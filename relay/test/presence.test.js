"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { Presence, parseHeartbeat } = require("../src/presence");

const PC = "a1b2c3d4e5f60708";
const MAC = "0f0e0d0c0b0a0908";
const beat = (id, extra = {}) => ({ t: "heartbeat", device: { id, name: id === PC ? "Desk PC" : "MacBook" }, os: "win32", idleSec: 5, locked: false, hosting: { browser: true, desktop: false }, driverOk: true, ...extra });
const clock = () => {
  const c = { t: 1_000_000_000 };
  c.now = () => c.t;
  c.add = (s) => (c.t += s * 1000);
  return c;
};

test("presence: heartbeats are validated, hosting defaults to off", () => {
  const now = 1;
  assert.strictEqual(parseHeartbeat({ device: { id: "not-hex!" } }, now), null);
  assert.strictEqual(parseHeartbeat({ device: { id: "abc" } }, now), null); // too short
  assert.strictEqual(parseHeartbeat(null, now), null);
  const hb = parseHeartbeat({ device: { id: PC.toUpperCase(), name: "x\u0000y".repeat(40) }, idleSec: "7" }, now);
  assert.strictEqual(hb.id, PC);
  assert.ok(hb.name.length <= 64 && !hb.name.includes("\u0000"));
  assert.deepStrictEqual(hb.hosting, { browser: false, desktop: false });
  assert.strictEqual(hb.idleSec, 7);
  assert.strictEqual(parseHeartbeat({ device: PC }, now).idleSec, Infinity); // no idle reading = never active
  assert.deepStrictEqual(parseHeartbeat({ device: PC, driverOk: { browser: false, bogus: true } }, now).driverOk, { browser: false });
});

test("presence: active device = least idle of those fresh, unlocked, idle < 120 s, switch on", () => {
  const c = clock();
  const p = new Presence({ now: c.now });
  const pc = {};
  const mac = {};
  p.connect(pc);
  p.connect(mac);
  assert.strictEqual(p.activeDevice("browser"), null);
  p.heartbeat(pc, beat(PC, { idleSec: 30 }));
  p.heartbeat(mac, beat(MAC, { idleSec: 3 }));
  assert.strictEqual(p.activeDevice("browser").id, MAC);
  p.heartbeat(mac, beat(MAC, { idleSec: 3, locked: true }));
  assert.strictEqual(p.activeDevice("browser").id, PC); // locked does not count
  p.heartbeat(mac, beat(MAC, { idleSec: 1, hosting: { browser: false } }));
  assert.strictEqual(p.activeDevice("browser").id, PC); // its owner said no
  p.heartbeat(mac, beat(MAC, { idleSec: 1, driverOk: { browser: false } }));
  assert.strictEqual(p.activeDevice("browser").id, PC); // cannot (no browser found)
  p.heartbeat(pc, beat(PC, { idleSec: 130 }));
  assert.strictEqual(p.activeDevice("browser"), null); // nobody touched a device for 2 minutes
  p.heartbeat(pc, beat(PC, { idleSec: 10 }));
  c.add(31);
  assert.strictEqual(p.activeDevice("browser"), null); // heartbeat older than 30 s
  // capabilities are separate switches
  p.heartbeat(pc, beat(PC, { idleSec: 0, hosting: { browser: false, desktop: true } }));
  assert.strictEqual(p.activeDevice("browser"), null);
  assert.strictEqual(p.activeDevice("desktop").id, PC);
  assert.strictEqual(p.activeDevice("nonsense"), null);
});

