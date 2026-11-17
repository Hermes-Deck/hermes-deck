"use strict";
// HTML for the phone pairing page (pair-page.js). Everything here is built from fixed strings, numbers, the relay's
// own address and the pairing values the relay made itself; nothing comes from the page request except the choice
// between the two fixed language tables. The QR code is inline SVG drawn by qr.js; the only script is inline and
// covered by the per-response CSP nonce.
const qr = require("./qr");

const STRINGS = {
  en: {
    lang: "en",
    title: "Connect your phone to Hermes Deck",
    step1: "Open Hermes Deck on your phone and scan this code.",
    step2: "Reading this on your phone? Tap “Open in Hermes Deck”.",
    open: "Open in Hermes Deck",
    manual: "Can’t scan? Enter these in the app:",
    noAddress: "Enter your Deck’s web address and this code in the app.",
    address: "Address",
    code: "Code",
    left: ["This page closes in ", "."],
    qrLabel: "QR code for pairing your phone",
    pairedTitle: "Phone connected",
    paired: ["", " is connected. You can close this page."],
    pairedNoName: "Your phone is connected. You can close this page.",
    goneTitle: "This link no longer works",
    gone: "It expired or was already used. Ask your agent for a new one.",
  },
  tr: {
    lang: "tr",
    title: "Telefonunu Hermes Deck’e bağla",
    step1: "Telefonunda Hermes Deck’i aç ve bu kodu tara.",
    step2: "Bu sayfa telefonunda mı açık? “Hermes Deck’te aç”a dokun.",
    open: "Hermes Deck’te aç",
    manual: "Tarayamıyor musun? Uygulamaya bunları yaz:",
    noAddress: "Uygulamaya Deck’inin web adresini ve bu kodu yaz.",
    address: "Adres",
    code: "Kod",
    left: ["Bu sayfa ", " içinde kapanır."],
    qrLabel: "Telefonunu eşleştirmek için QR kod",
    pairedTitle: "Telefon bağlandı",
    paired: ["", " bağlandı. Bu sayfayı kapatabilirsin."],
    pairedNoName: "Telefonun bağlandı. Bu sayfayı kapatabilirsin.",
    goneTitle: "Bu bağlantı artık çalışmıyor",
    gone: "Süresi doldu ya da zaten kullanıldı. Hermes’ten yeni bir bağlantı iste.",
  },
};

/** 'tr' when Turkish ranks above English in Accept-Language (q values, then order), else 'en'. */
function language(header) {
  let best = { lang: "en", q: -1, i: Infinity };
  String(header || "").slice(0, 512).split(",").slice(0, 32).forEach((part, i) => {
    const [tag, ...params] = part.trim().split(";");
    const base = tag.trim().toLowerCase().split("-")[0];
    if (base !== "en" && base !== "tr") return;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([01](?:\.\d{0,3})?)\s*$/i.exec(p);
      if (m) q = Number(m[1]);
    }
    if (q > 0 && (q > best.q || (q === best.q && i < best.i))) best = { lang: base, q, i };
  });
  return best.lang;
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** The app's pairing link: hermesdeck://pair?u=<base64url of the https address, no padding>&c=<code>. */
const deepLink = (address, code) => `hermesdeck://pair?u=${Buffer.from(address, "utf8").toString("base64url")}&c=${code}`;

const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

const CSS = `
:root{color-scheme:light dark;--bg:#f4f3ef;--card:#fff;--ink:#1d1c1a;--soft:#5d5a53;--line:#e2dfd7;--accent:#8a5a14;--accent-ink:#fff;--field:#f4f3ef}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--card:#1d1c1a;--ink:#edebe6;--soft:#aaa69c;--line:#4a4740;--accent:#d9a548;--accent-ink:#1a1306;--field:#2f2d29}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--ink)}
body{font:17px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px 16px;min-height:100vh}
main{width:100%;max-width:460px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:24px 20px}
h1{font-size:1.45rem;line-height:1.25;margin:0 0 12px;font-weight:650}
p{margin:0 0 8px}
.steps{color:var(--soft);margin:0 0 20px}
.grid{display:flex;flex-direction:column;gap:20px}
.side{display:flex;flex-direction:column;gap:20px}
.qr{background:#fff;border-radius:14px;padding:8px;width:min(100%,280px);margin:0 auto;line-height:0}
.qr svg{width:100%;height:auto;display:block}
.open{display:block;text-align:center;background:var(--accent);color:var(--accent-ink);text-decoration:none;font-weight:600;border-radius:12px;padding:14px 16px;min-height:48px;border:2px solid var(--accent)}
.open:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
.manual{font-size:.95rem;color:var(--soft)}
dl{margin:8px 0 0;display:grid;grid-template-columns:auto 1fr;gap:6px 12px;align-items:baseline}
dt{color:var(--soft)}
dd{margin:0;color:var(--ink);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.95rem;background:var(--field);border:1px solid var(--line);border-radius:8px;padding:6px 8px;overflow-wrap:anywhere;user-select:all;-webkit-user-select:all}
dd.code .half{display:inline-block;white-space:nowrap}
dd.code .half:first-child{margin-right:.5em}
dd.code .half span+span{margin-left:.4em}
.left{margin:0;font-size:.95rem;color:var(--soft)}
.left span{font-variant-numeric:tabular-nums;color:var(--ink);font-weight:600}
section[hidden],p[hidden]{display:none}
@media (max-width:719px){.side .open{order:-1}.grid .side{display:contents}.grid .open{order:-1}}
@media (min-width:720px){main{max-width:820px;padding:40px}h1{font-size:1.8rem}.grid{display:grid;grid-template-columns:300px 1fr;gap:36px;align-items:center}.grid .qr{margin:0;width:300px}}
@media (min-width:720px){.open{background:transparent;color:var(--accent)}}
`;

