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
import { STORE_KEYS, readStore, readCurrentStock, normalizeNegativeStocks } from "../modules/database/database-store.js";
import { generateStockReportPdf, generateStockCardPdf } from "../modules/core/pdf.js";

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

  $("fix-minus-stock-btn")?.addEventListener("click", handleFixNegativeStock);

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
    const conv = num(p["Konversi"] ?? p["Isi Kemasan"] ?? 1) || 1;
    const unitBuyPrice = buyPrice / conv;

    let status = "Aman";
    if (currentStock < 0) status = "Minus";
    else if (currentStock === 0) status = "Habis";
    else if (minStock > 0 && currentStock <= minStock) status = "Menipis";

    return {
      code,
      name: p["Nama Produk"] || "—",
      category: p["Kategori"] || "—",
      supplier: p["Supplier"] || "—",
      stock: currentStock,
      minStock,
      buyPrice,
      conv,
      unitBuyPrice,
      buyUnit: p["Kemasan Beli"] || p["Satuan Pembelian"] || "",
      totalValue: Math.max(0, currentStock) * unitBuyPrice,
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
  // Hitung total unit fisik riil (floor 0 agar total stok tidak minus)
  const totalUnits = stockList.reduce((sum, s) => sum + Math.max(0, s.stock), 0);
  const alertCount = stockList.filter(s => s.status === "Habis" || s.status === "Menipis" || s.status === "Minus").length;
  const minusCount = stockList.filter(s => s.status === "Minus").length;

  const pEl = $("stock-product-count");
  if (pEl) pEl.textContent = formatNumber(totalProducts);

  const uEl = $("stock-unit-count");
  if (uEl) {
    if (minusCount > 0) {
      uEl.innerHTML = `${formatNumber(totalUnits)} <small style="color:#ef4444;font-size:12px;font-weight:700;">(${minusCount} minus)</small>`;
    } else {
      uEl.textContent = formatNumber(totalUnits);
    }
  }

  const aEl = $("stock-alert-count");
  if (aEl) aEl.textContent = formatNumber(alertCount);

  // Tampilkan/sembunyikan tombol Perbaiki Stok Minus jika terdeteksi data anomali
  const fixBtn = $("fix-minus-stock-btn");
  if (fixBtn) {
    fixBtn.style.display = minusCount > 0 ? "inline-flex" : "none";
  }
}

