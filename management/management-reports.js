/**
 * management/management-reports.js
 * Manajemen Laporan Operasional KasirPro V2
 * 
 * Sesuai Spesifikasi:
 * - Tepat 3 laporan utama: Laporan Penjualan, Laporan Pembelian, dan Laporan Stok.
 * - Filter: Hari Ini, 7 Hari, Bulan Ini, Bulan Lalu, Custom Range.
 * - Sub-section: Produk Terjual, Per Kasir, Barang Masuk.
 * - Ekspor PDF Resmi A4 Portrait dengan repeated headers & nomor halaman.
 */

import { $, num, text, norm, rupiah, formatNumber, formatDateTime, escapeHtml, dateOnly } from "../modules/core/utils.js";
import { STORE_KEYS, readStore, readCurrentStock } from "../modules/database/database-store.js";
import { generateSalesReportPdf, generatePurchaseReportPdf, generateStockReportPdf } from "../modules/core/pdf.js";

let activeReportTab = "summary";

export function initReportsModule() {
  bindEvents();
  renderReports();
}

function bindEvents() {
  $("report-refresh")?.addEventListener("click", () => {
    renderReports();
    window.KasirProDialog?.success("Berhasil", "Laporan berhasil dimuat ulang.");
  });

  $("report-period")?.addEventListener("change", handlePeriodChange);
  $("report-start-date")?.addEventListener("change", renderReports);
  $("report-end-date")?.addEventListener("change", renderReports);
  $("report-search")?.addEventListener("input", renderReports);

  // Tabs Laporan
  document.querySelectorAll("[data-report-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-report-tab]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeReportTab = btn.dataset.reportTab;

      document.querySelectorAll("[data-report-panel]").forEach(p => {
        p.hidden = p.dataset.reportPanel !== activeReportTab;
      });

      renderReports();
    });
  });

  // Tombol Cetak PDF Laporan
  $("report-print")?.addEventListener("click", handlePrintActiveReport);
}

function handlePeriodChange() {
  const p = $("report-period")?.value;
  const startEl = $("report-start-date");
  const endEl = $("report-end-date");

  if (p === "custom") {
    if (startEl) startEl.disabled = false;
    if (endEl) endEl.disabled = false;
  } else {
    if (startEl) startEl.disabled = true;
    if (endEl) endEl.disabled = true;
  }
  renderReports();
}

