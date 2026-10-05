/**
 * modules/local/master-sync.js
 * KasirPro-v2 - Pengelola Sinkronisasi Cerdas & Cache Master Data
 * 
 * Sesuai Master Spesifikasi:
 * 1. Firestore = Source of Truth, IndexedDB = Local Cache.
 * 2. Menggunakan pembandingan `lastUpdated` timestamp agar efisien (tanpa full read berulang).
 * 3. Tidak menggunakan realtime listener global secara terus menerus.
 * 4. Mode offline HANYA BISA BACA CACHE local.
 * 5. Semua transaksi & perubahan data WAJIB butuh koneksi internet (requireOnline).
 * 6. Tidak ada antrean transaksi offline.
 */

import { indexedDBStore, STORES } from './indexeddb-store.js';

class MasterSyncManager {
  constructor() {
    // Menandai status sinkronisasi yang sedang berjalan
    this.isSyncing = false;
  }

  /**
   * Memeriksa apakah perangkat saat ini terhubung ke internet
   * @returns {boolean} Status koneksi internet
   */
  isOnline() {
    return navigator.onLine;
  }

  /**
   * Satpam Pemeriksa Koneksi Internet.
   * Wajib dipanggil sebelum melakukan penulisan/perubahan data atau transaksi.
   * Melempar Error jika perangkat sedang offline.
   */
  requireOnline() {
    if (!this.isOnline()) {
      throw new Error('Koneksi internet diperlukan untuk melakukan transaksi atau mengubah data. Mode offline hanya mendukung pembacaan data.');
    }
  }

  /**
   * Mengambil timestamp 'lastUpdated' lokal dari IndexedDB
   * @param {string} entityKey - Nama entitas (contoh: 'products', 'categories')
   * @returns {Promise<number>} Timestamp dalam milidetik
   */
  async getLocalLastUpdated(entityKey) {
    try {
      return await indexedDBStore.getLastUpdated(entityKey);
    } catch (error) {
      console.warn(`Gagal membaca lastUpdated lokal untuk [${entityKey}]:`, error);
      return 0;
    }
  }

  /**
   * Menyimpan timestamp 'lastUpdated' terbaru ke IndexedDB lokal
   * @param {string} entityKey - Nama entitas
   * @param {number} timestamp - Timestamp milidetik
   */
  async setLocalLastUpdated(entityKey, timestamp = Date.now()) {
    try {
      await indexedDBStore.setLastUpdated(entityKey, timestamp);
    } catch (error) {
      console.error(`Gagal memperbarui lastUpdated lokal untuk [${entityKey}]:`, error);
    }
  }

  /**
   * Melakukan sinkronisasi cerdas untuk satu entitas spesifik.
   * Mengecek stempel waktu (lastUpdated) Firestore vs Local.
   * Jika lokal sudah terbaru, Firestore FULL READ DIBATALKAN.
   * 
   * @param {Object} options - Parameter sinkronisasi
   * @param {string} options.entityKey - Key metadata (contoh: 'products')
   * @param {string} options.storeName - Nama store IndexedDB (STORES.PRODUCTS)
   * @param {Function} options.fetchRemoteMetaFn - Fungsi untuk mengambil { lastUpdated } dari Firestore Meta
   * @param {Function} options.fetchRemoteDataFn - Fungsi untuk mengambil data lengkap dari Firestore jika dibutuhkan
   * @returns {Promise<{ synced: boolean, source: string, count: number }>}
   */
  async syncEntity({ entityKey, storeName, fetchRemoteMetaFn, fetchRemoteDataFn }) {
    // 1. Jika offline, langsung gunakan data cache lokal tanpa gagal
    if (!this.isOnline()) {
      const localData = await indexedDBStore.getAll(storeName);
      console.log(`[Offline Mode] Membaca cache lokal untuk [${entityKey}] (${localData.length} items).`);
      return { synced: false, source: 'cache_offline', count: localData.length };
    }

    try {
      // 2. Baca timestamp lokal
      const localLastUpdated = await this.getLocalLastUpdated(entityKey);

      // 3. Ambil metadata remote (stempel waktu Firestore)
      const remoteMeta = await fetchRemoteMetaFn();
      const remoteLastUpdated = remoteMeta?.lastUpdated || remoteMeta?.updatedAt || 0;

      // 4. Bandingkan timestamp
      if (localLastUpdated > 0 && remoteLastUpdated > 0 && localLastUpdated >= remoteLastUpdated) {
        // Data lokal sudah paling baru! Hemat kuota, batalkan full read Firestore.
        const localData = await indexedDBStore.getAll(storeName);
        console.log(`[Cache Valid] Data [${entityKey}] sudah terbaru di lokal. Menghindari full read Firestore (${localData.length} items).`);
        return { synced: false, source: 'cache_valid', count: localData.length };
      }

      // 5. Jika data cloud lebih baru atau lokal masih kosong, ambil data lengkap dari Firestore
      console.log(`[Syncing] Memperbarui data [${entityKey}] dari Firestore Cloud...`);
      const remoteItems = await fetchRemoteDataFn();

      if (Array.isArray(remoteItems) && remoteItems.length > 0) {
        // Simpan ke IndexedDB lokal
        await indexedDBStore.putMany(storeName, remoteItems);
        // Perbarui stempel waktu lokal
        const newTimestamp = remoteLastUpdated > 0 ? remoteLastUpdated : Date.now();
        await this.setLocalLastUpdated(entityKey, newTimestamp);

        console.log(`[Sync Success] Berhasil menyinkronkan [${entityKey}] (${remoteItems.length} items).`);
        return { synced: true, source: 'firestore_cloud', count: remoteItems.length };
      } else {
        return { synced: false, source: 'firestore_empty', count: 0 };
      }
    } catch (error) {
      console.error(`Gagal melakukan sinkronisasi entitas [${entityKey}]:`, error);
      // Fallback: Kembalikan data cache lokal jika ada error jaringan/server
      const fallbackLocalData = await indexedDBStore.getAll(storeName);
      return { synced: false, source: 'cache_fallback', count: fallbackLocalData.length, error: error.message };
    }
  }

