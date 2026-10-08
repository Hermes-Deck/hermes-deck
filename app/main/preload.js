"use strict";
// The renderer's only door to the system: a few named calls, no Node, no raw ipcRenderer.
const { contextBridge, ipcRenderer, webUtils } = require("electron");
contextBridge.exposeInMainWorld("deckLanguage", process.argv.includes("--deck-language=tr") ? "tr" : "en");
// colour theme: the first paint uses the --deck-theme argument, later changes arrive as "theme" (main/theme.js)
const themeArg = process.argv.find((a) => a.startsWith("--deck-theme="));
contextBridge.exposeInMainWorld("deckTheme", {
  initial: themeArg ? themeArg.slice("--deck-theme=".length) : "basalt",
  onChange: (cb) => { ipcRenderer.on("theme", (_e, name) => cb(String(name))); },
});

const listen = (channel) => (cb) => {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("deck", {
  onLanguage: listen("language"),
  onRelay: listen("relay"),
  onHostVersions: listen("hostver"), // relay / plugin versions on the host (main/host-versions.js)
  onTelegram: listen("tg"),
  ready: () => ipcRenderer.invoke("ready"),
  rendered: () => ipcRenderer.send("rendered"),
  // telegram
  history: (key) => ipcRenderer.invoke("tg:history", key),
  send: (key, text, replyTo) => ipcRenderer.invoke("tg:send", key, text, replyTo),
  // file attachments (A7): files are staged in main and named by a token; the page never sees a path.
  // drop(files): dropped File objects become paths here, in the isolated preload, and main checks them
  // again; `nopath` lists the files that have none (an image dragged out of a web page, say).
  attach: {
    pick: () => ipcRenderer.invoke("tg:attach-pick"),
    drop: async (files) => {
      const list = Array.from(files || []);
      const paths = [];
      const nopath = [];
      list.forEach((f, i) => {
        let p = "";
        try {
          p = webUtils.getPathForFile(f);
        } catch {
          p = "";
        }
        if (p) paths.push(p);
        else nopath.push(i);
      });
      const r = paths.length ? await ipcRenderer.invoke("tg:attach-drop", paths) : { items: [], errors: [] };
      return { ...r, nopath };
    },
    // bytes of a pasted/dropped file that has no path; name and type are display hints (main sniffs images itself)
    paste: (bytes, name, type) => ipcRenderer.invoke("tg:attach-paste", { bytes, name, type }),
    saveDraft: (key, tokens) => ipcRenderer.invoke("attach:draft-save", key, tokens),
    restoreDrafts: () => ipcRenderer.invoke("attach:draft-restore"),
    forgetDraft: (key) => ipcRenderer.invoke("attach:draft-forget", key),
    appshot: () => ipcRenderer.invoke("attach:appshot"),
    discard: (token) => ipcRenderer.invoke("tg:attach-discard", token),
    send: (key, token, opts) => ipcRenderer.invoke("tg:send-file", key, token, opts),
    cancel: (token) => ipcRenderer.invoke("tg:upload-cancel", token),
  },
  // C5: "seen up to maxId" for read receipts (main batches them and checks the window is in front)
  markRead: (key, maxId) => ipcRenderer.send("tg:read", key, maxId),
  // message view: media (variant "thumb" | "full"; ref "p<i>"/"d<i>" picks a rich message's photo or
  // document), open/save a downloaded file, callback buttons (where "kb" | "rich")
  media: (key, msgId, variant, ref) => ipcRenderer.invoke("tg:media", key, msgId, variant, ref),
  mediaOpen: (key, msgId, ref) => ipcRenderer.invoke("tg:media-open", key, msgId, ref),
  mediaSave: (key, msgId, ref) => ipcRenderer.invoke("tg:media-save", key, msgId, ref),
  callback: (key, msgId, row, col, where) => ipcRenderer.invoke("tg:callback", key, msgId, row, col, where),
  // reactions (C9): the chat's picker, the user's own set on a message, a custom emoji's picture
  reactionChoices: (key) => ipcRenderer.invoke("tg:reaction-choices", key),
  react: (key, msgId, keys) => ipcRenderer.invoke("tg:react", key, msgId, keys),
  emoji: (docId) => ipcRenderer.invoke("tg:emoji", docId),
  // forum topics of the configured group: op "create" | "rename" | "close" | "pin" | "delete"
  topic: (op, args) => ipcRenderer.invoke("tg:topic", op, args),
  retryTelegram: () => ipcRenderer.invoke("tg:retry"),
  loginStart: (phone) => ipcRenderer.invoke("tg:login-start", phone),
  loginAnswer: (step, value) => ipcRenderer.invoke("tg:login-answer", step, value),
  loginCancel: () => ipcRenderer.invoke("tg:login-cancel"),
  logout: () => ipcRenderer.invoke("tg:logout"),
  // relay
  session: (sid) => ipcRenderer.invoke("relay:session", sid),
  sessionPlan: (sid) => ipcRenderer.invoke("relay:plan", sid), // Plan tab, relay path: {sid, plan, stored}
  tokens: (rangeOrDays) => ipcRenderer.invoke("relay:tokens", rangeOrDays), // "24h" | "7d" | "14d" | "30d" | "all", or a day count
  quotaRefresh: () => ipcRenderer.invoke("relay:quota-refresh"), // {refreshed, throttled, timedOut, retryAfterS}
  // sub-agent views (B1/B3): a session's messages (newest page; `before` pages back), one message in
  // full, one tool call in full
  messages: (sid, before) => ipcRenderer.invoke("relay:messages", sid, before),
  messageFull: (id) => ipcRenderer.invoke("relay:message-full", id),
  toolCall: (sid, call) => ipcRenderer.invoke("relay:call", sid, call),
  // settings (secrets go in, never come back out)
  settingsGet: () => ipcRenderer.invoke("settings:get"),
  settingsSave: (patch) => ipcRenderer.invoke("settings:save", patch),
  updates: {
    status: () => ipcRenderer.invoke("updates:status"),
    check: () => ipcRenderer.invoke("updates:check"),
    install: () => ipcRenderer.invoke("updates:install"),
    open: () => ipcRenderer.invoke("updates:open"),
    on: listen("updates"),
  },
  wallpaper: { // per chat mode
    pick: (mode) => ipcRenderer.invoke("wallpaper:pick", mode),
    preset: (mode, id) => ipcRenderer.invoke("wallpaper:preset", mode, id),
    clear: (mode) => ipcRenderer.invoke("wallpaper:clear", mode),
  },
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  // desktop shell (A9–A11): the fleet summary goes out to the pet and tray; notification clicks
  // ({t: "select", key}), chimes ({t: "chime", kind}) and tray-made settings changes come back
  desktop: {
    petState: (summary) => ipcRenderer.send("desktop:pet-state", summary),
    testNotification: () => ipcRenderer.invoke("desktop:test"),
    onEvent: listen("desktop"),
  },
  // direct Hermes connection: reads, mutations (each one a user's click), SSH setup
  bridge: {
    status: () => ipcRenderer.invoke("bridge:status"),
    sessions: (opts) => ipcRenderer.invoke("bridge:sessions", opts),
    history: (sid, opts) => ipcRenderer.invoke("bridge:history", sid, opts),
    send: (sid, text, opts) => ipcRenderer.invoke("bridge:send", sid, text, opts),
    create: (opts) => ipcRenderer.invoke("bridge:create", opts),
    discard: (sid) => ipcRenderer.invoke("bridge:discard", sid),
    finishUnload: () => ipcRenderer.invoke("bridge:unload-done"),
    deleteSession: (sid, opts) => ipcRenderer.invoke("bridge:delete", sid, opts),
    // session browser: every profile's stored sessions, and the click-driven writes on one of them
    sessionIndex: (opts) => ipcRenderer.invoke("bridge:session-index", opts),
    renameSession: (sid, opts) => ipcRenderer.invoke("bridge:session-rename", sid, opts),
    pinSession: (sid, opts) => ipcRenderer.invoke("bridge:session-pin", sid, opts),
    archiveSession: (sid, opts) => ipcRenderer.invoke("bridge:session-archive", sid, opts),
    branchSession: (sid, opts) => ipcRenderer.invoke("bridge:session-branch", sid, opts),
    takeover: (sid, opts) => ipcRenderer.invoke("bridge:takeover", sid, opts),
    steer: (sid, text, opts) => ipcRenderer.invoke("bridge:steer", sid, text, opts),
    redirect: (sid, text, opts) => ipcRenderer.invoke("bridge:redirect", sid, text, opts),
    interrupt: (sid, opts) => ipcRenderer.invoke("bridge:interrupt", sid, opts),
    reasoning: (show) => ipcRenderer.invoke("bridge:reasoning", show === true), // "Show thinking" for sessions the Deck drives
    // work pane: a session's live sub-agents (reads), steer / interrupt one of them (a click each), its plan and tool calls
    subagents: (sid, opts) => ipcRenderer.invoke("bridge:subagents", sid, opts),
    subagentTail: (sid, subagentId, opts) => ipcRenderer.invoke("bridge:subagent-tail", sid, subagentId, opts),
    steerSubagent: (sid, subagentId, text, opts) => ipcRenderer.invoke("bridge:subagent-steer", sid, subagentId, text, opts),
    interruptSubagent: (sid, subagentId, opts) => ipcRenderer.invoke("bridge:subagent-interrupt", sid, subagentId, opts),
    plan: (sid, opts) => ipcRenderer.invoke("bridge:plan", sid, opts),
    toolCalls: (sid, opts) => ipcRenderer.invoke("bridge:tool-calls", sid, opts),
    modelOptions: (sid, opts) => ipcRenderer.invoke("bridge:model-options", sid, opts),
    setModel: (sid, choice) => ipcRenderer.invoke("bridge:set-model", sid, choice),
    setEffort: (sid, opts) => ipcRenderer.invoke("bridge:set-effort", sid, opts),
    answerApproval: (id, choice) => ipcRenderer.invoke("bridge:answer-approval", id, choice),
    answerQuestion: (id, answers) => ipcRenderer.invoke("bridge:answer-question", id, answers),
    // Botlar: profile roster + avatars, the read-only Bot Chat lookup, and its create (first message only)
    profiles: () => ipcRenderer.invoke("bridge:profiles"),
    avatar: (name) => ipcRenderer.invoke("bridge:avatar", name),
    botChat: (name, opts) => ipcRenderer.invoke("bridge:bot-chat", name, opts),
    botChatCreate: (name, opts) => ipcRenderer.invoke("bridge:bot-chat-create", name, opts),
    // dictation: the recorded clip (Uint8Array) is transcribed on the Hermes host and comes back as text
    transcribe: (bytes, mime) => ipcRenderer.invoke("bridge:transcribe", bytes, mime),
    // files the agent offered in a session: addressed by the opaque ref main issued, never by a path
    file: {
      pickFolder: () => ipcRenderer.invoke("downloads:pick-folder"), // Settings > Download folder (returns the public settings)
      resetFolder: () => ipcRenderer.invoke("downloads:reset-folder"),
      info: (sid, ref, opts) => ipcRenderer.invoke("bridge:file-info", sid, ref, opts),
      image: (sid, ref, opts) => ipcRenderer.invoke("bridge:media-image", sid, ref, opts), // inline preview of a user-sent image
      audio: (sid, ref, opts) => ipcRenderer.invoke("bridge:media-audio", sid, ref, opts), // whole clip for the inline voice-note player
      download: (sid, ref, opts) => ipcRenderer.invoke("bridge:file-download", sid, ref, opts),
      cancel: (ticket) => ipcRenderer.invoke("bridge:file-cancel", ticket),
      open: (id) => ipcRenderer.invoke("bridge:file-open", id),
      reveal: (id) => ipcRenderer.invoke("bridge:file-reveal", id),
      onEvent: listen("files"),
    },
    onEvent: listen("bridge"),
    test: (config) => ipcRenderer.invoke("bridge:test", config),
  },
  // --- Workspace tab (main/presence.js, main/workspace.js) ---
  device: {
    state: () => ipcRenderer.invoke("device:state"),
    setHosting: (capability, on) => ipcRenderer.invoke("device:set-hosting", capability, on),
  },
  // --- Bot screen (main/cua): the "desktop" switch itself is deck.device.setHosting("desktop", on) ---
  botscreen: {
    state: () => ipcRenderer.invoke("bs:state"),
    setAgents: (profiles) => ipcRenderer.invoke("bs:agents", profiles),
    saveToken: (token) => ipcRenderer.invoke("bs:token", token), // goes in, never comes back out
    install: () => ipcRenderer.invoke("bs:install"),
    windows: () => ipcRenderer.invoke("bs:windows"),
    preview: (sourceId) => ipcRenderer.invoke("bs:preview", sourceId),
    frontmost: () => ipcRenderer.invoke("bs:frontmost"),
    pickerClosed: () => ipcRenderer.invoke("bs:picker-closed"),
    grant: (choice) => ipcRenderer.invoke("bs:grant", choice),
    stop: () => ipcRenderer.invoke("bs:stop"),
    lease: (profile, hold) => ipcRenderer.invoke("bs:lease", profile, hold),
    frame: (path) => ipcRenderer.invoke("bs:frame", path),
    macPermissions: () => ipcRenderer.invoke("bs:mac-permissions"),
    onEvent: listen("botscreen"),
  },
  // --- agent spaces (main/spaces.js): the agents' own desktop, its viewer and the user's control level ---
  spaces: {
    list: () => ipcRenderer.invoke("spaces:list"),
    audit: (profile, before, limit) => ipcRenderer.invoke("spaces:audit", profile, before, limit),
    frame: (profile, id) => ipcRenderer.invoke("spaces:frame", profile, id),
    approvals: () => ipcRenderer.invoke("spaces:approvals"),
    answer: (id, choice, withoutSnapshot) => ipcRenderer.invoke("spaces:answer", id, choice, withoutSnapshot),
    snapshots: (profile) => ipcRenderer.invoke("spaces:snapshots", profile),
    restore: (profile, id) => ipcRenderer.invoke("spaces:restore", profile, id),
    deleteSnapshots: (profile) => ipcRenderer.invoke("spaces:deleteSnapshots", profile),
    safety: (patch) => ipcRenderer.invoke("spaces:safety", patch),
    control: (level, space) => ipcRenderer.invoke("spaces:control", level, space), // watch | together | full | release; space: "host" or a profile
    route: (profile, target) => ipcRenderer.invoke("spaces:route", profile, target), // target: "device" | "space"
    mode: (mode) => ipcRenderer.invoke("spaces:mode", mode),
    view: (rect, level, space) => ipcRenderer.invoke("spaces:view", rect, level, space), // rect: the stage in CSS px, null hides
    home: (profile, host) => ipcRenderer.invoke("spaces:home", profile, host), // host: "auto" | "agent-host" | a device id
    desktop: (profile, action) => ipcRenderer.invoke("spaces:desktop", profile, action), // action: "start" | "stop"
  },
  // --- agent desktops on this computer (main/desktops.js), Settings > This device > Agent desktops ---
  desktops: {
    state: () => ipcRenderer.invoke("desktops:state"), // {docker, image, pull, host, limit, running, error, isolation, sizeBytes}
    host: (on) => ipcRenderer.invoke("desktops:host", on), // after the consent sheet; -> {settings, state}
    stop: (profile) => ipcRenderer.invoke("desktops:stop", profile),
    reset: (profile) => ipcRenderer.invoke("desktops:reset", profile), // after its confirmation
    onEvent: listen("desktops"),
  },
  workspace: {
    state: () => ipcRenderer.invoke("ws:state"),
    watch: (slug, opts) => ipcRenderer.invoke("ws:watch", slug, opts),
    resize: (slug, opts) => ipcRenderer.invoke("ws:resize", slug, opts), // the stage changed size: {maxWidth, maxHeight, large}
    unwatch: () => ipcRenderer.invoke("ws:unwatch"),
    start: (slug, where) => ipcRenderer.invoke("ws:start", slug, where), // where: "agent-host" starts it there
    control: (slug, who) => ipcRenderer.invoke("ws:control", slug, who),
    setHost: (slug, where) => ipcRenderer.invoke("ws:host", slug, where), // "auto" | "here" | "agent-host"
    transferTargets: () => ipcRenderer.invoke("ws:transfer-targets"),
    transferConsent: (target, automatic) => ipcRenderer.invoke("ws:transfer-consent", target, automatic),
    disableTransferAutomatic: () => ipcRenderer.invoke("ws:transfer-auto-off"),
    handoff: (slug, target) => ipcRenderer.invoke("ws:handoff", slug, target),
    follow: (slug) => ipcRenderer.invoke("ws:follow", slug), // follow the agent again after picking a tab
    navigate: (slug, url) => ipcRenderer.invoke("ws:navigate", slug, url),
    history: (slug, delta) => ipcRenderer.invoke("ws:history", slug, delta),
    reload: (slug) => ipcRenderer.invoke("ws:reload", slug),
    newTab: (slug) => ipcRenderer.invoke("ws:new-tab", slug),
    selectTab: (slug, id) => ipcRenderer.invoke("ws:select-tab", slug, id),
    closeTab: (slug, id) => ipcRenderer.invoke("ws:close-tab", slug, id),
    input: (slug, ev) => ipcRenderer.send("ws:input", slug, ev),
    onEvent: listen("workspace"),
  },
});