function parseEntryDate(val) {
  if (!val) return null;
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? null : val;
  const s = String(val).trim();
  if (!s) return null;
  // Format DD/MM/YYYY atau DD-MM-YYYY
  const dmyMatch = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (dmyMatch) {
    const d = new Date(Number(dmyMatch[3]), Number(dmyMatch[2]) - 1, Number(dmyMatch[1]), 12, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // Format YYYY-MM-DD
  const ymdMatch = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (ymdMatch) {
    const d = new Date(Number(ymdMatch[1]), Number(ymdMatch[2]) - 1, Number(ymdMatch[3]), 12, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getDateRange() {
  const p = $("report-period")?.value || "month";
  const now = new Date();
  let start = new Date();
  let end = new Date();

  if (p === "today") {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (p === "7") {
    start.setDate(now.getDate() - 7);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (p === "30") {
    start.setDate(now.getDate() - 30);
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (p === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else if (p === "custom") {
    const sVal = $("report-start-date")?.value;
    const eVal = $("report-end-date")?.value;
    start = sVal ? new Date(sVal) : new Date(0);
    start.setHours(0, 0, 0, 0);
    end = eVal ? new Date(eVal) : new Date();
    end.setHours(23, 59, 59, 999);
  } else {
    // Semua Data: cakup seluruh riwayat hingga masa depan
    start = new Date(0);
    end = new Date(8640000000000000);
  }

  return { start, end };
}

export function renderReports() {
  const { start, end } = getDateRange();
  const q = norm($("report-search")?.value);

  const sales = readStore(STORE_KEYS.sales, []);
  const invoices = readStore(STORE_KEYS.invoices, []);
  const movements = readStore(STORE_KEYS.movements, []);
  const master = readStore(STORE_KEYS.master, {});
  const products = Array.isArray(master.produk) ? master.produk : [];

  // Filter Sales dalam periode
  const filteredSales = sales.filter(s => {
    const d = parseEntryDate(s.at || s.createdAt);
    if (d && (d < start || d > end)) return false;
    if (q) {
      const sTarget = norm(`${s.transactionNumber || s.id || ''} ${s.cashierName || s.cashier || ''} ${s.paymentMethod || ''}`);
      if (!sTarget.includes(q)) return false;
    }
    return true;
  });

  const completedSales = filteredSales.filter(s => norm(s.status) !== "void");

  // Filter Faktur dalam periode & pencarian
  const filteredInvoices = invoices.filter(inv => {
    const d = parseEntryDate(inv.date || inv.invoiceDate || inv.createdAt);
    if (d && (d < start || d > end)) return false;
    if (q) {
      const invTarget = norm(`${inv.invoiceNumber || inv.id || ''} ${inv.supplierName || inv.supplier || ''} ${inv.status || ''} ${inv.notes || ''}`);
      if (!invTarget.includes(q)) return false;
    }
    return true;
  });

  // KPI Utama
  const totalOmzet = completedSales.reduce((sum, s) => sum + num(s.total), 0);
  const totalTrx = completedSales.length;
  const voidCount = filteredSales.filter(s => norm(s.status) === "void").length;
  const totalUnitSold = completedSales.reduce((sum, s) => sum + (s.items || []).reduce((iSum, it) => iSum + num(it.qty), 0), 0);
  const purchaseValue = filteredInvoices.reduce((sum, inv) => sum + num(inv.total), 0);

  // Estimasi Nilai Stok (Hanya menghitung stok fisik riil >= 0 agar valuasi aset tidak minus)
  let totalStockVal = 0;
  let lowStockCount = 0;
  let negativeStockCount = 0;
  products.forEach(p => {
    const rawSt = readCurrentStock(p["Kode Produk"]);
    const st = Math.max(0, rawSt);
    const conv = num(p["Konversi"] ?? p["Isi Kemasan"] ?? 1) || 1;
    const buy = num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0);
    const unitBuy = buy / conv;
    totalStockVal += (st * unitBuy);
    if (rawSt <= num(p["Stok Minimum"])) lowStockCount++;
    if (rawSt < 0) negativeStockCount++;
  });

  // Pasang nilai ke DOM KPI
  const revEl = $("report-revenue");
  if (revEl) revEl.textContent = rupiah(totalOmzet);

  const trxEl = $("report-transaction-count");
  if (trxEl) trxEl.textContent = formatNumber(totalTrx);

  const voidEl = $("report-void-count");
  if (voidEl) voidEl.textContent = `${voidCount} transaksi VOID`;

  const unitEl = $("report-unit-count");
  if (unitEl) unitEl.textContent = formatNumber(totalUnitSold);

  const purEl = $("report-purchase-value");
  if (purEl) purEl.textContent = rupiah(purchaseValue);

  // Pasang count ke KPI card dan ke badge chip tab panel
  const invCountEl = $("report-invoice-count");
  if (invCountEl) invCountEl.textContent = `${filteredInvoices.length} faktur`;

  const invPanelCountEl = $("report-invoices-count");
  if (invPanelCountEl) invPanelCountEl.textContent = `${filteredInvoices.length} faktur`;

  const salesPanelCountEl = $("report-sales-count");
  if (salesPanelCountEl) salesPanelCountEl.textContent = `${filteredSales.length} transaksi`;

  const stockPanelCountEl = $("report-stock-count");
  if (stockPanelCountEl) stockPanelCountEl.textContent = `${products.length} produk`;

  const stockValEl = $("report-stock-value");
  if (stockValEl) stockValEl.textContent = rupiah(totalStockVal);

  const lowStockEl = $("report-low-stock-count");
  if (lowStockEl) {
    if (negativeStockCount > 0) {
      lowStockEl.innerHTML = `<span style="color:#ef4444;font-weight:700;">⚠️ ${negativeStockCount} minus</span> · ${lowStockCount} menipis/habis`;
    } else {
      lowStockEl.textContent = `${lowStockCount} produk menipis/habis`;
    }
  }

  // Map master produk untuk lookup HPP
  const productsMap = new Map();
  products.forEach(p => productsMap.set(norm(p["Kode Produk"] || p.id), p));

  // Hitung total estimasi laba kotor untuk KPI
  let totalEstimatedProfit = 0;
  completedSales.forEach(s => {
    (s.items || []).forEach(it => {
      const q = num(it.qty);
      const sub = num(it.subtotal || (q * num(it.price)));
      const pData = productsMap.get(norm(it.code || it.productCode));
      const conv = num(pData?.["Konversi"] ?? pData?.["Isi Kemasan"] ?? 1) || 1;
      const buyPrice = num(it.buyPrice ?? it.costPrice ?? pData?.["Harga Beli Terakhir"] ?? pData?.["Harga Beli"] ?? 0) / conv;
      totalEstimatedProfit += (sub - (q * buyPrice));
    });
  });

  const profitEl = $("report-profit");
  if (profitEl) profitEl.textContent = rupiah(totalEstimatedProfit);

  const periodLabelEl = $("report-period-label");
  if (periodLabelEl) {
    const pSelect = $("report-period");
    periodLabelEl.textContent = pSelect?.selectedOptions?.[0]?.textContent || "Bulan Ini";
  }

  const lastUpdatedEl = $("report-last-updated");
  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = `Diperbarui: ${formatDateTime(new Date())}`;
  }

  // Render Seluruh Panel Laporan (Tabel Tersembunyi + Kartu Adaptif Vertikal)
  renderDailySummary(completedSales, productsMap);
  renderSalesSubReport(filteredSales);
  renderProductsSoldSubReport(completedSales, products);
  renderStockSubReport(products);
  renderGoodsInSubReport(movements, filteredInvoices, start, end, q);
  renderInvoicesSubReport(filteredInvoices);
  renderCashiersSubReport(completedSales, filteredSales, productsMap);
}

function bindCardAccordions(container) {
  if (!container) return;
  container.querySelectorAll(".card-accordion-header").forEach(header => {
    header.addEventListener("click", () => {
      const card = header.closest(".responsive-data-card");
      if (card) card.classList.toggle("is-expanded");
    });
  });
}

function renderDailySummary(completedSales, productsMap) {
  const tbody = $("report-daily-body");
  const cardList = $("report-daily-cards");
  const paymentListEl = $("report-payment-list");

  const dayMap = new Map();
  const paymentMap = new Map();
  let totalOmzet = 0;

  completedSales.forEach(s => {
    const rawDate = s.at || s.createdAt;
    const dObj = parseEntryDate(rawDate) || new Date();
    const dateKey = dObj.toISOString().slice(0, 10);
    const dayLabel = dObj.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });

    const sTotal = num(s.total);
    totalOmzet += sTotal;

    let sItems = 0;
    let sProfit = 0;
    (s.items || []).forEach(it => {
      const q = num(it.qty);
      sItems += q;
      const sub = num(it.subtotal || (q * num(it.price)));
      const pData = productsMap?.get(norm(it.code || it.productCode));
      const conv = num(pData?.["Konversi"] ?? pData?.["Isi Kemasan"] ?? 1) || 1;
      const buyPrice = num(it.buyPrice ?? it.costPrice ?? pData?.["Harga Beli Terakhir"] ?? pData?.["Harga Beli"] ?? 0) / conv;
      const hpp = q * buyPrice;
      sProfit += (sub - hpp);
    });

    const dayData = dayMap.get(dateKey) || { dateKey, dayLabel, trx: 0, items: 0, omzet: 0, profit: 0 };
    dayData.trx += 1;
    dayData.items += sItems;
    dayData.omzet += sTotal;
    dayData.profit += sProfit;
    dayMap.set(dateKey, dayData);

    const pMethod = s.paymentMethod || "Cash";
    paymentMap.set(pMethod, (paymentMap.get(pMethod) || 0) + sTotal);
  });

  const dayList = [...dayMap.values()].sort((a, b) => b.dateKey.localeCompare(a.dateKey));

  if (tbody) {
    if (!dayList.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:24px;color:#94a3b8;">Belum ada data transaksi harian.</td></tr>`;
    } else {
      tbody.innerHTML = dayList.map(d => `
        <tr>
          <td><strong>${escapeHtml(d.dayLabel)}</strong></td>
          <td>${formatNumber(d.trx)}</td>
          <td>${formatNumber(d.items)}</td>
          <td><strong>${rupiah(d.omzet)}</strong></td>
          <td style="color:#059669;font-weight:700;">${rupiah(d.profit)}</td>
        </tr>
      `).join("");
    }
  }

  if (cardList) {
    if (!dayList.length) {
      cardList.innerHTML = `<div style="text-align:center;padding:28px 16px;color:#94a3b8;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;"><i class="fa-solid fa-calendar-days" style="font-size:24px;margin-bottom:8px;display:block;"></i>Belum ada data transaksi harian.</div>`;
    } else {
      cardList.innerHTML = dayList.map(d => `
        <div class="responsive-data-card card-success">
          <div class="card-accordion-header" role="button" tabindex="0">
            <div class="card-header-main">
              <div class="card-title-row">
                <span class="card-title">${escapeHtml(d.dayLabel)}</span>
                <strong style="color:#059669;font-size:0.95rem;">${rupiah(d.omzet)}</strong>
              </div>
              <div class="card-meta-row">
                <span class="card-meta-code"><i class="fa-regular fa-calendar-days" style="font-size:10px;"></i> ${escapeHtml(d.dayLabel)}</span>
              </div>
              <div class="card-kpi-strip">
                <div class="kpi-strip-item">
                  <span class="kpi-strip-label">Total Omzet</span>
                  <span class="kpi-strip-val val-sell">${rupiah(d.omzet)}</span>
                </div>
                <div class="kpi-strip-item">
                  <span class="kpi-strip-label">Transaksi</span>
                  <span class="kpi-strip-val">${formatNumber(d.trx)} Trx (${formatNumber(d.items)} unit)</span>
                </div>
                <div class="kpi-strip-item">
                  <span class="kpi-strip-label">Estimasi Laba</span>
                  <span class="kpi-strip-val val-buy">${rupiah(d.profit)}</span>
                </div>
              </div>
            </div>
            <div class="card-toggle-icon"><i class="fa-solid fa-chevron-down"></i></div>
          </div>
          <div class="card-accordion-body">
            <div class="card-detail-grid">
              <div class="card-detail-item">
                <span class="card-detail-label">Tanggal</span>
                <span class="card-detail-value"><strong>${escapeHtml(d.dayLabel)}</strong></span>
              </div>
              <div class="card-detail-item">
                <span class="card-detail-label">Jumlah Transaksi</span>
                <span class="card-detail-value">${formatNumber(d.trx)} transaksi</span>
              </div>
              <div class="card-detail-item">
                <span class="card-detail-label">Produk Terjual</span>
                <span class="card-detail-value">${formatNumber(d.items)} unit</span>
              </div>
              <div class="card-detail-item">
                <span class="card-detail-label">Total Omzet Bersih</span>
                <span class="card-detail-value"><strong style="color:#0284c7;font-size:15px;">${rupiah(d.omzet)}</strong></span>
              </div>
              <div class="card-detail-item">
                <span class="card-detail-label">Estimasi Laba Kotor</span>
                <span class="card-detail-value"><strong style="color:#059669;font-size:15px;">${rupiah(d.profit)}</strong></span>
              </div>
            </div>
          </div>
        </div>
      `).join("");
      bindCardAccordions(cardList);
    }
  }

  // Breakdown Metode Pembayaran
  if (paymentListEl) {
    if (!paymentMap.size) {
      paymentListEl.innerHTML = `<div style="text-align:center;padding:20px;color:#94a3b8;font-size:13px;">Belum ada metode pembayaran tercatat.</div>`;
    } else {
      paymentListEl.innerHTML = [...paymentMap.entries()].map(([method, val]) => {
        const pct = totalOmzet > 0 ? Math.round((val / totalOmzet) * 100) : 0;
        return `
          <div class="breakdown-item" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#f8fafc;border-radius:10px;margin-bottom:8px;border:1px solid #e2e8f0;">
            <div style="display:flex;align-items:center;gap:10px;">
              <span class="badge badge-primary" style="padding:4px 8px;border-radius:6px;font-size:12px;font-weight:700;">${escapeHtml(method)}</span>
              <span style="font-size:13px;color:#64748b;">${pct}%</span>
            </div>
            <strong style="color:#0f172a;font-size:14px;">${rupiah(val)}</strong>
          </div>
        `;
      }).join("");
    }
  }
}

function renderSalesSubReport(salesList) {
  const tbody = $("report-sales-body");
  const cardList = $("report-sales-cards");

  if (tbody) {
    if (!salesList.length) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:24px;color:#94a3b8;">Tidak ada transaksi penjualan pada periode terpilih.</td></tr>`;
    } else {
      tbody.innerHTML = salesList.map(s => `
        <tr>
          <td>${formatDateTime(s.at || s.createdAt)}</td>
          <td><strong>${escapeHtml(s.transactionNumber || s.id)}</strong></td>
          <td>${escapeHtml(s.cashierName || s.cashier || 'Kasir')}</td>
          <td>${escapeHtml(s.paymentMethod || 'Cash')}</td>
          <td>${(s.items || []).length}</td>
          <td>${rupiah(s.subtotal || s.total)}</td>
          <td>${rupiah(s.transactionDiscount || 0)}</td>
          <td>${rupiah(s.tax || 0)}</td>
          <td><strong>${rupiah(s.total)}</strong></td>
          <td>${norm(s.status) === 'void' ? '<span class="text-danger font-bold">VOID</span>' : 'Selesai'}</td>
        </tr>
      `).join("");
    }
  }

  if (cardList) {
    if (!salesList.length) {
      cardList.innerHTML = `<div style="text-align:center;padding:28px 16px;color:#94a3b8;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;"><i class="fa-solid fa-receipt" style="font-size:24px;margin-bottom:8px;display:block;"></i>Tidak ada transaksi penjualan pada periode terpilih.</div>`;
    } else {
      cardList.innerHTML = salesList.map(s => {
        const isVoid = norm(s.status) === "void";
        const accentClass = isVoid ? "card-danger" : "card-success";
        const totalQty = (s.items || []).reduce((sum, it) => sum + num(it.qty), 0);

        return `
          <div class="responsive-data-card ${accentClass}">
            <div class="card-accordion-header" role="button" tabindex="0">
              <div class="card-header-main">
                <div class="card-title-row">
                  <span class="card-title">${escapeHtml(s.transactionNumber || s.id)}</span>
                  <span class="badge ${isVoid ? 'badge-danger' : 'badge-success'}" style="padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;">
                    ${isVoid ? 'VOID' : 'Selesai'}
                  </span>
                </div>
                <div class="card-meta-row">
                  <span class="card-meta-code"><i class="fa-solid fa-user" style="font-size:10px;"></i> ${escapeHtml(s.cashierName || s.cashier || 'Kasir')}</span>
                  <span class="card-meta-dot">•</span>
                  <span class="card-meta-sub"><i class="fa-regular fa-clock" style="font-size:10px;"></i> ${formatDateTime(s.at || s.createdAt)}</span>
                </div>
                <div class="card-kpi-strip">
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Total Penjualan</span>
                    <span class="kpi-strip-val ${isVoid ? 'text-danger' : 'val-sell'}">${rupiah(s.total)}</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Metode Bayar</span>
                    <span class="kpi-strip-val">${escapeHtml(s.paymentMethod || 'Cash')}</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Total Qty</span>
                    <span class="kpi-strip-val">${formatNumber(totalQty)} unit</span>
                  </div>
                </div>
              </div>
              <div class="card-toggle-icon"><i class="fa-solid fa-chevron-down"></i></div>
            </div>
            <div class="card-accordion-body">
              <div class="card-detail-grid">
                <div class="card-detail-item">
                  <span class="card-detail-label">Nomor Transaksi</span>
                  <span class="card-detail-value"><strong>${escapeHtml(s.transactionNumber || s.id)}</strong></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Waktu Transaksi</span>
                  <span class="card-detail-value">${formatDateTime(s.at || s.createdAt)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Kasir</span>
                  <span class="card-detail-value">${escapeHtml(s.cashierName || s.cashier || 'Kasir')}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Metode Pembayaran</span>
                  <span class="card-detail-value">${escapeHtml(s.paymentMethod || 'Cash')}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Jumlah Produk</span>
                  <span class="card-detail-value">${(s.items || []).length} jenis (${totalQty} unit)</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Subtotal</span>
                  <span class="card-detail-value">${rupiah(s.subtotal || s.total)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Diskon Transaksi</span>
                  <span class="card-detail-value">${rupiah(s.transactionDiscount || 0)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Pajak (PPN)</span>
                  <span class="card-detail-value">${rupiah(s.tax || 0)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Total Pembayaran</span>
                  <span class="card-detail-value"><strong style="color:#0284c7;font-size:15px;">${rupiah(s.total)}</strong></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Status Transaksi</span>
                  <span class="card-detail-value"><span class="badge ${isVoid ? 'badge-danger' : 'badge-success'}" style="padding:2px 6px;border-radius:4px;font-size:11px;">${isVoid ? 'VOID' : 'Selesai'}</span></span>
                </div>
              </div>
              ${(s.items && s.items.length) ? `
                <div style="margin-top:14px;padding-top:12px;border-top:1px dashed #e2e8f0;">
                  <strong style="font-size:12px;color:#475569;display:block;margin-bottom:8px;"><i class="fa-solid fa-list-check"></i> Rincian Item:</strong>
                  <div style="display:flex;flex-direction:column;gap:6px;">
                    ${s.items.map(it => `
                      <div style="display:flex;justify-content:space-between;align-items:center;background:#fff;padding:6px 10px;border-radius:6px;border:1px solid #f1f5f9;font-size:12px;">
                        <span><strong>${escapeHtml(it.name || it.productName || '—')}</strong> <small style="color:#64748b;">(${formatNumber(it.qty)} x ${rupiah(it.price || it.unitPrice || 0)})</small></span>
                        <strong>${rupiah(it.subtotal || (num(it.qty) * num(it.price)))}</strong>
                      </div>
                    `).join("")}
                  </div>
                </div>
              ` : ''}
            </div>
          </div>
        `;
      }).join("");
      bindCardAccordions(cardList);
    }
  }
}

function renderProductsSoldSubReport(completedSales, products) {
  const tbody = $("report-products-body");
  const cardList = $("report-products-cards");

  const productsMap = new Map();
  products.forEach(p => productsMap.set(norm(p["Kode Produk"] || p.id), p));

  const soldMap = new Map();
  completedSales.forEach(s => {
    (s.items || []).forEach(it => {
      const code = norm(it.code || it.productCode || it.name);
      const existing = soldMap.get(code) || {
        code: it.code || it.productCode || "—",
        name: it.name || it.productName || "—",
        qty: 0,
        omzet: 0,
        cost: 0
      };
      const q = num(it.qty);
      const sub = num(it.subtotal || (q * num(it.price)));
      const pData = productsMap.get(code);
      const conv = num(pData?.["Konversi"] ?? pData?.["Isi Kemasan"] ?? 1) || 1;
      const buyPrice = num(it.buyPrice ?? it.costPrice ?? pData?.["Harga Beli Terakhir"] ?? pData?.["Harga Beli"] ?? 0) / conv;

      existing.qty += q;
      existing.omzet += sub;
      existing.cost += (q * buyPrice);
      soldMap.set(code, existing);
    });
  });

  const list = [...soldMap.values()].sort((a, b) => b.omzet - a.omzet);

  const countEl = $("report-products-count");
  if (countEl) countEl.textContent = `${list.length} produk`;

  if (tbody) {
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:24px;color:#94a3b8;">Belum ada produk terjual pada periode terpilih.</td></tr>`;
    } else {
      tbody.innerHTML = list.map(item => `
        <tr>
          <td>${escapeHtml(item.code)}</td>
          <td><strong>${escapeHtml(item.name)}</strong></td>
          <td>${formatNumber(item.qty)}</td>
          <td><strong>${rupiah(item.omzet)}</strong></td>
          <td>${rupiah(item.cost)}</td>
          <td style="color:#059669;font-weight:700;">${rupiah(item.omzet - item.cost)}</td>
        </tr>
      `).join("");
    }
  }

  if (cardList) {
    if (!list.length) {
      cardList.innerHTML = `<div style="text-align:center;padding:28px 16px;color:#94a3b8;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;"><i class="fa-solid fa-box" style="font-size:24px;margin-bottom:8px;display:block;"></i>Belum ada produk terjual pada periode terpilih.</div>`;
    } else {
      cardList.innerHTML = list.map(item => {
        const profit = item.omzet - item.cost;
        return `
          <div class="responsive-data-card card-purple">
            <div class="card-accordion-header" role="button" tabindex="0">
              <div class="card-header-main">
                <div class="card-title-row">
                  <span class="card-title">${escapeHtml(item.name)}</span>
                  <strong style="color:#059669;font-size:0.95rem;">${rupiah(item.omzet)}</strong>
                </div>
                <div class="card-meta-row">
                  <span class="card-meta-code">${escapeHtml(item.code)}</span>
                </div>
                <div class="card-kpi-strip">
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Total Omzet</span>
                    <span class="kpi-strip-val val-sell">${rupiah(item.omzet)}</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Qty Terjual</span>
                    <span class="kpi-strip-val">${formatNumber(item.qty)} unit</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Laba Bersih</span>
                    <span class="kpi-strip-val val-buy">${rupiah(profit)}</span>
                  </div>
                </div>
              </div>
              <div class="card-toggle-icon"><i class="fa-solid fa-chevron-down"></i></div>
            </div>
            <div class="card-accordion-body">
              <div class="card-detail-grid">
                <div class="card-detail-item">
                  <span class="card-detail-label">Kode Produk</span>
                  <span class="card-detail-value"><code>${escapeHtml(item.code)}</code></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Nama Produk</span>
                  <span class="card-detail-value"><strong>${escapeHtml(item.name)}</strong></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Kuantitas Terjual</span>
                  <span class="card-detail-value">${formatNumber(item.qty)} unit</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Total Omzet Bersih</span>
                  <span class="card-detail-value"><strong style="color:#0284c7;font-size:15px;">${rupiah(item.omzet)}</strong></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Estimasi Total HPP</span>
                  <span class="card-detail-value">${rupiah(item.cost)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Estimasi Laba Kotor</span>
                  <span class="card-detail-value"><strong style="color:#059669;font-size:15px;">${rupiah(profit)}</strong></span>
                </div>
              </div>
            </div>
          </div>
        `;
      }).join("");
      bindCardAccordions(cardList);
    }
  }
}

function renderInvoicesSubReport(invoices) {
  const tbody = $("report-invoices-body");
  const cardList = $("report-invoices-cards");

  if (tbody) {
    if (!invoices.length) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:28px 16px;color:#94a3b8;font-size:13px;"><i class="fa-solid fa-file-circle-xmark" style="font-size:22px;display:block;margin-bottom:8px;opacity:0.5;"></i>Belum ada faktur pembelian pada periode terpilih</td></tr>`;
    } else {
      tbody.innerHTML = invoices.map(inv => `
        <tr>
          <td>${inv.date || inv.invoiceDate || '—'}</td>
          <td><strong>${escapeHtml(inv.invoiceNumber || inv.id)}</strong></td>
          <td>${escapeHtml(inv.supplierName || inv.supplier || '—')}</td>
          <td>${(inv.items || []).length} item</td>
          <td><strong>${rupiah(inv.total)}</strong></td>
          <td>${escapeHtml(inv.status || 'Terkonfirmasi')}</td>
        </tr>
      `).join("");
    }
  }

  if (cardList) {
    if (!invoices.length) {
      cardList.innerHTML = `<div style="text-align:center;padding:28px 16px;color:#94a3b8;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;"><i class="fa-solid fa-file-invoice-dollar" style="font-size:24px;margin-bottom:8px;display:block;"></i>Belum ada faktur pembelian pada periode terpilih.</div>`;
    } else {
      cardList.innerHTML = invoices.map(inv => `
        <div class="responsive-data-card card-purple">
          <div class="card-accordion-header" role="button" tabindex="0">
            <div class="card-header-main">
              <div class="card-title-row">
                <span class="card-title">${escapeHtml(inv.invoiceNumber || inv.id)}</span>
                <span class="badge badge-success" style="padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;">
                  ${escapeHtml(inv.status || 'Terkonfirmasi')}
                </span>
              </div>
              <div class="card-meta-row">
                <span class="card-meta-code"><i class="fa-solid fa-truck" style="font-size:10px;"></i> ${escapeHtml(inv.supplierName || inv.supplier || '—')}</span>
                <span class="card-meta-dot">•</span>
                <span class="card-meta-sub"><i class="fa-regular fa-calendar" style="font-size:10px;"></i> ${inv.date || inv.invoiceDate || '—'}</span>
              </div>
              <div class="card-kpi-strip">
                <div class="kpi-strip-item">
                  <span class="kpi-strip-label">Total Faktur</span>
                  <span class="kpi-strip-val val-buy">${rupiah(inv.total)}</span>
                </div>
                <div class="kpi-strip-item">
                  <span class="kpi-strip-label">Jenis Item</span>
                  <span class="kpi-strip-val">${(inv.items || []).length} Item</span>
                </div>
                <div class="kpi-strip-item">
                  <span class="kpi-strip-label">Status</span>
                  <span class="kpi-strip-val val-sell">${escapeHtml(inv.status || 'Terkonfirmasi')}</span>
                </div>
              </div>
            </div>
            <div class="card-toggle-icon"><i class="fa-solid fa-chevron-down"></i></div>
          </div>
          <div class="card-accordion-body">
            <div class="card-detail-grid">
              <div class="card-detail-item">
                <span class="card-detail-label">Nomor Faktur</span>
                <span class="card-detail-value"><strong>${escapeHtml(inv.invoiceNumber || inv.id)}</strong></span>
              </div>
              <div class="card-detail-item">
                <span class="card-detail-label">Tanggal Faktur</span>
                <span class="card-detail-value">${inv.date || inv.invoiceDate || '—'}</span>
              </div>
              <div class="card-detail-item">
                <span class="card-detail-label">Supplier</span>
                <span class="card-detail-value"><strong>${escapeHtml(inv.supplierName || inv.supplier || '—')}</strong></span>
              </div>
              <div class="card-detail-item">
                <span class="card-detail-label">Jumlah Produk</span>
                <span class="card-detail-value">${(inv.items || []).length} jenis produk</span>
              </div>
              <div class="card-detail-item">
                <span class="card-detail-label">Total Nilai Faktur</span>
                <span class="card-detail-value"><strong style="color:#0284c7;font-size:15px;">${rupiah(inv.total)}</strong></span>
              </div>
              <div class="card-detail-item">
                <span class="card-detail-label">Status Faktur</span>
                <span class="card-detail-value"><span class="badge badge-success" style="padding:2px 6px;border-radius:4px;font-size:11px;">${escapeHtml(inv.status || 'Terkonfirmasi')}</span></span>
              </div>
            </div>
          </div>
        </div>
      `).join("");
      bindCardAccordions(cardList);
    }
  }
}

function renderStockSubReport(products) {
  const tbody = $("report-stock-body");
  const cardList = $("report-stock-cards");

  if (tbody) {
    if (!products.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:#94a3b8;">Tidak ada data stok produk.</td></tr>`;
    } else {
      tbody.innerHTML = products.slice(0, 100).map(p => {
        const code = p["Kode Produk"] || p.id;
        const stock = readCurrentStock(code);
        const conv = num(p["Konversi"] ?? p["Isi Kemasan"] ?? 1) || 1;
        const buy = num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0);
        const unitBuy = buy / conv;
        const buyUnit = p["Kemasan Beli"] || p["Satuan Pembelian"] || "";

        return `
          <tr>
            <td>${escapeHtml(code)}</td>
            <td><strong>${escapeHtml(p["Nama Produk"] || '—')}</strong></td>
            <td>${escapeHtml(p["Kategori"] || '—')}</td>
            <td><strong>${formatNumber(stock)}</strong> ${escapeHtml(p["Satuan Dasar"] || 'Pcs')}</td>
            <td>${formatNumber(p["Stok Minimum"] || 0)}</td>
            <td>${rupiah(unitBuy)}${conv > 1 ? `<small style="display:block;font-size:10px;color:#64748b;">(${rupiah(buy)}/${escapeHtml(buyUnit || 'Box')})</small>` : ''}</td>
            <td>${rupiah(Math.max(0, stock) * unitBuy)}</td>
            <td>${stock < 0 ? '<span class="text-danger font-bold">Minus</span>' : (stock <= num(p["Stok Minimum"]) ? '<span class="text-danger font-bold">Menipis</span>' : 'Aman')}</td>
          </tr>
        `;
      }).join("");
    }
  }

  if (cardList) {
    if (!products.length) {
      cardList.innerHTML = `<div style="text-align:center;padding:28px 16px;color:#94a3b8;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;"><i class="fa-solid fa-boxes-stacked" style="font-size:24px;margin-bottom:8px;display:block;"></i>Tidak ada data stok produk.</div>`;
    } else {
      cardList.innerHTML = products.slice(0, 100).map(p => {
        const code = p["Kode Produk"] || p.id;
        const stock = readCurrentStock(code);
        const conv = num(p["Konversi"] ?? p["Isi Kemasan"] ?? 1) || 1;
        const buy = num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0);
        const unitBuy = buy / conv;
        const buyUnit = p["Kemasan Beli"] || p["Satuan Pembelian"] || "";
        const minStock = num(p["Stok Minimum"] || 0);
        const val = Math.max(0, stock) * unitBuy;

        let accentClass = "card-success";
        let statusBadge = `<span class="badge badge-success" style="padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;">Aman</span>`;
        if (stock < 0) {
          accentClass = "card-danger";
          statusBadge = `<span class="badge badge-danger" style="background:#fee2e2;color:#991b1b;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;border:1px solid #f87171;">⚠️ Minus</span>`;
        } else if (stock === 0) {
          accentClass = "card-danger";
          statusBadge = `<span class="badge badge-danger" style="padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;">Habis</span>`;
        } else if (stock <= minStock) {
          accentClass = "card-warning";
          statusBadge = `<span class="badge badge-warning" style="padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;">Menipis</span>`;
        }

        return `
          <div class="responsive-data-card ${accentClass}">
            <div class="card-accordion-header" role="button" tabindex="0">
              <div class="card-header-main">
                <div class="card-title-row">
                  <span class="card-title">${escapeHtml(p["Nama Produk"] || '—')}</span>
                  ${statusBadge}
                </div>
                <div class="card-meta-row">
                  <span class="card-meta-code">${escapeHtml(code)}</span>
                  <span class="card-meta-dot">•</span>
                  <span class="card-meta-sub">${escapeHtml(p["Kategori"] || '—')}</span>
                </div>
                <div class="card-kpi-strip">
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Stok Fisik</span>
                    <span class="kpi-strip-val ${stock <= 0 ? 'stock-empty' : ''}">${formatNumber(stock)} <small>${escapeHtml(p["Satuan Dasar"] || 'Pcs')}</small></span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Nilai Aset</span>
                    <span class="kpi-strip-val val-buy">${rupiah(val)}</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Kategori</span>
                    <span class="kpi-strip-val">${escapeHtml(p["Kategori"] || 'Umum')}</span>
                  </div>
                </div>
              </div>
              <div class="card-toggle-icon"><i class="fa-solid fa-chevron-down"></i></div>
            </div>
            <div class="card-accordion-body">
              <div class="card-detail-grid">
                <div class="card-detail-item">
                  <span class="card-detail-label">Kode Produk</span>
                  <span class="card-detail-value"><code>${escapeHtml(code)}</code></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Kategori</span>
                  <span class="card-detail-value">${escapeHtml(p["Kategori"] || '—')}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Stok Fisik</span>
                  <span class="card-detail-value"><strong style="font-size:15px;color:#0f172a;">${formatNumber(stock)}</strong> ${escapeHtml(p["Satuan Dasar"] || 'Pcs')}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Stok Minimum</span>
                  <span class="card-detail-value">${formatNumber(minStock)} ${escapeHtml(p["Satuan Dasar"] || 'Pcs')}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Harga Beli Satuan</span>
                  <span class="card-detail-value">${rupiah(unitBuy)}${conv > 1 ? ` <small class="text-muted">(${rupiah(buy)}/${escapeHtml(buyUnit || 'Box')})</small>` : ''}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Total Nilai Stok</span>
                  <span class="card-detail-value"><strong style="color:#0284c7;font-size:15px;">${rupiah(val)}</strong></span>
                </div>
              </div>
            </div>
          </div>
        `;
      }).join("");
      bindCardAccordions(cardList);
    }
  }
}

