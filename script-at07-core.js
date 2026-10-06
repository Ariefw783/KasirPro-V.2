import { signInKasirPro } from "./modules/database/auth.js";

const roleButtons = document.querySelectorAll(".role-card");
const roleSelection = document.querySelector(".role-selection");
const loginPanel = document.getElementById("login-panel");
const formTitle = document.getElementById("form-title");
const selectedRoleLabel = document.getElementById("selected-role-label");
const loginForm = document.getElementById("login-form");
const usernameWrapper = document.getElementById("username-wrapper");
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const backRoleButton = document.getElementById("back-role-button");
const togglePasswordButton = document.getElementById("toggle-password");
const passwordIcon = document.getElementById("password-icon");
const loginMessage = document.getElementById("login-message");
const loginSubmit = document.getElementById("login-submit");
const loginSubmitIcon = document.getElementById("login-submit-icon");
const loginSubmitText = document.getElementById("login-submit-text");

let selectedRole = "admin";
let isSubmitting = false;

init();

function init() {
  disableLegacyLoader();
  updateLoginStoreName();
  loadVersionInfo();
  checkActiveSession();
  bindEvents();
  selectRole("admin");
}

async function loadVersionInfo() {
  const versionEl = document.getElementById("login-app-version");
  const dateEl = document.getElementById("login-app-updated");
  if (versionEl) versionEl.textContent = "v2.2.21";
  if (dateEl) dateEl.textContent = "Diperbarui 06 Okt 2026";

  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (versionEl && data.version) versionEl.textContent = `v${data.version}`;
      if (dateEl && data.releaseDate) dateEl.textContent = `Diperbarui ${data.releaseDate}`;
    }
  } catch (err) {
    console.debug("Info versi menggunakan fallback bawaan:", err);
  }
}

async function updateLoginStoreName() {
  const node = document.getElementById("login-store-name");
  if (!node) return;
  try {
    const raw = localStorage.getItem("kasirpro_store_settings") || localStorage.getItem("kasirpro_master_store_v1");
    if (raw) {
      const parsed = JSON.parse(raw);
      const rows = parsed?.pengaturan_toko || parsed?.pengaturanToko || parsed;
      const settings = Array.isArray(rows) ? rows[0] : rows;
      const name = String(settings?.store_name || settings?.["Nama Toko"] || "").trim().replace(/\s+v\.?\s*2(?:\.0)?$/i, "").trim();
      if (name) node.textContent = name;
    }
  } catch (_) {}
}

function disableLegacyLoader() {
  const loading = document.getElementById("app-loading");
  if (loading) {
    loading.hidden = true;
    loading.style.display = "none";
    loading.setAttribute("aria-hidden", "true");
  }
}

function getSession() {
  const raw = sessionStorage.getItem("kasirpro_session") || localStorage.getItem("kasirpro_session");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && !sessionStorage.getItem("kasirpro_session")) {
      sessionStorage.setItem("kasirpro_session", raw);
    }
    return parsed;
  } catch (error) {
    console.error("Session tidak valid:", error);
    sessionStorage.removeItem("kasirpro_session");
    localStorage.removeItem("kasirpro_session");
    return null;
  }
}

function checkActiveSession() {
  const session = getSession();
  if (!session) return;
  if (session.role === "admin") window.location.replace("management/index.html");
  else if (session.role === "cashier") window.location.replace("pos/index.html");
}

function bindEvents() {
  roleButtons.forEach(button => button.addEventListener("click", () => selectRole(button.dataset.role)));
  backRoleButton?.addEventListener("click", () => selectRole("admin"));
  togglePasswordButton?.addEventListener("click", togglePasswordVisibility);
  loginForm?.addEventListener("submit", handleLoginSubmit);
  loginSubmit?.addEventListener("click", (e) => {
    if (!isSubmitting) {
      handleLoginSubmit(e);
    }
  });
}

function selectRole(role) {
  selectedRole = role === "cashier" ? "cashier" : "admin";
  clearMessage();
  loginPanel.hidden = false;
  roleSelection.hidden = false;
  roleButtons.forEach(button => {
    const active = button.dataset.role === selectedRole;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  if (selectedRole === "admin") {
    formTitle.textContent = "Login Administrator";
    selectedRoleLabel.textContent = "Masukkan akun Administrator untuk membuka aplikasi manajemen.";
    usernameWrapper.hidden = false;
    usernameInput.required = true;
    setTimeout(() => usernameInput?.focus(), 50);
  } else {
    formTitle.textContent = "Login Petugas Kasir";
    selectedRoleLabel.textContent = "Masukkan username kasir dan kata sandi.";
    usernameWrapper.hidden = false;
    usernameInput.required = true;
    usernameInput.value = "";
    setTimeout(() => usernameInput?.focus(), 50);
  }
  passwordInput.value = "";
  setButtonLoading(false);
}

function togglePasswordVisibility() {
  const visible = passwordInput.type === "text";
  passwordInput.type = visible ? "password" : "text";
  if (passwordIcon) passwordIcon.className = visible ? "fa-solid fa-eye" : "fa-solid fa-eye-slash";
  togglePasswordButton?.setAttribute("aria-label", visible ? "Tampilkan kata sandi" : "Sembunyikan kata sandi");
}

async function handleLoginSubmit(event) {
  if (event) {
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof event.stopPropagation === "function") event.stopPropagation();
  }
  if (isSubmitting) return false;
  clearMessage();
  setButtonLoading(true);
  try {
    const username = (usernameInput?.value || "").trim();
    const password = passwordInput?.value || "";
    if (!username) throw new Error("Silakan masukkan username.");
    if (!password) throw new Error("Silakan masukkan password.");

    if (selectedRole === "admin") {
      await signInKasirPro({ username, password, expectedRole: "admin" });
      window.location.replace("management/index.html");
      return false;
    }

    await signInKasirPro({ username, password, expectedRole: "cashier" });
    window.location.replace("pos/index.html");
    return false;
  } catch (error) {
    console.error("Login gagal:", error);
    showLoginError(firebaseLoginMessage(error));
    setButtonLoading(false);
    return false;
  }
}

function setButtonLoading(state) {
  isSubmitting = state;
  if (loginSubmit) loginSubmit.disabled = state;
  if (loginSubmitIcon) {
    loginSubmitIcon.innerHTML = state
      ? '<i class="fa-solid fa-spinner fa-spin"></i>'
      : '<i class="fa-solid fa-right-to-bracket"></i>';
  }
  if (loginSubmitText) loginSubmitText.textContent = state ? "Memproses..." : "Masuk";
}

function firebaseLoginMessage(error) {
  const code = String(error?.code || "");
  if (code.includes("invalid-credential") || code.includes("wrong-password") || code.includes("user-not-found")) return "Nama pengguna atau kata sandi salah.";
  if (code.includes("too-many-requests")) return "Percobaan login terlalu banyak. Tunggu beberapa saat lalu coba kembali.";
  if (code.includes("network-request-failed")) return "Koneksi ke Firebase gagal. Periksa internet lalu coba kembali.";
  return error?.message || "Login Firebase gagal.";
}

function showLoginError(message) {
  if (!loginMessage) return;
  loginMessage.classList.remove("success");
  loginMessage.textContent = message;
}

function clearMessage() {
  if (!loginMessage) return;
  loginMessage.textContent = "";
  loginMessage.classList.remove("success");
}
