/* ============================================================
   ABISE AUTO PARTS — cloud-synced shop manager
   Data is stored in Supabase (one shared row of JSON), so the
   owner and you see the same live data on every device.

   The shop is two separate "books":
     PARTS book  — parts sold (income) minus part costs + parts
                   business expenses. Household spending and loan
                   repayments are drawn from parts cash.
     REPAIRS book — repair labor (income) minus mechanic salary +
                   other repair expenses. Customers bring their own
                   parts; the shelf inventory is never touched here.
   ============================================================ */

/* ---------- Supabase init ---------- */
const CFG = window.ABISE_CONFIG || {};
let sb = null, configError = '';
if(!CFG.SUPABASE_URL || CFG.SUPABASE_URL.indexOf('PASTE')===0){
  configError = 'Not configured yet. Open config.js and paste your Supabase URL and key.';
}else{
  try{ sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY); }
  catch(e){ configError = 'Could not connect to Supabase: '+e.message; }
}

/* ---------- shared state ----------
   parts     : inventory items {id,name,category,forVehicle,stock,cost,price,note}
   sales     : parts sold       {id,date,partId,name,qty,unitPrice,unitCost,customer,note}
   repairs   : repair jobs       {id,plate,customer,phone,work,received,dispatch,price,paid,note}
   expenses  : costs             {id,book:'parts'|'repairs',cat,amount,date,employee,note,recurring,freq}
   household : home spending     {id,cat,amount,date,note}  (drawn from parts cash)
   loans     : loans             {id,lender,total,balance,note,created}
   customers : people + vehicles {id,name,phone,vehicles:[{plate,model}],note}
   suppliers : part sources      {id,name,phone,note}
   settings  : {currency, lowStock}
*/
let mem = {parts:[], sales:[], repairs:[], expenses:[], household:[], loans:[], assets:[], customers:[], suppliers:[], settings:{currency:'Br', lowStock:3}};
let SHARED_ID = 'shared';
let saveTimer = null, realtimeChan = null, applyingRemote = false;

const $ = id => document.getElementById(id);
let hideMoney=false;
try{hideMoney=localStorage.getItem('abise:hideMoney')==='1';}catch(e){}
const MASK='•••••';
const CUR=()=>mem.settings.currency||'Br';
const money=n=>hideMoney?(CUR()+' '+MASK):(CUR()+' '+Math.round(n).toLocaleString());
const LOWSTOCK=()=>{const v=+mem.settings.lowStock;return isNaN(v)?3:v;};
const uid=()=>Date.now()+''+Math.floor(Math.random()*999);
const today=()=>new Date().toISOString().slice(0,10);
function toast(m){const t=$('toast');t.innerHTML=m;t.classList.add('show');setTimeout(()=>t.classList.remove('show'),1900);}
function savedTick(label){
  let tick=$('savedTick');
  if(!tick){tick=document.createElement('div');tick.id='savedTick';tick.className='savedtick';document.body.appendChild(tick);}
  tick.innerHTML='<div class="tickcircle"><svg viewBox="0 0 52 52"><circle class="tickc" cx="26" cy="26" r="24" fill="none"/><path class="tickm" fill="none" d="M14 27 L22 35 L38 18"/></svg></div><div class="ticklabel">'+(label||'Saved')+'</div>';
  tick.classList.remove('show');void tick.offsetWidth;tick.classList.add('show');
  setTimeout(()=>tick.classList.remove('show'),1300);
}
function esc(s){return(s||'').replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));}
function setSync(state){const p=$('syncPill');if(!p)return;if(state==='saving'){p.textContent='Saving…';p.className='syncpill saving';}else if(state==='off'){p.textContent='Offline';p.className='syncpill off';}else{p.textContent='Synced';p.className='syncpill';}}

/* ---------- offline-first load / save ---------- */
const LS_KEY='abise:data';
const LS_DIRTY='abise:dirty';
function saveLocal(){try{localStorage.setItem(LS_KEY,JSON.stringify(mem));}catch(e){}}
function loadLocal(){try{const r=localStorage.getItem(LS_KEY);if(r)return normalize(JSON.parse(r));}catch(e){}return null;}
function markDirty(v){try{localStorage.setItem(LS_DIRTY,v?'1':'0');}catch(e){}}
function isDirty(){try{return localStorage.getItem(LS_DIRTY)==='1';}catch(e){return false;}}

async function cloudLoad(){
  const local=loadLocal();
  if(local){mem=local;}
  if(!navigator.onLine){setSync('off');return true;}
  try{
    const {data,error} = await sb.from('shop_data').select('content,updated_at').eq('id',SHARED_ID).maybeSingle();
    if(error){console.error(error);setSync('off');return true;}
    if(data && data.content){
      if(isDirty()){ await pushNow(); }
      else { mem = normalize(data.content); saveLocal(); }
    } else {
      await sb.from('shop_data').insert({id:SHARED_ID, content:mem});
      saveLocal();
    }
    setSync('synced');
  }catch(e){console.error(e);setSync('off');}
  return true;
}
function normalize(d){
  d=d||{};
  d.parts=d.parts||[];d.sales=d.sales||[];d.repairs=d.repairs||[];
  d.expenses=d.expenses||[];d.household=d.household||[];d.loans=d.loans||[];d.assets=d.assets||[];
  d.customers=d.customers||[];d.suppliers=d.suppliers||[];
  d.settings=d.settings||{};
  if(!d.settings.currency)d.settings.currency='Br';
  if(d.settings.lowStock==null)d.settings.lowStock=3;
  return d;
}
async function pushNow(){
  try{
    const {error}=await sb.from('shop_data').update({content:mem, updated_at:new Date().toISOString()}).eq('id',SHARED_ID);
    if(error){throw error;}
    markDirty(false);setSync('synced');return true;
  }catch(e){console.error(e);setSync('off');return false;}
}
async function save(){
  if(applyingRemote) return;
  saveLocal();
  markDirty(true);
  if(!navigator.onLine){setSync('off');return;}
  setSync('saving');
  if(saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async()=>{ await pushNow(); }, 500);
}
window.addEventListener('online', async()=>{ setSync('saving'); if(isDirty()){await pushNow();} else {setSync('synced');} });
window.addEventListener('offline', ()=>{ setSync('off'); });
function subscribeRealtime(){
  if(realtimeChan) sb.removeChannel(realtimeChan);
  realtimeChan = sb.channel('shop')
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'shop_data',filter:'id=eq.'+SHARED_ID},payload=>{
      if(payload.new && payload.new.content){
        applyingRemote=true;
        mem = normalize(payload.new.content);
        saveLocal(); markDirty(false);
        render();
        applyingRemote=false;
        setSync('synced');
      } else {
        refreshFromCloud();
      }
    }).subscribe();
}
async function refreshFromCloud(){
  if(!navigator.onLine) return;
  try{
    const {data,error}=await sb.from('shop_data').select('content').eq('id',SHARED_ID).maybeSingle();
    if(!error && data && data.content && !isDirty()){
      applyingRemote=true; mem=normalize(data.content); saveLocal(); render(); applyingRemote=false; setSync('synced');
    }
  }catch(e){setSync('off');}
}
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'){ subscribeRealtime(); refreshFromCloud(); }
});
window.addEventListener('focus',()=>{ refreshFromCloud(); });
setInterval(()=>{ if(document.visibilityState==='visible' && navigator.onLine && !isDirty()) refreshFromCloud(); }, 25000);

/* ============================================================
   DOMAIN LOGIC — two separate books
   ============================================================ */
const CATEGORIES=['Engine','Brake','Electrical','Suspension','Body','Filter','Fluids','Tyre','Other'];
const catIcon=c=>({Engine:'&#9881;',Brake:'&#128679;',Electrical:'&#128268;',Suspension:'&#127899;',Body:'&#128663;',Filter:'&#9851;',Fluids:'&#129704;',Tyre:'&#9899;',Other:'&middot;'}[c]||'&middot;');

const partById=id=>mem.parts.find(p=>p.id===id);
const partProfitEach=p=>(+p.price||0)-(+p.cost||0);
const isLow=p=>(+p.stock||0)<=LOWSTOCK();
const lowParts=()=>mem.parts.filter(isLow);

const inRange=(d,from,to)=>(!from||d>=from)&&(!to||d<=to);

/* ----- PARTS book ----- */
function partsIncome(from,to){let s=0;mem.sales.forEach(x=>{if(inRange(x.date,from,to))s+=(x.unitPrice||0)*(x.qty||0);});return s;}
function partsCostOfGoods(from,to){let s=0;mem.sales.forEach(x=>{if(inRange(x.date,from,to))s+=(x.unitCost||0)*(x.qty||0);});return s;}
function partsBizExpenses(from,to){let s=0;mem.expenses.forEach(e=>{if(e.book==='parts'&&inRange(e.date,from,to))s+=e.amount;});return s;}
function partsProfit(from,to){return partsIncome(from,to)-partsCostOfGoods(from,to)-partsBizExpenses(from,to);}

/* ----- REPAIRS book ----- */
const repairPaid=r=>r.paid?(r.price||0):0;          // labor counts as income when the job is marked paid
function repairsIncome(from,to){let s=0;mem.repairs.forEach(r=>{if(r.paid&&inRange(r.paidOn||r.dispatch||r.received,from,to))s+=(r.price||0);});return s;}
function repairsExpenses(from,to){let s=0;mem.expenses.forEach(e=>{if(e.book==='repairs'&&inRange(e.date,from,to))s+=e.amount;});return s;}
function repairsProfit(from,to){return repairsIncome(from,to)-repairsExpenses(from,to);}

/* ----- drawn from parts cash ----- */
function householdTotal(from,to){let s=0;mem.household.forEach(h=>{if(inRange(h.date,from,to))s+=h.amount;});return s;}
function assetsTotal(from,to){let s=0;mem.assets.forEach(a=>{if(inRange(a.date,from,to))s+=a.value;});return s;}
// every repayment entry for a loan, wherever it lives (parts expenses for business loans, household for household loans)
function repaymentsForLoan(loanId){
  const out=[];
  mem.expenses.forEach(e=>{if(e.loanId===loanId)out.push(e);});
  mem.household.forEach(h=>{if(h.loanId===loanId)out.push(h);});
  return out;
}
const loanRepaid=l=>Math.max(0,l.total-l.balance);

/* ----- combined / cash ----- */
function combinedProfit(from,to){return partsProfit(from,to)+repairsProfit(from,to);}
function cashPosition(){
  // Profit already includes business-loan repayments (they are parts expenses).
  // Household total already includes household-loan repayments. So we only
  // subtract household and assets here — never loan repayments again, or they'd double-count.
  return combinedProfit(null,null)-householdTotal(null,null)-assetsTotal(null,null);
}

const repairStatus=r=>r.paid?'paid':(r.dispatch?'done':'open');
const repairStatusLabel=r=>({paid:'Paid',done:'Done · unpaid',open:'Open'}[repairStatus(r)]);

function monthRange(ym){const[y,m]=ym.split('-').map(Number);const last=new Date(y,m,0).getDate();return [ym+'-01', ym+'-'+String(last).padStart(2,'0')];}

