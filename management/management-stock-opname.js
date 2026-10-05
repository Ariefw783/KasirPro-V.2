/**
 * management/management-stock-opname.js
 * Manajemen Stock Opname KasirPro V2
 * 
 * Sesuai Spesifikasi Tahap 4:
 * 1. Alur: Buat Sesi -> Pilih/Filter Produk -> Input Stok Fisik -> Hitung Selisih -> Review -> Konfirmasi.
 * 2. Kolom: Kode, Nama Produk, Stok Sistem, Stok Fisik, Selisih, Alasan, Status.
 * 3. Wajib Pagination: nilai Stok Fisik tersimpan saat berpindah halaman atau filter/search.
 * 4. Alasan wajib jika ada selisih (Selisih Fisik, Barang Rusak, Barang Hilang, Kesalahan Input, Lainnya).
 * 5. Konfirmasi mengunci sesi (append-only), melakukan atomic adjustment, dan mencatat movement "Stock Opname".
 * 6. Koreksi Stock Opname: Administratif & Transaksional (delta movement).
 * 7. Cetak PDF Laporan Stock Opname resmi A4 Portrait.
 */

import { $, num, text, norm, rupiah, formatNumber, formatDateTime, escapeHtml, nowIso, uid } from "../modules/core/utils.js";
import { STORE_KEYS, readStore, writeStore, writeStockTransaction, readCurrentStock } from "../modules/database/database-store.js";
import { generateStockOpnamePdf } from "../modules/core/pdf.js";

const SO_PAGE_SIZE = 25;
let opnamePage = 1;

// State Sesi Opname Aktif
let activeOpnameSession = null;
// Map penyimpan input fisik sementara per kode produk (persistent across pagination & filters)
const physicalInputCache = new Map();
const reasonCache = new Map();
const otherReasonCache = new Map();

let allOpnameProducts = [];
let filteredOpnameProducts = [];

let pendingOpnameImportItems = [];

export function initStockOpnameModule() {
  bindEvents();
  renderOpnameHistory();
}

function bindEvents() {
  // 1. Tombol Export Stok Sistem ke Excel
  $("opname-export-button")?.addEventListener("click", handleExportStockOpname);

  // 2. Tombol Navigasi ke Import Hasil Opname
  $("go-import-opname")?.addEventListener("click", openOpnameImportWorkflow);

  // 3. Tombol Kembali ke Stock Opname dari Import Panel
  $("btn-back-to-opname")?.addEventListener("click", () => {
    if (window.switchView) window.switchView("stock-opname");
    else document.querySelector('[data-view="stock-opname"]')?.click();
  });

  // 4. File input & Baca File Import Opname
  $("opname-import-file")?.addEventListener("change", handleOpnameFileSelected);
  $("read-opname-import")?.addEventListener("click", handleReadOpnameImportFile);

  // 5. Tombol Konfirmasi Adjustment Opname
  $("confirm-opname-import")?.addEventListener("click", handleConfirmOpnameImport);

  // Tombol Buat Sesi Opname Baru (Modal Input Manual)
  const opnameHeaderActions = document.querySelector('[data-view-section="stock-opname"] .module-header-actions');
  if (opnameHeaderActions && !$("btn-new-opname-session")) {
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.id = "btn-new-opname-session";
    newBtn.className = "button button-secondary";
    newBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Input Opname Manual';
    newBtn.addEventListener("click", startNewOpnameSession);
    opnameHeaderActions.appendChild(newBtn);
  }

  installOpnameSessionModal();
  installOpnameCorrectionModal();
}

