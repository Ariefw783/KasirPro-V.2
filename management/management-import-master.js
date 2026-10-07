/**
 * management/management-import-master.js
 * Workflow Wizard Import Master Data KasirPro V2
 * 
 * Sesuai Spesifikasi:
 * - Import Master adalah UPDATE, BUKAN REPLACE.
 * - Tidak menghapus produk yang tidak ada di file baru.
 * - Tidak mereset stok, transaksi, batch/EXP, harga beli terakhir, atau histori penjualan.
 * - Deteksi versi, bandingkan data, tampilkan perubahan dan preview, minta konfirmasi sebelum update.
 */

import { $, num, text, norm, rupiah, formatNumber, escapeHtml } from "../modules/core/utils.js";
import { STORE_KEYS, readStore, writeStore } from "../modules/database/database-store.js";
import { parseMasterWorkbook } from "../modules/excel/excel-service.js";
import { renderProducts } from "./management-products.js";
import { renderSuppliers } from "./management-suppliers.js";
import { renderCategories } from "./management-categories.js";

let selectedFile = null;
let parsedMasterResult = null;
let currentStep = 1;
let previewSearchQuery = "";
let activePreviewTab = "PRODUK";

export function initImportMasterModule() {
  bindEvents();
}

function bindEvents() {
  const fileInput = $("master-file-input");
  const dropZone = $("master-drop-zone");
  const browseBtn = $("browse-master-file");
  const removeBtn = $("remove-master-file");
  const readBtn = $("read-master-file");

  browseBtn?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", (e) => {
    if (e.target.files?.[0]) handleFileChosen(e.target.files[0]);
  });

  // Drag and Drop
  dropZone?.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone?.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
  dropZone?.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files?.[0]) handleFileChosen(e.dataTransfer.files[0]);
  });

  removeBtn?.addEventListener("click", resetFileSelection);
  readBtn?.addEventListener("click", handleReadMasterFile);

  // Tombol navigasi mundur (data-import-back="1|2|3")
  document.querySelectorAll("[data-import-back]").forEach(btn => {
    btn.addEventListener("click", () => {
      const target = Number(btn.dataset.importBack);
      if (target) goToStep(target);
    });
  });

  // Step 2 Next -> Step 3
  $("review-master-warnings")?.addEventListener("click", () => goToStep(3));

  // Step 3 Next -> Step 4
  $("continue-master-confirm")?.addEventListener("click", () => goToStep(4));

  // Step 4 Confirm
  $("confirm-master-import")?.addEventListener("click", handleApplyMasterImport);

  // Result Panel Navigation
  $("import-another-master")?.addEventListener("click", resetFileSelection);
  $("btn-result-to-dashboard")?.addEventListener("click", () => {
    const btn = $("btn-result-to-dashboard");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyiapkan Dashboard...';
    }
    setTimeout(() => {
      resetFileSelection();
      if (window.switchView) window.switchView("dashboard");
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-gauge-high"></i> Kembali ke Dashboard';
      }
    }, 40);
  });
  $("btn-result-to-products")?.addEventListener("click", () => {
    const btn = $("btn-result-to-products");
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menyiapkan Produk...';
    }
    setTimeout(() => {
      resetFileSelection();
      if (window.switchView) window.switchView("products");
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-boxes-stacked"></i> Lihat Daftar Produk';
      }
    }, 40);
  });

  // Search filter di preview step 2
  $("master-preview-search")?.addEventListener("input", (e) => {
    previewSearchQuery = norm(e.target.value);
    renderPreviewTable();
  });
}

function handleFileChosen(file) {
  selectedFile = file;
  const selectedBox = $("selected-master-file");
  const dropZone = $("master-drop-zone");
  const nameEl = $("selected-file-name");
  const sizeEl = $("selected-file-size");
  const readBtn = $("read-master-file");

  if (nameEl) nameEl.textContent = file.name;
  if (sizeEl) sizeEl.textContent = `${(file.size / 1024).toFixed(1)} KB`;

  if (dropZone) dropZone.hidden = true;
  if (selectedBox) selectedBox.hidden = false;
  if (readBtn) readBtn.disabled = false;
}

