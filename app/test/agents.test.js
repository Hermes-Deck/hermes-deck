"use strict";
// Sub-agent views: pure helpers of renderer/agents.js, the prompt-prefix parser in renderer/app.js (F2),
// and main/history.js (IPC input checks, fixture routes). Run: node --test test/
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { retryIndex, branchTotals, seqOf, pretty, goalKey } = require("../renderer/agents");
const hist = require("../main/history");
const i18n = require("../renderer/i18n");
i18n.setLanguage("tr"); // Existing friendly-error wording; fixture text stays unchanged.

/** Pull named function declarations out of app.js (an IIFE for the browser) and run them in a sandbox. */
function fromAppJs(...names) {
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8");
  const code = names
    .map((n) => {
      const at = src.indexOf(`function ${n}(`);
      assert.ok(at !== -1, `${n} not found in app.js`);
      let depth = 0;
      for (let i = src.indexOf("{", at); i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
      }
      throw new Error(`${n}: unbalanced`);
    })
    .join("\n");
  const box = { DeckI18n: i18n, i18nText: i18n.t, i18nLocale: i18n.getLocale };
  vm.runInNewContext(`${code}\n${names.map((n) => `this.${n} = ${n};`).join("\n")}`, box);
  return box;
}

test("F2: prompt prefixes split into request + context, old strip behaviour kept", () => {
  const { splitPromptPrefix, stripPromptPrefix } = fromAppJs("splitPromptPrefix", "promptBlockEnd", "stripPromptPrefix");
  const plain = (x) => JSON.parse(JSON.stringify(x));
  let r = splitPromptPrefix('[Replying to: "dünkü [özet] mesajı"]\n\n[Deniz Örnek|1000]\nRaporu güncelle');
  assert.deepStrictEqual(plain(r), { text: "Raporu güncelle", blocks: [{ kind: "reply", body: "dünkü [özet] mesajı" }, { kind: "sender", body: "Deniz Örnek" }], cut: null });
  r = splitPromptPrefix("[Grup bağlamı: Saha Ekibi · son [3] mesaj]\n[Mira|2002]\nTakvime işle");
  assert.deepStrictEqual(plain(r.blocks), [{ kind: "context", body: "Grup bağlamı: Saha Ekibi · son [3] mesaj" }, { kind: "sender", body: "Mira" }]);
  assert.strictEqual(r.text, "Takvime işle");
  // a bare sender tag before a group note
  r = splitPromptPrefix("[Deniz Örnek] [IMPORTANT: grup sohbetindesin, kısa yaz]\n\nAsıl soru burada");
  assert.deepStrictEqual(plain(r.blocks).map((b) => b.kind), ["sender", "context"]);
  assert.strictEqual(r.text, "Asıl soru burada");
  // a clipped preview that ends inside the quote: nothing stripped, the cut is reported
  r = splitPromptPrefix('[Replying to: "çok uzun bir alıntı…');
  assert.strictEqual(r.cut, "reply");
  assert.strictEqual(r.text, '[Replying to: "çok uzun bir alıntı…');
  // ordinary text that starts with a bracket stays text
  for (const t of ["[x] tamamlandı", "[rapor](https://example.org) hazır", "[TODO] bunu düzelt", "[ASYNC DELEGATION BATCH COMPLETE — deleg_1]\nsonuç"]) {
    assert.strictEqual(splitPromptPrefix(t).text, t, t);
  }
  assert.strictEqual(stripPromptPrefix('[Replying to: "a"]\n[Ad|12345]\nmerhaba'), "merhaba");
  assert.strictEqual(stripPromptPrefix("  düz metin  "), "düz metin");
});

