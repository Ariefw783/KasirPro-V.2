/* KasirPro V4 — unified notification, confirmation, and input dialogs. */
const ICONS={success:'fa-circle-check',error:'fa-circle-xmark',warning:'fa-triangle-exclamation',info:'fa-circle-info',input:'fa-pen-to-square'};
let activeResolve=null;

function install(){
  if(document.getElementById('kp-dialog-v4'))return;
  const style=document.createElement('style');
  style.id='kp-dialog-v4-style';
  style.textContent=`
  .kp-dialog-v4{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;padding:20px}.kp-dialog-v4[hidden]{display:none!important}
  .kp-dialog-v4__backdrop{position:absolute;inset:0;background:rgba(15,23,42,.48);backdrop-filter:blur(3px)}
  .kp-dialog-v4__card{position:relative;width:min(94vw,430px);overflow:hidden;border:1px solid #e2e8f0;border-radius:18px;background:#fff;box-shadow:0 28px 90px rgba(15,23,42,.3)}
  .kp-dialog-v4__body{padding:24px 24px 18px;text-align:center}.kp-dialog-v4__icon{width:54px;height:54px;margin:0 auto 15px;border-radius:16px;display:grid;place-items:center;font-size:24px;background:#eff6ff;color:#2563eb}
  .kp-dialog-v4[data-type=success] .kp-dialog-v4__icon{background:#ecfdf5;color:#059669}.kp-dialog-v4[data-type=error] .kp-dialog-v4__icon{background:#fef2f2;color:#dc2626}.kp-dialog-v4[data-type=warning] .kp-dialog-v4__icon{background:#fff7ed;color:#ea580c}
  .kp-dialog-v4 h2{margin:0;color:#0f172a;font-size:19px;line-height:1.3}.kp-dialog-v4__message{margin:9px 0 0;color:#475569;font-size:13px;line-height:1.65;white-space:pre-line;overflow-wrap:anywhere}
  .kp-dialog-v4__input-wrap{margin-top:16px;text-align:left}.kp-dialog-v4__input-wrap[hidden]{display:none!important}.kp-dialog-v4__input-wrap label{display:block;margin-bottom:6px;color:#334155;font-size:12px;font-weight:750}.kp-dialog-v4__input{width:100%;min-height:42px;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;color:#0f172a;font:inherit}.kp-dialog-v4__input:focus{outline:0;border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
  .kp-dialog-v4__actions{display:flex;justify-content:flex-end;gap:9px;padding:14px 18px;background:#f8fafc;border-top:1px solid #e2e8f0}.kp-dialog-v4__button{min-height:40px;padding:0 16px;border-radius:9px;border:1px solid #cbd5e1;background:#fff;color:#334155;font:inherit;font-size:12px;font-weight:800;cursor:pointer}.kp-dialog-v4__button.primary{border-color:#2563eb;background:#2563eb;color:#fff}.kp-dialog-v4[data-type=error] .kp-dialog-v4__button.primary{border-color:#dc2626;background:#dc2626}.kp-dialog-v4[data-type=success] .kp-dialog-v4__button.primary{border-color:#059669;background:#059669}
  @media(max-width:520px){.kp-dialog-v4__body{padding:21px 18px 16px}.kp-dialog-v4__actions{display:grid;grid-template-columns:1fr 1fr}.kp-dialog-v4__actions .kp-dialog-v4__button:only-child{grid-column:1/-1}}

  /* Progress Loading Modal */
  .kp-dialog-progress{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:20px}.kp-dialog-progress[hidden]{display:none!important}
  .kp-dialog-progress__backdrop{position:absolute;inset:0;background:rgba(15,23,42,.55);backdrop-filter:blur(4px)}
  .kp-dialog-progress__card{position:relative;width:min(94vw,430px);overflow:hidden;border:1px solid #e2e8f0;border-radius:18px;background:#fff;box-shadow:0 28px 90px rgba(15,23,42,.35);padding:26px 24px 22px;text-align:center}
  .kp-dialog-progress__icon{width:56px;height:56px;margin:0 auto 14px;border-radius:16px;display:grid;place-items:center;font-size:24px;background:#eff6ff;color:#2563eb}
  .kp-dialog-progress__icon i{animation:kp-spin 1s linear infinite}
  .kp-dialog-progress h2{margin:0;color:#0f172a;font-size:18px;line-height:1.3;font-weight:750}
  .kp-dialog-progress__message{margin:8px 0 14px;color:#475569;font-size:13px;line-height:1.55;white-space:pre-line;overflow-wrap:anywhere}
  .kp-dialog-progress__bar-container{width:100%;height:8px;background:#f1f5f9;border-radius:999px;overflow:hidden;margin:12px 0 8px;border:1px solid #e2e8f0}
  .kp-dialog-progress__bar-fill{height:100%;width:0%;background:linear-gradient(90deg,#2563eb,#38bdf8);border-radius:999px;transition:width .25s ease}
  .kp-dialog-progress__stats{display:flex;justify-content:space-between;align-items:center;font-size:11.5px;color:#64748b;font-weight:600}
  .kp-dialog-progress__hint{margin-top:14px;padding:8px 12px;background:#f8fafc;border-radius:8px;color:#94a3b8;font-size:11px;display:flex;align-items:center;justify-content:center;gap:6px}
  @keyframes kp-spin{to{transform:rotate(360deg)}}
  `;
  document.head.appendChild(style);
  const root=document.createElement('div');root.id='kp-dialog-v4';root.className='kp-dialog-v4';root.hidden=true;root.innerHTML=`<div class="kp-dialog-v4__backdrop"></div><section class="kp-dialog-v4__card" role="dialog" aria-modal="true" aria-labelledby="kp-dialog-v4-title"><div class="kp-dialog-v4__body"><div class="kp-dialog-v4__icon"><i class="fa-solid fa-circle-info"></i></div><h2 id="kp-dialog-v4-title"></h2><p class="kp-dialog-v4__message"></p><div class="kp-dialog-v4__input-wrap" hidden><label for="kp-dialog-v4-input"></label><input id="kp-dialog-v4-input" class="kp-dialog-v4__input"></div></div><footer class="kp-dialog-v4__actions"><button type="button" class="kp-dialog-v4__button cancel">Batal</button><button type="button" class="kp-dialog-v4__button primary">Mengerti</button></footer></section>`;
  document.body.appendChild(root);

  const progRoot=document.createElement('div');progRoot.id='kp-dialog-progress';progRoot.className='kp-dialog-progress';progRoot.hidden=true;progRoot.setAttribute('role','status');progRoot.setAttribute('aria-live','polite');progRoot.innerHTML=`<div class="kp-dialog-progress__backdrop"></div><section class="kp-dialog-progress__card"><div class="kp-dialog-progress__icon"><i class="fa-solid fa-arrows-rotate"></i></div><h2 id="kp-dialog-progress-title">Memproses Data</h2><p id="kp-dialog-progress-msg" class="kp-dialog-progress__message">Mohon tunggu, proses sedang berjalan...</p><div class="kp-dialog-progress__bar-container"><div id="kp-dialog-progress-bar" class="kp-dialog-progress__bar-fill" style="width:0%"></div></div><div class="kp-dialog-progress__stats"><span id="kp-dialog-progress-detail">Menyiapkan...</span><span id="kp-dialog-progress-pct">0%</span></div><div class="kp-dialog-progress__hint"><i class="fa-solid fa-circle-notch fa-spin"></i><span>Mohon jangan menutup atau memuat ulang halaman selama proses berjalan.</span></div></section>`;
  document.body.appendChild(progRoot);
}

