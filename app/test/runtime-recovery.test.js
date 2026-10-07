"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BridgeClient } = require('../main/bridge');
const key = JSON.stringify(['alpha', 'stored']);
function client() {
  const c = new BridgeClient({mode:'off'});
  c.conn = {}; c.epoch = 1;
  c.bindings.set(key, {rpcId:'old',epoch:1});
  c.rpcToStored.set('old', {sid:'stored',profile:'alpha'});
  return c;
}
test('reaped submit resumes stored identity in its profile and retries once', async () => {
  const c = client(), calls = [];
  c.request = async (method, params) => {
    calls.push({method,params});
    if (method === 'session.resume') return {session_id:'new'};
    if (params.session_id === 'old') throw Object.assign(new Error('session not found'), {rpcCode:4001});
    return {status:'ok'};
  };
  assert.deepEqual(await c.send('stored','hello',{profile:'alpha'}), {status:'ok'});
  assert.deepEqual(calls.map(x=>x.method), ['prompt.submit','session.resume','prompt.submit']);
  assert.equal(calls[1].params.session_id,'stored'); assert.equal(calls[1].params.profile,'alpha');
  assert.equal(calls[2].params.session_id,'new'); assert.equal(c.rpcToStored.has('old'),false);
});
test('takeover installs caller runtime binding and exposes only the mobile contract', async () => {
  const c = client();
  c.request = async (method, params) => {
    assert.equal(method,'deck.takeover');
    assert.deepEqual(params,{session_id:'stored',profile:'alpha'});
    return {ok:true,mode:'transferred',session_id:'taken'};
  };
  assert.deepEqual(await c.takeover('stored',{profile:'alpha'}),{ok:true,mode:'transferred'});
  assert.equal(c.bindings.get(key).rpcId,'taken');
});
for (const operation of ['attachments','steer','redirect','interrupt','gatewayInterrupt']) test(`reaped ${operation} retries once with the right identity`,async()=>{
 const c=client(),calls=[];
 if(operation!=='gatewayInterrupt')c.nodes.set(key,{sid:'stored',profile:'alpha',controlAvailable:true,turnId:'t',ownerPid:42});
 c.request=async(method,params)=>{calls.push({method,params});if(method==='session.resume')return {session_id:'new'};if(calls.length===1)throw Object.assign(new Error('session not found'),{rpcCode:4001});return {status:'ok'};};
 if(operation==='attachments')await c.send('stored','',{profile:'alpha',files:[{filename:'image.png',content_base64:'eA=='}]});
 else if(operation==='steer'||operation==='redirect')await c[operation]('stored','hello',{profile:'alpha',turnId:'t'});
 else await c.interrupt('stored',{profile:'alpha'});
 assert.equal(calls.length,3);assert.equal(calls[1].method,'session.resume');assert.equal(calls[1].params.session_id,'stored');assert.equal(calls[1].params.profile,'alpha');
 assert.equal(calls[2].params.session_id,calls[0].method.startsWith('native.')?'stored':'new');
 assert.equal(c.bindings.get(key).rpcId,'new');
});
test('missing runtime is retried only once, never for uncertain or ownership errors',async()=>{
 for(const [rpcCode,message,expected] of [[4001,'session not found',3],[4001,'session not found or not owned by this transport',1],[-32001,'uncertain',1],[undefined,'session not found',1]]){
  const c=client(),calls=[];c.request=async(method,params)=>{calls.push(method);if(method==='session.resume')return {session_id:'new'};throw Object.assign(new Error(message),{rpcCode});};
  await assert.rejects(c.send('stored','hello',{profile:'alpha'}),e=>e.message===message);assert.equal(calls.length,expected);
 }
});
test('wire RPC codes survive parsing and request rejection',async()=>{
 const {rpcReply}=require('../main/bridge');const c=client();
 const reply=rpcReply({jsonrpc:'2.0',id:'x',error:{code:4001,message:'session not found'}});
 const p=new Promise((resolve,reject)=>c.pending.set('x',{resolve,reject}));c._settle(reply);
 await assert.rejects(p,e=>e.rpcCode===4001&&e.message==='session not found');
});
test('concurrent missing-runtime replies share one resume', async () => {
 const c=client();let resumes=0;
 c.request=async(method,params)=>{
  if(method==='session.resume'){resumes++;await new Promise(r=>setTimeout(r,5));return {session_id:'new'};}
  if(params.session_id==='old')throw Object.assign(new Error('session not found'),{rpcCode:4001});
  return {status:'ok'};
 };
 await Promise.all([c.send('stored','one',{profile:'alpha'}),c.send('stored','two',{profile:'alpha'})]);
 assert.equal(resumes,1);
});

test('takeover targets the observed owner process', async () => {
 const c=client();
 c.nodes.set(key,{sid:'stored',profile:'alpha',ownerPid:42});
 c.request=async(method,params)=>{assert.equal(params.owner_pid,42);return {ok:true,mode:'transferred',session_id:'taken'};};
 await c.takeover('stored',{profile:'alpha'});
});

