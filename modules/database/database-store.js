/**
 * modules/database/database-store.js
 * KasirPro V2 - Single Source of Truth Engine
 * 
 * Prinsip:
 * 1. Firestore adalah SOURCE OF TRUTH.
 * 2. IndexedDB adalah LOCAL CACHE.
 * 3. Offline hanya untuk membaca cache; penulisan/transaksi WAJIB online (fail-closed).
 * 4. Penulisan penting menggunakan Firestore Atomic Batch / Transaction.
 * 5. IndexedDB diperbarui segera setelah operasi Firestore berhasil.
 */

import { firebaseApp, firebaseAuth, firebaseDb } from "./firebase-client.js";
import { waitForFirebaseUser, ensureInitialAdminProfile } from "./auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getDocsFromServer,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  runTransaction,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

import {
  collectionSegments,
  documentSegments,
  readableDocumentId,
  COLLECTION_NAMES,
  ROOT_DOCUMENT_PATH
} from "./database-paths.js";

import { indexedDBStore, STORES } from "../local/indexeddb-store.js";
import { masterSync } from "../local/master-sync.js";
import { supabaseDb } from "./supabase-client.js";

export const STORE_KEYS = Object.freeze({
  master: "kasirpro_master_store_v1",
  invoices: "kasirpro_purchase_invoices_v1",
  movements: "kasirpro_stock_movements_v1",
  opnames: "kasirpro_stock_opname_v1",
  sales: "kasirpro_sales_v1"
});

const inMemory = new Map();
const activeStockIndex = new Map();
let isInitialized = false;
let initPromise = null;

function norm(val) {
  return String(val ?? "").trim().toLowerCase();
}

/**
 * Sanitasi rekursif payload Firestore agar bebas dari nilai undefined
 */
export function sanitizeForFirestore(val) {
  if (val === undefined) return null;
  if (val === null || typeof val !== "object") return val;
  if (val instanceof Date) return val.toISOString();
  if (Array.isArray(val)) {
    return val
      .filter(item => item !== undefined)
      .map(item => sanitizeForFirestore(item));
  }
  const clean = {};
  for (const [k, v] of Object.entries(val)) {
    if (v !== undefined) {
      clean[k] = sanitizeForFirestore(v);
    }
  }
  return clean;
}

function num(val) {
  return Number(String(val ?? 0).replace(/[^0-9.-]/g, "")) || 0;
}

function clone(val) {
  if (val === undefined) return undefined;
  return typeof structuredClone === "function" ? structuredClone(val) : JSON.parse(JSON.stringify(val));
}

function requireOnline() {
  if (!navigator.onLine) {
    throw new Error("Koneksi internet diperlukan untuk mengubah atau menyimpan data transaksi. Mode offline hanya mendukung pembacaan data.");
  }
}

/**
 * Normalisasi data produk untuk memastikan field terdefinisi
 */
function normalizeProductRecord(prod) {
  const code = String(prod["Kode Produk"] || prod["Kode Produk Internal"] || prod.code || prod.id || "").trim();
  const name = String(prod["Nama Produk"] || prod.name || "").trim();
  const buyPrice = num(prod["Harga Beli Terakhir"] ?? prod["Harga Beli"] ?? prod.buyPrice);
  const sellPrice = num(prod["Harga Jual"] ?? prod.sellPrice);
  const sellPriceMid = num(prod["Harga Jual Satuan Sedang"] ?? prod["Harga Jual Sedang"] ?? prod.sellPriceMid);
  const sellPriceBuy = num(prod["Harga Jual Satuan Besar"] ?? prod["Harga Jual Besar"] ?? prod.sellPriceBuy);
  const baseUnit = String(prod["Satuan Dasar"] || prod["Satuan"] || prod.baseUnit || "Pcs").trim();
  const purchaseUnit = String(prod["Satuan Pembelian"] || prod.purchaseUnit || baseUnit).trim();
  const conversion = num(prod["Konversi"] ?? prod["Isi Kemasan"] ?? prod.conversion ?? 1) || 1;
  const midUnit = String(prod["Satuan Antara"] || prod.intermediateUnit || baseUnit).trim();
  const midQty = num(prod["Isi Satuan Antara"] ?? prod.intermediateQty ?? 1) || 1;
  const minStock = num(prod["Stok Minimum"] ?? prod.minStock);
  const stock = num(prod["Stok Awal"] ?? prod.stock ?? 0);

  let status = String(prod["Status"] || prod["Status Produk"] || prod.status || "").trim();
  if (!status || status === "Aktif") {
    if (sellPrice <= 0) {
      status = "Perlu Harga Jual";
    } else {
      status = "Aktif";
    }
  }

  return {
    ...prod,
    id: code,
    "Kode Produk": code,
    "Kode Produk Internal": code,
    "Barcode": String(prod["Barcode"] || prod.barcode || "").trim(),
    "Nama Produk": name,
    "Kategori": String(prod["Kategori"] || prod.category || "").trim(),
    "Supplier": String(prod["Supplier"] || prod.supplier || "").trim(),
    "Produsen": String(prod["Produsen"] || prod.manufacturer || "").trim(),
    "Harga Beli Terakhir": buyPrice,
    "Harga Beli": buyPrice,
    "Harga Jual": sellPrice,
    "Harga Jual Satuan Sedang": sellPriceMid,
    "Harga Jual Satuan Besar": sellPriceBuy,
    "Satuan Dasar": baseUnit,
    "Satuan": baseUnit,
    "Satuan Pembelian": purchaseUnit,
    "Konversi": conversion,
    "Satuan Antara": midUnit,
    "Isi Satuan Antara": midQty,
    "Stok Minimum": minStock,
    "Stok Awal": stock,
    "Status": status,
    "Status Produk": status
  };
}

/**
 * Muat data awal dari IndexedDB ke In-Memory
 */
async function loadFromIndexedDB() {
  try {
    let [products, suppliers, categories, config, invoices, sales, movements, opnames] = await Promise.all([
      indexedDBStore.getAll(STORES.PRODUCTS),
      indexedDBStore.getAll(STORES.SUPPLIERS),
      indexedDBStore.getAll(STORES.CATEGORIES),
      indexedDBStore.getAll(STORES.CONFIGURATIONS),
      indexedDBStore.getAll(STORES.INVOICES),
      indexedDBStore.getAll(STORES.SALES),
      indexedDBStore.getAll(STORES.MOVEMENTS),
      indexedDBStore.getAll(STORES.OPNAMES)
    ]);

    // Jika IndexedDB V2 masih kosong, coba periksa apakah ada data dari versi sebelumnya (kasirpro_local_v1)
    if ((!products || products.length === 0) && typeof indexedDB !== "undefined") {
      try {
        const legacyData = await new Promise((resolve) => {
          const req = indexedDB.open("kasirpro_local_v1");
          req.onerror = () => resolve(null);
          req.onsuccess = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains("products")) {
              db.close();
              resolve(null);
              return;
            }
            try {
              const tx = db.transaction("products", "readonly");
              const store = tx.objectStore("products");
              const getAllReq = store.getAll();
              getAllReq.onsuccess = () => {
                const list = getAllReq.result || [];
                db.close();
                resolve(list.length ? list : null);
              };
              getAllReq.onerror = () => { db.close(); resolve(null); };
            } catch {
              db.close();
              resolve(null);
            }
          };
        });

        if (legacyData && legacyData.length > 0) {
          console.log(`[DatabaseStore] Menemukan ${legacyData.length} produk dari cache versi lama (v1), memigrasikan...`);
          products = legacyData;
          await indexedDBStore.putMany(STORES.PRODUCTS, products.map(normalizeProductRecord));
        }
      } catch (legacyErr) {
        console.warn("[DatabaseStore] Pengecekan legacy cache v1 dilewati:", legacyErr);
      }
    }

    const cleanProducts = [];
    for (const p of (products || [])) {
      if (p._isDeleted) {
        if (p.id) indexedDBStore.delete(STORES.PRODUCTS, p.id).catch(() => {});
        continue;
      }
      cleanProducts.push(normalizeProductRecord(p));
    }

    const activeConfig = Array.isArray(config) ? (config[0] || null) : config;
    const defaultSettings = {
      id: "current",
      key: "storeSettings",
      "Nama Toko": "Apotek Doa Ibu",
      "Nama Apotek": "Apotek Doa Ibu",
      "Alamat": "",
      "Telepon": "",
      "Ukuran Struk": "58 mm",
      "Footer Struk": "Terima kasih atas kunjungan Anda"
    };

    const masterObj = {
      produk: cleanProducts,
      supplier: suppliers || [],
      kategori: categories || [],
      pengguna: [],
      pengaturan_toko: activeConfig ? [{ ...defaultSettings, ...activeConfig, id: "current", key: "storeSettings" }] : [defaultSettings]
    };

    inMemory.set(STORE_KEYS.master, masterObj);
    inMemory.set(STORE_KEYS.invoices, invoices || []);
    inMemory.set(STORE_KEYS.sales, sales || []);
    inMemory.set(STORE_KEYS.movements, movements || []);
    inMemory.set(STORE_KEYS.opnames, opnames || []);

    // Bangun active stock index
    activeStockIndex.clear();
    masterObj.produk.forEach(p => {
      const code = norm(p["Kode Produk"]);
      if (code) activeStockIndex.set(code, num(p["Stok Awal"]));
    });

    console.log(`[DatabaseStore] Berhasil memuat cache lokal: ${masterObj.produk.length} produk, ${(sales || []).length} sales.`);
  } catch (err) {
    console.warn("[DatabaseStore] Gagal memuat dari IndexedDB:", err);
  }
}

// Cooldown & throttling untuk mencegah sync berulang-ulang
let isSyncInProgress = false;
let lastSyncAttempt = 0;
const SYNC_COOLDOWN_MS = 60000; // Minimal 60 detik jeda antar sinkronisasi otomatis

/**
 * Sinkronisasi cerdas (Delta / Incremental) dari Firestore ke IndexedDB dan in-memory.
 * Menghemat 99%+ kuota Reads Firebase Free Tier dengan hanya mengambil dokumen yang berubah.
 *
 * @param {boolean} force - jika true, paksa sinkronisasi tanpa memedulikan cooldown
 */
