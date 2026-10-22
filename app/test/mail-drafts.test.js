"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { BridgeClient, checkRequest } = require("../main/bridge");
const { MailDrafts } = require("../main/mail-drafts");
const UI = require("../renderer/mail-drafts");
const { dom } = require("./inbox-dom-helper");
const { t } = require("../renderer/i18n");
const fields = { from: "sender@example.com", to: ["reader@example.com"], cc: [], bcc: ["private@example.com"], subject: "Test", body: "Exact <script>text</script>\nğ 🌍" };
const record = () => ({ id: "d_0123abcd", kind: "email", platform: "Mail", session_id: "session", status: "draft", status_detail: "", latest_version: 2, latest_card: 1,
  versions: [{ v: 1, card: 1, fields: { ...fields, subject: "First" } }, { v: 2, card: 1, fields }] });
const editFields = r => Object.fromEntries(Object.entries(r.versions.at(-1).fields).map(([k, v]) => [k, Array.isArray(v) ? v.join("\n") : v]));
function fake() {
  const calls = [], b = { epoch: 1, conn: { closed: false }, value: record(),
    async request(method, params) { calls.push({ method, params }); if (method === "deck.draft_get") return structuredClone(b.value); if (method === "prompt.submit") return { status: "streaming" }; throw Error("not implemented"); },
    async _bind(id, profile) { calls.push({ bind: id, profile }); return "runtime"; } };
  return { b, calls, m: new MailDrafts(b) };
}
test("draft review tokens bind profile, exact content and connection; no send or arbitrary operation", async () => {
  const { b, calls, m } = fake();
  for (const method of ["deck.draft_send", "deck.draft_approve", "deck.draft_state"]) assert.throws(() => checkRequest(method, {}));
  assert.throws(() => checkRequest("deck.draft_get", { profile: "../default", id: "d_0123abcd" }));
  assert.throws(() => checkRequest("deck.draft_edit", { profile: "default", id: "d_0123abcd", base_version: 2, card: 1, fields: { ...editFields(record()), account: "invented" } }));
  let r = await m.get("other", "d_0123abcd");
  await assert.rejects(m.act(r.review, "approve", {}));
  for (const key of ["from", "to", "bcc", "body"]) {
    r = await m.get("other", "d_0123abcd");
    const changed = structuredClone(b.value);
    changed.versions.at(-1).fields[key] = key === "to" || key === "bcc" ? ["changed@example.com"] : "changed";
    b.value = changed;
    await assert.rejects(m.act(r.review, "revise", "Make it shorter"));
  }
  assert.equal(calls.filter(c => c.method === "prompt.submit").length, 0);
  r = await m.get("other", "d_0123abcd");
  b.epoch++;
  await assert.rejects(m.act(r.review, "revise", "Shorter"));
  const anotherHost = fake();
  await assert.rejects(anotherHost.m.act(r.review, "revise", "Shorter"));
});
test("revision reaches only captured originating session once, without approving anything", async () => {
  const { m, calls } = fake(), r = await m.get("other", "d_0123abcd");
  const first = m.act(r.review, "revise", "Make the body shorter");
  await assert.rejects(m.act(r.review, "revise", "Duplicate"));
  assert.deepEqual(await first, { requested: true });
  const submit = calls.find(c => c.method === "prompt.submit");
  assert.match(submit.params.text, /version 2/);
  assert.match(submit.params.text, /NOT approval to send/);
  assert.equal(submit.params.session_id, "runtime");
  assert.deepEqual(calls.find(c => c.bind), { bind: "session", profile: "other" });
  await assert.rejects(m.act(r.review, "revise", "Replay"));
});
test("unknown outcomes consume review and never replay on reconnect", async () => {
  const { b, m } = fake(), r = await m.get("default", "d_0123abcd");
  const original = b.request;
  let submits = 0;
  b.request = async (method, p) => { if (method === "prompt.submit") { submits++; throw Error("connection lost; outcome unknown"); } return original(method, p); };
  await assert.rejects(m.act(r.review, "revise", "Shorter"), /outcome unknown/);
  b.epoch++;
  await assert.rejects(m.act(r.review, "revise", "Shorter"));
  assert.equal(submits, 1);
});
test("invalid pagination and duplicate identities fail closed", async () => {
  const { b, m } = fake();
  for (const page of [{ drafts: ["d_0123abcd", "d_0123abcd"], has_more: false }, { drafts: [], has_more: true }]) {
    b.request = async () => page;
    await assert.rejects(m.list("default"));
  }
});
test("actual pinned producer → Python adapter → stdio BridgeClient → UI → producer edit/readback", async ctx => {
  const fixture = path.resolve(__dirname, "../../hermes-plugin/hermes-deck/test_drafts.py");
  const b = new BridgeClient({ mode: "local", python: "/usr/bin/python3", stream: "/fixture" }, {
    launch: { file: process.env.DECK_TEST_PYTHON || "python3", args: ["-X", "utf8", fixture, "--rpc"] },
    timing: { handshake: 10000, heartbeat: 60000, request: 10000, keepalive: 60000 },
  });
  ctx.after(() => b.stop());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("synthetic producer handshake failed")), 10000);
    b.on("status", st => { if (st.status === "open") { clearTimeout(timer); resolve(); } }); b.start();
  });
  const m = b.mailDrafts(), page = await m.list("default", 0);
  assert.equal(page.drafts.length, 1); assert.equal(page.send_available, false);
  const { h, doc, walk } = dom();
  const view = UI.create({ h, doc, t, deck: { bridge: {
    draftsList: (...args) => m.list(...args), draftGet: (...args) => m.get(...args), draftAct: (...args) => m.act(...args),
    profiles: async () => [{ name: "default" }],
  }, settingsGet: async () => ({ activeHost: "fixture", hosts: [{ id: "fixture", name: "Synthetic host" }] }) } });
  await view.ready; await view.load(); await view.open(page.drafts[0]);
  assert.equal(view.state().record.latest_version, 1);
  // app.h sets attributes, not DOM properties: textarea initial content must be a text child.
  const bodyInput = walk(view.root).find(n => n.dataset?.fk === "mail:body");
  assert.equal(bodyInput.attrs.value, undefined);
  assert.equal(bodyInput.children.join(""), view.state().record.versions.at(-1).fields.body);
  for (const [key, value] of Object.entries({ from: "edited@example.com", to: "changed@example.com", bcc: "hidden@example.com", body: "Edited exact body\nğ 🌍 <script>" })) {
    walk(view.root).find(n => n.dataset?.fk === `mail:${key}`).attrs.oninput({ target: { value } });
  }
  assert.equal(view.hasUnsaved(), true);
  const buffer = view.state().form.fields;
  assert.equal(await view.act("edit", buffer), true);
  assert.equal(view.hasUnsaved(), false);
  assert.equal(view.state().record.latest_version, 2);
  assert.equal(view.state().record.latest_card, 1);
  assert.equal(view.state().record.versions.at(-1).fields.body, buffer.body);
  assert.deepEqual(view.state().record.versions.at(-1).fields.bcc, ["hidden@example.com"]);
  assert.ok(walk(view.root).some(n => n.tag === "details"));
  assert.ok(walk(view.root).find(n => n.tag === "button" && n.children.includes(t("mail.approveUnavailable"))).attrs.disabled);
  // A newer agent/user version may not replace or silently rebase an unsaved buffer.
  walk(view.root).find(n => n.dataset?.fk === "mail:body").attrs.oninput({ target: { value: "Unsubmitted buffer" } });
  const r = await m.get("default", page.drafts[0]);
  await m.act(r.review, "edit", { ...editFields(r.record), subject: "Concurrent change" });
  await view.load();
  assert.equal(view.state().form.fields.body, "Unsubmitted buffer");
  assert.equal(view.state().form.base.latest_version, 2);
  assert.equal(view.state().record.latest_version, 3);
  assert.equal(await view.act("edit", view.state().form.fields), false);
});
