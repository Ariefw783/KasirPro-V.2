/**
 * management/management-stock.js
 * Manajemen Persediaan Stok & Barang Masuk/Mutasi KasirPro V2
 * 
 * Sesuai Spesifikasi Tahap 4:
 * 1. Model stok HANYA Total Stok per Produk (NO stok per batch, NO FEFO).
 * 2. Status stok: Habis (0), Menipis (>0 dan <= min), Aman (>min).
 * 3. Detail stok hanya menampilkan histori Batch/EXP/Supplier/No Faktur sebagai histori info.
 * 4. Stock movement audit trail (Faktur Masuk, Penjualan, Stock Opname, Koreksi Faktur,
 *    Pembatalan Faktur, Retur/Koreksi Penjualan).
 */

import { $, num, text, norm, rupiah, formatNumber, formatDateTime, escapeHtml } from "../modules/core/utils.js";
import { STORE_KEYS, readStore, readCurrentStock } from "../modules/database/database-store.js";
import { generateStockReportPdf } from "../modules/core/pdf.js";

const PAGE_SIZE = 25;
let currentStockPage = 1;
let currentMovementsPage = 1;
let stockList = [];
let filteredStockList = [];
let movementList = [];
let filteredMovementList = [];

export function initStockModule() {
  bindEvents();
  renderStock();
  renderMovements();
}

function bindEvents() {
  $("refresh-stock")?.addEventListener("click", () => {
    renderStock();
    window.KasirProDialog?.success("Berhasil", "Data stok saat ini berhasil disegarkan.");
  });

  $("stock-search")?.addEventListener("input", () => {
    currentStockPage = 1;
    applyStockFilters();
  });

  $("stock-category-filter")?.addEventListener("change", () => {
    currentStockPage = 1;
    applyStockFilters();
  });

  $("stock-supplier-filter")?.addEventListener("change", () => {
    currentStockPage = 1;
    applyStockFilters();
  });

  $("stock-status-filter")?.addEventListener("change", () => {
    currentStockPage = 1;
    applyStockFilters();
  });

  $("stock-prev-page")?.addEventListener("click", () => {
    if (currentStockPage > 1) {
      currentStockPage--;
      renderStockTable();
    }
  });

  $("stock-next-page")?.addEventListener("click", () => {
    const totalPages = Math.ceil(filteredStockList.length / PAGE_SIZE) || 1;
    if (currentStockPage < totalPages) {
      currentStockPage++;
      renderStockTable();
    }
  });

  // Mutasi Stok (Barang Masuk)
  $("refresh-goods-in")?.addEventListener("click", () => {
    renderMovements();
    window.KasirProDialog?.success("Berhasil", "Riwayat mutasi stok berhasil dimuat ulang.");
  });

  $("movement-search")?.addEventListener("input", () => {
    currentMovementsPage = 1;
    applyMovementFilters();
  });

  $("movement-type-filter")?.addEventListener("change", () => {
    currentMovementsPage = 1;
    applyMovementFilters();
  });

  installStockHistoryModal();
}

export function renderStock() {
  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? master.produk : [];

  stockList = prods.map(p => {
    const code = p["Kode Produk"] || p["Kode Produk Internal"] || p.id;
    const currentStock = readCurrentStock(code);
    const minStock = num(p["Stok Minimum"]);
    const buyPrice = num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0);

    let status = "Aman";
    if (currentStock <= 0) status = "Habis";
    else if (minStock > 0 && currentStock <= minStock) status = "Menipis";

    return {
      code,
      name: p["Nama Produk"] || "—",
      category: p["Kategori"] || "—",
      supplier: p["Supplier"] || "—",
      stock: currentStock,
      minStock,
      buyPrice,
      totalValue: currentStock * buyPrice,
      unit: p["Satuan Dasar"] || p["Satuan"] || "Pcs",
      status
    };
  });

  // Populate categories & suppliers dropdown
  populateStockFilters(master);

  updateStockKpis();
  applyStockFilters();
}

function populateStockFilters(master) {
  const catFilter = $("stock-category-filter");
  if (catFilter) {
    const val = catFilter.value;
    const cats = Array.isArray(master.kategori) ? master.kategori : [];
    catFilter.innerHTML = '<option value="">Semua Kategori</option>';
    cats.forEach(c => {
      const name = c["Nama Kategori"] || c.name || "";
      if (name) catFilter.innerHTML += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
    });
    catFilter.value = val;
  }

  const supFilter = $("stock-supplier-filter");
  if (supFilter) {
    const val = supFilter.value;
    const sups = Array.isArray(master.supplier) ? master.supplier : [];
    supFilter.innerHTML = '<option value="">Semua Supplier</option>';
    sups.forEach(s => {
      const name = s["Nama Perusahaan"] || s["Supplier"] || s.name || "";
      if (name) supFilter.innerHTML += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
    });
    supFilter.value = val;
  }
}

