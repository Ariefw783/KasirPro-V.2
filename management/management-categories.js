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
let allCategoriesExpanded = false;
let categoryLinkedCounts = new Map();

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

  $("btn-toggle-all-categories")?.addEventListener("click", () => {
    allCategoriesExpanded = !allCategoriesExpanded;
    const cards = document.querySelectorAll(".kp-entity-card[data-entity='category']");
    cards.forEach(c => {
      c.classList.toggle("is-expanded", allCategoriesExpanded);
      c.classList.toggle("is-collapsed", !allCategoriesExpanded);
      const icon = c.querySelector(".btn-toggle-card i");
      if (icon) {
        icon.className = allCategoriesExpanded ? "fa-solid fa-chevron-up" : "fa-solid fa-chevron-down";
      }
    });
    const label = $("toggle-all-categories-text");
    if (label) label.textContent = allCategoriesExpanded ? "Ciutkan Semua" : "Buka Semua";
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
  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? master.produk : [];
  categoryLinkedCounts.clear();
  prods.forEach(p => {
    const c = norm(p["Kategori"] || p.category);
    if (c) categoryLinkedCounts.set(c, (categoryLinkedCounts.get(c) || 0) + 1);
  });

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
  const container = $("categories-cards-container") || $("categories-table-body");
  if (!container) return;

  const total = filteredCategories.length;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filteredCategories.slice(start, start + PAGE_SIZE);

  if (!pageItems.length) {
    container.innerHTML = `<div class="empty-table-state" style="text-align:center;padding:28px 20px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;color:#64748b;">
      <i class="fa-solid fa-tags" style="font-size:32px;color:#cbd5e1;display:block;margin-bottom:10px;"></i>
      Belum ada data kategori yang sesuai pencarian.
    </div>`;
  } else {
    container.innerHTML = pageItems.map((c, idx) => {
      const code = c["Kode Kategori"] || c.code || "—";
      const name = c["Nama Kategori"] || c.name || "—";
      const desc = c["Deskripsi"] || c.description || "";
      const rack = c["Rak"] || c["Lokasi"] || c.rack || "";
      const status = c.status || c.Status || "Aktif";
      const isAktif = norm(status) !== "nonaktif";
      const linkedCount = categoryLinkedCounts.get(norm(name)) || categoryLinkedCounts.get(norm(code)) || 0;

      return `
        <article class="kp-entity-card ${allCategoriesExpanded ? 'is-expanded' : 'is-collapsed'}" data-entity="category" data-code="${escapeHtml(code)}">
          <div class="kp-entity-card-header" data-action="toggle">
            <div class="kp-entity-header-left">
              <div class="kp-entity-avatar category">
                <i class="fa-solid fa-tags"></i>
              </div>
              <div class="kp-entity-info">
                <div class="kp-entity-title">
                  <span>${escapeHtml(name)}</span>
                  <span style="font-size:11px;color:#7c3aed;background:#f5f3ff;padding:1px 6px;border-radius:4px;border:1px solid #ddd6fe;font-weight:700;">
                    ${escapeHtml(code)}
                  </span>
                  <span class="badge ${isAktif ? 'badge-success' : 'badge-secondary'}" style="padding:2px 7px;font-size:10px;font-weight:700;">
                    ${isAktif ? 'Aktif' : 'Nonaktif'}
                  </span>
                </div>
                <div class="kp-entity-subtitle">
                  <span style="color:#64748b;display:inline-flex;align-items:center;gap:4px;"><i class="fa-solid fa-boxes-stacked" style="font-size:10px;"></i> ${linkedCount} Produk</span>
                  ${desc ? `<span style="color:#cbd5e1;">•</span><span style="color:#475569;display:inline-flex;align-items:center;gap:4px;"><i class="fa-solid fa-align-left" style="font-size:10px;"></i> ${escapeHtml(desc.length > 40 ? desc.slice(0, 40) + '...' : desc)}</span>` : ''}
                </div>
              </div>
            </div>
            <div class="kp-entity-header-right">
              <button type="button" class="btn-edit-category button button-small button-secondary" data-code="${escapeHtml(code)}" title="Edit Kategori" style="padding:4px 8px;font-size:11px;">
                <i class="fa-solid fa-pen"></i> <span class="hide-mobile">Edit</span>
              </button>
              <button type="button" class="btn-delete-category button button-small button-danger" data-code="${escapeHtml(code)}" title="Hapus / Nonaktifkan" style="padding:4px 8px;font-size:11px;">
                <i class="fa-solid fa-trash"></i>
              </button>
              <button type="button" class="btn-toggle-card button button-small button-secondary" style="padding:4px 8px;font-size:11px;" title="Buka/Ciutkan Data Lengkap">
                <i class="fa-solid ${allCategoriesExpanded ? 'fa-chevron-up' : 'fa-chevron-down'}"></i>
              </button>
            </div>
          </div>
          
          <div class="kp-entity-card-body">
            <div class="kp-entity-grid">
              <div class="kp-entity-field">
                <span class="kp-entity-label">Deskripsi Lengkap</span>
                <span class="kp-entity-val">${escapeHtml(desc || 'Tidak ada deskripsi.')}</span>
              </div>
              <div class="kp-entity-field">
                <span class="kp-entity-label">Lokasi / Rak Penyimpanan</span>
                <span class="kp-entity-val">${escapeHtml(rack || '—')}</span>
              </div>
            </div>
            
            <div class="kp-entity-footer">
              <span style="font-size:12px;color:#64748b;">
                Terdapat <strong>${linkedCount}</strong> obat di kategori ini
              </span>
              <button type="button" class="btn-filter-category-products button button-small button-primary" data-name="${escapeHtml(name)}" data-code="${escapeHtml(code)}" style="display:inline-flex;align-items:center;gap:6px;">
                <i class="fa-solid fa-arrow-up-right-from-square"></i> Lihat Produk di Kategori Ini
              </button>
            </div>
          </div>
        </article>
      `;
    }).join("");

    container.querySelectorAll(".kp-entity-card").forEach(card => {
      const header = card.querySelector(".kp-entity-card-header");
      const doToggle = (e) => {
        if (e.target.closest(".btn-edit-category") || e.target.closest(".btn-delete-category")) return;
        const isExpanded = card.classList.toggle("is-expanded");
        card.classList.toggle("is-collapsed", !isExpanded);
        const icon = card.querySelector(".btn-toggle-card i");
        if (icon) icon.className = isExpanded ? "fa-solid fa-chevron-up" : "fa-solid fa-chevron-down";
      };
      header?.addEventListener("click", doToggle);
    });

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

    container.querySelectorAll(".btn-filter-category-products").forEach(btn => {
      btn.addEventListener("click", () => {
        const catName = btn.dataset.name;
        if (window.switchView) {
          window.switchView("products");
          setTimeout(() => {
            const cf = document.getElementById("product-category-filter");
            if (cf) {
              cf.value = catName;
              cf.dispatchEvent(new Event("change"));
            }
          }, 80);
        }
      });
    });
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
        <form id="category-form-inner" style="padding:20px;text-align:left;display:flex;flex-direction:column;gap:12px;">
          <div>
            <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Kode Kategori</label>
            <input type="text" id="input-category-code" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;" placeholder="Contoh: KAT001 (Opsional, otomatis bila kosong)">
          </div>

          <div>
            <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Nama Kategori <span class="text-danger">*</span></label>
            <input type="text" id="input-category-name" required style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;" placeholder="Contoh: Obat Bebas">
          </div>

          <div>
            <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Lokasi / Rak Penyimpanan</label>
            <input type="text" id="input-category-rack" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;" placeholder="Contoh: Rak A-02">
          </div>

          <div>
            <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Deskripsi</label>
            <textarea id="input-category-desc" rows="2" style="width:100%;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;" placeholder="Keterangan singkat kategori..."></textarea>
          </div>

          <div>
            <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Status</label>
            <select id="input-category-status" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;">
              <option value="Aktif">Aktif</option>
              <option value="Nonaktif">Nonaktif</option>
            </select>
          </div>
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
  $("input-category-rack").value = cat ? (cat["Rak"] || cat["Lokasi"] || cat.rack || "") : "";
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
  const rack = text($("input-category-rack")?.value);
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
      "Rak": rack,
      "Lokasi": rack,
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
      "Rak": rack,
      "Lokasi": rack,
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
