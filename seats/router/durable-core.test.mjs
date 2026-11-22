import { test } from "node:test";
import assert from "node:assert/strict";
import { createCouncilApplication, runCouncilWorkflow } from "./durable-core.js";

const key = "route-token";
function env() {
  const queued = [];
  const workflowEvents = [];
  const created = [];
  const instance = {
    id: "council-chatgpt-abcdef0123456789abcdef0123456789",
    sendEvent: async value => workflowEvents.push(value),
    status: async () => ({status: "waiting"}),
  };
  return {
    OPENAI_API_KEY: "provider-secret",
    ROUTER_API_KEY_CHATGPT: key,
    SEAT_MODEL_CHATGPT: "gpt-6",
    COUNCIL_RATE_LIMITER: {limit: async () => ({success: true})},
    COUNCIL_INTAKE: {send: async value => queued.push(value)},
    COUNCIL_DURABLE: {
      create: async ({id, params}) => {created.push({id, params});return {id};},
      get: async () => instance,
    },
    queued, created, workflowEvents,
  };
}
function req(path, {seat="chatgpt", token=key, body={messages:[{role:"user",content:"Only a test"}]}, idempotency="unique-request-100"}={}) {
  return new Request("https://council.test" + path, {
    method: "POST",
    headers: {"content-type":"application/json","x-council-seat":seat,authorization:"Bearer "+token,"idempotency-key":idempotency},
    body:JSON.stringify(body),
  });
}
const api = () => createCouncilApplication({router:{fetch: async()=>{throw Error("DIRECT PROVIDER BYPASS")}}});

test("production entrypoint rejects direct model execution; durable intake is authentication gated",async()=>{
  const e=env(), app=api();
  assert.equal((await app.fetch(req("/v1/chat/completions"),e)).status,409);
  assert.equal((await app.fetch(req("/v1/council/workflows",{token:"wrong"}),e)).status,401);
  assert.equal((await app.fetch(req("/v1/council/workflows",{seat:"__proto__"}),e)).status,400);
  assert.equal((await app.fetch(req("/v1/council/workflows",{body:{messages:[]}}),e)).status,400);
  assert.equal(e.queued.length,0);
});

test("authorized create queues once using deterministic ID, without granting approval",async()=>{
  const e=env(),app=api();
  const first=await app.fetch(req("/v1/council/workflows"),e);
  const second=await app.fetch(req("/v1/council/workflows"),e);
  assert.equal(first.status,202);
  assert.equal(second.status,202);
  const a=await first.json(),b=await second.json();
  assert.equal(a.id,b.id);
  assert.match(a.id,/^council-chatgpt-[a-f0-9]{32}$/);
  assert.equal(e.queued.length,2);
  assert.deepEqual(Object.keys(e.queued[0]).sort(),["id","kind","messages","seat"]);
  assert.equal(e.queued[0].kind,"execute");
  assert.equal(e.queued[0].seat,"chatgpt");
  assert.equal(e.workflowEvents.length,0);
});

test("no queue binding or malformed idempotency key fails closed",async()=>{
  const e=env(), app=api();
  delete e.COUNCIL_INTAKE;
  assert.equal((await app.fetch(req("/v1/council/workflows"),e)).status,503);
  e.COUNCIL_INTAKE={send: async()=>{throw Error("queue offline")}};
  assert.equal((await app.fetch(req("/v1/council/workflows"),e)).status,503);
  assert.equal((await app.fetch(req("/v1/council/workflows",{idempotency:"x"}),e)).status,400);
});

test("approvals require matching seat token and identity, and may not cross seats",async()=>{
 const e=env(),app=api(), id="council-chatgpt-abcdef0123456789abcdef0123456789";
 assert.equal((await app.fetch(req("/v1/council/workflows/"+id+"/approve",{token:"wrong"}),e)).status,401);
 assert.equal((await app.fetch(req("/v1/council/workflows/council-claude-abcdef0123456789abcdef0123456789/approve"),e)).status,403);
 assert.equal(e.workflowEvents.length,0);
 const good=await app.fetch(req("/v1/council/workflows/"+id+"/approve",{body:{decision:"approve"}}),e);
 assert.equal(good.status,202);
 assert.deepEqual(e.workflowEvents,[{type:"founder-approved",payload:{decision:"approve",seat:"chatgpt",instanceId:id}}]);
});