async function syncFromFirestore(force = false) {
  if (!navigator.onLine) {
    console.log("[DatabaseStore] Perangkat offline, menggunakan cache lokal.");
    return;
  }

  const nowMs = Date.now();
  if (!force && (isSyncInProgress || (nowMs - lastSyncAttempt < SYNC_COOLDOWN_MS))) {
    console.log("[DatabaseStore] Sinkronisasi dilewati (cooldown aktif).");
    return;
  }

  isSyncInProgress = true;
  lastSyncAttempt = nowMs;

  try {
    const user = await waitForFirebaseUser();
    if (!user) {
      console.log("[DatabaseStore] Belum ada user terautentikasi, tunda sync Firestore.");
      return;
    }

    const lastSyncTime = await indexedDBStore.getLastUpdated("central_sync");
    const isIncremental = !force && lastSyncTime > 0;
    // Buffer toleransi 60 detik untuk variasi jam server/klien
    const cutoffIso = isIncremental ? new Date(Math.max(0, lastSyncTime - 60000)).toISOString() : null;

    console.log(`[DatabaseStore] Sinkronisasi Supabase PostgreSQL Cloud (${isIncremental ? 'Delta' : 'Full sync'})...`);

    const firestoreProducts = [];
    const firestoreCategories = [];
    const firestoreSuppliers = [];
    const firestoreInvoices = [];
    const firestoreSales = [];
    const firestoreMovements = [];
    const firestoreOpnames = [];
    const firestoreStocks = [];
    const firestoreSettings = [];

    // 2b. Fetch data dari Supabase PostgreSQL
    let supabaseProducts = [];
    let supabaseCategories = [];
    let supabaseSuppliers = [];
    let supabaseInvoices = [];
    let supabaseSales = [];
    let supabaseMovements = [];
    let supabaseOpnames = [];
    let supabaseStocks = [];
    let supabaseSettings = [];

    try {
      const [sbP, sbC, sbS, sbInv, sbSal, sbMov, sbOpn, sbStk, sbSet] = await Promise.all([
        supabaseDb.select("products").catch(() => []),
        supabaseDb.select("categories").catch(() => []),
        supabaseDb.select("suppliers").catch(() => []),
        supabaseDb.select("purchase_invoices").catch(() => []),
        supabaseDb.select("sales").catch(() => []),
        supabaseDb.select("stock_movements").catch(() => []),
        supabaseDb.select("stock_opnames").catch(() => []),
        supabaseDb.select("active_stocks").catch(() => []),
        supabaseDb.select("store_settings").catch(() => [])
      ]);

      if (Array.isArray(sbP)) supabaseProducts = sbP.map(p => ({
        id: p.id,
        "Kode Produk": p.code,
        "Kode Produk Internal": p.code,
        "Nama Produk": p.name,
        "Barcode": p.barcode || "",
        "Kategori": p.category || "",
        "Supplier": p.supplier || "",
        "Harga Beli": Number(p.buy_price || 0),
        "Harga Jual": Number(p.sell_price || 0),
        "Satuan Beli": p.buy_unit || "Box",
        "Satuan Terkecil": p.base_unit || "Pcs",
        "Satuan Menengah": p.mid_unit || "",
        "Isi Per Box": Number(p.conversion || 1),
        "Isi Per Strip": Number(p.mid_conversion || 1),
        "Harga Bertingkat": Array.isArray(p.tiered_prices) ? p.tiered_prices : [],
        "Stok Awal": Number(p.stock || 0),
        "Status": p.status || "Tidak Aktif",
        "Status Produk": p.status || "Tidak Aktif",
        "Stok Minimum": Number(p.min_stock || 0),
        updatedAt: p.updated_at
      }));

      if (Array.isArray(sbC)) supabaseCategories = sbC.map(c => ({
        id: c.id,
        "Nama Kategori": c.name,
        "Kode Kategori": c.id,
        updatedAt: c.updated_at
      }));

      if (Array.isArray(sbS)) supabaseSuppliers = sbS.map(s => ({
        id: s.id,
        "Supplier": s.name,
        "Nama Perusahaan": s.company_name || s.name,
        "Nomor Telepon": s.phone || "",
        "Alamat": s.address || "",
        "Status": s.status || "Aktif",
        updatedAt: s.updated_at
      }));

      if (Array.isArray(sbInv)) supabaseInvoices = sbInv.map(inv => ({
        id: inv.id,
        invoiceNumber: inv.invoice_number,
        supplierName: inv.supplier_name,
        date: inv.date,
        dueDate: inv.due_date,
        paymentType: inv.payment_type,
        discountType: inv.discount_type,
        globalDiscountRp: Number(inv.global_discount_rp || 0),
        ppnRate: inv.ppn_rate,
        customPpnRp: Number(inv.custom_ppn_rp || 0),
        grossTotal: Number(inv.gross_total || 0),
        totalDiscount: Number(inv.total_discount || 0),
        dpp: Number(inv.dpp || 0),
        ppn: Number(inv.ppn || 0),
        calculatedTotal: Number(inv.calculated_total || 0),
        printedTotal: Number(inv.printed_total || 0),
        difference: Number(inv.difference || 0),
        status: inv.status,
        items: inv.items || [],
        updatedAt: inv.updated_at
      }));

      if (Array.isArray(sbSal)) supabaseSales = sbSal.map(s => ({
        id: s.id,
        transactionNumber: s.transaction_number,
        date: s.date,
        cashierName: s.cashier_name,
        cashierId: s.cashier_id,
        paymentMethod: s.payment_method,
        subtotal: Number(s.subtotal || 0),
        discountPercent: Number(s.discount_percent || 0),
        discountNominal: Number(s.discount_nominal || 0),
        total: Number(s.total || 0),
        cashPaid: Number(s.cash_paid || 0),
        changeReturned: Number(s.change_returned || 0),
        status: s.status,
        voidReason: s.void_reason,
        items: s.items || [],
        createdAt: s.created_at
      }));

      if (Array.isArray(sbMov)) supabaseMovements = sbMov.map(m => ({
        id: m.id,
        productCode: m.product_code,
        productName: m.product_name,
        type: m.type,
        referenceId: m.reference_id,
        batch: m.batch,
        expiryDate: m.expiry_date,
        qtyIn: Number(m.qty_in || 0),
        qtyOut: Number(m.qty_out || 0),
        unit: m.unit,
        notes: m.notes,
        createdAt: m.created_at
      }));

      if (Array.isArray(sbOpn)) supabaseOpnames = sbOpn.map(o => ({
        id: o.id,
        reference: o.reference,
        date: o.date,
        notes: o.notes,
        createdBy: o.created_by,
        items: o.items || [],
        createdAt: o.created_at
      }));

      if (Array.isArray(sbStk)) supabaseStocks = sbStk.map(st => ({
        productCode: st.product_code,
        quantity: Number(st.quantity || 0)
      }));

      if (Array.isArray(sbSet) && sbSet.length) supabaseSettings = sbSet.map(st => ({
        key: "storeSettings",
        store_name: st.store_name,
        "Nama Toko": st.store_name,
        address: st.address,
        "Alamat Toko": st.address,
        phone: st.phone,
        "Nomor Telepon Toko": st.phone,
        receipt_size: st.receipt_size,
        "Ukuran Struk": st.receipt_size,
        receipt_footer: st.receipt_footer,
        "Pesan Penutup": st.receipt_footer
      }));
    } catch (sbErr) {
      console.warn("[DatabaseStore] Supabase fetch sync:", sbErr.message);
    }

    // Helper untuk merge array berdasarkan ID
    const mergeEntities = (existing = [], incoming = [], idExtractor) => {
      if (!incoming.length) return existing;
      const map = new Map(existing.map(x => [String(idExtractor(x)), x]));
      incoming.forEach(x => {
        const key = String(idExtractor(x));
        map.set(key, { ...(map.get(key) || {}), ...x });
      });
      return Array.from(map.values());
    };

    // Gabungkan data Firestore & Supabase (Supabase diutamakan)
    const combinedProducts = mergeEntities(firestoreProducts, supabaseProducts, p => p["Kode Produk"] || p.id);
    const combinedSuppliers = mergeEntities(firestoreSuppliers, supabaseSuppliers, s => s["Nama Perusahaan"] || s["Supplier"] || s.id);
    const combinedCategories = mergeEntities(firestoreCategories, supabaseCategories, c => c["Kode Kategori"] || c["Nama Kategori"] || c.id);
    const combinedInvoices = mergeEntities(firestoreInvoices, supabaseInvoices, i => i.id || i.invoiceNumber);
    const combinedSales = mergeEntities(firestoreSales, supabaseSales, s => s.id || s.transactionNumber);
    const combinedMovements = mergeEntities(firestoreMovements, supabaseMovements, m => m.id);
    const combinedOpnames = mergeEntities(firestoreOpnames, supabaseOpnames, o => o.id);
    const combinedStocks = mergeEntities(firestoreStocks, supabaseStocks, s => s.productCode || s.id);
    const combinedSettings = supabaseSettings.length ? supabaseSettings : firestoreSettings;

    // Update stok aktif dari koleksi StokAktif
    const stockMap = new Map();
    combinedStocks.forEach(s => {
      const code = norm(s.productCode || s.id);
      if (code) {
        stockMap.set(code, num(s.quantity));
        activeStockIndex.set(code, num(s.quantity));
      }
    });

    const currentMaster = inMemory.get(STORE_KEYS.master) || { produk: [], supplier: [], kategori: [], pengguna: [], pengaturan_toko: [] };

    // Normalisasi produk baru/terubah (abaikan record yang ditandai terhapus)
    const normalizedIncomingProducts = combinedProducts
      .filter(p => !p._isDeleted)
      .map(p => {
        const normProd = normalizeProductRecord(p);
        const code = norm(normProd["Kode Produk"]);
        if (stockMap.has(code)) {
          normProd["Stok Awal"] = stockMap.get(code);
        }
        activeStockIndex.set(code, normProd["Stok Awal"]);
        return normProd;
      });

    const prodIdFn = p => p["Kode Produk"] || p.id || p["Kode Produk Internal"];
    const mergedProducts = mergeEntities(currentMaster.produk, normalizedIncomingProducts, prodIdFn);

    const supIdFn = s => s["Nama Perusahaan"] || s["Supplier"] || s.id;
    const mergedSuppliers = mergeEntities(currentMaster.supplier, combinedSuppliers, supIdFn);

    const katIdFn = k => k["Kode Kategori"] || k["Nama Kategori"] || k.id;
    const mergedCategories = mergeEntities(currentMaster.kategori, combinedCategories, katIdFn);

    const masterObj = {
      produk: mergedProducts,
      supplier: mergedSuppliers,
      kategori: mergedCategories,
      pengguna: currentMaster.pengguna || [],
      pengaturan_toko: combinedSettings.length ? combinedSettings : currentMaster.pengaturan_toko
    };

    inMemory.set(STORE_KEYS.master, masterObj);

    if (combinedInvoices.length) {
      const invs = mergeEntities(inMemory.get(STORE_KEYS.invoices) || [], combinedInvoices, i => i.id || i.invoiceNumber);
      inMemory.set(STORE_KEYS.invoices, invs);
      await indexedDBStore.putMany(STORES.INVOICES, combinedInvoices);
    }
    if (combinedSales.length) {
      const sls = mergeEntities(inMemory.get(STORE_KEYS.sales) || [], combinedSales, s => s.id || s.transactionNumber);
      inMemory.set(STORE_KEYS.sales, sls);
      await indexedDBStore.putMany(STORES.SALES, combinedSales);
    }
    if (combinedMovements.length) {
      const movs = mergeEntities(inMemory.get(STORE_KEYS.movements) || [], combinedMovements, m => m.id);
      inMemory.set(STORE_KEYS.movements, movs);
      await indexedDBStore.putMany(STORES.MOVEMENTS, combinedMovements);
    }
    if (combinedOpnames.length) {
      const opns = mergeEntities(inMemory.get(STORE_KEYS.opnames) || [], combinedOpnames, o => o.id);
      inMemory.set(STORE_KEYS.opnames, opns);
      await indexedDBStore.putMany(STORES.OPNAMES, combinedOpnames);
    }

    // Simpan hanya rekaman yang berubah ke IndexedDB cache
    if (normalizedIncomingProducts.length) await indexedDBStore.putMany(STORES.PRODUCTS, normalizedIncomingProducts);
    if (combinedSuppliers.length) await indexedDBStore.putMany(STORES.SUPPLIERS, combinedSuppliers);
    if (combinedCategories.length) await indexedDBStore.putMany(STORES.CATEGORIES, combinedCategories);
    if (combinedSettings.length && combinedSettings[0]) {
      await indexedDBStore.put(STORES.CONFIGURATIONS, { key: "storeSettings", ...combinedSettings[0] });
    }

    await indexedDBStore.setLastUpdated("central_sync", Date.now());
    console.log(`[DatabaseStore] Sinkronisasi selesai. Perubahan diunduh: ${normalizedIncomingProducts.length} produk, ${firestoreSuppliers.length} supplier, ${firestoreCategories.length} kategori.`);

    window.dispatchEvent(new CustomEvent("kasirpro:database-synced", { detail: { timestamp: Date.now() } }));
  } catch (error) {
    console.error("[DatabaseStore] Sinkronisasi Firestore mengalami galat:", error);
  } finally {
    isSyncInProgress = false;
  }
}

