"use strict";
const { t: i18nText, getLocale: i18nLocale } = require("../renderer/i18n");
// Browser state and consent belong to this Deck. The relay sees only target-key ciphertext and metadata.
const fs = require("fs");
const path = require("path");
const { loadIdentity, sealBundle, openBundle, exportState, importState } = require("./browser-bundle");
const { CdpClient } = require("./cdp-view");
const errorText = (e) => String(e.message || e).slice(0, 200);

class BrowserTransfer {
  constructor({ host, presence, settings, dir, protect, unprotect, request, emit, shot = false }) {
    Object.assign(this, { host, presence, settings, dir, protect, unprotect, request, emit, shot });
    this.relay = null;
    this.identity = null;
    this.registered = false;
    this.registration = null;
    this.error = null;
    this.exporting = new Set();
    this.importing = new Set();
    this.uncertainImports = new Map();
    this.policyFile = path.join(dir, "browser-transfer-consent.json");
    this.consent = { allowed: false, autoTarget: null };
    if (!shot) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.policyFile, "utf8"));
        this.consent = { allowed: saved.allowed === true, autoTarget: typeof saved.autoTarget === "string" ? saved.autoTarget : null };
      } catch { /* first export asks before any snapshot or upload */ }
    }
    this.tick = setInterval(() => this.checkpoint(), 10_000);
    if (this.tick.unref) this.tick.unref();
    this.suspend = () => this.checkpoint("sleep");
    presence.on("suspend", this.suspend);
  }
  state() {
    return { ready: this.registered, hasDeviceToken: !!this.settings?.data?.botscreen?.deviceToken,
      consented: this.consent.allowed, automaticTarget: this.consent.autoTarget, error: this.error };
  }
  attach(relay) {
    if (this.relay && this.status) this.relay.off("status", this.status);
    this.relay = relay;
    this.registered = false;
    this.status = (m) => {
      if (m.status === "open") this.register().catch((e) => this.fail(e));
      else this.registered = false;
    };
    if (relay && !this.shot) relay.on("status", this.status);
  }
  fail(e, slug = null) {
    this.error = errorText(e);
    this.emit({ t: "transfer-status", slug, status: "error", error: this.error });
  }
  async register() {
    if (this.shot || !this.relay || !this.settings?.data?.botscreen?.deviceToken) return;
    if (!this.identity) this.identity = await loadIdentity(path.join(this.dir, "browser-transfer-key.enc"), { protect: this.protect, unprotect: this.unprotect });
    this.presence.push(); // registration is bound to this authenticated connection's current heartbeat
    this.relay.send({ t: "bundle-hello", deviceId: this.presence.id, publicKey: this.identity.publicKey,
      deviceToken: this.settings.data.botscreen.deviceToken });
  }
  async http(method, endpoint, body) {
    if (!this.registered || !this.relay) throw new Error(i18nText("transfer.identityNotReady"));
    const r = await fetch(`${this.relay.httpBase}${endpoint}`, {
      method, headers: { authorization: `Bearer ${this.relay.token}`, "content-type": "application/json",
        "x-deck-device-id": this.presence.id, "x-deck-device-token": this.settings.data.botscreen.deviceToken },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(i18nText("transfer.httpError", { status: r.status }));
    return r.json();
  }
  async targets() {
    if (!this.registered) {
      await this.register();
      // register() sends only a public-key hello; wait for its authenticated answer before HTTP access.
      for (let i = 0; i < 40 && !this.registered; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return (await this.http("GET", "/bundle/devices")).devices;
  }
  async approve(target, automatic) {
    const devices = await this.targets();
    if (!devices.some((d) => d.deviceId === target && d.fresh)) throw new Error(i18nText("transfer.targetNotReady"));
    const next = { allowed: true, autoTarget: automatic === true && target !== this.presence.id ? target : null };
    await this.request("transfer-policy", "default", { autoTarget: next.autoTarget });
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.policyFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, this.policyFile);
    this.consent = next;
    return this.state();
  }
  async disableAutomatic() {
    await this.request("transfer-policy", "default", { autoTarget: null });
    this.consent.autoTarget = null;
    const tmp = `${this.policyFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.consent), { mode: 0o600 });
    fs.renameSync(tmp, this.policyFile);
    return this.state();
  }
  async handoff(slug, target) {
    if (this.shot) throw new Error(i18nText("transfer.shotDisabled"));
    const devices = await this.targets();
    const wanted = String(target || "").trim();
    const dest = devices.find((d) => d.deviceId === wanted);
    if (!dest?.fresh) throw new Error(i18nText("transfer.targetNotReady"));
    if (!this.consent.allowed) return { consentRequired: true, slug, target: dest.deviceId };
    return this.request("transfer-export", slug, { target: dest.deviceId });
  }
  async export(slug, target, publicKey, reason = "manual") {
    if (!this.consent.allowed) {
      if (reason !== "checkpoint") this.emit({ t: "transfer-consent", slug, target, publicKey });
      return;
    }
    if (this.exporting.has(slug)) return;
    const browser = this.host.peek(slug);
    if (!browser || browser.status !== "running") throw new Error(i18nText("transfer.browserNotRunning"));
    if (browser.transferring) return; // a checkpoint must not release an outstanding manual transfer's fence
    this.exporting.add(slug);
    browser.transferring = true;
    let posting = false;
    try {
      const state = await exportState(browser, CdpClient);
      const envelope = await sealBundle(state, { source: this.presence.id, target, slug, publicKey, reason });
      posting = true;
      await this.http("POST", "/bundle", envelope);
    } catch (e) {
      if (!posting || reason === "checkpoint") browser.transferring = false;
      else await this.reconcile(slug).catch(() => {}); // a lost HTTP response may follow an accepted import
      throw e;
    }
    finally {
      if (reason === "checkpoint") browser.transferring = false;
      this.exporting.delete(slug);
    }
  }
  async reconcile(slug) {
    const result = await this.request("transfer-abort", slug);
    const browser = this.host.peek(slug);
    if (browser && result?.committed) await browser.stop();
    if (browser) browser.transferring = false;
  }
  async checkpoint(reason = "checkpoint") {
    if (!this.registered || !this.consent.allowed || !this.consent.autoTarget) return;
    try {
      const dest = (await this.targets()).find((d) => d.deviceId === this.consent.autoTarget && d.fresh);
      if (!dest) return;
      for (const b of this.host.list()) {
        if (b.status === "running") await this.export(b.slug, dest.deviceId, dest.publicKey, reason);
      }
    } catch (e) { this.fail(e); }
  }
  async receive(m) {
    if (this.uncertainImports.has(m.id)) return this.retryImport(this.uncertainImports.get(m.id));
    if (this.importing.has(m.id)) return;
    if (!this.host.enabled()) throw new Error(i18nText("transfer.browserOff"));
    this.importing.add(m.id);
    let imported = null;
    let browser = null;
    let previousController = null;
    try {
      const envelope = (await this.http("GET", `/bundle/${m.id}`)).bundle;
      if (envelope.slug !== m.slug || envelope.source !== m.source || envelope.target !== this.presence.id) throw new Error(i18nText("transfer.identityMismatch"));
      const state = await openBundle(envelope, this.identity, { deviceId: this.presence.id });
      await this.host.ensure(m.slug);
      browser = this.host.peek(m.slug);
      previousController = browser.controller;
      imported = await importState(browser, state, CdpClient);
      this.host.setController(m.slug, state.controller === "user" ? "user" : "agent");
      await this.acknowledge({ m, browser, imported, previousController });
      // Only a successful import acknowledgement exposes this browser to the agent's existing CDP route.
    } catch (e) {
      if (e.uncertain) throw e; // preserve the only restored state when the relay may already have committed
      await this.discard({ browser, imported });
      if (browser && previousController) this.host.setController(m.slug, previousController);
      await this.request("transfer-failed", m.slug, { bundleId: m.id, error: errorText(e) }).catch(() => {});
      throw e;
    } finally { this.importing.delete(m.id); }
  }
  async acknowledge(record) {
    const { m } = record;
    try { await this.request("transfer-applied", m.slug, { bundleId: m.id }); }
    catch (e) {
      let state;
      try { state = await this.request("transfer-state", m.slug, { bundleId: m.id }); }
      catch {
        this.uncertainImports.set(m.id, record);
        throw Object.assign(new Error(i18nText("transfer.ackUncertain")), { uncertain: true });
      }
      if (!state?.committed) throw e;
    }
    this.uncertainImports.delete(m.id);
  }
  async discard({ browser, imported }) {
    if (!browser || !imported) return;
    let c;
    try {
      c = await new CdpClient(`ws://127.0.0.1:${browser.port}${browser.wsPath}`).connect(2000);
      for (const browserContextId of imported.contexts) await c.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    } catch { /* the browser may have stopped */ } finally { c?.close(); }
  }
  async retryImport(record) {
    try { await this.acknowledge(record); }
    catch (e) {
      if (!e.uncertain) {
        this.uncertainImports.delete(record.m.id);
        await this.discard(record);
        this.host.setController(record.m.slug, record.previousController);
        await this.request("transfer-failed", record.m.slug, { bundleId: record.m.id, error: errorText(e) }).catch(() => {});
      }
      throw e;
    }
  }
  onMessage(m) {
    if (m.t === "bundle-identity") {
      this.registered = m.ok === true;
      this.error = m.ok ? null : String(m.error || i18nText("transfer.identityRejected")).slice(0, 200);
      if (this.registered && this.consent.allowed) this.request("transfer-policy", "default", { autoTarget: this.consent.autoTarget }).catch((e) => this.fail(e));
      if (this.registered) for (const b of this.host.list()) {
        if (this.host.peek(b.slug)?.transferring) this.reconcile(b.slug).catch((e) => this.fail(e, b.slug));
      }
      if (this.registered) for (const record of this.uncertainImports.values()) this.retryImport(record).catch((e) => this.fail(e, record.m.slug));
      this.emit({ t: "transfer-state", state: this.state() });
      return true;
    }
    if (m.t === "bundle-export") {
      this.export(m.slug, m.target, m.publicKey).catch((e) => this.fail(e, m.slug));
      return true;
    }
    if (m.t === "bundle-ready") {
      this.receive(m).catch((e) => this.fail(e, m.slug));
      return true;
    }
    if (m.t === "bundle-exported") {
      const browser = this.host.peek(m.slug);
      if (browser) browser.stop().finally(() => { browser.transferring = false; }).catch((e) => this.fail(e, m.slug));
      return true;
    }
    if (m.t === "bundle-status") {
      if (m.status === "error" && m.slug) {
        const browser = this.host.peek(m.slug);
        if (browser) browser.transferring = false;
      }
      this.emit({ ...m, t: "transfer-status" });
      return true;
    }
    return false;
  }
  stop() {
    clearInterval(this.tick);
    this.presence.off("suspend", this.suspend);
    this.attach(null);
  }
}
module.exports = { BrowserTransfer };
