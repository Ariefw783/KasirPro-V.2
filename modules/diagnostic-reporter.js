/**
 * KasirPro Diagnostic & Issue Reporter Engine
 * Merekam error runtime, metadata lingkungan (device, viewport, PWA, role),
 * mengaitkan file sumber terkait, dan mengekspor prompt siap-pakai untuk AI IDE / Antigravity.
 */

const STORAGE_KEY = "kasirpro_diagnostic_reports_v1";
const APP_VERSION = "v2.2.5";
const MAX_ERROR_LOGS = 15;

// Buffer error in-memory
const errorLogBuffer = [];

// Intersep Global Error
window.addEventListener("error", (event) => {
  try {
    const errObj = {
      time: new Date().toLocaleTimeString("id-ID"),
      message: event.message || "Unknown error",
      filename: event.filename || "inline/external script",
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error?.stack || null
    };
    errorLogBuffer.unshift(`[ERROR ${errObj.time}] ${errObj.message} at ${errObj.filename}:${errObj.lineno}:${errObj.colno}${errObj.stack ? `\nStack:\n${errObj.stack}` : ""}`);
    if (errorLogBuffer.length > MAX_ERROR_LOGS) errorLogBuffer.pop();
    DiagnosticReporter.updateBadgeCounter();
  } catch (_) {}
});

// Intersep Unhandled Promise Rejections
window.addEventListener("unhandledrejection", (event) => {
  try {
    const reason = event.reason;
    const errText = typeof reason === "object" ? (reason?.stack || reason?.message || JSON.stringify(reason)) : String(reason);
    errorLogBuffer.unshift(`[UNHANDLED REJECTION ${new Date().toLocaleTimeString("id-ID")}] ${errText}`);
    if (errorLogBuffer.length > MAX_ERROR_LOGS) errorLogBuffer.pop();
    DiagnosticReporter.updateBadgeCounter();
  } catch (_) {}
});

// Intersep console.error secara aman
const originalConsoleError = console.error;
console.error = function (...args) {
  try {
    const formatted = args.map(a => (typeof a === "object" ? (a?.stack || a?.message || JSON.stringify(a)) : String(a))).join(" ");
    errorLogBuffer.unshift(`[CONSOLE.ERROR ${new Date().toLocaleTimeString("id-ID")}] ${formatted}`);
    if (errorLogBuffer.length > MAX_ERROR_LOGS) errorLogBuffer.pop();
    DiagnosticReporter.updateBadgeCounter();
  } catch (_) {}
  originalConsoleError.apply(console, args);
};

