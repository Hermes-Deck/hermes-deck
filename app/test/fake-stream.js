#!/usr/bin/env node
"use strict";
// Test double for the host side of the Hermes bridge: hermes/stream.py --follow plus the legacy
// plugin behind it. It speaks the same newline-delimited JSON-RPC 2.0 on stdio (snapshots out,
// requests in, replies / native events / server requests out), so bridge.test.js can drive
// BridgeClient without SSH or a real Hermes. Each flag stages one behaviour or failure.
//
//   node fake-stream.js --serve [flags]
//     --log FILE              append every received request (and a start marker) as JSON lines
//     --interval MS           snapshot period (default 200)
//     --connection-id ID      snapshot connection_id (default "hermes")
//     --no-snapshot           never send a snapshot (handshake timeout)
//     --snapshots N           stop sending snapshots after N (heartbeat loss)
//     --oversize              after the first snapshot, write one line over 2 MiB
//     --split                 write every frame in 7-byte chunks, with pauses
//     --crlf                  end lines with \r\n
//     --drop METHOD           never answer METHOD (repeatable)
//     --delay METHOD=MS       answer METHOD after MS (repeatable)
//     --exit-on METHOD        exit as soon as METHOD arrives, before answering
//     --late-reply            before each answer, send a reply for an unknown id and a server
//                             request that reuses the request's id
//     --approval              after the first session.list, ask an approval (A7) and a question (Q3)
//     --cancel-approval MS    withdraw A7 with request.cancel MS after asking it
//     --no-gateway            ordinary requests fail like stream.py without a plugin control socket
//     --uncontrolled          the main session has no live control (control_available false)
//     --media                 ordinary sessions show a user turn with @image:/@file: lines; deck.file_read serves the pictures
//     --busy                  prompt.submit answers "queued" (session busy)
//     --profile-collision     alpha/beta share stored SIDs, with distinct runtime IDs and native authority
//     --profile-request-collision  those profiles also share one approval ID (answers must be refused)
//     --profile-recent-owner  only alpha is live; the recent default session has the same stored SID
//     --profile-launch-owner NAME  omitted-profile rows carry authoritative launch_profile instead of row profile
//     --bot-delete-lifecycle  confirmed deletion removes only matching canonical profile/root or tip
//     --bot-delete-fail       reject canonical deletion (expectations must stay)
//     --fail-stderr TEXT      print TEXT on stderr and exit at once (with --exit-code, default 255)
//
//   Botlar (Hermes Desktop's Bot Mode roster; the documented host extension, see app/main/bridge.js READS):
//   profiles.list / profiles.get_asset / session.title and the exact-title Bot Chat lookup are served by
//   default, with generic bots: default (160x160 face raster), research (custom hexagon, pinned, its Bot Chat
//   has a compression tip), writer (photo, no Bot Chat yet), ops (no metadata), archive-bot (hidden).
//     --no-profiles           profiles.* and session.title answer -32601 (a host without the extension)
//     --no-bot-chat           no profile has a Bot Chat yet (lookups empty, canonical_session null)
//     --bot-lookup-fail       the Bot Chat lookup errors
//     --title-ignored         session.list ignores `title` (an old host): recent sessions come back instead
//     --no-title              session.title answers -32601 (title lands after the first turn: pending_title)
//     --title-taken           session.title says the title is in use; a winner appears in the lookup
//     --big-avatar            every avatar is a ~1.6 MB data: URL (over the Deck's cap, under the frame limit)
//     --bot-approval          research's session waits for an approval (node state) and one approval is asked
//
//   Session browser (deck.session_index / deck.session_update / session.archive / session.branch_stored):
//     --no-index              deck.session_index and deck.session_update answer -32601 (an older plugin): session.list is used
//     --index-fail=NAME       deck.session_index of profile NAME errors (a store that cannot be read)
//
// Without --serve it exits at once, so `node --test` picking it up as a test file is harmless.
const fs = require("fs");
const readline = require("readline");
const zlib = require("zlib");

const argv = process.argv.slice(2);
if (!argv.includes("--serve")) process.exit(0);

const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const values = (name) => argv.flatMap((a, i) => (a === `--${name}` && i + 1 < argv.length ? [argv[i + 1]] : []));

const LOG = value("log", null);
const log = (entry) => {
  if (LOG) fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
};
log({ start: process.pid });

if (value("fail-stderr", null) !== null) {
  process.stderr.write(`${value("fail-stderr")}\n`, () => process.exit(Number(value("exit-code", "255"))));
  return;
}

const drops = new Set(values("drop"));
const exits = new Set(values("exit-on"));
const delays = new Map(
  values("delay").map((d) => {
    const [m, ms] = d.split("=");
    return [m, Number(ms)];
  })
);