const SCRIPT = `(()=>{const d=document,root=d.documentElement,left=d.getElementById("left");let deadline=Date.now()+Number(root.dataset.remaining||0)*1000,done=false;
const show=id=>{done=true;const w=d.getElementById("waiting");if(w)w.remove();for(const s of d.querySelectorAll("section[data-state]"))s.hidden=s.id!==id;};
const tick=()=>{if(done)return;const s=Math.max(0,Math.round((deadline-Date.now())/1000));if(left)left.textContent=Math.floor(s/60)+":"+String(s%60).padStart(2,"0");if(s<=0)show("gone");};
const poll=async()=>{if(done)return;try{const r=await fetch(location.pathname.replace(/\\/+$/,"")+"/status",{cache:"no-store",credentials:"omit",referrerPolicy:"no-referrer"});const j=await r.json();
if(j.state==="paired"){const n=d.getElementById("device");if(n&&j.name){n.textContent=j.name;}else{const p=d.getElementById("paired-named"),q=d.getElementById("paired-plain");if(p)p.hidden=true;if(q)q.hidden=false;}show("paired");}
else if(j.state==="gone")show("gone");else if(j.state==="waiting"&&Number.isFinite(j.remainingS))deadline=Date.now()+j.remainingS*1000;}catch{}if(!done)setTimeout(poll,2000);};
tick();setInterval(tick,1000);setTimeout(poll,2000);})();`;

function shell(t, nonce, body, { script = false, remaining = 0 } = {}) {
  return `<!doctype html>
<html lang="${t.lang}" data-remaining="${Math.max(0, Math.floor(remaining))}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(t.title)}</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<main>
${body}
</main>
${script ? `<script nonce="${nonce}">${SCRIPT}</script>\n` : ""}</body>
</html>
`;
}

const pairedSection = (t, name, hidden) => `<section id="paired" data-state${hidden ? " hidden" : ""}>
<h1>${esc(t.pairedTitle)}</h1>
<p id="paired-named"${name || hidden ? "" : " hidden"}>${esc(t.paired[0])}<strong id="device">${esc(name || "")}</strong>${esc(t.paired[1])}</p>
<p id="paired-plain"${name || hidden ? " hidden" : ""}>${esc(t.pairedNoName)}</p>
</section>`;
const goneSection = (t, hidden) => `<section id="gone" data-state${hidden ? " hidden" : ""}>
<h1>${esc(t.goneTitle)}</h1>
<p>${esc(t.gone)}</p>
</section>`;

/**
 * The waiting page: QR code + deep link + manual values + countdown, plus the hidden paired/gone sections the inline
 * script switches to. `address` is the relay's https address (null when unknown: then no QR and no link, the code
 * only), `code` the pending pairing code, `remainingS` whole seconds left.
 */
function waitingPage({ lang, nonce, address, code, remainingS }) {
  const t = STRINGS[lang] || STRINGS.en;
  const link = address ? deepLink(address, code) : null;
  const svg = link ? qr.toSvg(qr.encode(link, { ecl: "M" }), { label: t.qrLabel }) : "";
  const groups = String(code).match(/.{1,4}/g) || [];
  const half = (list) => `<span class="half">${list.map((g) => `<span>${esc(g)}</span>`).join("")}</span>`;
  const codeHtml = half(groups.slice(0, 4)) + (groups.length > 4 ? half(groups.slice(4)) : "");
  const body = `<section id="waiting" data-state>
<h1>${esc(t.title)}</h1>
<div class="steps">${link ? `<p>${esc(t.step1)}</p>\n<p>${esc(t.step2)}</p>` : `<p>${esc(t.noAddress)}</p>`}</div>
<div class="grid">
${link ? `<div class="qr">${svg}</div>\n` : ""}<div class="side">
${link ? `<a class="open" href="${esc(link)}">${esc(t.open)}</a>\n` : ""}<div class="manual">
${link ? `<p>${esc(t.manual)}</p>\n` : ""}<dl>
${address ? `<dt>${esc(t.address)}</dt><dd>${esc(address)}</dd>\n` : ""}<dt>${esc(t.code)}</dt><dd class="code">${codeHtml}</dd>
</dl>
</div>
<p class="left">${esc(t.left[0])}<span id="left">${clock(Math.max(0, Math.floor(remainingS)))}</span>${esc(t.left[1])}</p>
</div>
</div>
</section>
${pairedSection(t, "", true)}
${goneSection(t, true)}`;
  return shell(t, nonce, body, { script: true, remaining: remainingS });
}

/** After the pairing: no QR code, no code, the device's name (escaped) when it gave one. */
function pairedPage({ lang, nonce, name }) {
  const t = STRINGS[lang] || STRINGS.en;
  return shell(t, nonce, pairedSection(t, name, false));
}

/** Expired, unknown, dropped or malformed: one page, the same bytes for every miss in one language (but the nonce). */
function gonePage({ lang, nonce }) {
  const t = STRINGS[lang] || STRINGS.en;
  return shell(t, nonce, goneSection(t, false));
}

module.exports = { STRINGS, language, deepLink, waitingPage, pairedPage, gonePage, esc };
