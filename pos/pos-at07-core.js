import "../app-dialog.js";
import {
    initializeDatabase,
    readStore,
    writeStore,
    writeStockTransaction,
    writeMasterDelta
} from "../modules/database/database-store.js";

import { signOutKasirPro } from "../modules/database/auth.js";

const databaseInitialization = initializeDatabase();

const SESSION_KEY="kasirpro_session", MASTER_KEY="kasirpro_master_store_v1", SALES_KEY="kasirpro_sales_v1", MOVEMENT_KEY="kasirpro_stock_movements_v1";
let saleInProgress=false;
let selectedCustomer = null;

function customers() {
    const m = master();
    if (!Array.isArray(m.pelanggan)) m.pelanggan = [];
    return m.pelanggan;
}

function formatNumber(v) {
    const n = Number(String(v ?? 0).replace(/[^0-9.-]/g, "")) || 0;
    return new Intl.NumberFormat("id-ID").format(n);
}

function cleanWaPhone(phone) {
    let p = String(phone || "").replace(/[^0-9]/g, "");
    if (p.startsWith("0")) p = "62" + p.slice(1);
    else if (p.startsWith("8")) p = "628" + p.slice(1);
    return p;
}

function selectCustomer(c) {
    selectedCustomer = c;
    updateCustomerBar();
    updateProjectedPoints();
}

function clearCustomer() {
    selectedCustomer = null;
    updateCustomerBar();
    updateProjectedPoints();
}

function updateCustomerBar() {
    const unselected = $("unselected-customer-display");
    const selected = $("selected-customer-display");
    if (!unselected || !selected) return;

    if (selectedCustomer) {
        unselected.style.display = "none";
        selected.style.display = "flex";
        $("selected-customer-name").textContent = selectedCustomer.name;
        $("selected-customer-phone").textContent = `(${selectedCustomer.phone})`;
        $("selected-customer-points-badge").textContent = `${formatNumber(selectedCustomer.totalPoints || 0)} Poin`;
    } else {
        unselected.style.display = "flex";
        selected.style.display = "none";
    }
}

function updateProjectedPoints() {
    const pBox = $("pos-projected-points-box");
    const pLabel = $("label-projected-points");
    if (!pBox || !pLabel) return;

    if (selectedCustomer && cart.length > 0) {
        const c = calc();
        const pts = Math.floor(c.total / 5000);
        pBox.style.display = "inline-flex";
        pLabel.textContent = `+${formatNumber(pts)} Poin`;
    } else {
        pBox.style.display = "none";
    }
}

function openCustomerModal(initialTab = "search") {
    const modal = $("customer-select-overlay");
    if (!modal) return;
    modal.hidden = false;
    switchCustomerTab(initialTab);
    if (initialTab === "search") {
        renderCustomerSearchResults();
        setTimeout(() => $("input-search-cust")?.focus(), 60);
    } else {
        setTimeout(() => $("add-cust-name")?.focus(), 60);
    }
}

function closeCustomerModal() {
    const modal = $("customer-select-overlay");
    if (!modal) return;
    modal.hidden = true;
}

function switchCustomerTab(tab) {
    const isSearch = tab === "search";
    const tSearch = $("tab-cust-search"), tAdd = $("tab-cust-add");
    const pSearch = $("pane-cust-search"), pAdd = $("pane-cust-add");

    if (tSearch && tAdd) {
        tSearch.className = isSearch ? "button button-small button-primary" : "button button-small button-secondary";
        tAdd.className = isSearch ? "button button-small button-secondary" : "button button-small button-primary";
    }
    if (pSearch) pSearch.hidden = !isSearch;
    if (pAdd) pAdd.hidden = isSearch;
}

function renderCustomerSearchResults(query = "") {
    const container = $("list-cust-results");
    if (!container) return;

    const allCusts = customers();
    const q = norm(query);
    const filtered = allCusts.filter(c => {
        if (!q) return true;
        return norm(c.name).includes(q) || norm(c.phone).includes(q);
    });

    if (!filtered.length) {
        container.innerHTML = `
            <div style="text-align:center;padding:16px;color:#94a3b8;font-size:12px;">
                Belum ada member ditemukan.<br>
                <button type="button" id="btn-empty-add-cust" class="button button-small button-secondary" style="margin-top:6px;font-size:11px;">
                    <i class="fa-solid fa-user-plus"></i> Daftarkan Sekarang
                </button>
            </div>
        `;
        $("btn-empty-add-cust")?.addEventListener("click", () => switchCustomerTab("add"));
        return;
    }

    container.innerHTML = filtered.map(c => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;">
            <div>
                <strong style="color:#0f2a43;font-size:12.5px;">${escapeHtml(c.name)}</strong>
                <div style="color:#64748b;font-size:11px;"><i class="fa-brands fa-whatsapp" style="color:#25d366;"></i> ${escapeHtml(c.phone)}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
                <span class="badge" style="background:#ecfdf5;color:#059669;font-weight:700;padding:2px 7px;border-radius:10px;font-size:11px;">
                    ${formatNumber(c.totalPoints || 0)} Poin
                </span>
                <button type="button" class="button button-small button-primary btn-select-this-cust" data-phone="${escapeHtml(c.phone)}" style="padding:3px 9px;font-size:11px;font-weight:700;">
                    Pilih
                </button>
            </div>
        </div>
    `).join("");

    container.querySelectorAll(".btn-select-this-cust").forEach(btn => {
        btn.addEventListener("click", () => {
            const p = btn.dataset.phone;
            const found = allCusts.find(x => x.phone === p);
            if (found) {
                selectCustomer(found);
                closeCustomerModal();
            }
        });
    });
}

function handleQuickAddCustomer(e) {
    e.preventDefault();
    const nameInput = $("add-cust-name");
    const phoneInput = $("add-cust-phone");
    const rawName = text(nameInput?.value);
    const rawPhone = text(phoneInput?.value).replace(/[^0-9]/g, "");

    if (!rawName) return window.KasirProDialog?.warning("Perhatian", "Nama lengkap pelanggan wajib diisi.");
    if (!rawPhone || rawPhone.length < 8) return window.KasirProDialog?.warning("Perhatian", "Nomor WhatsApp / HP tidak valid (minimal 8 digit).");

    const allCusts = customers();
    const existing = allCusts.find(c => c.phone === rawPhone || cleanWaPhone(c.phone) === cleanWaPhone(rawPhone));
    if (existing) {
        selectCustomer(existing);
        closeCustomerModal();
        window.KasirProDialog?.info("Member Ditemukan", `Member dengan nomor ${rawPhone} sudah terdaftar atas nama ${existing.name}. Member langsung dipilih.`);
        return;
    }

    const newCust = {
        id: `CUST-${rawPhone}`,
        name: rawName,
        phone: rawPhone,
        totalPoints: 0,
        totalSpent: 0,
        visitCount: 0,
        createdAt: new Date().toISOString()
    };

    allCusts.push(newCust);
    writeMasterDelta({ pelanggan: [newCust] }).catch(err => console.warn("[POS] Gagal simpan delta member:", err));
    selectCustomer(newCust);
    closeCustomerModal();
    if (nameInput) nameInput.value = "";
    if (phoneInput) phoneInput.value = "";

    window.KasirProDialog?.success("Member Berhasil Didaftarkan", `Member ${rawName} (${rawPhone}) berhasil didaftarkan dan aktif pada transaksi ini.`);
}

function sendReceiptViaWhatsApp() {
    if (!lastSale) return;
    const st = settings();
    const storeName = st["Nama Toko"] || st["Nama Apotek"] || "Apotek Doa Ibu";
    let phone = lastSale.customer?.phone || "";

    const doSend = (targetPhone) => {
        const waPhone = cleanWaPhone(targetPhone);
        if (!waPhone || waPhone.length < 9) {
            window.KasirProDialog?.warning("Nomor Tidak Valid", "Nomor WhatsApp pelanggan tidak valid.");
            return;
        }

        let msg = `*STRUK PEMBELIAN - ${storeName.toUpperCase()}*\n`;
        msg += `No. Transaksi : ${lastSale.number}\n`;
        msg += `Waktu : ${new Date(lastSale.at).toLocaleString("id-ID")}\n`;
        if (lastSale.customer) {
            msg += `Pelanggan (Member) : ${lastSale.customer.name}\n`;
        }
        msg += `--------------------------------\n`;
        (lastSale.items || []).forEach(it => {
            msg += `• ${it.name} (${it.qty} ${it.unitName}) : ${rupiah(it.subtotal)}\n`;
        });
        msg += `--------------------------------\n`;
        msg += `*TOTAL BELANJA : ${rupiah(lastSale.total)}*\n`;
        msg += `Metode Bayar : ${lastSale.paymentMethod} (${rupiah(lastSale.paid)})\n`;
        if (lastSale.change > 0) msg += `Kembalian : ${rupiah(lastSale.change)}\n`;

        if (lastSale.customer) {
            msg += `--------------------------------\n`;
            msg += `🎁 *INFO LOYALTY MEMBER*\n`;
            msg += `Poin Belanja Ini : +${formatNumber(lastSale.customer.pointsEarned || 0)} Poin\n`;
            msg += `*Total Saldo Poin : ${formatNumber(lastSale.customer.currentPoints || 0)} Poin*\n`;
            msg += `Kumpulkan terus poinnya dan tukarkan dengan hadiah menarik!\n`;
        }

        msg += `--------------------------------\n`;
        msg += `_Terima kasih atas kunjungan Anda._\n`;

        const url = `https://wa.me/${waPhone}?text=${encodeURIComponent(msg)}`;
        window.open(url, "_blank");
    };

    if (phone) {
        doSend(phone);
    } else {
        window.KasirProDialog?.prompt?.(
            "Kirim Struk via WhatsApp",
            "Masukkan nomor WhatsApp pelanggan (contoh: 081234567890):",
            ""
        ).then(inputPhone => {
            if (inputPhone) doSend(inputPhone);
        });
    }
}
const SEARCH_RESULT_LIMIT=20;

