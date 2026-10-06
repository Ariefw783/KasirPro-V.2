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
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;
  const s = String(val ?? 0).trim();
  if (!s) return 0;
  // Jika format ribuan Indonesia dengan pemisah titik (misal: "39.048", "1.240.099")
  if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    return Number(s.replace(/\./g, "")) || 0;
  }
  return Number(s.replace(/[^0-9.-]/g, "")) || 0;
}

export function parseMoney(val) {
  if (typeof val === "number") return Number.isFinite(val) ? val : 0;
  const digits = String(val ?? "").replace(/[^0-9-]/g, "");
  return parseInt(digits, 10) || 0;
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

/**
 * Normalisasi Cerdas Nama Produk Farmasi
 * Membersihkan kode PBF, menyelaraskan singkatan obat, dan merapatkan spasi dosis.
 *
 * @param {string} name
 * @returns {string}
 */
export function normalizeProductName(name) {
  let s = String(name || "").toUpperCase();
  // Hapus tanda kurung beserta isinya jika berupa kode PBF atau keterangan kemasan
  s = s.replace(/\((B|PRE|PREKUSOR|OOT|HJ|BTL|KAP|TAB|SYR|STRIP|BOX|GEN|PATEN|OBAT BEBAS|BEBAS TERBATAS|KERAS)\)/gi, " ");
  s = s.replace(/\([^)]*\)/g, " "); // Hapus tanda kurung umum
  // Standarkan singkatan farmasi
  s = s.replace(/\bSYR\b/gi, "SIRUP");
  s = s.replace(/\bTAB\b/gi, "TABLET");
  s = s.replace(/\b(KPT|KAP)\b/gi, "KAPLET");
  s = s.replace(/\bINJ\b/gi, "INJEKSI");
  s = s.replace(/\bCRM\b/gi, "CREAM");
  s = s.replace(/\bBTL\b/gi, "BOTOL");
  // Rapatkan spasi dosis numerik: "500 MG" -> "500MG", "60 ML" -> "60ML"
  s = s.replace(/\b(\d+(?:[.,]\d+)?)\s+(MG|G|GR|ML|MCG|IU|UI|L|KG)\b/gi, "$1$2");
  // Hapus karakter non-alfanumerik kecuali tanda hubung / titik
  s = s.replace(/[^A-Z0-9\s.-]/g, " ");
  // Rapikan spasi ganda
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Kalkulasi Levenshtein Distance antar dua string
 *
 * @param {string} s1
 * @param {string} s2
 * @returns {number}
 */
export function levenshteinDistance(s1, s2) {
  const a = String(s1 || "").toLowerCase();
  const b = String(s2 || "").toLowerCase();
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const val = a[i - 1] === b[j - 1] ? row[j - 1] : Math.min(row[j - 1], row[j], prev) + 1;
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

/**
 * Menghitung tingkat kemiripan (Similarity Score) 0.0 - 1.0 (0% - 100%)
 * Menggabungkan Levenshtein distance ratio dan token-word overlap.
 *
 * @param {string} s1
 * @param {string} s2
 * @returns {number}
 */
export function stringSimilarity(s1, s2) {
  const str1 = String(s1 || "").trim().toLowerCase();
  const str2 = String(s2 || "").trim().toLowerCase();
  if (!str1 && !str2) return 1;
  if (!str1 || !str2) return 0;
  if (str1 === str2) return 1;

  const len1 = str1.length;
  const len2 = str2.length;
  const maxLen = Math.max(len1, len2);
  const minLen = Math.min(len1, len2);

  // Fast length pruning: jika selisih panjang terlalu besar, skor similarity tidak mungkin tinggi
  if (maxLen > 0 && (minLen / maxLen) < 0.45) {
    return Math.max(0, minLen / maxLen * 0.5);
  }

  // 1. Karakter Levenshtein Ratio
  const levDist = levenshteinDistance(str1, str2);
  const charScore = Math.max(0, 1 - (levDist / maxLen));

  // 2. Token-level Alignment Score (dioptimasi dengan Set $O(1)$)
  const tokens1 = str1.split(/\s+/).filter(Boolean);
  const tokens2 = str2.split(/\s+/).filter(Boolean);
  if (!tokens1.length || !tokens2.length) return charScore;

  const set2 = new Set(tokens2);
  const set1 = new Set(tokens1);

  let sumScore1 = 0;
  for (const t1 of tokens1) {
    if (set2.has(t1)) {
      sumScore1 += 1;
      continue;
    }
    let maxTScore = 0;
    for (const t2 of tokens2) {
      if (Math.abs(t1.length - t2.length) > 3) continue;
      const dist = levenshteinDistance(t1, t2);
      const score = Math.max(0, 1 - dist / Math.max(t1.length, t2.length));
      if (score > maxTScore) maxTScore = score;
    }
    sumScore1 += maxTScore;
  }
  const tokenPrecision = sumScore1 / tokens1.length;

  let sumScore2 = 0;
  for (const t2 of tokens2) {
    if (set1.has(t2)) {
      sumScore2 += 1;
      continue;
    }
    let maxTScore = 0;
    for (const t1 of tokens1) {
      if (Math.abs(t1.length - t2.length) > 3) continue;
      const dist = levenshteinDistance(t1, t2);
      const score = Math.max(0, 1 - dist / Math.max(t1.length, t2.length));
      if (score > maxTScore) maxTScore = score;
    }
    sumScore2 += maxTScore;
  }
  const tokenRecall = sumScore2 / tokens2.length;
  const tokenF1 = (tokenPrecision + tokenRecall > 0) ? (2 * tokenPrecision * tokenRecall) / (tokenPrecision + tokenRecall) : 0;
  const containmentScore = tokenPrecision >= 0.95 ? 0.95 : 0;

  return Math.max(charScore, tokenF1, (tokenPrecision * 0.7) + (tokenRecall * 0.3), containmentScore);
}

/**
 * Mencari produk master terdekat berdasarkan nama obat faktur
 *
 * @param {string} searchName
 * @param {Array} masterProducts
 * @param {number} threshold Default 0.8 (80%)
 * @returns {{ matchType: 'exact'|'fuzzy'|'none', score: number, product: Object|null }}
 */
export function findBestProductMatch(searchName, masterProducts = [], threshold = 0.8) {
  const rawQuery = String(searchName || "").trim();
  const normQuery = normalizeProductName(rawQuery);
  if (!normQuery || !Array.isArray(masterProducts) || !masterProducts.length) {
    return { matchType: "none", score: 0, product: null };
  }

  const queryTokens = new Set(normQuery.split(/\s+/).filter(Boolean));
  let bestMatch = null;
  let bestScore = 0;

  for (const p of masterProducts) {
    if (p._isDeleted) continue;
    const pName = p["Nama Produk"] || p.name || "";
    const pCode = p["Kode Produk"] || p["Kode Produk Internal"] || p.code || "";
    const pBarcode = p["Barcode"] || p.barcode || "";

    // 1. Exact match pada Barcode atau Kode Produk
    if (pBarcode && norm(pBarcode) === norm(rawQuery)) {
      return { matchType: "exact", score: 1, product: p };
    }
    if (pCode && norm(pCode) === norm(rawQuery)) {
      return { matchType: "exact", score: 1, product: p };
    }

    // 2. Exact match pada Nama Ternormalisasi
    const normMaster = p._normName || normalizeProductName(pName);
    if (normQuery === normMaster) {
      return { matchType: "exact", score: 1, product: p };
    }

    // Fast heuristic pruning: jika selisih panjang > 40%, lewati perhitungan berat
    const lenQ = normQuery.length;
    const lenM = normMaster.length;
    if (Math.min(lenQ, lenM) / Math.max(lenQ, lenM) < 0.55) {
      continue;
    }

    // 3. Fuzzy similarity
    const score = stringSimilarity(normQuery, normMaster);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = p;
    }
  }

  if (bestScore >= 0.999) {
    return { matchType: "exact", score: 1, product: bestMatch };
  }
  if (bestScore >= threshold) {
    return { matchType: "fuzzy", score: bestScore, product: bestMatch };
  }
  return { matchType: "none", score: bestScore, product: null };
}
