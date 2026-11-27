import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSign, generateKeyPairSync} from 'node:crypto';
import {verifyFounderAccess} from './founder-access.mjs';
import {createFounderApi} from './app-api.mjs';
import {createCouncilApplication} from '../seats/router/durable-core.js';

// Synthetic cryptographic identity, not an actual Cloudflare token or private credential.
const issuer='https://council-test.cloudflareaccess.com';
const aud='test-founder-audience-1234567890';
const email='founder@example.invalid';
const now=Math.floor(Date.now()/1000);
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...pair.publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'};
const json64=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
function signedJWT(changes={}){
 const header=json64({alg:'RS256',kid:'test-key',typ:'JWT'});
 const body=json64({iss:issuer,aud:[aud],email,sub:'founder-identity',iat:now-2,exp:now+3600,...changes});
 const sign=createSign('RSA-SHA256');sign.update(header+'.'+body);sign.end();
 return header+'.'+body+'.'+sign.sign(pair.privateKey).toString('base64url');
}
const valid=signedJWT();
const invalidOwner=signedJWT({email:'another@example.invalid'});
const invalidAudience=signedJWT({aud:['someone-else']});
const badParts=valid.split('.');
badParts[2]=(badParts[2][0]==='A'?'B':'A')+badParts[2].slice(1);
const invalidSignature=badParts.join('.');
const certFetch=async url=>{
 assert.equal(url,issuer+'/cdn-cgi/access/certs');
 return Response.json({keys:[jwk]});
};
const verify=(req,env)=>verifyFounderAccess(req,env,{fetchImpl:certFetch,now});
function workerEnv(){
 const queues=[], approvals=[];
 const instance={
  sendEvent:async event=>approvals.push(event),
  status:async()=>({status:'waiting'}),
 };
 return {
  COUNCIL_ACCESS_TEAM_DOMAIN:issuer,COUNCIL_ACCESS_AUD:aud,COUNCIL_FOUNDER_EMAIL:email,
  ROUTER_API_KEY_CHATGPT:'router-only-test-key',OPENAI_API_KEY:'test-provider-placeholder',
  SEAT_MODEL_CHATGPT:'gpt-6',
  COUNCIL_RATE_LIMITER:{limit:async()=>({success:true})},
  COUNCIL_INTAKE:{send:async item=>queues.push(item)},
  COUNCIL_DURABLE:{get:async()=>instance},
  queues,approvals,
 };
}
function request(path,token,{method='GET',seat='chatgpt',body,routerKey}={}){
 const headers={'x-council-seat':seat,...(token?{'Cf-Access-Jwt-Assertion':token}:{}),
  ...(body?{'content-type':'application/json'}:{}),
  ...(routerKey?{authorization:'Bearer '+routerKey}:{})};
 return new Request('https://private.example.invalid'+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})});
}
test('the Pages-to-Worker service binding independently verifies exactly the same signed founder identity',async()=>{
 const env=workerEnv(),worker=createCouncilApplication({authenticateFounder:verify});
 const serviceCalls=[];
 const pages=createFounderApi({authenticate:verify});
 const pagesEnv={...env,COUNCIL_ROUTER:{fetch:async r=>{
  serviceCalls.push(r);
  return worker.fetch(r,env);
 }}};
 const result=await pages(request('/api/seats',valid),pagesEnv);
 assert.equal(result.status,200);
 const seats=(await result.json()).seats;
 assert.equal(seats.length,5);
 assert.equal(seats.find(s=>s.id==='chatgpt').configured,true);
 assert.equal(seats.filter(s=>s.configured).length,1);
 assert.equal(seats.every(s=>s.runtimeVerified===false),true);
 assert.equal(serviceCalls.length,1);
 assert.equal(serviceCalls[0].headers.get('Cf-Access-Jwt-Assertion'),valid);
 assert.equal(serviceCalls[0].headers.get('authorization'),null);
 for(const token of [null,invalidOwner,invalidAudience,invalidSignature]){
  const denied=await pages(request('/api/session',token),pagesEnv);
  assert.equal(denied.status,401);
 }
 const workerUnauthorized=await worker.fetch(request('/v1/council/readiness',invalidAudience),env);
 assert.equal(workerUnauthorized.status,403);
});
test('a seat key alone can neither approve nor bypass the signed founder decision',async()=>{
 const env=workerEnv(),worker=createCouncilApplication({
  authenticateFounder:verify,
  router:{fetch:async()=>{throw Error('direct provider calls forbidden')}}
 });
 const id='council-chatgpt-abcdef0123456789abcdef0123456789';
 const approve='/v1/council/workflows/'+id+'/approve';
 const onlySeat=await worker.fetch(request(approve,null,{method:'POST',routerKey:env.ROUTER_API_KEY_CHATGPT,body:{decision:'approve'}}),env);
 assert.equal(onlySeat.status,403);
 const forged=await worker.fetch(request(approve,invalidOwner,{method:'POST',body:{decision:'approve'}}),env);
 assert.equal(forged.status,403);
 assert.equal(env.approvals.length,0);
 const submitted=await worker.fetch(request('/v1/council/workflows',valid,{
  method:'POST',body:{messages:[{role:'user',content:'Synthetic test claim'}]}
 }),{
  ...env,
 });
 // An idempotency key is required even for a valid founder.
 assert.equal(submitted.status,400);
 const post=new Request('https://private.example.invalid/v1/council/workflows',{
  method:'POST',headers:{'x-council-seat':'chatgpt','Cf-Access-Jwt-Assertion':valid,
   'idempotency-key':'founder-integrated-001','content-type':'application/json'},
  body:JSON.stringify({messages:[{role:'user',content:'Synthetic test claim'}]})
 });
 const queued=await worker.fetch(post,env);
 assert.equal(queued.status,202);
 assert.equal(env.queues.length,1);
 assert.equal(env.approvals.length,0);
 const approved=await worker.fetch(request(approve,valid,{method:'POST',body:{decision:'approve'}}),env);
 assert.equal(approved.status,202);
 assert.deepEqual(env.approvals,[{type:'founder-approved',payload:{decision:'approve',seat:'chatgpt',instanceId:id}}]);
 const legacy=await worker.fetch(request('/v1/chat/completions',valid,{method:'POST',body:{messages:[{role:'user',content:'bypass?'}]}}),env);
 assert.equal(legacy.status,409);
});