let session=null,
    cart=[],
    lastSale=null,
    searchResults=[],
    activeSearchIndex=-1,
    selectedHistorySaleId=null,
    posProductCache=[],
    posProductSearchIndex=[],
    posSearchDebounceTimer=null;

const $=id=>document.getElementById(id),
    text=v=>String(v??"").trim(),
    norm=v=>text(v).toLowerCase(),
    num=v=>Number(String(v??0).replace(/[^0-9.-]/g,""))||0,
    rupiah=v=>new Intl.NumberFormat("id-ID",{style:"currency",currency:"IDR",maximumFractionDigits:0}).format(num(v));

function master(){
    return readStore(MASTER_KEY,{});
}

function saveMaster(x){
    refreshPosProductCache(x?.produk);
    return writeStore(MASTER_KEY,x);
}

function sales(){
    return readStore(SALES_KEY,[]);
}

function saveSales(x){
    return writeStore(SALES_KEY,x);
}

function movements(){
    return readStore(MOVEMENT_KEY,[]);
}

function saveMovements(x){
    return writeStore(MOVEMENT_KEY,x);
}

function refreshPosProductCache(source) {
    posProductCache = Array.isArray(source) ? source : [];
    posProductSearchIndex = posProductCache
        .filter(activeProduct)
        .map((product) => ({
            product,
            code: norm(product["Kode Produk"]),
            name: norm(product["Nama Produk"])
        }));
}

function products(){
    return posProductCache;
}

function settings(){
    const s=master();
    const keys=["pengaturanToko","pengaturan_toko","pengaturan"];
    for(const k of keys){
        if(Array.isArray(s[k]) && s[k].length)return s[k][0]||{};
        if(s[k]&&typeof s[k]==="object" && Object.keys(s[k]).length)return s[k];
    }
    return { "Nama Toko": "Apotek Doa Ibu", "Nama Apotek": "Apotek Doa Ibu", "Footer Struk": "Terima kasih atas kunjungan Anda" };
}

function validate(){
    try{session=JSON.parse(sessionStorage.getItem(SESSION_KEY)||"null")}catch{}
    if(!session||!["admin","cashier"].includes(session.role)){
        location.replace("../index.html");
        return false;
    }
    return true;
}

function settingYes(v){
    return ["ya","yes","true","1","aktif"].includes(norm(v));
}

function escapeHtml(v){
    return text(v).replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
}

function init(){
    const initialMaster = master();
    refreshPosProductCache(initialMaster?.produk);
    if(!validate())return;
    const st=settings();
    const storeTitle = text(st["Nama Toko"] || st["Nama Apotek"] || "Apotek Doa Ibu").replace(/\s+v\.?\s*2(?:\.0)?$/i,"").trim() || "Apotek Doa Ibu";
    if ($("pos-store-name")) $("pos-store-name").textContent = storeTitle;
    $("pos-user-name").textContent=session.name||session.username||"Kasir";
    $("back-management").title=session.role==="admin"?"Buka Management":"Management khusus Administrator";

    bind();
    closeSearchResults();
    renderCart();
}

function activeProduct(p){
    const sellPrice = num(p["Harga Jual"]);
    const stock = num(p["Stok Awal"]);
    return stock > 0 && sellPrice > 0;
}

function searchableProducts(){
    return posProductSearchIndex;
}

function findSearchResults(query){
    const q=norm(query);
    if(!q)return[];
    const ranked=[];

    for(const entry of searchableProducts()){
        const { product: p, code, name } = entry;
        let score=0;

        if(code===q)score=100;
        else if(name===q)score=95;
        else if(code.startsWith(q))score=85;
        else if(name.startsWith(q))score=80;
        else if(code.includes(q))score=70;
        else if(name.includes(q))score=60;
        else continue;

        ranked.push({product:p,score});
    }

    ranked.sort((a,b)=>b.score-a.score||text(a.product["Nama Produk"]).localeCompare(text(b.product["Nama Produk"]),"id"));
    return ranked.slice(0,SEARCH_RESULT_LIMIT).map(x=>x.product);
}

function renderSearchResults(){
    const input=$("pos-search"),box=$("pos-search-results"),q=text(input.value);
    activeSearchIndex=-1;

    if(!q){
        closeSearchResults();
        return;
    }

    searchResults=findSearchResults(q);

    if(!searchResults.length){
        box.innerHTML='<div class="search-results-empty">Produk tidak ditemukan.</div>';
        box.hidden=false;
        input.setAttribute("aria-expanded","true");
        return;
    }

    box.innerHTML=searchResults.map((p,i)=>{
        const st=num(p["Stok Awal"]),mn=num(p["Stok Minimum"]),code=text(p["Kode Produk"])||"Tanpa kode";
        const availUnits=getAvailableUnitsForProduct(p);
        const primaryUnit=availUnits[0];
        const displayPrice=primaryUnit?primaryUnit.price:num(p["Harga Jual"]);
        const displayUnitLabel=primaryUnit?` / ${escapeHtml(primaryUnit.name)}`:"";
        return `
            <button
                class="search-result-item ${st<=0?'disabled':''}"
                data-search-index="${i}"
                type="button"
                role="option"
                aria-selected="false"
                ${st<=0?'disabled':''}
            >
                <span class="search-result-main">
                    <strong class="search-result-name">${escapeHtml(p["Nama Produk"]||"Produk")}</strong>
                    <span class="search-result-meta">
                        <span class="search-result-code">${escapeHtml(code)}</span>
                        <span class="search-result-stock ${st<=0?'empty':mn>0&&st<=mn?'low':''}">Stok ${st}</span>
                    </span>
                </span>
                <strong class="search-result-price">${rupiah(displayPrice)}${displayUnitLabel}</strong>
            </button>
        `;
    }).join("")+`<div class="search-results-info">Menampilkan maksimal ${SEARCH_RESULT_LIMIT} hasil</div>`;

    box.hidden=false;
    input.setAttribute("aria-expanded","true");

    box.querySelectorAll("[data-search-index]").forEach(button=>{
        button.addEventListener("click",()=>selectSearchResult(+button.dataset.searchIndex));
    });
}

