"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict');
test('refused send requires explicit takeover then retries original intent once',async()=>{
 const T=require('../renderer/takeover');
 let transfers=0,retries=0;
 const c=T.create({takeover:async(sid,opts)=>{transfers++;assert.equal(sid,'s');assert.equal(opts.profile,'alpha');return {ok:true,mode:'transferred'};},changed:()=>{},error:()=>{}});
 assert.equal(c.offer(new Error('This chat is open in another Hermes window/terminal'),{sid:'s',profile:'alpha'},async()=>{retries++;}),true);
 assert.equal(transfers,0);assert.equal(retries,0);
 const a=c.run({sid:'s',profile:'alpha'}),b=c.run({sid:'s',profile:'alpha'});
 await Promise.all([a,b]);assert.equal(transfers,1);assert.equal(retries,1);
 assert.equal(c.pending({sid:'s',profile:'alpha'}),null);
 assert.equal(c.offer(new Error('session not found'),{sid:'s',profile:'alpha'},()=>{}),false);
});
test('foreign-transport rejection offers takeover but a plain missing runtime does not',()=>{
 const T=require('../renderer/takeover');assert.equal(T.refused(new Error('session not found or not owned by this transport')),true);assert.equal(T.refused(new Error('session not found')),false);
});
test('failed or invalid takeover never retries the captured mutation',async()=>{
 const T=require('../renderer/takeover');
 for(const response of [null,{ok:true,mode:'unexpected'}]){let retries=0,errors=0;const c=T.create({takeover:async()=>response,changed:()=>{},error:()=>errors++});const target={sid:'s',profile:'alpha'};c.offer(new Error('another UI'),target,()=>retries++);await c.run(target);assert.equal(retries,0);assert.equal(errors,1);assert.ok(c.pending(target));}
});
test('interrupt/resume takeover reports restart after a successful retry',async()=>{
 const T=require('../renderer/takeover'),order=[];const c=T.create({takeover:async()=>({ok:true,mode:'restarted'}),changed:()=>{},error:()=>{},completed:()=>order.push('reported')});const target={sid:'s',profile:'alpha'};c.offer(new Error('another UI'),target,async()=>{order.push('retry');return true;});await c.run(target);assert.deepEqual(order,['retry','reported']);
});
