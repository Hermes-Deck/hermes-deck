'use strict';
/**
 * The relay's client of the push gateway. Events carry only ids (`target`, `id`, `kind`, optional `collapse`); the
 * gateway never sees content. Optional keys and kinds are sent only when the gateway's `GET /health` lists them in
 * `features` (PROGRAMME "Push gateway contract for D9"): older gateways reject unknown keys.
 */
const FEATURES_TTL = 3600000;
// collapse, digest (relay-notify); test, badge, liveActivity (relay-extras X1, X2, X7).
const KNOWN_FEATURES = ['collapse', 'digest', 'test', 'badge', 'liveActivity'];
const COLLAPSE = /^[a-f0-9]{32}$/;
class MobilePushClient {
  constructor({ url = process.env.HERMES_PUSH_URL, credential = process.env.HERMES_PUSH_SENDER_TOKEN, fetch: fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
    this.url=url; this.credential=credential; this.fetch=fetchImpl; this.now=now;
    try { const parsed=new URL(this.url); this.configured=parsed.protocol==='https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash && /^[A-Za-z0-9_-]{43}$/.test(this.credential || ''); } catch {this.configured=false;}
    this.features=new Set(); this.featuresAt=0; this.featuresBusy=null;
  }
  async request(path,method,body) {
    if (!this.configured) throw Error('Mobile push gateway is not configured');
    const response=await this.fetch(this.url.replace(/\/$/,'')+path,{method,headers:{authorization:`Bearer ${this.credential}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000),redirect:'error'});
    if (!response.ok) {
      let code;
      try { const body=await response.json(); if (['EVENT_EXPIRED','EVENT_FUTURE','SENDER_QUOTA'].includes(body.code)) code=body.code; } catch {}
      throw Object.assign(Error(`Mobile push gateway returned HTTP ${response.status}`),{status:response.status,code});
    }
    return response.json();
  }
  /**
   * Reads the gateway's optional features (`GET /health` -> `{ok, features: [...]}`), cached for an hour; `force` at each
   * registration. A gateway without the route (an older one) offers nothing; a network failure keeps the last answer.
   */
  refreshFeatures(force=false) {
    if (!this.configured) return Promise.resolve(this.features);
    if (this.featuresBusy) return this.featuresBusy;
    if (!force && this.featuresAt && this.now()-this.featuresAt<FEATURES_TTL) return Promise.resolve(this.features);
    this.featuresBusy=(async () => {
      try {
        const response=await this.fetch(this.url.replace(/\/$/,'')+'/health',{method:'GET',signal:AbortSignal.timeout(5000),redirect:'error'});
        let listed=[];
        if (response.ok) { try { const body=await response.json(); if (Array.isArray(body?.features)) listed=body.features; } catch {} }
        this.features=new Set(KNOWN_FEATURES.filter(feature => listed.includes(feature)));
      } catch {}
      this.featuresAt=this.now();
      return this.features;
    })().finally(() => { this.featuresBusy=null; });
    return this.featuresBusy;
  }
  offers(feature) { return this.features.has(feature); }
  setDevice(deviceId,registration) { return this.request('/v1/devices/'+encodeURIComponent(deviceId),'PUT',registration); }
  removeDevice(deviceId) { return this.request('/v1/devices/'+encodeURIComponent(deviceId),'DELETE'); }
  async notify(deviceId,{id,kind,collapse}) {
    // Optional kinds fall back for a gateway that does not list them: a digest travels as `done`; a test as `done` (the
    // relay only asks for `test` when offered; this is the guard for a gateway replaced in between).
    const optional=kind==='digest' || kind==='test';
    const body={target:deviceId,id,kind:optional && !this.offers(kind) ? 'done' : kind};
    if (typeof collapse==='string' && COLLAPSE.test(collapse) && this.offers('collapse')) body.collapse=collapse;
    try { return await this.request('/v1/events','POST',body); }
    catch (error) {
      // A gateway replaced by an older one refuses the optional key or kind: read its features again soon.
      if (error.status===400 && (body.collapse || body.kind==='digest' || body.kind==='test')) this.featuresAt=0;
      throw error;
    }
  }
}
module.exports={MobilePushClient};