function setActiveSearchIndex(index){
    if(!searchResults.length)return;
    activeSearchIndex=Math.max(0,Math.min(index,searchResults.length-1));
    const buttons=$("pos-search-results").querySelectorAll("[data-search-index]");

    buttons.forEach((button,i)=>{
        const active=i===activeSearchIndex;
        button.classList.toggle("active",active);
        button.setAttribute("aria-selected",active?"true":"false");
        if(active)button.scrollIntoView({block:"nearest"});
    });
}

function selectSearchResult(index){
    const p=searchResults[index];
    if(!p||num(p["Stok Awal"])<=0)return;
    addProduct(p);
    $("pos-search").value="";
    closeSearchResults();
    $("pos-search").focus();
}

function closeSearchResults(){
    searchResults=[];
    activeSearchIndex=-1;
    const box=$("pos-search-results");
    if(box){box.hidden=true;box.innerHTML=""}
    const input=$("pos-search");
    if(input)input.setAttribute("aria-expanded","false");
}

function getAvailableUnitsForProduct(p) {
    const units = [];
    const baseUnit = text(p["Satuan Dasar"] || p["Satuan"] || "Pcs") || "Pcs";
    const basePrice = num(p["Harga Jual"]) || 0;

    // 1. Satuan Sedang (Kemasan ritel utama apotek: Strip, Blister, Botol, Tube, Sachet, dll)
    // Jika produk memiliki satuan sedang dengan isi > 1, posisikan sebagai unit transaksi utama (default saat masuk keranjang POS)
    const midUnit = text(p["Satuan Antara"] || p["intermediateUnit"]);
    const midQty = num(p["Isi Satuan Antara"] ?? p["intermediateQty"] ?? 1);
    if (midUnit && norm(midUnit) !== norm(baseUnit) && midQty > 1) {
        const customMidPrice = num(p["Harga Jual Satuan Sedang"] ?? p["Harga Jual Sedang"]);
        const midPrice = customMidPrice > 0 ? customMidPrice : (basePrice * midQty);
        units.push({
            level: "mid",
            name: midUnit,
            multiplier: midQty,
            price: midPrice
        });
    }

    // 2. Satuan Terkecil / Eceran (Tablet, Kaplet, Kapsul, Pcs) - Selalu ada untuk eceran/racikan/puyer
    units.push({
        level: "base",
        name: baseUnit,
        multiplier: 1,
        price: basePrice
    });

    // Catatan Arsitektur: Satuan Besar (Box/Karton) sengaja TIDAK dimasukkan ke dalam opsi transaksi kasir POS.
    // Satuan Besar murni arsip data faktur supplier / HPP. Pembelian 1 box dilayani via kelipatan satuan sedang + diskon POS.

    // Filter unit jika ada pembatasan opsi satuan jual yang dikonfigurasi apotek
    if (Array.isArray(p["Satuan Dijual"]) && p["Satuan Dijual"].length > 0) {
        const filtered = units.filter(u => p["Satuan Dijual"].includes(u.level));
        if (filtered.length > 0) return filtered;
    }

    return units;
}

function addProduct(p){
    if(!p||num(p["Stok Awal"])<=0)return;

    const code=text(p["Kode Produk"]),name=text(p["Nama Produk"]);
    const availableUnits=getAvailableUnitsForProduct(p);
    const defaultUnit=availableUnits[0] || { level:"base", name: text(p["Satuan Dasar"]||"Pcs"), multiplier: 1, price: num(p["Harga Jual"]) };

    const totalUsedBase = cart.filter(x => code ? norm(x.code) === norm(code) : !x.code && norm(x.name) === norm(name))
        .reduce((sum, item) => sum + (item.qty * (item.selectedUnit?.multiplier || 1)), 0);

    const found=cart.find(x=> (code ? norm(x.code)===norm(code) : !x.code && norm(x.name)===norm(name)) && norm(x.selectedUnit?.name)===norm(defaultUnit.name));

    if(found){
        if(totalUsedBase + (found.selectedUnit?.multiplier || 1) > num(p["Stok Awal"])) {
            return window.KasirProDialog?.warning("Stok Tidak Cukup", `Qty melebihi stok yang tersedia (${num(p["Stok Awal"])} ${p["Satuan Dasar"]||""}).`);
        }
        found.qty++;
    }else{
        if(totalUsedBase + defaultUnit.multiplier > num(p["Stok Awal"])) {
            return window.KasirProDialog?.warning("Stok Tidak Cukup", `Stok tidak mencukupi untuk menambah item ini.`);
        }
        cart.push({
            code,
            name,
            price: defaultUnit.price,
            buyPrice: num(p["Harga Beli Terakhir"] ?? p["Harga Beli"] ?? 0),
            qty: 1,
            stock: num(p["Stok Awal"]),
            baseUnit: text(p["Satuan Dasar"] || "Pcs"),
            availableUnits,
            selectedUnit: defaultUnit
        });
    }

    renderCart();
}