function close(value){const root=document.getElementById('kp-dialog-v4');if(root)root.hidden=true;const done=activeResolve;activeResolve=null;done?.(value);}
function open(type,title,message,options={}){
  install();if(activeResolve)close(false);
  const root=document.getElementById('kp-dialog-v4'),inputWrap=root.querySelector('.kp-dialog-v4__input-wrap'),input=root.querySelector('.kp-dialog-v4__input'),cancel=root.querySelector('.cancel'),confirm=root.querySelector('.primary');
  root.dataset.type=type;root.querySelector('.kp-dialog-v4__icon i').className=`fa-solid ${ICONS[type]||ICONS.info}`;root.querySelector('h2').textContent=title||'Informasi';root.querySelector('.kp-dialog-v4__message').textContent=message||'';
  const isInput=type==='input';inputWrap.hidden=!isInput;inputWrap.querySelector('label').textContent=options.inputLabel||'Masukan';input.value=isInput?String(options.defaultValue||''):'';input.placeholder=options.placeholder||'';
  const showCancel=Boolean(options.showCancel||options.cancelText||type==='input');cancel.hidden=!showCancel;cancel.textContent=options.cancelText||'Batal';confirm.textContent=options.confirmText||({success:'Selesai',error:'Tutup',warning:showCancel?'Lanjutkan':'Mengerti',info:'Mengerti',input:'Simpan'}[type]||'Mengerti');
  root.hidden=false;
  return new Promise(resolve=>{activeResolve=resolve;confirm.onclick=()=>close(isInput?input.value:true);cancel.onclick=()=>close(isInput?null:false);root.querySelector('.kp-dialog-v4__backdrop').onclick=()=>{if(showCancel)close(isInput?null:false)};input.onkeydown=e=>{if(e.key==='Enter')close(input.value)};setTimeout(()=>isInput?input.focus():confirm.focus(),0);});
}