test("queue creates Workflow once and acknowledges; duplicate IDs are idempotent",async()=>{
 const e=env(),app=api();
 const message={kind:"execute",seat:"chatgpt",id:"council-chatgpt-abcdef0123456789abcdef0123456789",messages:[{role:"user",content:"ping"}]};
 let ack=0,retry=0;
 const msg={body:message,ack:()=>{ack++},retry:()=>{retry++}};
 await app.queue({messages:[msg]},e);
 assert.equal(ack,1);assert.equal(retry,0);assert.equal(e.created.length,1);
 e.COUNCIL_DURABLE.create=async()=>{throw Error("(instance.already_exists)")};
 await app.queue({messages:[msg]},e);
 assert.equal(ack,2);assert.equal(retry,0);
 e.COUNCIL_DURABLE.create=async()=>{throw Error("temporary failure")};
 await app.queue({messages:[msg]},e);
 assert.equal(retry,1);
});

test("workflow waits for explicit approval; denial and timeout never execute provider",async()=>{
 const e=env(),calls=[];
 const step={
   do:async(name,opts,fn)=>{if(typeof opts==="function")fn=opts;calls.push(name);return fn();},
   waitForEvent:async()=>({payload:{decision:"deny",seat:"chatgpt",instanceId:"x"}}),
 };
 const params={seat:"chatgpt",messages:[{role:"user",content:"ping"}]};
 const no=await runCouncilWorkflow({payload:params,instanceId:"x"},step,e,{router:{fetch:async()=>{throw Error("called provider without approval")}}});
 assert.equal(no.state,"rejected");
 assert.deepEqual(calls,["validate"]);
 step.waitForEvent=async()=>{throw Error("timeout")};
 const timed=await runCouncilWorkflow({payload:params,instanceId:"x"},step,e,{router:{fetch:async()=>{throw Error("called provider after timeout")}}});
 assert.equal(timed.state,"expired");
});

test("approved workflow performs one provider attempt and persists redacted receipt",async()=>{
 const e=env(),calls=[];
 const step={
   do:async(name,opts,fn)=>{if(typeof opts==="function")fn=opts;calls.push({name,config:typeof opts==="function"?null:opts});return fn();},
   waitForEvent:async()=>({payload:{decision:"approve",seat:"chatgpt",instanceId:"instance-a"}}),
 };
 let providers=0;
 const router={fetch:async()=>{providers++;return Response.json({id:"resp-1",seat:"chatgpt",choices:[{message:{content:"answer"}}],provider:{name:"openai",raw:"INTERNAL RAW RESPONSE"}})}};
 const record=await runCouncilWorkflow({instanceId:"instance-a",payload:{seat:"chatgpt",messages:[{role:"user",content:"ping"}]}},step,e,{router});
 assert.equal(record.state,"completed");
 assert.equal(record.seat,"chatgpt");
 assert.equal(record.content,"answer");
 assert.equal(record.provider,"openai");
 assert.equal(providers,1);
 assert.ok(!JSON.stringify(record).includes("INTERNAL RAW"));
 assert.equal(calls.find(x=>x.name==="provider execution")?.config?.retries?.limit,0);
 assert.equal(calls.find(x=>x.name==="provider execution")?.config?.retries?.delay,"1 second");
});

test("cron is a non-executing configuration heartbeat",async()=>{
 const e=env(),app=api(),logs=[];
 await app.scheduled({cron:"0 12 * * *",scheduledTime:Date.UTC(2026,10,22,12)},e,{waitUntil:async p=>p}, (...args)=>logs.push(args));
 assert.equal(e.queued.length,0);
 assert.equal(e.created.length,0);
 assert.ok(logs.length>=1);
 assert.ok(!JSON.stringify(logs).includes("provider-secret"));
});


