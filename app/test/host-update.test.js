"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createHostUpdater } = require("../main/host-update");

const RELAY = { httpBase: "http://relay.test:9330", token: "r".repeat(32) };

function setup({ host = true, reply = { status: 202, body: { state: "started", version: "1.3.0" } }, file } = {}) {
  const calls = [];
  const settings = { data: { botscreen: { deviceToken: "d".repeat(64) }, updates: { host } } };
  file = file || path.join(fs.mkdtempSync(path.join(os.tmpdir(), "deck-hu-")), "host-update.json");
  const fetch = async (url, o) => {
    calls.push({ url, headers: o.headers, body: JSON.parse(o.body) });
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  };
  const hu = createHostUpdater({ relay: () => RELAY, settings, deviceId: () => "a1b2c3d4e5f60708", app: "1.3.0", file, fetch });
  return { hu, calls, file, settings };
}
const update = (o = {}) => ({ remote: { enabled: true, managed: true }, status: null, restarts: [], queueError: null, ...o });
const stateWith = (relay, plugins, u = update()) => ({
  app: "1.3.0",
  relay: { version: relay, older: relay !== "1.3.0" },
  plugins: plugins.map(([profile, version]) => ({ profile, version, older: version !== "1.3.0", source: "relay" })),
  update: u,
});

test("update(): sends the app version with the relay token and this device's key", async () => {
  const x = setup();
  const r = await x.hu.update();
  assert.equal(r.ok, true);
  assert.equal(x.calls[0].url, "http://relay.test:9330/host/update");
  assert.deepEqual(x.calls[0].body, { version: "1.3.0" });
  assert.equal(x.calls[0].headers.authorization, `Bearer ${"r".repeat(32)}`);
  assert.equal(x.calls[0].headers["x-deck-device-id"], "a1b2c3d4e5f60708");
  assert.equal(x.calls[0].headers["x-deck-device-token"], "d".repeat(64));
});

test("update(): without a device key it explains instead of calling; relay errors come back as text", async () => {
  const x = setup();
  x.settings.data.botscreen.deviceToken = "";
  assert.deepEqual(await x.hu.update(), { ok: false, error: "hostupd.needDeviceKey" });
  assert.equal(x.calls.length, 0);
  const y = setup({ reply: { status: 409, body: { error: "the relay is not running from an install root", command: "node relay/bin/deck-relay-update init ~/hermes-deck --dry-run" } } });
  const r = await y.hu.update();
  assert.equal(r.ok, false);
  assert.match(r.command, /deck-relay-update init/);
});

test("auto: off by default, only when the host is behind, once per version, also across restarts", async () => {
  const off = setup({ host: false });
  await off.hu.maybeAuto(stateWith("1.2.0", [["default", "1.2.0"]]));
  assert.equal(off.calls.length, 0, "setting off");
  const x = setup();
  await x.hu.maybeAuto(stateWith("1.3.0", [["default", "1.3.0"]]));
  assert.equal(x.calls.length, 0, "host current: a second Deck sends nothing");
  await x.hu.maybeAuto(stateWith("1.2.0", [["default", "1.2.0"]]));
  await x.hu.maybeAuto(stateWith("1.2.0", [["default", "1.2.0"]])); // reconnect
  assert.equal(x.calls.length, 1);
  const again = setup({ file: x.file }); // app restart
  await again.hu.maybeAuto(stateWith("1.2.0", [["default", "1.2.0"]]));
  assert.equal(again.calls.length, 0, "remembered across restarts");
});

test("auto: nothing while an update runs, when remote updates are off, or without an install root", async () => {
  const x = setup();
  await x.hu.maybeAuto(stateWith("1.2.0", [], update({ status: { version: "1.3.0", state: "running" } })));
  await x.hu.maybeAuto(stateWith("1.2.0", [], update({ remote: { enabled: false, managed: true } })));
  await x.hu.maybeAuto(stateWith("1.2.0", [], update({ remote: { enabled: true, managed: false } })));
  await x.hu.maybeAuto(stateWith("1.2.0", [], null));
  assert.equal(x.calls.length, 0);
});

test("auto: a version that failed is never sent again automatically", async () => {
  const y = setup({ reply: { status: 500, body: { error: "bus" } } });
  await y.hu.maybeAuto(stateWith("1.2.0", []));
  assert.equal(y.calls.length, 1);
  await y.hu.maybeAuto(stateWith("1.2.0", []));
  assert.equal(y.calls.length, 1, "the failed send is remembered");
  const z = setup();
  await z.hu.maybeAuto(stateWith("1.2.0", [], update({ status: { version: "1.3.0", state: "rolled-back" } })));
  await z.hu.maybeAuto(stateWith("1.2.0", [], update({ status: null })));
  assert.equal(z.calls.length, 0, "a failure reported by the relay also stops the automatic mode");
});

test("restart(profile) posts the profile", async () => {
  const x = setup({ reply: { status: 200, body: { ok: true, state: "restarted", profile: "default" } } });
  assert.equal((await x.hu.restart("default")).ok, true);
  assert.equal(x.calls[0].url, "http://relay.test:9330/host/restart");
  assert.deepEqual(x.calls[0].body, { profile: "default" });
});
