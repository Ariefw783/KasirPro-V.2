import { kasirProFirebase } from "./firebase-config.js";

export const COLLECTION_NAMES = Object.freeze({
    products: "Produk",
    categories: "Kategori",
    suppliers: "Supplier",
    users: "Pengguna",
    storeSettings: "PengaturanToko",
    purchaseInvoices: "FakturPembelian",
    sales: "TransaksiPenjualan",
    stockMovements: "MutasiStok",
    stockOpnames: "StockOpname",
    migrationHistory: "RiwayatMigrasi",
    loginDirectory: "DaftarAkunLogin",
    masterSnapshots: "MasterSnapshot",
    masterSnapshotChunks: "MasterSnapshotChunks",
    activeStocks: "StokAktif"
});

export const DB_ENVIRONMENTS = Object.freeze({
    PRODUCTION: "production",
    SANDBOX: "sandbox"
});

export const STORE_DOCUMENTS = Object.freeze({
    production: kasirProFirebase.storeDocument || "Toko Utama",
    sandbox: kasirProFirebase.sandboxStoreDocument || "Toko Pengujian"
});

let memoryEnvFallback = null;

export function getDatabaseEnvironment() {
    try {
        if (typeof localStorage !== "undefined") {
            return localStorage.getItem("kasirpro_db_env") || DB_ENVIRONMENTS.PRODUCTION;
        }
    } catch {}
    return memoryEnvFallback || DB_ENVIRONMENTS.PRODUCTION;
}

export function setDatabaseEnvironment(env) {
    const valid = env === DB_ENVIRONMENTS.SANDBOX ? DB_ENVIRONMENTS.SANDBOX : DB_ENVIRONMENTS.PRODUCTION;
    memoryEnvFallback = valid;
    try {
        if (typeof localStorage !== "undefined") {
            localStorage.setItem("kasirpro_db_env", valid);
        }
    } catch (e) {
        console.warn("Gagal menyimpan environment:", e);
    }
    return valid;
}

export function getActiveStoreDocument() {
    const env = getDatabaseEnvironment();
    return env === DB_ENVIRONMENTS.SANDBOX ? STORE_DOCUMENTS.sandbox : STORE_DOCUMENTS.production;
}

export function getRootDocumentPath() {
    return [
        kasirProFirebase.rootCollection,
        getActiveStoreDocument()
    ];
}

export const ROOT_DOCUMENT_PATH = new Proxy([kasirProFirebase.rootCollection, kasirProFirebase.storeDocument], {
    get(target, prop) {
        const active = getRootDocumentPath();
        if (prop in active) return active[prop];
        return target[prop];
    }
});

export function collectionSegments(collectionKey) {
    const collectionName = COLLECTION_NAMES[collectionKey];
    if (!collectionName) throw new Error(`Koleksi KasirPro tidak dikenal: ${collectionKey}`);
    return [...getRootDocumentPath(), collectionName];
}

export function storeDocumentSegments(storeDocName, collectionKey) {
    const collectionName = COLLECTION_NAMES[collectionKey];
    if (!collectionName) throw new Error(`Koleksi KasirPro tidak dikenal: ${collectionKey}`);
    return [kasirProFirebase.rootCollection, storeDocName, collectionName];
}

export function collectionPath(collectionKey) {
    return collectionSegments(collectionKey).join("/");
}

export function documentSegments(collectionKey, documentId) {
    const clearId = String(documentId ?? "").trim();
    if (!clearId) throw new Error(`ID dokumen ${collectionKey} tidak boleh kosong.`);
    return [...collectionSegments(collectionKey), clearId];
}

export function documentPath(collectionKey, documentId) {
    return documentSegments(collectionKey, documentId).join("/");
}

export function readableDocumentId(prefix, businessIdentity) {
    const identity = String(businessIdentity ?? "")
        .trim().toLowerCase().normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 100);
    if (!identity) throw new Error(`Identitas bisnis untuk ${prefix} tidak boleh kosong.`);
    return `${prefix}-${identity}`;
}

export function masterSnapshotManifestSegments() {
    return documentSegments("masterSnapshots", "current");
}

export function masterSnapshotChunkId(version, index) {
    const v = Math.max(1, Number(version) || 1);
    const i = Math.max(0, Number(index) || 0);
    return `v${v}-${String(i + 1).padStart(3, "0")}`;
}

export function masterSnapshotChunkSegments(version, index) {
    return documentSegments("masterSnapshotChunks", masterSnapshotChunkId(version, index));
}

export const DATABASE_PATH_REPORT = Object.freeze(
    Object.fromEntries(Object.keys(COLLECTION_NAMES).map((key) => [key, collectionPath(key)]))
);
