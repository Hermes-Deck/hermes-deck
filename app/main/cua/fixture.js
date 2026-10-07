"use strict";
// Bot screen fixture for development screenshots (with main.js fixture mode):
//   npx electron . --shot=<png> --fixture=test/fixtures/telegram.json --tab=screen --botscreen=<scene>
// Scenes: on (default: a grant is active) | idle | off | paused | missing | sheet | confirm.
// Everything is made up and drawn here: no driver, no relay, no real window or screenshot is touched.
// The agents match the Telegram fixture's (Atlas, Kâtip).

const SCENES = new Set(["on", "idle", "off", "paused", "missing", "sheet", "confirm"]);

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const svgUrl = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
const FONT = "Segoe UI, Helvetica, Arial, sans-serif";

/** A spreadsheet window: title bar, ribbon strip, a grid; `hl` = [col, row] highlighted. */
function sheet(w, h, title, hl, typed) {
  const cols = 9;
  const rows = 16;
  const top = Math.round(h * 0.16);
  const cw = (w - 60) / cols;
  const rh = (h - top - 20) / rows;
  const cells = [];
  const data = [
    ["Kalem", "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Toplam", ""],
    ["Kira", "12.000", "12.000", "12.000", "12.000", "12.000", "12.000", "72.000"],
    ["Market", "4.350", "3.980", "4.120", "4.410", "4.050", "3.890", "24.800"],
    ["Ulaşım", "1.200", "1.150", "1.300", "1.250", "1.180", "1.220", "7.300"],
    ["Fatura", "2.100", "2.340", "1.980", "1.760", "1.640", "1.590", "11.410"],
    ["Kitap", "350", "420", "", "280", "510", "300", "1.860"],
    ["Spor", "900", "900", "900", "900", "900", "900", "5.400"],
    ["Toplam", "20.900", "20.790", "20.300", "20.600", "20.280", "19.900", "122.770"],
  ];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = 50 + c * cw;
      const y = top + r * rh;
      const on = hl && hl[0] === c && hl[1] === r;
      cells.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cw.toFixed(1)}" height="${rh.toFixed(1)}" fill="${on ? "#e6f2ea" : r === 0 ? "#f3f3f3" : "#ffffff"}" stroke="${on ? "#217346" : "#dadada"}" stroke-width="${on ? 3 : 1}"/>`);
      let v = data[r] && data[r][c] !== undefined ? data[r][c] : "";
      if (on && typed) v = typed;
      if (v) cells.push(`<text x="${(x + 8).toFixed(1)}" y="${(y + rh * 0.66).toFixed(1)}" font-family="${FONT}" font-size="${Math.round(rh * 0.42)}" fill="#202020" font-weight="${r === 0 || c === 0 || r === 7 ? 600 : 400}">${esc(v)}</text>`);
    }
  }
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<rect width="${w}" height="${h}" fill="#ffffff"/>` +
      `<rect width="${w}" height="${Math.round(h * 0.055)}" fill="#217346"/>` +
      `<text x="${w / 2}" y="${Math.round(h * 0.037)}" text-anchor="middle" font-family="${FONT}" font-size="${Math.round(h * 0.022)}" fill="#ffffff">${esc(title)}</text>` +
      `<rect y="${Math.round(h * 0.055)}" width="${w}" height="${Math.round(h * 0.09)}" fill="#f6f6f6"/>` +
      ["Dosya", "Giriş", "Ekle", "Formüller", "Veri", "Görünüm"].map((t, i) => `<text x="${24 + i * 96}" y="${Math.round(h * 0.11)}" font-family="${FONT}" font-size="${Math.round(h * 0.019)}" fill="#3a3a3a">${t}</text>`).join("") +
      cells.join("") +
      `</svg>`
  );
}

/** A plain notes window for the other agent's frames. */
function notes(w, h, title, lines) {
  const body = lines.map((l, i) => `<text x="40" y="${Math.round(h * 0.2 + i * h * 0.06)}" font-family="${FONT}" font-size="${Math.round(h * 0.03)}" fill="#2b2b2b">${esc(l)}</text>`).join("");
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<rect width="${w}" height="${h}" fill="#fbfaf6"/><rect width="${w}" height="${Math.round(h * 0.06)}" fill="#e9e6dc"/>` +
      `<circle cx="22" cy="${Math.round(h * 0.03)}" r="6" fill="#e06c5a"/><circle cx="42" cy="${Math.round(h * 0.03)}" r="6" fill="#e3b341"/><circle cx="62" cy="${Math.round(h * 0.03)}" r="6" fill="#5fb15f"/>` +
      `<text x="${w / 2}" y="${Math.round(h * 0.04)}" text-anchor="middle" font-family="${FONT}" font-size="${Math.round(h * 0.024)}" fill="#3a3a3a">${esc(title)}</text>${body}</svg>`
  );
}

