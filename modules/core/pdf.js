/**
 * modules/core/pdf.js
 * Modul Cetak PDF Resmi KasirPro V2 (A4 Portrait)
 * Menggunakan jsPDF & autoTable.
 */

import { rupiah, formatDateTime, formatNumber } from "./utils.js";

function getJsPDF() {
  const jspdf = window.jspdf?.jsPDF || window.jsPDF;
  if (!jspdf) {
    throw new Error("Pustaka jsPDF belum dimuat. Periksa koneksi internet atau script jsPDF.");
  }
  return jspdf;
}

function createA4Doc() {
  const JsPDF = getJsPDF();
  return new JsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4"
  });
}

function addDocHeader(doc, title, storeSettings = {}, extraInfo = []) {
  const storeName = storeSettings["Nama Toko"] || storeSettings["Nama Apotek"] || "Apotek Doa Ibu";
  const address = storeSettings["Alamat"] || "";
  const phone = storeSettings["Telepon"] || storeSettings["No. Telepon"] || "";

  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(15, 23, 42); // slate-900
  doc.text(storeName, 14, 18);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139); // slate-500
  let y = 23;
  if (address) {
    doc.text(address, 14, y);
    y += 4;
  }
  if (phone) {
    doc.text(`Telp: ${phone}`, 14, y);
    y += 4;
  }

  doc.setDrawColor(203, 213, 225); // slate-300
  doc.setLineWidth(0.5);
  doc.line(14, y + 2, 196, y + 2);
  y += 8;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(30, 41, 59); // slate-800
  doc.text(title, 14, y);
  y += 6;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  for (const info of extraInfo) {
    if (info) {
      doc.text(info, 14, y);
      y += 4.5;
    }
  }

  return y + 2;
}

function addPageFooters(doc) {
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184); // slate-400
    doc.text(`KasirPro V2 | Dicetak: ${formatDateTime(new Date())}`, 14, 287);
    doc.text(`Halaman ${i} dari ${pageCount}`, 196, 287, { align: "right" });
  }
}

/**
 * 1. Cetak Faktur Pembelian (Purchase Invoice)
 */
export function generatePurchaseInvoicePdf(invoice, storeSettings = {}, user = "Admin") {
  const doc = createA4Doc();
  const startY = addDocHeader(doc, `FAKTUR PEMBELIAN #${invoice.invoiceNumber || invoice.id}`, storeSettings, [
    `Supplier: ${invoice.supplierName || invoice.supplier || "—"}`,
    `Tanggal Faktur: ${invoice.date || invoice.invoiceDate || "—"}`,
    `Status: ${invoice.status || "Terkonfirmasi"}`,
    `Dicetak oleh: ${user}`
  ]);

  const tableBody = (invoice.items || []).map((item, idx) => [
    idx + 1,
    item.name || item.productName || item.namaBarang || "—",
    `${item.qty || 1} ${item.purchaseUnit || item.unit || "Pcs"}`,
    rupiah(item.buyPrice || item.price || 0),
    `${item.discountPercent || 0}%`,
    `${item.taxPercent || item.ppnPercent || 0}%`,
    item.batch || "—",
    item.expiryDate || item.expDate || "—",
    rupiah(item.subtotal || 0)
  ]);

  doc.autoTable({
    startY,
    head: [["No", "Nama Barang", "Qty", "Harga Satuan", "Disc", "PPN", "Batch", "Exp Date", "Subtotal"]],
    body: tableBody,
    theme: "striped",
    headStyles: { fillColor: [15, 42, 67], textColor: 255, fontSize: 8.5 },
    styles: { fontSize: 8, cellPadding: 2.5 },
    margin: { left: 14, right: 14 }
  });

  const finalY = doc.lastAutoTable.finalY + 8;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.text(`Subtotal: ${rupiah(invoice.subtotal || 0)}`, 140, finalY);
  doc.text(`Diskon Global: ${rupiah(invoice.globalDiscountRp || invoice.discount || 0)}`, 140, finalY + 5);
  doc.text(`PPN Global: ${rupiah(invoice.globalTaxRp || invoice.tax || 0)}`, 140, finalY + 10);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text(`TOTAL FAKTUR: ${rupiah(invoice.total || 0)}`, 140, finalY + 17);

  addPageFooters(doc);
  doc.save(`Faktur_${invoice.invoiceNumber || invoice.id}_${Date.now()}.pdf`);
}

