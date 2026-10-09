/**
 * management/management-users.js
 * Manajemen Pengguna & Backup Database KasirPro V2
 * 
 * Sesuai Evaluasi:
 * 1. Satu metode penambahan pengguna yang jelas (Admin & Kasir terintegrasi).
 * 2. Tombol Backup Database JSON berfungsi mengunduh full dump (master, invoices, sales, movements, opnames).
 * 3. Tombol Muat Ulang berfungsi menyegarkan data.
 */

import { $, num, text, norm, formatNumber, escapeHtml } from "../modules/core/utils.js";
import { STORE_KEYS, readStore, writeStore, writeMasterDelta } from "../modules/database/database-store.js";
import { provisionFirebaseUser, sendKasirProPasswordReset } from "../modules/database/auth.js";

let userList = [];
let activeEditingUser = null;

export function initUsersModule() {
  bindEvents();
  renderUsers();
}

function bindEvents() {
  // Tombol Tambah Pengguna
  $("btn-add-user")?.addEventListener("click", () => openUserModal(null));

  // Tombol Muat Ulang
  $("refresh-users")?.addEventListener("click", () => {
    renderUsers();
    window.KasirProDialog?.success("Berhasil", "Data pengguna berhasil dimuat ulang.");
  });

  // Tombol Backup Database JSON
  $("export-database-backup")?.addEventListener("click", handleExportDatabaseBackup);

  // Search & Filter
  $("user-search")?.addEventListener("input", renderUsersTable);
  $("user-role-filter")?.addEventListener("change", renderUsersTable);
  $("user-status-filter")?.addEventListener("change", renderUsersTable);

  installUserModal();
}

export function renderUsers() {
  const master = readStore(STORE_KEYS.master, {});
  userList = Array.isArray(master.pengguna) ? master.pengguna : [];

  // Jika daftar pengguna kosong, sediakan profil admin awal
  if (!userList.length) {
    userList = [
      {
        id: "admin",
        username: "admin",
        name: "Administrator",
        role: "admin",
        status: "aktif"
      }
    ];
  }

  updateKpis();
  renderUsersTable();
}

function updateKpis() {
  const total = userList.length;
  const adminCount = userList.filter(u => norm(u.role || u["Role"]) === "admin").length;
  const cashierCount = userList.filter(u => norm(u.role || u["Role"]) !== "admin").length;
  const activeCount = userList.filter(u => norm(u.status || u["Status"]) === "aktif").length;

  const totalEl = $("user-total-count");
  if (totalEl) totalEl.textContent = formatNumber(total);

  const adminEl = $("user-admin-count");
  if (adminEl) adminEl.textContent = formatNumber(adminCount);

  const cashierEl = $("user-cashier-count");
  if (cashierEl) cashierEl.textContent = formatNumber(cashierCount);

  const activeEl = $("user-active-count");
  if (activeEl) activeEl.textContent = formatNumber(activeCount);
}