export function addManualItem(name, unit, qty, price) {
    const cleanName = text(name);
    const cleanUnit = text(unit || "Pcs");
    const numQty = Math.max(1, parseInt(qty, 10) || 1);
    const numPrice = Math.max(0, parseInt(price, 10) || 0);

    if (!cleanName) {
        return window.KasirProDialog?.warning("Nama Diperlukan", "Silakan masukkan nama produk / obat.");
    }

    const manualId = `MANUAL-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    cart.push({
        code: "NON-KATALOG",
        manualId,
        name: cleanName,
        price: numPrice,
        buyPrice: 0,
        qty: numQty,
        stock: 999999,
        baseUnit: cleanUnit,
        availableUnits: [{ level: "base", name: cleanUnit, multiplier: 1, price: numPrice }],
        selectedUnit: { level: "base", name: cleanUnit, multiplier: 1, price: numPrice },
        isManual: true
    });

    renderCart();
}

function changeUnit(i, unitName){
    const x=cart[i];
    if(!x || x.isManual)return;
    const targetUnit=(x.availableUnits||[]).find(u=>norm(u.name)===norm(unitName));
    if(!targetUnit)return;



    const store=master();
    const plist=Array.isArray(store.produk)?store.produk:[];
    const p=findProductForCartItem(plist, x);
    const totalAvail=p ? num(p["Stok Awal"]) : x.stock;

    const otherUsed=cart.filter((item, idx)=>idx!==i && (x.code ? norm(item.code)===norm(x.code) : norm(item.name)===norm(x.name)))
        .reduce((sum, item)=>sum + (item.qty * (item.selectedUnit?.multiplier || 1)), 0);

    const needed = (x.qty * targetUnit.multiplier) + otherUsed;
    if(needed > totalAvail){
        renderCart();
        return window.KasirProDialog?.warning("Stok Tidak Cukup", `Stok tidak mencukupi untuk kemasan ${targetUnit.name} sebanyak ${x.qty}. Dibutuhkan ${x.qty * targetUnit.multiplier} ${x.baseUnit||""}, tersedia ${Math.max(0, totalAvail - otherUsed)}.`);
    }

    x.selectedUnit=targetUnit;
    x.price=targetUnit.price;
    renderCart();
}

function calc(){
    const subtotal=cart.reduce((a,x)=>a+x.price*x.qty,0),
        mode=$("cart-discount-mode").value,
        dv=num($("cart-discount-value").value),
        transDiscount=mode==="percent"?subtotal*Math.min(dv,100)/100:Math.min(dv,subtotal),
        taxBase=Math.max(0,subtotal-transDiscount),
        taxPercent=0,
        tax=0,
        total=taxBase;

    return{subtotal,itemDiscount:0,transDiscount,taxPercent,tax,total};
}

function renderCart(){
    const box=$("cart-items");

    box.innerHTML=cart.length?cart.map((x,i)=>{
        const hasMultiUnits = !x.isManual && Array.isArray(x.availableUnits) && x.availableUnits.length > 1;
        return `
        <div class="sale-line">
            <div class="line-product">
                <strong>${escapeHtml(x.name)}</strong>
                <div style="display:flex;align-items:center;gap:6px;margin-top:3px;flex-wrap:wrap;">
                    ${x.isManual ? `
                        <span style="font-size:10px;font-weight:700;padding:2px 6px;background:#fef3c7;border:1px solid #fde68a;border-radius:4px;color:#b45309;">
                            <i class="fa-solid fa-pen-nib"></i> Non-Katalog
                        </span>
                    ` : `
                        <small style="color:#64748b;">${escapeHtml(x.code||"Tanpa kode")}</small>
                    `}
                    ${hasMultiUnits ? `
                        <select class="cart-unit-select" data-cart-unit="${i}" style="padding:2px 6px;font-size:11px;font-weight:700;border:1px solid #0284c7;border-radius:4px;background:#f0f9ff;color:#0369a1;cursor:pointer;">
                            ${x.availableUnits.map(u => `
                                <option value="${escapeHtml(u.name)}" ${norm(u.name) === norm(x.selectedUnit?.name) ? 'selected' : ''}>
                                    ${escapeHtml(u.name)} (${rupiah(u.price)})
                                </option>
                            `).join('')}
                        </select>
                    ` : `
                        <span style="font-size:11px;font-weight:700;padding:2px 6px;background:#f1f5f9;border-radius:4px;color:#475569;">
                            ${escapeHtml(x.selectedUnit?.name || x.baseUnit || 'Item')}
                        </span>
                    `}
                    <small style="color:#0f172a;font-weight:700;">@ ${rupiah(x.price)}</small>
                </div>
            </div>

            <div class="qty-control">
                <button data-minus="${i}" type="button">−</button>
                <span>${x.qty}</span>
                <button data-plus="${i}" type="button">+</button>
            </div>

            <strong class="line-subtotal">${rupiah(x.price*x.qty)}</strong>

            <button class="remove-item" data-remove="${i}" type="button" aria-label="Hapus ${escapeHtml(x.name)}">
                <i class="fa-solid fa-trash"></i>
            </button>
        </div>
    `}).join(""):`
        <div class="cart-empty">
            <div>
                <i class="fa-solid fa-cart-shopping"></i>
                <p>Belum ada barang. Cari produk untuk memulai transaksi.</p>
            </div>
        </div>
    `;

    box.querySelectorAll("[data-minus]").forEach(b=>b.onclick=()=>changeQty(+b.dataset.minus,-1));
    box.querySelectorAll("[data-plus]").forEach(b=>b.onclick=()=>changeQty(+b.dataset.plus,1));
    box.querySelectorAll("[data-remove]").forEach(b=>b.onclick=()=>{cart.splice(+b.dataset.remove,1);renderCart()});
    box.querySelectorAll(".cart-unit-select").forEach(sel=>sel.onchange=(e)=>changeUnit(+sel.dataset.cartUnit, e.target.value));

    $("cart-count").textContent=`${cart.reduce((a,x)=>a+x.qty,0)} item`;
    renderTotals();
}

function changeQty(i,d){
    const x=cart[i];
    if(!x)return;
    const next=x.qty+d;
    if(next<=0){
        cart.splice(i,1);
        renderCart();
        return;
    }
    if(x.isManual){
        x.qty=next;
        renderCart();
        return;
    }

    const store=master();
    const plist=Array.isArray(store.produk)?store.produk:[];
    const p=findProductForCartItem(plist, x);
    const totalAvail=p ? num(p["Stok Awal"]) : x.stock;

    const mult = x.selectedUnit?.multiplier || 1;
    const otherUsed=cart.filter((item, idx)=>idx!==i && (x.code ? norm(item.code)===norm(x.code) : norm(item.name)===norm(x.name)))
        .reduce((sum, item)=>sum + (item.qty * (item.selectedUnit?.multiplier || 1)), 0);

    if((next * mult) + otherUsed > totalAvail){
        return window.KasirProDialog?.warning("Stok Tidak Cukup", `Qty melebihi stok yang tersedia (${totalAvail} ${x.baseUnit||""}).`);
    }
    x.qty=next;
    renderCart();
}

function renderTotals(){
    const c=calc();
    $("cart-subtotal").textContent=rupiah(c.subtotal);
    const itemDiscEl = $("cart-item-discount");
    if(itemDiscEl) itemDiscEl.textContent='-'+rupiah(c.itemDiscount);
    $("cart-transaction-discount").textContent='-'+rupiah(c.transDiscount);
    $("cart-tax").textContent=rupiah(c.tax);
    $("tax-row").style.display=c.taxPercent>0?"flex":"none";
    $("cart-total").textContent=rupiah(c.total);
    $("pay-button-total").textContent=rupiah(c.total);
}

function openPayment(){
    if(!cart.length)return window.KasirProDialog?.warning("Keranjang Kosong", "Keranjang belanja masih kosong.");
    const c=calc();
    $("payment-total").textContent=rupiah(c.total);
    $("cash-paid").value=Math.ceil(c.total);

    const now = new Date();
    const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    if ($("payment-date")) $("payment-date").value = localIso;

    updateChange();
    renderQuickCash(c.total);
    $("payment-overlay").hidden=false;
}

function renderQuickCash(total){
    const vals=[total,Math.ceil(total/10000)*10000,Math.ceil(total/50000)*50000].filter((v,i,a)=>a.indexOf(v)===i);
    $("quick-cash").innerHTML=vals.map(v=>`<button data-cash="${v}" type="button">${rupiah(v)}</button>`).join("");
    $("quick-cash").querySelectorAll("[data-cash]").forEach(b=>b.onclick=()=>{$("cash-paid").value=b.dataset.cash;updateChange()});
}

function updateChange(){
    const c=calc(),method=$("payment-method").value;
    const isCash = method === "Cash" || method === "Tunai";
    const paid = isCash ? num($("cash-paid").value) : c.total;
    $("cash-paid-label").hidden = !isCash;
    const noteEl = $("payment-custom-note-label");
    if (noteEl) noteEl.hidden = method !== "Lainnya";
    $("payment-change").textContent = rupiah(Math.max(0, paid - c.total));
}

function transactionNo(){
    const st=settings(),prefix=text(st["Prefix Transaksi"])||"TRX",d=new Date(),
        ymd=`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`,
        hms=`${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}${String(d.getSeconds()).padStart(2,"0")}`,
        suffix=Math.random().toString(36).slice(2,5).toUpperCase();
    return `${prefix}-${ymd}-${hms}-${suffix}`;
}

function findProductForCartItem(plist,item){
    if(item.isManual) return null;
    if(item.code && item.code !== "NON-KATALOG"){
        return plist.find(x=>norm(x["Kode Produk"])===norm(item.code));
    }
    return plist.find(x=>!text(x["Kode Produk"])&&norm(x["Nama Produk"])===norm(item.name));
}

async function completeSale(){
    const c=calc(),method=$("payment-method").value;
    const isCash = method === "Cash" || method === "Tunai";
    const paid = isCash ? num($("cash-paid").value) : c.total;
    if(isCash && paid < c.total) return window.KasirProDialog?.warning("Pembayaran Kurang", "Uang yang diterima masih kurang dari total transaksi.");
    if(!cart.length) return window.KasirProDialog?.warning("Keranjang Kosong", "Keranjang belanja masih kosong.");

    saleInProgress=true;
    const completeButton=$("complete-sale"),originalButtonText=completeButton.textContent;
    completeButton.disabled=true;
    completeButton.textContent="Menyimpan Transaksi…";

    const store=master(),plist=Array.isArray(store.produk)?store.produk:[],moves=movements(),number=transactionNo();

    for(const item of cart){
        if(item.isManual) continue;
        const p=findProductForCartItem(plist,item);
        const mult = item.selectedUnit?.multiplier || 1;
        const requiredBase = item.qty * mult;
        if(!p||num(p["Stok Awal"])<requiredBase){
            saleInProgress=false;
            completeButton.disabled=false;
            completeButton.textContent=originalButtonText;
            return window.KasirProDialog?.error("Stok Tidak Cukup", `Stok ${item.name} tidak mencukupi untuk transaksi ini (butuh ${requiredBase} ${p ? p["Satuan Dasar"] : ""}).`);
        }
    }

    const selectedDate = $("payment-date")?.value;
    const saleAt = selectedDate ? new Date(selectedDate).toISOString() : new Date().toISOString();
    for(const [itemIndex,item] of cart.entries()){
        if(item.isManual) continue;
        const p=findProductForCartItem(plist,item);
        if(!p) continue;
        const mult = item.selectedUnit?.multiplier || 1;
        const totalDeduct = item.qty * mult;
        const before=num(p["Stok Awal"]);
        const after=before-totalDeduct;
        p["Stok Awal"]=after;

        const unitName = item.selectedUnit?.name || p["Satuan Dasar"] || "item";
        moves.unshift({
            id:`MOV-${number}-${String(itemIndex+1).padStart(2,"0")}`,
            at:saleAt,
            createdAt:saleAt,
            type:"Penjualan Kasir",
            reference:number,
            productCode:item.code,
            productName:item.name,
            delta:-totalDeduct,
            quantity:-totalDeduct,
            stockBefore:before,
            stockAfter:after,
            source:"Transaksi Kasir (POS)",
            user:session.name || session.username || "Kasir",
            note:`Penjualan ${number} (${item.qty} ${unitName}${mult > 1 ? ` @${mult} ${p["Satuan Dasar"]||""}` : ""})`
        });
    }

    const customNote = text($("payment-custom-note")?.value);
    const recordedPaymentMethod = (method === "Lainnya" && customNote) ? `Lainnya (${customNote})` : (method || "Cash");
    const isBackdate = Boolean(selectedDate && new Date(selectedDate).toDateString() !== new Date().toDateString());

    let customerPayload = null;
    if (selectedCustomer) {
        const pointsEarned = Math.floor(c.total / 5000);
        const prevPts = num(selectedCustomer.totalPoints || 0);
        const currentPts = prevPts + pointsEarned;

        customerPayload = {
            id: selectedCustomer.id || `CUST-${selectedCustomer.phone}`,
            phone: selectedCustomer.phone,
            name: selectedCustomer.name,
            pointsEarned,
            previousPoints: prevPts,
            currentPoints: currentPts
        };

        // Update saldo member
        selectedCustomer.totalPoints = currentPts;
        selectedCustomer.totalSpent = num(selectedCustomer.totalSpent || 0) + c.total;
        selectedCustomer.visitCount = num(selectedCustomer.visitCount || 0) + 1;
        selectedCustomer.lastVisit = saleAt;

        // Persist delta customer
        writeMasterDelta({ pelanggan: [selectedCustomer] }).catch(err => console.warn("[POS] Gagal simpan delta pelanggan:", err));

        // Catat mutasi poin
        const pointLog = {
            id: `PTS-${number}`,
            type: "EARN",
            customerPhone: selectedCustomer.phone,
            customerName: selectedCustomer.name,
            points: pointsEarned,
            reference: number,
            balanceAfter: currentPts,
            at: saleAt,
            createdAt: saleAt,
            note: `Poin belanja transaksi ${number} (Rp ${formatNumber(c.total)})`
        };
        const m = master();
        if (!Array.isArray(m.mutasi_poin)) m.mutasi_poin = [];
        m.mutasi_poin.unshift(pointLog);
        writeMasterDelta({ mutasi_poin: [pointLog] }).catch(err => console.warn("[POS] Gagal simpan mutasi poin:", err));
    }

    lastSale={
        customer: customerPayload,
        id:`SALE-${Date.now()}-${String(session.username||"kasir").toLowerCase()}`,
        number,
        at:saleAt,
        createdAt:saleAt,
        cashier:session.name||session.username||"Kasir",
        role:session.role||"kasir",
        status:"SELESAI",
        isBackdate,
        items:cart.map(x=>({
            code:String(x.code||""),
            name:String(x.name||""),
            price:num(x.price),
            buyPrice:num(x.buyPrice),
            qty:num(x.qty),
            unitName:String(x.selectedUnit?.name || x.baseUnit || "item"),
            unitMultiplier:num(x.selectedUnit?.multiplier || 1),
            subtotal:num(x.subtotal || (num(x.price) * num(x.qty))),
            isManual: Boolean(x.isManual)
        })),
        discountMode:$("cart-discount-mode")?.value || "percent",
        discountValue:num($("cart-discount-value")?.value),
        ...c,
        paymentMethod:recordedPaymentMethod,
        paid:num(paid),
        change:Math.max(0,num(paid)-c.total)
    };

    const ss=sales();
    ss.unshift(lastSale);

    store.produk=plist;

    try{
        const saveResult=await writeStockTransaction([
            {key:MOVEMENT_KEY,records:moves.slice(0,cart.length)},
            {key:SALES_KEY,records:[lastSale]}
        ]);
        lastSale._localSyncStatus=saveResult.mode==="firebase-pending"?"menunggu-sinkron":"tersinkron";
    }catch(error){
        console.error("Transaksi gagal disimpan ke Firebase:",error);
        const errMsg = error?.message || "Periksa koneksi internet Anda lalu coba kembali.";
        return window.KasirProDialog?.error("Gagal Menyimpan Transaksi", `Transaksi belum dapat disimpan ke server:\n${errMsg}`);
    }finally{
        saleInProgress=false;
        completeButton.disabled=false;
        completeButton.textContent=originalButtonText;
    }

    $("payment-overlay").hidden=true;
    renderReceipt(lastSale);
    cart=[];
    $("cart-discount-value").value=0;
    clearCustomer();
    renderCart();
}

function renderReceipt(s){
    const st=settings(),
        showCashier=settingYes(st["Tampilkan Nama Kasir di Struk"]),
        showDiscount=settingYes(st["Tampilkan Diskon di Struk"]),
        isVoid=norm(s.status)==="void";

    lastSale=s;

    $("receipt-print-area").innerHTML=`
        <div class="center">
            <h2>${escapeHtml(st["Nama Toko"] || st["Nama Apotek"] || "Apotek Doa Ibu")}</h2>
            <div>${escapeHtml(st["Alamat"] || "")}</div>
            <div>${escapeHtml(st["Telepon"] || st["No. Telepon"] || "")}</div>
        </div>

        ${isVoid?'<div class="receipt-void-banner">TRANSAKSI VOID</div>':''}

        <hr>
        <div class="receipt-row"><span>No.</span><span>${escapeHtml(s.number)}</span></div>
        <div class="receipt-row"><span>Waktu</span><span>${new Date(s.at).toLocaleString("id-ID")}</span></div>
        ${showCashier?`<div class="receipt-row"><span>Kasir</span><span>${escapeHtml(s.cashier)}</span></div>`:""}
        <hr>

        ${(Array.isArray(s.items)?s.items:[]).map(i=>`
            <div class="receipt-item">
                <div>${escapeHtml(i.name)}</div>
                <div class="sub">
                    <span>${num(i.qty)} ${escapeHtml(i.unitName || '')} x ${rupiah(i.price)}</span>
                    <span>${rupiah(num(i.qty)*num(i.price))}</span>
                </div>
            </div>
        `).join("")}

        <hr>
        <div class="receipt-row"><span>Subtotal</span><span>${rupiah(s.subtotal)}</span></div>
        ${showDiscount&&num(s.transDiscount)>0?`<div class="receipt-row"><span>Diskon Transaksi</span><span>-${rupiah(num(s.transDiscount))}</span></div>`:""}
        <div class="receipt-row receipt-total"><span>TOTAL</span><span>${rupiah(s.total)}</span></div>
        <div class="receipt-row"><span>${escapeHtml(s.paymentMethod)}</span><span>${rupiah(s.paid)}</span></div>
        <div class="receipt-row"><span>Kembali</span><span>${rupiah(s.change)}</span></div>
        ${s.customer ? `
            <hr>
            <div class="receipt-row"><span>Member</span><span>${escapeHtml(s.customer.name)}</span></div>
            <div class="receipt-row"><span>Poin Masuk</span><span>+${formatNumber(s.customer.pointsEarned || 0)} Poin</span></div>
            <div class="receipt-row"><span>Saldo Poin</span><span>${formatNumber(s.customer.currentPoints || 0)} Poin</span></div>
            <div style="font-size:9.5px;text-align:center;color:#64748b;margin-top:2px;">Tukarkan poin Anda dengan hadiah menarik!</div>
        ` : ''}

        ${isVoid?`
            <hr>
            <div>VOID: ${escapeHtml(s.voidReason||"-")}</div>
            <div>Oleh: ${escapeHtml(s.voidBy||"Admin")}</div>
            <div>${s.voidAt?new Date(s.voidAt).toLocaleString("id-ID"):""}</div>
        `:""}

        <hr>
        <div class="receipt-footer">${escapeHtml(st["Footer Struk"] || st["Catatan Struk"] || "Terima kasih atas kunjungan Anda")}</div>
    `;

    applyReceiptPrintSettings(st["Ukuran Struk"]);
    $("receipt-overlay").hidden=false;
}

function applyReceiptPrintSettings(value){
    const size=["58mm","80mm","A4"].includes(text(value))?text(value):"80mm";
    document.documentElement.dataset.receiptSize=size;
    let style=document.getElementById("kasirpro-receipt-page-size");
    if(!style){style=document.createElement("style");style.id="kasirpro-receipt-page-size";document.head.appendChild(style);}
    if(size==="A4"){
        style.textContent="@media print{@page{size:A4 portrait;margin:12mm}#receipt-print-area{width:186mm!important;max-width:none!important;margin:0 auto!important;padding:0!important;font-size:11pt!important}}";
    }else{
        const fontSize=size==="58mm"?"9px":"10px";
        style.textContent=`@media print{@page{size:${size} auto;margin:3mm}#receipt-print-area{width:${size}!important;max-width:${size}!important;margin:0!important;padding:2mm!important;font-size:${fontSize}!important}}`;
    }
}