// ---------------------------------------------------------------- output (frames never interleave)
const queue = [];
let pumping = false;
function writeLine(line) {
  queue.push(Buffer.from(line + (flag("crlf") ? "\r\n" : "\n")));
  if (!pumping) pump();
}
function pump() {
  const buf = queue.shift();
  if (!buf) {
    pumping = false;
    return;
  }
  pumping = true;
  if (!flag("split")) {
    process.stdout.write(buf, pump);
    return;
  }
  // Four pieces per frame, the first only 7 bytes, with pauses so the reader sees partial frames.
  const size = Math.max(7, Math.ceil(buf.length / 4));
  let i = 0;
  const step = () => {
    if (i >= buf.length) return pump();
    const n = i === 0 ? 7 : size;
    const part = buf.subarray(i, i + n);
    i += n;
    process.stdout.write(part, () => setTimeout(step, 2));
  };
  step();
}
const out = (obj) => writeLine(JSON.stringify(obj));

// ---------------------------------------------------------------- host state
const now = () => Date.now() / 1000;
const MAIN = "s-main";
const CHILD = "s-child";
const IDLE = "s-idle";
const open = new Set(); // server request ids still waiting for an answer
const rpcProfiles = new Map();
const deletedProfiles = new Set();

function nodes() {
  const t = now();
  if (flag("profile-collision")) {
    const row = (profile, sid, turn = "") => ({ session_id: sid, profile_name: profile, state: "idle", active: false, updated_at: t,
      turn_id: turn, owner_pid: profile === "alpha" ? 4242 : 4343, control_available: !!turn, terminal_at: null });
    return [
      ...(flag("profile-recent-owner") ? ["alpha"] : ["alpha", "beta"]).filter((p) => !deletedProfiles.has(p)).map((p) => row(p, "s-shared", `t-${p}`)),
      ...[...made.values()].filter((m) => m.persisted).map((m) => row(m.profile, m.stored)),
    ];
  }
  return [
    {
      session_id: MAIN, parent_session_id: "", lineage_parent_session_id: "", subagent_id: "", role: "main",
      model: "model-a", provider: "prov", profile_name: "default", source: "cli", platform: "cli",
      title: "Ana oturum", name: "Hermes · Telegram", origin: "native", state: "working", active: true,
      turn_id: "t1", control_available: !flag("uncontrolled"), owner_pid: 4242, observation_source: "native_hook",
      steps: ["Thinking", "terminal", "terminal · done"], updated_at: t, terminal_at: null,
      context_used: 1200, context_max: 10000, context_percent: 12, context_estimated: false,
    },
    {
      session_id: CHILD, parent_session_id: MAIN, role: "leaf", model: "model-c", provider: "prov", profile_name: "default",
      source: "subagent", title: "Testleri çalıştır", name: "Hermes · Testleri çalıştır", origin: "native", state: "thinking",
      active: true, turn_id: "c1", control_available: true, owner_pid: 4242, steps: ["Native subagent started"], updated_at: t, terminal_at: null,
    },
    {
      session_id: IDLE, parent_session_id: "", role: "main", model: "model-a", provider: "prov", profile_name: "research",
      source: "telegram", title: "", name: "Hermes · research", origin: "native", state: flag("bot-approval") ? "approval" : "idle", active: false,
      turn_id: "", control_available: false, observation_source: "gateway_routing", steps: ["Current Hermes conversation"],
      updated_at: t - 600, terminal_at: null,
    },
  ];
}

// ---------------------------------------------------------------- bots (profiles.list, avatars, Bot Chat)
const T0 = now();
const BOT_CHAT = "Bot Chat";

/** A tiny PNG encoder (RGBA, no filter), enough for synthetic avatars. */
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 4 + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const dataUrl = (buf) => `data:image/png;base64,${buf.toString("base64")}`;
// what Hermes Desktop uploads for a vector face: the face drawn at 160x160 (a coral pill with two eyes)
const RASTER = png(160, 160, (x, y) => {
  const dx = (x - 80) / 64;
  const dy = (y - 74) / 47;
  const eye = (cx) => ((x - cx) / 8.8) ** 2 + ((y - 63) / 9.2) ** 2 <= 1;
  if (eye(62) || eye(98)) return [20, 20, 22, 255];
  return dx ** 8 + dy ** 8 <= 1 ? [232, 132, 106, 255] : [0, 0, 0, 0];
});
// a real picture (any size but 160x160): a soft diagonal gradient
const PHOTO = png(96, 96, (x, y) => {
  const t = (x + y) / 190;
  return [Math.round(205 - 60 * t), Math.round(166 - 40 * t), Math.round(90 + 70 * t), 255];
});

