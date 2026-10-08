/**
 * management/management-invoices.js
 * Manajemen Faktur Pembelian KasirPro V2
 * 
 * Sesuai Spesifikasi Tahap 3:
 * 1. Workflow HANYA melalui Import Excel hasil GPT (Download Template, Pilih File, Validasi, Preview, Konfirmasi).
 * 2. Tidak ada manual entry sebagai alur utama, tidak ada status Draft.
 * 3. Status: Perlu Review -> Siap Konfirmasi -> Terkonfirmasi -> Dibatalkan.
 * 4. Toleransi nominal selisih maksimal Rp10.
 * 5. Cek duplikasi nomor faktur: tolak jika nomor faktur sudah pernah dikonfirmasi.
 * 6. Tidak ada stok per batch / FEFO; batch dan EXP hanya info historis.
 * 7. Konfirmasi Faktur: Atomic penambahan stok satuan dasar, pencatatan movement "Faktur Masuk",
 *    dan update Harga Beli Terakhir (sebelum diskon & PPN).
 * 8. Koreksi Faktur: Dua metode (Administratif & Transaksional).
 * 9. Pembatalan Faktur: Reversal via stock movement (bukan destructive delete).
 * 10. Cetak PDF Faktur resmi A4 Portrait.
 */

import { $, num, parseMoney, text, norm, rupiah, formatNumber, escapeHtml, nowIso, uid, INVOICE_TOLERANCE_RP, normalizeProductName, findBestProductMatch, stringSimilarity } from "../modules/core/utils.js";
import { STORE_KEYS, readStore, writeStore, writeMasterDelta, readCurrentStock, writeStockTransaction, databaseStore, deletePurchaseInvoice } from "../modules/database/database-store.js";
import { generatePurchaseInvoicePdf } from "../modules/core/pdf.js";

let currentInvoices = [];
let activeDetailInvoice = null;

export function initInvoicesModule() {
  bindEvents();
  renderInvoices();
}

function bindEvents() {
  // Tombol Input Faktur Manual
  $("btn-open-manual-invoice")?.addEventListener("click", () => {
    openManualInvoiceModal();
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest("#btn-open-manual-invoice")) {
      openManualInvoiceModal();
    }
  });
  $("close-manual-invoice-modal")?.addEventListener("click", closeManualInvoiceModal);
  $("btn-cancel-manual-inv")?.addEventListener("click", closeManualInvoiceModal);
  $("btn-manual-add-row")?.addEventListener("click", () => addManualInvoiceRow());
  $("btn-paste-tsv-inv")?.addEventListener("click", handleTriggerPasteTsv);
  $("btn-close-paste-tsv-modal")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closePasteTsvModal();
  });
  $("btn-cancel-paste-tsv")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closePasteTsvModal();
  });
  $("modal-paste-tsv")?.addEventListener("click", (e) => {
    if (e.target === $("modal-paste-tsv")) {
      closePasteTsvModal();
    }
  });

  // Delegasi klik fallback untuk menutup modal paste TSV jika event langsung terlewat
  document.addEventListener("click", (e) => {
    if (e.target.closest("#btn-close-paste-tsv-modal") || e.target.closest("#btn-cancel-paste-tsv")) {
      e.preventDefault();
      closePasteTsvModal();
    }
  });

  $("btn-do-paste-tsv")?.addEventListener("click", () => {
    const textVal = $("tsv-paste-textarea")?.value;
    closePasteTsvModal();
    if (textVal) {
      processTsvData(textVal);
    }
  });

  // Shortcut Paste (Ctrl + V / Cmd + V) & Escape saat modal faktur aktif
  document.addEventListener("keydown", (e) => {
    // Escape untuk menutup modal paste TSV jika terbuka
    if (e.key === "Escape") {
      const pasteModal = $("modal-paste-tsv");
      if (pasteModal && !pasteModal.hidden) {
        e.preventDefault();
        closePasteTsvModal();
        return;
      }
    }

    const modalInv = $("modal-manual-invoice");
    if (!modalInv || modalInv.hidden) return;

    // Jika modal fallback paste sudah terbuka, biarkan textarea menangani paste secara native
    const pasteModal = $("modal-paste-tsv");
    if (pasteModal && !pasteModal.hidden) return;

    const activeEl = document.activeElement;
    const isTextInput = activeEl && (
      activeEl.tagName === "INPUT" ||
      activeEl.tagName === "TEXTAREA" ||
      activeEl.isContentEditable
    );

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") {
      // Jika pengguna TIDAK sedang fokus pada input field tertentu, jalankan pembacaan clipboard otomatis
      if (!isTextInput) {
        e.preventDefault();
        handleTriggerPasteTsv();
      }
    }
  });

  $("btn-quick-add-supplier-inv")?.addEventListener("click", handleQuickAddSupplierInv);
  $("manual-inv-supplier")?.addEventListener("change", handleSupplierChange);
  $("manual-inv-payment-type")?.addEventListener("change", handlePaymentTypeChange);
  $("manual-inv-date")?.addEventListener("change", handleInvoiceDateChange);
  $("manual-inv-discount-type")?.addEventListener("change", handleDiscountTypeChange);
  $("manual-inv-ppn-rate")?.addEventListener("change", handlePpnRateChange);

  // Auto format titik live pada input header mata uang
  const setupLiveCurrencyInput = (elId) => {
    const el = $(elId);
    if (!el) return;
    el.addEventListener("input", (e) => {
      const digits = e.target.value.replace(/[^0-9]/g, "");
      const valNum = parseInt(digits, 10) || 0;
      e.target.value = valNum ? formatNumber(valNum) : "";
      calculateManualInvoiceTotals();
    });
    el.addEventListener("focus", (e) => e.target.select());
  };

  setupLiveCurrencyInput("manual-inv-printed-total");
  setupLiveCurrencyInput("manual-inv-global-discount-rp");
  setupLiveCurrencyInput("manual-inv-custom-ppn-rp");

  $("btn-save-manual-draft")?.addEventListener("click", handleSaveManualDraft);
  $("btn-reset-manual-inv")?.addEventListener("click", handleResetManualInvoice);
  $("btn-confirm-manual-inv")?.addEventListener("click", handleConfirmManualInvoice);

  // Close floating autocomplete on click outside or on scroll
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".row-prod-search") && !e.target.closest("#manual-inv-global-ac")) {
      hideGlobalAc();
    }
  });

  document.querySelector(".manual-invoice-body")?.addEventListener("scroll", hideGlobalAc);

  // Search & Filter di daftar faktur
  $("invoice-search")?.addEventListener("input", renderInvoicesTable);
  $("invoice-status-filter")?.addEventListener("change", renderInvoicesTable);

  // Detail Modal Actions
  installInvoiceDetailModal();
  installInvoiceCorrectionModal();
}

export function renderInvoices() {
  const invs = readStore(STORE_KEYS.invoices, []);
  currentInvoices = Array.isArray(invs) ? invs : [];
  updateKpis();
  renderInvoicesTable();
}

function updateKpis() {
  const totalCount = currentInvoices.length;
  const reviewCount = currentInvoices.filter(i => norm(i.status) === "perlu review" || norm(i.status) === "siap konfirmasi").length;
  const confirmedCount = currentInvoices.filter(i => norm(i.status) === "terkonfirmasi" || norm(i.status) === "confirmed").length;
  const totalValue = currentInvoices
    .filter(i => norm(i.status) === "terkonfirmasi" || norm(i.status) === "confirmed")
    .reduce((sum, i) => sum + num(i.total), 0);

  const cEl = $("invoice-count");
  if (cEl) cEl.textContent = totalCount;

  const dEl = $("invoice-draft-count");
  if (dEl) {
    // Ubah label di UI jika ada
    dEl.textContent = reviewCount;
    const parentLabel = dEl.parentElement?.querySelector("span");
    if (parentLabel) parentLabel.textContent = "Review / Pending";
  }

  const confEl = $("invoice-confirmed-count");
  if (confEl) confEl.textContent = confirmedCount;

  const valEl = $("invoice-value-total");
  if (valEl) valEl.textContent = rupiah(totalValue);
}

