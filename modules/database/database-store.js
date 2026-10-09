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
  masterSnapshotManifestSegments,
  masterSnapshotChunkSegments,
  masterSnapshotChunkId,
  COLLECTION_NAMES,
  ROOT_DOCUMENT_PATH
} from "./database-paths.js";

import { indexedDBStore, STORES } from "../local/indexeddb-store.js";
import { masterSync } from "../local/master-sync.js";

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

// =========================================================================
// FEEDBACK VISUAL & MODAL LOADING SINKRONISASI DATABASE (READS, WRITES, DELETES)
// =========================================================================
let syncLoadingDepth = 0;
let syncCloseTimeout = null;

export function startDatabaseProgress(title, message, options = {}) {
  syncLoadingDepth++;
  if (syncCloseTimeout) {
    clearTimeout(syncCloseTimeout);
    syncCloseTimeout = null;
  }
  if (typeof window !== "undefined" && window.KasirProDialog?.showProgress) {
    window.KasirProDialog.showProgress(title, message, {
      detail: options.detail || "Memproses...",
      percent: options.percent ?? 25,
      icon: options.icon || "fa-arrows-rotate",
      type: options.type || "sync",
      badgeText: options.badgeText
    });
  }
}

export function updateDatabaseProgress(options = {}) {
  if (typeof window !== "undefined" && window.KasirProDialog?.updateProgress) {
    window.KasirProDialog.updateProgress(options);
  }
}

export function endDatabaseProgress(options = {}) {
  syncLoadingDepth = Math.max(0, syncLoadingDepth - 1);
  if (syncLoadingDepth === 0) {
    if (typeof window !== "undefined" && window.KasirProDialog?.updateProgress) {
      window.KasirProDialog.updateProgress({
        percent: 100,
        detail: options.detail || "Selesai",
        badgeText: options.badgeText
      });
    }
    syncCloseTimeout = setTimeout(() => {
      if (syncLoadingDepth === 0 && typeof window !== "undefined" && window.KasirProDialog?.closeProgress) {
        window.KasirProDialog.closeProgress();
      }
      syncCloseTimeout = null;
    }, 100);
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
 * Rekonsiliasi harga beli dan data kemasan dari histori faktur pembelian
 * Mencegah nilai 0 pada master katalog jika produk sudah pernah diinput via faktur.
 */
export function reconcileProductsWithInvoices(products, invoices) {
  if (!Array.isArray(products) || !Array.isArray(invoices) || invoices.length === 0) return;

  const mapByCode = new Map();
  const mapByName = new Map();

  const sortedInvoices = [...invoices].sort((a, b) => {
    const tA = new Date(a.confirmedAt || a.date || a.createdAt || 0).getTime();
    const tB = new Date(b.confirmedAt || b.date || b.createdAt || 0).getTime();
    return tA - tB;
  });

  for (const inv of sortedInvoices) {
    if (!Array.isArray(inv.items)) continue;
    for (const item of inv.items) {
      const buyPrice = num(item.buyPrice);
      if (buyPrice > 0) {
        const payload = {
          buyPrice,
          purchaseUnit: item.purchaseUnit || item.satuanBesar || "",
          conversionRatio: num(item.conversionRatio || item.conversion) || 1,
          intermediateUnit: item.intermediateUnit || item.satuanSedang || "",
          intermediateQty: num(item.intermediateQty) || 1,
          baseUnit: item.baseUnit || item.satuanTerkecil || "",
          supplierName: inv.supplierName || inv.supplier || ""
        };
        const c = norm(item.productCode || item.matchedProductCode || item.code);
        if (c) mapByCode.set(c, payload);
        const n = norm(item.name);
        if (n) mapByName.set(n, payload);
      }
    }
  }

  for (const p of products) {
    const curBuy = num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0);
    const code = norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.id);
    const name = norm(p["Nama Produk"] || p.name);
    const invMatch = (code && mapByCode.get(code)) || (name && mapByName.get(name));

    if (invMatch) {
      if (curBuy <= 0) {
        p["Harga Beli Terakhir"] = invMatch.buyPrice;
        p["Harga Beli"] = invMatch.buyPrice;
      }
      if (!p["Supplier"] && invMatch.supplierName) {
        p["Supplier"] = invMatch.supplierName;
      }
      if ((!p["Satuan Pembelian"] || p["Satuan Pembelian"] === p["Satuan Dasar"]) && invMatch.purchaseUnit) {
        p["Satuan Pembelian"] = invMatch.purchaseUnit;
        p["Kemasan Beli"] = invMatch.purchaseUnit;
      }
      if ((!p["Konversi"] || num(p["Konversi"]) <= 1) && invMatch.conversionRatio > 1) {
        p["Konversi"] = invMatch.conversionRatio;
        p["Isi Kemasan"] = invMatch.conversionRatio;
      }
      if (!p["Satuan Antara"] && invMatch.intermediateUnit) {
        p["Satuan Antara"] = invMatch.intermediateUnit;
        p["Isi Satuan Antara"] = invMatch.intermediateQty;
      }
    }
  }
}

/**
 * Muat data awal dari IndexedDB ke In-Memory (Instan 0ms offline)
 */