function showProgress(title, message, options = {}) {
  install();
  const root = document.getElementById('kp-dialog-progress');
  if (!root) return;
  const titleEl = document.getElementById('kp-dialog-progress-title');
  const msgEl = document.getElementById('kp-dialog-progress-msg');
  const barEl = document.getElementById('kp-dialog-progress-bar');
  const pctEl = document.getElementById('kp-dialog-progress-pct');
  const detailEl = document.getElementById('kp-dialog-progress-detail');

  if (titleEl) titleEl.textContent = title || 'Memproses Data';
  if (msgEl) msgEl.textContent = message || 'Mohon tunggu...';
  const pct = typeof options.percent === 'number' ? Math.max(0, Math.min(100, Math.round(options.percent))) : 0;
  if (barEl) barEl.style.width = `${pct}%`;
  if (pctEl) pctEl.textContent = `${pct}%`;
  if (detailEl) detailEl.textContent = options.detail || 'Memproses...';
  root.hidden = false;
}

function updateProgress({ title, message, percent, detail } = {}) {
  const root = document.getElementById('kp-dialog-progress');
  if (!root || root.hidden) return;
  if (title !== undefined) {
    const el = document.getElementById('kp-dialog-progress-title');
    if (el) el.textContent = title;
  }
  if (message !== undefined) {
    const el = document.getElementById('kp-dialog-progress-msg');
    if (el) el.textContent = message;
  }
  if (percent !== undefined && percent !== null) {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    const barEl = document.getElementById('kp-dialog-progress-bar');
    const pctEl = document.getElementById('kp-dialog-progress-pct');
    if (barEl) barEl.style.width = `${p}%`;
    if (pctEl) pctEl.textContent = `${p}%`;
  }
  if (detail !== undefined) {
    const el = document.getElementById('kp-dialog-progress-detail');
    if (el) el.textContent = detail;
  }
}

function closeProgress() {
  const root = document.getElementById('kp-dialog-progress');
  if (root) root.hidden = true;
}

window.KasirProDialog=Object.freeze({
  success:(title,message,options)=>open('success',title,message,options),
  error:(title,message,options)=>open('error',title,message,options),
  warning:(title,message,options)=>open('warning',title,message,options),
  info:(title,message,options)=>open('info',title,message,options),
  confirm:(title,message,options={})=>open('warning',title,message,{...options,showCancel:true}),
  input:(title,message,options)=>open('input',title,message,options),
  prompt:(title,message,options)=>open('input',title,message,options),
  showProgress:(title,message,options)=>showProgress(title,message,options),
  updateProgress:(options)=>updateProgress(options),
  closeProgress:()=>closeProgress()
});

// Ganti alert bawaan browser agar tidak muncul dialog browser native "[URL] mengatakan: ..."
window.alert = (msg) => {
  window.KasirProDialog.warning("Pemberitahuan", String(msg || ''));
};

if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install,{once:true});else install();