  /**
   * Menjalankan proses sinkronisasi seluruh master data saat aplikasi dibuka/di-refresh.
   * @param {Object} firestoreProviders - Map berisi fungsi fetcher Firestore untuk tiap entitas
   */
  async syncAllMasterData(firestoreProviders = {}) {
    if (this.isSyncing) {
      console.warn('Sinkronisasi master data sedang berjalan, mengabaikan pemicu ganda.');
      return;
    }

    this.isSyncing = true;
    console.log('--- Memulai Pemeriksaan Sinkronisasi Master Data ---');

    const results = {};

    try {
      // Daftar entitas master data yang wajib dikelola
      const entities = [
        { key: 'products', store: STORES.PRODUCTS },
        { key: 'suppliers', store: STORES.SUPPLIERS },
        { key: 'categories', store: STORES.CATEGORIES },
        { key: 'stock_summaries', store: STORES.STOCK_SUMMARIES },
        { key: 'prices', store: STORES.PRICES },
        { key: 'configurations', store: STORES.CONFIGURATIONS }
      ];

      for (const entity of entities) {
        const provider = firestoreProviders[entity.key];
        if (provider && typeof provider.fetchMeta === 'function' && typeof provider.fetchData === 'function') {
          results[entity.key] = await this.syncEntity({
            entityKey: entity.key,
            storeName: entity.store,
            fetchRemoteMetaFn: provider.fetchMeta,
            fetchRemoteDataFn: provider.fetchData
          });
        } else {
          // Jika provider remote tidak dipasangkan, gunakan cache lokal
          const localCount = (await indexedDBStore.getAll(entity.store)).length;
          results[entity.key] = { synced: false, source: 'cache_only', count: localCount };
        }
      }

      console.log('--- Sinkronisasi Master Data Selesai ---', results);
      return results;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Mengambil data master dari local cache (IndexedDB) dengan sangat cepat
   * @param {string} storeName - Nama store (STORES.PRODUCTS, STORES.PRICES, dll)
   * @returns {Promise<Array>} List data dari cache
   */
  async getLocalData(storeName) {
    try {
      return await indexedDBStore.getAll(storeName);
    } catch (error) {
      console.error(`Gagal membaca data lokal dari [${storeName}]:`, error);
      return [];
    }
  }

  /**
   * Mengambil satu data item berdasarkan ID dari local cache
   * @param {string} storeName - Nama store
   * @param {string|number} id - Primary Key item
   */
  async getLocalItemById(storeName, id) {
    try {
      return await indexedDBStore.get(storeName, id);
    } catch (error) {
      console.error(`Gagal membaca item [${id}] dari [${storeName}]:`, error);
      return null;
    }
  }
}

// Export instance tunggal agar dapat diakses secara konsisten di seluruh modul aplikasi
export const masterSync = new MasterSyncManager();
export default masterSync;