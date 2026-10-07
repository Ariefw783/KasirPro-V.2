/**
 * management/management.js
 * Entry Point Utama Management KasirPro V2
 * 
 * Menggantikan seluruh patch lama (AT-07, AT-08, AT-10, AT-12, AT-14, dll)
 * dengan arsitektur modular satu sumber logika utama per domain.
 */

import "../app-dialog.js";
import { signOutKasirPro, waitForFirebaseUser } from "../modules/database/auth.js";
import { initializeDatabase, readStore, STORE_KEYS } from "../modules/database/database-store.js";

import { initDashboardModule, renderDashboard } from "./management-dashboard.js";
import { initProductsModule, renderProducts } from "./management-products.js";
import { initSuppliersModule, renderSuppliers } from "./management-suppliers.js";
import { initCategoriesModule, renderCategories } from "./management-categories.js";
import { initInvoicesModule, renderInvoices } from "./management-invoices.js";
import { initStockModule, renderStock, renderMovements } from "./management-stock.js";
import { initStockOpnameModule, renderOpnameHistory } from "./management-stock-opname.js";
import { initSalesModule, renderSales } from "./management-sales.js";
import { initReportsModule, renderReports } from "./management-reports.js";
import { initUsersModule, renderUsers } from "./management-users.js";
import { initSettingsModule, renderSettings } from "./management-settings.js";
import { initImportMasterModule } from "./management-import-master.js";

const $ = (id) => document.getElementById(id);

let currentActiveView = "dashboard";

async function bootManagement() {
  // 1. Verifikasi Sesi Pengguna
  if (!validateAdminSession()) return;

  // 2. Setup Navigasi Sidebar & Layout
  setupSidebarNavigation();
  setupMobileSidebar();
  setupLogout();

  // 3. Sembunyikan loader awal
  hideInitialLoader();

  // 4. Inisialisasi Seluruh Domain Controller secara aman & terisolasi (Instan 0ms)
  const modulesToInit = [
    { name: "Dashboard", fn: initDashboardModule },
    { name: "Products", fn: initProductsModule },
    { name: "Suppliers", fn: initSuppliersModule },
    { name: "Categories", fn: initCategoriesModule },
    { name: "Invoices", fn: initInvoicesModule },
    { name: "Stock", fn: initStockModule },
    { name: "StockOpname", fn: initStockOpnameModule },
    { name: "Sales", fn: initSalesModule },
    { name: "Reports", fn: initReportsModule },
    { name: "Users", fn: initUsersModule },
    { name: "Settings", fn: initSettingsModule },
    { name: "ImportMaster", fn: initImportMasterModule }
  ];

  modulesToInit.forEach(m => {
    try {
      m.fn();
    } catch (err) {
      console.warn(`[Management] Inisialisasi modul ${m.name}:`, err);
    }
  });

  // 5. Setup Event Listener Sinkronisasi Database
  window.addEventListener("kasirpro:database-synced", () => {
    console.log("[Management] Event kasirpro:database-synced diterima, menyegarkan tampilan:", currentActiveView);
    refreshCurrentView();
  });

  window.addEventListener("kasirpro:database-ready", () => {
    refreshCurrentView();
  });

  // 6. Setup Navigasi Sub-proses Khusus
  setupSubProcessNavigation();

  // 7. Set active view & render dashboard seketika (0ms)
  switchView("dashboard");
  try {
    renderDashboard();
  } catch (_) {}

  // 8. Inisialisasi Database (IndexedDB Cache + Cloud Firestore) Non-blocking
  try {
    const timeoutPromise = new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout init db")), 3000));
    await Promise.race([initializeDatabase(), timeoutPromise]);
    console.log("[Management] Database siap, data tersinkron.");
  } catch (err) {
    console.warn("[Management] Berjalan dengan data lokal:", err?.message || err);
  } finally {
    hideInitialLoader();
    try {
      renderDashboard();
    } catch (_) {}
  }
}

