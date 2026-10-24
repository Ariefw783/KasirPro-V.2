/**
 * management/management-products.js
 * Manajemen Master Produk KasirPro V2
 * 
 * Sesuai Spesifikasi:
 * 1. Menampilkan Kode Internal, Barcode, Nama, Kategori, Supplier, Produsen,
 *    Harga Beli Terakhir, Harga Jual, Satuan Beli, Konversi, Satuan Dasar, Stok Min, Status.
 * 2. Status: Belum Aktif, Perlu Harga Jual, Aktif, Nonaktif.
 * 3. Mekanisme jelas untuk isi/ubah Harga Jual LANGSUNG dari halaman Master Produk.
 *    Setelah disimpan, status produk otomatis diperbarui (misal jadi Aktif).
 * 4. Filter "Harga Jual Belum Tersedia".
 * 5. Export Master membawa SELURUH data produk (bukan cuma filter/halaman).
 * 6. Import Master adalah UPDATE, bukan REPLACE (tidak menghapus, tidak mereset stok).
 */

import { $, num, text, norm, rupiah, formatNumber, escapeHtml } from "../modules/core/utils.js";
import { STORE_KEYS, readStore, writeMasterDelta, deleteMasterProduct, readCurrentStock } from "../modules/database/database-store.js";
import { indexedDBStore, STORES } from "../modules/local/indexeddb-store.js";
import { exportMasterData, parseMasterWorkbook, exportPricingWorkbook, parsePricingWorkbook, exportActiveProductsWorkbook } from "../modules/excel/excel-service.js";
import { openStockHistoryModal } from "./management-stock.js";

const PAGE_SIZE = 25;
let currentPage = 1;
let currentProducts = [];
let filteredProducts = [];
let activeEditingProduct = null;

export function initProductsModule() {
  bindEvents();
  renderProducts();
}

function bindEvents() {
  const searchInput = $("product-search");
  searchInput?.addEventListener("input", () => {
    currentPage = 1;
    applyFilters();
  });

  $("product-category-filter")?.addEventListener("change", () => {
    currentPage = 1;
    applyFilters();
  });

  $("product-supplier-filter")?.addEventListener("change", () => {
    currentPage = 1;
    applyFilters();
  });

  // Quick Status Filter Pills
  document.querySelectorAll(".prod-pill-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetStatus = btn.dataset.status ?? "";
      const stFilter = $("product-status-filter");
      if (stFilter) {
        stFilter.value = targetStatus;
        stFilter.dispatchEvent(new Event("change"));
      }
    });
  });

  $("product-status-filter")?.addEventListener("change", () => {
    currentPage = 1;
    applyFilters();
    syncProductStatusPills();
  });

  $("product-reset-filter")?.addEventListener("click", () => {
    const sInput = $("product-search");
    if (sInput) sInput.value = "";
    const cFilter = $("product-category-filter");
    if (cFilter) cFilter.value = "";
    const supFilter = $("product-supplier-filter");
    if (supFilter) supFilter.value = "";
    const stFilter = $("product-status-filter");
    if (stFilter) stFilter.value = "aktif";
    currentPage = 1;
    applyFilters();
    syncProductStatusPills();
  });

  window.addEventListener("kasirpro:stock-updated", () => {
    renderProducts();
  });

  $("refresh-products")?.addEventListener("click", () => {
    renderProducts();
    window.KasirProDialog?.success("Berhasil", "Data produk berhasil disegarkan.");
  });

  $("products-prev-page")?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      renderTable();
    }
  });

  $("products-next-page")?.addEventListener("click", () => {
    const totalPages = Math.ceil(filteredProducts.length / PAGE_SIZE) || 1;
    if (currentPage < totalPages) {
      currentPage++;
      renderTable();
    }
  });

  // Tombol Tambah Produk Manual
  $("btn-add-product")?.addEventListener("click", () => openProductModal());

  // Tombol Export Master Seluruh Data
  const exportBtn = $("export-master-button") || $("export-products");
  exportBtn?.addEventListener("click", handleExportMaster);

  // Tombol Export Produk Siap Jual (Aktif di Kasir POS)
  $("btn-export-active-products")?.addEventListener("click", handleExportActiveProducts);

  // Tombol Ekspor & Impor Khusus Perlu Harga Jual
  $("btn-export-pricing-excel")?.addEventListener("click", handleExportPricingExcel);
  $("btn-import-pricing-excel")?.addEventListener("click", () => {
    $("input-import-pricing-excel")?.click();
  });
  $("input-import-pricing-excel")?.addEventListener("change", handleImportPricingExcel);

  // Modal Edit Harga Jual & Tambah Produk
  installEditPriceModal();
  installProductModal();
}

/**
 * Membangun Index Hash Map Faktur Pembelian O(1)
 * Dieksekusi 1 kali instan (<1ms) untuk mencegah jutaan iterasi linier
 */
export function getInvoiceLookupMap() {
  const invoices = readStore(STORE_KEYS.invoices, []);
  const mapByCode = new Map();
  const mapByName = new Map();

  if (Array.isArray(invoices) && invoices.length > 0) {
    for (let i = invoices.length - 1; i >= 0; i--) {
      const inv = invoices[i];
      if (!Array.isArray(inv.items)) continue;
      const supplierName = inv.supplierName || inv.supplier || "";
      for (let j = 0; j < inv.items.length; j++) {
        const it = inv.items[j];
        const itCode = norm(it.productCode || it.matchedProductCode || it.code);
        const itName = norm(it.name);
        const itBuyPrice = num(it.buyPrice);
        const purchaseUnit = String(it.purchaseUnit || it.satuanBesar || it.unit || "").trim();
        const baseUnit = String(it.baseUnit || it.satuanTerkecil || "").trim();
        const conv = num(it.conversionRatio || it.conversion) || 1;

        const info = {
          buyPrice: itBuyPrice,
          purchaseUnit,
          baseUnit,
          conversionRatio: conv,
          supplierName
        };

        if (itCode && !mapByCode.has(itCode)) mapByCode.set(itCode, info);
        if (itName && !mapByName.has(itName)) mapByName.set(itName, info);
      }
    }
  }

  return { mapByCode, mapByName };
}

/**
 * Resolusi harga beli fisik dan informasi kemasan dari histori faktur pembelian
 * Mengikuti data input faktur secara mutlak (termasuk satuan besar / kemasan beli & satuan dasar/terkecil).
 * Menggunakan Index Hash Map O(1) untuk kecepatan pemuatan instan 0ms.
 */
export function resolveProductInvoiceData(prod, lookup = null) {
  if (!prod) return { buyPrice: 0, purchaseUnit: "", baseUnit: "", conversionRatio: 1, supplierName: "" };
  let buyPrice = num(prod["Harga Beli Terakhir"] ?? prod["Harga Beli"] ?? 0);
  let purchaseUnit = String(prod["Kemasan Beli"] || prod["Satuan Pembelian"] || "").trim();
  let baseUnit = String(prod["Satuan Dasar"] || prod["Satuan"] || "").trim();
  let conversionRatio = num(prod["Konversi"] ?? prod["Isi Kemasan"] ?? 1);
  let supplierName = String(prod["Supplier"] || "").trim();

  // Lookup instan O(1) dari Hash Map Faktur
  const invoiceLookup = lookup || getInvoiceLookupMap();
  const code = norm(prod["Kode Produk"] || prod["Kode Produk Internal"] || prod.id);
  const name = norm(prod["Nama Produk"] || prod.name);

  const match = (code ? invoiceLookup.mapByCode.get(code) : null) || (name ? invoiceLookup.mapByName.get(name) : null);
  if (match) {
    if (buyPrice <= 0 && match.buyPrice > 0) {
      buyPrice = match.buyPrice;
      prod["Harga Beli Terakhir"] = match.buyPrice;
      prod["Harga Beli"] = match.buyPrice;
    }
    // MUTLAK: Mengikuti satuan besar / kemasan beli dari faktur pembelian
    if (match.purchaseUnit) {
      purchaseUnit = match.purchaseUnit;
      prod["Kemasan Beli"] = match.purchaseUnit;
      prod["Satuan Pembelian"] = match.purchaseUnit;
    }
    // MUTLAK: Mengikuti satuan terkecil / dasar dari faktur pembelian
    if (match.baseUnit) {
      baseUnit = match.baseUnit;
      prod["Satuan Dasar"] = match.baseUnit;
      prod["Satuan"] = match.baseUnit;
    }
    if (match.conversionRatio > 1 || (conversionRatio <= 1 && match.conversionRatio)) {
      conversionRatio = match.conversionRatio;
      prod["Konversi"] = match.conversionRatio;
      prod["Isi Kemasan"] = match.conversionRatio;
    }
    if (!supplierName && match.supplierName) {
      supplierName = match.supplierName;
      prod["Supplier"] = match.supplierName;
    }
  }

  return { buyPrice, purchaseUnit, baseUnit, conversionRatio, supplierName };
}

export function renderProducts() {
  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? master.produk : [];
  currentProducts = prods.filter(p => !p._isDeleted);

  // Buat lookup faktur O(1) sekali saja di awal (<1ms)
  const invoiceLookup = getInvoiceLookupMap();

  // Pulihkan harga beli & satuan faktur ke produk sebelum filter diterapkan dengan Hash Map O(1)
  currentProducts.forEach(p => {
    resolveProductInvoiceData(p, invoiceLookup);
  });

  // Update dropdown filter kategori & supplier
  populateFilterDropdowns(master);

  applyFilters();
  syncProductStatusPills();
  updateSummaryKpis();
  updatePricingActionBar();
}

function syncProductStatusPills() {
  const currentVal = norm($("product-status-filter")?.value || "");
  document.querySelectorAll(".prod-pill-btn").forEach(btn => {
    const s = norm(btn.dataset.status ?? "");
    btn.classList.toggle("active", s === currentVal);
  });
  updatePricingActionBar();
  updateActiveProductsExportButton();
}

/**
 * Atur visibilitas kondisional tombol Export Produk Siap Jual
 * HANYA muncul ketika pengguna memilih filter "Aktif (Siap Jual)"
 */
export function updateActiveProductsExportButton() {
  const currentVal = norm($("product-status-filter")?.value || "");
  const btn = $("btn-export-active-products");
  if (!btn) return;
  btn.style.display = (currentVal === "aktif") ? "inline-flex" : "none";
}

function populateFilterDropdowns(master) {
  const categoryLookup = new Map();
  (master.kategori || []).forEach(k => {
    const realName = k["Nama Kategori"] || k.name || "";
    if (realName) {
      if (k.id) categoryLookup.set(norm(k.id), realName);
      if (k["Kode Kategori"]) categoryLookup.set(norm(k["Kode Kategori"]), realName);
      categoryLookup.set(norm(realName), realName);
    }
  });

  const supplierLookup = new Map();
  (master.supplier || []).forEach(s => {
    const realName = s["Nama Perusahaan"] || s["Supplier"] || s.name || "";
    if (realName) {
      if (s.id) supplierLookup.set(norm(s.id), realName);
      if (s["Supplier"]) supplierLookup.set(norm(s["Supplier"]), realName);
      supplierLookup.set(norm(realName), realName);
    }
  });

  const catFilter = $("product-category-filter");
  if (catFilter) {
    const currentVal = catFilter.value;
    const catSet = new Set();
    (master.kategori || []).forEach(c => {
      const name = c["Nama Kategori"] || c.name || "";
      if (name) catSet.add(name);
    });
    currentProducts.forEach(p => {
      const c = p["Kategori"] || p.category || "";
      if (c) {
        const resolved = categoryLookup.get(norm(c)) || c;
        catSet.add(resolved);
      }
    });

    catFilter.innerHTML = '<option value="">Semua Kategori</option>';
    [...catSet].sort().forEach(name => {
      catFilter.innerHTML += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
    });
    catFilter.value = currentVal;
  }

  const supFilter = $("product-supplier-filter");
  if (supFilter) {
    const currentVal = supFilter.value;
    const supSet = new Set();
    (master.supplier || []).forEach(s => {
      const name = s["Nama Perusahaan"] || s["Supplier"] || s.name || "";
      if (name) supSet.add(name);
    });
    currentProducts.forEach(p => {
      const s = p["Supplier"] || p.supplier || "";
      if (s) {
        const resolved = supplierLookup.get(norm(s)) || s;
        supSet.add(resolved);
      }
    });

    supFilter.innerHTML = '<option value="">Semua Supplier</option>';
    [...supSet].sort().forEach(name => {
      supFilter.innerHTML += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
    });
    supFilter.value = currentVal;
  }

  // Pastikan status filter punya 3 opsi resmi KasirPro (+ 1 Semua Produk)
  const statusFilter = $("product-status-filter");
  if (statusFilter && (!statusFilter.querySelector('option[value="katalog acuan"]') || statusFilter.querySelector('option[value="nonaktif"]'))) {
    const curVal = statusFilter.value || "aktif";
    statusFilter.innerHTML = `
      <option value="aktif">Aktif (Siap Jual)</option>
      <option value="belum aktif">Perlu Harga Jual</option>
      <option value="tidak aktif">Katalog Acuan</option>
      <option value="">Semua Produk</option>
    `;
    if (curVal && curVal !== "nonaktif") {
      statusFilter.value = curVal;
    } else {
      statusFilter.value = "aktif";
    }
  }
}

