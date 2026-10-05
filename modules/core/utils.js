/**
 * modules/core/utils.js
 * Utilitas Inti KasirPro V2
 */

export const $ = (id) => document.getElementById(id);

export function text(val) {
  return String(val ?? "").trim();
}

export function norm(val) {
  return text(val).toLowerCase();
}

export function num(val) {
  return Number(String(val ?? 0).replace(/[^0-9.-]/g, "")) || 0;
}

export function rupiah(val) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(num(val));
}

export function formatNumber(val) {
  return new Intl.NumberFormat("id-ID").format(num(val));
}

export function dateOnly(val) {
  if (!val) return "";
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? text(val) : d.toISOString().slice(0, 10);
}

export function formatDateTime(val) {
  if (!val) return "—";
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? text(val) || "—" : d.toLocaleString("id-ID");
}

export function nowIso() {
  return new Date().toISOString();
}

export function uid(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function escapeHtml(val) {
  return String(val ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c] || c));
}

export function clone(val) {
  if (val === undefined) return undefined;
  return typeof structuredClone === "function" ? structuredClone(val) : JSON.parse(JSON.stringify(val));
}

/**
 * Toleransi nominal faktur: perbedaan <= Rp10 diperbolehkan
 */
export const INVOICE_TOLERANCE_RP = 10;

export function isWithinTolerance(val1, val2, tolerance = INVOICE_TOLERANCE_RP) {
  return Math.abs(num(val1) - num(val2)) <= tolerance;
}