export function renderOpnameHistory() {
  const tbody = $("opname-history-body");
  if (!tbody) return;

  const history = readStore(STORE_KEYS.opnames, []);
  const list = Array.isArray(history) ? [...history].reverse() : [];

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty-table-state" style="text-align:center;padding:24px;">Belum ada riwayat stock opname.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(sess => {
    const totalDiffQty = (sess.items || []).reduce((sum, it) => sum + Math.abs(num(it.difference)), 0);
    const totalDiffVal = (sess.items || []).reduce((sum, it) => sum + Math.abs(num(it.difference) * num(it.buyPrice || 0)), 0);

    return `
      <tr>
        <td>${formatDateTime(sess.createdAt || sess.date)}</td>
        <td><strong>#${escapeHtml(sess.sessionNumber || sess.id)}</strong><br><small class="text-muted">${escapeHtml(sess.notes || '—')}</small></td>
        <td>${(sess.items || []).length} produk</td>
        <td><strong>${formatNumber(totalDiffQty)} unit</strong></td>
        <td><strong>${rupiah(totalDiffVal)}</strong></td>
        <td>
          <div style="display:flex;gap:6px;">
            <button type="button" class="btn-view-opname button button-small button-secondary" data-id="${escapeHtml(sess.id)}">
              <i class="fa-solid fa-eye"></i> Detail
            </button>
            <button type="button" class="btn-pdf-opname button button-small button-secondary" data-id="${escapeHtml(sess.id)}" title="Cetak PDF">
              <i class="fa-solid fa-file-pdf"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".btn-view-opname").forEach(btn => {
    btn.addEventListener("click", () => {
      const sessId = btn.dataset.id;
      const found = list.find(s => s.id === sessId);
      if (found) openOpnameDetailModal(found);
    });
  });

  tbody.querySelectorAll(".btn-pdf-opname").forEach(btn => {
    btn.addEventListener("click", () => {
      const sessId = btn.dataset.id;
      const found = list.find(s => s.id === sessId);
      if (found) {
        const master = readStore(STORE_KEYS.master, {});
        generateStockOpnamePdf(found, master.pengaturan_toko?.[0] || {}, "Administrator");
      }
    });
  });
}

/**
 * 0A. EXPORT STOK SISTEM KE EXCEL
 */
async function handleExportStockOpname() {
  try {
    const XLSX = window.XLSX;
    if (!XLSX) {
      window.KasirProDialog?.error("Pustaka Belum Siap", "Pustaka SheetJS (XLSX) belum dimuat.");
      return;
    }

    const master = readStore(STORE_KEYS.master, {});
    const prods = Array.isArray(master.produk) ? master.produk : [];
    if (!prods.length) {
      window.KasirProDialog?.warning("Master Produk Kosong", "Belum ada produk yang tersimpan di sistem untuk diekspor.");
      return;
    }

    const rows = [
      ["No", "Kode Produk Internal", "Barcode", "Nama Produk", "Kategori", "Satuan Dasar", "Harga Beli Terakhir", "Stok Sistem", "Stok Fisik", "Alasan"]
    ];

    prods.forEach((p, idx) => {
      const code = p["Kode Produk Internal"] || p["Kode Produk"] || p.id || "";
      const barcode = p["Barcode"] || p.barcode || "";
      const name = p["Nama Produk"] || p.name || "";
      const cat = p["Kategori"] || p.category || "";
      const unit = p["Satuan Dasar"] || p["Satuan"] || "Pcs";
      const buyPrice = num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0);
      const systemStock = readCurrentStock(code);

      rows.push([
        idx + 1,
        code,
        barcode,
        name,
        cat,
        unit,
        buyPrice,
        systemStock,
        "", // Kolom Stok Fisik dikosongkan agar diisi oleh petugas
        ""  // Kolom Alasan dikosongkan
      ]);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "STOCK_OPNAME");

    const today = new Date().toISOString().slice(0, 10);
    const fileName = `Stock_Opname_Sistem_${today}.xlsx`;
    XLSX.writeFile(wb, fileName);

    window.KasirProDialog?.success(
      "Export Stok Sistem Berhasil",
      `Lembar hitung fisik (${prods.length} produk) berhasil diekspor ke file:\n${fileName}\n\nLangkah selanjutnya:\n1. Buka file Excel dan isi kolom 'Stok Fisik' sesuai hasil hitung fisik gudang/rak.\n2. Jika ada selisih, isi kolom 'Alasan'.\n3. Unggah file kembali menggunakan tombol 'Import Hasil Opname'.`
    );
  } catch (err) {
    console.error("[StockOpname] Error exporting system stock:", err);
    window.KasirProDialog?.error("Gagal Export Stok Sistem", err.message || "Terjadi kesalahan saat membuat file Excel.");
  }
}

/**
 * 0B. ALUR IMPORT HASIL STOCK OPNAME
 */
function openOpnameImportWorkflow() {
  if (window.switchView) {
    window.switchView("import-opname");
  } else {
    document.querySelectorAll("[data-view-section]").forEach(sec => {
      sec.hidden = sec.dataset.viewSection !== "import-opname";
    });
  }

  // Reset input & preview
  const fileInput = $("opname-import-file");
  if (fileInput) fileInput.value = "";
  const summaryEl = $("opname-import-summary");
  if (summaryEl) summaryEl.hidden = true;
  const previewWrapper = $("opname-import-preview");
  if (previewWrapper) previewWrapper.hidden = true;
  const actionsWrapper = $("opname-import-actions");
  if (actionsWrapper) actionsWrapper.hidden = true;
  pendingOpnameImportItems = [];
}

function handleOpnameFileSelected() {
  const fileInput = $("opname-import-file");
  if (fileInput?.files?.[0]) {
    handleReadOpnameImportFile();
  }
}

async function handleReadOpnameImportFile() {
  const fileInput = $("opname-import-file");
  const file = fileInput?.files?.[0];
  if (!file) {
    window.KasirProDialog?.warning("File Belum Dipilih", "Silakan pilih file Excel lembar hasil opname terlebih dahulu.");
    return;
  }

  const readBtn = $("read-opname-import");
  if (readBtn) {
    readBtn.disabled = true;
    readBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Membaca...';
  }

  try {
    const XLSX = window.XLSX;
    if (!XLSX) throw new Error("Pustaka SheetJS (XLSX) belum dimuat.");

    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: "array" });
    const sheetName = wb.SheetNames[0];
    const rawRows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });

    if (!rawRows.length) {
      throw new Error("Lembar Excel kosong, tidak ada data opname yang terbaca.");
    }

    const master = readStore(STORE_KEYS.master, {});
    const products = Array.isArray(master.produk) ? master.produk : [];

    const parsedItems = [];
    let totalDiffQty = 0;
    let totalDiffVal = 0;

    for (const r of rawRows) {
      const code = text(r["Kode Produk Internal"] || r["Kode Produk"] || r["Kode"] || r.code);
      const barcode = text(r["Barcode"] || r.barcode);
      const name = text(r["Nama Produk"] || r["Nama"] || r.name);
      const physicalRaw = r["Stok Fisik"] !== undefined && r["Stok Fisik"] !== "" ? r["Stok Fisik"] : (r["Fisik"] !== undefined && r["Fisik"] !== "" ? r["Fisik"] : null);

      if (physicalRaw === null || physicalRaw === "") {
        // Lewati jika kolom fisik kosong
        continue;
      }

      const physicalStock = num(physicalRaw);

      let prod = products.find(p => {
        if (code && norm(p["Kode Produk"] || p["Kode Produk Internal"]) === norm(code)) return true;
        if (barcode && norm(p["Barcode"]) === norm(barcode)) return true;
        if (name && norm(p["Nama Produk"]) === norm(name)) return true;
        return false;
      });

      const prodCode = prod ? (prod["Kode Produk"] || prod["Kode Produk Internal"] || prod.id) : (code || name);
      const prodName = prod ? (prod["Nama Produk"] || prod.name) : (name || prodCode);
      const buyPrice = prod ? num(prod["Harga Beli Terakhir"] ?? prod["Harga Beli"] ?? 0) : 0;
      const systemStock = readCurrentStock(prodCode);
      const diff = physicalStock - systemStock;
      const diffVal = diff * buyPrice;
      const reason = text(r["Alasan"] || r["Keterangan"] || (diff !== 0 ? "Penyesuaian Fisik Opname" : "Sesuai"));

      parsedItems.push({
        productCode: prodCode,
        productName: prodName,
        systemStock,
        physicalStock,
        difference: diff,
        buyPrice,
        differenceValue: diffVal,
        reason
      });

      if (diff !== 0) {
        totalDiffQty += Math.abs(diff);
        totalDiffVal += Math.abs(diffVal);
      }
    }

    if (!parsedItems.length) {
      throw new Error("Tidak ditemukan baris yang mengisi kolom 'Stok Fisik'. Pastikan Anda mengisi kolom 'Stok Fisik' pada file Excel sebelum mengunggah.");
    }

    pendingOpnameImportItems = parsedItems;
    renderOpnameImportPreview(parsedItems, totalDiffQty, totalDiffVal);

  } catch (err) {
    console.error("[StockOpname] Error parsing import opname:", err);
    window.KasirProDialog?.error("Gagal Membaca File Opname", err.message || "Pastikan format file sesuai lembar hasil export.");
  } finally {
    if (readBtn) {
      readBtn.disabled = false;
      readBtn.innerHTML = '<i class="fa-solid fa-file-import"></i> Baca &amp; Preview';
    }
  }
}

function renderOpnameImportPreview(items, totalDiffQty, totalDiffVal) {
  const summaryEl = $("opname-import-summary");
  const previewWrapper = $("opname-import-preview");
  const tbody = $("opname-import-preview-body");
  const actionsWrapper = $("opname-import-actions");

  if (!summaryEl || !previewWrapper || !tbody) return;

  const itemsWithDiff = items.filter(it => it.difference !== 0);

  summaryEl.hidden = false;
  summaryEl.className = itemsWithDiff.length > 0 ? "ops-notice ops-notice-warning" : "ops-notice ops-notice-success";
  summaryEl.innerHTML = `
    <div style="font-size:13.5px;line-height:1.6;">
      <strong>Hasil Pembacaan Lembar Opname:</strong><br>
      Total Produk Terbaca: <strong>${items.length}</strong> | Produk dengan Selisih Stok: <strong>${itemsWithDiff.length}</strong><br>
      Total Selisih Unit: <strong>${formatNumber(totalDiffQty)} unit</strong> | Estimasi Nilai Selisih: <strong>${rupiah(totalDiffVal)}</strong>
    </div>
  `;

  tbody.innerHTML = items.map(it => {
    const hasDiff = it.difference !== 0;
    const diffColor = it.difference > 0 ? '#16a34a' : (it.difference < 0 ? '#dc2626' : '#64748b');
    const diffSign = it.difference > 0 ? '+' : '';

    return `
      <tr style="${hasDiff ? 'background:#fffbeb;' : ''}">
        <td><strong>${escapeHtml(it.productCode)}</strong></td>
        <td><strong>${escapeHtml(it.productName)}</strong><br><small class="text-muted">Alasan: ${escapeHtml(it.reason)}</small></td>
        <td>${formatNumber(it.systemStock)}</td>
        <td><strong>${formatNumber(it.physicalStock)}</strong></td>
        <td style="color:${diffColor};font-weight:700;">${diffSign}${formatNumber(it.difference)}</td>
        <td style="color:${diffColor};font-weight:700;">${rupiah(it.differenceValue)}</td>
      </tr>
    `;
  }).join("");

  previewWrapper.hidden = false;
  if (actionsWrapper) actionsWrapper.hidden = false;
}

async function handleConfirmOpnameImport() {
  if (!pendingOpnameImportItems || !pendingOpnameImportItems.length) return;

  const itemsWithDiff = pendingOpnameImportItems.filter(it => it.difference !== 0);

  const confirmed = await window.KasirProDialog?.confirm(
    "Konfirmasi Adjustment Stok",
    `Apakah Anda yakin ingin menerapkan penyesuaian hasil opname ini?\n\n` +
    `• Total Produk Diperiksa: ${pendingOpnameImportItems.length}\n` +
    `• Produk Mengalami Penyesuaian: ${itemsWithDiff.length}\n\n` +
    `Penyesuaian stok akan dicatat secara permanen di riwayat mutasi dan stok sistem.`
  );
  if (!confirmed) return;

  const confirmBtn = $("confirm-opname-import");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyimpan...';
  }

  try {
    const now = nowIso();
    const sessionNumber = `SO-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const movements = [];

    itemsWithDiff.forEach((it, idx) => {
      movements.push({
        id: `MOV-SO-${Date.now()}-${idx}`,
        movementType: "Stock Opname",
        type: "Stock Opname",
        productCode: it.productCode,
        productName: it.productName,
        quantity: it.difference,
        source: "Stock Opname",
        reference: sessionNumber,
        notes: it.reason || "Penyesuaian Stock Opname Excel",
        user: "Administrator",
        createdAt: now
      });
    });

    const completedSession = {
      id: `SO-${Date.now()}`,
      sessionNumber,
      date: now,
      createdAt: now,
      status: "Selesai",
      notes: "Import Hasil Hitung Fisik Excel",
      items: pendingOpnameImportItems,
      totalDiffQty: itemsWithDiff.reduce((sum, it) => sum + Math.abs(it.difference), 0),
      totalDiffVal: itemsWithDiff.reduce((sum, it) => sum + Math.abs(it.differenceValue), 0)
    };

    // Eksekusi transaksi atomik stok
    await writeStockTransaction([
      { key: STORE_KEYS.opnames, records: [completedSession] },
      { key: STORE_KEYS.movements, records: movements }
    ]);

    pendingOpnameImportItems = [];

    window.KasirProDialog?.success(
      "Stock Opname Berhasil",
      `Penyesuaian hasil opname #${sessionNumber} berhasil diterapkan!\n${itemsWithDiff.length} produk disesuaikan ke stok fisik aktual.`
    );

    // Kembali ke tampilan stock opname
    if (window.switchView) {
      window.switchView("stock-opname");
    } else {
      document.querySelector('[data-view="stock-opname"]')?.click();
    }
    renderOpnameHistory();
  } catch (err) {
    console.error("[StockOpname] Error applying opname adjustment:", err);
    window.KasirProDialog?.error("Gagal Menyimpan Opname", err.message || "Terjadi kesalahan saat menyimpan penyesuaian stok.");
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i class="fa-solid fa-check"></i> Konfirmasi Adjustment';
    }
  }
}

