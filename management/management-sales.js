/**
 * management/management-sales.js
 * Manajemen Transaksi Penjualan KasirPro V2
 * 
 * Sesuai Spesifikasi:
 * - Transaksi selesai tidak boleh diedit/dihapus secara langsung.
 * - Pembatalan/Retur wajib melalui VOID/Retur Penjualan dengan alasan
 *   (Salah Input, Barang Dikembalikan, Pembayaran Dibatalkan, Lainnya).
 * - Transaksi asli dipertahankan, perubahan stok dibalik via movement "Retur Penjualan".
 */

import { $, num, text, norm, rupiah, formatNumber, formatDateTime, escapeHtml, nowIso, uid } from "../modules/core/utils.js";
import { STORE_KEYS, readStore, writeStore, writeStockTransaction } from "../modules/database/database-store.js";

const PAGE_SIZE = 25;
let currentSalesPage = 1;
let allSales = [];
let filteredSales = [];
let activeDetailSale = null;

export function initSalesModule() {
  bindEvents();
  renderSales();
}

function bindEvents() {
  $("sales-refresh")?.addEventListener("click", () => {
    renderSales();
    window.KasirProDialog?.success("Berhasil", "Data transaksi penjualan berhasil dimuat ulang.");
  });

  $("sales-search")?.addEventListener("input", () => {
    currentSalesPage = 1;
    applySalesFilters();
  });

  $("sales-period")?.addEventListener("change", () => {
    currentSalesPage = 1;
    applySalesFilters();
  });

  $("sales-status-filter")?.addEventListener("change", () => {
    currentSalesPage = 1;
    applySalesFilters();
  });

  $("sales-payment-filter")?.addEventListener("change", () => {
    currentSalesPage = 1;
    applySalesFilters();
  });

  $("sales-prev-page")?.addEventListener("click", () => {
    if (currentSalesPage > 1) {
      currentSalesPage--;
      renderSalesTable();
    }
  });

  $("sales-next-page")?.addEventListener("click", () => {
    const totalPages = Math.ceil(filteredSales.length / PAGE_SIZE) || 1;
    if (currentSalesPage < totalPages) {
      currentSalesPage++;
      renderSalesTable();
    }
  });

  installSaleDetailModal();
}

export function renderSales() {
  const rawSales = readStore(STORE_KEYS.sales, []);
  allSales = Array.isArray(rawSales) ? [...rawSales].reverse() : [];
  updateSalesKpis();
  applySalesFilters();
}

function updateSalesKpis() {
  const completed = allSales.filter(s => norm(s.status) !== "void");
  const totalOmzet = completed.reduce((sum, s) => sum + num(s.total), 0);
  const totalQty = completed.reduce((sum, s) => sum + (s.items || []).reduce((iSum, it) => iSum + num(it.qty), 0), 0);

  const kpis = document.querySelectorAll('[data-view-section="sales"] .report-kpi strong');
  if (kpis.length >= 3) {
    kpis[0].textContent = rupiah(totalOmzet);
    kpis[1].textContent = formatNumber(completed.length);
    kpis[2].textContent = formatNumber(totalQty);
  }
}

function applySalesFilters() {
  const q = norm($("sales-search")?.value);
  const period = $("sales-period")?.value || "month";
  const statusFilter = norm($("sales-status-filter")?.value);
  const paymentFilter = norm($("sales-payment-filter")?.value);

  const now = new Date();

  filteredSales = allSales.filter(s => {
    const no = norm(s.transactionNumber || s.id);
    const cashier = norm(s.cashierName || s.cashier);
    const status = norm(s.status || "selesai");
    const payMethod = norm(s.paymentMethod || "cash");

    if (q && !no.includes(q) && !cashier.includes(q)) return false;
    if (statusFilter && status !== statusFilter) return false;
    if (paymentFilter && payMethod !== paymentFilter) return false;

    // Filter Periode
    const sDate = new Date(s.at || s.createdAt);
    if (!Number.isNaN(sDate.getTime())) {
      if (period === "today") {
        if (sDate.toDateString() !== now.toDateString()) return false;
      } else if (period === "7") {
        const diffDays = (now - sDate) / (1000 * 60 * 60 * 24);
        if (diffDays > 7) return false;
      } else if (period === "month") {
        if (sDate.getMonth() !== now.getMonth() || sDate.getFullYear() !== now.getFullYear()) return false;
      }
    }

    return true;
  });

  renderSalesTable();
}