test("presence: routes are sticky per session and every change bumps the epoch", () => {
  const c = clock();
  const p = new Presence({ now: c.now });
  const events = [];
  p.on("route", (e) => events.push(e.why));
  const pc = {};
  const mac = {};
  p.connect(pc);
  p.connect(mac);
  p.heartbeat(pc, beat(PC, { idleSec: 2 }));
  p.heartbeat(mac, beat(MAC, { idleSec: 50 }));

  const r1 = p.routeFor("scout", "browser");
  assert.strictEqual(r1.host.id, PC);
  assert.strictEqual(r1.epoch, p.epoch);
  const e1 = p.epoch;

  // the user moves to the Mac: the running session stays on the PC
  p.opened(r1);
  p.heartbeat(pc, beat(PC, { idleSec: 90 }));
  p.heartbeat(mac, beat(MAC, { idleSec: 1 }));
  c.add(400);
  p.heartbeat(pc, beat(PC, { idleSec: 400 }));
  p.heartbeat(mac, beat(MAC, { idleSec: 1 }));
  assert.strictEqual(p.routeFor("scout", "browser"), r1); // open connection: never "ended"
  assert.strictEqual(p.epoch, e1);
  // a second agent starts now: it goes where the user is
  assert.strictEqual(p.routeFor("research", "browser").host.id, MAC);

  // session end: no open connection and no use for sessionIdleS -> the next use is a new route
  p.closed(r1);
  c.add(301);
  p.heartbeat(mac, beat(MAC, { idleSec: 1 }));
  p.heartbeat(pc, beat(PC, { idleSec: 700 }));
  const r2 = p.routeFor("scout", "browser");
  assert.notStrictEqual(r2, r1);
  assert.strictEqual(r2.host.id, MAC);
  assert.ok(r2.epoch > e1);
  assert.ok(events.includes("ended") && events.filter((w) => w === "new").length === 3);

  // device loss: the Mac disconnects -> its routes are dropped at once, the epoch moves
  const before = p.epoch;
  p.disconnect(mac);
  assert.ok(p.epoch > before);
  assert.ok(events.includes("lost"));
  p.heartbeat(pc, beat(PC, { idleSec: 0 }));
  assert.strictEqual(p.routeFor("scout", "browser").host.id, PC);

  // the owner switches hosting off: that is device loss for this capability too
  p.heartbeat(pc, beat(PC, { idleSec: 0, hosting: { browser: false } }));
  assert.strictEqual(p.routeFor("scout", "browser"), null); // no device, no fallback: "çalışma alanı yok"
  assert.strictEqual(p.state().routes.length, 0);
});

test("presence: fallback host from .env when no device qualifies; handoff moves a session", () => {
  const c = clock();
  const p = new Presence({ now: c.now, browserDefault: "device", fallback: { browser: { name: "mini (yedek)" } } });
  const r = p.routeFor("scout", "browser");
  assert.deepStrictEqual(r.host, { kind: "fallback", id: "fallback", name: "mini (yedek)" });
  assert.strictEqual(p.routeFor("x", "desktop"), null); // no desktop fallback configured

  const pc = {};
  p.connect(pc);
  p.heartbeat(pc, beat(PC, { idleSec: 0 }));
  assert.strictEqual(p.routeFor("scout", "browser"), r); // sticky: still the fallback
  let moved = null;
  p.on("route", (e) => (moved = e));
  const h = p.handoff("scout", "browser", PC);
  assert.strictEqual(h.host.id, PC);
  assert.strictEqual(moved.why, "handoff");
  assert.strictEqual(moved.old, r);
  assert.ok(h.epoch > r.epoch);
  assert.strictEqual(p.routeFor("scout", "browser"), h);
  assert.strictEqual(p.handoff("scout", "browser", MAC), null); // not connected
  assert.strictEqual(p.connOf(PC), pc);
});

test("presence: the state pushed to decks does not change just because time passes", () => {
  const c = clock();
  const p = new Presence({ now: c.now });
  const pc = {};
  p.connect(pc);
  p.heartbeat(pc, beat(PC, { idleSec: 1 }));
  p.routeFor("scout", "browser");
  const s1 = JSON.stringify(p.state());
  c.add(5);
  p.heartbeat(pc, beat(PC, { idleSec: 6 }));
  assert.strictEqual(JSON.stringify(p.state()), s1);
  const s = p.state();
  assert.strictEqual(s.t, "devices");
  assert.strictEqual(s.active.browser, PC);
  assert.strictEqual(s.routes[0].host.name, "Desk PC");
  assert.ok(!("idleSec" in s.devices[0]));
});