/* all months that have any activity, newest first, with the two books split */
function monthlyBooks(){
  const m={};
  const touch=ym=>(m[ym]=m[ym]||{pInc:0,pCog:0,pExp:0,rInc:0,rExp:0,hh:0});
  mem.sales.forEach(s=>{const ym=(s.date||'').slice(0,7);if(!ym)return;const b=touch(ym);b.pInc+=(s.unitPrice||0)*(s.qty||0);b.pCog+=(s.unitCost||0)*(s.qty||0);});
  mem.repairs.forEach(r=>{if(!r.paid)return;const ym=(r.paidOn||r.dispatch||r.received||'').slice(0,7);if(!ym)return;touch(ym).rInc+=(r.price||0);});
  mem.expenses.forEach(e=>{const ym=(e.date||'').slice(0,7);if(!ym)return;const b=touch(ym);if(e.book==='repairs')b.rExp+=e.amount;else b.pExp+=e.amount;});
  mem.household.forEach(h=>{const ym=(h.date||'').slice(0,7);if(!ym)return;touch(ym).hh+=h.amount;});
  return Object.keys(m).sort().reverse().map(ym=>{
    const b=m[ym];
    return {ym, label:new Date(ym+'-01').toLocaleDateString('en',{month:'short',year:'numeric'}),
      partsProfit:b.pInc-b.pCog-b.pExp, repairsProfit:b.rInc-b.rExp,
      income:b.pInc+b.rInc, exp:b.pCog+b.pExp+b.rExp+b.hh, ...b};
  });
}

function bestPart(){
  const map={};mem.sales.forEach(s=>{const k=s.name||'Part';map[k]=(map[k]||0)+(s.unitPrice||0)*(s.qty||0);});
  let best=null;Object.entries(map).forEach(([k,v])=>{if(!best||v>best.v)best={k,v};});return best;
}

/* ============================================================
   TABS & RENDER
   ============================================================ */
let tab='home';
function setTab(t){
  tab=t;
  document.querySelectorAll('nav button[data-tab]').forEach(b=>b.classList.toggle('on',b.dataset.tab===t));
  render();
}
const TITLES={home:'Overview',parts:'Parts',repairs:'Repairs',reports:'Reports',customers:'Customers & vehicles',suppliers:'Suppliers',loans:'Loans',assets:'Assets',audit:'Financial audit'};
function render(){
  const v=$('view');if(!v)return;
  let body;
  switch(tab){
    case 'home': body=renderHome(); break;
    case 'parts': body=renderParts(); break;
    case 'repairs': body=renderRepairs(); break;
    case 'customers': body=renderCustomers(); break;
    case 'suppliers': body=renderSuppliers(); break;
    case 'loans': body=renderLoans(); break;
    case 'assets': body=renderAssets(); break;
    case 'audit': body=renderAudit(); break;
    default: body=renderReports();
  }
  v.innerHTML='<div class="pagetitle">'+(TITLES[tab]||'')+'</div>'+body;
  wireDynamic();
}

/* ---------------- HOME ---------------- */
function renderHome(){
  const ym=today().slice(0,7);const[from,to]=monthRange(ym);
  const cash=cashPosition();
  const pProf=partsProfit(from,to), rProf=repairsProfit(from,to);
  let html='';
  html+='<div class="hero alt"><div class="lbl">Cash position · all time</div><div class="big">'+(cash<0?'&minus;':'')+money(Math.abs(cash))+'</div>'
    +'<div class="delta" style="color:var(--muted)">Business profit, minus household &amp; assets</div>'
    +'<div class="row"><div><div class="k">Parts profit · '+new Date().toLocaleDateString('en',{month:'short'})+'</div><div class="v '+(pProf>=0?'pos':'neg')+'">'+money(pProf)+'</div></div>'
    +'<div><div class="k">Repairs profit · mo</div><div class="v '+(rProf>=0?'pos':'neg')+'">'+money(rProf)+'</div></div></div></div>';

  // alerts
  let alerts='';
  const low=lowParts();
  if(low.length)alerts+='<div class="alert tap-lowstock" style="cursor:pointer"><span class="dot"></span><span><b>'+low.length+' part'+(low.length>1?'s':'')+' low on stock</b> &mdash; reorder soon &rsaquo;</span></div>';
  const openJobs=mem.repairs.filter(r=>repairStatus(r)!=='paid');
  if(openJobs.length)alerts+='<div class="alert loan tap-repairs" style="cursor:pointer"><span class="dot"></span><span><b>'+openJobs.length+' repair job'+(openJobs.length>1?'s':'')+'</b> open or unpaid &rsaquo;</span></div>';
  const loanBal=mem.loans.reduce((s,l)=>s+l.balance,0);
  if(loanBal>0)alerts+='<div class="alert due tap-loans" style="cursor:pointer"><span class="dot"></span><span><b>'+money(loanBal)+'</b> in loans still to repay &rsaquo;</span></div>';
  if(alerts)html+='<div class="dash-section">Needs attention</div><div class="alerts">'+alerts+'</div>';

  // recent activity (sales, repairs, expenses, household)
  const rec=recentActivity().slice(0,6);
  const rows=rec.length?rec.map(activityRow).join(''):'<div class="empty"><div class="e-ic">&#128736;</div>No activity yet. Tap + to begin.</div>';
  html+='<div class="dash-section">Recent activity</div><div class="card">'+rows+'</div>';
  return html;
}
function recentActivity(){
  const rows=[];
  mem.sales.forEach(s=>rows.push({kind:'sale',id:s.id,name:'Sold · '+(s.name||'Part')+(s.qty>1?' ×'+s.qty:''),sub:(s.customer||'Counter')+' · '+(s.date||''),amt:(s.unitPrice||0)*(s.qty||0),date:s.date||''}));
  mem.repairs.forEach(r=>rows.push({kind:'repair',id:r.id,name:'Repair · '+(r.work||r.plate||'Job'),sub:repairStatusLabel(r)+(r.customer?' · '+r.customer:''),amt:r.paid?(r.price||0):0,neutral:!r.paid,date:r.paidOn||r.dispatch||r.received||''}));
  mem.expenses.forEach(e=>rows.push({kind:'exp',id:e.id,book:e.book,loanId:e.loanId,name:(e.loanId?'Loan repayment':(e.cat||'Expense'))+(e.employee?' · '+e.employee:''),sub:(e.loanId?'Loan':(e.book==='repairs'?'Repairs cost':'Parts cost'))+' · '+(e.date||''),amt:-e.amount,date:e.date||''}));
  mem.household.forEach(h=>rows.push({kind:'home',id:h.id,name:'Household · '+(h.cat||''),sub:'From parts cash · '+(h.date||''),amt:-h.amount,date:h.date||''}));
  return rows.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
}
function activityRow(r){
  const cls=r.kind==='sale'?'sale':r.kind==='repair'?'sal':r.kind==='home'?'home':(r.loanId?'loan':'exp');
  const ic=r.kind==='sale'?'&#128736;':r.kind==='repair'?'&#128295;':r.kind==='home'?'&#127968;':(r.loanId?'&#9672;':'&#128722;');
  let amtStr,amtCls;
  if(r.neutral){amtStr=money(r.amt||0);amtCls='';}
  else if(r.amt>=0){amtStr='+'+money(r.amt);amtCls='in';}
  else {amtStr='&minus;'+money(Math.abs(r.amt));amtCls='out';}
  const dataAttr=r.kind==='sale'?'data-sale="'+r.id+'"':r.kind==='repair'?'data-repair="'+r.id+'"':r.kind==='home'?'data-home="'+r.id+'"':'data-exp="'+r.id+'"';
  return '<div class="item" '+dataAttr+'><div class="ic '+cls+'">'+ic+'</div><div class="body"><div class="t1">'+esc(r.name)+'</div><div class="t2">'+esc(r.sub)+'</div></div><div class="amt '+amtCls+'">'+amtStr+'</div></div>';
}

/* ---------------- PARTS ---------------- */
let partFilter='all';
let partSearch='';
function partRow(p){
  const low=isLow(p);
  const sub=[p.category||'Other',p.forVehicle?'for '+p.forVehicle:''].filter(Boolean).join(' · ');
  const prof=partProfitEach(p);
  return '<div class="item" data-part="'+p.id+'"><div class="ic exp" style="background:var(--card2)">'+catIcon(p.category)+'</div>'
    +'<div class="body"><div class="t1">'+esc(p.name||'Part')+'</div><div class="t2">'+sub+'</div>'
    +(low?'<span class="pill unpaid">Low · '+(+p.stock||0)+' left</span>':'')
    +'</div><div class="amt" style="text-align:right">'
    +'<div style="font-family:Fraunces,serif;font-size:16px;color:'+(low?'var(--accent)':'var(--ink)')+'">'+(+p.stock||0)+'</div>'
    +'<div class="t2" style="font-weight:400">'+money(p.price||0)+' ea</div></div></div>';
}
function renderParts(){
  const ym=today().slice(0,7);const[from,to]=monthRange(ym);
  const low=lowParts().length;
  const invValue=mem.parts.reduce((s,p)=>s+(+p.stock||0)*(+p.cost||0),0);
  let html='<div class="twostat"><div><div class="sl">Parts profit · this month</div><div class="sv" style="color:var(--green)">'+money(partsProfit(from,to))+'</div></div><div class="tap-lowstock" style="cursor:pointer"><div class="sl">Low on stock &rsaquo;</div><div class="sv" style="color:'+(low?'var(--accent)':'var(--ink)')+'">'+low+'</div></div></div>';
  html+='<input class="searchbox" id="part_search" placeholder="&#128269; Search part by name" value="'+esc(partSearch)+'">';
  // category filter chips
  const cats=['all'].concat(CATEGORIES.filter(c=>mem.parts.some(p=>p.category===c)));
  html+='<div class="filterbar" style="flex-wrap:wrap">'+cats.map(c=>'<button data-partf="'+c+'" class="'+(partFilter===c?'on':'')+'">'+(c==='all'?'All':c)+'</button>').join('')+'</div>';
  html+='<button class="save" id="part_add" style="margin-top:0">+ New part</button>';

  let list=[...mem.parts];
  const q=partSearch.trim().toLowerCase();
  if(q)list=list.filter(p=>(p.name||'').toLowerCase().includes(q)||(p.forVehicle||'').toLowerCase().includes(q));
  if(partFilter!=='all')list=list.filter(p=>p.category===partFilter);
  list.sort((a,b)=>{const al=isLow(a),bl=isLow(b);if(al!==bl)return al?-1:1;return (a.name||'').localeCompare(b.name||'');});

  if(!mem.parts.length){
    return html+'<div class="card" style="margin-top:12px"><div class="empty"><div class="e-ic">&#128230;</div>No parts yet. Tap <b>+ New part</b> to add your first item.</div></div>';
  }
  if(!list.length){
    return html+'<div class="card" style="margin-top:12px"><div class="empty">No part matches.</div></div>';
  }
  html+='<div class="hint" style="margin:6px 0 8px">Inventory value (at cost): <b>'+money(invValue)+'</b> · tap a part to Sell, Restock or Edit.</div>';
  html+='<div class="card">'+list.map(partRow).join('')+'</div>';
  return html;
}

