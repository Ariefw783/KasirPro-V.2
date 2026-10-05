import "../app-dialog.js";
import {
    initializeDatabase,
    readStore,
    writeStore,
    writeStockTransaction
} from "../modules/database/database-store.js";

import { signOutKasirPro } from "../modules/database/auth.js";

const databaseInitialization = initializeDatabase();

const SESSION_KEY="kasirpro_session", MASTER_KEY="kasirpro_master_store_v1", SALES_KEY="kasirpro_sales_v1", MOVEMENT_KEY="kasirpro_stock_movements_v1";
let saleInProgress=false;
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
    const s = norm(p["Status"] || p["Status Produk"] || "aktif");
    const sellPrice = num(p["Harga Jual"]);
    return (s === "aktif" || !s) && sellPrice > 0;
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
                <strong class="search-result-price">${rupiah(p["Harga Jual"])}</strong>
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

    // 1. Satuan Dasar (Ecer terkecil) - Selalu Ada
    units.push({
        level: "base",
        name: baseUnit,
        multiplier: 1,
        price: basePrice
    });

    // 2. Satuan Sedang (hanya jika ada, berbeda nama dengan dasar, dan isi > 1)
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

    // 3. Satuan Besar (hanya jika ada, berbeda nama, dan konversi > 1)
    const buyUnit = text(p["Kemasan Beli"] || p["Satuan Pembelian"] || p["purchaseUnit"]);
    const conv = num(p["Konversi"] ?? p["Isi Kemasan"] ?? p["conversion"] ?? 1);
    if (buyUnit && norm(buyUnit) !== norm(baseUnit) && (!midUnit || norm(buyUnit) !== norm(midUnit)) && conv > 1) {
        const customBuyPrice = num(p["Harga Jual Satuan Besar"] ?? p["Harga Jual Besar"]);
        const buyPrice = customBuyPrice > 0 ? customBuyPrice : (basePrice * conv);
        units.push({
            level: "buy",
            name: buyUnit,
            multiplier: conv,
            price: buyPrice
        });
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

function changeUnit(i, unitName){
    const x=cart[i];
    if(!x)return;
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
        const hasMultiUnits = Array.isArray(x.availableUnits) && x.availableUnits.length > 1;
        return `
        <div class="sale-line">
            <div class="line-product">
                <strong>${escapeHtml(x.name)}</strong>
                <div style="display:flex;align-items:center;gap:6px;margin-top:3px;flex-wrap:wrap;">
                    <small style="color:#64748b;">${escapeHtml(x.code||"Tanpa kode")}</small>
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
    if(item.code){
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

    const saleAt=new Date().toISOString();
    for(const [itemIndex,item] of cart.entries()){
        const p=findProductForCartItem(plist,item);
        const mult = item.selectedUnit?.multiplier || 1;
        const totalDeduct = item.qty * mult;
        const before=num(p["Stok Awal"]);
        const after=before-totalDeduct;
        p["Stok Awal"]=after;

        const unitName = item.selectedUnit?.name || p["Satuan Dasar"] || "item";
        moves.unshift({
            id:`MOV-${number}-${String(itemIndex+1).padStart(2,"0")}`,
            at:saleAt,
            type:"sale",
            reference:number,
            productCode:item.code,
            productName:item.name,
            delta:-totalDeduct,
            stockBefore:before,
            stockAfter:after,
            note:`Penjualan ${number} (${item.qty} ${unitName}${mult > 1 ? ` @${mult} ${p["Satuan Dasar"]||""}` : ""})`
        });
    }

    const customNote = text($("payment-custom-note")?.value);
    const recordedPaymentMethod = (method === "Lainnya" && customNote) ? `Lainnya (${customNote})` : method;

    lastSale={
        id:`SALE-${Date.now()}-${String(session.username||"kasir").toLowerCase()}`,
        number,
        at:saleAt,
        cashier:session.name||session.username||"Kasir",
        role:session.role,
        status:"SELESAI",
        items:cart.map(x=>({
            ...x,
            unitName: x.selectedUnit?.name || x.baseUnit || "item",
            unitMultiplier: x.selectedUnit?.multiplier || 1
        })),
        discountMode:$("cart-discount-mode").value,
        discountValue:num($("cart-discount-value").value),
        ...c,
        paymentMethod:recordedPaymentMethod,
        paid,
        change:Math.max(0,paid-c.total)
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
        return window.KasirProDialog?.error("Gagal Menyimpan", "Transaksi belum dapat disimpan ke server database. Periksa koneksi internet Anda lalu coba kembali.");
    }finally{
        saleInProgress=false;
        completeButton.disabled=false;
        completeButton.textContent=originalButtonText;
    }

    $("payment-overlay").hidden=true;
    renderReceipt(lastSale);
    cart=[];
    $("cart-discount-value").value=0;
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
        const p=findProductForCartItem(plist,item);
        if(!p)return window.KasirProDialog?.error("Validasi VOID Gagal", `Produk ${item.name} tidak ditemukan pada master. VOID dibatalkan agar stok tidak berubah sebagian.`);
    }

    const moves=movements(),voidAt=new Date().toISOString(),voidBy=session.name||session.username||"Admin";

    for(const item of items){
        const p=findProductForCartItem(plist,item),before=num(p["Stok Awal"]),after=before+num(item.qty);
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
    }catch(error){
        console.error("POS tidak dapat membuka database:",error);
        window.KasirProDialog?.error("Koneksi Database", "Database Firebase belum dapat dibuka. Silakan login kembali dan periksa koneksi internet.");
        sessionStorage.removeItem(SESSION_KEY);
        location.replace("../index.html");
    }finally{
        setAppLoading(false);
    }
}

function setAppLoading(state, message = "") {
    const loading = document.getElementById("app-loading");
    if (!loading) return;
    loading.hidden = !state;
    const messageElement = loading.querySelector("[data-app-loading-message]") || loading.querySelector("p");
    if (message && messageElement) messageElement.textContent = message;
}

window.addEventListener("kasirpro:database-preload-start", (event) => {
    setAppLoading(true, event.detail?.message || "Menyiapkan data toko…");
});

window.addEventListener("kasirpro:database-loading", (event) => setAppLoading(true, event.detail?.message || "Mengambil data dari Firebase…"));
window.addEventListener("kasirpro:database-idle", () => setAppLoading(false));
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
    refreshPosProductCache(master()?.produk);
});
window.addEventListener("kasirpro:database-error", () => setAppLoading(false));

if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",startPos,{once:true});
else startPos();
