/**
 * management/management-settings.js
 * Manajemen Pengaturan Toko KasirPro V2
 * 
 * Sesuai Evaluasi:
 * - 100% UI-driven di halaman Pengaturan tanpa master Excel.
 * - HANYA 4 konfigurasi: Nama Apotek/Toko, Alamat Lengkap, Nomor Telepon, dan Ukuran Struk (58 mm, 80 mm, A4).
 * - Tidak ada upload logo atau pengaturan teknis database yang membingungkan.
 */

import { $, text } from "../modules/core/utils.js";
import { STORE_KEYS, readStore, writeStore, writeMasterDelta, purgeTestingTransactions, cloneMasterDataToSandbox } from "../modules/database/database-store.js";
import { getDatabaseEnvironment, setDatabaseEnvironment, DB_ENVIRONMENTS } from "../modules/database/database-paths.js";

export function initSettingsModule() {
  bindEvents();
  renderSettings();
  renderEnvironmentUI();
}

function bindEvents() {
  $("reload-store-settings")?.addEventListener("click", () => {
    renderSettings();
    window.KasirProDialog?.success("Berhasil", "Pengaturan toko berhasil dimuat ulang.");
  });

  $("store-settings-form")?.addEventListener("submit", handleSaveSettings);
  $("btn-purge-testing-data")?.addEventListener("click", handlePurgeTestingData);
  document.addEventListener("click", (e) => {
    if (e.target.closest("#btn-purge-testing-data")) {
      handlePurgeTestingData();
    }
    if (e.target.closest("#btn-banner-switch-prod")) {
      handleSwitchEnvironment("production");
    }
  });

  // Switcher Jalur Database
  document.querySelectorAll("input[name='db-environment-radio']").forEach(radio => {
    radio.addEventListener("change", (e) => {
      handleSwitchEnvironment(e.target.value);
    });
  });

  $("btn-clone-master-to-sandbox")?.addEventListener("click", handleCloneMasterToSandbox);
}

export function renderSettings() {
  const master = readStore(STORE_KEYS.master, {});
  const s = master.pengaturan_toko?.[0] || {};

  const nameInput = $("setting-store-name");
  if (nameInput) nameInput.value = s["Nama Toko"] || s["Nama Apotek"] || "Apotek Doa Ibu";

  const addrInput = $("setting-store-address");
  if (addrInput) addrInput.value = s["Alamat"] || "";

  const phoneInput = $("setting-store-phone");
  if (phoneInput) phoneInput.value = s["Telepon"] || s["No. Telepon"] || "";

  const sizeSelect = $("setting-receipt-size");
  if (sizeSelect) {
    const rawSize = String(s["Ukuran Struk"] || s["Lebar Kertas"] || "58 mm").toLowerCase().trim();
    if (rawSize.includes("80")) {
      sizeSelect.value = "80 mm";
    } else if (rawSize.includes("a4")) {
      sizeSelect.value = "A4";
    } else {
      sizeSelect.value = "58 mm";
    }
  }

  const footerInput = $("setting-receipt-footer");
  if (footerInput) footerInput.value = s["Footer Struk"] || s["Catatan Struk"] || "Terima kasih atas kunjungan Anda";

  const ds = $("settings-data-source");
  if (ds) ds.textContent = "Data pengaturan toko aktif.";
}