function updateSummaryKpis() {
  const total = currentProducts.length;
  let totalStock = 0;
  let lowStockCount = 0;

  for (let i = 0; i < currentProducts.length; i++) {
    const p = currentProducts[i];
    const code = norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.id);
    const stock = Math.max(readCurrentStock(code), num(p["Stok Awal"] ?? p.stock ?? 0));
    const min = num(p["Stok Minimum"]);
    totalStock += stock;
    if (stock <= 0 || (min > 0 && stock <= min)) {
      lowStockCount++;
    }
  }

  const totalEl = $("product-total-count");
  if (totalEl) totalEl.textContent = formatNumber(total);

  const stockEl = $("product-total-stock");
  if (stockEl) stockEl.textContent = formatNumber(totalStock);

  const lowEl = $("product-low-stock-count");
  if (lowEl) lowEl.textContent = formatNumber(lowStockCount);
}

function applyFilters() {
  const q = norm($("product-search")?.value);
  const cat = norm($("product-category-filter")?.value);
  const sup = norm($("product-supplier-filter")?.value);
  const statusVal = norm($("product-status-filter")?.value);

  const master = readStore(STORE_KEYS.master, {});
  const supplierLookup = new Map();
  (master.supplier || []).forEach(s => {
    const realName = s["Nama Perusahaan"] || s["Supplier"] || s.name || "";
    if (realName) {
      if (s.id) supplierLookup.set(norm(s.id), realName);
      if (s["Supplier"]) supplierLookup.set(norm(s["Supplier"]), realName);
      supplierLookup.set(norm(realName), realName);
    }
  });

  const categoryLookup = new Map();
  (master.kategori || []).forEach(k => {
    const realName = k["Nama Kategori"] || k.name || "";
    if (realName) {
      if (k.id) categoryLookup.set(norm(k.id), realName);
      if (k["Kode Kategori"]) categoryLookup.set(norm(k["Kode Kategori"]), realName);
      categoryLookup.set(norm(realName), realName);
    }
  });

  const invoiceLookup = getInvoiceLookupMap();

  filteredProducts = currentProducts.filter(p => {
    if (p._isDeleted) return false;
    const code = norm(p["Kode Produk"] || p["Kode Produk Internal"]);
    const barcode = norm(p["Barcode"]);
    const name = norm(p["Nama Produk"]);
    const pCat = norm(p["Kategori"]);
    const invData = resolveProductInvoiceData(p, invoiceLookup);
    const pSup = norm(p["Supplier"] || invData.supplierName);
    const sellPrice = num(p["Harga Jual"] ?? p.sellPrice ?? 0);

    // Pencarian text
    if (q && !code.includes(q) && !barcode.includes(q) && !name.includes(q)) {
      return false;
    }

    // Filter kategori (pencocokan nama riil, kode ID, dan substring)
    if (cat) {
      const resolvedCat = norm(categoryLookup.get(pCat) || pCat);
      if (resolvedCat !== cat && !resolvedCat.includes(cat) && !pCat.includes(cat)) {
        return false;
      }
    }

    // Filter supplier (pencocokan nama riil, ID supplier, histori faktur, dan substring)
    if (sup) {
      const resolvedSup = norm(supplierLookup.get(pSup) || pSup || invData.supplierName);
      if (resolvedSup !== sup && !resolvedSup.includes(sup) && !pSup.includes(sup)) {
        return false;
      }
    }

    const stock = Math.max(readCurrentStock(code), num(p["Stok Awal"] ?? p.stock ?? 0));

    // Filter status mutlak KasirPro (3 Status):
    // 1. Belum Aktif (Perlu Harga Jual): Sudah mempunyai stok via faktur (> 0), tapi belum diisi harga jual (<= 0)
    if (statusVal === "belum aktif" || statusVal === "perlu harga jual") {
      return stock > 0 && sellPrice <= 0;
    }
    // 2. Aktif (Siap Jual): Sudah mempunyai stok via faktur (> 0) DAN sudah diisi harga jual (> 0)
    if (statusVal === "aktif") {
      // Smart search & filter: Jika ada input pencarian ATAU filter kategori/supplier dipilih,
      // tembuskan ke seluruh katalog agar produk langsung ditemukan
      if (q || cat || sup) return true;
      return stock > 0 && sellPrice > 0;
    }
    // 3. Tidak Aktif / Katalog Acuan: Belum mendapat stok via input faktur (stock <= 0)
    if (statusVal === "tidak aktif" || statusVal === "katalog acuan" || statusVal === "nonaktif") {
      return stock <= 0;
    }
    if (statusVal) {
      return false;
    }

    return true;
  });

  const resetBtn = $("product-reset-filter");
  if (resetBtn) {
    resetBtn.hidden = !(q || cat || sup || (statusVal && statusVal !== "aktif"));
  }

  renderTable();
}