function renderGoodsInSubReport(movements, invoices, start, end, q) {
  const tbody = $("report-goods-body");
  const cardList = $("report-goods-cards");

  const goodsMovements = (movements || []).filter(m => {
    const isGoodsIn = norm(m.type).includes("faktur") || norm(m.type).includes("masuk") || norm(m.type) === "purchase";
    if (!isGoodsIn) return false;
    const d = parseEntryDate(m.createdAt || m.date || m.at);
    if (d && (d < start || d > end)) return false;
    if (q) {
      const target = norm(`${m.reference || ''} ${m.productCode || ''} ${m.productName || ''}`);
      if (!target.includes(q)) return false;
    }
    return true;
  });

  const countEl = $("report-goods-count");
  if (countEl) countEl.textContent = `${goodsMovements.length} mutasi`;

  if (tbody) {
    if (!goodsMovements.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:#94a3b8;">Belum ada riwayat barang masuk pada periode terpilih.</td></tr>`;
    } else {
      tbody.innerHTML = goodsMovements.slice(0, 100).map(m => {
        const qty = num(m.delta ?? m.quantity);
        return `
          <tr>
            <td>${formatDateTime(m.createdAt || m.date)}</td>
            <td><strong>${escapeHtml(m.reference || '—')}</strong></td>
            <td>${escapeHtml(m.productCode || '—')}</td>
            <td><strong>${escapeHtml(m.productName || '—')}</strong></td>
            <td style="color:#059669;font-weight:700;">+${formatNumber(qty)}</td>
            <td>${m.stockAfter !== undefined ? formatNumber(m.stockAfter) : '—'}</td>
            <td>${rupiah(num(m.unitPrice || 0) * qty)}</td>
          </tr>
        `;
      }).join("");
    }
  }

  if (cardList) {
    if (!goodsMovements.length) {
      cardList.innerHTML = `<div style="text-align:center;padding:28px 16px;color:#94a3b8;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;"><i class="fa-solid fa-boxes-packing" style="font-size:24px;margin-bottom:8px;display:block;"></i>Belum ada riwayat barang masuk pada periode terpilih.</div>`;
    } else {
      cardList.innerHTML = goodsMovements.slice(0, 100).map(m => {
        const qty = num(m.delta ?? m.quantity);
        return `
          <div class="responsive-data-card card-success">
            <div class="card-accordion-header" role="button" tabindex="0">
              <div class="card-header-main">
                <div class="card-title-row">
                  <span class="card-title">${escapeHtml(m.productName || 'Barang Masuk')}</span>
                  <strong style="color:#059669;font-size:0.95rem;">+${formatNumber(qty)} unit</strong>
                </div>
                <div class="card-meta-row">
                  <span class="card-meta-code">Ref: ${escapeHtml(m.reference || '—')}</span>
                  <span class="card-meta-dot">•</span>
                  <span class="card-meta-sub"><i class="fa-regular fa-clock" style="font-size:10px;"></i> ${formatDateTime(m.createdAt || m.date)}</span>
                </div>
                <div class="card-kpi-strip">
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Jumlah Masuk</span>
                    <span class="kpi-strip-val val-sell">+${formatNumber(qty)} unit</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Kode Item</span>
                    <span class="kpi-strip-val">${escapeHtml(m.productCode || '—')}</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Referensi</span>
                    <span class="kpi-strip-val">${escapeHtml(m.reference || '—')}</span>
                  </div>
                </div>
              </div>
              <div class="card-toggle-icon"><i class="fa-solid fa-chevron-down"></i></div>
            </div>
            <div class="card-accordion-body">
              <div class="card-detail-grid">
                <div class="card-detail-item">
                  <span class="card-detail-label">Referensi / Faktur</span>
                  <span class="card-detail-value"><strong>${escapeHtml(m.reference || '—')}</strong></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Waktu Masuk</span>
                  <span class="card-detail-value">${formatDateTime(m.createdAt || m.date)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Kode & Nama Produk</span>
                  <span class="card-detail-value"><code>${escapeHtml(m.productCode || '—')}</code> - ${escapeHtml(m.productName || '—')}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Kuantitas Masuk</span>
                  <span class="card-detail-value"><strong style="color:#059669;font-size:15px;">+${formatNumber(qty)}</strong></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Stok Setelah Masuk</span>
                  <span class="card-detail-value">${m.stockAfter !== undefined ? formatNumber(m.stockAfter) : '—'}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Operator / Catatan</span>
                  <span class="card-detail-value">${escapeHtml(m.user || '—')}${m.batch ? ` (Batch: ${escapeHtml(m.batch)})` : ''}</span>
                </div>
              </div>
            </div>
          </div>
        `;
      }).join("");
      bindCardAccordions(cardList);
    }
  }
}