function printReceipt(){
    if(!lastSale)return;
    window.print();
}

function saveReceiptPdf(){
    if(!lastSale)return;
    const previousTitle=document.title;
    document.title=`${text(lastSale.number)||"struk"}`;
    window.print();
    setTimeout(()=>{document.title=previousTitle},500);
}

function saleStatus(s){
    return norm(s.status)==="void"?"VOID":"SELESAI";
}

function saleMatchesPeriod(s,period){
    const d=new Date(s.at);
    if(Number.isNaN(d.getTime()))return period==="all";
    if(period==="all")return true;

    const now=new Date();

    if(period==="today"){
        return d.getFullYear()===now.getFullYear()&&d.getMonth()===now.getMonth()&&d.getDate()===now.getDate();
    }

    const days=num(period);
    if(!days)return true;
    return d.getTime()>=now.getTime()-(days*24*60*60*1000);
}

function openHistory(){
    $("history-search").value="";
    $("history-period").value="today";
    renderHistoryList();
    $("history-overlay").hidden=false;
}

function renderHistoryList(){
    const box=$("history-list"),q=norm($("history-search").value),period=$("history-period").value;

    const list=sales()
        .filter(s=>saleMatchesPeriod(s,period))
        .filter(s=>{
            if(!q)return true;
            const itemNames=(Array.isArray(s.items)?s.items:[]).map(i=>i.name).join(" ");
            return [s.number,s.cashier,s.paymentMethod,itemNames].some(v=>norm(v).includes(q));
        })
        .sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime());

    if(!list.length){
        box.innerHTML='<div class="history-empty">Tidak ada transaksi pada pencarian atau periode ini.</div>';
        return;
    }

    box.innerHTML=list.map(s=>{
        const status=saleStatus(s),itemCount=(Array.isArray(s.items)?s.items:[]).reduce((a,x)=>a+num(x.qty),0);
        return `
            <article class="history-item">
                <div class="history-item-main">
                    <div class="history-item-top">
                        <strong class="history-item-number">${escapeHtml(s.number||"-")}</strong>
                        <span class="history-status ${status==="VOID"?'void':''}">${status}</span>
                    </div>
                    <div class="history-item-meta">
                        <span>${s.at?new Date(s.at).toLocaleString("id-ID"):"-"}</span>
                        <span>${escapeHtml(s.cashier||"-")}</span>
                        <span>${escapeHtml(s.paymentMethod||"-")}</span>
                        <span>${itemCount} item</span>
                    </div>
                    <div class="history-item-total">${rupiah(s.total)}</div>
                </div>

                <div class="history-item-actions">
                    <button class="history-action" type="button" data-history-detail="${escapeHtml(s.id||s.number)}">Detail</button>
                    <button class="history-action primary" type="button" data-history-print="${escapeHtml(s.id||s.number)}">
                        <i class="fa-solid fa-print"></i> Cetak
                    </button>
                </div>
            </article>
        `;
    }).join("");

    box.querySelectorAll("[data-history-detail]").forEach(btn=>btn.onclick=()=>openHistoryDetail(btn.dataset.historyDetail));
    box.querySelectorAll("[data-history-print]").forEach(btn=>btn.onclick=()=>reprintHistorySale(btn.dataset.historyPrint));
}

