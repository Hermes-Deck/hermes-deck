"use strict";
// Token pane (renderer/tokens-view.js + main/tokens-range.js): range math, labels, old-relay fallback, calm layout.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const i18n = require("../renderer/i18n");
const T = require("../renderer/tokens-view");
const { fetchTokens } = require("../main/tokens-range");
test.afterEach(() => i18n.setLanguage("en"));

const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity).filter(x => x != null && x !== false) });
const text = x => (x && typeof x === "object" ? (x.children || []).map(text).join(" ") : String(x));
const find = (node, pred, out = []) => { if (node && typeof node === "object") { if (pred(node)) out.push(node); (node.children || []).forEach(c => find(c, pred, out)); } return out; };
const cls = (node, name) => find(node, n => String(n.attrs.class || "").split(" ").includes(name));
const k = n => String(Math.round(n));
const at = (y, m, d, hh = 12, mm = 0) => new Date(y, m - 1, d, hh, mm).getTime() / 1000;

test("normalize: a range-aware relay answer passes through", () => {
  const body = { range: "24h", bucket: "hour", from: 100, to: 86500, since: 50, rows: [{ t: 3600, agent: "A", model: "m", in: 1 }] };
  const d = T.normalize("24h", body);
  assert.equal(d.bucket, "hour");
  assert.equal(d.partial, null);
  assert.equal(d.rows.length, 1);
});

test("normalize: an old relay's day rows give honest ranges (24h = today only, labelled)", () => {
  const now = at(2030, 3, 10, 9);
  const rows = [{ day: "2030-03-10", agent: "A", in: 5 }, { day: "2030-03-09", agent: "A", in: 7 }, { day: "2030-02-01", agent: "A", in: 100 }];
  const today = T.normalize("24h", { legacy: true, rows }, now);
  assert.equal(today.partial, "today");
  assert.equal(T.totals(today.rows).fresh, 5);
  assert.equal(T.totals(T.normalize("7d", rows, now).rows).fresh, 12);
  assert.equal(T.totals(T.normalize("30d", rows, now).rows).fresh, 12);
  const all = T.normalize("all", { legacy: true, rows }, now);
  assert.equal(all.bucket, "week");
  assert.equal(all.since, at(2030, 2, 1, 0));
  assert.equal(T.totals(all.rows).fresh, 112);
  assert.ok(all.rows.every(r => r.t === T.weekOf(r.day)));
});

test("totals: tokens = fresh + cached + output, cache hit over prompt tokens, reasoning never added twice", () => {
  const t = T.totals([{ in: 100, cw: 20, cr: 380, out: 50, rs: 30, n: 3, sessions: 1, usd: 0.5, estimated: true }, { in: 0, cr: 0, out: 0, n: 1, unknownCost: 1 }]);
  assert.deepEqual([t.fresh, t.cached, t.out, t.tokens, t.n, t.sessions], [120, 380, 50, 550, 4, 1]);
  assert.equal(t.hit, 0.76);
  assert.equal(T.totals([]).hit, null);
});

test("axis: 24h has 24-25 hour columns, day ranges have N days, all has weeks or months", () => {
  const now = at(2030, 3, 10, 9, 30);
  const hours = T.axis({ bucket: "hour", from: now - 86400, to: now });
  assert.ok(hours.length === 25, `${hours.length}`);
  assert.equal(new Date(hours[0] * 1000).getHours(), 9);
  for (const [range, n] of [["7d", 7], ["14d", 14], ["30d", 30]]) {
    const d = T.normalize(range, [], now);
    const ax = T.axis(d);
    assert.equal(ax.length, n, range);
    assert.equal(ax.at(-1), "2030-03-10", range);
  }
  const weeks = T.axis({ bucket: "week", since: at(2030, 1, 15), to: now });
  assert.equal(weeks[0], "2030-01-14");
  assert.equal(weeks.at(-1), "2030-03-04");
  const months = T.axis({ bucket: "month", since: at(2028, 11, 3), to: now });
  assert.deepEqual([months[0], months[1], months[2], months.at(-1), months.length], ["2028-11", "2028-12", "2029-01", "2030-03", 17]);
});