function renderUsersTable() {
  const tbody = $("users-table-body");
  if (!tbody) return;

  const q = norm($("user-search")?.value);
  const roleFilter = norm($("user-role-filter")?.value);
  const statusFilter = norm($("user-status-filter")?.value);

  const filtered = userList.filter(u => {
    const uname = norm(u.username || u["Username"]);
    const name = norm(u.name || u["Nama"]);
    const phone = norm(u.phone || u["Telepon"]);
    const email = norm(u.email || u["Email"]);
    const role = norm(u.role || u["Role"]) === "admin" ? "admin" : "kasir";
    const status = norm(u.status || u["Status"]) === "nonaktif" ? "nonaktif" : "aktif";

    if (q && !uname.includes(q) && !name.includes(q) && !phone.includes(q) && !email.includes(q)) {
      return false;
    }
    if (roleFilter && role !== roleFilter) return false;
    if (statusFilter && status !== statusFilter) return false;

    return true;
  });

  const visibleEl = $("users-visible-count");
  if (visibleEl) visibleEl.textContent = formatNumber(filtered.length);

  const totalResultEl = $("users-total-result-count");
  if (totalResultEl) totalResultEl.textContent = formatNumber(userList.length);

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-table-state" style="text-align:center;padding:24px;">Tidak ada data pengguna yang sesuai pencarian.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(u => {
    const uid = u.id || `usr-${u.username}`;
    const uname = u.username || u["Username"] || "—";
    const name = u.name || u["Nama"] || uname;
    const roleRaw = norm(u.role || u["Role"]);
    const roleLabel = roleRaw === "admin" ? "Administrator" : "Kasir";
    const phone = u.phone || u["Telepon"] || "—";
    const email = u.email || u["Email"] || `${uname}@kasirpro-v2.app`;
    const statusRaw = norm(u.status || u["Status"]);
    const isAktif = statusRaw !== "nonaktif";
    const statusLabel = isAktif ? "Aktif" : "Nonaktif";

    return `
      <tr>
        <td><strong>${escapeHtml(uid)}</strong></td>
        <td><strong>${escapeHtml(name)}</strong></td>
        <td>
          <span class="badge ${roleRaw === 'admin' ? 'badge-primary' : 'badge-info'}" style="padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;">
            ${escapeHtml(roleLabel)}
          </span>
        </td>
        <td><code>${escapeHtml(uname)}</code></td>
        <td>${escapeHtml(phone)}</td>
        <td><small class="text-muted">${escapeHtml(email)}</small></td>
        <td><span style="font-size:12px;color:#059669;"><i class="fa-solid fa-shield-check"></i> Firebase</span></td>
        <td>
          <span class="badge ${isAktif ? 'badge-success' : 'badge-secondary'}" style="padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;">
            ${escapeHtml(statusLabel)}
          </span>
        </td>
        <td>
          <div style="display:flex;gap:6px;">
            <button type="button" class="btn-edit-user button button-small button-secondary" data-username="${escapeHtml(uname)}" title="Edit User">
              <i class="fa-solid fa-pen"></i> Edit
            </button>
            <button type="button" class="btn-reset-user button button-small button-secondary" data-username="${escapeHtml(uname)}" title="Reset Password">
              <i class="fa-solid fa-key"></i> Reset
            </button>
            ${uname !== 'admin' ? `
              <button type="button" class="btn-toggle-user button button-small button-danger" data-username="${escapeHtml(uname)}" title="Aktif/Nonaktifkan">
                <i class="fa-solid ${isAktif ? 'fa-user-slash' : 'fa-user-check'}"></i>
              </button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll(".btn-edit-user").forEach(btn => {
    btn.addEventListener("click", () => {
      const uName = btn.dataset.username;
      const found = userList.find(x => norm(x.username || x["Username"]) === norm(uName));
      if (found) openUserModal(found);
    });
  });

  tbody.querySelectorAll(".btn-reset-user").forEach(btn => {
    btn.addEventListener("click", () => {
      const uName = btn.dataset.username;
      handleResetPassword(uName);
    });
  });

  tbody.querySelectorAll(".btn-toggle-user").forEach(btn => {
    btn.addEventListener("click", () => {
      const uName = btn.dataset.username;
      handleToggleUserStatus(uName);
    });
  });

  // Render Kartu Adaptif Vertikal (Accordion Data Cards)
  const cardList = $("users-card-list");
  if (cardList) {
    if (!filtered.length) {
      cardList.innerHTML = `<div style="text-align:center;padding:28px 16px;color:#94a3b8;background:#fff;border-radius:12px;border:1px dashed #cbd5e1;"><i class="fa-solid fa-users" style="font-size:24px;margin-bottom:8px;display:block;"></i>Tidak ada data pengguna yang sesuai pencarian.</div>`;
    } else {
      cardList.innerHTML = filtered.map(u => {
        const uid = u.id || `usr-${u.username}`;
        const uname = u.username || u["Username"] || "—";
        const name = u.name || u["Nama"] || uname;
        const roleRaw = norm(u.role || u["Role"]);
        const roleLabel = roleRaw === "admin" ? "Administrator" : "Kasir";
        const phone = u.phone || u["Telepon"] || "—";
        const email = u.email || u["Email"] || `${uname}@kasirpro-v2.app`;
        const statusRaw = norm(u.status || u["Status"]);
        const isAktif = statusRaw !== "nonaktif";
        const statusLabel = isAktif ? "Aktif" : "Nonaktif";

        return `
          <div class="responsive-data-card ${roleRaw === 'admin' ? 'card-purple' : 'card-success'}">
            <div class="card-accordion-header" role="button" tabindex="0">
              <div class="card-header-main">
                <div class="card-title-row">
                  <span class="card-title">${escapeHtml(name)}</span>
                  <span class="badge ${roleRaw === 'admin' ? 'badge-primary' : 'badge-info'}" style="padding:3px 8px;border-radius:6px;font-size:11px;font-weight:700;">
                    ${escapeHtml(roleLabel)}
                  </span>
                </div>
                <div class="card-subtitle-row">
                  <span><i class="fa-solid fa-user"></i> <code>${escapeHtml(uname)}</code></span>
                  <span><i class="fa-solid fa-phone"></i> ${escapeHtml(phone)}</span>
                  <span class="badge ${isAktif ? 'badge-success' : 'badge-secondary'}" style="padding:2px 6px;border-radius:4px;font-size:10.5px;">${escapeHtml(statusLabel)}</span>
                </div>
              </div>
              <div class="card-toggle-icon"><i class="fa-solid fa-chevron-down"></i></div>
            </div>
            <div class="card-accordion-body">
              <div class="card-detail-grid">
                <div class="card-detail-item">
                  <span class="card-detail-label">ID Pengguna</span>
                  <span class="card-detail-value"><code>${escapeHtml(uid)}</code></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Username Login</span>
                  <span class="card-detail-value"><code>${escapeHtml(uname)}</code></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Nomor Telepon</span>
                  <span class="card-detail-value">${escapeHtml(phone)}</span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Email Terdaftar</span>
                  <span class="card-detail-value"><small class="text-muted">${escapeHtml(email)}</small></span>
                </div>
                <div class="card-detail-item">
                  <span class="card-detail-label">Autentikasi</span>
                  <span class="card-detail-value" style="color:#059669;font-weight:700;"><i class="fa-solid fa-shield-check"></i> Firebase</span>
                </div>
              </div>
              <div class="card-action-bar">
                <button type="button" class="btn-edit-user button button-small button-secondary" data-username="${escapeHtml(uname)}" title="Edit User">
                  <i class="fa-solid fa-pen"></i> Edit Profil
                </button>
                <button type="button" class="btn-reset-user button button-small button-secondary" data-username="${escapeHtml(uname)}" title="Reset Password">
                  <i class="fa-solid fa-key"></i> Reset Sandi
                </button>
                ${uname !== 'admin' ? `
                  <button type="button" class="btn-toggle-user button button-small button-danger" data-username="${escapeHtml(uname)}" title="Aktif/Nonaktifkan">
                    <i class="fa-solid ${isAktif ? 'fa-user-slash' : 'fa-user-check'}"></i> ${isAktif ? 'Nonaktifkan' : 'Aktifkan'}
                  </button>
                ` : ''}
              </div>
            </div>
          </div>
        `;
      }).join("");

      // Accordion toggle handler
      cardList.querySelectorAll(".card-accordion-header").forEach(header => {
        header.addEventListener("click", () => {
          const card = header.closest(".responsive-data-card");
          if (card) card.classList.toggle("is-expanded");
        });
      });

      cardList.querySelectorAll(".btn-edit-user").forEach(btn => {
        btn.addEventListener("click", () => {
          const uName = btn.dataset.username;
          const found = userList.find(x => norm(x.username || x["Username"]) === norm(uName));
          if (found) openUserModal(found);
        });
      });

      cardList.querySelectorAll(".btn-reset-user").forEach(btn => {
        btn.addEventListener("click", () => {
          const uName = btn.dataset.username;
          handleResetPassword(uName);
        });
      });

      cardList.querySelectorAll(".btn-toggle-user").forEach(btn => {
        btn.addEventListener("click", () => {
          const uName = btn.dataset.username;
          handleToggleUserStatus(uName);
        });
      });
    }
  }
}