function findSale(identifier){
    return sales().find(s=>String(s.id||s.number)===String(identifier))||null;
}

function openHistoryDetail(identifier){
    const s=findSale(identifier);
    if(!s)return;

    selectedHistorySaleId=s.id||s.number;
    $("history-detail-number").textContent=s.number||"-";

    const status=saleStatus(s),items=Array.isArray(s.items)?s.items:[];

    $("history-detail-content").innerHTML=`
        <div class="history-detail-summary">
            <div><span>Status</span><strong>${status}</strong></div>
            <div><span>Waktu</span><strong>${s.at?new Date(s.at).toLocaleString("id-ID"):"-"}</strong></div>
            <div><span>Kasir</span><strong>${escapeHtml(s.cashier||"-")}</strong></div>
            <div><span>Pembayaran</span><strong>${escapeHtml(s.paymentMethod||"-")}</strong></div>
        </div>

        <div class="history-detail-items">
            ${items.map(i=>`
                <div class="history-detail-item">
                    <div>
                        <strong>${escapeHtml(i.name||"Produk")}</strong>
                        <small>${num(i.qty)} x ${rupiah(i.price)}</small>
                    </div>
                    <strong>${rupiah(num(i.qty)*num(i.price))}</strong>
                </div>
            `).join("")}
        </div>

        <div class="history-detail-total">
            <div><span>Subtotal</span><strong>${rupiah(s.subtotal)}</strong></div>
            ${num(s.transDiscount)>0?`<div><span>Diskon Transaksi</span><strong>-${rupiah(num(s.transDiscount))}</strong></div>`:""}
            ${num(s.tax)>0?`<div><span>Pajak</span><strong>${rupiah(s.tax)}</strong></div>`:""}
            <div class="total"><span>Total</span><strong>${rupiah(s.total)}</strong></div>
        </div>

        ${status==="VOID"?`
            <div class="history-void-note">
                <strong>Transaksi telah di-VOID.</strong><br>
                Alasan: ${escapeHtml(s.voidReason||"-")}<br>
                Oleh: ${escapeHtml(s.voidBy||"Admin")}<br>
                ${s.voidAt?new Date(s.voidAt).toLocaleString("id-ID"):""}
            </div>
        `:""}
    `;

    $("history-detail-void").hidden=!(session.role==="admin"&&status!=="VOID");
    $("history-detail-overlay").hidden=false;
}