/**
 * 2. Cetak Laporan Penjualan (Sales Report)
 */
export function generateSalesReportPdf(salesList = [], filterInfo = {}, storeSettings = {}, user = "Admin") {
  const doc = createA4Doc();
  const totalOmzet = salesList.reduce((sum, s) => sum + (s.status === "VOID" ? 0 : (Number(s.total) || 0)), 0);
  const totalCompleted = salesList.filter(s => s.status !== "VOID").length;

  const startY = addDocHeader(doc, "LAPORAN PENJUALAN", storeSettings, [
    `Periode: ${filterInfo.periodLabel || "Semua Data"}`,
    `Total Transaksi Selesai: ${totalCompleted} | Total Omzet: ${rupiah(totalOmzet)}`,
    `Dicetak oleh: ${user}`
  ]);

  const tableBody = salesList.map((sale, idx) => [
    idx + 1,
    formatDateTime(sale.at || sale.createdAt),
    sale.transactionNumber || sale.id || "—",
    sale.cashierName || sale.cashier || "Kasir",
    sale.paymentMethod || "Cash",
    (sale.items || []).length,
    rupiah(sale.total || 0),
    sale.status || "SELESAI"
  ]);

  doc.autoTable({
    startY,
    head: [["No", "Waktu", "No. Transaksi", "Kasir", "Metode", "Item", "Total", "Status"]],
    body: tableBody,
    theme: "striped",
    headStyles: { fillColor: [15, 42, 67], textColor: 255, fontSize: 8.5 },
    styles: { fontSize: 8, cellPadding: 2.5 },
    margin: { left: 14, right: 14 }
  });

  addPageFooters(doc);
  doc.save(`Laporan_Penjualan_${Date.now()}.pdf`);
}

/**
 * 3. Cetak Laporan Pembelian (Purchase Report)
 */
export function generatePurchaseReportPdf(invoices = [], filterInfo = {}, storeSettings = {}, user = "Admin") {
  const doc = createA4Doc();
  const confirmed = invoices.filter(inv => inv.status === "Terkonfirmasi" || inv.status === "confirmed");
  const totalBeli = confirmed.reduce((sum, inv) => sum + (Number(inv.total) || 0), 0);

  const startY = addDocHeader(doc, "LAPORAN PEMBELIAN FAKTUR", storeSettings, [
    `Periode: ${filterInfo.periodLabel || "Semua Data"}`,
    `Total Faktur Terkonfirmasi: ${confirmed.length} | Total Nilai Pembelian: ${rupiah(totalBeli)}`,
    `Dicetak oleh: ${user}`
  ]);

  const tableBody = invoices.map((inv, idx) => [
    idx + 1,
    inv.date || inv.invoiceDate || "—",
    inv.invoiceNumber || inv.id || "—",
    inv.supplierName || inv.supplier || "—",
    (inv.items || []).length,
    rupiah(inv.subtotal || 0),
    rupiah(inv.total || 0),
    inv.status || "Terkonfirmasi"
  ]);

  doc.autoTable({
    startY,
    head: [["No", "Tanggal", "No. Faktur", "Supplier", "Jumlah Item", "Subtotal", "Total Faktur", "Status"]],
    body: tableBody,
    theme: "striped",
    headStyles: { fillColor: [15, 42, 67], textColor: 255, fontSize: 8.5 },
    styles: { fontSize: 8, cellPadding: 2.5 },
    margin: { left: 14, right: 14 }
  });

  addPageFooters(doc);
  doc.save(`Laporan_Pembelian_${Date.now()}.pdf`);
}

