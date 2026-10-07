'use strict';
class MobilePushClient {
  constructor() {
    this.url=process.env.HERMES_PUSH_URL; this.credential=process.env.HERMES_PUSH_SENDER_TOKEN;
    try { const url=new URL(this.url); this.configured=url.protocol==='https:' && !url.username && !url.password && !url.search && !url.hash && /^[A-Za-z0-9_-]{43}$/.test(this.credential || ''); } catch {this.configured=false;}
  }
  async request(path,method,body) {
    if (!this.configured) throw Error('Mobile push gateway is not configured');
    const response=await fetch(this.url.replace(/\/$/,'')+path,{method,headers:{authorization:`Bearer ${this.credential}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000),redirect:'error'});
    if (!response.ok) {
      let code;
      try { const body=await response.json(); if (['EVENT_EXPIRED','EVENT_FUTURE','SENDER_QUOTA'].includes(body.code)) code=body.code; } catch {}
      throw Object.assign(Error(`Mobile push gateway returned HTTP ${response.status}`),{status:response.status,code});
    }
    return response.json();
  }
  setDevice(deviceId,registration) { return this.request('/v1/devices/'+encodeURIComponent(deviceId),'PUT',registration); }
  removeDevice(deviceId) { return this.request('/v1/devices/'+encodeURIComponent(deviceId),'DELETE'); }
  notify(deviceId,{id,kind}) { return this.request('/v1/events','POST',{target:deviceId,id,kind}); }
}
module.exports={MobilePushClient};
