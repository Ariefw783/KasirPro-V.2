import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
    createUserWithEmailAndPassword,
    deleteUser,
    getAuth,
    onAuthStateChanged,
    sendPasswordResetEmail,
    signInWithEmailAndPassword,
    signOut
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
    doc,
    getDocFromServer,
    setDoc
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";
import { firebaseConfig, kasirProFirebase } from "./firebase-config.js";
import { firebaseAuth, firebaseDb } from "./firebase-client.js";
import { documentSegments } from "./database-paths.js";

const SESSION_KEY = "kasirpro_session";
const ADMIN_EMAIL = kasirProFirebase.adminGmail;

function cleanUsername(value) {
    return String(value ?? "").trim().toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function normalizeRole(value) {
    const role = String(value ?? "").trim().toLowerCase();
    if (["admin", "administrator"].includes(role)) return "admin";
    if (["kasir", "cashier"].includes(role)) return "cashier";
    return role;
}

function normalizeStatus(value) {
    return ["aktif", "active", "ya", "1", "true"].includes(String(value ?? "").trim().toLowerCase())
        ? "aktif"
        : "nonaktif";
}

export function usernameToFirebaseEmail(username) {
    const clean = cleanUsername(username);
    if (!clean) throw new Error("Nama pengguna tidak boleh kosong.");
    if (clean === "admin") return ADMIN_EMAIL;
    const [localPart, domain] = ADMIN_EMAIL.split("@");
    return `${localPart}+${clean}@${domain}`;
}

export async function sendKasirProPasswordReset({ username, authEmail }) {
    const targetEmail = usernameToFirebaseEmail(username);
    const recordedEmail = String(authEmail || "").trim().toLowerCase();
    if (recordedEmail !== targetEmail.toLowerCase()) {
        throw new Error(`Email login akun belum sesuai. Email yang diperlukan: ${targetEmail}.`);
    }
    await sendPasswordResetEmail(firebaseAuth, targetEmail);
    return targetEmail;
}

function sessionFromProfile(user, profile) {
    return {
        role: normalizeRole(profile.role),
        userId: user.uid,
        username: profile.username,
        name: profile.name || profile.username,
        firebaseEmail: user.email
    };
}

export async function ensureInitialAdminProfile(user, requestedUsername = "admin") {
    const profileRef = doc(firebaseDb, ...documentSegments("users", user.uid));
    const isInitialAdmin =
        String(user.email || "").toLowerCase() === ADMIN_EMAIL.toLowerCase() &&
        cleanUsername(requestedUsername) === "admin";

    try {
        const current = await getDocFromServer(profileRef);
        if (current.exists()) return current.data();
    } catch (error) {
        if (!isInitialAdmin) throw error;
    }

    if (!isInitialAdmin) {
        throw new Error("Profil pengguna belum dibuat oleh Administrator.");
    }

    const profile = {
        username: "admin",
        name: "Administrator",
        role: "admin",
        status: "aktif",
        authEmail: ADMIN_EMAIL,
        updatedAt: new Date().toISOString(),
        schemaVersion: kasirProFirebase.schemaVersion
    };
    await setDoc(profileRef, profile, { merge: true });
    const verified = await getDocFromServer(profileRef);
    if (!verified.exists()) throw new Error("Profil Administrator gagal dibuat di Firestore.");
    return verified.data();
}

export async function signInKasirPro({ username, password, expectedRole }) {
    const clean = cleanUsername(username);
    if (!clean || !password) throw new Error("Nama pengguna dan kata sandi wajib diisi.");

    const legacyEmail = `${clean}@${kasirProFirebase.authEmailDomain}`;
    const email = usernameToFirebaseEmail(clean);

    let credential;
    try {
        credential = await signInWithEmailAndPassword(firebaseAuth, email, password);
    } catch (error) {
        if (clean === "admin" || email === legacyEmail) throw error;
        credential = await signInWithEmailAndPassword(firebaseAuth, legacyEmail, password);
    }

    const profile = await ensureInitialAdminProfile(credential.user, username);
    const role = normalizeRole(profile.role);
    if (normalizeStatus(profile.status) !== "aktif") {
        await signOut(firebaseAuth);
        throw new Error("Akun ini sedang nonaktif.");
    }
    if (expectedRole && role !== normalizeRole(expectedRole)) {
        await signOut(firebaseAuth);
        throw new Error("Peran akun tidak sesuai dengan mode masuk yang dipilih.");
    }

    const session = sessionFromProfile(credential.user, profile);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
}

export function waitForFirebaseUser() {
    if (firebaseAuth.currentUser) {
        return Promise.resolve(firebaseAuth.currentUser);
    }
    return new Promise((resolve) => {
        const unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
            unsubscribe();
            resolve(user || null);
        });
    });
}

export async function signOutKasirPro() {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem("kasirpro_preload_session_v1");
    await signOut(firebaseAuth);
}

export async function provisionFirebaseUser(record) {
    const username = cleanUsername(record["Username"] || record.username);
    const password = String(record["Password Awal"] || record.password || "");
    const role = normalizeRole(record["Role"] || record.role);
    const status = normalizeStatus(record["Status"] || record.status);

    if (!username || !password || !["admin", "cashier"].includes(role)) {
        return { status: "skipped", username, reason: "Username, password awal, atau role belum valid." };
    }
    if (username === "admin") {
        return { status: "existing", username, reason: "Administrator utama memakai akun Firebase yang sudah ditetapkan." };
    }

    const secondaryName = `KasirProProvisioning-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const secondaryApp = initializeApp(firebaseConfig, secondaryName);
    const secondaryAuth = getAuth(secondaryApp);
    let createdUser = null;

    try {
        const credential = await createUserWithEmailAndPassword(
            secondaryAuth,
            usernameToFirebaseEmail(username),
            password
        );
        createdUser = credential.user;
        const profile = {
            username,
            name: String(record["Nama"] || record.name || username).trim(),
            role,
            status,
            authEmail: usernameToFirebaseEmail(username),
            phone: String(record["Nomor Telepon"] || "").trim(),
            email: String(record["Email"] || "").trim(),
            createdAt: new Date().toISOString(),
            schemaVersion: kasirProFirebase.schemaVersion
        };
        await setDoc(doc(firebaseDb, ...documentSegments("users", credential.user.uid)), profile);
        await setDoc(doc(firebaseDb, ...documentSegments("loginDirectory", `akun-${username}`)), {
            username,
            name: profile.name,
            role,
            status,
            authEmail: profile.authEmail
        });
        return { status: "created", username, uid: credential.user.uid, authEmail: profile.authEmail };
    } catch (error) {
        if (createdUser && error?.code !== "auth/email-already-in-use") {
            await deleteUser(createdUser).catch(() => {});
        }
        if (error?.code === "auth/email-already-in-use") {
            return { status: "existing", username, reason: "Akun Authentication sudah tersedia." };
        }
        return { status: "failed", username, reason: error?.message || String(error) };
    } finally {
        await signOut(secondaryAuth).catch(() => {});
        await deleteApp(secondaryApp).catch(() => {});
    }
}
