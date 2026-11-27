import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// DOM and network substitutes test frontend interactions; no live login or provider calls.
class Element {
 constructor(tag='div'){
  this.tag=tag;
  this.textContent='';
  this.children=[];
  this.disabled=false;
  this.value='';
  this.listeners=new Map();
  this.classList={add(){},remove(){}};
 }
 append(...items){this.children.push(...items)}
 replaceChildren(...items){this.children=[...items]}
 addEventListener(type,callback){this.listeners.set(type,callback)}
 setAttribute(name,value){this[name]=value}
 async activate(type='click'){return this.listeners.get(type)?.({preventDefault(){},submitter:this})}
}
const id='council-chatgpt-abcdef0123456789abcdef0123456789';
function createSandbox({workflowStatus='waiting',output=null,failStatus=false}={}){
 const nodes=new Map();
 const byId=name=>{if(!nodes.has(name))nodes.set(name,new Element());return nodes.get(name)};
 const called=[];
 let confirmations=0;
 const document={
  hidden:false,
  getElementById:byId,
  createElement:tag=>new Element(tag)
 };
 const fetch=async(path,init={})=>{
  called.push({path,method:init.method||'GET'});
  if(path==='/api/session')return Response.json({identityVerified:true});
  if(path==='/api/seats')return Response.json({routerStatus:'verified',seats:[
   {id:'chatgpt',configured:true},{id:'claude',configured:false},
   {id:'deepseek',configured:false},{id:'muse',configured:false},{id:'perplexity',configured:false}
  ]});
  if(path==='/api/readiness')return Response.json({dbAvailable:true});
  if(path==='/api/records')return Response.json({records:[]});
  if(path==='/api/workflows')return Response.json({workflows:[{id,seat:'chatgpt'}]});
  if(path==='/api/workflows/'+id&&(!init.method||init.method==='GET')){
   if(failStatus)return Response.json({error:'backend_unavailable'},{status:503});
   return Response.json({status:workflowStatus,output});
  }
  if(path==='/api/workflows/'+id+'/approve'&&init.method==='POST')return Response.json({id,state:'approval_delivered'},{status:202});
  throw Error('unexpected path: '+path);
 };
 const context={document,fetch,Response,setTimeout,
  setInterval:()=>0,matchMedia:()=>({matches:false}),
  window:{confirm:()=>{confirmations++;return true}}
 };
 const script=readFileSync('site/founder.js','utf8');
 runInNewContext(script,context,{filename:'site/founder.js',timeout:1000});
 const find=(root,text)=>root.children.find(x=>x.tag==='button'&&x.textContent===text);
 const ready=()=>new Promise(resolve=>setTimeout(resolve,10));
 return {byId,called,find,ready,confirmations:()=>confirmations};
}
test('a workflow cannot be approved until its signed-backend status is inspected',async()=>{
 const x=createSandbox();
 await x.ready();
 const workflow=x.byId('workflows').children[0];
 assert.ok(workflow,'workspace shows the queued workflow');
 const inspect=x.find(workflow,'Check workflow status');
 const approve=x.find(workflow,'Explicitly approve');
 assert.ok(inspect);
 assert.ok(approve);
 assert.equal(approve.disabled,true);
 assert.equal(x.called.some(r=>r.path.endsWith('/approve')),false);
 await inspect.activate();
 assert.equal(approve.disabled,false);
 await approve.activate();
 assert.equal(approve.disabled,true);
 assert.equal(x.confirmations(),1);
 assert.equal(x.called.filter(r=>r.path.endsWith('/approve')&&r.method==='POST').length,1);
});
test('unavailable workflow status fails closed instead of enabling provider approval',async()=>{
 const x=createSandbox({failStatus:true});
 await x.ready();
 const workflow=x.byId('workflows').children[0];
 const inspect=x.find(workflow,'Check workflow status');
 const approve=x.find(workflow,'Explicitly approve');
 assert.equal(approve.disabled,true);
 await inspect.activate();
 assert.equal(approve.disabled,true);
 await approve.activate();
 assert.equal(x.confirmations(),0);
 assert.equal(x.called.some(r=>r.path.endsWith('/approve')),false);
});
test('completed output is displayed as inferred and unsealed, with no approval action',async()=>{
 const output={state:'completed',content:'Untrusted <script>text</script>',provider:'openai'};
 const x=createSandbox({workflowStatus:'complete',output});
 await x.ready();
 const workflow=x.byId('workflows').children[0];
 await x.find(workflow,'Check workflow status').activate();
 assert.equal(x.find(workflow,'Explicitly approve').disabled,true);
 assert.ok(workflow.children.some(n=>n.tag==='p'&&n.textContent.includes('INFERRED · UNSEALED')));
 assert.equal(x.called.some(r=>r.path.endsWith('/approve')),false);
});