/* ---------------- REPAIRS ---------------- */
let repairFilter='active';
function repairRow(r){
  const st=repairStatus(r);
  const stCls={paid:'paid',done:'partial',open:'unpaid'}[st];
  const sub=[r.customer||'', r.plate?('Plate '+r.plate):''].filter(Boolean).join(' · ');
  return '<div class="item" data-repair="'+r.id+'"><div class="ic '+(st==='paid'?'sale':st==='done'?'sal':'exp')+'">&#128295;</div>'
    +'<div class="body"><div class="t1">'+esc(r.work||r.plate||'Repair job')+'</div><div class="t2">'+esc(sub)+'</div>'
    +'<span class="pill '+stCls+'">'+repairStatusLabel(r)+'</span>'
    +(r.received?'<span class="pill adj">In '+r.received+'</span>':'')
    +'</div><div class="amt in">'+money(r.price||0)+'</div></div>';
}
function renderRepairs(){
  const all=[...mem.repairs].sort((a,b)=>(b.received||b.id+'')> (a.received||a.id+'')?1:-1);
  const active=all.filter(r=>repairStatus(r)!=='paid');
  const done=all.filter(r=>repairStatus(r)==='paid');
  const owed=active.filter(r=>repairStatus(r)==='done').reduce((s,r)=>s+(r.price||0),0);
  let html='<div class="twostat"><div><div class="sl">Open jobs</div><div class="sv">'+active.length+'</div></div><div><div class="sl">Done, awaiting pay</div><div class="sv" style="color:var(--accent)">'+money(owed)+'</div></div></div>';
  html+='<div class="filterbar">'+[['active','Active'],['done','Done'],['all','All']].map(f=>'<button data-repf="'+f[0]+'" class="'+(repairFilter===f[0]?'on':'')+'">'+f[1]+'</button>').join('')+'</div>';
  html+='<button class="save" id="repair_add" style="margin-top:0">+ New repair job</button>';
  let list = repairFilter==='active'?active : repairFilter==='done'?done : all;
  if(!all.length){return html+'<div class="card" style="margin-top:12px"><div class="empty"><div class="e-ic">&#128295;</div>No repair jobs yet. Tap <b>+ New repair job</b>.</div></div>';}
  if(!list.length){return html+'<div class="card" style="margin-top:12px"><div class="empty" style="padding:18px">Nothing here &mdash; all caught up &#10003;</div></div>';}
  html+='<div class="card" style="margin-top:4px">'+list.map(repairRow).join('')+'</div>';
  html+='<div class="hint" style="text-align:center;margin-top:10px">Tap a job to update it · mark Paid to count its labor as income.</div>';
  return html;
}

/* ---------------- CUSTOMERS & VEHICLES ---------------- */
let custSearch='';
function renderCustomers(){
  const q=custSearch.trim().toLowerCase();
  let custs=[...mem.customers].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  if(q)custs=custs.filter(c=>(c.name||'').toLowerCase().includes(q)||(c.phone||'').includes(q)||(c.vehicles||[]).some(v=>(v.plate||'').toLowerCase().includes(q)||(v.model||'').toLowerCase().includes(q)));
  const vehCount=mem.customers.reduce((s,c)=>s+(c.vehicles||[]).length,0);
  let html='<div class="twostat"><div><div class="sl">Customers</div><div class="sv">'+mem.customers.length+'</div></div><div><div class="sl">Vehicles</div><div class="sv">'+vehCount+'</div></div></div>';
  html+='<input class="searchbox" id="cust_search" placeholder="&#128269; Search name, phone or plate" value="'+esc(custSearch)+'">';
  html+='<div class="hint" style="margin:-4px 0 10px">Customers are also added automatically when you record a sale or repair with their name.</div>';
  html+='<button class="save" id="cust_add" style="margin-top:0">+ New customer</button>';
  if(!custs.length){html+='<div class="card" style="margin-top:12px"><div class="empty"><div class="e-ic">&#128663;</div>'+(q?'No customer matches.':'No customers yet.')+'</div></div>';return html;}
  html+='<div class="card" style="margin-top:12px">'+custs.map(c=>{
    const veh=(c.vehicles||[]).map(v=>[v.model,v.plate].filter(Boolean).join(' ')).filter(Boolean).slice(0,3).join(', ');
    return '<div class="item custcard" data-cust="'+c.id+'"><div class="ic sale">&#128663;</div><div class="body"><div class="t1">'+esc(c.name||'Customer')+'</div><div class="t2">'+(c.phone?esc(c.phone):'no phone')+(veh?' · '+esc(veh):'')+'</div></div><div class="amt" style="color:var(--muted)">'+(c.vehicles||[]).length+'&nbsp;veh</div></div>';
  }).join('')+'</div>';
  return html;
}

/* ---------------- SUPPLIERS ---------------- */
function renderSuppliers(){
  let html='<div class="twostat"><div><div class="sl">Suppliers</div><div class="sv">'+mem.suppliers.length+'</div></div><div><div class="sl">Restock this month</div><div class="sv" style="color:var(--accent)">'+money(partsCostThisMonthFromExpenses())+'</div></div></div>';
  html+='<button class="save" id="sup_add" style="margin-top:0">+ New supplier</button>';
  if(!mem.suppliers.length){html+='<div class="card" style="margin-top:12px"><div class="empty"><div class="e-ic">&#127981;</div>No suppliers yet. Add the shops you buy parts from.</div></div>';return html;}
  const list=[...mem.suppliers].sort((a,b)=>(a.name||'').localeCompare(b.name||''));
  html+='<div class="card" style="margin-top:12px">'+list.map(s=>'<div class="item" data-sup="'+s.id+'"><div class="ic exp" style="background:var(--card2)">&#127981;</div><div class="body"><div class="t1">'+esc(s.name||'Supplier')+'</div><div class="t2">'+(s.phone?esc(s.phone):'')+(s.note?(s.phone?' · ':'')+esc(s.note):'')+'</div></div></div>').join('')+'</div>';
  return html;
}
function partsCostThisMonthFromExpenses(){
  const ym=today().slice(0,7);
  return mem.expenses.filter(e=>e.book==='parts'&&(e.cat==='Restock'||e.cat==='Part cost')&&(e.date||'').slice(0,7)===ym).reduce((s,e)=>s+e.amount,0);
}

/* ---------------- LOANS ---------------- */
function renderLoans(){
  const loans=[...mem.loans].sort((a,b)=>b.balance-a.balance);
  const totalBal=loans.reduce((s,l)=>s+l.balance,0);const totalBorrowed=loans.reduce((s,l)=>s+l.total,0);
  const list=loans.length?loans.map(l=>{const repaid=loanRepaid(l),pct=l.total>0?Math.round(repaid/l.total*100):0;const cleared=l.balance<=0;const purp=(l.purpose||'business')==='household'?'<span class="pill adj">Household</span>':'<span class="pill" style="background:var(--card2);color:var(--muted)">Business</span>';return '<div class="item" data-loan="'+l.id+'"><div class="ic loan">&#9672;</div><div class="body"><div class="t1">'+esc(l.lender||'Loan')+'</div><div class="t2">'+money(repaid)+' repaid of '+money(l.total)+(l.note?' · '+esc(l.note):'')+'</div>'+purp+'<span class="pill '+(cleared?'paid':'partial')+'">'+(cleared?'Cleared &#10003;':money(l.balance)+' left')+'</span><div class="prog"><i style="width:'+pct+'%;background:var(--purple)"></i></div></div><div class="amt">'+pct+'%</div></div>';}).join(''):'<div class="empty"><div class="e-ic">&#9672;</div>No loans tracked. Tap + &rarr; Loan.</div>';
  return '<div class="twostat"><div><div class="sl">Still to repay</div><div class="sv" style="color:var(--purple)">'+money(totalBal)+'</div></div><div><div class="sl">Total borrowed</div><div class="sv">'+money(totalBorrowed)+'</div></div></div><div class="hint" style="margin:0 0 10px">Repayments are drawn from parts cash.</div><div class="card">'+list+'</div>'+(loans.length?'<div class="hint" style="text-align:center;margin-top:10px">Tap a loan to log a repayment.</div>':'');
}

/* ---------------- ASSETS ---------------- */
function renderAssets(){
  const assets=[...mem.assets].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const total=assets.reduce((s,a)=>s+(+a.value||0),0);
  let html='<div class="twostat"><div><div class="sl">Assets built · value</div><div class="sv" style="color:var(--green)">'+money(total)+'</div></div><div><div class="sl">Items</div><div class="sv">'+assets.length+'</div></div></div>';
  html+='<div class="hint" style="margin:0 0 10px">Big things the shop owns &mdash; a car, tools, property. The money came out of parts cash, but it became something you still own, so it is tracked here instead of disappearing as an expense.</div>';
  html+='<button class="save" id="asset_add" style="margin-top:0">+ Record an asset</button>';
  if(!assets.length){html+='<div class="card" style="margin-top:12px"><div class="empty"><div class="e-ic">&#127974;</div>No assets recorded yet.</div></div>';return html;}
  html+='<div class="card" style="margin-top:12px">'+assets.map(a=>'<div class="item" data-asset="'+a.id+'"><div class="ic sale">&#127974;</div><div class="body"><div class="t1">'+esc(a.name||'Asset')+'</div><div class="t2">'+(a.date||'')+(a.note?' · '+esc(a.note):'')+'</div></div><div class="amt in">'+money(a.value||0)+'</div></div>').join('')+'</div>';
  html+='<div class="hint" style="text-align:center;margin-top:10px">Tap an asset to edit · swipe to delete.</div>';
  return html;
}

/* ---------------- AUDIT ---------------- */
function renderAudit(){
  const books=monthlyBooks();
  let totParts=0,totRepairs=0,totHH=0;
  books.forEach(b=>{totParts+=b.partsProfit;totRepairs+=b.repairsProfit;totHH+=b.hh;});
  let html='<div class="twostat"><div><div class="sl">Parts profit · all</div><div class="sv" style="color:var(--green)">'+money(totParts)+'</div></div><div><div class="sl">Repairs profit · all</div><div class="sv" style="color:var(--green)">'+money(totRepairs)+'</div></div></div>';
  html+='<div class="hint" style="margin-bottom:10px">This shows <b>exactly</b> what each book counts, month by month. Parts and repairs are kept separate. Household and loan repayments draw from parts cash. If a number looks off, the date on a sale/repair/expense is usually the cause &mdash; tap it to fix.</div>';
  if(!books.length)return html+'<div class="card"><div class="empty">No data yet.</div></div>';
  books.forEach(b=>{
    const label=new Date(b.ym+'-01').toLocaleDateString('en',{month:'long',year:'numeric'});
    html+='<div class="dash-section" style="font-size:16px">'+label+'</div><div class="card">';
    html+='<div class="item" style="cursor:default"><div class="ic sale">&#128736;</div><div class="body"><div class="t1">Parts book</div><div class="t2">sold '+money(b.pInc)+' · part cost '+money(b.pCog)+' · expenses '+money(b.pExp)+'</div></div><div class="amt '+(b.partsProfit>=0?'in':'out')+'">'+(b.partsProfit<0?'&minus;':'')+money(Math.abs(b.partsProfit))+'</div></div>';
    html+='<div class="item" style="cursor:default"><div class="ic sal">&#128295;</div><div class="body"><div class="t1">Repairs book</div><div class="t2">labor '+money(b.rInc)+' · expenses '+money(b.rExp)+'</div></div><div class="amt '+(b.repairsProfit>=0?'in':'out')+'">'+(b.repairsProfit<0?'&minus;':'')+money(Math.abs(b.repairsProfit))+'</div></div>';
    if(b.hh)html+='<div class="item" style="cursor:default"><div class="ic home">&#127968;</div><div class="body"><div class="t1">Household (from parts cash)</div></div><div class="amt out">&minus;'+money(b.hh)+'</div></div>';
    html+='</div>';
  });
  return html;
}