/**
 * 4. Cetak Laporan Stok (Stock Report)
 */
export function generateStockReportPdf(stockList = [], storeSettings = {}, user = "Admin") {
  const doc = createA4Doc();
  const totalItems = stockList.length;
  const totalUnits = stockList.reduce((sum, item) => sum + (Number(item.stock) || 0), 0);
  const totalNilai = stockList.reduce((sum, item) => sum + ((Number(item.stock) || 0) * (Number(item.buyPrice) || 0)), 0);

  const startY = addDocHeader(doc, "LAPORAN STOK AKTIF", storeSettings, [
    `Total Produk: ${formatNumber(totalItems)} | Total Unit: ${formatNumber(totalUnits)}`,
    `Estimasi Total Nilai Stok: ${rupiah(totalNilai)}`,
    `Dicetak oleh: ${user}`
  ]);

  const tableBody = stockList.map((item, idx) => [
    idx + 1,
    item.code || item["Kode Produk"] || "—",
    item.name || item["Nama Produk"] || "—",
    item.category || item["Kategori"] || "—",
    formatNumber(item.stock ?? item["Stok Awal"] ?? 0),
    formatNumber(item.minStock ?? item["Stok Minimum"] ?? 0),
    rupiah(item.buyPrice ?? item["Harga Beli Terakhir"] ?? item["Harga Beli"] ?? 0),
    rupiah((Number(item.stock ?? item["Stok Awal"] ?? 0)) * (Number(item.buyPrice ?? item["Harga Beli Terakhir"] ?? 0))),
    item.status || "Aman"
  ]);

  doc.autoTable({
    startY,
    head: [["No", "Kode", "Nama Produk", "Kategori", "Stok", "Min", "Harga Beli", "Nilai Stok", "Status"]],
    body: tableBody,
    theme: "striped",
    headStyles: { fillColor: [15, 42, 67], textColor: 255, fontSize: 8.5 },
    styles: { fontSize: 8, cellPadding: 2.5 },
    margin: { left: 14, right: 14 }
  });

  addPageFooters(doc);
  doc.save(`Laporan_Stok_${Date.now()}.pdf`);
}

/**
 * 5. Cetak Laporan Hasil Stock Opname (Stock Opname Report)
 */
export function generateStockOpnamePdf(session, storeSettings = {}, user = "Admin") {
  const doc = createA4Doc();
  const items = session.items || session.records || [];
  const startY = addDocHeader(doc, `LAPORAN STOCK OPNAME #${session.id || session.sessionNumber || "SESI"}`, storeSettings, [
    `Tanggal Sesi: ${formatDateTime(session.createdAt || session.date)}`,
    `Status: ${session.status || "Terkonfirmasi"}`,
    `Total Item Diperiksa: ${items.length}`,
    `Catatan: ${session.notes || "—"}`,
    `Dicetak oleh: ${user}`
  ]);

  const tableBody = items.map((item, idx) => [
    idx + 1,
    item.productCode || item.code || "—",
    item.productName || item.name || "—",
    formatNumber(item.systemStock ?? 0),
    formatNumber(item.physicalStock ?? 0),
    formatNumber(item.difference ?? ((item.physicalStock ?? 0) - (item.systemStock ?? 0))),
    item.reason || (item.difference === 0 ? "Sesuai" : "—"),
    item.status || "Terkonfirmasi"
  ]);

  doc.autoTable({
    startY,
    head: [["No", "Kode", "Nama Produk", "Stok Sistem", "Stok Fisik", "Selisih", "Alasan", "Status"]],
    body: tableBody,
    theme: "striped",
    headStyles: { fillColor: [15, 42, 67], textColor: 255, fontSize: 8.5 },
    styles: { fontSize: 8, cellPadding: 2.5 },
    margin: { left: 14, right: 14 }
  });

  addPageFooters(doc);
  doc.save(`Stock_Opname_${session.id || Date.now()}.pdf`);
}