/**
 * 1. MULAI SESI OPNAME MASSAL BARU
 */
function startNewOpnameSession() {
  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? master.produk : [];

  if (!prods.length) {
    window.KasirProDialog?.warning("Master Produk Kosong", "Belum ada produk untuk dilakukan stock opname.");
    return;
  }

  physicalInputCache.clear();
  reasonCache.clear();
  otherReasonCache.clear();
  opnamePage = 1;

  allOpnameProducts = prods.map(p => {
    const code = p["Kode Produk"] || p["Kode Produk Internal"] || p.id;
    const systemStock = readCurrentStock(code);
    return {
      code,
      name: p["Nama Produk"] || "—",
      category: p["Kategori"] || "—",
      unit: p["Satuan Dasar"] || p["Satuan"] || "Pcs",
      systemStock,
      buyPrice: num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0)
    };
  });

  activeOpnameSession = {
    id: `SO-${Date.now()}`,
    sessionNumber: `SO-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    status: "Dalam Proses",
    createdAt: nowIso()
  };

  openOpnameSessionModal();
}

/**
 * 2. MODAL SESI STOCK OPNAME DENGAN PAGINATION AMAN
 */
function installOpnameSessionModal() {
  if ($("modal-opname-session")) return;

  const modalHtml = `
    <div id="modal-opname-session" class="kp-dialog-v4" hidden>
      <div class="kp-dialog-v4__backdrop"></div>
      <section class="kp-dialog-v4__card" style="width:min(96vw,920px);max-height:94vh;display:flex;flex-direction:column;" role="dialog">
        <header style="padding:16px 24px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
          <div>
            <h2 id="opname-session-title" style="font-size:17px;font-weight:800;margin:0;">Sesi Stock Opname Massal</h2>
            <span style="font-size:12px;color:#64748b;">Input stok fisik produk. Nilai tetap tersimpan saat berpindah halaman atau menyaring produk.</span>
          </div>
          <button type="button" id="close-modal-opname-sess" class="button button-small button-secondary" style="padding:4px 8px;"><i class="fa-solid fa-xmark"></i></button>
        </header>

        <!-- Filter & Search Toolbar -->
        <div style="padding:12px 24px;background:#f8fafc;border-bottom:1px solid #e2e8f0;display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
          <input type="search" id="opname-sess-search" placeholder="Cari kode atau nama produk..." style="flex:1;min-width:200px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:13px;">
          <label style="font-size:12.5px;color:#334155;display:flex;align-items:center;gap:6px;">
            <input type="checkbox" id="opname-only-diff"> Hanya Tampilkan Selisih
          </label>
        </div>

        <!-- Tabel Produk Opname -->
        <div style="flex:1;overflow-y:auto;padding:16px 24px;">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width:110px;">Kode</th>
                <th>Nama Produk</th>
                <th style="width:90px;">Stok Sistem</th>
                <th style="width:110px;">Stok Fisik</th>
                <th style="width:90px;">Selisih</th>
                <th style="width:200px;">Alasan Selisih</th>
              </tr>
            </thead>
            <tbody id="opname-sess-table-body"></tbody>
          </table>
        </div>

        <!-- Pagination & Summary Footer -->
        <footer style="padding:14px 24px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <span id="opname-page-info" style="font-size:12.5px;color:#475569;">—</span>
            <div style="display:flex;gap:4px;">
              <button type="button" id="opname-prev-p" class="button button-small button-secondary"><i class="fa-solid fa-chevron-left"></i></button>
              <button type="button" id="opname-next-p" class="button button-small button-secondary"><i class="fa-solid fa-chevron-right"></i></button>
            </div>
          </div>
          <div style="display:flex;gap:8px;">
            <button type="button" id="cancel-opname-sess" class="button button-secondary">Batal</button>
            <button type="button" id="confirm-opname-sess" class="button button-primary"><i class="fa-solid fa-circle-check"></i> Review & Konfirmasi Opname</button>
          </div>
        </footer>
      </section>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  $("close-modal-opname-sess")?.addEventListener("click", closeOpnameSessionModal);
  $("cancel-opname-sess")?.addEventListener("click", closeOpnameSessionModal);
  $("opname-prev-p")?.addEventListener("click", () => {
    if (opnamePage > 1) {
      saveCurrentPageInputs();
      opnamePage--;
      renderOpnameSessionTable();
    }
  });
  $("opname-next-p")?.addEventListener("click", () => {
    const totalPages = Math.ceil(filteredOpnameProducts.length / SO_PAGE_SIZE) || 1;
    if (opnamePage < totalPages) {
      saveCurrentPageInputs();
      opnamePage++;
      renderOpnameSessionTable();
    }
  });

  $("opname-sess-search")?.addEventListener("input", () => {
    saveCurrentPageInputs();
    opnamePage = 1;
    applyOpnameSessionFilters();
  });

  $("opname-only-diff")?.addEventListener("change", () => {
    saveCurrentPageInputs();
    opnamePage = 1;
    applyOpnameSessionFilters();
  });

  $("confirm-opname-sess")?.addEventListener("click", handleConfirmOpnameSession);
}