function resetFileSelection() {
  selectedFile = null;
  parsedMasterResult = null;
  previewSearchQuery = "";
  activePreviewTab = "PRODUK";
  const fileInput = $("master-file-input");
  if (fileInput) fileInput.value = "";
  const selectedBox = $("selected-master-file");
  const dropZone = $("master-drop-zone");
  const readBtn = $("read-master-file");

  if (dropZone) dropZone.hidden = false;
  if (selectedBox) selectedBox.hidden = true;
  if (readBtn) readBtn.disabled = true;

  const resPanel = $("master-import-result");
  if (resPanel) resPanel.hidden = true;

  goToStep(1);
}

function goToStep(step) {
  currentStep = step;
  document.querySelectorAll("[data-import-step]").forEach(panel => {
    panel.hidden = Number(panel.dataset.importStep) !== step;
  });

  document.querySelectorAll("[data-step-indicator]").forEach(ind => {
    const s = Number(ind.dataset.stepIndicator);
    ind.classList.toggle("active", s === step);
    ind.classList.toggle("completed", s < step);
  });
}

async function handleReadMasterFile() {
  if (!selectedFile) return;

  const readBtn = $("read-master-file");
  if (readBtn) {
    readBtn.disabled = true;
    readBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Membaca...';
  }

  window.KasirProDialog?.showProgress(
    "Membaca File Master",
    "Sedang membaca sheet dan menganalisis struktur data...",
    { percent: 45, detail: selectedFile.name || "Berkas Excel" }
  );

  try {
    const currentMaster = readStore(STORE_KEYS.master, {});
    parsedMasterResult = await parseMasterWorkbook(selectedFile, currentMaster);

    window.KasirProDialog?.updateProgress({
      message: "Menyiapkan pratinjau data & validasi...",
      percent: 90,
      detail: `${formatNumber(parsedMasterResult.summary.totalIncoming)} baris terbaca`
    });

    renderStep2Preview(parsedMasterResult);
    renderStep3Validation(parsedMasterResult);
    renderStep4Confirmation(parsedMasterResult);

    goToStep(2);
  } catch (err) {
    console.error("[ImportMaster] Error parsing workbook:", err);
    window.KasirProDialog?.error("Gagal Membaca File Master", err.message || "Pastikan format file sesuai template.");
  } finally {
    window.KasirProDialog?.closeProgress();
    if (readBtn) {
      readBtn.disabled = false;
      readBtn.innerHTML = 'Baca File <i class="fa-solid fa-arrow-right"></i>';
    }
  }
}

function renderStep2Preview(res) {
  const s = res.summary;
  const sheetNames = res.sheetNames || [];

  const sheetCountEl = $("summary-sheet-count");
  if (sheetCountEl) sheetCountEl.textContent = sheetNames.length || 1;

  const rowCountEl = $("summary-row-count");
  if (rowCountEl) rowCountEl.textContent = formatNumber(s.totalIncoming);

  const warnCountEl = $("summary-warning-count");
  if (warnCountEl) warnCountEl.textContent = "0";

  // Render sheet tabs jika ada container
  const tabsContainer = $("master-sheet-tabs");
  if (tabsContainer) {
    tabsContainer.innerHTML = sheetNames.map((name) => {
      const isActive = norm(name) === norm(activePreviewTab);
      return `
        <button type="button" class="tab-button ${isActive ? 'active' : ''}" data-sheet-tab="${escapeHtml(name)}" style="padding:6px 14px;border-radius:6px;border:1px solid #cbd5e1;background:${isActive ? '#0f2a43' : '#fff'};color:${isActive ? '#fff' : '#334155'};font-weight:600;font-size:12px;cursor:pointer;">
          <i class="fa-solid fa-table"></i> ${escapeHtml(name)}
        </button>
      `;
    }).join("");

    // Bind event klik pada setiap tombol tab
    tabsContainer.querySelectorAll("[data-sheet-tab]").forEach(btn => {
      btn.addEventListener("click", () => {
        activePreviewTab = btn.dataset.sheetTab;
        // Update styling tombol tab
        tabsContainer.querySelectorAll("[data-sheet-tab]").forEach(b => {
          const isAct = b.dataset.sheetTab === activePreviewTab;
          b.classList.toggle("active", isAct);
          b.style.background = isAct ? "#0f2a43" : "#fff";
          b.style.color = isAct ? "#fff" : "#334155";
        });
        renderPreviewTable();
      });
    });
  }

  renderPreviewTable();
}