function reprintHistorySale(identifier){
    const s=findSale(identifier);
    if(!s)return;
    $("history-overlay").hidden=true;
    $("history-detail-overlay").hidden=true;
    renderReceipt(s);
}

function saveHistorySalePdf(identifier){
    const s=findSale(identifier);
    if(!s)return;
    $("history-overlay").hidden=true;
    $("history-detail-overlay").hidden=true;
    renderReceipt(s);
    setTimeout(saveReceiptPdf,50);
}

async function voidSelectedSale(){
    if(session.role!=="admin")return;

    const ss=sales(),index=ss.findIndex(s=>String(s.id||s.number)===String(selectedHistorySaleId));
    if(index<0)return window.KasirProDialog?.warning("Tidak Ditemukan", "Transaksi tidak ditemukan.");

    const sale=ss[index];
    if(saleStatus(sale)==="VOID")return window.KasirProDialog?.warning("Sudah VOID", "Transaksi ini sudah pernah dibatalkan (VOID).");

    const reason = await window.KasirProDialog?.prompt("Alasan Pembatalan (VOID)", "Masukkan alasan pembatalan transaksi penjualan ini:", "Pembatalan oleh pelanggan / kesalahan input");
    if(!reason)return;
    const isConfirmed = await window.KasirProDialog?.confirm("Konfirmasi VOID", `Apakah Anda yakin ingin membatalkan (VOID) transaksi ${sale.number}?\nStok barang akan otomatis dikembalikan ke inventaris toko.`);
    if(!isConfirmed)return;

    const store=master(),plist=Array.isArray(store.produk)?store.produk:[],items=Array.isArray(sale.items)?sale.items:[];

    for(const item of items){
        if(item.isManual) continue;
        const p=findProductForCartItem(plist,item);
        if(!p)return window.KasirProDialog?.error("Validasi VOID Gagal", `Produk ${item.name} tidak ditemukan pada master. VOID dibatalkan agar stok tidak berubah sebagian.`);
    }

    const moves=movements(),voidAt=new Date().toISOString(),voidBy=session.name||session.username||"Admin";

    for(const item of items){
        if(item.isManual) continue;
        const p=findProductForCartItem(plist,item);
        if(!p) continue;
        const before=num(p["Stok Awal"]),after=before+num(item.qty);
        p["Stok Awal"]=after;
        moves.unshift({
            id:`MOV-${Date.now()}-${Math.random()}`,
            at:voidAt,
            type:"sale_void",
            reference:sale.number,
            productCode:item.code,
            productName:item.name,
            delta:num(item.qty),
            stockBefore:before,
            stockAfter:after,
            note:`VOID penjualan ${sale.number}: ${reason}`
        });
    }

    sale.status="VOID";
    sale.voidAt=voidAt;
    sale.voidBy=voidBy;
    sale.voidReason=reason;

    store.produk=plist;

    try{
        await writeStockTransaction([
            {key:MOVEMENT_KEY,records:moves.slice(0,(sale.items||[]).length)},
            {key:SALES_KEY,records:[sale]}
        ]);
    }catch(error){
        console.error("VOID gagal disimpan ke Firebase:",error);
        return window.KasirProDialog?.error("Gagal Menyimpan", "VOID belum dapat disimpan ke server database. Periksa koneksi internet Anda lalu coba kembali.");
    }

    if(lastSale&&(lastSale.id===sale.id||lastSale.number===sale.number))lastSale=sale;

    renderHistoryList();
    openHistoryDetail(sale.id||sale.number);
}

function bind(){
    const search=$("pos-search");

    search.addEventListener("input",()=>{
        window.clearTimeout(posSearchDebounceTimer);
        posSearchDebounceTimer = window.setTimeout(renderSearchResults, 120);
    });
    search.addEventListener("focus",()=>{if(text(search.value))renderSearchResults()});
    search.addEventListener("keydown",e=>{
        if(e.key==="ArrowDown"){
            if(searchResults.length){e.preventDefault();setActiveSearchIndex(activeSearchIndex<0?0:activeSearchIndex+1)}
        }else if(e.key==="ArrowUp"){
            if(searchResults.length){e.preventDefault();setActiveSearchIndex(activeSearchIndex<=0?searchResults.length-1:activeSearchIndex-1)}
        }else if(e.key==="Enter"){
            if(searchResults.length){e.preventDefault();selectSearchResult(activeSearchIndex>=0?activeSearchIndex:0)}
        }else if(e.key==="Escape"){
            closeSearchResults();
        }
    });

    $("clear-pos-search").onclick=()=>{search.value="";closeSearchResults();search.focus()};

    function openManualItemModal() {
        if ($("manual-item-name")) $("manual-item-name").value = "";
        if ($("manual-item-unit")) $("manual-item-unit").value = "Pcs";
        if ($("manual-item-qty")) $("manual-item-qty").value = "1";
        if ($("manual-item-price")) $("manual-item-price").value = "";
        if ($("manual-item-subtotal")) $("manual-item-subtotal").textContent = "Rp0";
        if ($("manual-item-overlay")) $("manual-item-overlay").hidden = false;
        setTimeout(() => $("manual-item-name")?.focus(), 50);
    }

    function closeManualItemModal() {
        if ($("manual-item-overlay")) $("manual-item-overlay").hidden = true;
    }

    function updateManualItemSubtotal() {
        const q = Math.max(1, parseInt($("manual-item-qty")?.value, 10) || 1);
        const p = parseInt(String($("manual-item-price")?.value || "").replace(/[^0-9]/g, ""), 10) || 0;
        if ($("manual-item-subtotal")) $("manual-item-subtotal").textContent = rupiah(q * p);
    }

    function submitManualItem() {
        const name = text($("manual-item-name")?.value);
        const unit = text($("manual-item-unit")?.value) || "Pcs";
        const qty = Math.max(1, parseInt($("manual-item-qty")?.value, 10) || 1);
        const price = parseInt(String($("manual-item-price")?.value || "").replace(/[^0-9]/g, ""), 10) || 0;

        if (!name) {
            return window.KasirProDialog?.warning("Nama Diperlukan", "Silakan ketik nama obat / produk manual.");
        }
        if (price < 0) {
            return window.KasirProDialog?.warning("Harga Tidak Valid", "Harga jual tidak boleh bernilai negatif.");
        }

        addManualItem(name, unit, qty, price);
        closeManualItemModal();
    }

    $("btn-open-manual-item")?.addEventListener("click", openManualItemModal);
    $("close-manual-item")?.addEventListener("click", closeManualItemModal);
    $("manual-item-overlay")?.addEventListener("click", e => { if (e.target === $("manual-item-overlay")) closeManualItemModal(); });
    $("manual-item-qty")?.addEventListener("input", updateManualItemSubtotal);
    $("manual-item-price")?.addEventListener("input", updateManualItemSubtotal);
    $("btn-submit-manual-item")?.addEventListener("click", submitManualItem);
    $("form-manual-item")?.addEventListener("submit", (e) => {
        e.preventDefault();
        submitManualItem();
    });

    document.addEventListener("pointerdown",e=>{
        if(!e.target.closest(".search-autocomplete"))closeSearchResults();
    });

    $("clear-cart").onclick=()=>{if(cart.length&&confirm("Kosongkan keranjang?")){cart=[];renderCart()}};
    $("cart-discount-mode").onchange=renderTotals;
    $("cart-discount-value").oninput=renderTotals;
    $("open-payment").onclick=openPayment;
    $("close-payment").onclick=()=>$("payment-overlay").hidden=true;
    $("payment-overlay").onclick=e=>{if(e.target===$("payment-overlay"))$("payment-overlay").hidden=true};
    $("payment-method").onchange=updateChange;
    $("cash-paid").oninput=updateChange;
    $("complete-sale").onclick=completeSale;

    // Customer & Member events
    $("btn-open-customer-modal")?.addEventListener("click", () => openCustomerModal("search"));
    $("btn-select-customer")?.addEventListener("click", () => openCustomerModal("search"));
    $("btn-quick-add-customer")?.addEventListener("click", () => openCustomerModal("add"));
    $("btn-remove-selected-customer")?.addEventListener("click", clearCustomer);
    $("close-customer-select")?.addEventListener("click", closeCustomerModal);
    $("customer-select-overlay")?.addEventListener("click", (e) => {
        if (e.target === $("customer-select-overlay")) closeCustomerModal();
    });

    $("tab-cust-search")?.addEventListener("click", () => switchCustomerTab("search"));
    $("tab-cust-add")?.addEventListener("click", () => switchCustomerTab("add"));
    $("input-search-cust")?.addEventListener("input", (e) => renderCustomerSearchResults(e.target.value));
    $("form-quick-add-cust")?.addEventListener("submit", handleQuickAddCustomer);

    $("send-receipt-wa")?.addEventListener("click", sendReceiptViaWhatsApp);

    $("transaction-history").onclick=openHistory;
    $("close-history").onclick=()=>$("history-overlay").hidden=true;
    $("history-overlay").onclick=e=>{if(e.target===$("history-overlay"))$("history-overlay").hidden=true};
    $("history-search").oninput=renderHistoryList;
    $("history-period").onchange=renderHistoryList;

    $("close-history-detail").onclick=()=>$("history-detail-overlay").hidden=true;
    $("history-detail-overlay").onclick=e=>{if(e.target===$("history-detail-overlay"))$("history-detail-overlay").hidden=true};
    $("history-detail-reprint").onclick=()=>reprintHistorySale(selectedHistorySaleId);
    $("history-detail-save-pdf").onclick=()=>saveHistorySalePdf(selectedHistorySaleId);
    $("history-detail-void").onclick=voidSelectedSale;

    $("close-receipt").onclick=()=>$("receipt-overlay").hidden=true;
    $("print-receipt").onclick=printReceipt;
    $("save-receipt-pdf").onclick=saveReceiptPdf;

    $("pos-logout").onclick=()=>showAppModal({title:"Keluar dari POS?",message:"Sesi Kasir akan diakhiri.",icon:"fa-right-from-bracket",confirmLabel:"Keluar",onConfirm:async()=>{await signOutKasirPro().catch(()=>{});location.replace("../index.html")}});
    $("back-management").onclick=()=>{if(session.role!=="admin")return showAppModal({title:"Akses ditolak",message:"Halaman Management hanya dapat dibuka oleh Administrator.",icon:"fa-lock",cancellable:false});location.href="../management/index.html"};
    if ($("pos-shortcuts")) $("pos-shortcuts").onclick=()=>showAppModal({title:"Shortcut POS",message:"F2: pencarian produk • F4: pembayaran • Ctrl + Enter: selesaikan pembayaran • Ctrl + H: riwayat transaksi • Esc: tutup dialog atau pencarian.",icon:"fa-keyboard",cancellable:false});
    $("cart-header").onclick=()=>{};

    document.addEventListener("keydown",e=>{
        if(e.key==="F2"){e.preventDefault();$("pos-search").focus();return;}
        if(e.key==="F4"){e.preventDefault();openPayment();return;}
        if(e.key==="F6"){e.preventDefault();openCustomerModal();return;}
        if((e.ctrlKey||e.metaKey)&&e.key==="Enter"){e.preventDefault();completeSale();return;}
        if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="h"){e.preventDefault();openHistory();return;}
        if(e.key==="Escape"){
            if(!$("app-modal").hidden){$("app-modal").hidden=true;return;}
            closeSearchResults();
            $("payment-overlay").hidden=true;
            $("history-detail-overlay").hidden=true;
            $("history-overlay").hidden=true;
            $("receipt-overlay").hidden=true;
        }
    });
}