test("provider HTTP rejection persists only a bounded upstream status category", async () => {
 const e=env(),step={
   do:async(name,opts,fn)=>typeof opts==="function"?opts():fn(),
   waitForEvent:async()=>({payload:{decision:"approve",seat:"chatgpt",instanceId:"provider-failure-test"}}),
 };
 const testCases=[
  [{error:{message:"openai returned HTTP 401",raw:"sk-example-NEVER-STORE"}}, "upstream_http_401"],
  [{error:{message:"openai returned HTTP 429",provider_key:"sk-example-NEVER-STORE"}}, "upstream_http_429"],
  [{error:{message:"openai request failed",details:"supersecret"}}, "transport_failure"],
  [{error:{message:"openai returned an invalid response",body:"DO NOT STORE"}}, "invalid_response"],
  [{error:{message:"unexpected: private stuff"}}, "unclassified"],
 ];
 for(const [payload,reason] of testCases){
  const router={fetch:async()=>Response.json(payload,{status:502})};
  const record=await runCouncilWorkflow({instanceId:"provider-failure-test",payload:{seat:"chatgpt",messages:[{role:"user",content:"ping"}]}},step,e,{router});
  assert.equal(record.state,"blocked");
  assert.equal(record.status,502);
  assert.equal(record.reason,reason);
  assert.ok(!JSON.stringify(record).includes("supersecret"));
  assert.ok(!JSON.stringify(record).includes("private stuff"));
  assert.ok(!JSON.stringify(record).includes("sk-example"));
 }
});

test("invalid provider failure JSON never leaks raw body to Workflow result",async()=>{
 const e=env(),step={
   do:async(name,opts,fn)=>typeof opts==="function"?opts():fn(),
   waitForEvent:async()=>({payload:{decision:"approve",seat:"chatgpt",instanceId:"bad-error-test"}}),
 };
 const router={fetch:async()=>new Response("provider may leak sk-example-NEVER-STORE",{status:502})};
 const record=await runCouncilWorkflow({instanceId:"bad-error-test",payload:{seat:"chatgpt",messages:[{role:"user",content:"ping"}]}},step,e,{router});
 assert.deepEqual(record,{state:"blocked",seat:"chatgpt",status:502,reason:"unclassified"});
});


test("approved Workflow uses step timeout, not request-scoped AbortSignal timeout", async () => {
 const originalFetch=globalThis.fetch;
 const e=env();
 const seen=[],calls=[];
 globalThis.fetch=async (url,init)=>{
   seen.push({url,hasSignal:Object.prototype.hasOwnProperty.call(init,"signal")});
   return Response.json({id:"resp-ready",status:"completed",output:[{type:"message",content:[{type:"output_text",text:"READY"}]}]});
 };
 const step={
   do:async(name,opts,fn)=>{
     if(typeof opts==="function"){fn=opts;opts=null;}
     calls.push({name,options:opts});
     return fn();
   },
   waitForEvent:async()=>({payload:{decision:"approve",seat:"chatgpt",instanceId:"workflow-fetch-timeout-test"}})
 };
 try {
   const result=await runCouncilWorkflow({instanceId:"workflow-fetch-timeout-test",payload:{seat:"chatgpt",messages:[{role:"user",content:"READY?"}]}},step,e);
   assert.equal(result.state,"completed");
   assert.equal(result.content,"READY");
   assert.deepEqual(seen,[{url:"https://api.openai.com/v1/responses",hasSignal:false}]);
   const execution=calls.find(x=>x.name==="provider execution");
   assert.equal(execution?.options?.timeout,"75 seconds");
   assert.equal(execution?.options?.retries?.limit,0);
 }finally {
   globalThis.fetch=originalFetch;
 }
});


test("durable Workflow receipts persist only allowlisted fetch diagnostics",async()=>{
 const envMock=env();
 const step={
  do:async(name,options,fn)=>typeof options==="function"?options():fn(),
  waitForEvent:async()=>({payload:{decision:"approve",seat:"chatgpt",instanceId:"sanitize-network"}}),
 };
 for(const [diagnostic,want] of [["request_context","request_context"],["type_error","type_error"],["tls","tls"],["SECRET_PRIVATE","unclassified"],[42,"unclassified"]]){
  const router={fetch:async()=>Response.json({error:{
    message:"openai request failed",
    diagnostic,
    cause:"Bearer SECRET_PRIVATE SHOULD NOT BE PERSISTED",
  }},{status:502})};
  const actual=await runCouncilWorkflow({instanceId:"sanitize-network",payload:{seat:"chatgpt",messages:[{role:"user",content:"test"}]}},step,envMock,{router});
  assert.equal(actual.state,"blocked");
  assert.equal(actual.reason,"transport_failure");
  assert.equal(actual.detail,want);
  assert.ok(!JSON.stringify(actual).includes("SECRET_PRIVATE"));
  assert.ok(!JSON.stringify(actual).includes("Bearer"));
 }
});