function renderSalesTable() {
  const tbody = document.querySelector(".sales-table tbody") || $("sales-table-body");
  const cardList = $("sales-card-list");
  if (!tbody && !cardList) return;

  const total = filteredSales.length;
  const start = (currentSalesPage - 1) * PAGE_SIZE;
  const pageItems = filteredSales.slice(start, start + PAGE_SIZE);

  if (!pageItems.length) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="empty-table-state" style="text-align:center;padding:24px;">Tidak ada transaksi penjualan yang ditemukan.</td></tr>`;
    if (cardList) cardList.innerHTML = `<div style="text-align:center;padding:32px 16px;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;color:#64748b;"><i class="fa-solid fa-receipt" style="font-size:28px;margin-bottom:8px;color:#94a3b8;display:block;"></i>Tidak ada transaksi penjualan yang ditemukan.</div>`;
  } else {
    // 1. Render Desktop Table Rows
    if (tbody) {
      tbody.innerHTML = pageItems.map(s => {
        const isVoid = norm(s.status) === "void";
        const id = s.id || s.transactionNumber;
        const no = s.transactionNumber || s.id || "—";
        const date = formatDateTime(s.at || s.createdAt);
        const cashier = s.cashierName || s.cashier || "Kasir";
        const pay = s.paymentMethod || "Cash";
        const itemCount = (s.items || []).length;
        const total = num(s.total);

        return `
          <tr style="${isVoid ? 'background:#fef2f2;color:#94a3b8;' : ''}">
            <td>${date}</td>
            <td><strong>${escapeHtml(no)}</strong></td>
            <td>${escapeHtml(cashier)}</td>
            <td>${escapeHtml(pay)}</td>
            <td>${itemCount} item</td>
            <td><strong>${rupiah(total)}</strong></td>
            <td>
              <span class="badge ${isVoid ? 'badge-danger' : 'badge-success'}" style="padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;">
                ${isVoid ? 'VOID' : 'Selesai'}
              </span>
            </td>
            <td>
              <button type="button" class="btn-detail-sale button button-small button-secondary" data-id="${escapeHtml(id)}">
                <i class="fa-solid fa-eye"></i> Detail
              </button>
            </td>
          </tr>
        `;
      }).join("");
    }

    // 2. Render Mobile Collapsible Cards (Default Diciutkan)
    if (cardList) {
      cardList.innerHTML = pageItems.map(s => {
        const isVoid = norm(s.status) === "void";
        const id = s.id || s.transactionNumber;
        const no = s.transactionNumber || s.id || "—";
        const date = formatDateTime(s.at || s.createdAt);
        const cashier = s.cashierName || s.cashier || "Kasir";
        const pay = s.paymentMethod || "Cash";
        const itemCount = (s.items || []).length;
        const total = num(s.total);

        return `
          <div class="responsive-data-card ${isVoid ? 'card-danger' : 'card-success'}" data-id="${escapeHtml(id)}">
            <div class="card-accordion-header">
              <div class="card-header-main">
                <div class="card-title-row">
                  <div class="card-title">#${escapeHtml(no)}</div>
                  <span class="badge ${isVoid ? 'badge-danger' : 'badge-success'}" style="padding:2px 7px;border-radius:5px;font-size:10px;font-weight:700;">
                    ${isVoid ? 'VOID' : 'Selesai'}
                  </span>
                </div>
                <div class="card-meta-row">
                  <span class="card-meta-code"><i class="fa-solid fa-user" style="font-size:10px;"></i> ${escapeHtml(cashier)}</span>
                  <span class="card-meta-dot">•</span>
                  <span class="card-meta-sub"><i class="fa-regular fa-clock" style="font-size:10px;"></i> ${date}</span>
                </div>
                <div class="card-kpi-strip">
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Total Omzet</span>
                    <span class="kpi-strip-val ${isVoid ? 'text-danger' : 'val-sell'}">${rupiah(total)}</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Metode Bayar</span>
                    <span class="kpi-strip-val">${escapeHtml(pay)}</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Item Produk</span>
                    <span class="kpi-strip-val">${itemCount} Produk</span>
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
                  <span class="card-detail-label">Nomor Transaksi</span>
                  <span class="card-detail-value"><strong>#${escapeHtml(no)}</strong></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Kasir Pelaksana</span>
                  <span class="card-detail-value">${escapeHtml(cashier)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Metode Pembayaran</span>
                  <span class="card-detail-value">${escapeHtml(pay)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Jumlah Produk</span>
                  <span class="card-detail-value">${itemCount} Produk</span>
                </div>
                <div class="card-detail-item" style="grid-column: 1 / -1;">
                  <span class="card-detail-label">Total Penjualan</span>
                  <span class="card-detail-value" style="color:#059669;font-size:0.92rem;font-weight:800;">${rupiah(total)}</span>
                </div>
              </div>
              <div class="card-action-bar">
                <button type="button" class="btn-detail-sale button button-small button-secondary" data-id="${escapeHtml(id)}">
                  <i class="fa-solid fa-eye"></i> Detail Transaksi
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

    const sContainer = document.querySelector('[data-view-section="sales"]');
    if (sContainer) {
      sContainer.querySelectorAll(".btn-detail-sale").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const sId = btn.dataset.id;
          const found = allSales.find(s => (s.id || s.transactionNumber) === sId);
          if (found) openSaleDetailModal(found);
        });
      });
    }
  }

  const pageInfoEl = $("sales-page-info");
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  if (pageInfoEl) {
    pageInfoEl.textContent = `Halaman ${currentSalesPage} dari ${totalPages} (${total} total transaksi)`;
  }

  const prevBtn = $("sales-prev-page");
  if (prevBtn) prevBtn.disabled = currentSalesPage <= 1;

  const nextBtn = $("sales-next-page");
  if (nextBtn) nextBtn.disabled = currentSalesPage >= totalPages;
}

