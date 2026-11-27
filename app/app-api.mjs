import {verifyFounderAccess} from './founder-access.mjs';

const SEATS=['chatgpt','claude','deepseek','muse','perplexity'];
const RECORD=/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i;
const WORKFLOW=/^council-(chatgpt|claude|deepseek|muse|perplexity)-[0-9a-f]{32}$/;
const OWNER={decisionOwner:'founder',grantsExecutionAuthority:false};
const HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'};
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:HEADERS});
const fail=(status,reason)=>reply({error:reason},status);
const safeSeat=seat=>typeof seat==='string'&&SEATS.includes(seat);
const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function bodyJSON(request,max=12_000){
 const length=Number(request.headers.get('content-length')||0);
 if(!Number.isFinite(length)||length>max*4)return null;
 try {const raw=await request.text();return raw.length>max?null:JSON.parse(raw)}catch{return null}
}
function validateEvidence(items){
 if(items===undefined)return [];
 if(!Array.isArray(items)||items.length>8)return null;
 const out=[];
 for(const item of items){
  if(!item||typeof item!=='object'||Array.isArray(item)||typeof item.url!=='string'||typeof item.note!=='string'||item.note.length>600)return null;
  let url;
  try {url=new URL(item.url)}catch{return null}
  if(url.protocol!=='https:'||!url.hostname||url.username||url.password||item.url.length>1600)return null;
  out.push({url:url.toString(),note:item.note.trim()});
 }
 return out;
}
const dbReady=env=>env.COUNCIL_DB&&typeof env.COUNCIL_DB.prepare==='function';
const routerReady=(env,seat)=>typeof env.COUNCIL_ROUTER?.fetch==='function'&&typeof env['ROUTER_API_KEY_'+seat.toUpperCase()]==='string'&&env['ROUTER_API_KEY_'+seat.toUpperCase()].length>0;
async function readRecord(env,owner,id){
 return env.COUNCIL_DB.prepare('SELECT id, owner_email, claim, evidence_json, claim_sha256, created_at FROM council_records WHERE id = ? AND owner_email = ?').bind(id,owner).first();
}
async function readWorkflow(env,owner,id){
 return env.COUNCIL_DB.prepare('SELECT id, owner_email, record_id, seat, created_at FROM council_workflow_links WHERE id = ? AND owner_email = ?').bind(id,owner).first();
}
function workflowPath(id,suffix=''){return 'https://council.internal/v1/council/workflows/'+encodeURIComponent(id)+suffix}
async function sendToRouter(env,request,seat,path,body,extraHeaders={}){
 if(!routerReady(env,seat))return null;
 const headers={'content-type':'application/json',authorization:'Bearer '+env['ROUTER_API_KEY_'+seat.toUpperCase()],'x-council-seat':seat,...extraHeaders};
 try{
  return await env.COUNCIL_ROUTER.fetch(new Request(path,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})}));
 }catch{return null}
}
async function audit(env,owner,action,ref,data={}){
 try{await env.COUNCIL_DB.prepare('INSERT INTO council_events (id, owner_email, action, subject_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
 .bind(crypto.randomUUID(),owner,action,ref,JSON.stringify(data),new Date().toISOString()).run();return true}catch{return false}
}
export function createFounderApi({authenticate=verifyFounderAccess}={}){
 return async function handle(request,env={}){
  const url=new URL(request.url),path=url.pathname;
  if(request.method!=='GET'){
   const origin=request.headers.get('origin');
   const site=request.headers.get('sec-fetch-site');
   if((origin&&origin!==url.origin)||(site&&!['same-origin','none'].includes(site)))return fail(403,'cross_origin_denied');
   if(request.method==='POST'&&!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))return fail(415,'json_required');
  }
  if(!path.startsWith('/api/'))return fail(404,'not_found');
  if(request.method==='OPTIONS')return fail(405,'not_allowed'); // Same-origin only. Never enable wildcard CORS.
  let founder;
  try{founder=await authenticate(request,env)}catch{return fail(503,'identity_unavailable')}
  if(!founder.ok)return fail(founder.status===503?503:401,founder.status===503?'identity_not_configured':'unauthorized');
  const owner=founder.email;
  if(path==='/api/session'&&request.method==='GET')return reply({identityVerified:true,email:owner,authority:OWNER,gate:'founder_verified'});
  if(path==='/api/seats'&&request.method==='GET')return reply({seats:SEATS.map(id=>({id,configured:routerReady(env,id)&&Boolean(env['SEAT_MODEL_'+id.toUpperCase()]),runtimeVerified:false,authority:OWNER})),message:'Configured means bindings exist; it does not prove a successful provider exchange.'});
  if(path==='/api/readiness'&&request.method==='GET')return reply({identityVerified:true,dbAvailable:Boolean(dbReady(env)),routerBound:typeof env.COUNCIL_ROUTER?.fetch==='function',executionAuthority:false,ledgerMode:'founder_drafts_not_git_sealed'});
  if(!dbReady(env))return fail(503,'ledger_unavailable');
  if(path==='/api/records'&&request.method==='GET'){
   try{
    const r=await env.COUNCIL_DB.prepare('SELECT id, claim, evidence_json, claim_sha256, created_at FROM council_records WHERE owner_email = ? ORDER BY created_at DESC LIMIT 50').bind(owner).all();
    return reply({records:(r.results||[]).map(x=>({id:x.id,claim:x.claim,evidence:JSON.parse(x.evidence_json||'[]'),claimHash:x.claim_sha256,createdAt:x.created_at,label:'UNKNOWN',sealed:false,authority:OWNER})),source:'durable_draft_not_git_ledger'});
   }catch{return fail(503,'ledger_unavailable')}
  }
  if(path==='/api/records'&&request.method==='POST'){
   const body=await bodyJSON(request),claim=body?.claim,evidence=validateEvidence(body?.evidence);
   if(typeof claim!=='string'||claim.trim().length<5||claim.length>8000||evidence===null)return fail(400,'invalid_record');
   const id=crypto.randomUUID(),created=new Date().toISOString();
   const sha=await digest(JSON.stringify({claim:claim.trim(),evidence}));
   try {await env.COUNCIL_DB.prepare('INSERT INTO council_records (id, owner_email, claim, evidence_json, claim_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id,owner,claim.trim(),JSON.stringify(evidence),sha,created).run();}
   catch{return fail(503,'ledger_unavailable')}
   return reply({id,claim:claim.trim(),evidence,claimHash:sha,createdAt:created,label:'UNKNOWN',sealed:false,source:'durable_draft_not_git_ledger',authority:OWNER},201);
  }
  if(path==='/api/workflows'&&request.method==='GET'){
   try {const r=await env.COUNCIL_DB.prepare('SELECT id, record_id, seat, created_at FROM council_workflow_links WHERE owner_email = ? ORDER BY created_at DESC LIMIT 50').bind(owner).all();return reply({workflows:(r.results||[]).map(x=>({...x,approved:false,authority:OWNER}))});}catch{return fail(503,'ledger_unavailable')}
  }
  if(path==='/api/workflows'&&request.method==='POST'){
   const b=await bodyJSON(request,1000),seat=b?.seat,recordId=b?.recordId;
   if(!safeSeat(seat)||typeof recordId!=='string'||!RECORD.test(recordId))return fail(400,'invalid_workflow_request');
   let record;
   try{record=await readRecord(env,owner,recordId)}catch{return fail(503,'ledger_unavailable')}
   if(!record)return fail(404,'record_not_found');
   if(!routerReady(env,seat))return fail(503,'seat_not_ready');
   // A record/seat pair may only queue once. Replays return the same safe reference.
   try {const previous=await env.COUNCIL_DB.prepare('SELECT id, owner_email, record_id, seat, created_at FROM council_workflow_links WHERE record_id = ? AND seat = ? AND owner_email = ?').bind(recordId,seat,owner).first();
    if(previous)return reply({id:previous.id,recordId,seat,state:'queued_for_approval',approved:false,authority:OWNER},200);
   }catch{return fail(503,'ledger_unavailable')}
   const idempotency=recordId+':'+seat;
   const response=await sendToRouter(env,request,seat,'https://council.internal/v1/council/workflows',{messages:[{role:'user',content:record.claim}]},{'idempotency-key':idempotency});
   if(!response)return fail(503,'router_unavailable');
   let result;try{result=await response.json()}catch{return fail(502,'router_error')}
   if(response.status!==202||!WORKFLOW.test(result?.id||'')||!result.id.startsWith('council-'+seat+'-')||result?.approved!==false)return fail(502,'router_error');
   try{await env.COUNCIL_DB.prepare('INSERT INTO council_workflow_links (id, owner_email, record_id, seat, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(result.id,owner,recordId,seat,new Date().toISOString()).run();}
   catch{return fail(503,'workflow_receipt_unavailable')}
   if(!await audit(env,owner,'workflow_submitted',result.id,{recordId,seat}))return fail(503,'audit_unavailable');
   return reply({id:result.id,recordId,seat,state:'queued_for_approval',approved:false,authority:OWNER},202);
  }
  const found=path.match(/^\/api\/workflows\/(council-(?:chatgpt|claude|deepseek|muse|perplexity)-[0-9a-f]{32})(\/approve)?$/);
  if(found){
   const id=found[1],approve=found[2]==='/approve';
   if(request.method!==(approve?'POST':'GET'))return fail(405,'not_allowed');
   let link;
   try{link=await readWorkflow(env,owner,id)}catch{return fail(503,'ledger_unavailable')}
   if(!link)return fail(404,'workflow_not_found');
   const seat=link.seat;
   if(!routerReady(env,seat))return fail(503,'seat_not_ready');
   if(approve){
    const b=await bodyJSON(request,200);
    if(b?.decision!=='approve')return fail(400,'explicit_approval_required');
    const jwt=request.headers.get('Cf-Access-Jwt-Assertion');
    if(!jwt)return fail(503,'signed_founder_assertion_required');
    if(!await audit(env,owner,'founder_approval_intent',id,{seat}))return fail(503,'audit_unavailable');
    const r=await sendToRouter(env,request,seat,workflowPath(id,'/approve'),{decision:'approve'},{'Cf-Access-Jwt-Assertion':jwt});
    if(!r)return fail(503,'router_unavailable');
    if(r.status!==202)return fail(r.status===401||r.status===403?403:503,'approval_not_accepted');
    if(!await audit(env,owner,'founder_approval_sent',id,{seat}))return fail(503,'audit_unavailable');
    return reply({id,state:'approval_delivered',approvedBy:'verified_founder',executed:false},202);
   }
   const r=await sendToRouter(env,request,seat,workflowPath(id),null);
   if(!r)return fail(503,'router_unavailable');
   if(!r.ok)return fail(503,'workflow_unavailable');
   try{const result=await r.json();return reply({id,seat,recordId:link.record_id,status:result.status||result.state||'unknown',output:result.output||null,authority:OWNER});}catch{return fail(502,'workflow_error')}
  }
  return fail(404,'not_found');
 }
}
