/**
 * management/management-customers.js
 * Modul Manajemen Pelanggan (Member), Loyalty Poin, Katalog Hadiah, & Broadcast Promo WhatsApp
 * KasirPro V2
 */

import {
  STORE_KEYS,
  readStore,
  writeMasterDelta
} from "../modules/database/database-store.js";

const $ = (id) => document.getElementById(id);
const text = (v) => String(v ?? "").trim();
const norm = (v) => text(v).toLowerCase();
const num = (v) => Number(String(v ?? 0).replace(/[^0-9.-]/g, "")) || 0;

function formatNumber(n) {
  return Number(n || 0).toLocaleString("id-ID");
}

function rupiah(n) {
  return "Rp " + formatNumber(n);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function cleanWaPhone(phone) {
  let p = String(phone || "").replace(/[^0-9]/g, "");
  if (p.startsWith("0")) p = "62" + p.slice(1);
  else if (p.startsWith("8")) p = "628" + p.slice(1);
  return p;
}

let activeEditingCustomer = null;
let activeRedeemCustomer = null;

function getCustomersList() {
  const master = readStore(STORE_KEYS.master, {});
  if (!Array.isArray(master.pelanggan)) master.pelanggan = [];
  return master.pelanggan;
}

function getRewardsList() {
  const master = readStore(STORE_KEYS.master, {});
  if (!Array.isArray(master.hadiah)) master.hadiah = [];
  return master.hadiah;
}

function getPointMutations() {
  const master = readStore(STORE_KEYS.master, {});
  if (!Array.isArray(master.mutasi_poin)) master.mutasi_poin = [];
  return master.mutasi_poin;
}

function getStoreSettings() {
  const master = readStore(STORE_KEYS.master, {});
  return (Array.isArray(master.pengaturan_toko) && master.pengaturan_toko[0]) || {};
}

/**
 * 1. RENDER DAFTAR PELANGGAN / MEMBER
 */
export function renderCustomers() {
  const container = document.querySelector('[data-view-section="customers"]');
  if (!container) return;

  const customers = getCustomersList();
  const searchInput = $("input-search-customers");
  const q = norm(searchInput?.value);

  const filtered = customers.filter(c => {
    if (!q) return true;
    return norm(c.name).includes(q) || norm(c.phone).includes(q);
  });

  // Urutkan berdasarkan kunjungan terakhir / poin terbanyak
  filtered.sort((a, b) => (num(b.totalPoints) - num(a.totalPoints)));

  // Update Summary KPI
  const totalMemberEl = $("cust-kpi-total-members");
  const totalPointsEl = $("cust-kpi-total-points");
  const totalSpentEl = $("cust-kpi-total-spent");

  const totalPointsSum = customers.reduce((acc, c) => acc + num(c.totalPoints), 0);
  const totalSpentSum = customers.reduce((acc, c) => acc + num(c.totalSpent), 0);

  if (totalMemberEl) totalMemberEl.textContent = formatNumber(customers.length);
  if (totalPointsEl) totalPointsEl.textContent = formatNumber(totalPointsSum);
  if (totalSpentEl) totalSpentEl.textContent = rupiah(totalSpentSum);

  // Render Tabel Desktop
  const tbody = $("table-customers-tbody");
  if (tbody) {
    if (!filtered.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align:center;padding:32px;color:#94a3b8;">
            <i class="fa-solid fa-users-slash" style="font-size:24px;margin-bottom:8px;display:block;"></i>
            Belum ada data member yang sesuai. Klik tombol <strong>+ Tambah Member</strong> untuk mendaftarkan pelanggan baru.
          </td>
        </tr>
      `;
    } else {
      tbody.innerHTML = filtered.map((c, idx) => {
        const lastVisitStr = c.lastVisit ? new Date(c.lastVisit).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" }) : "—";
        return `
          <tr data-phone="${escapeHtml(c.phone)}">
            <td style="font-weight:800;color:#0f2a43;">
              ${escapeHtml(c.name)}
              <div style="font-size:11px;color:#64748b;font-weight:600;"><i class="fa-solid fa-phone" style="font-size:10px;"></i> ${escapeHtml(c.phone)}</div>
            </td>
            <td>
              <span class="badge" style="background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;font-weight:800;padding:3px 9px;border-radius:12px;font-size:12px;">
                <i class="fa-solid fa-coins" style="color:#f59e0b;margin-right:3px;"></i> ${formatNumber(c.totalPoints || 0)} Poin
              </span>
            </td>
            <td style="font-weight:700;color:#0f2a43;">${rupiah(c.totalSpent || 0)}</td>
            <td style="text-align:center;font-weight:700;">${formatNumber(c.visitCount || 0)}x</td>
            <td style="font-size:12px;color:#64748b;">${lastVisitStr}</td>
            <td>
              <div style="display:flex;align-items:center;gap:5px;">
                <button type="button" class="button button-small btn-cust-wa" data-phone="${escapeHtml(c.phone)}" style="background:#25d366;color:#fff;border:none;padding:4px 8px;font-size:11px;border-radius:5px;" title="Chat WhatsApp Pelanggan">
                  <i class="fa-brands fa-whatsapp"></i> Chat WA
                </button>
                <button type="button" class="button button-small button-primary btn-cust-redeem" data-phone="${escapeHtml(c.phone)}" style="padding:4px 8px;font-size:11px;" title="Tukar Poin Hadiah">
                  <i class="fa-solid fa-gift"></i> Tukar Poin
                </button>
                <button type="button" class="button button-small button-secondary btn-cust-history" data-phone="${escapeHtml(c.phone)}" style="padding:4px 8px;font-size:11px;" title="Riwayat Mutasi Poin">
                  <i class="fa-solid fa-clock-rotate-left"></i>
                </button>
                <button type="button" class="button button-small button-secondary btn-cust-edit" data-phone="${escapeHtml(c.phone)}" style="padding:4px 8px;font-size:11px;" title="Edit Data Member">
                  <i class="fa-solid fa-pen"></i>
                </button>
                <button type="button" class="button button-small button-danger btn-cust-delete" data-phone="${escapeHtml(c.phone)}" style="padding:4px 8px;font-size:11px;" title="Hapus Member">
                  <i class="fa-solid fa-trash"></i>
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join("");
    }
  }

  // Render Kartu Mobile/Tablet
  const cardList = $("card-list-customers");
  if (cardList) {
    if (!filtered.length) {
      cardList.innerHTML = `
        <div style="text-align:center;padding:24px;color:#94a3b8;font-size:12.5px;">
          Belum ada data member yang sesuai.
        </div>
      `;
    } else {
      cardList.innerHTML = filtered.map(c => {
        const lastVisitStr = c.lastVisit ? new Date(c.lastVisit).toLocaleDateString("id-ID") : "—";
        return `
          <div class="responsive-data-card" style="background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,0.02);">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;">
              <div>
                <strong style="font-size:14px;color:#0f2a43;">${escapeHtml(c.name)}</strong>
                <div style="font-size:12px;color:#64748b;margin-top:2px;">
                  <i class="fa-brands fa-whatsapp" style="color:#25d366;"></i> ${escapeHtml(c.phone)}
                </div>
              </div>
              <span class="badge" style="background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;font-weight:800;padding:3px 9px;border-radius:12px;font-size:12px;">
                <i class="fa-solid fa-coins" style="color:#f59e0b;"></i> ${formatNumber(c.totalPoints || 0)} Poin
              </span>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:10px 0;padding:8px;background:#f8fafc;border-radius:6px;font-size:11.5px;">
              <div><span style="color:#64748b;">Total Belanja:</span> <strong>${rupiah(c.totalSpent || 0)}</strong></div>
              <div><span style="color:#64748b;">Kunjungan:</span> <strong>${formatNumber(c.visitCount || 0)} kali</strong></div>
              <div style="grid-column:1/-1;"><span style="color:#64748b;">Terakhir Belanja:</span> <strong>${lastVisitStr}</strong></div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button type="button" class="button button-small btn-cust-wa" data-phone="${escapeHtml(c.phone)}" style="background:#25d366;color:#fff;border:none;flex:1;min-width:90px;font-size:11.5px;padding:5px;">
                <i class="fa-brands fa-whatsapp"></i> Chat WA
              </button>
              <button type="button" class="button button-small button-primary btn-cust-redeem" data-phone="${escapeHtml(c.phone)}" style="flex:1;min-width:90px;font-size:11.5px;padding:5px;">
                <i class="fa-solid fa-gift"></i> Tukar Poin
              </button>
              <button type="button" class="button button-small button-secondary btn-cust-history" data-phone="${escapeHtml(c.phone)}" style="padding:5px 8px;" title="Riwayat Poin">
                <i class="fa-solid fa-clock-rotate-left"></i>
              </button>
              <button type="button" class="button button-small button-secondary btn-cust-edit" data-phone="${escapeHtml(c.phone)}" style="padding:5px 8px;" title="Edit Member">
                <i class="fa-solid fa-pen"></i>
              </button>
              <button type="button" class="button button-small button-danger btn-cust-delete" data-phone="${escapeHtml(c.phone)}" style="padding:5px 8px;" title="Hapus Member">
                <i class="fa-solid fa-trash"></i>
              </button>
            </div>
          </div>
        `;
      }).join("");
    }
  }

  // Bind Event Listeners per baris
  container.querySelectorAll(".btn-cust-wa").forEach(btn => {
    btn.addEventListener("click", () => {
      const c = customers.find(x => x.phone === btn.dataset.phone);
      if (c) sendDirectCustomerWhatsApp(c);
    });
  });

  container.querySelectorAll(".btn-cust-redeem").forEach(btn => {
    btn.addEventListener("click", () => {
      const c = customers.find(x => x.phone === btn.dataset.phone);
      if (c) openRedeemPointsModal(c);
    });
  });

  container.querySelectorAll(".btn-cust-history").forEach(btn => {
    btn.addEventListener("click", () => {
      const c = customers.find(x => x.phone === btn.dataset.phone);
      if (c) openPointsHistoryModal(c);
    });
  });

  container.querySelectorAll(".btn-cust-edit").forEach(btn => {
    btn.addEventListener("click", () => {
      const c = customers.find(x => x.phone === btn.dataset.phone);
      if (c) openEditCustomerModal(c);
    });
  });

  container.querySelectorAll(".btn-cust-delete").forEach(btn => {
    btn.addEventListener("click", () => {
      const c = customers.find(x => x.phone === btn.dataset.phone);
      if (c) handleDeleteCustomer(c);
    });
  });
}

/**
 * 2. MODAL FORM TAMBAH & EDIT MEMBER
 */
export function openCreateCustomerModal() {
  activeEditingCustomer = null;
  const modal = $("modal-customer-form");
  if (!modal) return;

  $("modal-cust-form-title").innerHTML = '<i class="fa-solid fa-user-plus" style="color:#0284c7;margin-right:6px;"></i> Tambah Member Baru';
  $("input-cust-name").value = "";
  $("input-cust-phone").value = "";
  $("input-cust-phone").readOnly = false;
  $("input-cust-phone").style.background = "#fff";
  $("input-cust-initial-points").value = "0";
  $("box-cust-initial-points").hidden = false;

  modal.hidden = false;
  setTimeout(() => $("input-cust-name")?.focus(), 60);
}

export function openEditCustomerModal(cust) {
  if (!cust) return;
  activeEditingCustomer = cust;
  const modal = $("modal-customer-form");
  if (!modal) return;

  $("modal-cust-form-title").innerHTML = '<i class="fa-solid fa-user-pen" style="color:#0284c7;margin-right:6px;"></i> Edit Data Member';
  $("input-cust-name").value = cust.name || "";
  $("input-cust-phone").value = cust.phone || "";
  $("input-cust-phone").readOnly = true;
  $("input-cust-phone").style.background = "#f1f5f9";
  $("box-cust-initial-points").hidden = true;

  modal.hidden = false;
  setTimeout(() => $("input-cust-name")?.focus(), 60);
}

export function closeCustomerModal() {
  const modal = $("modal-customer-form");
  if (modal) modal.hidden = true;
  activeEditingCustomer = null;
}

async function handleSaveCustomerForm(e) {
  e.preventDefault();
  const name = text($("input-cust-name")?.value);
  const phone = text($("input-cust-phone")?.value).replace(/[^0-9]/g, "");

  if (!name) return window.KasirProDialog?.warning("Perhatian", "Nama member wajib diisi.");
  if (!phone || phone.length < 8) return window.KasirProDialog?.warning("Perhatian", "Nomor WhatsApp / HP tidak valid.");

  const customers = getCustomersList();

  if (activeEditingCustomer) {
    // Mode EDIT
    const target = customers.find(c => c.phone === activeEditingCustomer.phone);
    if (!target) return window.KasirProDialog?.error("Gagal", "Data member tidak ditemukan.");

    target.name = name;
    await writeMasterDelta({ pelanggan: [target] });
    closeCustomerModal();
    renderCustomers();
    window.KasirProDialog?.success("Berhasil Disimpan", `Data member "${name}" (${target.phone}) berhasil diperbarui.`);
  } else {
    // Mode TAMBAH BARU
    const existing = customers.find(c => c.phone === phone || cleanWaPhone(c.phone) === cleanWaPhone(phone));
    if (existing) {
      return window.KasirProDialog?.warning("Nomor Sudah Terdaftar", `Member dengan nomor ${phone} sudah terdaftar atas nama "${existing.name}".`);
    }

    const initPoints = Math.max(0, parseInt($("input-cust-initial-points")?.value || "0", 10) || 0);

    const newCust = {
      id: `CUST-${phone}`,
      name,
      phone,
      totalPoints: initPoints,
      totalSpent: 0,
      visitCount: 0,
      createdAt: new Date().toISOString()
    };

    customers.push(newCust);
    await writeMasterDelta({ pelanggan: [newCust] });

    if (initPoints > 0) {
      const mutLog = {
        id: `PTS-INIT-${Date.now()}`,
        type: "EARN",
        customerPhone: phone,
        customerName: name,
        points: initPoints,
        reference: "Bonus Pendaftaran Awal",
        balanceAfter: initPoints,
        at: new Date().toISOString(),
        note: "Poin awal pendaftaran member baru"
      };
      getPointMutations().unshift(mutLog);
      await writeMasterDelta({ mutasi_poin: [mutLog] });
    }

    closeCustomerModal();
    renderCustomers();
    window.KasirProDialog?.success("Member Berhasil Didaftarkan", `Member "${name}" (${phone}) berhasil didaftarkan ke sistem.`);
  }
}

async function handleDeleteCustomer(cust) {
  const confirmed = await window.KasirProDialog?.confirm?.(
    "Hapus Member?",
    `Apakah Anda yakin ingin menghapus member "${cust.name}" (${cust.phone})?\nSaldo ${formatNumber(cust.totalPoints)} poin akan dihapus.`
  );
  if (!confirmed) return;

  const customers = getCustomersList();
  const idx = customers.findIndex(c => c.phone === cust.phone);
  if (idx >= 0) {
    customers.splice(idx, 1);
    // Mark deleted in delta
    await writeMasterDelta({ pelanggan: [{ ...cust, _isDeleted: true }] });
    renderCustomers();
    window.KasirProDialog?.success("Member Dihapus", `Member "${cust.name}" telah dihapus.`);
  }
}

/**
 * 3. KATALOG HADIAH & PENUKARAN POIN (REDEEM REWARDS)
 */
export function openManageRewardsModal() {
  const modal = $("modal-manage-rewards");
  if (!modal) return;
  renderRewardsListInModal();
  modal.hidden = false;
}

export function closeManageRewardsModal() {
  const modal = $("modal-manage-rewards");
  if (modal) modal.hidden = true;
}

function renderRewardsListInModal() {
  const listContainer = $("list-rewards-container");
  if (!listContainer) return;
  const rewards = getRewardsList();

  if (!rewards.length) {
    listContainer.innerHTML = `
      <div style="text-align:center;padding:16px;color:#94a3b8;font-size:12px;">
        Belum ada katalog hadiah yang ditambahkan oleh owner.
      </div>
    `;
    return;
  }

  listContainer.innerHTML = rewards.map((r, idx) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#fff;border:1px solid #e2e8f0;border-radius:8px;margin-bottom:6px;">
      <div>
        <strong style="color:#0f2a43;font-size:13px;">${escapeHtml(r.name)}</strong>
        <div style="font-size:11px;color:#64748b;">${escapeHtml(r.note || "Hadiah penukaran poin member")}</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="badge" style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;font-weight:800;padding:3px 9px;border-radius:12px;font-size:11.5px;">
          <i class="fa-solid fa-star" style="color:#f59e0b;"></i> ${formatNumber(r.pointsRequired)} Poin
        </span>
        <button type="button" class="button button-small button-danger btn-delete-reward" data-index="${idx}" style="padding:3px 7px;font-size:11px;" title="Hapus Hadiah">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    </div>
  `).join("");

  listContainer.querySelectorAll(".btn-delete-reward").forEach(btn => {
    btn.addEventListener("click", async () => {
      const idx = parseInt(btn.dataset.index, 10);
      const rewards = getRewardsList();
      const removed = rewards.splice(idx, 1)[0];
      if (removed) {
        await writeMasterDelta({ hadiah: [{ ...removed, _isDeleted: true }] });
        renderRewardsListInModal();
      }
    });
  });
}

async function handleAddRewardSubmit(e) {
  e.preventDefault();
  const nameInput = $("add-reward-name");
  const pointsInput = $("add-reward-points");
  const noteInput = $("add-reward-note");

  const name = text(nameInput?.value);
  const points = parseInt(pointsInput?.value || "0", 10);
  const note = text(noteInput?.value);

  if (!name) return window.KasirProDialog?.warning("Perhatian", "Nama hadiah wajib diisi.");
  if (points <= 0) return window.KasirProDialog?.warning("Perhatian", "Poin yang dibutuhkan harus minimal 1 poin.");

  const rewards = getRewardsList();
  const newReward = {
    id: `RWD-${Date.now()}`,
    name,
    pointsRequired: points,
    note,
    createdAt: new Date().toISOString()
  };

  rewards.push(newReward);
  await writeMasterDelta({ hadiah: [newReward] });

  if (nameInput) nameInput.value = "";
  if (pointsInput) pointsInput.value = "";
  if (noteInput) noteInput.value = "";

  renderRewardsListInModal();
  window.KasirProDialog?.success("Hadiah Ditambahkan", `Hadiah "${name}" (${formatNumber(points)} Poin) berhasil masuk katalog.`);
}

export function openRedeemPointsModal(customer) {
  if (!customer) return;
  activeRedeemCustomer = customer;
  const modal = $("modal-redeem-points");
  if (!modal) return;

  $("redeem-cust-name").textContent = customer.name;
  $("redeem-cust-phone").textContent = customer.phone;
  $("redeem-cust-points").textContent = `${formatNumber(customer.totalPoints || 0)} Poin`;

  // Isi dropdown pilihan hadiah
  const rewards = getRewardsList();
  const selectEl = $("redeem-reward-select");
  if (selectEl) {
    selectEl.innerHTML = '<option value="">-- Pilih Hadiah dari Katalog Owner --</option>' +
      rewards.map(r => `
        <option value="${escapeHtml(r.name)}" data-points="${r.pointsRequired}">
          ${escapeHtml(r.name)} (${formatNumber(r.pointsRequired)} Poin)
        </option>
      `).join("") +
      '<option value="__CUSTOM__">-- Penukaran / Potong Poin Manual --</option>';
  }

  $("redeem-points-custom").value = "";
  $("redeem-points-custom-box").hidden = true;
  $("redeem-note").value = "";

  modal.hidden = false;
}

export function closeRedeemPointsModal() {
  const modal = $("modal-redeem-points");
  if (modal) modal.hidden = true;
  activeRedeemCustomer = null;
}

async function handleExecuteRedeemPoints(e) {
  e.preventDefault();
  if (!activeRedeemCustomer) return;

  const selectEl = $("redeem-reward-select");
  const selectedVal = selectEl?.value;
  if (!selectedVal) return window.KasirProDialog?.warning("Pilih Hadiah", "Silakan pilih hadiah yang ingin ditukarkan.");

  let rewardName = selectedVal;
  let pointsToDeduct = 0;

  if (selectedVal === "__CUSTOM__") {
    rewardName = text($("redeem-note")?.value) || "Penukaran Poin Manual";
    pointsToDeduct = parseInt($("redeem-points-custom")?.value || "0", 10);
  } else {
    const opt = selectEl.options[selectEl.selectedIndex];
    pointsToDeduct = parseInt(opt.dataset.points || "0", 10);
  }

  if (pointsToDeduct <= 0) {
    return window.KasirProDialog?.warning("Perhatian", "Jumlah poin yang ditukarkan harus lebih dari 0.");
  }

  const curPoints = num(activeRedeemCustomer.totalPoints || 0);
  if (curPoints < pointsToDeduct) {
    return window.KasirProDialog?.error(
      "Poin Tidak Cukup",
      `Saldo poin member (${formatNumber(curPoints)} Poin) tidak mencukupi untuk menukar hadiah ini (${formatNumber(pointsToDeduct)} Poin dibutuhkan).`
    );
  }

  const confirmed = await window.KasirProDialog?.confirm?.(
    "Konfirmasi Penukaran Hadiah",
    `Tukarkan hadiah:\n"${rewardName}" seharga ${formatNumber(pointsToDeduct)} Poin?\n\nSaldo poin ${activeRedeemCustomer.name} akan berkurang dari ${formatNumber(curPoints)} menjadi ${formatNumber(curPoints - pointsToDeduct)} Poin.`
  );
  if (!confirmed) return;

  const newBalance = curPoints - pointsToDeduct;
  activeRedeemCustomer.totalPoints = newBalance;

  // Catat log mutasi poin
  const now = new Date().toISOString();
  const pointLog = {
    id: `PTS-RED-${Date.now()}`,
    type: "REDEEM",
    customerPhone: activeRedeemCustomer.phone,
    customerName: activeRedeemCustomer.name,
    points: -pointsToDeduct,
    reference: rewardName,
    balanceAfter: newBalance,
    at: now,
    createdAt: now,
    note: `Penukaran hadiah: ${rewardName}`
  };

  getPointMutations().unshift(pointLog);
  await writeMasterDelta({
    pelanggan: [activeRedeemCustomer],
    mutasi_poin: [pointLog]
  });

  const redeemedCustomer = activeRedeemCustomer;
  closeRedeemPointsModal();
  renderCustomers();

  // Dialog sukses + tawaran kirim ucapan selamat via WhatsApp
  const sendWa = await window.KasirProDialog?.confirm?.(
    "Penukaran Berhasil!",
    `Penukaran hadiah "${rewardName}" berhasil diproses.\nSisa saldo poin ${redeemedCustomer.name}: ${formatNumber(newBalance)} Poin.\n\nKirim ucapan konfirmasi ke WhatsApp pelanggan sekarang?`
  );

  if (sendWa) {
    const st = getStoreSettings();
    const storeName = st["Nama Toko"] || st["Nama Apotek"] || "Apotek Doa Ibu";
    const waPhone = cleanWaPhone(redeemedCustomer.phone);
    const msg = `*SELAMAT! PENUKARAN HADIAH BERHASIL* 🎉\n` +
      `Halo Kak *${redeemedCustomer.name}*,\n\n` +
      `Penukaran hadiah di *${storeName}* telah berhasil:\n` +
      `• Hadiah : *${rewardName}*\n` +
      `• Poin Ditukar : -${formatNumber(pointsToDeduct)} Poin\n` +
      `• *Sisa Saldo Poin Anda : ${formatNumber(newBalance)} Poin*\n\n` +
      `Terima kasih telah menjadi pelanggan setia kami. Terus kumpulkan poin belanja Anda! 🙏`;

    window.open(`https://wa.me/${waPhone}?text=${encodeURIComponent(msg)}`, "_blank");
  }
}

/**
 * 4. RIWAYAT MUTASI POIN MEMBER
 */
export function openPointsHistoryModal(customer) {
  if (!customer) return;
  const modal = $("modal-points-history");
  if (!modal) return;

  $("history-cust-title").textContent = `Riwayat Poin: ${customer.name} (${customer.phone})`;
  $("history-cust-balance").textContent = `${formatNumber(customer.totalPoints || 0)} Poin`;

  const mutations = getPointMutations().filter(m => m.customerPhone === customer.phone);
  const tbody = $("table-points-history-tbody");

  if (tbody) {
    if (!mutations.length) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align:center;padding:24px;color:#94a3b8;font-size:12px;">
            Belum ada riwayat mutasi poin untuk member ini.
          </td>
        </tr>
      `;
    } else {
      tbody.innerHTML = mutations.map(m => {
        const isEarn = m.type === "EARN" || num(m.points) > 0;
        const color = isEarn ? "#059669" : "#dc2626";
        const sign = isEarn ? "+" : "";
        const dateStr = m.at ? new Date(m.at).toLocaleString("id-ID") : "—";
        return `
          <tr>
            <td style="font-size:11.5px;color:#64748b;">${dateStr}</td>
            <td>
              <span class="badge" style="background:${isEarn ? '#ecfdf5' : '#fef2f2'};color:${color};font-weight:700;font-size:11px;">
                ${isEarn ? 'Perolehan Belanja' : 'Penukaran Hadiah'}
              </span>
            </td>
            <td style="font-weight:800;color:${color};">${sign}${formatNumber(m.points)} Poin</td>
            <td style="font-weight:700;color:#0f2a43;">${formatNumber(m.balanceAfter || 0)} Poin</td>
            <td style="font-size:11.5px;color:#475569;">${escapeHtml(m.reference || m.note || "—")}</td>
          </tr>
        `;
      }).join("");
    }
  }

  modal.hidden = false;
}

export function closePointsHistoryModal() {
  const modal = $("modal-points-history");
  if (modal) modal.hidden = true;
}

/**
 * 5. DIRECT WHATSAPP CHAT & BROADCAST PROMO
 */
function sendDirectCustomerWhatsApp(customer) {
  if (!customer) return;
  const st = getStoreSettings();
  const storeName = st["Nama Toko"] || st["Nama Apotek"] || "Apotek Doa Ibu";
  const waPhone = cleanWaPhone(customer.phone);

  const defaultMsg = `Halo Kak *${customer.name}*,\n` +
    `Terima kasih telah menjadi pelanggan setia di *${storeName}*.\n` +
    `Saldo poin loyalty Kakak saat ini: *${formatNumber(customer.totalPoints || 0)} Poin*.\n` +
    `Tukarkan poin Anda dengan hadiah menarik di toko kami! 🙏`;

  window.open(`https://wa.me/${waPhone}?text=${encodeURIComponent(defaultMsg)}`, "_blank");
}

export function openBroadcastModal() {
  const modal = $("modal-broadcast-promo");
  if (!modal) return;
  updateBroadcastPreview();
  modal.hidden = false;
}

export function closeBroadcastModal() {
  const modal = $("modal-broadcast-promo");
  if (modal) modal.hidden = true;
}

function updateBroadcastPreview() {
  const filterType = $("broadcast-filter-type")?.value || "all";
  const minPoints = parseInt($("broadcast-min-points")?.value || "0", 10);
  const customers = getCustomersList();

  const recipients = customers.filter(c => {
    if (filterType === "points") return num(c.totalPoints) >= minPoints;
    return true;
  });

  $("broadcast-recipient-count").textContent = `${formatNumber(recipients.length)} Member`;

  const tbody = $("table-broadcast-recipients-tbody");
  if (tbody) {
    if (!recipients.length) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:16px;color:#94a3b8;font-size:12px;">Tidak ada member yang memenuhi kriteria filter.</td></tr>`;
    } else {
      tbody.innerHTML = recipients.slice(0, 50).map(c => `
        <tr>
          <td><strong>${escapeHtml(c.name)}</strong></td>
          <td style="color:#64748b;"><i class="fa-brands fa-whatsapp" style="color:#25d366;"></i> ${escapeHtml(c.phone)}</td>
          <td><span class="badge" style="background:#ecfdf5;color:#059669;font-weight:700;">${formatNumber(c.totalPoints || 0)} Poin</span></td>
          <td>
            <button type="button" class="button button-small btn-send-single-broadcast" data-phone="${escapeHtml(c.phone)}" data-name="${escapeHtml(c.name)}" data-points="${c.totalPoints || 0}" style="background:#25d366;color:#fff;border:none;padding:3px 8px;font-size:11px;">
              <i class="fa-brands fa-whatsapp"></i> Kirim WA
            </button>
          </td>
        </tr>
      `).join("");

      if (recipients.length > 50) {
        tbody.innerHTML += `<tr><td colspan="4" style="text-align:center;padding:8px;color:#64748b;font-size:11px;">... dan ${recipients.length - 50} member lainnya (unduh Excel untuk daftar lengkap)</td></tr>`;
      }

      tbody.querySelectorAll(".btn-send-single-broadcast").forEach(btn => {
        btn.addEventListener("click", () => {
          const p = btn.dataset.phone;
          const n = btn.dataset.name;
          const pts = btn.dataset.points;
          sendCustomBroadcastToCustomer(p, n, pts);
        });
      });
    }
  }
}

function getProcessedBroadcastMessage(name, points) {
  const rawMsg = $("broadcast-message-template")?.value || "";
  const st = getStoreSettings();
  const storeName = st["Nama Toko"] || st["Nama Apotek"] || "Apotek Doa Ibu";

  return rawMsg
    .replace(/\{nama\}/gi, name)
    .replace(/\{poin\}/gi, formatNumber(points))
    .replace(/\{toko\}/gi, storeName);
}

function sendCustomBroadcastToCustomer(phone, name, points) {
  const waPhone = cleanWaPhone(phone);
  const msg = getProcessedBroadcastMessage(name, points);
  window.open(`https://wa.me/${waPhone}?text=${encodeURIComponent(msg)}`, "_blank");
}

/**
 * 6. EKSPOR EXCEL KONTAK BROADCAST MEMBER
 */
export function exportCustomersToExcel() {
  const customers = getCustomersList();
  if (!customers.length) {
    return window.KasirProDialog?.warning("Data Kosong", "Belum ada data member untuk diekspor.");
  }

  const XLSX = typeof window !== "undefined" ? window.XLSX : null;
  if (!XLSX) {
    return window.KasirProDialog?.error("Pustaka Belum Siap", "Pustaka SheetJS (XLSX) belum dimuat.");
  }

  const today = new Date().toISOString().split("T")[0];
  const rows = [
    ["Nama Member", "Nomor WhatsApp (Standar)", "Format Broadcast (628xxx)", "Saldo Poin", "Total Belanja", "Kunjungan", "Terakhir Belanja"]
  ];

  customers.forEach(c => {
    rows.push([
      c.name,
      c.phone,
      cleanWaPhone(c.phone),
      num(c.totalPoints || 0),
      num(c.totalSpent || 0),
      num(c.visitCount || 0),
      c.lastVisit ? new Date(c.lastVisit).toLocaleDateString("id-ID") : "Belum Ada"
    ]);
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "MEMBER_BROADCAST");

  const fileName = `KasirPro_Kontak_Member_WA_${today}.xlsx`;
  XLSX.writeFile(wb, fileName);
  window.KasirProDialog?.success("Excel Terunduh", `File "${fileName}" berisi ${customers.length} kontak member berhasil diekspor.`);
}

/**
 * 7. INISIALISASI MODUL & EVENT LISTENER
 */
export function initCustomerModule() {
  $("btn-open-create-customer")?.addEventListener("click", openCreateCustomerModal);
  $("btn-close-customer-form")?.addEventListener("click", closeCustomerModal);
  $("btn-cancel-customer-form")?.addEventListener("click", closeCustomerModal);
  $("form-customer-detail")?.addEventListener("submit", handleSaveCustomerForm);

  $("input-search-customers")?.addEventListener("input", () => renderCustomers());

  // Katalog Hadiah
  $("btn-open-rewards-catalog")?.addEventListener("click", openManageRewardsModal);
  $("btn-close-manage-rewards")?.addEventListener("click", closeManageRewardsModal);
  $("form-add-reward")?.addEventListener("submit", handleAddRewardSubmit);

  // Penukaran Poin
  $("btn-close-redeem-modal")?.addEventListener("click", closeRedeemPointsModal);
  $("btn-cancel-redeem-modal")?.addEventListener("click", closeRedeemPointsModal);
  $("form-redeem-points")?.addEventListener("submit", handleExecuteRedeemPoints);
  $("redeem-reward-select")?.addEventListener("change", (e) => {
    const isCustom = e.target.value === "__CUSTOM__";
    $("redeem-points-custom-box").hidden = !isCustom;
  });

  // Riwayat Poin
  $("btn-close-points-history")?.addEventListener("click", closePointsHistoryModal);

  // Broadcast WA
  $("btn-open-broadcast-modal")?.addEventListener("click", openBroadcastModal);
  $("btn-close-broadcast-modal")?.addEventListener("click", closeBroadcastModal);
  $("broadcast-filter-type")?.addEventListener("change", (e) => {
    $("box-filter-min-points").hidden = e.target.value !== "points";
    updateBroadcastPreview();
  });
  $("broadcast-min-points")?.addEventListener("input", updateBroadcastPreview);
  $("btn-export-customers-excel")?.addEventListener("click", exportCustomersToExcel);
  $("btn-download-broadcast-excel")?.addEventListener("click", exportCustomersToExcel);
}

if (typeof window !== "undefined") {
  window.renderCustomers = renderCustomers;
  window.openCreateCustomerModal = openCreateCustomerModal;
  window.openEditCustomerModal = openEditCustomerModal;
  window.openManageRewardsModal = openManageRewardsModal;
  window.openRedeemPointsModal = openRedeemPointsModal;
  window.openPointsHistoryModal = openPointsHistoryModal;
  window.openBroadcastModal = openBroadcastModal;
  window.exportCustomersToExcel = exportCustomersToExcel;
  window.initCustomerModule = initCustomerModule;
}