// profile -> its Bot Chat registry row id ("Bot Chat" is unique per profile db); research's chat was compressed
const canon = new Map(flag("no-bot-chat") ? [] : [["default", "s-bot-default"], ["research", "s-bot-research"], ["ops", "s-bot-ops"]]);
const TIPS = new Map([["s-bot-research", "s-bot-research-2"]]);
const made = new Map(); // runtime id -> {stored, profile, title, titled}
let madeSeq = 0;
const BOT_ACTIVE = { "s-bot-default": T0 - 1500, "s-bot-research": T0 - 5400, "s-bot-ops": T0 - 3 * 86400 };
const BOT_PREVIEW = {
  "s-bot-default": "Bugünkü özet hazır: testler geçti.",
  "s-bot-research": "Message from 🤖 Hermes (@hermes): kaynak listesini güncelledim",
  "s-bot-ops": "Yedekler tamam.",
};
const BOT_HISTORY = [
  { id: 21, role: "user", content: "Bugünkü özetini çıkarır mısın?", timestamp: T0 - 1800 },
  { id: 22, role: "assistant", content: "Tabii. Üç başlık var:\n\n- **Testler** geçti\n- Sürüm notları hazır\n- Bir komut onay bekliyor", timestamp: T0 - 1500 },
];

function botChatRow(profile) {
  const id = canon.get(profile);
  if (!id) return null;
  const tip = TIPS.get(id) || id;
  return {
    id, resolved_id: tip, root_title: BOT_CHAT, title: BOT_CHAT, preview: BOT_PREVIEW[id] || "",
    started_at: (BOT_ACTIVE[id] || T0) - 86400, last_active: BOT_ACTIVE[id] || T0 - 60, message_count: id.startsWith("s-bot-new") ? 0 : 6,
  };
}

function profileRows() {
  const row = (name, extra) => ({
    name, path: `/home/someone/.hermes/profiles/${name}`, is_default: false, model: "model-a", provider: "prov",
    description: "", display_name: "", skill_count: 7, previous_names: [], role: null, ui_meta_revisions: {},
    has_avatar: false, worker_session: { id: "w-1", source: "kanban", title: "", last_active: T0 - 30 },
    last_session: null, canonical_session: botChatRow(name), ...extra,
  });
  return [
    row("default", { path: "/home/someone/.hermes", is_default: true, has_avatar: true, ui_meta: { "hermes-bots": { chat: "legacy" } },
      last_session: { id: MAIN, title: "Ana oturum", preview: "Merhaba", started_at: T0 - 7200, last_active: T0 - 20, message_count: 5 } }),
    row("research", { description: "Kaynak tarar, özet çıkarır.", ui_meta: { "hermes-bots": {
      title: "Araştırmacı", description: "Kaynak tarar, özet çıkarır.", shape: "hexagon", color: "#6fb3a6", custom: true, pinned: true, created: (T0 - 30 * 86400) * 1000,
    } } }),
    row("writer", { display_name: "Yazar", has_avatar: true }),
    row("ops", {}),
    row("archive-bot", { ui_meta: { "hermes-bots": { hidden: true, title: "Eski bot" } } }),
  ];
}

function botAnswer(method, p) {
  const profile = typeof p.profile === "string" ? p.profile : "default";
  switch (method) {
    case "profiles.list":
      return ok({ profiles: profileRows(), bot_mode_protocol: true });
    case "profiles.get_asset": {
      if (flag("big-avatar")) return ok({ found: true, mime: "image/png", size: 1200000, data: dataUrl(Buffer.concat([RASTER, Buffer.alloc(1200000)])) });
      const pic = p.name === "default" ? RASTER : p.name === "writer" ? PHOTO : null;
      return ok(pic ? { found: true, mime: "image/png", size: pic.length, data: dataUrl(pic) } : { found: false });
    }
    case "session.title": {
      const m = made.get(p.session_id);
      if (!m) return err(4001, "session not found");
      if (flag("title-taken")) {
        if (!canon.has(m.profile)) canon.set(m.profile, "s-bot-winner");
        return err(4022, "Title 'Bot Chat' is already in use by session s-bot-winner");
      }
      if (canon.has(m.profile) && canon.get(m.profile) !== m.stored) return err(4022, `Title 'Bot Chat' is already in use by session ${canon.get(m.profile)}`);
      canon.set(m.profile, m.stored);
      m.titled = true;
      return ok({ pending: false, title: p.title });
    }
    case "session.create": {
      madeSeq += 1;
      const stored = flag("profile-collision") ? "s-created-shared" : `s-bot-new-${madeSeq}`;
      const rpc = flag("profile-collision") ? `rpc-created-${profile}` : `rpc-${stored}`;
      made.set(rpc, { stored, profile, title: typeof p.title === "string" ? p.title : "", titled: false });
      rpcProfiles.set(rpc, profile);
      return ok({ session_id: rpc, stored_session_id: stored, message_count: 0, info: { lazy: true } });
    }
    case "session.list": {
      // the exact-title lookup (tui_gateway methods_session.py _session_list_by_title): at most one row, the
      // tip as resolved_id, in _session_row_summary's shape (no root_title / last_active, unlike
      // profiles.list's canonical_session)
      if (flag("bot-lookup-fail")) return err(5006, "database is locked");
      const row = botChatRow(profile);
      if (!row) return ok({ sessions: [] });
      return ok({ sessions: [{ id: row.id, resolved_id: row.resolved_id, title: row.root_title, preview: row.preview, started_at: row.started_at, message_count: row.message_count, source: "desktop", live_message_count: row.message_count }] });
    }
    default:
      return null;
  }
}