test("presence: a pin fixes one agent's place; a pinned device needs no recent input; a new pin moves the session", () => {
  const c = clock();
  const p = new Presence({ now: c.now, browserDefault: "device", fallback: { browser: { name: "agent host" } }, hostName: "agent host" });
  const saved = [];
  p.on("pins", () => saved.push(p.pinList()));
  const pc = {};
  const mac = {};
  p.connect(pc);
  p.connect(mac);
  p.heartbeat(pc, beat(PC, { idleSec: 500 })); // idle: never the active device
  p.heartbeat(mac, beat(MAC, { idleSec: 1 }));
  assert.strictEqual(p.routeFor("scout", "browser").host.id, MAC); // Otomatik: where the user is
  const events = [];
  p.on("route", (e) => events.push(e));

  // "Bu bilgisayar" on the idle PC: the running session moves there at once (sockets to the Mac are cut)
  assert.deepStrictEqual(p.setPin("scout", "browser", { kind: "device", id: PC }), { ok: true });
  const moved = events.pop();
  assert.strictEqual(moved.why, "handoff");
  assert.strictEqual(moved.old.host.id, MAC);
  assert.strictEqual(moved.next.host.id, PC);
  assert.strictEqual(p.routeFor("scout", "browser").host.id, PC);
  assert.deepStrictEqual(p.state().pins, [{ sessionKey: "scout", capability: "browser", host: { kind: "device", id: PC, name: "Desk PC" } }]);
  assert.deepStrictEqual(p.state().agentHost, { name: "agent host" });
  assert.strictEqual(p.routeFor("research", "browser").host.id, MAC); // other agents still go where the user is

  // the pinned PC goes away: no route at all; neither the Mac nor the agent host stands in
  p.disconnect(pc);
  assert.strictEqual(p.routeFor("scout", "browser"), null);
  assert.strictEqual(p.pinOf("scout", "browser").name, "Desk PC"); // the gateway names it to the agent

  // the agent host
  assert.deepStrictEqual(p.setPin("scout", "browser", { kind: "fallback" }), { ok: true });
  assert.strictEqual(p.routeFor("scout", "browser").host.kind, "fallback");
  // Otomatik again: the running route stays (sticky); the pin is gone
  assert.deepStrictEqual(p.setPin("scout", "browser", null), { ok: true });
  assert.strictEqual(p.routeFor("scout", "browser").host.kind, "fallback");
  assert.deepStrictEqual(p.state().pins, []);

  // refused: a device that cannot host now, an agent host without a browser, a bad key or place
  p.heartbeat(mac, beat(MAC, { idleSec: 1, hosting: { browser: false } }));
  assert.deepStrictEqual(p.setPin("scout", "browser", { kind: "device", id: MAC }), { ok: false, code: "device", why: "hosting" });
  assert.deepStrictEqual(p.setPin("scout", "browser", { kind: "device", id: "0123456789abcdef" }), { ok: false, code: "device", why: "offline" });
  const q = new Presence({ now: c.now });
  assert.deepStrictEqual(q.setPin("scout", "browser", { kind: "fallback" }), { ok: false, code: "fallback" });
  assert.deepStrictEqual(q.setPin("../x", "browser", null), { ok: false, code: "bad" });
  assert.deepStrictEqual(q.setPin("scout", "browser", { kind: "elsewhere" }), { ok: false, code: "bad" });
  assert.strictEqual(saved.length, 3); // only real changes are saved
});

test("presence: saved pins are validated on load and apply once their device is back", () => {
  const p = new Presence({ fallback: { browser: { name: "h" } } });
  p.loadPins([
    { sessionKey: "scout", capability: "browser", host: { kind: "device", id: PC, name: "Desk PC" } },
    { sessionKey: "x", capability: "browser", host: { kind: "fallback" } },
    { sessionKey: "Bad Key", capability: "browser", host: { kind: "fallback" } },
    { sessionKey: "y", capability: "nope", host: { kind: "fallback" } },
    { sessionKey: "z", capability: "browser", host: { kind: "device", id: "zz" } },
    null,
  ]);
  assert.deepStrictEqual(p.pinList().map((x) => x.sessionKey), ["scout", "x"]);
  assert.strictEqual(p.routeFor("scout", "browser"), null); // its device is not connected yet
  const pc = {};
  p.connect(pc);
  p.heartbeat(pc, beat(PC, { idleSec: 900 }));
  assert.strictEqual(p.routeFor("scout", "browser").host.id, PC);
  assert.strictEqual(p.routeFor("x", "browser").host.kind, "fallback");
  assert.strictEqual(p.deviceOf(pc), PC);
});