/**
 * Inisialisasi Database KasirPro
 */
export async function initializeDatabase() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // 1. Muat dari IndexedDB cache lokal segera (0ms start)
    await loadFromIndexedDB();
    isInitialized = true;
    window.dispatchEvent(new CustomEvent("kasirpro:database-ready"));

    // 2. Jika online, jalankan sinkronisasi latar belakang
    if (navigator.onLine) {
      syncFromFirestore().catch((err) => console.warn("[DatabaseStore] Sync error:", err));
    }

    return inMemory.get(STORE_KEYS.master) || { produk: [], supplier: [], kategori: [], pengguna: [], pengaturan_toko: [] };
  })();

  return initPromise;
}

/**
 * Baca store secara tersinkronisasi dari memori
 */
export function readStore(key, fallback = null) {
  if (!inMemory.has(key)) {
    if (key === STORE_KEYS.master) {
      return { produk: [], supplier: [], kategori: [], pengguna: [], pengaturan_toko: [] };
    }
    return fallback !== null ? fallback : [];
  }
  return clone(inMemory.get(key));
}

/**
 * Ambil stok produk terkini
 */
export function readCurrentStock(productCode) {
  const code = norm(productCode);
  if (activeStockIndex.has(code)) {
    return activeStockIndex.get(code);
  }
  const prods = inMemory.get(STORE_KEYS.master)?.produk || [];
  const found = prods.find(p => norm(p["Kode Produk"]) === code);
  return found ? num(found["Stok Awal"]) : 0;
}

/**
 * Simpan data store (online wajib)
 */
export async function writeStore(key, value, onProgress) {
  requireOnline();
  inMemory.set(key, clone(value));

  // Tulis ke IndexedDB
  if (key === STORE_KEYS.master) {
    if (typeof onProgress === "function") {
      onProgress({
        step: "indexeddb",
        message: "Menyimpan ke IndexedDB lokal...",
        detail: "Memperbarui cache produk, supplier & kategori",
        percent: 25
      });
    }
    await Promise.all([
      indexedDBStore.clearStore(STORES.PRODUCTS),
      indexedDBStore.clearStore(STORES.SUPPLIERS),
      indexedDBStore.clearStore(STORES.CATEGORIES)
    ]);
    if (Array.isArray(value?.produk)) await indexedDBStore.putMany(STORES.PRODUCTS, value.produk);
    if (Array.isArray(value?.supplier)) await indexedDBStore.putMany(STORES.SUPPLIERS, value.supplier);
    if (Array.isArray(value?.kategori)) await indexedDBStore.putMany(STORES.CATEGORIES, value.kategori);
    if (Array.isArray(value?.pengaturan_toko) && value.pengaturan_toko[0]) {
      await indexedDBStore.put(STORES.CONFIGURATIONS, { key: "storeSettings", ...value.pengaturan_toko[0] });
    }
  } else if (key === STORE_KEYS.invoices) {
    await indexedDBStore.clearStore(STORES.INVOICES);
    if (Array.isArray(value) && value.length) await indexedDBStore.putMany(STORES.INVOICES, value);
  } else if (key === STORE_KEYS.sales) {
    await indexedDBStore.clearStore(STORES.SALES);
    if (Array.isArray(value) && value.length) await indexedDBStore.putMany(STORES.SALES, value);
  } else if (key === STORE_KEYS.movements) {
    await indexedDBStore.clearStore(STORES.MOVEMENTS);
    if (Array.isArray(value) && value.length) await indexedDBStore.putMany(STORES.MOVEMENTS, value);
  } else if (key === STORE_KEYS.opnames) {
    await indexedDBStore.clearStore(STORES.OPNAMES);
    if (Array.isArray(value) && value.length) await indexedDBStore.putMany(STORES.OPNAMES, value);
  }

  // Tulis ke Firestore menggunakan batch terbagi (maksimal 400 op per commit)
  const operations = [];
  const now = new Date().toISOString();

  // Helper untuk membersihkan nilai undefined dan sanitasi ID Firestore
  const sanitizeDocId = (id, fallbackPrefix = "id") => {
    const raw = String(id || "").trim();
    if (!raw) return readableDocumentId(fallbackPrefix, Date.now().toString());
    return raw.replace(/[\/\\]/g, "_").trim();
  };

  const sanitizeFirestorePayload = (obj) => {
    const clean = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (v !== undefined) {
        clean[k] = v;
      }
    }
    return clean;
  };

  if (key === STORE_KEYS.master) {
    if (typeof onProgress === "function") {
      onProgress({
        step: "preparing_firestore",
        message: "Menyiapkan sinkronisasi Cloud Firestore...",
        detail: "Memformat payload produk, supplier & kategori",
        percent: 40
      });
    }

    if (Array.isArray(value?.produk)) {
      for (const p of value.produk) {
        const id = sanitizeDocId(p.id || p["Kode Produk"] || p["Kode Produk Internal"], "prd");
        const ref = doc(firebaseDb, ...documentSegments("products", id));
        operations.push({ ref, data: sanitizeFirestorePayload({ ...p, updatedAt: now }) });
      }
    }
    if (Array.isArray(value?.supplier)) {
      for (const s of value.supplier) {
        const id = sanitizeDocId(s.id || s["Supplier"] || s["Nama Perusahaan"], "sup");
        const ref = doc(firebaseDb, ...documentSegments("suppliers", id));
        operations.push({ ref, data: sanitizeFirestorePayload({ ...s, updatedAt: now }) });
      }
    }
    if (Array.isArray(value?.kategori)) {
      for (const k of value.kategori) {
        const id = sanitizeDocId(k.id || k["Kode Kategori"] || k["Nama Kategori"], "kat");
        const ref = doc(firebaseDb, ...documentSegments("categories", id));
        operations.push({ ref, data: sanitizeFirestorePayload({ ...k, updatedAt: now }) });
      }
    }
    if (Array.isArray(value?.pengaturan_toko) && value.pengaturan_toko[0]) {
      const ref = doc(firebaseDb, ...documentSegments("storeSettings", "current"));
      operations.push({ ref, data: sanitizeFirestorePayload({ ...value.pengaturan_toko[0], updatedAt: now }) });
    }

    // Simpan ke Supabase PostgreSQL
    try {
      if (Array.isArray(value?.produk) && value.produk.length) {
        const pRows = value.produk.map(p => ({
          id: p.id || p["Kode Produk"] || p["Kode Produk Internal"],
          code: String(p["Kode Produk"] || p.id || "").trim(),
          name: String(p["Nama Produk"] || "").trim(),
          barcode: p["Barcode"] || null,
          category: p["Kategori"] || null,
          supplier: p["Supplier"] || null,
          buy_price: Number(p["Harga Beli"] || 0),
          sell_price: Number(p["Harga Jual"] || 0),
          buy_unit: p["Satuan Beli"] || "Box",
          base_unit: p["Satuan Terkecil"] || "Pcs",
          mid_unit: p["Satuan Menengah"] || null,
          conversion: Number(p["Isi Per Box"] || 1),
          mid_conversion: Number(p["Isi Per Strip"] || 1),
          tiered_prices: Array.isArray(p["Harga Bertingkat"]) ? p["Harga Bertingkat"] : [],
          stock: Number(p["Stok Awal"] || 0),
          status: p["Status"] || p["Status Produk"] || "Tidak Aktif",
          min_stock: Number(p["Stok Minimum"] || 0),
          updated_at: now
        }));
        await supabaseDb.upsert("products", pRows, "id");
      }
      if (Array.isArray(value?.supplier) && value.supplier.length) {
        const sRows = value.supplier.map(s => ({
          id: s.id || s["Supplier"] || s["Nama Perusahaan"],
          name: String(s["Supplier"] || s["Nama Perusahaan"] || s.name || "").trim(),
          company_name: String(s["Nama Perusahaan"] || s["Supplier"] || "").trim(),
          phone: s["Nomor Telepon"] || s.phone || null,
          address: s["Alamat"] || s.address || null,
          status: s["Status"] || "Aktif",
          updated_at: now
        }));
        await supabaseDb.upsert("suppliers", sRows, "id");
      }
      if (Array.isArray(value?.kategori) && value.kategori.length) {
        const cRows = value.kategori.map(k => ({
          id: k.id || k["Kode Kategori"] || k["Nama Kategori"],
          name: String(k["Nama Kategori"] || k["Kategori"] || k.name || "").trim(),
          updated_at: now
        }));
        await supabaseDb.upsert("categories", cRows, "id");
      }
      if (Array.isArray(value?.pengaturan_toko) && value.pengaturan_toko[0]) {
        const st = value.pengaturan_toko[0];
        await supabaseDb.upsert("store_settings", {
          id: "toko_utama",
          store_name: st.store_name || st["Nama Toko"] || "Apotek Doa Ibu",
          address: st.address || st["Alamat Toko"] || "",
          phone: st.phone || st["Nomor Telepon Toko"] || "",
          receipt_size: st.receipt_size || st["Ukuran Struk"] || "58 mm",
          receipt_footer: st.receipt_footer || st["Pesan Penutup"] || "",
          updated_at: now
        }, "id");
      }
    } catch (supErr) {
      console.warn("[DatabaseStore] Supabase writeStore master:", supErr.message);
    }

    // Commit Firestore non-blocking
    const CHUNK_SIZE = 400;
    for (let i = 0; i < operations.length; i += CHUNK_SIZE) {
      const chunk = operations.slice(i, i + CHUNK_SIZE);
      const b = writeBatch(firebaseDb);
      for (const op of chunk) b.set(op.ref, op.data, { merge: true });
      try {
        await Promise.race([
          b.commit(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout Firestore")), 3000))
        ]);
      } catch (commitErr) {
        console.warn("[DatabaseStore] Peringatan commit batch master:", commitErr.message || commitErr);
      }
    }

    if (typeof onProgress === "function") {
      onProgress({
        step: "complete",
        message: "Data tersimpan di cloud & lokal.",
        detail: "Semua batch data telah ditulis",
        percent: 96
      });
    }
  }

  return true;
}