function renderCashiersSubReport(completedSales, filteredSales, productsMap) {
  const tbody = $("report-cashiers-body");
  const cardList = $("report-cashiers-cards");

  const cashierMap = new Map();

  filteredSales.forEach(s => {
    const cName = s.cashierName || s.cashier || "Kasir Utama";
    const existing = cashierMap.get(cName) || {
      name: cName,
      completedCount: 0,
      voidCount: 0,
      unitCount: 0,
      omzet: 0,
      profit: 0
    };

    if (norm(s.status) === "void") {
      existing.voidCount += 1;
    } else {
      existing.completedCount += 1;
      const sTotal = num(s.total);
      existing.omzet += sTotal;

      (s.items || []).forEach(it => {
        const q = num(it.qty);
        existing.unitCount += q;
        const sub = num(it.subtotal || (q * num(it.price)));
        const pData = productsMap?.get(norm(it.code || it.productCode));
        const conv = num(pData?.["Konversi"] ?? pData?.["Isi Kemasan"] ?? 1) || 1;
        const buyPrice = num(it.buyPrice ?? it.costPrice ?? pData?.["Harga Beli Terakhir"] ?? pData?.["Harga Beli"] ?? 0) / conv;
        existing.profit += (sub - (q * buyPrice));
      });
    }

    cashierMap.set(cName, existing);
  });

  const list = [...cashierMap.values()].sort((a, b) => b.omzet - a.omzet);

  const countEl = $("report-cashiers-count");
  if (countEl) countEl.textContent = `${list.length} kasir`;

  if (tbody) {
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:#94a3b8;">Belum ada data transaksi per kasir.</td></tr>`;
    } else {
      tbody.innerHTML = list.map(c => {
        const avg = c.completedCount > 0 ? c.omzet / c.completedCount : 0;
        return `
          <tr>
            <td><strong>${escapeHtml(c.name)}</strong></td>
            <td>${formatNumber(c.completedCount)}</td>
            <td>${formatNumber(c.voidCount)}</td>
            <td>${formatNumber(c.unitCount)}</td>
            <td><strong>${rupiah(c.omzet)}</strong></td>
            <td>${rupiah(avg)}</td>
            <td style="color:#059669;font-weight:700;">${rupiah(c.profit)}</td>
          </tr>
        `;
      }).join("");
    }
  }

  if (cardList) {
    if (!list.length) {
      cardList.innerHTML = `<div style="text-align:center;padding:28px 16px;color:#94a3b8;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;"><i class="fa-solid fa-user-tie" style="font-size:24px;margin-bottom:8px;display:block;"></i>Belum ada data transaksi per kasir.</div>`;
    } else {
      cardList.innerHTML = list.map(c => {
        const avg = c.completedCount > 0 ? c.omzet / c.completedCount : 0;
        return `
          <div class="responsive-data-card card-success">
            <div class="card-accordion-header" role="button" tabindex="0">
              <div class="card-header-main">
                <div class="card-title-row">
                  <span class="card-title">${escapeHtml(c.name)}</span>
                  <strong style="color:#059669;font-size:0.95rem;">${rupiah(c.omzet)}</strong>
                </div>
                <div class="card-meta-row">
                  <span class="card-meta-code"><i class="fa-solid fa-user-tie" style="font-size:10px;"></i> ${escapeHtml(c.name)}</span>
                </div>
                <div class="card-kpi-strip">
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Total Omzet</span>
                    <span class="kpi-strip-val val-sell">${rupiah(c.omzet)}</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Trx Selesai</span>
                    <span class="kpi-strip-val">${formatNumber(c.completedCount)} Trx (${formatNumber(c.unitCount)} unit)</span>
                  </div>
                  <div class="kpi-strip-item">
                    <span class="kpi-strip-label">Status VOID</span>
                    <span class="kpi-strip-val ${c.voidCount > 0 ? 'text-danger' : 'val-sell'}">${c.voidCount > 0 ? `${c.voidCount} VOID` : '0 VOID'}</span>
                  </div>
                </div>
              </div>
              <div class="card-toggle-icon"><i class="fa-solid fa-chevron-down"></i></div>
            </div>
            <div class="card-accordion-body">
              <div class="card-detail-grid">
                <div class="card-detail-item">
                  <span class="card-detail-label">Nama Kasir</span>
                  <span class="card-detail-value"><strong>${escapeHtml(c.name)}</strong></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Transaksi Selesai</span>
                  <span class="card-detail-value">${formatNumber(c.completedCount)} transaksi</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Transaksi VOID</span>
                  <span class="card-detail-value">${formatNumber(c.voidCount)} transaksi</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Produk Terjual</span>
                  <span class="card-detail-value">${formatNumber(c.unitCount)} unit</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Total Omzet Kasir</span>
                  <span class="card-detail-value"><strong style="color:#0284c7;font-size:15px;">${rupiah(c.omzet)}</strong></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Rata-rata Transaksi</span>
                  <span class="card-detail-value">${rupiah(avg)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Estimasi Laba Kotor</span>
                  <span class="card-detail-value"><strong style="color:#059669;font-size:15px;">${rupiah(c.profit)}</strong></span>
                </div>
              </div>
            </div>
          </div>
        `;
      }).join("");
      bindCardAccordions(cardList);
    }
  }
}

