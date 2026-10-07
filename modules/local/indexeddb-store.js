/**
 * modules/local/indexeddb-store.js
 * KasirPro V2 - Local Cache Manager (IndexedDB)
 * 
 * Sesuai Spesifikasi:
 * 1. IndexedDB berfungsi sebagai LOCAL CACHE (bukan Source of Truth).
 * 2. Menyimpan data Produk, Supplier, Kategori, Ringkasan Stok, Harga, Konfigurasi, Faktur, Penjualan, Mutasi, dan Opname.
 * 3. Sinkronisasi menggunakan perbandingan metadata lastUpdated.
 * 4. Mode offline hanya bisa membaca data dari cache ini.
 */

const BASE_DB_NAME = "KasirProLocalDB_v3";
const DB_VERSION = 1;

export function getLocalDbName() {
  return BASE_DB_NAME;
}

export const STORES = Object.freeze({
  PRODUCTS: "products",
  SUPPLIERS: "suppliers",
  CATEGORIES: "categories",
  STOCK_SUMMARIES: "stock_summaries",
  PRICES: "prices",
  CONFIGURATIONS: "configurations",
  SYNC_METADATA: "sync_metadata",
  INVOICES: "invoices",
  SALES: "sales",
  MOVEMENTS: "movements",
  OPNAMES: "opnames",
  USERS: "users"
});

