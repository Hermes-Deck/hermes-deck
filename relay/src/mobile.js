'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const tokens = require('./devtokens');
const { atomicWriteJson, readJson } = require('./util');
const compat = require('./compat');
const { UploadSpool, LEGACY, settleBody } = require('./uploads');
const { DownloadTickets, LEGACY_MAX: LEGACY_DOWNLOAD } = require('./downloads');
// The old single-line limits (base64 through the plugin's stdio): what a host without staged uploads can take. With a
// plugin that answers deck.attach_staged on this host, capabilities() reports the spool's limits instead (uploads.js).
const LIMITS = LEGACY;
const TTL = 15 * 60 * 1000;
const NOTIFICATION_CAPACITY = 10000;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PUSH_EVENT_ID = /^e_(\d{13})_([a-f0-9]{48})$/;
const MUTATION_AGE = 7 * 86400000;
const MUTATION_FUTURE = 15 * 60000;
const MUTATION_ID = /^m\.(\d{13})\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const mutationTime = id => { const match = typeof id === 'string' && MUTATION_ID.exec(id); return match ? Number(match[1]) : null; };
const TITLE_MAX = 80, BODY_MAX = 300, BODY_LINES = 4, SOURCE_MAX = 4000, LAST_REPLY_LIMIT = 200;
// One banner per turn: reply and done of the same turn are merged inside this window (and by turn id when both are known).
const SETTLE_MS = 3500, COALESCE_MS = 10000, NAMES_TTL = 10 * 60 * 1000, LOOKUP_MS = 3000, GROUP_LIMIT = 200;
const LANGUAGE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/;
/** Dictation language hint: a BCP-47-ish tag reduced to the lowercase primary subtag Whisper-style engines take ('tr-TR' -> 'tr'). */
const dictationLanguage = value => LANGUAGE.test(value) ? value.split(/[-_]/)[0].toLowerCase() : null;
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('timeout')), ms); t.unref?.(); })]);
/** Display name for a profile id; never the raw id 'default'. */
const fallbackAgent = profile => profile === 'default' || !profile ? 'Hermes' : `${profile[0].toUpperCase()}${profile.slice(1)}`;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const clip = (text, max) => { const chars = [...text]; return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}\u2026` : text; };
/** One display line: control characters and whitespace runs collapsed, bounded. */
const oneLine = (value, max) => typeof value === 'string' ? clip(value.slice(0, SOURCE_MAX).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(), max) : '';
/** Markdown reduced to plain text lines for a notification banner (no content is ever sent to the gateway). */
function plainLines(value) {
  if (typeof value !== 'string') return [];
  let fenced = false;
  return value.slice(0, SOURCE_MAX).replace(/\r\n?/g, '\n').replace(CONTROL, ' ').split('\n')
    // Fenced code is skipped entirely: a banner shows prose, and code may carry secrets.
    .filter(line => { if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return false; } return !fenced && !/^\s*(?:@image:|MEDIA:)/.test(line); })
    .map(line => line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^\s*>+\s?/, '').replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\s*([-*_]\s*){3,}$/, '').replace(/(\*\*|__|~~)(.+?)\1/g, '$2').replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2').replace(/`+/g, '')
      .replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
