"use strict";
// Inline detail of one tool call (Work › Run rows, sub-agent calls): arguments and output, both open.
// `patch` / `write_file` calls show their diff (diff-view.js) instead of raw arguments. Full calls are read once from
// the relay when the published preview was cut. DOM is built through an injected `h`: text nodes only.
(function (root) {
  const diffModule = () => root.DeckDiff || (typeof module === "object" && typeof require === "function" ? require("./diff-view") : null);
  const FULL_CAP = 64;
  const clipped = value => typeof value === "string" && value.endsWith("…");
  function parse(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value !== "string") return null;
    try { const v = JSON.parse(value); return v && typeof v === "object" && !Array.isArray(v) ? v : null; } catch { return null; }
  }
  /** Whether a call's published preview was cut (plugin `…`, relay `truncated`), so the detail should read the full call. */
  function needsFull(c) {
    if (!c || !c.call) return false;
    if (c.truncated === true || clipped(c.args) || clipped(c.result) || clipped(c.err)) return true;
    // a file tool whose arguments do not parse cannot be diffed from its preview
    return !!diffModule()?.toolKind(String(c.tool || "")) && typeof c.args === "string" && c.args !== "" && !parse(c.args);
  }

  /**
   * Full-call reads (`deck.toolCall`): at most one per (sid, call), kept in an LRU of `cap` entries. A call read while
   * it was running is read once more after it finishes, for its result. `forget` lets a failed read be retried.
   */
  function createFullCalls({ read, onChange, cap = FULL_CAP }) {
    const entries = new Map();
    const keyOf = (sid, call) => `${sid}\n${call}`;
    function get(sid, c) {
      if (!sid || !c || !c.call || typeof read !== "function") return null;
      const key = keyOf(sid, c.call), was = entries.get(key);
      if (was) { entries.delete(key); entries.set(key, was); }
      const finished = !!c.status && c.status !== "running";
      if (was && !(was.state === "done" && was.whileRunning && finished && !was.hasResult)) return was;
      if (!was && !needsFull(c)) return null;
      const entry = { state: "loading", data: was?.data || null, hasResult: false, whileRunning: !finished };
      entries.set(key, entry);
      while (entries.size > cap) entries.delete(entries.keys().next().value);
      Promise.resolve().then(() => read(sid, c.call)).then(data => {
        entry.data = data && typeof data === "object" ? data : null;
        entry.hasResult = typeof entry.data?.result === "string";
        entry.state = "done";
      }, () => { entry.state = "error"; }).then(() => { if (typeof onChange === "function") onChange(sid, c.call); });
      return entry;
    }
    const forget = (sid, call) => { const e = entries.get(keyOf(sid, call)); if (e && e.state === "error") entries.delete(keyOf(sid, call)); };
    const peek = (sid, call) => entries.get(keyOf(sid, call)) || null;
    return { get, peek, forget, size: () => entries.size };
  }
  /** The call with the full stored arguments/result in place of its previews. `capped`: the store clipped it too. */
  function merged(c, entry) {
    const d = entry && entry.data;
    if (!d) return c;
    return { ...c, args: typeof d.args === "string" ? d.args : c.args, result: typeof d.result === "string" ? d.result : c.result,
      truncated: false, capped: d.truncated === true };
  }
  const textOf = value => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value, null, 2);
  /** What the Output section shows: a readable error first, else the result. */
  function outputOf(c) {
    if (c.err && !(clipped(c.err) && c.result)) return { text: textOf(c.err), error: true };
    if (c.result != null && c.result !== "") return { text: textOf(c.result), error: false };
    return { text: "", error: false };
  }

  function fields(h, value, key) {
    return h("dl", { class: "td-kv" }, Object.entries(value).slice(0, 64).map(([name, v]) => [h("dt", null, name),
      h("dd", null, typeof v === "string" ? h("pre", { class: "td-val", "data-keep": `${key}:f:${name}` }, v)
        : v && typeof v === "object" ? h("pre", { class: "td-val", "data-keep": `${key}:f:${name}` }, JSON.stringify(v, null, 2))
          : h("code", { class: "td-val" }, JSON.stringify(v)))]));
  }
  /** The result of a file tool in words (applied / written / failed); null when the result is not readable. */
  function summary(h, t, model) {
    if (!model) return null;
    if (model.error) return h("p", { class: "td-sum fail" }, `${t("diff.failed")}: ${model.error}`);
    const s = model.summary;
    if (!s) return null;
    if (model.kind === "write") {
      const size = diffModule()?.size(s.bytes) || String(s.bytes);
      return h("p", { class: "td-sum ok" }, [t("diff.written", { size }), s.verified ? t("diff.verified") : null].filter(Boolean).join(" · "));
    }
    return h("p", { class: "td-sum ok" }, t("diff.applied"));
  }
  /**
   * One call's detail, arguments and output both open. `o`: h, t, key (state prefix), isOn(key) / toggle(key) for
   * the Raw switches and the diff line cap, copy(text, key) and copied (the key that just copied), full (an entry
   * from createFullCalls, or null), failed (colour the output red).
   */
  function render(c, o) {
    const { h, t, key } = o, entry = o.full || null, call = merged(c, entry);
    const D = diffModule(), model = D ? D.fromCall(call) : null, diff = !!model && model.files.length > 0;
    const argsText = textOf(call.args), parsed = parse(call.args), out = outputOf(call);
    const rawArgs = o.isOn(`${key}:raw-args`), rawOut = o.isOn(`${key}:raw-out`);
    const note = entry?.state === "loading" ? t("tooldetail.loading")
      : entry?.state === "error" || (!entry && needsFull(c)) ? t("tooldetail.clipped") : call.capped ? t("tooldetail.capped") : null;
    const toggle = (k, on) => h("button", { class: "td-toggle", type: "button", "aria-pressed": on ? "true" : "false", onclick: () => o.toggle(k) }, t("tooldetail.raw"));
    const copy = (text, what) => text ? h("button", { class: "td-copy", type: "button", "aria-label": t(what === "args" ? "tooldetail.copyArgs" : "tooldetail.copyOutput"),
      onclick: () => o.copy(text, `${key}:${what}`) }, t(o.copied === `${key}:${what}` ? "tooldetail.copied" : "tooldetail.copy")) : null;
    const argsBody = !argsText ? h("p", { class: "td-empty" }, t("tooldetail.noArgs"))
      : diff && !rawArgs ? D.render(h, model, { t, key: `${key}:dv`, isFull: o.isOn, showAll: o.toggle })
        : parsed && !rawArgs ? fields(h, parsed, key) : h("pre", { class: "td-pre", "data-keep": `${key}:args` }, argsText);
    const said = model && out.text ? summary(h, t, model) : null;
    const outBody = !out.text ? h("p", { class: "td-empty" }, t(c.status === "running" ? "work.running" : "work.noOutput"))
      : said && !rawOut ? said : h("pre", { class: `td-pre${out.error || o.failed ? " fail" : ""}`, "data-keep": `${key}:out` }, out.text);
    return h("div", { class: "td", "data-detail": c.call },
      note ? h("p", { class: "td-note", role: "status" }, note) : null,
      h("section", { class: "td-sec" }, h("header", null, h("span", null, t("work.arguments")), diff || parsed ? toggle(`${key}:raw-args`, rawArgs) : null, copy(argsText, "args")), argsBody),
      h("section", { class: "td-sec" }, h("header", null, h("span", null, t("tooldetail.output")), said ? toggle(`${key}:raw-out`, rawOut) : null, copy(out.text, "output")), outBody));
  }

  const api = { needsFull, createFullCalls, merged, outputOf, render };
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DeckToolDetail = Object.freeze(api);
})(typeof window === "object" ? window : globalThis);
