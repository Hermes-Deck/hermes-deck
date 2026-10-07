'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {MobileRelay} = require('../src/mobile');
test('takeover is an explicit profile-scoped mutation with receipt replay protection',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'takeover-'));
  const m=new MobileRelay({tokensFile:path.join(dir,'devices.json'),bridgeConfig:{mode:'off'}});
  t.after(()=>{m.stop();fs.rmSync(dir,{recursive:true,force:true});});
  let calls=0;
  m.bridge=()=>({takeover:async(sid,args)=>{calls++;assert.equal(sid,'stored');assert.equal(args.profile,'alpha');return {ok:true,mode:'transferred'};}});
  const d=m.device('fixture');
  const msg={id:`m.${Date.now()}.${crypto.randomUUID()}`,op:'takeover',args:{sid:'stored',profile:'alpha'}};
  assert.deepEqual(await m.call(d,msg),{ok:true,mode:'transferred'});
  await assert.rejects(m.call(d,msg),/already used/);
  await assert.rejects(m.call(d,{...msg,id:`m.${Date.now()}.${crypto.randomUUID()}`,args:{sid:'stored'}}),/profile/);
  assert.equal(calls,1);
  m.bridgeConfig={mode:'local'};assert.equal(m.capabilities().takeover,true);
});
