/**
 * management/management-suppliers.js
 * Manajemen Master Supplier KasirPro V2
 * 
 * Sesuai Spesifikasi:
 * - Field Supplier HANYA: Nama Perusahaan (wajib), Nama Sales/PIC, dan NPWP.
 * - Tidak boleh lagi menggunakan tampilan Supplier 1, Supplier 2, Supplier 3.
 * - Sediakan: Daftar Supplier, Tambah, Edit, Hapus/Nonaktif, Cari.
 */

import { $, num, text, norm, escapeHtml } from "../modules/core/utils.js";
import { STORE_KEYS, readStore, writeStore, writeMasterDelta } from "../modules/database/database-store.js";

const PAGE_SIZE = 25;
let currentPage = 1;
let currentSuppliers = [];
let filteredSuppliers = [];
let activeEditingSupplier = null;

export function initSuppliersModule() {
  bindEvents();
  renderSuppliers();
}

function bindEvents() {
  $("supplier-search")?.addEventListener("input", () => {
    currentPage = 1;
    applyFilters();
  });

  $("supplier-status-filter")?.addEventListener("change", () => {
    currentPage = 1;
    applyFilters();
  });

  $("refresh-suppliers")?.addEventListener("click", () => {
    renderSuppliers();
    window.KasirProDialog?.success("Berhasil", "Data supplier berhasil disegarkan.");
  });

  $("suppliers-prev-page")?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      renderTable();
    }
  });

  $("suppliers-next-page")?.addEventListener("click", () => {
    const totalPages = Math.ceil(filteredSuppliers.length / PAGE_SIZE) || 1;
    if (currentPage < totalPages) {
      currentPage++;
      renderTable();
    }
  });

  // Tombol Tambah Supplier di header
  const headerActions = document.querySelector('[data-view-section="suppliers"] .module-header-actions');
  if (headerActions && !$("btn-add-supplier")) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.id = "btn-add-supplier";
    addBtn.className = "button button-primary";
    addBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Tambah Supplier';
    addBtn.addEventListener("click", () => openSupplierModal(null));
    headerActions.prepend(addBtn);
  }

  installSupplierModal();
}

export function renderSuppliers() {
  const master = readStore(STORE_KEYS.master, {});
  currentSuppliers = Array.isArray(master.supplier) ? master.supplier : [];
  applyFilters();
  updateSummaryKpis();
}

function updateSummaryKpis() {
  const total = currentSuppliers.length;
  const activeCount = currentSuppliers.filter(s => norm(s.status || s.Status) !== "nonaktif").length;

  const totalEl = $("supplier-total-count");
  if (totalEl) totalEl.textContent = total;

  const activeEl = $("supplier-active-count");
  if (activeEl) activeEl.textContent = activeCount;
}

function applyFilters() {
  const q = norm($("supplier-search")?.value);
  const statusVal = norm($("supplier-status-filter")?.value);

  filteredSuppliers = currentSuppliers.filter(s => {
    const name = norm(s["Nama Perusahaan"] || s["Supplier"] || s.name);
    const pic = norm(s["Nama Sales/PIC"] || s["Kontak Person"] || s.pic);
    const npwp = norm(s["NPWP"] || s.npwp);
    const status = norm(s.status || s.Status || "aktif");

    if (q && !name.includes(q) && !pic.includes(q) && !npwp.includes(q)) return false;
    if (statusVal && status !== statusVal) return false;

    return true;
  });

  renderTable();
}