/** First lines of a text as a banner body: at most BODY_LINES lines and BODY_MAX characters. */
function previewText(value, lines = BODY_LINES, max = BODY_MAX) {
  const picked = plainLines(value).slice(0, lines);
  if (!picked.length) return '';
  return clip(picked.join('\n'), max);
}
/** Banner body for one admitted event, from the native payload or the open request. Never persisted outside the owner's relay. */
function notificationBody(kind, source = {}) {
  if (kind === 'approval') return previewText(source.description, 2) || previewText(source.command, 2) || '';
  if (kind === 'question') { const first = Array.isArray(source.questions) ? source.questions.find(q => q && typeof q.question === 'string') : null; return first ? previewText(first.question, 2) : ''; }
  if (kind === 'error') { const p = source.payload || {}; return previewText(p.error ?? p.message ?? p.reason ?? p.text, 1, 120); }
  const p = source.payload || {};
  return previewText(p.text ?? p.message ?? p.final_response ?? p.response ?? p.summary ?? source.text);
}
/** Conversation title for a notification: live node title, then the recent-session list, then the agent (profile) name. */
function conversationTitle(bridge, sid, profile, fallback = oneLine(profile, TITLE_MAX)) {
  let node = null;
  try { node = bridge?.nodeFor?.(sid, profile) || null; } catch {}
  const recent = Array.isArray(bridge?.recent) ? bridge.recent.find(row => row && row.id === sid && (!row.profile || row.profile === profile)) : null;
  for (const candidate of [node?.title, recent?.title, node?.name]) {
    const title = oneLine(candidate, TITLE_MAX);
    if (title && title !== 'Bot Chat') return title;
  }
  return fallback;
}
/** A pending notification is pushed once its text lookup has finished (or its short hold ran out). */
const ready = item => item.delivery === 'pending' && !(item.hold > Date.now());
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const opaque = () => crypto.randomBytes(24).toString('hex');
const pairFile = file => `${file}.pairs`;
function privateWrite(file, value) {
  atomicWriteJson(file, value);
  fs.chmodSync(file, 0o600);
}
function createPair(file) {
  const code = crypto.randomBytes(16).toString('hex');
  const data = readJson(pairFile(file), { pairs: {} });
  data.pairs = Object.fromEntries(Object.entries(data.pairs).filter(([, value]) => value.expires > Date.now()));
  if (Object.keys(data.pairs).length >= 10) throw fail('limit', 'Too many pending pairs');
  data.pairs[tokens.hash(code)] = { expires: Date.now() + 5 * 60 * 1000 };
  privateWrite(pairFile(file), data);
  return code;
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req, maximum = 65536) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > maximum) throw fail('too_large', 'Body too large', 413);
    parts.push(part);
  }
  return Buffer.concat(parts);
}
async function object(req) {
  let value;
  try { value = JSON.parse((await body(req)).toString()); }
  catch (error) { if (error.code) throw error; throw fail('bad_request', 'Expected JSON object'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('bad_request', 'Expected JSON object');
  return value;
}
const READ_OPS = new Set(['sessions', 'history', 'profiles', 'avatar', 'botChat', 'modelOptions', 'sessionPage', 'sessionIndex', 'plan', 'toolCalls', 'subagents', 'subagentTail', 'commands']);
const OPS = {
  plan: ['sid', 'profile'], toolCalls: ['sid', 'profile'], subagents: ['sid', 'profile'],
  subagentTail: ['sid', 'profile', 'id'], steerSubagent: ['sid', 'profile', 'id', 'text'], interruptSubagent: ['sid', 'profile', 'id'], commands: ['profile'],
  sessionPage: ['profile', 'archived', 'offset'], sessionIndex: ['archived', 'force'],
  renameSession: ['sid', 'profile', 'title'], pinSession: ['sid', 'profile', 'pinned'], archiveSession: ['sid', 'profile', 'archived'], branchSession: ['sid', 'profile'], discard: ['sid', 'profile'],
  setEffort: ['sid', 'profile', 'effort'], reasoning: ['show'],
  sessions: ['profile', 'limit'], history: ['sid', 'profile', 'limit', 'offset'], profiles: [], avatar: ['name'],
  botChat: ['name', 'expect'], createBotChat: ['name', 'expect'], create: ['profile'], delete: ['sid', 'profile'],
  send: ['sid', 'profile', 'text', 'uploads'], steer: ['sid', 'profile', 'text', 'turnId'], redirect: ['sid', 'profile', 'text', 'turnId'],
  takeover: ['sid', 'profile'], interrupt: ['sid', 'profile', 'turnId'], modelOptions: ['sid', 'profile', 'profileOnly'], setModel: ['sid', 'profile', 'model', 'provider', 'confirm'],
  answerApproval: ['id', 'profile', 'choice'], answerQuestion: ['id', 'profile', 'answers'], transcribe: ['upload', 'mime', 'language'],
};
class MobileRelay {
  constructor({ tokensFile, bridgeConfig, bridgeOptions = {}, capabilities = {}, push = null, settleMs = SETTLE_MS, uploads = null, downloads = null }) {
    Object.assign(this, { tokensFile, bridgeConfig, bridgeOptions, push, settleMs });
    // Uploads live on disk (uploads.js), shared with the desktop routes; index.js passes the relay's spool.
    this.uploads = uploads || new UploadSpool({ dir: path.join(path.dirname(path.resolve(tokensFile)), 'uploads') });
    this.ownSpool = !uploads;
    // Large downloads (downloads.js): deck.file_grant tickets in the same spool, streamed from disk.
    this.downloads = downloads || new DownloadTickets({ spool: this.uploads });
    // Whether the plugin behind the bridge takes staged uploads on this host (deck.version uploads.host) and grants
    // relay downloads (deck.version downloads.host; `direct` is the active per-file cap, 0 when not); probed, cached.
    this.staging = { ok: false, direct: 0, at: 0, busy: null };
    this.names = { at: 0, map: new Map(), busy: null };
    this.enriching = new Map();
    this.BridgeClient = null;
    if (bridgeConfig && bridgeConfig.mode !== 'off') {
      try { this.BridgeClient = require('../../app/main/bridge').BridgeClient; }
      catch { throw fail('unavailable', 'Configured mobile bridge requires the full Hermes Deck source layout including app/main/bridge.js', 503); }
    }
    this.available = capabilities;
    this.devices = new Map();
    this.attempts = new Map();
    this.metaFile = `${tokensFile}.state`;
    this.meta = readJson(this.metaFile, { devices: {} });
    this.meta.revocations ||= {};
    this.pushTasks = new Map();
    this.pushRetryAt = new Map();
    this.pushCursor = 0;
    this.pushStopped = false;
    let expired = false;
    for (const state of Object.values(this.meta.devices)) {
      if (state.pushAttempt) { state.observePush = false; state.pushRemoval ||= opaque(); expired = true; }
      const ids = state.ids || [];
      const floor = Math.max(state.receiptFloor || 0, Date.now() - MUTATION_AGE);
      expired ||= state.receiptFloor !== floor;
      state.receiptFloor = floor;
      state.ids = ids.filter(id => mutationTime(id) !== null && mutationTime(id) > floor);
      expired ||= state.ids.length !== ids.length;
    }
    if (expired) privateWrite(this.metaFile, this.meta);
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
    this.ticks = 0;
    this.timer = setInterval(() => this.sweep(), 1000);
    this.timer.unref();
    this.flushPush().catch(() => {});
    if (this.push?.configured && this.capabilities().bridge) {
      const authorized = tokens.load(this.tokensFile).devices;
      for (const [id, state] of Object.entries(this.meta.devices)) {
        if (state.observePush && /^[a-f0-9]{64}$/.test(authorized[id]?.hash || '') && !this.meta.revocations[id]) this.bridge(this.device(id));
      }
    }
  }
  capabilities() {
    // relayVersion: iOS Settings › About shows it (SettingsView.swift); protocol: the wire protocol (compat.js)
    // limits: the spool's (2 GB per file by default) once the plugin proved it takes staged uploads on this host, else
    // the old single-line limits; uploads.staged says which (informational: clients trust `limits`).
    // limits.downloadBytes: the largest file /mobile/files can deliver (8 GB by default when the plugin grants relay
    // downloads on this host, `downloads.direct`; else the 200 MB of the chunk path).
    const staged = this.stagedReady();
    const direct = this.directReady();
    return { v: 1, relayVersion: compat.VERSION, protocol: compat.PROTOCOL, bridge: !!this.bridgeConfig && this.bridgeConfig.mode !== 'off', history: !!this.available.history,
      takeover: !!this.bridgeConfig && this.bridgeConfig.mode !== 'off',
      sessionBrowser: !!this.bridgeConfig && this.bridgeConfig.mode !== 'off', reasoning: !!this.bridgeConfig && this.bridgeConfig.mode !== 'off',
      work: !!this.bridgeConfig && this.bridgeConfig.mode !== 'off', subagents: !!this.bridgeConfig && this.bridgeConfig.mode !== 'off', commands: !!this.bridgeConfig && this.bridgeConfig.mode !== 'off',
      workspace: !!this.available.workspace, desktop: !!this.available.desktop, push: !!this.push?.configured, transcribeLanguage: true,
      limits: { ...(staged ? this.uploads.limits() : LIMITS), downloadBytes: direct ? this.staging.direct : LEGACY_DOWNLOAD }, uploads: { v: 1, staged }, downloads: { v: 1, direct } };
  }
  stagedReady() { return !!this.bridgeConfig && this.bridgeConfig.mode !== 'off' && this.staging.ok === true; }
  directReady() { return !!this.bridgeConfig && this.bridgeConfig.mode !== 'off' && this.staging.direct > 0; }
  limits() { return this.stagedReady() ? this.uploads.limits() : LIMITS; }
  /**
   * Asks the plugin (deck.version, answered by stream.py) whether it takes staged uploads from this relay's spool: its
   * uploads.host must equal ours (same machine, same real folder); and whether it grants relay downloads into it
   * (downloads.host equal to ours; the smaller of its maxBytes and ours applies). A definite answer is cached for
   * maxAgeMs; a bridge that is not connected yet is waited for briefly and asked again next time.
   */
  async probeStaging(device, maxAgeMs = 60000) {
    if (!this.bridgeConfig || this.bridgeConfig.mode === 'off') return false;
    if (this.staging.at && Date.now() - this.staging.at < maxAgeMs) return this.staging.ok;
    if (!this.staging.busy) {
      this.staging.busy = (async () => {
        const bridge = this.bridge(device);
        if (typeof bridge.version !== 'function') return;
        if (bridge.status && bridge.status.status !== 'open' && typeof bridge.on === 'function') {
          let seen;
          await withTimeout(new Promise(resolve => { seen = s => { if (s?.status === 'open') resolve(); }; bridge.on('status', seen); }), LOOKUP_MS).catch(() => {});
          bridge.off?.('status', seen);
        }
        const answer = await withTimeout(Promise.resolve(bridge.version()), LOOKUP_MS).catch(() => null);
        if (!answer) return; // cannot tell now: not cached
        const up = answer.uploads;
        let host = null;
        try { host = this.uploads.hostId(); } catch {}
        this.staging.ok = !!(up && up.v === 1 && host && up.host === host);
        const down = answer.downloads;
        this.staging.direct = down && down.v === 1 && host && down.host === host && Number.isSafeInteger(down.maxBytes) && down.maxBytes > 0
          ? Math.min(down.maxBytes, this.downloads.maxBytes) : 0;
        this.staging.at = Date.now();
      })().catch(() => {}).finally(() => { this.staging.busy = null; });
    }
    await this.staging.busy;
    return this.staging.ok;
  }
  authenticate(req) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice(7), id = tokens.match(this.tokensFile, token);
    return id ? { id, hash: tokens.hash(token) } : null;
  }
  pair({ code, name }, address = 'local') {
    const now = Date.now();
    let attempt = this.attempts.get(address);
    if (!attempt || attempt.until < now) {
      if (this.attempts.size >= 1024) throw fail('rate_limit', 'Pairing capacity limit', 429);
      attempt = { count: 0, until: now + 60000 };
      this.attempts.set(address, attempt);
    }
    if (++attempt.count > 10) throw fail('rate_limit', 'Pairing attempt limit', 429);
    if (typeof code !== 'string' || code.length > 128 || typeof name !== 'string' || name.length > 80 || !name.trim()) throw fail('bad_request', 'Invalid pair');
    const file = pairFile(this.tokensFile), data = readJson(file, { pairs: {} }), key = tokens.hash(code), ticket = data.pairs[key];
    if (!ticket || ticket.expires < now) throw fail('invalid_pair', 'Invalid or expired pairing code', 401);
    delete data.pairs[key];
    privateWrite(file, data);
    const deviceId = `mobile-${crypto.randomBytes(10).toString('hex')}`, token = tokens.add(this.tokensFile, deviceId);
    return { token, deviceId, capabilities: this.capabilities() };
  }
  device(id) {
    let device = this.devices.get(id);
    if (!device) {
      if (this.devices.size >= 64) throw fail('limit', 'Too many active devices', 429);
      device = { id, hash: tokens.load(this.tokensFile).devices[id]?.hash, sockets: new Set(), uploads: new Map(), inflightBytes: 0, files: new Map(),
        notifications: new Map(Object.entries(this.meta.devices[id]?.notifications || {})), ids: new Set(this.meta.devices[id]?.ids || []), receiptFloor: this.meta.devices[id]?.receiptFloor || Date.now() - MUTATION_AGE, registrationBusy: false, observePush: this.meta.devices[id]?.observePush === true, pushAttempt: this.meta.devices[id]?.pushAttempt || null, pushRemoval: this.meta.devices[id]?.pushRemoval || null, notificationOverflow: this.meta.devices[id]?.notificationOverflow || 0, pushKinds: this.meta.devices[id]?.pushKinds || null, groups: new Map(), merged: new Set(), reads: new Set(), offers: null, bridge: null };
      this.devices.set(id, device);
    }
    return device;
  }
  persist(device) {
    this.meta.devices[device.id] = { ids: [...device.ids], receiptFloor: device.receiptFloor, observePush: device.observePush, pushAttempt: device.pushAttempt, pushRemoval: device.pushRemoval, notificationOverflow: device.notificationOverflow, pushKinds: device.pushKinds, notifications: Object.fromEntries(device.notifications) };
    privateWrite(this.metaFile, this.meta);
  }
  bridge(device) {
    if (!this.capabilities().bridge) throw fail('unavailable', 'Hermes bridge is not configured', 503);
    if (!device.bridge) {
      const bridge = device.bridge = new this.BridgeClient(this.bridgeConfig, this.bridgeOptions);
      // A (re)connected plugin may be a newer or older one: ask again whether it takes staged uploads.
      bridge.on('status', s => { if (s?.status === 'open' && device.bridge === bridge) { this.staging.at = 0; this.probeStaging(device).catch(() => {}); } });
      for (const [event, label] of [['status', 'status'], ['snapshot', 'snapshot'], ['requests', 'requests'], ['event', 'native'], ['sessions', 'sessions']]) {
        bridge.on(event, data => {
          if (this.devices.get(device.id) !== device || !tokens.stillValid(this.tokensFile, device.id, device.hash)) return;
          this.emit(device, { t: 'bridge', event: label, data });
          try { this.notify(device, label, data); } catch { this.emit(device, { t: 'bridge', event: 'status', data: { status: 'error', error: 'Notification metadata could not be saved' } }); }
        });
      }
      bridge.start();
    }
    return device.bridge;
  }
  emit(device, event) {
    const text = JSON.stringify(event);
    for (const ws of device.sockets) if (ws.mobileBridge && ws.readyState === 1) {
      if (ws.bufferedAmount > 4 * 1024 * 1024) ws.terminate();
      else ws.send(text);
    }
  }
  notify(device, event, data) {
    const admission = { accepted: 0, duplicate: 0, skipped: 0, overflow: 0, available: !!this.push?.configured && device.observePush === true };
    if (!admission.available) return admission;
    let items = [];
    if (event === 'requests') for (const request of Array.isArray(data) ? data : []) {
      const profile = request?.profile;
      if (typeof profile !== 'string' || !PROFILE_NAME.test(profile)) { admission.skipped++; continue; }
      let sid = request.sid;
      if (!sid) {
        try { sid = device.bridge?.nodeFor?.(request.rpcId, profile)?.sid; }
        catch { admission.skipped++; continue; }
      }
      const createdAt = typeof request.createdAt === 'number' && Number.isFinite(request.createdAt) && request.createdAt > 0 ? request.createdAt : null;
      const scope = ['request', profile, sid, request.id, request.kind];
      const key = createdAt === null ? scope : [...scope, request.rpcId, createdAt];
      items.push({ sid, profile, kind: request.kind, timestamp: createdAt === null ? request.at : Math.floor(createdAt * 1000), key: JSON.stringify(key), source: request });
    }
    if (event === 'native') {
      const kind = { 'message.complete': 'reply', 'turn.complete': 'done', 'turn.error': 'error' }[data.type];
      const profile = data.profile;
      if (typeof profile !== 'string' || !PROFILE_NAME.test(profile)) { admission.skipped++; return admission; }
      let sid = data.sid;
      if (!sid) { try { sid = device.bridge?.nodeFor?.(data.rpcId, profile)?.sid; } catch { admission.skipped++; return admission; } }
      if (kind === 'reply') {
        // Remembered so the terminal "done" notification of the same turn can still show the reply, also when the session id is
        // not bound yet (a new session's first turn): then it is kept under the runtime id and found again through the node. Bounded, memory only.
        const text = notificationBody('reply', { payload: data.payload });
        if (text) this.rememberReply(device, profile, [sid, data.rpcId], text);
      }
      if (kind && sid) {
        if (kind === 'done' || kind === 'error') {
          let node;
          try { node = device.bridge?.nodeFor?.(sid, profile); } catch {}
          const turn = data.payload?.turn_id;
          // Gateway counters/request IDs are not native hook turn IDs; uncorrelated terminal events defer to snapshots.
          if (typeof turn !== 'string' || !turn || node?.turnId !== turn) { admission.skipped++; return admission; }
          items = [{ sid, profile, kind, key: JSON.stringify(['terminal', profile, sid, turn, kind]), source: { payload: data.payload }, rpcId: data.rpcId }];
        } else items = [{ sid, profile, kind, key: JSON.stringify(['native', profile, sid, opaque()]), source: { payload: data.payload }, rpcId: data.rpcId }];
      }
    }
    if (event === 'snapshot') {
      const previous = device.states;
      device.states = new Map((data.nodes || []).map(node => [JSON.stringify([node.profile, node.sid]), JSON.stringify([node.state, node.turnId])]));
      if (previous) items = (data.nodes || []).filter(node => previous.has(JSON.stringify([node.profile, node.sid])) && previous.get(JSON.stringify([node.profile, node.sid])) !== JSON.stringify([node.state, node.turnId]))
        .map(node => ({ sid: node.sid, profile: node.profile, kind: { finished: 'done', error: 'error' }[node.state], timestamp: node.terminalAt ? Math.trunc(node.terminalAt < 1e12 ? node.terminalAt * 1000 : node.terminalAt) : undefined, key: node.turnId ? JSON.stringify(['terminal', node.profile, node.sid, node.turnId, { finished: 'done', error: 'error' }[node.state]]) : null }));
    }
    this.prune(device);
    for (const item of items) {
      if (!item.key || !item.sid || typeof item.profile !== 'string' || !PROFILE_NAME.test(item.profile) || !['reply', 'done', 'approval', 'question', 'error'].includes(item.kind)) { admission.skipped++; continue; }
      const nonce = crypto.createHash('sha256').update(`${device.id}:${item.key}`).digest('hex').slice(0, 48);
      // Reuse the initial timestamp across reconnects/restarts while the local mapping is retained.
      if (device.merged.has(nonce) || [...device.notifications.keys()].some(id => id === nonce || PUSH_EVENT_ID.exec(id)?.[2] === nonce)) { admission.duplicate++; continue; }
      const timestamp = Number.isSafeInteger(item.timestamp) && item.timestamp >= 1e12 && item.timestamp < 1e13 ? item.timestamp : Date.now();
      const id = `e_${timestamp}_${nonce}`;
      let body = '';
      try { body = notificationBody(item.kind, item.source); } catch {}
      if (!body && (item.kind === 'done' || item.kind === 'reply')) {
        let rpcId = item.rpcId;
        try { rpcId ||= device.bridge?.nodeFor?.(item.sid, item.profile)?.rpcId; } catch {}
        body = this.recallReply(device, item.profile, [item.sid, rpcId]);
      }
      // One banner per turn: reply and done of the same turn are merged into the first one; the text wins.
      if (item.kind === 'reply' || item.kind === 'done') {
        const group = device.groups.get(JSON.stringify([item.profile, item.sid])), existing = group && device.notifications.get(group.id);
        if (existing && Date.now() - group.at < COALESCE_MS && !group.kinds.has(item.kind)) {
          group.kinds.add(item.kind);
          device.merged.add(nonce);
          if (!existing.body && body) { existing.body = body; delete existing.hold; }
          // Not pushed yet and its kind is switched off on the phone: carry the banner under the kind that is on.
          if (existing.delivery === 'pending' && !this.kindEnabled(device, existing.kind) && this.kindEnabled(device, item.kind)) existing.kind = item.kind;
          admission.duplicate++;
          this.persist(device);
          this.flushPush().catch(() => {});
          continue;
        }
      }
      if (device.notifications.size >= NOTIFICATION_CAPACITY) { admission.overflow++; continue; }
      let title = '', agent = '';
      try { ({ title, agent } = this.describe(device.bridge, item.sid, item.profile)); } catch {}
      const lookup = (item.kind === 'reply' || item.kind === 'done') && !body && typeof device.bridge?.history === 'function' && this.settleMs > 0;
      device.notifications.set(id, { sid: item.sid, profile: item.profile, kind: item.kind, title, body, agent, expires: timestamp + 7 * 86400000, delivery: 'pending', ...(lookup ? { hold: Date.now() + this.settleMs } : {}) });
      if (item.kind === 'reply' || item.kind === 'done') {
        device.groups.set(JSON.stringify([item.profile, item.sid]), { id, at: Date.now(), kinds: new Set([item.kind]) });
        while (device.groups.size > GROUP_LIMIT) device.groups.delete(device.groups.keys().next().value);
        while (device.merged.size > GROUP_LIMIT) device.merged.delete(device.merged.keys().next().value);
      }
      admission.accepted++;
      this.persist(device);
      this.refreshNames(device.bridge).catch(() => {});
      if (lookup) this.enrich(device, id, item);
      else this.flushPush().catch(() => {});
    }
    if (admission.overflow) {
      device.notificationOverflow += admission.overflow;
      this.persist(device);
      this.emit(device, { t: 'bridge', event: 'notificationAdmission', data: { ...admission, capacity: NOTIFICATION_CAPACITY } });
    }
    return admission;
  }
  kindEnabled(device, kind) { return !Array.isArray(device.pushKinds) || device.pushKinds.includes(kind); }
  /** Keeps a turn's reply text under every id the session is known by (stored sid and runtime id), so a done event can find it. */
  rememberReply(device, profile, ids, text) {
    device.lastReply ||= new Map();
    for (const id of new Set(ids.filter(value => typeof value === 'string' && value))) {
      const key = JSON.stringify([profile, id]);
      device.lastReply.delete(key); device.lastReply.set(key, text);
    }
    while (device.lastReply.size > LAST_REPLY_LIMIT) device.lastReply.delete(device.lastReply.keys().next().value);
  }
  recallReply(device, profile, ids) {
    const all = new Set(ids.filter(value => typeof value === 'string' && value));
    try { for (const [rpc, stored] of device.bridge?.rpcToStored || []) if (stored.profile === profile && all.has(stored.sid)) all.add(rpc); } catch {}
    for (const id of all) { const text = device.lastReply?.get(JSON.stringify([profile, id])); if (text) return text; }
    return '';
  }
  /** Conversation title and agent label of a notification. A subagent session shows its parent conversation and its own name as the agent. */
  describe(bridge, sid, profile) {
    let node = null, parent = null;
    try { node = bridge?.nodeFor?.(sid, profile) || null; } catch {}
    const parentSid = node?.parent || node?.lineageParent;
    if (node?.subagentId || node?.role === 'subagent' || (parentSid && parentSid !== sid && node?.source !== 'deck')) {
      try { parent = parentSid ? bridge?.nodeFor?.(parentSid, profile) || null : null; } catch {}
    }
    const own = conversationTitle(bridge, sid, profile, '');
    let title = own, agent = '';
    if (parent) {
      const parentTitle = conversationTitle(bridge, parentSid, profile, '');
      const label = oneLine(node.title || node.name, TITLE_MAX);
      if (parentTitle) title = parentTitle;
      if (label) agent = label;
    }
    return { title: title || fallbackAgent(profile), agent: agent ? this.agentLabel(profile, agent) : this.agentLabel(profile, '') };
  }
  /** Profile display name from the cached roster, else a friendly form of the id. Never the raw id 'default'. */
  profileName(profile) { return this.names.map.get(profile) || fallbackAgent(profile); }
  agentLabel(profile, child) {
    const name = this.profileName(profile);
    return oneLine(child && name ? `${child} \u00b7 ${name}` : child || name, TITLE_MAX);
  }
  /** Profile roster (display names) from the bridge, cached; one lookup in flight, short timeout, failures leave the old cache. */
  refreshNames(bridge) {
    if (!bridge?.profiles) return Promise.resolve();
    if (this.names.busy) return this.names.busy;
    if (this.names.map.size && Date.now() - this.names.at < NAMES_TTL) return Promise.resolve();
    this.names.busy = withTimeout(Promise.resolve(bridge.profiles()), LOOKUP_MS).then(rows => {
      const map = new Map();
      for (const row of Array.isArray(rows) ? rows : []) {
        const name = oneLine(row?.displayName, TITLE_MAX);
        if (typeof row?.name === 'string' && name) map.set(row.name, name);
      }
      this.names.map = map; this.names.at = Date.now();
    }).catch(() => { this.names.at = Date.now() - NAMES_TTL + 30000; }).finally(() => { this.names.busy = null; });
    return this.names.busy;
  }
  /** A done/reply item that arrived without text (a snapshot transition, an unbound new session): read the session's last assistant message. */
  enrich(device, id, item) {
    const finish = () => {
      const current = device.notifications.get(id);
      if (current) delete current.hold;
      try { this.persist(device); } catch {}
      this.flushPush().catch(() => {});
    };
    const bridge = device.bridge;
    const lookup = typeof bridge?.history === 'function'
      ? withTimeout(Promise.resolve(bridge.history(item.sid, { profile: item.profile, limit: 12, offset: 0 })), LOOKUP_MS) : Promise.reject(new Error('no history'));
    const wake = setTimeout(finish, this.settleMs + 25); wake.unref?.();
    lookup.then(result => {
      const current = device.notifications.get(id);
      if (!current || current.body) return;
      const messages = Array.isArray(result?.messages) ? result.messages : [];
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role !== 'assistant') continue;
        const text = notificationBody('reply', { text: messages[i].text });
        if (text) { current.body = text; break; }
      }
    }).catch(() => {}).then(() => { clearTimeout(wake); finish(); });
  }
  offers(device) {
    if (!device.offers) {
      const { FileOffers } = require('../../app/main/hermes-files');
      device.offers = new FileOffers();
    }
    return device.offers;
  }
  async call(device, message) {
    if (!message || typeof message.id !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(message.id)) throw fail('bad_request', 'Invalid request ID');
    const args = message.args ?? {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('bad_request', 'Invalid arguments');
    if (!Object.hasOwn(OPS, message.op)) throw fail('operation', 'Unsupported operation');
    if (Object.keys(args).some(key => !OPS[message.op].includes(key))) throw fail('bad_request', 'Unknown argument');
    const now = Date.now();
    device.receiptFloor = Math.max(device.receiptFloor, now - MUTATION_AGE);
    let expired = false;
    for (const id of device.ids) if (mutationTime(id) === null || mutationTime(id) <= device.receiptFloor) { device.ids.delete(id); expired = true; }
    if (expired) this.persist(device);
    if (!READ_OPS.has(message.op)) {
      const timestamp = mutationTime(message.id);
      if (timestamp === null) throw fail('bad_request', 'Mutation ID requires m.<Unix milliseconds>.<UUID>');
      if (timestamp <= device.receiptFloor) throw Object.assign(fail('expired_request', 'Request expired; refresh state before a new action'), { uncertain: true });
      if (timestamp > now + MUTATION_FUTURE) throw fail('clock_skew', 'Mutation timestamp is ahead of server time');
    }
    if (device.ids.has(message.id) || device.reads.has(message.id)) throw fail('duplicate', 'Request ID already used; refresh state before a new action');
    if (READ_OPS.has(message.op)) {
      if (device.reads.size >= 64) throw fail('limit', 'Too many active reads', 429);
      device.reads.add(message.id);
      try { return await this.dispatch(device, message.op, args); }
      finally { device.reads.delete(message.id); }
    }
    if (device.ids.size >= 10000) throw fail('limit', 'Mutation limit for the seven-day window reached; reads remain available', 429);
    device.ids.add(message.id);
    this.persist(device);
    return this.dispatch(device, message.op, args);
  }
  async dispatch(device, op, args) {
    const bridge = this.bridge(device);
    switch (op) {
      case 'plan': case 'toolCalls': case 'subagents': case 'subagentTail': case 'steerSubagent': case 'interruptSubagent': case 'commands': {
        // This allowlist crosses mobile -> runtime: validate here, before any bridge binding or request.
        if (typeof args.profile !== 'string' || !PROFILE_NAME.test(args.profile)) throw fail('bad_request', 'Explicit profile required');
        if (op === 'commands') return bridge.commandCatalog(args.profile);
        if (typeof args.sid !== 'string' || !/^[\x21-\x7e]{1,512}$/.test(args.sid)) throw fail('bad_request', 'Invalid session ID');
        const options = { profile: args.profile };
        if (['plan', 'toolCalls', 'subagents'].includes(op)) return bridge[op](args.sid, options);
        if (typeof args.id !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(args.id)) throw fail('bad_request', 'Invalid sub-agent ID');
        if (op === 'steerSubagent') {
          if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 32000) throw fail('bad_request', 'Invalid guidance text');
          return bridge.steerSubagent(args.sid, args.id, args.text, options);
        }
        return bridge[op](args.sid, args.id, options);
      }
      case 'sessions': return bridge.sessions(args);
      case 'sessionPage': case 'sessionIndex':
        if ('archived' in args && typeof args.archived !== 'boolean' || 'force' in args && typeof args.force !== 'boolean' || 'offset' in args && (!Number.isSafeInteger(args.offset) || args.offset < 0)) throw fail('bad_request', 'Invalid session index arguments');
        return bridge[op](args);
      case 'renameSession': case 'pinSession': case 'archiveSession': case 'branchSession': case 'discard': case 'setEffort': case 'takeover':
        if (!PROFILE_NAME.test(args.profile || '')) throw fail('bad_request', 'Explicit profile required');
        return bridge[op](args.sid, args);
      case 'reasoning':
        if (typeof args.show !== 'boolean') throw fail('bad_request', 'Invalid reasoning preference');
        return bridge.setReasoning(args.show);
      case 'history': {
        const result = await bridge.history(args.sid, args);
        const scope = JSON.stringify([args.profile || 'default', args.sid]);
        const offers = this.offers(device);
        const { projectMedia } = require('../../app/main/media-refs');
        for (const message of result.messages) {
          const files = offers.collect(scope, message);
          if (files.length) message.files = files;
          projectMedia(scope, message, offers);
        }
        return result;
      }
      case 'profiles': return bridge.profiles();
      case 'avatar': return bridge.avatar(args.name);
      case 'botChat': return bridge.botChat(args.name, args);
      case 'createBotChat': return bridge.createBotChat(args.name, args);
      case 'create': return bridge.create(args);
      case 'delete': return bridge.deleteSession(args.sid, args);
      case 'send': {
        const refs = args.uploads || [];
        if (!Array.isArray(refs) || refs.length > 10 || new Set(refs).size !== refs.length) throw fail('bad_request', 'Invalid uploads');
        if (!refs.length) return bridge.send(args.sid, args.text, { profile: args.profile, files: [] });
        // Staged (the plugin on this host takes spool ids): only ids travel, the plugin moves the files itself. Else the
        // old single-line path: each file read from the spool into base64, within the old limits.
        const staged = this.stagedReady();
        const ready = refs.map(id => this.upload(device, id));
        if (ready.some(item => item.state !== 'ready')) throw fail('not_ready', 'Upload incomplete');
        if (!staged && (ready.some(item => item.size > LIMITS.fileBytes) || ready.reduce((sum, item) => sum + item.size, 0) > LIMITS.totalBytes)) {
          throw fail('limit', 'Hermes on this host takes at most 25 MB per file; update the Hermes Deck plugin for larger files', 413);
        }
        const { items, release } = this.uploads.take(device, refs);
        try {
          if (staged) return await bridge.send(args.sid, args.text, { profile: args.profile, staged: items.map(item => ({ upload: item.id, filename: item.name })) });
          const files = items.map(item => ({ filename: item.name, content_base64: this.uploads.readBuffer(item, LIMITS.fileBytes).toString('base64') }));
          return await bridge.send(args.sid, args.text, { profile: args.profile, files });
        } catch (error) {
          if (staged && error?.rpcCode === -32601) this.staging = { ok: false, at: Date.now(), busy: null }; // an older plugin came back
          throw error;
        } finally { release(); }
      }
      case 'steer': case 'redirect': case 'interrupt': {
        if (typeof args.profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(args.profile)) throw fail('bad_request', 'Explicit control profile required');
        const node = bridge.nodeFor(args.sid, args.profile);
        if (!node || node.sid !== args.sid || node.profile !== args.profile) throw fail('bad_request', 'Live session profile does not match control target');
        return op === 'interrupt' ? bridge.interrupt(args.sid, args) : bridge[op](args.sid, args.text, args);
      }
      case 'modelOptions': return bridge.modelOptions(args.sid, args);
      case 'setModel': return bridge.setModel(args.sid, args);
      case 'answerApproval': case 'answerQuestion': {
        const requests = bridge.listRequests().filter(request => request.id === args.id);
        if (typeof args.profile !== 'string' || requests.length !== 1 || requests[0].profile !== args.profile) throw fail('bad_request', 'Open request profile is missing, mismatched or ambiguous');
        return op === 'answerApproval' ? bridge.answerApproval(args.id, args.choice, { profile: args.profile }) : bridge.answerQuestion(args.id, args.answers, { profile: args.profile });
      }
      case 'transcribe': {
        const item = this.upload(device, args.upload);
        if (item.state !== 'ready') throw fail('not_ready', 'Upload incomplete');
        if (args.mime !== undefined && args.mime !== item.mime) throw fail('bad_request', 'MIME mismatch');
        // Optional language hint from the dictation UI; an invalid tag is a client bug, not something to guess around.
        let language;
        if (args.language !== undefined && args.language !== null && args.language !== '') {
          language = typeof args.language === 'string' ? dictationLanguage(args.language) : null;
          if (!language) throw fail('bad_request', 'Invalid dictation language');
        }
        if (item.size > LIMITS.dictationBytes) throw fail('limit', 'Dictation clip too large', 413);
        // A clip (<= 25 MB) is read from the spool into memory; the spool entry is deleted when the call settles.
        const { items: [clip], release } = this.uploads.take(device, [item.id]);
        try { return await bridge.transcribe(this.uploads.readBuffer(clip, LIMITS.dictationBytes), clip.mime, language ? { language } : undefined); }
        finally { release(); }
      }
    }
  }
  /** A new upload ticket {id}: checked against the active limits (staged or old), the device's quota and the disk floor. */
  createUpload(device, args) {
    const item = this.uploads.create(device, args, this.limits());
    return { id: item.id };
  }
  upload(device, id) {
    if (!device?.uploads) throw fail('not_found', 'Upload missing or expired', 404);
    return this.uploads.get(device, id);
  }
  prune(device) {
    this.uploads.prune(device);
    for (const [id, item] of device.files) if (item.expires < Date.now()) device.files.delete(id);
    for (const [id, item] of device.notifications) if (item.expires < Date.now() && item.delivery !== 'pending') device.notifications.delete(id);
  }
  flushPush() {
    if (!this.push?.configured || this.pushStopped) return Promise.resolve();
    const registered = tokens.load(this.tokensFile).devices;
    for (const id of Object.keys(this.meta.devices)) if (!registered[id]) {
      this.meta.revocations[id] ||= opaque();
      delete this.meta.devices[id];
      privateWrite(this.metaFile, this.meta);
    }
    // Fresh round-robin admission: four globally, one operation per device. Completion refills slots.
    const ids = [...new Set([...Object.keys(this.meta.revocations), ...Object.keys(this.meta.devices)])];
    const start = this.pushCursor % Math.max(ids.length, 1);
    for (let offset = 0; offset < ids.length && this.pushTasks.size < 4; offset++) {
      const index = (start + offset) % ids.length, id = ids[index];
      if (this.devices.get(id)?.registrationBusy || this.pushTasks.has(id) || (this.pushRetryAt.get(id) || 0) > Date.now()) continue;
      const state = this.meta.devices[id];
      if (!this.meta.revocations[id] && !state?.pushRemoval && (state?.observePush !== true || !Object.values(state.notifications || {}).some(ready))) continue;
      this.pushCursor = (index + 1) % ids.length;
      const task = this.pushOne(id).then(() => { this.pushRetryAt.delete(id); }).catch(() => { this.pushRetryAt.set(id, Date.now() + 1000); }).finally(() => {
        this.pushTasks.delete(id);
        this.flushPush().catch(() => {});
      });
      this.pushTasks.set(id, task);
    }
    return Promise.allSettled([...this.pushTasks.values()]);
  }
  async pushOne(deviceId) {
    if (this.devices.get(deviceId)?.registrationBusy) return;
    const tombstone = this.meta.revocations[deviceId];
    if (tombstone) {
      await this.push.removeDevice(deviceId);
      // A late registration completion may have reasserted cleanup while this removal was in flight.
      if (this.meta.revocations[deviceId] === tombstone) {
        delete this.meta.revocations[deviceId];
        privateWrite(this.metaFile, this.meta);
      }
      return;
    }
    if (!tokens.load(this.tokensFile).devices[deviceId]) return;
    const state = this.meta.devices[deviceId];
    if (state?.pushRemoval) {
      const generation = state.pushRemoval, attempt = state.pushAttempt;
      await this.push.removeDevice(deviceId);
      const current = this.meta.devices[deviceId];
      if (current?.pushRemoval === generation) {
        current.pushRemoval = null;
        if (current.pushAttempt === attempt) current.pushAttempt = null;
        const device = this.devices.get(deviceId);
        if (device?.pushRemoval === generation) { device.pushRemoval = null; if (device.pushAttempt === attempt) device.pushAttempt = null; }
        privateWrite(this.metaFile, this.meta);
      }
      return;
    }
    if (state?.observePush !== true) return;
    const next = Object.entries(state?.notifications || {}).find(([, item]) => ready(item));
    if (!next) return;
    const [id, item] = next;
    let delivery = 'accepted';
    if (!PUSH_EVENT_ID.test(id) || item.expires <= Date.now()) delivery = 'expired';
    else {
      try { await this.push.notify(deviceId, { id, kind: item.kind }); }
      catch (error) { if (error.status === 410 && error.code === 'EVENT_EXPIRED') delivery = 'expired'; else throw error; }
    }
    if (this.meta.revocations[deviceId] || !tokens.load(this.tokensFile).devices[deviceId]) return;
    const current = this.meta.devices[deviceId]?.notifications?.[id];
    if (!current) return;
    current.delivery = delivery;
    const device = this.devices.get(deviceId);
    if (device?.notifications.has(id)) device.notifications.get(id).delivery = delivery;
    privateWrite(this.metaFile, this.meta);
  }
  async disablePush(device) {
    if (this.devices.get(device.id) !== device || !tokens.stillValid(this.tokensFile, device.id, device.hash)) throw fail('unauthorized', 'Device revoked', 401);
    device.observePush = false;
    if (!device.registrationBusy) device.pushAttempt = null;
    device.pushRemoval = opaque();
    this.persist(device);
    this.pushRetryAt.delete(device.id);
    this.flushPush().catch(() => {});
    const active = this.pushTasks.get(device.id);
    if (active) await active;
    if (device.observePush) throw fail('superseded', 'Push removal superseded by enable', 409);
    if (device.pushRemoval) throw fail('push_cleanup_pending', 'Push disabled locally; broker cleanup will retry', 503);
    return { ok: true };
  }
  async revoke(device) {
    this.meta.revocations[device.id] = opaque();
    delete this.meta.devices[device.id];
    let persistenceError;
    try { privateWrite(this.metaFile, this.meta); } catch (error) { persistenceError = error; }
    // Authorization is cut even if persisting the cleanup or contacting the gateway fails.
    tokens.revoke(this.tokensFile, device.id);
    for (const id of [...device.uploads.keys()]) this.uploads.remove(device, id); // its uploads go too, running ones aborted
    for (const ws of device.sockets) ws.terminate();
    if (!device.registrationBusy) this.devices.delete(device.id);
    await device.bridge?.stop();
    if (persistenceError) throw persistenceError;
    await this.flushPush();
    return { ok: true, revoked: true, pushCleanup: this.meta.revocations[device.id] ? 'pending' : 'complete' };
  }
  sweep() {
    this.ticks++;
    this.flushPush().catch(() => {});
    for (const device of this.devices.values()) {
      if (!tokens.stillValid(this.tokensFile, device.id, device.hash)) { if (!this.meta.revocations[device.id]) this.revoke(device).catch(() => {}); continue; }
      this.prune(device);
      if (this.ticks % 30 === 0) for (const ws of device.sockets) {
        if (!ws.mobileBridge) continue;
        if (ws.mobileAlive === false) ws.terminate();
        else { ws.mobileAlive = false; try { ws.ping(); } catch { ws.terminate(); } }
      }
    }
    for (const [key, attempt] of this.attempts) if (attempt.until < Date.now()) this.attempts.delete(key);
  }
  upgrade(req, socket, head, auth) {
    const device = this.device(auth.id);
    if (device.sockets.size >= 4) throw fail('limit', 'Too many device sockets', 429);
    this.wss.handleUpgrade(req, socket, head, ws => {
      ws.send(JSON.stringify({ t: 'hello', v: 2, serverTime: Date.now(), mutationIDs: 'timestamp-v1', mutationRetentionMs: MUTATION_AGE, mutationFutureMs: MUTATION_FUTURE }));
      device.sockets.add(ws);
      ws.mobileBridge = true;
      ws.mobileAlive = true;
      ws.on('pong', () => { ws.mobileAlive = true; });
      ws.on('close', () => device.sockets.delete(ws));
      ws.on('error', () => {});
      ws.on('message', async (data, binary) => {
        if (binary) return ws.close(1003);
        let message;
        try { message = JSON.parse(data); } catch { return ws.close(1007); }
        try {
          if (!tokens.stillValid(this.tokensFile, device.id, device.hash)) throw fail('unauthorized', 'Device revoked', 401);
          const result = await this.call(device, message);
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'response', id: message.id, ok: true, result }));
        } catch (error) {
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'response', id: message?.id, ok: false, error: { code: error.code || 'bridge_error', message: error.message, uncertain: error.uncertain === true || !error.code } }));
        }
      });
      try {
        const bridge = this.bridge(device);
        ws.send(JSON.stringify({ t: 'bridge', event: 'status', data: bridge.status }));
        if (bridge.snapshot) ws.send(JSON.stringify({ t: 'bridge', event: 'snapshot', data: bridge.snapshot }));
        ws.send(JSON.stringify({ t: 'bridge', event: 'requests', data: bridge.listRequests() }));
      } catch (error) { ws.send(JSON.stringify({ t: 'bridge', event: 'status', data: { status: 'off', error: error.message } })); }
    });
  }
  onHttp(req, res, url) {
    if (!url.pathname.startsWith('/mobile/')) return false;
    this.handle(req, res, url).catch(error => {
      if (res.headersSent) res.destroy();
      else { settleBody(req, res); json(res, error.status || 500, { error: { code: error.code || 'bridge_error', message: error.message, uncertain: error.uncertain === true || !error.code } }); }
    });
    return true;
  }
  async handle(req, res, url) {
    const route = url.pathname;
    if (route === '/mobile/pair' && req.method === 'POST') return json(res, 200, this.pair(await object(req), req.socket.remoteAddress));
    const auth = this.authenticate(req);
    if (!auth) throw fail('unauthorized', 'Mobile bearer required', 401);
    const device = this.device(auth.id);
    if (route === '/mobile/pair' && req.method === 'DELETE') return json(res, 200, await this.revoke(device));
    if (route === '/mobile/capabilities' && req.method === 'GET') {
      await this.probeStaging(device).catch(() => false);
      return json(res, 200, { ...this.capabilities(), notificationAdmission: { capacity: NOTIFICATION_CAPACITY, retained: device.notifications.size, overflow: device.notificationOverflow } });
    }
    if (route === '/mobile/uploads' && req.method === 'POST') {
      const args = await object(req);
      await this.probeStaging(device).catch(() => false); // which limits apply: staged (spool) or the old ones
      return json(res, 200, this.createUpload(device, args));
    }
    let match = /^\/mobile\/uploads\/([a-f0-9]{48})$/.exec(route);
    if (match) {
      const item = this.upload(device, match[1]);
      if (req.method === 'DELETE') { req.resume(); this.uploads.remove(device, item.id); return json(res, 200, { ok: true }); }
      if (req.method === 'PUT') {
        // Streamed to the spool on disk (never into memory); a size mismatch, cancel or revoke deletes it.
        await this.uploads.write(device, item, req, { stillValid: () => tokens.stillValid(this.tokensFile, device.id, device.hash) });
        return json(res, 200, { id: item.id, name: item.name, mime: item.mime, size: item.size });
      }
    }
    if (route === '/mobile/files/info' && req.method === 'POST') {
      const args = await object(req);
      if (Object.keys(args).some(key => !['sid', 'profile', 'ref'].includes(key))) throw fail('bad_request', 'Unknown argument');
      if (device.files.size >= 100) throw fail('limit', 'File ticket limit', 429);
      if (!PROFILE_NAME.test(args.profile || '')) throw fail('bad_request', 'Explicit profile required');
      const filePath = this.offers(device).pathOf(JSON.stringify([args.profile, args.sid]), args.ref);
      if (!filePath) throw fail('not_found', 'File reference unavailable; refresh history', 404);
      const bridge = this.bridge(device);
      await this.probeStaging(device).catch(() => false); // direct (deck.file_grant, streamed from disk) or chunk path
      let item = null;
      if (this.directReady() && typeof bridge.fileGrant === 'function') {
        try {
          const grant = await bridge.fileGrant(args.sid, filePath, { profile: args.profile });
          item = { size: grant.size, mtime: grant.mtime, grant: grant.id };
        } catch (error) {
          if (error?.rpcCode !== -32601) throw error; // a plugin without deck.file_grant after all: the chunk path
          this.staging.direct = 0;
        }
      }
      if (!item) {
        const first = await bridge.fileChunk(args.sid, filePath, { profile: args.profile, offset: 0, length: 1 });
        item = { size: first.size, mtime: first.mtime };
      }
      item = { id: opaque(), sid: args.sid, profile: args.profile, ref: filePath, ...item, name: path.basename(filePath), mime: 'application/octet-stream', expires: Date.now() + TTL };
      device.files.set(item.id, item);
      return json(res, 200, { id: item.id, name: item.name, mime: item.mime, size: item.size });
    }
    match = /^\/mobile\/files\/([a-f0-9]{48})$/.exec(route);
    if (match && req.method === 'GET') {
      const item = device.files.get(match[1]);
      if (!item || item.expires < Date.now()) throw fail('not_found', 'File ticket expired', 404);
      const bridge = this.bridge(device);
      if (item.grant) {
        // Streamed from disk by the relay (downloads.js), Range included; an expired plugin ticket is granted again
        // once, and must still name the same file (size and mtime).
        const stillValid = () => tokens.stillValid(this.tokensFile, device.id, device.hash);
        if (!stillValid()) throw fail('unauthorized', 'Device revoked', 401);
        const options = { name: item.name, mime: item.mime, stillValid };
        try {
          return await this.downloads.serve(req, res, item.grant, options);
        } catch (error) {
          if (res.headersSent || error.code !== 'not_found') throw error;
        }
        const grant = await bridge.fileGrant(item.sid, item.ref, { profile: item.profile });
        if (grant.size !== item.size || grant.mtime !== item.mtime) throw fail('changed', 'File changed', 409);
        item.grant = grant.id;
        return await this.downloads.serve(req, res, item.grant, options);
      }
      res.writeHead(200, { 'content-type': item.mime, 'content-length': item.size, 'cache-control': 'no-store' });
      let offset = 0;
      while (offset < item.size) {
        if (res.destroyed) return;
        if (!tokens.stillValid(this.tokensFile, device.id, device.hash)) throw fail('unauthorized', 'Device revoked', 401);
        const part = await bridge.fileChunk(item.sid, item.ref, { profile: item.profile, offset, length: Math.min(1048576, item.size - offset) });
        if (part.offset !== offset || part.size !== item.size || part.mtime !== item.mtime || !part.bytes.length) throw fail('changed', 'File changed');
        offset += part.bytes.length;
        if (!res.write(part.bytes)) await new Promise(resolve => { res.once('drain', resolve); res.once('close', resolve); });
      }
      return res.end();
    }
    if (route === '/mobile/push') {
      if (req.method === 'DELETE') return json(res, 200, await this.disablePush(device));
      if (req.method === 'PUT') {
        const registration = await object(req);
        if (typeof registration.enabled !== 'boolean') throw fail('bad_request', 'Expected registration enabled boolean');
        if (registration.enabled === false) return json(res, 200, await this.disablePush(device));
        if (!this.push?.configured) throw fail('unavailable', 'Push gateway not configured', 503);
        if (this.devices.get(device.id) !== device || !tokens.stillValid(this.tokensFile, device.id, device.hash)) throw fail('unauthorized', 'Device revoked', 401);
        if (device.registrationBusy) throw fail('busy', 'Push registration already in flight', 409);
        device.registrationBusy = true;
        try {
          const activeCleanup = this.pushTasks.get(device.id);
          let priorRemoval = device.pushRemoval;
          const attempt = device.pushAttempt = opaque();
          this.persist(device);
          // Already-running cleanup finishes before this explicit registration; queued old intent is superseded.
          if (activeCleanup) await activeCleanup;
          if (device.pushRemoval && device.pushRemoval !== priorRemoval) throw fail('superseded', 'Push registration superseded by opt-out', 409);
          priorRemoval = device.pushRemoval;
          if (this.devices.get(device.id) !== device || !tokens.stillValid(this.tokensFile, device.id, device.hash)) throw fail('unauthorized', 'Device revoked', 401);
          if (device.pushAttempt !== attempt) throw fail('superseded', 'Push registration superseded by newer intent', 409);
          let definitive = false;
          try {
            await this.push.setDevice(device.id, registration);
            if (Array.isArray(registration.kinds)) device.pushKinds = registration.kinds.filter(kind => typeof kind === 'string');
            if (device.pushAttempt === attempt && device.pushRemoval === priorRemoval && !this.meta.revocations[device.id]) {
              device.pushRemoval = null;
              device.observePush = true;
              device.pushAttempt = null;
            }
          } catch (error) {
            // These actual broker responses reject before INSERT; transport/5xx/ack parse failures are uncertain.
            definitive = [400, 401, 404, 413].includes(error.status) || (error.status === 429 && error.code === 'SENDER_QUOTA');
            if (definitive) {
              error.code ||= 'push_registration_rejected';
              error.uncertain = false;
              if (device.pushAttempt === attempt) device.pushAttempt = null;
            }
            if (!definitive && device.pushAttempt === attempt) {
              device.observePush = false;
              device.pushRemoval = opaque();
            }
            throw error;
          }
          finally {
            if (this.devices.get(device.id) !== device || !tokens.stillValid(this.tokensFile, device.id, device.hash) || this.meta.revocations[device.id]) {
              this.meta.revocations[device.id] = opaque();
              delete this.meta.devices[device.id];
              privateWrite(this.metaFile, this.meta);
              this.pushRetryAt.delete(device.id);
              this.flushPush().catch(() => {});
              throw fail('unauthorized', 'Device revoked; push cleanup queued', 401);
            }
            if (!definitive && !device.observePush && device.pushAttempt === null) {
              device.pushRemoval = opaque();
              this.persist(device);
              this.pushRetryAt.delete(device.id);
              this.flushPush().catch(() => {});
            }
            this.persist(device);
          }
          if (device.observePush && this.capabilities().bridge) this.bridge(device);
          return json(res, 200, { ok: true });
        } finally {
          device.registrationBusy = false;
          if (!tokens.stillValid(this.tokensFile, device.id, device.hash)) this.devices.delete(device.id);
          this.flushPush().catch(() => {});
        }
      }
    }
    match = /^\/mobile\/notifications\/(e_\d{13}_[a-f0-9]{48}|[a-f0-9]{48})$/.exec(route);
    if (match && req.method === 'GET') {
      const item = device.notifications.get(match[1]);
      if (!item || item.expires < Date.now()) throw fail('not_found', 'Notification expired', 404);
      // Extra fields only: older app builds read sid/profile/kind and ignore the rest.
      await this.refreshNames(device.bridge).catch(() => {});
      // Stored labels from before the roster was known (or older relay builds: the raw profile id) are resolved now.
      const plain = !item.agent || item.agent === item.profile || item.agent === fallbackAgent(item.profile);
      const agent = plain ? this.agentLabel(item.profile, '') : item.agent;
      return json(res, 200, { sid: item.sid, profile: item.profile, kind: item.kind, title: item.title || agent || fallbackAgent(item.profile), body: item.body || '', agent });
    }
    throw fail('not_found', 'Not found', 404);
  }
  async stop() {
    clearInterval(this.timer);
    this.pushStopped = true;
    if (this.ownSpool) this.uploads.stop();
    for (const device of this.devices.values()) { for (const ws of device.sockets) ws.terminate(); await device.bridge?.stop(); }
    await Promise.allSettled([...this.pushTasks.values()]);
    this.wss.close();
  }
}
module.exports = { MobileRelay, createPair, LIMITS, previewText, notificationBody, conversationTitle };