function installSaleDetailModal() {
  const overlay = $("sales-detail-overlay");
  if (!overlay) return;

  $("close-sales-detail")?.addEventListener("click", () => overlay.hidden = true);
  $("sales-detail-close-btn")?.addEventListener("click", () => overlay.hidden = true);
  $("sales-detail-print")?.addEventListener("click", () => {
    window.print();
  });
  $("sales-detail-void")?.addEventListener("click", handleVoidSale);
}

function openSaleDetailModal(sale) {
  activeDetailSale = sale;
  const overlay = $("sales-detail-overlay");
  if (!overlay) return;

  $("sales-detail-number").textContent = `Transaksi #${sale.transactionNumber || sale.id}`;
  $("sales-detail-time").textContent = formatDateTime(sale.at || sale.createdAt);

  const isVoid = norm(sale.status) === "void";
  const voidBtn = $("sales-detail-void");
  if (voidBtn) {
    voidBtn.style.display = isVoid ? "none" : "inline-flex";
  }

  const area = $("sales-detail-print-area");
  if (area) {
    area.innerHTML = `
      <div style="margin-bottom:14px;background:#f8fafc;padding:12px;border-radius:8px;">
        <div>Kasir: <strong>${escapeHtml(sale.cashierName || sale.cashier || 'Kasir')}</strong></div>
        <div>Metode Bayar: <strong>${escapeHtml(sale.paymentMethod || 'Cash')}</strong></div>
        <div>Status: <strong style="color:${isVoid ? '#dc2626' : '#059669'};">${isVoid ? 'VOID (Dibatalkan)' : 'Selesai'}</strong></div>
        ${isVoid ? `<div style="color:#dc2626;margin-top:4px;">Alasan VOID: ${escapeHtml(sale.voidReason || '—')}</div>` : ''}
      </div>
      <table class="data-table" style="width:100%;font-size:12px;">
        <thead>
          <tr>
            <th>Produk</th>
            <th>Qty</th>
            <th>Harga</th>
            <th>Subtotal</th>
          </tr>
        </thead>
        <tbody>
          ${(sale.items || []).map(it => `
            <tr>
              <td><strong>${escapeHtml(it.name || it.productName || '—')}</strong></td>
              <td>${it.qty} ${escapeHtml(it.unitName || it.unit || it.baseUnit || 'item')}</td>
              <td>${rupiah(it.price || it.sellPrice || 0)}</td>
              <td>${rupiah(it.subtotal || (num(it.qty) * num(it.price)) || 0)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <div style="margin-top:14px;text-align:right;">
        <div>Subtotal: <strong>${rupiah(sale.subtotal || sale.total || 0)}</strong></div>
        <div>Diskon Transaksi: <strong>${rupiah(sale.transactionDiscount || 0)}</strong></div>
        <div style="font-size:15px;margin-top:4px;">TOTAL: <strong>${rupiah(sale.total || 0)}</strong></div>
      </div>
    `;
  }

  overlay.hidden = false;
}

async function handleVoidSale() {
  if (!activeDetailSale) return;
  const sale = activeDetailSale;

  const reasonOptions = ["Salah Input", "Barang Dikembalikan", "Pembayaran Dibatalkan", "Lainnya"];
  const selectedReason = await window.KasirProDialog?.input(
    "VOID Transaksi (Retur Penjualan)",
    `Pilih alasan pembatalan transaksi #${sale.transactionNumber || sale.id}.\nStok akan dikembalikan ke persediaan secara otomatis.`,
    {
      placeholder: "Contoh: Barang Dikembalikan atau Salah Input...",
      defaultValue: "Barang Dikembalikan"
    }
  );
  if (!selectedReason) return;

  try {
    const movements = [];
    const now = nowIso();
    const user = "Admin";

    // Balik stok tiap item
    for (const item of (sale.items || [])) {
      const code = item.code || item.productCode;
      const baseQty = num(item.qty) * (num(item.conversionRatio) || 1);

      movements.push({
        id: uid("mov-void"),
        productCode: code || item.name,
        productName: item.name || item.productName,
        type: "Retur Penjualan",
        delta: baseQty, // tambah kembali stok
        quantity: baseQty,
        source: "VOID Penjualan",
        reference: sale.transactionNumber || sale.id,
        user,
        reason: selectedReason,
        createdAt: now
      });
    }

    sale.status = "VOID";
    sale.voidAt = now;
    sale.voidBy = user;
    sale.voidReason = selectedReason;

    await writeStockTransaction([
      { key: STORE_KEYS.sales, records: [sale] },
      { key: STORE_KEYS.movements, records: movements }
    ]);

    $("sales-detail-overlay").hidden = true;
    renderSales();
    window.KasirProDialog?.success("Transaksi Di-VOID", `Transaksi #${sale.transactionNumber || sale.id} berhasil di-VOID dan stok telah dikembalikan.`);
  } catch (err) {
    window.KasirProDialog?.error("Gagal VOID Transaksi", err.message);
  }
}