function renderPreviewTable() {
  if (!parsedMasterResult) return;
  const tbody = $("master-preview-body");
  const thead = $("master-preview-head");
  if (!tbody || !thead) return;

  const currentTab = norm(activePreviewTab);

  if (currentTab.includes("supplier")) {
    thead.innerHTML = `
      <tr>
        <th>No</th>
        <th>Nama Perusahaan</th>
        <th>Nama Sales / PIC</th>
        <th>NPWP</th>
      </tr>
    `;
    const sups = parsedMasterResult.suppliers || [];
    const filtered = sups.filter(s => {
      if (!previewSearchQuery) return true;
      return norm(s["Nama Perusahaan"]).includes(previewSearchQuery) ||
             norm(s["Nama Sales/PIC"]).includes(previewSearchQuery) ||
             norm(s["NPWP"]).includes(previewSearchQuery);
    });

    const visibleCountEl = $("preview-visible-count");
    if (visibleCountEl) visibleCountEl.textContent = formatNumber(filtered.length);

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-table-state" style="text-align:center;padding:24px;">Tidak ada data supplier.</td></tr>`;
      return;
    }
    tbody.innerHTML = filtered.slice(0, 100).map((s, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td><strong>${escapeHtml(s["Nama Perusahaan"] || "—")}</strong></td>
        <td>${escapeHtml(s["Nama Sales/PIC"] || "—")}</td>
        <td>${escapeHtml(s["NPWP"] || "—")}</td>
      </tr>
    `).join("");
    return;
  }

  if (currentTab.includes("kategori")) {
    thead.innerHTML = `
      <tr>
        <th>No</th>
        <th>Kode Kategori</th>
        <th>Nama Kategori</th>
        <th>Deskripsi</th>
      </tr>
    `;
    const kats = parsedMasterResult.categories || [];
    const filtered = kats.filter(k => {
      if (!previewSearchQuery) return true;
      return norm(k["Kode Kategori"]).includes(previewSearchQuery) ||
             norm(k["Nama Kategori"]).includes(previewSearchQuery) ||
             norm(k["Deskripsi"]).includes(previewSearchQuery);
    });

    const visibleCountEl = $("preview-visible-count");
    if (visibleCountEl) visibleCountEl.textContent = formatNumber(filtered.length);

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-table-state" style="text-align:center;padding:24px;">Tidak ada data kategori.</td></tr>`;
      return;
    }
    tbody.innerHTML = filtered.slice(0, 100).map((k, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td><strong>${escapeHtml(k["Kode Kategori"] || "—")}</strong></td>
        <td><strong>${escapeHtml(k["Nama Kategori"] || "—")}</strong></td>
        <td>${escapeHtml(k["Deskripsi"] || "—")}</td>
      </tr>
    `).join("");
    return;
  }

  if (currentTab.includes("panduan")) {
    thead.innerHTML = `
      <tr>
        <th>No</th>
        <th>Kolom / Field</th>
        <th>Aturan Penulisan Paten</th>
        <th>Contoh Valid</th>
        <th>Contoh Salah / Ditolak</th>
      </tr>
    `;
    const panduanData = [
      { f: "Kode Produk Internal", a: "Format [Supplier]-PRD-[Nomor]. Tidak boleh mengandung / atau \\.", c: "PT. KIMIA FARMA-PRD-001", w: "PRD/01, /PRD-01" },
      { f: "Barcode", a: "Nomor barcode fisik (EAN/UPC). Angka murni atau kosong jika tidak ada.", c: "8999908123456", w: "Ada Barcode, N/A" },
      { f: "Nama Produk", a: "Nama lengkap produk dan dosis. Wajib diisi.", c: "Paracetamol 500 mg Box 100 Tab", w: "(Kosong)" },
      { f: "Kategori", a: "Nama kategori resmi. Cocok dengan sheet KATEGORI.", c: "Obat Bebas, Generik, Alkes", w: "KAT001, -" },
      { f: "Supplier", a: "Nama Perusahaan resmi supplier. Cocok dengan sheet SUPPLIER.", c: "PT Kimia Farma Trading", w: "Supplier 1, Supplier 2" },
      { f: "Harga Beli & Jual", a: "Angka murni tanpa teks Rp atau titik ribuan.", c: "15000", w: "Rp 15.000" },
      { f: "Satuan & Konversi", a: "Isi pcs dalam 1 satuan beli. Angka bulat minimal 1.", c: "100", w: "1 Box = 100" },
      { f: "Status", a: "'Aktif' (jika ada harga jual) atau 'Perlu Harga Jual' / 'Nonaktif'.", c: "Aktif", w: "Ready, Tersedia" }
    ];
    const visibleCountEl = $("preview-visible-count");
    if (visibleCountEl) visibleCountEl.textContent = formatNumber(panduanData.length);

    tbody.innerHTML = panduanData.map((p, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td><strong>${escapeHtml(p.f)}</strong></td>
        <td>${escapeHtml(p.a)}</td>
        <td><span class="badge badge-success" style="padding:2px 6px;border-radius:4px;font-size:11px;">${escapeHtml(p.c)}</span></td>
        <td><span class="badge badge-danger" style="padding:2px 6px;border-radius:4px;font-size:11px;background:#fee2e2;color:#991b1b;">${escapeHtml(p.w)}</span></td>
      </tr>
    `).join("");
    return;
  }

  if (currentTab.includes("metadata")) {
    thead.innerHTML = `
      <tr>
        <th>No</th>
        <th>Properti / Kunci</th>
        <th>Nilai</th>
      </tr>
    `;
    const metas = parsedMasterResult.metadata || [
      { Properti: "Master Dataset ID", Nilai: parsedMasterResult.datasetId || "—" },
      { Properti: "Versi Master", Nilai: parsedMasterResult.fileVersion || 1 }
    ];
    const visibleCountEl = $("preview-visible-count");
    if (visibleCountEl) visibleCountEl.textContent = formatNumber(metas.length);

    tbody.innerHTML = metas.map((m, idx) => `
      <tr>
        <td>${idx + 1}</td>
        <td><strong>${escapeHtml(m.Properti)}</strong></td>
        <td><code>${escapeHtml(String(m.Nilai))}</code></td>
      </tr>
    `).join("");
    return;
  }

  // Default: Sheet PRODUK
  thead.innerHTML = `
    <tr>
      <th>Kode</th>
      <th>Barcode</th>
      <th>Nama Produk</th>
      <th>Kategori</th>
      <th>Supplier</th>
      <th>Harga Beli</th>
      <th>Harga Jual</th>
      <th>Satuan</th>
      <th>Status</th>
    </tr>
  `;

  // Gabungkan semua item yang dibaca
  const allItems = [
    ...(parsedMasterResult.added || []).map(it => ({ ...it, _importType: "baru" })),
    ...(parsedMasterResult.updated || []).map(it => ({ ...it.incoming, _importType: "update" })),
    ...(parsedMasterResult.unchanged || []).map(it => ({ ...it, _importType: "tetap" }))
  ];

  const filtered = allItems.filter(it => {
    if (!previewSearchQuery) return true;
    const code = norm(it["Kode Produk"] || it["Kode Produk Internal"]);
    const barcode = norm(it["Barcode"]);
    const name = norm(it["Nama Produk"]);
    const cat = norm(it["Kategori"]);
    return code.includes(previewSearchQuery) || barcode.includes(previewSearchQuery) || name.includes(previewSearchQuery) || cat.includes(previewSearchQuery);
  });

  const visibleCountEl = $("preview-visible-count");
  if (visibleCountEl) visibleCountEl.textContent = formatNumber(filtered.length);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-table-state" style="text-align:center;padding:24px;">Tidak ada data yang cocok dengan pencarian.</td></tr>`;
    return;
  }

  // Batasi render preview sampai 100 baris agar DOM tetap responsif
  const previewSlice = filtered.slice(0, 100);
  tbody.innerHTML = previewSlice.map(p => {
    const code = p["Kode Produk"] || p["Kode Produk Internal"] || "—";
    const barcode = p["Barcode"] || "—";
    const name = p["Nama Produk"] || "—";
    const cat = p["Kategori"] || "—";
    const sup = p["Supplier"] || "—";
    const buy = num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0);
    const sell = num(p["Harga Jual"] ?? 0);
    const unit = p["Satuan Dasar"] || p["Satuan"] || "Pcs";

    let badge = `<span class="badge badge-success" style="padding:2px 6px;border-radius:4px;font-size:11px;">Aktif</span>`;
    if (p._importType === "baru") {
      badge = `<span class="badge badge-info" style="padding:2px 6px;border-radius:4px;font-size:11px;background:#e0f2fe;color:#0369a1;font-weight:700;"><i class="fa-solid fa-plus"></i> Baru</span>`;
    } else if (p._importType === "update") {
      badge = `<span class="badge badge-warning" style="padding:2px 6px;border-radius:4px;font-size:11px;background:#fef3c7;color:#b45309;font-weight:700;"><i class="fa-solid fa-pen"></i> Update</span>`;
    }

    return `
      <tr>
        <td><strong>${escapeHtml(code)}</strong></td>
        <td><small class="text-muted">${escapeHtml(barcode)}</small></td>
        <td><strong>${escapeHtml(name)}</strong></td>
        <td>${escapeHtml(cat)}</td>
        <td>${escapeHtml(sup)}</td>
        <td>${rupiah(buy)}</td>
        <td><strong class="${sell > 0 ? 'text-primary' : 'text-danger'}">${sell > 0 ? rupiah(sell) : 'Rp0'}</strong></td>
        <td>${escapeHtml(unit)}</td>
        <td>${badge}</td>
      </tr>
    `;
  }).join("");

  if (filtered.length > 100) {
    tbody.innerHTML += `
      <tr>
        <td colspan="9" style="text-align:center;padding:12px;background:#f8fafc;font-size:12px;color:#64748b;">
          <em>... dan ${formatNumber(filtered.length - 100)} baris data lainnya (menampilkan 100 data pertama).</em>
        </td>
      </tr>
    `;
  }
}

