// Durable Council orchestration. This module has no Cloudflare-specific imports
// so the security, idempotency and approval gates can be tested with node --test.
import { createCouncilRouter } from "./multi-router.js";
import { SEATS } from "./seat-router.js";

const MAX_INPUT_CHARS = 48_000;
const MAX_BODY_CHARS = 64_000;
const INSTANCE_RE = /^council-(chatgpt|claude|deepseek|muse|perplexity)-[a-f0-9]{32}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9:_-]{8,80}$/;

function reply(body,status=200) {
  return new Response(JSON.stringify(body), {
    status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"},
  });
}
function failure(status,message) { return reply({error:{message}},status); }
function knownSeat(name) {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(SEATS,name);
}
function validMessages(messages) {
  if (!Array.isArray(messages) || messages.length<1 || messages.length>64) return false;
  let total=0;
  for(const message of messages) {
    if(!message || typeof message!=="object" || Array.isArray(message))return false;
    if(!["system","user","assistant"].includes(message.role))return false;
    if(typeof message.content!=="string")return false;
    total+=message.content.length;
  }
  return total>0 && total<=MAX_INPUT_CHARS;
}
async function sha256(text) {
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function secureEqual(a,b) {
  const [left,right]=await Promise.all([sha256(a),sha256(b)]);
  let difference=0;
  for(let i=0;i<left.length;i++)difference |= left.charCodeAt(i)^right.charCodeAt(i);
  return difference===0;
}
async function authorize(request, env,seat) {
  const secret=env["ROUTER_API_KEY_"+seat.toUpperCase()];
  if(typeof secret!=="string" || !secret) return 503;
  const given=request.headers.get("authorization")??"";
  return await secureEqual(given,"Bearer "+secret)?200:401;
}
async function parseBody(request) {
  const contentLength=Number(request.headers.get("content-length")||0);
  if(contentLength>MAX_BODY_CHARS*4)return null;
  try {
    const text=await request.text();
    if(text.length>MAX_BODY_CHARS)return null;
    return JSON.parse(text);
  }catch{return null;}
}
function validateJob(job) {
  return job && job.kind==="execute" && knownSeat(job.seat)
    && INSTANCE_RE.test(job.id) && job.id.startsWith("council-"+job.seat+"-")
    && validMessages(job.messages);
}

export function createCouncilApplication({router=createCouncilRouter()}={}) {
  return {
    async fetch(request,env={}) {
      const path=new URL(request.url).pathname;
      if(path==="/health") return router.fetch(request,env);
      // Production must not bypass founder approval via the legacy synchronous API.
      if(path==="/v1/chat/completions")return failure(409,"Use approval-gated /v1/council/workflows");
      const create=path==="/v1/council/workflows";
      const match=path.match(/^\/v1\/council\/workflows\/(council-[a-z]+-[a-f0-9]{32})(?:\/(approve))?$/);
      if(!create&&!match)return failure(404,"Not found");
      if(request.method!==(create||match?.[2]?"POST":"GET"))return failure(405,"Method not allowed");
      const seat=request.headers.get("x-council-seat")??"";
      if(!knownSeat(seat))return failure(400,"Unknown or missing Council seat");
      const auth=await authorize(request,env,seat);
      if(auth!==200)return failure(auth,auth===401?"Unauthorized":"Seat authorization not configured");

      if(create){
        const idempotency=request.headers.get("idempotency-key")??"";
        if(!IDEMPOTENCY_RE.test(idempotency))return failure(400,"Valid idempotency-key required");
        const body=await parseBody(request);
        if(!validMessages(body?.messages))return failure(400,"Invalid messages");
        if(typeof env.COUNCIL_INTAKE?.send!=="function")return failure(503,"Council queue unavailable");
        const id="council-"+seat+"-"+(await sha256(seat+":"+idempotency)).slice(0,32);
        try{
          const gate=await env.COUNCIL_RATE_LIMITER?.limit({key:"intake:"+seat});
          if(gate?.success!==true)return failure(gate?.success===false?429:503,"Council intake unavailable or limited");
          await env.COUNCIL_INTAKE.send({kind:"execute",seat,id,messages:body.messages});
        }catch{return failure(503,"Council intake unavailable");}
        return reply({id,state:"queued_for_approval",approved:false},202);
      }
      const id=match[1];
      if(!INSTANCE_RE.test(id)||!id.startsWith("council-"+seat+"-"))return failure(403,"Seat mismatch");
      if(typeof env.COUNCIL_DURABLE?.get!=="function")return failure(503,"Council Workflow unavailable");
      let instance;
      try{instance=await env.COUNCIL_DURABLE.get(id);}
      catch{return failure(404,"Workflow not found");}

      if(match[2]==="approve"){
        const body=await parseBody(request);
        if(body?.decision!=="approve")return failure(400,"Explicit founder approval required");
        try{
          await instance.sendEvent({type:"founder-approved",payload:{decision:"approve",seat,instanceId:id}});
          return reply({id,state:"approval_delivered"},202);
        }catch{return failure(409,"Workflow not awaiting approval");}
      }
      try{
        const status=await instance.status();
        return reply({id,...status});
      }catch{return failure(503,"Cannot inspect Workflow");}
    },
    async queue(batch,env={}) {
      for(const message of batch.messages||[]){
        const job=message.body;
        if(!validateJob(job)||typeof env.COUNCIL_DURABLE?.create!=="function"){
          message.retry();continue;
        }
        try{
          await env.COUNCIL_DURABLE.create({id:job.id,params:{seat:job.seat,messages:job.messages}});
          message.ack();
        }catch(error){
          if(error instanceof Error&&error.message.includes("(instance.already_exists)")){
            message.ack();continue;
          }
          message.retry();
        }
      }
    },
    async scheduled(controller,env={},ctx={},logger=(line)=>console.info(line)) {
      // Cron is diagnostic only. It never starts unapproved AI execution.
      logger(JSON.stringify({
        event:"council_maintenance_heartbeat",
        schedule:controller.cron,
        scheduled_at:new Date(controller.scheduledTime).toISOString(),
        queue_bound:typeof env.COUNCIL_INTAKE?.send==="function",
        workflow_bound:typeof env.COUNCIL_DURABLE?.get==="function",
        rate_limit_bound:typeof env.COUNCIL_RATE_LIMITER?.limit==="function",
      }));
    },
  };
}

export async function runCouncilWorkflow(event,step,env={}, {router=createCouncilRouter({useRequestTimeout:false})}={}) {
  const approvedJob=await step.do("validate",async()=>{
    const payload=event.payload;
    if(!knownSeat(payload?.seat)||!validMessages(payload?.messages))return null;
    return {seat:payload.seat,messages:payload.messages};
  });
  if(!approvedJob)return {state:"invalid"};
  let decision;
  try{
    decision=await step.waitForEvent("await founder approval",{
      type:"founder-approved",timeout:"24 hours",
    });
  }catch{return {state:"expired",seat:approvedJob.seat};}
  if(decision?.payload?.decision!=="approve"||
     decision.payload.seat!==approvedJob.seat||
     decision.payload.instanceId!==event.instanceId)return {state:"rejected",seat:approvedJob.seat};

  return step.do("provider execution",{retries:{limit:0,delay:"1 second"},timeout:"75 seconds"},async()=>{
    const seat=approvedJob.seat;
    const key=env["ROUTER_API_KEY_"+seat.toUpperCase()];
    if(typeof key!=="string"||!key)return {state:"blocked",seat,status:503};
    const req=new Request("https://council.internal/v1/chat/completions",{
      method:"POST",
      headers:{"content-type":"application/json","x-council-seat":seat,authorization:"Bearer "+key},
      body:JSON.stringify({messages:approvedJob.messages}),
    });
    const res=await router.fetch(req,env);
    if(!res.ok){
      // Preserve only an allowlisted diagnostic category. Never persist
      // upstream response bodies, API credentials, or router error details.
      let reason="unclassified";
      try {
        const error=await res.json();
        const message=error?.error?.message;
        if(typeof message==="string"){
          const http=/^(?:openai|anthropic|deepseek|meta|perplexity) returned HTTP ([1-5]\d{2})$/.exec(message);
          if(http) reason="upstream_http_"+http[1];
          else if(/^(?:openai|anthropic|deepseek|meta|perplexity) request failed$/.test(message)) reason="transport_failure";
          else if(/^(?:openai|anthropic|deepseek|meta|perplexity) returned an invalid response$/.test(message)) reason="invalid_response";
        }
      } catch { /* Malformed errors must not prevent a safe receipt. */ }
      return {state:"blocked",seat,status:res.status,reason};
    }
    const result=await res.json();
    const content=result?.choices?.[0]?.message?.content;
    if(typeof content!=="string"||!content.trim()||result.seat!==seat){
      return {state:"blocked",seat,status:502};
    }
    // Do not persist provider.raw or any API secrets into Workflow results/logs.
    return {state:"completed",seat,content,provider:result.provider?.name??null,response_id:result.id??null};
  });
}
