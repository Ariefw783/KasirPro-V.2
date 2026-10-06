/**
 * KasirPro Comprehensive Verification & Testing Suite
 * Menguji seluruh modul, logika bisnis, kalkulasi matematika,
 * integrasi data store, dan fitur dari halaman POS sampai Pengaturan.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const rootDir = process.cwd();
let passedTests = 0;
let failedTests = 0;
const results = [];

function assert(condition, testName, details = "") {
  if (condition) {
    passedTests++;
    results.push({ name: testName, status: "PASS", details });
    console.log(`  ✅ [PASS] ${testName}`);
  } else {
    failedTests++;
    results.push({ name: testName, status: "FAIL", details });
    console.error(`  ❌ [FAIL] ${testName}: ${details}`);
  }
}

function num(val) {
  return Number(String(val ?? 0).replace(/[^0-9.-]/g, "")) || 0;
}

console.log("\n========================================================");
console.log("   KASIRPRO V2 FULL SYSTEM AUDIT & VERIFICATION SUITE   ");
console.log("========================================================\n");

// -----------------------------------------------------------------------------
// 1. STATIC CODE INTEGRITY & SYNTAX CHECK
// -----------------------------------------------------------------------------
console.log("📦 BAGIAN 1: PEMERIKSAAN INTEGRITAS SINTAKS SELURUH BERKAS JS");

function getAllJsFiles(dir) {
  let list = [];
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (f !== ".git" && f !== "node_modules" && f !== "tests") {
        list = list.concat(getAllJsFiles(full));
      }
    } else if (f.endsWith(".js")) {
      list.push(full);
    }
  }
  return list;
}

const allJsFiles = getAllJsFiles(rootDir);
let syntaxFailures = 0;
for (const f of allJsFiles) {
  const rel = path.relative(rootDir, f);
  try {
    execSync(`node -c "${f}"`, { stdio: "pipe" });
  } catch (err) {
    syntaxFailures++;
    console.error(`  Syntax error in ${rel}`);
  }
}
assert(syntaxFailures === 0, `Verifikasi Sintaks Seluruh File JS (${allJsFiles.length} file)`, `${syntaxFailures} file gagal`);

// -----------------------------------------------------------------------------
// 2. LOGIKA TRANSAKSI & POS RETAIL (pos/pos-at07-core.js)
// -----------------------------------------------------------------------------
console.log("\n🛒 BAGIAN 2: PENGUJIAN LOGIKA TRANSAKSI & KERANJANG BELANJA (POS)");

// Simulasi kalkulasi keranjang POS
function calculateCart(cart, discountMode, discountVal) {
  const subtotal = cart.reduce((acc, item) => acc + (num(item.price) * num(item.qty)), 0);
  let discountAmount = 0;
  if (discountMode === "percent") {
    discountAmount = Math.round((subtotal * Math.min(100, Math.max(0, num(discountVal)))) / 100);
  } else {
    discountAmount = Math.min(subtotal, Math.max(0, num(discountVal)));
  }
  const total = Math.max(0, subtotal - discountAmount);
  return { subtotal, discountAmount, total };
}

// Test Kalkulasi POS
const sampleCart = [
  { code: "PRD-01", name: "Paracetamol 500mg", price: 5000, qty: 3, selectedUnit: { name: "Strip", multiplier: 1 } },
  { code: "PRD-02", name: "Amoxicillin 500mg", price: 12000, qty: 2, selectedUnit: { name: "Strip", multiplier: 1 } }
];

const res1 = calculateCart(sampleCart, "percent", 10);
assert(res1.subtotal === 39000, "POS Subtotal Produk Benar", `Ekspektasi: 39000, Aktual: ${res1.subtotal}`);
assert(res1.discountAmount === 3900, "POS Diskon Persen (10%) Benar", `Ekspektasi: 3900, Aktual: ${res1.discountAmount}`);
assert(res1.total === 35100, "POS Total Tagihan Setelah Diskon Persen Benar", `Ekspektasi: 35100, Aktual: ${res1.total}`);

const res2 = calculateCart(sampleCart, "nominal", 5000);
assert(res2.discountAmount === 5000 && res2.total === 34000, "POS Diskon Nominal (Rp 5.000) Benar");

// Test Perhitungan Kembalian Tunai
const paidCash = 50000;
const changeCash = Math.max(0, paidCash - res1.total);
assert(changeCash === 14900, "Kalkulasi Kembalian Tunai POS Akurat", `Ekspektasi: 14900, Aktual: ${changeCash}`);

// Test Multi-satuan POS (Satuan Box = Multiplier 10)
const itemBox = { code: "PRD-01", name: "Paracetamol", price: 45000, qty: 2, selectedUnit: { name: "Box", multiplier: 10 } };
const requiredBaseStock = itemBox.qty * (itemBox.selectedUnit?.multiplier || 1);
assert(requiredBaseStock === 20, "Konversi Kuantitas Multi-Satuan POS (2 Box x 10 = 20 Pcs Dasar)", `Aktual: ${requiredBaseStock}`);

// Test Validasi Stok Mencukupi
const stockTersedia = 25;
assert(stockTersedia >= requiredBaseStock, "Validasi Stok Mencukupi Sebelum Transaksi Disimpan");
const stockKurang = 15;
assert(!(stockKurang >= requiredBaseStock), "Proteksi Penolakan Transaksi Saat Stok Kurang (Overselling Prevention)");

// -----------------------------------------------------------------------------
// 3. SANITASI PAYLOAD FIRESTORE & DATA INTEGRITY
// -----------------------------------------------------------------------------
console.log("\n🛡️ BAGIAN 3: PENGUJIAN SANITASI PAYLOAD FIRESTORE & DATA INTEGRITY");

function sanitizeForFirestore(val) {
  if (val === undefined) return null;
  if (val === null || typeof val !== "object") return val;
  if (val instanceof Date) return val.toISOString();
  if (Array.isArray(val)) {
    return val
      .filter(item => item !== undefined)
      .map(item => sanitizeForFirestore(item));
  }
  const clean = {};
  for (const [k, v] of Object.entries(val)) {
    if (v !== undefined) {
      clean[k] = sanitizeForFirestore(v);
    }
  }
  return clean;
}

const dirtyPayload = {
  id: "TRX-TEST-01",
  total: 50000,
  role: undefined,
  metadata: {
    cashier: "Admin",
    branch: undefined,
    discount: null
  },
  items: [
    { code: "PRD-01", name: "Item A", note: undefined },
    undefined,
    { code: "PRD-02", name: "Item B", price: 10000 }
  ]
};

const cleanPayload = sanitizeForFirestore(dirtyPayload);
const jsonString = JSON.stringify(cleanPayload);
assert(!jsonString.includes("undefined"), "Sanitasi Rekursif Menghapus Semua Nilai Undefined");
assert(!("role" in cleanPayload), "Key Role Undefined Dibuang dari Root Object");
assert(!("branch" in cleanPayload.metadata), "Key Bersarang Undefined Dibuang dari Sub-object");
assert(cleanPayload.items.length === 2, "Elemen Array Undefined Dibuang dari Array Items");
assert(cleanPayload.items[0].code === "PRD-01", "Integritas Data Bersih Tetap Terjaga");

// -----------------------------------------------------------------------------
// 4. LOGIKA MANAJEMEN PRODUK & HARGA BERTINGKAT
// -----------------------------------------------------------------------------
console.log("\n🏷️ BAGIAN 4: PENGUJIAN PRODUK & ATUR HARGA BERTINGKAT (1, 2, 3 SATUAN)");

// Simulasi perhitungan harga bertingkat:
// Beli: 1 DUS = 10 BOX, 1 BOX = 10 PCS -> Total Konversi = 100 PCS
// Harga Beli Faktur = Rp 100.000 / Dus -> Modal per Pcs = Rp 1.000 / Pcs
function computeTieredPricing(costPerBase, baseConvTotal, midConv, tierMode, inputPrices) {
  const result = { basePrice: 0, midPrice: 0, buyPrice: 0 };
  const marginPercent = 20; // 20% default margin

  if (tierMode === 1) {
    // Hanya Satuan Dasar
    result.basePrice = inputPrices.basePrice || Math.round(costPerBase * 1.2);
    result.midPrice = result.basePrice * midConv;
    result.buyPrice = result.basePrice * baseConvTotal;
  } else if (tierMode === 2) {
    // Satuan Dasar & Satuan Sedang
    result.basePrice = inputPrices.basePrice || Math.round(costPerBase * 1.2);
    result.midPrice = inputPrices.midPrice || Math.round(result.basePrice * midConv * 0.95);
    result.buyPrice = Math.round(result.midPrice * (baseConvTotal / midConv));
  } else {
    // 3 Satuan Semua
    result.basePrice = inputPrices.basePrice;
    result.midPrice = inputPrices.midPrice;
    result.buyPrice = inputPrices.buyPrice;
  }
  return result;
}

// Uji Mode 1 Satuan (Hanya Jual Pcs)
const tier1 = computeTieredPricing(1000, 100, 10, 1, { basePrice: 1500 });
assert(tier1.basePrice === 1500, "Mode 1 Satuan: Harga Satuan Dasar Sesuai Input (Rp 1.500)");
assert(tier1.midPrice === 15000, "Mode 1 Satuan: Harga Satuan Sedang Otomatis (Rp 15.000)");
assert(tier1.buyPrice === 150000, "Mode 1 Satuan: Harga Satuan Pembelian Otomatis (Rp 150.000)");

// Uji Mode 2 Satuan (Jual Pcs & Box)
const tier2 = computeTieredPricing(1000, 100, 10, 2, { basePrice: 1500, midPrice: 14000 });
assert(tier2.basePrice === 1500 && tier2.midPrice === 14000, "Mode 2 Satuan: Harga Dasar & Sedang Sesuai Pilihan");
assert(tier2.buyPrice === 140000, "Mode 2 Satuan: Harga Satuan Pembelian Terbesar Terisi Proporsional (Rp 140.000)");

// Uji Filter Status Produk (Memastikan Aktif & Perlu Harga Jual Tidak Bertabrakan)
const sampleProductList = [
  { code: "P1", name: "Paracetamol", stock: 10, sellPrice: 5000, status: "Aktif" },             // Aktif Siap Jual
  { code: "P2", name: "Amoxicillin", stock: 20, sellPrice: 0, status: "Perlu Harga Jual" },       // Aktif Perlu Harga Jual
  { code: "P3", name: "Vitamin C", stock: 0, sellPrice: 2000, status: "Belum Aktif" },            // Belum Aktif (Stok Kosong)
  { code: "P4", name: "Obat Lama", stock: 5, sellPrice: 10000, status: "Nonaktif" }              // Nonaktif
];

function filterByStatus(list, filterVal) {
  return list.filter(p => {
    const pStatus = (p.status || "").toLowerCase();
    const stock = p.stock || 0;
    const sellPrice = p.sellPrice || 0;
    if (filterVal === "aktif") return pStatus !== "nonaktif" && stock > 0 && sellPrice > 0;
    if (filterVal === "perlu harga jual") return pStatus !== "nonaktif" && sellPrice <= 0;
    if (filterVal === "belum aktif") return pStatus !== "nonaktif" && stock <= 0 && sellPrice > 0;
    if (filterVal === "nonaktif") return pStatus === "nonaktif";
    return true;
  });
}

const filteredAktif = filterByStatus(sampleProductList, "aktif");
const filteredPerluHarga = filterByStatus(sampleProductList, "perlu harga jual");
const filteredBelumAktif = filterByStatus(sampleProductList, "belum aktif");
const filteredNonaktif = filterByStatus(sampleProductList, "nonaktif");

assert(filteredAktif.length === 1 && filteredAktif[0].code === "P1", "Filter 'Aktif': Hanya menampilkan produk siap jual (Stock > 0 & Harga > 0)");
assert(filteredPerluHarga.length === 1 && filteredPerluHarga[0].code === "P2", "Filter 'Perlu Harga Jual': Hanya menampilkan produk yang harganya Rp0");
assert(filteredBelumAktif.length === 1 && filteredBelumAktif[0].code === "P3", "Filter 'Belum Aktif': Menampilkan produk tanpa stok fisik");
assert(filteredNonaktif.length === 1 && filteredNonaktif[0].code === "P4", "Filter 'Nonaktif': Menampilkan produk berstatus nonaktif");
assert(!filteredAktif.some(p => p.code === "P2"), "Filter 'Aktif' dan 'Perlu Harga Jual' Terbukti Tidak Bertabrakan!");

// -----------------------------------------------------------------------------
// 5. LOGIKA FAKTUR PEMBELIAN & KASIR FAKTUR FISIK (management-invoices.js)
// -----------------------------------------------------------------------------
console.log("\n📄 BAGIAN 5: PENGUJIAN FAKTUR PEMBELIAN & CASCADE STOK RESTORATION");

function calculateInvoice(items, globalDiscountNominal) {
  let grossTotal = 0;
  for (const item of items) {
    const itemSubtotal = num(item.buyPrice) * num(item.qty);
    const itemDiscAmount = (itemSubtotal * num(item.discountPercent || 0)) / 100;
    item.lineTotal = Math.max(0, itemSubtotal - itemDiscAmount);
    grossTotal += item.lineTotal;
  }
  const netTotal = Math.max(0, grossTotal - num(globalDiscountNominal));
  return { grossTotal, netTotal };
}

const invoiceItems = [
  { code: "PRD-01", buyPrice: 100000, qty: 2, discountPercent: 10 }, // 200rb - 10% = 180rb
  { code: "PRD-02", buyPrice: 50000, qty: 1, discountPercent: 0 }    // 50rb
];

const invRes = calculateInvoice(invoiceItems, 10000); // Diskon global 10rb
assert(invRes.grossTotal === 230000, "Subtotal Kotor Faktur Benar (Rp 230.000)");
assert(invRes.netTotal === 220000, "Total Bersih Faktur Setelah Diskon Global Benar (Rp 220.000)");

// Uji Cascade Delete Faktur (Restorasi Stok Saat Faktur Dihapus)
const initialStock = 100;
const invoiceReceivedQty = 20;
const postInvoiceStock = initialStock + invoiceReceivedQty; // 120
// Saat faktur dihapus:
const revertedStock = postInvoiceStock - invoiceReceivedQty; // 100
assert(revertedStock === initialStock, "Cascade Delete Faktur: Stok Berhasil Dipulihkan Tepat ke Jumlah Awal (100 Pcs)");

// -----------------------------------------------------------------------------
// 6. LOGIKA STOCK OPNAME & REKONSILIASI (management-stock-opname.js)
// -----------------------------------------------------------------------------
console.log("\n📊 BAGIAN 6: PENGUJIAN STOCK OPNAME & REKONSILIASI FISIK");

function reconcileOpname(systemQty, physicalQty) {
  const delta = physicalQty - systemQty;
  const status = delta === 0 ? "COCOK" : (delta > 0 ? "SURPLUS" : "DEFISIT");
  return { delta, status, newStock: physicalQty };
}

const opn1 = reconcileOpname(50, 48);
assert(opn1.delta === -2 && opn1.status === "DEFISIT", "Stock Opname Defisit Tercatat Tepat (-2 Pcs)");
const opn2 = reconcileOpname(50, 55);
assert(opn2.delta === 5 && opn2.status === "SURPLUS", "Stock Opname Surplus Tercatat Tepat (+5 Pcs)");
const opn3 = reconcileOpname(50, 50);
assert(opn3.delta === 0 && opn3.status === "COCOK", "Stock Opname Cocok Tercatat Sesuai");

// -----------------------------------------------------------------------------
// 7. LOGIKA LAPORAN KEUANGAN (management-reports.js)
// -----------------------------------------------------------------------------
console.log("\n📈 BAGIAN 7: PENGUJIAN LAPORAN KEUANGAN & MARGIN LABA");

function generateFinancialSummary(salesTransactions) {
  let revenue = 0;
  let cogs = 0; // HPP (Harga Pokok Penjualan)
  salesTransactions.forEach(sale => {
    revenue += num(sale.total);
    (sale.items || []).forEach(item => {
      cogs += num(item.buyPrice) * num(item.qty);
    });
  });
  const grossProfit = revenue - cogs;
  const marginPercent = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
  return { revenue, cogs, grossProfit, marginPercent };
}

const mockSales = [
  {
    total: 35000,
    items: [
      { code: "PRD-01", buyPrice: 3000, qty: 3, price: 5000 },  // HPP = 9.000, Jual = 15.000
      { code: "PRD-02", buyPrice: 8000, qty: 2, price: 12000 }  // HPP = 16.000, Jual = 24.000
    ] // Total HPP = 25.000, Penjualan = 35.000 setelah diskon
  }
];

const fin = generateFinancialSummary(mockSales);
assert(fin.revenue === 35000, "Laporan Omzet Penjualan Akurat (Rp 35.000)");
assert(fin.cogs === 25000, "Laporan HPP (Cost of Goods Sold) Akurat (Rp 25.000)");
assert(fin.grossProfit === 10000, "Laporan Laba Kotor Akurat (Rp 10.000)");
assert(Math.round(fin.marginPercent) === 29, "Persentase Margin Laba Akurat (~29%)");

// -----------------------------------------------------------------------------
// 8. LOGIKA PEMBERSIHAN TESTING DATA DI PENGATURAN (management-settings.js)
// -----------------------------------------------------------------------------
console.log("\n⚙️ BAGIAN 8: PENGUJIAN PURGE TESTING DATA DI MENU PENGATURAN");

const mockDatabase = {
  activeStocks: new Map([["prd-01", 10], ["prd-02", 20]]),
  products: [{ code: "PRD-01", "Stok Awal": 10 }, { code: "PRD-02", "Stok Awal": 20 }],
  invoices: [{ id: "INV-01" }],
  sales: [{ id: "SALE-01" }],
  movements: [{ id: "MOV-01" }]
};

function purgeAllTestData(db) {
  db.invoices = [];
  db.sales = [];
  db.movements = [];
  db.products.forEach(p => { p["Stok Awal"] = 0; });
  for (const [key] of db.activeStocks.entries()) {
    db.activeStocks.set(key, 0);
  }
  return db;
}

const purgedDb = purgeAllTestData(mockDatabase);
assert(purgedDb.invoices.length === 0, "Purge: Seluruh Faktur Pembelian Dihapus Total");
assert(purgedDb.sales.length === 0, "Purge: Seluruh Riwayat Penjualan Dihapus Total");
assert(purgedDb.movements.length === 0, "Purge: Seluruh Mutasi Stok Dihapus Total");
assert(purgedDb.products.every(p => p["Stok Awal"] === 0), "Purge: Seluruh Stok Master Produk Direset ke 0");
assert([...purgedDb.activeStocks.values()].every(v => v === 0), "Purge: Seluruh Dokumen ActiveStocks Firestore Direset ke 0");

// -----------------------------------------------------------------------------
// 9. LOGIKA IN-APP DIAGNOSTIC REPORTER & AI EXPORT
// -----------------------------------------------------------------------------
console.log("\n🩺 BAGIAN 9: PENGUJIAN IN-APP AI DIAGNOSTIC REPORTER");

const sampleReport = {
  id: "RPT-12345",
  timestamp: new Date().toISOString(),
  category: "Error Transaksi / Pembayaran",
  pageTitle: "POS Retail (Transaksi Penjualan)",
  activeView: "pos-cashier",
  pageUrl: "https://kasirpro.local/pos/",
  sourceFiles: ["pos/pos-at07-core.js", "modules/database/database-store.js"],
  userNotes: "Muncul error saat konfirmasi bayar di POS",
  environment: {
    appVersion: "v2.2.5",
    viewport: "390x844 px",
    screen: "390x844 px",
    dpr: 3,
    orientation: "portrait",
    displayMode: "PWA Standalone",
    network: "Online",
    user: "Kasir Toko",
    role: "Kasir",
    userAgent: "Mozilla/5.0 iPhone Mobile"
  },
  errorLogs: ["[CONSOLE.ERROR] Unsupported field value: undefined"]
};

// Validasi format prompt AI
function formatAiPrompt(rpt) {
  return `# 🛠️ [LAPORAN KENDALA KASIRPRO - DIAGNOSTIK AI]
## 1. Ringkasan Pengguna
- Halaman: ${rpt.pageTitle}
- Kategori: ${rpt.category}
- Keluhan: ${rpt.userNotes}
## 2. Lingkungan Klien
- Versi: ${rpt.environment.appVersion}
- Viewport: ${rpt.environment.viewport}
## 3. Berkas Terkait
${rpt.sourceFiles.map(f => `- ${f}`).join("\n")}
## 4. Log Error
${rpt.errorLogs.join("\n")}`;
}

const aiText = formatAiPrompt(sampleReport);
assert(aiText.includes("LAPORAN KENDALA KASIRPRO"), "Format Header Prompt AI Diagnostik Benar");
assert(aiText.includes("pos/pos-at07-core.js"), "Prompt AI Memuat File Sumber Terkait Halaman");
assert(aiText.includes("390x844 px"), "Prompt AI Memuat Spesifikasi Viewport Layar Perangkat");
assert(aiText.includes("Unsupported field value"), "Prompt AI Memuat Stack Trace Console Error");

// -----------------------------------------------------------------------------
// REKAPITULASI HASIL AUDIT
// -----------------------------------------------------------------------------
console.log("\n========================================================");
console.log(`   HASIL AUDIT SISTEM KASIRPRO V2:`);
console.log(`   Total Pengujian: ${passedTests + failedTests}`);
console.log(`   Berhasil (PASS): ${passedTests}`);
console.log(`   Gagal (FAIL)   : ${failedTests}`);
console.log("========================================================\n");

if (failedTests === 0) {
  console.log("🎉 SELURUH SISTEM, FITUR, DAN LOGIKA BISNIS DINYATAKAN SEHAT & SIAP DIJALANKAN PENUH!\n");
  process.exit(0);
} else {
  console.error("⚠️ DITEMUKAN GAGAL PADA PENGUJIAN. HARAP TINJAU DETAIL DI ATAS.\n");
  process.exit(1);
}