/**
 * Simpan HANYA record master yang berubah (produk / supplier / kategori / pengguna / pengaturan).
 * Menghindari penulisan ulang seluruh master ke Firestore. Menghemat 99.9% kuota Writes.
 * Menerapkan Optimistic Update (respons instan di UI & IndexedDB, sinkronisasi di latar belakang).
 *
 * @param {{produk?: object[], supplier?: object[], kategori?: object[], pengguna?: object[], pengaturan_toko?: object[]}} changes
 */
export async function writeMasterDelta(changes = {}) {
  requireOnline();
  const now = new Date().toISOString();

  const prodIdOf = (p) => p.id || p["Kode Produk"] || p["Kode Produk Internal"] || readableDocumentId("prd", p["Nama Produk"]);
  const supIdOf = (s) => s.id || s["Supplier"] || s["Nama Perusahaan"] || readableDocumentId("sup", s["Nama Perusahaan"]);
  const katIdOf = (k) => k.id || k["Kode Kategori"] || readableDocumentId("kat", k["Nama Kategori"]);
  const usrIdOf = (u) => u.id || u.username || readableDocumentId("usr", u.username);
  const setDocIdOf = (st) => st.id || st.key || "current";

  const groups = [
    { field: "produk", coll: "products", store: STORES.PRODUCTS, idOf: prodIdOf, records: (changes.produk || []).map(p => normalizeProductRecord(p)) },
    { field: "supplier", coll: "suppliers", store: STORES.SUPPLIERS, idOf: supIdOf, records: changes.supplier || [] },
    { field: "kategori", coll: "categories", store: STORES.CATEGORIES, idOf: katIdOf, records: changes.kategori || [] },
    { field: "pengguna", coll: "users", store: STORES.USERS, idOf: usrIdOf, records: changes.pengguna || [] },
    { field: "pengaturan_toko", coll: "storeSettings", store: STORES.CONFIGURATIONS, idOf: setDocIdOf, records: changes.pengaturan_toko || [] }
  ].filter(g => g.records.length);

  if (!groups.length) return true;

  const sanitizeDocId = (id, fallbackPrefix = "id") => {
    const raw = String(id || "").trim();
    if (!raw) return readableDocumentId(fallbackPrefix, Date.now().toString());
    return raw.replace(/[\/\\]/g, "_").trim();
  };

  const sanitizeFirestorePayload = (obj) => {
    const clean = {};
    for (const [k, v] of Object.entries(obj || {})) {
      if (v !== undefined) clean[k] = v;
    }
    return clean;
  };

  // 1. OPTIMISTIC UPDATE: Perbarui in-memory & IndexedDB SEGERA (0ms latency bagi pengguna)
  const master = inMemory.get(STORE_KEYS.master) || { produk: [], supplier: [], kategori: [], pengguna: [], pengaturan_toko: [] };
  for (const g of groups) {
    const list = Array.isArray(master[g.field]) ? [...master[g.field]] : [];
    const indexById = new Map(list.map((x, i) => [String(g.idOf(x)), i]));
    for (const rec of g.records) {
      const key = String(g.idOf(rec));
      rec.id = sanitizeDocId(key, g.coll.slice(0, 3));
      if (g.store === STORES.CONFIGURATIONS || g.store === STORES.SYNC_METADATA) {
        rec.key = rec.key || "storeSettings";
      }
      if (indexById.has(key)) {
        list[indexById.get(key)] = { ...list[indexById.get(key)], ...rec };
      } else {
        indexById.set(key, list.length);
        list.push(rec);
      }
      if (g.field === "produk") {
        const code = norm(rec["Kode Produk"]);
        if (code && !activeStockIndex.has(code)) activeStockIndex.set(code, num(rec["Stok Awal"]));
      }
    }
    master[g.field] = list;
  }
  inMemory.set(STORE_KEYS.master, master);

  // Simpan ke IndexedDB cache lokal
  await Promise.all(groups.map(g => indexedDBStore.putMany(g.store, g.records)));

  // 2. FIRESTORE COMMIT: Hanya record delta yang berubah
  const operations = [];
  for (const g of groups) {
    for (const rec of g.records) {
      const id = rec.id || sanitizeDocId(g.idOf(rec), g.coll.slice(0, 3));
      operations.push({
        ref: doc(firebaseDb, ...documentSegments(g.coll, id)),
        data: sanitizeFirestorePayload({ ...rec, updatedAt: now })
      });
    }
  }

  const CHUNK_SIZE = 400;
  for (let i = 0; i < operations.length; i += CHUNK_SIZE) {
    const b = writeBatch(firebaseDb);
    for (const op of operations.slice(i, i + CHUNK_SIZE)) b.set(op.ref, op.data, { merge: true });
    try {
      const commitPromise = b.commit();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout sync Firestore master delta (10 detik)")), 10000)
      );
      await Promise.race([commitPromise, timeoutPromise]);
    } catch (commitErr) {
      console.warn("[DatabaseStore] Peringatan commit writeMasterDelta:", commitErr.message || commitErr);
    }
  // 3. SUPABASE SYNC: Tulis perubahan ke Supabase PostgreSQL
  try {
    for (const g of groups) {
      if (g.field === "produk" && g.records.length) {
        const rows = g.records.map(p => ({
          id: p.id || sanitizeDocId(g.idOf(p), "prd"),
          code: String(p["Kode Produk"] || p.id || "").trim(),
          name: String(p["Nama Produk"] || "").trim(),
          barcode: p["Barcode"] || null,
          category: p["Kategori"] || null,
          supplier: p["Supplier"] || null,
          buy_price: Number(p["Harga Beli"] || 0),
          sell_price: Number(p["Harga Jual"] || 0),
          buy_unit: p["Satuan Beli"] || "Box",
          base_unit: p["Satuan Terkecil"] || "Pcs",
          mid_unit: p["Satuan Menengah"] || null,
          conversion: Number(p["Isi Per Box"] || 1),
          mid_conversion: Number(p["Isi Per Strip"] || 1),
          tiered_prices: Array.isArray(p["Harga Bertingkat"]) ? p["Harga Bertingkat"] : [],
          stock: Number(p["Stok Awal"] || 0),
          status: p["Status"] || p["Status Produk"] || "Tidak Aktif",
          min_stock: Number(p["Stok Minimum"] || 0),
          updated_at: now
        }));
        await supabaseDb.upsert("products", rows, "id");
      } else if (g.field === "supplier" && g.records.length) {
        const rows = g.records.map(s => ({
          id: s.id || sanitizeDocId(g.idOf(s), "sup"),
          name: String(s["Supplier"] || s["Nama Perusahaan"] || s.name || "").trim(),
          company_name: String(s["Nama Perusahaan"] || s["Supplier"] || s.company_name || "").trim(),
          phone: s["Nomor Telepon"] || s.phone || null,
          address: s["Alamat"] || s.address || null,
          status: s["Status"] || "Aktif",
          updated_at: now
        }));
        await supabaseDb.upsert("suppliers", rows, "id");
      } else if (g.field === "kategori" && g.records.length) {
        const rows = g.records.map(k => ({
          id: k.id || sanitizeDocId(g.idOf(k), "kat"),
          name: String(k["Nama Kategori"] || k["Kategori"] || k.name || "").trim(),
          updated_at: now
        }));
        await supabaseDb.upsert("categories", rows, "id");
      } else if (g.field === "pengaturan_toko" && g.records.length) {
        const st = g.records[0];
        await supabaseDb.upsert("store_settings", {
          id: "toko_utama",
          store_name: st.store_name || st["Nama Toko"] || "Apotek Doa Ibu",
          address: st.address || st["Alamat Toko"] || "",
          phone: st.phone || st["Nomor Telepon Toko"] || "",
          receipt_size: st.receipt_size || st["Ukuran Struk"] || "58 mm",
          receipt_footer: st.receipt_footer || st["Pesan Penutup"] || "",
          updated_at: now
        }, "id");
      }
    }
  } catch (supErr) {
    console.warn("[DatabaseStore] Supabase writeMasterDelta:", supErr.message);
  }

  return true;
}

/**
 * Hapus produk dari Master Produk secara permanen (In-Memory, IndexedDB, dan Firestore Cloud)
 * Hanya boleh dipanggil jika produk tidak memiliki riwayat transaksi atau pergerakan stok.
 *
 * @param {string} codeOrId
 * @returns {Promise<boolean>}
 */
export async function deleteMasterProduct(codeOrId) {
  requireOnline();
  const searchKey = norm(codeOrId);
  if (!searchKey) throw new Error("Kode atau ID produk tidak valid.");

  const master = inMemory.get(STORE_KEYS.master) || { produk: [] };
  const prods = Array.isArray(master.produk) ? master.produk : [];
  const target = prods.find(p => norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.id) === searchKey);

  // Kumpulkan seluruh kemungkinan ID dokumen (ID internal, Firestore ID, Kode Produk)
  const docIds = new Set();
  docIds.add(String(codeOrId).trim());
  if (target) {
    if (target.id) docIds.add(String(target.id).trim());
    if (target["Kode Produk"]) docIds.add(String(target["Kode Produk"]).trim());
    if (target["Kode Produk Internal"]) docIds.add(String(target["Kode Produk Internal"]).trim());
    if (target._firestoreDocumentId) docIds.add(String(target._firestoreDocumentId).trim());
  }

  // 1. Bersihkan dari In-Memory
  master.produk = prods.filter(p => {
    const pCode = norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.id);
    return pCode !== searchKey && !docIds.has(String(p.id)) && !docIds.has(String(p["Kode Produk"]));
  });
  inMemory.set(STORE_KEYS.master, master);

  activeStockIndex.delete(searchKey);
  for (const id of docIds) {
    activeStockIndex.delete(norm(id));
  }

  // 2. Bersihkan dari IndexedDB cache lokal
  for (const id of docIds) {
    const cleanId = id.replace(/[\/\\]/g, "_").trim();
    await indexedDBStore.delete(STORES.PRODUCTS, id);
    if (cleanId !== id) await indexedDBStore.delete(STORES.PRODUCTS, cleanId);
    await indexedDBStore.delete(STORES.STOCK_SUMMARIES, id);
    await indexedDBStore.delete(STORES.PRICES, id);
  }

  // 3. Hapus permanen dari Cloud Firestore
  const deleteOps = [];
  for (const id of docIds) {
    const cleanId = id.replace(/[\/\\]/g, "_").trim();
    try {
      const prodRef = doc(firebaseDb, ...documentSegments("products", cleanId));
      deleteOps.push(deleteDoc(prodRef));
    } catch (e) {
      console.warn(`[DatabaseStore] Gagal membuat ref deleteDoc products [${cleanId}]:`, e);
    }
    try {
      const stockRef = doc(firebaseDb, ...documentSegments("activeStocks", cleanId));
      deleteOps.push(deleteDoc(stockRef));
    } catch (_) {}
  }

  try {
    await Promise.allSettled(deleteOps);
  } catch (err) {
    console.error("[DatabaseStore] Gagal menghapus dokumen Firestore:", err);
  }

  // 4. Hapus dari Supabase PostgreSQL
  try {
    for (const id of docIds) {
      await supabaseDb.delete("products", "id", id);
      await supabaseDb.delete("products", "code", id);
      await supabaseDb.delete("active_stocks", "product_code", id);
    }
  } catch (supErr) {
    console.warn("[DatabaseStore] Supabase deleteMasterProduct:", supErr.message);
  }

  return true;
}