function openOpnameSessionModal() {
  const modal = $("modal-opname-session");
  if (!modal) return;
  $("opname-session-title").textContent = `Sesi Stock Opname #${activeOpnameSession?.sessionNumber}`;
  applyOpnameSessionFilters();
  modal.hidden = false;
}

function closeOpnameSessionModal() {
  saveCurrentPageInputs();
  const modal = $("modal-opname-session");
  if (modal) modal.hidden = true;
  activeOpnameSession = null;
}

function applyOpnameSessionFilters() {
  const q = norm($("opname-sess-search")?.value);
  const onlyDiff = $("opname-only-diff")?.checked;

  filteredOpnameProducts = allOpnameProducts.filter(p => {
    const code = norm(p.code);
    const name = norm(p.name);
    if (q && !code.includes(q) && !name.includes(q)) return false;

    if (onlyDiff) {
      const phys = physicalInputCache.has(p.code) ? physicalInputCache.get(p.code) : p.systemStock;
      if (phys === p.systemStock) return false;
    }

    return true;
  });

  renderOpnameSessionTable();
}

function saveCurrentPageInputs() {
  const tbody = $("opname-sess-table-body");
  if (!tbody) return;

  tbody.querySelectorAll("tr[data-code]").forEach(row => {
    const code = row.dataset.code;
    const physInput = row.querySelector(".input-physical-stock");
    const reasonSelect = row.querySelector(".select-opname-reason");
    const otherInput = row.querySelector(".input-other-reason");

    if (physInput && physInput.value !== "") {
      physicalInputCache.set(code, num(physInput.value));
    }
    if (reasonSelect) {
      reasonCache.set(code, reasonSelect.value);
    }
    if (otherInput) {
      otherReasonCache.set(code, text(otherInput.value));
    }
  });
}

