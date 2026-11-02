"use strict";
// masked-prompt.js: the card a masked prompt (sudo, secret, vault.*) gets, against a tiny DOM stand-in. Behaviour only;
// the owner checks the look on the installed build.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const MPM = require("../renderer/masked-prompt");
const i18n = require("../renderer/i18n");
i18n.setLanguage("en");
const t = i18n.t;

/** A minimal element: attributes, dataset, listeners, children, a live `value` property. */
function h(tag, attrs, ...kids) {
  const el = { tag, attrs: {}, dataset: {}, listeners: {}, children: [], value: "", blurred: 0,
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    blur() { this.blurred++; },
    set textContent(v) { this.children = [String(v)]; }, get textContent() { return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join(""); } };
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.attrs.class = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.listeners[k.slice(2)] = v;
    else el.attrs[k] = v === true ? "" : String(v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.children.push(typeof c === "object" ? c : String(c));
  return el;
}
const all = (el) => [el, ...el.children.filter((c) => typeof c === "object").flatMap(all)];
const inputs = (el) => all(el).filter((x) => x.tag === "input");
const button = (el, label) => all(el).find((x) => x.tag === "button" && x.textContent === label);
const key = (el, k) => el.listeners.keydown({ key: k, isComposing: false, preventDefault() {}, stopPropagation() {} });
const type = (el, v) => { el.value = v; el.listeners.input({ target: el }); };
const tick = () => new Promise((r) => setImmediate(r));

const REQS = {
  sudo: { id: "S1", rpcId: "rpc", profile: "default", kind: "secret", method: "sudo", command: "apt-get install -y ripgrep" },
  secret: { id: "S2", rpcId: "rpc", profile: "default", kind: "secret", method: "secret", envVar: "ATLAS_API_KEY", prompt: "API key for Atlas" },
  unlock: { id: "S3", rpcId: "rpc", profile: "default", kind: "secret", method: "vault.unlock_prompt", displayName: "Bitwarden" },
  login: { id: "S4", rpcId: "rpc", profile: "default", kind: "secret", method: "vault.save_login", site: "login.example.com", origin: "https://login.example.com" },
  code: { id: "S5", rpcId: "rpc", profile: "default", kind: "secret", method: "vault.code", site: "login.example.com", hint: "6 digits" },
};

function world(result = { status: "ok" }) {
  const sent = [];
  let redraws = 0;
  const mp = MPM.create({ h, t, answer: async (r, value) => { sent.push([r.id, value]); return typeof result === "function" ? result() : result; }, redraw: () => { redraws++; } });
  return { mp, sent, redraws: () => redraws };
}

test("titles: sudo, a named secret, unlock, save login, code (with and without a site)", () => {
  const title = (r) => t(MPM.title(r).key, MPM.title(r).vars);
  assert.equal(title(REQS.sudo), "sudo password");
  assert.equal(title(REQS.secret), "Secret: ATLAS_API_KEY");
  assert.equal(title(REQS.unlock), "Unlock Bitwarden");
  assert.equal(title(REQS.login), "Save login for login.example.com");
  assert.equal(title(REQS.code), "Code for login.example.com");
  assert.equal(title({ ...REQS.code, site: "" }), "One-time code");
  i18n.setLanguage("tr");
  try { assert.equal(title(REQS.login), "login.example.com için girişi kaydet"); } finally { i18n.setLanguage("en"); }
});

test("every input is masked, unspellchecked and never autofilled; a code field asks for digits; no value in the markup", () => {
  const { mp } = world();
  for (const r of Object.values(REQS)) {
    const card = mp.card(r, { who: "Ana oturum" });
    assert.equal(card.dataset.hold, "1");
    assert.equal(card.dataset.requestId, r.id);
    const masked = inputs(card).find((x) => x.dataset.mpSecret);
    assert.equal(masked.attrs.type, "password", r.method);
    assert.equal(masked.attrs.spellcheck, "false");
    assert.equal(masked.attrs.autocomplete, r.method === "vault.code" ? "one-time-code" : "new-password");
    assert.equal(masked.attrs.inputmode, r.method === "vault.code" ? "numeric" : undefined);
    assert.equal(inputs(card).length, r.method === "vault.save_login" ? 2 : 1);
    type(masked, "typed-Pw-1");
    const again = mp.card(r, { who: "Ana oturum" }); // a re-render keeps what was typed, as the input's property only
    const field = inputs(again).find((x) => x.dataset.mpSecret);
    assert.equal(field.value, "typed-Pw-1");
    assert.ok(!JSON.stringify(again.attrs).includes("typed-Pw-1") && !all(again).some((x) => JSON.stringify(x.attrs).includes("typed-Pw-1")));
  }
  // the sudo command, the secret's prompt and the code hint are shown; the login's origin when it differs from the site
  const text = (r) => all(mp.card(r, {})).map((x) => x.children.filter((c) => typeof c === "string").join(" ")).join(" ");
  assert.match(text(REQS.sudo), /apt-get install -y ripgrep/);
  assert.match(text(REQS.secret), /API key for Atlas/);
  assert.match(text(REQS.code), /6 digits/);
  assert.match(text(REQS.login), /https:\/\/login\.example\.com/);
});

test("Enter sends the typed value once and wipes the field and the draft at once", async () => {
  const w = world();
  const card = w.mp.card(REQS.sudo, {});
  const field = inputs(card)[0];
  type(field, "sudo-Pw-0e5c1d");
  key(field, "Enter");
  assert.equal(field.value, "", "wiped before the answer is even back");
  assert.ok(field.blurred >= 1);
  await tick();
  assert.deepEqual(w.sent, [["S1", "sudo-Pw-0e5c1d"]]);
  assert.equal(w.mp.size(), 0, "answered: no draft left");
  key(field, "Enter"); // a second Enter on the old field sends nothing more
  await tick();
  assert.equal(w.sent.length, 1);
});

test("save login needs both fields, then sends {identifier, password}; Esc and Cancel decline with an empty answer", async () => {
  const w = world();
  let card = w.mp.card(REQS.login, {});
  let [id, pw] = inputs(card);
  type(pw, "login-Pw-c3d917");
  key(pw, "Enter");
  await tick();
  assert.deepEqual(w.sent, []);
  card = w.mp.card(REQS.login, {});
  assert.ok(all(card).some((x) => x.attrs.role === "alert" && x.textContent === t("mp.needLogin")));
  [id, pw] = inputs(card);
  type(id, " ada@example.com ");
  key(id, "Enter");
  await tick();
  assert.deepEqual(w.sent, [["S4", { identifier: "ada@example.com", password: "login-Pw-c3d917" }]]);
  assert.deepEqual([id.value, pw.value], ["", ""]);
  // Esc on a code card, the Cancel button on an unlock card: both answer "" (declined)
  const code = w.mp.card(REQS.code, {});
  type(inputs(code)[0], "481516");
  key(inputs(code)[0], "Escape");
  assert.equal(inputs(code)[0].value, "");
  const unlock = w.mp.card(REQS.unlock, {});
  type(inputs(unlock)[0], "master-Pw-4a8e60");
  button(unlock, t("mp.cancel")).listeners.click();
  await tick();
  assert.deepEqual(w.sent.slice(1), [["S5", ""], ["S3", ""]]);
  assert.equal(w.mp.size(), 0);
});

test("an empty value is not sent; a failed send keeps the card with an error and nothing typed", async () => {
  const w = world(() => { throw new Error("Hermes connection lost"); });
  const card = w.mp.card(REQS.secret, {});
  key(inputs(card)[0], "Enter");
  await tick();
  assert.deepEqual(w.sent, []);
  type(inputs(card)[0], "sk-test-9b2f71");
  button(card, t("mp.send")).listeners.click();
  await tick();
  assert.deepEqual(w.sent, [["S2", "sk-test-9b2f71"]]);
  const after = w.mp.card(REQS.secret, {});
  assert.ok(all(after).some((x) => x.attrs.role === "alert" && x.textContent === "Hermes connection lost"));
  assert.equal(inputs(after)[0].value, "");
  assert.ok(!JSON.stringify([...w.mp._drafts.values()].map(({ inputs: _, ...d }) => d)).includes("sk-test"));
});

test("a request that leaves (answered elsewhere, expired, disconnected) wipes what was typed", () => {
  const w = world();
  const card = w.mp.card(REQS.code, {});
  const field = inputs(card)[0];
  type(field, "481516");
  w.mp.prune([REQS.sudo, { id: "A1", kind: "approval" }]);
  assert.equal(field.value, "");
  assert.equal(w.mp.size(), 0);
  assert.equal(inputs(w.mp.card(REQS.code, {}))[0].value, "", "a card drawn again starts empty");
  // the same id on another profile is another request
  w.mp.card(REQS.sudo, {});
  w.mp.prune([{ ...REQS.sudo, profile: "research" }]);
  assert.equal(w.mp.size(), 0);
});

test("Show reveals the masked field and Hide masks it again; a closed connection disables the card", () => {
  const w = world();
  const card = w.mp.card(REQS.code, {});
  const field = inputs(card)[0];
  button(card, t("mp.show")).listeners.click();
  assert.equal(field.attrs.type, "text");
  const hide = all(card).find((x) => x.tag === "button" && x.attrs["aria-pressed"] === "true");
  hide.listeners.click();
  assert.equal(field.attrs.type, "password");
  const closed = w.mp.card(REQS.code, { open: () => false });
  assert.ok(all(closed).filter((x) => x.tag === "input" || x.tag === "button").every((x) => "disabled" in x.attrs));
  key(inputs(closed)[0], "Enter");
  assert.deepEqual(w.sent, []);
});