function renderTable() {
  const tbody = $("suppliers-table-body");
  const cardList = $("suppliers-card-list");
  if (!tbody && !cardList) return;

  const total = filteredSuppliers.length;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filteredSuppliers.slice(start, start + PAGE_SIZE);

  if (!pageItems.length) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="empty-table-state" style="text-align:center;padding:24px;">Belum ada data supplier.</td></tr>`;
    if (cardList) cardList.innerHTML = `<div style="text-align:center;padding:32px 16px;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;color:#64748b;"><i class="fa-solid fa-truck" style="font-size:28px;margin-bottom:8px;color:#94a3b8;display:block;"></i>Belum ada data supplier yang sesuai pencarian.</div>`;
  } else {
    // 1. Render Desktop Table Rows
    if (tbody) {
      tbody.innerHTML = pageItems.map((s, idx) => {
        const name = s["Nama Perusahaan"] || s["Supplier"] || s.name || "—";
        const pic = s["Nama Sales/PIC"] || s["Kontak Person"] || s.pic || "—";
        const phone = s["No. HP / WA"] || s["Telepon"] || s.phone || "—";
        const email = s["Email"] || s.email || "—";
        const terms = s["Termin Pembayaran"] || s["Termin"] || s.terms || "—";
        const npwp = s["NPWP"] || s.npwp || "—";
        const status = s.status || s.Status || "Aktif";
        const isAktif = norm(status) !== "nonaktif";

        return `
          <tr>
            <td><strong>${escapeHtml(name)}</strong></td>
            <td>${escapeHtml(name)}</td>
            <td>${escapeHtml(pic)}</td>
            <td>${escapeHtml(phone)}</td>
            <td>${escapeHtml(email)}</td>
            <td>${escapeHtml(terms)}</td>
            <td><span class="badge" style="background:#f1f5f9;color:#475569;font-weight:700;">Terdaftar</span></td>
            <td>
              <span class="badge ${isAktif ? 'badge-success' : 'badge-secondary'}" style="padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;">
                ${isAktif ? 'Aktif' : 'Nonaktif'}
              </span>
            </td>
            <td>
              <div style="display:flex;gap:6px;">
                <button type="button" class="btn-edit-supplier button button-small button-secondary" data-name="${escapeHtml(name)}" title="Edit Supplier">
                  <i class="fa-solid fa-pen"></i> Edit
                </button>
                <button type="button" class="btn-delete-supplier button button-small button-danger" data-name="${escapeHtml(name)}" title="Hapus / Nonaktifkan">
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
      cardList.innerHTML = pageItems.map((s, idx) => {
        const name = s["Nama Perusahaan"] || s["Supplier"] || s.name || "—";
        const pic = s["Nama Sales/PIC"] || s["Kontak Person"] || s.pic || "—";
        const phone = s["No. HP / WA"] || s["Telepon"] || s.phone || "";
        const email = s["Email"] || s.email || "";
        const address = s["Alamat Lengkap / Gudang"] || s["Alamat"] || s.address || "";
        const terms = s["Termin Pembayaran"] || s["Termin"] || s.terms || "";
        const bank = s["Rekening Bank"] || s.bank || "";
        const npwp = s["NPWP"] || s.npwp || "";
        const status = s.status || s.Status || "Aktif";
        const isAktif = norm(status) !== "nonaktif";

        const cleanWords = name.replace(/[^a-zA-Z0-9 ]/g, "").split(" ").filter(Boolean);
        const initials = (cleanWords.slice(0, 2).map(w => w[0]).join("") || "SP").toUpperCase();

        return `
          <div class="responsive-data-card ${isAktif ? 'card-success' : 'card-warning'}" data-name="${escapeHtml(name)}">
            <div class="card-accordion-header">
              <div class="card-header-main">
                <div class="card-title-row">
                  <div class="card-title">${escapeHtml(name)}</div>
                  <span class="badge ${isAktif ? 'badge-success' : 'badge-secondary'}" style="font-size:10px;padding:2px 7px;border-radius:5px;font-weight:700;">
                    ${isAktif ? 'Aktif' : 'Nonaktif'}
                  </span>
                </div>
                <div class="card-subtitle-row">
                  <span>PIC: <strong>${escapeHtml(pic)}</strong></span>
                  ${phone ? `<span>•</span><span>${escapeHtml(phone)}</span>` : ''}
                </div>
              </div>
              <div class="card-toggle-icon">
                <i class="fa-solid fa-chevron-down"></i>
              </div>
            </div>
            <div class="card-accordion-body">
              <div class="card-detail-grid">
                <div class="card-detail-item">
                  <span class="card-detail-label">Nama Perusahaan</span>
                  <span class="card-detail-value">${escapeHtml(name)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Kontak Person</span>
                  <span class="card-detail-value">${escapeHtml(pic)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Telepon / HP</span>
                  <span class="card-detail-value">${escapeHtml(phone || "—")}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Email</span>
                  <span class="card-detail-value">${escapeHtml(email || "—")}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Termin Pembayaran</span>
                  <span class="card-detail-value">${escapeHtml(terms || "—")}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Rekening Bank</span>
                  <span class="card-detail-value">${escapeHtml(bank || "—")}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">NPWP</span>
                  <span class="card-detail-value">${escapeHtml(npwp || "—")}</span>
                </div>
                <div class="card-detail-item" style="grid-column: 1 / -1;">
                  <span class="card-detail-label">Alamat Lengkap</span>
                  <span class="card-detail-value">${escapeHtml(address || "—")}</span>
                </div>
              </div>
              <div class="card-action-bar">
                <button type="button" class="btn-edit-supplier button button-small button-secondary" data-name="${escapeHtml(name)}">
                  <i class="fa-solid fa-pen"></i> Edit Data
                </button>
                <button type="button" class="btn-delete-supplier button button-small button-danger" data-name="${escapeHtml(name)}">
                  <i class="fa-solid fa-trash"></i> Hapus
                </button>
              </div>
            </div>
          </div>
        `;
      }).join("");

      // Pasang event toggle expand/collapse pada kartu mobile
      cardList.querySelectorAll(".card-accordion-header").forEach(hdr => {
        hdr.addEventListener("click", () => {
          const card = hdr.closest(".responsive-data-card");
          if (card) card.classList.toggle("is-expanded");
        });
      });
    }

    // Pasang event action buttons (Edit & Hapus) baik pada table maupun cards
    const container = document.querySelector('[data-view-section="suppliers"]');
    if (container) {
      container.querySelectorAll(".btn-edit-supplier").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const supName = btn.dataset.name;
          const s = currentSuppliers.find(x => norm(x["Nama Perusahaan"] || x["Supplier"]) === norm(supName));
          if (s) openSupplierModal(s);
        });
      });

      container.querySelectorAll(".btn-delete-supplier").forEach(btn => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const supName = btn.dataset.name;
          handleDeleteSupplier(supName);
        });
      });
    }
  }

  const visibleCountEl = $("suppliers-visible-count");
  if (visibleCountEl) visibleCountEl.textContent = pageItems.length;

  const totalResultEl = $("suppliers-total-result-count");
  if (totalResultEl) totalResultEl.textContent = total;

  const prevBtn = $("suppliers-prev-page");
  if (prevBtn) prevBtn.disabled = currentPage <= 1;

  const nextBtn = $("suppliers-next-page");
  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
}