function renderInvoicesTable() {
  const tbody = $("invoice-table-body");
  if (!tbody) return;

  const q = norm($("invoice-search")?.value);
  const statusFilter = norm($("invoice-status-filter")?.value);

  const filtered = currentInvoices.filter(inv => {
    const no = norm(inv.invoiceNumber || inv.id);
    const sup = norm(inv.supplierName || inv.supplier);
    const status = norm(inv.status);

    if (q && !no.includes(q) && !sup.includes(q)) return false;
    if (statusFilter && status !== statusFilter) return false;
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-table-state" style="text-align:center;padding:24px;">Tidak ada faktur pembelian yang ditemukan.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(inv => {
    const id = inv.id || inv.invoiceNumber;
    const no = inv.invoiceNumber || inv.id || "—";
    const date = inv.date || inv.invoiceDate || "—";
    const sup = inv.supplierName || inv.supplier || "—";
    const itemCount = (inv.items || []).length;
    const total = num(inv.total);
    const status = inv.status || "Perlu Review";

    return `
      <tr>
        <td><strong>${escapeHtml(no)}</strong></td>
        <td>${escapeHtml(date)}</td>
        <td>${escapeHtml(sup)}</td>
        <td>${itemCount} item</td>
        <td><strong>${rupiah(total)}</strong></td>
        <td>${getInvoiceStatusBadge(status)}</td>
        <td>
          <div style="display:flex;gap:6px;">
            <button type="button" class="btn-detail-invoice button button-small button-secondary" data-id="${escapeHtml(id)}">
              <i class="fa-solid fa-eye"></i> Detail
            </button>
            <button type="button" class="btn-pdf-invoice button button-small button-secondary" data-id="${escapeHtml(id)}" title="Cetak PDF">
              <i class="fa-solid fa-file-pdf"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".btn-detail-invoice").forEach(btn => {
    btn.addEventListener("click", () => {
      const invId = btn.dataset.id;
      const found = currentInvoices.find(i => (i.id || i.invoiceNumber) === invId);
      if (found) openInvoiceDetailModal(found);
    });
  });

  tbody.querySelectorAll(".btn-pdf-invoice").forEach(btn => {
    btn.addEventListener("click", () => {
      const invId = btn.dataset.id;
      const found = currentInvoices.find(i => (i.id || i.invoiceNumber) === invId);
      if (found) handlePrintInvoicePdf(found);
    });
  });
}

function getInvoiceStatusBadge(status) {
  const s = norm(status);
  if (s === "terkonfirmasi" || s === "confirmed") {
    return `<span class="badge badge-success" style="background:#ecfdf5;color:#059669;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;"><i class="fa-solid fa-circle-check"></i> Terkonfirmasi</span>`;
  }
  if (s === "siap konfirmasi") {
    return `<span class="badge badge-primary" style="background:#eff6ff;color:#2563eb;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;"><i class="fa-solid fa-circle-dot"></i> Siap Konfirmasi</span>`;
  }
  if (s === "dibatalkan" || s === "cancelled") {
    return `<span class="badge badge-danger" style="background:#fef2f2;color:#dc2626;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;"><i class="fa-solid fa-ban"></i> Dibatalkan</span>`;
  }
  return `<span class="badge badge-warning" style="background:#fff7ed;color:#ea580c;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;"><i class="fa-solid fa-triangle-exclamation"></i> Perlu Review</span>`;
}



export async function executeConfirmInvoice(inv) {
  if (inv.selisih > INVOICE_TOLERANCE_RP) {
    const goAhead = await window.KasirProDialog?.confirm(
      "Peringatan Selisih Nominal",
      `Faktur memiliki selisih nominal Rp${inv.selisih} (melebihi toleransi Rp10).\nApakah Anda yakin ingin tetap memproses dan mengonfirmasi faktur ini?`
    );
    if (!goAhead) return false;
  }

  const confirmed = await window.KasirProDialog?.confirm(
    "Konfirmasi Faktur Masuk",
    `Apakah Anda yakin ingin mengonfirmasi Faktur #${inv.invoiceNumber} dari ${inv.supplierName}?\nStok produk akan bertambah di satuan dasar dan Harga Beli Terakhir akan diperbarui.`
  );
  if (!confirmed) return false;

  try {
    const master = readStore(STORE_KEYS.master, {});
    const existingInvoices = readStore(STORE_KEYS.invoices, []);
    const movements = [];
    const products = Array.isArray(master.produk) ? [...master.produk] : [];
    const suppliers = Array.isArray(master.supplier) ? [...master.supplier] : [];

    // Lacak record yang berubah supaya penyimpanan hanya menulis yang terdampak
    const touchedProducts = new Map();
    const touchedSuppliers = [];

    const now = nowIso();
    const user = "Admin";

    // 1. Pastikan supplier terdaftar
    if (inv.supplierName && !suppliers.some(s => norm(s["Nama Perusahaan"] || s["Supplier"]) === norm(inv.supplierName))) {
      const newSupplier = {
        id: `SUP-${Date.now()}`,
        "Nama Perusahaan": inv.supplierName,
        "Supplier": inv.supplierName,
        "Status": "Aktif",
        "status": "Aktif"
      };
      suppliers.push(newSupplier);
      touchedSuppliers.push(newSupplier);
      master.supplier = suppliers;
    }

    // 2. Proses tiap item: tambah stok, catat movement, update harga beli & konversi
    for (const item of inv.items) {
      const convRatio = num(item.conversionRatio) || 1;
      const baseQtyAdded = num(item.qty) * convRatio;

      let prodIdx = products.findIndex(p => {
        if (item.matchedProductCode) return norm(p["Kode Produk"]) === norm(item.matchedProductCode);
        if (item.productCode) return norm(p["Kode Produk"]) === norm(item.productCode);
        if (item.barcode && p["Barcode"]) return norm(p["Barcode"]) === norm(item.barcode);
        return norm(p["Nama Produk"]) === norm(item.name);
      });

      let targetProd = null;
      if (prodIdx >= 0) {
        targetProd = products[prodIdx];

        // Perbarui konversi ke Master Produk jika diisi di faktur
        if (convRatio > 1 || item.purchaseUnit) {
          targetProd["Satuan Pembelian"] = item.purchaseUnit || targetProd["Satuan Pembelian"] || "Box";
          targetProd["Kemasan Beli"] = item.purchaseUnit || targetProd["Kemasan Beli"] || "Box";
          targetProd["Konversi"] = convRatio;
          targetProd["Isi Kemasan"] = convRatio;
          targetProd["Satuan Dasar"] = item.baseUnit || targetProd["Satuan Dasar"] || "Pcs";
          targetProd["Satuan"] = item.baseUnit || targetProd["Satuan"] || "Pcs";
          if (item.intermediateUnit) {
            targetProd["Satuan Antara"] = item.intermediateUnit;
            targetProd["Isi Satuan Antara"] = num(item.intermediateQty) || 1;
          }
        }
      } else {
        // Produk Baru dari Faktur
        const newCode = `PRD-${Date.now().toString().slice(-5)}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
        targetProd = {
          id: newCode,
          "Kode Produk": newCode,
          "Kode Produk Internal": newCode,
          "Barcode": item.barcode || "",
          "Nama Produk": item.name,
          "Kategori": "Umum",
          "Supplier": inv.supplierName,
          "Produsen": item.manufacturer || inv.supplierName || "",
          "Harga Beli Terakhir": num(item.buyPrice),
          "Harga Beli": num(item.buyPrice),
          "Harga Jual": 0, // Wajib diisi manual di Master Produk
          "Satuan Pembelian": item.purchaseUnit || "Box",
          "Kemasan Beli": item.purchaseUnit || "Box",
          "Konversi": convRatio,
          "Isi Kemasan": convRatio,
          "Satuan Dasar": item.baseUnit || "Pcs",
          "Satuan": item.baseUnit || "Pcs",
          "Satuan Antara": item.intermediateUnit || item.baseUnit || "Pcs",
          "Isi Satuan Antara": num(item.intermediateQty) || 1,
          "Stok Minimum": 5,
          "Stok Awal": 0,
          "Status": "Perlu Harga Jual",
          "Status Produk": "Perlu Harga Jual"
        };
        products.push(targetProd);
        prodIdx = products.length - 1;
      }

      // Update Harga Beli Terakhir
      targetProd["Harga Beli Terakhir"] = num(item.buyPrice);
      targetProd["Harga Beli"] = num(item.buyPrice);
      targetProd["Supplier"] = inv.supplierName;
      touchedProducts.set(targetProd["Kode Produk"], targetProd);

      // Catat mutasi stok
      const movementId = uid("mov-inv");
      movements.push({
        id: movementId,
        productCode: targetProd["Kode Produk"],
        productName: targetProd["Nama Produk"],
        type: "Faktur Masuk",
        delta: baseQtyAdded,
        quantity: baseQtyAdded,
        source: "Faktur Pembelian",
        reference: inv.invoiceNumber,
        user,
        batch: item.batch || "",
        expiryDate: item.expiryDate || "",
        createdAt: now
      });
    }

    master.produk = products;

    // 3. Simpan Faktur Terkonfirmasi
    const confirmedInvoice = {
      ...inv,
      status: "Terkonfirmasi",
      confirmedAt: now,
      confirmedBy: user
    };

    const nextInvoices = [...existingInvoices, confirmedInvoice];

    // Eksekusi transaksi atomik
    await writeStockTransaction([
      { key: STORE_KEYS.invoices, records: [confirmedInvoice] },
      { key: STORE_KEYS.movements, records: movements }
    ]);

    // Ambil stok terbaru
    for (const [code, prod] of touchedProducts) {
      prod["Stok Awal"] = readCurrentStock(code);
    }

    await writeMasterDelta({
      produk: [...touchedProducts.values()],
      supplier: touchedSuppliers
    });

    // Hapus draft manual jika ada
    try { localStorage.removeItem(MANUAL_DRAFT_KEY); } catch (e) {}

    // Tutup modal manual jika sedang terbuka
    try { closeManualInvoiceModal(); } catch (e) {}

    // Kembali ke daftar faktur
    try {
      if (window.switchView) {
        window.switchView("purchase-invoices");
      } else {
        const invNav = document.querySelector('[data-view="purchase-invoices"]');
        if (invNav) invNav.click();
      }
      renderInvoices();
    } catch (e) {}

    window.KasirProDialog?.success(
      "Faktur Berhasil Dikonfirmasi",
      `Faktur #${inv.invoiceNumber} berhasil dikonfirmasi sebagai Barang Masuk.\nStok telah diperbarui secara otomatis.`
    );
    return true;
  } catch (err) {
    console.error("[Invoices] Error confirming invoice:", err);
    window.KasirProDialog?.error("Gagal Konfirmasi Faktur", err.message || "Terjadi kesalahan saat memproses faktur.");
    return false;
  }
}

/* ==========================================================================
   KONTROLLER INPUT FAKTUR MANUAL (GRID MODE DENGAN REKONSILIASI MATEMATIKA)
   ========================================================================== */

let manualInvoiceItems = [];
const MANUAL_DRAFT_KEY = "kasirpro_manual_invoice_draft_v2";
let cachedMasterProducts = null;
let prodSearchDebounceTimer = null;

export function openManualInvoiceModal() {
  const modal = $("modal-manual-invoice");
  if (!modal) return;

  // Cache data produk untuk performa instan saat pencarian di modal faktur
  cachedMasterProducts = readStore(STORE_KEYS.master, {})?.produk || [];

  populateManualInvoiceSupplierDropdown();

  const dateInput = $("manual-inv-date");
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().slice(0, 10);
  }

  // Coba pulihkan draft jika ada
  let hasDraft = false;
  try {
    const raw = localStorage.getItem(MANUAL_DRAFT_KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && Array.isArray(d.items) && d.items.length > 0) {
        if ($("manual-inv-supplier")) $("manual-inv-supplier").value = d.supplierName || "";
        if ($("manual-inv-number")) $("manual-inv-number").value = d.invoiceNumber || "";
        if ($("manual-inv-date")) $("manual-inv-date").value = d.date || "";
        if ($("manual-inv-payment-type")) $("manual-inv-payment-type").value = d.paymentType || "tempo";
        if ($("manual-inv-due-date")) $("manual-inv-due-date").value = d.dueDate || "";
        if ($("manual-inv-discount-type")) $("manual-inv-discount-type").value = d.discountType || "item";
        if ($("manual-inv-global-discount-rp")) $("manual-inv-global-discount-rp").value = d.globalDiscountRp || 0;
        if ($("manual-inv-ppn-rate")) $("manual-inv-ppn-rate").value = d.ppnRate || "11";
        if ($("manual-inv-custom-ppn-rp")) $("manual-inv-custom-ppn-rp").value = d.customPpnRp || 0;
        if ($("manual-inv-printed-total")) $("manual-inv-printed-total").value = d.printedTotal || "";
        manualInvoiceItems = d.items;
        hasDraft = true;
      }
    }
  } catch (e) {
    console.warn("Failed to restore manual invoice draft:", e);
  }

  handlePaymentTypeChange();
  handleDiscountTypeChange();
  handlePpnRateChange();

  if (!hasDraft || !manualInvoiceItems.length) {
    manualInvoiceItems = [];
    addManualInvoiceRow();
  } else {
    renderManualInvoiceItems();
  }

  calculateManualInvoiceTotals();
  modal.hidden = false;
  setTimeout(() => $("manual-inv-number")?.focus(), 60);
}

