"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const i18n = require("../renderer/i18n");
test.afterEach(() => i18n.setLanguage("en"));
function load(language = "en") {
  i18n.setLanguage(language);
  const file = path.join(__dirname, "..", "renderer", "usage-view.js");
  const box = { module: { exports: {} }, require: createRequire(file), DeckI18n: i18n, i18nText: i18n.t, i18nLocale: i18n.getLocale };
  assert.ok(fs.existsSync(file), "usage view module exists");
  vm.runInNewContext(fs.readFileSync(file, "utf8"), box);
  return box.module.exports;
}
const h = (tag, attrs, ...children) => ({ tag, attrs, children: children.flat(Infinity).filter(x => x != null) });
const text = x => typeof x === "object" ? (x.children || []).map(text).join(" ") : String(x);

const find = (node, pred, out = []) => { if (node && typeof node === "object") { if (pred(node)) out.push(node); (node.children || []).forEach(c => find(c, pred, out)); } return out; };
const cls = (node, name) => find(node, n => (n.attrs && n.attrs.class || "").split(" ").includes(name));
const HOUR = 3600e3;

test("usage UI: one block per provider with short window labels, relative resets and stale status", () => {
  const U = load("tr");
  const now = Date.parse("2030-01-01T10:00:00Z");
  const quotas = { claude: { provider: "claude", ok: true, stale: true, fetched_at: now / 1000 - 600, windows: [{ minutes: 300, used: 87, resetsAt: "2030-01-01T16:12:00Z" }, { minutes: 10080, used: 56 }] }, codex: { provider: "codex", ok: true, windows: [{ minutes: 300, used: 0 }, { minutes: 10080, used: 44, resetsAt: "2030-01-04T14:00:00Z" }] } };
  const blocks = U.quotaRows(h, { quotas }, { now });
  assert.equal(blocks.length, 2);
  assert.deepEqual([...blocks.map(b => cls(b, "qname")[0].children[0])], ["Claude", "ChatGPT / Codex"]);
  const words = blocks.map(text).join(" ");
  for (const word of ["5 sa", "7 g", "%87", "%0", "6 sa 12 dk sonra sıfırlanır", "3 g 4 sa sonra sıfırlanır", "sıfırlanma zamanı yok", "Eski veri", "güncelleme: 10 dk önce"]) assert.ok(words.includes(word), word);
  assert.ok(!words.includes("Resets:") && !words.includes("oturum"), "no long labels or absolute resets inline");
  const bars = blocks.flatMap(b => find(b, n => n.attrs && n.attrs.role === "progressbar"));
  assert.equal(bars.length, 4);
  assert.equal(bars[2].attrs["aria-valuenow"], 0);
  const resets = cls(blocks[0], "q-reset");
  assert.ok(resets[0].attrs.title.startsWith("Sıfırlanma:"), "absolute time stays on hover");
  assert.equal(cls(blocks[0], "unknown").length, 1, "a missing reset is shown as such, not blank");
});

test("usage UI: a model-family limit (Claude Max: Fable) gets its own row after the account windows", () => {
  const U = load("tr");
  const now = Date.parse("2030-01-01T10:00:00Z");
  const claude = { provider: "claude", ok: true, windows: [{ minutes: 300, used: 12 }, { minutes: 10080, used: 65 }],
    modelWindows: [{ model: "Fable", minutes: 10080, used: 2, resetsAt: "2030-01-01T18:00:00Z" }, { model: "", minutes: 10080, used: 9 }, { model: "Bad", minutes: 10080, used: "9" }] };
  const [block] = U.quotaRows(h, { quotas: { claude } }, { now });
  assert.ok(block.attrs.class.split(" ").includes("has-model"), "the block widens its label column");
  const labels = cls(block, "q-win");
  assert.deepEqual(labels.map(l => l.children[0]), ["5 sa", "7 g", "Fable"], "invalid model rows are dropped");
  assert.ok(labels[2].attrs.class.includes("q-model"));
  assert.equal(labels[2].attrs.title, "Fable haftalık limiti · 7 g pencere");
  const bars = find(block, n => n.attrs && n.attrs.role === "progressbar");
  assert.equal(bars.length, 3);
  assert.equal(bars[2].attrs["aria-valuenow"], 2);
  assert.equal(bars[2].attrs["aria-label"], "Claude · Fable haftalık limiti · 7 g pencere");
  assert.ok(text(block).includes("8 sa 0 dk sonra sıfırlanır"));
  // No model limit reported (no access to such a model): the block is unchanged.
  const [plain] = load("en").quotaRows(h, { quotas: { claude: { ...claude, modelWindows: undefined } } }, { now });
  assert.ok(!plain.attrs.class.includes("has-model"));
  assert.deepEqual(cls(plain, "q-win").map(l => l.children[0]), ["5h", "7d"]);
  assert.equal(cls(plain, "q-win")[1].attrs.title, "Weekly limit · 7d window");
});

