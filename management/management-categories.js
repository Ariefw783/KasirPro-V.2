/**
 * management/management-categories.js
 * Manajemen Master Kategori KasirPro V2
 * 
 * Sesuai Spesifikasi:
 * - Kategori menyediakan: Daftar Kategori, Tambah, Edit, Hapus, dan Cari.
 */

import { $, num, text, norm, escapeHtml } from "../modules/core/utils.js";
import { STORE_KEYS, readStore, writeStore, writeMasterDelta } from "../modules/database/database-store.js";

const PAGE_SIZE = 25;
let currentPage = 1;
let currentCategories = [];
let filteredCategories = [];
let activeEditingCategory = null;

export function initCategoriesModule() {
  bindEvents();
  renderCategories();
}

function bindEvents() {
  $("category-search")?.addEventListener("input", () => {
    currentPage = 1;
    applyFilters();
  });

  $("category-status-filter")?.addEventListener("change", () => {
    currentPage = 1;
    applyFilters();
  });

  $("refresh-categories")?.addEventListener("click", () => {
    renderCategories();
    window.KasirProDialog?.success("Berhasil", "Data kategori berhasil disegarkan.");
  });

  $("categories-prev-page")?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      renderTable();
    }
  });

  $("categories-next-page")?.addEventListener("click", () => {
    const totalPages = Math.ceil(filteredCategories.length / PAGE_SIZE) || 1;
    if (currentPage < totalPages) {
      currentPage++;
      renderTable();
    }
  });

  // Tombol Tambah Kategori di header
  const headerActions = document.querySelector('[data-view-section="categories"] .module-header-actions');
  if (headerActions && !$("btn-add-category")) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.id = "btn-add-category";
    addBtn.className = "button button-primary";
    addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Tambah Kategori';
    addBtn.addEventListener("click", () => openCategoryModal(null));
    headerActions.prepend(addBtn);
  }

  installCategoryModal();
}

export function renderCategories() {
  const master = readStore(STORE_KEYS.master, {});
  currentCategories = Array.isArray(master.kategori) ? master.kategori : [];
  applyFilters();
  updateSummaryKpis();
}

function updateSummaryKpis() {
  const total = currentCategories.length;
  const activeCount = currentCategories.filter(c => norm(c.status || c.Status) !== "nonaktif").length;

  const totalEl = $("category-total-count");
  if (totalEl) totalEl.textContent = total;

  const activeEl = $("category-active-count");
  if (activeEl) activeEl.textContent = activeCount;
}

function applyFilters() {
  const q = norm($("category-search")?.value);
  const statusVal = norm($("category-status-filter")?.value);

  filteredCategories = currentCategories.filter(c => {
    const code = norm(c["Kode Kategori"] || c.code);
    const name = norm(c["Nama Kategori"] || c.name);
    const desc = norm(c["Deskripsi"] || c.description);
    const status = norm(c.status || c.Status || "aktif");

    if (q && !code.includes(q) && !name.includes(q) && !desc.includes(q)) return false;
    if (statusVal && status !== statusVal) return false;

    return true;
  });

  renderTable();
}

