(function () {
    "use strict";

    // Mode Produksi Aktif: Service worker dan update tracker berjalan normal

    const scriptUrl = new URL(document.currentScript.src);
    const appRoot = new URL("./", scriptUrl);
    let installPrompt = null;
    let registration = null;
    let refreshing = false;
    let isUpdateModalShown = false;

    // Injeksi CSS Khusus PWA & Modal Pembaruan Wajib
    const style = document.createElement("style");
    style.id = "kp-pwa-styles";
    style.textContent = `
        /* Tombol PWA Install Mengambang */
        .kp-pwa-control{position:fixed;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));z-index:100000;display:flex;max-width:min(360px,calc(100vw - 32px));align-items:center;gap:10px;padding:11px 14px;border:0;border-radius:14px;background:#0f2a43;color:#fff;box-shadow:0 12px 32px rgba(15,42,67,.28);font:600 14px/1.35 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
        .kp-pwa-control[hidden]{display:none!important}.kp-pwa-control:focus-visible{outline:3px solid #60a5fa;outline-offset:3px}.kp-pwa-control svg{width:20px;height:20px;flex:0 0 auto;fill:currentColor}
        
        /* Toast Pemberitahuan Sistem */
        .kp-pwa-toast{position:fixed;left:50%;bottom:max(18px,env(safe-area-inset-bottom));z-index:100001;transform:translate(-50%,18px);max-width:min(520px,calc(100vw - 32px));padding:11px 16px;border-radius:12px;background:#172033;color:#fff;box-shadow:0 10px 28px rgba(15,23,42,.28);font:500 14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:0;pointer-events:none;transition:.2s ease}
        .kp-pwa-toast.is-visible{opacity:1;transform:translate(-50%,0)}
        
        /* MODAL PEMBARUAN WAJIB (MANDATORY UPDATE MODAL) */
        .kp-update-modal{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:18px;background:rgba(15,23,42,.78);backdrop-filter:blur(8px);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
        .kp-update-modal[hidden]{display:none!important}
        .kp-update-card{position:relative;width:min(520px,100%);max-height:92vh;overflow-y:auto;background:#ffffff;border-radius:22px;border:1px solid rgba(226,232,240,.9);box-shadow:0 28px 80px rgba(15,23,42,.5);padding:28px 24px 22px;text-align:center;animation:kp-modal-pop .25s ease-out}
        @keyframes kp-modal-pop{from{transform:scale(.94);opacity:0}to{transform:scale(1);opacity:1}}
        
        .kp-update-icon{width:64px;height:64px;margin:0 auto 14px;border-radius:20px;background:linear-gradient(135deg,#1d4ed8,#3b82f6);color:#fff;display:grid;place-items:center;font-size:28px;box-shadow:0 10px 26px rgba(37,99,235,.38)}
        .kp-update-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;background:#eff6ff;color:#2563eb;border:1px solid #dbeafe;border-radius:999px;font-size:11.5px;font-weight:750;margin-bottom:10px}
        .kp-update-title{margin:0 0 6px;color:#0f172a;font-size:20px;font-weight:800;line-height:1.25}
        .kp-update-subtitle{margin:0 0 16px;color:#64748b;font-size:13px;line-height:1.55}
        
        .kp-update-changelog-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;padding:16px 18px;margin-bottom:20px;text-align:left}
        .kp-update-changelog-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:12px;font-weight:750;color:#334155;text-transform:uppercase;letter-spacing:.5px}
        .kp-update-list{margin:0;padding:0;list-style:none;display:grid;gap:9px}
        .kp-update-list li{font-size:13px;color:#1e293b;line-height:1.45;display:flex;align-items:flex-start;gap:9px}
        .kp-update-list li svg{width:16px;height:16px;flex:0 0 auto;fill:#10b981;margin-top:2px}
        
        .kp-update-btn{width:100%;min-height:48px;padding:12px 20px;background:#2563eb;color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all .18s;box-shadow:0 8px 22px rgba(37,99,235,.32)}
        .kp-update-btn:hover{background:#1d4ed8;box-shadow:0 10px 26px rgba(37,99,235,.4)}
        .kp-update-btn:active{transform:scale(.98)}
        
        .kp-update-loading-state{display:flex;flex-direction:column;align-items:center;gap:12px;padding:32px 14px}
        .kp-update-spinner{width:46px;height:46px;border:4px solid #e2e8f0;border-top-color:#2563eb;border-radius:50%;animation:kp-spin .75s linear infinite}
        @keyframes kp-spin{to{transform:rotate(360deg)}}
        
        .kp-update-footnote{margin-top:14px;font-size:11.5px;color:#94a3b8;line-height:1.4}

        @media (max-width:640px){.kp-pwa-control{left:16px;right:16px;justify-content:center;max-width:none}.kp-pwa-toast{bottom:76px}.kp-update-card{padding:22px 18px 18px}}
        @media print{.kp-pwa-control,.kp-pwa-toast,.kp-update-modal{display:none!important}}
    `;
    document.head.append(style);

    // Tombol Install PWA Manual
    const installButton = document.createElement("button");
    installButton.type = "button";
    installButton.className = "kp-pwa-control";
    installButton.hidden = true;
    installButton.setAttribute("aria-label", "Instal KasirPro");
    installButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16 7 11l1.4-1.4 2.6 2.6V3h2v9.2l2.6-2.6L17 11l-5 5Zm-7 5v-6h2v4h10v-4h2v6H5Z"/></svg><span>Instal KasirPro</span>';

    // Toast Pesan Sistem
    const toast = document.createElement("div");
    toast.className = "kp-pwa-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    let toastTimer = null;

    function showToast(message, duration = 3500) {
        toast.textContent = message;
        toast.classList.add("is-visible");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove("is-visible"), duration);
    }

    function escapeHtml(str) {
        return String(str || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    // Ambil Metadata Versi & Changelog dari Server
    async function fetchVersionMetadata() {
        try {
            const res = await fetch(new URL(`version.json?t=${Date.now()}`, appRoot), { cache: "no-store" });
            if (res.ok) return await res.json();
        } catch (_) {}
        return {
            version: "2.2.0",
            build: "20261004.2",
            releaseDate: "04 Oktober 2026",
            title: "Pembaruan Sistem KasirPro V2",
            description: "Pembaruan ini wajib diterapkan agar seluruh data transaksi antar perangkat tetap selaras dan akurat.",
            changelog: [
                "Rekonsiliasi Cerdas Diskon & PPN Faktur (Mendukung per item & global).",
                "Modal Pop-Up Loading Progres Aktual saat proses impor master data.",
                "Status Produk Otomatis Berbasis Ketersediaan Stok Fisik.",
                "Auto-registrasi Supplier & Kategori baru saat input produk manual.",
                "Proteksi Hapus Data Pintar (Hard Delete data baru & Soft Archive data berriwayat).",
                "Peningkatan sinkronisasi real-time multi-perangkat (PC Admin & Kasir)."
            ]
        };
    }

    // Tampilkan Modal Pembaruan Wajib (Mandatory Update Modal)
    async function showMandatoryUpdateModal(worker) {
        if (isUpdateModalShown) return;
        isUpdateModalShown = true;

        const meta = await fetchVersionMetadata();
        let modal = document.getElementById("kp-update-modal");
        if (!modal) {
            modal = document.createElement("div");
            modal.id = "kp-update-modal";
            modal.className = "kp-update-modal";
            modal.setAttribute("role", "alertdialog");
            modal.setAttribute("aria-modal", "true");
            modal.setAttribute("aria-labelledby", "kp-update-title");
            document.body.appendChild(modal);
        }

        const changelogListHtml = (meta.changelog || [])
            .map(item => `
                <li>
                    <svg viewBox="0 0 20 20" aria-hidden="true"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd"/></svg>
                    <span>${escapeHtml(item)}</span>
                </li>
            `).join("");

        modal.innerHTML = `
            <section class="kp-update-card">
                <div class="kp-update-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24" style="width:32px;height:32px;fill:currentColor;"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/></svg>
                </div>
                <div class="kp-update-badge">
                    <svg viewBox="0 0 16 16" style="width:12px;height:12px;fill:currentColor;"><path d="M8 0a8 8 0 100 16A8 8 0 008 0zm3.5 6L7 10.5 4.5 8l1-1L7 8.5l3.5-3.5 1 1z"/></svg>
                    Pembaruan Wajib • Versi ${escapeHtml(meta.version || "2.2.0")}
                </div>
                <h2 id="kp-update-title" class="kp-update-title">${escapeHtml(meta.title || "Pembaruan Sistem Tersedia")}</h2>
                <p class="kp-update-subtitle">${escapeHtml(meta.description || "Pembaruan ini wajib diterapkan agar seluruh data transaksi antar perangkat tetap selaras dan akurat.")}</p>

                <div class="kp-update-changelog-box">
                    <div class="kp-update-changelog-header">
                        <span>Apa yang Baru di Versi Ini?</span>
                        <span>${escapeHtml(meta.releaseDate || "")}</span>
                    </div>
                    <ul class="kp-update-list">
                        ${changelogListHtml}
                    </ul>
                </div>

                <button type="button" id="kp-btn-apply-update" class="kp-update-btn">
                    <svg viewBox="0 0 24 24" style="width:18px;height:18px;fill:currentColor;" aria-hidden="true"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
                    <span>Perbarui Aplikasi Sekarang</span>
                </button>
                <div class="kp-update-footnote">
                    Aplikasi akan memuat ulang secara otomatis setelah pembaruan diterapkan.
                </div>
            </section>
        `;

        modal.hidden = false;

        // Cegah penutupan modal via Escape atau klik di luar (Pembaruan Wajib)
        modal.onclick = (e) => e.stopPropagation();

        const btnApply = document.getElementById("kp-btn-apply-update");
        if (btnApply) {
            btnApply.onclick = async () => {
                const card = modal.querySelector(".kp-update-card");
                if (card) {
                    card.innerHTML = `
                        <div class="kp-update-loading-state">
                            <div class="kp-update-spinner" role="status" aria-label="Loading"></div>
                            <strong style="font-size:17px;color:#0f172a;margin-top:8px;">Sedang Menerapkan Pembaruan...</strong>
                            <span style="font-size:13px;color:#64748b;text-align:center;max-width:320px;line-height:1.5;">
                                Membersihkan cache lama &amp; menyinkronkan aset terbaru.<br>
                                Halaman akan dimuat ulang otomatis dalam sekejap.
                            </span>
                        </div>
                    `;
                }

                // Catat versi baru di local storage
                try {
                    localStorage.setItem("kasirpro_app_version", meta.version || "2.2.0");
                    localStorage.setItem("kasirpro_app_build", meta.build || "");
                    localStorage.setItem("kasirpro_last_update_ts", Date.now().toString());
                } catch (_) {}

                // Beritahu Service Worker untuk aktifkan versi baru seketika
                if (worker) {
                    worker.postMessage({ type: "SKIP_WAITING" });
                }

                // Bersihkan cache statis browser agar versi baru langsung terambil bersih
                if ("caches" in window) {
                    try {
                        const cacheNames = await caches.keys();
                        await Promise.all(cacheNames.map(name => caches.delete(name)));
                    } catch (_) {}
                }

                // Berikan jeda transisi halus sebelum memuat ulang
                setTimeout(() => {
                    window.location.reload();
                }, 650);
            };
        }
    }

    // Periksa apakah ada pembaruan dari server
    async function checkForAppUpdates() {
        if (!navigator.onLine) return;

        // 1. Cek Service Worker registration
        if (registration) {
            try {
                await registration.update();
                if (registration.waiting) {
                    showMandatoryUpdateModal(registration.waiting);
                    return;
                }
            } catch (_) {}
        }

        // 2. Cek metadata version.json
        try {
            const meta = await fetchVersionMetadata();
            const currentVersion = localStorage.getItem("kasirpro_app_version");
            const currentBuild = localStorage.getItem("kasirpro_app_build");

            if (!currentVersion) {
                // Pengguna baru pertama kali buka aplikasi
                localStorage.setItem("kasirpro_app_version", meta.version || "2.2.0");
                localStorage.setItem("kasirpro_app_build", meta.build || "");
                return;
            }

            // Jika ada versi atau build yang lebih baru di server
            if (meta.version !== currentVersion || (meta.build && meta.build !== currentBuild)) {
                const targetWorker = registration?.waiting || registration?.installing || navigator.serviceWorker.controller;
                showMandatoryUpdateModal(targetWorker);
            }
        } catch (_) {}
    }

    // Event Listener PWA Install
    window.addEventListener("beforeinstallprompt", (event) => {
        event.preventDefault();
        installPrompt = event;
        installButton.hidden = false;
    });

    installButton.onclick = async () => {
        if (!installPrompt) return;
        installButton.hidden = true;
        await installPrompt.prompt();
        const choice = await installPrompt.userChoice;
        if (choice.outcome === "accepted") showToast("KasirPro sedang dipasang.");
        installPrompt = null;
    };

    window.addEventListener("appinstalled", () => {
        installButton.hidden = true;
        installPrompt = null;
        showToast("KasirPro berhasil dipasang.");
    });

    // Koneksi & Status Database
    window.addEventListener("online", () => {
        showToast("Koneksi internet kembali aktif.");
        checkForAppUpdates();
    });
    window.addEventListener("offline", () => {
        showToast("KasirPro memerlukan internet untuk membaca dan menyimpan data Firestore.", 5500);
    });
    window.addEventListener("kasirpro:database-ready", () => showToast("Database Firestore siap digunakan."));
    window.addEventListener("kasirpro:database-synced", (event) => {
        const total = Number(event.detail?.totalRecords || 0);
        if (total > 0) showToast(`${total.toLocaleString("id-ID")} perubahan tersimpan ke Firestore.`);
    });
    window.addEventListener("kasirpro:database-error", () => showToast("Operasi Firestore gagal. Data tidak disimpan sebagai cadangan lokal.", 6000));

    // Pengecekan saat halaman selesai dimuat
    document.addEventListener("DOMContentLoaded", () => {
        document.body.append(installButton, toast);
        const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
        const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
        if (isIos && !isStandalone) {
            setTimeout(() => showToast("Untuk instal di iPhone/iPad: pilih Bagikan, lalu Tambahkan ke Layar Utama.", 6500), 1200);
        }
    });

    // Registrasi Service Worker & Pendeteksi Update
    if (!("serviceWorker" in navigator)) return;

    window.addEventListener("load", async () => {
        try {
            registration = await navigator.serviceWorker.register(new URL("sw.js", appRoot), {
                scope: appRoot.pathname,
                updateViaCache: "none"
            });

            // Pengecekan awal saat startup
            await registration.update().catch(() => {});
            if (registration.waiting) {
                showMandatoryUpdateModal(registration.waiting);
            }

            // Pendeteksi saat service worker baru sedang diunduh
            registration.addEventListener("updatefound", () => {
                const worker = registration.installing;
                if (!worker) return;
                worker.addEventListener("statechange", () => {
                    if (worker.state === "installed" && navigator.serviceWorker.controller) {
                        showMandatoryUpdateModal(worker);
                    }
                });
            });

            // Auto reload saat service worker baru mengambil alih
            navigator.serviceWorker.addEventListener("controllerchange", () => {
                if (refreshing) return;
                refreshing = true;
                window.location.reload();
            });

            // Cek update saat kembali membuka tab / aplikasi (window focus)
            window.addEventListener("focus", checkForAppUpdates);

            // Cek berkala setiap 3 menit di latar belakang
            setInterval(checkForAppUpdates, 3 * 60 * 1000);

            // Cek metadata versi setelah 2.5 detik
            setTimeout(checkForAppUpdates, 2500);

        } catch (error) {
            console.error("PWA KasirPro gagal diaktifkan:", error);
        }
    });
})();
