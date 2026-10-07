"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AttachStore}=require('../main/attach');
const PNG=Buffer.from('89504e470d0a1a0a0000000d49484452','hex');
test('pasted image draft survives restart, keeps chat identity and is deleted on discard',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'draft-images-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new AttachStore({draftDir:dir});
 const v=await a.stageData({bytes:PNG});
 await a.saveDraft('hermes:alpha:stored',[v.token]);
 const b=new AttachStore({draftDir:dir});
 const drafts=await b.restoreDrafts();
 assert.equal(drafts['hermes:alpha:stored'][0].token,v.token);
 assert.deepEqual((await b.hermesFiles([v.token])).files[0].content_base64,PNG.toString('base64'));
 assert.equal(JSON.stringify(drafts).includes(dir),false);
 b.discard(v.token);
 assert.deepEqual(await new AttachStore({draftDir:dir}).restoreDrafts(),{});
});
test('draft bytes enforce 25 MB/file and 100 MB globally without deleting earlier chats',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'draft-caps-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const source=path.join(dir,'source.bin');fs.writeFileSync(source,'x');fs.truncateSync(source,25*1024*1024);
 const a=new AttachStore({draftDir:path.join(dir,'drafts')});
 for(let i=0;i<4;i++){const v=await a.stagePath(source);a.saveDraft(`chat-${i}`,[v.token]);}
 const fifth=await a.stagePath(source);assert.throws(()=>a.saveDraft('chat-5',[fifth.token]),/100 MB/);
 fs.truncateSync(source,25*1024*1024+1);const big=await a.stagePath(source);assert.throws(()=>a.saveDraft('chat-big',[big.token]),/25 MB/);
 assert.equal(Object.keys(await new AttachStore({draftDir:path.join(dir,'drafts')}).restoreDrafts()).length,4);
});
test('drafts expire after fourteen days and prune their files',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'draft-age-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new AttachStore({draftDir:dir,now:()=>1000});const v=await a.stageData({bytes:PNG});a.saveDraft('chat',[v.token]);
 assert.equal(fs.statSync(path.join(dir,v.token)).size,PNG.length);
 const b=new AttachStore({draftDir:dir,now:()=>1000+14*86400000+1});
 assert.deepEqual(await b.restoreDrafts(),{});assert.equal(fs.existsSync(path.join(dir,v.token)),false);
});
test('a long-running desktop also prunes expired drafts without restarting',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'draft-live-age-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let now=1000;
 const a=new AttachStore({draftDir:dir,now:()=>now});const v=await a.stageData({bytes:PNG});a.saveDraft('chat',[v.token]);now+=14*86400000+1;
 assert.deepEqual(await a.restoreDrafts(),{});assert.equal(fs.existsSync(path.join(dir,v.token)),false);
});

test('queued draft files stay staged across restart without overwriting the earlier queue',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'draft-queue-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const a=new AttachStore({draftDir:dir});const one=await a.stageData({bytes:PNG});const two=await a.stageData({bytes:PNG});
 a.saveDraft('hermes:stored',[one.token,two.token]);a.saveDraft('outbox:hermes:stored',[one.token]);a.saveDraft('outbox:hermes:stored',[two.token]);
 const b=new AttachStore({draftDir:dir});const drafts=await b.restoreDrafts();assert.equal(drafts['outbox:hermes:stored'].length,2);
 assert.equal(drafts['hermes:stored'],undefined);b.forgetDraft('outbox:hermes:stored');assert.deepEqual(await new AttachStore({draftDir:dir}).restoreDrafts(),{});
});