function installUserModal() {
  if ($("modal-user-form")) return;

  const modalHtml = `
    <div id="modal-user-form" class="kp-dialog-v4" hidden>
      <div class="kp-dialog-v4__backdrop"></div>
      <section class="kp-dialog-v4__card" style="width:min(94vw,480px);" role="dialog">
        <header style="padding:18px 20px 12px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
          <h2 id="user-modal-title" style="font-size:16px;font-weight:800;margin:0;">Tambah Pengguna</h2>
          <button type="button" id="close-modal-user" class="button button-small button-secondary" style="padding:4px 8px;"><i class="fa-solid fa-xmark"></i></button>
        </header>
        <div style="padding:20px;text-align:left;">
          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Username <span class="text-danger">*</span></label>
          <input type="text" id="input-user-username" required style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;margin-bottom:14px;" placeholder="Contoh: kasir1 atau admin2">

          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Nama Lengkap <span class="text-danger">*</span></label>
          <input type="text" id="input-user-name" required style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;margin-bottom:14px;" placeholder="Contoh: Siti Rahma / Kasir Shift 1">

          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Peran (Role) <span class="text-danger">*</span></label>
          <select id="input-user-role" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;margin-bottom:14px;">
            <option value="cashier">Kasir (Hanya Akses POS)</option>
            <option value="admin">Administrator (Akses Penuh Manajemen)</option>
          </select>

          <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Nomor Telepon</label>
          <input type="tel" id="input-user-phone" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;margin-bottom:14px;" placeholder="08xxxxxxxxxx">

          <div id="wrap-user-password">
            <label style="display:block;font-size:13px;font-weight:700;color:#1e293b;margin-bottom:6px;">Password Awal <span class="text-danger">*</span></label>
            <input type="password" id="input-user-password" style="width:100%;min-height:40px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;color:#0f172a;" placeholder="Minimal 6 karakter">
            <small style="color:#64748b;font-size:11.5px;display:block;margin-top:4px;">Digunakan untuk login pertama kali di aplikasi kasir atau manajemen.</small>
          </div>
        </div>
        <footer style="padding:12px 20px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;justify-content:flex-end;gap:8px;">
          <button type="button" id="cancel-user-form" class="button button-secondary">Batal</button>
          <button type="button" id="save-user-form" class="button button-primary"><i class="fa-solid fa-floppy-disk"></i> Simpan Pengguna</button>
        </footer>
      </section>
    </div>
  `;
  document.body.insertAdjacentHTML("beforeend", modalHtml);

  $("close-modal-user")?.addEventListener("click", closeUserModal);
  $("cancel-user-form")?.addEventListener("click", closeUserModal);
  $("save-user-form")?.addEventListener("click", handleSaveUser);
}