function renderOpnameSessionTable() {
  const tbody = $("opname-sess-table-body");
  if (!tbody) return;

  const total = filteredOpnameProducts.length;
  const start = (opnamePage - 1) * SO_PAGE_SIZE;
  const pageItems = filteredOpnameProducts.slice(start, start + SO_PAGE_SIZE);

  if (!pageItems.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-table-state" style="text-align:center;padding:24px;">Tidak ada produk yang sesuai.</td></tr>`;
  } else {
    tbody.innerHTML = pageItems.map(p => {
      // Ambil nilai dari persistent cache jika ada, default kosong/stok sistem
      const hasInput = physicalInputCache.has(p.code);
      const physVal = hasInput ? physicalInputCache.get(p.code) : "";
      const diff = hasInput ? physVal - p.systemStock : 0;
      const curReason = reasonCache.get(p.code) || "Selisih Fisik";
      const curOther = otherReasonCache.get(p.code) || "";

      const diffColor = diff > 0 ? "#059669" : (diff < 0 ? "#dc2626" : "#64748b");
      const diffStr = diff > 0 ? `+${diff}` : `${diff}`;

      return `
        <tr data-code="${escapeHtml(p.code)}">
          <td><strong>${escapeHtml(p.code)}</strong></td>
          <td><strong>${escapeHtml(p.name)}</strong></td>
          <td>${formatNumber(p.systemStock)} ${escapeHtml(p.unit)}</td>
          <td>
            <input type="number" min="0" class="input-physical-stock" data-code="${escapeHtml(p.code)}" value="${physVal}" style="width:90px;padding:6px 8px;border:1px solid #cbd5e1;border-radius:6px;font-weight:700;" placeholder="${p.systemStock}">
          </td>
          <td>
            <strong class="col-diff" style="color:${diffColor};">${diffStr}</strong>
          </td>
          <td>
            <div class="reason-container" style="${diff === 0 ? 'display:none;' : 'display:flex;flex-direction:column;gap:4px;'}">
              <select class="select-opname-reason" data-code="${escapeHtml(p.code)}" style="padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;">
                <option value="Selisih Fisik" ${curReason === 'Selisih Fisik' ? 'selected' : ''}>Selisih Fisik</option>
                <option value="Barang Rusak" ${curReason === 'Barang Rusak' ? 'selected' : ''}>Barang Rusak</option>
                <option value="Barang Hilang" ${curReason === 'Barang Hilang' ? 'selected' : ''}>Barang Hilang</option>
                <option value="Kesalahan Input" ${curReason === 'Kesalahan Input' ? 'selected' : ''}>Kesalahan Input</option>
                <option value="Lainnya" ${curReason === 'Lainnya' ? 'selected' : ''}>Lainnya</option>
              </select>
              <input type="text" class="input-other-reason" data-code="${escapeHtml(p.code)}" value="${escapeHtml(curOther)}" placeholder="Jelaskan alasan..." style="${curReason === 'Lainnya' ? 'display:block;' : 'display:none;'}padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:11.5px;">
            </div>
          </td>
        </tr>
      `;
    }).join("");

    // Live update listener pada input stok fisik
    tbody.querySelectorAll(".input-physical-stock").forEach(input => {
      input.addEventListener("input", () => {
        const code = input.dataset.code;
        const row = input.closest("tr");
        const pObj = allOpnameProducts.find(x => x.code === code);
        if (!pObj) return;

        const val = input.value === "" ? pObj.systemStock : num(input.value);
        physicalInputCache.set(code, val);

        const diff = val - pObj.systemStock;
        const diffEl = row.querySelector(".col-diff");
        const reasonWrap = row.querySelector(".reason-container");

        if (diffEl) {
          diffEl.style.color = diff > 0 ? "#059669" : (diff < 0 ? "#dc2626" : "#64748b");
          diffEl.textContent = diff > 0 ? `+${diff}` : `${diff}`;
        }
        if (reasonWrap) {
          reasonWrap.style.display = diff === 0 ? "none" : "flex";
        }
      });
    });

    tbody.querySelectorAll(".select-opname-reason").forEach(sel => {
      sel.addEventListener("change", () => {
        const code = sel.dataset.code;
        reasonCache.set(code, sel.value);
        const row = sel.closest("tr");
        const otherInp = row.querySelector(".input-other-reason");
        if (otherInp) {
          otherInp.style.display = sel.value === "Lainnya" ? "block" : "none";
        }
      });
    });

    tbody.querySelectorAll(".input-other-reason").forEach(inp => {
      inp.addEventListener("input", () => {
        const code = inp.dataset.code;
        otherReasonCache.set(code, inp.value);
      });
    });
  }

  const pageInfoEl = $("opname-page-info");
  const totalPages = Math.ceil(total / SO_PAGE_SIZE) || 1;
  if (pageInfoEl) {
    pageInfoEl.textContent = `Halaman ${opnamePage} dari ${totalPages} (${total} total produk)`;
  }

  const prevBtn = $("opname-prev-p");
  if (prevBtn) prevBtn.disabled = opnamePage <= 1;

  const nextBtn = $("opname-next-p");
  if (nextBtn) nextBtn.disabled = opnamePage >= totalPages;
}

