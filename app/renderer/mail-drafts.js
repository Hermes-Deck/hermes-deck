"use strict";
(function (root) {
  const FIELDS = ["from", "to", "cc", "bcc", "subject", "body"];
  const editable = r => ["draft", "failed", "approved"].includes(r.status);
  const text = v => Array.isArray(v) ? v.join("\n") : v;
  function create({ h, t, deck, doc }) {
    const el = h("section", { class: "te-mail", "aria-label": t("mail.title") });
    let profile = "default", host = "", profiles = [], ids = [], offset = 0, more = false, selected = null;
    let record = null, review = null, form = null, revision = "", busy = false, error = "", status = "", generation = 0, loaded = false;
    let account = null, prepared = false;
    const dirty = () => !!form && FIELDS.some(k => form.fields[k] !== text(form.base.versions.at(-1).fields[k]));
    const hasUnsaved = () => dirty() || !!revision.trim() || busy;
    const canReviewSend = () => !!review && record?.send_protocol === 1 && editable(record) && !dirty() && !revision.trim() && !conflict();
    const conflict = () => !!form && record && form.base.latest_version !== record.latest_version;
    const controls = new Map();
    const button = (key, fn, disabled = busy, primary = false) => {
      const node = h("button", { type: "button", class: `te-btn${primary ? " primary" : ""}`, disabled,
        dataset: { fk: key }, onclick: fn }, t(key));
      controls.set(key, node); return node;
    };
    function syncControls() {
      for (const [key, disabled] of Object.entries({
        "mail.save": busy || !dirty() || !review || conflict() || !editable(record),
        "mail.discardEdits": busy || !hasUnsaved(),
        "mail.requestRevision": busy || dirty() || !review || !revision.trim() || !editable(record),
        "mail.sender": busy || !canReviewSend(),
        "mail.prepare": busy || !canReviewSend() || !account || form?.fields.from !== undefined && form.fields.from !== account || record?.versions.at(-1).fields.from !== account,
        "mail.confirmSend": busy || !canReviewSend() || !prepared,
        "mail.previousPage": hasUnsaved() || offset === 0, "mail.nextPage": hasUnsaved() || !more,
      })) { const node = controls.get(key); if (node) node.disabled = disabled; }
    }
    function redraw(force = false) {
      // Unrelated snapshots never detach a focused editor or reset its selection/caret.
      if (!force && el.contains(doc.activeElement) && doc.activeElement?.dataset.hold) return;
      const focus = el.contains(doc.activeElement) ? doc.activeElement?.dataset.fk : null;
      const kids = [h("h2", { class: "te-group" }, t("mail.title")),
        h("div", { class: "te-actions" }, h("label", null, t("mail.profile"), h("select", { class: "te-answer", value: profile, disabled: hasUnsaved(),
          onchange: e => { if (hasUnsaved()) { e.target.value = profile; return; } profile = e.target.value; offset = 0; selected = null; record = null; form = null; load(); } },
        (profiles.length ? profiles : [{ name: profile }]).map(p => h("option", { value: p.name, selected: p.name === profile }, p.name)))),
        button("mail.refresh", () => load(), busy)),
        h("p", { class: "te-mail-source" }, t("mail.source", { host, profile })),
        h("p", { role: "status" }, t(record?.send_protocol === 1 ? "mail.sendInfo" : "mail.blocked"))];
      if (error) kids.push(h("p", { class: "te-error", role: "alert" }, error));
      if (status || busy) kids.push(h("p", { role: "status", "aria-live": "polite" }, busy ? t("mail.busy") : t(status)));
      for (const id of ids) {
        const active = selected === id;
        kids.push(h("article", { class: `te-row mail${active ? " sel" : ""}` },
          h("button", { class: "te-row-head", type: "button", disabled: busy || (hasUnsaved() && !active), "aria-expanded": String(active),
            onclick: () => open(id) }, h("span", { class: "te-kind", "aria-hidden": "true" }, "@"),
          h("span", { class: "te-row-title" }, h("b", null, active && record ? record.versions.at(-1).fields.subject || id : id),
          h("small", null, active && record ? t("mail.version", { n: record.latest_version }) : t("mail.open")))),
          active && record ? body() : null));
      }
      if (loaded && !ids.length && !error && !busy) kids.push(h("p", null, t("mail.empty")));
      kids.push(h("div", { class: "te-actions" },
        button("mail.previousPage", () => { if (hasUnsaved()) return; offset = Math.max(0, offset - 20); selected = null; record = null; load(); }, hasUnsaved() || offset === 0),
        button("mail.nextPage", () => { if (hasUnsaved()) return; offset += 20; selected = null; record = null; load(); }, hasUnsaved() || !more)));
      el.replaceChildren(...kids);
      if (focus) [...el.querySelectorAll("[data-fk]")].find(n => n.dataset.fk === focus)?.focus({ preventScroll: true });
    }
    function body() {
      const f = form?.fields || Object.fromEntries(FIELDS.map(k => [k, text(record.versions.at(-1).fields[k])]));
      const kids = [h("p", { class: "te-mail-source" }, `${record.id} · ${t("mail.version", { n: record.latest_version })} · ${profile} · ${host}`),
        account || !record.send_receipt ? h("p", null, account ? t("mail.accountVerified", { account }) : t("mail.accountUnavailable")) : null,
        h("p", null, t("mail.platform", { platform: record.platform || "—" })),
        h("p", { role: "status" }, t(record.status === "sent" && record.send_receipt?.state === "sent" ? "mail.sentVerified" : `mail.state.${record.status}`))];
      if (record.send_receipt) kids.push(h("p", { role: "status" }, t("mail.receipt", {
        account: record.send_receipt.account, n: record.send_receipt.version,
        state: t(`mail.receipt.${record.send_receipt.state}`), id: record.send_receipt.provider_id || "—" })));
      if (account && !prepared && editable(record)) kids.push(h("div", { class: "te-actions" },
        h("label", null, t("mail.senderAccount"), h("select", { class: "te-answer", value: account, disabled: busy },
          h("option", { value: account, selected: true }, account))),
        button("mail.useSender", () => { form = { base: form?.base || record, fields: { ...f, from: account } }; redraw(true); }, busy || f.from === account)));
      if (record.status_detail) kids.push(h("pre", { class: "te-finished" }, record.status_detail));
      if (conflict()) kids.push(h("p", { class: "te-error", role: "alert" }, t("mail.conflict")));
      for (const field of FIELDS) {
        const multiline = ["body", "to", "cc", "bcc"].includes(field);
        kids.push(h("label", { class: "te-mail-field" }, t(`mail.${field}`), h(multiline ? "textarea" : "input", {
          type: multiline ? undefined : "text", class: "te-answer", value: multiline ? undefined : f[field], rows: field === "body" ? 10 : 2,
          readOnly: busy || prepared || !editable(record), dataset: { hold: "1", fk: `mail:${field}` },
          oninput: e => {
            if (!form) form = { base: record, fields: { ...f } };
            form.fields[field] = e.target.value; syncControls();
          }, onblur: () => setTimeout(redraw, 0),
        }, multiline ? f[field] : null)));
      }
      const prior = record.versions.length > 1 ? record.versions[0] : null;
      if (prior) kids.push(h("details", null, h("summary", null, t("mail.previous", { n: prior.v })), FIELDS.map(k => {
        const now = record.versions.at(-1).fields[k];
        return h("div", { class: "te-mail-field" }, h("b", null, t(`mail.${k}`), JSON.stringify(prior.fields[k]) !== JSON.stringify(now) ? ` · ${t("mail.changed")}` : ""),
          h("p", null, t("mail.version", { n: prior.v })), h("pre", { class: "te-command" }, text(prior.fields[k])),
          h("p", null, t("mail.version", { n: record.latest_version })), h("pre", { class: "te-command" }, text(now)));
      })));
      kids.push(h("div", { class: "te-actions" },
        button("mail.save", () => act("edit", form.fields), busy || !dirty() || !review || conflict() || !editable(record), true),
        button("mail.discardEdits", () => { form = null; revision = ""; redraw(true); }, busy || !hasUnsaved())),
      h("label", { class: "te-mail-field" }, t("mail.revision"), h("textarea", { class: "te-answer", rows: 3, maxLength: 4000,
        readOnly: busy || prepared, dataset: { hold: "1", fk: "mail:revision" }, oninput: e => { revision = e.target.value; syncControls(); }, onblur: () => setTimeout(redraw, 0) }, revision)),
      h("div", { class: "te-actions" }, button("mail.requestRevision", () => act("revise", revision), busy || dirty() || !review || !revision.trim() || !editable(record)),
        record.send_protocol !== 1 ? button("mail.approveUnavailable", () => {}, true) : null));
      if (record.send_protocol === 1 && editable(record)) {
        if (prepared) kids.push(h("div", { class: "te-mail-confirm", role: "group", "aria-label": t("mail.finalConfirmation") },
          h("p", null, t("mail.confirmExact", { id: record.id, n: record.latest_version, account, host, profile })),
          h("div", { class: "te-actions" }, button("mail.cancelSend", () => open(selected), busy),
            button("mail.confirmSend", () => act("send", true), busy || !canReviewSend(), true))));
        else kids.push(h("div", { class: "te-actions" }, button("mail.sender", () => act("sender"), busy || !canReviewSend()),
          button("mail.prepare", () => act("prepare"), busy || !canReviewSend() || !account || f.from !== account, true)));
      }
      return h("div", { class: "te-row-body te-request" }, kids);
    }
    async function run(fn) {
      if (busy) return false;
      busy = true; error = ""; status = ""; const epoch = generation; redraw(true);
      try { await fn(epoch); return epoch === generation; }
      catch (e) { if (epoch === generation) { review = null; prepared = false; account = null; error = `${t("mail.unavailable")} ${String(e.message || e)}`; } return false; }
      finally { busy = false; redraw(); }
    }
    async function read(id, epoch) {
      const result = await deck.bridge.draftGet(profile, id);
      if (epoch !== generation) return;
      record = result.record; review = result.review; selected = id;
      account = result.account || null; prepared = !!result.prepared;
    }
    async function open(id) {
      if (hasUnsaved() && selected !== id) return false;
      return run(async epoch => { if (id !== selected) form = null; await read(id, epoch); });
    }
    async function load() {
      return run(async epoch => {
        const page = await deck.bridge.draftsList(profile, offset);
        if (epoch !== generation) return;
        ids = page.drafts; more = page.has_more; loaded = true;
        if (selected && (dirty() || revision.trim()) && !ids.includes(selected)) ids.push(selected);
        // Preserve a removed draft's buffer; a fresh get will explain why it cannot be changed.
        if (selected && (ids.includes(selected) || hasUnsaved())) await read(selected, epoch);
        else { record = null; review = null; selected = null; }
      });
    }
    async function act(action, value) {
      if (!review || conflict() || (action === "edit" && !dirty()) || (action === "revise" && (dirty() || !revision.trim()))) return false;
      if (["sender", "prepare", "send"].includes(action) && (!canReviewSend() || (action === "prepare" && (!account || record.versions.at(-1).fields.from !== account)) || (action === "send" && (!prepared || value !== true)))) return false;
      const token = review;
      return run(async epoch => {
        review = null;
        const result = await deck.bridge.draftAct(token, action, value);
        if (epoch !== generation) return;
        if (action === "revise") { revision = ""; prepared = false; account = null; status = "mail.revisionRequested"; }
        else { record = result.record; review = result.review; form = null; account = result.account || null; prepared = !!result.prepared;
          status = action === "edit" ? "mail.saved" : action === "send" ? "mail.sentVerified" : action === "prepare" ? "mail.finalConfirmation" : "mail.senderReady"; }
      });
    }
    const off = deck.bridge?.onEvent?.(m => {
      if (m.t !== "status") return;
      generation++; review = null; prepared = false; account = null;
      status = "mail.refreshNeeded"; redraw();
    });
    const ready = Promise.all([
      deck.bridge?.profiles?.().then(p => { profiles = p; }).catch(() => {}),
      deck.settingsGet?.().then(s => { host = s.hosts?.find(x => x.id === s.activeHost)?.name || ""; }).catch(() => {}),
    ]).then(() => { redraw(); });
    el.addEventListener("focusout", () => setTimeout(redraw, 0));
    redraw();
    return { root: el, ready, load, open, act, redraw, hasUnsaved, stop: () => off?.(),
      state: () => ({ profile, record, review, form, busy, error, status, account, prepared }) };
  }
  const api = { create, FIELDS };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DeckMailDrafts = api;
})(typeof window === "object" ? window : globalThis);