async function handleSaveSettings(e) {
  e?.preventDefault();

  const name = text($("setting-store-name")?.value) || "Apotek Doa Ibu";
  const address = text($("setting-store-address")?.value);
  const phone = text($("setting-store-phone")?.value);
  const receiptSize = $("setting-receipt-size")?.value || "58 mm";
  const receiptFooter = text($("setting-receipt-footer")?.value) || "Terima kasih atas kunjungan Anda";

  const master = readStore(STORE_KEYS.master, {});
  const currentSettings = master.pengaturan_toko?.[0] || {};

  const updatedSettings = {
    id: currentSettings.id || "current",
    key: currentSettings.key || "storeSettings",
    ...currentSettings,
    "Nama Toko": name,
    "Nama Apotek": name,
    "Alamat": address,
    "Telepon": phone,
    "No. Telepon": phone,
    "Ukuran Struk": receiptSize,
    "Lebar Kertas": receiptSize,
    "Footer Struk": receiptFooter,
    "Catatan Struk": receiptFooter
  };

  master.pengaturan_toko = [updatedSettings];

  try {
    await writeMasterDelta({ pengaturan_toko: [updatedSettings] });

    // Kirim notifikasi sinkronisasi lokal agar POS & halaman lain membaca nama toko & setting baru
    window.dispatchEvent(new CustomEvent("kasirpro:database-synced"));

    window.KasirProDialog?.success(
      "Pengaturan Disimpan",
      `Profil ${name} dan ukuran struk (${receiptSize}) berhasil disimpan dan disinkronkan ke seluruh sistem.`
    );
  } catch (err) {
    console.error("[Settings] Gagal menyimpan pengaturan toko:", err);
    window.KasirProDialog?.error("Gagal Menyimpan", err.message || "Terjadi kesalahan saat menyimpan pengaturan ke database.");
  }
}

async function handlePurgeTestingData() {
  if (!navigator.onLine) {
    window.KasirProDialog?.error("Perangkat Offline", "Fitur pembersihan data cloud membutuhkan koneksi internet aktif.");
    return;
  }

  const confirm1 = await window.KasirProDialog?.confirm(
    "Pembersihan Data Uji Coba",
    "PERINGATAN TINGKAT TINGGI:\n\nApakah Anda yakin ingin menghapus seluruh data transaksi uji coba?\n\nHal ini akan menghapus:\n1. Seluruh Faktur Pembelian yang pernah diinput\n2. Seluruh Riwayat Mutasi Kartu Stok\n3. Seluruh Riwayat Penjualan Kasir POS\n4. Mereset saldo stok seluruh produk ke 0\n\nMaster data produk dan supplier TIDAK AKAN terhapus."
  );
  if (!confirm1) return;

  const confirm2 = await window.KasirProDialog?.confirm(
    "Konfirmasi Akhir Pembersihan",
    "Data akan dihapus secara permanen dari Cloud Firestore dan IndexedDB perangkat. Tindakan ini TIDAK DAPAT DIBATALKAN.\n\nKetik 'YA' pada pikiran Anda dan lanjutkan pembersihan sekarang?"
  );
  if (!confirm2) return;

  const btn = $("btn-purge-testing-data");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sedang Membersihkan Database...';
  }

  try {
    window.KasirProDialog?.showProgress(
      "Pembersihan Data Uji Coba",
      "Memulai pembersihan data transaksi...",
      { percent: 5, detail: "Menghubungkan ke server database..." }
    );

    const res = await purgeTestingTransactions({
      clearInvoices: true,
      clearMovements: true,
      clearSales: true,
      clearOpnames: true,
      resetProductStock: true,
      onProgress: (p) => {
        window.KasirProDialog?.updateProgress(p);
      }
    });

    window.KasirProDialog?.closeProgress();

    window.KasirProDialog?.success(
      "Pembersihan Berhasil",
      `Database berhasil dibersihkan hingga ke akar Firestore!\n\n• ${res.deletedInvoices} Faktur dihapus\n• ${res.deletedMovements} Mutasi stok dibersihkan\n• ${res.deletedSales} Transaksi penjualan dihapus\n• ${res.deletedOpnames || 0} Sesi opname dibersihkan\n• Saldo stok produk telah direset ke 0 (Status kembali Tidak Aktif).`
    );

    // Refresh halaman agar seluruh cache dan tampilan bersih seketika
    setTimeout(() => {
      window.location.reload();
    }, 1200);
  } catch (err) {
    window.KasirProDialog?.closeProgress();
    console.error("[Settings] Gagal membersihkan data uji coba:", err);
    window.KasirProDialog?.error("Gagal Membersihkan", err.message || "Terjadi kesalahan saat membersihkan data.");
  } finally {
    window.KasirProDialog?.closeProgress();
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-trash-can"></i> Bersihkan Semua Data Uji Coba';
    }
  }
}