function setupSubProcessNavigation() {
  // Tombol Import Master dari halaman Produk
  $("btn-goto-import-master")?.addEventListener("click", () => {
    switchView("import-master");
  });

  // Tombol Kembali ke Produk dari halaman Import Master
  $("btn-back-to-products")?.addEventListener("click", () => {
    switchView("products");
  });

  // Tab Sub-panel Stok (Stok Saat Ini vs Riwayat Mutasi)
  const tabCurrent = $("tab-sub-stock-current");
  const tabMovements = $("tab-sub-stock-movements");
  const panelCurrent = $("panel-sub-stock-current");
  const panelMovements = $("panel-sub-stock-movements");

  tabCurrent?.addEventListener("click", () => {
    tabCurrent.className = "button button-primary";
    if (tabMovements) tabMovements.className = "button button-secondary";
    if (panelCurrent) panelCurrent.hidden = false;
    if (panelMovements) panelMovements.hidden = true;
    renderStock();
  });

  tabMovements?.addEventListener("click", () => {
    if (tabCurrent) tabCurrent.className = "button button-secondary";
    tabMovements.className = "button button-primary";
    if (panelCurrent) panelCurrent.hidden = true;
    if (panelMovements) panelMovements.hidden = false;
    renderMovements();
  });
}

function validateAdminSession() {
  try {
    const raw = sessionStorage.getItem("kasirpro_session");
    if (!raw) {
      location.replace("../index.html");
      return false;
    }
    const session = JSON.parse(raw);
    if (!session || session.role !== "admin") {
      if (session?.role === "cashier") {
        location.replace("../pos/index.html");
      } else {
        location.replace("../index.html");
      }
      return false;
    }
    const userNameEl = $("user-name") || $("current-user-name");
    if (userNameEl) userNameEl.textContent = session.name || session.username || "Administrator";
    return true;
  } catch (e) {
    location.replace("../index.html");
    return false;
  }
}

function hideInitialLoader() {
  const loader = $("app-loading");
  if (loader) {
    loader.hidden = true;
    loader.style.display = "none";
    loader.style.pointerEvents = "none";
  }
  const overlay = $("sidebar-overlay");
  if (overlay) {
    overlay.classList.remove("show");
    overlay.style.display = "none";
    overlay.style.pointerEvents = "none";
  }
}

function setupSidebarNavigation() {
  // Tombol navigasi menu utama & sub-item
  document.querySelectorAll("[data-view]").forEach(btn => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view;
      switchView(view);
    });
  });

  // Tombol grup menu collapsible (accordion)
  document.querySelectorAll("[data-group]").forEach(parentBtn => {
    parentBtn.addEventListener("click", () => {
      const groupName = parentBtn.dataset.group;
      const submenu = document.querySelector(`[data-submenu="${groupName}"]`);
      if (submenu) {
        const isExpanded = parentBtn.getAttribute("aria-expanded") === "true";
        parentBtn.setAttribute("aria-expanded", String(!isExpanded));
        submenu.hidden = isExpanded;
      }
    });
  });
}

function refreshCurrentView() {
  if (currentActiveView === "dashboard") renderDashboard();
  else if (currentActiveView === "products") renderProducts();
  else if (currentActiveView === "suppliers") renderSuppliers();
  else if (currentActiveView === "categories") renderCategories();
  else if (currentActiveView === "stock") {
    renderStock();
    renderMovements();
  }
  else if (currentActiveView === "goods-in") renderMovements();
  else if (currentActiveView === "stock-opname") renderOpnameHistory();
  else if (currentActiveView === "purchase-invoices") renderInvoices();
  else if (currentActiveView === "sales") renderSales();
  else if (currentActiveView === "reports") renderReports();
  else if (currentActiveView === "users") renderUsers();
  else if (currentActiveView === "settings") renderSettings();
}