test("usage UI: percent follows the UI language, not a fixed order", () => {
  const en = load("en");
  assert.equal(en.pct(58), "58%");
  assert.equal(en.pct(0), "0%");
  const tr = load("tr");
  assert.equal(tr.pct(58), "%58");
  const fleet = { quotas: { claude: { provider: "claude", ok: true, windows: [{ minutes: 300, used: 63 }] } } };
  assert.ok(load("en").quotaRows(h, fleet).map(text).join(" ").includes("63%"));
  assert.ok(!load("en").quotaRows(h, fleet).map(text).join(" ").includes("%63"));
});

test("usage UI: Blend quota bars stay neutral through 60%, brass above it", () => {
  const U = load();
  const state = used => { const b = U.quotaRows(h, { quotas: { claude: { provider: "claude", ok: true, windows: [{ minutes: 300, used }] } } })[0]; return [cls(b, "bar")[0].children[0].attrs.class, cls(b, "pct")[0].attrs.class]; };
  assert.deepEqual([...state(60)], ["", "pct"]);
  assert.deepEqual([...state(61)], ["warn", "pct warn"]);
  assert.deepEqual([...state(94)], ["warn", "pct warn"]);
  assert.deepEqual([...state(95)], ["warn", "pct warn"]);
  assert.deepEqual([...state(250)], ["warn", "pct warn"]); // clamped to 100
});

test("usage UI: relative durations and window labels", () => {
  const U = load();
  assert.equal(U.untilText(12 * 60e3), "12m");
  assert.equal(U.untilText(6 * HOUR + 12 * 60e3), "6h 12m");
  assert.equal(U.untilText(76 * HOUR), "3d 4h");
  assert.equal(U.windowLabel(300), "5h");
  assert.equal(U.windowLabel(10080), "7d");
  assert.equal(U.windowLabel(30), "30m");
  assert.equal(U.windowLabel(undefined), "–");
  const past = U.quotaRows(h, { quotas: { claude: { provider: "claude", ok: true, windows: [{ minutes: 300, used: 5, resetsAt: "2030-01-01T09:00:00Z" }] } } }, { now: Date.parse("2030-01-01T10:00:00Z") });
  assert.ok(text(past[0]).includes("resetting now"));
});

test("usage UI: failed quota providers become an inline status, not body text", () => {
  const U = load();
  const rows = U.quotaRows(h, { quotas: { claude: { provider: "claude", ok: false, err: "login-needed" }, codex: { provider: "codex", ok: false, error: "pending" } } });
  const statuses = rows.flatMap(r => cls(r, "ustatus"));
  assert.deepEqual([...statuses.map(s => s.attrs.class)], ["ustatus warn", "ustatus info"]);
  assert.ok(text(rows[0]).includes("Account login required"));
});

test("usage UI: installed CodexBar remains the selected quota source", () => {
  const U = load();
  const result = U.quotaRows(h, { quotas: { claude: { provider: "claude", ok: true, windows: [{ minutes: 300, used: 10 }] } },
    profiles: { default: { quotas: { claude: { provider: "claude", ok: true, source: "hermes-account-usage", windows: [{ minutes: 300, used: 90 }] } } } } });
  assert.ok(result.map(text).join(" ").includes("10%"));
  assert.ok(!result.map(text).join(" ").includes("90%"));
});

