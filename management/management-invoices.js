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
import { STORE_KEYS, readStore, writeStore, writeMasterDelta, readCurrentStock, setActiveStock, writeStockTransaction, databaseStore, deletePurchaseInvoice } from "../modules/database/database-store.js";
import { generatePurchaseInvoicePdf } from "../modules/core/pdf.js";
import { generateAutoProductCode } from "./management-products.js";

let currentInvoices = [];
let activeDetailInvoice = null;
let editingInvoice = null;

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
  $("btn-toggle-all-inv-rows")?.addEventListener("click", toggleAllManualInvoiceRows);
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
  $("btn-toggle-inv-header")?.addEventListener("click", () => toggleManualInvoiceHeader());
  $("manual-inv-number")?.addEventListener("input", updateManualInvoiceHeaderSummary);
  $("manual-inv-due-date")?.addEventListener("change", updateManualInvoiceHeaderSummary);

  // Auto format titik live pada input header mata uang
  const setupLiveCurrencyInput = (elId) => {
    const el = $(elId);
    if (!el) return;
    el.addEventListener("input", (e) => {
      const digits = e.target.value.replace(/[^0-9]/g, "");
      const valNum = parseInt(digits, 10) || 0;
      e.target.value = valNum ? formatNumber(valNum) : "";
      calculateManualInvoiceTotals();
      updateManualInvoiceHeaderSummary();
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
  $("invoice-payment-filter")?.addEventListener("change", (e) => {
    activeInvoicePaymentFilter = e.target.value;
    renderInvoicesTable();
  });

  // Detail Modal Actions
  installInvoiceDetailModal();
  installInvoiceCorrectionModal();
}

let activeInvoicePaymentFilter = "all";

export function parseInvoiceDate(val) {
  if (!val) return null;
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? null : val;
  const s = String(val).trim();
  if (!s) return null;
  const dmyMatch = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (dmyMatch) {
    const d = new Date(Number(dmyMatch[3]), Number(dmyMatch[2]) - 1, Number(dmyMatch[1]), 0, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const ymdMatch = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (ymdMatch) {
    const d = new Date(Number(ymdMatch[1]), Number(ymdMatch[2]) - 1, Number(ymdMatch[3]), 0, 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 0, 0, 0);
}

export function getInvoicePaymentInfo(inv, referenceDate = new Date()) {
  if (!inv) {
    return {
      isTempo: false,
      isPaid: true,
      statusLabel: "Lunas",
      badgeClass: "badge-success",
      badgeStyle: "background:#ecfdf5;color:#059669;border:1px solid #a7f3d0;",
      colorTheme: "card-success",
      daysLeft: null,
      dueState: "paid",
      reminderText: "Lunas"
    };
  }

  const payType = norm(inv.paymentType || inv.paymentMethod || "tempo");
  const isTempo = payType === "tempo";
  const payStatusNorm = norm(inv.paymentStatus || "");
  const isPaid = !isTempo || payStatusNorm === "lunas" || Boolean(inv.paidAt);

  if (!isTempo) {
    return {
      isTempo: false,
      isPaid: true,
      statusLabel: "Tunai (Lunas)",
      badgeClass: "badge-success",
      badgeStyle: "background:#ecfdf5;color:#059669;border:1px solid #a7f3d0;",
      colorTheme: "card-success",
      daysLeft: null,
      dueState: "paid",
      reminderText: "Lunas Tunai"
    };
  }

  if (isPaid) {
    return {
      isTempo: true,
      isPaid: true,
      statusLabel: "Tempo (Sudah Lunas)",
      badgeClass: "badge-success",
      badgeStyle: "background:#ecfdf5;color:#059669;border:1px solid #a7f3d0;",
      colorTheme: "card-success",
      daysLeft: null,
      dueState: "paid",
      reminderText: "Sudah Bayar"
    };
  }

  // Tempo Belum Lunas
  const dueDate = parseInvoiceDate(inv.dueDate);
  if (!dueDate) {
    return {
      isTempo: true,
      isPaid: false,
      statusLabel: "Tempo (Belum Lunas)",
      badgeClass: "badge-primary",
      badgeStyle: "background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;",
      colorTheme: "card-primary",
      daysLeft: null,
      dueState: "no_due",
      reminderText: "Tempo Belum Lunas"
    };
  }

  const ref = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate(), 0, 0, 0);
  const diffTime = dueDate.getTime() - ref.getTime();
  const daysLeft = Math.round(diffTime / (1000 * 60 * 60 * 24));

  if (daysLeft < 0) {
    const overdueDays = Math.abs(daysLeft);
    return {
      isTempo: true,
      isPaid: false,
      statusLabel: `Lewat Tempo (H+${overdueDays})`,
      badgeClass: "badge-danger",
      badgeStyle: "background:#fef2f2;color:#dc2626;border:1px solid #fecaca;",
      colorTheme: "card-danger",
      daysLeft,
      dueState: "overdue",
      reminderText: `Terlambat ${overdueDays} hari!`
    };
  }

  if (daysLeft === 0) {
    return {
      isTempo: true,
      isPaid: false,
      statusLabel: "Jatuh Tempo Hari Ini",
      badgeClass: "badge-warning",
      badgeStyle: "background:#fffbeb;color:#d97706;border:1px solid #fde68a;",
      colorTheme: "card-warning",
      daysLeft: 0,
      dueState: "due_soon",
      reminderText: "Jatuh tempo hari ini!"
    };
  }

  if (daysLeft <= 3) {
    return {
      isTempo: true,
      isPaid: false,
      statusLabel: `Jatuh Tempo (H-${daysLeft})`,
      badgeClass: "badge-warning",
      badgeStyle: "background:#fffbeb;color:#d97706;border:1px solid #fde68a;",
      colorTheme: "card-warning",
      daysLeft,
      dueState: "due_soon",
      reminderText: `Sisa ${daysLeft} hari lagi`
    };
  }

  return {
    isTempo: true,
    isPaid: false,
    statusLabel: `Tempo (Sisa ${daysLeft} Hari)`,
    badgeClass: "badge-primary",
    badgeStyle: "background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;",
    colorTheme: "card-primary",
    daysLeft,
    dueState: "safe",
    reminderText: `Jatuh tempo: ${inv.dueDate}`
  };
}

export function getInvoicePaymentBadge(payInfo) {
  if (!payInfo) return "";
  let icon = "fa-calendar-days";
  if (payInfo.isPaid) {
    icon = payInfo.isTempo ? "fa-circle-check" : "fa-money-bill-wave";
  } else if (payInfo.dueState === "overdue") {
    icon = "fa-circle-exclamation";
  } else if (payInfo.dueState === "due_soon") {
    icon = "fa-triangle-exclamation";
  }

  return `<span class="badge ${payInfo.badgeClass}" style="${payInfo.badgeStyle}padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;display:inline-flex;align-items:center;gap:4px;"><i class="fa-solid ${icon}"></i> ${escapeHtml(payInfo.statusLabel)}</span>`;
}

export async function toggleMarkInvoicePaid(invId, markAsPaid = true) {
  const existingInvoices = readStore(STORE_KEYS.invoices, []);
  const idx = existingInvoices.findIndex(x => (x.id === invId || x.invoiceNumber === invId));
  if (idx < 0) {
    window.KasirProDialog?.error("Faktur Tidak Ditemukan", "Data faktur tidak ditemukan di penyimpanan lokal.");
    return false;
  }

  const inv = existingInvoices[idx];
  const invNo = inv.invoiceNumber || inv.id;
  const totalRp = rupiah(inv.total || 0);

  if (markAsPaid) {
    const ok = await window.KasirProDialog?.confirm(
      "Konfirmasi Pelunasan Faktur",
      `Tandai Faktur #${invNo} senilai ${totalRp} dari ${inv.supplierName || inv.supplier || "Supplier"} sebagai SUDAH BAYAR / LUNAS?`
    );
    if (!ok) return false;

    const now = nowIso();
    const updatedInv = {
      ...inv,
      paymentStatus: "Lunas",
      paidAt: now,
      paidBy: "Admin"
    };
    existingInvoices[idx] = updatedInv;
    await writeStore(STORE_KEYS.invoices, existingInvoices);
    currentInvoices = existingInvoices;
    renderInvoices();
    if (activeDetailInvoice && (activeDetailInvoice.id === invId || activeDetailInvoice.invoiceNumber === invId)) {
      openInvoiceDetailModal(updatedInv);
    }
    window.dispatchEvent(new CustomEvent("kasirpro:database-synced"));
    window.KasirProDialog?.success("Faktur Lunas", `Faktur #${invNo} berhasil ditandai sebagai Sudah Bayar.`);
    return true;
  } else {
    const ok = await window.KasirProDialog?.confirm(
      "Batalkan Status Lunas",
      `Kembalikan status Faktur #${invNo} senilai ${totalRp} menjadi BELUM LUNAS?`
    );
    if (!ok) return false;

    const updatedInv = {
      ...inv,
      paymentStatus: "Belum Lunas",
      paidAt: null,
      paidBy: null
    };
    existingInvoices[idx] = updatedInv;
    await writeStore(STORE_KEYS.invoices, existingInvoices);
    currentInvoices = existingInvoices;
    renderInvoices();
    if (activeDetailInvoice && (activeDetailInvoice.id === invId || activeDetailInvoice.invoiceNumber === invId)) {
      openInvoiceDetailModal(updatedInv);
    }
    window.dispatchEvent(new CustomEvent("kasirpro:database-synced"));
    window.KasirProDialog?.info("Status Diperbarui", `Status Faktur #${invNo} dikembalikan menjadi Belum Lunas.`);
    return true;
  }
}

// Pasang binding global window
if (typeof window !== "undefined") {
  window.toggleMarkInvoicePaid = toggleMarkInvoicePaid;
  window.getInvoicePaymentInfo = getInvoicePaymentInfo;
  window.setInvoicePaymentFilter = (filter) => {
    activeInvoicePaymentFilter = filter;
    const sel = $("invoice-payment-filter");
    if (sel) sel.value = filter;
    renderInvoicesTable();
  };
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
  const cardList = $("invoice-card-list");
  if (!tbody && !cardList) return;

  const q = norm($("invoice-search")?.value);
  const statusFilter = norm($("invoice-status-filter")?.value);
  const now = new Date();

  // 1. Hitung counter untuk Filter Pills & Alert Banner
  let countAll = currentInvoices.length;
  let countTempoUnpaid = 0;
  let countDueSoon = 0;
  let countOverdue = 0;
  let countPaid = 0;
  let urgentTotal = 0;

  currentInvoices.forEach(inv => {
    const pInfo = getInvoicePaymentInfo(inv, now);
    if (pInfo.isPaid) {
      countPaid++;
    } else if (pInfo.isTempo) {
      countTempoUnpaid++;
      if (pInfo.dueState === "due_soon") {
        countDueSoon++;
        urgentTotal += num(inv.total);
      } else if (pInfo.dueState === "overdue") {
        countOverdue++;
        urgentTotal += num(inv.total);
      }
    }
  });

  // 2. Render Alert Banner Pengingat H-3 di Halaman Faktur
  const reminderBanner = $("invoice-due-reminder-banner");
  if (reminderBanner) {
    const urgentCount = countDueSoon + countOverdue;
    if (urgentCount > 0) {
      reminderBanner.style.display = "block";
      reminderBanner.innerHTML = `
        <div style="background:#fffbeb;border:1px solid #fde68a;border-left:5px solid #f59e0b;padding:12px 16px;border-radius:10px;display:flex;align-items:center;justify-content:space-between;gap:12px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
          <div style="display:flex;align-items:center;gap:12px;">
            <div style="width:36px;height:36px;border-radius:50%;background:#fef3c7;color:#b45309;display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;">
              <i class="fa-solid fa-triangle-exclamation"></i>
            </div>
            <div>
              <div style="font-weight:700;color:#92400e;font-size:13.5px;">Peringatan Jatuh Tempo Faktur Supplier</div>
              <div style="font-size:12px;color:#b45309;">
                Terdapat <strong>${urgentCount} faktur tempo</strong> senilai <strong>${rupiah(urgentTotal)}</strong> yang mendekati atau telah lewat tanggal jatuh tempo.
              </div>
            </div>
          </div>
          <button type="button" id="btn-filter-urgent-invoices" class="button button-small button-warning" style="white-space:nowrap;font-weight:700;display:inline-flex;align-items:center;gap:6px;">
            <i class="fa-solid fa-filter"></i> Tampilkan
          </button>
        </div>
      `;
      $("btn-filter-urgent-invoices")?.addEventListener("click", () => {
        activeInvoicePaymentFilter = "due_soon";
        const sel = $("invoice-payment-filter");
        if (sel) sel.value = "due_soon";
        renderInvoicesTable();
      });
    } else {
      reminderBanner.style.display = "none";
      reminderBanner.innerHTML = "";
    }
  }

  // 3. Render Filter Pills Cepat
  const pillsContainer = $("invoice-payment-pills");
  if (pillsContainer) {
    const pillDefs = [
      { key: "all", label: "Semua", count: countAll, badgeBg: "#e2e8f0", badgeColor: "#334155" },
      { key: "tempo_unpaid", label: "Tempo Belum Lunas", count: countTempoUnpaid, badgeBg: "#e0f2fe", badgeColor: "#0284c7" },
      { key: "due_soon", label: "Jatuh Tempo (H-3)", count: countDueSoon, badgeBg: countDueSoon > 0 ? "#fef3c7" : "#f1f5f9", badgeColor: countDueSoon > 0 ? "#b45309" : "#64748b" },
      { key: "overdue", label: "Lewat Jatuh Tempo", count: countOverdue, badgeBg: countOverdue > 0 ? "#fee2e2" : "#f1f5f9", badgeColor: countOverdue > 0 ? "#b91c1c" : "#64748b" },
      { key: "paid", label: "Lunas", count: countPaid, badgeBg: "#dcfce7", badgeColor: "#15803d" }
    ];

    pillsContainer.innerHTML = pillDefs.map(p => {
      const isActive = activeInvoicePaymentFilter === p.key;
      const activeStyle = isActive
        ? "background:#0284c7;color:#fff;border-color:#0284c7;font-weight:700;"
        : "background:#fff;color:#475569;border-color:#cbd5e1;";
      const countStyle = isActive
        ? "background:rgba(255,255,255,0.25);color:#fff;"
        : `background:${p.badgeBg};color:${p.badgeColor};`;

      return `
        <button type="button" class="invoice-pill-btn" data-filter="${p.key}" style="border:1px solid;border-radius:20px;padding:4px 12px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:all 0.15s;${activeStyle}">
          <span>${p.label}</span>
          <span style="font-size:10px;font-weight:800;padding:1px 6px;border-radius:10px;${countStyle}">${p.count}</span>
        </button>
      `;
    }).join("");

    pillsContainer.querySelectorAll(".invoice-pill-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        activeInvoicePaymentFilter = btn.dataset.filter;
        const sel = $("invoice-payment-filter");
        if (sel) sel.value = activeInvoicePaymentFilter;
        renderInvoicesTable();
      });
    });
  }

  // 4. Filter List Faktur
  const filtered = currentInvoices.filter(inv => {
    const no = norm(inv.invoiceNumber || inv.id);
    const sup = norm(inv.supplierName || inv.supplier);
    const status = norm(inv.status);
    const payInfo = getInvoicePaymentInfo(inv, now);

    if (q && !no.includes(q) && !sup.includes(q)) return false;
    if (statusFilter && status !== statusFilter) return false;

    if (activeInvoicePaymentFilter === "tempo_unpaid") {
      if (!payInfo.isTempo || payInfo.isPaid) return false;
    } else if (activeInvoicePaymentFilter === "due_soon") {
      if (!payInfo.isTempo || payInfo.isPaid || (payInfo.dueState !== "due_soon" && payInfo.dueState !== "overdue")) return false;
    } else if (activeInvoicePaymentFilter === "overdue") {
      if (!payInfo.isTempo || payInfo.isPaid || payInfo.dueState !== "overdue") return false;
    } else if (activeInvoicePaymentFilter === "paid") {
      if (!payInfo.isPaid) return false;
    }

    return true;
  });

  if (!filtered.length) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="empty-table-state" style="text-align:center;padding:24px;">Tidak ada faktur pembelian yang sesuai dengan filter.</td></tr>`;
    if (cardList) cardList.innerHTML = `<div style="text-align:center;padding:32px 16px;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;color:#64748b;"><i class="fa-solid fa-file-invoice" style="font-size:28px;margin-bottom:8px;color:#94a3b8;display:block;"></i>Tidak ada faktur pembelian yang sesuai dengan filter.</div>`;
    return;
  }

  // 5. Render Desktop Table Rows
  if (tbody) {
    tbody.innerHTML = filtered.map(inv => {
      const id = inv.id || inv.invoiceNumber;
      const no = inv.invoiceNumber || inv.id || "—";
      const date = inv.date || inv.invoiceDate || "—";
      const sup = inv.supplierName || inv.supplier || "—";
      const itemCount = (inv.items || []).length;
      const total = num(inv.total);
      const status = inv.status || "Perlu Review";
      const payInfo = getInvoicePaymentInfo(inv, now);

      let payActionBtn = "";
      if (payInfo.isTempo && !payInfo.isPaid) {
        payActionBtn = `
          <button type="button" class="btn-toggle-paid button button-small button-success" data-id="${escapeHtml(id)}" data-action="mark" style="background:#10b981;color:#fff;" title="Tandai Sudah Bayar">
            <i class="fa-solid fa-check"></i> Sudah Bayar
          </button>
        `;
      } else if (payInfo.isTempo && payInfo.isPaid) {
        payActionBtn = `
          <button type="button" class="btn-toggle-paid button button-small button-secondary" data-id="${escapeHtml(id)}" data-action="unmark" title="Batalkan Lunas">
            <i class="fa-solid fa-rotate-left"></i>
          </button>
        `;
      }

      return `
        <tr>
          <td><strong>${escapeHtml(no)}</strong></td>
          <td>${escapeHtml(date)}</td>
          <td>${escapeHtml(sup)}</td>
          <td>${itemCount} item</td>
          <td><strong>${rupiah(total)}</strong></td>
          <td>${getInvoiceStatusBadge(status)}</td>
          <td>${getInvoicePaymentBadge(payInfo)}</td>
          <td>
            <div style="display:flex;gap:6px;align-items:center;">
              <button type="button" class="btn-detail-invoice button button-small button-secondary" data-id="${escapeHtml(id)}">
                <i class="fa-solid fa-eye"></i> Detail
              </button>
              <button type="button" class="btn-pdf-invoice button button-small button-secondary" data-id="${escapeHtml(id)}" title="Cetak PDF">
                <i class="fa-solid fa-file-pdf"></i>
              </button>
              ${payActionBtn}
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }

  // 6. Render Mobile Collapsible Cards (Default Diciutkan)
  if (cardList) {
    cardList.innerHTML = filtered.map(inv => {
      const id = inv.id || inv.invoiceNumber;
      const no = inv.invoiceNumber || inv.id || "—";
      const date = inv.date || inv.invoiceDate || "—";
      const sup = inv.supplierName || inv.supplier || "—";
      const itemCount = (inv.items || []).length;
      const total = num(inv.total);
      const status = inv.status || "Perlu Review";
      const payInfo = getInvoicePaymentInfo(inv, now);

      let cardPayActionBtn = "";
      if (payInfo.isTempo && !payInfo.isPaid) {
        cardPayActionBtn = `
          <button type="button" class="btn-toggle-paid button button-small button-success" data-id="${escapeHtml(id)}" data-action="mark" style="background:#10b981;color:#fff;">
            <i class="fa-solid fa-check"></i> Sudah Bayar
          </button>
        `;
      } else if (payInfo.isTempo && payInfo.isPaid) {
        cardPayActionBtn = `
          <button type="button" class="btn-toggle-paid button button-small button-secondary" data-id="${escapeHtml(id)}" data-action="unmark">
            <i class="fa-solid fa-rotate-left"></i> Batal Lunas
          </button>
        `;
      }

      const reminderSubHtml = payInfo.isTempo
        ? `<span>•</span><span style="font-weight:700;font-size:11px;color:${payInfo.isPaid ? '#059669' : (payInfo.dueState === 'overdue' ? '#dc2626' : (payInfo.dueState === 'due_soon' ? '#d97706' : '#2563eb'))};">${escapeHtml(payInfo.reminderText)}</span>`
        : "";

      return `
        <div class="responsive-data-card ${payInfo.colorTheme}" data-id="${escapeHtml(id)}">
          <div class="card-accordion-header">
            <div class="card-header-main">
              <div class="card-title-row" style="display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;">
                <div class="card-title">#${escapeHtml(no)}</div>
                <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
                  ${getInvoiceStatusBadge(status)}
                  ${getInvoicePaymentBadge(payInfo)}
                </div>
              </div>
              <div class="card-meta-row">
                <span class="card-meta-code"><i class="fa-solid fa-truck" style="font-size:10px;"></i> ${escapeHtml(sup)}</span>
                <span class="card-meta-dot">•</span>
                <span class="card-meta-sub"><i class="fa-regular fa-calendar" style="font-size:10px;"></i> ${escapeHtml(date)}</span>
              </div>
              <div class="card-kpi-strip">
                <div class="kpi-strip-item">
                  <span class="kpi-strip-label">Total Tagihan</span>
                  <span class="kpi-strip-val val-buy">${rupiah(total)}</span>
                </div>
                <div class="kpi-strip-item">
                  <span class="kpi-strip-label">Jumlah Item</span>
                  <span class="kpi-strip-val">${itemCount} Produk</span>
                </div>
                <div class="kpi-strip-item">
                  <span class="kpi-strip-label">${payInfo.isTempo ? 'Status Tempo' : 'Metode Bayar'}</span>
                  <span class="kpi-strip-val ${payInfo.isTempo && !payInfo.isPaid && payInfo.dueState === 'overdue' ? 'text-danger' : (payInfo.isTempo && !payInfo.isPaid && payInfo.dueState === 'due_soon' ? 'text-warning' : '')}">
                    ${payInfo.isTempo ? (payInfo.isPaid ? 'Lunas' : escapeHtml(payInfo.reminderText || inv.dueDate || 'Tempo')) : 'Tunai Lunas'}
                  </span>
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
                <span class="card-detail-label">Nomor Faktur</span>
                <span class="card-detail-value"><strong>#${escapeHtml(no)}</strong></span>
              </div>
              <div class="card-detail-item">
                <span class="card-detail-label">Supplier</span>
                <span class="card-detail-value">${escapeHtml(sup)}</span>
              </div>
              <div class="card-detail-item">
                <span class="card-detail-label">Tanggal Faktur</span>
                <span class="card-detail-value">${escapeHtml(date)}</span>
              </div>
              <div class="card-detail-item">
                <span class="card-detail-label">Metode & Status Bayar</span>
                <span class="card-detail-value">${getInvoicePaymentBadge(payInfo)}</span>
              </div>
              ${payInfo.isTempo ? `
                <div class="card-detail-item">
                  <span class="card-detail-label">Jatuh Tempo</span>
                  <span class="card-detail-value"><strong>${escapeHtml(inv.dueDate || '—')}</strong> (${escapeHtml(payInfo.statusLabel)})</span>
                </div>
              ` : `
                <div class="card-detail-item">
                  <span class="card-detail-label">Metode Pembayaran</span>
                  <span class="card-detail-value">Tunai (Lunas Langsung)</span>
                </div>
              `}
              <div class="card-detail-item">
                <span class="card-detail-label">Jumlah Item</span>
                <span class="card-detail-value">${itemCount} Produk</span>
              </div>
              <div class="card-detail-item" style="grid-column: 1 / -1;">
                <span class="card-detail-label">Total Tagihan Faktur</span>
                <span class="card-detail-value" style="color:#0369a1;font-size:0.92rem;font-weight:800;">${rupiah(total)}</span>
              </div>
            </div>
            <div class="card-action-bar">
              <button type="button" class="btn-detail-invoice button button-small button-secondary" data-id="${escapeHtml(id)}">
                <i class="fa-solid fa-eye"></i> Detail Faktur
              </button>
              <button type="button" class="btn-pdf-invoice button button-small button-secondary" data-id="${escapeHtml(id)}" title="Cetak PDF">
                <i class="fa-solid fa-file-pdf"></i> Cetak PDF
              </button>
              ${cardPayActionBtn}
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

  // 7. Bind event Detail, PDF & Toggle Paid pada seluruh kontainer (baik tabel maupun kartu)
  const invContainer = document.querySelector('[data-view-section="purchase-invoices"]');
  if (invContainer) {
    invContainer.querySelectorAll(".btn-detail-invoice").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const invId = btn.dataset.id;
        const found = currentInvoices.find(i => (i.id || i.invoiceNumber) === invId);
        if (found) openInvoiceDetailModal(found);
      });
    });

    invContainer.querySelectorAll(".btn-pdf-invoice").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const invId = btn.dataset.id;
        const found = currentInvoices.find(i => (i.id || i.invoiceNumber) === invId);
        if (found) handlePrintInvoicePdf(found);
      });
    });

    invContainer.querySelectorAll(".btn-toggle-paid").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const invId = btn.dataset.id;
        const action = btn.dataset.action;
        toggleMarkInvoicePaid(invId, action === "mark");
      });
    });
  }
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

  const isEditMode = Boolean(editingInvoice);
  const confirmTitle = isEditMode ? "Konfirmasi Pembaruan Faktur" : "Konfirmasi Faktur Masuk";
  const confirmText = isEditMode
    ? `Apakah Anda yakin ingin memperbarui Faktur #${editingInvoice.invoiceNumber}?\nStok versi lama akan dibalik (*reversal*) otomatis dan digantikan dengan stok versi baru hasil editan.`
    : `Apakah Anda yakin ingin mengonfirmasi Faktur #${inv.invoiceNumber} dari ${inv.supplierName}?\nStok produk akan bertambah di satuan dasar dan Harga Beli Terakhir akan diperbarui.`;

  const confirmed = await window.KasirProDialog?.confirm(confirmTitle, confirmText);
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

    // 0. Jika sedang mengedit faktur, balikkan (reversal) stok versi lama terlebih dahulu
    if (isEditMode && Array.isArray(editingInvoice.items)) {
      for (const oldItem of editingInvoice.items) {
        const oldConv = num(oldItem.conversionRatio) || num(oldItem.conversion) || 1;
        const oldBaseQty = (num(oldItem.qty) || 1) * oldConv;
        const oldCode = norm(oldItem.matchedProductCode || oldItem.productCode || oldItem.code);
        const prod = products.find(p => norm(p["Kode Produk"]) === oldCode || norm(p["Nama Produk"]) === norm(oldItem.name));
        if (prod) {
          const curStock = readCurrentStock(prod["Kode Produk"]);
          const revertedStock = Math.max(0, curStock - oldBaseQty);
          setActiveStock(prod["Kode Produk"], revertedStock);
          prod["Stok Awal"] = revertedStock;
          touchedProducts.set(norm(prod["Kode Produk"]), prod);
        }
      }
    }

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
        const newCode = item.productCode || (inv.supplierName ? generateAutoProductCode(inv.supplierName) : `PRD-${Date.now().toString().slice(-5)}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`);
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
    const payTypeNorm = norm(inv.paymentType || inv.paymentMethod || "tempo");
    const isTunai = payTypeNorm === "tunai";
    const initialPaymentStatus = inv.paymentStatus || (isTunai ? "Lunas" : "Belum Lunas");
    const initialPaidAt = inv.paidAt || (initialPaymentStatus === "Lunas" || isTunai ? (inv.paidAt || now) : null);

    const confirmedInvoice = {
      ...inv,
      id: isEditMode ? editingInvoice.id : inv.id,
      status: "Terkonfirmasi",
      paymentType: payTypeNorm,
      paymentMethod: payTypeNorm,
      paymentStatus: initialPaymentStatus,
      paidAt: initialPaidAt,
      dueDate: inv.dueDate || "",
      confirmedAt: now,
      confirmedBy: user,
      corrections: isEditMode ? [
        ...(editingInvoice.corrections || []),
        { method: "trx", reason: "Revisi Item via Grid Mode", correctedAt: now, correctedBy: user }
      ] : (inv.corrections || [])
    };

    let nextInvoices;
    if (isEditMode) {
      nextInvoices = existingInvoices.map(x => (x.id === editingInvoice.id || norm(x.invoiceNumber) === norm(editingInvoice.invoiceNumber)) ? confirmedInvoice : x);
    } else {
      nextInvoices = [...existingInvoices, confirmedInvoice];
    }

    if (isEditMode) {
      const oldRef = norm(editingInvoice.invoiceNumber);
      const oldId = norm(editingInvoice.id);
      const curMovs = readStore(STORE_KEYS.movements, []);
      const keptMovs = curMovs.filter(m => norm(m.reference) !== oldRef && norm(m.reference) !== oldId);
      await writeStore(STORE_KEYS.movements, keptMovs);
    }

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

    if (isEditMode) {
      editingInvoice = null;
    }

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
      isEditMode ? "Faktur Berhasil Diperbarui" : "Faktur Berhasil Dikonfirmasi",
      isEditMode
        ? `Faktur #${inv.invoiceNumber} berhasil diperbarui.\nStok lama telah dibalik dan stok baru telah diterapkan secara otomatis.`
        : `Faktur #${inv.invoiceNumber} berhasil dikonfirmasi sebagai Barang Masuk.\nStok telah diperbarui secara otomatis.`
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
  toggleManualInvoiceHeader(false);
  updateManualInvoiceHeaderSummary();
  modal.hidden = false;
  modal.style.display = "flex";
  setTimeout(() => $("manual-inv-number")?.focus(), 60);
}

export function openManualInvoiceForEdit(inv) {
  if (!inv) return;
  editingInvoice = inv;
  populateManualInvoiceSupplierDropdown();

  if ($("manual-inv-supplier")) $("manual-inv-supplier").value = inv.supplierName || inv.supplier || "";
  if ($("manual-inv-number")) $("manual-inv-number").value = inv.invoiceNumber || "";
  if ($("manual-inv-date")) $("manual-inv-date").value = inv.date || inv.invoiceDate || "";
  if ($("manual-inv-payment-type")) $("manual-inv-payment-type").value = inv.paymentType || inv.paymentMethod || "tempo";
  if ($("manual-inv-due-date")) $("manual-inv-due-date").value = inv.dueDate || "";
  if ($("manual-inv-discount-type")) $("manual-inv-discount-type").value = inv.discountMethod || "item";
  if ($("manual-inv-global-discount-rp")) $("manual-inv-global-discount-rp").value = inv.discountGlobal ? formatNumber(inv.discountGlobal) : "";
  if ($("manual-inv-ppn-rate")) $("manual-inv-ppn-rate").value = String(inv.taxGlobalPercent ?? (inv.taxGlobal > 0 ? 11 : 0));
  if ($("manual-inv-printed-total")) $("manual-inv-printed-total").value = inv.total ? formatNumber(inv.total) : "";

  handlePaymentTypeChange();
  handleDiscountTypeChange();
  handlePpnRateChange();

  const titleEl = $("manual-invoice-title");
  if (titleEl) {
    titleEl.innerHTML = `<span style="color:#f59e0b;"><i class="fa-solid fa-pen-to-square"></i> Edit & Rekonsiliasi Faktur</span> #${escapeHtml(inv.invoiceNumber || inv.id)}`;
  }
  const confirmBtn = $("btn-confirm-manual-inv");
  if (confirmBtn) {
    confirmBtn.innerHTML = `<i class="fa-solid fa-rotate"></i> Perbarui & Reversal Stok`;
    confirmBtn.style.background = "#d97706";
  }

  manualInvoiceItems = (inv.items || []).map(it => ({
    name: it.name || "",
    productCode: it.productCode || it.matchedProductCode || it.code || "",
    barcode: it.barcode || "",
    batch: it.batch || "",
    expiryDate: it.expiryDate || "",
    purchaseUnit: it.purchaseUnit || it.satuanBesar || "BOX",
    intermediateUnit: it.intermediateUnit || it.satuanSedang || "",
    intermediateQty: num(it.intermediateQty) || 1,
    baseUnit: it.baseUnit || it.satuanTerkecil || "TABLET",
    conversionRatio: num(it.conversionRatio) || num(it.conversion) || 1,
    qty: num(it.qty) || 0,
    buyPrice: num(it.buyPrice) || 0,
    discountPercent: num(it.discountPercent) || 0,
    discountRp: num(it.discountRp) || 0,
    subtotal: num(it.subtotal) || 0,
    _collapsed: false
  }));

  if (!manualInvoiceItems.length) {
    addManualInvoiceRow();
  }

  renderManualInvoiceItems();
  calculateManualInvoiceTotals();
  toggleManualInvoiceHeader(false);
  updateManualInvoiceHeaderSummary();

  const modal = $("modal-manual-invoice");
  if (modal) {
    modal.hidden = false;
    modal.style.display = "flex";
    setTimeout(() => $("manual-inv-number")?.focus(), 60);
  }
}

export function closeManualInvoiceModal() {
  const modal = $("modal-manual-invoice");
  if (modal) {
    modal.hidden = true;
    modal.style.display = "none";
  }
  if (editingInvoice) {
    editingInvoice = null;
    const titleEl = $("manual-invoice-title");
    if (titleEl) titleEl.textContent = "Input Faktur Manual (Grid Mode)";
    const confirmBtn = $("btn-confirm-manual-inv");
    if (confirmBtn) {
      confirmBtn.innerHTML = `<i class="fa-solid fa-circle-check"></i> Simpan & Verifikasi Faktur`;
      confirmBtn.style.background = "";
    }
  }
}

function updateManualInvoiceHeaderSummary() {
  const summaryEl = $("manual-inv-header-summary");
  if (!summaryEl) return;

  const supplier = text($("manual-inv-supplier")?.value) || "Belum dipilih";
  const invNum = text($("manual-inv-number")?.value) || "-";
  const invDate = $("manual-inv-date")?.value || "-";
  const payType = $("manual-inv-payment-type")?.value === "tunai" ? "Tunai" : "Tempo";
  const dueDate = $("manual-inv-due-date")?.value || "-";
  const printedTotal = $("manual-inv-printed-total")?.value || "0";

  summaryEl.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:12px;">
      <div style="display:flex;align-items:center;flex-wrap:wrap;gap:12px;">
        <span><strong>Supplier:</strong> <span class="text-primary" style="font-weight:700;">${escapeHtml(supplier)}</span></span>
        <span><strong>No. Faktur:</strong> <span style="font-weight:700;">${escapeHtml(invNum)}</span></span>
        <span><strong>Tgl:</strong> ${escapeHtml(invDate)}</span>
        <span><strong>Bayar:</strong> ${payType}${payType === "Tempo" && dueDate !== "-" ? ` (Tempo: ${escapeHtml(dueDate)})` : ""}</span>
        <span><strong>Total Fisik:</strong> <span style="font-weight:800;color:#991b1b;">Rp ${escapeHtml(printedTotal)}</span></span>
      </div>
      <button type="button" id="btn-edit-header-from-summary" class="button button-small button-secondary" style="font-size:11px;padding:2px 8px;border:1px solid #cbd5e1;background:#fff;">
        <i class="fa-solid fa-pen-to-square"></i> Buka Header
      </button>
    </div>
  `;

  $("btn-edit-header-from-summary")?.addEventListener("click", () => {
    toggleManualInvoiceHeader(false);
  });
}

function toggleManualInvoiceHeader(forceCollapse) {
  const body = $("manual-inv-header-body");
  const summary = $("manual-inv-header-summary");
  const icon = $("icon-toggle-inv-header");
  const label = $("label-toggle-inv-header");
  if (!body || !summary) return;

  const isCurrentlyVisible = body.style.display !== "none";
  const shouldCollapse = forceCollapse !== undefined ? forceCollapse : isCurrentlyVisible;

  if (shouldCollapse) {
    updateManualInvoiceHeaderSummary();
    body.style.display = "none";
    summary.style.display = "block";
    if (icon) icon.className = "fa-solid fa-chevron-down";
    if (label) label.textContent = "Buka Detail";
  } else {
    body.style.display = "block";
    summary.style.display = "none";
    if (icon) icon.className = "fa-solid fa-chevron-up";
    if (label) label.textContent = "Ciutkan";
  }
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
  updateManualInvoiceHeaderSummary();
}

function handleInvoiceDateChange() {
  const payType = $("manual-inv-payment-type")?.value || "tempo";
  const invDate = $("manual-inv-date")?.value;
  if (!invDate) return;
  if (payType === "tunai") {
    const dueInput = $("manual-inv-due-date");
    if (dueInput) dueInput.value = invDate;
  }
  updateManualInvoiceHeaderSummary();
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
  let detected14Col = false;
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
    const hCols = lines[0].split("\t").map(c => c.trim().toLowerCase());
    if (hCols.length >= 14 || hCols.some(c => c.includes("isi satuan sedang") || c.includes("isi sedang"))) {
      detected14Col = true;
    }
    lines.shift();
  }

  if (!lines.length) {
    window.KasirProDialog?.warning("Data Kosong", "Hanya terdeteksi baris header tanpa baris produk.");
    return;
  }

  const prods = cachedMasterProducts || (readStore(STORE_KEYS.master, {})?.produk || []);
  const selectedSupplier = text($("manual-inv-supplier")?.value);
  const normSelectedSup = norm(selectedSupplier);

  // Pre-indexing Master Produk untuk pencocokan instan (< 10ms)
  // Dipisahkan Tier 1 (Supplier Sama) dan Tier 2 (Supplier Lain/Umum)
  const exactNormMap_Sup = new Map();
  const barcodeMap_Sup = new Map();
  const codeMap_Sup = new Map();
  const candidateList_Sup = [];

  const exactNormMap_Other = new Map();
  const barcodeMap_Other = new Map();
  const codeMap_Other = new Map();
  const candidateList_Other = [];

  for (const p of prods) {
    if (p._isDeleted) continue;
    const pCode = norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.code || p.id);
    const pBarcode = norm(p["Barcode"] || p.barcode);
    const pName = p["Nama Produk"] || p.name || "";
    const normPName = normalizeProductName(pName);
    const pSup = norm(p["Supplier"] || p["Produsen"] || p.supplier || "");

    const isSameSup = !!(normSelectedSup && pSup && (pSup === normSelectedSup));

    if (isSameSup) {
      if (pBarcode && !barcodeMap_Sup.has(pBarcode)) barcodeMap_Sup.set(pBarcode, p);
      if (pCode && !codeMap_Sup.has(pCode)) codeMap_Sup.set(pCode, p);
      if (normPName && !exactNormMap_Sup.has(normPName)) exactNormMap_Sup.set(normPName, p);
      if (normPName) {
        candidateList_Sup.push({
          product: p,
          normName: normPName,
          tokens: new Set(normPName.split(/\s+/).filter(Boolean)),
          len: normPName.length
        });
      }
    } else {
      if (pBarcode && !barcodeMap_Other.has(pBarcode)) barcodeMap_Other.set(pBarcode, p);
      if (pCode && !codeMap_Other.has(pCode)) codeMap_Other.set(pCode, p);
      if (normPName && !exactNormMap_Other.has(normPName)) exactNormMap_Other.set(normPName, p);
      if (normPName) {
        candidateList_Other.push({
          product: p,
          normName: normPName,
          tokens: new Set(normPName.split(/\s+/).filter(Boolean)),
          len: normPName.length
        });
      }
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

    // Deteksi Format Baris:
    // Pada format 14 kolom:
    // cols[3] = Satuan Besar
    // cols[4] = Satuan Sedang (Opsional)
    // cols[5] = Isi Satuan Sedang (Isi: angka seperti 10, 28, atau kosong)
    // cols[6] = Satuan Terkecil (Nama satuan: KAPLET, TABLET, BOTOL, PCS)
    // cols[7] = Isi Konversi (angka konversi total)
    // cols[8] = Qty Beli
    // cols[9] = Total Masuk (teks/angka: Qty x Konversi)
    // cols[10] = Harga Beli (Rp)
    // cols[11] = Disc (%)
    // cols[12] = Disc (Rp)
    // cols[13] = Subtotal
    const isCols5Number = cols[5] !== undefined && cols[5] !== "" && /^[0-9.]+$/.test(cols[5]);
    const isCols6NonNumber = cols[6] !== undefined && isNaN(Number(cols[6]));
    const is14ColFormat = detected14Col || cols.length >= 14 || (isCols5Number && isCols6NonNumber);

    if (is14ColFormat) {
      // 14 Kolom Akurat (Memetakan Opsional & Isi pada Satuan Sedang)
      rawMidUnit = cols[4] || "";
      rawMidQty = num(cols[5]) || (rawMidUnit ? 1 : "");
      rawBaseUnit = cols[6] || "";
      rawConv = num(cols[7]) || 0;
      rawQty = num(cols[8]) || 1;
      // cols[9] adalah Total Masuk (dihitung otomatis: Qty Beli x Konversi)
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

    // Smart Product Matching dengan Prioritas Supplier Pilihan Pengguna
    const normRaw = norm(rawName);
    const normQuery = normalizeProductName(rawName);
    let match = null;

    // 1. TAHAP 1: Utamakan kecocokan produk pada supplier yang dipilih terlebih dahulu
    if (normSelectedSup) {
      if (barcodeMap_Sup.has(normRaw)) {
        match = { matchType: "exact", score: 1, product: barcodeMap_Sup.get(normRaw) };
      } else if (codeMap_Sup.has(normRaw)) {
        match = { matchType: "exact", score: 1, product: codeMap_Sup.get(normRaw) };
      } else if (exactNormMap_Sup.has(normQuery)) {
        match = { matchType: "exact", score: 1, product: exactNormMap_Sup.get(normQuery) };
      } else {
        let bestSupScore = 0;
        let bestSupMatch = null;
        const qTokens = new Set(normQuery.split(/\s+/).filter(Boolean));
        const lenQ = normQuery.length;

        for (const cand of candidateList_Sup) {
          if (Math.min(lenQ, cand.len) / Math.max(lenQ, cand.len) < 0.55) continue;
          let commonTokens = 0;
          for (const qt of qTokens) {
            if (cand.tokens.has(qt)) commonTokens++;
          }
          if (qTokens.size >= 2 && commonTokens === 0) continue;
          const score = stringSimilarity(normQuery, cand.normName);
          if (score > bestSupScore) {
            bestSupScore = score;
            bestSupMatch = cand.product;
          }
        }

        if (bestSupScore >= 0.999) {
          match = { matchType: "exact", score: 1, product: bestSupMatch };
        } else if (bestSupScore >= 0.8) {
          match = { matchType: "fuzzy", score: bestSupScore, product: bestSupMatch };
        }
      }
    }

    // 2. TAHAP 2: Jika tidak cocok di supplier pilihan atau supplier belum dipilih
    if (!match) {
      if (!normSelectedSup) {
        // Jika belum ada supplier dipilih, cari di master secara netral
        if (barcodeMap_Other.has(normRaw)) {
          match = { matchType: "exact", score: 1, product: barcodeMap_Other.get(normRaw) };
        } else if (codeMap_Other.has(normRaw)) {
          match = { matchType: "exact", score: 1, product: codeMap_Other.get(normRaw) };
        } else if (exactNormMap_Other.has(normQuery)) {
          match = { matchType: "exact", score: 1, product: exactNormMap_Other.get(normQuery) };
        } else {
          let bestFuzzyMatch = null;
          let bestFuzzyScore = 0;
          const qTokens = new Set(normQuery.split(/\s+/).filter(Boolean));
          const lenQ = normQuery.length;

          for (const cand of candidateList_Other) {
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
      } else {
        // Supplier dipilih, tetapi obat ini milik supplier lain di master.
        // Dilarang menganggap 100% cocok (exact)! Diturunkan menjadi fuzzy (maks 85%) dengan flag differentSupplier.
        let otherProd = null;
        let otherScore = 0;

        if (barcodeMap_Other.has(normRaw)) {
          otherProd = barcodeMap_Other.get(normRaw);
          otherScore = 0.85;
        } else if (codeMap_Other.has(normRaw)) {
          otherProd = codeMap_Other.get(normRaw);
          otherScore = 0.85;
        } else if (exactNormMap_Other.has(normQuery)) {
          otherProd = exactNormMap_Other.get(normQuery);
          otherScore = 0.85;
        } else {
          const qTokens = new Set(normQuery.split(/\s+/).filter(Boolean));
          const lenQ = normQuery.length;

          for (const cand of candidateList_Other) {
            if (Math.min(lenQ, cand.len) / Math.max(lenQ, cand.len) < 0.55) continue;
            let commonTokens = 0;
            for (const qt of qTokens) {
              if (cand.tokens.has(qt)) commonTokens++;
            }
            if (qTokens.size >= 2 && commonTokens === 0) continue;
            const score = stringSimilarity(normQuery, cand.normName);
            if (score > otherScore) {
              otherScore = score;
              otherProd = cand.product;
            }
          }
        }

        if (otherProd && otherScore >= 0.8) {
          match = { matchType: "fuzzy", score: Math.min(otherScore, 0.85), product: otherProd, differentSupplier: true };
        } else {
          match = { matchType: "none", score: otherScore, product: null };
        }
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
      if (!mUnit && match.product["Satuan Antara"]) {
        mUnit = match.product["Satuan Antara"];
        mQty = num(match.product["Isi Satuan Antara"]) || 1;
      } else if (rawMidQty) {
        mQty = rawMidQty;
      }
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
      supplier: selectedSupplier || (matchedProduct ? (matchedProduct["Supplier"] || matchedProduct["Produsen"] || "") : ""),
      purchaseUnit: pUnit,
      intermediateUnit: mUnit,
      intermediateQty: mUnit ? (mQty || "") : "",
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
    expiryDate: prefill.expiryDate || "",
    _collapsed: false
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
  updateManualInvoiceHeaderSummary();
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
    const isCollapsed = !!item._collapsed;

    let matchClass = "match-new";
    let headerBadgeHtml = `<span class="header-status-pill" style="font-size:10px;font-weight:700;background:#e0f2fe;color:#0284c7;border:1px solid #bae6fd;padding:1px 6px;border-radius:4px;">+ Baru</span>`;
    let matchBadgeHtml = "";

    if (item.matchStatus === "exact" && item.productCode) {
      matchClass = "match-exact";
      headerBadgeHtml = `<span class="header-status-pill" style="font-size:10px;font-weight:700;background:#ecfdf5;color:#059669;border:1px solid #a7f3d0;padding:1px 6px;border-radius:4px;">Tersambung</span>`;
      matchBadgeHtml = `
        <div style="margin-top:2px;">
          <span style="font-size:10px;font-weight:700;background:#ecfdf5;color:#059669;border:1px solid #a7f3d0;padding:1px 6px;border-radius:4px;" title="Produk cocok 100% dengan master data">
            Tersambung: ${escapeHtml(item.productCode)}
          </span>
        </div>
      `;
    } else if (item.matchStatus === "fuzzy" && item.matchedProduct) {
      matchClass = "match-fuzzy";
      const matchName = item.matchedProduct["Nama Produk"] || item.productCode || "";
      headerBadgeHtml = `<span class="header-status-pill" style="font-size:10px;font-weight:700;background:#fffbeb;color:#d97706;border:1px solid #fde68a;padding:1px 6px;border-radius:4px;">Mirip (${item.matchScore || 85}%)</span>`;
      matchBadgeHtml = `
        <div style="margin-top:2px;">
          <span style="font-size:10px;font-weight:700;background:#fffbeb;color:#d97706;border:1px solid #fde68a;padding:1px 6px;border-radius:4px;" title="Mirip (${item.matchScore}%). Klik/ketik untuk mengganti jika perlu.">
            Mirip: ${escapeHtml(matchName)} (${item.matchScore}%)
          </span>
        </div>
      `;
    } else if (item.name && (item.matchStatus === "new" || !item.productCode)) {
      matchClass = "match-new";
      headerBadgeHtml = `<span class="header-status-pill" style="font-size:10px;font-weight:700;background:#e0f2fe;color:#0284c7;border:1px solid #bae6fd;padding:1px 6px;border-radius:4px;">+ Produk Baru</span>`;
      matchBadgeHtml = `
        <div style="margin-top:2px;">
          <span style="font-size:10px;font-weight:700;background:#e0f2fe;color:#0284c7;border:1px solid #bae6fd;padding:1px 6px;border-radius:4px;" title="Produk belum terdaftar di master data (akan didaftarkan otomatis)">
            + Produk Baru
          </span>
        </div>
      `;
    } else if (item.productCode) {
      matchClass = "match-exact";
      headerBadgeHtml = `<span class="header-status-pill" style="font-size:10px;font-weight:700;background:#ecfdf5;color:#059669;border:1px solid #a7f3d0;padding:1px 6px;border-radius:4px;">Tersambung</span>`;
      matchBadgeHtml = `
        <div style="font-size:10.5px;color:#0284c7;display:flex;gap:6px;margin-top:2px;">
          <span>Kode: ${escapeHtml(item.productCode)}</span>
        </div>
      `;
    }

    const itemSupName = item.supplier || currentSup || item.matchedProduct?.["Supplier"] || item.matchedProduct?.["Produsen"] || "-";
    const itemUnit = item.purchaseUnit || "-";
    const unitDisplay = qNum ? `${qNum} ${itemUnit}` : itemUnit;

    return `
      <tr data-index="${idx}" class="manual-inv-row ${matchClass} ${isCollapsed ? 'is-collapsed' : 'is-expanded'}">
        <td class="col-mobile-header" data-index="${idx}">
          <div class="mobile-row-header-left" style="display:flex;align-items:flex-start;gap:8px;min-width:0;flex:1;">
            <span class="mobile-row-badge" style="background:#0284c7;color:#fff;font-size:11px;font-weight:800;padding:2px 7px;border-radius:6px;flex-shrink:0;margin-top:2px;">#${idx + 1}</span>
            <div style="min-width:0;flex:1;">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span class="mobile-row-title" style="font-size:12.5px;font-weight:700;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(item.name || '(Obat Baru)')}</span>
                <span class="header-badge-wrapper">${headerBadgeHtml}</span>
              </div>
              <div class="card-meta-row" style="margin-top:2px;margin-bottom:3px;">
                <span class="card-meta-code val-sup">${escapeHtml(itemSupName)}</span>
              </div>
              <div class="card-kpi-strip manual-row-kpi" style="margin-top:4px;">
                <div class="kpi-strip-item">
                  <span class="kpi-strip-label">Satuan Beli</span>
                  <span class="kpi-strip-val val-unit" style="color:#0284c7;">${escapeHtml(unitDisplay)}</span>
                </div>
                <div class="kpi-strip-item">
                  <span class="kpi-strip-label">Harga Satuan</span>
                  <span class="kpi-strip-val">${rupiah(item.buyPrice || 0)}</span>
                </div>
                <div class="kpi-strip-item">
                  <span class="kpi-strip-label">Subtotal</span>
                  <span class="kpi-strip-val val-subtotal" style="color:#0f172a;font-weight:800;">${rupiah(item.subtotal || 0)}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="mobile-row-header-actions" style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
            <button type="button" class="btn-toggle-row button button-small button-secondary" data-index="${idx}" style="padding:4px 9px;font-size:11.5px;display:inline-flex;align-items:center;gap:4px;background:#f8fafc;border:1px solid #cbd5e1;color:#334155;" title="${isCollapsed ? 'Buka detail baris obat' : 'Ciutkan baris obat'}">
              <i class="fa-solid ${isCollapsed ? 'fa-chevron-down' : 'fa-chevron-up'}"></i>
              <span class="toggle-text">${isCollapsed ? 'Buka' : 'Ciutkan'}</span>
            </button>
            <button type="button" class="btn-remove-row button button-small button-secondary" data-index="${idx}" style="color:#ef4444;background:#fef2f2;border:1px solid #fecaca;padding:4px 8px;font-size:11.5px;" title="Hapus baris ini">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </td>
        <td class="col-num" data-mobile-label="#" style="text-align:center;font-weight:700;color:#64748b;">${idx + 1}</td>
        <td class="col-prod inv-prod-cell" data-mobile-label="Nama Produk">
          <div style="display:flex;flex-direction:column;gap:3px;">
            <input type="text" class="row-prod-search" data-index="${idx}" value="${escapeHtml(item.name)}" 
              placeholder="${supSelected ? 'Ketik nama obat / scan barcode...' : 'Pilih Supplier terlebih dahulu...'}" 
              ${supSelected ? '' : 'disabled'} autocomplete="off" 
              style="font-weight:700;${supSelected ? 'color:#0f172a;background:#fff;' : 'background:#f8fafc;color:#94a3b8;cursor:not-allowed;'}">
            ${matchBadgeHtml}
          </div>
        </td>
        <td class="col-batch" data-mobile-label="No. Batch">
          <input type="text" class="row-batch" data-index="${idx}" value="${escapeHtml(item.batch || '')}" placeholder="No. Batch" style="font-weight:600;">
        </td>
        <td class="col-exp" data-mobile-label="Exp Date">
          <input type="date" class="row-exp" data-index="${idx}" value="${escapeHtml(item.expiryDate || '')}" style="font-size:11.5px;">
        </td>
        <td class="col-unit-buy" data-mobile-label="Satuan Besar">
          <input type="text" class="row-purchase-unit" data-index="${idx}" value="${escapeHtml(item.purchaseUnit || '')}" placeholder="BOX / BTL">
        </td>
        <td class="col-unit-mid" data-mobile-label="Satuan Sedang">
          <div style="display:flex;align-items:center;gap:4px;">
            <input type="text" class="row-mid-unit" data-index="${idx}" value="${escapeHtml(item.intermediateUnit || '')}" placeholder="Opsional" style="flex:1;">
            <input type="number" inputmode="numeric" class="row-mid-qty" data-index="${idx}" min="1" step="1" value="${midQtyStr}" title="Isi per Satuan Sedang" style="width:48px;" placeholder="Isi">
          </div>
        </td>
        <td class="col-unit-base" data-mobile-label="Satuan Terkecil">
          <input type="text" class="row-base-unit" data-index="${idx}" value="${escapeHtml(item.baseUnit || '')}" placeholder="TAB / BTL">
        </td>
        <td class="col-conv" data-mobile-label="Isi Konversi">
          <input type="number" inputmode="numeric" class="row-conversion" data-index="${idx}" min="1" step="1" value="${convStr}" title="Total Satuan Terkecil dalam 1 Satuan Besar" style="font-weight:800;color:#0369a1;" placeholder="1">
        </td>
        <td class="col-qty" data-mobile-label="Qty Beli">
          <input type="number" inputmode="decimal" class="row-qty" data-index="${idx}" min="0.01" step="any" value="${qtyStr}" style="font-weight:700;" placeholder="1">
        </td>
        <td class="col-total-base row-total-base-cell" data-mobile-label="Total Masuk" style="text-align:center;font-weight:700;color:#0369a1;background:#f0f9ff;border-radius:4px;">
          ${totalBase > 0 ? totalBase : '—'} <small style="font-size:10px;">${escapeHtml(item.baseUnit || '')}</small>
        </td>
        <td class="col-buy-price" data-mobile-label="Harga Beli">
          <input type="text" inputmode="numeric" class="row-buy-price" data-index="${idx}" value="${buyPriceStr}" placeholder="0" style="font-weight:600;">
        </td>
        <td class="col-disc-pct" data-mobile-label="Diskon (%)">
          <input type="number" inputmode="decimal" class="row-disc-pct" data-index="${idx}" min="0" max="100" step="0.1" value="${discPctStr}" placeholder="0">
        </td>
        <td class="col-disc-rp" data-mobile-label="Diskon (Rp)">
          <input type="text" inputmode="numeric" class="row-disc-rp" data-index="${idx}" value="${discRpStr}" placeholder="0">
        </td>
        <td class="col-subtotal row-subtotal-cell" data-mobile-label="Subtotal" style="text-align:right;font-weight:800;color:#0f172a;">
          ${rupiah(item.subtotal || 0)}
        </td>
        <td class="col-action" style="text-align:center;">
          <button type="button" class="btn-remove-row button button-small button-secondary" data-index="${idx}" style="color:#ef4444;padding:4px 8px;" title="Hapus baris ini">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      </tr>
    `;
  }).join("");

  bindManualItemRowEvents();
  updateToggleAllButtonState();
}

function toggleManualInvoiceRowCollapse(idx) {
  const item = manualInvoiceItems[idx];
  if (!item) return;
  item._collapsed = !item._collapsed;

  const row = document.querySelector(`tr[data-index="${idx}"]`);
  if (!row) return;

  if (item._collapsed) {
    row.classList.remove("is-expanded");
    row.classList.add("is-collapsed");
  } else {
    row.classList.remove("is-collapsed");
    row.classList.add("is-expanded");
  }

  const toggleBtn = row.querySelector(".btn-toggle-row");
  if (toggleBtn) {
    toggleBtn.innerHTML = `
      <i class="fa-solid ${item._collapsed ? 'fa-chevron-down' : 'fa-chevron-up'}"></i>
      <span class="toggle-text">${item._collapsed ? 'Buka' : 'Ciutkan'}</span>
    `;
    toggleBtn.title = item._collapsed ? "Buka detail baris obat" : "Ciutkan baris obat";
  }

  updateToggleAllButtonState();
}

function toggleAllManualInvoiceRows() {
  if (!manualInvoiceItems.length) return;
  const anyExpanded = manualInvoiceItems.some(i => !i._collapsed);
  const targetCollapsed = anyExpanded;

  manualInvoiceItems.forEach((item, idx) => {
    item._collapsed = targetCollapsed;
    const row = document.querySelector(`tr[data-index="${idx}"]`);
    if (row) {
      if (targetCollapsed) {
        row.classList.remove("is-expanded");
        row.classList.add("is-collapsed");
      } else {
        row.classList.remove("is-collapsed");
        row.classList.add("is-expanded");
      }
      const toggleBtn = row.querySelector(".btn-toggle-row");
      if (toggleBtn) {
        toggleBtn.innerHTML = `
          <i class="fa-solid ${targetCollapsed ? 'fa-chevron-down' : 'fa-chevron-up'}"></i>
          <span class="toggle-text">${targetCollapsed ? 'Buka' : 'Ciutkan'}</span>
        `;
        toggleBtn.title = targetCollapsed ? "Buka detail baris obat" : "Ciutkan baris obat";
      }
    }
  });

  updateToggleAllButtonState();
}

function updateToggleAllButtonState() {
  const btn = $("btn-toggle-all-inv-rows");
  if (!btn) return;
  const anyExpanded = manualInvoiceItems.some(i => !i._collapsed);
  const icon = $("icon-toggle-all-inv-rows");
  const label = $("label-toggle-all-inv-rows");
  if (icon && label) {
    if (anyExpanded) {
      icon.className = "fa-solid fa-chevron-up";
      label.textContent = "Ciutkan Semua";
      btn.title = "Ciutkan Semua Kartu Obat";
    } else {
      icon.className = "fa-solid fa-chevron-down";
      label.textContent = "Buka Semua";
      btn.title = "Buka Semua Kartu Obat";
    }
  }
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
      manualInvoiceItems[idx].name = e.target.value.trim();
      updateMobileRowHeader(idx);
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
      updateMobileRowHeader(idx);
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

  // Toggle collapse baris per kartu di tampilan mobile
  tbody.querySelectorAll(".btn-toggle-row").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index, 10);
      toggleManualInvoiceRowCollapse(idx);
    });
  });

  tbody.querySelectorAll(".col-mobile-header").forEach(header => {
    header.addEventListener("click", (e) => {
      if (e.target.closest(".btn-remove-row") || e.target.closest(".btn-toggle-row")) return;
      const idx = parseInt(header.dataset.index, 10);
      toggleManualInvoiceRowCollapse(idx);
    });
  });

  // Tombol Hapus
  tbody.querySelectorAll(".btn-remove-row").forEach(b => {
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
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
              <span style="color:#0284c7;">${conv > 1 ? `1 ${escapeHtml(buyUnit)} (isi ${conv} ${escapeHtml(baseUnit)})` : `${escapeHtml(buyUnit || baseUnit)}`}</span>
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

  // Posisikan secara fixed relatif terhadap input secara responsif
  const rect = inputEl.getBoundingClientRect();
  const screenW = window.innerWidth || document.documentElement.clientWidth || 360;
  const targetW = Math.min(Math.max(rect.width, 360), screenW - 20);
  const leftPos = Math.max(10, Math.min(rect.left, screenW - targetW - 10));

  acBox.style.position = "fixed";
  acBox.style.top = `${rect.bottom + 3}px`;
  acBox.style.left = `${leftPos}px`;
  acBox.style.width = `${targetW}px`;
  acBox.style.maxWidth = "calc(100vw - 20px)";
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
    const curItem = manualInvoiceItems[idx] || {};
    if (typeof window.openProductModal === "function") {
      window.openProductModal(
        {
          name: prodName,
          supplier: currentSup,
          buyUnit: curItem.purchaseUnit || "Box",
          conversion: num(curItem.conversionRatio) || 1,
          baseUnit: curItem.baseUnit || "Pcs",
          buyPrice: num(curItem.buyPrice) || 0
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

  // 1. Tautkan identitas resmi master produk
  item.productCode = prod["Kode Produk"] || prod["Kode Produk Internal"] || "";
  item.name = prod["Nama Produk"] || prod.name || "";
  if (!item.barcode && prod["Barcode"]) {
    item.barcode = prod["Barcode"];
  }

  // 2. PROTEKSI NILAI TRANSAKSI FAKTUR FISIK
  // Hanya isi kolom jika pada baris faktur fisik masih kosong/belum diisi pengguna
  if (!item.purchaseUnit) {
    item.purchaseUnit = prod["Kemasan Beli"] || prod["Satuan Pembelian"] || "BOX";
  }

  const baseU = prod["Satuan Dasar"] || prod["Satuan"] || "TABLET";
  const interU = prod["Satuan Antara"] || "";
  const conv = num(prod["Konversi"] ?? prod["Isi Kemasan"] ?? 1) || 1;
  const interQty = num(prod["Isi Satuan Antara"]) || 1;

  if (!item.baseUnit) {
    item.baseUnit = baseU;
  }
  if (!num(item.conversionRatio) || num(item.conversionRatio) <= 1) {
    if (conv > 1) item.conversionRatio = conv;
  }

  // Isi satuan antara hanya jika di faktur fisik belum diisi
  if (!item.intermediateUnit && interU) {
    item.intermediateUnit = interU;
    item.intermediateQty = interQty;
  }

  // HARGA BELI FAKTUR: HANYA ISI JIKA DI BARIS FAKTUR FISIK MASIH KOSONG / 0
  const masterBuyPrice = num(prod["Harga Beli Terakhir"] ?? prod["Harga Beli"] ?? 0);
  if (!num(item.buyPrice) && masterBuyPrice > 0) {
    item.buyPrice = masterBuyPrice;
  }

  item.matchStatus = "exact";
  item.matchScore = 100;
  item.matchedProduct = prod;

  recalculateRow(idx);
  renderManualInvoiceItems();
  calculateManualInvoiceTotals();
}

function updateMobileRowHeader(idx) {
  const item = manualInvoiceItems[idx];
  if (!item) return;
  const row = document.querySelector(`tr.manual-inv-row[data-index="${idx}"]`);
  if (!row) return;

  const titleEl = row.querySelector(".mobile-row-title");
  if (titleEl) {
    titleEl.textContent = item.name || "(Obat Baru)";
  }

  let matchClass = "match-new";
  let badgeText = "+ Baru";
  let badgeStyle = "background:#e0f2fe;color:#0284c7;border:1px solid #bae6fd;";
  if (item.matchStatus === "exact" && item.productCode) {
    matchClass = "match-exact";
    badgeText = "Tersambung";
    badgeStyle = "background:#ecfdf5;color:#059669;border:1px solid #a7f3d0;";
  } else if (item.matchStatus === "fuzzy" && item.matchedProduct) {
    matchClass = "match-fuzzy";
    badgeText = `Mirip (${item.matchScore || 85}%)`;
    badgeStyle = "background:#fffbeb;color:#d97706;border:1px solid #fde68a;";
  }

  row.classList.remove("match-exact", "match-fuzzy", "match-new");
  row.classList.add(matchClass);

  const badgeWrapper = row.querySelector(".header-badge-wrapper");
  if (badgeWrapper) {
    badgeWrapper.innerHTML = `<span class="header-status-pill" style="font-size:10px;font-weight:700;${badgeStyle}padding:1px 6px;border-radius:4px;">${badgeText}</span>`;
  }

  const currentSup = text($("manual-inv-supplier")?.value);
  const itemSupName = item.supplier || currentSup || item.matchedProduct?.["Supplier"] || item.matchedProduct?.["Produsen"] || "-";
  const supEl = row.querySelector(".val-sup");
  if (supEl) supEl.textContent = itemSupName;

  const qNum = num(item.qty) || 0;
  const itemUnit = item.purchaseUnit || "-";
  const unitDisplay = qNum ? `${qNum} ${itemUnit}` : itemUnit;
  const unitEl = row.querySelector(".val-unit");
  if (unitEl) unitEl.textContent = unitDisplay;

  const subtotalEl = row.querySelector(".val-subtotal");
  if (subtotalEl) subtotalEl.textContent = rupiah(item.subtotal || 0);
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
      updateMobileRowHeader(idx);
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
  toggleManualInvoiceHeader(false);
  updateManualInvoiceHeaderSummary();
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

  // Cek duplikasi nomor faktur (kecuali faktur yang sedang diedit)
  const exists = currentInvoices.some(i => i.id !== editingInvoice?.id && norm(i.invoiceNumber) === norm(invNum) && (norm(i.status) === "terkonfirmasi" || norm(i.status) === "confirmed"));
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
          <div style="display:flex;gap:8px;align-items:center;">
            <button type="button" id="btn-print-detail-pdf" class="button button-secondary"><i class="fa-solid fa-file-pdf"></i> Cetak PDF</button>
            <span id="detail-pay-action-wrapper"></span>
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

  const payInfo = getInvoicePaymentInfo(inv);
  const payWrapper = $("detail-pay-action-wrapper");
  if (payWrapper) {
    if (payInfo.isTempo && !payInfo.isPaid) {
      payWrapper.innerHTML = `
        <button type="button" id="btn-detail-toggle-paid" class="button button-success" style="background:#10b981;color:#fff;">
          <i class="fa-solid fa-check"></i> Tandai Sudah Bayar
        </button>
      `;
    } else if (payInfo.isTempo && payInfo.isPaid) {
      payWrapper.innerHTML = `
        <button type="button" id="btn-detail-toggle-paid" class="button button-secondary">
          <i class="fa-solid fa-rotate-left"></i> Batal Lunas
        </button>
      `;
    } else {
      payWrapper.innerHTML = "";
    }

    payWrapper.querySelector("#btn-detail-toggle-paid")?.addEventListener("click", () => {
      toggleMarkInvoicePaid(inv.id || inv.invoiceNumber, !payInfo.isPaid);
    });
  }

  const bodyEl = $("invoice-detail-body");
  const items = inv.items || [];

  bodyEl.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:14px;background:#f8fafc;padding:14px;border-radius:10px;margin-bottom:16px;">
      <div><span style="font-size:12px;color:#64748b;">Status Faktur:</span><br>${getInvoiceStatusBadge(inv.status)}</div>
      <div><span style="font-size:12px;color:#64748b;">Status Pembayaran:</span><br>${getInvoicePaymentBadge(payInfo)}</div>
      ${payInfo.isTempo ? `
        <div><span style="font-size:12px;color:#64748b;">Jatuh Tempo:</span><br><strong>${escapeHtml(inv.dueDate || '—')}</strong> <small style="display:block;color:${payInfo.isPaid ? '#059669' : (payInfo.dueState === 'overdue' ? '#dc2626' : (payInfo.dueState === 'due_soon' ? '#d97706' : '#2563eb'))};font-weight:700;">${escapeHtml(payInfo.reminderText)}</small></div>
      ` : `
        <div><span style="font-size:12px;color:#64748b;">Metode Bayar:</span><br><strong>Tunai (Lunas)</strong></div>
      `}
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
      <section class="kp-dialog-v4__card" style="width:min(94vw,560px);max-height:92vh;overflow-y:auto;" role="dialog">
        <header style="padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
          <h2 style="font-size:16px;font-weight:800;margin:0;"><i class="fa-solid fa-pen-to-square" style="color:#d97706;"></i> Koreksi & Edit Faktur</h2>
          <button type="button" id="close-modal-correction" class="button button-small button-secondary" style="padding:4px 8px;"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <div style="padding:20px;text-align:left;">
          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Metode Koreksi</label>
          <select id="corr-method" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;margin-bottom:14px;">
            <option value="admin">1. Koreksi Administratif (Nomor, Tanggal, Jatuh Tempo, Status Bayar - Tanpa Ubah Stok)</option>
            <option value="trx">2. Koreksi Transaksional (Revisi Item, Qty, Harga Beli via Grid Editor - Reversal Stok Otomatis)</option>
          </select>

          <!-- SEKSI ADMINISTRATIF -->
          <div id="corr-admin-section">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
              <div>
                <label style="display:block;font-size:12px;font-weight:700;color:#475569;margin-bottom:4px;">Nomor Faktur</label>
                <input type="text" id="corr-inv-number" style="width:100%;min-height:38px;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:700;color:#475569;margin-bottom:4px;">Supplier</label>
                <input type="text" id="corr-inv-supplier" style="width:100%;min-height:38px;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
              <div>
                <label style="display:block;font-size:12px;font-weight:700;color:#475569;margin-bottom:4px;">Tanggal Faktur</label>
                <input type="date" id="corr-inv-date" style="width:100%;min-height:38px;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;">
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:700;color:#475569;margin-bottom:4px;">Jatuh Tempo</label>
                <input type="date" id="corr-inv-due-date" style="width:100%;min-height:38px;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;">
              </div>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
              <div>
                <label style="display:block;font-size:12px;font-weight:700;color:#475569;margin-bottom:4px;">Metode Pembayaran</label>
                <select id="corr-inv-pay-type" style="width:100%;min-height:38px;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;">
                  <option value="tempo">Tempo (Kredit)</option>
                  <option value="tunai">Tunai (Cash)</option>
                </select>
              </div>
              <div>
                <label style="display:block;font-size:12px;font-weight:700;color:#475569;margin-bottom:4px;">Status Pembayaran</label>
                <select id="corr-inv-pay-status" style="width:100%;min-height:38px;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;">
                  <option value="Belum Lunas">Belum Lunas</option>
                  <option value="Lunas">Lunas</option>
                </select>
              </div>
            </div>

            <label style="display:block;font-size:12px;font-weight:700;color:#1e293b;margin-bottom:4px;">Alasan Koreksi <span class="text-danger">*</span></label>
            <input type="text" id="corr-reason" required style="width:100%;min-height:38px;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;margin-bottom:12px;" placeholder="Contoh: Kesalahan nomor faktur dari supplier atau tanggal tempo">

            <label style="display:block;font-size:12px;font-weight:700;color:#1e293b;margin-bottom:4px;">Catatan Koreksi Tambahan</label>
            <textarea id="corr-notes" rows="2" style="width:100%;padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;margin-bottom:12px;" placeholder="Keterangan perbaikan tambahan..."></textarea>
          </div>

          <!-- SEKSI TRANSAKSIONAL -->
          <div id="corr-trx-section" style="display:none;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:14px;margin-bottom:14px;">
            <h4 style="margin:0 0 6px;color:#0369a1;font-size:13.5px;font-weight:800;"><i class="fa-solid fa-arrows-rotate"></i> Koreksi Transaksional & Rekonsiliasi Stok</h4>
            <p style="margin:0 0 12px;font-size:12.5px;color:#0c4a6e;line-height:1.45;">
              Gunakan opsi ini jika Anda perlu <strong>menambah/mengurangi obat, mengubah kuantitas beli, harga beli, atau diskon faktur</strong>.<br>
              Form Input Faktur Manual (Grid Mode) akan dibuka dengan data faktur ini sudah terisi. Saat disimpan, KasirPro akan <strong>membalik (*reversal*) stok lama secara atomik</strong> dan menerapkan stok baru hasil revisi.
            </p>
            <button type="button" id="btn-open-grid-editor" class="button button-primary" style="width:100%;background:#0284c7;font-weight:700;padding:10px 16px;font-size:13px;"><i class="fa-solid fa-table-cells"></i> Buka Editor Faktur di Form Grid Mode</button>
          </div>
        </div>
        <footer style="padding:12px 20px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:8px;">
          <button type="button" id="cancel-correction" class="button button-secondary">Batal</button>
          <button type="button" id="save-correction" class="button button-primary"><i class="fa-solid fa-floppy-disk"></i> Simpan Koreksi Administratif</button>
        </footer>
      </section>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  $("corr-method")?.addEventListener("change", (e) => {
    const isTrx = e.target.value === "trx";
    const adminSec = $("corr-admin-section");
    const trxSec = $("corr-trx-section");
    const saveBtn = $("save-correction");
    if (adminSec) adminSec.style.display = isTrx ? "none" : "block";
    if (trxSec) trxSec.style.display = isTrx ? "block" : "none";
    if (saveBtn) saveBtn.style.display = isTrx ? "none" : "inline-flex";
  });

  $("btn-open-grid-editor")?.addEventListener("click", () => {
    if (!activeDetailInvoice) return;
    const invToEdit = activeDetailInvoice;
    closeInvoiceCorrectionModal();
    closeInvoiceDetailModal();
    openManualInvoiceForEdit(invToEdit);
  });

  $("close-modal-correction")?.addEventListener("click", closeInvoiceCorrectionModal);
  $("cancel-correction")?.addEventListener("click", closeInvoiceCorrectionModal);
  $("save-correction")?.addEventListener("click", handleSaveInvoiceCorrection);
}

function openInvoiceCorrectionModal(inv) {
  const modal = $("modal-invoice-correction");
  if (!modal) return;

  const methodSelect = $("corr-method");
  if (methodSelect) methodSelect.value = "admin";

  const adminSec = $("corr-admin-section");
  const trxSec = $("corr-trx-section");
  const saveBtn = $("save-correction");
  if (adminSec) adminSec.style.display = "block";
  if (trxSec) trxSec.style.display = "none";
  if (saveBtn) saveBtn.style.display = "inline-flex";

  if ($("corr-inv-number")) $("corr-inv-number").value = inv.invoiceNumber || inv.id || "";
  if ($("corr-inv-supplier")) $("corr-inv-supplier").value = inv.supplierName || inv.supplier || "";
  if ($("corr-inv-date")) $("corr-inv-date").value = inv.date || inv.invoiceDate || "";
  if ($("corr-inv-due-date")) $("corr-inv-due-date").value = inv.dueDate || "";
  if ($("corr-inv-pay-type")) $("corr-inv-pay-type").value = inv.paymentType || inv.paymentMethod || "tempo";
  if ($("corr-inv-pay-status")) $("corr-inv-pay-status").value = inv.paymentStatus || (inv.paymentType === "tunai" ? "Lunas" : "Belum Lunas");
  if ($("corr-reason")) $("corr-reason").value = "";
  if ($("corr-notes")) $("corr-notes").value = "";

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
  const reason = text($("corr-reason")?.value);
  const notes = text($("corr-notes")?.value);

  if (!reason) {
    window.KasirProDialog?.warning("Perhatian", "Alasan koreksi wajib diisi.");
    return;
  }

  const newNum = text($("corr-inv-number")?.value) || inv.invoiceNumber;
  const newSup = text($("corr-inv-supplier")?.value) || inv.supplierName || inv.supplier;
  const newDate = text($("corr-inv-date")?.value) || inv.date || inv.invoiceDate;
  const newDueDate = text($("corr-inv-due-date")?.value) || inv.dueDate;
  const newPayType = $("corr-inv-pay-type")?.value || inv.paymentType || "tempo";
  const newPayStatus = $("corr-inv-pay-status")?.value || inv.paymentStatus || "Belum Lunas";

  // Cek duplikasi nomor faktur jika diubah
  if (norm(newNum) !== norm(inv.invoiceNumber)) {
    const isDup = currentInvoices.some(x => x.id !== inv.id && norm(x.invoiceNumber) === norm(newNum));
    if (isDup) {
      window.KasirProDialog?.warning("Nomor Faktur Duplikat", `Nomor faktur "${newNum}" sudah digunakan pada faktur lain.`);
      return;
    }
  }

  const oldInvNum = inv.invoiceNumber;
  inv.invoiceNumber = newNum;
  inv.supplierName = newSup;
  inv.supplier = newSup;
  inv.date = newDate;
  inv.invoiceDate = newDate;
  inv.dueDate = newDueDate;
  inv.paymentType = newPayType;
  inv.paymentMethod = newPayType;
  inv.paymentStatus = newPayStatus;

  const now = nowIso();
  const user = "Admin";

  const correctionEntry = {
    method: "admin",
    reason,
    notes,
    correctedAt: now,
    correctedBy: user,
    changedFields: {
      invoiceNumber: newNum,
      supplier: newSup,
      date: newDate,
      dueDate: newDueDate,
      paymentType: newPayType,
      paymentStatus: newPayStatus
    }
  };

  inv.corrections = Array.isArray(inv.corrections) ? [...inv.corrections, correctionEntry] : [correctionEntry];
  inv.notes = `${inv.notes || ''} [Koreksi Admin: ${reason}]`.trim();

  try {
    // Jika nomor faktur berubah, perbarui juga reference di movements terkait
    if (oldInvNum && norm(oldInvNum) !== norm(newNum)) {
      const movements = readStore(STORE_KEYS.movements, []);
      let movChanged = false;
      movements.forEach(m => {
        if (norm(m.reference) === norm(oldInvNum)) {
          m.reference = newNum;
          movChanged = true;
        }
      });
      if (movChanged) await writeStore(STORE_KEYS.movements, movements);
    }

    await writeStore(STORE_KEYS.invoices, currentInvoices);
    closeInvoiceCorrectionModal();
    closeInvoiceDetailModal();
    renderInvoices();
    window.KasirProDialog?.success("Koreksi Disimpan", "Koreksi administratif faktur berhasil disimpan.");
  } catch (err) {
    window.KasirProDialog?.error("Gagal Menyimpan Koreksi", err.message);
  }
}