function openUserModal(user = null) {
  activeEditingUser = user;
  const modal = $("modal-user-form");
  if (!modal) return;

  $("user-modal-title").textContent = user ? "Edit Informasi Pengguna" : "Tambah Pengguna Baru";
  $("input-user-username").value = user ? (user.username || user["Username"] || "") : "";
  $("input-user-username").disabled = Boolean(user);
  $("input-user-name").value = user ? (user.name || user["Nama"] || "") : "";
  $("input-user-role").value = (user?.role || user?.["Role"] || "cashier").toLowerCase() === "admin" ? "admin" : "cashier";
  $("input-user-phone").value = user ? (user.phone || user["Telepon"] || "") : "";

  const passWrap = $("wrap-user-password");
  if (passWrap) passWrap.style.display = user ? "none" : "block";

  modal.hidden = false;
  setTimeout(() => $("input-user-name")?.focus(), 50);
}

function closeUserModal() {
  const modal = $("modal-user-form");
  if (modal) modal.hidden = true;
  activeEditingUser = null;
}

async function handleSaveUser() {
  const username = norm($("input-user-username")?.value);
  const name = text($("input-user-name")?.value);
  const role = $("input-user-role")?.value || "cashier";
  const phone = text($("input-user-phone")?.value);
  const password = $("input-user-password")?.value || "";

  if (!username || !name) {
    window.KasirProDialog?.warning("Perhatian", "Username dan Nama Lengkap wajib diisi.");
    return;
  }

  const master = readStore(STORE_KEYS.master, {});
  const users = Array.isArray(master.pengguna) ? [...master.pengguna] : [];

  let targetUser = null;
  if (activeEditingUser) {
    const idx = users.findIndex(u => norm(u.username || u["Username"]) === username);
    if (idx >= 0) {
      users[idx].name = name;
      users[idx]["Nama"] = name;
      users[idx].role = role;
      users[idx]["Role"] = role;
      users[idx].phone = phone;
      users[idx]["Telepon"] = phone;
      targetUser = users[idx];
    }
  } else {
    if (password.length < 6) {
      window.KasirProDialog?.warning("Perhatian", "Password awal minimal 6 karakter.");
      return;
    }

    // Provision akun ke Firebase Auth
    try {
      const res = await provisionFirebaseUser({
        username,
        name,
        role,
        password,
        phone,
        status: "aktif"
      });

      if (res.status === "failed") {
        throw new Error(res.reason || "Gagal membuat akun login Firebase.");
      }
    } catch (authErr) {
      window.KasirProDialog?.error("Gagal Akun Login", authErr.message);
      return;
    }

    targetUser = {
      id: `usr-${username}`,
      username,
      name,
      role,
      phone,
      email: `${username}@kasirpro-v2.app`,
      status: "aktif"
    };
  }

  try {
    await writeMasterDelta({ pengguna: [targetUser] });
    closeUserModal();
    renderUsers();
    window.KasirProDialog?.success("Berhasil", `Pengguna "${name}" (${username}) berhasil disimpan.`);
  } catch (err) {
    window.KasirProDialog?.error("Gagal Menyimpan", err.message);
  }
}

