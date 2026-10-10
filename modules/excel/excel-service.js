/**
 * modules/excel/excel-service.js
 * Layanan Export & Import Excel KasirPro V2
 * Kompatibel penuh antara Template, Export, dan Import/Update.
 */

import { num, text, norm, rupiah, INVOICE_TOLERANCE_RP, isWithinTolerance } from "../core/utils.js";

function getXLSX() {
  const x = typeof window !== "undefined" ? window.XLSX : (typeof globalThis !== "undefined" ? globalThis.XLSX : null);
  if (!x) throw new Error("Pustaka SheetJS (XLSX) belum dimuat.");
  return x;
}

/**
 * Format tanggal waktu YYYY-MM-DD_HH-mm-ss untuk nama file
 */
function getTimestampString() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

let lastExportTime = "";
let lastExportCounter = 0;

/**
 * KAMUS SATUAN (satu istilah di seluruh sistem)
 * ------------------------------------------------------------------
 *  Master Produk (Template Master)  | Faktur Pembelian (Template Faktur) | Arti
 *  ---------------------------------|------------------------------------|-----------------------------
 *  Satuan Pembelian                 | Kemasan Beli                       | Satuan saat membeli (Box, Dus)
 *  Konversi                         | Isi Kemasan                        | 1 Satuan Pembelian = N Satuan Dasar
 *  Satuan Dasar                     | Satuan Dasar                       | Satuan terkecil untuk stok & jual
 *  Satuan Antara (opsional)         | Satuan Antara (opsional)           | Kemasan perantara (Strip, Pack)
 *  Isi Satuan Antara (opsional)     | Isi Satuan Antara (opsional)       | 1 Satuan Antara = N Satuan Dasar
 *
 * Parser menerima kedua nama kolom (alias) sehingga template mana pun tetap terbaca.
 */
const COL_ALIASES = Object.freeze({
  purchaseUnit: ["Satuan Pembelian", "Kemasan Beli", "Satuan Beli"],
  conversion: ["Konversi", "Isi Kemasan"],
  baseUnit: ["Satuan Dasar", "Satuan"],
  midUnit: ["Satuan Antara"],
  midQty: ["Isi Satuan Antara"]
});

/** Ambil nilai pertama yang tidak kosong dari daftar nama kolom (alias). */
function pick(row, keys) {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return "";
}

/**
 * 1. EXPORT MASTER PRODUK (SELURUH DATA)
 */
export function exportMasterData(masterStore = {}) {
  const XLSX = getXLSX();
  const wb = XLSX.utils.book_new();

  // Waktu & Penamaan File
  const ts = getTimestampString();
  let fileSuffix = "";
  if (ts === lastExportTime) {
    lastExportCounter++;
    fileSuffix = `_${String(lastExportCounter).padStart(3, "0")}`;
  } else {
    lastExportTime = ts;
    lastExportCounter = 0;
  }
  const fileName = `Master_Produk_${ts}${fileSuffix}.xlsx`;

  // 1. Sheet PRODUK (Hanya PRODUK, istilah kolom 100% selaras dengan Faktur Pembelian)
  const produkList = Array.isArray(masterStore.produk) ? masterStore.produk : [];
  const produkRows = [
    [
      "Kode Produk Internal", "Barcode", "Nama Produk", "Kategori", "Supplier",
      "Produsen", "Harga Beli Terakhir", "Harga Jual", "Kemasan Beli",
      "Isi Kemasan", "Satuan Dasar", "Satuan Antara", "Isi Satuan Antara", "Stok Minimum", "Status"
    ]
  ];

  produkList.forEach(p => {
    produkRows.push([
      p["Kode Produk Internal"] || p["Kode Produk"] || p.id || "",
      p["Barcode"] || p.barcode || "",
      p["Nama Produk"] || p.name || "",
      p["Kategori"] || p.category || "",
      p["Supplier"] || p.supplier || "",
      p["Produsen"] || p.manufacturer || "",
      num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0),
      num(p["Harga Jual"] ?? 0),
      p["Kemasan Beli"] || p["Satuan Pembelian"] || p.purchaseUnit || p["Satuan Dasar"] || p["Satuan"] || "Pcs",
      num(p["Isi Kemasan"] ?? p["Konversi"] ?? 1),
      p["Satuan Dasar"] || p["Satuan"] || "Pcs",
      p["Satuan Antara"] || p["Satuan Dasar"] || p["Satuan"] || "Pcs",
      num(p["Isi Satuan Antara"] || 1),
      num(p["Stok Minimum"] || 0),
      p["Status"] || p["Status Produk"] || (num(p["Harga Jual"]) > 0 ? "Aktif" : "Perlu Harga Jual")
    ]);
  });
  const wsProduk = XLSX.utils.aoa_to_sheet(produkRows);

  // 2. Sheet PANDUAN_INPUT (Panduan Penulisan Input Paten & Penyelarasan Istilah Satuan)
  const panduanRows = [
    ["KOLOM / FIELD", "ATURAN PENULISAN PATEN (WAJIB DIPATUHI)", "CONTOH VALID", "CONTOH SALAH / TIDAK DITERIMA"],
    ["Kode Produk Internal", "Format standar [KodeSupplier]-NEW-[Nomor]. Tidak boleh mengandung garis miring (/ atau \\). Unik untuk setiap produk.", "RNA-NEW-001", "PRD/01, /PRD-01 (Karakter miring dilarang)"],
    ["Barcode", "Nomor barcode fisik (EAN-13, UPC). Angka murni atau kosong jika produk tidak memiliki barcode fisik.", "8999908123456", "Ada Barcode, N/A"],
    ["Nama Produk", "Nama lengkap produk beserta dosis/kemasan. Wajib diisi.", "Paracetamol 500 mg Box 100 Tab", ""],
    ["Kategori", "Nama kategori produk resmi. Dikelola langsung di Menu Kategori UI.", "Obat Bebas, Generik, Alkes", "KAT001, -"],
    ["Supplier", "Nama Perusahaan resmi supplier. Dikelola langsung di Menu Supplier UI.", "PT Kimia Farma Trading", "Supplier 1, Supplier 2"],
    ["Produsen", "Nama pabrik / manufaktur farmasi.", "PT Kimia Farma Tbk", ""],
    ["Harga Beli Terakhir", "Angka murni tanpa format mata uang atau pemisah ribuan. Desimal menggunakan titik.", "15000", "Rp 15.000, 15.000,00"],
    ["Harga Jual", "Angka murni tanpa simbol Rp. Jika bernilai 0, sistem otomatis menetapkan status 'Perlu Harga Jual'.", "18000", "Rp 18.000"],
    ["Kemasan Beli", "Satuan saat kulakan/beli ke distributor (sama persis dengan Faktur Pembelian).", "Box, Dus, Karton", ""],
    ["Isi Kemasan", "Isi Satuan Dasar di dalam 1 Kemasan Beli / Konversi (sama persis dengan Faktur Pembelian). Angka bulat minimal 1.", "100", "1 Box = 100 (Hanya tulis angka)"],
    ["Satuan Dasar", "Satuan terkecil untuk stok dan penjualan di kasir (POS).", "Tablet, Kapsul, Botol, Pcs", ""],
    ["Satuan Antara", "Satuan kemasan perantara (opsional).", "Strip, Pack", ""],
    ["Isi Satuan Antara", "Isi Satuan Dasar di dalam 1 Satuan Antara. Angka bulat minimal 1.", "10", ""],
    ["Stok Minimum", "Batas peringatan restock obat/barang.", "10", "10 Box (Hanya tulis angka)"],
    ["Status", "Pilihan status resmi: 'Aktif' (jika ada harga jual) atau 'Perlu Harga Jual' / 'Nonaktif'.", "Aktif", "Ready, Tersedia"]
  ];
  const wsPanduan = XLSX.utils.aoa_to_sheet(panduanRows);

  // 3. Sheet METADATA
  const currentVersion = Number(masterStore.version || 1);
  const metadataRows = [
    ["Master Dataset ID", "Version", "Export Date/Time", "Format/Template"],
    [`MASTER-EXP-${Date.now()}`, currentVersion, new Date().toISOString(), "Template_Master_KasirPro_V2"]
  ];
  const wsMeta = XLSX.utils.aoa_to_sheet(metadataRows);

  // Susun workbook sederhana: PRODUK, PANDUAN_INPUT, METADATA (Supplier & Kategori sudah mandiri di UI)
  XLSX.utils.book_append_sheet(wb, wsProduk, "PRODUK");
  XLSX.utils.book_append_sheet(wb, wsPanduan, "PANDUAN_INPUT");
  XLSX.utils.book_append_sheet(wb, wsMeta, "METADATA");

  XLSX.writeFile(wb, fileName);
  return { fileName, totalProduk: produkList.length, version: currentVersion };
}