test("usage UI: all-profile totals include cache but never double-add reasoning, estimates + equivalent costs distinguished", () => {
  const U = load("tr");
  const rows = [{ in: 100, cr: 50, cw: 10, out: 20, rs: 5, usd: .25, n: 2, estimated: true, cost_label: "API list-price equivalent" }, { in: 7, cr: 0, cw: 0, out: 3, usd: 0, n: 1 }];
  const sum = U.totals(rows);
  assert.equal(sum.tokens, 190);
  assert.equal(sum.usd, .25);
  assert.equal(U.costText(rows[0]), "≈$0.25");
  assert.equal(U.costText(rows[1]), "$0.00");
  assert.equal(U.costText({ usd: 0, unknownCost: 1 }), "–");
  const result = U.summary(h, rows, String);
  const words = result.map(text).join(" ");
  assert.ok(!words.includes("API liste fiyatı eşdeğeri"), "the cost caveat is not page text");
  assert.ok(cls(result[0], "usage-cost")[0].attrs.title.includes("API liste fiyatı eşdeğeri"), "...it is the cost's tooltip");
  assert.ok(!words.includes("state.db") && !words.includes("60"), "no source/interval description");
});

test("usage UI: unavailable store makes stale totals explicit and names the failure kind", () => {
  const U = load("tr");
  const now = Date.parse("2030-01-01T10:00:00Z");
  const stale = U.summary(h, [{ in: 1, usd: .5 }], String, { profiles: { default: { ok: false, error: "unavailable", stale: true, updatedAt: now / 1000 - 7200 } } }, { now });
  const staleText = stale.map(text).join(" ");
  assert.ok(staleText.includes("Kullanım kaydı okunamadı"));
  assert.ok(staleText.includes("Son veri gösteriliyor"));
  assert.ok(staleText.includes("güncelleme: 2 sa önce"));
  assert.equal(cls(stale[1], "ustatus-ic").length, 1, "status carries an icon element");
  const en = load("en");
  const kinds = { "too-large": "too large", locked: "busy", missing: "was not found", schema: "unexpected layout" };
  for (const [kind, word] of Object.entries(kinds)) {
    const rows = en.summary(h, [{ in: 1 }], String, { profiles: { default: { ok: false, error: kind, stale: false } } });
    const status = rows.flatMap(r => cls(r, "ustatus"))[0];
    assert.ok(status.attrs.class.includes("bad"), `${kind}: no cached totals is an error`);
    assert.ok(text(status).includes(word), kind);
    assert.ok(text(status).includes("No totals yet"), kind);
  }
  // several profiles failing for the same reason produce one status, not a wall of text
  const many = en.summary(h, [{ in: 1 }], String, { profiles: { a: { ok: false, error: "too-large", stale: true }, b: { ok: false, error: "too-large", stale: true }, c: { ok: true } } });
  assert.equal(many.flatMap(r => cls(r, "ustatus")).length, 1);
});

test("usage UI: totals lead with the token count; calls and cost are secondary", () => {
  const U = load("en");
  const now = Date.now(); // one clock for the data and the view: a millisecond between two reads made 120 s stale
  const rows = U.summary(h, [{ in: 1500, cr: 0, cw: 0, out: 500, usd: 1.5, n: 1, estimated: true }, { n: 2 }], n => `${n / 1000}k`, { profiles: { default: { ok: true, updatedAt: now / 1000 - 120 } } }, { now });
  const total = rows[0];
  assert.equal(cls(total, "usage-big")[0].children[0], "2k");
  assert.equal(cls(total, "usage-unit")[0].children[0], "tokens");
  assert.equal(text(cls(total, "usage-sub")[0]).replace(/\s+/g, " ").trim(), "3 calls · ≈$1.50");
  assert.equal(rows.length, 1, "fresh data (2 min) shows no 'updated' line");
  const stale = U.summary(h, [{ in: 1 }], String, { profiles: { default: { ok: true, updatedAt: now / 1000 - 600 } } }, { now });
  assert.ok(text(stale.at(-1)).includes("updated 10 min ago"), "older than 2 min: a tiny timestamp");
  assert.equal(U.plural("usage.calls", 1), "1 call");
  assert.equal(load("tr").plural("usage.calls", 3), "3 çağrı");
});

