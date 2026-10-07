"use strict";
// D3 uses the existing presence routes. A route is fenced until the authenticated target has restored it.
const fs = require("fs");
const path = require("path");
const { CdpClient } = require("./cdp-view");
const { exportState, importState, sealBundle, openBundle } = require("./browser-bundle");
const send = (ws, body) => ws && ws.readyState === 1 && ws.send(JSON.stringify(body));
const sourceOf = (route) => route.host.kind === "fallback" ? "fallback" : route.host.id;

class BrowserTransfers {
  constructor({ presence, bundles, fallback, identity, policyFile = null, broadcast = () => {}, now = Date.now,
    restore = null, decode = openBundle }) {
    Object.assign(this, { presence, bundles, fallback, identity, policyFile, broadcast, now, decode });
    this.restore = restore || (async (slug, state) => {
      const browser = await fallback.ensure(slug);
      const result = await importState(browser, state, CdpClient);
      fallback.setController(slug, state.controller === "user" ? "user" : "agent");
      return result;
    });
    this.policies = new Map();
    this.pending = new Map();
    this.exporting = new Set();
    this.sleepTimers = new Map();
    if (policyFile) {
      try {
        const list = JSON.parse(fs.readFileSync(policyFile, "utf8"));
        for (const [id, target] of Array.isArray(list) ? list : []) {
          if (/^[a-f0-9]{8,64}$/.test(id) && (target === "fallback" || /^[a-f0-9]{8,64}$/.test(target))) this.policies.set(id, target);
        }
      } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    this.lost = ({ old, why }) => {
      if (!old || old.capability !== "browser" || why !== "lost") return;
      const source = sourceOf(old);
      const target = this.policies.get(source);
      const checkpoint = target && this.bundles.latestCheckpoint(source, old.sessionKey);
      if (!checkpoint || checkpoint.target !== target || !this.bundles.identity(target)?.fresh) {
        if (presence.holdTransfer(old.sessionKey, "browser", old)) presence.finishTransfer(old.sessionKey, "browser");
        this.broadcast({ t: "bundle-status", slug: old.sessionKey, status: "error", error: "Tarayıcı kaynağı çevrimdışı. Onaylı şifreli checkpoint veya hazır hedef bulunamadı; kaynak sabit tutuldu." });
        return;
      }
      this.stored(checkpoint, old).catch(() => {});
    };
    presence.on("route", this.lost);
    this.sleep = (id) => {
      if (this.sleepTimers.has(id)) return;
      // A suspend can freeze a Deck before its fresh export finishes. Give it 3 s, then use its checkpoint.
      const timer = setTimeout(() => {
        this.sleepTimers.delete(id);
        for (const old of [...presence.routes.values()]) {
          if (old.capability === "browser" && sourceOf(old) === id) this.lost({ old, why: "lost" });
        }
      }, 3000);
      if (timer.unref) timer.unref();
      this.sleepTimers.set(id, timer);
    };
    presence.on("sleep", this.sleep);
  }

  policy(ws, { autoTarget }) {
    const actor = this.bundles.boundDevice(ws);
    if (!actor) throw new Error("Cihaz kimliği doğrulanmadı.");
    if (autoTarget !== null && (!this.bundles.identity(autoTarget)?.fresh || autoTarget === actor)) throw new Error("Aktarım hedefi hazır değil.");
    if (autoTarget) this.policies.set(actor, autoTarget);
    else this.policies.delete(actor);
    if (this.policyFile) {
      fs.mkdirSync(path.dirname(this.policyFile), { recursive: true });
      const tmp = `${this.policyFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.policies]), { mode: 0o600 });
      fs.renameSync(tmp, this.policyFile);
    }
  }

  check(meta) {
    const old = this.presence.routes.get(`browser\t${meta.slug}`);
    if (!old || sourceOf(old) !== meta.source || this.pending.has(meta.slug)) throw new Error("Bu tarayıcının kaynağı değişti; aktarımı yeniden dene.");
    if (meta.reason !== "checkpoint" && !this.bundles.identity(meta.target)?.fresh) throw new Error("Aktarım hedefi hazır değil.");
  }

  async request(ws, slug, { target }) {
    if (!this.bundles.boundDevice(ws)) throw new Error("Aktarım için cihaz anahtarını Ayarlar > Bu cihaz bölümüne ekle.");
    const dest = this.bundles.identity(target);
    if (!dest?.fresh) throw new Error("Hedef cihaz ajan tarayıcısına açık değil.");
    const route = this.presence.routes.get(`browser\t${slug}`) || this.presence.routeFor(slug, "browser");
    if (!route || sourceOf(route) === target) throw new Error("Ajan tarayıcısı başka bir cihazda çalışmalı.");
    const source = sourceOf(route);
    if (source === "fallback") {
      if (!this.fallback || !this.identity) throw new Error("Ajan makinesinde aktarım hazır değil.");
      const browser = this.fallback.peek(slug);
      if (!browser || browser.status !== "running") throw new Error("Tarayıcı çalışmıyor.");
      browser.transferring = true;
      try {
        const state = await exportState(browser, CdpClient);
        this.bundles.putServer(await sealBundle(state, { source, target, slug, publicKey: dest.publicKey, now: this.now() }));
      } catch (e) { browser.transferring = false; throw e; }
    } else {
      const sourceConn = this.bundles.connOf(source);
      if (!sourceConn) throw new Error("Kaynak cihaz bağlı değil.");
      send(sourceConn, { t: "bundle-export", slug, target, publicKey: dest.publicKey });
    }
    return { queued: true };
  }

  async stored(meta, old = this.presence.routes.get(`browser\t${meta.slug}`)) {
    if (meta.reason === "checkpoint" && !old) return;
    if (!old || sourceOf(old) !== meta.source || this.pending.has(meta.slug)) return;
    const target = this.bundles.identity(meta.target);
    if (!target?.fresh || !this.presence.holdTransfer(meta.slug, "browser", old)) return;
    const timer = setTimeout(() => this.failed(meta.id, "Aktarım hedefi 60 saniyede yanıt vermedi."), 60_000);
    if (timer.unref) timer.unref();
    this.pending.set(meta.slug, { ...meta, timer });
    this.broadcast({ t: "bundle-status", slug: meta.slug, status: "importing", target: meta.target, checkpointAt: meta.createdAt });
    try {
      if (meta.target === "fallback") {
        const envelope = this.bundles.getServer(meta.id);
        const state = await this.decode(envelope, this.identity, { deviceId: "fallback", now: this.now() });
        await this.restore(meta.slug, state);
        this.applied(null, meta.id, "fallback");
      } else {
        const ws = this.bundles.connOf(meta.target);
        if (!ws) throw new Error("Hedef cihaz bağlı değil.");
        send(ws, { t: "bundle-ready", ...meta });
      }
    } catch (e) { this.failed(meta.id, String(e.message || e)); }
  }

  applied(ws, id, internal = null) {
    const actor = internal || this.bundles.boundDevice(ws);
    const pending = [...this.pending.values()].find((m) => m.id === id);
    if (!pending || pending.target !== actor) throw new Error("Aktarım sahipliği doğrulanmadı.");
    if (actor === "fallback") this.bundles.getServer(id);
    else this.bundles.get(actor, id); // fails closed if expiry/revocation deleted it during import
    if (!this.bundles.identity(actor)?.fresh) throw new Error("Hedef cihaz artık hazır değil.");
    if (actor === "fallback") this.bundles.ackServer(id);
    else this.bundles.ack(actor, id); // acknowledge storage successfully before making the route usable
    if (!this.presence.finishTransfer(pending.slug, "browser", actor)) throw new Error("Hedef cihaz artık hazır değil.");
    clearTimeout(pending.timer);
    this.pending.delete(pending.slug);
    if (pending.source === "fallback") {
      const b = this.fallback?.peek(pending.slug);
      // a launched headless browser is ours to stop; an attached external one (no proc) is never closed or killed, it
      // just stops being gated so the agent can use it again if the user moves the browser back to the agent host
      if (b) b.transferring = false;
      if (b?.proc) b.proc.kill();
    } else send(this.bundles.connOf(pending.source), { t: "bundle-exported", slug: pending.slug, id });
    this.broadcast(this.presence.state());
    this.broadcast({ t: "bundle-status", slug: pending.slug, status: "done", target: actor, checkpointAt: pending.createdAt });
  }

  failed(id, error, ws = null) {
    const meta = [...this.pending.values()].find((m) => m.id === id);
    if (!meta || (ws && this.bundles.boundDevice(ws) !== meta.target)) return;
    clearTimeout(meta.timer);
    this.pending.delete(meta.slug);
    if (meta.source === "fallback") {
      const b = this.fallback?.peek(meta.slug);
      if (b) b.transferring = false;
    } else send(this.bundles.connOf(meta.source), { t: "bundle-status", slug: meta.slug, status: "error", error: String(error).slice(0, 200) });
    this.presence.finishTransfer(meta.slug, "browser");
    this.broadcast(this.presence.state());
    this.broadcast({ t: "bundle-status", slug: meta.slug, status: "error", error: String(error).slice(0, 200) });
  }

  async op(ws, slug, m) {
    if (m.op === "transfer-policy") return this.policy(ws, m);
    if (m.op === "transfer-export") return this.request(ws, slug, m);
    if (m.op === "transfer-applied") return this.applied(ws, m.bundleId);
    if (m.op === "transfer-failed") return this.failed(m.bundleId, m.error || "Aktarım reddedildi.", ws);
    if (m.op === "transfer-state") {
      const actor = this.bundles.boundDevice(ws);
      if (!actor) throw new Error("Cihaz kimliği doğrulanmadı.");
      const pending = this.pending.get(slug);
      if (pending) {
        if (pending.target !== actor || pending.id !== m.bundleId) throw new Error("Aktarım sahipliği doğrulanmadı.");
        return { committed: false, pending: true };
      }
      const route = this.presence.routes.get(`browser\t${slug}`);
      const pin = this.presence.pinOf(slug, "browser");
      return { committed: !!(route && sourceOf(route) === actor) || !!(pin && (pin.kind === "fallback" ? "fallback" : pin.id) === actor), pending: false };
    }
    if (m.op === "transfer-abort") {
      const actor = this.bundles.boundDevice(ws);
      if (!actor) throw new Error("Cihaz kimliği doğrulanmadı.");
      const pending = this.pending.get(slug);
      if (pending) {
        if (pending.source !== actor) throw new Error("Kaynak cihaz doğrulanmadı.");
        this.failed(pending.id, "Kaynak cihaz aktarımı iptal etti.");
        return { committed: false };
      }
      const route = this.presence.routes.get(`browser\t${slug}`);
      const pin = this.presence.pinOf(slug, "browser");
      return { committed: !!(route && sourceOf(route) !== actor) || !!(pin && (pin.kind === "fallback" ? "fallback" : pin.id) !== actor) };
    }
    throw new Error("Geçersiz aktarım isteği.");
  }

  stop() {
    this.presence.off("route", this.lost);
    this.presence.off("sleep", this.sleep);
    for (const timer of this.sleepTimers.values()) clearTimeout(timer);
    for (const m of this.pending.values()) this.failed(m.id, "Relay kapanıyor.");
  }

  connected(ws) {
    const actor = this.bundles.boundDevice(ws);
    for (const m of this.pending.values()) if (m.target === actor) send(ws, { t: "bundle-ready", ...m, timer: undefined });
  }
}
module.exports = { BrowserTransfers };