/** A small picker thumbnail. */
function thumb(kind, title) {
  const w = 320;
  const h = 200;
  if (kind === "sheet") return sheet(w, h, title, [2, 3]);
  const bg = { notes: "#fbfaf6", files: "#f4f6f9", web: "#ffffff", vault: "#175ddc" }[kind] || "#ffffff";
  const bar = { notes: "#e9e6dc", files: "#e3e8ef", web: "#dfe3e8", vault: "#124aaf" }[kind] || "#dddddd";
  const ink = kind === "vault" ? "#ffffff" : "#5a5a5a";
  const rows = [0, 1, 2, 3, 4].map((i) => `<rect x="20" y="${48 + i * 26}" width="${200 - i * 18}" height="10" rx="5" fill="${kind === "vault" ? "#3d7ae6" : "#d8d8d8"}"/>`).join("");
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${bg}"/>` +
      `<rect width="${w}" height="26" fill="${bar}"/><text x="${w / 2}" y="17" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${ink}">${esc(title)}</text>${rows}</svg>`
  );
}

const ATLAS_TITLE = "Örnek bütçe - Excel";
const FRAMES = {
  "atlas/s-ornek-1/1.jpg": () => sheet(1280, 800, ATLAS_TITLE, null),
  "atlas/s-ornek-1/2.jpg": () => sheet(1280, 800, ATLAS_TITLE, [4, 5]),
  "atlas/s-ornek-1/3.jpg": () => sheet(1280, 800, ATLAS_TITLE, [4, 5], "380"),
  "atlas/s-ornek-1/4.jpg": () => sheet(1280, 800, ATLAS_TITLE, [4, 6]),
  "atlas/s-ornek-1/5.jpg": () => sheet(1280, 800, ATLAS_TITLE, [7, 7]),
  "atlas/s-ornek-1/6.jpg": () => sheet(1280, 800, ATLAS_TITLE, [7, 7]),
  "katip/s-ornek-2/1.jpg": () => notes(1280, 800, "Haftalık notlar", ["Pazartesi: rapor taslağı", "Salı: toplantı notlarını temize çek", "Çarşamba: bütçe özetini gönder"]),
};

/** The frame for a path, as a data URL (only the fixture's own paths exist). */
function frame(p) {
  const f = FRAMES[p];
  if (!f) throw new Error("Örnekte bu kare yok.");
  return f();
}

/**
 * cu events (contract shape) for this device and the relay host, oldest first.
 * @param {string} deviceId this deck's presence id
 */
function events(deviceId, now = Date.now()) {
  const atlas = { sid: "s-ornek-1", agent: "Atlas", profile: "atlas", device: deviceId, window: { id: 1001, app: "Excel" } };
  const katip = { sid: "s-ornek-2", agent: "Kâtip", profile: "katip", device: "host", window: { id: 77, app: "Notlar" } };
  const ev = (base, ago, action, x, y, n, extra = {}) => ({ type: "cu", ...base, ts: now - ago * 1000, action, x, y, frame: `${base.profile}/${base.sid}/${n}.jpg`, ok: true, error: null, ...extra });
  // points are cell centres of sheet(): x = 50 + (col + 0.5) * 135.6, y = 128 + (row + 0.5) * 40.75
  return [
    ev(atlas, 410, "capture", null, null, 1),
    ev(atlas, 352, "click", 660, 352, 2),
    ev(atlas, 341, "type", 660, 352, 3),
    ev(katip, 300, "capture", null, null, 1),
    ev(atlas, 233, "key", null, null, 4),
    ev(atlas, 128, "click", 1067, 433, 5, { ok: false, error: "the user holds control in Hermes Deck" }),
    ev(atlas, 24, "double_click", 1067, 433, 6),
  ];
}

/** The consent sheet's window list (made-up windows). */
function windows() {
  return [
    { sourceId: "window:1001:0", id: 1001, pid: 4242, title: ATLAS_TITLE, app: "Excel", kind: "sheet" },
    { sourceId: "window:1002:0", id: 1002, pid: 4343, title: "Toplantı notları - Not Defteri", app: "Not Defteri", kind: "notes" },
    { sourceId: "window:1003:0", id: 1003, pid: 4444, title: "Proje klasörü - Dosya Gezgini", app: "Dosya Gezgini", kind: "files" },
    { sourceId: "window:1004:0", id: 1004, pid: 4545, title: "Ana sayfa - Tarayıcı", app: "Tarayıcı", kind: "web" },
    { sourceId: "window:1005:0", id: 1005, pid: 4646, title: "Bitwarden", app: "Bitwarden", kind: "vault", blocked: "Parola yöneticisi bir ajana verilemez." },
  ].map((w) => ({ ...w, thumb: thumb(w.kind, w.title), matched: true, blocked: w.blocked || null }));
}

module.exports = { SCENES, frame, events, windows, ATLAS_TITLE };
