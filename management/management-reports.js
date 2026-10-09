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

  // Render Panel Aktif
  renderSalesSubReport(filteredSales);
  renderProductsSoldSubReport(completedSales, products);
  renderInvoicesSubReport(filteredInvoices);
  renderStockSubReport(products);
}

function renderSalesSubReport(salesList) {
  const tbody = $("report-sales-body");
  if (!tbody) return;

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

function renderProductsSoldSubReport(completedSales, products) {
  const tbody = $("report-products-body");
  if (!tbody) return;

  const soldMap = new Map();
  completedSales.forEach(s => {
    (s.items || []).forEach(it => {
      const code = norm(it.code || it.productCode || it.name);
      const existing = soldMap.get(code) || {
        code: it.code || it.productCode || "—",
        name: it.name || it.productName || "—",
        qty: 0,
        omzet: 0
      };
      existing.qty += num(it.qty);
      existing.omzet += num(it.subtotal || (num(it.qty) * num(it.price)));
      soldMap.set(code, existing);
    });
  });

  const list = [...soldMap.values()].sort((a, b) => b.omzet - a.omzet);

  tbody.innerHTML = list.map(item => `
    <tr>
      <td>${escapeHtml(item.code)}</td>
      <td><strong>${escapeHtml(item.name)}</strong></td>
      <td>${formatNumber(item.qty)}</td>
      <td><strong>${rupiah(item.omzet)}</strong></td>
      <td>—</td>
      <td>—</td>
    </tr>
  `).join("");
}

function renderInvoicesSubReport(invoices) {
  const tbody = $("report-invoices-body");
  if (!tbody) return;

  if (!invoices.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:28px 16px;color:#94a3b8;font-size:13px;"><i class="fa-solid fa-file-circle-xmark" style="font-size:22px;display:block;margin-bottom:8px;opacity:0.5;"></i>Belum ada faktur pembelian pada periode terpilih</td></tr>`;
    return;
  }

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

function renderStockSubReport(products) {
  const tbody = $("report-stock-body");
  if (!tbody) return;

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