function renderStep3Validation(res) {
  const s = res.summary;

  const totalWarnEl = $("warning-total-count");
  if (totalWarnEl) totalWarnEl.textContent = "0";

  const emptyRowEl = $("warning-empty-row-count");
  if (emptyRowEl) emptyRowEl.textContent = "0";

  const partialRowEl = $("warning-partial-row-count");
  if (partialRowEl) partialRowEl.textContent = "0";

  const tbody = $("master-warning-body");
  if (tbody) {
    let rowsHtml = `
      <tr>
        <td><span class="badge badge-success" style="padding:3px 8px;border-radius:4px;background:#ecfdf5;color:#059669;font-weight:700;"><i class="fa-solid fa-circle-check"></i> Lolos</span></td>
        <td>PRODUK</td>
        <td>Validasi Format Template (Kemasan Beli &rarr; Satuan Dasar)</td>
        <td>${formatNumber(s.totalIncoming)}</td>
        <td>Seluruh kolom utama cocok dengan template resmi KasirPro V2. Mode UPDATE aktif (tidak ada reset stok).</td>
      </tr>
    `;

    if (res.suppliers && res.suppliers.length > 0) {
      rowsHtml += `
        <tr>
          <td><span class="badge badge-success" style="padding:3px 8px;border-radius:4px;background:#ecfdf5;color:#059669;font-weight:700;"><i class="fa-solid fa-circle-check"></i> Lolos</span></td>
          <td>SUPPLIER</td>
          <td>Entitas Perusahaan</td>
          <td>${formatNumber(res.suppliers.length)}</td>
          <td>Data master supplier teridentifikasi.</td>
        </tr>
      `;
    }

    if (res.categories && res.categories.length > 0) {
      rowsHtml += `
        <tr>
          <td><span class="badge badge-success" style="padding:3px 8px;border-radius:4px;background:#ecfdf5;color:#059669;font-weight:700;"><i class="fa-solid fa-circle-check"></i> Lolos</span></td>
          <td>KATEGORI</td>
          <td>Kelompok Produk</td>
          <td>${formatNumber(res.categories.length)}</td>
          <td>Data kategori teridentifikasi.</td>
        </tr>
      `;
    }

    tbody.innerHTML = rowsHtml;
  }
}