function renderTable() {
  const tbody = $("products-table-body");
  if (!tbody) return;

  const total = filteredProducts.length;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filteredProducts.slice(start, start + PAGE_SIZE);

  const master = readStore(STORE_KEYS.master, {});
  const supplierLookup = new Map();
  (master.supplier || []).forEach(s => {
    const realName = s["Nama Perusahaan"] || s["Supplier"] || s.name || "";
    if (realName) {
      if (s.id) supplierLookup.set(norm(s.id), realName);
      if (s["Supplier"]) supplierLookup.set(norm(s["Supplier"]), realName);
      supplierLookup.set(norm(realName), realName);
    }
  });

  const categoryLookup = new Map();
  (master.kategori || []).forEach(k => {
    const realName = k["Nama Kategori"] || k.name || "";
    if (realName) {
      if (k.id) categoryLookup.set(norm(k.id), realName);
      if (k["Kode Kategori"]) categoryLookup.set(norm(k["Kode Kategori"]), realName);
      categoryLookup.set(norm(realName), realName);
    }
  });

  if (!pageItems.length) {
    const q = norm($("product-search")?.value);
    const cat = norm($("product-category-filter")?.value);
    const sup = norm($("product-supplier-filter")?.value);
    const statusVal = norm($("product-status-filter")?.value);

    if (statusVal === "aktif" && !q && !cat && !sup) {
      const emptyHtml = `
        <div style="max-width:480px;margin:16px auto;padding:24px 16px;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;text-align:center;color:#64748b;">
          <i class="fa-solid fa-store" style="font-size:32px;color:#94a3b8;margin-bottom:10px;display:block;"></i>
          <h4 style="font-size:15px;color:#1e293b;margin-bottom:6px;font-weight:700;">Etalase Siap Jual Masih Kosong</h4>
          <p style="font-size:12.5px;line-height:1.5;margin:0 0 14px 0;">
            Katalog acuan obat Anda telah tersimpan rapi. Produk akan otomatis masuk ke etalase ini segera setelah stok dicatat via faktur pembelian.
          </p>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
            <a href="../pembelian/index.html" class="button button-primary button-small" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;">
              <i class="fa-solid fa-file-invoice"></i> Input Faktur Pembelian
            </a>
            <button type="button" class="button button-secondary button-small" id="btn-view-all-catalogs" style="display:inline-flex;align-items:center;gap:6px;">
              <i class="fa-solid fa-book-open"></i> Buka Katalog Acuan
            </button>
          </div>
        </div>
      `;
      tbody.innerHTML = `<tr><td colspan="11" class="empty-table-state">${emptyHtml}</td></tr>`;
      const cardList = $("products-card-list");
      if (cardList) cardList.innerHTML = emptyHtml;

      setTimeout(() => {
        document.getElementById("btn-view-all-catalogs")?.addEventListener("click", () => {
          const sf = $("product-status-filter");
          if (sf) {
            sf.value = "tidak aktif";
            sf.dispatchEvent(new Event("change"));
          }
        });
      }, 0);
    } else {
      tbody.innerHTML = `<tr><td colspan="11" class="empty-table-state" style="text-align:center;padding:24px;">Tidak ada data produk yang sesuai kriteria pencarian.</td></tr>`;
      const cardList = $("products-card-list");
      if (cardList) cardList.innerHTML = `<div style="text-align:center;padding:32px 16px;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;color:#64748b;"><i class="fa-solid fa-boxes-stacked" style="font-size:28px;margin-bottom:8px;color:#94a3b8;display:block;"></i>Tidak ada data produk yang sesuai kriteria pencarian.</div>`;
    }
  } else {
    const invoiceLookup = getInvoiceLookupMap();
    const cardList = $("products-card-list");

    // 1. Render Desktop Table Rows
    tbody.innerHTML = pageItems.map((p, idx) => {
      const code = p["Kode Produk"] || p["Kode Produk Internal"] || "—";
      const name = p["Nama Produk"] || "—";
      const rawCat = p["Kategori"] || "";
      const invData = resolveProductInvoiceData(p, invoiceLookup);
      const rawSup = p["Supplier"] || invData.supplierName || "";
      const cat = categoryLookup.get(norm(rawCat)) || rawCat || "—";
      const sup = supplierLookup.get(norm(rawSup)) || rawSup || "—";
      const buyPrice = invData.buyPrice;
      const sellPrice = num(p["Harga Jual"] ?? p.sellPrice ?? 0);
      const stock = Math.max(readCurrentStock(code), num(p["Stok Awal"] ?? p.stock ?? 0));
      const unit = invData.baseUnit || p["Satuan Dasar"] || p["Satuan"] || "Pcs";
      const buyUnit = invData.purchaseUnit || p["Kemasan Beli"] || p["Satuan Pembelian"] || unit;
      const conv = num(invData.conversionRatio) || num(p["Konversi"]) || 1;
      const unitLabel = norm(buyUnit) !== norm(unit) && conv > 1
        ? `<strong>${escapeHtml(buyUnit)}</strong> <small class="text-muted">(isi ${formatNumber(conv)} ${escapeHtml(unit)})</small>`
        : `<strong>${escapeHtml(buyUnit || unit)}</strong>`;
      const minStock = num(p["Stok Minimum"]);
      const rawStatus = p["Status"] || p["Status Produk"];
      const statusBadge = getStatusBadge(rawStatus, sellPrice, stock);

      let priceDisplayHtml = "";
      if (stock <= 0) {
        // Status Katalog Acuan: Belum disentuh faktur -> Kunci ikon edit
        priceDisplayHtml = `
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="color:#94a3b8;font-size:11px;font-style:italic;">— (Katalog Acuan)</span>
            <button type="button" class="button button-small" disabled style="opacity:0.5;cursor:not-allowed;background:#f1f5f9;color:#94a3b8;border:1px solid #cbd5e1;padding:4px 7px;" title="Terkunci: Harga jual ditetapkan saat faktur pembelian dicatat">
              <i class="fa-solid fa-lock"></i>
            </button>
          </div>
        `;
      } else if (sellPrice <= 0) {
        // Status Belum Aktif (Perlu Harga Jual): Sudah ada stok dari faktur -> Tombol TERBUKA & MENONJOL
        priceDisplayHtml = `
          <div style="display:flex;align-items:center;gap:6px;">
            <strong class="text-danger" style="color:#dc2626;font-size:11px;">Rp0 (Wajib Diisi)</strong>
            <button type="button" class="btn-edit-price button button-small button-primary" data-code="${escapeHtml(code)}" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;font-size:11px;font-weight:700;" title="Klik untuk tetapkan harga jual">
              <i class="fa-solid fa-pen"></i> Atur Harga
            </button>
          </div>
        `;
      } else {
        // Status Aktif (Siap Jual): Sudah ada stok dan harga jual -> Ikon pena terbuka untuk ubah harga
        priceDisplayHtml = `
          <div style="display:flex;align-items:center;gap:6px;">
            <strong class="text-primary">${rupiah(sellPrice)}</strong>
            <button type="button" class="btn-edit-price button button-small button-secondary" data-code="${escapeHtml(code)}" style="padding:4px 7px;" title="Ubah Harga Jual">
              <i class="fa-solid fa-pen"></i>
            </button>
          </div>
        `;
      }

      return `
        <tr data-code="${escapeHtml(code)}">
          <td><strong>${escapeHtml(code)}</strong><br><small class="text-muted">${escapeHtml(p["Barcode"] || "")}</small></td>
          <td><strong>${escapeHtml(name)}</strong></td>
          <td><span style="font-weight:600;color:#0f2a43;">${escapeHtml(cat)}</span></td>
          <td><span style="font-weight:600;color:#0f2a43;">${escapeHtml(sup)}</span></td>
          <td>${rupiah(buyPrice)}</td>
          <td>${priceDisplayHtml}</td>
          <td>${unitLabel}</td>
          <td><strong>${formatNumber(stock)}</strong> ${escapeHtml(unit)}</td>
          <td>${formatNumber(minStock)} ${escapeHtml(unit)}</td>
          <td>${statusBadge}</td>
          <td>
            <div style="display:flex;align-items:center;gap:4px;">
              <button type="button" class="btn-product-stock-card button button-small button-secondary" data-code="${escapeHtml(code)}" title="Lihat Kartu Stok & Riwayat Mutasi">
                <i class="fa-solid fa-clipboard-list" style="color:#0284c7;"></i>
              </button>
              <button type="button" class="btn-edit-product button button-small button-secondary" data-code="${escapeHtml(code)}" title="Edit Data Master Produk">
                <i class="fa-solid fa-pen-to-square" style="color:#0f766e;"></i>
              </button>
              <button type="button" class="btn-delete-product button button-small button-danger" data-code="${escapeHtml(code)}" title="Hapus Produk">
                <i class="fa-solid fa-trash"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join("");

    // 2. Render Mobile Collapsible Cards (Default Diciutkan)
    if (cardList) {
      cardList.innerHTML = pageItems.map((p, idx) => {
        const code = p["Kode Produk"] || p["Kode Produk Internal"] || "—";
        const name = p["Nama Produk"] || "—";
        const rawCat = p["Kategori"] || "";
        const invData = resolveProductInvoiceData(p, invoiceLookup);
        const rawSup = p["Supplier"] || invData.supplierName || "";
        const cat = categoryLookup.get(norm(rawCat)) || rawCat || "—";
        const sup = supplierLookup.get(norm(rawSup)) || rawSup || "—";
        const buyPrice = invData.buyPrice;
        const sellPrice = num(p["Harga Jual"] ?? p.sellPrice ?? 0);
        const stock = Math.max(readCurrentStock(code), num(p["Stok Awal"] ?? p.stock ?? 0));
        const unit = invData.baseUnit || p["Satuan Dasar"] || p["Satuan"] || "Pcs";
        const buyUnit = invData.purchaseUnit || p["Kemasan Beli"] || p["Satuan Pembelian"] || unit;
        const conv = num(invData.conversionRatio) || num(p["Konversi"]) || 1;
        const unitLabel = norm(buyUnit) !== norm(unit) && conv > 1
          ? `1 ${escapeHtml(buyUnit)} (isi ${formatNumber(conv)} ${escapeHtml(unit)})`
          : `${escapeHtml(buyUnit || unit)}`;
        const minStock = num(p["Stok Minimum"]);
        const rawStatus = p["Status"] || p["Status Produk"];
        const statusBadge = getStatusBadge(rawStatus, sellPrice, stock);

        let cardTheme = "card-primary";
        if (stock <= 0) cardTheme = "";
        else if (sellPrice <= 0) cardTheme = "card-warning";
        else cardTheme = "card-success";

        return `
          <div class="responsive-data-card ${cardTheme}" data-code="${escapeHtml(code)}">
            <div class="card-accordion-header">
              <div class="card-header-main">
                <div class="card-title-row">
                  <div class="card-title">${escapeHtml(name)}</div>
                  ${statusBadge}
                </div>
                <div class="card-meta-row">
                  <span class="card-meta-code">${escapeHtml(code)}</span>
                  <span class="card-meta-dot">•</span>
                  <span class="card-meta-sub">${escapeHtml(cat || 'Umum')}</span>
                  ${sup ? `<span class="card-meta-dot">•</span><span class="card-meta-sub">${escapeHtml(sup)}</span>` : ''}
                </div>
                <div class="card-kpi-strip">
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Modal Beli</span>
                    <span class="kpi-strip-val val-buy">${rupiah(buyPrice)}</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Harga Jual</span>
                    <span class="kpi-strip-val val-sell ${sellPrice <= 0 ? 'text-danger' : ''}">${sellPrice > 0 ? rupiah(sellPrice) : 'Rp0 (Wajib)'}</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Stok Aktual</span>
                    <span class="kpi-strip-val val-stock ${stock <= 0 ? 'stock-empty' : ''}">${formatNumber(stock)} <small>${escapeHtml(unit)}</small></span>
                  </div>
                </div>
              </div>
              <div class="card-toggle-icon">
                <i class="fa-solid fa-chevron-down"></i>
              </div>
            </div>
            <div class="card-accordion-body">
              <div class="card-detail-grid">
                <div class="card-detail-item">
                  <span class="card-detail-label">Barcode</span>
                  <span class="card-detail-value">${escapeHtml(p["Barcode"] || "—")}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Kategori</span>
                  <span class="card-detail-value">${escapeHtml(cat)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Supplier</span>
                  <span class="card-detail-value">${escapeHtml(sup)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Satuan Besar (Beli)</span>
                  <span class="card-detail-value"><strong style="color:#0284c7;">${escapeHtml(buyUnit)}</strong></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Kemasan & Konversi</span>
                  <span class="card-detail-value">${unitLabel}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Stok Minimum</span>
                  <span class="card-detail-value">${formatNumber(minStock)} ${escapeHtml(unit)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Harga Satuan Lain</span>
                  <span class="card-detail-value">
                    ${num(p["Harga Jual Satuan Sedang"]) > 0 ? `Sedang: ${rupiah(num(p["Harga Jual Satuan Sedang"]))}` : 'Sedang: —'} • 
                    ${num(p["Harga Jual Satuan Besar"]) > 0 ? `Besar: ${rupiah(num(p["Harga Jual Satuan Besar"]))}` : 'Besar: —'}
                  </span>
                </div>
              </div>
              <div class="card-action-bar">
                <button type="button" class="btn-product-stock-card button button-small button-secondary" data-code="${escapeHtml(code)}" title="Lihat Kartu Stok & Riwayat Mutasi">
                  <i class="fa-solid fa-clipboard-list" style="color:#0284c7;"></i> Kartu Stok
                </button>
                <button type="button" class="btn-edit-product button button-small button-secondary" data-code="${escapeHtml(code)}" title="Edit Data Master Produk">
                  <i class="fa-solid fa-pen-to-square" style="color:#0f766e;"></i> Edit Produk
                </button>
                ${stock > 0 ? `
                  <button type="button" class="btn-edit-price button button-small button-primary" data-code="${escapeHtml(code)}">
                    <i class="fa-solid fa-pen"></i> Atur Harga Jual
                  </button>
                ` : `
                  <button type="button" class="button button-small" disabled style="opacity:0.5;background:#f1f5f9;color:#94a3b8;border:1px solid #cbd5e1;">
                    <i class="fa-solid fa-lock"></i> Katalog Acuan
                  </button>
                `}
                <button type="button" class="btn-delete-product button button-small button-danger" data-code="${escapeHtml(code)}" title="Hapus Produk">
                  <i class="fa-solid fa-trash"></i> Hapus
                </button>
              </div>
            </div>
          </div>
        `;
      }).join("");

      cardList.querySelectorAll(".card-accordion-header").forEach(hdr => {
        hdr.addEventListener("click", () => {
          const card = hdr.closest(".responsive-data-card");
          if (card) card.classList.toggle("is-expanded");
        });
      });
    }

    // Bind event Edit, Kartu Stok, & Hapus ke seluruh elemen dalam section produk (baik tabel maupun kartu)
    const pContainer = document.querySelector('[data-view-section="products"]');
    if (pContainer) {
      pContainer.querySelectorAll(".btn-product-stock-card").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const code = btn.dataset.code;
          openStockHistoryModal(code);
        });
      });

      pContainer.querySelectorAll(".btn-edit-product").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const code = btn.dataset.code;
          const prod = currentProducts.find(p => norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.id) === norm(code));
          if (prod) openEditProductModal(prod);
        });
      });

      pContainer.querySelectorAll(".btn-edit-price").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const code = btn.dataset.code;
          const prod = currentProducts.find(p => norm(p["Kode Produk"]) === norm(code));
          if (prod) openEditPriceModal(prod);
        });
      });

      pContainer.querySelectorAll(".btn-delete-product").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const code = btn.dataset.code;
          handleDeleteProduct(code);
        });
      });
    }
  }

  // Update info pagination
  const visibleCountEl = $("products-visible-count");
  if (visibleCountEl) visibleCountEl.textContent = pageItems.length;

  const totalResultEl = $("products-total-result-count");
  if (totalResultEl) totalResultEl.textContent = total;

  const prevBtn = $("products-prev-page");
  if (prevBtn) prevBtn.disabled = currentPage <= 1;

  const nextBtn = $("products-next-page");
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
}

function getStatusBadge(rawStatus, sellPrice, stock = 0) {
  if (stock > 0) {
    if (sellPrice <= 0) {
      return `<span class="badge badge-warning" style="background:#fff7ed;color:#ea580c;border:1px solid #ffedd5;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;" title="Stok fisik tersedia dari faktur, menunggu penentuan harga jual"><i class="fa-solid fa-triangle-exclamation"></i> Perlu Harga Jual</span>`;
    }
    return `<span class="badge badge-success" style="background:#ecfdf5;color:#059669;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;" title="Produk siap ditransaksikan di kasir"><i class="fa-solid fa-circle-check"></i> Aktif (Siap Jual)</span>`;
  }
  return `<span class="badge badge-secondary" style="background:#f8fafc;color:#64748b;border:1px solid #e2e8f0;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;" title="Referensi katalog obat supplier (otomatis aktif saat faktur pembelian dicatat)"><i class="fa-solid fa-book-bookmark"></i> Katalog Acuan</span>`;
}

/**
 * Handle Export Master Data (membawa SELURUH dataset produk)
 */
export function handleExportMaster() {
  try {
    const master = readStore(STORE_KEYS.master, {});
    const prods = Array.isArray(master.produk) ? master.produk : [];
    if (!prods.length) {
      window.KasirProDialog?.warning("Master Kosong", "Belum ada produk yang tersimpan untuk diekspor.");
      return;
    }
    const res = exportMasterData(master);
    window.KasirProDialog?.success(
      "Export Master Berhasil",
      `Seluruh data produk (${res.totalProduk} produk) berhasil diekspor ke file:\n${res.fileName}`
    );
  } catch (err) {
    console.error("[ExportMaster] Error exporting:", err);
    window.KasirProDialog?.error("Gagal Export Master", err.message || "Terjadi kesalahan saat membuat file Excel.");
  }
}

/**
 * Handle Export Excel Khusus Produk Siap Jual (Aktif di Kasir POS)
 * Format selaras dengan template "Perlu Harga Jual" (Kode, Nama, Modal Beli, Kemasan A, Harga A, Kemasan B, Harga B, Stok).
 */
export async function handleExportActiveProducts() {
  try {
    const invoiceLookup = getInvoiceLookupMap();
    const sourceList = Array.isArray(filteredProducts) && filteredProducts.length ? filteredProducts : currentProducts;
    const itemsToExport = (sourceList || []).filter(p => !p._isDeleted).map(p => {
      const code = p["Kode Produk"] || p["Kode Produk Internal"] || p.id;
      const invData = resolveProductInvoiceData(p, invoiceLookup);
      const stock = Math.max(readCurrentStock(code), num(p["Stok Awal"] ?? p.stock ?? 0));
      return {
        ...p,
        "Harga Beli Terakhir": invData.buyPrice || p["Harga Beli Terakhir"] || p["Harga Beli"] || 0,
        "Kemasan Beli": invData.purchaseUnit || p["Kemasan Beli"] || p["Satuan Pembelian"] || p["Satuan Dasar"] || "Pcs",
        "Konversi": num(invData.conversionRatio) || num(p["Konversi"]) || 1,
        "Satuan Dasar": invData.baseUnit || p["Satuan Dasar"] || p["Satuan"] || "Pcs",
        _stockAktual: stock
      };
    });

    if (!itemsToExport.length) {
      window.KasirProDialog?.warning("Tidak Ada Produk", "Tidak ada produk siap jual yang dapat diekspor.");
      return;
    }

    const res = await exportActiveProductsWorkbook(itemsToExport);
    window.KasirProDialog?.success(
      "Export Produk Siap Jual Berhasil",
      `Berhasil mengekspor ${res.count} produk siap jual ke file:\n${res.fileName}\n\nFormat file memuat modal beli, harga kemasan eceran & sedang, serta stok aktual kasir POS.`
    );
  } catch (err) {
    console.error("[ExportActiveProducts] Error:", err);
    window.KasirProDialog?.error("Gagal Export", err.message || "Terjadi kesalahan saat mengekspor produk siap jual.");
  }
}

export const handleExportPhysicalCheck = handleExportActiveProducts;

/**
 * Update UI dan Status Action Bar Khusus Perlu Harga Jual Excel
 */
export function updatePricingActionBar() {
  const statusVal = norm($("product-status-filter")?.value || "");
  const isPerluHargaJual = (statusVal === "belum aktif" || statusVal === "perlu harga jual");

  const btnExportPricing = $("btn-export-pricing-excel");
  const btnImportPricing = $("btn-import-pricing-excel");
  if (btnExportPricing) {
    btnExportPricing.style.display = isPerluHargaJual ? "inline-flex" : "none";
  }
  if (btnImportPricing) {
    btnImportPricing.style.display = isPerluHargaJual ? "inline-flex" : "none";
  }

  const badge = $("badge-pending-pricing-count");
  if (badge) {
    const pendingCount = currentProducts.filter(p => {
      if (p._isDeleted) return false;
      const code = norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.id);
      const stock = Math.max(readCurrentStock(code), num(p["Stok Awal"] ?? p.stock ?? 0));
      const sellPrice = num(p["Harga Jual"] ?? p.sellPrice ?? 0);
      return stock > 0 && sellPrice <= 0;
    }).length;

    if (pendingCount > 0) {
      badge.textContent = `${pendingCount} Perlu Harga Jual`;
      badge.style.background = "#d97706";
      badge.style.color = "#ffffff";
    } else {
      badge.textContent = "Semua Obat Sudah Berharga";
      badge.style.background = "#059669";
      badge.style.color = "#ffffff";
    }
  }

  const bar = $("pricing-excel-action-bar");
  if (bar) {
    bar.style.display = "none";
  }
}

/**
 * Handle Export Excel Khusus Perlu Harga Jual dengan Rumus Otomatis Multi-Satuan
 */
export async function handleExportPricingExcel() {
  try {
    const master = readStore(STORE_KEYS.master, {});
    const prods = Array.isArray(master.produk) ? master.produk : [];
    if (!prods.length) {
      window.KasirProDialog?.warning("Master Kosong", "Belum ada produk yang tersimpan.");
      return;
    }

    const invoiceLookup = getInvoiceLookupMap();
    // Prioritas 1: Produk yang membutuhkan harga jual (stok > 0 dan harga jual <= 0, abaikan produk Nonaktif)
    let targets = prods.filter(p => {
      if (p._isDeleted) return false;
      const status = norm(p["Status"] || p["Status Produk"] || "");
      if (status === "nonaktif" || status === "inactive") return false;
      const code = norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.id);
      const stock = Math.max(readCurrentStock(code), num(p["Stok Awal"] ?? p.stock ?? 0));
      const sellPrice = num(p["Harga Jual"] ?? p.sellPrice ?? 0);
      return stock > 0 && sellPrice <= 0;
    });

    // Prioritas 2: Jika semua sudah berharga, ekspor produk yang sedang difilter atau semua produk berstok aktif
    if (targets.length === 0) {
      if (filteredProducts.length > 0 && filteredProducts.length < prods.length) {
        targets = filteredProducts.filter(p => {
          const status = norm(p["Status"] || p["Status Produk"] || "");
          return !p._isDeleted && status !== "nonaktif" && status !== "inactive";
        });
      } else {
        targets = prods.filter(p => {
          const status = norm(p["Status"] || p["Status Produk"] || "");
          return !p._isDeleted && status !== "nonaktif" && status !== "inactive" && Math.max(readCurrentStock(norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.id)), num(p["Stok Awal"] ?? p.stock ?? 0)) > 0;
        });
        if (!targets.length) {
          targets = prods.filter(p => {
            const status = norm(p["Status"] || p["Status Produk"] || "");
            return !p._isDeleted && status !== "nonaktif" && status !== "inactive";
          });
        }
      }
    }

    // Pastikan data faktur (harga beli faktur, kemasan beli, satuan dasar) tersinkronisasi
    targets.forEach(p => resolveProductInvoiceData(p, invoiceLookup));

    const res = await exportPricingWorkbook(targets);
    window.KasirProDialog?.success(
      "Export Excel Berhasil",
      `Berhasil mengekspor ${res.count} produk ke berkas:\n${res.fileName}\n\nSilakan buka di Excel, tentukan harga jual, lalu upload kembali!`
    );
  } catch (err) {
    console.error("[ExportPricing] Error exporting:", err);
    window.KasirProDialog?.error("Gagal Export", err.message || "Terjadi kesalahan saat membuat file Excel harga jual.");
  }
}

/**
 * Handle Import Excel Harga Jual dari Owner (Update Opsi Multi-Satuan & Aktifkan Produk)
 */
export async function handleImportPricingExcel(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const master = readStore(STORE_KEYS.master, {});
    const res = await parsePricingWorkbook(file, master);

    if (res.updatedProducts.length === 0) {
      window.KasirProDialog?.warning(
        "Tidak Ada Data Diperbarui",
        res.errors.length ? res.errors.slice(0, 3).join("\n") : "Tidak ada harga jual yang valid dalam berkas Excel."
      );
      return;
    }

    // Simpan pembaruan harga ke store (IndexedDB & Firebase)
    await writeMasterDelta({ produk: res.updatedProducts });
    renderProducts();

    window.KasirProDialog?.success(
      "Harga Jual Berhasil Diterapkan!",
      `Berhasil memperbarui harga multi-satuan untuk ${res.totalUpdated} produk.\nStatus produk kini Aktif (Siap Jual) dan langsung aktif di meja kasir POS!`
    );
  } catch (err) {
    console.error("[ImportPricing] Error importing:", err);
    window.KasirProDialog?.error("Gagal Import", err.message || "Terjadi kesalahan saat memproses file Excel harga jual.");
  } finally {
    e.target.value = "";
  }
}

/**
 * Toggle Status Aktif / Nonaktif produk (non-destructive) - Optimistic 0ms
 */
async function handleToggleProductStatus(code) {
  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? master.produk : [];
  const target = prods.find(p => norm(p["Kode Produk"]) === norm(code));
  if (!target) return;

  const prevStatus = target["Status"] || target["Status Produk"] || "Aktif";
  const currentNorm = norm(prevStatus);
  const hasPrice = num(target["Harga Jual"]) > 0;

  let newStatus;
  if (currentNorm === "aktif") {
    newStatus = "Nonaktif";
  } else if (hasPrice) {
    newStatus = "Aktif";
  } else {
    // Tidak bisa diaktifkan tanpa Harga Jual valid -> minta harga dahulu
    openEditPriceModal(target);
    return;
  }

  // Optimistic update di memori & tabel segera
  target["Status"] = newStatus;
  target["Status Produk"] = newStatus;
  renderProducts();

  try {
    // Hanya 1 record yang ditulis delta ke IndexedDB & Firestore di background
    await writeMasterDelta({ produk: [target] });
  } catch (err) {
    // Rollback jika gagal
    target["Status"] = prevStatus;
    target["Status Produk"] = prevStatus;
    renderProducts();
    window.KasirProDialog?.error("Gagal Mengubah Status", err.message || "Koneksi database bermasalah.");
  }
}

/**
 * Hapus Produk Bersyarat (Poin A.2):
 * - Jika produk memiliki stok > 0 atau ada riwayat transaksi/mutasi -> Soft Delete (Nonaktifkan).
 * - Jika produk benar-benar baru (0 stok, belum pernah transaksi) -> Hapus Permanen.
 */
async function handleDeleteProduct(code) {
  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? [...master.produk] : [];
  const target = prods.find(p => norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.id) === norm(code));
  if (!target) return;

  const prodName = target["Nama Produk"] || code;
  const stock = readCurrentStock(code);
  const movements = readStore(STORE_KEYS.movements, []);
  const sales = readStore(STORE_KEYS.sales, []);
  const invoices = readStore(STORE_KEYS.invoices, []);

  const hasMovements = movements.some(m => norm(m.productCode) === norm(code));
  const hasSales = sales.some(s => (s.items || []).some(it => norm(it.code) === norm(code) || norm(it.productCode) === norm(code)));

  // KASUS 1: Produk sudah pernah terjual di Kasir POS -> Mutlak tidak boleh dihapus demi jejak audit akuntansi
  if (hasSales) {
    const confirmDeactivate = await window.KasirProDialog?.confirm(
      "Produk Memiliki Riwayat Penjualan",
      `Produk "${prodName}" sudah pernah ditransaksikan di kasir POS.\n\nSesuai prinsip akuntansi, produk yang pernah terjual tidak boleh dihapus permanen agar pembukuan audit masa lalu tidak rusak.\n\nApakah Anda ingin MENONAKTIFKAN produk ini?`
    );
    if (confirmDeactivate) {
      target["Status"] = "Nonaktif";
      target["Status Produk"] = "Nonaktif";
      renderProducts();
      await writeMasterDelta({ produk: [target] });
      window.KasirProDialog?.success("Status Diperbarui", `Produk "${prodName}" telah dinonaktifkan.`);
    }
    return;
  }

  // KASUS 2: Produk BELUM PERNAH TERJUAL di Kasir POS -> Berikan keleluasaan penuh kepada Owner untuk HAPUS PERMANEN!
  // (Termasuk produk yang memiliki sisa stok / mutasi dari faktur yang sudah dibatalkan atau dihapus)
  let confirmMsg = `Hapus produk "${prodName}" secara permanen dari sistem dan cloud?`;
  if (stock > 0 || hasMovements) {
    confirmMsg = `Produk "${prodName}" belum pernah terjual di kasir POS, namun masih memiliki sisa stok (${stock} ${target["Satuan Dasar"] || "Unit"}).\n\nApakah Anda yakin ingin MENGHAPUS BERSIH produk ini dan MENOLKAN seluruh sisa stoknya secara permanen dari sistem dan cloud?`;
  }

  const confirmDelete = await window.KasirProDialog?.confirm(
    "Hapus Produk Permanen",
    confirmMsg
  );
  if (!confirmDelete) return;

  try {
    await deleteMasterProduct(code);
    renderProducts();
    window.KasirProDialog?.success("Berhasil Dihapus", `Produk "${prodName}" beserta sisa stoknya berhasil dihapus secara permanen.`);
  } catch (err) {
    console.error("[Products] Gagal menghapus produk:", err);
    window.KasirProDialog?.error("Gagal Menghapus", err.message || "Terjadi kesalahan saat menghapus produk.");
  }
}

/**
 * MODAL EDIT HARGA JUAL LANGSUNG & BERTAHAP
 */
let priceModalState = {
  mode: "1", // "1" = single, "2" = dual, "3" = all three
  singleSelected: "base",
  dualSelected: ["base", "mid"],
  baseUnit: "Pcs",
  midUnit: "",
  midQty: 1,
  buyUnit: "",
  conversion: 1,
  buyPrice: 0
};

function installEditPriceModal() {
  if ($("modal-edit-price")) return;

  const modalHtml = `
    <div id="modal-edit-price" class="kp-dialog-v4" hidden>
      <div class="kp-dialog-v4__backdrop"></div>
      <section class="kp-dialog-v4__card" style="width:min(96vw,520px);max-height:92vh;overflow-y:auto;border-radius:14px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);" role="dialog">
        <header style="padding:14px 18px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;background:#0f172a;color:#fff;">
          <div>
            <h2 style="font-size:15.5px;font-weight:800;margin:0;color:#f8fafc;"><i class="fa-solid fa-tags text-primary"></i> Atur Harga Jual Produk</h2>
            <p style="font-size:11px;color:#94a3b8;margin:2px 0 0;">Tentukan harga satuan transaksi yang dijual di kasir (POS)</p>
          </div>
          <button type="button" id="close-modal-price" class="button button-small button-secondary" style="padding:4px 8px;color:#cbd5e1;" title="Tutup"><i class="fa-solid fa-xmark"></i></button>
        </header>

        <div style="padding:16px 18px;text-align:left;display:grid;gap:12px;background:#f8fafc;">
          <!-- Info Ringkas Produk & Modal Faktur Fisik -->
          <div style="background:#fff;padding:12px 14px;border-radius:10px;border:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(0,0,0,0.03);">
            <div style="font-size:11px;color:#64748b;font-weight:600;">Produk:</div>
            <strong id="price-modal-name" style="display:block;font-size:14.5px;color:#0f172a;margin-top:2px;">—</strong>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;padding-top:6px;border-top:1px dashed #e2e8f0;font-size:11.5px;flex-wrap:wrap;gap:6px;">
              <span style="color:#64748b;">Kode: <strong id="price-modal-code" style="color:#0f172a;">—</strong></span>
              <span style="color:#0369a1;font-weight:700;">Modal Beli Faktur: <strong id="price-modal-buy" style="color:#0284c7;">Rp0</strong> <span id="price-modal-buy-unit" style="font-size:10px;color:#64748b;"></span></span>
            </div>
          </div>

          <!-- Banner Satuan Jual Aktif (Sedang & Eceran) -->
          <div style="background:#eff6ff;padding:10px 12px;border-radius:8px;border:1px solid #bfdbfe;font-size:12px;color:#0369a1;display:flex;align-items:center;gap:8px;">
            <i class="fa-solid fa-cart-shopping" style="font-size:15px;color:#0284c7;"></i>
            <div>
              <span style="font-weight:700;display:block;">Satuan Transaksi Kasir (POS):</span>
              <span id="price-modal-units-info" style="font-size:11px;color:#0369a1;">Satuan Sedang (Kemasan Mayoritas) &amp; Satuan Terkecil (Eceran)</span>
            </div>
          </div>

          <!-- Input Kolom Harga Jual Satuan Aktif -->
          <div style="background:#fff;padding:14px;border-radius:10px;border:1px solid #cbd5e1;box-shadow:0 1px 3px rgba(0,0,0,0.03);display:grid;gap:12px;">
            <!-- 1. Satuan Sedang (Strip / Blister / Botol) - Ditampilkan Teratas jika produk ada satuan sedang -->
            <div id="box-edit-price-mid">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <label id="label-edit-price-mid" style="font-size:12px;font-weight:700;color:#0369a1;">
                  Harga Satuan Sedang
                </label>
                <span id="badge-auto-mid" style="font-size:10px;padding:2px 8px;border-radius:4px;background:#e0f2fe;color:#0369a1;font-weight:700;" hidden><i class="fa-solid fa-calculator"></i> Dihitung Otomatis</span>
              </div>
              <div style="position:relative;">
                <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);font-weight:700;color:#64748b;font-size:12.5px;">Rp</span>
                <input type="text" inputmode="numeric" id="input-edit-price-mid" style="width:100%;min-height:38px;padding:6px 10px 6px 34px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px;font-weight:800;color:#0369a1;" placeholder="0">
              </div>
              <div id="hint-price-mid" style="font-size:10.5px;color:#64748b;margin-top:2px;"></div>
            </div>

            <!-- 2. Satuan Terkecil / Ecer -->
            <div id="box-price-row-base">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <label id="label-edit-sell-price" style="font-size:12px;font-weight:700;color:#1e293b;">
                  Harga Eceran <span class="text-danger">*</span>
                </label>
                <span id="badge-auto-base" style="font-size:10px;padding:2px 8px;border-radius:4px;background:#e0f2fe;color:#0369a1;font-weight:700;" hidden><i class="fa-solid fa-calculator"></i> Dihitung Otomatis</span>
              </div>
              <div style="position:relative;">
                <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);font-weight:700;color:#64748b;font-size:12.5px;">Rp</span>
                <input type="text" inputmode="numeric" id="input-edit-sell-price" style="width:100%;min-height:38px;padding:6px 10px 6px 34px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px;font-weight:800;color:#0f172a;" placeholder="0">
              </div>
              <div id="hint-price-base" style="font-size:10.5px;color:#64748b;margin-top:2px;"></div>
            </div>

            <!-- Info Arsip Kemasan Beli Supplier (Tidak untuk Transaksi Kasir) -->
            <div id="box-edit-price-buy" style="margin-top:2px;padding:8px 10px;background:#f8fafc;border-radius:6px;border:1px dashed #cbd5e1;font-size:11px;color:#64748b;display:flex;justify-content:space-between;align-items:center;">
              <div>
                <span id="label-edit-price-buy" style="font-weight:600;">Kemasan Beli PBF (Arsip):</span>
                <strong id="hint-price-buy" style="color:#0f2a43;margin-left:4px;">BOX</strong>
              </div>
              <input type="hidden" id="input-edit-price-buy" value="0">
              <span id="badge-auto-buy" style="font-size:10px;color:#64748b;font-style:italic;">Data Arsip Faktur</span>
            </div>
          </div>
        </div>

        <footer style="padding:12px 18px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
          <div>
            <button type="button" id="btn-reset-price-to-pending" class="button button-danger" style="display:none;background:#fef2f2;color:#dc2626;border:1px solid #fecaca;font-size:12px;padding:6px 12px;border-radius:6px;cursor:pointer;font-weight:600;">
              <i class="fa-solid fa-rotate-left"></i> Kembalikan ke Perlu Harga Jual
            </button>
          </div>
          <div style="display:flex;gap:8px;margin-left:auto;">
            <button type="button" id="cancel-edit-price" class="button button-secondary">Batal</button>
            <button type="button" id="save-edit-price" class="button button-primary"><i class="fa-solid fa-floppy-disk"></i> Simpan Harga &amp; Aktifkan</button>
          </div>
        </footer>
      </section>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  // Setup live auto dots pada input harga & reaktif antara sedang dan eceran
  const setupAutoDots = (inputId, onInputCallback) => {
    const el = $(inputId);
    if (!el) return;
    el.addEventListener("input", (e) => {
      const digits = e.target.value.replace(/[^0-9]/g, "");
      const val = parseInt(digits, 10) || 0;
      e.target.value = val ? formatNumber(val) : "";
      if (typeof onInputCallback === "function") onInputCallback(val);
    });
    el.addEventListener("focus", (e) => e.target.select());
  };

  setupAutoDots("input-edit-price-mid", (val) => {
    const midQty = Math.max(1, priceModalState.midQty || 1);
    const baseInput = $("input-edit-sell-price");
    if (baseInput && (!baseInput.value || document.activeElement === $("input-edit-price-mid"))) {
      baseInput.value = val ? formatNumber(Math.round(val / midQty)) : "";
    }
  });

  setupAutoDots("input-edit-sell-price", (val) => {
    const midQty = Math.max(1, priceModalState.midQty || 1);
    const midInput = $("input-edit-price-mid");
    if (midInput && priceModalState.midUnit && (!midInput.value || document.activeElement === $("input-edit-sell-price"))) {
      midInput.value = val ? formatNumber(Math.round(val * midQty)) : "";
    }
  });

  $("close-modal-price")?.addEventListener("click", closeEditPriceModal);
  $("cancel-edit-price")?.addEventListener("click", closeEditPriceModal);
  $("save-edit-price")?.addEventListener("click", handleSavePriceModal);
  $("btn-reset-price-to-pending")?.addEventListener("click", handleResetPriceToPending);
}

function openEditPriceModal(prod) {
  if (!prod) return;
  const code = norm(prod["Kode Produk"] || prod["Kode Produk Internal"] || prod.code || prod.id);
  const curStock = Math.max(readCurrentStock(code), num(prod["Stok Awal"] ?? prod.stock ?? 0));
  if (curStock <= 0) {
    window.KasirProDialog?.warning(
      "Harga Jual Terkunci",
      `Produk "${prod["Nama Produk"] || code}" belum memiliki stok faktur.\n\nSilakan input faktur pembelian terlebih dahulu melalui Input Faktur Grid Mode untuk menentukan harga jual produk ini.`
    );
    return;
  }

  activeEditingProduct = prod;
  const modal = $("modal-edit-price");
  if (!modal) return;

  $("price-modal-name").textContent = prod["Nama Produk"] || "—";
  $("price-modal-code").textContent = prod["Kode Produk"] || prod["Kode Produk Internal"] || "—";

  const invData = resolveProductInvoiceData(prod);
  const buyPrice = invData.buyPrice;
  $("price-modal-buy").textContent = rupiah(buyPrice);

  const baseUnit = String(invData.baseUnit || prod["Satuan Dasar"] || prod["Satuan"] || "Pcs").trim();
  const midUnit = String(prod["Satuan Antara"] || "").trim();
  const midQty = num(prod["Isi Satuan Antara"] || 1);
  const buyUnit = String(invData.purchaseUnit || prod["Kemasan Beli"] || prod["Satuan Pembelian"] || "").trim();
  const conversion = num(invData.conversionRatio || prod["Konversi"] || prod["Isi Kemasan"] || 1);

  priceModalState = {
    hasMid: Boolean(midUnit && norm(midUnit) !== norm(baseUnit) && midQty > 1),
    baseUnit,
    midUnit: midUnit && norm(midUnit) !== norm(baseUnit) && midQty > 1 ? midUnit : "",
    midQty: midQty > 1 ? midQty : 1,
    buyUnit: buyUnit && norm(buyUnit) !== norm(baseUnit) && conversion > 1 ? buyUnit : "",
    conversion: conversion > 1 ? conversion : 1,
    buyPrice
  };

  if ($("price-modal-buy-unit")) {
    $("price-modal-buy-unit").textContent = priceModalState.buyUnit ? ` / ${priceModalState.buyUnit}` : ` / ${baseUnit}`;
  }

  // Update deskripsi satuan aktif
  const infoEl = $("price-modal-units-info");
  if (infoEl) {
    if (priceModalState.midUnit) {
      infoEl.innerHTML = `<strong>${escapeHtml(priceModalState.midUnit)}</strong> (Kemasan Mayoritas) &amp; <strong>${escapeHtml(baseUnit)}</strong> (Eceran Pasien)`;
    } else {
      infoEl.innerHTML = `<strong>${escapeHtml(baseUnit)}</strong> (Kemasan Tunggal)`;
    }
  }

  // Label & Nilai Awal Satuan Terkecil / Ecer
  $("label-edit-sell-price").innerHTML = `Harga Eceran (<strong>${escapeHtml(baseUnit)}</strong>) <span class="text-danger">*</span>`;
  const curBase = num(prod["Harga Jual"]);
  $("input-edit-sell-price").value = curBase > 0 ? formatNumber(curBase) : "";
  if ($("hint-price-base")) $("hint-price-base").textContent = `Modal beli faktur: ${rupiah(Math.round(buyPrice / priceModalState.conversion))} per ${baseUnit}`;

  // Kontrol tombol reset: muncul jika produk sudah memiliki harga jual (> 0)
  const resetBtn = $("btn-reset-price-to-pending");
  if (resetBtn) {
    resetBtn.style.display = curBase > 0 ? "inline-flex" : "none";
  }

  // Satuan Sedang
  const midBox = $("box-edit-price-mid");
  if (midBox) {
    midBox.hidden = !priceModalState.midUnit;
    if (priceModalState.midUnit) {
      $("label-edit-price-mid").innerHTML = `Harga Satuan Sedang (<strong>${escapeHtml(priceModalState.midUnit)}</strong> — isi ${priceModalState.midQty} ${escapeHtml(baseUnit)})`;
      const curMid = num(prod["Harga Jual Satuan Sedang"]);
      const initMid = curMid > 0 ? curMid : (curBase ? curBase * priceModalState.midQty : Math.round((buyPrice / priceModalState.conversion) * priceModalState.midQty));
      $("input-edit-price-mid").value = initMid > 0 ? formatNumber(initMid) : "";
      if ($("hint-price-mid")) $("hint-price-mid").textContent = `Modal beli faktur: ${rupiah(Math.round((buyPrice / priceModalState.conversion) * priceModalState.midQty))} per ${priceModalState.midUnit}`;
    }
  }

  // Info Arsip Satuan Besar (Beli PBF)
  const buyBox = $("box-edit-price-buy");
  if (buyBox) {
    buyBox.hidden = !priceModalState.buyUnit;
    if (priceModalState.buyUnit) {
      if ($("hint-price-buy")) $("hint-price-buy").textContent = `${priceModalState.buyUnit} (isi ${priceModalState.conversion} ${baseUnit})`;
      const curBuy = num(prod["Harga Jual Satuan Besar"]) || (curBase ? curBase * priceModalState.conversion : buyPrice);
      if ($("input-edit-price-buy")) $("input-edit-price-buy").value = curBuy > 0 ? curBuy : "";
    }
  }

  modal.hidden = false;
  setTimeout(() => {
    if (priceModalState.midUnit) $("input-edit-price-mid")?.focus();
    else $("input-edit-sell-price")?.focus();
  }, 60);
}

function closeEditPriceModal() {
  const modal = $("modal-edit-price");
  if (modal) modal.hidden = true;
  activeEditingProduct = null;
}

/**
 * Handler konfirmasi reset harga produk kembali ke nol (Perlu Harga Jual)
 */
async function handleResetPriceToPending() {
  if (!activeEditingProduct) return;
  const prodName = activeEditingProduct["Nama Produk"] || activeEditingProduct["Kode Produk"] || "produk ini";
  const ok = await window.KasirProDialog?.confirm?.(
    "Kembalikan ke Perlu Harga Jual?",
    `Apakah Anda yakin ingin me-reset harga jual "${prodName}" menjadi Rp0?\n\nProduk ini akan dipindahkan kembali ke tab "Perlu Harga Jual" dan tidak dapat dijual di kasir sebelum harga ditentukan ulang.`
  );
  if (!ok) return;

  await executeResetProductPrice(activeEditingProduct);
}

/**
 * Eksekusi reset harga jual produk menjadi 0 dan status kembali ke Belum Aktif
 */
export async function executeResetProductPrice(prod) {
  if (!prod) return;
  const code = norm(prod["Kode Produk"] || prod["Kode Produk Internal"] || prod.code || prod.id);
  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? master.produk : [];
  const target = prods.find(p => norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.code || p.id) === code);
  if (!target) return;

  target["Harga Jual"] = 0;
  target["Harga Jual Satuan Sedang"] = 0;
  target["Harga Jual Satuan Besar"] = 0;
  target["sellPrice"] = 0;
  target["Status"] = "Belum Aktif";
  target["Status Produk"] = "Belum Aktif";

  const resetBtn = $("btn-reset-price-to-pending");
  const saveBtn = $("save-edit-price");
  if (resetBtn) resetBtn.disabled = true;
  if (saveBtn) saveBtn.disabled = true;

  try {
    await writeMasterDelta({ produk: [target] });
    closeEditPriceModal();
    renderProducts();
    window.KasirProDialog?.success?.(
      "Berhasil Direset",
      `Harga jual "${target["Nama Produk"] || code}" berhasil dikosongkan. Produk kini berada di filter "Perlu Harga Jual".`
    );
  } catch (err) {
    window.KasirProDialog?.error?.("Gagal Mereset", err.message);
  } finally {
    if (resetBtn) resetBtn.disabled = false;
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function handleSavePriceModal() {
  if (!activeEditingProduct) return;

  const getNumVal = (id) => {
    const el = $(id);
    if (!el) return 0;
    return parseInt(el.value.replace(/[^0-9]/g, ""), 10) || 0;
  };

  const curBase = getNumVal("input-edit-sell-price");
  const curMid = getNumVal("input-edit-price-mid");
  const conv = Math.max(1, priceModalState.conversion || 1);
  const midQty = Math.max(1, priceModalState.midQty || 1);

  let priceBase = curBase;
  let priceMid = curMid;

  if (curBase <= 0 && curMid <= 0) {
    const currentPrice = num(activeEditingProduct["Harga Jual"]);
    if (currentPrice > 0) {
      const wantReset = await window.KasirProDialog?.confirm?.(
        "Nol-kan Harga Jual?",
        `Anda mengosongkan / mengisi 0 pada harga jual.\n\nApakah Anda ingin mengembalikan produk ini ke filter "Perlu Harga Jual"?`
      );
      if (wantReset) {
        await executeResetProductPrice(activeEditingProduct);
        return;
      }
    }
    window.KasirProDialog?.warning("Perhatian", priceModalState.midUnit ? "Silakan isi Harga Satuan Sedang atau Harga Eceran." : "Harga jual eceran wajib diisi.");
    return;
  }

  if (priceModalState.midUnit) {
    if (priceMid <= 0 && priceBase > 0) priceMid = Math.round(priceBase * midQty);
    if (priceBase <= 0 && priceMid > 0) priceBase = Math.round(priceMid / midQty);
  } else {
    if (priceBase <= 0) {
      window.KasirProDialog?.warning("Perhatian", "Harga jual eceran wajib diisi.");
      return;
    }
  }

  const priceBuy = priceBase > 0 ? Math.round(priceBase * conv) : (num(activeEditingProduct["Harga Jual Satuan Besar"]) || 0);
  const allowedUnits = priceModalState.midUnit ? ["mid", "base"] : ["base"];
  const mode = priceModalState.midUnit ? "2" : "1";

  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? master.produk : [];
  const target = prods.find(p => norm(p["Kode Produk"]) === norm(activeEditingProduct["Kode Produk"]));
  if (!target) return;

  target["Harga Jual"] = priceBase;
  target["Harga Jual Satuan Sedang"] = priceMid;
  target["Harga Jual Satuan Besar"] = priceBuy;
  target["Opsi Jual"] = mode;
  target["Satuan Dijual"] = allowedUnits;
  target["Status"] = "Aktif";
  target["Status Produk"] = "Aktif";

  if (priceModalState.baseUnit) {
    target["Satuan Dasar"] = priceModalState.baseUnit;
    target["Satuan"] = priceModalState.baseUnit;
  }
  if (priceModalState.buyUnit) {
    target["Kemasan Beli"] = priceModalState.buyUnit;
    target["Satuan Pembelian"] = priceModalState.buyUnit;
  }
  if (priceModalState.buyPrice > 0) {
    if (!num(target["Harga Beli Terakhir"])) target["Harga Beli Terakhir"] = priceModalState.buyPrice;
    if (!num(target["Harga Beli"])) target["Harga Beli"] = priceModalState.buyPrice;
  }

  const saveBtn = $("save-edit-price");
  if (saveBtn) saveBtn.disabled = true;

  try {
    await writeMasterDelta({ produk: [target] });
    closeEditPriceModal();
    renderProducts();
    window.KasirProDialog?.success(
      "Harga Jual Disimpan",
      `Harga jual ${target["Nama Produk"]} berhasil diperbarui. Status produk kini Aktif (Siap Jual).`
    );
  } catch (err) {
    window.KasirProDialog?.error("Gagal Menyimpan", err.message);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * Ekstraksi akronim/singkatan supplier resmi (misal: ROSA NUGRAHA ABADI -> RNA)
 */
export function getSupplierAcronym(supplierName) {
  if (!supplierName || !String(supplierName).trim()) return "UMUM";

  let clean = String(supplierName).trim().toUpperCase();

  // Hapus prefiks bentuk badan usaha umum
  clean = clean.replace(/^(PT\.?|CV\.?|UD\.?|PD\.?|NV\.?|FA\.?|TOKO|APOTEK)\s+/i, "").trim();

  // Pisahkan kata-kata, hilangkan kata kosong atau PT/CV yang tersisa
  const words = clean.split(/[\s\-_.\/,]+/).filter(w => w.length > 0 && !/^(PT|CV|UD|PD|NV|FA)$/i.test(w));

  if (words.length === 0) return "UMUM";

  if (words.length >= 2) {
    // Ambil huruf pertama setiap kata (misal: ROSA NUGRAHA ABADI -> RNA)
    return words.map(w => w[0]).join("").slice(0, 5);
  }

  // Jika hanya 1 kata
  const single = words[0];
  if (single.length <= 4) return single;
  return single.slice(0, 3);
}

/**
 * Generate kode produk otomatis format [SupplierAcronym-NEW-0XX]
 * Contoh: ROSA NUGRAHA ABADI -> RNA-NEW-001
 */
export function generateAutoProductCode(supplierName) {
  const acronym = getSupplierAcronym(supplierName);
  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? master.produk : [];

  // Hitung jumlah produk yang sudah ada untuk supplier ini dengan format -NEW-
  const prefix = `${acronym}-NEW-`;
  const existingNumbers = prods
    .map(p => {
      const code = String(p["Kode Produk"] || p["Kode Produk Internal"] || "").toUpperCase();
      if (code.startsWith(prefix)) {
        const numPart = parseInt(code.replace(prefix, ""), 10);
        return isNaN(numPart) ? 0 : numPart;
      }
      return 0;
    })
    .filter(n => n > 0);

  const nextSeq = (existingNumbers.length > 0 ? Math.max(...existingNumbers) : 0) + 1;
  const seqStr = String(nextSeq).padStart(3, "0");
  return `${prefix}${seqStr}`;
}

/**
 * Modal Tambah Master Produk Baru
 */
function installProductModal() {
  if ($("modal-product-form")) return;

  const modalHtml = `
    <div id="modal-product-form" class="kp-dialog-v4" hidden>
      <div class="kp-dialog-v4__backdrop"></div>
      <section class="kp-dialog-v4__card" style="width:min(96vw,840px);max-height:92vh;overflow-y:auto;border-radius:14px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);" role="dialog">
        <header style="padding:14px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;background:#ffffff;">
          <h2 style="font-size:15.5px;font-weight:800;margin:0;color:#0f2a43;">
            <i class="fa-solid fa-box-open" style="color:#0284c7;margin-right:6px;"></i> Tambah Master Produk Baru
          </h2>
          <button type="button" id="close-modal-product" class="button button-small button-secondary" style="padding:4px 8px;" title="Tutup"><i class="fa-solid fa-xmark"></i></button>
        </header>

        <form id="product-form-inner" style="padding:16px 20px;display:grid;grid-template-columns:repeat(auto-fit, minmax(min(100%, 320px), 1fr));gap:12px;text-align:left;background:#f8fafc;">
          <!-- Kolom 1: Identitas & Klasifikasi -->
          <div style="display:flex;flex-direction:column;gap:10px;background:#ffffff;padding:14px;border-radius:10px;border:1px solid #e2e8f0;">
            <div style="font-size:12px;font-weight:700;color:#0f2a43;border-bottom:1px dashed #cbd5e1;padding-bottom:6px;">
              <i class="fa-solid fa-id-card text-primary" style="margin-right:5px;"></i> 1. Identitas &amp; Klasifikasi
            </div>

            <!-- Supplier (Pemicu Kode Otomatis) -->
            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <label style="font-size:11.5px;font-weight:700;color:#1e293b;">
                  Supplier / Distributor <span class="text-danger">*</span>
                </label>
                <button type="button" id="btn-quick-add-supplier" class="button button-small button-secondary" style="font-size:10.5px;padding:2px 7px;">
                  <i class="fa-solid fa-plus"></i> Baru
                </button>
              </div>
              <select id="input-prod-supplier" required style="width:100%;min-height:36px;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:12.5px;background:#fff;">
                <option value="">-- Pilih Supplier --</option>
              </select>
            </div>

            <!-- Kode Produk (Otomatis & Editable) -->
            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <label style="font-size:11.5px;font-weight:700;color:#1e293b;">
                  Kode Produk <span class="text-danger">*</span>
                </label>
                <span style="font-size:10.5px;color:#0284c7;font-weight:600;">(Otomatis)</span>
              </div>
              <input type="text" id="input-prod-code" required style="width:100%;min-height:36px;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:12.5px;font-weight:700;color:#0f2a43;background:#f8fafc;" placeholder="Otomatis mengikuti supplier">
            </div>

            <!-- Nama Produk -->
            <div>
              <label style="display:block;font-size:11.5px;font-weight:700;color:#1e293b;margin-bottom:4px;">
                Nama Produk <span class="text-danger">*</span>
              </label>
              <input type="text" id="input-prod-name" required style="width:100%;min-height:36px;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:12.5px;" placeholder="Nama produk / obat lengkap">
            </div>

            <!-- Barcode & Kategori -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <div>
                <label style="display:block;font-size:11.5px;font-weight:700;color:#1e293b;margin-bottom:4px;">
                  Barcode Fisik
                </label>
                <input type="text" id="input-prod-barcode" style="width:100%;min-height:36px;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:12.5px;" placeholder="Barcode (opsional)">
              </div>
              <div>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                  <label style="font-size:11.5px;font-weight:700;color:#1e293b;">
                    Kategori <span class="text-danger">*</span>
                  </label>
                  <button type="button" id="btn-quick-add-category" class="button button-small button-secondary" style="font-size:10px;padding:1px 5px;">
                    <i class="fa-solid fa-plus"></i> Baru
                  </button>
                </div>
                <select id="input-prod-category" required style="width:100%;min-height:36px;padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:12.5px;background:#fff;">
                  <option value="">-- Kategori --</option>
                </select>
              </div>
            </div>

            <!-- Stok Minimum (Otomatis 3, Read Only) -->
            <div style="display:flex;align-items:center;justify-content:space-between;background:#f8fafc;padding:7px 10px;border-radius:6px;border:1px solid #e2e8f0;font-size:12px;margin-top:2px;">
              <span style="color:#475569;font-weight:600;"><i class="fa-solid fa-shield-halved" style="color:#0284c7;margin-right:4px;"></i> Stok Minimum Aman:</span>
              <div style="display:inline-flex;align-items:center;gap:4px;">
                <input type="number" id="input-prod-min-stock" value="3" readonly style="width:48px;height:28px;text-align:center;font-weight:800;color:#0f2a43;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:5px;cursor:not-allowed;" title="Stok minimum otomatis 3 (read only)">
                <span style="font-size:11px;font-weight:700;color:#64748b;">(Otomatis)</span>
              </div>
            </div>
          </div>

          <!-- Kolom 2: Satuan & Konversi Kemasan 3 Tingkat Universal -->
          <div style="display:flex;flex-direction:column;gap:10px;background:#ffffff;padding:14px;border-radius:10px;border:1px solid #e2e8f0;">
            <div style="font-size:12px;font-weight:700;color:#0369a1;border-bottom:1px dashed #cbd5e1;padding-bottom:6px;margin-bottom:2px;display:flex;align-items:center;gap:6px;">
              <i class="fa-solid fa-boxes-stacked"></i> 2. Konversi Kemasan (3 Tingkat)
            </div>

            <!-- Form 1: Masukkan 3 Jenis Satuan Kemasan -->
            <div style="font-size:11px;font-weight:700;color:#475569;margin-bottom:2px;">
              Form 1: Masukkan 3 Jenis Satuan Kemasan
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:6px;">
              <div>
                <label style="display:block;font-size:10.5px;font-weight:700;color:#1e293b;margin-bottom:3px;" title="Kemasan pembelian langsung dari supplier">1. Supplier <span class="text-danger">*</span></label>
                <input type="text" id="input-prod-buy-unit" style="width:100%;min-height:34px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;font-weight:700;color:#0284c7;text-align:center;" placeholder="BOX" value="Box">
              </div>
              <div>
                <label style="display:block;font-size:10.5px;font-weight:700;color:#1e293b;margin-bottom:3px;" title="Kemasan sedang (Strip / Blister / dll)">2. Sedang</label>
                <input type="text" id="input-prod-mid-unit" style="width:100%;min-height:34px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;text-align:center;" placeholder="STRIP" value="">
              </div>
              <div>
                <label style="display:block;font-size:10.5px;font-weight:700;color:#1e293b;margin-bottom:3px;" title="Kemasan terkecil / eceran pasien">3. Terkecil <span class="text-danger">*</span></label>
                <input type="text" id="input-prod-base-unit" required style="width:100%;min-height:34px;padding:4px 6px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;font-weight:700;color:#0f172a;text-align:center;" placeholder="TABLET" value="Pcs">
              </div>
            </div>

            <!-- Form 2: Hubungan Isi Kemasan Berantai -->
            <div style="font-size:11px;font-weight:700;color:#475569;margin-bottom:2px;border-top:1px dashed #e2e8f0;padding-top:6px;">
              Form 2: Hubungan Isi Kemasan Berantai (Dinamis):
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;background:#f8fafc;padding:8px 10px;border-radius:8px;border:1px solid #e2e8f0;">
              <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#1e293b;">
                <span style="font-weight:700;min-width:14px;color:#64748b;">1.</span>
                <span>1 <strong id="lbl-dyn-buy-unit" style="color:#0284c7;">BOX</strong> =</span>
                <input type="number" id="input-prod-mid-qty" min="1" step="1" style="width:52px;min-height:28px;padding:2px 4px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;font-weight:700;text-align:center;" value="1">
                <span id="lbl-dyn-mid-unit" style="font-weight:700;color:#0369a1;">STRIP</span>
              </div>
              <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#1e293b;">
                <span style="font-weight:700;min-width:14px;color:#64748b;">2.</span>
                <span>1 <strong id="lbl-dyn-mid-unit-2" style="color:#0369a1;">STRIP</strong> =</span>
                <input type="number" id="input-prod-base-qty" min="1" step="1" style="width:52px;min-height:28px;padding:2px 4px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;font-weight:700;text-align:center;" value="1">
                <span id="lbl-dyn-base-unit" style="font-weight:700;color:#0f172a;">TABLET</span>
              </div>
              <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#0f172a;border-top:1px dashed #cbd5e1;padding-top:6px;margin-top:2px;">
                <span style="font-weight:700;min-width:14px;color:#0284c7;">3.</span>
                <span>Total 1 <strong id="lbl-dyn-buy-unit-2" style="color:#0284c7;">BOX</strong> =</span>
                <input type="number" id="input-prod-conversion" readonly style="width:58px;min-height:28px;padding:2px 4px;border:1px solid #bae6fd;border-radius:6px;font-size:12.5px;font-weight:800;color:#0284c7;background:#e0f2fe;text-align:center;" value="1">
                <span id="lbl-dyn-base-unit-2" style="font-weight:700;color:#0f172a;">TABLET</span>
              </div>
            </div>

            <!-- Hidden Fields untuk kompatibilitas data harga jual (diatur di menu harga jual) -->
            <input type="hidden" id="input-prod-buy-price" value="0">
            <input type="hidden" id="input-prod-margin" value="0">
            <input type="hidden" id="input-prod-sell-price" value="0">
          </div>
        </form>

        <footer style="padding:12px 20px;background:#ffffff;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:10px;">
          <button type="button" id="cancel-product-form" class="button button-secondary">Batal</button>
          <button type="button" id="save-product-form" class="button button-primary"><i class="fa-solid fa-floppy-disk"></i> Simpan Produk</button>
        </footer>
      </section>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  $("close-modal-product")?.addEventListener("click", closeProductModal);
  $("cancel-product-form")?.addEventListener("click", closeProductModal);
  $("save-product-form")?.addEventListener("click", handleSaveProductModal);

  // Setup Live Interaksi Konversi 3 Tingkat Berantai
  setupChainedUnitConversionEvents();

  // Quick Add Supplier
  $("btn-quick-add-supplier")?.addEventListener("click", async () => {
    const newName = prompt("Masukkan Nama Perusahaan Supplier Baru:");
    if (!newName || !newName.trim()) return;
    const cleanName = newName.trim();
    const newSup = {
      id: `SUP-${Date.now()}`,
      "Nama Perusahaan": cleanName,
      "Supplier": cleanName,
      "Status": "Aktif",
      "status": "Aktif"
    };
    await writeMasterDelta({ supplier: [newSup] });
    const supSelect = $("input-prod-supplier");
    if (supSelect) {
      const opt = document.createElement("option");
      opt.value = cleanName;
      opt.textContent = cleanName;
      supSelect.appendChild(opt);
      supSelect.value = cleanName;
      const autoCode = generateAutoProductCode(cleanName);
      const codeInput = $("input-prod-code");
      if (codeInput) codeInput.value = autoCode;
    }
    window.KasirProDialog?.success("Supplier Ditambahkan", `Supplier "${cleanName}" berhasil didaftarkan.`);
  });

  // Quick Add Kategori
  $("btn-quick-add-category")?.addEventListener("click", async () => {
    const newName = prompt("Masukkan Nama Kategori Baru:");
    if (!newName || !newName.trim()) return;
    const cleanName = newName.trim();
    const newKat = {
      id: `KAT-${Date.now()}`,
      "Kode Kategori": `KAT-${Date.now().toString().slice(-4)}`,
      "Nama Kategori": cleanName,
      "Status": "Aktif",
      "status": "Aktif"
    };
    await writeMasterDelta({ kategori: [newKat] });
    const catSelect = $("input-prod-category");
    if (catSelect) {
      const opt = document.createElement("option");
      opt.value = cleanName;
      opt.textContent = cleanName;
      catSelect.appendChild(opt);
      catSelect.value = cleanName;
    }
    window.KasirProDialog?.success("Kategori Ditambahkan", `Kategori "${cleanName}" berhasil didaftarkan.`);
  });

  // Saat dropdown supplier berubah -> regenerate kode produk otomatis
  $("input-prod-supplier")?.addEventListener("change", (e) => {
    const supName = e.target.value;
    if (supName) {
      const autoCode = generateAutoProductCode(supName);
      const codeInput = $("input-prod-code");
      if (codeInput) codeInput.value = autoCode;
    }
  });
}

function updateChainedUnitLabelsAndTotal() {
  const buyVal = text($("input-prod-buy-unit")?.value) || "BOX";
  const midVal = text($("input-prod-mid-unit")?.value) || buyVal;
  const baseVal = text($("input-prod-base-unit")?.value) || "TABLET";

  const midQty = num($("input-prod-mid-qty")?.value) || 1;
  const baseQty = num($("input-prod-base-qty")?.value) || 1;
  const totalConv = Math.max(1, midQty * baseQty);

  const lblBuy = $("lbl-dyn-buy-unit");
  const lblBuy2 = $("lbl-dyn-buy-unit-2");
  const lblMid = $("lbl-dyn-mid-unit");
  const lblMid2 = $("lbl-dyn-mid-unit-2");
  const lblBase = $("lbl-dyn-base-unit");
  const lblBase2 = $("lbl-dyn-base-unit-2");
  const convInput = $("input-prod-conversion");

  if (lblBuy) lblBuy.textContent = buyVal;
  if (lblBuy2) lblBuy2.textContent = buyVal;
  if (lblMid) lblMid.textContent = midVal;
  if (lblMid2) lblMid2.textContent = midVal;
  if (lblBase) lblBase.textContent = baseVal;
  if (lblBase2) lblBase2.textContent = baseVal;
  if (convInput) convInput.value = totalConv;
}

function setupChainedUnitConversionEvents() {
  const unitInputs = ["input-prod-buy-unit", "input-prod-mid-unit", "input-prod-base-unit", "input-prod-mid-qty", "input-prod-base-qty"];
  unitInputs.forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("focus", (e) => e.target.select());
    el.addEventListener("input", updateChainedUnitLabelsAndTotal);
  });

  // Smart Auto-fill: saat kemasan supplier diisi nama satuan tunggal (Botol/Pcs/dll),
  // jika kemasan sedang kosong atau default, otomatis sinkronkan ke 1-tingkat
  $("input-prod-buy-unit")?.addEventListener("change", (e) => {
    const val = text(e.target.value).toUpperCase();
    const isSingleUnitType = ["BOTOL", "BTL", "PCS", "PIECES", "TUBE", "SACHET", "POT", "JERIGEN", "VIAL", "AMPUL"].includes(val);
    if (isSingleUnitType) {
      const midEl = $("input-prod-mid-unit");
      const baseEl = $("input-prod-base-unit");
      const midQtyEl = $("input-prod-mid-qty");
      const baseQtyEl = $("input-prod-base-qty");
      if (midEl && (!midEl.value || midEl.value.toLowerCase() === "strip")) midEl.value = val;
      if (baseEl && (!baseEl.value || baseEl.value.toLowerCase() === "pcs")) baseEl.value = val;
      if (midQtyEl) midQtyEl.value = 1;
      if (baseQtyEl) baseQtyEl.value = 1;
      updateChainedUnitLabelsAndTotal();
    }
  });
}

let activeProductSavedCallback = null;
let activeEditingProductTarget = null;

export function openEditProductModal(prod) {
  if (!prod) return;
  activeEditingProductTarget = prod;

  const conv = Math.max(1, num(prod["Konversi"] ?? prod["Isi Kemasan"]) || 1);
  const baseQ = Math.max(1, num(prod["Isi Satuan Antara"] ?? prod["Isi Satuan Dasar"]) || 1);
  const midQ = Math.max(1, Math.round(conv / baseQ));

  openProductModal({
    isEdit: true,
    code: prod["Kode Produk"] || prod["Kode Produk Internal"] || prod.id,
    name: prod["Nama Produk"] || prod.name || "",
    barcode: prod["Barcode"] || prod.barcode || "",
    supplier: prod["Supplier"] || prod.supplier || "",
    category: prod["Kategori"] || prod.category || "",
    buyUnit: prod["Kemasan Beli"] || prod["Satuan Pembelian"] || "Box",
    midUnit: prod["Satuan Antara"] || "",
    baseUnit: prod["Satuan Dasar"] || prod["Satuan"] || "Pcs",
    midQty: midQ,
    baseQty: baseQ,
    conversion: conv,
    buyPrice: prod["Harga Beli Terakhir"] ?? prod["Harga Beli"] ?? 0
  });
}

export function openProductModal(prefill = {}, callback = null) {
  activeProductSavedCallback = typeof callback === "function" ? callback : null;
  const modal = $("modal-product-form");
  if (!modal) return;

  const isEdit = Boolean(prefill.isEdit || activeEditingProductTarget);
  const titleEl = modal.querySelector("header h2");
  if (titleEl) {
    titleEl.innerHTML = isEdit
      ? '<i class="fa-solid fa-pen-to-square" style="color:#0284c7;margin-right:6px;"></i> Edit Master Produk'
      : '<i class="fa-solid fa-box-open" style="color:#0284c7;margin-right:6px;"></i> Tambah Master Produk Baru';
  }
  const saveBtnEl = $("save-product-form");
  if (saveBtnEl) {
    saveBtnEl.innerHTML = isEdit
      ? '<i class="fa-solid fa-floppy-disk"></i> Simpan Perubahan'
      : '<i class="fa-solid fa-floppy-disk"></i> Simpan Produk';
  }

  const master = readStore(STORE_KEYS.master, {});
  const sups = Array.isArray(master.supplier) ? master.supplier : [];
  const cats = Array.isArray(master.kategori) ? master.kategori : [];

  // Populate supplier dropdown
  const supSelect = $("input-prod-supplier");
  if (supSelect) {
    supSelect.innerHTML = '<option value="">-- Pilih Nama Perusahaan Supplier --</option>' +
      sups.map(s => {
        const name = s["Nama Perusahaan"] || s["Supplier"] || s.name || "";
        return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
      }).join("");

    if (prefill.supplier) {
      supSelect.value = prefill.supplier;
      if (!supSelect.value && prefill.supplier.trim()) {
        const opt = document.createElement("option");
        opt.value = prefill.supplier.trim();
        opt.textContent = prefill.supplier.trim();
        supSelect.appendChild(opt);
        supSelect.value = prefill.supplier.trim();
      }
    }
  }

  // Populate category dropdown
  const catSelect = $("input-prod-category");
  if (catSelect) {
    catSelect.innerHTML = '<option value="">-- Pilih Nama Kategori --</option>' +
      cats.map(c => {
        const name = c["Nama Kategori"] || c.name || "";
        return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
      }).join("");
    if (prefill.category) catSelect.value = prefill.category;
  }

  // Populate form inputs
  const targetSupplier = prefill.supplier || supSelect?.value || "";
  const cInput = $("input-prod-code");
  if (cInput) {
    cInput.value = prefill.code || (targetSupplier ? generateAutoProductCode(targetSupplier) : "");
    if (isEdit) {
      cInput.readOnly = true;
      cInput.style.background = "#f1f5f9";
      cInput.style.cursor = "not-allowed";
      cInput.title = "Kode produk tidak dapat diubah (kunci utama)";
    } else {
      cInput.readOnly = false;
      cInput.style.background = "#f8fafc";
      cInput.style.cursor = "text";
      cInput.title = "";
    }
  }
  $("input-prod-name").value = prefill.name || "";
  $("input-prod-barcode").value = prefill.barcode || "";

  // 3 Tingkat Kemasan Berantai Universal
  const buyU = prefill.buyUnit || prefill.purchaseUnit || "Box";
  const midU = prefill.midUnit || prefill.intermediateUnit || "";
  const baseU = prefill.baseUnit || "Pcs";
  const midQ = (prefill.midQty !== undefined && prefill.midQty !== null && prefill.midQty !== "") ? num(prefill.midQty) : 1;
  let baseQ = 1;
  if (prefill.baseQty !== undefined && prefill.baseQty !== null && prefill.baseQty !== "") {
    baseQ = num(prefill.baseQty) || 1;
  } else if (prefill.conversion !== undefined && prefill.conversion !== null) {
    const totalConv = num(prefill.conversion) || 1;
    baseQ = Math.max(1, Math.round(totalConv / (midQ || 1)));
  }

  $("input-prod-buy-unit").value = buyU;
  if ($("input-prod-mid-unit")) $("input-prod-mid-unit").value = midU;
  if ($("input-prod-base-unit")) $("input-prod-base-unit").value = baseU;
  if ($("input-prod-mid-qty")) $("input-prod-mid-qty").value = midQ || 1;
  if ($("input-prod-base-qty")) $("input-prod-base-qty").value = baseQ || 1;
  if ($("input-prod-conversion")) $("input-prod-conversion").value = (midQ || 1) * (baseQ || 1);

  updateChainedUnitLabelsAndTotal();

  const bPriceVal = num(prefill.buyPrice);
  if ($("input-prod-buy-price")) $("input-prod-buy-price").value = bPriceVal > 0 ? String(bPriceVal) : "0";
  if ($("input-prod-sell-price")) $("input-prod-sell-price").value = "0";
  if ($("input-prod-min-stock")) $("input-prod-min-stock").value = "3";

  modal.hidden = false;
  setTimeout(() => {
    if (!prefill.name) $("input-prod-name")?.focus();
    else $("input-prod-buy-unit")?.focus();
  }, 60);
}

if (typeof window !== "undefined") {
  window.openProductModal = openProductModal;
  window.openEditProductModal = openEditProductModal;
}

export function closeProductModal() {
  const modal = $("modal-product-form");
  if (modal) modal.hidden = true;
  activeProductSavedCallback = null;
  activeEditingProductTarget = null;
  const titleEl = modal?.querySelector("header h2");
  if (titleEl) {
    titleEl.innerHTML = '<i class="fa-solid fa-box-open" style="color:#0284c7;margin-right:6px;"></i> Tambah Master Produk Baru';
  }
  const saveBtnEl = $("save-product-form");
  if (saveBtnEl) {
    saveBtnEl.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Simpan Produk';
  }
  const cInput = $("input-prod-code");
  if (cInput) {
    cInput.readOnly = false;
    cInput.style.background = "#f8fafc";
    cInput.style.cursor = "text";
    cInput.title = "";
  }
}

async function handleSaveProductModal() {
  const supplier = text($("input-prod-supplier")?.value);
  let code = text($("input-prod-code")?.value);
  const name = text($("input-prod-name")?.value);
  const barcode = text($("input-prod-barcode")?.value);
  const category = text($("input-prod-category")?.value);

  // Satuan & Konversi 3 Tingkat Berantai
  const buyUnit = text($("input-prod-buy-unit")?.value) || "Box";
  const midUnit = text($("input-prod-mid-unit")?.value) || buyUnit;
  const baseUnit = text($("input-prod-base-unit")?.value) || "Pcs";
  const midQty = num($("input-prod-mid-qty")?.value) || 1;
  const baseQty = num($("input-prod-base-qty")?.value) || 1;
  const conversion = Math.max(1, midQty * baseQty);

  const buyPrice = num($("input-prod-buy-price")?.value) || 0;
  const sellPrice = 0;
  const minStock = 3;

  if (!supplier) {
    window.KasirProDialog?.warning("Perhatian", "Silakan pilih Supplier terlebih dahulu.");
    return;
  }
  if (!name) {
    window.KasirProDialog?.warning("Perhatian", "Nama Produk wajib diisi.");
    return;
  }
  if (!category) {
    window.KasirProDialog?.warning("Perhatian", "Silakan pilih Kategori produk.");
    return;
  }

  if (!code) {
    code = generateAutoProductCode(supplier);
  }

  // Sanitasi karakter garis miring
  code = code.replace(/[\/\\]/g, "_").trim();

  // Cek duplikasi kode produk
  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? master.produk : [];
  const sups = Array.isArray(master.supplier) ? master.supplier : [];
  const cats = Array.isArray(master.kategori) ? master.kategori : [];

  if (activeEditingProductTarget) {
    // Mode EDIT MASTER PRODUK
    const targetCode = activeEditingProductTarget["Kode Produk"] || activeEditingProductTarget["Kode Produk Internal"] || activeEditingProductTarget.id;
    const target = prods.find(p => norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.id) === norm(targetCode));
    if (!target) {
      window.KasirProDialog?.error?.("Gagal Memperbarui", "Data produk tidak ditemukan di Master.");
      return;
    }

    target["Nama Produk"] = name;
    target["Barcode"] = barcode;
    target["Supplier"] = supplier;
    target["Produsen"] = supplier;
    target["Kategori"] = category;
    target["Kemasan Beli"] = buyUnit;
    target["Satuan Pembelian"] = buyUnit;
    target["Satuan Antara"] = midUnit || baseUnit;
    target["Satuan Dasar"] = baseUnit;
    target["Satuan"] = baseUnit;
    target["Konversi"] = conversion;
    target["Isi Kemasan"] = conversion;
    target["Isi Satuan Antara"] = (midUnit && norm(midUnit) !== norm(baseUnit)) ? baseQty : 1;
    target["Isi Satuan Dasar"] = baseQty || 1;

    // Sinkronkan harga jual bertingkat jika harga jual sudah ditentukan
    const curSellPrice = num(target["Harga Jual"]);
    if (curSellPrice > 0) {
      target["Harga Jual Satuan Sedang"] = (midUnit && norm(midUnit) !== norm(baseUnit)) ? Math.round(curSellPrice * target["Isi Satuan Antara"]) : 0;
      target["Harga Jual Satuan Besar"] = Math.round(curSellPrice * conversion);
      target["Opsi Jual"] = (midUnit && norm(midUnit) !== norm(baseUnit)) ? "2" : "1";
      target["Satuan Dijual"] = (midUnit && norm(midUnit) !== norm(baseUnit)) ? ["mid", "base"] : ["base"];
    }

    const saveBtn = $("save-product-form");
    if (saveBtn) saveBtn.disabled = true;

    try {
      await writeMasterDelta({ produk: [target] });
      closeProductModal();
      renderProducts();
      window.KasirProDialog?.success?.(
        "Master Produk Diperbarui",
        `Master data produk "${name}" (${targetCode}) berhasil diperbarui.`
      );
      if (typeof activeProductSavedCallback === "function") {
        try { activeProductSavedCallback(target); } catch(e) {}
      }
    } catch(err) {
      window.KasirProDialog?.error?.("Gagal Menyimpan", err.message);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
    return;
  }

  if (prods.some(p => norm(p["Kode Produk"] || p["Kode Produk Internal"]) === norm(code))) {
    window.KasirProDialog?.warning("Perhatian", `Kode produk "${code}" sudah terdaftar dalam sistem. Gunakan kode lain.`);
    return;
  }

  // Produk baru belum memiliki stok fisik dari faktur/opname, status awal otomatis "Belum Aktif"
  const status = "Belum Aktif";

  const newProduct = {
    id: code,
    "Kode Produk": code,
    "Kode Produk Internal": code,
    "Barcode": barcode,
    "Nama Produk": name,
    "Kategori": category,
    "Supplier": supplier,
    "Produsen": supplier,
    "Harga Beli Terakhir": buyPrice,
    "Harga Beli": buyPrice,
    "Harga Jual": sellPrice,
    "Satuan Pembelian": buyUnit,
    "Kemasan Beli": buyUnit,
    "Konversi": conversion,
    "Isi Kemasan": conversion,
    "Satuan Dasar": baseUnit,
    "Satuan": baseUnit,
    "Satuan Antara": midUnit || baseUnit,
    "Isi Satuan Antara": (midUnit && norm(midUnit) !== norm(baseUnit)) ? baseQty : 1,
    "Isi Satuan Dasar": baseQty || 1,
    "Stok Minimum": minStock,
    "Stok Awal": 0,
    "Status": status,
    "Status Produk": status
  };

  // Siapkan delta payload
  const deltaPayload = { produk: [newProduct] };

  // Otomatis daftarkan supplier ke master supplier jika belum ada di menu supplier
  let newSupAdded = null;
  if (supplier && !sups.some(s => norm(s["Nama Perusahaan"] || s["Supplier"]) === norm(supplier))) {
    newSupAdded = {
      id: `SUP-${Date.now()}`,
      "Nama Perusahaan": supplier,
      "Supplier": supplier,
      "Nama Sales/PIC": "Belum di atur",
      "NPWP": "Belum di atur",
      "Status": "Aktif",
      "status": "Aktif"
    };
    deltaPayload.supplier = [newSupAdded];
  }

  // Otomatis daftarkan kategori ke master kategori jika belum ada di menu kategori
  let newCatAdded = null;
  if (category && !cats.some(c => norm(c["Nama Kategori"] || c.name) === norm(category))) {
    newCatAdded = {
      id: `KAT-${Date.now()}`,
      "Kode Kategori": `KAT-${Date.now().toString().slice(-4)}`,
      "Nama Kategori": category,
      "Status": "Aktif",
      "status": "Aktif"
    };
    deltaPayload.kategori = [newCatAdded];
  }

  const saveBtn = $("save-product-form");
  if (saveBtn) saveBtn.disabled = true;

  try {
    await writeMasterDelta(deltaPayload);
    const cb = activeProductSavedCallback;
    closeProductModal();
    renderProducts();

    // Trigger update tampilan supplier dan kategori jika ada yang baru
    if (newSupAdded && typeof window.renderSuppliers === "function") {
      window.renderSuppliers();
    }
    if (newCatAdded && typeof window.renderCategories === "function") {
      window.renderCategories();
    }

    const supNote = newSupAdded ? `\n(Supplier "${supplier}" otomatis terdaftar di Menu Supplier)` : "";
    window.KasirProDialog?.success(
      "Produk Ditambahkan",
      `Produk "${name}" berhasil didaftarkan ke Master Produk dengan kode: ${code}.${supNote}\nStatus: Belum Aktif (menunggu penerimaan stok faktur/opname).`
    );
    if (typeof cb === "function") {
      try { cb(newProduct); } catch (e) { console.error("Error invoking product saved callback:", e); }
    }
  } catch (err) {
    console.error("[Products] Error saving manual product:", err);
    window.KasirProDialog?.error("Gagal Menyimpan", err.message || "Terjadi kesalahan saat menyimpan produk.");
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}
