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
import { STORE_KEYS, readStore, writeStore, writeMasterDelta, purgeTestingTransactions } from "../modules/database/database-store.js";

export function initSettingsModule() {
  bindEvents();
  renderSettings();
}

function bindEvents() {
  $("reload-store-settings")?.addEventListener("click", () => {
    renderSettings();
    window.KasirProDialog?.success("Berhasil", "Pengaturan toko berhasil dimuat ulang.");
  });

  $("store-settings-form")?.addEventListener("submit", handleSaveSettings);
  $("btn-purge-testing-data")?.addEventListener("click", handlePurgeTestingData);
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
    const res = await purgeTestingTransactions({
      clearInvoices: true,
      clearMovements: true,
      clearSales: true,
      clearOpnames: true,
      resetProductStock: true
    });

    window.KasirProDialog?.success(
      "Pembersihan Berhasil",
      `Database berhasil dibersihkan hingga ke akar Firestore!\n\n• ${res.deletedInvoices} Faktur dihapus\n• ${res.deletedMovements} Mutasi stok dibersihkan\n• ${res.deletedSales} Transaksi penjualan dihapus\n• ${res.deletedOpnames || 0} Sesi opname dibersihkan\n• Saldo stok produk telah direset ke 0 (Status kembali Tidak Aktif).`
    );

    // Refresh halaman agar seluruh cache dan tampilan bersih seketika
    setTimeout(() => {
      window.location.reload();
    }, 1200);
  } catch (err) {
    console.error("[Settings] Gagal membersihkan data uji coba:", err);
    window.KasirProDialog?.error("Gagal Membersihkan", err.message || "Terjadi kesalahan saat membersihkan data.");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-trash-can"></i> Bersihkan Semua Data Uji Coba';
    }
  }
}
