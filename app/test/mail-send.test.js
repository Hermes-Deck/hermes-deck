"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { BridgeClient, checkRequest } = require("../main/bridge");
const { MailDrafts } = require("../main/mail-drafts");
const UI = require("../renderer/mail-drafts");
const { dom } = require("./inbox-dom-helper");
const { t } = require("../renderer/i18n");
const account = "sender@example.com", scope = "scope_" + "x".repeat(30), ticket = "dc_" + "y".repeat(32);
const fields = { from: account, to: ["reader@example.com"], cc: ["copy@example.com"], bcc: ["private@example.com"], subject: "Exact subject", body: "Exact body\nğ 🌍 <script>" };
function fixture() {
  let calls = 0;
  const b = { epoch: 1, conn: { closed: false }, value: { id: "d_0123abcd", kind: "email", platform: "Gmail", session_id: "session", status: "draft", status_detail: "", latest_version: 2, latest_card: 1,
    versions: [{ v: 2, card: 1, fields: structuredClone(fields) }], send_protocol: 1 },
    async request(method, p) {
      checkRequest(method, p);
      if (method === "deck.draft_get") return structuredClone(b.value);
      if (method === "deck.draft_sender") return { account, scope, draft_send_protocol: 1 };
      if (method === "deck.draft_prepare") return { scope, confirmationToken: ticket, expiresAt: Date.now() / 1000 + 300,
        preview: { action: "draft-send", draftId: b.value.id, version: b.value.latest_version, account, fields: structuredClone(b.value.versions[0].fields) } };
      if (method === "deck.draft_commit") { calls++; b.value.status = "sent";
        b.value.send_receipt = { state: "sent", version: 2, account, provider_id: "synthetic_1" }; return { status: "verified" }; }
      throw Error("Unexpected method " + method);
    } };
  const m = new MailDrafts(b);
  return { b, m, calls: () => calls };
}
async function prepare(m) {
  const reviewed = await m.get("default", "d_0123abcd");
  const sender = await m.act(reviewed.review, "sender");
  return m.act(sender.review, "prepare");
}
test("mail send requires final exact-version confirmation; backend token stays in main", async () => {
  const { m, calls } = fixture();
  const r = await prepare(m);
  assert.equal(r.account, account); assert.equal(r.prepared, true);
  assert.equal(JSON.stringify(r).includes(ticket), false);
  await assert.rejects(m.act(r.review, "send", 1));
  assert.equal(calls(), 0);
  const sending = m.act(r.review, "send", true);
  await assert.rejects(m.act(r.review, "send", true));
  assert.equal((await sending).record.send_receipt.provider_id, "synthetic_1");
  await assert.rejects(m.act(r.review, "send", true));
  assert.equal(calls(), 1);
});
test("all reviewed fields, host identity and reconnect fence final send", async () => {
  for (const field of Object.keys(fields)) {
    const { b, m, calls } = fixture(), r = await prepare(m);
    b.value.versions[0].fields[field] = Array.isArray(fields[field]) ? ["changed@example.com"] : "changed";
    await assert.rejects(m.act(r.review, "send", true)); assert.equal(calls(), 0);
  }
  const { b, m, calls } = fixture(), r = await prepare(m);
  await assert.rejects(fixture().m.act(r.review, "send", true));
  b.epoch++;
  await assert.rejects(m.act(r.review, "send", true)); assert.equal(calls(), 0);
});
test("uncertain send consumes the review and never replays", async () => {
  const { b, m } = fixture(), r = await prepare(m), original = b.request;
  let sends = 0;
  b.request = async (method, p) => { if (method === "deck.draft_commit") { sends++; throw Error("Outcome unknown"); } return original(method, p); };
  await assert.rejects(m.act(r.review, "send", true));
  b.epoch++;
  await assert.rejects(m.act(r.review, "send", true));
  assert.equal(sends, 1);
});
test("named send bridge schema rejects forged state, omitted version and implicit consent", () => {
  const good = { profile: "default", id: "d_0123abcd", version: 2, scope, confirmationToken: ticket, confirmed: true };
  checkRequest("deck.draft_commit", good);
  for (const bad of [{ ...good, confirmed: 1 }, { ...good, version: undefined }, { ...good, status: "sent" }, { ...good, scope: {} }])
    assert.throws(() => checkRequest("deck.draft_commit", bad));
});
test("native producer + Gmail API + Deck UI reaches persisted synthetic receipt", { skip: !process.env.DECK_TEST_MAIL_FIXTURE }, async ctx => {
  const bridge = new BridgeClient({ mode: "local", python: "/usr/bin/python3", stream: "/fixture" }, {
    launch: { file: "python3", args: [process.env.DECK_TEST_MAIL_FIXTURE, "--rpc"] },
    timing: { handshake: 30000, heartbeat: 60000, request: 60000, keepalive: 60000 },
  });
  ctx.after(() => bridge.stop());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("native fixture handshake")), 30000);
    bridge.on("status", s => { if (s.status === "open") { clearTimeout(timer); resolve(); } }); bridge.start();
  });
  const mail = bridge.mailDrafts(), { h, doc, walk } = dom();
  const view = UI.create({ h, doc, t, deck: { bridge: {
    draftsList: (...a) => mail.list(...a), draftGet: (...a) => mail.get(...a), draftAct: (...a) => mail.act(...a),
    profiles: async () => [{ name: "default" }],
  }, settingsGet: async () => ({ activeHost: "synthetic", hosts: [{ id: "synthetic", name: "Synthetic host" }] }) } });
  await view.ready; await view.load(); await view.open("d_0123abcd");
  const body = walk(view.root).find(n => n.dataset?.fk === "mail:body");
  body.attrs.oninput({ target: { value: "Reviewed version 2\nğ 🌍 <script>" } });
  assert.equal(await view.act("edit", view.state().form.fields), true);
  assert.equal(view.state().record.latest_version, 2); assert.equal(view.state().record.latest_card, 1);
  assert.equal(await view.act("send", true), false);
  await walk(view.root).find(n => n.dataset?.fk === "mail.sender").attrs.onclick();
  assert.equal(view.state().account, account);
  await walk(view.root).find(n => n.dataset?.fk === "mail.prepare").attrs.onclick();
  assert.equal(view.state().prepared, true);
  assert.equal(walk(view.root).find(n => n.dataset?.fk === "mail:body").attrs.readOnly, true);
  const confirmation = view.state().review;
  await walk(view.root).find(n => n.dataset?.fk === "mail.confirmSend").attrs.onclick();
  assert.equal(view.state().record.status, "sent", view.state().error);
  assert.equal(view.state().record.send_receipt.provider_id, "synthetic_1");
  assert.equal(view.state().record.send_receipt.version, 2);
  assert.equal(view.state().record.send_receipt.account, account);
  await assert.rejects(mail.act(confirmation, "send", true));
  await view.load();
  assert.equal(view.state().record.send_receipt.provider_id, "synthetic_1");
  assert.equal(walk(view.root).some(n => n.tag === "script"), false);
});
