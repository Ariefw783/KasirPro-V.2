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
import { STORE_KEYS, readStore, writeStore, writeMasterDelta, executeFactoryHardReset } from "../modules/database/database-store.js";

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
  $("btn-factory-hard-reset")?.addEventListener("click", handleFactoryHardReset);

  document.addEventListener("click", (e) => {
    if (e.target.closest("#btn-factory-hard-reset")) {
      handleFactoryHardReset();
    }
  });
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

async function handleFactoryHardReset() {
  if (!navigator.onLine) {
    window.KasirProDialog?.error("Perangkat Offline", "Fitur Factory Reset membutuhkan koneksi internet aktif untuk membersihkan Cloud Firestore.");
    return;
  }

  const confirm1 = await window.KasirProDialog?.confirm(
    "⚠️ FACTORY HARD RESET (RESET TOTAL PABRIK)",
    "PERINGATAN TINGKAT TINGGI:\n\nTindakan ini akan mengosongkan SELURUH DATA SISTEM seperti pertama kali aplikasi dibuat:\n\n1. Seluruh Master Produk / Obat DIHAPUS TOTAL\n2. Seluruh Kategori & Supplier DIHAPUS TOTAL\n3. Seluruh Faktur Pembelian & Penjualan POS DIHAPUS TOTAL\n4. Seluruh Kartu Stok & Saldo Stok DIHAPUS TOTAL\n5. Database lokal IndexedDB & Cache peramban DIKOSONGKAN TOTAL\n\nAkun Administrator utama tetap aman agar Anda dapat login kembali.\n\nApakah Anda benar-benar yakin ingin melakukan Factory Reset sekarang?"
  );
  if (!confirm1) return;

  const confirm2 = await window.KasirProDialog?.confirm(
    "🔴 KONFIRMASI AKHIR - TIDAK DAPAT DIBATALKAN",
    "Semua master obat, supplier, faktur, dan transaksi akan LENYAP PERMANEN dari Cloud Firestore dan IndexedDB.\n\nApakah Anda yakin ingin mengeksekusi Factory Hard Reset sekarang?"
  );
  if (!confirm2) return;

  const btn = $("btn-factory-hard-reset");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Mengeksekusi Factory Reset...';
  }

  try {
    window.KasirProDialog?.showProgress(
      "Factory Hard Reset",
      "Memulai pembersihan total database...",
      { percent: 5, detail: "Menghubungkan ke Cloud Firestore..." }
    );

    const res = await executeFactoryHardReset({
      onProgress: (p) => {
        window.KasirProDialog?.updateProgress(p);
      }
    });

    window.KasirProDialog?.closeProgress();

    window.KasirProDialog?.success(
      "Factory Reset Berhasil!",
      `Seluruh data sistem berhasil dikosongkan secara permanen!\n\n• ${res.deletedDocuments} Dokumen Cloud Firestore dibersihkan\n• Database lokal IndexedDB & Cache browser telah dikosongkan total\n• Akun Administrator tetap aktif\n\nHalaman akan memuat ulang seketika ke kondisi awal bersih.`
    );

    setTimeout(() => {
      window.location.reload();
    }, 1500);
  } catch (err) {
    window.KasirProDialog?.closeProgress();
    console.error("[Settings] Gagal Factory Hard Reset:", err);
    window.KasirProDialog?.error("Gagal Factory Reset", err.message || "Terjadi kesalahan saat mengeksekusi Factory Reset.");
  } finally {
    window.KasirProDialog?.closeProgress();
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fa-solid fa-bomb"></i> Factory Hard Reset (Kosongkan Semua Data)';
    }
  }
}