function updateStockKpis() {
  const totalProducts = stockList.length;
  const totalUnits = stockList.reduce((sum, s) => sum + s.stock, 0);
  const alertCount = stockList.filter(s => s.status === "Habis" || s.status === "Menipis").length;

  const pEl = $("stock-product-count");
  if (pEl) pEl.textContent = formatNumber(totalProducts);

  const uEl = $("stock-unit-count");
  if (uEl) uEl.textContent = formatNumber(totalUnits);

  const aEl = $("stock-alert-count");
  if (aEl) aEl.textContent = formatNumber(alertCount);
}

function applyStockFilters() {
  const q = norm($("stock-search")?.value);
  const cat = norm($("stock-category-filter")?.value);
  const sup = norm($("stock-supplier-filter")?.value);
  const statusVal = norm($("stock-status-filter")?.value);

  filteredStockList = stockList.filter(s => {
    const code = norm(s.code);
    const name = norm(s.name);
    const sCat = norm(s.category);
    const sSup = norm(s.supplier);
    const status = norm(s.status);

    if (q && !code.includes(q) && !name.includes(q)) return false;
    if (cat && sCat !== cat) return false;
    if (sup && sSup !== sup) return false;

    if (statusVal) {
      if (statusVal === "safe" && status !== "aman") return false;
      if (statusVal === "low" && status !== "menipis") return false;
      if (statusVal === "empty" && status !== "habis") return false;
    }

    return true;
  });

  renderStockTable();
}

function renderStockTable() {
  const tbody = $("stock-table-body");
  if (!tbody) return;

  const total = filteredStockList.length;
  const start = (currentStockPage - 1) * PAGE_SIZE;
  const pageItems = filteredStockList.slice(start, start + PAGE_SIZE);

  if (!pageItems.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-table-state" style="text-align:center;padding:24px;">Tidak ada data stok produk yang ditemukan.</td></tr>`;
  } else {
    tbody.innerHTML = pageItems.map(item => {
      return `
        <tr>
          <td><strong>${escapeHtml(item.code)}</strong></td>
          <td><strong>${escapeHtml(item.name)}</strong></td>
          <td>${escapeHtml(item.category)}</td>
          <td><strong style="font-size:14px;color:#0f172a;">${formatNumber(item.stock)}</strong> ${escapeHtml(item.unit)}</td>
          <td>${formatNumber(item.minStock)}</td>
          <td>${rupiah(item.buyPrice)}</td>
          <td>${rupiah(item.totalValue)}</td>
          <td>${getStockStatusBadge(item.status)}</td>
          <td>
            <button type="button" class="btn-stock-history button button-small button-secondary" data-code="${escapeHtml(item.code)}" title="Lihat Histori Masuk/Batch">
              <i class="fa-solid fa-clock-rotate-left"></i> Histori
            </button>
          </td>
        </tr>
      `;
    }).join("");

    tbody.querySelectorAll(".btn-stock-history").forEach(btn => {
      btn.addEventListener("click", () => {
        const code = btn.dataset.code;
        openStockHistoryModal(code);
      });
    });
  }

  const pageInfoEl = $("stock-page-info");
  if (pageInfoEl) {
    pageInfoEl.textContent = `Menampilkan ${pageItems.length} dari ${total} produk (Halaman ${currentStockPage})`;
  }

  const prevBtn = $("stock-prev-page");
  if (prevBtn) prevBtn.disabled = currentStockPage <= 1;

  const nextBtn = $("stock-next-page");
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  if (nextBtn) nextBtn.disabled = currentStockPage >= totalPages;
}

function getStockStatusBadge(status) {
  const s = norm(status);
  if (s === "habis") {
    return `<span class="badge badge-danger" style="background:#fef2f2;color:#dc2626;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;">Habis</span>`;
  }
  if (s === "menipis") {
    return `<span class="badge badge-warning" style="background:#fff7ed;color:#ea580c;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;">Menipis</span>`;
  }
  return `<span class="badge badge-success" style="background:#ecfdf5;color:#059669;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;">Aman</span>`;
}

/**
 * 2. BARANG MASUK & MUTASI STOK
 */
export function renderMovements() {
  const movs = readStore(STORE_KEYS.movements, []);
  movementList = Array.isArray(movs) ? [...movs].reverse() : [];
  applyMovementFilters();
}

function applyMovementFilters() {
  const q = norm($("movement-search")?.value);
  const typeFilter = norm($("movement-type-filter")?.value);

  filteredMovementList = movementList.filter(m => {
    const code = norm(m.productCode);
    const name = norm(m.productName);
    const ref = norm(m.reference);
    const type = norm(m.type);

    if (q && !code.includes(q) && !name.includes(q) && !ref.includes(q)) return false;

    if (typeFilter) {
      if (typeFilter === "purchase" && !type.includes("faktur") && !type.includes("masuk")) return false;
      if (typeFilter === "sale" && !type.includes("penjualan") && !type.includes("sale")) return false;
      if (typeFilter === "opname" && !type.includes("opname")) return false;
      if (typeFilter === "reversal" && !type.includes("pembatalan") && !type.includes("retur")) return false;
    }

    return true;
  });

  renderMovementTable();
}

