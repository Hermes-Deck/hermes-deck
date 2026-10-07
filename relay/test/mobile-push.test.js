'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
test('relay client reports only HTTPS configuration and truthful unavailable errors',async()=>{
 const {MobilePushClient}=require('../src/mobile-push');const oldURL=process.env.HERMES_PUSH_URL,oldToken=process.env.HERMES_PUSH_SENDER_TOKEN;
 try {process.env.HERMES_PUSH_URL='http://127.0.0.1';process.env.HERMES_PUSH_SENDER_TOKEN='a'.repeat(43);let client=new MobilePushClient();
 assert.equal(client.configured,false);await assert.rejects(client.notify('device',{id:'id',kind:'reply'}),/not configured/);
 process.env.HERMES_PUSH_URL='https://gateway.example/prefix';assert.equal(new MobilePushClient().configured,true);
 process.env.HERMES_PUSH_URL='https://user:password@gateway.example';assert.equal(new MobilePushClient().configured,false);
 }finally{if(oldURL===undefined)delete process.env.HERMES_PUSH_URL;else process.env.HERMES_PUSH_URL=oldURL;if(oldToken===undefined)delete process.env.HERMES_PUSH_SENDER_TOKEN;else process.env.HERMES_PUSH_SENDER_TOKEN=oldToken;}
});