/**
 * 2. ANALISIS & IMPORT MASTER PRODUK (UPDATE BUKAN REPLACE)
 */
export async function parseMasterWorkbook(file, currentMaster = {}) {
  const XLSX = getXLSX();
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array" });

  const currentProducts = Array.isArray(currentMaster.produk) ? currentMaster.produk : [];
  const prodByCode = new Map(currentProducts.map(p => [norm(p["Kode Produk"] || p["Kode Produk Internal"]), p]));

  // Metadata check
  let fileVersion = 1;
  let datasetId = "UNKNOWN";
  if (wb.SheetNames.includes("METADATA")) {
    const metaSheet = wb.Sheets["METADATA"];
    const metaData = XLSX.utils.sheet_to_json(metaSheet, { header: 1 });
    if (metaData.length > 1) {
      datasetId = text(metaData[1][0]);
      fileVersion = num(metaData[1][1]) || 1;
    }
  }

  // Parse Produk
  const sheetProdukName = wb.SheetNames.find(n => norm(n).includes("produk")) || wb.SheetNames[0];
  const wsProduk = wb.Sheets[sheetProdukName];
  const jsonProduk = XLSX.utils.sheet_to_json(wsProduk, { defval: "" });

  const added = [];
  const updated = [];
  const unchanged = [];
  const conflicts = [];

  for (const row of jsonProduk) {
    const code = text(row["Kode Produk Internal"] || row["Kode Produk"] || row["Kode"] || row.code);
    const name = text(row["Nama Produk"] || row["Nama"] || row.name);
    if (!name && !code) continue;

    const sellPrice = num(row["Harga Jual"]);
    const buyPrice = num(row["Harga Beli Terakhir"] ?? row["Harga Beli"]);
    const barcode = text(row["Barcode"]);
    const category = text(row["Kategori"]);
    const supplier = text(row["Supplier"]);
    const manufacturer = text(row["Produsen"]);
    const purchaseUnit = text(pick(row, COL_ALIASES.purchaseUnit));
    const conversion = num(pick(row, COL_ALIASES.conversion) || 1) || 1;
    const baseUnit = text(pick(row, COL_ALIASES.baseUnit) || "Pcs");
    const midUnit = text(pick(row, COL_ALIASES.midUnit)) || baseUnit;
    const midQty = num(pick(row, COL_ALIASES.midQty) || 1) || 1;
    const minStock = num(row["Stok Minimum"]);
    let status = text(row["Status"] || row["Status Produk"]);

    if (!status) {
      status = sellPrice > 0 ? "Aktif" : "Perlu Harga Jual";
    }

    const prodCode = code || `PRD-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const itemPayload = {
      id: prodCode,
      "Kode Produk": prodCode,
      "Kode Produk Internal": code || prodCode,
      "Barcode": barcode,
      "Nama Produk": name,
      "Kategori": category,
      "Supplier": supplier,
      "Produsen": manufacturer,
      "Harga Beli Terakhir": buyPrice,
      "Harga Beli": buyPrice,
      "Harga Jual": sellPrice,
      "Kemasan Beli": purchaseUnit || baseUnit,
      "Satuan Pembelian": purchaseUnit || baseUnit,
      "Isi Kemasan": conversion,
      "Konversi": conversion,
      "Satuan Dasar": baseUnit,
      "Satuan": baseUnit,
      "Satuan Antara": midUnit,
      "Isi Satuan Antara": midQty,
      "Stok Minimum": minStock,
      "Status": status
    };

    const existing = prodByCode.get(norm(code));
    if (existing) {
      // Pertahankan stok lama, jangan pernah mereset stok dari Excel Master!
      itemPayload["Stok Awal"] = existing["Stok Awal"] ?? existing.stock ?? 0;
      // Pertahankan Harga Beli Terakhir jika di Excel kosong
      if (!buyPrice && existing["Harga Beli Terakhir"]) {
        itemPayload["Harga Beli Terakhir"] = existing["Harga Beli Terakhir"];
        itemPayload["Harga Beli"] = existing["Harga Beli Terakhir"];
      }
      if (existing["Harga Jual Satuan Sedang"]) {
        itemPayload["Harga Jual Satuan Sedang"] = existing["Harga Jual Satuan Sedang"];
      }
      if (existing["Harga Jual Satuan Besar"]) {
        itemPayload["Harga Jual Satuan Besar"] = existing["Harga Jual Satuan Besar"];
      }

      // Deteksi perubahan
      const hasChange =
        norm(existing["Nama Produk"]) !== norm(name) ||
        num(existing["Harga Jual"]) !== sellPrice ||
        norm(existing["Kategori"]) !== norm(category) ||
        norm(existing["Status"]) !== norm(status) ||
        norm(existing["Satuan Pembelian"] || existing["Satuan Dasar"]) !== norm(itemPayload["Satuan Pembelian"]) ||
        norm(existing["Satuan Dasar"] || existing["Satuan"]) !== norm(baseUnit) ||
        (num(existing["Konversi"]) || 1) !== conversion ||
        norm(existing["Satuan Antara"] || existing["Satuan Dasar"]) !== norm(midUnit) ||
        (num(existing["Isi Satuan Antara"]) || 1) !== midQty;

      if (hasChange) {
        updated.push({ existing, incoming: itemPayload });
      } else {
        unchanged.push(itemPayload);
      }
    } else {
      // Produk baru: stok awal default 0 jika belum ada faktur
      itemPayload["Stok Awal"] = 0;
      added.push(itemPayload);
    }
  }

  // Parse Suppliers & Categories jika ada
  const suppliers = [];
  const sheetSupplierName = wb.SheetNames.find(n => norm(n).includes("supplier"));
  if (sheetSupplierName) {
    const wsSup = wb.Sheets[sheetSupplierName];
    const jsonSup = XLSX.utils.sheet_to_json(wsSup, { defval: "" });
    jsonSup.forEach(s => {
      const name = text(s["Nama Perusahaan"] || s["Supplier"] || s["Nama Supplier"]);
      if (name) {
        suppliers.push({
          "Nama Perusahaan": name,
          "Supplier": name,
          "Nama Sales/PIC": text(s["Nama Sales/PIC"] || s["Kontak Person"] || s.pic),
          "NPWP": text(s["NPWP"] || s.npwp)
        });
      }
    });
  }

  const categories = [];
  const sheetCategoryName = wb.SheetNames.find(n => norm(n).includes("kategori"));
  if (sheetCategoryName) {
    const wsKat = wb.Sheets[sheetCategoryName];
    const jsonKat = XLSX.utils.sheet_to_json(wsKat, { defval: "" });
    jsonKat.forEach(k => {
      const name = text(k["Nama Kategori"] || k["Nama"]);
      if (name) {
        categories.push({
          "Kode Kategori": text(k["Kode Kategori"] || k["Kode"] || name.slice(0, 3).toUpperCase()),
          "Nama Kategori": name,
          "Deskripsi": text(k["Deskripsi"] || k.description)
        });
      }
    });
  }

  return {
    datasetId,
    fileVersion,
    summary: {
      addedCount: added.length,
      updatedCount: updated.length,
      unchangedCount: unchanged.length,
      totalIncoming: added.length + updated.length + unchanged.length
    },
    added,
    updated,
    unchanged,
    suppliers,
    categories,
    sheetNames: wb.SheetNames,
    metadata: [
      { Properti: "Master Dataset ID", Nilai: datasetId },
      { Properti: "Versi Master", Nilai: fileVersion },
      { Properti: "Format Template", Nilai: "Template_Master_KasirPro_V2" }
    ]
  };
}

/**
 * 2b. EXPORT KHUSUS PERLU HARGA JUAL DENGAN RUMUS OTOMATIS EXCEL MULTI-SATUAN
 * ------------------------------------------------------------------------
 * Menghasilkan berkas Excel 9 kolom berwarna, rapi, terstruktur, non-standar:
 * Kolom 1 (A): Kode Produk
 * Kolom 2 (B): Nama Produk
 * Kolom 3 (C): Harga Beli Faktur (Rp)
 * Kolom 4 (D): Kemasan A (Box, Dus, Karton, dll) [Kuning Soft - Opsional Grosir]
 * Kolom 5 (E): Harga Jual A [Kuning Soft - Opsional Grosir]
 * Kolom 6 (F): Kemasan B (Strip, Blister, Sachet, dll) [Abu Gelap jika tidak ada]
 * Kolom 7 (G): Harga Jual B [Abu Gelap jika tidak ada]
 * Kolom 8 (H): Kemasan C (Tablet, Kaplet, Botol, Tube, dll) [Eceran Utama]
 * Kolom 9 (I): Harga Jual C [Wajib / Utama]
 */
export async function exportPricingWorkbook(items = []) {
  const ts = getTimestampString();
  const fileName = `KasirPro_Perlu_Harga_Jual_${ts}.xlsx`;

  const ExcelJS = typeof window !== "undefined" ? window.ExcelJS : (typeof globalThis !== "undefined" ? globalThis.ExcelJS : null);

  if (ExcelJS) {
    return await exportPricingWithExcelJS(items, fileName);
  } else {
    return exportPricingWithSheetJS(items, fileName);
  }
}

async function exportPricingWithExcelJS(items, fileName) {
  const ExcelJS = typeof window !== "undefined" ? window.ExcelJS : globalThis.ExcelJS;
  const wb = new ExcelJS.Workbook();
  wb.creator = "KasirPro V2";
  wb.lastModifiedBy = "KasirPro System";
  wb.created = new Date();
  wb.modified = new Date();

  // 1. Sheet DAFTAR_HARGA
  const ws = wb.addWorksheet("DAFTAR_HARGA", {
    views: [{ showGridLines: true }]
  });

  // Konfigurasi 9 Kolom Baku
  ws.columns = [
    { header: "Kode Produk", key: "code", width: 18 },
    { header: "Nama Produk", key: "name", width: 38 },
    { header: "Harga Beli Faktur (Rp)", key: "buyPrice", width: 22 },
    { header: "Kemasan A (Besar)", key: "unitA", width: 20 },
    { header: "Harga Jual A [Opsional]", key: "priceA", width: 24 },
    { header: "Kemasan B (Sedang)", key: "unitB", width: 20 },
    { header: "Harga Jual B [Sedang]", key: "priceB", width: 22 },
    { header: "Kemasan C (Eceran)", key: "unitC", width: 18 },
    { header: "Harga Jual C [Eceran]", key: "priceC", width: 22 }
  ];

  // Styling Header (Baris 1)
  const headerRow = ws.getRow(1);
  headerRow.height = 32;
  headerRow.eachCell((cell, colNumber) => {
    cell.font = { name: "Segoe UI", size: 10.5, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };

    if (colNumber === 4 || colNumber === 5) {
      // Kelompok A (Amber / Kuning Tebal untuk teks putih)
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFB45309" }
      };
    } else if (colNumber === 6 || colNumber === 7) {
      // Kelompok B (Slate Dark)
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF334155" }
      };
    } else if (colNumber === 8 || colNumber === 9) {
      // Kelompok C (Emerald Hijau Eceran Utama)
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF047857" }
      };
    } else {
      // Info Produk & Faktur (Teal Medical)
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF0F766E" }
      };
    }

    cell.border = {
      top: { style: "thin", color: { argb: "FF0F172A" } },
      bottom: { style: "medium", color: { argb: "FF0F172A" } },
      left: { style: "thin", color: { argb: "FF0F172A" } },
      right: { style: "thin", color: { argb: "FF0F172A" } }
    };
  });

  const dataBorder = {
    top: { style: "thin", color: { argb: "FFE2E8F0" } },
    bottom: { style: "thin", color: { argb: "FFE2E8F0" } },
    left: { style: "thin", color: { argb: "FFE2E8F0" } },
    right: { style: "thin", color: { argb: "FFE2E8F0" } }
  };

  // Warna Kuning Soft untuk Kolom A (Opsional Grosir)
  const yellowFill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFEF9C3" } // Pastel Yellow
  };

  // Warna Abu Gelap / Charcoal untuk Sel Satuan B Non-Aktif
  const disabledFill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF334155" } // Dark Slate
  };

  const disabledFont = {
    name: "Segoe UI",
    size: 10,
    color: { argb: "FF94A3B8" },
    italic: true
  };

  const standardFont = {
    name: "Segoe UI",
    size: 10,
    color: { argb: "FF0F172A" }
  };

  const boldFont = {
    name: "Segoe UI",
    size: 10,
    bold: true,
    color: { argb: "FF0F172A" }
  };

  // Isi Baris Data
  items.forEach((p, idx) => {
    const r = idx + 2;

    const code = p["Kode Produk"] || p["Kode Produk Internal"] || p.id || "";
    const name = p["Nama Produk"] || p.name || "";

    const baseUnit = String(p["Satuan Dasar"] || p["Satuan"] || "Pcs").trim();
    const midUnit = String(p["Satuan Antara"] || "").trim();
    const midQty = num(p["Isi Satuan Antara"] || 1);
    const buyUnit = String(p["Kemasan Beli"] || p["Satuan Pembelian"] || baseUnit).trim();
    const conversion = Math.max(1, num(p["Konversi"] ?? p["Isi Kemasan"] ?? 1));

    const hasMid = Boolean(midUnit && norm(midUnit) !== norm(baseUnit) && midQty > 1);
    const hasBuy = Boolean(buyUnit && norm(buyUnit) !== norm(baseUnit) && (!midUnit || norm(buyUnit) !== norm(midUnit)) && conversion > 1);

    const buyPrice = num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0);
    const modalEceran = Math.round(buyPrice / conversion);

    const curBase = num(p["Harga Jual"]);
    const defaultSellBase = curBase > 0 ? curBase : (modalEceran > 0 ? Math.ceil((modalEceran * 1.2) / 100) * 100 : 0);

    const curMid = num(p["Harga Jual Satuan Sedang"]);
    const defaultSellMid = curMid > 0 ? curMid : (hasMid ? defaultSellBase * midQty : 0);

    const curBuy = num(p["Harga Jual Satuan Besar"]);
    const defaultSellBuy = curBuy > 0 ? curBuy : (hasBuy ? defaultSellBase * conversion : defaultSellBase);

    const row = ws.addRow({
      code,
      name,
      buyPrice,
      unitA: hasBuy ? `${buyUnit} (${conversion} ${baseUnit})` : buyUnit,
      priceA: hasBuy 
        ? { formula: `I${r}*${conversion}`, result: defaultSellBuy } 
        : { formula: `I${r}`, result: defaultSellBase },
      unitB: hasMid ? `${midUnit} (${midQty} ${baseUnit})` : "-",
      priceB: hasMid 
        ? { formula: `I${r}*${midQty}`, result: defaultSellMid } 
        : "-",
      unitC: baseUnit,
      priceC: { formula: `ROUNDUP((C${r}/${conversion})*1.2,-2)`, result: defaultSellBase }
    });

    row.height = 24;

    // Kolom 1: Kode Produk
    const c1 = row.getCell(1);
    c1.font = standardFont;
    c1.border = dataBorder;
    c1.alignment = { vertical: "middle", horizontal: "center" };

    // Kolom 2: Nama Produk
    const c2 = row.getCell(2);
    c2.font = boldFont;
    c2.border = dataBorder;
    c2.alignment = { vertical: "middle", horizontal: "left" };

    // Kolom 3: Harga Beli Faktur (Rp)
    const c3 = row.getCell(3);
    c3.font = standardFont;
    c3.border = dataBorder;
    c3.numFmt = '"Rp "#,##0';
    c3.alignment = { vertical: "middle", horizontal: "right" };

    // Kolom 4 & 5: Satuan A & Harga Jual A (KUNING SOFT - OPSIONAL)
    const c4 = row.getCell(4);
    c4.font = standardFont;
    c4.fill = yellowFill;
    c4.border = dataBorder;
    c4.alignment = { vertical: "middle", horizontal: "center" };

    const c5 = row.getCell(5);
    c5.font = boldFont;
    c5.fill = yellowFill;
    c5.border = dataBorder;
    c5.numFmt = '"Rp "#,##0';
    c5.alignment = { vertical: "middle", horizontal: "right" };

    // Kolom 6 & 7: Satuan B & Harga Jual B (SEDANG)
    const c6 = row.getCell(6);
    const c7 = row.getCell(7);

    if (hasMid) {
      c6.font = standardFont;
      c6.border = dataBorder;
      c6.alignment = { vertical: "middle", horizontal: "center" };

      c7.font = boldFont;
      c7.border = dataBorder;
      c7.numFmt = '"Rp "#,##0';
      c7.alignment = { vertical: "middle", horizontal: "right" };
    } else {
      // TIDAK ADA SATUAN B -> DIARSIR ABU GELAP / CHARCOAL OTOMATIS
      c6.font = disabledFont;
      c6.fill = disabledFill;
      c6.border = dataBorder;
      c6.alignment = { vertical: "middle", horizontal: "center" };

      c7.font = disabledFont;
      c7.fill = disabledFill;
      c7.border = dataBorder;
      c7.alignment = { vertical: "middle", horizontal: "center" };
    }

    // Kolom 8 & 9: Satuan C & Harga Jual C (ECERAN UTAMA)
    const c8 = row.getCell(8);
    c8.font = boldFont;
    c8.border = dataBorder;
    c8.alignment = { vertical: "middle", horizontal: "center" };

    const c9 = row.getCell(9);
    c9.font = boldFont;
    c9.border = dataBorder;
    c9.numFmt = '"Rp "#,##0';
    c9.alignment = { vertical: "middle", horizontal: "right" };
  });

  // 2. Sheet PANDUAN_OWNER
  const wsGuide = wb.addWorksheet("PANDUAN_OWNER", {
    views: [{ showGridLines: true }]
  });

  wsGuide.columns = [
    { header: "NO", key: "no", width: 6 },
    { header: "BAGIAN", key: "section", width: 30 },
    { header: "PETUNJUK LENGKAP UNTUK OWNER / PEMILIK APOTEK", key: "desc", width: 85 }
  ];

  const guideHeader = wsGuide.getRow(1);
  guideHeader.height = 30;
  guideHeader.eachCell(c => {
    c.font = { name: "Segoe UI", size: 10.5, bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } };
    c.alignment = { vertical: "middle", horizontal: "center" };
  });

  const guideItems = [
    { no: 1, section: "Kolom I (Harga Jual C - Eceran)", desc: "Kolom ini adalah harga jual satuan eceran utama (Kaplet / Botol / Tablet / Pcs). Sudah terisi rumus otomatis estimasi laba 20% pembulatan ratusan. Anda bebas langsung mengetik nominal harga eceran yang diinginkan (misal: 600, 1500, 5000)." },
    { no: 2, section: "Kolom G (Harga Jual B - Sedang)", desc: "Otomatis menghitung kelipatan dari Harga Eceran (Kolom I) dikali isi kemasan sedang (misal Strip = 10 x Eceran). Jika produk tidak memiliki kemasan sedang, sel ini otomatis berwarna abu gelap dan tidak perlu diisi." },
    { no: 3, section: "Kolom E (Harga Jual A - Kuning Soft)", desc: "Warna kuning menandakan kolom ini bersifat opsional untuk diskon grosir pembelian kemasan besar (Box/Dus/Karton). Otomatis menghitung kelipatan, namun Anda bisa mengetik langsung harga diskon grosir jika diinginkan." },
    { no: 4, section: "Kolom A (Kode Produk)", desc: "JANGAN mengubah atau menghapus isi Kode Produk. Kolom ini adalah kunci pencocokan otomatis sistem KasirPro." },
    { no: 5, section: "Cara Simpan & Upload", desc: "Setelah selesai, simpan berkas ini (Ctrl+S). Buka menu Master Produk di KasirPro, lalu klik tombol 'Upload & Terapkan Harga Jual'. Produk akan langsung AKTIF dan bisa ditransaksikan di kasir POS!" }
  ];

  guideItems.forEach(g => {
    const gr = wsGuide.addRow(g);
    gr.height = 24;
    gr.eachCell(c => {
      c.font = { name: "Segoe UI", size: 10 };
      c.border = dataBorder;
      c.alignment = { vertical: "middle", wrapText: true };
    });
  });

  const buffer = await wb.xlsx.writeBuffer();
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  return { fileName, count: items.length };
}

function exportPricingWithSheetJS(items, fileName) {
  const XLSX = getXLSX();
  const wb = XLSX.utils.book_new();

  const headers = [
    "Kode Produk",
    "Nama Produk",
    "Harga Beli Faktur (Rp)",
    "Kemasan A (Besar)",
    "Harga Jual A [Opsional]",
    "Kemasan B (Sedang)",
    "Harga Jual B [Sedang]",
    "Kemasan C (Eceran)",
    "Harga Jual C [Eceran]"
  ];

  const rows = [headers];

  items.forEach((p, idx) => {
    const r = idx + 2;

    const code = p["Kode Produk"] || p["Kode Produk Internal"] || p.id || "";
    const name = p["Nama Produk"] || p.name || "";

    const baseUnit = String(p["Satuan Dasar"] || p["Satuan"] || "Pcs").trim();
    const midUnit = String(p["Satuan Antara"] || "").trim();
    const midQty = num(p["Isi Satuan Antara"] || 1);
    const buyUnit = String(p["Kemasan Beli"] || p["Satuan Pembelian"] || baseUnit).trim();
    const conversion = Math.max(1, num(p["Konversi"] ?? p["Isi Kemasan"] ?? 1));

    const hasMid = Boolean(midUnit && norm(midUnit) !== norm(baseUnit) && midQty > 1);
    const hasBuy = Boolean(buyUnit && norm(buyUnit) !== norm(baseUnit) && (!midUnit || norm(buyUnit) !== norm(midUnit)) && conversion > 1);

    const buyPrice = num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0);
    const modalEceran = Math.round(buyPrice / conversion);

    const curBase = num(p["Harga Jual"]);
    const defaultSellBase = curBase > 0 ? curBase : (modalEceran > 0 ? Math.ceil((modalEceran * 1.2) / 100) * 100 : 0);

    const curMid = num(p["Harga Jual Satuan Sedang"]);
    const defaultSellMid = curMid > 0 ? curMid : (hasMid ? defaultSellBase * midQty : 0);

    const curBuy = num(p["Harga Jual Satuan Besar"]);
    const defaultSellBuy = curBuy > 0 ? curBuy : (hasBuy ? defaultSellBase * conversion : defaultSellBase);

    const cellBuyPrice = { t: "n", v: buyPrice, z: '"Rp "#,##0' };
    const cellPriceA = {
      t: "n",
      v: defaultSellBuy,
      f: hasBuy ? `I${r}*${conversion}` : `I${r}`,
      z: '"Rp "#,##0'
    };
    const cellPriceB = hasMid
      ? { t: "n", v: defaultSellMid, f: `I${r}*${midQty}`, z: '"Rp "#,##0' }
      : "-";
    const cellPriceC = {
      t: "n",
      v: defaultSellBase,
      f: `ROUNDUP((C${r}/${conversion})*1.2,-2)`,
      z: '"Rp "#,##0'
    };

    rows.push([
      code,
      name,
      cellBuyPrice,
      hasBuy ? `${buyUnit} (${conversion} ${baseUnit})` : buyUnit,
      cellPriceA,
      hasMid ? `${midUnit} (${midQty} ${baseUnit})` : "-",
      cellPriceB,
      baseUnit,
      cellPriceC
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 18 }, { wch: 38 }, { wch: 22 },
    { wch: 20 }, { wch: 24 }, { wch: 20 },
    { wch: 22 }, { wch: 18 }, { wch: 22 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, "DAFTAR_HARGA");

  const guideRows = [
    ["NO", "BAGIAN", "PETUNJUK LENGKAP UNTUK OWNER / PEMILIK APOTEK"],
    [1, "Kolom I (Harga Jual C - Eceran)", "Kolom harga satuan eceran utama (Kaplet / Botol / Tablet). Terisi rumus otomatis laba 20% pembulatan ratusan."],
    [2, "Kolom G (Harga Jual B - Sedang)", "Otomatis menghitung kelipatan dari Harga Eceran dikali isi sedang. Jika tidak ada, bertanda '-' (abu gelap)."],
    [3, "Kolom E (Harga Jual A - Kuning)", "Opsional untuk diskon grosir Box/Karton. Otomatis kelipatan atau bisa ditimpa."],
    [4, "Kolom A (Kode Produk)", "JANGAN mengubah kode produk sebagai kunci pencocokan sistem."],
    [5, "Simpan & Upload", "Simpan lalu upload kembali di KasirPro agar obat langsung AKTIF di kasir POS."]
  ];
  const wsGuide = XLSX.utils.aoa_to_sheet(guideRows);
  XLSX.utils.book_append_sheet(wb, wsGuide, "PANDUAN_OWNER");

  XLSX.writeFile(wb, fileName);
  return { fileName, count: items.length };
}

/**
 * 2c. PARSE & TERAPKAN HARGA JUAL DARI EXCEL OWNER (9 KOLOM BERWARNA)
 * ------------------------------------------------------------------
 * Membaca sheet DAFTAR_HARGA, mencocokkan kode produk,
 * memperbarui harga multi-satuan, menyetel opsi jual dan satuan dijual,
 * serta mengubah status produk menjadi Aktif (Siap Jual).
 */
export async function parsePricingWorkbook(file, currentMaster = {}) {
  const XLSX = getXLSX();
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array" });

  const sheetName = wb.SheetNames.find(n => norm(n).includes("harga") || norm(n).includes("daftar")) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    throw new Error("Sheet daftar harga tidak ditemukan di dalam berkas Excel.");
  }

  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  if (!rows || rows.length === 0) {
    throw new Error("Berkas Excel kosong atau tidak memiliki baris data harga jual.");
  }

  const currentProducts = Array.isArray(currentMaster.produk) ? currentMaster.produk : [];
  const prodByCode = new Map();
  const prodByName = new Map();
  currentProducts.forEach(p => {
    if (p._isDeleted) return;
    const code = norm(p["Kode Produk"] || p["Kode Produk Internal"] || p.id);
    const name = norm(p["Nama Produk"] || p.name);
    if (code) prodByCode.set(code, p);
    if (name) prodByName.set(name, p);
  });

  const updatedProducts = [];
  const errors = [];
  let processedCount = 0;

  for (const row of rows) {
    const rawCode = text(row["Kode Produk"] || row["Kode Produk Internal"] || row["Kode"] || row.code);
    const rawName = text(row["Nama Produk"] || row["Nama"] || row.name);

    if (!rawCode && !rawName) continue;
    processedCount++;

    const code = norm(rawCode);
    const name = norm(rawName);

    // Cari produk di master (prioritas kode, fallback nama)
    const target = (code ? prodByCode.get(code) : null) || (name ? prodByName.get(name) : null);
    if (!target) {
      errors.push(`Produk '${rawName || rawCode}' tidak ditemukan di Master Produk.`);
      continue;
    }

    // Ambil harga dari baris Excel (dukung kolom format 9-kolom baru & alias)
    let priceBase = num(
      row["Harga Jual C [Eceran]"] ?? 
      row["Harga Jual C"] ?? 
      row["Harga Jual Eceran"] ?? 
      row["Harga Jual Terkecil"] ?? 
      row["Harga Jual"]
    );
    let priceMid = num(
      row["Harga Jual B [Sedang]"] ?? 
      row["Harga Jual B"] ?? 
      row["Harga Jual Sedang"] ?? 
      row["Harga Jual Satuan Sedang"]
    );
    let priceBuy = num(
      row["Harga Jual A [Opsional]"] ?? 
      row["Harga Jual A"] ?? 
      row["Harga Jual Kemasan Beli"] ?? 
      row["Harga Jual Satuan Besar"] ?? 
      row["Harga Jual Besar"]
    );

    const baseUnit = String(target["Satuan Dasar"] || target["Satuan"] || "Pcs").trim();
    const midUnit = String(target["Satuan Antara"] || "").trim();
    const midQty = num(target["Isi Satuan Antara"] || 1);
    const buyUnit = String(target["Kemasan Beli"] || target["Satuan Pembelian"] || "").trim();
    const conversion = num(target["Konversi"] ?? target["Isi Kemasan"] ?? 1);

    const hasMid = Boolean(midUnit && norm(midUnit) !== norm(baseUnit) && midQty > 1);
    const hasBuy = Boolean(buyUnit && norm(buyUnit) !== norm(baseUnit) && (!midUnit || norm(buyUnit) !== norm(midUnit)) && conversion > 1);

    // Fallback kalkulasi jika harga dasar kosong tapi harga sedang/besar diisi
    if (priceBase <= 0) {
      if (priceMid > 0 && midQty > 1) {
        priceBase = Math.round(priceMid / midQty);
      } else if (priceBuy > 0 && conversion > 1) {
        priceBase = Math.round(priceBuy / conversion);
      } else if (priceBuy > 0) {
        priceBase = priceBuy;
      }
    }

    if (priceBase <= 0) {
      errors.push(`Produk '${target["Nama Produk"]}' dilewati karena harga jual belum diisi (> 0).`);
      continue;
    }

    // Jika harga satuan sedang / besar kosong di Excel, hitung otomatis dari harga eceran
    if (hasMid && priceMid <= 0) {
      priceMid = Math.round(priceBase * midQty);
    }
    if (hasBuy && priceBuy <= 0) {
      priceBuy = Math.round(priceBase * conversion);
    }

    // Tentukan opsi jual & satuan dijual yang aktif
    let mode = "1";
    let allowedUnits = ["base"];

    if (hasMid && hasBuy) {
      mode = "3";
      allowedUnits = ["base", "mid", "buy"];
    } else if (hasBuy) {
      mode = "2";
      allowedUnits = ["base", "buy"];
    } else if (hasMid) {
      mode = "2";
      allowedUnits = ["base", "mid"];
    } else {
      mode = "1";
      allowedUnits = ["base"];
    }

    // Perbarui target produk
    target["Harga Jual"] = priceBase;
    target["Harga Jual Satuan Sedang"] = priceMid > 0 ? priceMid : 0;
    target["Harga Jual Satuan Besar"] = priceBuy > 0 ? priceBuy : 0;
    target["Opsi Jual"] = mode;
    target["Satuan Dijual"] = allowedUnits;
    target["Status"] = "Aktif";
    target["Status Produk"] = "Aktif";

    updatedProducts.push(target);
  }

  return {
    updatedProducts,
    totalProcessed: processedCount,
    totalUpdated: updatedProducts.length,
    errors
  };
}

/**
 * 3. PARSE FAKTUR PEMBELIAN EXCEL (SHEET FAKTUR & ITEM)
 */
export async function parseInvoiceWorkbook(file, existingInvoices = [], masterProducts = []) {
  const XLSX = getXLSX();
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array" });

  const sheetFakturName = wb.SheetNames.find(n => norm(n) === "faktur" || norm(n) === "faktur_pembelian");
  const sheetItemName = wb.SheetNames.find(n => norm(n) === "item" || norm(n) === "detail_faktur");

  if (!sheetFakturName || !sheetItemName) {
    throw new Error("Format file Excel tidak sesuai standar template Faktur KasirPro V2. Wajib memiliki sheet 'FAKTUR' dan sheet 'ITEM'.");
  }

  const jsonFaktur = XLSX.utils.sheet_to_json(wb.Sheets[sheetFakturName], { defval: "" });
  const jsonItem = XLSX.utils.sheet_to_json(wb.Sheets[sheetItemName], { defval: "" });

  if (!jsonFaktur.length) {
    throw new Error("Sheet FAKTUR kosong, tidak ada data faktur yang terbaca.");
  }
  if (!jsonItem.length) {
    throw new Error("Sheet ITEM kosong, tidak ada rincian barang faktur yang terbaca.");
  }

function formatExcelDate(val) {
  if (!val) return "";
  if (typeof val === "number" && val > 30000 && val < 70000) {
    const utcDays = Math.floor(val - 25569);
    const date = new Date(utcDays * 86400 * 1000);
    return date.toISOString().slice(0, 10);
  }
  const str = String(val).trim();
  // Jika format angka serial tersimpan sebagai string angka murni
  if (/^\d{5}$/.test(str)) {
    const numVal = Number(str);
    if (numVal > 30000 && numVal < 70000) {
      const utcDays = Math.floor(numVal - 25569);
      const date = new Date(utcDays * 86400 * 1000);
      return date.toISOString().slice(0, 10);
    }
  }
  // Tanggal format DD-MM-YYYY (misal 24-08-2026) -> 2026-08-24
  const dmyMatch = str.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (dmyMatch) {
    return `${dmyMatch[3]}-${dmyMatch[2].padStart(2, "0")}-${dmyMatch[1].padStart(2, "0")}`;
  }
  // Format MM-YYYY (misal 12-2027) -> 2027-12-01
  const myMatch = str.match(/^(\d{1,2})[-\/](\d{4})$/);
  if (myMatch) {
    return `${myMatch[2]}-${myMatch[1].padStart(2, "0")}-01`;
  }
  return str;
}

  const headerRow = jsonFaktur[0];
  const supplierName = text(headerRow["Nama Supplier"] || headerRow["Supplier"]);
  const invoiceNumber = text(headerRow["No. Faktur"] || headerRow["Nomor Faktur"] || headerRow["No Faktur"]);
  const invoiceDate = formatExcelDate(headerRow["Tanggal Faktur"] || headerRow["Tanggal"]);
  const subtotalFaktur = num(headerRow["Subtotal Faktur"] || headerRow["Subtotal"]);
  const discPercent = num(headerRow["Diskon Global (%)"] || headerRow["Diskon (%)"]);
  const discRp = num(headerRow["Diskon Global (Rp)"] || headerRow["Diskon Faktur"] || headerRow["Diskon"]);
  const taxPercent = num(headerRow["PPN Global (%)"] || headerRow["PPN (%)"]);
  const taxRp = num(headerRow["PPN Global (Rp)"] || headerRow["PPN Global"]);
  const totalFaktur = num(headerRow["Total Faktur"] || headerRow["Total"]);
  const notes = text(headerRow["Catatan"] || headerRow["Keterangan"]);

  if (!invoiceNumber) {
    throw new Error("Nomor Faktur wajib diisi pada sheet FAKTUR.");
  }

  // 1. Validasi Duplikasi Nomor Faktur
  const duplicate = existingInvoices.find(inv =>
    norm(inv.invoiceNumber || inv.id) === norm(invoiceNumber) &&
    (norm(inv.status) === "terkonfirmasi" || norm(inv.status) === "confirmed")
  );
  if (duplicate) {
    throw new Error(`Nomor Faktur [${invoiceNumber}] sudah pernah dikonfirmasi sebelumnya! Import ditolak seluruhnya untuk mencegah data ganda.`);
  }

  // 2. Parse & Validasi Item
  let calcSubtotal = 0;
  let calcItemDiscount = 0;
  let calcItemTax = 0;

  const prodByCode = new Map(masterProducts.map(p => [norm(p["Kode Produk"]), p]));
  const prodByBarcode = new Map(masterProducts.filter(p => p["Barcode"]).map(p => [norm(p["Barcode"]), p]));
  const prodByName = new Map(masterProducts.map(p => [norm(p["Nama Produk"]), p]));

  const items = [];
  let issueCount = 0;

  jsonItem.forEach((row, idx) => {
    const rawName = text(row["Nama Barang"] || row["Nama Produk"]);
    if (!rawName) return;

    const barcode = text(row["Barcode"]);
    const refCode = text(row["Kode Ref Supplier"]);
    const manufacturer = text(row["Produsen"]);
    const qty = num(row["Qty"] || 1);
    const kemasanBeli = text(pick(row, COL_ALIASES.purchaseUnit) || "Box");
    const expDate = formatExcelDate(row["Exp. Date"] || row["Tanggal Expired"]);
    const batch = text(row["Batch"]);
    const hargaSatuan = num(row["Harga Satuan"] || row["Harga Beli"]);
    const discItemPct = num(row["Disc Item (%)"] || row["Diskon (%)"]);
    const discItemRp = num(row["Disc Item (Rp)"] || row["Diskon Item"]);
    const ppnItemPct = num(row["PPN Item (%)"] || row["PPN (%)"]);
    const ppnItemRp = num(row["PPN Item (Rp)"]);
    const subtotalItem = num(row["Subtotal Item"] || (qty * hargaSatuan - discItemRp));
    const satuanDasar = text(row["Satuan Dasar"] || "Pcs");
    const isiKemasan = num(pick(row, COL_ALIASES.conversion) || 1) || 1;
    const satuanAntara = text(pick(row, COL_ALIASES.midUnit)) || satuanDasar;
    const isiSatuanAntara = num(pick(row, COL_ALIASES.midQty) || 1) || 1;
    let statusKonversi = text(row["Status Konversi"] || "TERVERIFIKASI").toUpperCase();

    // Kalkulasi subtotal item sistem
    const itemNet = (qty * hargaSatuan) - discItemRp;
    calcSubtotal += (qty * hargaSatuan);
    calcItemDiscount += discItemRp;
    calcItemTax += ppnItemRp;

    // Pencocokan Produk
    let matchingStatus = "Produk Baru";
    let matchedProduct = null;

    if (barcode && prodByBarcode.has(norm(barcode))) {
      matchingStatus = "Cocok Pasti";
      matchedProduct = prodByBarcode.get(norm(barcode));
    } else if (prodByName.has(norm(rawName))) {
      matchingStatus = "Cocok Pasti";
      matchedProduct = prodByName.get(norm(rawName));
    } else {
      // Cari kemiripan nama
      const normN = norm(rawName);
      const possible = masterProducts.find(p => normN.includes(norm(p["Nama Produk"])) || norm(p["Nama Produk"]).includes(normN));
      if (possible) {
        matchingStatus = "Kemungkinan Cocok";
        matchedProduct = possible;
        issueCount++;
      } else {
        matchingStatus = "Produk Baru";
      }
    }

    // Validasi silang konversi faktur vs Master Produk (tidak boleh menebak)
    let conversionNote = "";
    if (matchedProduct) {
      const mBase = text(matchedProduct["Satuan Dasar"] || matchedProduct["Satuan"]);
      const mConv = num(matchedProduct["Konversi"]) || 1;
      const mBuy = text(matchedProduct["Satuan Pembelian"]);
      const masterConfigured = mConv > 1 || (mBuy && norm(mBuy) !== norm(mBase));
      if (masterConfigured && statusKonversi !== "TIDAK DIPERLUKAN") {
        if (mBase && norm(mBase) !== norm(satuanDasar)) {
          conversionNote = `Satuan Dasar faktur (${satuanDasar}) berbeda dengan Master (${mBase}).`;
        } else if (mConv !== isiKemasan) {
          conversionNote = `Isi Kemasan faktur (${isiKemasan}) berbeda dengan Konversi Master (${mConv}).`;
        }
      }
    }
    if (conversionNote) {
      statusKonversi = "PERLU REVIEW";
    }

    if (statusKonversi === "PERLU REVIEW") {
      issueCount++;
    }

    items.push({
      itemNumber: idx + 1,
      name: rawName,
      namaBarang: rawName,
      barcode,
      refCode,
      manufacturer,
      qty,
      purchaseUnit: kemasanBeli,
      expiryDate: expDate,
      batch,
      buyPrice: hargaSatuan,
      discountPercent: discItemPct,
      discountRp: discItemRp,
      taxPercent: ppnItemPct,
      taxRp: ppnItemRp,
      subtotal: subtotalItem,
      baseUnit: satuanDasar,
      conversionRatio: isiKemasan,
      intermediateUnit: satuanAntara,
      intermediateQty: isiSatuanAntara,
      conversionStatus: statusKonversi,
      conversionNote,
      matchingStatus,
      matchedProductCode: matchedProduct ? matchedProduct["Kode Produk"] : null,
      matchedProductName: matchedProduct ? matchedProduct["Nama Produk"] : null
    });
  });

  // 3. Kalkulasi Diskon & PPN Sistem (Mendukung Metode Per Item, Metode Global, dan Rekapitulasi Anti-Double-Deduction)
  let effectiveDiscount = 0;
  let effectiveGlobalDiscount = 0;
  const rawGlobalDiscount = discRp > 0 ? discRp : (calcSubtotal * discPercent / 100);

  if (calcItemDiscount > 0) {
    // Terdapat diskon per item di sheet ITEM
    if (rawGlobalDiscount === 0) {
      // Diskon murni per item (Metode A: prompt GPT mengisi 0 pada Diskon Global)
      effectiveDiscount = calcItemDiscount;
      effectiveGlobalDiscount = 0;
    } else if (Math.abs(rawGlobalDiscount - calcItemDiscount) <= INVOICE_TOLERANCE_RP) {
      // Rekapitulasi: Nilai Diskon Global pada Sheet FAKTUR sama dengan total diskon item (seperti Faktur PT ROSA)
      // Jangan kurangkan dua kali!
      effectiveDiscount = calcItemDiscount;
      effectiveGlobalDiscount = 0;
    } else if (rawGlobalDiscount > calcItemDiscount + INVOICE_TOLERANCE_RP) {
      // Periksa apakah rawGlobalDiscount adalah akumulasi total diskon ATAU diskon ekstra tambahan
      const dppOpt1 = Math.max(0, calcSubtotal - rawGlobalDiscount);
      const dppOpt2 = Math.max(0, calcSubtotal - calcItemDiscount - rawGlobalDiscount);
      const taxOpt1 = taxRp > 0 ? taxRp : Math.round(dppOpt1 * (taxPercent || 11) / 100);
      const taxOpt2 = taxRp > 0 ? taxRp : Math.round(dppOpt2 * (taxPercent || 11) / 100);
      const selisih1 = Math.abs(totalFaktur - (dppOpt1 + taxOpt1));
      const selisih2 = Math.abs(totalFaktur - (dppOpt2 + taxOpt2));

      if (selisih1 <= selisih2) {
        effectiveDiscount = rawGlobalDiscount;
        effectiveGlobalDiscount = rawGlobalDiscount - calcItemDiscount;
      } else {
        effectiveDiscount = calcItemDiscount + rawGlobalDiscount;
        effectiveGlobalDiscount = rawGlobalDiscount;
      }
    } else {
      // rawGlobalDiscount lebih kecil dari calcItemDiscount (berarti diskon ekstra tambahan)
      effectiveDiscount = calcItemDiscount + rawGlobalDiscount;
      effectiveGlobalDiscount = rawGlobalDiscount;
    }
  } else {
    // Tidak ada diskon per item (Metode B: Diskon Murni Global di footer)
    effectiveDiscount = rawGlobalDiscount;
    effectiveGlobalDiscount = rawGlobalDiscount;
  }

  // Dasar Pengenaan Pajak (DPP)
  const dpp = Math.max(0, calcSubtotal - effectiveDiscount);

  // Kalkulasi PPN Efektif (Per Item vs Global di Footer)
  let effectiveTax = 0;
  if (calcItemTax > 0) {
    if (taxRp > 0 && Math.abs(taxRp - calcItemTax) <= INVOICE_TOLERANCE_RP) {
      // taxRp di header adalah rekapitulasi PPN item
      effectiveTax = calcItemTax;
    } else if (taxRp > 0) {
      effectiveTax = calcItemTax + taxRp;
    } else {
      effectiveTax = calcItemTax;
    }
  } else {
    // PPN Global (Mayoritas faktur distributor farmasi seperti PT. ROSA)
    if (taxRp > 0) {
      effectiveTax = taxRp;
    } else if (taxPercent > 0) {
      effectiveTax = Math.round(dpp * taxPercent / 100);
    }
  }

  const totalHitungSistem = dpp + effectiveTax;
  const selisih = Math.abs(totalFaktur - totalHitungSistem);

  let status = "Siap Konfirmasi";
  let statusMessage = "Validasi berhasil, faktur siap dikonfirmasi.";

  if (selisih > INVOICE_TOLERANCE_RP) {
    status = "Perlu Review";
    statusMessage = `Selisih hitung sistem (Rp${totalHitungSistem}) vs total faktur (Rp${totalFaktur}) sebesar Rp${selisih} melebihi batas toleransi Rp10.`;
    issueCount++;
  } else if (issueCount > 0) {
    status = "Perlu Review";
    statusMessage = `Terdapat ${issueCount} item yang membutuhkan review konversi atau pencocokan produk.`;
  }

  return {
    invoice: {
      id: `INV-${invoiceNumber}`,
      invoiceNumber,
      supplierName,
      supplier: supplierName,
      date: invoiceDate,
      subtotal: subtotalFaktur || calcSubtotal,
      grossSubtotal: calcSubtotal,
      itemDiscountTotal: calcItemDiscount,
      globalDiscountRp: effectiveGlobalDiscount,
      totalDiscountRp: effectiveDiscount,
      dpp,
      itemTaxTotal: calcItemTax,
      globalTaxRp: effectiveTax,
      total: totalFaktur,
      totalHitungSistem,
      selisih,
      toleranceMet: selisih <= INVOICE_TOLERANCE_RP,
      notes,
      status,
      statusMessage,
      items
    },
    issueCount
  };
}