test("desktop default host: an unpinned agent goes to the agent host (its space), not the active device", () => {
  const { Presence } = require("../src/presence");
  const p = new Presence({ fallback: { desktop: { id: "host", name: "agent host" } }, desktopDefault: "host" });
  const ws = {};
  p.connect(ws);
  p.heartbeat(ws, { t: "heartbeat", device: { id: "a1b2c3d4", name: "pc" }, idleSec: 0, hosting: { browser: false, desktop: true }, driverOk: true });
  const r = p.routeFor("p:aurora", "desktop");
  assert.equal(r.host.kind, "fallback");
  const legacy = new Presence({ fallback: { desktop: { id: "host", name: "agent host" } } });
  legacy.connect(ws);
  legacy.heartbeat(ws, { t: "heartbeat", device: { id: "a1b2c3d4", name: "pc" }, idleSec: 0, hosting: { browser: false, desktop: true }, driverOk: true });
  assert.equal(legacy.routeFor("p:aurora", "desktop").host.kind, "device", "default stays device-first");
});

test("a desktop pin set for p:<profile> applies to every route key of that profile, and clearing it goes back to the space", () => {
  const { Presence } = require("../src/presence");
  const p = new Presence({ fallback: { desktop: { id: "host", name: "agent host" } }, desktopDefault: "host" });
  const ws = {};
  p.connect(ws);
  p.heartbeat(ws, { t: "heartbeat", device: { id: "a1b2c3d4", name: "pc" }, idleSec: 0, hosting: { browser: false, desktop: true }, driverOk: true });
  assert.deepEqual(p.setPin("p:aurora", "desktop", { kind: "device", id: "a1b2c3d4" }), { ok: true });
  assert.equal(p.routeFor("p:aurora/k:agent:main:tg:1", "desktop").host.kind, "device");
  assert.equal(p.routeFor("p:pioneer/k:x", "desktop").host.kind, "fallback", "other agents unaffected");
  assert.deepEqual(p.setPin("p:aurora", "desktop", null), { ok: true });
  p.endSession("p:aurora/k:agent:main:tg:1", "desktop");
  assert.equal(p.routeFor("p:aurora/k:agent:main:tg:1", "desktop").host.kind, "fallback");
});

test("a desktop pin to a device that does not host desktop is refused", () => {
  const { Presence } = require("../src/presence");
  const p = new Presence({ fallback: { desktop: { id: "host", name: "agent host" } }, desktopDefault: "host" });
  const ws = {};
  p.connect(ws);
  p.heartbeat(ws, { t: "heartbeat", device: { id: "a1b2c3d4", name: "pc" }, idleSec: 0, hosting: { browser: true, desktop: false }, driverOk: false });
  assert.deepEqual(p.setPin("p:aurora", "desktop", { kind: "device", id: "a1b2c3d4" }), { ok: false, code: "device", why: "hosting" });
});

test("a refused device pin says why: the device is offline, its switch is off, or its driver is not ready", () => {
  const { Presence } = require("../src/presence");
  const p = new Presence({ fallback: { desktop: { id: "host", name: "agent host" } }, desktopDefault: "host" });
  const ws = {};
  p.connect(ws);
  const hb = (hosting, driverOk) => p.heartbeat(ws, { t: "heartbeat", device: { id: "a1b2c3d4", name: "pc" }, idleSec: 0, hosting, driverOk });
  assert.deepEqual(p.setPin("p:aurora", "desktop", { kind: "device", id: "ffffffff" }), { ok: false, code: "device", why: "offline" });
  hb({ browser: false, desktop: false }, true);
  assert.deepEqual(p.setPin("p:aurora", "desktop", { kind: "device", id: "a1b2c3d4" }), { ok: false, code: "device", why: "hosting" });
  hb({ browser: false, desktop: true }, { desktop: false });
  assert.deepEqual(p.setPin("p:aurora", "desktop", { kind: "device", id: "a1b2c3d4" }), { ok: false, code: "device", why: "driver" });
});