export function switchView(targetView) {
  window.switchView = switchView;
  currentActiveView = targetView;

  // Update judul halaman di topbar
  const titles = {
    "dashboard": ["Dashboard", "Ringkasan operasional toko"],
    "products": ["DAFTAR PRODUK SUPPLIER", "Kelola master produk yang digunakan oleh Faktur, Stok, POS, dan Laporan"],
    "suppliers": ["Supplier", "Kelola master perusahaan supplier"],
    "categories": ["Kategori", "Kelola kategori pengelompokan produk"],
    "stock": ["Stok", "Posisi stok aktif dan riwayat pergerakan stok"],
    "goods-in": ["Riwayat Mutasi & Barang Masuk", "Riwayat arus stok masuk dan keluar"],
    "stock-opname": ["Stock Opname", "Pemeriksaan dan penyesuaian fisik persediaan"],
    "purchase-invoices": ["Faktur", "Kelola faktur pembelian dari supplier"],
    "sales": ["Transaksi Penjualan", "Riwayat transaksi POS dan cetak ulang"],
    "reports": ["Laporan", "Ringkasan penjualan, pembelian, dan stok"],
    "users": ["Pengguna", "Kelola akun pengguna dan hak akses"],
    "settings": ["Pengaturan", "Konfigurasi toko dan ukuran cetak struk"],
    "import-master": ["Import Master Produk", "Update master produk dari file Excel resmi (UPDATE mode)"],
    "import-opname": ["Import Hasil Stock Opname", "Unggah lembar hasil perhitungan fisik dan sesuaikan stok sistem"]
  };
  if (titles[targetView]) {
    const titleEl = $("page-title");
    const subEl = $("page-subtitle");
    if (titleEl) titleEl.textContent = titles[targetView][0];
    if (subEl) subEl.textContent = titles[targetView][1];
  }

  // Update status tombol navigasi
  document.querySelectorAll("[data-view]").forEach(btn => {
    const isActive = btn.dataset.view === targetView
      || (targetView === "import-master" && btn.dataset.view === "products")
      || (targetView === "import-opname" && btn.dataset.view === "stock-opname");
    btn.classList.toggle("active", isActive);

    // Buka parent submenu jika item aktif berada dalam submenu
    if (isActive) {
      const submenu = btn.closest(".nav-submenu");
      if (submenu) {
        submenu.hidden = false;
        const groupName = submenu.dataset.submenu;
        const parentBtn = document.querySelector(`[data-group="${groupName}"]`);
        if (parentBtn) parentBtn.setAttribute("aria-expanded", "true");
      }
    }
  });

  // Tampilkan section view yang bersesuaian, sembunyikan yang lain
  document.querySelectorAll("[data-view-section]").forEach(sec => {
    const isTarget = sec.dataset.viewSection === targetView;
    sec.hidden = !isTarget;
  });

  // Panggil penyegaran data spesifik per tampilan
  refreshCurrentView();

  closeMobileSidebar();
}

function setupMobileSidebar() {
  const toggleBtn = $("sidebar-toggle");
  const sidebar = $("sidebar");
  const overlay = $("sidebar-overlay");

  toggleBtn?.addEventListener("click", () => {
    sidebar?.classList.toggle("open");
    overlay?.classList.toggle("show");
  });

  overlay?.addEventListener("click", closeMobileSidebar);
}

function closeMobileSidebar() {
  $("sidebar")?.classList.remove("open");
  $("sidebar-overlay")?.classList.remove("show");
}

function setupLogout() {
  $("logout-button")?.addEventListener("click", async () => {
    const confirmed = await window.KasirProDialog?.confirm(
      "Keluar Aplikasi",
      "Apakah Anda yakin ingin keluar dari Administrator KasirPro?"
    );
    if (!confirmed) return;
    await signOutKasirPro();
    location.replace("../index.html");
  });
}

// Tutup loader & overlay seawal mungkin
hideInitialLoader();

// Jalankan saat dokumen siap
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootManagement);
} else {
  bootManagement();
}
