/* KasirPro AT-08 — POS professional confirm/prompt bridge */
const replaying = new WeakSet();

function dialog(){ return window.KasirProDialog; }

function replayLegacyClick(element,{confirmQueue=[],promptQueue=[]}={}){
  if(!element) return;
  const oldConfirm = window.confirm;
  const oldPrompt = window.prompt;
  const confirms = [...confirmQueue];
  const prompts = [...promptQueue];

  window.confirm = () => confirms.length ? !!confirms.shift() : false;
  window.prompt = () => prompts.length ? String(prompts.shift() ?? '') : '';
  replaying.add(element);
  try { element.click(); }
  finally {
    queueMicrotask(() => {
      replaying.delete(element);
      window.confirm = oldConfirm;
      window.prompt = oldPrompt;
    });
  }
}

async function handleClearCart(button){
  const approved = await dialog()?.confirm?.(
    'Kosongkan Keranjang',
    'Semua item yang sudah dimasukkan ke transaksi akan dihapus dari keranjang.',
    {confirmText:'Kosongkan',cancelText:'Batal',type:'warning'}
  );
  if(!approved) return;
  replayLegacyClick(button,{confirmQueue:[true]});
}

async function handleVoid(button){
  const result = await dialog()?.prompt?.(
    'Alasan VOID Transaksi',
    'Masukkan alasan pembatalan transaksi. Alasan akan disimpan pada riwayat transaksi.',
    {label:'Alasan VOID',placeholder:'Contoh: Salah input produk',help:'Wajib diisi sebelum transaksi dapat di-VOID.',confirmText:'Lanjutkan',cancelText:'Batal',required:true,type:'warning'}
  );
  if(!result?.confirmed) return;
  const reason = String(result.value || '').trim();
  if(!reason) return;

  const approved = await dialog()?.confirm?.(
    'Konfirmasi VOID',
    'Transaksi akan ditandai VOID dan stok barang pada transaksi tersebut akan dikembalikan.',
    {confirmText:'VOID Transaksi',cancelText:'Batal',type:'warning'}
  );
  if(!approved) return;

  replayLegacyClick(button,{promptQueue:[reason],confirmQueue:[true]});
}

async function capture(event){
  const button = event.target.closest?.('#clear-cart, #history-detail-void');
  if(!button || replaying.has(button)) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  try {
    if(button.id === 'clear-cart') await handleClearCart(button);
    else if(button.id === 'history-detail-void') await handleVoid(button);
  } catch(error) {
    console.error('AT-08 POS dialog bridge:',error);
    await dialog()?.error?.('Tindakan Tidak Dapat Dilanjutkan',error?.message || String(error));
  }
}

document.addEventListener('click',capture,true);

window.KasirProPosDialogAT08 = Object.freeze({replayLegacyClick});