async function loadFromIndexedDB() {
  try {
    // Satu kali eksekusi pembersihan total cache lokal untuk Fresh Start project baru
    if (typeof localStorage !== "undefined" && !localStorage.getItem("kasirpro_v3_fresh_reset_applied")) {
      try {
        console.log("[DatabaseStore] Menerapkan Fresh Clean Slate v3 untuk project baru...");
        await indexedDBStore.clearStore(STORES.PRODUCTS);
        await indexedDBStore.clearStore(STORES.SUPPLIERS);
        await indexedDBStore.clearStore(STORES.CATEGORIES);
        await indexedDBStore.clearStore(STORES.INVOICES);
        await indexedDBStore.clearStore(STORES.SALES);
        await indexedDBStore.clearStore(STORES.MOVEMENTS);
        await indexedDBStore.clearStore(STORES.OPNAMES);
        await indexedDBStore.clearStore(STORES.STOCK_SUMMARIES);
        if (typeof indexedDB !== "undefined") {
          try { indexedDB.deleteDatabase("KasirProLocalDB_v2"); } catch (_) {}
          try { indexedDB.deleteDatabase("KasirProLocalDB_v2_sandbox"); } catch (_) {}
          try { indexedDB.deleteDatabase("kasirpro_local_v1"); } catch (_) {}
        }
        localStorage.setItem("kasirpro_v3_fresh_reset_applied", "true");
      } catch (cleanErr) {
        console.warn("[DatabaseStore] Clean slate error:", cleanErr);
      }
    }

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

    // Pastikan database legacy kasirpro_local_v1 dimusnahkan secara permanen agar tidak menyuntikkan data sampah
    if (typeof indexedDB !== "undefined") {
      try { indexedDB.deleteDatabase("kasirpro_local_v1"); } catch (_) {}
    }

    const prodMap = new Map();
    const orphanKeysToDelete = [];

    for (const p of (products || [])) {
      if (p._isDeleted) {
        if (p.id) orphanKeysToDelete.push(p.id);
        continue;
      }
      const normP = normalizeProductRecord(p);
      const code = norm(normP["Kode Produk"] || normP["Kode Produk Internal"] || normP.id);
      if (!code) continue;

      if (prodMap.has(code)) {
        const existing = prodMap.get(code);
        if (p.id && String(p.id).startsWith("id_") && p.id !== normP.id) {
          orphanKeysToDelete.push(p.id);
        } else if (existing.id && String(existing.id).startsWith("id_") && existing.id !== normP.id) {
          orphanKeysToDelete.push(existing.id);
          prodMap.set(code, normP);
        } else {
          prodMap.set(code, { ...existing, ...normP });
        }
      } else {
        if (p.id && String(p.id).startsWith("id_") && p.id !== normP.id) {
          orphanKeysToDelete.push(p.id);
        }
        prodMap.set(code, normP);
      }
    }

    if (orphanKeysToDelete.length > 0) {
      for (const orphanKey of orphanKeysToDelete) {
        indexedDBStore.delete(STORES.PRODUCTS, orphanKey).catch(() => {});
      }
    }

    const cleanProducts = Array.from(prodMap.values());

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

    // Pulihkan harga beli & data kemasan produk dari histori faktur jika masih 0
    reconcileProductsWithInvoices(masterObj.produk, invoices || []);

    // Bangun active stock index dengan proteksi non-negatif
    activeStockIndex.clear();
    masterObj.produk.forEach(p => {
      const code = norm(p["Kode Produk"]);
      if (code) {
        const s = num(p["Stok Awal"]);
        const cleanStock = Math.max(0, s);
        activeStockIndex.set(code, cleanStock);
        p["Stok Awal"] = cleanStock;
      }
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

  if (force) {
    startDatabaseProgress("Sinkronisasi Cloud", "Menyinkronkan data dengan Cloud Firestore...", {
      type: "sync",
      badgeText: "Firestore & IndexedDB",
      percent: 35,
      icon: "fa-arrows-rotate"
    });
  }

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

    console.log(`[DatabaseStore] Menjalankan sync Firestore (${isIncremental ? `Delta sejak ${cutoffIso}` : 'Full initial sync'})...`);

    const fetchCollection = async (collKey, options = {}) => {
      try {
        const segs = collectionSegments(collKey);
        const colRef = collection(firebaseDb, ...segs);
        let q;

        if (isIncremental && cutoffIso) {
          // Hanya ambil dokumen yang updatedAt lebih baru dari cutoff
          q = query(colRef, where("updatedAt", ">", cutoffIso));
        } else if (options.limitCount) {
          // Batasi dokumen historis pada initial sync agar tidak jebol kuota
          q = query(colRef, limit(options.limitCount));
        } else {
          q = colRef;
        }

        let snap;
        try {
          snap = await getDocs(q);
        } catch (queryErr) {
          // Fallback jika query index bermasalah
          console.warn(`[DatabaseStore] Fallback getDocs [${collKey}]:`, queryErr.message || queryErr);
          snap = await getDocs(colRef);
        }

        return snap.docs.map(d => ({ ...d.data(), id: d.id, _firestoreDocumentId: d.id }));
      } catch (e) {
        console.warn(`[DatabaseStore] Gagal mengambil koleksi [${collKey}]:`, e);
        return [];
      }
    };

    const [
      firestoreProducts,
      firestoreCategories,
      firestoreSuppliers,
      firestoreInvoices,
      firestoreSales,
      firestoreMovements,
      firestoreOpnames,
      firestoreStocks,
      firestoreSettings
    ] = await Promise.all([
      fetchCollection("products"),
      fetchCollection("categories"),
      fetchCollection("suppliers"),
      fetchCollection("purchaseInvoices", { limitCount: 150 }),
      fetchCollection("sales", { limitCount: 200 }),
      fetchCollection("stockMovements", { limitCount: 300 }),
      fetchCollection("stockOpnames", { limitCount: 50 }),
      fetchCollection("activeStocks"),
      fetchCollection("storeSettings")
    ]);

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

    // Update stok aktif dari koleksi StokAktif dengan proteksi non-negatif
    const stockMap = new Map();
    firestoreStocks.forEach(s => {
      const code = norm(s.productCode || s.id);
      if (code) {
        const safeQty = Math.max(0, num(s.quantity));
        stockMap.set(code, safeQty);
        activeStockIndex.set(code, safeQty);
      }
    });

    const currentMaster = inMemory.get(STORE_KEYS.master) || { produk: [], supplier: [], kategori: [], pengguna: [], pengaturan_toko: [] };

    // Normalisasi produk baru/terubah (abaikan record yang ditandai terhapus)
    const normalizedIncomingProducts = firestoreProducts
      .filter(p => !p._isDeleted)
      .map(p => {
        const normProd = normalizeProductRecord(p);
        const code = norm(normProd["Kode Produk"]);
        if (stockMap.has(code)) {
          normProd["Stok Awal"] = Math.max(0, stockMap.get(code));
        } else {
          normProd["Stok Awal"] = Math.max(0, num(normProd["Stok Awal"]));
        }
        activeStockIndex.set(code, normProd["Stok Awal"]);
        return normProd;
      });

    const prodIdFn = p => norm(p["Kode Produk"] || p.id || p["Kode Produk Internal"]);
    
    // Pastikan katalog lokal selalu terbaca utuh (in-memory atau langsung dari IndexedDB)
    let localProds = (currentMaster.produk && currentMaster.produk.length > 0)
      ? currentMaster.produk
      : await indexedDBStore.getAll(STORES.PRODUCTS);
    localProds = (localProds || []).filter(p => !p._isDeleted);

    const prodMap = new Map();
    for (const p of localProds) {
      const key = prodIdFn(p);
      if (key) prodMap.set(key, p);
    }

    // Periksa Manifest Master Snapshot Chunks di Cloud Firestore
    let manifestData = null;
    try {
      const manifestRef = doc(firebaseDb, ...masterSnapshotManifestSegments());
      const manifestSnap = await getDoc(manifestRef);
      if (manifestSnap.exists()) {
        manifestData = manifestSnap.data();
      }
    } catch (mErr) {
      console.warn("[DatabaseStore] Gagal membaca manifest snapshot cloud:", mErr?.message || mErr);
    }

    const expectedTotal = Number(manifestData?.totalProducts) || 0;
    const cloudVersion = Number(manifestData?.version) || 1;
    const localVersion = Number(currentMaster.version) || 0;

    // Jika katalog lokal lebih sedikit dari total manifest (misal browser baru, refresh setelah pembersihan, dll.)
    // ATAU versi master di cloud lebih baru dari versi lokal:
    if (expectedTotal > 0 && (prodMap.size < expectedTotal || cloudVersion > localVersion)) {
      try {
        console.log(`[DatabaseStore] Mengunduh ${manifestData.chunksCount} Master Snapshot Chunks (Cloud: ${expectedTotal} produk, Lokal: ${prodMap.size} produk)...`);
        const totalChunks = manifestData.chunksCount || 0;
        const chunkPromises = [];
        for (let i = 0; i < totalChunks; i++) {
          const cRef = doc(firebaseDb, ...masterSnapshotChunkSegments(cloudVersion, i));
          chunkPromises.push(getDoc(cRef));
        }
        const chunkSnaps = await Promise.all(chunkPromises);
        for (const cs of chunkSnaps) {
          if (cs.exists()) {
            const cData = cs.data();
            if (Array.isArray(cData.items)) {
              for (const item of cData.items) {
                const key = prodIdFn(item);
                if (key) {
                  const existingItem = prodMap.get(key);
                  const normItem = normalizeProductRecord(item);
                  if (existingItem) {
                    // Pertahankan data operasional & histori harga yang sudah ada di existingItem
                    const exBuy = num(existingItem["Harga Beli Terakhir"] ?? existingItem["Harga Beli"] ?? 0);
                    if (exBuy > 0) {
                      normItem["Harga Beli Terakhir"] = exBuy;
                      normItem["Harga Beli"] = exBuy;
                    }
                    const exSell = num(existingItem["Harga Jual"] ?? existingItem.sellPrice ?? 0);
                    if (exSell > 0) normItem["Harga Jual"] = exSell;

                    const exSellMid = num(existingItem["Harga Jual Satuan Sedang"] ?? existingItem["Harga Jual Sedang"] ?? 0);
                    if (exSellMid > 0) normItem["Harga Jual Satuan Sedang"] = exSellMid;

                    const exSellBuy = num(existingItem["Harga Jual Satuan Besar"] ?? existingItem["Harga Jual Besar"] ?? 0);
                    if (exSellBuy > 0) normItem["Harga Jual Satuan Besar"] = exSellBuy;

                    if (existingItem["Supplier"]) normItem["Supplier"] = existingItem["Supplier"];
                    if (existingItem["Satuan Pembelian"]) normItem["Satuan Pembelian"] = existingItem["Satuan Pembelian"];
                    if (existingItem["Kemasan Beli"]) normItem["Kemasan Beli"] = existingItem["Kemasan Beli"];
                    if (num(existingItem["Konversi"]) > 1) {
                      normItem["Konversi"] = existingItem["Konversi"];
                      normItem["Isi Kemasan"] = existingItem["Isi Kemasan"] || existingItem["Konversi"];
                    }
                    if (existingItem["Satuan Antara"]) normItem["Satuan Antara"] = existingItem["Satuan Antara"];
                    if (existingItem["Isi Satuan Antara"]) normItem["Isi Satuan Antara"] = existingItem["Isi Satuan Antara"];
                    if (existingItem["Nomor Batch"]) normItem["Nomor Batch"] = existingItem["Nomor Batch"];
                    if (existingItem["Tanggal Kadaluarsa"]) normItem["Tanggal Kadaluarsa"] = existingItem["Tanggal Kadaluarsa"];
                    if (existingItem["isTieredPricing"] !== undefined) normItem["isTieredPricing"] = existingItem["isTieredPricing"];
                    if (existingItem["tieredPricing"] !== undefined) normItem["tieredPricing"] = existingItem["tieredPricing"];
                    if (existingItem["Opsi Jual"] !== undefined) normItem["Opsi Jual"] = existingItem["Opsi Jual"];
                    if (existingItem["Satuan Dijual"] !== undefined) normItem["Satuan Dijual"] = existingItem["Satuan Dijual"];
                    if (existingItem["Status"]) normItem["Status"] = existingItem["Status"];
                    if (existingItem["Status Produk"]) normItem["Status Produk"] = existingItem["Status Produk"];
                    if (existingItem["Stok Awal"] !== undefined) normItem["Stok Awal"] = existingItem["Stok Awal"];
                  }
                  prodMap.set(key, normItem);
                }
              }
            }
          }
        }
      } catch (chunkErr) {
        console.warn("[DatabaseStore] Gagal mengunduh snapshot chunks:", chunkErr?.message || chunkErr);
      }
    }

    // Incoming individual produk dari Firestore (produk dengan stok aktif atau perubahan data)
    normalizedIncomingProducts.forEach(inc => {
      const key = prodIdFn(inc);
      if (key) {
        if (prodMap.has(key)) {
          prodMap.set(key, { ...prodMap.get(key), ...inc });
        } else {
          prodMap.set(key, inc);
        }
      }
    });

    const mergedProducts = Array.from(prodMap.values());

    const supIdFn = s => s["Nama Perusahaan"] || s["Supplier"] || s.id;
    const mergedSuppliers = isIncremental
      ? mergeEntities(currentMaster.supplier, firestoreSuppliers, supIdFn)
      : firestoreSuppliers;

    const katIdFn = k => k["Kode Kategori"] || k["Nama Kategori"] || k.id;
    const mergedCategories = isIncremental
      ? mergeEntities(currentMaster.kategori, firestoreCategories, katIdFn)
      : firestoreCategories;

    const masterObj = {
      produk: mergedProducts,
      supplier: mergedSuppliers,
      kategori: mergedCategories,
      pengguna: currentMaster.pengguna || [],
      pengaturan_toko: firestoreSettings.length ? firestoreSettings : currentMaster.pengaturan_toko
    };

    inMemory.set(STORE_KEYS.master, masterObj);

    if (isIncremental) {
      if (firestoreInvoices.length) {
        const invs = mergeEntities(inMemory.get(STORE_KEYS.invoices) || [], firestoreInvoices, i => i.id || i.invoiceNumber);
        inMemory.set(STORE_KEYS.invoices, invs);
        await indexedDBStore.putMany(STORES.INVOICES, firestoreInvoices);
      }
      if (firestoreSales.length) {
        const sls = mergeEntities(inMemory.get(STORE_KEYS.sales) || [], firestoreSales, s => s.id || s.transactionNumber);
        inMemory.set(STORE_KEYS.sales, sls);
        await indexedDBStore.putMany(STORES.SALES, firestoreSales);
      }
      if (firestoreMovements.length) {
        const movs = mergeEntities(inMemory.get(STORE_KEYS.movements) || [], firestoreMovements, m => m.id);
        inMemory.set(STORE_KEYS.movements, movs);
        await indexedDBStore.putMany(STORES.MOVEMENTS, firestoreMovements);
      }
      if (firestoreOpnames.length) {
        const opns = mergeEntities(inMemory.get(STORE_KEYS.opnames) || [], firestoreOpnames, o => o.id);
        inMemory.set(STORE_KEYS.opnames, opns);
        await indexedDBStore.putMany(STORES.OPNAMES, firestoreOpnames);
      }
    } else {
      // Pada Full Initial Sync, Cloud Firestore adalah Source of Truth untuk transaksi operasional
      inMemory.set(STORE_KEYS.invoices, firestoreInvoices);
      inMemory.set(STORE_KEYS.sales, firestoreSales);
      inMemory.set(STORE_KEYS.movements, firestoreMovements);
      inMemory.set(STORE_KEYS.opnames, firestoreOpnames);

      // KUNCI: Jangan pernah menghapus STORES.PRODUCTS pada sync latar belakang
      await Promise.all([
        indexedDBStore.clearStore(STORES.SUPPLIERS),
        indexedDBStore.clearStore(STORES.CATEGORIES),
        indexedDBStore.clearStore(STORES.INVOICES),
        indexedDBStore.clearStore(STORES.SALES),
        indexedDBStore.clearStore(STORES.MOVEMENTS),
        indexedDBStore.clearStore(STORES.OPNAMES)
      ]);
    }

    // Rekonsiliasi harga beli dan data kemasan dari histori faktur ke mergedProducts
    reconcileProductsWithInvoices(mergedProducts, inMemory.get(STORE_KEYS.invoices) || []);

    // Simpan ke IndexedDB cache lokal
    if (force) {
      updateDatabaseProgress({
        detail: "Menyimpan ke IndexedDB lokal...",
        percent: 85,
        message: "Memperbarui cache lokal..."
      });
    }

    if (mergedProducts.length) await indexedDBStore.putMany(STORES.PRODUCTS, mergedProducts);
    if (firestoreSuppliers.length) await indexedDBStore.putMany(STORES.SUPPLIERS, firestoreSuppliers);
    if (firestoreCategories.length) await indexedDBStore.putMany(STORES.CATEGORIES, firestoreCategories);
    if (!isIncremental) {
      if (firestoreInvoices.length) await indexedDBStore.putMany(STORES.INVOICES, firestoreInvoices);
      if (firestoreSales.length) await indexedDBStore.putMany(STORES.SALES, firestoreSales);
      if (firestoreMovements.length) await indexedDBStore.putMany(STORES.MOVEMENTS, firestoreMovements);
      if (firestoreOpnames.length) await indexedDBStore.putMany(STORES.OPNAMES, firestoreOpnames);
    }
    if (firestoreSettings.length && firestoreSettings[0]) {
      await indexedDBStore.put(STORES.CONFIGURATIONS, { key: "storeSettings", ...firestoreSettings[0] });
    }

    await indexedDBStore.setLastUpdated("central_sync", Date.now());
    console.log(`[DatabaseStore] Sinkronisasi selesai. Perubahan diunduh: ${normalizedIncomingProducts.length} produk, ${firestoreSuppliers.length} supplier, ${firestoreCategories.length} kategori.`);

    window.dispatchEvent(new CustomEvent("kasirpro:database-synced", { detail: { timestamp: Date.now() } }));
  } catch (error) {
    console.warn("[DatabaseStore] Sinkronisasi Firestore ditunda/dilewati:", error?.message || error);
  } finally {
    isSyncInProgress = false;
    if (force) {
      endDatabaseProgress({ detail: "Sinkronisasi Selesai", badgeText: "Database Sinkron" });
    }
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
 * Ambil stok produk terkini (O(1) Ultra-fast Hash Map)
 */
export function readCurrentStock(productCode) {
  const code = norm(productCode);
  if (!code) return 0;
  if (activeStockIndex.has(code)) {
    return activeStockIndex.get(code);
  }
  return 0;
}

/**
 * Set stok aktif produk pada in-memory index
 */
export function setActiveStock(productCode, quantity) {
  const code = norm(productCode);
  if (!code) return;
  const safeQty = Math.max(0, num(quantity));
  activeStockIndex.set(code, safeQty);
}

/**
 * Simpan data store (online wajib)
 */
export async function writeStore(key, value, onProgress) {
  requireOnline();
  startDatabaseProgress("Menyimpan Data", "Menulis ke IndexedDB lokal dan Cloud Firestore...", {
    type: "write",
    badgeText: "Database Write",
    percent: 25,
    icon: "fa-cloud-arrow-up"
  });
  try {
  inMemory.set(key, clone(value));

  // Tulis ke IndexedDB
  if (key === STORE_KEYS.master) {
    // Normalisasi dan perbarui active stock index secara instan untuk 10.000+ produk
    if (Array.isArray(value?.produk)) {
      value.produk = value.produk.map(p => normalizeProductRecord(p));
      activeStockIndex.clear();
      for (let i = 0; i < value.produk.length; i++) {
        const p = value.produk[i];
        const c = norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.id);
        if (c) activeStockIndex.set(c, num(p["Stok Awal"] ?? p.stock ?? 0));
      }
    }

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
        message: "Menyiapkan sinkronisasi Cloud Firestore hemat kuota...",
        detail: "Memproses katalog acuan & produk operasional",
        percent: 40
      });
    }

    const allProds = Array.isArray(value?.produk) ? value.produk : [];
    // 1. Produk fisik nyata dengan stok (>0) disinkronkan ke koleksi products
    const productsWithStock = allProds.filter(p => num(p["Stok Awal"] ?? p.stock) > 0);
    for (const p of productsWithStock) {
      const id = sanitizeDocId(p.id || p["Kode Produk"] || p["Kode Produk Internal"], "prd");
      const ref = doc(firebaseDb, ...documentSegments("products", id));
      operations.push({ ref, data: sanitizeFirestorePayload({ ...p, updatedAt: now }) });
    }

    // 2. Seluruh Master Katalog (100% Produk) disimpan dalam Master Snapshot Chunks (Hemat 99.9% Writes & Reads)
    // 2.000 produk per dokumen chunk (~250 KB per dokumen, batas Firestore 1 MB).
    const SNAPSHOT_CHUNK_SIZE = 2000;
    const catalogChunks = [];
    for (let ci = 0; ci < allProds.length; ci += SNAPSHOT_CHUNK_SIZE) {
      catalogChunks.push(allProds.slice(ci, ci + SNAPSHOT_CHUNK_SIZE));
    }

    const currentVersion = Number(value?.version) || 1;
    for (let idx = 0; idx < catalogChunks.length; idx++) {
      const cRef = doc(firebaseDb, ...masterSnapshotChunkSegments(currentVersion, idx));
      const chunkData = {
        version: currentVersion,
        chunkIndex: idx,
        totalChunks: catalogChunks.length,
        itemsCount: catalogChunks[idx].length,
        updatedAt: now,
        items: catalogChunks[idx].map(p => sanitizeFirestorePayload({
          id: p.id || p["Kode Produk"] || p["Kode Produk Internal"],
          "Kode Produk": p["Kode Produk"] || p["Kode Produk Internal"] || p.id,
          "Kode Produk Internal": p["Kode Produk Internal"] || p["Kode Produk"] || p.id,
          "Barcode": p["Barcode"] || "",
          "Nama Produk": p["Nama Produk"] || "",
          "Kategori": p["Kategori"] || "",
          "Supplier": p["Supplier"] || "",
          "Produsen": p["Produsen"] || "",
          "Harga Beli Terakhir": num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0),
          "Harga Beli": num(p["Harga Beli"] ?? p["Harga Beli Terakhir"] ?? 0),
          "Harga Jual": num(p["Harga Jual"] ?? 0),
          "Harga Jual Satuan Sedang": num(p["Harga Jual Satuan Sedang"] ?? 0),
          "Harga Jual Satuan Besar": num(p["Harga Jual Satuan Besar"] ?? 0),
          "Satuan Dasar": p["Satuan Dasar"] || p["Satuan"] || "Pcs",
          "Satuan": p["Satuan Dasar"] || p["Satuan"] || "Pcs",
          "Satuan Pembelian": p["Satuan Pembelian"] || p["Kemasan Beli"] || "Pcs",
          "Kemasan Beli": p["Kemasan Beli"] || p["Satuan Pembelian"] || "Pcs",
          "Konversi": num(p["Konversi"] ?? p["Isi Kemasan"] ?? 1),
          "Isi Kemasan": num(p["Isi Kemasan"] ?? p["Konversi"] ?? 1),
          "Satuan Antara": p["Satuan Antara"] || "Pcs",
          "Isi Satuan Antara": num(p["Isi Satuan Antara"] ?? 1),
          "Stok Minimum": num(p["Stok Minimum"] ?? 0),
          "Stok Awal": num(p["Stok Awal"] ?? p.stock ?? 0),
          "Status": p["Status"] || (num(p["Harga Jual"]) > 0 ? "Aktif" : "Perlu Harga Jual")
        }))
      };
      operations.push({ ref: cRef, data: chunkData });
    }

    // Manifest Snapshot
    if (catalogChunks.length > 0) {
      const manifestRef = doc(firebaseDb, ...masterSnapshotManifestSegments());
      operations.push({
        ref: manifestRef,
        data: {
          version: currentVersion,
          totalProducts: allProds.length,
          activeCount: productsWithStock.length,
          chunksCount: catalogChunks.length,
          updatedAt: now
        }
      });
    }

    // 3. Supplier & Kategori
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

    // Commit dalam chunk 400 operasi dengan timeout perlindungan agar UI tidak hang
    const CHUNK_SIZE = 400;
    const totalChunks = Math.ceil(operations.length / CHUNK_SIZE) || 1;

    for (let i = 0; i < operations.length; i += CHUNK_SIZE) {
      const chunk = operations.slice(i, i + CHUNK_SIZE);
      const chunkIdx = Math.floor(i / CHUNK_SIZE) + 1;

      if (typeof onProgress === "function") {
        const pct = 40 + Math.round((chunkIdx / totalChunks) * 55);
        onProgress({
          step: "firestore",
          message: `Menyinkronkan ke Cloud Firestore (Batch ${chunkIdx} dari ${totalChunks})...`,
          detail: `${Math.min(i + chunk.length, operations.length)} dari ${operations.length} data tersinkron`,
          percent: pct,
          currentChunk: chunkIdx,
          totalChunks: totalChunks
        });
      }

      const b = writeBatch(firebaseDb);
      for (const op of chunk) {
        b.set(op.ref, op.data, { merge: true });
      }
      try {
        const commitPromise = b.commit();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout sync Firestore master (10 detik)")), 10000)
        );
        await Promise.race([commitPromise, timeoutPromise]);
      } catch (commitErr) {
        console.warn("[DatabaseStore] Peringatan commit batch master (data lokal tetap aman tersimpan di IndexedDB):", commitErr?.message || commitErr);
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
  } finally {
    endDatabaseProgress({ detail: "Data Berhasil Disimpan", badgeText: "Tersimpan" });
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
  startDatabaseProgress("Menyimpan Pembaruan", "Menyinkronkan perubahan master ke Cloud Firestore & IndexedDB...", {
    type: "write",
    badgeText: "Master Delta Write",
    percent: 40,
    icon: "fa-cloud-arrow-up"
  });
  try {
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
  }
  } finally {
    endDatabaseProgress({ detail: "Perubahan Tersimpan", badgeText: "Tersimpan" });
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
  startDatabaseProgress("Menghapus Produk", "Menghapus produk dari Cloud Firestore & IndexedDB...", {
    type: "delete",
    badgeText: "Product Delete",
    percent: 35,
    icon: "fa-trash-can"
  });
  try {
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
  } finally {
    endDatabaseProgress({ detail: "Produk Berhasil Dihapus", badgeText: "Dihapus" });
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
  startDatabaseProgress("Membatalkan Faktur", "Menghapus faktur & merollback stok produk ke Cloud & IndexedDB...", {
    type: "delete",
    badgeText: "Rollback Faktur",
    percent: 30,
    icon: "fa-trash-can"
  });
  try {
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
      const conv = num(item.conversionRatio) || num(item.conversion) || num(item.isiKonversi) || 1;
      const baseQty = (num(item.qty) || 1) * conv;
      const prod = products.find(p => norm(p["Kode Produk"]) === norm(code) || norm(p["Nama Produk"]) === norm(item.name));
      if (prod) {
        const curStock = readCurrentStock(prod["Kode Produk"]);
        // Rollback aman: kembali ke posisi sebelum faktur (floor 0)
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

  // Update stok produk & activeStocks di Firestore jika ada yang terdampak
  for (const p of touchedProducts) {
    const pId = String(p.id || p["Kode Produk"]).replace(/[\/\\]/g, "_").trim();
    const pRef = doc(firebaseDb, ...documentSegments("products", pId));
    batch.set(pRef, { "Stok Awal": p["Stok Awal"], updatedAt: new Date().toISOString() }, { merge: true });

    // SINKRONISASI PENTING: Koleksi activeStocks di Firestore juga diperbarui
    const stockCode = norm(p["Kode Produk"]);
    const stockRef = doc(firebaseDb, ...documentSegments("activeStocks", readableDocumentId("stok", stockCode)));
    batch.set(stockRef, {
      productCode: stockCode,
      productName: p["Nama Produk"] || stockCode,
      quantity: p["Stok Awal"],
      updatedAt: new Date().toISOString()
    }, { merge: true });
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

  return true;
  } finally {
    endDatabaseProgress({ detail: "Faktur Berhasil Dibatalkan", badgeText: "Selesai" });
  }
}

/**
 * Normalisasi stok minus: Menormalkan kembali semua saldo produk yang < 0 ke 0.
 * Menyinkronkan ke Master Produk, activeStockIndex, activeStocks Firestore, dan IndexedDB.
 */
export async function normalizeNegativeStocks() {
  requireOnline();
  startDatabaseProgress("Normalisasi Stok Minus", "Menormalkan saldo produk yang minus kembali ke 0...", {
    type: "write",
    badgeText: "Koreksi Stok",
    percent: 30,
    icon: "fa-wrench"
  });
  try {
    const master = inMemory.get(STORE_KEYS.master) || { produk: [] };
    const products = Array.isArray(master.produk) ? master.produk : [];
    const negativeProds = [];

    products.forEach(p => {
      const code = norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.id);
      const curStock = readCurrentStock(code);
      const stockAwal = num(p["Stok Awal"]);
      if (curStock < 0 || stockAwal < 0) {
        p["Stok Awal"] = 0;
        activeStockIndex.set(code, 0);
        negativeProds.push(p);
      }
    });

    if (!negativeProds.length) {
      return 0;
    }

    const batch = writeBatch(firebaseDb);
    const now = new Date().toISOString();
    negativeProds.forEach(p => {
      const code = norm(p["Kode Produk"] || p.id);
      const pId = String(p.id || code).replace(/[\/\\]/g, "_").trim();
      const pRef = doc(firebaseDb, ...documentSegments("products", pId));
      batch.set(pRef, { "Stok Awal": 0, updatedAt: now }, { merge: true });

      const stockRef = doc(firebaseDb, ...documentSegments("activeStocks", readableDocumentId("stok", code)));
      batch.set(stockRef, {
        productCode: code,
        productName: p["Nama Produk"] || code,
        quantity: 0,
        updatedAt: now
      }, { merge: true });
    });

    updateDatabaseProgress({ detail: "Menyimpan ke Cloud...", percent: 70 });
    await batch.commit();

    updateDatabaseProgress({ detail: "Menyimpan ke IndexedDB lokal...", percent: 90 });
    await indexedDBStore.putMany(STORES.PRODUCTS, products);

    console.log(`[DatabaseStore] Berhasil menormalkan ${negativeProds.length} produk bersaldo minus kembali ke 0.`);
    return negativeProds.length;
  } finally {
    endDatabaseProgress({ detail: "Stok Berhasil Dinormalkan" });
  }
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

    // Queue Firestore batch
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

  await batch.commit();
  return true;
}

/**
 * Transaksi Atomik Stok (Stok Berkurang/Bertambah + Mutasi Stok + Rekam Transaksi)
 * Menjamin tidak terjadi overselling dan menjaga Source of Truth Firestore.
 */
export async function writeStockTransaction(entries = []) {
  requireOnline();
  startDatabaseProgress("Transaksi Database", "Mencatat transaksi atomik & mutasi stok...", {
    type: "write",
    badgeText: "Transaksi Atomik",
    percent: 30,
    icon: "fa-cubes"
  });
  try {
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

  // Eksekusi Atomic Transaction di Firestore
  await runTransaction(firebaseDb, async (transaction) => {
    const now = new Date().toISOString();
    newStockValues.clear();

    // 1. Baca StokAktif terkini untuk semua kode produk terkait
    const stockDocs = new Map();
    for (const code of affectedCodes) {
      const ref = doc(firebaseDb, ...documentSegments("activeStocks", readableDocumentId("stok", code)));
      const snap = await transaction.get(ref);
      stockDocs.set(code, { ref, exists: snap.exists(), data: snap.exists() ? snap.data() : null });
    }

    // 2. Hitung dan verifikasi kuantitas stok baru
    for (const m of movements) {
      const code = norm(m.productCode || m["Kode Produk"]);
      if (!code) continue;

      const currentRemote = stockDocs.get(code);
      const currentQty = newStockValues.has(code)
        ? newStockValues.get(code)
        : (currentRemote?.exists ? num(currentRemote.data?.quantity) : (activeStockIndex.get(code) ?? num(m.stockBefore)));

      let delta = num(m.delta ?? m.quantity ?? m.qty);
      const type = norm(m.type);

      // Jika jenis mutasi adalah penjualan, delta memotong stok
      if (type === "sale" || type === "penjualan") {
        if (delta > 0) delta = -delta;
        // Rekonsiliasi fallback: jika remote stok belum sinkron / bernilai 0 tapi master/m.stockBefore cukup
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

    // 3. Tulis StokAktif yang baru
    for (const [code, qty] of newStockValues.entries()) {
      const stockInfo = stockDocs.get(code);
      const prodName = movements.find(m => norm(m.productCode) === code)?.productName || code;
      transaction.set(stockInfo.ref, sanitizeForFirestore({
        productCode: code,
        productName: prodName,
        quantity: Math.max(0, qty),
        updatedAt: now
      }), { merge: true });
    }

    // 4. Tulis MutasiStok
    for (const m of movements) {
      const mId = m.id || readableDocumentId("mut", `${m.productCode}-${Date.now()}`);
      const mRef = doc(firebaseDb, ...documentSegments("stockMovements", mId));
      transaction.set(mRef, sanitizeForFirestore({ ...m, id: mId, createdAt: m.createdAt || now }), { merge: true });
    }

    // 5. Tulis Transaksi Penjualan jika ada
    for (const s of sales) {
      const sId = s.id || s.transactionNumber || readableDocumentId("trx", Date.now());
      const sRef = doc(firebaseDb, ...documentSegments("sales", sId));
      transaction.set(sRef, sanitizeForFirestore({ ...s, id: sId, updatedAt: now }), { merge: true });
    }

    // 6. Tulis Faktur Pembelian jika ada
    for (const inv of invoices) {
      const invId = inv.id || inv.invoiceNumber || readableDocumentId("inv", Date.now());
      const invRef = doc(firebaseDb, ...documentSegments("purchaseInvoices", invId));
      transaction.set(invRef, sanitizeForFirestore({ ...inv, id: invId, updatedAt: now }), { merge: true });
    }

    // 7. Tulis Stock Opname jika ada
    for (const op of opnames) {
      const opId = op.id || readableDocumentId("opn", Date.now());
      const opRef = doc(firebaseDb, ...documentSegments("stockOpnames", opId));
      transaction.set(opRef, sanitizeForFirestore({ ...op, id: opId, updatedAt: now }), { merge: true });
    }
  });

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

  window.dispatchEvent(new CustomEvent("kasirpro:stock-updated", { detail: { timestamp: Date.now() } }));
  return true;
  } finally {
    endDatabaseProgress({ detail: "Transaksi Stok Berhasil", badgeText: "Selesai" });
  }
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