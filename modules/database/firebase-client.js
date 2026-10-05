import { initializeApp, getApp, getApps } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
    getAuth,
    browserSessionPersistence,
    setPersistence
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const APP_NAME = "KasirProV2";

export const firebaseApp = getApps().some((app) => app.name === APP_NAME)
    ? getApp(APP_NAME)
    : initializeApp(firebaseConfig, APP_NAME);

export const firebaseAuth = getAuth(firebaseApp);

try {
    await setPersistence(firebaseAuth, browserSessionPersistence);
} catch (error) {
    console.warn("Persistence sesi Firebase Auth tidak dapat diaktifkan:", error);
}

// Firestore sengaja memakai konfigurasi default memory-only.
// Seluruh pembacaan data operasional dilakukan dengan *FromServer di database-store.js.
export const firebaseDb = getFirestore(firebaseApp);