function renderTable() {
  const tbody = $("categories-table-body");
  const cardList = $("categories-card-list");
  if (!tbody && !cardList) return;

  const total = filteredCategories.length;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filteredCategories.slice(start, start + PAGE_SIZE);

  if (!pageItems.length) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="5" class="empty-table-state" style="text-align:center;padding:24px;">Belum ada data kategori.</td></tr>`;
    if (cardList) cardList.innerHTML = `<div style="text-align:center;padding:32px 16px;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;color:#64748b;"><i class="fa-solid fa-tags" style="font-size:28px;margin-bottom:8px;color:#94a3b8;display:block;"></i>Belum ada data kategori yang sesuai pencarian.</div>`;
  } else {
    // 1. Render Desktop Table Rows
    if (tbody) {
      tbody.innerHTML = pageItems.map((c, idx) => {
        const code = c["Kode Kategori"] || c.code || "—";
        const name = c["Nama Kategori"] || c.name || "—";
        const desc = c["Deskripsi"] || c.description || "—";
        const status = c.status || c.Status || "Aktif";
        const isAktif = norm(status) !== "nonaktif";

        return `
          <tr>
            <td><strong>${escapeHtml(code)}</strong></td>
            <td><strong>${escapeHtml(name)}</strong></td>
            <td>${escapeHtml(desc)}</td>
            <td>
              <span class="badge ${isAktif ? 'badge-success' : 'badge-secondary'}" style="padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;">
                ${isAktif ? 'Aktif' : 'Nonaktif'}
              </span>
            </td>
            <td>
              <div style="display:flex;gap:6px;">
                <button type="button" class="btn-edit-category button button-small button-secondary" data-code="${escapeHtml(code)}" title="Edit Kategori">
                  <i class="fa-solid fa-pen"></i> Edit
                </button>
                <button type="button" class="btn-delete-category button button-small button-danger" data-code="${escapeHtml(code)}" title="Hapus / Nonaktifkan">
                  <i class="fa-solid fa-trash"></i>
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join("");
    }

    // 2. Render Mobile Collapsible Cards (Default Diciutkan)
    if (cardList) {
      cardList.innerHTML = pageItems.map((c, idx) => {
        const code = c["Kode Kategori"] || c.code || "—";
        const name = c["Nama Kategori"] || c.name || "—";
        const desc = c["Deskripsi"] || c.description || "";
        const status = c.status || c.Status || "Aktif";
        const isAktif = norm(status) !== "nonaktif";

        return `
          <div class="responsive-data-card card-purple" data-code="${escapeHtml(code)}">
            <div class="card-accordion-header">
              <div class="card-avatar" style="width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;">
                <i class="fa-solid fa-pills"></i>
              </div>
              <div class="card-header-main">
                <div class="card-title-row">
                  <div class="card-title">${escapeHtml(name)}</div>
                  <span class="badge ${isAktif ? 'badge-success' : 'badge-secondary'}" style="font-size:10px;padding:2px 7px;border-radius:5px;font-weight:700;">
                    ${isAktif ? 'Aktif' : 'Nonaktif'}
                  </span>
                </div>
                <div class="card-subtitle-row">
                  <span>Kode: <strong>${escapeHtml(code)}</strong></span>
                  ${desc ? `<span>• ${escapeHtml(desc)}</span>` : ''}
                </div>
              </div>
              <div class="card-toggle-icon">
                <i class="fa-solid fa-chevron-down"></i>
              </div>
            </div>
            <div class="card-accordion-body">
              <div class="card-detail-grid">
                <div class="card-detail-item">
                  <span class="card-detail-label">Kode Kategori</span>
                  <span class="card-detail-value"><strong>${escapeHtml(code)}</strong></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Nama Kategori</span>
                  <span class="card-detail-value">${escapeHtml(name)}</span>
                </div>
                <div class="card-detail-item" style="grid-column: 1 / -1;">
                  <span class="card-detail-label">Deskripsi & Catatan</span>
                  <span class="card-detail-value">${escapeHtml(desc || "Tidak ada deskripsi tambahan.")}</span>
                </div>
              </div>
              <div class="card-action-bar">
                <button type="button" class="btn-edit-category button button-small button-secondary" data-code="${escapeHtml(code)}">
                  <i class="fa-solid fa-pen"></i> Edit Kategori
                </button>
                <button type="button" class="btn-delete-category button button-small button-danger" data-code="${escapeHtml(code)}">
                  <i class="fa-solid fa-trash"></i> Hapus
                </button>
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

    // Pasang event action buttons (Edit & Hapus) baik pada table maupun cards
    const container = document.querySelector('[data-view-section="categories"]');
    if (container) {
      container.querySelectorAll(".btn-edit-category").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const catCode = btn.dataset.code;
          const c = currentCategories.find(x => norm(x["Kode Kategori"] || x.code) === norm(catCode));
          if (c) openCategoryModal(c);
        });
      });

      container.querySelectorAll(".btn-delete-category").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const catCode = btn.dataset.code;
          handleDeleteCategory(catCode);
        });
      });
    }
  }

  const visibleCountEl = $("categories-visible-count");
  if (visibleCountEl) visibleCountEl.textContent = pageItems.length;

  const totalResultEl = $("categories-total-result-count");
  if (totalResultEl) totalResultEl.textContent = total;

  const prevBtn = $("categories-prev-page");
  if (prevBtn) prevBtn.disabled = currentPage <= 1;

  const nextBtn = $("categories-next-page");
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
}

function installCategoryModal() {
  if ($("modal-category-form")) return;

  const modalHtml = `
    <div id="modal-category-form" class="kp-dialog-v4" hidden>
      <div class="kp-dialog-v4__backdrop"></div>
      <section class="kp-dialog-v4__card" style="width:min(94vw,460px);" role="dialog">
        <header style="padding:18px 20px 12px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
          <h2 id="category-modal-title" style="font-size:16px;font-weight:800;margin:0;">Tambah Kategori Baru</h2>
          <button type="button" id="close-modal-category" class="button button-small button-secondary" style="padding:4px 8px;"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <form id="category-form-inner" style="padding:20px;text-align:left;">
          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Kode Kategori</label>
          <input type="text" id="input-category-code" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;margin-bottom:14px;" placeholder="Contoh: KAT001 (Opsional, otomatis bila kosong)">

          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Nama Kategori <span class="text-danger">*</span></label>
          <input type="text" id="input-category-name" required style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;margin-bottom:14px;" placeholder="Contoh: Obat Bebas">

          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Deskripsi</label>
          <textarea id="input-category-desc" rows="2" style="width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;margin-bottom:14px;" placeholder="Keterangan singkat kategori..."></textarea>

          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Status</label>
          <select id="input-category-status" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;">
            <option value="Aktif">Aktif</option>
            <option value="Nonaktif">Nonaktif</option>
          </select>
        </form>
        <footer style="padding:12px 20px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:8px;">
          <button type="button" id="cancel-category-form" class="button button-secondary">Batal</button>
          <button type="button" id="save-category-form" class="button button-primary"><i class="fa-solid fa-floppy-disk"></i> Simpan Kategori</button>
        </footer>
      </section>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  $("close-modal-category")?.addEventListener("click", closeCategoryModal);
  $("cancel-category-form")?.addEventListener("click", closeCategoryModal);
  $("save-category-form")?.addEventListener("click", handleSaveCategory);
}

function openCategoryModal(cat = null) {
  activeEditingCategory = cat;
  const modal = $("modal-category-form");
  if (!modal) return;

  $("category-modal-title").textContent = cat ? "Edit Kategori" : "Tambah Kategori Baru";
  $("input-category-code").value = cat ? (cat["Kode Kategori"] || cat.code || "") : "";
  $("input-category-name").value = cat ? (cat["Nama Kategori"] || cat.name || "") : "";
  $("input-category-desc").value = cat ? (cat["Deskripsi"] || cat.description || "") : "";
  $("input-category-status").value = cat ? (cat.status || cat.Status || "Aktif") : "Aktif";

  modal.hidden = false;
  setTimeout(() => $("input-category-name")?.focus(), 50);
}

function closeCategoryModal() {
  const modal = $("modal-category-form");
  if (modal) modal.hidden = true;
  activeEditingCategory = null;
}

async function handleSaveCategory() {
  let code = text($("input-category-code")?.value);
  const name = text($("input-category-name")?.value);
  const desc = text($("input-category-desc")?.value);
  const status = $("input-category-status")?.value || "Aktif";

  if (!name) {
    window.KasirProDialog?.warning("Perhatian", "Nama Kategori wajib diisi.");
    return;
  }
  if (!code) {
    code = `KAT-${Date.now().toString().slice(-4)}`;
  }

  const master = readStore(STORE_KEYS.master, {});
  const cats = Array.isArray(master.kategori) ? [...master.kategori] : [];
  let targetCategory = null;

  if (activeEditingCategory) {
    const idx = cats.findIndex(c => norm(c["Kode Kategori"] || c.code) === norm(activeEditingCategory["Kode Kategori"] || activeEditingCategory.code));
    targetCategory = {
      ...(idx >= 0 ? cats[idx] : {}),
      id: (idx >= 0 && cats[idx].id) ? cats[idx].id : `KAT-${Date.now()}`,
      "Kode Kategori": code,
      "Nama Kategori": name,
      "Deskripsi": desc,
      "Status": status,
      "status": status
    };
  } else {
    // Cek duplikasi
    const exists = cats.some(c => norm(c["Nama Kategori"] || c.name) === norm(name));
    if (exists) {
      window.KasirProDialog?.warning("Duplikasi", `Kategori "${name}" sudah ada.`);
      return;
    }
    targetCategory = {
      id: `KAT-${Date.now()}`,
      "Kode Kategori": code,
      "Nama Kategori": name,
      "Deskripsi": desc,
      "Status": status,
      "status": status
    };
  }

  try {
    // Tulis delta (hanya 1 kategori ke Firestore & IndexedDB, 0ms respon instan)
    await writeMasterDelta({ kategori: [targetCategory] });
    closeCategoryModal();
    renderCategories();
    window.KasirProDialog?.success("Berhasil", `Kategori "${name}" berhasil disimpan.`);
  } catch (err) {
    window.KasirProDialog?.error("Gagal Menyimpan", err.message);
  }
}

async function handleDeleteCategory(catCode) {
  const confirmed = await window.KasirProDialog?.confirm(
    "Konfirmasi Hapus",
    `Apakah Anda yakin ingin menonaktifkan kategori "${catCode}"?`
  );
  if (!confirmed) return;

  const master = readStore(STORE_KEYS.master, {});
  const cats = Array.isArray(master.kategori) ? [...master.kategori] : [];
  const target = cats.find(c => norm(c["Kode Kategori"] || c.code) === norm(catCode));
  if (!target) return;

  const updatedTarget = {
    ...target,
    status: "Nonaktif",
    Status: "Nonaktif"
  };

  try {
    await writeMasterDelta({ kategori: [updatedTarget] });
    renderCategories();
    window.KasirProDialog?.success("Berhasil", `Kategori "${catCode}" dinonaktifkan.`);
  } catch (err) {
    window.KasirProDialog?.error("Gagal Menghapus", err.message);
  }
}
