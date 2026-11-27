/** Cloudflare Access identity is an independently signed JWT, never a client-supplied email. */
const fail=(status, reason)=>({ok:false,status,reason});
const enc=new TextEncoder();
const TEAM=/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const AUD=/^[A-Za-z0-9_-]{12,128}$/;
const EMAIL=/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
function b64url(input){
 if(!/^[A-Za-z0-9_-]+$/.test(input)||input.length>16000)throw Error('invalid base64url');
 const normalized=input.replace(/-/g,'+').replace(/_/g,'/');
 const binary=atob(normalized+'='.repeat((4-normalized.length%4)%4));
 return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
function decodedJSON(segment){return JSON.parse(new TextDecoder().decode(b64url(segment)));}
export async function verifyFounderAccess(request,env={}, {fetchImpl=globalThis.fetch,now=Math.floor(Date.now()/1000)}={}){
 const issuer=String(env.COUNCIL_ACCESS_TEAM_DOMAIN||'').trim();
 const audience=String(env.COUNCIL_ACCESS_AUD||'').trim();
 const owner=String(env.COUNCIL_FOUNDER_EMAIL||'').trim().toLowerCase();
 if(!TEAM.test(issuer)||!AUD.test(audience)||!EMAIL.test(owner))return fail(503,'identity_not_configured');
 const token=request.headers.get('Cf-Access-Jwt-Assertion')||'';
 if(!token||token.length>16000)return fail(401,'access_token_required');
 let header,payload,data,signature;
 try{
  const parts=token.split('.');if(parts.length!==3)throw Error('format');
  [header,payload,signature]=[decodedJSON(parts[0]),decodedJSON(parts[1]),b64url(parts[2])];
  data=parts[0]+'.'+parts[1];
  if(header?.alg!=='RS256'||!header.kid||typeof header.kid!=='string'||header.kid.length>128)throw Error('algorithm');
  if(payload?.iss!==issuer||!Array.isArray(payload.aud)||!payload.aud.includes(audience))throw Error('audience');
  if(payload?.email?.toLowerCase()!==owner||typeof payload.sub!=='string'||!payload.sub||payload.sub.length>512)throw Error('founder');
  if(!Number.isSafeInteger(payload.exp)||payload.exp<=now||payload.exp>now+86400*3)throw Error('expired');
  if(payload.iat!==undefined&&(!Number.isSafeInteger(payload.iat)||payload.iat>now+60))throw Error('issued_at');
  if(payload.nbf!==undefined&&(!Number.isSafeInteger(payload.nbf)||payload.nbf>now+60))throw Error('not_before');
 }catch{return fail(401,'invalid_access_token');}
 let keys;
 try{
  const resp=await fetchImpl(issuer+'/cdn-cgi/access/certs',{redirect:'error',signal:AbortSignal.timeout(5000),headers:{accept:'application/json'}});
  if(!resp.ok||resp.redirected||Number(resp.headers.get('content-length')||0)>65536)return fail(503,'identity_keys_unavailable');
  const text=await resp.text();if(text.length>65536)return fail(503,'identity_keys_unavailable');
  keys=JSON.parse(text)?.keys;
  if(!Array.isArray(keys)||keys.length>32)return fail(503,'identity_keys_unavailable');
 }catch{return fail(503,'identity_keys_unavailable');}
 for(const key of keys){
  if(key?.kid!==header.kid||key.kty!=='RSA'||(key.alg&&key.alg!=='RS256')||(key.use&&key.use!=='sig'))continue;
  try{
   const publicKey=await crypto.subtle.importKey('jwk',key,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
   if(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',publicKey,signature,enc.encode(data))){
    return {ok:true,email:owner,sub:payload.sub,status:200};
   }
  }catch{ /* invalid/unknown key never authenticates */ }
 }
 return fail(401,'invalid_access_signature');
}
