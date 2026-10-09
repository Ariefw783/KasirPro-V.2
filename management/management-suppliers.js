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
let allSuppliersExpanded = false;
let supplierLinkedCounts = new Map();

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

  $("btn-toggle-all-suppliers")?.addEventListener("click", () => {
    allSuppliersExpanded = !allSuppliersExpanded;
    const cards = document.querySelectorAll(".kp-entity-card[data-entity='supplier']");
    cards.forEach(c => {
      c.classList.toggle("is-expanded", allSuppliersExpanded);
      c.classList.toggle("is-collapsed", !allSuppliersExpanded);
      const icon = c.querySelector(".btn-toggle-card i");
      if (icon) {
        icon.className = allSuppliersExpanded ? "fa-solid fa-chevron-up" : "fa-solid fa-chevron-down";
      }
    });
    const label = $("toggle-all-suppliers-text");
    if (label) label.textContent = allSuppliersExpanded ? "Ciutkan Semua" : "Buka Semua";
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
  const master = readStore(STORE_KEYS.master, {});
  const prods = Array.isArray(master.produk) ? master.produk : [];
  supplierLinkedCounts.clear();
  prods.forEach(p => {
    const s = norm(p["Supplier"] || p.supplier);
    if (s) supplierLinkedCounts.set(s, (supplierLinkedCounts.get(s) || 0) + 1);
  });

  const total = currentSuppliers.length;
  const activeCount = currentSuppliers.filter(s => norm(s.status || s.Status) !== "nonaktif").length;

  const totalEl = $("supplier-total-count");
  if (totalEl) totalEl.textContent = total;

  const activeEl = $("supplier-active-count");
  if (activeEl) activeEl.textContent = activeCount;

  const linkedEl = $("supplier-linked-product-count");
  if (linkedEl) {
    let linkedSum = 0;
    currentSuppliers.forEach(s => {
      const name = norm(s["Nama Perusahaan"] || s["Supplier"] || s.name);
      linkedSum += supplierLinkedCounts.get(name) || 0;
    });
    linkedEl.textContent = linkedSum;
  }
}

function applyFilters() {
  const q = norm($("supplier-search")?.value);
  const statusVal = norm($("supplier-status-filter")?.value);

  filteredSuppliers = currentSuppliers.filter(s => {
    const name = norm(s["Nama Perusahaan"] || s["Supplier"] || s.name);
    const pic = norm(s["Nama Sales/PIC"] || s["Kontak Person"] || s.pic);
    const npwp = norm(s["NPWP"] || s.npwp);
    const phone = norm(s["No. Telepon"] || s["Telepon"] || s.phone || s["Kontak"]);
    const status = norm(s.status || s.Status || "aktif");

    if (q && !name.includes(q) && !pic.includes(q) && !npwp.includes(q) && !phone.includes(q)) return false;
    if (statusVal && status !== statusVal) return false;

    return true;
  });

  renderTable();
}

function renderTable() {
  const container = $("suppliers-cards-container") || $("suppliers-table-body");
  if (!container) return;

  const total = filteredSuppliers.length;
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filteredSuppliers.slice(start, start + PAGE_SIZE);

  if (!pageItems.length) {
    container.innerHTML = `<div class="empty-table-state" style="text-align:center;padding:28px 20px;background:#fff;border-radius:12px;border:1px solid #e2e8f0;color:#64748b;">
      <i class="fa-solid fa-truck-field" style="font-size:32px;color:#cbd5e1;display:block;margin-bottom:10px;"></i>
      Belum ada data supplier yang sesuai pencarian.
    </div>`;
  } else {
    container.innerHTML = pageItems.map((s, idx) => {
      const name = s["Nama Perusahaan"] || s["Supplier"] || s.name || "—";
      const pic = s["Nama Sales/PIC"] || s["Kontak Person"] || s.pic || "—";
      const npwp = s["NPWP"] || s.npwp || "—";
      const phone = s["No. Telepon"] || s["Telepon"] || s.phone || s["Kontak"] || "";
      const address = s["Alamat"] || s.address || "";
      const bank = s["Rekening"] || s.bankAccount || s["Bank"] || "";
      const notes = s["Termin"] || s.top || s["Catatan"] || "";
      const status = s.status || s.Status || "Aktif";
      const isAktif = norm(status) !== "nonaktif";
      const linkedCount = supplierLinkedCounts.get(norm(name)) || 0;

      return `
        <article class="kp-entity-card ${allSuppliersExpanded ? 'is-expanded' : 'is-collapsed'}" data-entity="supplier" data-name="${escapeHtml(name)}">
          <div class="kp-entity-card-header" data-action="toggle">
            <div class="kp-entity-header-left">
              <div class="kp-entity-avatar supplier">
                <i class="fa-solid fa-truck-field"></i>
              </div>
              <div class="kp-entity-info">
                <div class="kp-entity-title">
                  <span>${escapeHtml(name)}</span>
                  <span class="badge ${isAktif ? 'badge-success' : 'badge-secondary'}" style="padding:2px 7px;font-size:10px;font-weight:700;">
                    ${isAktif ? 'Aktif' : 'Nonaktif'}
                  </span>
                </div>
                <div class="kp-entity-subtitle">
                  ${phone ? `<span style="color:#0284c7;display:inline-flex;align-items:center;gap:4px;"><i class="fa-solid fa-phone" style="font-size:10px;"></i> ${escapeHtml(phone)}</span><span style="color:#cbd5e1;">•</span>` : ''}
                  <span style="color:#475569;display:inline-flex;align-items:center;gap:4px;"><i class="fa-solid fa-user-tie" style="font-size:10px;"></i> PIC: ${escapeHtml(pic)}</span>
                  <span style="color:#cbd5e1;">•</span>
                  <span style="color:#64748b;display:inline-flex;align-items:center;gap:4px;"><i class="fa-solid fa-boxes-stacked" style="font-size:10px;"></i> ${linkedCount} Produk</span>
                </div>
              </div>
            </div>
            <div class="kp-entity-header-right">
              <button type="button" class="btn-edit-supplier button button-small button-secondary" data-name="${escapeHtml(name)}" title="Edit Supplier" style="padding:4px 8px;font-size:11px;">
                <i class="fa-solid fa-pen"></i> <span class="hide-mobile">Edit</span>
              </button>
              <button type="button" class="btn-delete-supplier button button-small button-danger" data-name="${escapeHtml(name)}" title="Hapus / Nonaktifkan" style="padding:4px 8px;font-size:11px;">
                <i class="fa-solid fa-trash"></i>
              </button>
              <button type="button" class="btn-toggle-card button button-small button-secondary" style="padding:4px 8px;font-size:11px;" title="Buka/Ciutkan Data Lengkap">
                <i class="fa-solid ${allSuppliersExpanded ? 'fa-chevron-up' : 'fa-chevron-down'}"></i>
              </button>
            </div>
          </div>
          
          <div class="kp-entity-card-body">
            <div class="kp-entity-grid">
              <div class="kp-entity-field">
                <span class="kp-entity-label">Nama Sales / PIC</span>
                <span class="kp-entity-val">${escapeHtml(pic)}</span>
              </div>
              <div class="kp-entity-field">
                <span class="kp-entity-label">No. Telepon / WhatsApp</span>
                <span class="kp-entity-val">${phone ? `<a href="tel:${escapeHtml(phone)}" style="color:#0284c7;text-decoration:none;"><i class="fa-solid fa-phone" style="font-size:11px;"></i> ${escapeHtml(phone)}</a>` : '—'}</span>
              </div>
              <div class="kp-entity-field">
                <span class="kp-entity-label">NPWP Perusahaan</span>
                <span class="kp-entity-val">${escapeHtml(npwp)}</span>
              </div>
              <div class="kp-entity-field">
                <span class="kp-entity-label">Alamat / Domisili</span>
                <span class="kp-entity-val">${escapeHtml(address || '—')}</span>
              </div>
              <div class="kp-entity-field">
                <span class="kp-entity-label">Rekening Pembayaran</span>
                <span class="kp-entity-val">${escapeHtml(bank || '—')}</span>
              </div>
              <div class="kp-entity-field">
                <span class="kp-entity-label">Termin Pembayaran (TOP)</span>
                <span class="kp-entity-val">${escapeHtml(notes || '—')}</span>
              </div>
            </div>
            
            <div class="kp-entity-footer">
              <span style="font-size:12px;color:#64748b;">
                Menyuplai <strong>${linkedCount}</strong> obat di Master Produk
              </span>
              <button type="button" class="btn-filter-supplier-products button button-small button-primary" data-name="${escapeHtml(name)}" style="display:inline-flex;align-items:center;gap:6px;">
                <i class="fa-solid fa-arrow-up-right-from-square"></i> Lihat Produk Supplier Ini
              </button>
            </div>
          </div>
        </article>
      `;
    }).join("");

    container.querySelectorAll(".kp-entity-card").forEach(card => {
      const header = card.querySelector(".kp-entity-card-header");
      const doToggle = (e) => {
        if (e.target.closest(".btn-edit-supplier") || e.target.closest(".btn-delete-supplier")) return;
        const isExpanded = card.classList.toggle("is-expanded");
        card.classList.toggle("is-collapsed", !isExpanded);
        const icon = card.querySelector(".btn-toggle-card i");
        if (icon) icon.className = isExpanded ? "fa-solid fa-chevron-up" : "fa-solid fa-chevron-down";
      };
      header?.addEventListener("click", doToggle);
    });

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

    container.querySelectorAll(".btn-filter-supplier-products").forEach(btn => {
      btn.addEventListener("click", () => {
        const supName = btn.dataset.name;
        if (window.switchView) {
          window.switchView("products");
          setTimeout(() => {
            const sf = document.getElementById("product-supplier-filter");
            if (sf) {
              sf.value = supName;
              sf.dispatchEvent(new Event("change"));
            }
          }, 80);
        }
      });
    });
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
      <section class="kp-dialog-v4__card" style="width:min(94vw,500px);" role="dialog">
        <header style="padding:18px 20px 12px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
          <h2 id="supplier-modal-title" style="font-size:16px;font-weight:800;margin:0;">Tambah Supplier Baru</h2>
          <button type="button" id="close-modal-supplier" class="button button-small button-secondary" style="padding:4px 8px;"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <form id="supplier-form-inner" style="padding:20px;text-align:left;display:flex;flex-direction:column;gap:12px;">
          <div>
            <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Nama Perusahaan <span class="text-danger">*</span></label>
            <input type="text" id="input-supplier-name" required style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;" placeholder="Contoh: PT Kimia Farma Trading">
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div>
              <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Nama Sales / PIC</label>
              <input type="text" id="input-supplier-pic" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;" placeholder="Contoh: Budi Santoso">
            </div>
            <div>
              <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">No. Telepon / WA</label>
              <input type="tel" id="input-supplier-phone" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;" placeholder="0812xxxx">
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div>
              <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">NPWP Perusahaan</label>
              <input type="text" id="input-supplier-npwp" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;" placeholder="01.234.567.8-901.000">
            </div>
            <div>
              <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Status</label>
              <select id="input-supplier-status" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;">
                <option value="Aktif">Aktif</option>
                <option value="Nonaktif">Nonaktif</option>
              </select>
            </div>
          </div>

          <div>
            <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Alamat / Domisili</label>
            <input type="text" id="input-supplier-address" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;" placeholder="Alamat kantor distributor">
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <div>
              <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Rekening Pembayaran</label>
              <input type="text" id="input-supplier-bank" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;" placeholder="BCA 123456 a/n PT ...">
            </div>
            <div>
              <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Termin Pembayaran</label>
              <input type="text" id="input-supplier-notes" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;" placeholder="Contoh: TOP 30 Hari">
            </div>
          </div>
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
  $("input-supplier-phone").value = sup ? (sup["No. Telepon"] || sup["Telepon"] || sup.phone || sup["Kontak"] || "") : "";
  $("input-supplier-npwp").value = sup ? (sup["NPWP"] || sup.npwp || "") : "";
  $("input-supplier-address").value = sup ? (sup["Alamat"] || sup.address || "") : "";
  $("input-supplier-bank").value = sup ? (sup["Rekening"] || sup.bankAccount || sup["Bank"] || "") : "";
  $("input-supplier-notes").value = sup ? (sup["Termin"] || sup.top || sup["Catatan"] || "") : "";
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
  const phone = text($("input-supplier-phone")?.value);
  const npwp = text($("input-supplier-npwp")?.value);
  const address = text($("input-supplier-address")?.value);
  const bank = text($("input-supplier-bank")?.value);
  const notes = text($("input-supplier-notes")?.value);
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
      "No. Telepon": phone,
      "Telepon": phone,
      "NPWP": npwp,
      "Alamat": address,
      "Rekening": bank,
      "Termin": notes,
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
      "No. Telepon": phone,
      "Telepon": phone,
      "NPWP": npwp,
      "Alamat": address,
      "Rekening": bank,
      "Termin": notes,
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