class IndexedDBStore {
  constructor() {
    this.db = null;
    this._openPromise = null;
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
    }
    this._openPromise = null;
  }

  async openDB() {
    if (this.db) return this.db;
    if (this._openPromise) return this._openPromise;

    // Musnahkan database lokal versi lama agar tidak ada residu 7499 produk lama
    if (typeof indexedDB !== "undefined" && typeof sessionStorage !== "undefined" && !sessionStorage.getItem("kasirpro_legacy_db_v2_deleted")) {
      try { indexedDB.deleteDatabase("KasirProLocalDB_v2"); } catch (_) {}
      try { indexedDB.deleteDatabase("KasirProLocalDB_v2_sandbox"); } catch (_) {}
      try { indexedDB.deleteDatabase("kasirpro_local_v1"); } catch (_) {}
      try { sessionStorage.setItem("kasirpro_legacy_db_v2_deleted", "1"); } catch (_) {}
    }

    this._openPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(getLocalDbName(), DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        const ensureStore = (name, keyPath = "id", indices = []) => {
          let store;
          if (!db.objectStoreNames.contains(name)) {
            store = db.createObjectStore(name, { keyPath });
          } else {
            store = event.target.transaction.objectStore(name);
          }
          for (const [idxName, idxField] of indices) {
            if (!store.indexNames.contains(idxName)) {
              store.createIndex(idxName, idxField, { unique: false });
            }
          }
          return store;
        };

        ensureStore(STORES.PRODUCTS, "id", [
          ["barcode", "barcode"],
          ["code", "code"],
          ["categoryId", "categoryId"],
          ["name", "name"]
        ]);
        ensureStore(STORES.SUPPLIERS, "id", [["name", "name"]]);
        ensureStore(STORES.CATEGORIES, "id", [["code", "code"], ["name", "name"]]);
        ensureStore(STORES.STOCK_SUMMARIES, "id", [["productCode", "productCode"]]);
        ensureStore(STORES.PRICES, "id", [["productCode", "productCode"]]);
        ensureStore(STORES.CONFIGURATIONS, "key");
        ensureStore(STORES.SYNC_METADATA, "key");
        ensureStore(STORES.INVOICES, "id", [["invoiceNumber", "invoiceNumber"], ["status", "status"]]);
        ensureStore(STORES.SALES, "id", [["transactionNumber", "transactionNumber"], ["status", "status"]]);
        ensureStore(STORES.MOVEMENTS, "id", [["productCode", "productCode"], ["type", "type"]]);
        ensureStore(STORES.OPNAMES, "id", [["status", "status"]]);
        ensureStore(STORES.USERS, "id", [["username", "username"]]);
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onblocked = () => {
        console.warn("[IndexedDB] Database upgrade terhalang koneksi lain, melanjutkan...");
        resolve(request.result || null);
      };

      request.onerror = (event) => {
        console.warn("[IndexedDB] Gagal membuka database:", event.target.error);
        reject(event.target.error);
      };

      setTimeout(() => {
        if (!this.db) {
          console.warn("[IndexedDB] Timeout membuka database (3 detik), melanjutkan...");
          resolve(request.result || null);
        }
      }, 3000);
    });

    return this._openPromise;
  }

  async put(storeName, item) {
    if (!item) return;
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      if (store.keyPath === "key" && !item.key) {
        item.key = item.id || "storeSettings";
      } else if (store.keyPath === "id" && !item.id) {
        item.id = item["Kode Produk"] || item["Kode Produk Internal"] || item.code || item.Supplier || item["Nama Perusahaan"] || item["Kode Kategori"] || item.invoiceNumber || item.transactionNumber || item.key || (`id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
      }
      const req = store.put(item);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async putMany(storeName, items) {
    if (!Array.isArray(items) || items.length === 0) return true;
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      for (const item of items) {
        if (item) {
          if (store.keyPath === "key" && !item.key) {
            item.key = item.id || "storeSettings";
          } else if (store.keyPath === "id" && !item.id) {
            item.id = item["Kode Produk"] || item["Kode Produk Internal"] || item.code || item.Supplier || item["Nama Perusahaan"] || item["Kode Kategori"] || item.invoiceNumber || item.transactionNumber || item.key || (`id_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
          }
          store.put(item);
        }
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async get(storeName, key) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async getAll(storeName) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(storeName, key) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async clearStore(storeName) {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const req = store.clear();
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async setLastUpdated(entityKey, timestamp = Date.now()) {
    return this.put(STORES.SYNC_METADATA, {
      key: entityKey,
      lastUpdated: timestamp
    });
  }

  async getLastUpdated(entityKey) {
    const record = await this.get(STORES.SYNC_METADATA, entityKey);
    return record?.lastUpdated || 0;
  }
}

export const indexedDBStore = new IndexedDBStore();

// --- BACKWARD-COMPATIBILITY EXPORTS FOR LEGACY CALLS ---
export async function getLocalProducts() {
  return indexedDBStore.getAll(STORES.PRODUCTS);
}

export async function getLocalSuppliers() {
  return indexedDBStore.getAll(STORES.SUPPLIERS);
}

export async function getLocalCategories() {
  return indexedDBStore.getAll(STORES.CATEGORIES);
}

export async function getLocalStoreSettings() {
  return indexedDBStore.get(STORES.CONFIGURATIONS, "storeSettings");
}

export async function getLocalMetadata(key, fallback = null) {
  const meta = await indexedDBStore.get(STORES.SYNC_METADATA, key);
  return meta ? meta.value : fallback;
}

export async function setLocalMetadata(obj = {}) {
  for (const [key, value] of Object.entries(obj)) {
    await indexedDBStore.put(STORES.SYNC_METADATA, { key, value, lastUpdated: Date.now() });
  }
}

export async function hasLocalMaster() {
  const prods = await indexedDBStore.getAll(STORES.PRODUCTS);
  return Array.isArray(prods) && prods.length > 0;
}

export async function getLocalMasterSnapshot() {
  const [produk, supplier, kategori, settings] = await Promise.all([
    indexedDBStore.getAll(STORES.PRODUCTS),
    indexedDBStore.getAll(STORES.SUPPLIERS),
    indexedDBStore.getAll(STORES.CATEGORIES),
    indexedDBStore.get(STORES.CONFIGURATIONS, "storeSettings")
  ]);
  return {
    produk: produk || [],
    supplier: supplier || [],
    kategori: kategori || [],
    pengaturan_toko: settings ? [settings] : []
  };
}

export async function replaceLocalMaster(master, options = {}) {
  if (!master) return;
  await Promise.all([
    indexedDBStore.clearStore(STORES.PRODUCTS),
    indexedDBStore.clearStore(STORES.SUPPLIERS),
    indexedDBStore.clearStore(STORES.CATEGORIES)
  ]);
  await Promise.all([
    indexedDBStore.putMany(STORES.PRODUCTS, (master.produk || []).map(p => ({ ...p, id: p.id || p["Kode Produk"] || p["Kode Produk Internal"] }))),
    indexedDBStore.putMany(STORES.SUPPLIERS, (master.supplier || []).map(s => ({ ...s, id: s.id || s["Supplier"] || s["Nama Perusahaan"] }))),
    indexedDBStore.putMany(STORES.CATEGORIES, (master.kategori || []).map(k => ({ ...k, id: k.id || k["Kode Kategori"] || k["Nama Kategori"] })))
  ]);
  if (master.pengaturan_toko && master.pengaturan_toko[0]) {
    await indexedDBStore.put(STORES.CONFIGURATIONS, { key: "storeSettings", ...master.pengaturan_toko[0] });
  }
  await setLocalMetadata({
    masterVersion: options.masterVersion || 1,
    lastUpdated: Date.now()
  });
}

export async function upsertLocalProduct(prod) {
  const id = prod.id || prod["Kode Produk"] || prod["Kode Produk Internal"];
  return indexedDBStore.put(STORES.PRODUCTS, { ...prod, id });
}

export default indexedDBStore;