function handlePrintActiveReport() {
  const master = readStore(STORE_KEYS.master, {});
  const settings = master.pengaturan_toko?.[0] || {};
  const { start, end } = getDateRange();
  const periodLabel = $("report-period")?.selectedOptions?.[0]?.textContent || "Bulan Ini";

  if (activeReportTab === "sales" || activeReportTab === "summary" || activeReportTab === "products" || activeReportTab === "cashiers") {
    const sales = readStore(STORE_KEYS.sales, []);
    generateSalesReportPdf(sales, { periodLabel }, settings, "Administrator");
  } else if (activeReportTab === "invoices" || activeReportTab === "goods") {
    const invoices = readStore(STORE_KEYS.invoices, []);
    generatePurchaseReportPdf(invoices, { periodLabel }, settings, "Administrator");
  } else if (activeReportTab === "stock") {
    const prods = Array.isArray(master.produk) ? master.produk : [];
    const stockList = prods.map(p => {
      const conv = num(p["Konversi"] ?? p["Isi Kemasan"] ?? 1) || 1;
      const buyPrice = num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0);
      return {
        code: p["Kode Produk"] || p.id,
        name: p["Nama Produk"],
        category: p["Kategori"],
        stock: readCurrentStock(p["Kode Produk"]),
        minStock: p["Stok Minimum"],
        buyPrice: buyPrice / conv
      };
    });
    generateStockReportPdf(stockList, settings, "Administrator");
  }
}
