import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createSign} from 'node:crypto';
import {verifyFounderAccess} from './founder-access.mjs';

const team='https://example.cloudflareaccess.com', aud='1234567890abcdef-verified-app';
const founder='founder@example.test';
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const pub=pair.publicKey.export({format:'jwk'});
function jwt(changes={},header={}){
 const now=Math.floor(Date.now()/1000);
 const payload={iss:team,aud:[aud],email:founder,sub:'founder-subject',exp:now+3600,iat:now-10,...changes};
 const encode=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
 const data=encode({typ:'JWT',alg:'RS256',kid:'trusted-key',...header})+'.'+encode(payload);
 const sig=createSign('RSA-SHA256').update(data).end().sign(pair.privateKey).toString('base64url');
 return data+'.'+sig;
}
const env={COUNCIL_ACCESS_TEAM_DOMAIN:team,COUNCIL_ACCESS_AUD:aud,COUNCIL_FOUNDER_EMAIL:founder};
const fetchImpl=async url=>new Response(JSON.stringify({keys:[{...pub,kid:'trusted-key',alg:'RS256',use:'sig'}]}),{status:200});
const req=(token)=>new Request('https://api.test/api/session',{headers:token?{'Cf-Access-Jwt-Assertion':token}:{}});
test('signed Cloudflare Access founder session verified with RS256 and exact issuer/audience',async()=>{
 const r=await verifyFounderAccess(req(jwt()),env,{fetchImpl});
 assert.equal(r.ok,true);assert.equal(r.email,founder);assert.equal(r.sub,'founder-subject');
});
test('fails closed without founder config, token or JWKS',async()=>{
 assert.equal((await verifyFounderAccess(req(jwt()),{}, {fetchImpl})).status,503);
 assert.equal((await verifyFounderAccess(req(null),env,{fetchImpl})).status,401);
 assert.equal((await verifyFounderAccess(req(jwt()),env,{fetchImpl:async()=>{throw new Error('offline')}})).status,503);
});
test('rejects forged or expired JWT and different claimed founder',async()=>{
 for(const t of [jwt({email:'stranger@example.test'}),jwt({exp:1}),jwt({aud:['wrong-aud']}),jwt({iss:'https://other.cloudflareaccess.com'}),jwt({}, {alg:'HS256'}),jwt().slice(0,-2)+'xx']){
  const r=await verifyFounderAccess(req(t),env,{fetchImpl}); assert.equal(r.ok,false);
 }
});
test('rejects malicious team domain without fetching any URL',async()=>{
 let sent=0;const r=await verifyFounderAccess(req(jwt()),{...env,COUNCIL_ACCESS_TEAM_DOMAIN:'https://example.cloudflareaccess.com.evil.test'}, {fetchImpl:async()=>{sent++;return new Response('')}});
 assert.equal(r.ok,false);assert.equal(sent,0);
});
