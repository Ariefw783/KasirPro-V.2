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
import { STORE_KEYS, readStore, writeStore, writeMasterDelta } from "../modules/database/database-store.js";

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
