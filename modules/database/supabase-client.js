/**
 * modules/database/supabase-client.js
 * Supabase PostgreSQL Client Engine untuk KasirPro V2
 * 
 * Menggunakan PostgREST REST API resmi Supabase secara native,
 * ringan, cepat (0 overhead), dan bekerja mulus di PWA browser maupun Node.js.
 */

import { supabaseConfig } from "./supabase-config.js";

const BASE_URL = `${supabaseConfig.url}/rest/v1`;
const HEADERS = {
    "apikey": supabaseConfig.anonKey,
    "Authorization": `Bearer ${supabaseConfig.anonKey}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation"
};

/**
 * Eksekusi query REST API Supabase
 */
export async function supabaseRequest(endpoint, options = {}) {
    const url = endpoint.startsWith("http") ? endpoint : `${BASE_URL}/${endpoint}`;
    const config = {
        method: options.method || "GET",
        headers: {
            ...HEADERS,
            ...(options.headers || {})
        }
    };

    if (options.body) {
        config.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }

    const response = await fetch(url, config);
    if (!response.ok) {
        const errText = await response.text();
        let errMsg = errText;
        try {
            const parsed = JSON.parse(errText);
            errMsg = parsed.message || parsed.hint || errText;
        } catch (_) {}
        throw new Error(`[Supabase ${response.status}] ${errMsg}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
        return await response.json();
    }
    return await response.text();
}

/**
 * Operasi Tabel Supabase (Mirip query builder)
 */
export const supabaseDb = {
    // Ambil semua data dari tabel
    async select(table, queryParams = "select=*") {
        return await supabaseRequest(`${table}?${queryParams}`, { method: "GET" });
    },

    // Insert satu atau banyak baris
    async insert(table, rows) {
        const payload = Array.isArray(rows) ? rows : [rows];
        return await supabaseRequest(table, {
            method: "POST",
            body: payload
        });
    },

    // Upsert (insert or update on conflict)
    async upsert(table, rows, onConflict = "id") {
        const payload = Array.isArray(rows) ? rows : [rows];
        return await supabaseRequest(`${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
            method: "POST",
            headers: { "Prefer": "resolution=merge-duplicates,return=representation" },
            body: payload
        });
    },

    // Update baris berdasarkan kolom
    async update(table, data, matchColumn, matchValue) {
        return await supabaseRequest(`${table}?${encodeURIComponent(matchColumn)}=eq.${encodeURIComponent(matchValue)}`, {
            method: "PATCH",
            body: data
        });
    },

    // Delete baris berdasarkan kolom
    async delete(table, matchColumn, matchValue) {
        return await supabaseRequest(`${table}?${encodeURIComponent(matchColumn)}=eq.${encodeURIComponent(matchValue)}`, {
            method: "DELETE"
        });
    },

    // Panggil fungsi PostgreSQL RPC (misal factory_hard_reset)
    async rpc(functionName, params = {}) {
        return await supabaseRequest(`rpc/${functionName}`, {
            method: "POST",
            body: params
        });
    }
};