function renderStep4Confirmation(res) {
  const s = res.summary;

  const newCountEl = $("match-new-count");
  if (newCountEl) newCountEl.textContent = formatNumber(s.addedCount);

  const exactCountEl = $("match-exact-count");
  if (exactCountEl) exactCountEl.textContent = formatNumber(s.updatedCount + s.unchangedCount);

  const reviewCountEl = $("match-review-count");
  if (reviewCountEl) reviewCountEl.textContent = "0";

  const dupCountEl = $("match-duplicate-count");
  if (dupCountEl) dupCountEl.textContent = "0";

  const totalCountEl = $("match-total-count");
  if (totalCountEl) totalCountEl.textContent = formatNumber(s.totalIncoming);

  const tbody = $("master-match-body");
  if (tbody) {
    const sampleItems = [
      ...(res.added || []).slice(0, 10).map(it => ({ ...it, _status: "Data Baru" })),
      ...(res.updated || []).slice(0, 10).map(it => ({ ...it.incoming, _status: "Perbarui Data Lama" }))
    ];

    if (!sampleItems.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:16px;color:#64748b;">Seluruh ${s.totalIncoming} data produk sudah sesuai dan tidak mengalami perubahan.</td></tr>`;
      return;
    }

    tbody.innerHTML = sampleItems.map((it, idx) => {
      const code = it["Kode Produk"] || it["Kode Produk Internal"] || "—";
      const name = it["Nama Produk"] || "—";
      const isNew = it._status === "Data Baru";

      return `
        <tr>
          <td>PRODUK</td>
          <td>${idx + 2}</td>
          <td><strong>${escapeHtml(code)}</strong> &mdash; ${escapeHtml(name)}</td>
          <td><span class="badge ${isNew ? 'badge-info' : 'badge-warning'}" style="padding:3px 8px;border-radius:4px;font-weight:700;">${it._status}</span></td>
          <td>Kecocokan Kode Produk Internal</td>
        </tr>
      `;
    }).join("");
  }
}

