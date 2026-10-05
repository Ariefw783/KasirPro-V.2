import { signInKasirPro } from "./modules/database/auth.js";
import { readStore } from "./modules/database/database-store.js";

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
  checkActiveSession();
  bindEvents();
  selectRole("admin");
}

async function updateLoginStoreName() {
  const node = document.getElementById("login-store-name");
  if (!node) return;
  try {
    const master = readStore("kasirpro_master_store_v1", {}) || {};
    const rows = master?.pengaturan_toko || master?.pengaturanToko || master?.pengaturan || [];
    const settings = Array.isArray(rows) ? rows[0] : rows;
    const name = String(settings?.["Nama Toko"] || "").trim().replace(/\s+v\.?\s*2(?:\.0)?$/i, "").trim();
    if (name) node.textContent = name;
  } catch (error) {
    console.warn("Nama toko lokal belum dapat dibaca:", error);
  }
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
  const raw = sessionStorage.getItem("kasirpro_session");
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (error) {
    console.error("Session tidak valid:", error);
    sessionStorage.removeItem("kasirpro_session");
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
  event.preventDefault();
  if (isSubmitting) return;
  clearMessage();
  setButtonLoading(true);
  try {
    if (selectedRole === "admin") {
      const username = usernameInput.value.trim();
      const password = passwordInput.value;
      await signInKasirPro({ username, password, expectedRole: "admin" });
      window.location.replace("management/index.html");
      return;
    }

    const username = usernameInput.value.trim();
    if (!username) throw new Error("Silakan masukkan username kasir.");
    const password = passwordInput.value;
    await signInKasirPro({ username, password, expectedRole: "cashier" });
    window.location.replace("pos/index.html");
  } catch (error) {
    console.error("Login gagal:", error);
    showLoginError(firebaseLoginMessage(error));
    setButtonLoading(false);
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
