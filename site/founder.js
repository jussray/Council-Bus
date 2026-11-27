const byId=id=>document.getElementById(id);
const quotes=[
 'A question becomes powerful when its evidence can be traced.',
 'Five perspectives. One record. No borrowed authority.',
 'Good counsel explores options; only the founder decides.',
 'Every claim deserves a source. Every decision, a receipt.',
 'Clarity begins with what we actually know.',
 'A record is not approval. Evidence is not permission.'
];
let q=0,active=false,records=[];
function rotate(){if(document.hidden||matchMedia('(prefers-reduced-motion: reduce)').matches)return;q=(q+1)%quotes.length;const node=byId('quote');node.classList.add('fade');setTimeout(()=>{node.textContent=quotes[q];node.classList.remove('fade')},220)}
setInterval(rotate,7000);
const status=message=>{byId('feedback').textContent=message};
async function api(path,{method='GET',body}={}){
 const response=await fetch(path,{method,cache:'no-store',credentials:'same-origin',headers:{'accept':'application/json',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 let value;try{value=await response.json()}catch{throw Error('Unexpected server response')}
 if(!response.ok)throw Error(typeof value?.error==='string'?value.error:'Request failed');
 return value;
}
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
function renderSeats(list){const root=byId('seats');root.replaceChildren();for(const seat of list){const row=el('div',undefined,'seat');row.append(el('strong',seat.id.toUpperCase()),el('small',seat.configured===true?'Configured · Runtime unverified':seat.configured===false?'Not configured':'Unknown · Worker verification unavailable'));root.append(row)}}
function renderRecords(){const root=byId('records');root.replaceChildren();if(!records.length){root.append(el('p','No durable records yet.'));return}for(const rec of records){const box=el('article',undefined,'record');box.append(el('small','UNKNOWN · UNSEALED · '+new Date(rec.createdAt).toLocaleString()),el('p',rec.claim));const label=el('label','Council seat');const choose=el('select');choose.setAttribute('aria-label','Choose Council seat for '+rec.id);for(const seat of ['chatgpt','claude','deepseek','muse','perplexity']){const opt=el('option',seat);opt.value=seat;choose.append(opt)}const send=el('button','Queue for founder approval','btn subtle');send.type='button';send.addEventListener('click',async()=>{send.disabled=true;try{const r=await api('/api/workflows',{method:'POST',body:{recordId:rec.id,seat:choose.value}});status('Workflow queued, not approved: '+r.id);await loadWorkflows()}catch(err){status('Queue blocked: '+err.message)}finally{send.disabled=false}});box.append(label,choose,send);root.append(box)}}
async function loadRecords(){try{records=(await api('/api/records')).records;renderRecords()}catch(err){status('Ledger unavailable: '+err.message)}}
async function loadWorkflows(){const root=byId('workflows');try{const items=(await api('/api/workflows')).workflows;root.replaceChildren();if(!items.length){root.append(el('p','No queued workflows.'));return}for(const wf of items){const box=el('div',undefined,'record');box.append(el('small',wf.seat+' · '+wf.id),el('p','Pending founder action; do not mistake queueing for approval.'));const approve=el('button','Explicitly approve','btn');approve.type='button';approve.addEventListener('click',async()=>{if(!window.confirm('Authorize this single Council Workflow? A provider request may execute; no other permissions are granted.'))return;approve.disabled=true;try{const r=await api('/api/workflows/'+encodeURIComponent(wf.id)+'/approve',{method:'POST',body:{decision:'approve'}});status('Founder approval event accepted: '+r.id)}catch(err){status('Approval blocked: '+err.message)}finally{approve.disabled=false}});box.append(approve);root.append(box)}}catch(err){root.replaceChildren(el('p','Workflow read blocked: '+err.message))}}
async function init(){status('');try{const session=await api('/api/session');if(!session.identityVerified)throw Error('founder_identity_unverified');active=true;byId('identity').textContent='Verified founder session';byId('unauthorized').classList.add('hidden');byId('app').classList.remove('hidden');const [seats,readiness]=await Promise.all([api('/api/seats'),api('/api/readiness')]);renderSeats(seats.seats);byId('readiness').textContent=readiness.dbAvailable?'Private database available. GitHub sealing still requires the ledger review gate.':'Ledger binding unavailable (fail-closed).';await Promise.all([loadRecords(),loadWorkflows()])}catch(err){active=false;byId('identity').textContent='Founder session not verified';byId('app').classList.add('hidden');byId('unauthorized').classList.remove('hidden');status('Workspace locked: '+err.message)}}
byId('record-form').addEventListener('submit',async event=>{event.preventDefault();if(!active)return;const claim=byId('claim').value.trim(),source=byId('source').value.trim(),note=byId('note').value.trim();const evidence=source?[{url:source,note}]:[];const btn=event.submitter;btn.disabled=true;try{await api('/api/records',{method:'POST',body:{claim,evidence}});byId('claim').value='';byId('source').value='';byId('note').value='';status('Durable draft saved. Not sealed or approved.');await loadRecords()}catch(err){status('Save blocked: '+err.message)}finally{btn.disabled=false}});
byId('reload').addEventListener('click',init);
init();