async function handleFixNegativeStock() {
  const minusProds = stockList.filter(s => s.stock < 0);
  if (!minusProds.length) {
    return window.KasirProDialog?.info("Semua Stok Normal", "Tidak ditemukan produk dengan saldo stok minus.");
  }
  const ok = await window.KasirProDialog?.confirm(
    "Perbaiki Stok Minus",
    `Ditemukan ${minusProds.length} produk bersaldo minus (misal akibat pembatalan faktur yang salah input).\n\nApakah Anda ingin menormalkan seluruh stok produk minus ini kembali ke 0 agar data stok dan nilai aset toko 100% akurat?`
  );
  if (!ok) return;

  try {
    const fixedCount = await normalizeNegativeStocks();
    window.KasirProDialog?.success("Stok Berhasil Dinormalkan", `${fixedCount} produk bersaldo minus telah berhasil dinormalkan kembali ke 0.`);
    renderStock();
  } catch (err) {
    window.KasirProDialog?.error("Gagal Normalisasi Stok", err.message);
  }
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
      if (statusVal === "minus" && status !== "minus") return false;
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
          <td>${rupiah(item.unitBuyPrice)}${item.conv > 1 ? `<small style="display:block;font-size:10.5px;color:#64748b;">(${rupiah(item.buyPrice)}/${escapeHtml(item.buyUnit || 'Box')})</small>` : ''}</td>
          <td><strong style="color:#0369a1;">${rupiah(item.totalValue)}</strong></td>
          <td>${getStockStatusBadge(item.status)}</td>
          <td>
            <button type="button" class="btn-stock-history button button-small button-secondary" data-code="${escapeHtml(item.code)}" title="Lihat Kartu Stok & Riwayat Mutasi">
              <i class="fa-solid fa-clipboard-list" style="color:#0284c7;"></i> Kartu Stok
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

  // Render Kartu Adaptif Vertikal (Accordion Data Cards)
  const cardList = $("stock-card-list");
  if (cardList) {
    if (!pageItems.length) {
      cardList.innerHTML = `<div style="text-align:center;padding:28px 16px;color:#94a3b8;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;"><i class="fa-solid fa-boxes-stacked" style="font-size:24px;margin-bottom:8px;display:block;"></i>Tidak ada data stok produk yang ditemukan.</div>`;
    } else {
      cardList.innerHTML = pageItems.map(item => {
        const s = norm(item.status);
        let accentClass = "card-success";
        if (s === "minus") accentClass = "card-danger";
        else if (s === "habis") accentClass = "card-danger";
        else if (s === "menipis") accentClass = "card-warning";

        return `
          <div class="responsive-data-card ${accentClass}">
            <div class="card-accordion-header" role="button" tabindex="0">
              <div class="card-header-main">
                <div class="card-title-row">
                  <span class="card-title">${escapeHtml(item.name)}</span>
                  ${getStockStatusBadge(item.status)}
                </div>
                <div class="card-meta-row">
                  <span class="card-meta-code">${escapeHtml(item.code)}</span>
                  <span class="card-meta-dot">•</span>
                  <span class="card-meta-sub">${escapeHtml(item.category || 'Umum')}</span>
                </div>
                <div class="card-kpi-strip">
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Stok Fisik</span>
                    <span class="kpi-strip-val ${item.stock <= 0 ? 'stock-empty' : ''}">${formatNumber(item.stock)} <small>${escapeHtml(item.unit)}</small></span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Harga Beli</span>
                    <span class="kpi-strip-val val-buy">${rupiah(item.unitBuyPrice)}</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Nilai Aset</span>
                    <span class="kpi-strip-val" style="color:#0284c7;">${rupiah(item.totalValue)}</span>
                  </div>
                </div>
              </div>
              <div class="card-toggle-icon"><i class="fa-solid fa-chevron-down"></i></div>
            </div>
            <div class="card-accordion-body">
              <div class="card-detail-grid">
                <div class="card-detail-item">
                  <span class="card-detail-label">Stok Fisik</span>
                  <span class="card-detail-value"><strong style="color:#0f172a;font-size:15px;">${formatNumber(item.stock)}</strong> ${escapeHtml(item.unit)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Stok Minimum</span>
                  <span class="card-detail-value">${formatNumber(item.minStock)} ${escapeHtml(item.unit)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Harga Beli Dasar</span>
                  <span class="card-detail-value">${rupiah(item.unitBuyPrice)}${item.conv > 1 ? ` <small class="text-muted">(${rupiah(item.buyPrice)}/${escapeHtml(item.buyUnit || 'Box')})</small>` : ''}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Total Nilai Stok</span>
                  <span class="card-detail-value"><strong style="color:#0284c7;">${rupiah(item.totalValue)}</strong></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Supplier Terkait</span>
                  <span class="card-detail-value">${escapeHtml(item.supplier || '—')}</span>
                </div>
              </div>
              <div class="card-action-bar">
                <button type="button" class="btn-stock-history button button-small button-secondary" data-code="${escapeHtml(item.code)}" title="Lihat Kartu Stok & Riwayat Mutasi">
                  <i class="fa-solid fa-clipboard-list" style="color:#0284c7;"></i> Kartu Stok
                </button>
              </div>
            </div>
          </div>
        `;
      }).join("");

      // Accordion toggle listener
      cardList.querySelectorAll(".card-accordion-header").forEach(header => {
        header.addEventListener("click", () => {
          const card = header.closest(".responsive-data-card");
          if (card) card.classList.toggle("is-expanded");
        });
      });

      cardList.querySelectorAll(".btn-stock-history").forEach(btn => {
        btn.addEventListener("click", () => {
          const code = btn.dataset.code;
          openStockHistoryModal(code);
        });
      });
    }
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
  if (s === "minus") {
    return `<span class="badge badge-danger" style="background:#fee2e2;color:#991b1b;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;border:1px solid #f87171;">⚠️ Minus</span>`;
  }
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
        <td style="white-space:nowrap;font-weight:600;">${formatDateTime(m.createdAt || m.date || m.at)}</td>
        <td><strong>${escapeHtml(m.type || 'Mutasi')}</strong></td>
        <td><strong style="color:#0284c7;">${escapeHtml(m.reference || '—')}</strong></td>
        <td><code>${escapeHtml(m.productCode || '—')}</code></td>
        <td><strong>${escapeHtml(m.productName || '—')}</strong></td>
        <td style="color:${isPositive ? '#059669' : '#dc2626'};font-weight:700;text-align:right;">${deltaStr}</td>
        <td style="text-align:right;font-weight:700;">${m.stockAfter !== undefined ? formatNumber(m.stockAfter) : '—'}</td>
        <td>
          <span style="font-weight:600;color:#334155;">${escapeHtml(m.source || 'Sistem')}</span>
          <small class="text-muted" style="display:block;">User: ${escapeHtml(m.user || '—')}${m.batch ? ` | Batch: ${escapeHtml(m.batch)}` : ''}${m.note || m.notes ? ` | ${escapeHtml(m.note || m.notes)}` : ''}</small>
        </td>
      </tr>
    `;
  }).join("");

  // Render juga ke card list adaptif
  const cardLists = [ $("movement-card-list"), $("goods-in-card-list") ].filter(Boolean);
  cardLists.forEach(cardList => {
    if (!filteredMovementList.length) {
      cardList.innerHTML = `<div style="text-align:center;padding:28px 16px;color:#94a3b8;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;"><i class="fa-solid fa-clock-rotate-left" style="font-size:24px;margin-bottom:8px;display:block;"></i>Tidak ada riwayat mutasi stok.</div>`;
    } else {
      cardList.innerHTML = filteredMovementList.slice(0, 100).map(m => {
        const isPositive = num(m.delta ?? m.quantity) > 0;
        const deltaStr = isPositive ? `+${formatNumber(m.delta ?? m.quantity)}` : `${formatNumber(m.delta ?? m.quantity)}`;
        const accentClass = isPositive ? "card-success" : "card-danger";

        return `
          <div class="responsive-data-card ${accentClass}">
            <div class="card-accordion-header" role="button" tabindex="0">
              <div class="card-header-main">
                <div class="card-title-row">
                  <span class="card-title">${escapeHtml(m.productName || m.productCode || 'Mutasi Stok')}</span>
                  <span class="badge ${isPositive ? 'badge-success' : 'badge-danger'}" style="font-weight:700;font-size:12px;padding:3px 8px;border-radius:6px;">${deltaStr}</span>
                </div>
                <div class="card-meta-row">
                  <span class="card-meta-code">${escapeHtml(m.type || 'Mutasi')}</span>
                  <span class="card-meta-dot">•</span>
                  <span class="card-meta-sub">${formatDateTime(m.createdAt || m.date)}</span>
                </div>
                <div class="card-kpi-strip">
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Perubahan</span>
                    <span class="kpi-strip-val ${isPositive ? 'val-sell' : 'text-danger'}">${deltaStr}</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Referensi</span>
                    <span class="kpi-strip-val">${escapeHtml(m.reference || '—')}</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Kode Item</span>
                    <span class="kpi-strip-val">${escapeHtml(m.productCode || '—')}</span>
                  </div>
                </div>
              </div>
              <div class="card-toggle-icon"><i class="fa-solid fa-chevron-down"></i></div>
            </div>
            <div class="card-accordion-body">
              <div class="card-detail-grid">
                <div class="card-detail-item">
                  <span class="card-detail-label">Kode Produk</span>
                  <span class="card-detail-value"><code>${escapeHtml(m.productCode || '—')}</code></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Stok Setelah Mutasi</span>
                  <span class="card-detail-value"><strong>${m.stockAfter !== undefined ? formatNumber(m.stockAfter) : '—'}</strong></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Sumber & Pelaku</span>
                  <span class="card-detail-value">
                    <strong>${escapeHtml(m.source || 'Sistem')}</strong> 
                    <small class="text-muted">(${escapeHtml(m.user || '—')})</small>
                  </span>
                </div>
                ${m.note || m.notes ? `
                <div class="card-detail-item">
                  <span class="card-detail-label">Keterangan / Rincian</span>
                  <span class="card-detail-value">${escapeHtml(m.note || m.notes)}</span>
                </div>` : ''}
                ${m.batch ? `
                <div class="card-detail-item">
                  <span class="card-detail-label">No. Batch / Exp</span>
                  <span class="card-detail-value">${escapeHtml(m.batch)}${m.expiryDate ? ` (EXP: ${escapeHtml(m.expiryDate)})` : ''}</span>
                </div>` : ''}
              </div>
            </div>
          </div>
        `;
      }).join("");

      cardList.querySelectorAll(".card-accordion-header").forEach(h => {
        h.addEventListener("click", () => {
          const card = h.closest(".responsive-data-card");
          if (card) card.classList.toggle("is-expanded");
        });
      });
    }
  });
}

/**
 * 3. MODAL KARTU STOK & AUDIT MUTASI LENGKAP
 */
export function installStockHistoryModal() {
  if ($("modal-stock-history")) return;

  const modalHtml = `
    <div id="modal-stock-history" class="kp-dialog-v4" hidden>
      <div class="kp-dialog-v4__backdrop"></div>
      <section class="kp-dialog-v4__card" style="width:min(96vw,840px);max-height:92vh;overflow-y:auto;display:flex;flex-direction:column;" role="dialog">
        <header style="padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;background:#f8fafc;border-top-left-radius:12px;border-top-right-radius:12px;">
          <div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:6px;background:#e0f2fe;color:#0284c7;font-size:14px;"><i class="fa-solid fa-clipboard-list"></i></span>
              <h2 id="stock-hist-title" style="font-size:16px;font-weight:800;color:#0f2a43;margin:0;">Kartu Stok Produk</h2>
            </div>
            <span id="stock-hist-sub" style="font-size:12px;color:#64748b;margin-left:36px;display:block;">Buku rekaman audit lalu lintas stok masuk, keluar, dan penyesuaian</span>
          </div>
          <button type="button" id="close-modal-stock-hist" class="button button-small button-secondary" style="padding:4px 8px;"><i class="fa-solid fa-xmark"></i></button>
        </header>

        <div id="stock-hist-body" style="padding:16px 20px;text-align:left;flex:1;overflow-y:auto;">
          <!-- Konten kartu stok -->
        </div>

        <footer style="padding:12px 20px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;border-bottom-left-radius:12px;border-bottom-right-radius:12px;">
          <button type="button" id="btn-print-stock-card" class="button button-secondary button-small" style="display:inline-flex;align-items:center;gap:6px;">
            <i class="fa-solid fa-file-pdf" style="color:#ef4444;"></i> Cetak PDF Kartu Stok
          </button>
          <button type="button" id="btn-close-stock-hist" class="button button-secondary">Tutup</button>
        </footer>
      </section>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  $("close-modal-stock-hist")?.addEventListener("click", () => $("modal-stock-history").hidden = true);
  $("btn-close-stock-hist")?.addEventListener("click", () => $("modal-stock-history").hidden = true);
}

let activeStockCardProduct = null;
let activeStockCardMovements = [];

export function openStockHistoryModal(productCode) {
  installStockHistoryModal();
  const modal = $("modal-stock-history");
  if (!modal) return;

  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? master.produk : [];
  const prod = prods.find(p => norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.id) === norm(productCode));
  const movs = readStore(STORE_KEYS.movements, []);
  const settings = readStore(STORE_KEYS.settings, {});

  const prodName = prod ? prod["Nama Produk"] : productCode;
  const unit = prod ? (prod["Satuan Dasar"] || prod["Satuan"] || "Item") : "Item";
  const curStock = prod ? readCurrentStock(prod["Kode Produk"] || productCode) : 0;

  $("stock-hist-title").textContent = prodName;
  $("stock-hist-sub").textContent = `Kode: ${productCode} | Satuan Dasar: ${unit} | Stok Saat Ini: ${formatNumber(curStock)} ${unit}`;

  // Filter faktur dan mutasi produk ini, urutkan dari yang terbaru ke terlama
  const prodMovs = (movs || []).filter(m => norm(m.productCode) === norm(productCode)).reverse();

  activeStockCardProduct = prod || { code: productCode, name: prodName, unit, stock: curStock };
  activeStockCardMovements = prodMovs;

  const totalIn = prodMovs.filter(m => num(m.delta ?? m.quantity) > 0).reduce((sum, m) => sum + num(m.delta ?? m.quantity), 0);
  const totalOut = prodMovs.filter(m => num(m.delta ?? m.quantity) < 0).reduce((sum, m) => sum + Math.abs(num(m.delta ?? m.quantity)), 0);

  const bodyEl = $("stock-hist-body");
  if (!prodMovs.length) {
    bodyEl.innerHTML = `
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 16px;margin-bottom:16px;display:flex;gap:16px;flex-wrap:wrap;">
        <div><small style="color:#64748b;display:block;">Stok Saat Ini</small><strong style="font-size:15px;color:#0f172a;">${formatNumber(curStock)} ${escapeHtml(unit)}</strong></div>
        <div><small style="color:#64748b;display:block;">Total Masuk</small><strong style="font-size:15px;color:#059669;">+0 ${escapeHtml(unit)}</strong></div>
        <div><small style="color:#64748b;display:block;">Total Keluar</small><strong style="font-size:15px;color:#dc2626;">-0 ${escapeHtml(unit)}</strong></div>
      </div>
      <p style="text-align:center;padding:32px 16px;color:#64748b;background:#fff;border-radius:8px;border:1px dashed #cbd5e1;">
        <i class="fa-solid fa-clipboard-question" style="font-size:24px;margin-bottom:8px;display:block;color:#94a3b8;"></i>
        Belum ada riwayat mutasi / lalu lintas stok yang tercatat untuk produk ini.
      </p>
    `;
  } else {
    bodyEl.innerHTML = `
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 16px;margin-bottom:16px;display:flex;gap:20px;flex-wrap:wrap;align-items:center;">
        <div>
          <small style="color:#64748b;display:block;font-size:11px;text-transform:uppercase;font-weight:700;">Saldo Stok Saat Ini</small>
          <strong style="font-size:16px;color:#0f2a43;">${formatNumber(curStock)}</strong> <small style="color:#64748b;">${escapeHtml(unit)}</small>
        </div>
        <div style="border-left:1px solid #cbd5e1;height:28px;"></div>
        <div>
          <small style="color:#64748b;display:block;font-size:11px;text-transform:uppercase;font-weight:700;">Total Barang Masuk</small>
          <strong style="font-size:16px;color:#059669;">+${formatNumber(totalIn)}</strong> <small style="color:#64748b;">${escapeHtml(unit)}</small>
        </div>
        <div style="border-left:1px solid #cbd5e1;height:28px;"></div>
        <div>
          <small style="color:#64748b;display:block;font-size:11px;text-transform:uppercase;font-weight:700;">Total Barang Keluar</small>
          <strong style="font-size:16px;color:#dc2626;">-${formatNumber(totalOut)}</strong> <small style="color:#64748b;">${escapeHtml(unit)}</small>
        </div>
        <div style="border-left:1px solid #cbd5e1;height:28px;"></div>
        <div>
          <small style="color:#64748b;display:block;font-size:11px;text-transform:uppercase;font-weight:700;">Total Transaksi Mutasi</small>
          <strong style="font-size:16px;color:#0284c7;">${formatNumber(prodMovs.length)}</strong> <small style="color:#64748b;">kali</small>
        </div>
      </div>

      <div class="table-wrapper" style="max-height:360px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:8px;">
        <table class="data-table" style="font-size:12.5px;">
          <thead style="position:sticky;top:0;background:#f1f5f9;z-index:2;">
            <tr>
              <th style="padding:8px 10px;">Waktu & Jam</th>
              <th style="padding:8px 10px;">Jenis Mutasi</th>
              <th style="padding:8px 10px;">No. Referensi</th>
              <th style="padding:8px 10px;text-align:right;">Perubahan</th>
              <th style="padding:8px 10px;text-align:right;">Saldo Setelah</th>
              <th style="padding:8px 10px;">Sumber / User</th>
              <th style="padding:8px 10px;">Batch / EXP / Info</th>
            </tr>
          </thead>
          <tbody>
            ${prodMovs.map(m => {
              const deltaVal = num(m.delta ?? m.quantity);
              const isPositive = deltaVal > 0;
              const deltaStr = isPositive ? `+${formatNumber(deltaVal)}` : `${formatNumber(deltaVal)}`;
              const timeDisplay = formatDateTime(m.createdAt || m.date || m.at);

              let badgeBg = "#f1f5f9";
              let badgeColor = "#475569";
              const typeStr = norm(m.type);
              if (typeStr.includes("faktur") || typeStr.includes("masuk")) {
                badgeBg = "#dcfce7"; badgeColor = "#15803d";
              } else if (typeStr.includes("penjualan") || typeStr.includes("sale")) {
                badgeBg = "#fee2e2"; badgeColor = "#b91c1c";
              } else if (typeStr.includes("opname")) {
                badgeBg = "#fef3c7"; badgeColor = "#b45309";
              } else if (typeStr.includes("retur") || typeStr.includes("pembatalan")) {
                badgeBg = "#f3e8ff"; badgeColor = "#7e22ce";
              }

              return `
                <tr>
                  <td style="white-space:nowrap;color:#0f172a;font-weight:600;">${timeDisplay}</td>
                  <td>
                    <span class="badge" style="background:${badgeBg};color:${badgeColor};font-weight:700;font-size:11px;padding:3px 7px;border-radius:5px;">
                      ${escapeHtml(m.type || 'Mutasi')}
                    </span>
                  </td>
                  <td>
                    <span style="font-weight:700;color:#0284c7;">${escapeHtml(m.reference || '—')}</span>
                    ${m.supplier ? `<small style="display:block;color:#64748b;font-size:11px;">${escapeHtml(m.supplier)}</small>` : ''}
                  </td>
                  <td style="text-align:right;font-weight:800;color:${isPositive ? '#059669' : '#dc2626'};">
                    ${deltaStr}
                  </td>
                  <td style="text-align:right;font-weight:700;color:#0f172a;">
                    ${m.stockAfter !== undefined ? formatNumber(m.stockAfter) : '—'}
                  </td>
                  <td>
                    <small style="color:#334155;font-weight:600;display:block;">${escapeHtml(m.source || 'Sistem')}</small>
                    <small style="color:#64748b;font-size:11px;">Oleh: ${escapeHtml(m.user || '—')}</small>
                  </td>
                  <td>
                    ${m.batch ? `<span style="font-weight:600;color:#0f172a;">Batch: ${escapeHtml(m.batch)}</span>` : ''}
                    ${m.expiryDate ? `<small style="display:block;color:#64748b;font-size:11px;">EXP: ${escapeHtml(m.expiryDate)}</small>` : ''}
                    ${m.note || m.notes ? `<small style="display:block;color:#64748b;font-size:11px;font-style:italic;">${escapeHtml(m.note || m.notes)}</small>` : ''}
                    ${!m.batch && !m.expiryDate && !m.note && !m.notes ? '<span style="color:#94a3b8;">—</span>' : ''}
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
      <p style="margin-top:10px;font-size:11.5px;color:#64748b;display:flex;align-items:center;gap:6px;">
        <i class="fa-solid fa-circle-info" style="color:#0284c7;"></i> 
        Setiap entri memuat saldo sebelum & sesudah, nomor bukti faktur/struk, dan petugas penanggung jawab secara transparan.
      </p>
    `;
  }

  // Setup tombol Cetak PDF
  const printBtn = $("btn-print-stock-card");
  if (printBtn) {
    printBtn.onclick = () => {
      try {
        generateStockCardPdf(activeStockCardProduct, activeStockCardMovements, settings, "Administrator");
      } catch (err) {
        window.KasirProDialog?.error("Gagal Cetak PDF", err.message);
      }
    };
  }

  modal.hidden = false;
}
