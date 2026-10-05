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

export const ROOT_DOCUMENT_PATH = Object.freeze([
    kasirProFirebase.rootCollection,
    kasirProFirebase.storeDocument
]);

export function collectionSegments(collectionKey) {
    const collectionName = COLLECTION_NAMES[collectionKey];
    if (!collectionName) throw new Error(`Koleksi KasirPro tidak dikenal: ${collectionKey}`);
    return [...ROOT_DOCUMENT_PATH, collectionName];
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
