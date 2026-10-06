-- =============================================================================
-- KASIRPRO V2 - SUPABASE POSTGRESQL DATABASE SCHEMA
-- Skema Relasional Apotek & POS (Single Source of Truth)
-- =============================================================================

-- 1. EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. TABEL PENGATURAN TOKO (store_settings)
CREATE TABLE IF NOT EXISTS public.store_settings (
    id TEXT PRIMARY KEY DEFAULT 'toko_utama',
    store_name TEXT NOT NULL DEFAULT 'Apotek Doa Ibu',
    address TEXT DEFAULT 'Jl. Raya Sehat No. 123',
    phone TEXT DEFAULT '081234567890',
    receipt_size TEXT NOT NULL DEFAULT '58 mm',
    receipt_footer TEXT DEFAULT 'Terima kasih atas kunjungan Anda',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert profil default jika belum ada
INSERT INTO public.store_settings (id, store_name, address, phone, receipt_size, receipt_footer)
VALUES ('toko_utama', 'Apotek Doa Ibu', 'Jl. Raya Sehat No. 123', '081234567890', '58 mm', 'Terima kasih atas kunjungan Anda')
ON CONFLICT (id) DO NOTHING;

-- 3. TABEL PROFIL PENGGUNA (profiles)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id UUID UNIQUE,
    username TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'cashier')),
    status TEXT NOT NULL DEFAULT 'aktif' CHECK (status IN ('aktif', 'nonaktif')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Akun Default Administrator
INSERT INTO public.profiles (username, name, role, status)
VALUES ('admin', 'Administrator Apotek', 'admin', 'aktif')
ON CONFLICT (username) DO NOTHING;

-- 4. TABEL KATEGORI PRODUK (categories)
CREATE TABLE IF NOT EXISTS public.categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. TABEL SUPPLIER / PBF (suppliers)
CREATE TABLE IF NOT EXISTS public.suppliers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    company_name TEXT,
    phone TEXT,
    address TEXT,
    status TEXT NOT NULL DEFAULT 'Aktif',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. TABEL MASTER PRODUK / OBAT (products)
CREATE TABLE IF NOT EXISTS public.products (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    barcode TEXT,
    category TEXT,
    supplier TEXT,
    buy_price NUMERIC NOT NULL DEFAULT 0,
    sell_price NUMERIC NOT NULL DEFAULT 0,
    buy_unit TEXT NOT NULL DEFAULT 'Box',
    base_unit TEXT NOT NULL DEFAULT 'Pcs',
    mid_unit TEXT,
    conversion NUMERIC NOT NULL DEFAULT 1,
    mid_conversion NUMERIC NOT NULL DEFAULT 1,
    tiered_prices JSONB DEFAULT '[]'::jsonb,
    stock NUMERIC NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Tidak Aktif',
    min_stock NUMERIC DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_code ON public.products(code);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON public.products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_name ON public.products(name);

-- 7. TABEL SALDO STOK REALTIME (active_stocks)
CREATE TABLE IF NOT EXISTS public.active_stocks (
    product_code TEXT PRIMARY KEY,
    product_name TEXT NOT NULL,
    quantity NUMERIC NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. TABEL FAKTUR PEMBELIAN (purchase_invoices)
CREATE TABLE IF NOT EXISTS public.purchase_invoices (
    id TEXT PRIMARY KEY,
    invoice_number TEXT NOT NULL,
    supplier_name TEXT NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date DATE,
    payment_type TEXT NOT NULL DEFAULT 'tempo',
    discount_type TEXT NOT NULL DEFAULT 'item',
    global_discount_rp NUMERIC DEFAULT 0,
    ppn_rate TEXT NOT NULL DEFAULT '11',
    custom_ppn_rp NUMERIC DEFAULT 0,
    gross_total NUMERIC NOT NULL DEFAULT 0,
    total_discount NUMERIC NOT NULL DEFAULT 0,
    dpp NUMERIC NOT NULL DEFAULT 0,
    ppn NUMERIC NOT NULL DEFAULT 0,
    calculated_total NUMERIC NOT NULL DEFAULT 0,
    printed_total NUMERIC NOT NULL DEFAULT 0,
    difference NUMERIC NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Terkonfirmasi',
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoices_number ON public.purchase_invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_date ON public.purchase_invoices(date);

-- 9. TABEL TRANSAKSI PENJUALAN KASIR POS (sales)
CREATE TABLE IF NOT EXISTS public.sales (
    id TEXT PRIMARY KEY,
    transaction_number TEXT UNIQUE NOT NULL,
    date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cashier_name TEXT NOT NULL,
    cashier_id TEXT,
    payment_method TEXT NOT NULL DEFAULT 'Tunai',
    subtotal NUMERIC NOT NULL DEFAULT 0,
    discount_percent NUMERIC DEFAULT 0,
    discount_nominal NUMERIC DEFAULT 0,
    total NUMERIC NOT NULL DEFAULT 0,
    cash_paid NUMERIC NOT NULL DEFAULT 0,
    change_returned NUMERIC NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Selesai',
    void_reason TEXT,
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_number ON public.sales(transaction_number);
CREATE INDEX IF NOT EXISTS idx_sales_date ON public.sales(date);

-- 10. TABEL MUTASI KARTU STOK FIFO (stock_movements)
CREATE TABLE IF NOT EXISTS public.stock_movements (
    id TEXT PRIMARY KEY,
    product_code TEXT NOT NULL,
    product_name TEXT NOT NULL,
    type TEXT NOT NULL, -- INVOICE_IN, SALE_OUT, VOID_IN, OPNAME_SURPLUS, OPNAME_DEFICIT
    reference_id TEXT,
    batch TEXT,
    expiry_date TEXT,
    qty_in NUMERIC NOT NULL DEFAULT 0,
    qty_out NUMERIC NOT NULL DEFAULT 0,
    unit TEXT NOT NULL DEFAULT 'Pcs',
    unit_cost NUMERIC NOT NULL DEFAULT 0,
    stock_after NUMERIC NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_movements_product ON public.stock_movements(product_code);
CREATE INDEX IF NOT EXISTS idx_movements_date ON public.stock_movements(created_at);

-- 11. TABEL STOCK OPNAME (stock_opnames)
CREATE TABLE IF NOT EXISTS public.stock_opnames (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    operator TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Selesai',
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- FUNGSI SUPER CEPAT: FACTORY HARD RESET (0.05 Detik Selesai Tanpa Limit Kuota!)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.factory_hard_reset()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    TRUNCATE TABLE 
        public.products,
        public.categories,
        public.suppliers,
        public.purchase_invoices,
        public.sales,
        public.stock_movements,
        public.stock_opnames,
        public.active_stocks
    CASCADE;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Seluruh data apotek dan transaksi berhasil dikosongkan secara permanen.',
        'timestamp', NOW()
    );
END;
$$;

-- FUNGSI PEMBERSIHAN TRANSAKSI UJI COBA (HANYA FAKTUR & MUTASI, KATALOG AMAN)
CREATE OR REPLACE FUNCTION public.purge_testing_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    TRUNCATE TABLE 
        public.purchase_invoices,
        public.sales,
        public.stock_movements,
        public.stock_opnames,
        public.active_stocks
    CASCADE;

    -- Reset stok seluruh produk ke 0 dan status ke Tidak Aktif
    UPDATE public.products
    SET stock = 0, status = 'Tidak Aktif', updated_at = NOW()
    WHERE id IS NOT NULL;

    RETURN jsonb_build_object(
        'success', true,
        'message', 'Seluruh faktur pembelian, penjualan, mutasi stok berhasil dibersihkan dan saldo stok produk kembali ke 0.',
        'timestamp', NOW()
    );
END;
$$;

-- =============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- Memberikan izin akses baca/tulis penuh ke aplikasi klien
-- =============================================================================
ALTER TABLE public.store_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.active_stocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_opnames ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public full access store_settings" ON public.store_settings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public full access profiles" ON public.profiles FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public full access categories" ON public.categories FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public full access suppliers" ON public.suppliers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public full access products" ON public.products FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public full access active_stocks" ON public.active_stocks FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public full access purchase_invoices" ON public.purchase_invoices FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public full access sales" ON public.sales FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public full access stock_movements" ON public.stock_movements FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Public full access stock_opnames" ON public.stock_opnames FOR ALL USING (true) WITH CHECK (true);

-- Berikan izin akses RPC
GRANT EXECUTE ON FUNCTION public.factory_hard_reset() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_testing_data() TO anon, authenticated, service_role;