test("usage UI: English default and live Turkish selection keep quota numbers and provider data intact", () => {
  assert.equal(i18n.getLanguage(), "en");
  const U = load();
  const fleet = { quotas: { claude: { provider: "claude", profile: "Araştırmacı", ok: true, stale: true, windows: [{ minutes: 300, used: 87, resetsAt: "2030-01-01T12:00:00Z" }] } } };
  const draw = () => U.quotaRows(h, fleet, { now: Date.parse("2030-01-01T10:00:00Z") }).map(text).join(" ");
  const en = draw();
  for (const word of ["Claude", "Araştırmacı", "5h", "resets in 2h 0m", "Older data", "87%"]) assert.ok(en.includes(word), word);
  i18n.setLanguage("tr");
  const tr = draw();
  for (const word of ["Claude", "Araştırmacı", "5 sa", "2 sa 0 dk sonra sıfırlanır", "Eski veri", "%87"]) assert.ok(tr.includes(word), word);
  i18n.setLanguage("en");
  assert.equal(draw(), en);
  assert.equal(fleet.quotas.claude.profile, "Araştırmacı");
});

test("usage fixture: token refresh retains the fixture's model rows", async () => {
  const { FixtureRelay } = require("../main/fixture");
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "usage.json"), "utf8")).relay;
  const relay = new FixtureRelay(snapshot);
  assert.equal((await relay.get("/tokens?days=7")).length, 2);
});

test("usage UI: per-model tokens/cost are shown rather than hidden in a daily graph", () => {
  const U = load();
  const rows = [{ day: "2030-01-01", agent: "Primary", model: "claude-example", in: 1, cr: 2, cw: 3, out: 4, usd: .5, n: 1, estimated: true }];
  const table = U.modelTable(h, rows, String);
  assert.ok(text(table).includes("claude-example"));
  assert.ok(text(table).includes("≈$0.50"));
  assert.ok(text(table).includes("10"));
});

test("quota refresh button: busy state, throttled and failed notes, one run per click", async () => {
  const U = load("en");
  const state = { busy: false, note: null };
  let redraws = 0, runs = 0, answer = { refreshed: true, throttled: false, timedOut: false, retryAfterS: 0 };
  const run = async () => { runs++; if (answer instanceof Error) throw answer; return answer; };
  const button = () => U.refreshButton(h, state, run, () => { redraws++; });
  let b = button();
  assert.equal(b.tag, "button");
  assert.equal(b.attrs["aria-busy"], "false");
  assert.match(text(b), /Refresh/);
  const click = b.attrs.onclick();
  assert.equal(state.busy, true);
  assert.equal(button().attrs.disabled, "disabled");
  assert.match(text(button()), /Refreshing/);
  await b.attrs.onclick();                       // a second click while busy does nothing
  assert.equal(runs, 1);
  await click;
  assert.equal(state.busy, false); assert.equal(state.note, null); assert.equal(redraws, 2);
  answer = { throttled: true, retryAfterS: 12 };
  await button().attrs.onclick();
  assert.match(state.note, /12 s/);
  answer = { timedOut: true };
  await button().attrs.onclick();
  assert.match(state.note, /slow/);
  answer = new Error("boom");
  await button().attrs.onclick();
  assert.match(state.note, /Could not refresh/);
  assert.equal(state.busy, false);
  const tr = load("tr");
  assert.match(text(tr.refreshButton(h, { busy: false }, run, () => {})), /Yenile/);
});
