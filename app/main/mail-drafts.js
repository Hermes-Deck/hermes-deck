"use strict";
// Only protocol-capable Draft Cards + Gmail can send. Credentials never cross IPC.
const { randomUUID } = require("node:crypto");
const { t } = require("../renderer/i18n");
const ID = /^d_[0-9a-f]{8}$/;
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SCOPE = /^[A-Za-z0-9_-]{20,256}$/;
const FIELDS = { from: 320, to: 16050, cc: 16050, bcc: 16050, subject: 300, body: 20000 };
const plain = x => !!x && typeof x === "object" && !Array.isArray(x);
const keys = (x, names) => plain(x) && Object.keys(x).length === names.length && names.every(k => Object.hasOwn(x, k));
const integer = x => Number.isSafeInteger(x) && x > 0;
function validFields(fields) {
  return keys(fields, Object.keys(FIELDS)) && Object.entries(fields).every(([k, v]) => typeof v === "string" && [...v].length <= FIELDS[k]);
}
function validRequest(method, p) {
  if (!plain(p) || typeof p.profile !== "string" || !PROFILE.test(p.profile)) return false;
  if (method === "deck.drafts_list") return keys(p, ["profile", "offset"]) && Number.isSafeInteger(p.offset) && p.offset >= 0 && p.offset <= 100000;
  if (typeof p.id !== "string" || !ID.test(p.id)) return false;
  if (method === "deck.draft_get") return keys(p, ["profile", "id"]);
  if (method === "deck.draft_sender") return keys(p, ["profile", "id"]);
  if (method === "deck.draft_prepare") return keys(p, ["profile", "id", "version", "scope"]) && integer(p.version) && typeof p.scope === "string" && SCOPE.test(p.scope);
  if (method === "deck.draft_commit") return keys(p, ["profile", "id", "version", "scope", "confirmationToken", "confirmed"])
    && integer(p.version) && typeof p.scope === "string" && SCOPE.test(p.scope) && typeof p.confirmationToken === "string"
    && /^dc_[A-Za-z0-9_-]{20,100}$/.test(p.confirmationToken) && p.confirmed === true;
  return method === "deck.draft_edit" && keys(p, ["profile", "id", "base_version", "card", "fields"])
    && integer(p.base_version) && integer(p.card) && validFields(p.fields);
}
function projectRecord(r) {
  if (!plain(r) || !ID.test(r.id) || r.kind !== "email" || !integer(r.latest_version) || !integer(r.latest_card)
    || !["draft", "approved", "sent", "saved", "failed", "discarded", "unknown"].includes(r.status)
    || typeof r.platform !== "string" || r.platform.length > 40 || typeof r.session_id !== "string" || r.session_id.length > 512
    || typeof r.status_detail !== "string" || r.status_detail.length > 280
    || !Array.isArray(r.versions) || !r.versions.length || r.versions.length > 2) throw new Error(t("mail.invalid"));
  const versions = r.versions.map(v => {
    if (!plain(v) || !integer(v.v) || !integer(v.card) || !plain(v.fields)) throw new Error(t("mail.invalid"));
    const fields = {};
    for (const [k, max] of Object.entries(FIELDS)) {
      const value = v.fields[k];
      if (["to", "cc", "bcc"].includes(k)) {
        if (!Array.isArray(value) || value.length > 50 || value.some(x => typeof x !== "string" || [...x].length > 320)) throw new Error(t("mail.invalid"));
        fields[k] = [...value];
      } else {
        if (typeof value !== "string" || [...value].length > max) throw new Error(t("mail.invalid"));
        fields[k] = value;
      }
    }
    return { v: v.v, card: v.card, fields };
  });
  if (versions.at(-1).v !== r.latest_version || (versions.length === 2 && versions[0].v >= versions[1].v)) throw new Error(t("mail.invalid"));
  let receipt = null;
  if (r.send_protocol === 1 && r.send_receipt != null) {
    const s = r.send_receipt;
    if (!plain(s) || !integer(s.version) || typeof s.account !== "string" || s.account.length > 320
      || !["sent", "unknown", "failed"].includes(s.state) || typeof s.provider_id !== "string"
      || (s.provider_id && !/^[A-Za-z0-9_-]{1,256}$/.test(s.provider_id)) || (s.state === "sent" && !s.provider_id)) throw Error(t("mail.invalid"));
    receipt = { version: s.version, account: s.account, state: s.state, provider_id: s.provider_id };
  }
  return { id: r.id, kind: "email", platform: r.platform, session_id: r.session_id, status: r.status,
    send_protocol: r.send_protocol === 1 ? 1 : null, send_receipt: receipt,
    status_detail: r.status_detail, latest_version: r.latest_version, latest_card: r.latest_card, versions };
}
class MailDrafts {
  constructor(bridge) { this.bridge = bridge; this.reviews = new Map(); this.busy = new Set(); }
  current(epoch, conn) { if (this.bridge.epoch !== epoch || this.bridge.conn !== conn || !conn || conn.closed) throw new Error(t("mail.refreshNeeded")); }
  async list(profile, offset = 0) {
    const b = this.bridge, epoch = b.epoch, conn = b.conn;
    const r = await b.request("deck.drafts_list", { profile, offset });
    this.current(epoch, conn);
    if (!plain(r) || !Array.isArray(r.drafts) || r.drafts.length > 20 || r.drafts.some(x => typeof x !== "string" || !ID.test(x)) || typeof r.has_more !== "boolean") throw new Error(t("mail.invalid"));
    if (new Set(r.drafts).size !== r.drafts.length || (r.has_more && r.drafts.length !== 20)) throw new Error(t("mail.invalid"));
    return { drafts: r.drafts, has_more: r.has_more, send_available: false };
  }
  async get(profile, id) {
    const b = this.bridge, epoch = b.epoch, conn = b.conn;
    const record = projectRecord(await b.request("deck.draft_get", { profile, id }));
    this.current(epoch, conn);
    if (record.id !== id) throw new Error(t("mail.invalid"));
    return this.issue(profile, record, epoch, conn);
  }
  issue(profile, record, epoch, conn, extra = {}) {
    const key = JSON.stringify([profile, record.id]);
    for (const [token, r] of this.reviews) if (r.key === key || r.epoch !== epoch) this.reviews.delete(token);
    const review = randomUUID();
    this.reviews.set(review, { profile, record, key, epoch, conn, ...extra });
    while (this.reviews.size > 40) this.reviews.delete(this.reviews.keys().next().value);
    return { record, review, account: extra.account || null, prepared: !!extra.ticket };
  }
  async act(review, action, value) {
    const r = this.reviews.get(review), b = this.bridge;
    if (!r || this.busy.has(r.key)) throw new Error(t("mail.refreshNeeded"));
    this.current(r.epoch, r.conn);
    if (!["draft", "failed", "approved"].includes(r.record.status)) throw new Error(t("mail.refreshNeeded"));
    if (action === "edit" ? !validFields(value) : action === "revise" ? typeof value !== "string" || !value.trim() || value.length > 4000
      : !["sender", "prepare", "send"].includes(action) || (action === "send" ? value !== true : value != null)) throw new Error(t("mail.invalid"));
    if (["sender", "prepare", "send"].includes(action) && (r.record.send_protocol !== 1
      || (action !== "sender" && (!r.scope || !r.account)) || (action === "send" && (!r.ticket || r.expires <= Date.now() / 1000)))) throw Error(t("mail.refreshNeeded"));
    // One attempt per reviewed snapshot, including unknown outcomes. Explicit refresh is required afterwards.
    this.reviews.delete(review); this.busy.add(r.key);
    try {
      const fresh = projectRecord(await b.request("deck.draft_get", { profile: r.profile, id: r.record.id }));
      this.current(r.epoch, r.conn);
      if (JSON.stringify(fresh) !== JSON.stringify(r.record)) throw new Error(t("mail.refreshNeeded"));
      if (action === "sender") {
        const sender = await b.request("deck.draft_sender", { profile: r.profile, id: fresh.id });
        this.current(r.epoch, r.conn);
        if (!plain(sender) || sender.draft_send_protocol !== 1 || typeof sender.scope !== "string" || !SCOPE.test(sender.scope)
          || typeof sender.account !== "string" || !/^[^\s<>@]+@[^\s<>@]+$/.test(sender.account) || sender.account.length > 320) throw Error(t("mail.invalid"));
        return this.issue(r.profile, fresh, r.epoch, r.conn, { account: sender.account, scope: sender.scope });
      }
      if (action === "prepare") {
        const ticket = await b.request("deck.draft_prepare", { profile: r.profile, id: fresh.id, version: fresh.latest_version, scope: r.scope });
        this.current(r.epoch, r.conn);
        const p = ticket?.preview;
        if (!plain(p) || p.action !== "draft-send" || p.draftId !== fresh.id || p.version !== fresh.latest_version || p.account !== r.account
          || ticket.scope !== r.scope || typeof ticket.confirmationToken !== "string" || !/^dc_[A-Za-z0-9_-]{20,100}$/.test(ticket.confirmationToken)
          || !Number.isFinite(ticket.expiresAt) || !Object.keys(FIELDS).every(k => JSON.stringify(p.fields?.[k]) === JSON.stringify(fresh.versions.at(-1).fields[k]))) throw Error(t("mail.invalid"));
        return this.issue(r.profile, fresh, r.epoch, r.conn, { account: r.account, scope: r.scope, ticket: ticket.confirmationToken, expires: ticket.expiresAt });
      }
      if (action === "send") {
        await b.request("deck.draft_commit", { profile: r.profile, id: fresh.id, version: fresh.latest_version,
          scope: r.scope, confirmationToken: r.ticket, confirmed: true });
        this.current(r.epoch, r.conn);
        const result = await this.get(r.profile, fresh.id);
        if (result.record.status !== "sent" || result.record.send_receipt?.state !== "sent"
          || result.record.send_receipt.version !== fresh.latest_version || result.record.send_receipt.account !== r.account) throw Error(t("mail.unknown"));
        return result;
      }
      if (action === "edit") {
        await b.request("deck.draft_edit", { profile: r.profile, id: fresh.id, base_version: fresh.latest_version,
          card: fresh.versions.at(-1).card, fields: value });
        this.current(r.epoch, r.conn);
        return await this.get(r.profile, fresh.id); // read back normalized producer state, never optimistic editor text
      }
      if (!/^[\x21-\x7e]{1,512}$/.test(fresh.session_id)) throw new Error(t("mail.noSession"));
      const rpcId = await b._bind(fresh.session_id, r.profile);
      this.current(r.epoch, r.conn);
      const response = await b.request("prompt.submit", { session_id: rpcId,
        text: `Revise Draft Cards draft ${fresh.id}, based on version ${fresh.latest_version}. This is a revision request only, NOT approval to send. Keep it as a draft for review.\n\n${value}` });
      this.current(r.epoch, r.conn);
      if (!plain(response) || !["streaming", "queued"].includes(response.status)) throw new Error(t("mail.unknown"));
      return { requested: true };
    } finally { this.busy.delete(r.key); }
  }
}
module.exports = { MailDrafts, validRequest, validFields, projectRecord };