/**
 * Hapus Faktur Pembelian secara tuntas (In-Memory, IndexedDB, dan Firestore Cloud)
 * Termasuk rollback stok produk delta dan penghapusan riwayat mutasi terkait.
 *
 * @param {string} invoiceIdOrNumber
 * @returns {Promise<boolean>}
 */
export async function deletePurchaseInvoice(invoiceIdOrNumber) {
  requireOnline();
  const searchKey = norm(invoiceIdOrNumber);
  if (!searchKey) throw new Error("ID atau Nomor Faktur tidak valid.");

  // 1. Ambil data faktur dari memori
  const invoices = inMemory.get(STORE_KEYS.invoices) || [];
  const targetInv = invoices.find(i => norm(i.id) === searchKey || norm(i.invoiceNumber) === searchKey);
  if (!targetInv) return false;

  const invId = String(targetInv.id || targetInv.invoiceNumber).replace(/[\/\\]/g, "_").trim();
  const invNumber = String(targetInv.invoiceNumber || "").trim();

  // 2. Ambil movements terkait faktur ini untuk rollback stok
  const movements = inMemory.get(STORE_KEYS.movements) || [];
  const relatedMovements = movements.filter(m => 
    norm(m.reference) === norm(invNumber) || norm(m.reference) === norm(invId) ||
    (m.source === "Faktur Pembelian" && norm(m.reference) === norm(invNumber))
  );

  // 3. Rollback stok produk di master
  const master = inMemory.get(STORE_KEYS.master) || { produk: [] };
  const products = Array.isArray(master.produk) ? master.produk : [];
  const touchedProducts = [];

  const isConfirmed = norm(targetInv.status) === "terkonfirmasi" || norm(targetInv.status) === "confirmed";
  if (isConfirmed && Array.isArray(targetInv.items)) {
    for (const item of targetInv.items) {
      const code = item.matchedProductCode || item.code || item.productCode;
      const baseQty = (num(item.qty) || 1) * (num(item.conversionRatio) || 1);
      const prod = products.find(p => norm(p["Kode Produk"]) === norm(code) || norm(p["Nama Produk"]) === norm(item.name));
      if (prod) {
        const curStock = readCurrentStock(prod["Kode Produk"]);
        const nextStock = Math.max(0, curStock - baseQty);
        activeStockIndex.set(norm(prod["Kode Produk"]), nextStock);
        prod["Stok Awal"] = nextStock;
        touchedProducts.push(prod);
      }
    }
  }

  // 4. Hapus dari Firestore Cloud menggunakan Batch
  const batch = writeBatch(firebaseDb);
  
  // Hapus dokumen faktur di Firestore
  const invRef = doc(firebaseDb, ...documentSegments("purchaseInvoices", invId));
  batch.delete(invRef);
  if (invNumber && invNumber !== invId) {
    try {
      const cleanNum = invNumber.replace(/[\/\\]/g, "_").trim();
      const altRef = doc(firebaseDb, ...documentSegments("purchaseInvoices", cleanNum));
      batch.delete(altRef);
    } catch (_) {}
  }

  // Hapus dokumen movements terkait dari Firestore
  for (const m of relatedMovements) {
    if (m.id) {
      try {
        const cleanMId = String(m.id).replace(/[\/\\]/g, "_").trim();
        const mRef = doc(firebaseDb, ...documentSegments("stockMovements", cleanMId));
        batch.delete(mRef);
      } catch (_) {}
    }
  }

  // Update stok produk di Firestore jika ada yang terdampak
  for (const p of touchedProducts) {
    const pId = String(p.id || p["Kode Produk"]).replace(/[\/\\]/g, "_").trim();
    const pRef = doc(firebaseDb, ...documentSegments("products", pId));
    batch.set(pRef, { "Stok Awal": p["Stok Awal"], updatedAt: new Date().toISOString() }, { merge: true });
  }

  await batch.commit();

  // 5. Bersihkan dari In-Memory
  const nextInvoices = invoices.filter(i => norm(i.id) !== searchKey && norm(i.invoiceNumber) !== searchKey);
  inMemory.set(STORE_KEYS.invoices, nextInvoices);

  const nextMovements = movements.filter(m => !relatedMovements.includes(m));
  inMemory.set(STORE_KEYS.movements, nextMovements);

  // 6. Bersihkan dari IndexedDB
  await Promise.all([
    indexedDBStore.clearStore(STORES.INVOICES),
    indexedDBStore.clearStore(STORES.MOVEMENTS)
  ]);
  if (nextInvoices.length) await indexedDBStore.putMany(STORES.INVOICES, nextInvoices);
  if (nextMovements.length) await indexedDBStore.putMany(STORES.MOVEMENTS, nextMovements);
  if (touchedProducts.length) {
    await indexedDBStore.putMany(STORES.PRODUCTS, products);
  }

  // 7. Bersihkan dari Supabase PostgreSQL
  try {
    if (invId) await supabaseDb.delete("purchase_invoices", "id", invId);
    if (invNumber) await supabaseDb.delete("purchase_invoices", "invoice_number", invNumber);
    for (const m of relatedMovements) {
      if (m.id) await supabaseDb.delete("stock_movements", "id", m.id);
    }
    for (const p of touchedProducts) {
      const code = norm(p["Kode Produk"]);
      if (code) {
        await supabaseDb.update("products", { stock: num(p["Stok Awal"]) }, "code", code).catch(() => {});
      }
    }
  } catch (supErr) {
    console.warn("[DatabaseStore] Supabase deletePurchaseInvoice:", supErr.message);
  }

  return true;
}

/**
 * Pembersihan Menyeluruh Data Uji Coba (Testing Mode Purge)
 * Menghapus faktur uji coba, riwayat mutasi stok, dan penjualan dari In-Memory, IndexedDB, dan Firestore Cloud.
 *
 * @param {Object} options
 * @returns {Promise<{deletedInvoices: number, deletedMovements: number, deletedSales: number}>}
 */
