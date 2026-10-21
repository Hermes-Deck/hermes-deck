"use strict";
// Multi-host end to end: two real hosts (hermes-deck's stream.py + observer in front of testhost.py's gateway, each
// with its own HERMES_HOME), real BridgeClients wired the way main.js wires the active host and a watcher, and the
// real inbox store. Both hosts raise approval "A1": the same id on two machines.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { BridgeClient } = require("../main/bridge");
const I = require("../renderer/inbox");

const HOST = path.join(__dirname, "..", "..", "hermes-plugin", "hermes-deck", "testhost.py");
const PY = process.env.DECK_TEST_PYTHON || "python3";
const CFG = { mode: "ssh", target: "hermes-test", python: "/usr/bin/python3", stream: "~/.hermes/hermes-deck/stream.py" };
const TIMING = { request: 5000, write: 1000, handshake: 10000, heartbeat: 12000, kill: 500, backoffMin: 40, backoffMax: 160, keepalive: 60000 };

function host(t, name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hd-")), log = path.join(home, "gateway.log");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const client = () => { const c = new BridgeClient(CFG, { launch: { file: PY, args: [HOST, home, "--log", log] }, timing: TIMING }); t.after(() => c.stop()); return c; };
  const answers = () => { try { return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map(JSON.parse).filter(e => e.method === "request.answer"); } catch { return []; } };
  return { name, client, answers };
}
const until = async (pred, ms = 15000) => { const end = Date.now() + ms; while (!pred()) { if (Date.now() > end) throw new Error("timed out"); await new Promise(r => setTimeout(r, 50)); } };

test("two real hosts: one inbox, each answer reaches only the host that asked", async (t) => {
  if (process.platform === "win32") return t.skip("needs Unix sockets");
  if (spawnSync(PY, ["-c", "import yaml"]).status !== 0) return t.skip("no python with PyYAML (set DECK_TEST_PYTHON)");
  const A = host(t, "Host A"), B = host(t, "Host B");
  const active = A.client(), watcher = B.client();
  // main.js: the active host feeds deck.bridge; a watcher feeds deck.hosts and answers through hosts:answer
  const w = { status: "connecting", requests: [] };
  const deck = {
    bridge: { answerApproval: (id, v, o) => active.answerApproval(id, v, o) },
    hosts: { answer: (hostId, kind, id, v, o) => { assert.equal(hostId, "h2"); if (w.status !== "open") throw new Error("offline"); return watcher.answerApproval(id, v, o); } },
  };
  const store = I.createStore(deck);
  const pushHosts = () => store.feedHosts({ t: "requests", hosts: [{ id: "h2", name: B.name, status: w.status, requests: w.requests }] });
  active.on("status", s => store.feedBridge({ t: "status", ...s }));
  active.on("requests", list => store.feedBridge({ t: "requests", list }));
  watcher.on("status", s => { w.status = s.status; if (s.status !== "open") w.requests = []; pushHosts(); });
  watcher.on("requests", list => { w.requests = list; pushHosts(); });
  active.start(); watcher.start();
  await until(() => store.items().length === 2);

  // the same id on two machines: two cards, told apart by host
  // the plugin stamps the owning profile: no chat has to be opened before a card can be answered
  const cards = store.items();
  assert.deepEqual(cards.map(r => r.request.profile), ["default", "default"]);
  assert.deepEqual(cards.map(r => r.id), ["A1", "A1"]);
  assert.notEqual(cards[0].key, cards[1].key);
  const remote = cards.find(r => r.host === "h2"), local = cards.find(r => !r.host);
  assert.equal(remote.hostName, "Host B");

  // A is on screen; answering B's card reaches B alone
  assert.equal(await store.answer(remote, "deny"), true);
  await until(() => B.answers().length === 1);
  assert.deepEqual(B.answers()[0].params, { id: "A1", result: { choice: "deny" } });
  assert.equal(A.answers().length, 0, "the active host heard nothing");
  await until(() => store.items().length === 1);
  assert.equal(store.items()[0].host, undefined, "only A's card is left");

  // A's own card still answers to A
  assert.equal(await store.answer(local, "once"), true);
  await until(() => A.answers().length === 1);
  assert.equal(B.answers().length, 1, "B heard nothing more");
});

test("two real hosts: a host that drops goes inert and nothing is sent or replayed", async (t) => {
  if (process.platform === "win32") return t.skip("needs Unix sockets");
  if (spawnSync(PY, ["-c", "import yaml"]).status !== 0) return t.skip("no python with PyYAML (set DECK_TEST_PYTHON)");
  const B = host(t, "Host B");
  const watcher = B.client();
  const w = { status: "connecting", requests: [] };
  let sent = 0;
  const store = I.createStore({ hosts: { answer: (_h, _k, id, v, o) => { sent++; if (w.status !== "open") throw new Error("offline"); return watcher.answerApproval(id, v, o); } } });
  const pushHosts = () => store.feedHosts({ t: "requests", hosts: [{ id: "h2", name: B.name, status: w.status, requests: w.requests }] });
  watcher.on("status", s => { w.status = s.status; if (s.status !== "open") w.requests = []; pushHosts(); });
  watcher.on("requests", list => { w.requests = list; pushHosts(); });
  watcher.start();
  await until(() => store.items().length === 1);
  const card = store.items()[0];
  await watcher.stop(); // the connection to B is gone
  assert.equal(store.live(card), false);
  assert.equal(await store.answer(card, "once"), false);
  assert.equal(sent, 0, "an answer never leaves for a host that is not connected");
  assert.equal(B.answers().length, 0);
});

test("a card answered on another device leaves when its host withdraws it (request.cancel)", async (t) => {
  // the host's own signal that a request ended elsewhere; fake-stream withdraws approval A7 after 300 ms
  const FAKE = path.join(__dirname, "fake-stream.js");
  const c = new BridgeClient(CFG, { launch: { file: process.execPath, args: [FAKE, "--serve", "--approval", "--cancel-approval", "300"] }, timing: TIMING });
  t.after(() => c.stop());
  const w = { status: "connecting", requests: [] };
  const store = I.createStore({});
  const pushHosts = () => store.feedHosts({ t: "requests", hosts: [{ id: "h2", name: "Host B", status: w.status, requests: w.requests }] });
  c.on("status", s => { w.status = s.status; pushHosts(); });
  c.on("requests", list => { w.requests = list; pushHosts(); });
  c.start();
  await until(() => store.items().some(r => r.id === "A7"));
  await until(() => !store.items().some(r => r.id === "A7"));
});