export function renderEnvironmentUI() {
  const currentEnv = getDatabaseEnvironment();
  const isSandbox = currentEnv === DB_ENVIRONMENTS.SANDBOX;

  const rProd = $("radio-env-prod");
  const rSand = $("radio-env-sand");
  const lProd = $("lbl-env-prod");
  const lSand = $("lbl-env-sand");
  const banner = $("banner-sandbox-mode");

  if (rProd) rProd.checked = !isSandbox;
  if (rSand) rSand.checked = isSandbox;

  if (lProd) {
    lProd.style.borderColor = !isSandbox ? "#10b981" : "#e2e8f0";
    lProd.style.background = !isSandbox ? "#f0fdf4" : "#fff";
  }
  if (lSand) {
    lSand.style.borderColor = isSandbox ? "#f59e0b" : "#e2e8f0";
    lSand.style.background = isSandbox ? "#fffbeb" : "#fff";
  }

  if (banner) {
    banner.style.display = isSandbox ? "flex" : "none";
  }
}

async function handleSwitchEnvironment(newEnv) {
  const currentEnv = getDatabaseEnvironment();
  if (newEnv === currentEnv) return;

  const isSwitchingToSandbox = newEnv === DB_ENVIRONMENTS.SANDBOX;
  const targetLabel = isSwitchingToSandbox ? "Database Pengujian (Sandbox)" : "Database Utama (Produksi)";
  const desc = isSwitchingToSandbox
    ? "Aplikasi akan beralih ke jalur 'Kasir Pro V2 / Toko Pengujian'. Seluruh transaksi, mutasi stok, dan faktur yang diinput tidak akan mempengaruhi database utama apotek.\n\nHalaman akan dimuat ulang untuk memuat database ini."
    : "Aplikasi akan kembali ke jalur 'Kasir Pro V2 / Toko Utama' untuk operasional riil apotek.\n\nHalaman akan dimuat ulang untuk memuat database ini.";

  const confirmed = await window.KasirProDialog?.confirm(
    `Beralih ke ${targetLabel}?`,
    desc
  );

  if (!confirmed) {
    renderEnvironmentUI();
    return;
  }

  setDatabaseEnvironment(newEnv);
  window.KasirProDialog?.success(
    "Lingkungan Diubah",
    `Berhasil beralih ke ${targetLabel}. Memuat ulang sistem...`
  );

  setTimeout(() => {
    window.location.reload();
  }, 900);
}

async function handleCloneMasterToSandbox() {
  if (!navigator.onLine) {
    window.KasirProDialog?.error("Perangkat Offline", "Koneksi internet aktif diperlukan untuk menyalin data ke Cloud Firestore.");
    return;
  }

  const goAhead = await window.KasirProDialog?.confirm(
    "Salin Master Data ke Sandbox",
    "Sistem akan menyalin seluruh Produk, Kategori, dan Supplier dari Database Utama ke Database Pengujian (Toko Pengujian).\n\nSaldo stok produk di Sandbox akan di-set ke 0 agar siap diuji coba dengan faktur pembelian.\n\nLanjutkan proses kloning sekarang?"
  );
  if (!goAhead) return;

  const btn = $("btn-clone-master-to-sandbox");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyalin Master Data...';
  }

  try {
    window.KasirProDialog?.showProgress(
      "Salin Master ke Sandbox",
      "Mempersiapkan penyalinan data...",
      { percent: 10, detail: "Menghubungkan ke Database Utama..." }
    );

    const res = await cloneMasterDataToSandbox((p) => {
      window.KasirProDialog?.updateProgress(p);
    });

    window.KasirProDialog?.closeProgress();
    window.KasirProDialog?.success(
      "Kloning Berhasil",
      `Berhasil menyalin ke Database Pengujian:\n\n• ${res.products} Master Produk\n• ${res.suppliers} Supplier\n• ${res.categories} Kategori\n\nStok produk di Sandbox berstatus 0 dan siap digunakan untuk uji coba faktur!`
    );
  } catch (err) {
    window.KasirProDialog?.closeProgress();
    console.error("[Settings] Gagal kloning master ke sandbox:", err);
    window.KasirProDialog?.error("Gagal Menyalin", err.message || "Terjadi kesalahan saat menyalin master data.");
  } finally {
    window.KasirProDialog?.closeProgress();
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-copy"></i> Salin Master ke Sandbox';
    }
  }
}
