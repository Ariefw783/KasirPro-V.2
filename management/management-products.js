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
import { exportMasterData, parseMasterWorkbook } from "../modules/excel/excel-service.js";

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

  $("product-status-filter")?.addEventListener("change", () => {
    currentPage = 1;
    applyFilters();
  });

  $("product-reset-filter")?.addEventListener("click", () => {
    const sInput = $("product-search");
    if (sInput) sInput.value = "";
    const cFilter = $("product-category-filter");
    if (cFilter) cFilter.value = "";
    const supFilter = $("product-supplier-filter");
    if (supFilter) supFilter.value = "";
    const stFilter = $("product-status-filter");
    if (stFilter) stFilter.value = "";
    currentPage = 1;
    applyFilters();
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

  // Modal Edit Harga Jual & Tambah Produk
  installEditPriceModal();
  installProductModal();
}

export function renderProducts() {
  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? master.produk : [];
  currentProducts = prods.filter(p => !p._isDeleted);

  // Update dropdown filter kategori & supplier
  populateFilterDropdowns(master);

  applyFilters();
  updateSummaryKpis();
}

function populateFilterDropdowns(master) {
  const catFilter = $("product-category-filter");
  if (catFilter) {
    const currentVal = catFilter.value;
    const cats = Array.isArray(master.kategori) ? master.kategori : [];
    catFilter.innerHTML = '<option value="">Semua Kategori</option>';
    cats.forEach(c => {
      const name = c["Nama Kategori"] || c.name || "";
      if (name) {
        catFilter.innerHTML += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
      }
    });
    catFilter.value = currentVal;
  }

  const supFilter = $("product-supplier-filter");
  if (supFilter) {
    const currentVal = supFilter.value;
    const sups = Array.isArray(master.supplier) ? master.supplier : [];
    supFilter.innerHTML = '<option value="">Semua Supplier</option>';
    sups.forEach(s => {
      const name = s["Nama Perusahaan"] || s["Supplier"] || s.name || "";
      if (name) {
        supFilter.innerHTML += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
      }
    });
    supFilter.value = currentVal;
  }

  // Pastikan status filter punya opsi resmi KasirPro
  const statusFilter = $("product-status-filter");
  if (statusFilter && !statusFilter.querySelector('option[value="tidak aktif"]')) {
    const curVal = statusFilter.value;
    statusFilter.innerHTML = `
      <option value="">Semua Status</option>
      <option value="aktif">Aktif (Siap Jual)</option>
      <option value="belum aktif">Belum Aktif (Perlu Harga Jual)</option>
      <option value="tidak aktif">Tidak Aktif (Belum Ada Stok)</option>
      <option value="nonaktif">Nonaktif</option>
    `;
    if (curVal) statusFilter.value = curVal;
  }
}

function updateSummaryKpis() {
  const total = currentProducts.length;
  let totalStock = 0;
  let lowStockCount = 0;

  currentProducts.forEach(p => {
    const code = norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.id);
    const stock = Math.max(readCurrentStock(code), num(p["Stok Awal"] ?? p.stock ?? 0));
    const min = num(p["Stok Minimum"]);
    totalStock += stock;
    if (stock <= 0 || (min > 0 && stock <= min)) {
      lowStockCount++;
    }
  });

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

  filteredProducts = currentProducts.filter(p => {
    if (p._isDeleted) return false;
    const code = norm(p["Kode Produk"] || p["Kode Produk Internal"]);
    const barcode = norm(p["Barcode"]);
    const name = norm(p["Nama Produk"]);
    const pCat = norm(p["Kategori"]);
    const pSup = norm(p["Supplier"]);
    const pStatus = norm(p["Status"] || p["Status Produk"] || p.status);
    const sellPrice = num(p["Harga Jual"] ?? p.sellPrice ?? 0);

    // Pencarian text
    if (q && !code.includes(q) && !barcode.includes(q) && !name.includes(q)) {
      return false;
    }
    // Filter kategori
    if (cat && pCat !== cat) return false;
    // Filter supplier
    if (sup && pSup !== sup) return false;

    const stock = Math.max(readCurrentStock(code), num(p["Stok Awal"] ?? p.stock ?? 0));

    // Filter status khusus yang saling eksklusif sesuai alur operasional KasirPro:
    // 1. Belum Aktif (Perlu Harga Jual): Mempunyai stok via faktur (> 0), tapi belum diisi harga jual (<= 0)
    if (statusVal === "belum aktif" || statusVal === "perlu harga jual") {
      return pStatus !== "nonaktif" && stock > 0 && sellPrice <= 0;
    }
    // 2. Aktif (Siap Jual): Mempunyai stok via faktur (> 0) DAN sudah diisi harga jual (> 0) -> Siap transaksi POS
    if (statusVal === "aktif") {
      return pStatus !== "nonaktif" && stock > 0 && sellPrice > 0;
    }
    // 3. Tidak Aktif: Belum mendapat stok fisik via input faktur (stock <= 0)
    if (statusVal === "tidak aktif") {
      return pStatus !== "nonaktif" && stock <= 0;
    }
    // 4. Nonaktif: Dinonaktifkan manual oleh pengguna/manajer
    if (statusVal === "nonaktif") {
      return pStatus === "nonaktif";
    }
    if (statusVal && pStatus !== statusVal) {
      return false;
    }

    return true;
  });

  const resetBtn = $("product-reset-filter");
  if (resetBtn) {
    resetBtn.hidden = !(q || cat || sup || statusVal);
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
    tbody.innerHTML = `<tr><td colspan="11" class="empty-table-state" style="text-align:center;padding:24px;">Tidak ada data produk yang sesuai kriteria pencarian.</td></tr>`;
  } else {
    tbody.innerHTML = pageItems.map((p, idx) => {
      const code = p["Kode Produk"] || p["Kode Produk Internal"] || "—";
      const name = p["Nama Produk"] || "—";
      const rawCat = p["Kategori"] || "";
      const rawSup = p["Supplier"] || "";
      const cat = categoryLookup.get(norm(rawCat)) || rawCat || "—";
      const sup = supplierLookup.get(norm(rawSup)) || rawSup || "—";
      const buyPrice = num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0);
      const sellPrice = num(p["Harga Jual"] ?? p.sellPrice ?? 0);
      const stock = Math.max(readCurrentStock(code), num(p["Stok Awal"] ?? p.stock ?? 0));
      const unit = p["Satuan Dasar"] || p["Satuan"] || "Pcs";
      const buyUnit = p["Satuan Pembelian"] || unit;
      const conv = num(p["Konversi"]) || 1;
      const unitLabel = norm(buyUnit) !== norm(unit) && conv > 1
        ? `<strong>${escapeHtml(buyUnit)}</strong> <small class="text-muted">(1 ${escapeHtml(buyUnit)} = ${formatNumber(conv)} ${escapeHtml(unit)})</small>`
        : `<strong>${escapeHtml(unit)}</strong>`;
      const minStock = num(p["Stok Minimum"]);
      const rawStatus = p["Status"] || p["Status Produk"];
      const statusBadge = getStatusBadge(rawStatus, sellPrice, stock);

      return `
        <tr data-code="${escapeHtml(code)}">
          <td><strong>${escapeHtml(code)}</strong><br><small class="text-muted">${escapeHtml(p["Barcode"] || "")}</small></td>
          <td><strong>${escapeHtml(name)}</strong></td>
          <td><span style="font-weight:600;color:#0f2a43;">${escapeHtml(cat)}</span></td>
          <td><span style="font-weight:600;color:#0f2a43;">${escapeHtml(sup)}</span></td>
          <td>${rupiah(buyPrice)}</td>
          <td>
            <div style="display:flex;align-items:center;gap:6px;">
              <strong class="${sellPrice <= 0 ? 'text-danger' : 'text-primary'}">${sellPrice > 0 ? rupiah(sellPrice) : 'Rp0 (Belum diisi)'}</strong>
              <button type="button" class="btn-edit-price button button-small button-secondary" data-code="${escapeHtml(code)}" title="Ubah Harga Jual">
                <i class="fa-solid fa-pen"></i>
              </button>
            </div>
          </td>
          <td>${unitLabel}</td>
          <td><strong>${formatNumber(stock)}</strong> ${escapeHtml(unit)}</td>
          <td>${formatNumber(minStock)} ${escapeHtml(unit)}</td>
          <td>${statusBadge}</td>
          <td>
            <div style="display:flex;align-items:center;gap:4px;">
              <button type="button" class="btn-delete-product button button-small button-danger" data-code="${escapeHtml(code)}" title="Hapus Produk">
                <i class="fa-solid fa-trash"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join("");

    // Bind event Edit Harga Jual per row
    tbody.querySelectorAll(".btn-edit-price").forEach(btn => {
      btn.addEventListener("click", () => {
        const code = btn.dataset.code;
        const prod = currentProducts.find(p => norm(p["Kode Produk"]) === norm(code));
        if (prod) openEditPriceModal(prod);
      });
    });

    // Bind event hapus produk bersyarat
    tbody.querySelectorAll(".btn-delete-product").forEach(btn => {
      btn.addEventListener("click", () => {
        const code = btn.dataset.code;
        handleDeleteProduct(code);
      });
    });
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
  const normStatus = norm(rawStatus);
  if (normStatus === "nonaktif") {
    return `<span class="badge badge-secondary" style="background:#f1f5f9;color:#64748b;border:1px solid #cbd5e1;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;"><i class="fa-solid fa-ban"></i> Nonaktif</span>`;
  }
  if (stock > 0) {
    if (sellPrice <= 0) {
      return `<span class="badge badge-warning" style="background:#fff7ed;color:#ea580c;border:1px solid #ffedd5;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;" title="Produk sudah mempunyai stok via faktur tetapi belum diatur harga jualnya"><i class="fa-solid fa-triangle-exclamation"></i> Belum Aktif (Perlu Harga Jual)</span>`;
    }
    return `<span class="badge badge-success" style="background:#ecfdf5;color:#059669;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;" title="Produk memiliki stok dan harga jual, siap ditransaksikan di POS"><i class="fa-solid fa-circle-check"></i> Aktif</span>`;
  }
  return `<span class="badge badge-secondary" style="background:#f8fafc;color:#64748b;border:1px solid #e2e8f0;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;" title="Belum mendapat stok via input faktur"><i class="fa-solid fa-clock"></i> Tidak Aktif</span>`;
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
  const hasSales = sales.some(s => (s.items || []).some(it => norm(it.code) === norm(code)));
  const hasInvoices = invoices.some(inv => (inv.items || []).some(it => norm(it.matchedProductCode) === norm(code)));

  if (stock > 0 || hasMovements || hasSales || hasInvoices) {
    const confirmDeactivate = await window.KasirProDialog?.confirm(
      "Produk Memiliki Riwayat",
      `Produk "${prodName}" memiliki stok (${stock}) atau riwayat transaksi di sistem.\n\nSesuai prinsip akuntansi, produk dengan riwayat tidak boleh dihapus permanen agar audit penjualan masa lalu tidak rusak.\n\nApakah Anda ingin MENONAKTIFKAN produk ini?`
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

  // Jika produk baru & belum pernah ada transaksi -> Hapus permanen
  const confirmDelete = await window.KasirProDialog?.confirm(
    "Hapus Produk Permanen",
    `Apakah Anda yakin ingin menghapus produk "${prodName}"? Produk ini belum memiliki riwayat transaksi sehingga akan dihapus secara permanen dari sistem dan cloud.`
  );
  if (!confirmDelete) return;

  try {
    await deleteMasterProduct(code);
    renderProducts();
    window.KasirProDialog?.success("Berhasil Dihapus", `Produk "${prodName}" berhasil dihapus secara permanen.`);
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
      <section class="kp-dialog-v4__card" style="width:min(96vw,540px);max-height:92vh;overflow-y:auto;" role="dialog">
        <header style="padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;background:#0f172a;color:#fff;">
          <div>
            <h2 style="font-size:16px;font-weight:800;margin:0;color:#f8fafc;"><i class="fa-solid fa-tags text-primary"></i> Atur Harga Jual Bertingkat</h2>
            <p style="font-size:11px;color:#94a3b8;margin:2px 0 0;">Tentukan satuan konversi yang boleh dijual ke pembeli di kasir</p>
          </div>
          <button type="button" id="close-modal-price" class="button button-small button-secondary" style="padding:4px 8px;color:#cbd5e1;" title="Tutup"><i class="fa-solid fa-xmark"></i></button>
        </header>

        <div style="padding:18px 20px;text-align:left;display:grid;gap:14px;background:#f8fafc;">
          <!-- Info Ringkas Produk & Modal Faktur Fisik -->
          <div style="background:#fff;padding:12px 14px;border-radius:10px;border:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(0,0,0,0.03);">
            <div style="font-size:11px;color:#64748b;font-weight:600;">Produk:</div>
            <strong id="price-modal-name" style="display:block;font-size:14.5px;color:#0f172a;margin-top:2px;">—</strong>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;padding-top:6px;border-top:1px dashed #e2e8f0;font-size:11.5px;flex-wrap:wrap;gap:6px;">
              <span style="color:#64748b;">Kode: <strong id="price-modal-code" style="color:#0f172a;">—</strong></span>
              <span style="color:#0369a1;font-weight:700;">Modal Faktur Fisik: <strong id="price-modal-buy" style="color:#0284c7;">Rp0</strong> <span id="price-modal-buy-unit" style="font-size:10px;color:#64748b;"></span></span>
            </div>
          </div>

          <!-- Opsi Berapa Satuan Yang Dijual ke Pembeli -->
          <div style="background:#fff;padding:14px;border-radius:10px;border:1px solid #cbd5e1;box-shadow:0 1px 3px rgba(0,0,0,0.03);">
            <label style="display:block;font-size:12px;font-weight:800;color:#0f172a;margin-bottom:8px;">
              <i class="fa-solid fa-cart-shopping text-primary"></i> Opsi Satuan yang Ingin Dijual ke Pembeli (POS):
            </label>
            <div style="display:grid;gap:8px;">
              <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer;font-weight:600;color:#334155;background:#f8fafc;padding:8px 10px;border-radius:6px;border:1px solid #e2e8f0;">
                <input type="radio" name="price-selling-mode" value="1" checked style="accent-color:#2563eb;">
                <span><strong>Hanya Jual 1 Satuan Konversi</strong> <span style="font-size:11px;color:#64748b;display:block;font-weight:400;">Input harga satuan pilihan, 2 satuan lainnya terisi otomatis</span></span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer;font-weight:600;color:#334155;background:#f8fafc;padding:8px 10px;border-radius:6px;border:1px solid #e2e8f0;">
                <input type="radio" name="price-selling-mode" value="2" style="accent-color:#2563eb;">
                <span><strong>Jual 2 Satuan Konversi</strong> <span style="font-size:11px;color:#64748b;display:block;font-weight:400;">Input 2 harga satuan pilihan, 1 satuan lainnya terisi otomatis</span></span>
              </label>
              <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer;font-weight:600;color:#334155;background:#f8fafc;padding:8px 10px;border-radius:6px;border:1px solid #e2e8f0;">
                <input type="radio" name="price-selling-mode" value="3" style="accent-color:#2563eb;">
                <span><strong>Jual Semua (3 Satuan Konversi)</strong> <span style="font-size:11px;color:#64748b;display:block;font-weight:400;">Wajib mengisi harga jual dari ketiga satuan konversi</span></span>
              </label>
            </div>

            <!-- Selector Pilihan Satuan untuk Mode 1 -->
            <div id="box-mode-1-selector" style="margin-top:10px;padding-top:10px;border-top:1px dashed #e2e8f0;">
              <label style="display:block;font-size:11.5px;font-weight:700;color:#0369a1;margin-bottom:4px;">Pilih Satuan Tunggal Yang Boleh Dijual ke Pembeli:</label>
              <select id="select-active-single-unit" style="width:100%;min-height:36px;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:12.5px;font-weight:700;background:#fff;">
              </select>
            </div>

            <!-- Selector Pilihan Satuan untuk Mode 2 -->
            <div id="box-mode-2-selector" style="margin-top:10px;padding-top:10px;border-top:1px dashed #e2e8f0;" hidden>
              <label style="display:block;font-size:11.5px;font-weight:700;color:#0369a1;margin-bottom:4px;">Centang Tepat 2 Satuan Yang Boleh Dijual ke Pembeli:</label>
              <div id="checkboxes-dual-unit" style="display:flex;gap:12px;flex-wrap:wrap;">
              </div>
            </div>
          </div>

          <!-- Input Kolom Harga Jual Ketiga Satuan -->
          <div style="background:#fff;padding:14px;border-radius:10px;border:1px solid #cbd5e1;box-shadow:0 1px 3px rgba(0,0,0,0.03);display:grid;gap:12px;">
            <!-- 1. Satuan Terkecil / Ecer -->
            <div id="box-price-row-base">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <label id="label-edit-sell-price" style="font-size:12px;font-weight:700;color:#1e293b;">
                  Harga Jual Satuan Terkecil / Ecer <span class="text-danger">*</span>
                </label>
                <span id="badge-auto-base" style="font-size:10px;padding:1px 6px;border-radius:4px;background:#f1f5f9;color:#64748b;font-weight:600;" hidden>Terhitung Otomatis</span>
              </div>
              <div style="position:relative;">
                <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);font-weight:700;color:#64748b;font-size:12.5px;">Rp</span>
                <input type="text" inputmode="numeric" id="input-edit-sell-price" style="width:100%;min-height:38px;padding:6px 10px 6px 34px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px;font-weight:800;color:#0f172a;" placeholder="0">
              </div>
              <div id="hint-price-base" style="font-size:10.5px;color:#64748b;margin-top:2px;"></div>
            </div>

            <!-- 2. Satuan Sedang (Strip / Blister) -->
            <div id="box-edit-price-mid">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <label id="label-edit-price-mid" style="font-size:12px;font-weight:700;color:#0369a1;">
                  Harga Jual Satuan Sedang
                </label>
                <span id="badge-auto-mid" style="font-size:10px;padding:1px 6px;border-radius:4px;background:#f1f5f9;color:#64748b;font-weight:600;" hidden>Terhitung Otomatis</span>
              </div>
              <div style="position:relative;">
                <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);font-weight:700;color:#64748b;font-size:12.5px;">Rp</span>
                <input type="text" inputmode="numeric" id="input-edit-price-mid" style="width:100%;min-height:38px;padding:6px 10px 6px 34px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px;font-weight:800;color:#0369a1;" placeholder="0">
              </div>
              <div id="hint-price-mid" style="font-size:10.5px;color:#64748b;margin-top:2px;"></div>
            </div>

            <!-- 3. Satuan Besar (Box / Dus) -->
            <div id="box-edit-price-buy">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <label id="label-edit-price-buy" style="font-size:12px;font-weight:700;color:#047857;">
                  Harga Jual Satuan Besar
                </label>
                <span id="badge-auto-buy" style="font-size:10px;padding:1px 6px;border-radius:4px;background:#f1f5f9;color:#64748b;font-weight:600;" hidden>Terhitung Otomatis</span>
              </div>
              <div style="position:relative;">
                <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);font-weight:700;color:#64748b;font-size:12.5px;">Rp</span>
                <input type="text" inputmode="numeric" id="input-edit-price-buy" style="width:100%;min-height:38px;padding:6px 10px 6px 34px;border:1px solid #cbd5e1;border-radius:6px;font-size:14px;font-weight:800;color:#047857;" placeholder="0">
              </div>
              <div id="hint-price-buy" style="font-size:10.5px;color:#64748b;margin-top:2px;"></div>
            </div>
          </div>
        </div>

        <footer style="padding:12px 20px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:8px;">
          <button type="button" id="cancel-edit-price" class="button button-secondary">Batal</button>
          <button type="button" id="save-edit-price" class="button button-primary"><i class="fa-solid fa-floppy-disk"></i> Simpan Harga &amp; Aktifkan</button>
        </footer>
      </section>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  // Setup live auto dots pada ketiga input harga
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

  setupAutoDots("input-edit-sell-price", (val) => recalculateTieredPricesFrom("base", val));
  setupAutoDots("input-edit-price-mid", (val) => recalculateTieredPricesFrom("mid", val));
  setupAutoDots("input-edit-price-buy", (val) => recalculateTieredPricesFrom("buy", val));

  // Radio button mode switch
  document.querySelectorAll('input[name="price-selling-mode"]').forEach(radio => {
    radio.addEventListener("change", (e) => {
      priceModalState.mode = e.target.value;
      updatePriceModalUIByMode();
    });
  });

  // Mode 1: Single unit selector change
  $("select-active-single-unit")?.addEventListener("change", (e) => {
    priceModalState.singleSelected = e.target.value;
    updatePriceModalUIByMode();
  });

  $("close-modal-price")?.addEventListener("click", closeEditPriceModal);
  $("cancel-edit-price")?.addEventListener("click", closeEditPriceModal);
  $("save-edit-price")?.addEventListener("click", handleSavePriceModal);
}

function updatePriceModalUIByMode() {
  const mode = priceModalState.mode;
  const boxMode1 = $("box-mode-1-selector");
  const boxMode2 = $("box-mode-2-selector");

  if (boxMode1) boxMode1.hidden = mode !== "1";
  if (boxMode2) boxMode2.hidden = mode !== "2";

  const inpBase = $("input-edit-sell-price");
  const inpMid = $("input-edit-price-mid");
  const inpBuy = $("input-edit-price-buy");

  const badgeBase = $("badge-auto-base");
  const badgeMid = $("badge-auto-mid");
  const badgeBuy = $("badge-auto-buy");

  if (mode === "1") {
    // Mode 1: Hanya 1 satuan yang dipilih yang aktif, 2 lainnya read-only otomatis
    const activeUnit = priceModalState.singleSelected || "base";
    if (inpBase) {
      inpBase.readOnly = activeUnit !== "base";
      inpBase.style.background = activeUnit === "base" ? "#fff" : "#f1f5f9";
      if (badgeBase) badgeBase.hidden = activeUnit === "base";
    }
    if (inpMid) {
      inpMid.readOnly = activeUnit !== "mid";
      inpMid.style.background = activeUnit === "mid" ? "#fff" : "#f1f5f9";
      if (badgeMid) badgeMid.hidden = activeUnit === "mid";
    }
    if (inpBuy) {
      inpBuy.readOnly = activeUnit !== "buy";
      inpBuy.style.background = activeUnit === "buy" ? "#fff" : "#f1f5f9";
      if (badgeBuy) badgeBuy.hidden = activeUnit === "buy";
    }
  } else if (mode === "2") {
    // Mode 2: 2 satuan aktif yang dicentang, 1 satuan lainnya otomatis
    const dual = priceModalState.dualSelected || ["base", "mid"];
    if (inpBase) {
      const isAct = dual.includes("base");
      inpBase.readOnly = !isAct;
      inpBase.style.background = isAct ? "#fff" : "#f1f5f9";
      if (badgeBase) badgeBase.hidden = isAct;
    }
    if (inpMid) {
      const isAct = dual.includes("mid");
      inpMid.readOnly = !isAct;
      inpMid.style.background = isAct ? "#fff" : "#f1f5f9";
      if (badgeMid) badgeMid.hidden = isAct;
    }
    if (inpBuy) {
      const isAct = dual.includes("buy");
      inpBuy.readOnly = !isAct;
      inpBuy.style.background = isAct ? "#fff" : "#f1f5f9";
      if (badgeBuy) badgeBuy.hidden = isAct;
    }
  } else {
    // Mode 3: Ketiga satuan wajib diisi
    if (inpBase) {
      inpBase.readOnly = false;
      inpBase.style.background = "#fff";
      if (badgeBase) badgeBase.hidden = true;
    }
    if (inpMid) {
      inpMid.readOnly = false;
      inpMid.style.background = "#fff";
      if (badgeMid) badgeMid.hidden = true;
    }
    if (inpBuy) {
      inpBuy.readOnly = false;
      inpBuy.style.background = "#fff";
      if (badgeBuy) badgeBuy.hidden = true;
    }
  }
}

function recalculateTieredPricesFrom(sourceLevel, sourceVal) {
  if (sourceVal <= 0) return;

  const conv = Math.max(1, priceModalState.conversion || 1); // isi kemasan total dasar
  const midQty = Math.max(1, priceModalState.midQty || 1); // isi dasar per sedang
  const midPerBuy = Math.max(1, conv / midQty);

  const inpBase = $("input-edit-sell-price");
  const inpMid = $("input-edit-price-mid");
  const inpBuy = $("input-edit-price-buy");

  let basePrice = 0;
  if (sourceLevel === "base") {
    basePrice = sourceVal;
  } else if (sourceLevel === "mid") {
    basePrice = Math.round(sourceVal / midQty);
  } else if (sourceLevel === "buy") {
    basePrice = Math.round(sourceVal / conv);
  }

  // Jika mode 1 atau mode 2: isi field yang readOnly
  const mode = priceModalState.mode;
  if (mode === "1") {
    const single = priceModalState.singleSelected;
    if (single !== "base" && inpBase && inpBase.readOnly) {
      inpBase.value = basePrice ? formatNumber(basePrice) : "";
    }
    if (single !== "mid" && inpMid && inpMid.readOnly) {
      const midP = Math.round(basePrice * midQty);
      inpMid.value = midP ? formatNumber(midP) : "";
    }
    if (single !== "buy" && inpBuy && inpBuy.readOnly) {
      const buyP = Math.round(basePrice * conv);
      inpBuy.value = buyP ? formatNumber(buyP) : "";
    }
  } else if (mode === "2") {
    const dual = priceModalState.dualSelected;
    if (!dual.includes("base") && inpBase && inpBase.readOnly) {
      inpBase.value = basePrice ? formatNumber(basePrice) : "";
    }
    if (!dual.includes("mid") && inpMid && inpMid.readOnly) {
      const midP = Math.round(basePrice * midQty);
      inpMid.value = midP ? formatNumber(midP) : "";
    }
    if (!dual.includes("buy") && inpBuy && inpBuy.readOnly) {
      const buyP = Math.round(basePrice * conv);
      inpBuy.value = buyP ? formatNumber(buyP) : "";
    }
  }
}

function openEditPriceModal(prod) {
  activeEditingProduct = prod;
  const modal = $("modal-edit-price");
  if (!modal) return;

  $("price-modal-name").textContent = prod["Nama Produk"] || "—";
  $("price-modal-code").textContent = prod["Kode Produk"] || prod["Kode Produk Internal"] || "—";

  const buyPrice = num(prod["Harga Beli Terakhir"] ?? prod["Harga Beli"] ?? 0);
  $("price-modal-buy").textContent = rupiah(buyPrice);

  const baseUnit = String(prod["Satuan Dasar"] || prod["Satuan"] || "Pcs").trim();
  const midUnit = String(prod["Satuan Antara"] || "").trim();
  const midQty = num(prod["Isi Satuan Antara"] || 1);
  const buyUnit = String(prod["Kemasan Beli"] || prod["Satuan Pembelian"] || "").trim();
  const conversion = num(prod["Konversi"] ?? prod["Isi Kemasan"] ?? 1);

  priceModalState = {
    mode: String(prod["Opsi Jual"] || "1"),
    singleSelected: "base",
    dualSelected: ["base", "mid"],
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

  // Populate Selector Mode 1 (Single Unit)
  const selSingle = $("select-active-single-unit");
  if (selSingle) {
    let opts = `<option value="base">Satuan Terkecil (${escapeHtml(baseUnit)})</option>`;
    if (priceModalState.midUnit) {
      opts += `<option value="mid">Satuan Sedang (${escapeHtml(priceModalState.midUnit)} - isi ${priceModalState.midQty} ${escapeHtml(baseUnit)})</option>`;
    }
    if (priceModalState.buyUnit) {
      opts += `<option value="buy">Satuan Besar (${escapeHtml(priceModalState.buyUnit)} - isi ${priceModalState.conversion} ${escapeHtml(baseUnit)})</option>`;
    }
    selSingle.innerHTML = opts;
    selSingle.value = "base";
  }

  // Populate Checkbox Mode 2 (Dual Unit)
  const boxDual = $("checkboxes-dual-unit");
  if (boxDual) {
    boxDual.innerHTML = `
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;">
        <input type="checkbox" class="chk-dual-unit" value="base" checked style="accent-color:#2563eb;">
        <span>${escapeHtml(baseUnit)} (Terkecil)</span>
      </label>
      ${priceModalState.midUnit ? `
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;">
          <input type="checkbox" class="chk-dual-unit" value="mid" checked style="accent-color:#2563eb;">
          <span>${escapeHtml(priceModalState.midUnit)} (Sedang)</span>
        </label>
      ` : ''}
      ${priceModalState.buyUnit ? `
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;">
          <input type="checkbox" class="chk-dual-unit" value="buy" style="accent-color:#2563eb;">
          <span>${escapeHtml(priceModalState.buyUnit)} (Besar)</span>
        </label>
      ` : ''}
    `;

    boxDual.querySelectorAll(".chk-dual-unit").forEach(chk => {
      chk.addEventListener("change", () => {
        const checkedVals = Array.from(boxDual.querySelectorAll(".chk-dual-unit:checked")).map(c => c.value);
        if (checkedVals.length > 2) {
          chk.checked = false;
          window.KasirProDialog?.warning("Maksimal 2 Satuan", "Pada Opsi Jual 2 Satuan, Anda hanya dapat memilih tepat 2 satuan.");
          return;
        }
        priceModalState.dualSelected = checkedVals;
        updatePriceModalUIByMode();
      });
    });
  }

  // Set nilai radio mode
  const radios = document.querySelectorAll('input[name="price-selling-mode"]');
  radios.forEach(r => {
    r.checked = r.value === priceModalState.mode;
  });

  // Label & Nilai Awal Satuan Terkecil
  $("label-edit-sell-price").innerHTML = `Harga Jual Satuan Terkecil / Ecer (<strong>${escapeHtml(baseUnit)}</strong>) <span class="text-danger">*</span>`;
  const curBase = num(prod["Harga Jual"]);
  $("input-edit-sell-price").value = curBase > 0 ? formatNumber(curBase) : "";
  if ($("hint-price-base")) $("hint-price-base").textContent = `Modal dasar: ${rupiah(Math.round(buyPrice / priceModalState.conversion))}`;

  // Satuan Sedang
  const midBox = $("box-edit-price-mid");
  if (midBox) {
    midBox.hidden = !priceModalState.midUnit;
    if (priceModalState.midUnit) {
      $("label-edit-price-mid").innerHTML = `Harga Jual Satuan Sedang (<strong>${escapeHtml(priceModalState.midUnit)}</strong> - isi ${priceModalState.midQty} ${escapeHtml(baseUnit)})`;
      const curMid = num(prod["Harga Jual Satuan Sedang"]);
      const initMid = curMid > 0 ? curMid : (curBase ? curBase * priceModalState.midQty : Math.round((buyPrice / priceModalState.conversion) * priceModalState.midQty * 1.2));
      $("input-edit-price-mid").value = initMid > 0 ? formatNumber(initMid) : "";
      if ($("hint-price-mid")) $("hint-price-mid").textContent = `Modal dasar: ${rupiah(Math.round((buyPrice / priceModalState.conversion) * priceModalState.midQty))}`;
    }
  }

  // Satuan Besar
  const buyBox = $("box-edit-price-buy");
  if (buyBox) {
    buyBox.hidden = !priceModalState.buyUnit;
    if (priceModalState.buyUnit) {
      $("label-edit-price-buy").innerHTML = `Harga Jual Satuan Besar (<strong>${escapeHtml(priceModalState.buyUnit)}</strong> - isi ${priceModalState.conversion} ${escapeHtml(baseUnit)})`;
      const curBuy = num(prod["Harga Jual Satuan Besar"]);
      const initBuy = curBuy > 0 ? curBuy : (curBase ? curBase * priceModalState.conversion : Math.round(buyPrice * 1.2));
      $("input-edit-price-buy").value = initBuy > 0 ? formatNumber(initBuy) : "";
      if ($("hint-price-buy")) $("hint-price-buy").textContent = `Modal faktur fisik: ${rupiah(buyPrice)}`;
    }
  }

  updatePriceModalUIByMode();

  modal.hidden = false;
  setTimeout(() => $("input-edit-sell-price")?.focus(), 60);
}

function closeEditPriceModal() {
  const modal = $("modal-edit-price");
  if (modal) modal.hidden = true;
  activeEditingProduct = null;
}

async function handleSavePriceModal() {
  if (!activeEditingProduct) return;

  const getNumVal = (id) => {
    const el = $(id);
    if (!el) return 0;
    return parseInt(el.value.replace(/[^0-9]/g, ""), 10) || 0;
  };

  const mode = priceModalState.mode;
  let priceBase = getNumVal("input-edit-sell-price");
  let priceMid = getNumVal("input-edit-price-mid");
  let priceBuy = getNumVal("input-edit-price-buy");

  const conv = Math.max(1, priceModalState.conversion || 1);
  const midQty = Math.max(1, priceModalState.midQty || 1);

  let allowedUnits = ["base"];

  if (mode === "1") {
    // Mode 1: Cukup input satuan yang dipilih
    const selected = priceModalState.singleSelected || "base";
    allowedUnits = [selected];

    if (selected === "base") {
      if (priceBase <= 0) {
        window.KasirProDialog?.warning("Perhatian", "Silakan isi Harga Jual Satuan Terkecil / Ecer.");
        return;
      }
      if (!priceMid) priceMid = Math.round(priceBase * midQty);
      if (!priceBuy) priceBuy = Math.round(priceBase * conv);
    } else if (selected === "mid") {
      if (priceMid <= 0) {
        window.KasirProDialog?.warning("Perhatian", "Silakan isi Harga Jual Satuan Sedang.");
        return;
      }
      priceBase = Math.round(priceMid / midQty);
      if (!priceBuy) priceBuy = Math.round(priceBase * conv);
    } else if (selected === "buy") {
      if (priceBuy <= 0) {
        window.KasirProDialog?.warning("Perhatian", "Silakan isi Harga Jual Satuan Besar.");
        return;
      }
      priceBase = Math.round(priceBuy / conv);
      if (!priceMid) priceMid = Math.round(priceBase * midQty);
    }
  } else if (mode === "2") {
    // Mode 2: Wajib isi 2 satuan yang dipilih
    const dual = priceModalState.dualSelected || [];
    if (dual.length < 2) {
      window.KasirProDialog?.warning("Pilih 2 Satuan", "Silakan centang tepat 2 satuan konversi yang boleh dijual.");
      return;
    }
    allowedUnits = dual;

    for (const u of dual) {
      if (u === "base" && priceBase <= 0) {
        window.KasirProDialog?.warning("Perhatian", "Harga jual satuan terkecil wajib diisi.");
        return;
      }
      if (u === "mid" && priceMid <= 0) {
        window.KasirProDialog?.warning("Perhatian", "Harga jual satuan sedang wajib diisi.");
        return;
      }
      if (u === "buy" && priceBuy <= 0) {
        window.KasirProDialog?.warning("Perhatian", "Harga jual satuan besar wajib diisi.");
        return;
      }
    }

    // 1 satuan sisanya dihitung otomatis
    if (!dual.includes("base")) priceBase = priceMid ? Math.round(priceMid / midQty) : Math.round(priceBuy / conv);
    if (!dual.includes("mid")) priceMid = Math.round(priceBase * midQty);
    if (!dual.includes("buy")) priceBuy = Math.round(priceBase * conv);
  } else {
    // Mode 3: Wajib isi ketiga satuan konversi
    allowedUnits = ["base"];
    if (priceModalState.midUnit) allowedUnits.push("mid");
    if (priceModalState.buyUnit) allowedUnits.push("buy");

    if (priceBase <= 0) {
      window.KasirProDialog?.warning("Perhatian", "Harga jual satuan terkecil wajib diisi.");
      return;
    }
    if (priceModalState.midUnit && priceMid <= 0) {
      window.KasirProDialog?.warning("Perhatian", "Harga jual satuan sedang wajib diisi pada opsi 3 satuan.");
      return;
    }
    if (priceModalState.buyUnit && priceBuy <= 0) {
      window.KasirProDialog?.warning("Perhatian", "Harga jual satuan besar wajib diisi pada opsi 3 satuan.");
      return;
    }
  }

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

  const saveBtn = $("save-edit-price");
  if (saveBtn) saveBtn.disabled = true;

  try {
    await writeMasterDelta({ produk: [target] });
    closeEditPriceModal();
    renderProducts();
    window.KasirProDialog?.success(
      "Harga Jual Bertingkat Disimpan",
      `Harga jual ${target["Nama Produk"]} berhasil diperbarui (${allowedUnits.length} satuan aktif). Status produk kini Aktif.`
    );
  } catch (err) {
    window.KasirProDialog?.error("Gagal Menyimpan", err.message);
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * Generate kode produk otomatis format [Nama Supplier-PRD-xxx]
 */
function generateAutoProductCode(supplierName) {
  const supClean = String(supplierName || "UMUM")
    .trim()
    .replace(/[\/\\]/g, "_")
    .toUpperCase();

  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? master.produk : [];

  // Hitung jumlah produk yang sudah ada untuk supplier ini
  const prefix = `${supClean}-PRD-`;
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
      <section class="kp-dialog-v4__card" style="width:min(94vw,560px);max-height:90vh;overflow-y:auto;" role="dialog">
        <header style="padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
          <h2 style="font-size:16px;font-weight:800;margin:0;color:#0f2a43;">
            <i class="fa-solid fa-box-open" style="color:#0284c7;margin-right:6px;"></i> Tambah Produk Baru
          </h2>
          <button type="button" id="close-modal-product" class="button button-small button-secondary" style="padding:4px 8px;"><i class="fa-solid fa-xmark"></i></button>
        </header>

        <form id="product-form-inner" style="padding:20px;display:grid;gap:14px;text-align:left;">
          <!-- Supplier (Pemicu Kode Otomatis) -->
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <label style="font-size:13px;font-weight:700;color:#1e293b;">
                Supplier / Distributor <span class="text-danger">*</span>
              </label>
              <button type="button" id="btn-quick-add-supplier" class="button button-small button-secondary" style="font-size:11px;padding:2px 8px;">
                <i class="fa-solid fa-plus"></i> Supplier Baru
              </button>
            </div>
            <select id="input-prod-supplier" required style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;background:#fff;">
              <option value="">-- Pilih Supplier --</option>
            </select>
          </div>

          <!-- Kode Produk (Otomatis & Editable) -->
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
              <label style="font-size:13px;font-weight:700;color:#1e293b;">
                Kode Produk Internal <span class="text-danger">*</span>
              </label>
              <span style="font-size:11px;color:#0284c7;font-weight:600;">Otomatis: [Supplier-PRD-xxx]</span>
            </div>
            <input type="text" id="input-prod-code" required style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;font-weight:700;color:#0f2a43;background:#f8fafc;" placeholder="Pilih supplier terlebih dahulu">
          </div>

          <!-- Nama Produk & Barcode -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div style="grid-column: span 2;">
              <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">
                Nama Produk <span class="text-danger">*</span>
              </label>
              <input type="text" id="input-prod-name" required style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;" placeholder="Contoh: Paracetamol 500 mg Box 100 Tab">
            </div>
            <div>
              <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">
                Barcode Fisik
              </label>
              <input type="text" id="input-prod-barcode" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;" placeholder="Nomor EAN / UPC">
            </div>
            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                <label style="font-size:13px;font-weight:700;color:#1e293b;">
                  Kategori <span class="text-danger">*</span>
                </label>
                <button type="button" id="btn-quick-add-category" class="button button-small button-secondary" style="font-size:11px;padding:2px 8px;">
                  <i class="fa-solid fa-plus"></i> Kategori Baru
                </button>
              </div>
              <select id="input-prod-category" required style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;background:#fff;">
                <option value="">-- Pilih Kategori --</option>
              </select>
            </div>
          </div>

          <!-- Satuan & Konversi 3 Tingkat -->
          <div style="padding:12px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;margin-bottom:12px;">
            <div style="font-size:12px;font-weight:700;color:#0369a1;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
              <i class="fa-solid fa-boxes-stacked"></i> Konversi Kemasan (3 Tingkat Wadah)
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
              <div>
                <label style="display:block;font-size:12px;font-weight:700;color:#475569;margin-bottom:4px;">1. Satuan Besar (Beli)</label>
                <input type="text" id="input-prod-buy-unit" style="width:100%;min-height:36px;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;" placeholder="Box / Dus / Pak" value="Box">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:700;color:#475569;margin-bottom:4px;">2. Satuan Sedang (Opsional)</label>
                <input type="text" id="input-prod-mid-unit" style="width:100%;min-height:36px;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;" placeholder="Strip / Blister">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:700;color:#475569;margin-bottom:4px;">3. Satuan Terkecil (Ecer) <span class="text-danger">*</span></label>
                <input type="text" id="input-prod-base-unit" required style="width:100%;min-height:36px;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;" placeholder="Tablet / Kaplet / Botol / Pcs" value="Pcs">
              </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px;">
              <div>
                <label style="display:block;font-size:11px;color:#64748b;margin-bottom:2px;">Isi per Satuan Sedang (misal: 1 Strip = N Terkecil)</label>
                <input type="number" id="input-prod-mid-qty" min="1" step="1" style="width:100%;min-height:32px;padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;" value="1">
              </div>
              <div>
                <label style="display:block;font-size:11px;color:#64748b;margin-bottom:2px;">Total Isi per Satuan Besar (Total Terkecil dlm 1 Box) <span class="text-danger">*</span></label>
                <input type="number" id="input-prod-conversion" min="1" step="1" style="width:100%;min-height:32px;padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;font-weight:700;color:#0284c7;" value="1">
              </div>
            </div>
          </div>

          <!-- Harga Beli, Margin, Harga Jual & Stok Min -->
          <div style="display:grid;grid-template-columns:1fr 90px 1fr 85px;gap:10px;">
            <div>
              <label style="display:block;font-size:12px;font-weight:700;color:#1e293b;margin-bottom:4px;">Harga Beli (Rp)</label>
              <input type="number" id="input-prod-buy-price" min="0" step="100" style="width:100%;min-height:38px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13.5px;" placeholder="0">
            </div>
            <div>
              <label style="display:block;font-size:12px;font-weight:700;color:#1e293b;margin-bottom:4px;">Margin (%)</label>
              <input type="number" id="input-prod-margin" min="0" max="1000" step="1" style="width:100%;min-height:38px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13.5px;" placeholder="20">
            </div>
            <div>
              <label style="display:block;font-size:12px;font-weight:700;color:#1e293b;margin-bottom:4px;">Harga Jual (Rp) <span class="text-danger">*</span></label>
              <input type="number" id="input-prod-sell-price" min="0" step="100" style="width:100%;min-height:38px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13.5px;font-weight:700;color:#0369a1;" placeholder="0">
            </div>
            <div>
              <label style="display:block;font-size:12px;font-weight:700;color:#1e293b;margin-bottom:4px;">Stok Min</label>
              <input type="number" id="input-prod-min-stock" min="0" step="1" style="width:100%;min-height:38px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13.5px;" value="10">
            </div>
          </div>
        </form>

        <footer style="padding:12px 20px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:8px;">
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

  // Kalkulator Margin otomatis
  const calcFromMargin = () => {
    const buy = num($("input-prod-buy-price")?.value);
    const margin = num($("input-prod-margin")?.value);
    if (buy > 0 && margin > 0) {
      const sell = Math.round(buy * (1 + margin / 100));
      const sellInput = $("input-prod-sell-price");
      if (sellInput) sellInput.value = sell;
    }
  };
  $("input-prod-buy-price")?.addEventListener("input", calcFromMargin);
  $("input-prod-margin")?.addEventListener("input", calcFromMargin);

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

let activeProductSavedCallback = null;

export function openProductModal(prefill = {}, callback = null) {
  activeProductSavedCallback = typeof callback === "function" ? callback : null;
  const modal = $("modal-product-form");
  if (!modal) return;

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
  $("input-prod-code").value = prefill.code || (targetSupplier ? generateAutoProductCode(targetSupplier) : "");
  $("input-prod-name").value = prefill.name || "";
  $("input-prod-barcode").value = prefill.barcode || "";
  $("input-prod-buy-unit").value = prefill.buyUnit || "Box";
  const midInput = $("input-prod-mid-unit");
  if (midInput) midInput.value = prefill.midUnit || "";
  const midQtyInput = $("input-prod-mid-qty");
  if (midQtyInput) midQtyInput.value = prefill.midQty || 1;
  $("input-prod-conversion").value = prefill.conversion || 1;
  $("input-prod-base-unit").value = prefill.baseUnit || "Pcs";
  $("input-prod-buy-price").value = prefill.buyPrice !== undefined && prefill.buyPrice !== null ? prefill.buyPrice : "";
  $("input-prod-sell-price").value = prefill.sellPrice !== undefined && prefill.sellPrice !== null ? prefill.sellPrice : "";
  $("input-prod-min-stock").value = prefill.minStock || "10";

  modal.hidden = false;
  setTimeout(() => {
    if (!prefill.name) $("input-prod-name")?.focus();
    else $("input-prod-conversion")?.focus();
  }, 60);
}

if (typeof window !== "undefined") {
  window.openProductModal = openProductModal;
}

export function closeProductModal() {
  const modal = $("modal-product-form");
  if (modal) modal.hidden = true;
  activeProductSavedCallback = null;
}

async function handleSaveProductModal() {
  const supplier = text($("input-prod-supplier")?.value);
  let code = text($("input-prod-code")?.value);
  const name = text($("input-prod-name")?.value);
  const barcode = text($("input-prod-barcode")?.value);
  const category = text($("input-prod-category")?.value);
  const buyUnit = text($("input-prod-buy-unit")?.value) || "Box";
  const midUnit = text($("input-prod-mid-unit")?.value) || "";
  const midQty = num($("input-prod-mid-qty")?.value) || 1;
  const conversion = num($("input-prod-conversion")?.value) || 1;
  const baseUnit = text($("input-prod-base-unit")?.value) || "Pcs";
  const buyPrice = num($("input-prod-buy-price")?.value);
  const sellPrice = num($("input-prod-sell-price")?.value);
  const minStock = num($("input-prod-min-stock")?.value);

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
    "Isi Satuan Antara": midQty || 1,
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