// Session browser fixtures: generic rows of every platform, per profile; "default" has more than one page.
const INDEX_ROWS = {
  default: [
    ...Array.from({ length: 130 }, (_, i) => ({ id: `s-bulk-${i}`, title: `Bulk ${i}`, preview: "", source: i % 2 ? "webui" : "tui", started_at: T0 - 100000 - i * 60, last_active: T0 - 90000 - i * 60, message_count: 3, archived: false, pinned: false, profile: "default" })),
  ],
  research: [
    { id: "s-tg-1", title: "Telegram thread", preview: "hello from a phone", source: "telegram", started_at: T0 - 5000, last_active: T0 - 400, message_count: 12, archived: false, pinned: true },
    { id: "s-dc-1", title: "", preview: "discord question", source: "discord", started_at: T0 - 9000, last_active: T0 - 8000, message_count: 2, archived: false, pinned: false },
  ],
};
const INDEX_ARCHIVED = { research: [{ id: "s-old-1", title: "Old chat", preview: "", source: "cli", started_at: T0 - 900000, last_active: T0 - 800000, message_count: 5, archived: true, pinned: false }] };
const index_state = { titles: new Map(), pinned: new Map(), archived: new Set() };

function indexAnswer(method, p) {
  const profile = typeof p.profile === "string" ? p.profile : "default";
  switch (method) {
    case "deck.session_index": {
      if (flag("no-index")) return err(-32601, "Unsupported Hermes Deck control");
      if (value("index-fail", "") === profile) return err(5000, "Hermes session store unavailable");
      const all = (p.archived === "only" ? INDEX_ARCHIVED : INDEX_ROWS)[profile] || [];
      const off = p.offset || 0;
      const page = all.slice(off, off + p.limit).map((r) => ({ ...r, title: index_state.titles.get(r.id) ?? r.title, pinned: index_state.pinned.get(r.id) ?? r.pinned, archived: index_state.archived.has(r.id) || r.archived }));
      return ok({ sessions: page, has_more: off + p.limit < all.length });
    }
    case "deck.session_update": {
      if (flag("no-index")) return err(-32601, "Unsupported Hermes Deck control");
      if (typeof p.title === "string") index_state.titles.set(p.session_id, p.title);
      if (typeof p.pinned === "boolean") index_state.pinned.set(p.session_id, p.pinned);
      return ok({ ok: true, title: index_state.titles.get(p.session_id) || "", pinned: index_state.pinned.get(p.session_id) === true });
    }
    case "session.archive": {
      if (p.session_id === MAIN && p.archived) return err(4023, "cannot archive an active session");
      if (p.archived) index_state.archived.add(p.session_id); else index_state.archived.delete(p.session_id);
      return ok({ archived: p.archived, session_key: p.session_id });
    }
    case "session.branch_stored":
      return ok({ session_id: `rpc-branch-${p.parent_session_id}`, stored_session_id: `s-branch-${p.parent_session_id}`, message_count: 2, messages_omitted: true, info: { lazy: true } });
    default:
      return null;
  }
}

const HISTORY = [
  { id: 11, role: "user", content: "Merhaba", timestamp: 1700000000.5 },
  { id: 12, role: "assistant", content: [{ type: "text", text: "Selam" }, { type: "image_url", image_url: { url: "x" } }], timestamp: 1700000001.25 },
  { id: 13, role: "tool", content: "tool output" },
  { id: 14, role: "assistant", display_kind: "hidden", content: "gizli" },
  { id: 15, role: "assistant", content: "ham metin", display_content: "Görünen metin", timestamp: 1700000002 },
];
// session "s-files": an assistant message that offers files (a MEDIA: tag and a backticked path) and a user message
// naming a secret (which offers nothing)
const FILES_HISTORY = [
  { id: 16, role: "assistant", content: "Here is the report: MEDIA:/srv/example/out/report.txt and the notes `/srv/example/out/notes.md`.", timestamp: 1700000003 },
  { id: 17, role: "user", content: "please send MEDIA:/home/user/.ssh/id_ed25519", timestamp: 1700000004 },
];

