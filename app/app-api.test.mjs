import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFounderApi} from './app-api.mjs';
const owner='founder@example.test';
const OK=async()=>({ok:true,email:owner,sub:'founder-1',status:200});
const NOT_OK=async()=>({ok:false,status:401,reason:'invalid_access_token'});
const makeReq=(path,method='GET',body=null,headers={})=>new Request('https://app.test'+path,{method,headers:{'Cf-Access-Jwt-Assertion':'synthetic-signed-founder',...(body?{'content-type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
function db(){
 const records=new Map(),workflows=new Map(),events=[];
 return {records,workflows,events,failAuditBatch:false,
 async batch(statements){
  if(!Array.isArray(statements)||statements.length!==2)throw Error('invalid batch');
  const [entity,receipt]=statements;
  const isDraft=entity._sql?.includes('INSERT INTO council_records');
  const isWorkflow=entity._sql?.includes('INSERT INTO council_workflow_links');
  if((!isDraft&&!isWorkflow)||!receipt._sql?.includes('INSERT INTO council_events'))throw Error('unexpected batch');
  const id=entity._args?.[0];await entity.run();
  try{if(this.failAuditBatch)throw Error('audit storage failed');await receipt.run();}
  catch(error){if(isDraft)records.delete(id);else workflows.delete(id);throw error}
  return [{success:true},{success:true}];
 },
 prepare(sql){let args=[];return {bind(...values){args=values;this._sql=sql;this._args=values;return this},async first(){
  if(sql.includes('FROM council_records WHERE id = ?'))return records.get(args[0])?.owner_email===args[1]?records.get(args[0]):null;
  if(sql.includes('FROM council_workflow_links WHERE id = ?'))return workflows.get(args[0])?.owner_email===args[1]?workflows.get(args[0]):null;
  if(sql.includes('FROM council_workflow_links WHERE record_id = ?'))return [...workflows.values()].find(w=>w.record_id===args[0]&&w.seat===args[1]&&w.owner_email===args[2])||null;
  return null;
 },async all(){if(sql.includes('FROM council_records'))return{results:[...records.values()].filter(x=>x.owner_email===args[0])};if(sql.includes('FROM council_workflow_links'))return{results:[...workflows.values()].filter(x=>x.owner_email===args[0])};return{results:[]}},async run(){
  if(sql.includes('INSERT INTO council_records')){const [id,who,claim,evidence_json,claim_sha256,created_at]=args;records.set(id,{id,owner_email:who,claim,evidence_json,claim_sha256,created_at});return{success:true}}
  if(sql.includes('INSERT INTO council_workflow_links')){const [id,who,record_id,seat,created_at]=args;workflows.set(id,{id,owner_email:who,record_id,seat,created_at});return{success:true}}
  if(sql.includes('INSERT INTO council_events')){events.push(args);return{success:true}}
  throw Error('unknown SQL: '+sql.slice(0,100));
 }}}};
}
const env=()=>({COUNCIL_DB:db(),COUNCIL_RATE_LIMITER:{limit:async()=>({success:true})},SEAT_MODEL_CHATGPT:'configured-model',ROUTER_API_KEY_CHATGPT:'server-only-token',COUNCIL_ROUTER:{fetch:async req=>{
 const path=new URL(req.url).pathname;
 if(path==='/v1/council/readiness')return Response.json({seats:[{id:'chatgpt',configured:true,runtimeVerified:false}]});
 if(path==='/v1/council/workflows')return Response.json({id:'council-chatgpt-abcdef0123456789abcdef0123456789',state:'queued_for_approval',approved:false},{status:202});
 if(path.endsWith('/approve'))return Response.json({state:'approval_delivered'},{status:202});
 return Response.json({status:'waiting',output:null});
 }}});
test('unauthenticated routes fail closed before DB or backend calls',async()=>{
 const e=env(),app=createFounderApi({authenticate:NOT_OK});
 for(const [p,m] of [['/api/session','GET'],['/api/records','GET'],['/api/records','POST'],['/api/seats','GET'],['/api/workflows','POST']])assert.equal((await app(makeReq(p,m,m==='POST'?{claim:'hello council',seat:'chatgpt'}:null),e)).status,401);
 assert.equal(e.COUNCIL_DB.records.size,0);
});
test('session and five seats show config readiness, never secret values or live claims',async()=>{
 const e=env(),app=createFounderApi({authenticate:OK});
 const session=await (await app(makeReq('/api/session'),e)).json();
 assert.equal(session.identityVerified,true);assert.equal(session.email,owner);
 const seats=await (await app(makeReq('/api/seats'),e)).json();
 assert.equal(seats.seats.length,5);
 assert.equal(seats.seats.find(x=>x.id==='chatgpt').configured,true);
 assert.equal(seats.seats.find(x=>x.id==='claude').configured,false);
 assert.ok(!JSON.stringify(seats).includes('server-only-token'));
 assert.equal(seats.seats.find(x=>x.id==='chatgpt').runtimeVerified,false);
});
test('record creation persists owner-scoped UNKNOWN/unsealed claim and evidence; never grants approval',async()=>{
 const e=env(),app=createFounderApi({authenticate:OK});
 const r=await app(makeReq('/api/records','POST',{claim:'Source claim from owner',evidence:[{url:'https://example.org/report',note:'reference'}]}),e);
 assert.equal(r.status,201);const item=await r.json();
 assert.equal(item.label,'UNKNOWN');assert.equal(item.sealed,false);assert.equal(item.authority.grantsExecutionAuthority,false);
 assert.equal(e.COUNCIL_DB.records.size,1);
 assert.equal(e.COUNCIL_DB.events.length,1);
 assert.equal(e.COUNCIL_DB.events[0][2],'draft_recorded');
 assert.equal((await app(makeReq('/api/records','GET'),e)).status,200);
});
test('rejects dangerous evidence, oversize payloads and absent D1',async()=>{
 const e=env(),app=createFounderApi({authenticate:OK});
 for(const claim of ['x','x'.repeat(12000)])assert.equal((await app(makeReq('/api/records','POST',{claim}),e)).status,400);
 assert.equal((await app(makeReq('/api/records','POST',{claim:'Valid claim',evidence:[{url:'javascript:alert(1)',note:'bad'}]}),e)).status,400);
 delete e.COUNCIL_DB;
 assert.equal((await app(makeReq('/api/records','POST',{claim:'Valid claim'}),e)).status,503);
});
test('workflow queue is linked to an owner record but cannot auto-approve; approval requires separate founder verifier in router',async()=>{
 const e=env(),seen=[],app=createFounderApi({authenticate:OK});
 e.COUNCIL_ROUTER.fetch=async req=>{seen.push(req);return Response.json({id:'council-chatgpt-abcdef0123456789abcdef0123456789',state:new URL(req.url).pathname.endsWith('approve')?'approval_delivered':'queued_for_approval',approved:false},{status:202})};
 const record=await (await app(makeReq('/api/records','POST',{claim:'Review this evidence please'}),e)).json();
 assert.equal((await app(makeReq('/api/workflows','POST',{recordId:'00000000-0000-4000-8000-000000000001',seat:'chatgpt'}),e)).status,404);
 const res=await app(makeReq('/api/workflows','POST',{recordId:record.id,seat:'chatgpt'},{'idempotency-key':'client-origin-unique'}),e);
 assert.equal(res.status,202);const job=await res.json();
 assert.equal(job.approved,false);assert.equal(seen.length,1);
 assert.equal(seen[0].headers.get('authorization'),null);
 assert.equal(seen[0].headers.get('Cf-Access-Jwt-Assertion'),'synthetic-signed-founder');
 assert.equal((await app(new Request('https://app.test/api/workflows/'+job.id+'/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'approve'})}),e)).status,503); // fails without signed JWT
});
test('cross-site POST and absent JSON type cannot reach database',async()=>{
 const e=env(),app=createFounderApi({authenticate:OK});
 assert.equal((await app(makeReq('/api/records','POST',{claim:'Some valid evidence'},{origin:'https://evil.test'}),e)).status,403);
 assert.equal((await app(new Request('https://app.test/api/records',{method:'POST',body:'{\"claim\":\"Valid\"}'}),e)).status,415);
 assert.equal(e.COUNCIL_DB.records.size,0);
});
test('duplicate workflow submission does not send a second provider job',async()=>{
 const e=env(),app=createFounderApi({authenticate:OK});let submissions=0;const prior=e.COUNCIL_ROUTER.fetch;e.COUNCIL_ROUTER.fetch=async req=>{submissions++;return prior(req)};
 const record=await (await app(makeReq('/api/records','POST',{claim:'Idempotent workflow key'}),e)).json();
 const a=await (await app(makeReq('/api/workflows','POST',{recordId:record.id,seat:'chatgpt'}),e)).json();
 const b=await (await app(makeReq('/api/workflows','POST',{recordId:record.id,seat:'chatgpt'}),e)).json();
 assert.equal(a.id,b.id);assert.equal(submissions,1);
});
test('when a verified Access assertion exists, founder can explicitly approve via protected router',async()=>{
 const e=env(),app=createFounderApi({authenticate:OK});
 const record=await (await app(makeReq('/api/records','POST',{claim:'Only verified owner decides'}),e)).json();
 const submitted=await (await app(makeReq('/api/workflows','POST',{recordId:record.id,seat:'chatgpt'}),e)).json();
 const res=await app(makeReq('/api/workflows/'+submitted.id+'/approve','POST',{decision:'approve'},{'Cf-Access-Jwt-Assertion':'a.signed.cloudflare.jwt'}),e);
 assert.equal(res.status,202);
 assert.equal((await res.json()).state,'approval_delivered');
});

test('signed founder assertion reaches the internal router without cloning per-seat secrets onto Pages',async()=>{
 const e=env(),calls=[];
 delete e.ROUTER_API_KEY_CHATGPT;
 e.COUNCIL_ROUTER.fetch=async req=>{calls.push(req);return Response.json({id:'council-chatgpt-abcdef0123456789abcdef0123456789',state:'queued_for_approval',approved:false},{status:202})};
 const app=createFounderApi({authenticate:OK});
 const record=await (await app(makeReq('/api/records','POST',{claim:'Founder-only seat request'}),e)).json();
 const submitted=await app(makeReq('/api/workflows','POST',{recordId:record.id,seat:'chatgpt'},{'Cf-Access-Jwt-Assertion':'synthetic-signed-founder'}),e);
 assert.equal(submitted.status,202);
 assert.equal(calls.length,1);
 assert.equal(calls[0].headers.get('Cf-Access-Jwt-Assertion'),'synthetic-signed-founder');
 assert.equal(calls[0].headers.get('authorization'),null);
});

test('five-seat readiness is read from protected Worker rather than guessed from Pages secrets',async()=>{
 const e=env();delete e.ROUTER_API_KEY_CHATGPT;
 const app=createFounderApi({authenticate:OK});
 e.COUNCIL_ROUTER.fetch=async req=>{
  assert.equal(new URL(req.url).pathname,'/v1/council/readiness');
  assert.equal(req.headers.get('Cf-Access-Jwt-Assertion'),'synthetic-founder');
  return Response.json({seats:[{id:'chatgpt',configured:true,runtimeVerified:false},{id:'claude',configured:false,runtimeVerified:false},{id:'deepseek',configured:false,runtimeVerified:false},{id:'muse',configured:false,runtimeVerified:false},{id:'perplexity',configured:false,runtimeVerified:false}]});
 };
 const res=await app(makeReq('/api/seats','GET',null,{'Cf-Access-Jwt-Assertion':'synthetic-founder'}),e);
 assert.equal(res.status,200);
 const body=await res.json();
 assert.equal(body.seats.length,5);
 assert.equal(body.seats.find(x=>x.id==='chatgpt').configured,true);
 assert.equal(body.seats.find(x=>x.id==='claude').configured,false);
});

test('draft creation rolls back when its audit event cannot be committed',async()=>{
 const e=env(),app=createFounderApi({authenticate:OK});
 e.COUNCIL_DB.failAuditBatch=true;
 const res=await app(makeReq('/api/records','POST',{claim:'A recorded claim must have an audit receipt'}),e);
 assert.equal(res.status,503);
 assert.equal(e.COUNCIL_DB.records.size,0);
 assert.equal(e.COUNCIL_DB.events.length,0);
});

test('workflow submission records intent before dispatch and links a receipt atomically',async()=>{
 const e=env(),app=createFounderApi({authenticate:OK}),seen=[];
 e.COUNCIL_ROUTER.fetch=async request=>{
  seen.push({url:request.url,auditActions:e.COUNCIL_DB.events.map(x=>x[2])});
  return Response.json({id:'council-chatgpt-abcdef0123456789abcdef0123456789',state:'queued_for_approval',approved:false},{status:202});
 };
 const record=await (await app(makeReq('/api/records','POST',{claim:'Evidence needs a durable receipt before queueing'}),e)).json();
 const r=await app(makeReq('/api/workflows','POST',{recordId:record.id,seat:'chatgpt'}),e);
 assert.equal(r.status,202);
 assert.equal(seen.length,1);
 assert.deepEqual(seen[0].auditActions,['draft_recorded','workflow_submission_intent']);
 assert.deepEqual(e.COUNCIL_DB.events.map(x=>x[2]),['draft_recorded','workflow_submission_intent','workflow_submitted']);
 assert.equal(e.COUNCIL_DB.workflows.size,1);
});

test('failed durable intent audit cannot dispatch a provider workflow',async()=>{
 const e=env(),app=createFounderApi({authenticate:OK});
 const record=await (await app(makeReq('/api/records','POST',{claim:'Evidence must have an audit before sending'}),e)).json();
 const original=e.COUNCIL_DB.prepare.bind(e.COUNCIL_DB);
 e.COUNCIL_DB.prepare=(sql)=>{
  if(sql.includes('INSERT INTO council_events'))return{bind:()=>({run:async()=>({success:false})})};
  return original(sql);
 };
 let sends=0;
 e.COUNCIL_ROUTER.fetch=async()=>{sends++;return Response.json({id:'council-chatgpt-abcdef0123456789abcdef0123456789',approved:false},{status:202})};
 const res=await app(makeReq('/api/workflows','POST',{recordId:record.id,seat:'chatgpt'}),e);
 assert.equal(res.status,503);
 assert.equal(sends,0);
 assert.equal(e.COUNCIL_DB.workflows.size,0);
});