/* ---------------- REPORTS ---------------- */
let repPeriod='month';
function periodRange(){
  const now=new Date();
  if(repPeriod==='week'){const t=new Date(now);const day=(t.getDay()+6)%7;t.setDate(t.getDate()-day);return [t.toISOString().slice(0,10), today()];}
  if(repPeriod==='year'){return [now.getFullYear()+'-01-01', today()];}
  return monthRange(today().slice(0,7));
}
function monthlyBarChart(rows){
  if(!rows.length)return '<div class="empty" style="padding:20px">No monthly data yet.</div>';
  if(hideMoney)return '<div class="empty" style="padding:20px">Money hidden &mdash; tap the eye to show.</div>';
  const max=Math.max(1,...rows.map(r=>Math.max(r.income,r.exp)));
  const H=120;
  const bars=rows.map(r=>{
    const ih=Math.round(r.income/max*H), eh=Math.round(r.exp/max*H);
    const short=r.label.split(' ')[0];
    return '<div class="mbar" data-gomonth="'+r.ym+'" title="'+r.label+'"><div class="mbar-cols" style="height:'+H+'px"><div class="mbar-col inc" style="height:'+Math.max(2,ih)+'px"></div><div class="mbar-col exp" style="height:'+Math.max(2,eh)+'px"></div></div><div class="mbar-label">'+short+'</div></div>';
  }).join('');
  return '<div class="mchart-legend"><span><i class="lg inc"></i>Income</span><span><i class="lg exp"></i>Spent</span></div><div class="mchart">'+bars+'</div><div class="hint" style="margin-top:8px">Tap a month for its full detail.</div>';
}
function bookCard(kind){
  const[from,to]=periodRange();
  if(kind==='parts'){
    const inc=partsIncome(from,to),cog=partsCostOfGoods(from,to),exp=partsBizExpenses(from,to),prof=inc-cog-exp;
    return '<div class="repcard"><h3>&#128736; Parts book</h3>'
      +'<div class="bookln"><span>Parts sold</span><span class="in">'+money(inc)+'</span></div>'
      +'<div class="bookln"><span>Cost of parts</span><span class="out">&minus;'+money(cog)+'</span></div>'
      +'<div class="bookln"><span>Parts expenses (salary, etc.)</span><span class="out">&minus;'+money(exp)+'</span></div>'
      +'<div class="bookln tot"><span>Parts profit</span><span class="'+(prof>=0?'in':'out')+'">'+(prof<0?'&minus;':'')+money(Math.abs(prof))+'</span></div></div>';
  }
  const inc=repairsIncome(from,to),exp=repairsExpenses(from,to),prof=inc-exp;
  return '<div class="repcard"><h3>&#128295; Maintenance book</h3>'
    +'<div class="bookln"><span>Repair labor (paid jobs)</span><span class="in">'+money(inc)+'</span></div>'
    +'<div class="bookln"><span>Repair expenses (mechanic, etc.)</span><span class="out">&minus;'+money(exp)+'</span></div>'
    +'<div class="bookln tot"><span>Maintenance profit</span><span class="'+(prof>=0?'in':'out')+'">'+(prof<0?'&minus;':'')+money(Math.abs(prof))+'</span></div></div>';
}
function renderReports(){
  const[from,to]=periodRange();
  const combined=combinedProfit(from,to);
  const hh=householdTotal(from,to);
  const periodLabel={week:'This week',month:'This month',year:'This year'}[repPeriod];
  let html='<div class="filterbar">'+[['week','This week'],['month','This month'],['year','This year']].map(p=>'<button data-repp="'+p[0]+'" class="'+(repPeriod===p[0]?'on':'')+'">'+p[1]+'</button>').join('')+'</div>';

  html+=bookCard('parts');
  html+=bookCard('repairs');

  html+='<div class="twostat"><div><div class="sl">Combined profit · '+periodLabel.toLowerCase()+'</div><div class="sv" style="color:'+(combined>=0?'var(--green)':'var(--accent)')+'">'+(combined<0?'&minus;':'')+money(Math.abs(combined))+'</div></div><div><div class="sl">Household (from parts)</div><div class="sv" style="color:var(--accent)">&minus;'+money(hh)+'</div></div></div>';

  // assets built (drawn from parts cash, but owned)
  const assetsAll=mem.assets.reduce((s,a)=>s+(+a.value||0),0);
  if(assetsAll>0){
    html+='<div class="twostat"><div class="tap-assets" style="cursor:pointer"><div class="sl">Assets built &rsaquo;</div><div class="sv" style="color:var(--green)">'+money(assetsAll)+'</div></div><div><div class="sl">Cash position</div><div class="sv" style="color:'+(cashPosition()>=0?'var(--green)':'var(--accent)')+'">'+(cashPosition()<0?'&minus;':'')+money(Math.abs(cashPosition()))+'</div></div></div><div class="hint" style="margin:-2px 0 4px">Assets came out of parts cash but are things the shop owns (car, tools). Not a loss &mdash; tap to view.</div>';
  }

  // monthly trend
  const series=monthlyBooks().slice(0,12).reverse().map(b=>({ym:b.ym,label:b.label,income:b.income,exp:b.exp}));
  html+='<div class="repcard"><h3>Monthly income vs spent</h3>'+monthlyBarChart(series)+'</div>';

  // best part
  const bp=bestPart();
  if(bp)html+='<div class="repcard"><h3>Top selling part</h3><div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font-family:Fraunces,serif;font-size:18px">'+esc(bp.k)+'</span><span style="color:var(--green);font-weight:600">'+money(bp.v)+'</span></div><div class="hint" style="margin-top:4px">By total sales value, all time.</div></div>';

  // loans
  const loans=[...mem.loans].sort((a,b)=>b.balance-a.balance);
  const totalBal=loans.reduce((s,l)=>s+l.balance,0);
  const loanRows=loans.length?loans.map(l=>{const repaid=loanRepaid(l),pct=l.total>0?Math.round(repaid/l.total*100):0;const cleared=l.balance<=0;return '<div class="item" data-loan="'+l.id+'"><div class="ic loan">&#9672;</div><div class="body"><div class="t1">'+esc(l.lender||'Loan')+'</div><div class="t2">'+money(repaid)+' repaid of '+money(l.total)+'</div><span class="pill '+(cleared?'paid':'partial')+'">'+(cleared?'Cleared &#10003;':money(l.balance)+' left')+'</span><div class="prog"><i style="width:'+pct+'%;background:var(--purple)"></i></div></div><div class="amt">'+pct+'%</div></div>';}).join(''):'<div class="empty" style="padding:18px">No loans tracked.</div>';
  html+='<div class="dash-section">Loans <span style="font-family:Archivo;font-style:normal;font-size:12px;color:var(--muted)">&mdash; '+money(totalBal)+' to repay · drawn from parts cash</span></div><div class="card">'+loanRows+'</div>';

  // previous months
  const ser=monthlyBooks().slice(0,12);
  if(ser.length){
    const rows=ser.map(r=>'<div class="item monthrow" data-gomonth="'+r.ym+'" style="cursor:pointer"><div class="body"><div class="t1">'+r.label+'</div><div class="t2">parts '+money(r.partsProfit)+' · repairs '+money(r.repairsProfit)+'</div></div><div class="amt" style="color:'+((r.partsProfit+r.repairsProfit)>=0?'var(--green)':'var(--accent)')+'">'+((r.partsProfit+r.repairsProfit)<0?'&minus;':'')+money(Math.abs(r.partsProfit+r.repairsProfit))+' &rsaquo;</div></div>').join('');
    html+='<div class="dash-section">Previous months</div><div class="card">'+rows+'</div>';
  }
  html+='<button class="ghost" id="setBtn">&#9881; Settings &amp; account</button>';
  return html;
}
function renderMonthDetail(ym){
  const[from,to]=monthRange(ym);
  const label=new Date(ym+'-01').toLocaleDateString('en',{month:'long',year:'numeric'});
  const sales=mem.sales.filter(s=>inRange(s.date,from,to));
  const reps=mem.repairs.filter(r=>r.paid&&inRange(r.paidOn||r.dispatch||r.received,from,to));
  const exps=mem.expenses.filter(e=>inRange(e.date,from,to));
  const hh=mem.household.filter(h=>inRange(h.date,from,to));
  let html='<h2>'+label+'</h2>';
  html+='<div class="twostat"><div><div class="sl">Parts profit</div><div class="sv" style="color:var(--green)">'+money(partsProfit(from,to))+'</div></div><div><div class="sl">Repairs profit</div><div class="sv" style="color:var(--green)">'+money(repairsProfit(from,to))+'</div></div></div>';
  html+='<div class="dash-section">Parts sold ('+sales.length+')</div><div class="card">'+(sales.length?sales.sort((a,b)=>(b.date||'').localeCompare(a.date||'')).map(s=>'<div class="item" style="cursor:default"><div class="ic sale">&#128736;</div><div class="body"><div class="t1">'+esc(s.name||'Part')+(s.qty>1?' ×'+s.qty:'')+'</div><div class="t2">'+(s.customer||'Counter')+' · '+(s.date||'')+'</div></div><div class="amt in">'+money((s.unitPrice||0)*(s.qty||0))+'</div></div>').join(''):'<div class="empty" style="padding:16px">No parts sold.</div>')+'</div>';
  html+='<div class="dash-section">Repairs paid ('+reps.length+')</div><div class="card">'+(reps.length?reps.map(r=>'<div class="item" style="cursor:default"><div class="ic sal">&#128295;</div><div class="body"><div class="t1">'+esc(r.work||r.plate||'Job')+'</div><div class="t2">'+(r.customer||'')+'</div></div><div class="amt in">'+money(r.price||0)+'</div></div>').join(''):'<div class="empty" style="padding:16px">No repairs paid.</div>')+'</div>';
  const allCosts=exps.concat(hh.map(h=>({cat:h.cat,amount:h.amount,date:h.date,note:h.note,book:'household'})));
  html+='<div class="dash-section">Spending ('+allCosts.length+')</div><div class="card">'+(allCosts.length?allCosts.sort((a,b)=>b.amount-a.amount).map(e=>'<div class="item" style="cursor:default"><div class="ic '+(e.book==='household'?'home':'exp')+'">&minus;</div><div class="body"><div class="t1">'+(e.loanId?'Loan repayment':e.cat)+'</div><div class="t2">'+(e.book==='household'?'Household':e.book==='repairs'?'Repairs':'Parts')+' · '+(e.date||'')+'</div></div><div class="amt out">&minus;'+money(e.amount)+'</div></div>').join(''):'<div class="empty" style="padding:16px">No spending.</div>')+'</div>';
  openSheet(html);
}

/* ============================================================
   SHEETS / FORMS
   ============================================================ */
const scrim=$('scrim'),sheet=$('sheet'),sheetInner=$('sheetInner');
function lockScroll(){document.body.style.overflow='hidden';document.body.style.touchAction='none';}
function unlockScroll(){if(!sheet.classList.contains('show')&&!$('sideMenu').classList.contains('show')){document.body.style.overflow='';document.body.style.touchAction='';}}
function openSheet(html){
  sheetInner.innerHTML='<div class="grab" id="grabClose"></div><button class="sheetback" id="sheetBack" aria-label="Back">&#8592;</button><button class="sheetclose" id="sheetClose" aria-label="Close">&times;</button>'+html;
  scrim.classList.add('show');sheet.classList.add('show');sheet.scrollTop=0;lockScroll();
  const sc=$('sheetClose');if(sc)sc.onclick=closeSheet;
  const sb2=$('sheetBack');if(sb2)sb2.onclick=closeSheet;
  // swipe-down to dismiss (only from very top)
  let startY=null,curY=0;
  const onStart=e=>{if(sheet.scrollTop>2){startY=null;return;}startY=e.touches?e.touches[0].clientY:e.clientY;curY=0;sheet.style.transition='none';};
  const onMove=e=>{if(startY===null)return;const y=e.touches?e.touches[0].clientY:e.clientY;curY=y-startY;if(curY>0){sheet.style.transform='translateY('+curY+'px)';scrim.style.opacity=Math.max(0,1-curY/400);}};
  const onEnd=()=>{if(startY===null)return;sheet.style.transition='';scrim.style.opacity='';if(curY>120){closeSheet();}else{sheet.style.transform='';}startY=null;};
  sheet.addEventListener('touchstart',onStart,{passive:true});
  sheet.addEventListener('touchmove',onMove,{passive:true});
  sheet.addEventListener('touchend',onEnd);
  // edge-swipe-right to go back
  let exStart=null,exDx=0,exActive=false;
  const exOnStart=e=>{const t=e.touches?e.touches[0]:e;if(t.clientX<=30){exStart=t.clientX;exDx=0;exActive=true;sheet.style.transition='none';}else{exStart=null;exActive=false;}};
  const exOnMove=e=>{if(!exActive||exStart===null)return;const t=e.touches?e.touches[0]:e;exDx=t.clientX-exStart;if(exDx>0){sheet.style.transform='translateX('+exDx+'px)';scrim.style.opacity=Math.max(0,1-exDx/400);}};
  const exOnEnd=()=>{if(!exActive){return;}sheet.style.transition='';scrim.style.opacity='';if(exDx>80){closeSheet();}else{sheet.style.transform='';}exStart=null;exActive=false;exDx=0;};
  sheet.addEventListener('touchstart',exOnStart,{passive:true});
  sheet.addEventListener('touchmove',exOnMove,{passive:true});
  sheet.addEventListener('touchend',exOnEnd);
  document.querySelectorAll('.addopt').forEach(b=>b.onclick=()=>{const t=b.dataset.t;
    if(t==='sale')saleForm();
    else if(t==='part')partForm();
    else if(t==='repair')repairForm();
    else if(t==='pexp')expenseForm('parts');
    else if(t==='rexp')expenseForm('repairs');
    else if(t==='home')householdForm();
    else if(t==='loan')loanForm();
    else if(t==='asset')assetForm();
  });
}
function closeSheet(){scrim.classList.remove('show');sheet.classList.remove('show');sheet.style.transform='';scrim.style.opacity='';unlockScroll();}
scrim.onclick=closeSheet;
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeSheet();closeSide();}});