// --media: every ordinary session's history is a user turn with attached pictures (@image: lines in the stored form
// Hermes writes) and one file; deck.file_read serves the pictures (a generated PNG) from an images folder.
const MEDIA_DIR = "/srv/example/home/images";
const makePng = (w, h, rgb) => {
  const crc = (buf) => { let c, t = ~0; for (const b of buf) { c = (t ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t = (t >>> 8) ^ c; } return ~t >>> 0; };
  const chunk = (type, data) => { const n = Buffer.alloc(4); n.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([n, body, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = (rgb[0] + x) & 255; raw[o + 1] = (rgb[1] + y) & 255; raw[o + 2] = rgb[2]; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};
const MEDIA_FILES = { [`${MEDIA_DIR}/upload_1_1.png`]: makePng(320, 200, [20, 60, 120]), [`${MEDIA_DIR}/upload_1_2.png`]: makePng(160, 240, [120, 40, 20]) };
const MEDIA_HISTORY = [
  { id: 21, role: "assistant", content: "Ready.", timestamp: 1700000010 },
  { id: 22, role: "user", content: `what is in these?\n\n@image:${MEDIA_DIR}/upload_1_1.png\n@image:\`${MEDIA_DIR}/upload_1_2.png\`\n@image:"${MEDIA_DIR}/missing.png"\n@file:'${MEDIA_DIR}/../notes.txt'`, timestamp: 1700000011 },
];

// --work: every ordinary session's history is one turn of work: thoughts with the tool calls they made (stored before
// the tools ran, then the tool rows), a line of commentary beside a call, and the reply.
const workCall = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const WORK_HISTORY = [
  { id: 31, role: "user", content: "Run the test suite and fix what fails.", timestamp: 1700000020 },
  { id: 32, role: "assistant", content: "", timestamp: 1700000021, reasoning: "I should run the plugin tests first, then the app suite.",
    tool_calls: [workCall("w1", "terminal", { command: "python -m pytest hermes-plugin -q", timeout: 600 })] },
  { id: 33, role: "tool", tool_call_id: "w1", content: "1 failed, 212 passed" },
  { id: 34, role: "assistant", content: "", timestamp: 1700000040, reasoning: "The failure imports yaml; system python may not have it. Check against a clean checkout to confirm it is pre-existing.",
    tool_calls: [workCall("w2", "terminal", { command: "git stash && python -m pytest hermes-plugin/test_usage.py -q; git stash pop" }), workCall("w3", "read_file", { path: "hermes-plugin/test_usage.py", offset: 1 })] },
  { id: 35, role: "tool", tool_call_id: "w2", content: "1 failed" },
  { id: 36, role: "tool", tool_call_id: "w3", content: "import yaml" },
  { id: 37, role: "assistant", content: "Pre-existing (no PyYAML in system python). Full suite with the project python:", timestamp: 1700000060,
    tool_calls: [workCall("w4", "terminal", { command: "venv/bin/python -m pytest -q" })] },
  { id: 38, role: "tool", tool_call_id: "w4", content: "213 passed" },
  { id: 39, role: "assistant", content: "", timestamp: 1700000080, reasoning: "Now the app suite. npm ci would download Electron; skip the binary.",
    tool_calls: [workCall("w5", "terminal", { command: "ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci && npm test" })] },
  { id: 40, role: "tool", tool_call_id: "w5", content: "1131 tests, 0 failed" },
  { id: 41, role: "assistant", content: "", timestamp: 1700000100, reasoning: "While that ran: the docs mention the old label; update docs/features.md.",
    tool_calls: [workCall("w6", "patch", { path: "docs/features.md", old_string: "a", new_string: "b" })] },
  { id: 42, role: "tool", tool_call_id: "w6", content: "ok" },
  { id: 43, role: "assistant", content: "All green: plugin 213 passed, app 1131 passed. The one plugin failure was pre-existing (system python has no PyYAML).", timestamp: 1700000110, reasoning: "Summarise." },
];

// --work-live: a turn still running. The history holds its first step (stored before the tool ran); the events then
// finish that tool and stream the second step's reasoning, with no message.complete.
const WORK_LIVE_HISTORY = WORK_HISTORY.slice(0, 2);
let workLiveSent = false;
function workLive(sid) {
  const ev = (type, payload) => out({ jsonrpc: "2.0", method: "event", params: { type, session_id: sid, payload } });
  const steps = [
    () => ev("message.start", {}),
    () => ev("reasoning.delta", { text: WORK_HISTORY[1].reasoning }),
    () => ev("tool.start", { tool_id: "w1", name: "terminal", arguments: { command: "python -m pytest hermes-plugin -q" } }),
    () => ev("tool.complete", { tool_id: "w1", result: "1 failed, 212 passed", duration_ms: 4200 }),
    () => ev("reasoning.delta", { text: "One failure. It imports yaml; " }),
    () => ev("reasoning.delta", { text: "system python may not have it. I will check a clean checkout first." }),
  ];
  steps.forEach((fn, i) => setTimeout(fn, 300 + i * 250));
}

const FILE_PATH = "/srv/example/out/report.txt";
const FILE_BODY = Buffer.from("line of report\n".repeat(200)); // 3,000 bytes
const ok = (result) => ({ result });
const err = (code, message) => ({ error: { code, message } });

function answer(method, p) {
  if (["deck.session_index", "deck.session_update", "session.archive", "session.branch_stored"].includes(method)) return indexAnswer(method, p);
  const extension = ["profiles.list", "profiles.get_asset", "session.title"].includes(method);
  const off = (extension && flag("no-profiles")) || (method === "session.title" && flag("no-title"));
  const lookup = method === "session.list" && "title" in p && !flag("title-ignored");
  if (!off && (extension || lookup || method === "session.create")) return botAnswer(method, p);
  switch (method) {
    case "session.list":
      if (flag("profile-recent-owner")) {
        const launch = value("profile-launch-owner");
        return ok({ ...(launch ? { launch_profile: launch } : {}), sessions: [{ id: "s-shared", ...(launch ? {} : { profile_name: "default" }), title: "Stored launch owner" }] });
      }
      return ok({
        sessions: [
          { id: MAIN, title: "Ana oturum", preview: "Merhaba", started_at: 1700000000, message_count: 5, source: "telegram" },
          { id: IDLE, title: "", preview: "", started_at: 1699990000, message_count: 2, source: "telegram" },
        ],
      });
    case "session.messages": {
      // The plugin's own checks (Observer.messages).
      const keys = ["session_id", "profile", "limit", "offset", "order", "inline_images"];
      if (Object.keys(p).some((k) => !keys.includes(k))) return err(4000, "Unsupported history parameter");
      if (typeof p.session_id !== "string" || !p.session_id) return err(4000, "A persisted session ID is required");
      const limit = p.limit ?? 40;
      const offset = p.offset ?? 0;
      if (p.session_id.startsWith("s-bot-")) {
        const page = p.session_id.startsWith("s-bot-new") || offset > 0 ? [] : BOT_HISTORY;
        return ok({ session_id: p.session_id, messages: page, pagination: { limit, offset, order: "latest", returned: page.length } });
      }
      if (p.session_id === "s-files") return ok({ session_id: p.session_id, messages: offset === 0 ? FILES_HISTORY : [], pagination: { limit, offset, order: "latest", returned: offset === 0 ? FILES_HISTORY.length : 0 } });
      if (flag("media")) return ok({ session_id: p.session_id, messages: offset === 0 ? MEDIA_HISTORY : [], pagination: { limit, offset, order: "latest", returned: offset === 0 ? MEDIA_HISTORY.length : 0 } });
      if (flag("work-live")) return ok({ session_id: p.session_id, messages: offset === 0 ? WORK_LIVE_HISTORY : [], pagination: { limit, offset, order: "latest", returned: offset === 0 ? WORK_LIVE_HISTORY.length : 0 } });
      if (flag("work")) return ok({ session_id: p.session_id, messages: offset === 0 ? WORK_HISTORY : [], pagination: { limit, offset, order: "latest", returned: offset === 0 ? WORK_HISTORY.length : 0 } });
      const page = offset === 0 ? HISTORY : [{ id: 9, role: "user", content: "Eski soru", timestamp: 1699999000 }];
      return ok({ session_id: p.session_id, messages: page, pagination: { limit, offset, order: "latest", returned: page.length } });
    }
    case "session.resume": {
      if (!p.session_id) return err(4006, "session_id required");
      const profile = p.profile || "default";
      const rpc = flag("profile-collision") ? `rpc-${profile}-${p.session_id}` : `rpc-${p.session_id}`;
      rpcProfiles.set(rpc, profile);
      return ok({ session_id: rpc, stored_session_id: p.session_id, message_count: 5 });
    }
    case "prompt.submit": {
      if (typeof p.session_id !== "string" || !p.session_id.startsWith("rpc-")) return err(4001, "session not found");
      // a created session's pending title lands with its first turn (Hermes prompt_turn pending_title)
      const m = made.get(p.session_id);
      if (m) m.persisted = true;
      if (m && m.title === BOT_CHAT && !m.titled && !canon.has(m.profile)) {
        canon.set(m.profile, m.stored);
        m.titled = true;
      }
      return ok({ status: flag("busy") ? "queued" : "streaming" });
    }
    case "deck.attach_submit":
      if (typeof p.session_id !== "string" || !p.session_id.startsWith("rpc-")) return err(4001, "session not found");
      return ok({ status: flag("busy") ? "queued" : "streaming" });
    case "native.steer":
    case "native.redirect":
    case "native.interrupt": {
      const node = nodes().find((n) => n.session_id === p.session_id && (!flag("profile-collision") || n.owner_pid === p.owner_pid));
      if (!node || !node.control_available) return ok({ status: "not_running" });
      if (p.turn_id !== node.turn_id || p.owner_pid !== node.owner_pid) return ok({ status: "stale" });
      if (method === "native.interrupt") return ok({ status: "interrupted" });
      if (typeof p.text !== "string" || !p.text.trim() || p.text.length > 32000) return ok({ status: "invalid_text" });
      return ok({ status: method === "native.steer" ? "queued" : "redirected" });
    }
    case "session.interrupt":
      return ok({ status: "interrupted" });
    case "session.close":
      return ok({ closed: true });
    case "session.delete": {
      // The plugin's allowed_request, then Hermes: the running session (s-main) is refused (4023).
      if (Object.keys(p).some((k) => !["session_id", "profile"].includes(k)) || typeof p.session_id !== "string" || !p.session_id) return err(-32601, "Unsupported Hermes Desk control");
      if (p.session_id === MAIN) return err(4023, "cannot delete an active session");
      if (p.session_id === "s-missing") return err(4007, "session not found");
      if (flag("profile-collision") && p.session_id === "s-shared") deletedProfiles.add(p.profile);
      if (flag("bot-delete-lifecycle")) {
        const profile = p.profile || "default";
        const row = botChatRow(profile);
        if (row && [row.id, row.resolved_id].includes(p.session_id)) {
          if (flag("bot-delete-fail")) return err(5036, "canonical delete refused");
          canon.delete(profile);
          for (const [rpc, created] of made) if (created.profile === profile && created.stored === p.session_id) made.delete(rpc);
        }
      }
      return ok({ deleted: p.session_id });
    }
    case "session.usage":
      return ok({ context_used: 10, context_max: 100 });
    case "model.options":
      return ok({
        model: flag("profile-collision") ? `${rpcProfiles.get(p.session_id)}-model` : "model-a",
        provider: "prov",
        providers: [
          { slug: "prov", name: "Provider", authenticated: true, models: ["model-a", "model-b", "bad id"], unavailable_models: [], capabilities: { "model-b": { fast: false, reasoning: false } } },
          { slug: "locked", name: "Locked", authenticated: false, models: ["model-x"] },
          // a config.yaml custom_providers entry: Hermes names it custom:<name>
          { slug: "custom:labrelay", name: "Lab Relay", is_user_defined: true, aliases: ["custom:labrelay", "labrelay"], models: ["lab-1.5"] },
        ],
      });
    case "config.set": {
      // The plugin's allowed_request: the model key (never --global / -g), or one session's reasoning effort.
      if (p.key === "reasoning") {
        const ok3 = Object.keys(p).sort().join() === "key,session_id,value" && ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(p.value);
        return ok3 ? ok({ key: "reasoning", value: p.value }) : err(-32601, "Unsupported Hermes Desk control");
      }
      const tokens = typeof p.value === "string" ? p.value.split(/\s+/) : [];
      if (p.key !== "model" || !p.session_id || tokens.includes("--global") || tokens.includes("-g")) return err(-32601, "Unsupported Hermes Desk control");
      if (p.value.startsWith("model-b ") && p.confirm_expensive_model !== true) return ok({ confirm_required: true, confirm_message: "model-b pahalı bir model; onaylıyor musun?" });
      return ok({ deferred: true, warning: "" });
    }
    case "deck.transcribe": {
      // dictation: the plugin's own checks (observer.parse_transcribe); the "transcript" is fixed
      if (Object.keys(p).sort().join() !== "audio_base64,mime" || typeof p.audio_base64 !== "string" || !p.audio_base64) return err(4000, "Invalid dictation request");
      const head = Buffer.from(p.audio_base64, "base64").subarray(0, 4);
      if (!head.equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return err(4000, "Unsupported audio format");
      return ok({ text: "merhaba dünya", provider: "local" });
    }
    case "deck.file_read": {
      // a file the agent "offered": FILE_BODY at FILE_PATH in any session; anything else is refused like the plugin does
      if (p.path === FILE_PATH) {
        const off = Math.min(p.offset, FILE_BODY.length);
        const part = FILE_BODY.subarray(off, off + p.length);
        return ok({ name: "report.txt", size: FILE_BODY.length, mtime: 1700000000, offset: off, length: part.length, eof: off + part.length >= FILE_BODY.length, data: part.toString("base64") });
      }
      if (MEDIA_FILES[p.path]) {
        const body = MEDIA_FILES[p.path];
        const off = Math.min(p.offset, body.length);
        const part = body.subarray(off, off + p.length);
        return ok({ name: p.path.split("/").pop(), size: body.length, mtime: 1700000000, offset: off, length: part.length, eof: off + part.length >= body.length, data: part.toString("base64") });
      }
      return err(p.path === "/home/user/.ssh/id_ed25519" ? 4080 : 4081, p.path === "/home/user/.ssh/id_ed25519" ? "Hermes Deck cannot download this file" : "This file was not offered in this session");
    }
    case "deck.version": // --plugin-version X[:protocol] answers like stream.py 0.3.6+; without it: an older plugin (-32601)
      if (!value("plugin-version", "")) return err(-32601, "Unsupported Hermes Desk control");
      return ok({ version: value("plugin-version", "").split(":")[0], protocol: Number(value("plugin-version", "").split(":")[1] || 1) });
    case "request.answer":
      if (typeof p.id !== "string" || !p.result || typeof p.result !== "object") return err(4002, "id and an object result required");
      return ok({ status: open.delete(p.id) ? "ok" : "expired" });
    default:
      return err(-32601, "Unsupported Hermes Desk control");
  }
}

let listed = false;
function after(method, p) {
  if (method === "session.messages" && flag("work-live") && !workLiveSent && p.session_id === MAIN) {
    workLiveSent = true;
    workLive(MAIN);
  }
  if (method === "prompt.submit" && typeof p.session_id === "string" && p.session_id.startsWith("rpc-")) {
    const ev = (type, payload) => out({ jsonrpc: "2.0", method: "event", params: { type, session_id: p.session_id, payload } });
    ev("message.start", {});
    ev("message.delta", { text: "Mer" });
    ev("message.delta", { text: "haba" });
    ev("message.delta", { text: "eski", replay: true }); // replayed history never reaches the UI
    ev("message.complete", { text: "Merhaba", status: "complete" });
    if (flag("profile-collision")) {
      const profile = rpcProfiles.get(p.session_id);
      const id = flag("profile-request-collision") ? "A-shared" : `A-${profile}`;
      open.add(id);
      out({ jsonrpc: "2.0", id, method: "approval", params: { session_id: p.session_id, command: `test ${profile}`, choices: ["once", "deny"] } });
      if (flag("profile-request-collision")) out({ jsonrpc: "2.0", id: "A-native", method: "approval", params: { session_id: "s-shared", profile_name: profile, command: `native ${profile}` } });
      out({ jsonrpc: "2.0", id: `Q-${profile}`, method: "clarify", params: { session_id: p.session_id, questions: [{ qid: "q", question: profile }] } });
    }
  }
  if (method === "session.list" && !listed && flag("profile-collision")) {
    listed = true;
    out({ jsonrpc: "2.0", method: "event", params: { type: "native.test", session_id: "s-shared", profile_name: "beta", payload: {} } });
    out({ jsonrpc: "2.0", method: "event", params: { type: "native.ambiguous", session_id: "s-shared", payload: {} } });
  }
  if (method === "session.list" && !listed && flag("bot-approval")) {
    listed = true;
    open.add("A9");
    out({
      jsonrpc: "2.0", id: "A9", method: "approval",
      params: { session_id: "rpc-s-idle", command: "git push origin main", description: "Komut onayı: değişiklikleri uzak depoya gönder", choices: ["once", "session", "deny"] },
    });
  }
  if (method === "session.list" && !listed && flag("approval")) {
    listed = true;
    open.add("A7");
    open.add("Q3");
    out({
      jsonrpc: "2.0", id: "A7", method: "approval",
      params: { session_id: "rpc-s-main", profile_name: "default", command: "rm -rf build", description: "Komut onayı", choices: ["once", "session", "always", "deny"] },
    });
    out({
      jsonrpc: "2.0", id: "Q3", method: "clarify",
      params: { session_id: "rpc-s-main", profile_name: "default", questions: [{ qid: "q1", question: "Hangi dal?", choices: ["main", "dev"], multi_select: false }] },
    });
    const ms = Number(value("cancel-approval", "0"));
    if (ms) {
      setTimeout(() => {
        open.delete("A7");
        out({ jsonrpc: "2.0", method: "event", params: { type: "request.cancel", session_id: "rpc-s-main", payload: { id: "A7", method: "approval", reason: "timeout" } } });
      }, ms);
    }
  }
}

function handle(req) {
  const { id, method } = req;
  const p = req.params && typeof req.params === "object" ? req.params : {};
  log({ id, method, params: p });
  if (exits.has(method)) process.exit(3);
  if (drops.has(method)) return;
  let reply;
  if (flag("no-gateway") && !String(method).startsWith("native.")) {
    reply = err(-32001, "Hermes control connection unavailable; request was not sent");
  } else reply = answer(method, p);
  const send = () => {
    if (flag("late-reply")) {
      out({ jsonrpc: "2.0", id: "deck-unknown-0", result: { status: "stale reply" } });
      out({ jsonrpc: "2.0", id, method: "approval", params: { session_id: "rpc-s-main", command: "same id as a pending call" } });
    }
    out({ jsonrpc: "2.0", id, ...reply });
    after(method, p);
  };
  const d = delays.get(method);
  if (d) setTimeout(send, d);
  else send();
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (line.length > 65536) return; // stream.py drops oversized input lines silently
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    out({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Hermes control connection unavailable; request was not sent" } });
    return;
  }
  if (req && typeof req === "object" && !Array.isArray(req)) handle(req);
});
rl.on("close", () => process.exit(0)); // the app closed our stdin: stop like a dead pipe would

// ---------------------------------------------------------------- snapshots
let sent = 0;
function snapshot() {
  if (flag("no-snapshot")) return;
  const limit = Number(value("snapshots", "0"));
  if (limit && sent >= limit) return;
  sent += 1;
  out({ schema: value("snapshot-schema", "hermes-deck.v1"), hook_event_name: "HermesSnapshot", connection_id: value("connection-id", "hermes"), online: true, gateway: { running: true, active_agents: 1 }, nodes: nodes() });
  if (sent === 1 && flag("oversize")) writeLine("x".repeat(2 * 1024 * 1024 + 16));
}
snapshot();
setInterval(snapshot, Number(value("interval", "200")));
