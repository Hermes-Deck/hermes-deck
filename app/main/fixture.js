"use strict";
// Fixture mode for development screenshots:
//   npx electron . --shot=<png> --fixture=<json> --select=<key> [--scene=<name>] [--tab=<id>]
// Replays dialogs, messages, avatars, group members, media and a relay snapshot from a JSON file
// instead of connecting anywhere. Nothing here talks to Telegram or a relay; sending is refused.
// The file format is the renderer's own records (see app/test/fixtures/telegram.json).
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { safeName, writeAtomic } = require("./media");
const history = require("./history"); // sub-agent views: "…Ago" times, history routes, timed live pushes
const RX = require("../renderer/reactions"); // C9: the renderer's own toggle math, for in-memory reactions
const { t: i18nText } = require("../renderer/i18n"); // the same texts TelegramService uses, in the UI language

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+)(;base64)?,(.*)$/s;

function decode(v) {
  const src = typeof v === "string" ? v : v && v.data;
  const m = DATA_URL.exec(String(src || ""));
  if (!m) return null;
  return { mime: m[1], buf: m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8"), name: v && v.name };
}

/** The media record of a rich message's block with this ref (galleries, quotes, lists and details searched too). */
function richMedia(blocks, ref) {
  for (const b of blocks || []) {
    if (b.t === "media" && b.ref === ref) return b.media;
    const kids = [b.items && b.t === "gallery" ? b.items : null, b.blocks, ...(b.t === "ul" || b.t === "ol" ? (b.items || []).map((it) => it.blocks) : [])];
    for (const list of kids) {
      const hit = list && richMedia(list, ref);
      if (hit) return hit;
    }
  }
  return null;
}

class FixtureService extends EventEmitter {
  constructor(file, { mediaDir }) {
    super();
    this.file = file;
    this.data = JSON.parse(fs.readFileSync(file, "utf8"));
    this.mediaDir = path.join(mediaDir, "fixture");
    this.state = null;
    this.avatars = {};
    this.people = {};
  }

  async start() {
    const d = this.data;
    const dl = d.dialogs || {};
    this.me = d.me || null;
    this.state = { me: this.me, group: dl.group || null, bots: dl.bots || [], topics: dl.topics || [], forumGroups: dl.forumGroups || [] };
    for (const x of [...this.state.bots, ...this.state.topics]) if (x.last) x.last = this._msg(x.last, x.key);
    this.avatars = { ...(d.avatars || {}) };
    this.people = JSON.parse(JSON.stringify(d.people || {}));
    this.emit("dialogs", this.state);
    for (const [key, url] of Object.entries(this.avatars)) this.emit("avatar", { key, url });
    if (Object.keys(this.people).length) this.emit("people", this.people);
  }

  meInfo() {
    return this.me;
  }

  /** A record from the file; "ago" (seconds before now) keeps day labels on "Today" whenever it runs. */
  _msg(m, key) {
    const now = Math.floor(Date.now() / 1000);
    const date = m.ago !== undefined ? now - m.ago : m.date || now;
    const rec = { ...m, key, date };
    delete rec.ago;
    return rec;
  }

  async history(key) {
    return ((this.data.messages || {})[key] || []).map((m) => this._msg(m, key));
  }

  async send() {
    throw new Error(i18nText("U0223"));
  }

  /**
   * File attachments (A7): a pretend upload for screenshots. Progress ticks for `uploadMs` (the file
   * field "uploadMs", default 20 s) and honours cancel; nothing is read from disk or sent anywhere.
   * The result is an in-memory message (lost on restart).
   */
  async sendFile(key, file, { caption = "", progress = null } = {}) {
    const steps = 40;
    const ms = Number(this.data.uploadMs) || 20000;
    for (let i = 0; i <= steps; i++) {
      if (progress && progress.isCanceled) throw new Error("USER_CANCELED");
      if (progress) progress(i / steps);
      if (i < steps) await new Promise((r) => setTimeout(r, ms / steps));
    }
    const list = (this.data.messages = this.data.messages || {})[key] || (this.data.messages[key] = []);
    const id = Math.max(1000, ...list.map((m) => m.id)) + 1;
    if (file.buffer && file.mime && file.mime.startsWith("image/")) {
      const data = `data:${file.mime};base64,${file.buffer.toString("base64")}`;
      (this.data.media = this.data.media || {})[`${key}:${id}`] = { thumb: data, full: data };
    }
    const media = file.kind === "photo" ? { kind: "photo", size: file.size } : { kind: "file", name: file.name, size: file.size };
    const m = { id, ago: 0, out: true, fromId: this.me && this.me.id, from: this.me && this.me.name, text: caption, ents: [], media };
    list.push(m);
    return this._msg(m, key);
  }

  async sendAlbum(key, files, { caption = "", progress = null } = {}) {
    const out = [];
    for (const [i, f] of files.entries()) out.push(await this.sendFile(key, f, { caption: i ? "" : caption, progress }));
    return out;
  }

  /** ref: a rich message's photo/document ("p0", "d1"); its file sits under "<key>:<id>:<ref>" in "media". */
  async fetchMedia(key, id, variant, ref = null) {
    const entry = (this.data.media || {})[`${key}:${id}${ref ? `:${ref}` : ""}`] || {};
    const item = decode(entry[variant]);
    if (!item) throw new Error(i18nText(variant === "thumb" ? "U0224" : "U0225"));
    const msg = ((this.data.messages || {})[key] || []).find((m) => m.id === id) || {};
    const media = (ref ? richMedia(msg.rich && msg.rich.blocks, ref) : msg.media) || {};
    const name = safeName(item.name || media.name || `${media.kind || "file"}-${id}`);
    const file = path.join(this.mediaDir, `${key}-${id}${ref ? `-${ref}` : ""}-${variant}`, name);
    writeAtomic(file, item.buf);
    return { path: file, mime: item.mime, name, size: item.buf.length, kind: media.kind || null };
  }

  /** where "rich": a rich message's button row; its answer sits under "<key>:<id>:rich:<row>:<col>". */
  async callback(key, id, row, col, where = "kb") {
    const a = (this.data.callbacks || {})[`${key}:${id}:${where === "rich" ? "rich:" : ""}${row}:${col}`];
    return a || { message: i18nText("U0226") };
  }

  // --- reactions (C9), in memory only: "reactionChoices" per chat key (or "*"), "emoji" pictures by
  // document id, and "reactFail" message refs ("<key>:<id>") whose changes are refused (rollback scenes)
  async reactionChoices(key) {
    const c = this.data.reactionChoices || {};
    return c[key] || c["*"] || { list: [], max: 1 };
  }

  async react(key, id, keys) {
    if ((this.data.reactFail || []).includes(`${key}:${id}`)) throw new Error(i18nText("U0227"));
    const msg = ((this.data.messages || {})[key] || []).find((m) => m.id === id);
    if (!msg) throw new Error(i18nText("U0228"));
    const reactions = RX.applyMine(msg.reactions || null, keys, this.me && this.me.id);
    if (reactions) msg.reactions = reactions;
    else delete msg.reactions;
    this.emit("reactions", { key, id, reactions });
    return reactions;
  }

  async customEmoji(docId) {
    const item = decode((this.data.emoji || {})[docId]);
    if (!item) return null;
    const file = path.join(this.mediaDir, "emoji", `${safeName(String(docId))}.img`);
    writeAtomic(file, item.buf);
    return file;
  }

  // --- topic management, in memory only (same rules as TelegramService) -------------------------
  _canManage(del = false) {
    const g = this.state.group;
    if (!g || !g.canManage || (del && !g.canDelete)) throw new Error(i18nText("U0229"));
  }

  _topic(id) {
    const t = this.state.topics.find((x) => x.id === id);
    if (!t) throw new Error(i18nText("U0230"));
    return t;
  }

  _changed() {
    const t = this.state.topics;
    this.state.topics = [...t.filter((x) => x.pinned), ...t.filter((x) => !x.pinned)];
    this.emit("dialogs", this.state);
  }

  async createTopic(title, color) {
    this._canManage();
    const ids = [...this.state.topics.map((t) => t.id), ...Object.values(this.data.messages || {}).flat().map((m) => m.id)];
    const id = Math.max(100, ...ids) + 1;
    const key = `t${id}`;
    this.state.topics.push({ key, id, title, color, unread: 0, pinned: false, closed: false, last: null });
    this.data.messages = this.data.messages || {};
    this.data.messages[key] = [{ id, ago: 0, out: true, fromId: this.me && this.me.id, from: this.me && this.me.name, text: "", ents: [], media: null, service: i18nText("U0231", { v: (this.me && this.me.name) || i18nText("A0144"), title }) }];
    this._changed();
    return { key, id };
  }

  async editTopic(id, patch) {
    this._canManage();
    Object.assign(this._topic(id), patch);
    this._changed();
  }

  async pinTopic(id, pinned) {
    this._canManage();
    this._topic(id).pinned = pinned;
    this._changed();
  }

  async deleteTopic(id) {
    this._canManage(true);
    const t = this._topic(id);
    this.state.topics = this.state.topics.filter((x) => x !== t);
    delete (this.data.messages || {})[t.key];
    this._changed();
  }

  // C5 read receipts: nothing leaves fixture mode; the renderer's local badges are all there is
  markRead() {
    return false;
  }

  setReadReceipts() {}

  wakeReads() {}

  async stop() {}

  async logout() {}
}

/** Stands in for RelayClient: a fixed snapshot, re-sent whenever the renderer asks to resync. */
function fixtureHermesConfig() {
  const fields = {
    model: { type: "string", description: "Default model", category: "general", help: "The model new sessions start with, as provider/name. Leave empty to use the provider's own default.", default: "" },
    toolsets: { type: "list", description: "Toolsets", category: "general", help: "Tool bundles the agent may use. One name per line.", default: ["web", "terminal"] },
    timezone: { type: "string", description: "Timezone", category: "general", help: "IANA timezone, for example Europe/Berlin. Blank uses the system timezone.", default: "" },
    "agent.max_turns": { type: "string", description: "Agent → Max Turns", category: "agent", free: true, help: "Maximum tool-calling iterations per conversation. Higher = more room for complex tasks, but costs more tokens.", default: 90 },
    "agent.service_tier": { type: "select", description: "Fast mode", category: "agent", options: ["", "normal", "fast", "auto"], help: "Ask the provider for its faster, pricier tier when it has one.", default: "" },
    "agent.verbose": { type: "boolean", description: "Agent → Verbose", category: "agent", help: "Print every tool call and its result while the agent works.", default: false },
    "display.compact": { type: "boolean", description: "Display → Compact", category: "display", help: "Use a tighter layout with less spacing between messages and tool output.", default: false },
    "display.show_reasoning": { type: "boolean", description: "Display → Show Reasoning", category: "display", help: "Show the model's reasoning text above each answer when the provider returns it.", default: false },
    "delegation.max_iterations": { type: "number", description: "Delegation → Max Iterations", category: "delegation", help: "Max tool-calling turns per child agent (default: 250)", default: 250 },
    "delegation.max_concurrent_children": { type: "number", description: "Delegation → Max Concurrent Children", category: "delegation", help: "Max parallel child agents per batch. Values above 10 multiply API cost linearly.", default: 10 },
    "auxiliary.vision.model": { type: "string", description: "Auxiliary → Vision → Model", category: "auxiliary", help: "Model used to look at images. Empty: the main model if it can see, else the provider's default.", default: "" },
    "auxiliary.vision.timeout": { type: "number", description: "Auxiliary → Vision → Timeout", category: "auxiliary", help: "Seconds to wait for an image analysis before giving up.", default: 120 },
    "auxiliary.compression.model": { type: "string", description: "Auxiliary → Compression → Model", category: "auxiliary", help: "Model that writes the summary when a long conversation is compressed.", default: "" },
    "auxiliary.compression.timeout": { type: "number", description: "Auxiliary → Compression → Timeout", category: "auxiliary", help: "Seconds to wait for a summary before giving up.", default: 120 },
  };
  const values = {
    model: "example-model", toolsets: ["web", "terminal"], timezone: "", "agent.max_turns": 60, "agent.service_tier": "", "agent.verbose": false,
    "display.compact": true, "display.show_reasoning": false, "delegation.max_iterations": 250, "delegation.max_concurrent_children": 4,
    "auxiliary.vision.model": "", "auxiliary.vision.timeout": 120, "auxiliary.compression.model": "", "auxiliary.compression.timeout": 120,
  };
  return { fields, values, explicit: ["model", "agent.max_turns", "display.compact", "delegation.max_concurrent_children"] };
}

class FixtureRelay extends EventEmitter {
  constructor(snapshot) {
    super();
    this.snapshot = history.fixtureData(snapshot) || null; // sub-agent views: absolute times, agent counts
  }

  start() {
    this.emit("status", this.snapshot ? { status: "open" } : { status: "unconfigured" });
    if (this.snapshot) this.stopLive = history.fixtureLive(this.snapshot, (m) => this.emit("msg", m)); // timed "evs" pushes
  }

  resync() {
    if (this.snapshot) this.emit("msg", { t: "snapshot", agents: {}, sessions: [], fleet: null, tokens: [], ...this.snapshot });
  }

  async get(p) {
    const r = history.fixtureGet(this.snapshot, p); // sub-agent views: the history routes from the file
    if (r !== undefined) return r;
    return String(p).startsWith("/tokens") ? (this.snapshot && this.snapshot.tokens) || [] : { recent: [] };
  }

  async post(p) {
    return String(p) === "/fleet/quotas/refresh" ? { ok: true, refreshed: true, throttled: false, timedOut: false, retryAfterS: 0, quotas: {}, profiles: {} } : {};
  }

  /** Settings > Hermes config: a small synthetic schema and config (no real Hermes), for --tab=settings:hermescfg. */
  async call(method, p, body) {
    if (!this.snapshot) return { status: 404, body: {} };
    const f = (this.hcfg ||= fixtureHermesConfig());
    const route = String(p).split("?")[0];
    if (route === "/hermes/config/schema") return { status: 200, body: { ok: true, fields: f.fields, categoryOrder: ["general", "agent", "display", "delegation", "auxiliary"], profiles: ["default", "scout"] } };
    if (route === "/hermes/config" && method === "GET") return { status: 200, body: { ok: true, profile: "default", rev: "0".repeat(64), values: f.values, explicit: f.explicit, managed: false, restartNeeded: false } };
    if (route === "/hermes/config") return { status: 200, body: { ok: true, profile: body.profile, rev: "1".repeat(64), values: { ...f.values, ...body.set }, explicit: f.explicit, saved: Object.keys(body.set), backup: "config.yaml.bak-deck-fixture" } };
    if (route === "/hermes/restart") return { status: method === "POST" ? 202 : 200, body: { ok: true, gateway: null, relay: { startedAt: 1, supervised: true }, restartNeeded: false } };
    return { status: 404, body: {} };
  }

  stop() {
    if (this.stopLive) this.stopLive();
  }
}

module.exports = { FixtureService, FixtureRelay };