let fs={};

/* ----- customer helpers ----- */
function findCustomerByName(name){const n=(name||'').trim().toLowerCase();return mem.customers.find(c=>(c.name||'').trim().toLowerCase()===n);}
function upsertCustomer(name,phone,plate,model){
  const nm=(name||'').trim();if(!nm)return null;
  let c=findCustomerByName(nm);
  if(!c){c={id:uid(),name:nm,phone:phone||'',vehicles:[],note:''};mem.customers.push(c);}
  if(phone&&!c.phone)c.phone=phone;
  if(plate){const exists=(c.vehicles||[]).some(v=>(v.plate||'').toLowerCase()===plate.toLowerCase());if(!exists){c.vehicles=c.vehicles||[];c.vehicles.push({plate:plate,model:model||''});}}
  return c.id;
}

/* ----- PART form (add / edit inventory) ----- */
function partForm(existing){
  const p=existing||{};
  fs={category:p.category||'Engine'};
  let html='<h2>'+(existing?'Edit part':'New part')+'</h2>';
  if(existing){
    const prof=partProfitEach(existing);
    html+='<div class="repcard" style="margin-bottom:8px;padding:14px 16px"><div style="display:flex;justify-content:space-between;align-items:baseline"><span style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)">In stock</span><span style="font-family:Fraunces,serif;font-size:22px;font-weight:600;color:'+(isLow(existing)?'var(--accent)':'var(--ink)')+'">'+(+existing.stock||0)+'</span></div><div style="font-size:12px;color:var(--muted);margin-top:4px">Profit each: '+(prof<0?'&minus;':'')+money(Math.abs(prof))+' &middot; '+money(existing.cost||0)+' cost &rarr; '+money(existing.price||0)+' sell</div></div>';
  }
  html+='<label>Item name (write it yourself)</label><input id="p_name" value="'+esc(p.name||'')+'" placeholder="e.g. Engine Oil 4L, Toyota brake pad">';
  html+='<label>Category</label><div class="cats">'+CATEGORIES.map(c=>'<button data-cat="'+c+'" class="'+(fs.category===c?'sel':'')+'"><span class="ce">'+catIcon(c)+'</span>'+c+'</button>').join('')+'</div>';
  html+='<label>For vehicle (optional)</label><input id="p_for" value="'+esc(p.forVehicle||'')+'" placeholder="e.g. Toyota Corolla, Hilux">';
  html+='<label>In stock now</label><input id="p_stock" type="number" inputmode="numeric" value="'+(p.stock!=null?p.stock:'')+'" placeholder="0">';
  html+='<div class="tworow"><div><label>Cost price ('+CUR()+')</label><input id="p_cost" type="number" inputmode="decimal" value="'+(p.cost!=null?p.cost:'')+'" placeholder="0"></div><div><label>Selling price ('+CUR()+')</label><input id="p_price" type="number" inputmode="decimal" value="'+(p.price!=null?p.price:'')+'" placeholder="0"></div></div>';
  html+='<label>Note (optional)</label><input id="p_note" value="'+esc(p.note||'')+'" placeholder="shelf, brand, etc.">';
  html+='<button class="save" id="p_save">'+(existing?'Save changes':'Add part')+'</button>';
  if(existing){
    html+='<button class="ghost" id="p_sell" style="color:var(--green);font-weight:600">&#128176; Sell this part</button>';
    html+='<button class="ghost" id="p_restock" style="color:var(--purple);font-weight:600">&#128230; Restock (add stock)</button>';
    html+='<button class="ghost del" id="p_del">Delete part</button>';
  }
  openSheet(html);
  document.querySelectorAll('.cats button').forEach(b=>b.onclick=()=>{fs.category=b.dataset.cat;document.querySelectorAll('.cats button').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');});
  $('p_save').onclick=async()=>{
    const name=$('p_name').value.trim();if(!name){toast('Enter the item name');return;}
    const data={name:name,category:fs.category,forVehicle:$('p_for').value.trim(),stock:+$('p_stock').value||0,cost:+$('p_cost').value||0,price:+$('p_price').value||0,note:$('p_note').value.trim()};
    if(existing)Object.assign(existing,data);else mem.parts.push(Object.assign({id:uid()},data));
    await save();closeSheet();savedTick(existing?'Part updated':'Part added');render();
  };
  if(existing){
    $('p_sell').onclick=()=>saleForm(null,existing.id);
    $('p_restock').onclick=()=>restockForm(existing);
    $('p_del').onclick=async()=>{if(confirm('Delete this part? Past sales of it stay in your records.')){mem.parts=mem.parts.filter(x=>x.id!==existing.id);await save();closeSheet();toast('Deleted');render();}};
  }
}

/* ----- RESTOCK form (adds stock, records a Parts-book expense) ----- */
function restockForm(part){
  let html='<h2>Restock: '+esc(part.name||'part')+'</h2>';
  html+='<div class="hint" style="margin-bottom:6px">Currently <b>'+(+part.stock||0)+'</b> in stock. Adding stock records the purchase as a Parts-book expense.</div>';
  html+='<label>Quantity added</label><input id="rs_qty" type="number" inputmode="numeric" placeholder="0">';
  html+='<label>Cost per unit ('+CUR()+')</label><input id="rs_cost" type="number" inputmode="decimal" value="'+(part.cost||'')+'" placeholder="0">';
  html+='<label>Supplier (optional)</label><input id="rs_sup" list="suplist" placeholder="who you bought from"><datalist id="suplist">'+mem.suppliers.map(s=>'<option value="'+esc(s.name)+'">').join('')+'</datalist>';
  html+='<label>Date</label><input id="rs_date" type="date" value="'+today()+'">';
  html+='<div class="balbox"><span class="bl">Total cost</span><span class="bv" id="rs_tot">'+CUR()+' 0</span></div>';
  html+='<button class="save" id="rs_save">Add stock</button>';
  openSheet(html);
  const upd=()=>{const q=+$('rs_qty').value||0,c=+$('rs_cost').value||0;$('rs_tot').textContent=CUR()+' '+(q*c).toLocaleString();};
  $('rs_qty').oninput=upd;$('rs_cost').oninput=upd;upd();
  $('rs_save').onclick=async()=>{
    const q=+$('rs_qty').value||0;if(q<=0){toast('Enter quantity');return;}
    const c=+$('rs_cost').value||0;
    part.stock=(+part.stock||0)+q;
    if(c>0)part.cost=c; // update unit cost to latest
    const supName=$('rs_sup').value.trim();
    if(supName && !mem.suppliers.some(s=>(s.name||'').toLowerCase()===supName.toLowerCase()))mem.suppliers.push({id:uid(),name:supName,phone:'',note:''});
    mem.expenses.push({id:uid(),book:'parts',cat:'Restock',amount:q*c,date:$('rs_date').value||today(),note:part.name+(supName?' · '+supName:''),recurring:false,freq:'once'});
    await save();closeSheet();savedTick('Restocked +'+q);render();
  };
}

/* ----- SALE form (sells a part, deducts stock, parts income) ----- */
function saleForm(existing,presetPartId){
  fs={partId:presetPartId||''};
  let html='<h2>Sell a part</h2>';
  if(!mem.parts.length){html+='<div class="hint">No parts in inventory yet. Add a part first, then sell it.</div><button class="save" id="sale_addpart">+ New part</button>';openSheet(html);$('sale_addpart').onclick=()=>partForm();return;}
  html+='<label>Part</label><select id="sale_part">'+['<option value="">Choose a part…</option>'].concat(mem.parts.map(p=>'<option value="'+p.id+'"'+(fs.partId===p.id?' selected':'')+'>'+esc(p.name)+' ('+(+p.stock||0)+' in stock)</option>')).join('')+'</select>';
  html+='<label>Quantity</label><input id="sale_qty" type="number" inputmode="numeric" value="1" placeholder="1">';
  html+='<label>Unit price ('+CUR()+')</label><input id="sale_price" type="number" inputmode="decimal" placeholder="0">';
  html+='<label>Customer (optional)</label><input id="sale_cust" list="custlist" placeholder="walk-in or name"><datalist id="custlist">'+mem.customers.map(c=>'<option value="'+esc(c.name)+'">').join('')+'</datalist>';
  html+='<label>Date</label><input id="sale_date" type="date" value="'+today()+'">';
  html+='<div class="balbox"><span class="bl">Total</span><span class="bv" id="sale_tot">'+CUR()+' 0</span></div>';
  html+='<div class="hint" id="sale_stockhint" style="margin-top:2px"></div>';
  html+='<button class="save" id="sale_save">Record sale</button>';
  openSheet(html);
  const fillPrice=()=>{const p=partById($('sale_part').value);if(p){if(!$('sale_price').value)$('sale_price').value=p.price||'';}upd();};
  const upd=()=>{
    const p=partById($('sale_part').value);const q=+$('sale_qty').value||0;const pr=+$('sale_price').value||0;
    $('sale_tot').textContent=CUR()+' '+(q*pr).toLocaleString();
    const h=$('sale_stockhint');
    if(p){const left=(+p.stock||0)-q;h.innerHTML=left<0?'<span style="color:var(--accent)">Only '+(+p.stock||0)+' in stock &mdash; this would go negative.</span>':'After sale: '+left+' left in stock'+(left<=LOWSTOCK()?' <span style="color:var(--accent)">(low)</span>':'');}
    else h.innerHTML='';
  };
  $('sale_part').onchange=fillPrice;$('sale_qty').oninput=upd;$('sale_price').oninput=upd;
  if(fs.partId){fillPrice();}
  $('sale_save').onclick=async()=>{
    const p=partById($('sale_part').value);if(!p){toast('Choose a part');return;}
    const q=+$('sale_qty').value||0;if(q<=0){toast('Enter quantity');return;}
    const pr=+$('sale_price').value||0;if(pr<=0){toast('Enter unit price');return;}
    const custName=$('sale_cust').value.trim();
    if(custName)upsertCustomer(custName,'','','');
    p.stock=(+p.stock||0)-q;
    mem.sales.push({id:uid(),date:$('sale_date').value||today(),partId:p.id,name:p.name,qty:q,unitPrice:pr,unitCost:+p.cost||0,customer:custName,note:''});
    await save();closeSheet();savedTick('Sale recorded');render();
  };
}

/* ----- REPAIR job form ----- */
function repairForm(existing){
  const r=existing||{};
  fs={paid:r.paid||false};
  let html='<h2>'+(existing?'Repair job':'New repair job')+'</h2>';
  html+='<label>Plate number</label><input id="r_plate" value="'+esc(r.plate||'')+'" placeholder="e.g. A12345">';
  html+='<label>Customer name</label><input id="r_cust" list="custlist" value="'+esc(r.customer||'')+'" placeholder="owner name"><datalist id="custlist">'+mem.customers.map(c=>'<option value="'+esc(c.name)+'">').join('')+'</datalist>';
  html+='<label>Phone (optional)</label><input id="r_phone" type="tel" value="'+esc(r.phone||'')+'" placeholder="09...">';
  html+='<label>Vehicle / model (optional)</label><input id="r_model" value="'+esc(r.model||'')+'" placeholder="e.g. Corolla 2014">';
  html+='<label>Work to do / done</label><input id="r_work" value="'+esc(r.work||'')+'" placeholder="e.g. full service, brake job">';
  html+='<div class="tworow"><div><label>Date received</label><input id="r_recv" type="date" value="'+(r.received||today())+'"></div><div><label>Date dispatched</label><input id="r_disp" type="date" value="'+(r.dispatch||'')+'"></div></div>';
  html+='<label>Labor price ('+CUR()+')</label><input id="r_price" type="number" inputmode="decimal" value="'+(r.price||'')+'" placeholder="0">';
  html+='<div class="hint" style="margin:4px 0 0">Customer brings their own parts &mdash; only your labor counts here. Income counts when you mark the job Paid.</div>';
  html+='<div class="toggle '+(fs.paid?'on':'')+'" id="r_paidtog"><span class="tl">Paid by customer</span><span class="sw"><i></i></span></div>';
  html+='<label>Note (optional)</label><input id="r_note" value="'+esc(r.note||'')+'" placeholder="anything to remember">';
  html+='<button class="save" id="r_save">'+(existing?'Save changes':'Add repair job')+'</button>';
  if(existing)html+='<button class="ghost del" id="r_del">Delete job</button>';
  openSheet(html);
  $('r_paidtog').onclick=function(){fs.paid=!fs.paid;this.classList.toggle('on',fs.paid);};
  $('r_save').onclick=async()=>{
    const price=+$('r_price').value||0;
    const custName=$('r_cust').value.trim();const plate=$('r_plate').value.trim();const model=$('r_model').value.trim();
    if(custName)upsertCustomer(custName,$('r_phone').value.trim(),plate,model);
    const wasPaid=existing?existing.paid:false;
    const data={plate:plate,customer:custName,phone:$('r_phone').value.trim(),model:model,work:$('r_work').value.trim(),received:$('r_recv').value,dispatch:$('r_disp').value,price:price,paid:fs.paid,note:$('r_note').value.trim()};
    if(fs.paid && !wasPaid)data.paidOn=today();
    else if(fs.paid && existing)data.paidOn=existing.paidOn||today();
    else data.paidOn='';
    if(existing)Object.assign(existing,data);else mem.repairs.push(Object.assign({id:uid()},data));
    await save();closeSheet();savedTick(existing?'Job updated':'Job saved');render();
  };
  if(existing)$('r_del').onclick=async()=>{if(confirm('Delete this repair job?')){mem.repairs=mem.repairs.filter(x=>x.id!==existing.id);await save();closeSheet();toast('Deleted');render();}};
}

/* ----- EXPENSE form (Parts-book or Repairs-book) ----- */
function expenseForm(book,existing){
  const e=existing||{};
  if(e.loanId){ // loan repayment edit
    const loan=mem.loans.find(l=>l.id===e.loanId);
    let html='<h2>Edit loan repayment</h2>';
    html+='<div class="hint" style="margin-bottom:8px">Repayment to <b>'+esc((loan&&loan.lender)||'lender')+'</b>, drawn from parts cash.</div>';
    html+='<label>Amount ('+CUR()+')</label><input id="le_amt" type="number" inputmode="decimal" value="'+(e.amount||'')+'">';
    html+='<label>Date</label><input id="le_date" type="date" value="'+(e.date||today())+'">';
    html+='<label>Note (optional)</label><input id="le_note" value="'+esc(e.note||'')+'">';
    html+='<button class="save" id="le_save">Save changes</button><button class="ghost del" id="le_del">Delete this repayment</button>';
    openSheet(html);
    $('le_save').onclick=async()=>{e.amount=+$('le_amt').value||0;e.date=$('le_date').value;e.note=$('le_note').value;await save();closeSheet();savedTick('Repayment saved');render();};
    $('le_del').onclick=async()=>{if(confirm('Delete this repayment entry? The loan record stays.')){mem.expenses=mem.expenses.filter(x=>x.id!==e.id);await save();closeSheet();toast('Deleted');render();}};
    return;
  }
  const bk=existing?existing.book:book;
  const partCats=[['Restock','&#128230;'],['Salaries','&#128101;'],['Rent','&#127968;'],['Transport','&#128666;'],['Utilities','&#128161;'],['Other','&middot;']];
  const repCats=[['Salaries','&#128101;'],['Tools','&#128295;'],['Consumables','&#129704;'],['Rent','&#127968;'],['Utilities','&#128161;'],['Other','&middot;']];
  const cats=bk==='repairs'?repCats:partCats;
  fs={cat:e.cat||cats[0][0],freq:e.freq||'once'};
  let html='<h2>'+(existing?'Edit expense':(bk==='repairs'?'Repairs expense':'Parts expense'))+'</h2>';
  html+='<div class="hint" style="margin:0 0 10px">This goes into the <b>'+(bk==='repairs'?'Maintenance':'Parts')+' book</b>.</div>';
  html+='<label>Category</label><div class="cats">'+cats.map(c=>'<button data-cat="'+c[0]+'" class="'+(fs.cat===c[0]?'sel':'')+'"><span class="ce">'+c[1]+'</span>'+c[0]+'</button>').join('')+'</div>';
  html+='<div id="e_empwrap" style="display:'+(fs.cat==='Salaries'?'block':'none')+'"><label>Employee / person name</label><input id="e_emp" value="'+esc(e.employee||'')+'" placeholder="'+(bk==='repairs'?'mechanic name':'counter staff')+'"></div>';
  html+='<label>Amount ('+CUR()+')</label><input id="e_amt" type="number" inputmode="decimal" value="'+(e.amount||'')+'" placeholder="0">';
  html+='<label>Date</label><input id="e_date" type="date" value="'+(e.date||today())+'">';
  html+='<label>Note (optional)</label><input id="e_note" value="'+esc(e.note||'')+'" placeholder="details">';
  html+='<label>Repeats?</label><div class="seg" id="seg_freq">'+[['once','One-time'],['week','Weekly'],['month','Monthly'],['quarter','Every 3 months']].map(f=>'<button data-freq="'+f[0]+'" class="'+(fs.freq===f[0]?'sel':'')+'">'+f[1]+'</button>').join('')+'</div>';
  html+='<button class="save" id="e_save">'+(existing?'Save changes':'Add expense')+'</button>';
  if(existing)html+='<button class="ghost del" id="e_del">Delete</button>';
  openSheet(html);
  document.querySelectorAll('.cats button').forEach(b=>b.onclick=()=>{fs.cat=b.dataset.cat;document.querySelectorAll('.cats button').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');$('e_empwrap').style.display=fs.cat==='Salaries'?'block':'none';});
  document.querySelectorAll('#seg_freq button').forEach(b=>b.onclick=()=>{fs.freq=b.dataset.freq;document.querySelectorAll('#seg_freq button').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');});
  $('e_save').onclick=async()=>{
    const amount=+$('e_amt').value||0;if(amount<=0){toast('Enter an amount');return;}
    const emp=fs.cat==='Salaries'?($('e_emp').value||''):'';
    const data={book:bk,cat:fs.cat,amount:amount,date:$('e_date').value,note:$('e_note').value,employee:emp,recurring:fs.freq!=='once',freq:fs.freq};
    if(existing)Object.assign(existing,data);else mem.expenses.push(Object.assign({id:uid()},data));
    await save();closeSheet();savedTick(existing?'Expense updated':'Expense saved');render();
  };
  if(existing)$('e_del').onclick=async()=>{mem.expenses=mem.expenses.filter(x=>x.id!==existing.id);await save();closeSheet();toast('Deleted');render();};
}

/* ----- HOUSEHOLD form (drawn from parts cash) ----- */
function householdForm(existing){
  const h=existing||{};
  const cats=[['Grocery','&#129004;'],['Rent','&#127968;'],['School','&#127890;'],['Health','&#9877;'],['Transport','&#128666;'],['Other','&middot;']];
  fs={cat:h.cat||cats[0][0]};
  let html='<h2>'+(existing?'Edit household':'Household expense')+'</h2>';
  html+='<div class="hint" style="margin:0 0 10px">Personal/home spending, <b>drawn from parts cash</b>. Kept separate from the business books.</div>';
  html+='<label>Category</label><div class="cats">'+cats.map(c=>'<button data-cat="'+c[0]+'" class="'+(fs.cat===c[0]?'sel':'')+'"><span class="ce">'+c[1]+'</span>'+c[0]+'</button>').join('')+'</div>';
  html+='<label>Amount ('+CUR()+')</label><input id="h_amt" type="number" inputmode="decimal" value="'+(h.amount||'')+'" placeholder="0">';
  html+='<label>Date</label><input id="h_date" type="date" value="'+(h.date||today())+'">';
  html+='<label>Note (optional)</label><input id="h_note" value="'+esc(h.note||'')+'" placeholder="details">';
  html+='<button class="save" id="h_save">'+(existing?'Save changes':'Add household expense')+'</button>';
  if(existing)html+='<button class="ghost del" id="h_del">Delete</button>';
  openSheet(html);
  document.querySelectorAll('.cats button').forEach(b=>b.onclick=()=>{fs.cat=b.dataset.cat;document.querySelectorAll('.cats button').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');});
  $('h_save').onclick=async()=>{
    const amount=+$('h_amt').value||0;if(amount<=0){toast('Enter an amount');return;}
    const data={cat:fs.cat,amount:amount,date:$('h_date').value,note:$('h_note').value};
    if(existing)Object.assign(existing,data);else mem.household.push(Object.assign({id:uid()},data));
    await save();closeSheet();savedTick(existing?'Updated':'Saved');render();
  };
  if(existing)$('h_del').onclick=async()=>{mem.household=mem.household.filter(x=>x.id!==existing.id);await save();closeSheet();toast('Deleted');render();};
}

/* ----- CUSTOMER form (with vehicles) ----- */
function customerForm(existing){
  const c=existing||{};
  fs={vehicles:(c.vehicles||[]).map(v=>({plate:v.plate,model:v.model}))};
  let html='<h2>'+(existing?'Customer':'New customer')+'</h2>';
  html+='<label>Name</label><input id="c_name" value="'+esc(c.name||'')+'" placeholder="full name">';
  html+='<label>Phone (optional)</label><input id="c_phone" type="tel" value="'+esc(c.phone||'')+'" placeholder="09...">';
  html+='<label>Vehicles</label><div id="c_vlist"></div>';
  html+='<div class="tworow" style="margin-top:6px"><input id="c_vmodel" placeholder="model e.g. Corolla"><input id="c_vplate" placeholder="plate e.g. A12345"></div>';
  html+='<button class="seg" id="c_vadd" style="width:auto;padding:8px 16px;border:1px solid var(--line);border-radius:11px;background:var(--card2);color:var(--ink);font-weight:600;margin-top:8px">+ Add vehicle</button>';
  html+='<label style="margin-top:14px">Note (optional)</label><input id="c_note" value="'+esc(c.note||'')+'" placeholder="anything to remember">';
  html+='<button class="save" id="c_save">'+(existing?'Save customer':'Add customer')+'</button>';
  if(existing)html+='<button class="ghost del" id="c_del">Delete customer</button>';
  openSheet(html);
  const drawV=()=>{
    const el=$('c_vlist');
    el.innerHTML=fs.vehicles.length?fs.vehicles.map((v,i)=>'<div class="item" style="cursor:default;padding:9px 0;border-bottom:1px solid var(--line)"><div class="ic sale" style="width:34px;height:34px;font-size:15px">&#128663;</div><div class="body"><div class="t1">'+esc(v.model||'Vehicle')+'</div><div class="t2">'+esc(v.plate||'')+'</div></div><span data-vdel="'+i+'" style="color:var(--accent);font-size:20px;padding:0 6px;cursor:pointer">&times;</span></div>').join(''):'<div class="hint" style="margin:4px 0">No vehicles yet.</div>';
    el.querySelectorAll('[data-vdel]').forEach(b=>b.onclick=()=>{fs.vehicles.splice(+b.dataset.vdel,1);drawV();});
  };
  drawV();
  $('c_vadd').onclick=()=>{const model=$('c_vmodel').value.trim(),plate=$('c_vplate').value.trim();if(!model&&!plate)return;fs.vehicles.push({model:model,plate:plate});$('c_vmodel').value='';$('c_vplate').value='';drawV();};
  $('c_save').onclick=async()=>{
    const name=$('c_name').value.trim();if(!name){toast('Enter a name');return;}
    const data={name:name,phone:$('c_phone').value,vehicles:fs.vehicles.slice(),note:$('c_note').value};
    if(existing)Object.assign(existing,data);else mem.customers.push(Object.assign({id:uid()},data));
    await save();closeSheet();toast(existing?'Customer saved':'Customer added');render();
  };
  if(existing)$('c_del').onclick=async()=>{if(confirm('Delete this customer? Their past sales/repairs stay.')){mem.customers=mem.customers.filter(x=>x.id!==existing.id);await save();closeSheet();toast('Deleted');render();}};
}

/* ----- SUPPLIER form ----- */
function supplierForm(existing){
  const s=existing||{};
  let html='<h2>'+(existing?'Supplier':'New supplier')+'</h2>';
  html+='<label>Name</label><input id="su_name" value="'+esc(s.name||'')+'" placeholder="e.g. Habesha Auto Spare">';
  html+='<label>Phone (optional)</label><input id="su_phone" type="tel" value="'+esc(s.phone||'')+'" placeholder="09...">';
  html+='<label>Note (optional)</label><input id="su_note" value="'+esc(s.note||'')+'" placeholder="what they supply, location">';
  html+='<button class="save" id="su_save">'+(existing?'Save supplier':'Add supplier')+'</button>';
  if(existing)html+='<button class="ghost del" id="su_del">Delete supplier</button>';
  openSheet(html);
  $('su_save').onclick=async()=>{
    const name=$('su_name').value.trim();if(!name){toast('Enter a name');return;}
    const data={name:name,phone:$('su_phone').value,note:$('su_note').value};
    if(existing)Object.assign(existing,data);else mem.suppliers.push(Object.assign({id:uid()},data));
    await save();closeSheet();toast(existing?'Saved':'Supplier added');render();
  };
  if(existing)$('su_del').onclick=async()=>{mem.suppliers=mem.suppliers.filter(x=>x.id!==existing.id);await save();closeSheet();toast('Deleted');render();};
}

/* ----- LOAN forms ----- */
function loanForm(existing){
  const l=existing||{};
  fs={purpose:l.purpose||'business'};
  let html='<h2>'+(existing?'Loan':'Add a loan')+'</h2><label>Lender / source</label><input id="l_lender" value="'+esc(l.lender||'')+'" placeholder="e.g. Bank, relative">';
  html+='<label>What is this loan for?</label><div class="seg" id="seg_purpose">'+[['business','Business (parts)'],['household','Household']].map(p=>'<button data-purpose="'+p[0]+'" class="'+(fs.purpose===p[0]?'sel':'')+'">'+p[1]+'</button>').join('')+'</div>';
  html+='<div class="hint" id="l_phint" style="margin:4px 0 0">'+(fs.purpose==='business'?'Repayments will count as a <b>business (parts) expense</b> — they reduce parts profit.':'Repayments will count as a <b>household expense</b> — they reduce your balance, not business profit.')+'</div>';
  html+='<label>Total loan amount ('+CUR()+')</label><input id="l_total" type="number" inputmode="decimal" value="'+(l.total||'')+'" placeholder="0" '+(existing?'disabled style="opacity:.5"':'')+'>';
  if(existing)html+='<label>Current balance ('+CUR()+')</label><input id="l_bal" type="number" inputmode="decimal" value="'+l.balance+'">';
  html+='<label>Note (optional)</label><input id="l_note" value="'+esc(l.note||'')+'" placeholder="e.g. due 5th monthly">';
  if(existing)html+='<div class="balbox"><span class="bl">Repaid</span><span class="bv">'+money(loanRepaid(l))+' of '+money(l.total)+'</span></div>';
  html+='<button class="save" id="l_save">'+(existing?'Save':'Add loan')+'</button>';
  if(existing)html+='<button class="ghost" id="l_repay" style="color:var(--purple);font-weight:600">&#65291; Log a repayment</button><button class="ghost del" id="l_del">Delete loan</button>';
  openSheet(html);
  document.querySelectorAll('#seg_purpose button').forEach(b=>b.onclick=()=>{fs.purpose=b.dataset.purpose;document.querySelectorAll('#seg_purpose button').forEach(x=>x.classList.remove('sel'));b.classList.add('sel');$('l_phint').innerHTML=fs.purpose==='business'?'Repayments will count as a <b>business (parts) expense</b> — they reduce parts profit.':'Repayments will count as a <b>household expense</b> — they reduce your balance, not business profit.';});
  $('l_save').onclick=async()=>{if(existing){existing.lender=$('l_lender').value;existing.note=$('l_note').value;existing.purpose=fs.purpose;const b=+$('l_bal').value;if(!isNaN(b))existing.balance=Math.max(0,Math.min(existing.total,b));}else{const total=+$('l_total').value||0;if(total<=0){toast('Enter loan amount');return;}mem.loans.push({id:uid(),lender:$('l_lender').value,total:total,balance:total,note:$('l_note').value,purpose:fs.purpose,created:today()});}await save();closeSheet();toast(existing?'Saved':'Loan added');render();};
  if(existing){$('l_repay').onclick=()=>repayForm(existing);$('l_del').onclick=async()=>{mem.loans=mem.loans.filter(x=>x.id!==existing.id);mem.expenses=mem.expenses.filter(x=>x.loanId!==existing.id);mem.household=mem.household.filter(x=>x.loanId!==existing.id);await save();closeSheet();toast('Loan deleted');render();};}
}
function repayForm(loan){
  const isBiz=(loan.purpose||'business')==='business';
  openSheet('<h2>Repay: '+esc(loan.lender||'loan')+'</h2><div class="hint" style="margin-bottom:6px">'+money(loan.balance)+' remaining · '+(isBiz?'counts as a business (parts) expense':'counts as a household expense')+'</div><label>Repayment amount ('+CUR()+')</label><input id="r_amt" type="number" inputmode="decimal" placeholder="0"><label>Date</label><input id="r_date" type="date" value="'+today()+'"><button class="save" id="r_save">Log repayment</button>');
  $('r_save').onclick=async()=>{const amt=+$('r_amt').value||0;if(amt<=0){toast('Enter an amount');return;}const pay=Math.min(loan.balance,amt);loan.balance=Math.max(0,loan.balance-pay);
    if(isBiz){mem.expenses.push({id:uid(),book:'parts',cat:'Loan repay',amount:pay,date:$('r_date').value,note:loan.lender,loanId:loan.id,recurring:false,freq:'once'});}
    else{mem.household.push({id:uid(),cat:'Loan repay',amount:pay,date:$('r_date').value,note:loan.lender,loanId:loan.id});}
    await save();closeSheet();toast(loan.balance===0?'Loan cleared! &#10003;':'Repayment logged');render();};
}

/* ----- ASSET form (drawn from parts cash, kept as something owned) ----- */
function assetForm(existing){
  const a=existing||{};
  let html='<h2>'+(existing?'Edit asset':'Record an asset')+'</h2>';
  html+='<div class="hint" style="margin:0 0 10px">Something the shop bought and still owns (car, tools, property). The money comes out of <b>parts cash</b>, but it is tracked here as an asset, not lost as an expense.</div>';
  html+='<label>What is it?</label><input id="as_name" value="'+esc(a.name||'')+'" placeholder="e.g. Toyota pickup, welding machine">';
  html+='<label>Value paid ('+CUR()+')</label><input id="as_val" type="number" inputmode="decimal" value="'+(a.value||'')+'" placeholder="0">';
  html+='<label>Date bought</label><input id="as_date" type="date" value="'+(a.date||today())+'">';
  html+='<label>Note (optional)</label><input id="as_note" value="'+esc(a.note||'')+'" placeholder="bought with loan, plate no., etc.">';
  html+='<button class="save" id="as_save">'+(existing?'Save changes':'Record asset')+'</button>';
  if(existing)html+='<button class="ghost del" id="as_del">Delete asset</button>';
  openSheet(html);
  $('as_save').onclick=async()=>{
    const name=$('as_name').value.trim();if(!name){toast('Enter what it is');return;}
    const val=+$('as_val').value||0;if(val<=0){toast('Enter the value');return;}
    const data={name:name,value:val,date:$('as_date').value||today(),note:$('as_note').value.trim()};
    if(existing)Object.assign(existing,data);else mem.assets.push(Object.assign({id:uid()},data));
    await save();closeSheet();savedTick(existing?'Asset updated':'Asset recorded');render();
  };
  if(existing)$('as_del').onclick=async()=>{if(confirm('Delete this asset record?')){mem.assets=mem.assets.filter(x=>x.id!==existing.id);await save();closeSheet();toast('Deleted');render();}};
}

/* ----- SETTINGS ----- */
function settingsForm(){
  openSheet('<h2>Settings &amp; account</h2>'
    +'<label>Currency label</label><input id="s_cur" value="'+esc(CUR())+'" placeholder="Br, ETB, Birr">'
    +'<label>Low-stock alert when stock is at or below</label><input id="s_low" type="number" inputmode="numeric" value="'+LOWSTOCK()+'" placeholder="3">'
    +'<button class="save" id="s_save">Save</button>'
    +'<div class="hint" style="margin-top:18px">Signed in as <b>'+esc(currentEmail||'')+'</b>. Your data lives in the cloud and syncs live between devices.</div>'
    +'<button class="ghost" id="s_export">&#11015; Download a backup copy</button>'
    +'<button class="ghost del" id="s_signout">Sign out</button>');
  $('s_save').onclick=async()=>{mem.settings.currency=$('s_cur').value||'Br';const lv=+$('s_low').value;mem.settings.lowStock=isNaN(lv)?3:lv;await save();closeSheet();toast('Saved');render();};
  $('s_export').onclick=()=>{const blob=new Blob([JSON.stringify(mem,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='abise-backup-'+today()+'.json';a.click();};
  $('s_signout').onclick=async()=>{await sb.auth.signOut();location.reload();};
}

/* ============================================================
   WIRING
   ============================================================ */
async function deleteEntity(kind,id){
  if(kind==='part')mem.parts=mem.parts.filter(x=>x.id!==id);
  else if(kind==='sale')mem.sales=mem.sales.filter(x=>x.id!==id);
  else if(kind==='repair')mem.repairs=mem.repairs.filter(x=>x.id!==id);
  else if(kind==='exp')mem.expenses=mem.expenses.filter(x=>x.id!==id);
  else if(kind==='home')mem.household=mem.household.filter(x=>x.id!==id);
  else if(kind==='loan')mem.loans=mem.loans.filter(x=>x.id!==id);
  else if(kind==='cust')mem.customers=mem.customers.filter(x=>x.id!==id);
  else if(kind==='sup')mem.suppliers=mem.suppliers.filter(x=>x.id!==id);
  else if(kind==='asset')mem.assets=mem.assets.filter(x=>x.id!==id);
  await save();savedTick('Deleted');render();
}
function attachSwipeDelete(){
  const map=[['data-part','part'],['data-sale','sale'],['data-repair','repair'],['data-exp','exp'],['data-home','home'],['data-loan','loan'],['data-asset','asset'],['data-cust','cust'],['data-sup','sup']];
  map.forEach(([attr,kind])=>{
    document.querySelectorAll('.item['+attr+']').forEach(item=>{
      if(item.dataset.swipeWired)return; item.dataset.swipeWired='1';
      const id=item.getAttribute(attr);
      item.classList.add('has-swipe');
      const content=document.createElement('div');content.className='swipe-content';
      while(item.firstChild){content.appendChild(item.firstChild);}
      const del=document.createElement('button');del.className='swipe-del';del.textContent='Delete';
      del.onclick=(e)=>{e.stopPropagation();if(confirm('Delete this item?')){deleteEntity(kind,id);}};
      item.appendChild(del);
      item.appendChild(content);
      let sx=null,dx=0,opened=false;const W=88;
      const setX=x=>{content.style.transform='translateX('+x+'px)';};
      const reset=()=>{content.style.transition='transform .2s';setX(0);opened=false;item.classList.remove('swiped');};
      const openIt=()=>{content.style.transition='transform .2s';setX(-W);opened=true;item.classList.add('swiped');};
      content.addEventListener('touchstart',e=>{sx=e.touches[0].clientX;dx=0;content.style.transition='none';},{passive:true});
      content.addEventListener('touchmove',e=>{if(sx===null)return;dx=e.touches[0].clientX-sx;const base=opened?-W:0;const nx=Math.min(0,Math.max(-W,base+dx));setX(nx);},{passive:true});
      content.addEventListener('touchend',()=>{if(sx===null)return;const base=opened?-W:0;const final=base+dx;if(final<-W/2)openIt();else reset();sx=null;
        setTimeout(()=>{document.addEventListener('touchstart',function once(ev){if(!item.contains(ev.target)){reset();}document.removeEventListener('touchstart',once);},{passive:true,once:true});},0);
      });
    });
  });
}
function wireDynamic(){
  attachSwipeDelete();
  document.querySelectorAll('[data-part]').forEach(el=>el.onclick=()=>{const p=partById(el.dataset.part);if(p)partForm(p);});
  document.querySelectorAll('[data-sale]').forEach(el=>el.onclick=()=>{toast('Sale recorded earlier — swipe to delete if wrong');});
  document.querySelectorAll('[data-repair]').forEach(el=>el.onclick=()=>{const r=mem.repairs.find(x=>x.id===el.dataset.repair);if(r)repairForm(r);});
  document.querySelectorAll('[data-exp]').forEach(el=>el.onclick=()=>{const e=mem.expenses.find(x=>x.id===el.dataset.exp);if(e)expenseForm(e.book,e);});
  document.querySelectorAll('[data-home]').forEach(el=>el.onclick=()=>{const h=mem.household.find(x=>x.id===el.dataset.home);if(!h)return;if(h.loanId){const l=mem.loans.find(x=>x.id===h.loanId);if(l){loanForm(l);return;}}householdForm(h);});
  document.querySelectorAll('[data-loan]').forEach(el=>el.onclick=()=>{const l=mem.loans.find(x=>x.id===el.dataset.loan);if(l)loanForm(l);});
  document.querySelectorAll('[data-asset]').forEach(el=>el.onclick=()=>{const a=mem.assets.find(x=>x.id===el.dataset.asset);if(a)assetForm(a);});
  document.querySelectorAll('[data-cust]').forEach(el=>el.onclick=()=>{const c=mem.customers.find(x=>x.id===el.dataset.cust);if(c)customerForm(c);});
  document.querySelectorAll('[data-sup]').forEach(el=>el.onclick=()=>{const s=mem.suppliers.find(x=>x.id===el.dataset.sup);if(s)supplierForm(s);});
  document.querySelectorAll('[data-gomonth]').forEach(b=>b.onclick=()=>renderMonthDetail(b.dataset.gomonth));
  document.querySelectorAll('[data-partf]').forEach(b=>b.onclick=()=>{partFilter=b.dataset.partf;render();});
  document.querySelectorAll('[data-repf]').forEach(b=>b.onclick=()=>{repairFilter=b.dataset.repf;render();});
  document.querySelectorAll('[data-repp]').forEach(b=>b.onclick=()=>{repPeriod=b.dataset.repp;render();});
  document.querySelectorAll('.tap-lowstock').forEach(b=>b.onclick=()=>{partFilter='all';setTab('parts');});
  document.querySelectorAll('.tap-repairs').forEach(b=>b.onclick=()=>setTab('repairs'));
  document.querySelectorAll('.tap-loans').forEach(b=>b.onclick=()=>setTab('loans'));
  document.querySelectorAll('.tap-assets').forEach(b=>b.onclick=()=>setTab('assets'));
  // search boxes
  const ps=$('part_search');if(ps)ps.oninput=()=>{partSearch=ps.value;const v=renderParts();$('view').innerHTML='<div class="pagetitle">'+TITLES.parts+'</div>'+v;wireDynamic();const ps2=$('part_search');if(ps2){ps2.focus();ps2.setSelectionRange(ps2.value.length,ps2.value.length);}};
  const cs=$('cust_search');if(cs)cs.oninput=()=>{custSearch=cs.value;const v=renderCustomers();$('view').innerHTML='<div class="pagetitle">'+TITLES.customers+'</div>'+v;wireDynamic();const cs2=$('cust_search');if(cs2){cs2.focus();cs2.setSelectionRange(cs2.value.length,cs2.value.length);}};
  // add buttons inside views
  const pa=$('part_add');if(pa)pa.onclick=()=>partForm();
  const ra=$('repair_add');if(ra)ra.onclick=()=>repairForm();
  const ca=$('cust_add');if(ca)ca.onclick=()=>customerForm();
  const sua=$('sup_add');if(sua)sua.onclick=()=>supplierForm();
  const asa=$('asset_add');if(asa)asa.onclick=()=>assetForm();
  const setb=$('setBtn');if(setb)setb.onclick=settingsForm;
}
document.querySelectorAll('nav button[data-tab]').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));

/* side menu */
function openSide(){$('sideScrim').classList.add('show');$('sideMenu').classList.add('show');lockScroll();}
function closeSide(){const sm=$('sideMenu');$('sideScrim').classList.remove('show');sm.classList.remove('show');sm.style.transform='';unlockScroll();}
$('menuBtn').onclick=openSide;
(function(){
  const eb=$('eyeBtn');
  function paint(){eb.innerHTML=hideMoney?'&#128584;':'&#128065;';eb.classList.toggle('on',hideMoney);}
  paint();
  eb.onclick=()=>{hideMoney=!hideMoney;try{localStorage.setItem('abise:hideMoney',hideMoney?'1':'0');}catch(e){}paint();render();toast(hideMoney?'Money hidden':'Money shown');};
})();
(function(){
  const sm=$('sideMenu');let sx=null,dx=0;
  sm.addEventListener('touchstart',e=>{sx=e.touches[0].clientX;dx=0;sm.style.transition='none';},{passive:true});
  sm.addEventListener('touchmove',e=>{if(sx===null)return;dx=e.touches[0].clientX-sx;if(dx<0){sm.style.transform='translateX('+dx+'px)';}},{passive:true});
  sm.addEventListener('touchend',()=>{if(sx===null)return;sm.style.transition='';if(dx<-70){closeSide();}else{sm.style.transform='';}sx=null;});
})();
$('sideClose').onclick=closeSide;
$('sideScrim').onclick=closeSide;
document.querySelectorAll('.sideitem').forEach(b=>b.onclick=()=>{const go=b.dataset.go;closeSide();if(go==='settings'){settingsForm();}else{setTab(go);}});

/* the central + button */
$('addBtn').onclick=()=>openSheet('<h2>Add</h2>'
  +'<div class="addsection">Income</div><div class="addgrid">'
  +'<button class="addopt" data-t="sale"><span class="ce">&#128736;</span>Sell a part</button>'
  +'<button class="addopt" data-t="repair"><span class="ce">&#128295;</span>Repair job</button>'
  +'</div>'
  +'<div class="addsection">Inventory</div><div class="addgrid">'
  +'<button class="addopt" data-t="part"><span class="ce">&#128230;</span>New / edit part</button>'
  +'</div>'
  +'<div class="addsection">Expense</div><div class="addgrid">'
  +'<button class="addopt" data-t="pexp"><span class="ce">&#128722;</span>Parts expense</button>'
  +'<button class="addopt" data-t="rexp"><span class="ce">&#128295;</span>Repairs expense</button>'
  +'</div><div class="addgrid" style="margin-top:8px">'
  +'<button class="addopt" data-t="home"><span class="ce">&#127968;</span>Household</button>'
  +'<button class="addopt" data-t="loan"><span class="ce">&#9672;</span>Loan</button>'
  +'<button class="addopt" data-t="asset"><span class="ce">&#127974;</span>Asset</button>'
  +'</div>');

/* ============================================================
   AUTH FLOW
   ============================================================ */
let currentEmail='';
function showAuth(msg,cls){$('loadingView').style.display='none';$('appView').style.display='none';$('authView').style.display='flex';if(msg){const m=$('au_msg');m.textContent=msg;m.className='auth-msg '+(cls||'');}}
function showApp(){$('loadingView').style.display='none';$('authView').style.display='none';$('appView').style.display='block';}

async function bootSession(){
  const {data:{session}} = await sb.auth.getSession();
  if(!session){ showAuth(''); return; }
  currentEmail = session.user.email;
  $('loadingView').style.display='flex';
  const ok = await cloudLoad();
  if(!ok){ toast('Could not load data'); }
  subscribeRealtime();
  showApp(); setSync('synced'); render();
}

$('au_signin').onclick=async()=>{
  const email=$('au_email').value.trim(),pass=$('au_pass').value;
  if(!email||!pass){showAuth('Enter email and password','err');return;}
  $('au_signin').disabled=true;
  const {error}=await sb.auth.signInWithPassword({email,password:pass});
  $('au_signin').disabled=false;
  if(error){
    const m=(error.message||'').toLowerCase();
    if(m.includes('confirm')){showAuth('Please confirm your email first — open the link we sent to '+email+', then sign in.','err');return;}
    if(m.includes('invalid')){showAuth('Email or password is wrong. Check and try again.','err');return;}
    showAuth(error.message,'err');return;
  }
  bootSession();
};
$('au_signup').onclick=async()=>{
  const email=$('au_email').value.trim(),pass=$('au_pass').value;
  if(!email||pass.length<6){showAuth('Enter your email and a password of at least 6 characters','err');return;}
  $('au_signup').disabled=true;
  const {data,error}=await sb.auth.signUp({email,password:pass});
  $('au_signup').disabled=false;
  if(error){
    const m=(error.message||'').toLowerCase();
    if(m.includes('already')){showAuth('That email already has an account — just sign in above.','err');return;}
    showAuth(error.message,'err');return;
  }
  // If the project has confirmation ON, there's no active session yet -> guide them to their inbox.
  if(data && data.session){ bootSession(); return; }
  showAuth('✓ Account created! Check your email ('+email+') and tap the confirmation link, then come back here and sign in.','ok');
  $('au_pass').value='';
};

/* ============================================================
   START
   ============================================================ */
(function start(){
  if(configError){ showAuth(configError,'err'); $('au_signin').disabled=true; $('au_signup').disabled=true; return; }
  bootSession();
})();