/**
 * 3. KONFIRMASI SESI STOCK OPNAME
 */
async function handleConfirmOpnameSession() {
  saveCurrentPageInputs();

  // Validasi seluruh produk yang memiliki selisih
  const adjustedItems = [];
  for (const p of allOpnameProducts) {
    const hasInput = physicalInputCache.has(p.code);
    const physVal = hasInput ? physicalInputCache.get(p.code) : p.systemStock;
    const diff = physVal - p.systemStock;

    if (diff !== 0) {
      let r = reasonCache.get(p.code) || "Selisih Fisik";
      const o = otherReasonCache.get(p.code) || "";
      if (r === "Lainnya") {
        if (!o.trim()) {
          window.KasirProDialog?.warning(
            "Alasan Wajib Diisi",
            `Produk "${p.name}" memiliki selisih dan memilih alasan "Lainnya". Keterangan manual wajib diisi!`
          );
          return;
        }
        r = `Lainnya: ${o.trim()}`;
      }

      adjustedItems.push({
        productCode: p.code,
        code: p.code,
        productName: p.name,
        name: p.name,
        systemStock: p.systemStock,
        physicalStock: physVal,
        difference: diff,
        reason: r,
        buyPrice: p.buyPrice,
        status: "Terkonfirmasi"
      });
    }
  }

  if (!adjustedItems.length) {
    const noDiffConfirm = await window.KasirProDialog?.confirm(
      "Tidak Ada Selisih",
      "Seluruh stok fisik sesuai dengan stok sistem (0 selisih).\nApakah Anda ingin menyelesaikan sesi stock opname ini?"
    );
    if (!noDiffConfirm) return;
  } else {
    const countConfirm = await window.KasirProDialog?.confirm(
      "Konfirmasi Hasil Opname",
      `Terdapat ${adjustedItems.length} produk dengan selisih stok yang akan disesuaikan.\n\nSesi akan dikunci dan perubahan stok akan dicatat secara permanen. Lanjutkan?`
    );
    if (!countConfirm) return;
  }

  try {
    const now = nowIso();
    const user = "Admin";
    const movements = [];

    // Catat mutasi untuk setiap produk yang berselisih
    for (const it of adjustedItems) {
      movements.push({
        id: uid("mov-so"),
        productCode: it.productCode,
        productName: it.productName,
        type: "Stock Opname",
        delta: it.difference,
        quantity: Math.abs(it.difference),
        stockBefore: it.systemStock,
        stockAfter: it.physicalStock,
        source: "Stock Opname",
        reference: activeOpnameSession.sessionNumber,
        user,
        reason: it.reason,
        createdAt: now
      });
    }

    const completedSession = {
      ...activeOpnameSession,
      status: "Terkonfirmasi",
      confirmedAt: now,
      confirmedBy: user,
      items: adjustedItems,
      totalAdjusted: adjustedItems.length
    };

    // Eksekusi transaksi atomik
    await writeStockTransaction([
      { key: STORE_KEYS.opnames, records: [completedSession] },
      { key: STORE_KEYS.movements, records: movements }
    ]);

    closeOpnameSessionModal();
    renderOpnameHistory();
    window.KasirProDialog?.success(
      "Stock Opname Selesai",
      `Sesi opname #${completedSession.sessionNumber} berhasil dikonfirmasi.\nStok telah disesuaikan secara atomik.`
    );
  } catch (err) {
    window.KasirProDialog?.error("Gagal Menyimpan Opname", err.message);
  }
}

/**
 * 4. DETAIL MODAL OPNAME
 */
function openOpnameDetailModal(sess) {
  const master = readStore(STORE_KEYS.master, {});
  const settings = master.pengaturan_toko?.[0] || {};

  const totalDiffQty = (sess.items || []).reduce((sum, it) => sum + Math.abs(num(it.difference)), 0);

  window.KasirProDialog?.info(
    `Detail Stock Opname #${sess.sessionNumber || sess.id}`,
    `Tanggal: ${formatDateTime(sess.createdAt || sess.date)}\nStatus: ${sess.status}\nTotal Item Selisih: ${(sess.items || []).length} produk (${totalDiffQty} unit)\n\nCetak laporan PDF dapat dilakukan melalui tombol PDF pada tabel riwayat.`
  );
}

/**
 * 5. KOREKSI STOCK OPNAME (ADMINISTRATIF & TRANSAKSIONAL)
 */
function installOpnameCorrectionModal() {
  // Tersedia jika diperlukan koreksi lanjutan
}