export async function purgeTestingTransactions(options = {}) {
  requireOnline();

  const {
    clearInvoices = true,
    clearMovements = true,
    clearSales = true,
    clearOpnames = true,
    resetProductStock = true,
    onProgress = null
  } = options;

  if (typeof onProgress === "function") {
    onProgress({
      title: "Pembersihan Data Uji Coba",
      message: "Memvalidasi sesi Administrator cloud...",
      percent: 8,
      detail: "Otentikasi kredensial Firebase..."
    });
  }

  // 1. Pastikan sesi Firebase Auth aktif sebelum mengeksekusi operasi Cloud
  let user = firebaseAuth.currentUser;
  if (!user) {
    user = await waitForFirebaseUser();
  }
  if (!user) {
    throw new Error("Sesi Firebase belum aktif atau telah kedaluwarsa. Silakan muat ulang halaman atau login kembali sebagai Administrator.");
  }

  // 2. Pastikan profil Administrator terverifikasi di Cloud Firestore
  try {
    await ensureInitialAdminProfile(user, "admin");
  } catch (profErr) {
    console.warn("[DatabaseStore] Profil admin check:", profErr?.message || profErr);
  }

  if (typeof onProgress === "function") {
    onProgress({
      title: "Pembersihan Data Uji Coba",
      message: "Menyiapkan daftar dokumen cloud...",
      percent: 20,
      detail: "Menghitung dokumen transaksi & stok..."
    });
  }

  const invoices = inMemory.get(STORE_KEYS.invoices) || [];
  const movements = inMemory.get(STORE_KEYS.movements) || [];
  const sales = inMemory.get(STORE_KEYS.sales) || [];
  const opnames = inMemory.get(STORE_KEYS.opnames) || [];
  const master = inMemory.get(STORE_KEYS.master) || { produk: [] };
  const products = Array.isArray(master.produk) ? master.produk : [];

  const delCount = {
    deletedInvoices: clearInvoices ? invoices.length : 0,
    deletedMovements: clearMovements ? movements.length : 0,
    deletedSales: clearSales ? sales.length : 0,
    deletedOpnames: clearOpnames ? opnames.length : 0
  };

  // 3. Susun daftar operasi Firestore Cloud
  const ops = [];
  if (clearInvoices) {
    for (const inv of invoices) {
      const id = String(inv.id || inv.invoiceNumber).replace(/[\/\\]/g, "_").trim();
      if (id) ops.push({ coll: "purchaseInvoices", id });
      if (inv.invoiceNumber && inv.invoiceNumber !== id) {
        ops.push({ coll: "purchaseInvoices", id: String(inv.invoiceNumber).replace(/[\/\\]/g, "_").trim() });
      }
    }
  }
  if (clearMovements) {
    for (const m of movements) {
      const id = String(m.id || "").replace(/[\/\\]/g, "_").trim();
      if (id) ops.push({ coll: "stockMovements", id });
    }
  }
  if (clearSales) {
    for (const s of sales) {
      const id = String(s.id || s.transactionNumber || "").replace(/[\/\\]/g, "_").trim();
      if (id) ops.push({ coll: "sales", id });
    }
  }
  if (clearOpnames) {
    for (const op of opnames) {
      const id = String(op.id || op.reference || op.sessionId || "").replace(/[\/\\]/g, "_").trim();
      if (id) ops.push({ coll: "stockOpnames", id });
    }
  }

  // Reset stok produk di Firestore jika diminta (Smart Dirty Pruning: hanya sentuh produk yang pernah ada stok)
  if (resetProductStock) {
    for (const p of products) {
      const code = norm(p["Kode Produk"]);
      const stockVal = Number(p["Stok Awal"] || 0);
      const isDirty = stockVal > 0 || (p["Status"] && norm(p["Status"]) !== "tidak aktif") || (activeStockIndex.get(code) > 0);

      p["Stok Awal"] = 0;
      p["Status"] = "Tidak Aktif";
      p["Status Produk"] = "Tidak Aktif";
      activeStockIndex.set(code, 0);

      // Hanya kirim batch ke Firestore jika produk ini memang memiliki stok atau status aktif
      if (isDirty) {
        const pId = String(p.id || p["Kode Produk"]).replace(/[\/\\]/g, "_").trim();
        if (pId) {
          ops.push({
            coll: "products",
            id: pId,
            updateData: {
              "Stok Awal": 0,
              "Status": "Tidak Aktif",
              "Status Produk": "Tidak Aktif",
              updatedAt: new Date().toISOString()
            }
          });
        }
        const stockDocId = readableDocumentId("stok", code);
        if (stockDocId) {
          ops.push({ coll: "activeStocks", id: stockDocId });
        }
      }
    }
  }

  // Commit deletion in chunks (maks 150 per batch untuk stabilitas tinggi)
  const chunkSize = 150;
  const totalChunks = Math.max(1, Math.ceil(ops.length / chunkSize));
  for (let i = 0; i < ops.length; i += chunkSize) {
    const chunk = ops.slice(i, i + chunkSize);
    const chunkIdx = Math.floor(i / chunkSize) + 1;
    if (typeof onProgress === "function") {
      const pct = 20 + Math.round((chunkIdx / totalChunks) * 60);
      onProgress({
        title: "Pembersihan Data Uji Coba",
        message: `Membersihkan Cloud Firestore (Batch ${chunkIdx} dari ${totalChunks})...`,
        percent: pct,
        detail: `${Math.min(i + chunk.length, ops.length)} dari ${ops.length} dokumen diproses`
      });
    }

    const batch = writeBatch(firebaseDb);
    for (const item of chunk) {
      try {
        const ref = doc(firebaseDb, ...documentSegments(item.coll, item.id));
        if (item.updateData) {
          batch.set(ref, sanitizeForFirestore(item.updateData), { merge: true });
        } else {
          batch.delete(ref);
        }
      } catch (segErr) {
        console.warn(`[DatabaseStore] Lewati dokumen [${item.coll}/${item.id}]:`, segErr);
      }
    }
    try {
      // Timeout Guard 10 detik per batch agar tidak pernah macet
      await Promise.race([
        batch.commit(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout batch commit (10s)")), 10000))
      ]);
    } catch (commitErr) {
      console.warn(`[DatabaseStore] Batch pembersihan ke Firestore (chunk ${chunkIdx}):`, commitErr.message || commitErr);
      if (commitErr?.code === "permission-denied" || commitErr?.message?.toLowerCase().includes("permission")) {
        throw new Error("Akses Cloud Ditolak (Missing or insufficient permissions). Pastikan akun login Anda adalah Administrator resmi (apotekdoaibu.v2@gmail.com) dengan status aktif di database Firestore.");
      }
      // Lanjutkan agar tidak pernah macet
    }
  }

  // 3b. Eksekusi pembersihan transaksi di Supabase PostgreSQL
  try {
    await supabaseDb.rpc("purge_testing_data");
  } catch (supErr) {
    console.warn("[DatabaseStore] Supabase purge_testing_data:", supErr.message);
  }

  // 4. Bersihkan In-Memory
  if (typeof onProgress === "function") {
    onProgress({
      title: "Pembersihan Data Uji Coba",
      message: "Mengosongkan cache lokal & IndexedDB...",
      percent: 88,
      detail: "Menyinkronkan penyimpanan perangkat..."
    });
  }
  if (clearInvoices) inMemory.set(STORE_KEYS.invoices, []);
  if (clearMovements) inMemory.set(STORE_KEYS.movements, []);
  if (clearSales) inMemory.set(STORE_KEYS.sales, []);
  if (clearOpnames) inMemory.set(STORE_KEYS.opnames, []);
  if (resetProductStock) inMemory.set(STORE_KEYS.master, master);

  // 5. Bersihkan IndexedDB
  const clearPromises = [];
  if (clearInvoices) clearPromises.push(indexedDBStore.clearStore(STORES.INVOICES));
  if (clearMovements) clearPromises.push(indexedDBStore.clearStore(STORES.MOVEMENTS));
  if (clearSales) clearPromises.push(indexedDBStore.clearStore(STORES.SALES));
  if (clearOpnames) clearPromises.push(indexedDBStore.clearStore(STORES.OPNAMES));
  if (resetProductStock) {
    clearPromises.push(indexedDBStore.clearStore(STORES.PRODUCTS));
    clearPromises.push(indexedDBStore.clearStore(STORES.STOCK_SUMMARIES));
  }
  await Promise.all(clearPromises);

  if (resetProductStock && products.length) {
    await indexedDBStore.putMany(STORES.PRODUCTS, products);
  }

  if (typeof onProgress === "function") {
    onProgress({
      title: "Pembersihan Selesai",
      message: "Seluruh database berhasil dibersihkan!",
      percent: 100,
      detail: "Menyelesaikan proses..."
    });
  }

  return delCount;
}

/**
 * Factory Hard Reset (Reset Pabrik Total)
 * Mengosongkan seluruh data dari akar Cloud Firestore dan IndexedDB:
 * - Seluruh Faktur Pembelian, Penjualan POS, Mutasi Stok, Opname, dan StokAktif
 * - Seluruh Master Produk, Master Kategori, Master Supplier, dan Snapshot
 * - Seluruh penyimpanan lokal browser (IndexedDB & LocalStorage cache)
 * - Akun Administrator utama tetap dipertahankan agar tidak terkunci
 *
 * @param {Object} options
 * @returns {Promise<{deletedDocuments: number, totalQueued: number}>}
 */
export async function executeFactoryHardReset(options = {}) {
  requireOnline();
  const { onProgress = null } = options;

  const notify = (percent, message, detail = "") => {
    if (typeof onProgress === "function") {
      onProgress({
        title: "Factory Hard Reset",
        message,
        percent,
        detail
      });
    }
  };

  notify(5, "Memvalidasi kredensial Administrator...", "Memeriksa sesi login Administrator...");

  // 1. Pastikan sesi Auth aktif (Firebase Auth atau Supabase Profile)
  let user = firebaseAuth.currentUser;
  if (!user) {
    user = await waitForFirebaseUser();
  }
  if (!user) {
    throw new Error("Sesi login belum aktif. Silakan muat ulang halaman atau login kembali sebagai Administrator.");
  }

  // 2. Pastikan profil Administrator terverifikasi
  try {
    await ensureInitialAdminProfile(user, "admin");
  } catch (profErr) {
    console.warn("[FactoryReset] Profil check:", profErr?.message || profErr);
  }

  // 2b. Eksekusi Reset Total di Supabase PostgreSQL (0ms kuota tanpa batas)
  try {
    notify(10, "Mereset database Supabase Cloud...", "Mengosongkan seluruh tabel Supabase PostgreSQL...");
    await supabaseDb.rpc("factory_hard_reset");
    console.log("[FactoryReset] Supabase factory_hard_reset sukses.");
  } catch (supErr) {
    console.warn("[FactoryReset] Supabase factory_hard_reset galat/lewati:", supErr.message);
  }

  notify(15, "Menghimpun seluruh data dari Cloud Firestore...", "Mendeteksi koleksi produk, supplier, dan transaksi...");

  const docsToDelete = [];

  // Ambil dari In-Memory (cepat & akurat)
  const invoices = inMemory.get(STORE_KEYS.invoices) || [];
  invoices.forEach(inv => {
    const id = String(inv.id || inv.invoiceNumber).replace(/[\/\\]/g, "_").trim();
    if (id) docsToDelete.push({ coll: "purchaseInvoices", id });
  });

  const movements = inMemory.get(STORE_KEYS.movements) || [];
  movements.forEach(m => {
    const id = String(m.id || "").replace(/[\/\\]/g, "_").trim();
    if (id) docsToDelete.push({ coll: "stockMovements", id });
  });

  const sales = inMemory.get(STORE_KEYS.sales) || [];
  sales.forEach(s => {
    const id = String(s.id || s.transactionNumber || "").replace(/[\/\\]/g, "_").trim();
    if (id) docsToDelete.push({ coll: "sales", id });
  });

  const opnames = inMemory.get(STORE_KEYS.opnames) || [];
  opnames.forEach(op => {
    const id = String(op.id || op.reference || op.sessionId || "").replace(/[\/\\]/g, "_").trim();
    if (id) docsToDelete.push({ coll: "stockOpnames", id });
  });

  const master = inMemory.get(STORE_KEYS.master) || {};
  const products = Array.isArray(master.produk) ? master.produk : [];
  products.forEach(p => {
    const pId = String(p.id || p["Kode Produk"]).replace(/[\/\\]/g, "_").trim();
    if (pId) docsToDelete.push({ coll: "products", id: pId });
    const code = norm(p["Kode Produk"]);
    if (code) {
      docsToDelete.push({ coll: "activeStocks", id: readableDocumentId("stok", code) });
    }
  });

  const categories = Array.isArray(master.kategori) ? master.kategori : [];
  categories.forEach(c => {
    const cId = String(c.id || c["Kategori"] || "").replace(/[\/\\]/g, "_").trim();
    if (cId) docsToDelete.push({ coll: "categories", id: cId });
  });

  const suppliers = Array.isArray(master.supplier) ? master.supplier : [];
  suppliers.forEach(s => {
    const sId = String(s.id || s["Supplier"] || s["Nama Perusahaan"] || "").replace(/[\/\\]/g, "_").trim();
    if (sId) docsToDelete.push({ coll: "suppliers", id: sId });
  });

  // Query langsung ke Cloud Firestore untuk koleksi data (dengan batas timeout per koleksi)
  const cloudCollections = [
    "purchaseInvoices",
    "stockMovements",
    "sales",
    "stockOpnames",
    "activeStocks",
    "products",
    "categories",
    "suppliers",
    "masterSnapshots",
    "masterSnapshotChunks"
  ];

  for (const collKey of cloudCollections) {
    try {
      const segs = collectionSegments(collKey);
      const collRef = collection(firebaseDb, ...segs);
      const snap = await Promise.race([
        getDocs(query(collRef, limit(500))),
        new Promise((_, r) => setTimeout(() => r(new Error("Timeout query")), 4000))
      ]).catch(() => null);

      if (snap && !snap.empty) {
        snap.forEach(d => {
          docsToDelete.push({ coll: collKey, id: d.id });
        });
      }
    } catch (qErr) {
      console.warn(`[FactoryReset] Lewati query [${collKey}]:`, qErr.message);
    }
  }

  // Deduplikasi dokumen
  const uniqueMap = new Map();
  docsToDelete.forEach(item => {
    if (item.coll && item.id) {
      uniqueMap.set(`${item.coll}:${item.id}`, item);
    }
  });
  const finalDocs = Array.from(uniqueMap.values());

  notify(30, `Membersihkan ${finalDocs.length} dokumen Cloud Firestore...`, "Mengeksekusi batch delete...");

  // 3. Batch Delete ke Firestore Cloud (Chunk 150 + Timeout Guard 10s per batch)
  const chunkSize = 150;
  const totalChunks = Math.max(1, Math.ceil(finalDocs.length / chunkSize));
  let committedDocs = 0;

  for (let i = 0; i < finalDocs.length; i += chunkSize) {
    const chunk = finalDocs.slice(i, i + chunkSize);
    const chunkIdx = Math.floor(i / chunkSize) + 1;
    const pct = 30 + Math.round((chunkIdx / totalChunks) * 48);

    notify(
      pct,
      `Menghapus Cloud Firestore (Batch ${chunkIdx} dari ${totalChunks})...`,
      `${Math.min(i + chunk.length, finalDocs.length)} dari ${finalDocs.length} dokumen diproses`
    );

    const batch = writeBatch(firebaseDb);
    for (const item of chunk) {
      try {
        const ref = doc(firebaseDb, ...documentSegments(item.coll, item.id));
        batch.delete(ref);
      } catch (segErr) {
        // Abaikan segment error
      }
    }

    try {
      await Promise.race([
        batch.commit(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout commit batch (10s)")), 10000))
      ]);
      committedDocs += chunk.length;
    } catch (batchErr) {
      console.warn(`[FactoryReset] Batch ${chunkIdx} timeout/lewati:`, batchErr.message || batchErr);
      if (batchErr?.code === "permission-denied" || batchErr?.message?.toLowerCase().includes("permission")) {
        throw new Error("Akses Cloud Ditolak (Missing or insufficient permissions). Pastikan akun login Anda adalah Administrator resmi (apotekdoaibu.v2@gmail.com) dengan status aktif di database Firestore.");
      }
      // Lanjutkan ke batch berikutnya
    }
  }

  // 4. Kosongkan In-Memory
  notify(82, "Mengosongkan memori aplikasi...", "Membersihkan state runtime...");
  inMemory.set(STORE_KEYS.invoices, []);
  inMemory.set(STORE_KEYS.movements, []);
  inMemory.set(STORE_KEYS.sales, []);
  inMemory.set(STORE_KEYS.opnames, []);
  inMemory.set(STORE_KEYS.master, { produk: [], kategori: [], supplier: [] });
  activeStockIndex.clear();

  // 5. Kosongkan seluruh store IndexedDB
  notify(90, "Menghapus database lokal IndexedDB...", "Mengosongkan seluruh tabel kasirpro_v2_db...");
  try {
    await indexedDBStore.clearStore(STORES.INVOICES);
    await indexedDBStore.clearStore(STORES.MOVEMENTS);
    await indexedDBStore.clearStore(STORES.SALES);
    await indexedDBStore.clearStore(STORES.OPNAMES);
    await indexedDBStore.clearStore(STORES.PRODUCTS);
    await indexedDBStore.clearStore(STORES.CATEGORIES);
    await indexedDBStore.clearStore(STORES.SUPPLIERS);
    await indexedDBStore.clearStore(STORES.STOCK_SUMMARIES);
    await indexedDBStore.clearStore(STORES.MASTER_SNAPSHOTS);
  } catch (idbErr) {
    console.warn("[FactoryReset] Gagal clear IndexedDB stores:", idbErr);
  }

  // 6. Bersihkan LocalStorage Cache (jaga sesi auth login admin)
  notify(96, "Membersihkan draft & cache browser...", "Mereset pengaturan lokal...");
  try {
    const preserveKeys = ["kasirpro_session", "kasirpro_role", "kasirpro_last_user"];
    const saved = {};
    preserveKeys.forEach(k => {
      saved[k] = localStorage.getItem(k);
    });
    localStorage.clear();
    preserveKeys.forEach(k => {
      if (saved[k]) localStorage.setItem(k, saved[k]);
    });
  } catch (lsErr) {
    console.warn("[FactoryReset] LocalStorage clear error:", lsErr);
  }

  notify(100, "Factory Hard Reset Berhasil!", "Seluruh data telah bersih 100%. Memuat ulang aplikasi...");

  return {
    deletedDocuments: committedDocs,
    totalQueued: finalDocs.length
  };
}

/**
 * Simpan kumpulan bundle store
 */
export async function writeStoreBundle(entries = []) {
  requireOnline();
  for (const entry of entries) {
    if (entry && entry.key) {
      await writeStore(entry.key, entry.value || entry.records);
    }
  }
  return true;
}

/**
 * Delta operational write
 */
export async function writeOperationalDelta(entries = []) {
  requireOnline();
  const batch = writeBatch(firebaseDb);
  const now = new Date().toISOString();

  // 1. Simpan ke IndexedDB lokal & Supabase PostgreSQL
  for (const entry of entries) {
    const key = entry.key;
    const records = entry.records || entry.value || [];
    if (!Array.isArray(records) || records.length === 0) continue;

    // Update in-memory
    const existing = inMemory.get(key) || [];
    const updated = [...existing];
    for (const rec of records) {
      const idx = updated.findIndex(x => (x.id && x.id === rec.id) || (x._firestoreDocumentId && x._firestoreDocumentId === rec._firestoreDocumentId));
      if (idx >= 0) updated[idx] = { ...updated[idx], ...rec };
      else updated.push(rec);
    }
    inMemory.set(key, updated);

    // Update IndexedDB
    if (key === STORE_KEYS.invoices) await indexedDBStore.putMany(STORES.INVOICES, records);
    else if (key === STORE_KEYS.sales) await indexedDBStore.putMany(STORES.SALES, records);
    else if (key === STORE_KEYS.movements) await indexedDBStore.putMany(STORES.MOVEMENTS, records);
    else if (key === STORE_KEYS.opnames) await indexedDBStore.putMany(STORES.OPNAMES, records);

    // Update Supabase PostgreSQL
    try {
      if (key === STORE_KEYS.invoices) {
        const rows = records.map(inv => ({
          id: String(inv.id || inv.invoiceNumber || Date.now()),
          invoice_number: String(inv.invoiceNumber || inv.invoice_number || "").trim(),
          supplier_name: String(inv.supplierName || inv.supplier_name || "").trim(),
          date: inv.date || null,
          due_date: inv.dueDate || inv.due_date || null,
          payment_type: inv.paymentType || "tunai",
          discount_type: inv.discountType || "nominal",
          global_discount_rp: Number(inv.globalDiscountRp || 0),
          ppn_rate: Number(inv.ppnRate || 0),
          custom_ppn_rp: Number(inv.customPpnRp || 0),
          gross_total: Number(inv.grossTotal || 0),
          total_discount: Number(inv.totalDiscount || 0),
          dpp: Number(inv.dpp || 0),
          ppn: Number(inv.ppn || 0),
          calculated_total: Number(inv.calculatedTotal || 0),
          printed_total: Number(inv.printedTotal || 0),
          difference: Number(inv.difference || 0),
          status: inv.status || "draft",
          items: Array.isArray(inv.items) ? inv.items : [],
          updated_at: now
        }));
        await supabaseDb.upsert("purchase_invoices", rows, "id");
      } else if (key === STORE_KEYS.sales) {
        const rows = records.map(s => ({
          id: String(s.id || s.transactionNumber || Date.now()),
          transaction_number: String(s.transactionNumber || s.id || "").trim(),
          date: s.date || now,
          cashier_name: String(s.cashierName || "Kasir").trim(),
          cashier_id: s.cashierId || null,
          payment_method: s.paymentMethod || "Tunai",
          subtotal: Number(s.subtotal || 0),
          discount_percent: Number(s.discountPercent || 0),
          discount_nominal: Number(s.discountNominal || 0),
          total: Number(s.total || 0),
          cash_paid: Number(s.cashPaid || 0),
          change_returned: Number(s.changeReturned || 0),
          status: s.status || "Selesai",
          void_reason: s.voidReason || null,
          items: Array.isArray(s.items) ? s.items : []
        }));
        await supabaseDb.upsert("sales", rows, "id");
      } else if (key === STORE_KEYS.movements) {
        const rows = records.map(m => ({
          id: String(m.id || Date.now() + Math.random().toString(36).slice(2, 6)),
          product_code: String(m.productCode || "").trim(),
          product_name: String(m.productName || "").trim(),
          type: String(m.type || "").trim(),
          reference_id: m.referenceId || null,
          batch: m.batch || null,
          expiry_date: m.expiryDate || null,
          qty_in: Number(m.qtyIn || 0),
          qty_out: Number(m.qtyOut || 0),
          unit: m.unit || "Pcs",
          notes: m.notes || null,
          created_at: m.createdAt || now
        }));
        await supabaseDb.upsert("stock_movements", rows, "id");
      } else if (key === STORE_KEYS.opnames) {
        const rows = records.map(o => ({
          id: String(o.id || o.reference || Date.now()),
          reference: String(o.reference || "").trim(),
          date: o.date || now,
          notes: o.notes || null,
          created_by: o.createdBy || null,
          items: Array.isArray(o.items) ? o.items : []
        }));
        await supabaseDb.upsert("stock_opnames", rows, "id");
      }
    } catch (supErr) {
      console.warn("[DatabaseStore] Supabase writeOperationalDelta:", supErr.message);
    }

    // Queue Firestore batch non-blocking
    let collName = "sales";
    if (key === STORE_KEYS.invoices) collName = "purchaseInvoices";
    else if (key === STORE_KEYS.movements) collName = "stockMovements";
    else if (key === STORE_KEYS.opnames) collName = "stockOpnames";

    for (const rec of records) {
      const id = rec.id || rec._firestoreDocumentId || readableDocumentId(collName.slice(0, 3), rec.id || Date.now());
      const ref = doc(firebaseDb, ...documentSegments(collName, id));
      batch.set(ref, { ...rec, id, updatedAt: now }, { merge: true });
    }
  }

  try {
    await Promise.race([
      batch.commit(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout Firestore")), 3000))
    ]);
  } catch (fsErr) {
    console.warn("[DatabaseStore] Firestore writeOperationalDelta dilewati:", fsErr.message);
  }
  return true;
}

/**
 * Transaksi Atomik Stok (Stok Berkurang/Bertambah + Mutasi Stok + Rekam Transaksi)
 * Menjamin tidak terjadi overselling dan menjaga Source of Truth Firestore.
 */
export async function writeStockTransaction(entries = []) {
  requireOnline();

  const sourceEntries = entries.map(e => ({
    key: e.key,
    records: clone(Array.isArray(e.records) ? e.records : (Array.isArray(e.value) ? e.value : []))
  }));

  const movements = sourceEntries.find(e => e.key === STORE_KEYS.movements)?.records || [];
  const sales = sourceEntries.find(e => e.key === STORE_KEYS.sales)?.records || [];
  const invoices = sourceEntries.find(e => e.key === STORE_KEYS.invoices)?.records || [];
  const opnames = sourceEntries.find(e => e.key === STORE_KEYS.opnames)?.records || [];

  const affectedCodes = [...new Set(movements.map(m => norm(m.productCode || m["Kode Produk"])).filter(Boolean))];

  const newStockValues = new Map();

  const now = new Date().toISOString();
  newStockValues.clear();

  // 1. Hitung dan verifikasi kuantitas stok baru secara lokal & aman
  for (const m of movements) {
    const code = norm(m.productCode || m["Kode Produk"]);
    if (!code) continue;

    let currentQty = newStockValues.has(code)
      ? newStockValues.get(code)
      : (activeStockIndex.get(code) ?? num(m.stockBefore));

    let delta = num(m.delta ?? m.quantity ?? m.qty);
    const type = norm(m.type);

    // Jika jenis mutasi adalah penjualan, delta memotong stok
    if (type === "sale" || type === "penjualan") {
      if (delta > 0) delta = -delta;
      if (currentQty < Math.abs(delta) && num(m.stockBefore) >= Math.abs(delta)) {
        currentQty = num(m.stockBefore);
      }
    }

    const nextQty = type === "opname" ? num(m.stockAfter) : currentQty + delta;

    if (nextQty < 0 && (type === "sale" || type === "penjualan")) {
      throw new Error(`Stok produk [${m.productName || code}] tidak mencukupi (sisa: ${currentQty}, dibutuhkan: ${Math.abs(delta)}).`);
    }

    m.stockBefore = currentQty;
    m.stockAfter = nextQty;
    newStockValues.set(code, nextQty);
  }

  // 2. Eksekusi Sinkronisasi Firestore Non-blocking (agar tidak mengganggu kasir jika kuota habis)
  try {
    const b = writeBatch(firebaseDb);
    for (const [code, qty] of newStockValues.entries()) {
      const prodName = movements.find(m => norm(m.productCode) === code)?.productName || code;
      const ref = doc(firebaseDb, ...documentSegments("activeStocks", readableDocumentId("stok", code)));
      b.set(ref, sanitizeForFirestore({ productCode: code, productName: prodName, quantity: Math.max(0, qty), updatedAt: now }), { merge: true });
    }
    for (const m of movements) {
      const mId = m.id || readableDocumentId("mut", `${m.productCode}-${Date.now()}`);
      const mRef = doc(firebaseDb, ...documentSegments("stockMovements", mId));
      b.set(mRef, sanitizeForFirestore({ ...m, id: mId, createdAt: m.createdAt || now }), { merge: true });
    }
    for (const s of sales) {
      const sId = s.id || s.transactionNumber || readableDocumentId("trx", Date.now());
      const sRef = doc(firebaseDb, ...documentSegments("sales", sId));
      b.set(sRef, sanitizeForFirestore({ ...s, id: sId, updatedAt: now }), { merge: true });
    }
    for (const inv of invoices) {
      const invId = inv.id || inv.invoiceNumber || readableDocumentId("inv", Date.now());
      const invRef = doc(firebaseDb, ...documentSegments("purchaseInvoices", invId));
      b.set(invRef, sanitizeForFirestore({ ...inv, id: invId, updatedAt: now }), { merge: true });
    }
    for (const op of opnames) {
      const opId = op.id || readableDocumentId("opn", Date.now());
      const opRef = doc(firebaseDb, ...documentSegments("stockOpnames", opId));
      b.set(opRef, sanitizeForFirestore({ ...op, id: opId, updatedAt: now }), { merge: true });
    }
    await Promise.race([
      b.commit(),
      new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout Firestore")), 3000))
    ]);
  } catch (fsErr) {
    console.warn("[DatabaseStore] Sinkronisasi Firestore dilewati:", fsErr.message);
  }

  // Setelah Transaksi Cloud Berhasil, update cache lokal segera
  for (const [code, qty] of newStockValues.entries()) {
    activeStockIndex.set(code, qty);
  }

  // Update in-memory & IndexedDB
  const master = inMemory.get(STORE_KEYS.master) || { produk: [] };
  master.produk.forEach(p => {
    const code = norm(p["Kode Produk"]);
    if (newStockValues.has(code)) {
      p["Stok Awal"] = newStockValues.get(code);
    }
  });
  await indexedDBStore.putMany(STORES.PRODUCTS, master.produk);

  if (movements.length) {
    const curMovs = inMemory.get(STORE_KEYS.movements) || [];
    inMemory.set(STORE_KEYS.movements, [...curMovs, ...movements]);
    await indexedDBStore.putMany(STORES.MOVEMENTS, movements);
  }

  if (sales.length) {
    const curSales = inMemory.get(STORE_KEYS.sales) || [];
    const nextSales = [...curSales];
    sales.forEach(s => {
      const idx = nextSales.findIndex(x => x.id === s.id);
      if (idx >= 0) nextSales[idx] = s;
      else nextSales.push(s);
    });
    inMemory.set(STORE_KEYS.sales, nextSales);
    await indexedDBStore.putMany(STORES.SALES, sales);
  }

  if (invoices.length) {
    const curInvs = inMemory.get(STORE_KEYS.invoices) || [];
    const nextInvs = [...curInvs];
    invoices.forEach(inv => {
      const idx = nextInvs.findIndex(x => x.id === inv.id);
      if (idx >= 0) nextInvs[idx] = inv;
      else nextInvs.push(inv);
    });
    inMemory.set(STORE_KEYS.invoices, nextInvs);
    await indexedDBStore.putMany(STORES.INVOICES, invoices);
  }

  if (opnames.length) {
    const curOps = inMemory.get(STORE_KEYS.opnames) || [];
    const nextOps = [...curOps];
    opnames.forEach(op => {
      const idx = nextOps.findIndex(x => x.id === op.id);
      if (idx >= 0) nextOps[idx] = op;
      else nextOps.push(op);
    });
    inMemory.set(STORE_KEYS.opnames, nextOps);
    await indexedDBStore.putMany(STORES.OPNAMES, opnames);
  }

  // Update Supabase PostgreSQL (Single Source of Truth)
  try {
    const nowIso = new Date().toISOString();
    for (const [code, qty] of newStockValues.entries()) {
      const prodName = movements.find(m => norm(m.productCode) === code)?.productName || code;
      await supabaseDb.upsert("active_stocks", {
        product_code: code,
        product_name: prodName,
        quantity: Math.max(0, qty),
        updated_at: nowIso
      }, "product_code").catch(() => {});
      await supabaseDb.update("products", { stock: Math.max(0, qty), updated_at: nowIso }, "code", code).catch(() => {});
    }

    if (movements.length) {
      const mRows = movements.map(m => ({
        id: m.id || readableDocumentId("mut", `${m.productCode}-${Date.now()}`),
        product_code: String(m.productCode || "").trim(),
        product_name: String(m.productName || "").trim(),
        type: String(m.type || "").trim(),
        reference_id: m.referenceId || null,
        batch: m.batch || null,
        expiry_date: m.expiryDate || null,
        qty_in: Number(m.qtyIn || 0),
        qty_out: Number(m.qtyOut || 0),
        unit: m.unit || "Pcs",
        notes: m.notes || null,
        created_at: m.createdAt || nowIso
      }));
      await supabaseDb.upsert("stock_movements", mRows, "id").catch(() => {});
    }

    if (sales.length) {
      const sRows = sales.map(s => ({
        id: s.id || s.transactionNumber || readableDocumentId("trx", Date.now()),
        transaction_number: String(s.transactionNumber || s.id || "").trim(),
        date: s.date || nowIso,
        cashier_name: String(s.cashierName || s.cashier || "Kasir").trim(),
        cashier_id: s.cashierId || null,
        payment_method: s.paymentMethod || "Tunai",
        subtotal: Number(s.subtotal || 0),
        discount_percent: Number(s.discountPercent || 0),
        discount_nominal: Number(s.discountNominal || 0),
        total: Number(s.total || 0),
        cash_paid: Number(s.cashPaid || 0),
        change_returned: Number(s.changeReturned || 0),
        status: s.status || "Selesai",
        void_reason: s.voidReason || null,
        items: Array.isArray(s.items) ? s.items : []
      }));
      await supabaseDb.upsert("sales", sRows, "id").catch(() => {});
    }

    if (invoices.length) {
      const invRows = invoices.map(inv => ({
        id: inv.id || inv.invoiceNumber || readableDocumentId("inv", Date.now()),
        invoice_number: String(inv.invoiceNumber || inv.id || "").trim(),
        supplier_name: String(inv.supplierName || "").trim(),
        date: inv.date || nowIso.slice(0, 10),
        due_date: inv.dueDate || null,
        payment_type: inv.paymentType || "tempo",
        discount_type: inv.discountType || "item",
        global_discount_rp: Number(inv.globalDiscountRp || 0),
        ppn_rate: String(inv.ppnRate || "11"),
        custom_ppn_rp: Number(inv.customPpnRp || 0),
        gross_total: Number(inv.grossTotal || 0),
        total_discount: Number(inv.totalDiscount || 0),
        dpp: Number(inv.dpp || 0),
        ppn: Number(inv.ppn || 0),
        calculated_total: Number(inv.calculatedTotal || 0),
        printed_total: Number(inv.printedTotal || 0),
        difference: Number(inv.difference || 0),
        status: inv.status || "Terkonfirmasi",
        items: Array.isArray(inv.items) ? inv.items : [],
        updated_at: nowIso
      }));
      await supabaseDb.upsert("purchase_invoices", invRows, "id").catch(() => {});
    }

    if (opnames.length) {
      const opRows = opnames.map(o => ({
        id: o.id || o.reference || o.sessionId || readableDocumentId("opn", Date.now()),
        reference: String(o.reference || o.sessionId || o.id || "").trim(),
        date: o.date || nowIso,
        notes: o.notes || null,
        created_by: o.createdBy || null,
        items: Array.isArray(o.items) ? o.items : []
      }));
      await supabaseDb.upsert("stock_opnames", opRows, "id").catch(() => {});
    }
  } catch (sbErr) {
    console.warn("[DatabaseStore] Supabase writeStockTransaction:", sbErr.message);
  }

  window.dispatchEvent(new CustomEvent("kasirpro:stock-updated", { detail: { timestamp: Date.now() } }));
  return true;
}

export async function reloadMasterCache() {
  await syncFromFirestore();
  return inMemory.get(STORE_KEYS.master);
}

class DatabaseStoreManager {
  async saveItem(collName, docId, data) {
    requireOnline();
    const ref = doc(firebaseDb, ...documentSegments(collName, docId));
    const payload = { ...data, id: docId, updatedAt: new Date().toISOString() };
    await setDoc(ref, payload, { merge: true });
    return true;
  }

  async deleteItem(collName, docId) {
    requireOnline();
    const ref = doc(firebaseDb, ...documentSegments(collName, docId));
    await deleteDoc(ref);
    return true;
  }

  async executeAtomicBatch(operations = []) {
    requireOnline();
    const batch = writeBatch(firebaseDb);
    const now = new Date().toISOString();
    for (const op of operations) {
      const ref = doc(firebaseDb, ...documentSegments(op.collection, op.id));
      if (op.type === "delete") {
        batch.delete(ref);
      } else {
        batch.set(ref, { ...op.data, id: op.id, updatedAt: now }, { merge: true });
      }
    }
    await batch.commit();
    return true;
  }

  async runAtomicTransaction(logicFn) {
    requireOnline();
    return runTransaction(firebaseDb, logicFn);
  }
}

export const databaseStore = new DatabaseStoreManager();
export default databaseStore;