function showAppModal({title,message,icon="fa-circle-info",confirmLabel="Mengerti",onConfirm,cancellable=true}){
    const modal=$("app-modal"),titleElement=$("app-modal-title"),messageElement=$("app-modal-message"),iconElement=$("app-modal-icon"),confirmButton=$("app-modal-confirm"),cancelButton=$("app-modal-cancel");
    if(!modal||!confirmButton||!cancelButton)return;
    titleElement.textContent=title;messageElement.textContent=message;iconElement.className=`fa-solid ${icon}`;confirmButton.textContent=confirmLabel;cancelButton.hidden=!cancellable;
    const close=()=>{modal.hidden=true};
    cancelButton.onclick=close;modal.onclick=e=>{if(e.target===modal&&cancellable)close()};confirmButton.onclick=async()=>{close();await onConfirm?.()};modal.hidden=false;confirmButton.focus();
}

async function startPos(){
    try{
        setAppLoading(true);
        await databaseInitialization;
        init();
        console.log("[POS] startPos inisialisasi awal selesai, menunggu database ready...");
    }catch(error){
        console.error("POS tidak dapat membuka database:",error);
        window.KasirProDialog?.error("Koneksi Database", "Database Firebase belum dapat dibuka. Silakan login kembali dan periksa koneksi internet.");
        sessionStorage.removeItem(SESSION_KEY);
        location.replace("../index.html");
    }
}

let isPosReadyDismissed = false;

function setAppLoading(state, message = "") {
    const loading = document.getElementById("app-loading");
    if (!loading) return;
    if (state) {
        isPosReadyDismissed = false;
        loading.classList.remove("fade-out");
        loading.hidden = false;
        loading.style.display = "grid";
        loading.style.pointerEvents = "auto";
    } else {
        isPosReadyDismissed = true;
        loading.classList.add("fade-out");
        setTimeout(() => {
            loading.hidden = true;
            loading.style.display = "none";
            loading.style.pointerEvents = "none";
        }, 280);
    }
    const messageElement = loading.querySelector("[data-app-loading-message]") || loading.querySelector("span");
    if (message && messageElement) messageElement.textContent = message;
}

window.addEventListener("kasirpro:database-preload-start", (event) => {
    setAppLoading(true, event.detail?.message || "Menyiapkan data toko…");
});

window.addEventListener("kasirpro:database-loading", (event) => setAppLoading(true, event.detail?.message || "Mengambil data dari Firebase…"));
window.addEventListener("kasirpro:database-idle", () => {
    if (isPosReadyDismissed) setAppLoading(false);
});
window.addEventListener("kasirpro:database-sync-start", (event) => setAppLoading(true, event.detail?.message || "Menyinkronkan data ke Firebase…"));
window.addEventListener("kasirpro:database-sync-progress", (event) => {
    const detail = event.detail || {};
    setAppLoading(true, `Menyinkronkan data ${detail.currentBatch || 0}/${detail.totalBatches || 0}…`);
});
window.addEventListener("kasirpro:database-synced", () => {
    setAppLoading(false);
    console.log("[POS] Database tersinkronisasi, memperbarui produk POS...");
    refreshPosProductCache(master()?.produk);
    const st = settings();
    const storeNode = $("pos-store-name");
    if (storeNode) storeNode.textContent = text(st["Nama Toko"] || st["Nama Apotek"] || "Apotek Doa Ibu").replace(/\s+v\.?\s*2(?:\.0)?$/i,"").trim() || "Apotek Doa Ibu";
});
window.addEventListener("kasirpro:database-ready", () => {
    console.log("[POS] Event kasirpro:database-ready diterima, halaman POS siap digunakan!");
    refreshPosProductCache(master()?.produk);
    setAppLoading(false);
});

// Fallback keselamatan: jika database-ready terlambat atau offline, tetap buka POS setelah 2.5s
setTimeout(() => {
    if (!isPosReadyDismissed) {
        console.log("[POS] Fallback timeout tercapai, membuka akses POS.");
        setAppLoading(false);
    }
}, 2500);

window.addEventListener("kasirpro:database-error", () => setAppLoading(false));

if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",startPos,{once:true});
else startPos();