test("B4: retries link a failed attempt to the next run of the same goal", () => {
  const goal = "Kaynakça listesindeki bağlantıları kontrol et";
  const s = (sid, extra) => ({ sid, parent: "P", agent: "Atlas", goal, firstTs: 0, lastTs: 0, ...extra });
  const idx = retryIndex([
    s("a", { state: "failed", firstTs: 100, lastTs: 170, model: "m1" }),
    s("b", { state: "running", firstTs: 200, model: "m2", goal: `  ${goal.replace(/ /g, "  ")}…` }),
    s("c", { state: "done", firstTs: 150 }), // same goal, started before a ended: a parallel copy, not a retry of a
    { sid: "d", parent: "Q", agent: "Kâtip", goal, state: "running", firstTs: 300 }, // another agent
    s("e", { state: "done", firstTs: 100 + 7 * 3600 }), // far too late
    s("x", { goal: "ok", state: "failed", firstTs: 1 }),
    s("y", { goal: "ok", state: "done", firstTs: 2 }),
  ]);
  // a failed at 170; c started at 150 (alongside it), b at 200: b is the retry, whatever the model
  assert.deepStrictEqual(idx.get("a"), { by: "b" });
  assert.deepStrictEqual(idx.get("b"), { of: "a" });
  assert.strictEqual(idx.get("c"), undefined);
  assert.strictEqual(idx.get("e"), undefined);
  assert.strictEqual(idx.get("d"), undefined);
  assert.strictEqual(idx.get("x"), undefined); // too short to compare
  const idx2 = retryIndex([s("a", { state: "failed", firstTs: 100, lastTs: 170 }), s("b", { state: "running", firstTs: 200 })]);
  assert.deepStrictEqual([idx2.get("a"), idx2.get("b")], [{ by: "b" }, { of: "a" }]);
  assert.strictEqual(goalKey("  Bir  Görev…"), "bir görev");
});

test("B4: branch totals sum the subtree, cost only where known", () => {
  const all = new Map([
    ["r", { sid: "r", tokens: { in: 10, cw: 5, cr: 100, out: 7 }, children: ["k1", "k2"] }],
    ["k1", { sid: "k1", tokens: { in: 1, cr: 10, out: 1 }, children: ["g"] }],
    ["g", { sid: "g", tokens: { in: 2, cr: 20, out: 2 }, cost: 0.25, children: [] }],
    ["k2", { sid: "k2", tokens: {}, children: [] }],
  ]);
  const kidsOf = (s) => (s.children || []).map((c) => all.get(c)).filter(Boolean);
  assert.deepStrictEqual(branchTotals(all.get("r"), kidsOf), { fresh: 18, cr: 130, out: 10, cost: 0.25, hasCost: true, n: 3, depth: 2 });
  assert.deepStrictEqual(branchTotals(all.get("k2"), kidsOf), { fresh: 0, cr: 0, out: 0, cost: 0, hasCost: false, n: 0, depth: 0 });
});

test("B1/B3: message order and argument display", () => {
  assert.ok(seqOf("h:default:12") < seqOf("h:default:100"));
  assert.ok(seqOf("c:0a1b2c3d-1111:500") < seqOf("c:0a1b2c3d-1111:500.1"));
  assert.ok(seqOf("c:0a1b2c3d-1111:500.1") < seqOf("c:0a1b2c3d-1111:501"));
  assert.strictEqual(pretty('{"a":1,"b":[2]}'), '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}');
  assert.strictEqual(pretty('{"a": 1, "b": "kesil'), '{"a": 1, "b": "kesil'); // clipped JSON stays as is
  assert.strictEqual(pretty("ls -la"), "ls -la");
});