async function handleResetPassword(username) {
  const confirmed = await window.KasirProDialog?.confirm(
    "Reset Password",
    `Kirim instruksi reset password untuk akun "${username}"?`
  );
  if (!confirmed) return;

  try {
    await sendKasirProPasswordReset({ username });
    window.KasirProDialog?.success("Instruksi Dikirim", `Instruksi pembaruan kata sandi untuk akun "${username}" telah diproses.`);
  } catch (err) {
    window.KasirProDialog?.error("Gagal Reset Password", err.message);
  }
}

async function handleToggleUserStatus(username) {
  const master = readStore(STORE_KEYS.master, {});
  const users = Array.isArray(master.pengguna) ? [...master.pengguna] : [];
  const target = users.find(u => norm(u.username || u["Username"]) === username);
  if (!target) return;

  const currentStatus = norm(target.status || target["Status"]);
  const newStatus = currentStatus === "aktif" ? "nonaktif" : "aktif";

  const updatedTarget = {
    ...target,
    status: newStatus,
    Status: newStatus
  };

  try {
    await writeMasterDelta({ pengguna: [updatedTarget] });
    renderUsers();
    window.KasirProDialog?.success("Status Diperbarui", `Akun "${username}" sekarang ${newStatus.toUpperCase()}.`);
  } catch (err) {
    window.KasirProDialog?.error("Gagal Memperbarui Status", err.message);
  }
}

/**
 * Backup Database Penuh dalam format JSON
 */
function handleExportDatabaseBackup() {
  try {
    const backupData = {
      app: "KasirPro V2",
      exportedAt: new Date().toISOString(),
      version: "2.0",
      stores: {
        master: readStore(STORE_KEYS.master, {}),
        purchaseInvoices: readStore(STORE_KEYS.invoices, []),
        stockMovements: readStore(STORE_KEYS.movements, []),
        stockOpnames: readStore(STORE_KEYS.opnames, []),
        sales: readStore(STORE_KEYS.sales, [])
      }
    };

    const jsonStr = JSON.stringify(backupData, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const fileName = `KasirPro_Backup_${ts}.json`;

    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);

    const master = backupData.stores.master;
    const prodCount = (master.produk || []).length;
    const invCount = backupData.stores.purchaseInvoices.length;
    const salesCount = backupData.stores.sales.length;

    window.KasirProDialog?.success(
      "Backup Database Berhasil",
      `Cadangan database JSON berhasil diunduh:\n${fileName}\n\nTermasuk:\n• ${prodCount} Master Produk\n• ${invCount} Faktur Pembelian\n• ${salesCount} Transaksi Penjualan\n• Riwayat Mutasi & Opname Stok`
    );
  } catch (err) {
    console.error("[Users] Error exporting database backup:", err);
    window.KasirProDialog?.error("Gagal Backup Database", err.message || "Terjadi kesalahan saat membuat file backup JSON.");
  }
}
