"use strict";
var i18nNode = (key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).node(key, vars, typeof document === "object" ? document : null);
var i18nBind = (el, attr, key, vars) => (typeof module === "object" && module.exports ? require("./i18n") : window.DeckI18n).bind(el, attr, key, vars);
var i18nText = typeof module === "object" && module.exports ? require("./i18n").t : window.DeckI18n.t;
var i18nLocale = typeof module === "object" && module.exports ? require("./i18n").getLocale : window.DeckI18n.getLocale;
// Forum topics of the configured group, in the rail (window.DeckTopics.create(ctx)).
//  - "+" on the topics header opens an inline form: a title (up to 128 characters) and one of
//    Telegram's six icon colours. The new topic is selected once it exists.
//  - Right-click on a topic (or the menu key / Shift+F10 on it) opens the shared context menu:
//    "Open in Telegram" for everyone; rename, close/reopen, pin/unpin and delete only when this account
//    can manage the group's topics (creator, or admin with manage_topics; delete also needs
//    delete_messages). General can be neither closed nor deleted, and deleting asks first.
//  - Closed topics are greyed with a lock, pinned ones carry a pin (main sends them first).
(() => {
  const COLORS = () => [
    [0x6fb9f0, i18nText("colors.blue"), "colors.blue"],
    [0xffd67e, i18nText("U0886"), "U0886"],
    [0xcb86db, i18nText("colors.purple"), "colors.purple"],
    [0x8eee98, i18nText("U0887"), "U0887"],
    [0xff93b2, i18nText("colors.pink"), "colors.pink"],
    [0xfb6f5f, i18nText("U0888"), "U0888"],
  ];
  const cssColor = (c) => `#${(Number(c) >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
  const NS = "http://www.w3.org/2000/svg";
  const ICON = {
    lock: "M5 7V5.2a3 3 0 0 1 6 0V7 M3.8 7h8.4v6.4H3.8z",
    pin: "M6 2.5h4 M7 2.5v3.7L4.8 9.4h6.4L9 6.2V2.5 M8 9.4V14",
  };

  function create(ctx) {
    const { h, S, deck, els, MV, select, mark, cleanErr } = ctx;
    const group = () => S.tg.group || {};
    const can = () => !!group().canManage;
    const topicOf = (key) => S.tg.topics.find((t) => t.key === key) || null;

    function icon(kind, label) {
      const s = document.createElementNS(NS, "svg");
      s.setAttribute("viewBox", "0 0 16 16");
      s.setAttribute("class", `ticon ${kind}`);
      s.setAttribute("role", "img");
      s.setAttribute("aria-label", label);
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", ICON[kind]);
      s.appendChild(p);
      return s;
    }

    function link(t) {
      const cid = String(group().id || "").replace(/^-100/, "");
      return /^\d+$/.test(cid) ? `https://t.me/c/${cid}/${t.id}` : null;
    }

    // ---------------------------------------------------------------- inline form
    // The rail is rebuilt often. The form is a single DOM node that each rebuild moves back into
    // place, so the typed title, the chosen colour and (through data-fk) the focus survive.
    let form = null; // {mode: "create"|"rename", key, color, busy, el, input, error}

    function openForm(mode, t) {
      closeForm(false);
      const f = { mode, key: t ? t.key : null, color: COLORS()[0][0], busy: false };
      f.input = h("input", {
        type: "text",
        maxlength: "128",
        placeholder: mode === "create" ? i18nText("U0889") : i18nText("U0890"),
        "data-i18n-placeholder": mode === "create" ? "U0889" : "U0890",
        "aria-label": mode === "create" ? i18nText("U0891") : i18nText("U0892"),
        "data-i18n-aria-label": mode === "create" ? "U0891" : "U0892",
        autocomplete: "off",
        dataset: { fk: "topic-form-title" },
      });
      if (t) f.input.value = t.title;
      f.error = h("p", { class: "tf-error", role: "alert" });
      const ok = h("button", { class: "btn small primary", type: "submit" }, mode === "create" ? i18nNode("U0893") : i18nNode("A0151"));
      const cancel = h("button", { class: "btn small", type: "button", onclick: () => closeForm(true) }, i18nNode("U0451"));
      f.el = h(
        "form",
        { class: "topic-form", "aria-label": mode === "create" ? i18nText("A0367") : i18nText("U0894"), "data-i18n-aria-label": mode === "create" ? "A0367" : "U0894" },
        f.input,
        mode === "create" ? colorPicker(f) : null,
        h("div", { class: "tf-actions" }, ok, cancel),
        f.error
      );
      f.el.addEventListener("submit", (e) => {
        e.preventDefault();
        submit(f, ok);
      });
      f.el.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          closeForm(true);
        }
      });
      form = f;
      mark("rail", true);
      setTimeout(() => {
        f.input.focus();
        f.input.select();
      }, 50);
    }

    function closeForm(refocus) {
      if (!form) return;
      const f = form;
      form = null;
      mark("rail", true);
      if (refocus) {
        // back to what opened the form, once the rail has been rebuilt without it
        setTimeout(() => {
          const el = document.querySelector(`[data-fk="${CSS.escape(f.mode === "create" ? "topic-add" : `row:${f.key}`)}"]`);
          if (el) el.focus();
        }, 50);
      }
    }

    function colorPicker(f) {
      const btns = COLORS().map(([c, name, key], i) =>
        h("button", {
          class: "tf-swatch",
          type: "button",
          role: "radio",
          title: name,
          "data-i18n-title": key,
          "aria-label": name,
          "data-i18n-aria-label": key,
          "aria-checked": i === 0 ? "true" : "false",
          tabindex: i === 0 ? "0" : "-1",
          style: { "--sw": cssColor(c) },
          onclick: () => pick(i, false),
        })
      );
      const pick = (i, focus) => {
        f.color = COLORS()[i][0];
        btns.forEach((b, k) => {
          b.setAttribute("aria-checked", k === i ? "true" : "false");
          b.tabIndex = k === i ? 0 : -1;
        });
        if (focus) btns[i].focus();
      };
      const wrap = h("div", { class: "tf-colors", role: "radiogroup", "aria-label": i18nText("A0368") , "data-i18n-aria-label": "A0368"}, btns);
      wrap.addEventListener("keydown", (e) => {
        const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!d) return;
        e.preventDefault();
        const i = COLORS().findIndex(([c]) => c === f.color);
        pick((i + d + COLORS().length) % COLORS().length, true);
      });
      return wrap;
    }

    async function submit(f, ok) {
      if (f.busy) return;
      const title = f.input.value.trim();
      if (!title) {
        i18nBind(f.error, "textContent", "U0321");
        f.input.focus();
        return;
      }
      f.busy = true;
      ok.disabled = true;
      f.error.textContent = "";
      try {
        if (f.mode === "create") {
          const r = await deck.topic("create", { title, color: f.color });
          closeForm(false);
          MV.toast(i18nText("U0895"));
          if (r && r.key) select(r.key);
        } else {
          await deck.topic("rename", { id: Number(f.key.slice(1)), title });
          closeForm(true);
          MV.toast(i18nText("U0896"));
        }
      } catch (e) {
        f.error.textContent = cleanErr(e);
      } finally {
        f.busy = false;
        ok.disabled = false;
      }
    }

    // ---------------------------------------------------------------- delete confirmation
    function confirmDelete(t) {
      const back = document.activeElement;
      const err = h("p", { class: "form-error", role: "alert" });
      const ok = h("button", { class: "btn danger", type: "button" }, i18nNode("A0369"));
      const cancel = h("button", { class: "btn", type: "button" }, i18nNode("U0451"));
      const box = h(
        "div",
        { class: "cd", role: "alertdialog", "aria-modal": "true", "aria-labelledby": "cd-title", "aria-describedby": "cd-body" },
        h("h2", { id: "cd-title" }, i18nNode("A0370")),
        h("p", { id: "cd-body" }, h("strong", null, t.title), i18nNode("U0897")),
        err,
        h("div", { class: "form-actions" }, cancel, ok)
      );
      const root = h("div", { class: "cd-back" }, box);
      const close = () => {
        root.remove();
        if (back && back.isConnected) back.focus();
      };
      cancel.addEventListener("click", close);
      root.addEventListener("click", (e) => {
        if (e.target === root && !ok.disabled) close();
      });
      root.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && !ok.disabled) {
          e.preventDefault();
          close();
        } else if (e.key === "Tab") {
          e.preventDefault();
          (document.activeElement === ok ? cancel : ok).focus();
        }
      });
      ok.addEventListener("click", async () => {
        ok.disabled = cancel.disabled = true;
        i18nBind(ok, "textContent", "A0371");
        err.textContent = "";
        try {
          await deck.topic("delete", { id: t.id });
          root.remove();
          MV.toast(i18nText("A0372"));
          if (S.sel === t.key) {
            const next = topicOf("t1") || S.tg.topics[0] || S.tg.bots[0];
            if (next) select(next.key);
          }
        } catch (e) {
          err.textContent = cleanErr(e);
          ok.disabled = cancel.disabled = false;
          i18nBind(ok, "textContent", "A0369");
        }
      });
      document.body.appendChild(root);
      cancel.focus(); // the safe answer holds the focus
    }

    // ---------------------------------------------------------------- topic menu
    async function act(op, args, done) {
      try {
        await deck.topic(op, args);
        MV.toast(done);
      } catch (e) {
        MV.toast(cleanErr(e), true);
      }
    }

    function openTopicMenu(row, pos) {
      const t = topicOf(row.dataset.fk.replace(/^row:/, ""));
      if (!t) return;
      const general = t.id === 1;
      const url = link(t);
      const items = [{ label: i18nText("U0844"), enabled: !!url, run: () => deck.openExternal(url) }];
      if (can()) {
        items.push("-", { label: i18nText("U0898"), noReturn: true, run: () => openForm("rename", t) });
        if (!general) items.push({ label: t.closed ? i18nText("U0899") : i18nText("A0197"), run: () => act("close", { id: t.id, closed: !t.closed }, t.closed ? i18nText("U0900") : i18nText("U0901")) });
        items.push({ label: t.pinned ? i18nText("U0902") : i18nText("A0373"), run: () => act("pin", { id: t.id, pinned: !t.pinned }, t.pinned ? i18nText("U0903") : i18nText("A0374")) });
        if (!general && group().canDelete) items.push("-", { label: i18nText("A0369"), danger: true, noReturn: true, run: () => confirmDelete(t) });
      }
      MV.openMenu(items, row, pos, `${t.title} konusu`);
    }

    let keyAt = 0; // a keyboard-opened menu swallows the contextmenu event that may follow
    els.rail.addEventListener("contextmenu", (e) => {
      const row = e.target.closest && e.target.closest(".row.topic");
      if (!row) return;
      e.preventDefault();
      if (Date.now() - keyAt < 500) return;
      openTopicMenu(row, e.clientX === 0 && e.clientY === 0 ? null : { x: e.clientX, y: e.clientY });
    });
    els.rail.addEventListener("keydown", (e) => {
      const row = e.target.closest && e.target.closest(".row.topic");
      if (!row || !(e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) return;
      e.preventDefault();
      keyAt = Date.now();
      openTopicMenu(row, null);
    });

    // ---------------------------------------------------------------- fixture scenes (development screenshots)
    let scene = null;
    function applyScene(sc) {
      if (sc.topicForm === "create") openForm("create");
      if (sc.topicForm && sc.topicForm !== "create" && topicOf(sc.topicForm)) openForm("rename", topicOf(sc.topicForm));
      if (sc.topicTitle && form) {
        setTimeout(() => {
          if (!form) return;
          form.input.value = String(sc.topicTitle);
          if (sc.topicSubmit) form.el.requestSubmit(); // runs the real create path against the fixture
        }, 100);
      }
      if (sc.topicMenu) {
        const row = els.rail.querySelector(`[data-fk="row:${CSS.escape(String(sc.topicMenu))}"]`);
        if (row) {
          const r = row.getBoundingClientRect();
          openTopicMenu(row, { x: r.left + 60, y: r.top + r.height - 4 });
        }
      }
      if (sc.topicDelete && topicOf(sc.topicDelete)) {
        confirmDelete(topicOf(sc.topicDelete));
        if (sc.topicConfirm) setTimeout(() => document.querySelector(".cd .btn.danger").click(), 100);
      }
    }

    return {
      /** The topics section header, with "+" when this account may create topics. */
      head(eyebrow) {
        if (scene && S.tg.topics.length) {
          const sc = scene;
          scene = null;
          setTimeout(() => applyScene(sc), 600);
        }
        if (!can()) return eyebrow;
        const open = !!(form && form.mode === "create");
        const add = h(
          "button",
          {
            class: "topic-add",
            type: "button",
            title: i18nText("A0367"),
            "aria-label": i18nText("U0904"),
            "aria-expanded": open ? "true" : "false",
            dataset: { fk: "topic-add" },
            onclick: () => (open ? closeForm(true) : openForm("create")),
           "data-i18n-title": "A0367", "data-i18n-aria-label": "U0904"},
          "+"
        );
        return h("div", { class: "eyebrow-row" }, eyebrow, add);
      },
      /** The open form when it belongs here: "head" (create) or a topic key (rename), else null. */
      formAt(where) {
        if (!form) return null;
        return (where === "head" ? form.mode === "create" : form.mode === "rename" && form.key === where) ? form.el : null;
      },
      /** Closed (greyed, lock) and pinned (pin) marks and the topic's colour on a rail row. */
      decorate(t, row) {
        if (t.closed) row.classList.add("closed");
        if (t.pinned) row.classList.add("pinned");
        if (t.color !== undefined && t.color !== null) row.style.setProperty("--tc", cssColor(t.color));
        const meta = row.querySelector(".meta");
        if (meta && (t.pinned || t.closed)) meta.prepend(h("span", { class: "tmarks" }, t.pinned ? icon("pin", i18nText("common.pinned")) : null, t.closed ? icon("lock", i18nText("U0905")) : null));
        return row;
      },
      /** Whether the section shows even without topics (so the first one can be created). */
      showSection: () => S.tg.topics.length > 0 || (can() && !!S.tg.group),
      setScene: (sc) => (scene = sc && typeof sc === "object" && (sc.topicForm || sc.topicMenu || sc.topicDelete) ? sc : null),
    };
  }

  window.DeckTopics = Object.freeze({ create });
})();