export function closeManualInvoiceModal() {
  const modal = $("modal-manual-invoice");
  if (modal) modal.hidden = true;
}

function populateManualInvoiceSupplierDropdown() {
  const select = $("manual-inv-supplier");
  if (!select) return;

  const currentVal = select.value;
  const master = readStore(STORE_KEYS.master, {});
  const sups = Array.isArray(master.supplier) ? master.supplier : [];

  select.innerHTML = '<option value="">-- Pilih Supplier --</option>' +
    sups.map(s => {
      const name = s["Nama Perusahaan"] || s["Supplier"] || s.name || "";
      return `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
    }).join("");

  if (currentVal) select.value = currentVal;
}

async function handleQuickAddSupplierInv() {
  const newName = prompt("Masukkan Nama Perusahaan Supplier Baru:");
  if (!newName || !newName.trim()) return;
  const cleanName = newName.trim();

  const newSup = {
    id: `SUP-${Date.now()}`,
    "Nama Perusahaan": cleanName,
    "Supplier": cleanName,
    "Status": "Aktif",
    "status": "Aktif"
  };

  try {
    await writeMasterDelta({ supplier: [newSup] });
    populateManualInvoiceSupplierDropdown();
    const select = $("manual-inv-supplier");
    if (select) select.value = cleanName;
    window.KasirProDialog?.success("Supplier Ditambahkan", `Supplier "${cleanName}" berhasil didaftarkan.`);
  } catch (e) {
    window.KasirProDialog?.error("Gagal", e.message);
  }
}

function handlePaymentTypeChange() {
  const payType = $("manual-inv-payment-type")?.value || "tempo";
  const dueInput = $("manual-inv-due-date");
  const dueReq = $("manual-inv-due-date-required");
  const label = $("manual-inv-due-date-label");
  const invDate = $("manual-inv-date")?.value || new Date().toISOString().slice(0, 10);

  if (payType === "tunai") {
    if (dueReq) dueReq.style.display = "none";
    if (dueInput) {
      dueInput.value = invDate;
      dueInput.disabled = true;
      dueInput.title = "Pembayaran tunai lunas langsung pada tanggal faktur";
    }
    if (label) label.innerHTML = 'Jatuh Tempo <span style="font-size:11px;color:#059669;font-weight:600;">(Lunas Tunai)</span>';
  } else {
    // Tempo
    if (dueReq) dueReq.style.display = "inline";
    if (dueInput) {
      dueInput.disabled = false;
      dueInput.title = "";
      if (!dueInput.value || dueInput.value === invDate) {
        const d = new Date(invDate);
        d.setDate(d.getDate() + 30);
        dueInput.value = d.toISOString().slice(0, 10);
      }
    }
    if (label) label.innerHTML = 'Jatuh Tempo <span class="text-danger" id="manual-inv-due-date-required">*</span>';
  }
}

function handleInvoiceDateChange() {
  const payType = $("manual-inv-payment-type")?.value || "tempo";
  const invDate = $("manual-inv-date")?.value;
  if (!invDate) return;
  if (payType === "tunai") {
    const dueInput = $("manual-inv-due-date");
    if (dueInput) dueInput.value = invDate;
  }
}

function handleDiscountTypeChange() {
  const type = $("manual-inv-discount-type")?.value;
  const box = $("manual-inv-global-discount-box");
  if (box) box.hidden = type !== "global";
  calculateManualInvoiceTotals();
}

function handlePpnRateChange() {
  const rate = $("manual-inv-ppn-rate")?.value || "11";
  const customBox = $("manual-inv-custom-ppn-box");
  if (customBox) customBox.hidden = rate !== "custom";
  calculateManualInvoiceTotals();
}

async function handleTriggerPasteTsv() {
  let clipText = "";
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      clipText = await navigator.clipboard.readText();
    }
  } catch (err) {
    console.warn("[Invoice] Gagal membaca clipboard otomatis:", err);
  }

  // Jika teks clipboard memuat pemisah tab atau baris baru
  if (clipText && (clipText.includes("\t") || clipText.includes("\n"))) {
    processTsvData(clipText);
  } else {
    // Tampilkan modal fallback input textarea
    openPasteTsvModal(clipText);
  }
}

function openPasteTsvModal(prefill = "") {
  const modal = $("modal-paste-tsv");
  if (!modal) return;
  const ta = $("tsv-paste-textarea");
  if (ta) {
    ta.value = prefill || "";
    setTimeout(() => ta.focus(), 60);
  }
  modal.hidden = false;
  modal.style.display = "grid";
}

function closePasteTsvModal() {
  const modal = $("modal-paste-tsv");
  if (modal) {
    modal.hidden = true;
    modal.style.display = "none";
  }
}

/**
 * One-Click Paste TSV Parser dengan Smart Product Matching
 * Membaca data tabel TSV (dari Excel/GPT/Clipboard), memetakan 13 kolom faktur,
 * mencocokkan produk secara cerdas dengan Master Produk (Exact, Fuzzy, New),
 * serta menghitung ulang rekonsiliasi faktur secara instan.
 */
function processTsvData(rawText) {
  if (!rawText || typeof rawText !== "string") {
    window.KasirProDialog?.warning("Format Kosong", "Tidak ada teks atau data tabel yang dapat dibaca.");
    return;
  }

  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) {
    window.KasirProDialog?.warning("Data Kosong", "Teks yang ditempel tidak memuat baris data.");
    return;
  }

  // 1. Deteksi Baris Header (lewati jika baris 1 adalah judul kolom)
  const firstLineNorm = lines[0].toLowerCase();
  if (
    firstLineNorm.includes("nama produk") ||
    firstLineNorm.includes("nama obat") ||
    firstLineNorm.includes("nama barang") ||
    firstLineNorm.includes("no batch") ||
    firstLineNorm.includes("no. batch") ||
    firstLineNorm.includes("exp date") ||
    firstLineNorm.includes("subtotal") ||
    firstLineNorm.includes("harga beli")
  ) {
    lines.shift();
  }

  if (!lines.length) {
    window.KasirProDialog?.warning("Data Kosong", "Hanya terdeteksi baris header tanpa baris produk.");
    return;
  }

  const prods = cachedMasterProducts || (readStore(STORE_KEYS.master, {})?.produk || []);

  // Pre-indexing Master Produk untuk pencocokan instan (< 10ms)
  const exactNormMap = new Map();
  const barcodeMap = new Map();
  const codeMap = new Map();
  const candidateList = [];

  for (const p of prods) {
    if (p._isDeleted) continue;
    const pCode = norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.code || p.id);
    const pBarcode = norm(p["Barcode"] || p.barcode);
    const pName = p["Nama Produk"] || p.name || "";
    const normPName = normalizeProductName(pName);

    if (pBarcode && !barcodeMap.has(pBarcode)) barcodeMap.set(pBarcode, p);
    if (pCode && !codeMap.has(pCode)) codeMap.set(pCode, p);
    if (normPName && !exactNormMap.has(normPName)) exactNormMap.set(normPName, p);

    if (normPName) {
      candidateList.push({
        product: p,
        normName: normPName,
        tokens: new Set(normPName.split(/\s+/).filter(Boolean)),
        len: normPName.length
      });
    }
  }

  // Helper konversi tanggal kedaluwarsa ke YYYY-MM-DD
  const parseExpDate = (rawExp) => {
    const s = String(rawExp || "").trim();
    if (!s) return "";
    // Format YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // Format DD/MM/YYYY atau DD-MM-YYYY
    const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (dmy) {
      const day = dmy[1].padStart(2, "0");
      const month = dmy[2].padStart(2, "0");
      const year = dmy[3];
      return `${year}-${month}-${day}`;
    }
    // Format MM/YYYY atau MM-YYYY
    const my = s.match(/^(\d{1,2})[\/\-](\d{4})$/);
    if (my) {
      const month = my[1].padStart(2, "0");
      const year = my[2];
      return `${year}-${month}-01`;
    }
    // Format MM/YY
    const myShort = s.match(/^(\d{1,2})[\/\-](\d{2})$/);
    if (myShort) {
      const month = myShort[1].padStart(2, "0");
      const year = `20${myShort[2]}`;
      return `${year}-${month}-01`;
    }
    return s;
  };

  const parsedItems = [];
  let exactCount = 0;
  let fuzzyCount = 0;
  let newCount = 0;

  for (const line of lines) {
    const cols = line.split("\t").map(c => c.trim());
    if (cols.length === 1 && !cols[0]) continue;

    const rawName = cols[0] || "";
    if (!rawName) continue;

    const rawBatch = cols[1] || "";
    const rawExp = parseExpDate(cols[2] || "");
    const rawBuyUnit = cols[3] || "";

    let rawMidUnit = "";
    let rawMidQty = "";
    let rawBaseUnit = "";
    let rawConv = 0;
    let rawQty = 1;
    let rawBuyPrice = 0;
    let rawDiscPct = 0;
    let rawDiscRp = 0;
    let rawSubtotal = 0;

    // Deteksi Cerdas: Apakah format 14 kolom (Satuan Sedang dipecah 2 sel: Opsional dan Isi)
    const isCols5Number = cols[5] !== undefined && cols[5] !== "" && /^[0-9]+$/.test(cols[5].trim());
    const isCols6NonNumber = cols[6] !== undefined && isNaN(Number(cols[6].trim()));
    const is14ColFormat = cols.length >= 14 || (isCols5Number && isCols6NonNumber);

    if (is14ColFormat) {
      // 14 Kolom Akurat
      rawMidUnit = cols[4] || "";
      rawMidQty = num(cols[5]) || (rawMidUnit ? 1 : "");
      rawBaseUnit = cols[6] || "";
      rawConv = num(cols[7]) || 0;
      rawQty = num(cols[8]) || 1;
      // cols[9] adalah Total Masuk (dihitung: Qty Beli x Konversi)
      rawBuyPrice = num(cols[10] || 0);
      rawDiscPct = num(cols[11] || 0);
      rawDiscRp = num(cols[12] || 0);
      rawSubtotal = num(cols[13] || 0);
    } else {
      // 13 Kolom Lama
      rawMidUnit = cols[4] || "";
      rawMidQty = "";
      rawBaseUnit = cols[5] || "";
      rawConv = num(cols[6]) || 0;
      rawQty = num(cols[7]) || 1;
      // cols[8] adalah Total Masuk
      rawBuyPrice = num(cols[9] || 0);
      rawDiscPct = num(cols[10] || 0);
      rawDiscRp = num(cols[11] || 0);
      rawSubtotal = num(cols[12] || 0);
    }

    if (!rawDiscRp && rawDiscPct > 0) {
      rawDiscRp = Math.round((rawQty * rawBuyPrice * rawDiscPct) / 100);
    }
    if (!rawSubtotal) {
      rawSubtotal = Math.max(0, Math.round((rawQty * rawBuyPrice) - rawDiscRp));
    }

    // Smart Product Matching dengan Pre-indexed Master Data
    const normRaw = norm(rawName);
    const normQuery = normalizeProductName(rawName);
    let match = null;

    if (barcodeMap.has(normRaw)) {
      match = { matchType: "exact", score: 1, product: barcodeMap.get(normRaw) };
    } else if (codeMap.has(normRaw)) {
      match = { matchType: "exact", score: 1, product: codeMap.get(normRaw) };
    } else if (exactNormMap.has(normQuery)) {
      match = { matchType: "exact", score: 1, product: exactNormMap.get(normQuery) };
    } else {
      // Fuzzy matching teroptimasi dengan candidate filtering
      let bestFuzzyMatch = null;
      let bestFuzzyScore = 0;
      const qTokens = new Set(normQuery.split(/\s+/).filter(Boolean));
      const lenQ = normQuery.length;

      for (const cand of candidateList) {
        if (Math.min(lenQ, cand.len) / Math.max(lenQ, cand.len) < 0.55) continue;

        let commonTokens = 0;
        for (const qt of qTokens) {
          if (cand.tokens.has(qt)) commonTokens++;
        }
        if (qTokens.size >= 2 && commonTokens === 0) continue;

        const score = stringSimilarity(normQuery, cand.normName);
        if (score > bestFuzzyScore) {
          bestFuzzyScore = score;
          bestFuzzyMatch = cand.product;
        }
      }

      if (bestFuzzyScore >= 0.999) {
        match = { matchType: "exact", score: 1, product: bestFuzzyMatch };
      } else if (bestFuzzyScore >= 0.8) {
        match = { matchType: "fuzzy", score: bestFuzzyScore, product: bestFuzzyMatch };
      } else {
        match = { matchType: "none", score: bestFuzzyScore, product: null };
      }
    }

    let finalCode = "";
    let finalBarcode = "";
    let matchStatus = "new";
    let matchScore = 0;
    let matchedProduct = null;

    let pUnit = rawBuyUnit;
    let mUnit = rawMidUnit;
    let bUnit = rawBaseUnit;
    let convRatio = rawConv;
    let mQty = rawMidQty || 1;

    if (match.matchType === "exact" && match.product) {
      finalCode = match.product["Kode Produk"] || match.product["Kode Produk Internal"] || match.product.id || "";
      finalBarcode = match.product["Barcode"] || "";
      matchStatus = "exact";
      matchScore = 100;
      matchedProduct = match.product;
      exactCount++;

      // Isi satuan default jika kolom TSV kosong
      if (!pUnit) pUnit = match.product["Kemasan Beli"] || match.product["Satuan Pembelian"] || "Box";
      if (!bUnit) bUnit = match.product["Satuan Dasar"] || match.product["Satuan"] || "Pcs";
      if (!convRatio) convRatio = num(match.product["Konversi"] ?? match.product["Isi Kemasan"] ?? 1) || 1;
      if (!mUnit && match.product["Satuan Antara"]) {
        mUnit = match.product["Satuan Antara"];
        mQty = num(match.product["Isi Satuan Antara"]) || 1;
      } else if (rawMidQty) {
        mQty = rawMidQty;
      }
    } else if (match.matchType === "fuzzy" && match.product) {
      finalCode = match.product["Kode Produk"] || match.product["Kode Produk Internal"] || match.product.id || "";
      finalBarcode = match.product["Barcode"] || "";
      matchStatus = "fuzzy";
      matchScore = Math.round(match.score * 100);
      matchedProduct = match.product;
      fuzzyCount++;

      if (!pUnit) pUnit = match.product["Kemasan Beli"] || match.product["Satuan Pembelian"] || "Box";
      if (!bUnit) bUnit = match.product["Satuan Dasar"] || match.product["Satuan"] || "Pcs";
      if (!convRatio) convRatio = num(match.product["Konversi"] ?? match.product["Isi Kemasan"] ?? 1) || 1;
    } else {
      matchStatus = "new";
      matchScore = 0;
      newCount++;

      if (!pUnit) pUnit = "Box";
      if (!bUnit) bUnit = "Pcs";
      if (!convRatio) convRatio = 1;
    }

    // Fleksibilitas Multi-Satuan
    if (norm(pUnit) === norm(bUnit) || convRatio <= 1) {
      mUnit = "";
      mQty = "";
      convRatio = 1;
    }

    parsedItems.push({
      productCode: finalCode,
      name: rawName,
      barcode: finalBarcode,
      purchaseUnit: pUnit,
      intermediateUnit: mUnit,
      intermediateQty: mQty > 1 ? mQty : "",
      baseUnit: bUnit,
      conversionRatio: convRatio,
      qty: rawQty,
      buyPrice: rawBuyPrice,
      discountPercent: rawDiscPct > 0 ? rawDiscPct : "",
      discountRp: rawDiscRp > 0 ? rawDiscRp : "",
      subtotal: rawSubtotal,
      batch: rawBatch,
      expiryDate: rawExp,
      matchStatus,
      matchScore,
      matchedProduct
    });
  }

  if (!parsedItems.length) {
    window.KasirProDialog?.warning("Gagal Impor", "Tidak ada baris produk valid yang dapat diekstraksi dari data TSV.");
    return;
  }

  // Jika tabel hanya memiliki 1 baris kosong awal, ganti sepenuhnya
  if (manualInvoiceItems.length === 1 && !manualInvoiceItems[0].name && !manualInvoiceItems[0].qty) {
    manualInvoiceItems = parsedItems;
  } else {
    manualInvoiceItems.push(...parsedItems);
  }

  renderManualInvoiceItems();
  calculateManualInvoiceTotals();

  window.KasirProDialog?.success(
    "Impor TSV Berhasil",
    `Berhasil memuat ${parsedItems.length} baris obat dari data TSV!\n\n• ${exactCount} produk cocok sempurna (Exact)\n• ${fuzzyCount} produk mirip (Fuzzy Match)\n• ${newCount} produk baru (Belum ada di master)`
  );
}

function addManualInvoiceRow(prefill = {}) {
  manualInvoiceItems.push({
    productCode: prefill.productCode || "",
    name: prefill.name || "",
    barcode: prefill.barcode || "",
    purchaseUnit: prefill.purchaseUnit || "",
    intermediateUnit: prefill.intermediateUnit || "",
    intermediateQty: prefill.intermediateQty || "",
    baseUnit: prefill.baseUnit || "",
    conversionRatio: prefill.conversionRatio !== undefined && prefill.conversionRatio !== null ? prefill.conversionRatio : "",
    qty: prefill.qty !== undefined && prefill.qty !== null ? prefill.qty : "",
    buyPrice: prefill.buyPrice !== undefined && prefill.buyPrice !== null ? prefill.buyPrice : "",
    discountPercent: prefill.discountPercent !== undefined && prefill.discountPercent !== null ? prefill.discountPercent : "",
    discountRp: prefill.discountRp !== undefined && prefill.discountRp !== null ? prefill.discountRp : "",
    subtotal: prefill.subtotal || 0,
    batch: prefill.batch || "",
    expiryDate: prefill.expiryDate || ""
  });
  renderManualInvoiceItems();
  calculateManualInvoiceTotals();

  // Fokuskan input nama produk pada baris baru
  setTimeout(() => {
    const rows = document.querySelectorAll(".row-prod-search");
    if (rows.length) rows[rows.length - 1]?.focus();
  }, 50);
}

function removeManualInvoiceRow(idx) {
  if (manualInvoiceItems.length <= 1) {
    manualInvoiceItems = [];
    addManualInvoiceRow();
    return;
  }
  manualInvoiceItems.splice(idx, 1);
  renderManualInvoiceItems();
  calculateManualInvoiceTotals();
}

function handleSupplierChange() {
  renderManualInvoiceItems();
  hideGlobalAc();
}

function hideGlobalAc() {
  const ac = $("manual-inv-global-ac");
  if (ac) ac.style.display = "none";
}

function renderManualInvoiceItems() {
  const tbody = $("manual-invoice-items-body");
  if (!tbody) return;

  const currentSup = text($("manual-inv-supplier")?.value);
  const supSelected = !!currentSup;

  tbody.innerHTML = manualInvoiceItems.map((item, idx) => {
    const qNum = num(item.qty) || 0;
    const convNum = num(item.conversionRatio) || 1;
    const totalBase = qNum * convNum;

    const buyPriceStr = (item.buyPrice !== undefined && item.buyPrice !== null && item.buyPrice !== "") ? (num(item.buyPrice) ? formatNumber(num(item.buyPrice)) : "") : "";
    const discRpStr = (item.discountRp !== undefined && item.discountRp !== null && item.discountRp !== "") ? (num(item.discountRp) ? formatNumber(num(item.discountRp)) : "") : "";
    const discPctStr = (item.discountPercent !== undefined && item.discountPercent !== null && item.discountPercent !== "" && item.discountPercent !== 0) ? item.discountPercent : "";
    const qtyStr = (item.qty !== undefined && item.qty !== null && item.qty !== "") ? item.qty : "";
    const convStr = (item.conversionRatio !== undefined && item.conversionRatio !== null && item.conversionRatio !== "") ? item.conversionRatio : "";
    const midQtyStr = (item.intermediateQty !== undefined && item.intermediateQty !== null && item.intermediateQty !== "" && item.intermediateUnit) ? item.intermediateQty : "";

    let matchBadgeHtml = "";
    if (item.matchStatus === "exact" && item.productCode) {
      matchBadgeHtml = `
        <div style="margin-top:2px;">
          <span style="font-size:10px;font-weight:700;background:#ecfdf5;color:#059669;border:1px solid #a7f3d0;padding:1px 6px;border-radius:4px;display:inline-flex;align-items:center;gap:3px;" title="Produk cocok 100% dengan master data">
            <i class="fa-solid fa-circle-check"></i> Tersambung: ${escapeHtml(item.productCode)}
          </span>
        </div>
      `;
    } else if (item.matchStatus === "fuzzy" && item.matchedProduct) {
      const matchName = item.matchedProduct["Nama Produk"] || item.productCode || "";
      matchBadgeHtml = `
        <div style="margin-top:2px;">
          <span style="font-size:10px;font-weight:700;background:#fffbeb;color:#d97706;border:1px solid #fde68a;padding:1px 6px;border-radius:4px;display:inline-flex;align-items:center;gap:3px;cursor:pointer;" title="Mirip (${item.matchScore}%). Klik/ketik untuk mengganti jika perlu.">
            <i class="fa-solid fa-triangle-exclamation"></i> Mirip: ${escapeHtml(matchName)} (${item.matchScore}%)
          </span>
        </div>
      `;
    } else if (item.name && (item.matchStatus === "new" || !item.productCode)) {
      matchBadgeHtml = `
        <div style="margin-top:2px;">
          <span style="font-size:10px;font-weight:700;background:#f0f9ff;color:#0284c7;border:1px solid #bae6fd;padding:1px 6px;border-radius:4px;display:inline-flex;align-items:center;gap:3px;" title="Produk belum terdaftar di master data (akan didaftarkan otomatis)">
            <i class="fa-solid fa-plus-circle"></i> + Produk Baru
          </span>
        </div>
      `;
    } else if (item.productCode) {
      matchBadgeHtml = `
        <div style="font-size:10.5px;color:#0284c7;display:flex;gap:6px;margin-top:2px;">
          <span>Kode: ${escapeHtml(item.productCode)}</span>
        </div>
      `;
    }

    return `
      <tr data-index="${idx}">
        <td style="text-align:center;font-weight:700;color:#64748b;">${idx + 1}</td>
        <td class="inv-prod-cell">
          <div style="display:flex;flex-direction:column;gap:3px;">
            <input type="text" class="row-prod-search" data-index="${idx}" value="${escapeHtml(item.name)}" 
              placeholder="${supSelected ? 'Ketik nama obat / scan barcode...' : 'Pilih Supplier terlebih dahulu...'}" 
              ${supSelected ? '' : 'disabled'} autocomplete="off" 
              style="font-weight:700;${supSelected ? 'color:#0f172a;background:#fff;' : 'background:#f8fafc;color:#94a3b8;cursor:not-allowed;'}">
            ${matchBadgeHtml}
          </div>
        </td>
        <td>
          <input type="text" class="row-batch" data-index="${idx}" value="${escapeHtml(item.batch || '')}" placeholder="No. Batch" style="font-weight:600;">
        </td>
        <td>
          <input type="date" class="row-exp" data-index="${idx}" value="${escapeHtml(item.expiryDate || '')}" style="font-size:11.5px;">
        </td>
        <td>
          <input type="text" class="row-purchase-unit" data-index="${idx}" value="${escapeHtml(item.purchaseUnit || '')}" placeholder="BOX / BTL">
        </td>
        <td>
          <div style="display:flex;align-items:center;gap:4px;">
            <input type="text" class="row-mid-unit" data-index="${idx}" value="${escapeHtml(item.intermediateUnit || '')}" placeholder="Opsional" style="flex:1;">
            <input type="number" class="row-mid-qty" data-index="${idx}" min="1" step="1" value="${midQtyStr}" title="Isi per Satuan Sedang" style="width:48px;" placeholder="Isi">
          </div>
        </td>
        <td>
          <input type="text" class="row-base-unit" data-index="${idx}" value="${escapeHtml(item.baseUnit || '')}" placeholder="TAB / BTL">
        </td>
        <td>
          <input type="number" class="row-conversion" data-index="${idx}" min="1" step="1" value="${convStr}" title="Total Satuan Terkecil dalam 1 Satuan Besar" style="font-weight:800;color:#0369a1;" placeholder="1">
        </td>
        <td>
          <input type="number" class="row-qty" data-index="${idx}" min="0.01" step="any" value="${qtyStr}" style="font-weight:700;" placeholder="1">
        </td>
        <td class="row-total-base-cell" style="text-align:center;font-weight:700;color:#0369a1;background:#f0f9ff;border-radius:4px;">
          ${totalBase > 0 ? totalBase : '—'} <small style="font-size:10px;">${escapeHtml(item.baseUnit || '')}</small>
        </td>
        <td>
          <input type="text" inputmode="numeric" class="row-buy-price" data-index="${idx}" value="${buyPriceStr}" placeholder="0" style="font-weight:600;">
        </td>
        <td>
          <input type="number" class="row-disc-pct" data-index="${idx}" min="0" max="100" step="0.1" value="${discPctStr}" placeholder="0">
        </td>
        <td>
          <input type="text" inputmode="numeric" class="row-disc-rp" data-index="${idx}" value="${discRpStr}" placeholder="0">
        </td>
        <td class="row-subtotal-cell" style="text-align:right;font-weight:800;color:#0f172a;">
          ${rupiah(item.subtotal || 0)}
        </td>
        <td style="text-align:center;">
          <button type="button" class="btn-remove-row button button-small button-secondary" data-index="${idx}" style="color:#ef4444;padding:4px 8px;" title="Hapus baris ini">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      </tr>
    `;
  }).join("");

  bindManualItemRowEvents();
}

function checkAutoUnitFallback(idx) {
  const item = manualInvoiceItems[idx];
  if (!item) return;
  const pUnit = norm(item.purchaseUnit);
  const bUnit = norm(item.baseUnit);
  if (pUnit && bUnit && pUnit === bUnit) {
    item.conversionRatio = 1;
    item.intermediateUnit = "";
    item.intermediateQty = 1;
    const row = document.querySelector(`tr[data-index="${idx}"]`);
    if (row) {
      const midUnitInp = row.querySelector(".row-mid-unit");
      if (midUnitInp) midUnitInp.value = "";
      const midQtyInp = row.querySelector(".row-mid-qty");
      if (midQtyInp) midQtyInp.value = "";
      const convInp = row.querySelector(".row-conversion");
      if (convInp && (!convInp.value || convInp.value === "0")) convInp.value = "1";
    }
  }
}

function bindManualItemRowEvents() {
  const tbody = $("manual-invoice-items-body");
  if (!tbody) return;

  // Auto-select text saat fokus untuk seluruh input di baris tabel
  tbody.querySelectorAll("input").forEach(inp => {
    inp.addEventListener("focus", (e) => {
      e.target.select();
    });
  });

  // Search autocomplete dengan debounce 100ms agar pengetikan super ringan
  tbody.querySelectorAll(".row-prod-search").forEach(input => {
    input.addEventListener("input", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      clearTimeout(prodSearchDebounceTimer);
      prodSearchDebounceTimer = setTimeout(() => {
        showProductSuggestions(e.target, idx, e.target.value);
      }, 100);
    });
    input.addEventListener("focus", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      showProductSuggestions(e.target, idx, e.target.value);
    });
  });

  // Batch & Exp Date
  tbody.querySelectorAll(".row-batch").forEach(el => {
    el.addEventListener("input", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      manualInvoiceItems[idx].batch = e.target.value.trim();
    });
  });

  tbody.querySelectorAll(".row-exp").forEach(el => {
    el.addEventListener("input", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      manualInvoiceItems[idx].expiryDate = e.target.value;
    });
  });

  // Input Satuan & Konversi
  tbody.querySelectorAll(".row-purchase-unit").forEach(el => {
    el.addEventListener("input", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      manualInvoiceItems[idx].purchaseUnit = e.target.value.trim();
      checkAutoUnitFallback(idx);
    });
  });

  tbody.querySelectorAll(".row-mid-unit").forEach(el => {
    el.addEventListener("input", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      manualInvoiceItems[idx].intermediateUnit = e.target.value.trim();
    });
  });

  tbody.querySelectorAll(".row-mid-qty").forEach(el => {
    el.addEventListener("input", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      manualInvoiceItems[idx].intermediateQty = num(e.target.value) || 1;
      calculateManualInvoiceTotals();
    });
  });

  tbody.querySelectorAll(".row-base-unit").forEach(el => {
    el.addEventListener("input", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      manualInvoiceItems[idx].baseUnit = e.target.value.trim();
      checkAutoUnitFallback(idx);
      recalculateRow(idx, false);
    });
  });

  tbody.querySelectorAll(".row-conversion").forEach(el => {
    el.addEventListener("input", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      manualInvoiceItems[idx].conversionRatio = num(e.target.value) || 1;
      recalculateRow(idx, false);
    });
  });

  tbody.querySelectorAll(".row-qty").forEach(el => {
    el.addEventListener("input", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      manualInvoiceItems[idx].qty = num(e.target.value) || 0;
      recalculateRow(idx, false);
    });
  });

  // Live auto thousand dots untuk Harga Beli
  tbody.querySelectorAll(".row-buy-price").forEach(el => {
    el.addEventListener("input", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      const digits = e.target.value.replace(/[^0-9]/g, "");
      const valNum = parseInt(digits, 10) || 0;
      e.target.value = valNum ? formatNumber(valNum) : "";
      manualInvoiceItems[idx].buyPrice = valNum;
      recalculateRow(idx, false);
    });
  });

  tbody.querySelectorAll(".row-disc-pct").forEach(el => {
    el.addEventListener("input", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      const pct = num(e.target.value) || 0;
      manualInvoiceItems[idx].discountPercent = pct;
      const q = num(manualInvoiceItems[idx].qty) || 0;
      const p = num(manualInvoiceItems[idx].buyPrice) || 0;
      manualInvoiceItems[idx].discountRp = Math.round((q * p) * (pct / 100));
      const row = tbody.querySelector(`tr[data-index="${idx}"]`);
      if (row) {
        const rpInput = row.querySelector(".row-disc-rp");
        if (rpInput) rpInput.value = manualInvoiceItems[idx].discountRp ? formatNumber(manualInvoiceItems[idx].discountRp) : "";
      }
      recalculateRow(idx, false);
    });
  });

  tbody.querySelectorAll(".row-disc-rp").forEach(el => {
    el.addEventListener("input", (e) => {
      const idx = parseInt(e.target.dataset.index, 10);
      const digits = e.target.value.replace(/[^0-9]/g, "");
      const valNum = parseInt(digits, 10) || 0;
      e.target.value = valNum ? formatNumber(valNum) : "";
      manualInvoiceItems[idx].discountRp = valNum;
      manualInvoiceItems[idx].discountPercent = 0;
      const row = tbody.querySelector(`tr[data-index="${idx}"]`);
      if (row) {
        const pctInput = row.querySelector(".row-disc-pct");
        if (pctInput) pctInput.value = "";
      }
      recalculateRow(idx, false);
    });
  });

  // Tombol Hapus
  tbody.querySelectorAll(".btn-remove-row").forEach(b => {
    b.addEventListener("click", () => {
      const idx = parseInt(b.dataset.index, 10);
      removeManualInvoiceRow(idx);
    });
  });
}

function showProductSuggestions(inputEl, idx, query) {
  const acBox = $("manual-inv-global-ac");
  if (!acBox || !inputEl) return;

  const currentSup = text($("manual-inv-supplier")?.value);
  if (!currentSup) {
    hideGlobalAc();
    window.KasirProDialog?.warning("Perhatian", "Silakan pilih Nama Supplier di bagian atas faktur terlebih dahulu.");
    $("manual-inv-supplier")?.focus();
    return;
  }

  const q = (query || "").trim().toLowerCase();
  const prods = cachedMasterProducts || (readStore(STORE_KEYS.master, {})?.produk || []);

  const supMatches = [];
  const otherMatches = [];

  for (const p of prods) {
    if (p._isDeleted || norm(p["Status"] || p["Status Produk"]) === "nonaktif") continue;

    const pSup = norm(p["Supplier"] || p["Produsen"]);
    const isThisSup = pSup === norm(currentSup);
    const name = (p["Nama Produk"] || p.name || "").toLowerCase();
    const code = (p["Kode Produk"] || p["Kode Produk Internal"] || "").toLowerCase();
    const barcode = (p["Barcode"] || "").toLowerCase();

    const matchesQuery = !q || name.includes(q) || code.includes(q) || barcode.includes(q);

    if (matchesQuery) {
      if (isThisSup) supMatches.push(p);
      else if (q) otherMatches.push(p);
    }
  }

  const combined = [...supMatches.slice(0, 10), ...otherMatches.slice(0, 5)];

  let html = "";
  if (combined.length > 0) {
    html = combined.map(p => {
      const name = p["Nama Produk"] || p.name || "";
      const code = p["Kode Produk"] || p["Kode Produk Internal"] || "";
      const buyPrice = num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0);
      const buyUnit = p["Kemasan Beli"] || p["Satuan Pembelian"] || "Box";
      const conv = num(p["Konversi"] ?? p["Isi Kemasan"] ?? 1);
      const baseUnit = p["Satuan Dasar"] || p["Satuan"] || "Pcs";
      const pSup = p["Supplier"] || p["Produsen"] || "";
      const isCurrentSup = norm(pSup) === norm(currentSup);

      return `
        <div class="inv-prod-opt" data-index="${idx}" data-code="${escapeHtml(code)}" style="border-left:${isCurrentSup ? '4px solid #0284c7' : '4px solid #e2e8f0'};padding:8px 12px;cursor:pointer;">
          <div style="flex:1;min-width:0;padding-right:8px;">
            <div style="font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(name)}</div>
            <div style="color:#64748b;font-size:11px;display:flex;gap:6px;flex-wrap:wrap;margin-top:2px;">
              <span>Kode: <strong>${escapeHtml(code)}</strong></span>
              <span>•</span>
              <span style="color:#0284c7;">1 ${escapeHtml(buyUnit)} = ${conv} ${escapeHtml(baseUnit)}</span>
              ${!isCurrentSup && pSup ? `<span style="color:#ca8a04;">(Supplier: ${escapeHtml(pSup)})</span>` : ''}
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-weight:800;color:#0369a1;font-size:13px;">${rupiah(buyPrice)}</div>
            <small style="font-size:10px;color:#64748b;">Modal Terakhir</small>
          </div>
        </div>
      `;
    }).join("");
  } else {
    html = `
      <div style="padding:14px;text-align:center;color:#64748b;font-size:12px;">
        <i class="fa-solid fa-box-open" style="font-size:20px;display:block;margin-bottom:6px;color:#94a3b8;"></i>
        ${q ? `Produk "<strong>${escapeHtml(query)}</strong>" belum ada di sistem.` : `Belum ada produk terdaftar untuk supplier <strong>${escapeHtml(currentSup)}</strong>.`}
      </div>
    `;
  }

  // Opsi Tambah Produk Baru
  const addName = (query || "").trim();
  html += `
    <div class="inv-prod-opt inv-prod-opt-add" data-index="${idx}" data-name="${escapeHtml(addName)}" style="padding:10px 14px;background:#f0f9ff;color:#0284c7;font-weight:700;cursor:pointer;border-top:1px solid #e0f2fe;display:flex;align-items:center;gap:6px;">
      <i class="fa-solid fa-plus-circle"></i> + Daftarkan Produk Baru: "${escapeHtml(addName || 'Obat Baru')}"
    </div>
  `;

  acBox.innerHTML = html;

  // Posisikan secara fixed relatif terhadap input
  const rect = inputEl.getBoundingClientRect();
  acBox.style.position = "fixed";
  acBox.style.top = `${rect.bottom + 3}px`;
  acBox.style.left = `${rect.left}px`;
  acBox.style.width = `${Math.max(rect.width, 380)}px`;
  acBox.style.zIndex = "999999";
  acBox.style.display = "block";

  // Listener untuk pilihan
  acBox.querySelectorAll(".inv-prod-opt:not(.inv-prod-opt-add)").forEach(opt => {
    opt.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const code = opt.dataset.code;
      const targetProd = prods.find(p => norm(p["Kode Produk"] || p["Kode Produk Internal"]) === norm(code));
      if (targetProd) {
        selectProductForRow(idx, targetProd);
      }
      hideGlobalAc();
    });
  });

  acBox.querySelector(".inv-prod-opt-add")?.addEventListener("mousedown", (e) => {
    e.preventDefault();
    hideGlobalAc();
    const prodName = addName;
    if (typeof window.openProductModal === "function") {
      window.openProductModal(
        {
          name: prodName,
          supplier: currentSup,
          buyUnit: "Box",
          conversion: 1,
          baseUnit: "Pcs"
        },
        (newProd) => {
          selectProductForRow(idx, newProd);
        }
      );
    }
  });
}

function selectProductForRow(idx, prod) {
  if (!manualInvoiceItems[idx]) return;

  const item = manualInvoiceItems[idx];
  item.productCode = prod["Kode Produk"] || prod["Kode Produk Internal"] || "";
  item.name = prod["Nama Produk"] || prod.name || "";
  item.barcode = prod["Barcode"] || "";
  item.purchaseUnit = prod["Kemasan Beli"] || prod["Satuan Pembelian"] || "BOX";

  const baseU = prod["Satuan Dasar"] || prod["Satuan"] || "TABLET";
  const interU = prod["Satuan Antara"] || "";
  const conv = num(prod["Konversi"] ?? prod["Isi Kemasan"] ?? 1) || 1;
  const interQty = num(prod["Isi Satuan Antara"]) || 1;

  item.baseUnit = baseU;
  item.conversionRatio = conv;

  // Cek fleksibilitas satuan: 1 satuan (Btl/Tube), 2 satuan (Box -> Sachet), atau 3 satuan (Box -> Strip -> Tab)
  if (norm(item.purchaseUnit) === norm(baseU) || conv <= 1) {
    // 1 Satuan murni
    item.intermediateUnit = "";
    item.intermediateQty = "";
    item.conversionRatio = 1;
  } else if (!interU || norm(interU) === norm(baseU) || interQty <= 1 || interQty === conv) {
    // 2 Satuan murni
    item.intermediateUnit = "";
    item.intermediateQty = "";
  } else {
    // 3 Satuan lengkap
    item.intermediateUnit = interU;
    item.intermediateQty = interQty;
  }

  item.buyPrice = num(prod["Harga Beli Terakhir"] ?? prod["Harga Beli"] ?? 0);
  item.matchStatus = "exact";
  item.matchScore = 100;
  item.matchedProduct = prod;

  recalculateRow(idx);
  renderManualInvoiceItems();
  calculateManualInvoiceTotals();
}

function recalculateRow(idx, fullRender = false) {
  const item = manualInvoiceItems[idx];
  if (!item) return;

  const q = num(item.qty) || 0;
  const price = num(item.buyPrice) || 0;
  const gross = q * price;
  const disc = num(item.discountRp) || 0;
  item.subtotal = Math.max(0, gross - disc);

  if (fullRender) {
    renderManualInvoiceItems();
  } else {
    const row = document.querySelector(`tr[data-index="${idx}"]`);
    if (row) {
      const subtotalEl = row.querySelector(".row-subtotal-cell") || row.children[13];
      if (subtotalEl) subtotalEl.textContent = rupiah(item.subtotal);
      const baseEl = row.querySelector(".row-total-base-cell") || row.children[9];
      if (baseEl) {
        const totalBase = q * (num(item.conversionRatio) || 1);
        baseEl.innerHTML = `${totalBase} <small style="font-size:10px;">${escapeHtml(item.baseUnit || '')}</small>`;
      }
    }
  }

  calculateManualInvoiceTotals();
}

function calculateManualInvoiceTotals() {
  const discType = $("manual-inv-discount-type")?.value || "item";
  const ppnRateSelect = $("manual-inv-ppn-rate")?.value || "11";
  const printedTotalInput = num($("manual-inv-printed-total")?.value) || 0;

  let gross = 0;
  let itemDiscTotal = 0;

  manualInvoiceItems.forEach(item => {
    const q = num(item.qty) || 0;
    const p = num(item.buyPrice) || 0;
    gross += (q * p);
    itemDiscTotal += (num(item.discountRp) || 0);
  });

  let globalDisc = 0;
  if (discType === "global") {
    globalDisc = num($("manual-inv-global-discount-rp")?.value) || 0;
  }

  const totalDisc = discType === "global" ? globalDisc : itemDiscTotal;
  const dpp = Math.max(0, gross - totalDisc);

  let ppn = 0;
  if (ppnRateSelect === "11") {
    ppn = Math.round(dpp * 0.11);
  } else if (ppnRateSelect === "0") {
    ppn = 0;
  } else if (ppnRateSelect === "custom") {
    ppn = num($("manual-inv-custom-ppn-rp")?.value) || 0;
  }

  const systemTotal = dpp + ppn;
  const selisih = Math.abs(systemTotal - printedTotalInput);

  if ($("rec-subtotal-gross")) $("rec-subtotal-gross").textContent = rupiah(gross);
  if ($("rec-discount-item")) $("rec-discount-item").textContent = rupiah(totalDisc);
  if ($("rec-dpp")) $("rec-dpp").textContent = rupiah(dpp);
  if ($("rec-ppn")) $("rec-ppn").textContent = rupiah(ppn);
  if ($("rec-total-system")) $("rec-total-system").textContent = rupiah(systemTotal);
  if ($("rec-total-printed")) $("rec-total-printed").textContent = rupiah(printedTotalInput);

  const banner = $("rec-status-banner");
  const icon = $("rec-status-icon");
  const text = $("rec-status-text");
  const diffEl = $("rec-diff-amount");

  if (diffEl) diffEl.textContent = `Selisih: ${rupiah(selisih)}`;

  if (printedTotalInput === 0 && !manualInvoiceItems.some(i => i.buyPrice > 0)) {
    if (banner) {
      banner.className = "";
      banner.style.background = "#f1f5f9";
      banner.style.color = "#475569";
    }
    if (icon) icon.className = "fa-solid fa-circle-info";
    if (text) text.textContent = "Masukkan data obat dan nominal total tercetak fisik di kertas faktur.";
  } else if (selisih <= INVOICE_TOLERANCE_RP) {
    if (banner) {
      banner.className = "rec-banner-match";
    }
    if (icon) icon.className = "fa-solid fa-circle-check";
    if (text) text.textContent = "COCOK / VALID: Hitungan sistem selaras dengan total fisik faktur (toleransi <= Rp10).";
  } else {
    if (banner) {
      banner.className = "rec-banner-mismatch";
    }
    if (icon) icon.className = "fa-solid fa-triangle-exclamation";
    if (text) text.textContent = `PERHATIAN: Ada selisih ${rupiah(selisih)} dengan fisik kertas! Periksa kembali Qty, Harga Satuan, Diskon, atau PPN.`;
  }

  return {
    gross,
    totalDisc,
    dpp,
    ppn,
    systemTotal,
    printedTotal: printedTotalInput,
    selisih
  };
}

function handleSaveManualDraft() {
  const payload = {
    supplierName: $("manual-inv-supplier")?.value || "",
    invoiceNumber: $("manual-inv-number")?.value || "",
    date: $("manual-inv-date")?.value || "",
    paymentType: $("manual-inv-payment-type")?.value || "tempo",
    dueDate: $("manual-inv-due-date")?.value || "",
    discountType: $("manual-inv-discount-type")?.value || "item",
    globalDiscountRp: num($("manual-inv-global-discount-rp")?.value) || 0,
    ppnRate: $("manual-inv-ppn-rate")?.value || "11",
    customPpnRp: num($("manual-inv-custom-ppn-rp")?.value) || 0,
    printedTotal: $("manual-inv-printed-total")?.value || "",
    items: manualInvoiceItems
  };

  try {
    localStorage.setItem(MANUAL_DRAFT_KEY, JSON.stringify(payload));
    window.KasirProDialog?.success("Draft Tersimpan", "Seluruh baris dan data faktur manual berhasil disimpan di browser (0 kuota Firebase).");
  } catch (e) {
    window.KasirProDialog?.error("Gagal", e.message);
  }
}

async function handleResetManualInvoice() {
  const ok = await window.KasirProDialog?.confirm("Bersihkan Form", "Kosongkan seluruh isian dan daftar item faktur manual?");
  if (!ok) return;

  manualInvoiceItems = [];
  try { localStorage.removeItem(MANUAL_DRAFT_KEY); } catch (e) {}

  if ($("manual-inv-number")) $("manual-inv-number").value = "";
  if ($("manual-inv-payment-type")) $("manual-inv-payment-type").value = "tempo";
  handlePaymentTypeChange();
  if ($("manual-inv-printed-total")) $("manual-inv-printed-total").value = "";
  if ($("manual-inv-global-discount-rp")) $("manual-inv-global-discount-rp").value = 0;
  if ($("manual-inv-custom-ppn-rp")) $("manual-inv-custom-ppn-rp").value = 0;

  addManualInvoiceRow();
  calculateManualInvoiceTotals();
}

async function handleConfirmManualInvoice() {
  const supName = text($("manual-inv-supplier")?.value);
  const invNum = text($("manual-inv-number")?.value);
  const invDate = text($("manual-inv-date")?.value);
  const payType = $("manual-inv-payment-type")?.value || "tempo";
  let invDueDate = text($("manual-inv-due-date")?.value);
  const discType = $("manual-inv-discount-type")?.value || "item";
  const ppnRateSelect = $("manual-inv-ppn-rate")?.value || "11";

  if (!supName) {
    window.KasirProDialog?.warning("Perhatian", "Silakan pilih Nama Supplier faktur.");
    return;
  }
  if (!invNum) {
    window.KasirProDialog?.warning("Perhatian", "Nomor Faktur Fisik wajib diisi.");
    return;
  }
  if (!invDate) {
    window.KasirProDialog?.warning("Perhatian", "Tanggal Faktur wajib diisi.");
    return;
  }

  if (payType === "tempo") {
    if (!invDueDate) {
      const d = new Date(invDate);
      d.setDate(d.getDate() + 30);
      invDueDate = d.toISOString().slice(0, 10);
    }
  } else {
    // Tunai
    invDueDate = invDate;
  }

  // Cek duplikasi nomor faktur
  const exists = currentInvoices.some(i => norm(i.invoiceNumber) === norm(invNum) && (norm(i.status) === "terkonfirmasi" || norm(i.status) === "confirmed"));
  if (exists) {
    window.KasirProDialog?.warning("Faktur Duplikat", `Nomor faktur "${invNum}" sudah pernah dikonfirmasi sebelumnya. Import ulang ditolak sesuai aturan.`);
    return;
  }

  // Validasi item
  const validItems = manualInvoiceItems.filter(i => text(i.name) && num(i.qty) > 0);
  if (!validItems.length) {
    window.KasirProDialog?.warning("Item Kosong", "Minimal harus ada 1 baris produk dengan Nama dan Qty yang valid.");
    return;
  }

  const calcs = calculateManualInvoiceTotals();
  if (calcs.printedTotal <= 0) {
    window.KasirProDialog?.warning("Perhatian", "Silakan isi 'Total Akhir Tercetak di Kertas' untuk verifikasi rekonsiliasi.");
    return;
  }

  const invoiceId = uid("inv");
  const invPayload = {
    id: invoiceId,
    invoiceNumber: invNum,
    date: invDate,
    invoiceDate: invDate,
    paymentMethod: payType,
    paymentType: payType,
    paymentStatus: payType === "tunai" ? "Lunas" : "Belum Lunas",
    dueDate: invDueDate || "",
    supplierName: supName,
    supplier: supName,
    discountMethod: discType,
    subtotal: calcs.gross,
    discountGlobal: calcs.totalDisc,
    discountGlobalPercent: 0,
    taxGlobal: calcs.ppn,
    taxGlobalPercent: ppnRateSelect === "11" ? 11 : 0,
    total: calcs.printedTotal > 0 ? calcs.printedTotal : calcs.systemTotal,
    calculatedTotal: calcs.systemTotal,
    selisih: calcs.selisih,
    toleranceStatus: calcs.selisih <= INVOICE_TOLERANCE_RP ? "PAS" : "SELISIH",
    status: "Terkonfirmasi",
    notes: `Input Manual Grid [Rekonsiliasi: ${calcs.selisih <= INVOICE_TOLERANCE_RP ? 'COCOK' : 'SELISIH Rp' + calcs.selisih}]`,
    items: validItems.map((item, i) => ({
      no: i + 1,
      name: item.name,
      productCode: item.productCode || "",
      matchedProductCode: item.productCode || "",
      barcode: item.barcode || "",
      qty: num(item.qty),
      purchaseUnit: item.purchaseUnit || "BOX",
      intermediateUnit: item.intermediateUnit || "",
      intermediateQty: num(item.intermediateQty) || 1,
      baseUnit: item.baseUnit || "TABLET",
      conversionRatio: num(item.conversionRatio) || 1,
      buyPrice: num(item.buyPrice),
      discountPercent: num(item.discountPercent) || 0,
      discountRp: num(item.discountRp) || 0,
      subtotal: num(item.subtotal),
      batch: item.batch || "",
      expiryDate: item.expiryDate || "",
      conversionStatus: "TERVERIFIKASI"
    }))
  };

  await executeConfirmInvoice(invPayload);
}

/**
 * 3. MODAL DETAIL FAKTUR
 */
function installInvoiceDetailModal() {
  if ($("modal-invoice-detail")) return;

  const modalHtml = `
    <div id="modal-invoice-detail" class="kp-dialog-v4" hidden>
      <div class="kp-dialog-v4__backdrop"></div>
      <section class="kp-dialog-v4__card" style="width:min(96vw,800px);max-height:92vh;overflow-y:auto;" role="dialog">
        <header style="padding:18px 24px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
          <div>
            <h2 id="invoice-detail-title" style="font-size:18px;font-weight:800;margin:0;">Detail Faktur Pembelian</h2>
            <span id="invoice-detail-sub" style="font-size:12.5px;color:#64748b;">—</span>
          </div>
          <button type="button" id="close-modal-invoice-detail" class="button button-small button-secondary" style="padding:4px 8px;"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <div id="invoice-detail-body" style="padding:20px;text-align:left;">
          <!-- Konten dinamis -->
        </div>
        <footer style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div>
            <button type="button" id="btn-print-detail-pdf" class="button button-secondary"><i class="fa-solid fa-file-pdf"></i> Cetak PDF</button>
          </div>
          <div style="display:flex;gap:8px;">
            <button type="button" id="btn-invoice-action-danger" class="button button-danger" style="background:#ef4444;color:#fff;"><i class="fa-solid fa-trash-can"></i> Hapus Faktur</button>
            <button type="button" id="btn-correct-invoice" class="button button-warning"><i class="fa-solid fa-pen-to-square"></i> Koreksi Faktur</button>
          </div>
        </footer>
      </section>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  $("close-modal-invoice-detail")?.addEventListener("click", closeInvoiceDetailModal);
  $("btn-print-detail-pdf")?.addEventListener("click", () => {
    if (activeDetailInvoice) handlePrintInvoicePdf(activeDetailInvoice);
  });
  $("btn-invoice-action-danger")?.addEventListener("click", () => {
    if (!activeDetailInvoice) return;
    const isConfirmed = norm(activeDetailInvoice.status) === "terkonfirmasi" || norm(activeDetailInvoice.status) === "confirmed";
    if (isConfirmed) {
      handleReversalCancelInvoice();
    } else {
      handleDeleteInvoice();
    }
  });
  $("btn-correct-invoice")?.addEventListener("click", () => {
    if (activeDetailInvoice) openInvoiceCorrectionModal(activeDetailInvoice);
  });
}

function openInvoiceDetailModal(inv) {
  activeDetailInvoice = inv;
  const modal = $("modal-invoice-detail");
  if (!modal) return;

  $("invoice-detail-title").textContent = `Faktur #${inv.invoiceNumber || inv.id}`;
  $("invoice-detail-sub").textContent = `${inv.supplierName || inv.supplier} | Tanggal: ${inv.date || inv.invoiceDate}`;

  const isConfirmed = norm(inv.status) === "terkonfirmasi" || norm(inv.status) === "confirmed";
  const dangerBtn = $("btn-invoice-action-danger");
  if (dangerBtn) {
    if (isConfirmed) {
      dangerBtn.innerHTML = `<i class="fa-solid fa-ban"></i> Batalkan Faktur (Reversal Stok)`;
      dangerBtn.title = "Batalkan faktur ini dan kembalikan stok obat secara otomatis";
    } else {
      dangerBtn.innerHTML = `<i class="fa-solid fa-trash-can"></i> Hapus Faktur Permanen`;
      dangerBtn.title = "Hapus data faktur ini secara permanen dari sistem";
    }
  }

  const bodyEl = $("invoice-detail-body");
  const items = inv.items || [];
  const isTunai = (inv.paymentMethod === "tunai" || inv.paymentType === "tunai");
  const payBadge = isTunai
    ? `<span class="badge" style="background:#ecfdf5;color:#059669;padding:3.5px 9px;border-radius:6px;font-weight:750;display:inline-flex;align-items:center;gap:5px;"><i class="fa-solid fa-money-bill-wave"></i> Tunai (Lunas Langsung)</span>`
    : `<span class="badge" style="background:#eff6ff;color:#1d4ed8;padding:3.5px 9px;border-radius:6px;font-weight:750;display:inline-flex;align-items:center;gap:5px;"><i class="fa-solid fa-calendar-days"></i> Tempo (Jatuh Tempo: ${escapeHtml(inv.dueDate || '—')})</span>`;

  bodyEl.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:14px;background:#f8fafc;padding:14px;border-radius:10px;margin-bottom:16px;">
      <div><span style="font-size:12px;color:#64748b;">Status Faktur:</span><br>${getInvoiceStatusBadge(inv.status)}</div>
      <div><span style="font-size:12px;color:#64748b;">Metode Pembayaran:</span><br>${payBadge}</div>
      <div><span style="font-size:12px;color:#64748b;">Subtotal:</span><br><strong>${rupiah(inv.subtotal || 0)}</strong></div>
      <div><span style="font-size:12px;color:#64748b;">Diskon Global:</span><br><strong>${rupiah(inv.globalDiscountRp || 0)}</strong></div>
      <div><span style="font-size:12px;color:#64748b;">PPN Global:</span><br><strong>${rupiah(inv.globalTaxRp || 0)}</strong></div>
      <div><span style="font-size:12px;color:#64748b;">Total Faktur:</span><br><strong style="font-size:16px;color:#0f2a43;">${rupiah(inv.total || 0)}</strong></div>
    </div>
    ${inv.notes ? `<p style="font-size:12.5px;color:#475569;margin-bottom:16px;"><strong>Catatan:</strong> ${escapeHtml(inv.notes)}</p>` : ''}
    <h3 style="font-size:14px;font-weight:700;margin-bottom:8px;">Rincian Barang Faktur</h3>
    <div class="table-wrapper" style="max-height:280px;overflow-y:auto;">
      <table class="data-table">
        <thead>
          <tr>
            <th>No</th>
            <th>Nama Barang</th>
            <th>Qty</th>
            <th>Harga</th>
            <th>Diskon</th>
            <th>PPN</th>
            <th>Subtotal</th>
            <th>Batch / EXP</th>
          </tr>
        </thead>
        <tbody>
          ${items.map((it, i) => `
            <tr>
              <td>${i + 1}</td>
              <td><strong>${escapeHtml(it.name || it.productName || '—')}</strong></td>
              <td>${it.qty} ${escapeHtml(it.purchaseUnit || it.unit || 'Pcs')}</td>
              <td>${rupiah(it.buyPrice || it.price || 0)}</td>
              <td>${it.discountPercent || 0}%</td>
              <td>${it.taxPercent || 0}%</td>
              <td><strong>${rupiah(it.subtotal || 0)}</strong></td>
              <td>${escapeHtml(it.batch || '—')} / ${escapeHtml(it.expiryDate || '—')}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  modal.hidden = false;
}

async function handleDeleteInvoice() {
  if (!activeDetailInvoice) return;
  const inv = activeDetailInvoice;
  const invId = inv.id || inv.invoiceNumber;
  const isConfirmed = norm(inv.status) === "terkonfirmasi" || norm(inv.status) === "confirmed";

  let confirmMsg = `Hapus Faktur #${inv.invoiceNumber || invId} secara permanen dari sistem?`;
  if (isConfirmed) {
    confirmMsg += `\n\nFaktur ini berstatus Terkonfirmasi. Penghapusan akan otomatis membalik stok delta produk agar stok sistem kembali bersih.`;
  }

  const ok = await window.KasirProDialog?.confirm("Hapus Faktur", confirmMsg);
  if (!ok) return;

  try {
    await deletePurchaseInvoice(inv.id || inv.invoiceNumber);
    currentInvoices = readStore(STORE_KEYS.invoices, []);

    closeInvoiceDetailModal();
    renderInvoices();
    window.KasirProDialog?.success("Faktur Dihapus", `Faktur #${inv.invoiceNumber || invId} berhasil dihapus permanen dari sistem beserta mutasi stok terkait.`);
  } catch (err) {
    console.error("[Invoices] Error deleting invoice:", err);
    window.KasirProDialog?.error("Gagal Menghapus Faktur", err.message || "Terjadi kesalahan saat menghapus faktur.");
  }
}

function closeInvoiceDetailModal() {
  const modal = $("modal-invoice-detail");
  if (modal) modal.hidden = true;
  activeDetailInvoice = null;
}

/**
 * 4. CETAK PDF FAKTUR RESMI
 */
function handlePrintInvoicePdf(inv) {
  const master = readStore(STORE_KEYS.master, {});
  const settings = master.pengaturan_toko?.[0] || {};
  generatePurchaseInvoicePdf(inv, settings, "Administrator");
}

/**
 * 5. PEMBATALAN FAKTUR (REVERSAL VIA STOCK MOVEMENT)
 */
async function handleReversalCancelInvoice() {
  if (!activeDetailInvoice) return;
  const inv = activeDetailInvoice;

  const confirmed = await window.KasirProDialog?.confirm(
    "Pembatalan Faktur (Reversal)",
    `PERHATIAN: Pembatalan faktur Terkonfirmasi akan membalik stok produk secara otomatis melalui stock movement "Pembatalan Faktur". Histori faktur tetap disimpan sebagai jejak audit.\n\nLanjutkan pembatalan faktur #${inv.invoiceNumber}?`
  );
  if (!confirmed) return;

  try {
    const movements = [];
    const now = nowIso();
    const user = "Admin";

    // Balik stok tiap item
    for (const item of (inv.items || [])) {
      const code = item.matchedProductCode || item.code;
      const baseQty = (num(item.qty) || 1) * (num(item.conversionRatio) || 1);

      movements.push({
        id: uid("mov-rev"),
        productCode: code || item.name,
        productName: item.name,
        type: "Pembatalan Faktur",
        delta: -baseQty,
        quantity: -baseQty,
        source: "Pembatalan Faktur",
        reference: inv.invoiceNumber,
        user,
        createdAt: now
      });
    }

    inv.status = "Dibatalkan";
    inv.cancelledAt = now;
    inv.cancelledBy = user;

    await writeStockTransaction([
      { key: STORE_KEYS.invoices, records: [inv] },
      { key: STORE_KEYS.movements, records: movements }
    ]);

    closeInvoiceDetailModal();
    renderInvoices();
    window.KasirProDialog?.success("Faktur Dibatalkan", `Faktur #${inv.invoiceNumber} berhasil dibatalkan dan stok telah dibalik secara aman.`);
  } catch (err) {
    window.KasirProDialog?.error("Gagal Membatalkan Faktur", err.message);
  }
}

/**
 * 6. MODAL KOREKSI FAKTUR (ADMINISTRATIF & TRANSAKSIONAL)
 */
function installInvoiceCorrectionModal() {
  if ($("modal-invoice-correction")) return;

  const modalHtml = `
    <div id="modal-invoice-correction" class="kp-dialog-v4" hidden>
      <div class="kp-dialog-v4__backdrop"></div>
      <section class="kp-dialog-v4__card" style="width:min(94vw,520px);" role="dialog">
        <header style="padding:18px 20px 12px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
          <h2 style="font-size:16px;font-weight:800;margin:0;">Koreksi Faktur Pembelian</h2>
          <button type="button" id="close-modal-correction" class="button button-small button-secondary" style="padding:4px 8px;"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <div style="padding:20px;text-align:left;">
          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Metode Koreksi</label>
          <select id="corr-method" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;margin-bottom:14px;">
            <option value="admin">Koreksi Administratif (Hanya perbaiki info tanpa efek stok)</option>
            <option value="trx">Koreksi Transaksional (Perbaiki catatan nominal / stok delta)</option>
          </select>

          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Alasan Koreksi <span class="text-danger">*</span></label>
          <input type="text" id="corr-reason" required style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;margin-bottom:14px;" placeholder="Contoh: Kesalahan nomor faktur dari supplier">

          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Catatan Koreksi Tambahan</label>
          <textarea id="corr-notes" rows="2" style="width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;margin-bottom:14px;" placeholder="Keterangan perbaikan..."></textarea>
        </div>
        <footer style="padding:12px 20px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:8px;">
          <button type="button" id="cancel-correction" class="button button-secondary">Batal</button>
          <button type="button" id="save-correction" class="button button-primary"><i class="fa-solid fa-floppy-disk"></i> Simpan Koreksi</button>
        </footer>
      </section>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  $("close-modal-correction")?.addEventListener("click", closeInvoiceCorrectionModal);
  $("cancel-correction")?.addEventListener("click", closeInvoiceCorrectionModal);
  $("save-correction")?.addEventListener("click", handleSaveInvoiceCorrection);
}

function openInvoiceCorrectionModal(inv) {
  const modal = $("modal-invoice-correction");
  if (!modal) return;
  $("corr-reason").value = "";
  $("corr-notes").value = "";
  modal.hidden = false;
  setTimeout(() => $("corr-reason")?.focus(), 50);
}

function closeInvoiceCorrectionModal() {
  const modal = $("modal-invoice-correction");
  if (modal) modal.hidden = true;
}

async function handleSaveInvoiceCorrection() {
  if (!activeDetailInvoice) return;
  const inv = activeDetailInvoice;
  const method = $("corr-method")?.value || "admin";
  const reason = text($("corr-reason")?.value);
  const notes = text($("corr-notes")?.value);

  if (!reason) {
    window.KasirProDialog?.warning("Perhatian", "Alasan koreksi wajib diisi.");
    return;
  }

  const now = nowIso();
  const user = "Admin";

  const correctionEntry = {
    method,
    reason,
    notes,
    correctedAt: now,
    correctedBy: user
  };

  inv.corrections = Array.isArray(inv.corrections) ? [...inv.corrections, correctionEntry] : [correctionEntry];
  inv.notes = `${inv.notes || ''} [Koreksi ${method.toUpperCase()}: ${reason}]`.trim();

  try {
    await writeStore(STORE_KEYS.invoices, currentInvoices);
    closeInvoiceCorrectionModal();
    closeInvoiceDetailModal();
    renderInvoices();
    window.KasirProDialog?.success("Koreksi Disimpan", "Riwayat koreksi faktur berhasil dicatat tanpa menghapus histori asli.");
  } catch (err) {
    window.KasirProDialog?.error("Gagal Menyimpan Koreksi", err.message);
  }
}