function renderMovementTable() {
  const tbody = $("movement-table-body");
  if (!tbody) return;

  if (!filteredMovementList.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-table-state" style="text-align:center;padding:24px;">Tidak ada riwayat mutasi stok.</td></tr>`;
    return;
  }

  tbody.innerHTML = filteredMovementList.slice(0, 100).map(m => {
    const isPositive = num(m.delta ?? m.quantity) > 0;
    const deltaStr = isPositive ? `+${formatNumber(m.delta ?? m.quantity)}` : `${formatNumber(m.delta ?? m.quantity)}`;

    return `
      <tr>
        <td>${formatDateTime(m.createdAt || m.date)}</td>
        <td><strong>${escapeHtml(m.type || 'Mutasi')}</strong></td>
        <td>${escapeHtml(m.reference || '—')}</td>
        <td>${escapeHtml(m.productCode || '—')}</td>
        <td><strong>${escapeHtml(m.productName || '—')}</strong></td>
        <td style="color:${isPositive ? '#059669' : '#dc2626'};font-weight:700;">${deltaStr}</td>
        <td>${m.stockAfter !== undefined ? formatNumber(m.stockAfter) : '—'}</td>
        <td><small class="text-muted">User: ${escapeHtml(m.user || '—')}${m.batch ? ` | Batch: ${escapeHtml(m.batch)}` : ''}</small></td>
      </tr>
    `;
  }).join("");
}

/**
 * 3. MODAL HISTORI BATCH & EXP (INFORMASI HISTORIS FAKTUR)
 */
function installStockHistoryModal() {
  if ($("modal-stock-history")) return;

  const modalHtml = `
    <div id="modal-stock-history" class="kp-dialog-v4" hidden>
      <div class="kp-dialog-v4__backdrop"></div>
      <section class="kp-dialog-v4__card" style="width:min(94vw,680px);max-height:90vh;overflow-y:auto;" role="dialog">
        <header style="padding:18px 20px 12px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
          <div>
            <h2 id="stock-hist-title" style="font-size:16px;font-weight:800;margin:0;">Histori Masuk & Batch</h2>
            <span id="stock-hist-sub" style="font-size:12px;color:#64748b;">Informasi historis dari faktur pembelian (bukan bucket stok)</span>
          </div>
          <button type="button" id="close-modal-stock-hist" class="button button-small button-secondary" style="padding:4px 8px;"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <div id="stock-hist-body" style="padding:20px;text-align:left;">
          <!-- Konten tabel mutasi dan batch -->
        </div>
        <footer style="padding:12px 20px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;">
          <button type="button" id="btn-close-stock-hist" class="button button-secondary">Tutup</button>
        </footer>
      </section>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  $("close-modal-stock-hist")?.addEventListener("click", () => $("modal-stock-history").hidden = true);
  $("btn-close-stock-hist")?.addEventListener("click", () => $("modal-stock-history").hidden = true);
}

function openStockHistoryModal(productCode) {
  const modal = $("modal-stock-history");
  if (!modal) return;

  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? master.produk : [];
  const prod = prods.find(p => norm(p["Kode Produk"]) === norm(productCode));
  const movs = readStore(STORE_KEYS.movements, []);
  const invoices = readStore(STORE_KEYS.invoices, []);

  $("stock-hist-title").textContent = prod ? prod["Nama Produk"] : productCode;

  // Filter faktur dan mutasi produk ini
  const prodMovs = (movs || []).filter(m => norm(m.productCode) === norm(productCode)).reverse();

  const bodyEl = $("stock-hist-body");
  if (!prodMovs.length) {
    bodyEl.innerHTML = `<p style="text-align:center;padding:20px;color:#64748b;">Belum ada riwayat faktur masuk atau mutasi untuk produk ini.</p>`;
  } else {
    bodyEl.innerHTML = `
      <div class="table-wrapper" style="max-height:300px;overflow-y:auto;">
        <table class="data-table">
          <thead>
            <tr>
              <th>Waktu</th>
              <th>Jenis</th>
              <th>Referensi</th>
              <th>Qty Masuk/Keluar</th>
              <th>Batch</th>
              <th>Exp Date</th>
            </tr>
          </thead>
          <tbody>
            ${prodMovs.map(m => `
              <tr>
                <td>${formatDateTime(m.createdAt || m.date)}</td>
                <td><strong>${escapeHtml(m.type || '—')}</strong></td>
                <td>${escapeHtml(m.reference || '—')}</td>
                <td style="color:${num(m.delta) >= 0 ? '#059669' : '#dc2626'};font-weight:700;">
                  ${num(m.delta) >= 0 ? `+${m.delta}` : m.delta}
                </td>
                <td>${escapeHtml(m.batch || '—')}</td>
                <td>${escapeHtml(m.expiryDate || '—')}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      <p style="margin-top:12px;font-size:11.5px;color:#64748b;"><i class="fa-solid fa-circle-info"></i> Batch dan EXP merupakan catatan historis pengiriman faktur dan tidak membagi stok menjadi bucket atau FEFO.</p>
    `;
  }

  modal.hidden = false;
}