test("series: rows land in their bucket, missing buckets are zero; byAgent sorts by tokens or cost", () => {
  const now = at(2030, 3, 10, 9);
  const d = T.normalize("7d", [{ day: "2030-03-10", agent: "A", in: 10, cr: 30, n: 1 }, { day: "2030-03-08", agent: "B", in: 1, out: 1, usd: 9, n: 1 }], now);
  const s = T.series(d);
  assert.equal(s.length, 7);
  assert.deepEqual([s.at(-1).fresh, s.at(-1).cached, s[4].fresh, s[0].fresh], [10, 30, 1, 0]);
  assert.deepEqual(T.byAgent(d.rows).map(a => a.agent), ["A", "B"]);
  assert.deepEqual(T.byAgent(d.rows, "cost").map(a => a.agent), ["B", "A"]);
});

test("cost: the caveat is a tiny ≈ with a tooltip, never page text", () => {
  const sub = T.costParts({ usd: 12.4, equivalent: true });
  assert.deepEqual([sub.value, sub.approx], ["$12.40", true]);
  assert.match(sub.why, /list-price/);
  assert.deepEqual(T.costParts({ usd: 1, estimated: false }), { value: "$1.00", approx: false, why: null });
  assert.equal(T.costParts({ usd: 0, unknownCost: 2 }).value, "–");
  assert.equal(T.costParts({ usd: 0, unknownCost: 2 }).approx, false);
});

test("labels: ticks and hover names follow the bucket and the UI language", () => {
  const d = { range: "all", bucket: "month", since: at(2029, 6, 1), to: at(2030, 2, 1) };
  assert.match(T.tickLabel(d, "2029-06"), /Jun/);
  assert.match(T.tickLabel(d, "2029-06"), /29/, "multi-year months carry the year");
  assert.match(T.whenLabel({ bucket: "week" }, "2030-03-04"), /^Week of /);
  i18n.setLanguage("tr");
  assert.match(T.whenLabel({ bucket: "week" }, "2030-03-04"), /haftası$/);
  assert.match(T.whenLabel({ bucket: "month" }, "2030-03"), /Mart/);
  assert.equal(T.tickEvery(30), 5);
  assert.equal(T.tickEvery(7), 1);
});

function view({ answers = {}, store = new Map(), snapshot = [] } = {}) {
  const calls = [];
  let marks = 0;
  const v = T.create({
    h, k, mark: () => { marks += 1; }, isOpen: () => false,
    store: { get: key => store.get(key) || null, set: (key, val) => store.set(key, val) },
    deck: { tokens: async r => { calls.push(r); return answers[r] || { range: r, bucket: "day", from: 0, to: 0, since: null, rows: [] }; } },
    snapshotRows: () => snapshot, usageStatus: () => null, sessions: () => [], where: () => "",
  });
  return { v, calls, store, marks: () => marks };
}

test("pane: range control, four figures, chart, agents and models — and no explanatory paragraphs", async () => {
  const now = Date.now() / 1000;
  const rows = [{ t: new Date(now * 1000).toLocaleDateString("sv-SE"), agent: "Primary", model: "model-a", in: 1000, cr: 3000, out: 200, n: 4, usd: 1.5, cost_label: "API list-price equivalent" }];
  const { v } = view({ answers: { "7d": { range: "7d", bucket: "day", from: now - 6 * 86400, to: now, since: null, rows } } });
  await v.refresh();
  const kids = [];
  v.pane(kids);
  const all = h("div", null, kids);
  const radios = find(all, n => n.attrs.role === "radio");
  assert.deepEqual(radios.map(r => text(r)), ["24h", "7d", "14d", "30d", "All"]);
  assert.deepEqual(radios.map(r => r.attrs["aria-checked"]), ["false", "true", "false", "false", "false"]);
  assert.equal(cls(all, "tok-fig").length, 4);
  assert.equal(text(cls(all, "tok-fig-v")[0]).trim(), "4200");
  assert.equal(cls(all, "tok-approx").length, 1, "subscription cost carries ≈");
  assert.equal(cls(all, "tok-col").length, 7);
  assert.equal(cls(all, "tok-agent").length, 1);
  assert.ok(text(all).includes("model-a"));
  const words = text(all);
  for (const banned of ["state.db", "every 60 seconds", "not a bill", "Hover", "reasoning tokens are included", "No context or cache warnings"]) assert.ok(!words.includes(banned), banned);
  assert.equal(cls(all, "quota-note").length, 0, "fresh data shows no 'updated' stamp");
});