function installSupplierModal() {
  if ($("modal-supplier-form")) return;

  const modalHtml = `
    <div id="modal-supplier-form" class="kp-dialog-v4" hidden>
      <div class="kp-dialog-v4__backdrop"></div>
      <section class="kp-dialog-v4__card" style="width:min(94vw,460px);" role="dialog">
        <header style="padding:18px 20px 12px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
          <h2 id="supplier-modal-title" style="font-size:16px;font-weight:800;margin:0;">Tambah Supplier Baru</h2>
          <button type="button" id="close-modal-supplier" class="button button-small button-secondary" style="padding:4px 8px;"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <form id="supplier-form-inner" style="padding:20px;text-align:left;">
          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Nama Perusahaan <span class="text-danger">*</span></label>
          <input type="text" id="input-supplier-name" required style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;margin-bottom:14px;" placeholder="Contoh: PT Kimia Farma Trading">

          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Nama Sales / PIC</label>
          <input type="text" id="input-supplier-pic" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;margin-bottom:14px;" placeholder="Contoh: Budi Santoso">

          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">NPWP Perusahaan</label>
          <input type="text" id="input-supplier-npwp" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;margin-bottom:14px;" placeholder="Contoh: 01.234.567.8-901.000">

          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Status</label>
          <select id="input-supplier-status" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;">
            <option value="Aktif">Aktif</option>
            <option value="Nonaktif">Nonaktif</option>
          </select>
        </form>
        <footer style="padding:12px 20px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:8px;">
          <button type="button" id="cancel-supplier-form" class="button button-secondary">Batal</button>
          <button type="button" id="save-supplier-form" class="button button-primary"><i class="fa-solid fa-floppy-disk"></i> Simpan Supplier</button>
        </footer>
      </section>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  $("close-modal-supplier")?.addEventListener("click", closeSupplierModal);
  $("cancel-supplier-form")?.addEventListener("click", closeSupplierModal);
  $("save-supplier-form")?.addEventListener("click", handleSaveSupplier);
}

function openSupplierModal(sup = null) {
  activeEditingSupplier = sup;
  const modal = $("modal-supplier-form");
  if (!modal) return;

  $("supplier-modal-title").textContent = sup ? "Edit Data Supplier" : "Tambah Supplier Baru";
  $("input-supplier-name").value = sup ? (sup["Nama Perusahaan"] || sup["Supplier"] || sup.name || "") : "";
  $("input-supplier-pic").value = sup ? (sup["Nama Sales/PIC"] || sup["Kontak Person"] || sup.pic || "") : "";
  $("input-supplier-npwp").value = sup ? (sup["NPWP"] || sup.npwp || "") : "";
  $("input-supplier-status").value = sup ? (sup.status || sup.Status || "Aktif") : "Aktif";

  modal.hidden = false;
  setTimeout(() => $("input-supplier-name")?.focus(), 50);
}

function closeSupplierModal() {
  const modal = $("modal-supplier-form");
  if (modal) modal.hidden = true;
  activeEditingSupplier = null;
}

async function handleSaveSupplier() {
  const name = text($("input-supplier-name")?.value);
  const pic = text($("input-supplier-pic")?.value);
  const npwp = text($("input-supplier-npwp")?.value);
  const status = $("input-supplier-status")?.value || "Aktif";

  if (!name) {
    window.KasirProDialog?.warning("Perhatian", "Nama Perusahaan supplier wajib diisi.");
    return;
  }

  const master = readStore(STORE_KEYS.master, {});
  const sups = Array.isArray(master.supplier) ? [...master.supplier] : [];
  let targetSupplier = null;

  if (activeEditingSupplier) {
    const idx = sups.findIndex(s => norm(s["Nama Perusahaan"] || s["Supplier"]) === norm(activeEditingSupplier["Nama Perusahaan"] || activeEditingSupplier["Supplier"]));
    targetSupplier = {
      ...(idx >= 0 ? sups[idx] : {}),
      id: (idx >= 0 && sups[idx].id) ? sups[idx].id : `SUP-${Date.now()}`,
      "Nama Perusahaan": name,
      "Supplier": name,
      "Nama Sales/PIC": pic,
      "Kontak Person": pic,
      "NPWP": npwp,
      "Status": status,
      "status": status
    };
  } else {
    // Tambah baru
    const exists = sups.some(s => norm(s["Nama Perusahaan"] || s["Supplier"]) === norm(name));
    if (exists) {
      window.KasirProDialog?.warning("Duplikasi", `Supplier dengan nama "${name}" sudah terdaftar.`);
      return;
    }
    targetSupplier = {
      id: `SUP-${Date.now()}`,
      "Nama Perusahaan": name,
      "Supplier": name,
      "Nama Sales/PIC": pic,
      "Kontak Person": pic,
      "NPWP": npwp,
      "Status": status,
      "status": status
    };
  }

  try {
    // Jika ini adalah EDIT nama supplier, lakukan cascade update ke seluruh produk yang terasosiasi
    if (activeEditingSupplier) {
      const oldName = activeEditingSupplier["Nama Perusahaan"] || activeEditingSupplier["Supplier"] || "";
      if (oldName && norm(oldName) !== norm(name)) {
        const prods = Array.isArray(master.produk) ? [...master.produk] : [];
        const affectedProds = [];
        prods.forEach(p => {
          if (norm(p["Supplier"]) === norm(oldName)) {
            p["Supplier"] = name;
            affectedProds.push(p);
          }
        });
        if (affectedProds.length > 0) {
          master.produk = prods;
          await writeMasterDelta({ supplier: [targetSupplier], produk: affectedProds });
        } else {
          await writeMasterDelta({ supplier: [targetSupplier] });
        }
      } else {
        await writeMasterDelta({ supplier: [targetSupplier] });
      }
    } else {
      await writeMasterDelta({ supplier: [targetSupplier] });
    }

    closeSupplierModal();
    renderSuppliers();
    window.KasirProDialog?.success("Berhasil", `Supplier "${name}" berhasil disimpan.`);
  } catch (err) {
    window.KasirProDialog?.error("Gagal Menyimpan", err.message);
  }
}

async function handleDeleteSupplier(supName) {
  const confirmed = await window.KasirProDialog?.confirm(
    "Konfirmasi Hapus",
    `Apakah Anda yakin ingin menghapus/menonaktifkan supplier "${supName}"?`
  );
  if (!confirmed) return;

  const master = readStore(STORE_KEYS.master, {});
  const sups = Array.isArray(master.supplier) ? [...master.supplier] : [];
  const target = sups.find(s => norm(s["Nama Perusahaan"] || s["Supplier"]) === norm(supName));
  if (!target) return;

  // Ubah status jadi nonaktif (non-destructive)
  const updatedTarget = {
    ...target,
    status: "Nonaktif",
    Status: "Nonaktif"
  };

  try {
    await writeMasterDelta({ supplier: [updatedTarget] });
    renderSuppliers();
    window.KasirProDialog?.success("Berhasil", `Supplier "${supName}" telah dinonaktifkan.`);
  } catch (err) {
    window.KasirProDialog?.error("Gagal Menghapus", err.message);
  }
}