export const DiagnosticReporter = {
  version: APP_VERSION,

  /**
   * Mengambil riwayat laporan dari LocalStorage
   */
  getReports() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch (_) {
      return [];
    }
  },

  /**
   * Menyimpan satu laporan baru
   */
  saveReport(reportData) {
    const list = this.getReports();
    list.unshift(reportData);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    this.updateBadgeCounter();
    return reportData;
  },

  /**
   * Menghapus laporan berdasarkan ID
   */
  deleteReport(id) {
    let list = this.getReports();
    list = list.filter(r => r.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    this.updateBadgeCounter();
    return list;
  },

  /**
   * Menghapus semua riwayat laporan
   */
  clearAllReports() {
    localStorage.removeItem(STORAGE_KEY);
    this.updateBadgeCounter();
  },

  /**
   * Menganalisis lingkungan sistem klien saat ini
   */
  captureContext() {
    const isPOS = window.location.pathname.includes("/pos/") || document.querySelector(".retail-pos") !== null;
    let pageTitle = "Halaman Tidak Diketahui";
    let activeView = "general";
    let sourceFiles = [];

    if (isPOS) {
      pageTitle = "POS Retail (Transaksi Penjualan)";
      activeView = "pos-cashier";
      sourceFiles = [
        "pos/pos-at07-core.js",
        "pos/pos.js",
        "modules/database/database-store.js",
        "modules/database/database-paths.js",
        "pos/pos.css"
      ];
    } else {
      // Manajemen
      const activeNav = document.querySelector(".nav-item.is-active");
      activeView = activeNav?.dataset?.view || "dashboard";
      const viewTitleMap = {
        "dashboard": "Dashboard Operasional",
        "products": "Manajemen Produk & Harga Bertingkat",
        "purchases": "Faktur Pembelian & Kasir Faktur Fisik",
        "stock": "Inventori & Mutasi Stok",
        "stock-opname": "Stock Opname & Rekonsiliasi",
        "reports": "Laporan Keuangan & Penjualan",
        "users": "Manajemen Pengguna & Hak Akses",
        "settings": "Pengaturan Sistem & Data Store"
      };
      pageTitle = viewTitleMap[activeView] || `Manajemen (${activeView})`;

      const fileMap = {
        "products": ["modules/management/products-module.js", "modules/database/database-store.js", "modules/local/indexeddb-store.js"],
        "purchases": ["modules/management/purchases-module.js", "modules/database/database-store.js", "modules/local/indexeddb-store.js"],
        "stock": ["modules/management/stock-module.js", "modules/database/database-store.js"],
        "stock-opname": ["modules/management/stock-opname-module.js", "modules/database/database-store.js"],
        "reports": ["modules/management/reports-module.js", "modules/database/database-store.js"],
        "users": ["modules/management/users-module.js", "modules/database/database-store.js"],
        "settings": ["modules/management/settings-module.js", "modules/database/database-store.js"],
        "dashboard": ["management/management.js", "modules/database/database-store.js"]
      };
      sourceFiles = fileMap[activeView] || ["management/management.js", "modules/database/database-store.js"];
    }

    // Informasi Sesi
    let sessionUser = "Tidak teridentifikasi";
    let sessionRole = "Unknown";
    try {
      const sessRaw = localStorage.getItem("kasirpro_session_v1") || sessionStorage.getItem("kasirpro_session_v1");
      if (sessRaw) {
        const s = JSON.parse(sessRaw);
        sessionUser = s.name || s.username || "Pengguna";
        sessionRole = s.role || "Kasir";
      }
    } catch (_) {}

    const isPwa = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

    return {
      pageTitle,
      activeView,
      pageUrl: window.location.href,
      sourceFiles,
      environment: {
        appVersion: APP_VERSION,
        viewport: `${window.innerWidth}x${window.innerHeight} px`,
        screen: `${window.screen?.width || 0}x${window.screen?.height || 0} px`,
        dpr: window.devicePixelRatio || 1,
        orientation: (window.screen?.orientation?.type || (window.innerWidth > window.innerHeight ? "landscape" : "portrait")),
        displayMode: isPwa ? "PWA Standalone (Installed App)" : "Web Browser Window",
        network: navigator.onLine ? "Online (Tersambung)" : "Offline (Terputus)",
        user: sessionUser,
        role: sessionRole,
        userAgent: navigator.userAgent
      },
      errorLogs: [...errorLogBuffer]
    };
  },

  /**
   * Menghasilkan teks AI Prompt terstruktur siap pakai untuk Antigravity / AI IDE
   */
  generateAiPrompt(report) {
    const timestampWIB = new Date(report.timestamp).toLocaleString("id-ID", {
      dateStyle: "full",
      timeStyle: "medium"
    });

    const fileListMd = (report.sourceFiles || []).map(f => `- \`${f}\``).join("\n");
    const errorsText = (report.errorLogs && report.errorLogs.length > 0)
      ? report.errorLogs.join("\n\n")
      : "Tidak ada exception console runtime yang tertangkap saat issue dilaporkan.";

    return `# 🛠️ [LAPORAN KENDALA KASIRPRO - DIAGNOSTIK AI]

## 1. Ringkasan Pengguna
- **Waktu Kejadian**: ${timestampWIB}
- **Halaman / Menu Aktif**: ${report.pageTitle} (\`${report.activeView}\`)
- **URL**: \`${report.pageUrl}\`
- **Kategori Masalah**: ${report.category}
- **Deskripsi Kendala dari Pengguna**:
> ${report.userNotes.replace(/\n/g, "\n> ")}

---

## 2. Lingkungan Klien (Client Environment)
- **Versi Aplikasi**: ${report.environment.appVersion}
- **Ukuran Layar (Viewport)**: ${report.environment.viewport} (Resolusi Layar: ${report.environment.screen}, DPR: ${report.environment.dpr})
- **Orientasi Layar**: ${report.environment.orientation}
- **Mode Aplikasi**: ${report.environment.displayMode}
- **Status Jaringan**: ${report.environment.network}
- **Sesi Pengguna**: ${report.environment.user} (Role: ${report.environment.role})
- **Browser User-Agent**: \`${report.environment.userAgent}\`

---

## 3. Berkas Kode Sumber Terkait (Related Source Files)
${fileListMd}

---

## 4. Log Konsol & Stack Trace Terakhir
\`\`\`
${errorsText}
\`\`\`

---

## 5. Instruksi untuk AI Assistant (Antigravity)
Harap telusuri penyebab akar (root cause) dari kendala di atas berdasarkan konteks file sumber terkait, spesifikasi tampilan perangkat, dan log error yang tercatat. Lakukan perbaikan kode pada file tersebut dengan mematuhi prinsip arsitektur KasirPro, pastikan tampilan tetap responsif di ponsel/desktop, dan pertahankan keutuhan database.`;
  },

  /**
   * Mengunduh laporan dalam file .txt
   */
  downloadReportTxt(report) {
    const content = this.generateAiPrompt(report);
    const dateStr = new Date(report.timestamp).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `KasirPro_Diagnostic_${report.activeView}_${dateStr}.txt`;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  /**
   * Menyalin teks ke clipboard dengan toast notifikasi
   */
  async copyAiPrompt(report) {
    const text = this.generateAiPrompt(report);
    try {
      await navigator.clipboard.writeText(text);
      this.showToast("Format AI berhasil disalin! Siap di-paste ke Antigravity");
      return true;
    } catch (_) {
      // Fallback manual input
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      this.showToast("Format AI berhasil disalin ke clipboard!");
      return true;
    }
  },

  /**
   * Menampilkan toast feedback visual
   */
  showToast(message) {
    let toast = document.getElementById("kp-diag-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "kp-diag-toast";
      toast.className = "kp-diag-toast";
      document.body.appendChild(toast);
    }
    toast.innerHTML = `<i class="fa-solid fa-circle-check" style="color:#22c55e;"></i> <span>${message}</span>`;
    toast.style.display = "flex";
    clearTimeout(this._toastTimeout);
    this._toastTimeout = setTimeout(() => {
      toast.style.display = "none";
    }, 3500);
  },

  /**
   * Perbarui badge counter pada tombol bug di header
   */
  updateBadgeCounter() {
    const reports = this.getReports();
    const count = reports.length;
    const badgeElements = document.querySelectorAll(".kp-report-badge");
    badgeElements.forEach(b => {
      if (count > 0 || errorLogBuffer.length > 0) {
        b.style.display = "inline-block";
        b.textContent = count > 0 ? count : "!";
      } else {
        b.style.display = "none";
      }
    });
  },

  /**
   * Buka Modal Pelaporan
   */
  openModal(preselectedCategory = "Error Transaksi / POS") {
    this.renderModal();
    const backdrop = document.getElementById("kp-diag-backdrop");
    if (backdrop) {
      backdrop.classList.add("kp-open");
      this.switchTab("new");
      if (preselectedCategory) {
        const catSelect = document.getElementById("kp-diag-category");
        if (catSelect) catSelect.value = preselectedCategory;
      }
      this.refreshNewReportForm();
    }
  },

  /**
   * Tutup Modal
   */
  closeModal() {
    const backdrop = document.getElementById("kp-diag-backdrop");
    if (backdrop) backdrop.classList.remove("kp-open");
  },

  /**
   * Render atau Perbarui Struktur Modal di DOM
   */
  renderModal() {
    if (document.getElementById("kp-diag-backdrop")) return;

    const html = `
      <div id="kp-diag-backdrop" class="kp-diag-backdrop">
        <div class="kp-diag-modal" role="dialog" aria-labelledby="kp-diag-modal-title">
          
          <div class="kp-diag-header">
            <div class="kp-diag-header-title">
              <i class="fa-solid fa-stethoscope"></i>
              <span id="kp-diag-modal-title">Pusat Laporan & Diagnostik Sistem</span>
            </div>
            <button type="button" class="kp-diag-close-btn" id="kp-diag-close-top" title="Tutup">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>

          <div class="kp-diag-tabs">
            <button type="button" class="kp-diag-tab-btn active" id="kp-tab-new-btn">
              <i class="fa-solid fa-pen-to-square"></i> Buat Laporan Baru
            </button>
            <button type="button" class="kp-diag-tab-btn" id="kp-tab-history-btn">
              <i class="fa-solid fa-list-check"></i> Riwayat Laporan
              <span class="kp-diag-tab-badge" id="kp-tab-history-count">0</span>
            </button>
          </div>

          <!-- TAB 1: FORM BUAT LAPORAN BARU -->
          <div class="kp-diag-body" id="kp-tab-new-content">
            <div id="kp-diag-context-banner" class="kp-diag-context-banner">
              <i class="fa-solid fa-circle-info"></i>
              <div>
                <strong id="kp-diag-banner-title">Menganalisis status sistem...</strong>
                <div id="kp-diag-banner-meta" class="kp-diag-context-meta"></div>
              </div>
            </div>

            <div class="kp-diag-field">
              <label class="kp-diag-label" for="kp-diag-category">Kategori Kendala</label>
              <select id="kp-diag-category" class="kp-diag-select">
                <option value="Error Transaksi / Pembayaran">Error Transaksi / Pembayaran</option>
                <option value="Tampilan / Responsivitas Layar">Tampilan / Responsivitas Layar</option>
                <option value="Kalkulasi Stok / Faktur">Kalkulasi Stok / Faktur</option>
                <option value="Sinkronisasi Database / Cloud">Sinkronisasi Database / Cloud</option>
                <option value="Lainnya">Lainnya</option>
              </select>
            </div>

            <div class="kp-diag-field">
              <label class="kp-diag-label" for="kp-diag-notes">Jelaskan Kendala yang Terjadi</label>
              <textarea id="kp-diag-notes" class="kp-diag-textarea" placeholder="Contoh: Saat saya menekan tombol Konfirmasi Bayar, muncul error..."></textarea>
            </div>

            <div style="font-size:0.8rem; color:#64748b; display:flex; align-items:center; gap:6px;">
              <i class="fa-solid fa-shield-halved" style="color:#0284c7;"></i>
              Metadata teknis (viewport layar, file sumber terkait, log error) akan otomatis dilampirkan.
            </div>
          </div>

          <!-- TAB 2: RIWAYAT LAPORAN & EXPORT -->
          <div class="kp-diag-body" id="kp-tab-history-content" style="display:none;">
            <div id="kp-diag-history-list" class="kp-diag-list"></div>
          </div>

          <div class="kp-diag-footer">
            <div id="kp-footer-new-actions" style="display:flex; gap:10px; width:100%; justify-content:space-between; align-items:center;">
              <button type="button" class="kp-diag-btn kp-diag-btn-secondary" id="kp-btn-view-history">
                <i class="fa-solid fa-folder-open"></i> Lihat Riwayat (<span id="kp-btn-history-count">0</span>)
              </button>
              <div style="display:flex; gap:8px;">
                <button type="button" class="kp-diag-btn kp-diag-btn-secondary" id="kp-btn-cancel-modal">Batal</button>
                <button type="button" class="kp-diag-btn kp-diag-btn-primary" id="kp-btn-submit-report">
                  <i class="fa-solid fa-paper-plane"></i> Simpan Laporan
                </button>
              </div>
            </div>

            <div id="kp-footer-history-actions" style="display:none; gap:10px; width:100%; justify-content:space-between; align-items:center;">
              <button type="button" class="kp-diag-btn kp-diag-btn-danger" id="kp-btn-clear-all">
                <i class="fa-solid fa-trash-can"></i> Hapus Semua Laporan
              </button>
              <button type="button" class="kp-diag-btn kp-diag-btn-primary" id="kp-btn-back-to-new">
                <i class="fa-solid fa-plus"></i> Buat Laporan Baru
              </button>
            </div>
          </div>

        </div>
      </div>
    `;

    document.body.insertAdjacentHTML("beforeend", html);
    this.attachModalEvents();
  },

  /**
   * Pasang Event Listener untuk Modal
   */
  attachModalEvents() {
    const backdrop = document.getElementById("kp-diag-backdrop");
    const closeBtn = document.getElementById("kp-diag-close-top");
    const cancelBtn = document.getElementById("kp-btn-cancel-modal");
    const tabNewBtn = document.getElementById("kp-tab-new-btn");
    const tabHistoryBtn = document.getElementById("kp-tab-history-btn");
    const submitBtn = document.getElementById("kp-btn-submit-report");
    const viewHistoryBtn = document.getElementById("kp-btn-view-history");
    const backToNewBtn = document.getElementById("kp-btn-back-to-new");
    const clearAllBtn = document.getElementById("kp-btn-clear-all");

    closeBtn?.addEventListener("click", () => this.closeModal());
    cancelBtn?.addEventListener("click", () => this.closeModal());

    backdrop?.addEventListener("click", (e) => {
      if (e.target === backdrop) this.closeModal();
    });

    tabNewBtn?.addEventListener("click", () => this.switchTab("new"));
    tabHistoryBtn?.addEventListener("click", () => this.switchTab("history"));
    viewHistoryBtn?.addEventListener("click", () => this.switchTab("history"));
    backToNewBtn?.addEventListener("click", () => this.switchTab("new"));

    clearAllBtn?.addEventListener("click", () => {
      if (confirm("Apakah Anda yakin ingin menghapus semua riwayat laporan?")) {
        this.clearAllReports();
        this.renderHistoryList();
      }
    });

    submitBtn?.addEventListener("click", () => this.handleSubmitReport());
  },

  /**
   * Beralih Tab Modal (new / history)
   */
  switchTab(tab) {
    const tabNewBtn = document.getElementById("kp-tab-new-btn");
    const tabHistoryBtn = document.getElementById("kp-tab-history-btn");
    const contentNew = document.getElementById("kp-tab-new-content");
    const contentHistory = document.getElementById("kp-tab-history-content");
    const footerNew = document.getElementById("kp-footer-new-actions");
    const footerHistory = document.getElementById("kp-footer-history-actions");

    if (tab === "new") {
      tabNewBtn?.classList.add("active");
      tabHistoryBtn?.classList.remove("active");
      if (contentNew) contentNew.style.display = "flex";
      if (contentHistory) contentHistory.style.display = "none";
      if (footerNew) footerNew.style.display = "flex";
      if (footerHistory) footerHistory.style.display = "none";
      this.refreshNewReportForm();
    } else {
      tabNewBtn?.classList.remove("active");
      tabHistoryBtn?.classList.add("active");
      if (contentNew) contentNew.style.display = "none";
      if (contentHistory) contentHistory.style.display = "flex";
      if (footerNew) footerNew.style.display = "none";
      if (footerHistory) footerHistory.style.display = "flex";
      this.renderHistoryList();
    }
  },

  /**
   * Refresh Form Baru & Informasi Banner Diagnostik
   */
  refreshNewReportForm() {
    const ctx = this.captureContext();
    const banner = document.getElementById("kp-diag-context-banner");
    const bannerTitle = document.getElementById("kp-diag-banner-title");
    const bannerMeta = document.getElementById("kp-diag-banner-meta");
    const historyCount1 = document.getElementById("kp-tab-history-count");
    const historyCount2 = document.getElementById("kp-btn-history-count");

    const reports = this.getReports();
    if (historyCount1) historyCount1.textContent = reports.length;
    if (historyCount2) historyCount2.textContent = reports.length;

    const hasErrors = ctx.errorLogs && ctx.errorLogs.length > 0;
    if (banner) {
      if (hasErrors) {
        banner.className = "kp-diag-context-banner has-errors";
        banner.querySelector("i").className = "fa-solid fa-triangle-exclamation";
        bannerTitle.textContent = `Terdeteksi ${ctx.errorLogs.length} runtime error di console:`;
      } else {
        banner.className = "kp-diag-context-banner";
        banner.querySelector("i").className = "fa-solid fa-circle-check";
        bannerTitle.textContent = `Sistem berjalan normal pada ${ctx.pageTitle}`;
      }
    }

    if (bannerMeta) {
      bannerMeta.innerHTML = `
        <span><i class="fa-solid fa-display"></i> ${ctx.environment.viewport}</span>
        <span><i class="fa-solid fa-mobile-screen"></i> ${ctx.environment.displayMode}</span>
        <span><i class="fa-solid fa-code"></i> ${ctx.sourceFiles[0] || ""}</span>
      `;
    }
  },

  /**
   * Submit Laporan Baru
   */
  handleSubmitReport() {
    const notesElem = document.getElementById("kp-diag-notes");
    const catElem = document.getElementById("kp-diag-category");
    const userNotes = notesElem?.value?.trim() || "";

    if (!userNotes) {
      alert("Silakan tuliskan penjelasan kendala yang terjadi.");
      notesElem?.focus();
      return;
    }

    const ctx = this.captureContext();
    const newReport = {
      id: `RPT-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      category: catElem?.value || "Lainnya",
      userNotes,
      pageTitle: ctx.pageTitle,
      activeView: ctx.activeView,
      pageUrl: ctx.pageUrl,
      sourceFiles: ctx.sourceFiles,
      environment: ctx.environment,
      errorLogs: ctx.errorLogs
    };

    this.saveReport(newReport);
    if (notesElem) notesElem.value = "";
    this.showToast("Laporan kendala berhasil disimpan!");
    this.switchTab("history");
  },

  /**
   * Render Daftar Riwayat Laporan
   */
  renderHistoryList() {
    const container = document.getElementById("kp-diag-history-list");
    const historyCount1 = document.getElementById("kp-tab-history-count");
    const historyCount2 = document.getElementById("kp-btn-history-count");
    if (!container) return;

    const reports = this.getReports();
    if (historyCount1) historyCount1.textContent = reports.length;
    if (historyCount2) historyCount2.textContent = reports.length;

    if (!reports.length) {
      container.innerHTML = `
        <div class="kp-diag-empty">
          <i class="fa-regular fa-clipboard"></i>
          <p>Belum ada laporan kendala yang tersimpan.</p>
          <button type="button" class="kp-diag-btn kp-diag-btn-primary" style="margin-top:10px;" id="kp-btn-empty-create">
            <i class="fa-solid fa-plus"></i> Tulis Laporan Baru
          </button>
        </div>
      `;
      document.getElementById("kp-btn-empty-create")?.addEventListener("click", () => this.switchTab("new"));
      return;
    }

    let cardsHtml = "";
    reports.forEach((rpt) => {
      const timeStr = new Date(rpt.timestamp).toLocaleString("id-ID", {
        dateStyle: "medium",
        timeStyle: "short"
      });
      const hasErrors = rpt.errorLogs && rpt.errorLogs.length > 0;

      cardsHtml += `
        <div class="kp-diag-card" data-id="${rpt.id}">
          <div class="kp-diag-card-head">
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="kp-diag-badge-category">${rpt.category}</span>
              <strong>${rpt.pageTitle}</strong>
            </div>
            <span class="kp-diag-time"><i class="fa-regular fa-clock"></i> ${timeStr}</span>
          </div>

          <div class="kp-diag-notes">
            "${rpt.userNotes}"
          </div>

          <div class="kp-diag-meta-strip">
            <span><i class="fa-solid fa-display"></i> ${rpt.environment?.viewport || ""}</span>
            <span><i class="fa-solid fa-network-wired"></i> ${rpt.environment?.network || ""}</span>
            <span><i class="fa-solid fa-bug"></i> ${hasErrors ? `${rpt.errorLogs.length} error logged` : "0 error"}</span>
          </div>

          <div class="kp-diag-card-actions">
            <button type="button" class="kp-diag-btn kp-diag-btn-ai kp-btn-copy-ai" data-id="${rpt.id}">
              <i class="fa-solid fa-wand-magic-sparkles"></i> Salin Format AI (Prompt)
            </button>
            <button type="button" class="kp-diag-btn kp-diag-btn-secondary kp-btn-download-txt" data-id="${rpt.id}">
              <i class="fa-solid fa-download"></i> Unduh (.txt)
            </button>
            <button type="button" class="kp-diag-btn kp-diag-btn-danger kp-btn-delete-report" data-id="${rpt.id}">
              <i class="fa-solid fa-trash-can"></i> Hapus
            </button>
          </div>
        </div>
      `;
    });

    container.innerHTML = cardsHtml;

    // Attach Action Listeners
    container.querySelectorAll(".kp-btn-copy-ai").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const rpt = reports.find(r => r.id === id);
        if (rpt) this.copyAiPrompt(rpt);
      });
    });

    container.querySelectorAll(".kp-btn-download-txt").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const rpt = reports.find(r => r.id === id);
        if (rpt) this.downloadReportTxt(rpt);
      });
    });

    container.querySelectorAll(".kp-btn-delete-report").forEach(btn => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        this.deleteReport(id);
        this.renderHistoryList();
      });
    });
  },

  /**
   * Inisialisasi Reporter Engine pada Halaman
   */
  init() {
    this.renderModal();
    this.updateBadgeCounter();

    // Listener otomatis untuk tombol trigger di header
    document.querySelectorAll(".kp-report-trigger-btn").forEach(btn => {
      btn.addEventListener("click", () => this.openModal());
    });
  }
};

// Auto-init saat DOM Content Loaded
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => DiagnosticReporter.init());
} else {
  DiagnosticReporter.init();
}

// Pasang ke window object untuk akses global
window.DiagnosticReporter = DiagnosticReporter;
