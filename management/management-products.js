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

  // Pastikan status filter punya opsi lengkap dan rapi (tanpa duplikasi filter harga jual)
  const statusFilter = $("product-status-filter");
  if (statusFilter && !statusFilter.querySelector('option[value="perlu harga jual"]')) {
    statusFilter.innerHTML = `
      <option value="">Semua Status</option>
      <option value="aktif">Aktif</option>
      <option value="perlu harga jual">Perlu Harga Jual</option>
      <option value="belum aktif">Belum Aktif</option>
      <option value="nonaktif">Nonaktif</option>
    `;
  }
}

function updateSummaryKpis() {
  const total = currentProducts.length;
  let totalStock = 0;
  let lowStockCount = 0;

  currentProducts.forEach(p => {
    const stock = readCurrentStock(p["Kode Produk"] || p.id);
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
    const pStatus = norm(p["Status"] || p["Status Produk"]);
    const sellPrice = num(p["Harga Jual"]);

    // Pencarian text
    if (q && !code.includes(q) && !barcode.includes(q) && !name.includes(q)) {
      return false;
    }
    // Filter kategori
    if (cat && pCat !== cat) return false;
    // Filter supplier
    if (sup && pSup !== sup) return false;

    const stock = readCurrentStock(code);
    const isAutoActive = stock > 0;

    // Filter status khusus
    if (statusVal === "aktif") {
      return isAutoActive;
    }
    if (statusVal === "belum aktif") {
      return !isAutoActive;
    }
    if (statusVal === "perlu harga jual") {
      return sellPrice <= 0 || pStatus === "perlu harga jual";
    }
    if (statusVal === "nonaktif") {
      return pStatus === "nonaktif";
    }
    if (statusVal && pStatus !== statusVal) {
      return false;
    }

    return true;
  });

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
      const sellPrice = num(p["Harga Jual"] ?? 0);
      const stock = readCurrentStock(code);
      const unit = p["Satuan Dasar"] || p["Satuan"] || "Pcs";
      const buyUnit = p["Satuan Pembelian"] || unit;
      const conv = num(p["Konversi"]) || 1;
      const unitLabel = norm(buyUnit) !== norm(unit) && conv > 1
        ? `<strong>${escapeHtml(buyUnit)}</strong> <small class="text-muted">(1 ${escapeHtml(buyUnit)} = ${formatNumber(conv)} ${escapeHtml(unit)})</small>`
        : `<strong>${escapeHtml(unit)}</strong>`;
      const minStock = num(p["Stok Minimum"]);
      // Status Otomatis Berdasarkan Stok (Input Faktur / Stock Opname):
      // "Aktif" jika sudah memiliki stok fisik > 0, "Belum Aktif" jika belum memiliki stok (stok <= 0)
      const autoStatus = stock > 0 ? "Aktif" : "Belum Aktif";
      const statusBadge = getStatusBadge(autoStatus, sellPrice, stock);

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

function getStatusBadge(status, sellPrice, stock = 0) {
  if (stock > 0) {
    if (sellPrice <= 0) {
      return `<span class="badge badge-warning" style="background:#fff7ed;color:#ea580c;border:1px solid #ffedd5;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;" title="Produk memiliki stok fisik tetapi belum diatur harga jualnya"><i class="fa-solid fa-triangle-exclamation"></i> Aktif (Perlu Harga)</span>`;
    }
    return `<span class="badge badge-success" style="background:#ecfdf5;color:#059669;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;"><i class="fa-solid fa-circle-check"></i> Aktif</span>`;
  }
  return `<span class="badge badge-info" style="background:#eff6ff;color:#2563eb;border:1px solid #dbeafe;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;" title="Belum memiliki stok fisik dari faktur atau stock opname"><i class="fa-solid fa-clock"></i> Belum Aktif</span>`;
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
 * MODAL EDIT HARGA JUAL LANGSUNG
 */
function installEditPriceModal() {
  if ($("modal-edit-price")) return;

  const modalHtml = `
    <div id="modal-edit-price" class="kp-dialog-v4" hidden>
      <div class="kp-dialog-v4__backdrop"></div>
      <section class="kp-dialog-v4__card" style="width:min(94vw,480px);" role="dialog">
        <header style="padding:18px 20px 12px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
          <h2 style="font-size:16px;font-weight:800;margin:0;">Atur Harga Jual Bertingkat</h2>
          <button type="button" id="close-modal-price" class="button button-small button-secondary" style="padding:4px 8px;"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <div style="padding:20px;text-align:left;display:grid;gap:12px;">
          <div>
            <span style="font-size:12px;color:#64748b;">Nama Produk:</span>
            <strong id="price-modal-name" style="display:block;font-size:14px;color:#0f172a;margin-top:2px;">—</strong>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div>
              <span style="font-size:12px;color:#64748b;">Kode Produk:</span>
              <strong id="price-modal-code" style="display:block;font-size:13px;color:#334155;margin-top:2px;">—</strong>
            </div>
            <div>
              <span style="font-size:12px;color:#64748b;">Harga Beli Terakhir:</span>
              <strong id="price-modal-buy" style="display:block;font-size:13px;color:#334155;margin-top:2px;">Rp0</strong>
            </div>
          </div>

          <div>
            <label id="label-edit-sell-price" style="display:block;font-size:12.5px;font-weight:700;color:#1e293b;margin-bottom:4px;">
              Harga Jual Satuan Terkecil / Ecer <span class="text-danger">*</span>
            </label>
            <input type="number" id="input-edit-sell-price" min="0" step="100" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14.5px;font-weight:700;color:#0f172a;" placeholder="Contoh: 1000">
          </div>

          <div id="box-edit-price-mid" hidden>
            <label id="label-edit-price-mid" style="display:block;font-size:12.5px;font-weight:700;color:#0369a1;margin-bottom:4px;">
              Harga Jual Satuan Sedang (Strip / Blister)
            </label>
            <input type="number" id="input-edit-price-mid" min="0" step="100" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;font-weight:700;color:#0369a1;" placeholder="0">
          </div>

          <div id="box-edit-price-buy" hidden>
            <label id="label-edit-price-buy" style="display:block;font-size:12.5px;font-weight:700;color:#047857;margin-bottom:4px;">
              Harga Jual Satuan Besar (Box / Dus)
            </label>
            <input type="number" id="input-edit-price-buy" min="0" step="100" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;font-weight:700;color:#047857;" placeholder="0">
          </div>

          <small style="display:block;margin-top:4px;color:#64748b;font-size:11.5px;line-height:1.4;">
            * Harga satuan yang tidak diisi khusus akan otomatis dihitung berdasarkan rasio isi kemasan. Status produk akan otomatis menjadi <strong>Aktif</strong>.
          </small>
        </div>
        <footer style="padding:12px 20px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:8px;">
          <button type="button" id="cancel-edit-price" class="button button-secondary">Batal</button>
          <button type="button" id="save-edit-price" class="button button-primary"><i class="fa-solid fa-floppy-disk"></i> Simpan Harga</button>
        </footer>
      </section>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  $("close-modal-price")?.addEventListener("click", closeEditPriceModal);
  $("cancel-edit-price")?.addEventListener("click", closeEditPriceModal);
  $("save-edit-price")?.addEventListener("click", handleSavePriceModal);
}

function openEditPriceModal(prod) {
  activeEditingProduct = prod;
  const modal = $("modal-edit-price");
  if (!modal) return;

  $("price-modal-name").textContent = prod["Nama Produk"] || "—";
  $("price-modal-code").textContent = prod["Kode Produk"] || prod["Kode Produk Internal"] || "—";
  $("price-modal-buy").textContent = rupiah(prod["Harga Beli Terakhir"] ?? prod["Harga Beli"] ?? 0);

  const baseUnit = String(prod["Satuan Dasar"] || prod["Satuan"] || "Pcs").trim();
  const midUnit = String(prod["Satuan Antara"] || "").trim();
  const midQty = num(prod["Isi Satuan Antara"] || 1);
  const buyUnit = String(prod["Kemasan Beli"] || prod["Satuan Pembelian"] || "").trim();
  const conversion = num(prod["Konversi"] ?? prod["Isi Kemasan"] ?? 1);

  // Label Satuan Terkecil
  $("label-edit-sell-price").innerHTML = `Harga Jual Satuan Terkecil / Ecer (<strong>${escapeHtml(baseUnit)}</strong>) <span class="text-danger">*</span>`;
  $("input-edit-sell-price").value = num(prod["Harga Jual"]) || "";

  // Satuan Sedang (hanya tampil jika ada dan > 1)
  const midBox = $("box-edit-price-mid");
  const hasMid = midUnit && norm(midUnit) !== norm(baseUnit) && midQty > 1;
  if (midBox) {
    midBox.hidden = !hasMid;
    if (hasMid) {
      $("label-edit-price-mid").innerHTML = `Harga Jual Satuan Sedang (<strong>${escapeHtml(midUnit)}</strong> - isi ${midQty} ${escapeHtml(baseUnit)})`;
      const currentMid = num(prod["Harga Jual Satuan Sedang"]);
      $("input-edit-price-mid").value = currentMid > 0 ? currentMid : (num(prod["Harga Jual"]) ? num(prod["Harga Jual"]) * midQty : "");
    }
  }

  // Satuan Besar (hanya tampil jika ada dan > 1)
  const buyBox = $("box-edit-price-buy");
  const hasBuy = buyUnit && norm(buyUnit) !== norm(baseUnit) && conversion > 1;
  if (buyBox) {
    buyBox.hidden = !hasBuy;
    if (hasBuy) {
      $("label-edit-price-buy").innerHTML = `Harga Jual Satuan Besar (<strong>${escapeHtml(buyUnit)}</strong> - isi ${conversion} ${escapeHtml(baseUnit)})`;
      const currentBuy = num(prod["Harga Jual Satuan Besar"]);
      $("input-edit-price-buy").value = currentBuy > 0 ? currentBuy : (num(prod["Harga Jual"]) ? num(prod["Harga Jual"]) * conversion : "");
    }
  }

  modal.hidden = false;
  setTimeout(() => $("input-edit-sell-price")?.focus(), 50);
}

function closeEditPriceModal() {
  const modal = $("modal-edit-price");
  if (modal) modal.hidden = true;
  activeEditingProduct = null;
}

async function handleSavePriceModal() {
  if (!activeEditingProduct) return;
  const newPrice = num($("input-edit-sell-price")?.value);

  if (newPrice <= 0) {
    window.KasirProDialog?.warning("Perhatian", "Harga jual satuan terkecil harus lebih besar dari Rp0 agar produk dapat aktif dan dijual.");
    return;
  }

  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? master.produk : [];
  const target = prods.find(p => norm(p["Kode Produk"]) === norm(activeEditingProduct["Kode Produk"]));
  if (!target) return;

  target["Harga Jual"] = newPrice;

  // Simpan Harga Satuan Sedang
  const midQty = num(target["Isi Satuan Antara"] || 1);
  const inputMid = num($("input-edit-price-mid")?.value);
  target["Harga Jual Satuan Sedang"] = inputMid > 0 ? inputMid : (newPrice * midQty);

  // Simpan Harga Satuan Besar
  const conversion = num(target["Konversi"] ?? target["Isi Kemasan"] ?? 1);
  const inputBuy = num($("input-edit-price-buy")?.value);
  target["Harga Jual Satuan Besar"] = inputBuy > 0 ? inputBuy : (newPrice * conversion);

  target["Status"] = "Aktif";
  target["Status Produk"] = "Aktif";

  const saveBtn = $("save-edit-price");
  if (saveBtn) saveBtn.disabled = true;

  try {
    // Hanya 1 record yang ditulis ke Firestore (hemat kuota)
    await writeMasterDelta({ produk: [target] });
    closeEditPriceModal();
    renderProducts();
    window.KasirProDialog?.success(
      "Harga Jual Tersimpan",
      `Harga jual ${target["Nama Produk"]} berhasil diperbarui. Status produk kini Aktif.`
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
