/**
 * management/management-dashboard.js
 * Dashboard KasirPro V2
 * 
 * ATURAN KETAT: JANGAN MENGUBAH DASHBOARD.
 * Modul ini menjaga dan merender seluruh KPI, periode, dan visual Dashboard persis seperti semula.
 */

import { $, num, text, norm, rupiah, formatNumber } from "../modules/core/utils.js";
import { STORE_KEYS, readStore, readCurrentStock } from "../modules/database/database-store.js";

let dashboardPeriod = "today";

export function initDashboardModule() {
  bindDashboardEvents();
  renderDashboard();

  window.addEventListener("kasirpro:database-synced", renderDashboard);
  window.addEventListener("kasirpro:database-ready", renderDashboard);
  window.addEventListener("kasirpro:stock-updated", renderDashboard);
}

function bindDashboardEvents() {
  document.querySelectorAll("[data-dashboard-period]").forEach((button) => {
    button.addEventListener("click", () => {
      dashboardPeriod = button.dataset.dashboardPeriod || "today";
      renderDashboard();
    });
  });
}

function dashboardPeriodLabel() {
  switch (dashboardPeriod) {
    case "week": return "7 Hari Terakhir";
    case "month": return "Bulan Ini";
    case "all": return "Semua Data";
    case "today":
    default: return "Hari Ini";
  }
}

function dashboardDateMatches(dateValue, forcedPeriod = null) {
  const period = forcedPeriod || dashboardPeriod;
  if (!dateValue || period === "all") return true;

  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return true;

  const now = new Date();
  if (period === "today") {
    return date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
  }

  if (period === "week") {
    const diffTime = Math.abs(now.getTime() - date.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays <= 7;
  }

  if (period === "month") {
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  }

  return true;
}

export function renderDashboard() {
  const store = readStore(STORE_KEYS.master, {});
  const products = Array.isArray(store.produk) ? store.produk : [];
  const suppliers = Array.isArray(store.supplier) ? store.supplier : [];
  const sales = readStore(STORE_KEYS.sales, []);
  const invoices = readStore(STORE_KEYS.invoices, []);

  const completed = sales.filter((sale) => norm(sale?.status) !== "void");
  const filteredSales = completed.filter((sale) => dashboardDateMatches(sale?.at || sale?.createdAt));
  const voidSales = sales.filter((sale) => norm(sale?.status) === "void" && dashboardDateMatches(sale?.voidAt || sale?.at || sale?.createdAt));
  const filteredInvoices = invoices.filter((invoice) => dashboardDateMatches(invoice?.confirmedAt || invoice?.date || invoice?.createdAt));

  const now = new Date();
  now.setHours(23, 59, 59, 999);
  const dueInvoices = invoices.filter((invoice) => {
    const due = new Date(invoice?.dueDate);
    return (norm(invoice?.status) === "terkonfirmasi" || norm(invoice?.status) === "confirmed")
      && norm(invoice?.paymentType) === "tempo"
      && !Number.isNaN(due.getTime())
      && due <= now;
  });

  const lowStock = products.filter((product) => {
    const code = product["Kode Produk"] || product.id;
    const stock = readCurrentStock(code);
    const minimum = num(product?.["Stok Minimum"]);
    return stock <= 0 || (minimum > 0 && stock <= minimum);
  }).length;

  const pendingInvoices = invoices.filter((invoice) => norm(invoice?.status) === "perlu review" || norm(invoice?.status) === "draft").length;
  const totalRevenue = filteredSales.reduce((sum, sale) => sum + num(sale?.total), 0);

  // Estimasi laba
  const salesProfit = filteredSales.reduce((sum, sale) => {
    const items = sale.items || [];
    const profit = items.reduce((iSum, it) => {
      const sell = num(it.subtotal || (num(it.qty) * num(it.price)));
      const buy = num(it.buyPrice || 0) * num(it.qty);
      return iSum + Math.max(0, sell - buy);
    }, 0);
    return sum + profit;
  }, 0);

  const purchaseInvoiceValue = filteredInvoices.reduce((sum, invoice) => sum + num(invoice?.total), 0);

  let stockValue = 0;
  let totalItems = 0;
  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const code = product["Kode Produk"] || product.id;
    const stock = readCurrentStock(code);
    if (stock > 0) {
      totalItems += stock;
      const conv = num(product?.["Konversi"] ?? product?.["Isi Kemasan"] ?? 1) || 1;
      const buyPrice = num(product?.["Harga Beli Terakhir"] ?? product?.["Harga Beli"] ?? 0);
      const unitBuyPrice = buyPrice / conv;
      stockValue += (stock * unitBuyPrice);
    }
  }

  const todaySales = completed.filter((sale) => dashboardDateMatches(sale?.at || sale?.createdAt, "today")).length;

  const set = (id, value) => {
    const el = $(id);
    if (el) el.textContent = String(value);
  };

  set("dashboard-period-label", dashboardPeriodLabel());
  document.querySelectorAll("[data-dashboard-period]").forEach((button) => {
    button.classList.toggle("active", button.dataset.dashboardPeriod === dashboardPeriod);
  });

  set("dashboard-total-revenue", rupiah(totalRevenue));
  set("dashboard-sales-profit", rupiah(salesProfit));
  set("dashboard-purchase-invoice-value", rupiah(purchaseInvoiceValue));
  set("dashboard-supplier-due", rupiah(dueInvoices.reduce((sum, inv) => sum + num(inv.total), 0)));
  set("dashboard-supplier-due-note", `${dueInvoices.length} faktur tempo jatuh tempo.`);
  set("dashboard-stock-value", rupiah(stockValue));
  set("dashboard-total-products", products.length);
  set("dashboard-total-stock", formatNumber(totalItems));
  set("dashboard-total-suppliers", suppliers.length);
  set("dashboard-sales-today", todaySales);
  set("dashboard-low-stock", lowStock);
  set("dashboard-draft-invoices", pendingInvoices);
  set("dashboard-void-sales", voidSales.length);
  set("dashboard-review-count", `${lowStock + pendingInvoices + voidSales.length} perhatian`);
}