test("main/history: IPC checks inputs and builds relay paths", async () => {
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => (handlers[ch] = fn) };
  const asked = [];
  let fail = null;
  const relay = { get: async (p) => (asked.push(p), fail ? Promise.reject(new Error(`relay ${p}: HTTP ${fail}`)) : { ok: true }) };
  hist.register(ipcMain, () => relay);
  // like ipcMain.handle: a handler that throws becomes a rejected invoke()
  const call = (ch, ...a) => Promise.resolve().then(() => handlers[ch]({}, ...a));
  await call("relay:messages", "0a1b2c3d-1111-4222-8333-444455556666/abc123", "4096");
  await call("relay:message-full", "h:default:42");
  await call("relay:call", "20261001_100100_bbbbbb", "read_file_0_aa11");
  assert.deepStrictEqual(asked, [
    "/session/0a1b2c3d-1111-4222-8333-444455556666%2Fabc123/messages?limit=50&before=4096",
    "/message/h%3Adefault%3A42/full",
    "/session/20261001_100100_bbbbbb/call/read_file_0_aa11",
  ]);
  await assert.rejects(() => call("relay:messages", "../etc", null), /geçersiz/);
  await assert.rejects(() => call("relay:messages", "s1", "12a"), /geçersiz/);
  await assert.rejects(() => call("relay:call", "s1", "a b"), /geçersiz/);
  fail = 501;
  await assert.rejects(() => call("relay:messages", "s1"), /node:sqlite/);
  fail = 404;
  await assert.rejects(() => call("relay:message-full", "h:default:1"), /bulamadı/);
});

test("main/history: fixture relay data, routes and live pushes", async () => {
  const data = hist.fixtureData({
    agents: { A: { name: "A" } },
    sessions: [
      { sid: "p", agent: "A", state: "running", firstAgo: 60, curTool: { tool: "t", sinceAgo: 5 } },
      { sid: "k", agent: "A", parent: "p", state: "running", firstAgo: 30 },
    ],
    history: { k: { meta: { model: "m" }, items: [{ id: "h:x:1", role: "assistant", ago: 20, calls: [{ call: "c1", name: "read_file", args: "{}" }] }, { id: "h:x:2", role: "tool", call: "c1", name: "read_file", text: "kısa", truncated: true }] } },
    full: { "h:x:2": { id: "h:x:2", role: "tool", text: "uzun sonuç" } },
    details: { k: { recent: [{ call: "c9", tool: "terminal", args: "ls", result: "a" }] } },
    live: [{ after: 10, evs: [{ ev: "tool_start", sid: "k", call: "c2", ago: 0 }], sessions: [{ sid: "k", agent: "A", parent: "p", state: "done", firstAgo: 30 }] }],
  });
  const now = Date.now() / 1000;
  assert.ok(Math.abs(data.sessions[0].firstTs - (now - 60)) < 2);
  assert.ok(Math.abs(data.sessions[0].curTool.since - (now - 5)) < 2);
  assert.deepStrictEqual([data.agents.A.running, data.agents.A.subsRunning], [1, 1]);
  const page = hist.fixtureGet(data, "/session/k/messages?limit=50");
  assert.deepStrictEqual([page.items.length, page.next, page.meta.model], [2, null, "m"]);
  assert.strictEqual(hist.fixtureGet(data, `/message/${encodeURIComponent("h:x:2")}/full`).text, "uzun sonuç");
  assert.deepStrictEqual(hist.fixtureGet(data, "/session/k/call/c1"), { call: "c1", name: "read_file", args: "{}", result: "uzun sonuç" });
  assert.strictEqual(hist.fixtureGet(data, "/session/k/call/c9").result, "a");
  assert.deepStrictEqual(hist.fixtureGet(data, "/session/k"), { recent: [{ call: "c9", tool: "terminal", args: "ls", result: "a" }] });
  assert.strictEqual(hist.fixtureGet(data, "/tokens?days=7"), undefined);
  await assert.rejects(() => hist.fixtureGet(data, "/session/zz/messages"), /bulamadı/);
  const pushed = await new Promise((resolve) => hist.fixtureLive(data, resolve));
  assert.strictEqual(pushed.t, "evs");
  assert.strictEqual(pushed.evs[0].call, "c2");
  assert.deepStrictEqual([pushed.agents.A.running, pushed.agents.A.subsRunning], [1, 0]);
  assert.strictEqual(hist.fixtureData({ agents: {} }).sessions, undefined); // a relay section without sessions passes through
});
