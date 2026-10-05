/* KasirPro AT-11 — POS Quick Search Supplier Display
 * Display-only layer. Tidak mengubah ranking pencarian, transaksi, stok, atau database.
 */

import { readStore } from "../modules/database/database-store.js";

const MASTER_KEY = "kasirpro_master_store_v1";

let cacheSignature = "";
let supplierNameByLabel = new Map();
let supplierLabelByProductCode = new Map();
let supplierLabelByUniqueProductName = new Map();
let cacheReady = false;

const text = (value) => String(value ?? "").trim();
const norm = (value) => text(value).toLowerCase();

function master() {
    return readStore(MASTER_KEY, {}) || {};
}

function currentSignature(data) {
    const products = Array.isArray(data?.produk) ? data.produk : [];
    const suppliers = Array.isArray(data?.supplier) ? data.supplier : [];
    const lastProduct = products.length ? products[products.length - 1] : null;
    return `${products.length}:${suppliers.length}:${products[0]?.["Kode Produk"] || ""}:${lastProduct?.["Kode Produk"] || ""}`;
}

function rebuildCacheIfNeeded() {
    if (cacheReady) return;
    const data = master();
    const signature = currentSignature(data);
    if (signature === cacheSignature && supplierNameByLabel.size) return;

    const suppliers = Array.isArray(data?.supplier) ? data.supplier : [];
    const products = Array.isArray(data?.produk) ? data.produk : [];

    supplierNameByLabel = new Map();
    supplierLabelByProductCode = new Map();
    supplierLabelByUniqueProductName = new Map();

    for (const supplier of suppliers) {
        const label = text(supplier?.["Supplier"] || supplier?.["Kode Supplier"]);
        const company = text(supplier?.["Nama Supplier"]);
        if (!label) continue;
        supplierNameByLabel.set(norm(label), company || label);
    }

    const nameOccurrences = new Map();
    for (const product of products) {
        const label = text(product?.["Supplier"] || product?.["Kode Supplier"]);
        const code = text(product?.["Kode Produk"]);
        const name = text(product?.["Nama Produk"]);
        if (code && label) supplierLabelByProductCode.set(norm(code), label);
        if (name && label) {
            const key = norm(name);
            const previous = nameOccurrences.get(key);
            nameOccurrences.set(key, previous ? { count: previous.count + 1, label: previous.label } : { count: 1, label });
        }
    }

    for (const [key, value] of nameOccurrences.entries()) {
        if (value.count === 1) supplierLabelByUniqueProductName.set(key, value.label);
    }

    cacheSignature = signature;
    cacheReady = true;
}

function companyNameForResult(item) {
    rebuildCacheIfNeeded();

    const code = text(item.querySelector(".search-result-code")?.textContent);
    const productName = text(item.querySelector(".search-result-name")?.textContent);

    let label = "";
    if (code && norm(code) !== "tanpa kode") {
        label = supplierLabelByProductCode.get(norm(code)) || "";
    }
    if (!label && productName) {
        label = supplierLabelByUniqueProductName.get(norm(productName)) || "";
    }
    if (!label) return "";

    return supplierNameByLabel.get(norm(label)) || label;
}

function separator() {
    const span = document.createElement("span");
    span.className = "search-result-separator";
    span.textContent = "•";
    span.setAttribute("aria-hidden", "true");
    return span;
}

function annotateResult(item) {
    if (!(item instanceof HTMLElement) || item.dataset.supplierDisplayAt11 === "1") return;

    const meta = item.querySelector(".search-result-meta");
    const code = meta?.querySelector(".search-result-code");
    const stock = meta?.querySelector(".search-result-stock");
    if (!meta || !code || !stock) return;

    const company = companyNameForResult(item);
    if (!company) {
        item.dataset.supplierDisplayAt11 = "1";
        return;
    }

    const supplier = document.createElement("span");
    supplier.className = "search-result-supplier";
    supplier.textContent = company;
    supplier.title = company;

    meta.insertBefore(separator(), stock);
    meta.insertBefore(supplier, stock);
    meta.insertBefore(separator(), stock);
    item.dataset.supplierDisplayAt11 = "1";
}

function annotateAll() {
    document.querySelectorAll("#pos-search-results .search-result-item").forEach(annotateResult);
}

function startObserver() {
    const box = document.getElementById("pos-search-results");
    if (!box) return;

    annotateAll();

    const observer = new MutationObserver(annotateAll);
    observer.observe(box, { childList: true, subtree: true });
}

function invalidateCache() {
    cacheReady = false;
    cacheSignature = "";
    rebuildCacheIfNeeded();
}

window.addEventListener("kasirpro:local-master-updated", invalidateCache);
window.addEventListener("kasirpro:database-ready", () => {
    if (!cacheReady) rebuildCacheIfNeeded();
});

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
} else {
    startObserver();
}

