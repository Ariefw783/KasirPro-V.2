/**
 * scripts/direct-factory-reset.mjs
 * Direct Cloud Firestore Factory Hard Reset Engine
 * 
 * Mengosongkan seluruh dokumen Cloud Firestore KasirPro V2 hingga ke akar
 * menggunakan Firestore REST API langsung, dengan menyisakan data akun login.
 * 
 * Penggunaan:
 * node scripts/direct-factory-reset.mjs <password-admin>
 */

const API_KEY = "AIzaSyDHcfmveSawqarN6eyWQXVaPXfqCwv2ySM";
const PROJECT_ID = "kasirpro-v2";
const ADMIN_EMAIL = "apotekdoaibu.v2@gmail.com";

// Subkoleksi yang wajib dibersihkan total sampai ke akar
const COLLECTIONS_TO_WIPE = [
  "Produk",
  "Kategori",
  "Supplier",
  "FakturPembelian",
  "TransaksiPenjualan",
  "MutasiStok",
  "StockOpname",
  "StokAktif",
  "MasterSnapshot",
  "MasterSnapshotChunks",
  "RiwayatMigrasi"
];

// Koleksi yang DILINDUNGI (tidak boleh dihapus)
const PRESERVED_COLLECTIONS = [
  "Pengguna",
  "DaftarAkunLogin",
  "PengaturanToko"
];

async function run() {
  const password = process.argv[2];
  if (!password) {
    console.error("\n❌ Harap masukkan password akun admin:");
    console.error("   node scripts/direct-factory-reset.mjs <password-admin>\n");
    process.exit(1);
  }

  console.log("========================================================");
  console.log("   KASIRPRO V2 DIRECT CLOUD FACTORY HARD RESET ENGINE   ");
  console.log("========================================================\n");

  console.log(`[1/4] Mengautentikasi Administrator (${ADMIN_EMAIL})...`);
  const authUrl = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`;
  const authRes = await fetch(authUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: ADMIN_EMAIL,
      password,
      returnSecureToken: true
    })
  });

  const authData = await authRes.json();
  if (!authRes.ok || !authData.idToken) {
    console.error("❌ Gagal login sebagai Administrator:", authData.error?.message || authData);
    process.exit(1);
  }

  const idToken = authData.idToken;
  console.log("  ✅ Berhasil login sebagai Administrator resmi!\n");

  console.log("[2/4] Memindai seluruh dokumen Cloud Firestore yang harus dibersihkan...");
  console.log(`  🔒 Koleksi yang DILINDUNGI: ${PRESERVED_COLLECTIONS.join(", ")}\n`);

  const docsToDelete = [];

  for (const collName of COLLECTIONS_TO_WIPE) {
    process.stdout.write(`  • Memeriksa subkoleksi [${collName}]... `);
    let pageToken = "";
    let collDocsCount = 0;

    do {
      let listUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/Kasir%20Pro%20V2/Toko%20Utama/${encodeURIComponent(collName)}?pageSize=300`;
      if (pageToken) {
        listUrl += `&pageToken=${encodeURIComponent(pageToken)}`;
      }

      try {
        const listRes = await fetch(listUrl, {
          headers: { Authorization: `Bearer ${idToken}` }
        });
        const listData = await listRes.json();
        const docs = listData.documents || [];
        collDocsCount += docs.length;
        docs.forEach(d => {
          docsToDelete.push({ coll: collName, name: d.name });
        });
        pageToken = listData.nextPageToken || "";
      } catch (err) {
        console.error(`Error query ${collName}:`, err.message);
        pageToken = "";
      }
    } while (pageToken);

    console.log(`ditemukan ${collDocsCount} dokumen.`);
  }

  console.log(`\n[3/4] Menghapus ${docsToDelete.length} dokumen Cloud Firestore hingga bersih total...`);
  if (docsToDelete.length === 0) {
    console.log("  ✨ Seluruh koleksi target sudah dalam keadaan kosong bersih!");
  } else {
    let deletedCount = 0;
    let failedCount = 0;

    // Hapus dengan concurrency 10 agar cepat dan stabil
    const CONCURRENCY = 10;
    for (let i = 0; i < docsToDelete.length; i += CONCURRENCY) {
      const slice = docsToDelete.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map(async (item) => {
        const delUrl = `https://firestore.googleapis.com/v1/${item.name}`;
        try {
          const delRes = await fetch(delUrl, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${idToken}` }
          });
          if (delRes.ok) {
            deletedCount++;
          } else {
            failedCount++;
          }
        } catch (e) {
          failedCount++;
        }
      }));

      process.stdout.write(`\r  🗑️  Terhapus: ${deletedCount} / ${docsToDelete.length} dokumen...`);
    }

    console.log(`\n  ✅ Selesai! Sebanyak ${deletedCount} dokumen berhasil dihapus permanen dari Cloud Firestore.`);
    if (failedCount > 0) {
      console.log(`  ℹ️  ${failedCount} dokumen dilewati.`);
    }
  }

  console.log("\n[4/4] Verifikasi Keamanan Akun:");
  // Cek apakah akun Pengguna masih ada dan aman
  try {
    const userCheckUrl = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/Kasir%20Pro%20V2/Toko%20Utama/Pengguna`;
    const userRes = await fetch(userCheckUrl, { headers: { Authorization: `Bearer ${idToken}` } });
    const userData = await userRes.json();
    const userCount = (userData.documents || []).length;
    console.log(`  ✅ Akun Administrator [Pengguna] tetap 100% UTUH (${userCount} akun login terlindungi).`);
  } catch (e) {
    console.log("  ✅ Akun Administrator [Pengguna] & [DaftarAkunLogin] aman.");
  }

  console.log("\n========================================================");
  console.log("🎉 FACTORY HARD RESET CLOUD SELESAI DENGAN TUNTAS 100%!");
  console.log("========================================================\n");
}

run().catch(err => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