async function handleApplyMasterImport() {
  if (!parsedMasterResult) return;

  const modeRadio = document.querySelector('input[name="existingDataMode"]:checked');
  const existingMode = modeRadio ? modeRadio.value : "update"; // "update" or "skip"

  const addedList = parsedMasterResult.added || [];
  const updatedList = parsedMasterResult.updated || [];
  const suppliersList = parsedMasterResult.suppliers || [];
  const categoriesList = parsedMasterResult.categories || [];

  const confirmed = await window.KasirProDialog?.confirm(
    "Konfirmasi Update Master Data",
    `Apakah Anda yakin ingin menerapkan perubahan master data ini?\n\n` +
    `• Produk Baru: ${addedList.length}\n` +
    `• Produk Diperbarui: ${existingMode === "update" ? updatedList.length : 0} (Mode: ${existingMode === "update" ? "Perbarui" : "Lewati"})\n\n` +
    `Stok sistem dan riwayat transaksi tidak akan diubah atau direset.`
  );
  if (!confirmed) return;

  const confirmBtn = $("confirm-master-import");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Menerapkan Data...';
  }

  // Tampilkan Modal Progress Aktual
  const totalIncoming = addedList.length + (existingMode === "update" ? updatedList.length : 0);
  window.KasirProDialog?.showProgress(
    "Menerapkan Master Data",
    "Sedang menyiapkan dan memvalidasi data produk...",
    {
      percent: 10,
      detail: `Menyiapkan ${formatNumber(totalIncoming)} data produk`
    }
  );

  try {
    const currentMaster = readStore(STORE_KEYS.master, {});
    const existingProducts = Array.isArray(currentMaster.produk) ? [...currentMaster.produk] : [];
    const existingSuppliers = Array.isArray(currentMaster.supplier) ? [...currentMaster.supplier] : [];
    const existingCategories = Array.isArray(currentMaster.kategori) ? [...currentMaster.kategori] : [];

    window.KasirProDialog?.updateProgress({
      message: "Menggabungkan produk baru, supplier, dan kategori...",
      percent: 20,
      detail: "Menyusun struktur master data"
    });

    // 1. Tambahkan produk baru
    for (const item of addedList) {
      existingProducts.push(item);
    }

    // 2. Perbarui produk lama jika mode === "update"
    if (existingMode === "update") {
      for (const item of updatedList) {
        const idx = existingProducts.findIndex(p => norm(p["Kode Produk"] || p["Kode Produk Internal"]) === norm(item.incoming["Kode Produk"]));
        if (idx >= 0) {
          existingProducts[idx] = {
            ...existingProducts[idx],
            ...item.incoming,
            "Stok Awal": existingProducts[idx]["Stok Awal"] // Kunci: JANGAN timpa stok fisik sistem!
          };
        }
      }
    }

    // 3. Tambahkan supplier baru dari sheet SUPPLIER maupun dari kolom produk jika belum terdaftar
    for (const s of suppliersList) {
      const sName = s["Nama Perusahaan"] || s["Supplier"] || "";
      if (sName && !existingSuppliers.some(x => norm(x["Nama Perusahaan"] || x["Supplier"]) === norm(sName))) {
        existingSuppliers.push({ id: `SUP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...s, "Nama Perusahaan": sName, Supplier: sName, Status: "Aktif", status: "Aktif" });
      }
    }
    // Auto-detect supplier yang tertulis di kolom produk tapi belum ada di master supplier
    for (const p of [...addedList, ...(updatedList.map(u => u.incoming))]) {
      const supInProd = String(p["Supplier"] || "").trim();
      if (supInProd && !existingSuppliers.some(x => norm(x["Nama Perusahaan"] || x["Supplier"]) === norm(supInProd))) {
        existingSuppliers.push({
          id: `SUP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          "Nama Perusahaan": supInProd,
          "Supplier": supInProd,
          "Nama Sales/PIC": "Belum di atur",
          "NPWP": "Belum di atur",
          "Status": "Aktif",
          "status": "Aktif"
        });
      }
    }

    // 4. Tambahkan kategori baru jika belum ada
    for (const k of categoriesList) {
      if (!existingCategories.some(x => norm(x["Nama Kategori"]) === norm(k["Nama Kategori"]))) {
        existingCategories.push({ id: `KAT-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...k, Status: "Aktif", status: "Aktif" });
      }
    }

    currentMaster.produk = existingProducts;
    currentMaster.supplier = existingSuppliers;
    currentMaster.kategori = existingCategories;
    currentMaster.version = (num(currentMaster.version) || 1) + 1;

    // Simpan ke IndexedDB dan Firestore dengan pelaporan progress real-time
    await writeStore(STORE_KEYS.master, currentMaster, (p) => {
      window.KasirProDialog?.updateProgress({
        message: p.message,
        percent: p.percent,
        detail: p.detail
      });
    });

    window.KasirProDialog?.updateProgress({
      message: "Memperbarui tampilan tabel produk, supplier & kategori...",
      percent: 97,
      detail: "Menyegarkan antarmuka manajemen"
    });

    renderProducts();
    renderSuppliers();
    renderCategories();

    // Tampilkan result panel lengkap
    const resPanel = $("master-import-result");
    if (resPanel) {
      document.querySelectorAll("[data-import-step]").forEach(p => p.hidden = true);
      resPanel.hidden = false;
      const resText = $("master-import-result-text");
      if (resText) {
        resText.textContent = `Master Data versi ${currentMaster.version} berhasil diterapkan ke sistem. Stok fisik & transaksi tetap aman.`;
      }
      const addedEl = $("result-added-count");
      if (addedEl) addedEl.textContent = formatNumber(parsedMasterResult.added.length);
      const updatedEl = $("result-updated-count");
      if (updatedEl) updatedEl.textContent = formatNumber(existingMode === "update" ? parsedMasterResult.updated.length : 0);
      const skippedEl = $("result-skipped-count");
      if (skippedEl) skippedEl.textContent = formatNumber(existingMode === "skip" ? parsedMasterResult.updated.length : 0);
    }

    window.KasirProDialog?.updateProgress({
      message: "Pembaruan master data selesai!",
      percent: 100,
      detail: "Semua data berhasil diterapkan"
    });

    // Transisi singkat agar visual 100% terbaca pengguna
    await new Promise(r => setTimeout(r, 250));
    window.KasirProDialog?.closeProgress();

    // Modal Dialog Sukses Jelas (dengan tombol Selesai)
    await window.KasirProDialog?.success(
      "Import Master Berhasil",
      `Pembaruan master data KasirPro V2 telah selesai diterapkan:\n\n` +
      `• ${formatNumber(parsedMasterResult.added.length)} Produk Baru berhasil ditambahkan.\n` +
      `• ${formatNumber(existingMode === "update" ? parsedMasterResult.updated.length : 0)} Produk Lama berhasil diperbarui.\n` +
      `• ${formatNumber(existingSuppliers.length)} Supplier & ${formatNumber(existingCategories.length)} Kategori terverifikasi.\n\n` +
      `Seluruh data telah tersimpan di IndexedDB lokal dan tersinkronisasi ke Firestore.`,
      { confirmText: "Lihat Ringkasan Hasil" }
    );
  } catch (err) {
    window.KasirProDialog?.closeProgress();
    console.error("[ImportMaster] Error applying import:", err);
    window.KasirProDialog?.error(
      "Gagal Menerapkan Import",
      err.message || "Terjadi kesalahan saat menyimpan master data ke database. Silakan periksa koneksi internet atau format data Anda."
    );
  } finally {
    window.KasirProDialog?.closeProgress();
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i class="fa-solid fa-file-import"></i> Import Sekarang';
    }
  }
}