test("pane: switching range paints at once from the kept copy and persists the choice; others are prefetched", async () => {
  const { v, calls, store } = view();
  await v.refresh();
  assert.deepEqual(calls, ["7d", "24h", "14d", "30d", "all"]);
  v.select("all");
  assert.equal(v.range, "all");
  assert.equal(store.get("deck.tokRange"), "all");
  assert.equal(calls.length, 5, "a fresh cached copy is not refetched on switch");
  const kids = [];
  v.pane(kids);
  assert.equal(find(h("div", null, kids), n => n.attrs["aria-checked"] === "true").map(text)[0], "All");
  const again = view({ store });
  assert.equal(again.v.range, "all", "the range survives a restart");
});

test("pane: an old relay answering 24h shows a short 'today only' marker", async () => {
  const today = new Date().toLocaleDateString("sv-SE");
  const { v } = view({ answers: { "24h": { legacy: true, range: "24h", rows: [{ day: today, agent: "A", in: 3 }] } }, store: new Map([["deck.tokRange", "24h"]]) });
  await v.refresh();
  const kids = [];
  v.pane(kids);
  assert.ok(text(h("div", null, kids)).includes("today only"));
});

test("main: fetchTokens asks ?range= and falls back to ?days= on an old relay; day counts still work", async () => {
  const seen = [];
  const newRelay = async p => { seen.push(p); return { range: "24h", bucket: "hour", rows: [] }; };
  assert.equal((await fetchTokens(newRelay, "24h")).bucket, "hour");
  assert.deepEqual(seen, ["/tokens?range=24h"]);
  const old = [];
  const oldRelay = async p => { old.push(p); return [{ day: "2030-01-01", in: 1 }]; };
  const r = await fetchTokens(oldRelay, "all");
  assert.equal(r.legacy, true);
  assert.deepEqual(old, ["/tokens?range=all", "/tokens?days=400"]);
  old.length = 0;
  await fetchTokens(oldRelay, "7d");
  assert.deepEqual(old, ["/tokens?range=7d"], "7d needs no second request");
  old.length = 0;
  await fetchTokens(oldRelay, 9999);
  await fetchTokens(oldRelay, "1d;rm");
  assert.deepEqual(old, ["/tokens?days=400", "/tokens?days=7"], "unknown input never reaches the URL");
});

test("tokens view: loaded by the page and every tok.* key exists in both languages", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  assert.ok(html.includes('<script src="tokens-view.js"></script>') && html.includes('href="tokens.css"'));
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer", "tokens-view.js"), "utf8");
  const keys = new Set([...src.matchAll(/"(tok\.[a-zA-Z0-9.]+)"/g)].map(m => m[1]));
  for (const r of T.RANGES) { keys.add(`tok.range.${r}`); keys.add(`tok.rangeTip.${r}`); }
  for (const key of keys) {
    const forms = key in i18n.tables.en ? [key] : [`${key}.one`, `${key}.other`]; // plural bases (usage-view plural())
    for (const f of forms) assert.ok(f in i18n.tables.en && f in i18n.tables.tr, f);
  }
});

test("tokens view Refresh reloads the selected range and reports failed reads without losing data", async () => {
  i18n.extend(require("../renderer/i18n-e"));
  let reads = 0, fail = false;
  const h = (tag, attrs, ...children) => ({ tag, attrs: attrs || {}, children: children.flat(Infinity).filter(x => x != null) });
  const view = T.create({ h, k: String, deck: { tokens: async () => { reads++; if (fail) throw new Error("Unavailable"); return []; } }, mark() {}, isOpen: () => false });
  const kids = [];
  view.pane(kids);
  const walk = n => [n, ...(n.children || []).filter(c => typeof c === "object").flatMap(walk)];
  const refresh = kids.flatMap(walk).find(n => n.attrs?.class === "tok-refresh quota-refresh");
  assert.ok(refresh, "the Usage inspector contains an explicit token refresh action");
  await refresh.attrs.onclick();
  assert.equal(reads, 1);
  fail = true;
  await refresh.attrs.onclick();
  const after = []; view.pane(after);
  assert.ok(after.flatMap(walk).some(n => n.attrs?.role === "status" && n.children.includes(i18n.t("triage.usageRefreshFailed"))));
});
