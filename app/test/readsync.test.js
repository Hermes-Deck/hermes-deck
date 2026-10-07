"use strict";
// C5 read receipts, checked offline: the batching queue (main/readsync.js), the request shapes and the
// read updates in main/telegram.js, and the renderer's look-then-send tracker and badge helpers
// (renderer/readsync.js). Fake clients and fake timers only; a guard fails the run on any network use.
const { test } = require("node:test");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("node:assert/strict");
const net = require("net");
const tls = require("tls");
const dns = require("dns");

const blocked = (what) =>
  function () {
    throw new Error(`network use in a test: ${what}`);
  };
net.connect = net.createConnection = blocked("net.connect");
net.Socket.prototype.connect = blocked("net.Socket.connect");
tls.connect = blocked("tls.connect");
dns.lookup = blocked("dns.lookup");

const { Api, helpers } = require("teleproto");
const { UpdateConnectionState } = require("teleproto/network");
const { ReadQueue } = require("../main/readsync");
const { TelegramService } = require("../main/telegram");
const RS = require("../renderer/readsync");
const sample = require("./rich-sample");

const big = helpers.returnBigInt;
const GROUP_ID = `-100${sample.GROUP_CHANNEL}`;
const KEY = `u${sample.BOT}`;
const channel = () => new Api.Channel({ id: big(sample.GROUP_CHANNEL), accessHash: big(77), title: "Atölye", photo: new Api.ChatPhotoEmpty(), date: 0, forum: true, megagroup: true, creator: true });
const bot = () => new Api.User({ id: big(sample.BOT), accessHash: big(5), bot: true, firstName: "Atlas", username: "atlas_ornek_bot" });

/** Timers driven by hand: tick(ms) runs what falls due, in order. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const due = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      due.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => due.delete(id),
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...due.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await new Promise((r) => setImmediate(r)); // let the flush's awaits settle
      }
      now = end;
    },
    pending: () => due.size,
  };
}

/** A service on a fake client: the bot DM and the forum group are known, nothing is connected. */
function service(client, opts = {}) {
  const svc = new TelegramService({ apiId: 1, apiHash: "x", groupChatId: GROUP_ID, readGate: () => true, ...opts });
  svc.client = client;
  svc.bots.set(sample.BOT, { key: KEY, entity: bot() });
  svc.group = channel();
  svc.state = { group: { id: GROUP_ID, title: "Atölye" }, bots: [{ key: KEY, unread: 4 }], topics: [{ key: "t5", unread: 2 }] };
  return svc;
}

const recorder = (answer = () => true) => {
  const calls = [];
  return { calls, invoke: async (req) => (calls.push(req), answer(req)) };
};

// ------------------------------------------------------------------ main/readsync.js
test("queue: marks collapse into one batch after a quiet pause, highest id per chat", async () => {
  const t = fakeTimers();
  const sent = [];
  const q = new ReadQueue({ send: async (k, id) => sent.push([k, id]), gate: () => true, timers: t, now: t.now });
  assert.equal(q.mark("u1", 10), true);
  await t.tick(500);
  assert.equal(q.mark("u1", 12), true);
  assert.equal(q.mark("u1", 11), false, "an older id than the queued one adds nothing");
  assert.equal(q.mark("t5", 40), true);
  await t.tick(1400);
  assert.deepEqual(sent, [], "debounced: the last mark restarted the wait");
  await t.tick(200);
  assert.deepEqual(sent, [["u1", 12], ["t5", 40]]);
  assert.equal(q.mark("u1", 12), false, "already sent");
  assert.equal(q.mark("u1", 0), false);
  assert.equal(q.mark("u1", "x"), false);
});

test("queue: constant scrolling still sends within the maximum wait", async () => {
  const t = fakeTimers();
  const sent = [];
  const q = new ReadQueue({ send: async (k, id) => sent.push([k, id]), gate: () => true, timers: t, now: t.now });
  for (let i = 1; i <= 10; i++) {
    q.mark("u1", i); // every 700 ms: the quiet pause never comes
    await t.tick(700);
    if (i === 7) assert.deepEqual(sent, [], "not before the maximum wait");
  }
  assert.deepEqual(sent[0], ["u1", 8], "sent at the 5 s mark with the newest id so far, while still scrolling");
});

test("queue: nothing goes out while the gate is closed; wake() sends what was held", async () => {
  const t = fakeTimers();
  const sent = [];
  let front = false;
  const q = new ReadQueue({ send: async (k, id) => sent.push([k, id]), gate: () => front, timers: t, now: t.now });
  q.mark("u1", 3);
  await t.tick(10000);
  assert.deepEqual(sent, [], "window in the background: held");
  assert.equal(t.pending(), 0, "and no timer keeps spinning");
  front = true;
  q.wake();
  await t.tick(1500);
  assert.deepEqual(sent, [["u1", 3]]);
});

test("queue: reads from another device cancel queued marks; failures retry, then drop", async () => {
  const t = fakeTimers();
  const sent = [];
  let fail = 0;
  const q = new ReadQueue({
    send: async (k, id) => {
      if (fail > 0) {
        fail--;
        throw new Error("FLOOD_WAIT_3");
      }
      sent.push([k, id]);
    },
    gate: () => true,
    timers: t,
    now: t.now,
  });
  q.mark("u1", 5);
  q.seen("u1", 9);
  await t.tick(2000);
  assert.deepEqual(sent, [], "already read elsewhere");
  assert.equal(q.mark("u1", 8), false);
  fail = 1;
  q.mark("u1", 10);
  await t.tick(1500);
  await t.tick(1500);
  assert.deepEqual(sent, [["u1", 10]], "one failure, then sent");
  fail = 10;
  q.mark("u1", 11);
  await t.tick(20000);
  assert.equal(q.pending.size, 0, "gave up after the retries");
  q.mark("u1", 12);
  q.clear();
  await t.tick(5000);
  assert.equal(sent.length, 1);
});

// ------------------------------------------------------------------ main/telegram.js: outgoing
test("requests: a bot DM is messages.readHistory, a topic messages.readDiscussion; never channels.readHistory", async () => {
  const c = recorder((req) => (req instanceof Api.messages.ReadHistory ? new Api.messages.AffectedMessages({ pts: 1, ptsCount: 1 }) : true));
  const svc = service(c);
  assert.equal(svc.markRead(KEY, 120), true);
  assert.equal(svc.markRead("t5", 300), true);
  assert.equal(svc.markRead("t1", 77), true);
  assert.equal(svc.markRead("x9", 5), false, "not a chat key");
  await svc._reads.flush();
  assert.equal(c.calls.length, 3, "one request per chat, in one batch");
  const [dm, topic, general] = c.calls;
  assert.ok(dm instanceof Api.messages.ReadHistory);
  assert.ok(dm.peer instanceof Api.InputPeerUser);
  assert.equal(dm.peer.userId.toString(), sample.BOT);
  assert.equal(dm.peer.accessHash.toString(), "5");
  assert.equal(dm.maxId, 120);
  assert.ok(topic instanceof Api.messages.ReadDiscussion);
  assert.ok(topic.peer instanceof Api.InputPeerChannel);
  assert.equal(topic.peer.channelId.toString(), sample.GROUP_CHANNEL);
  assert.equal(topic.msgId, 5);
  assert.equal(topic.readMaxId, 300);
  assert.ok(general instanceof Api.messages.ReadDiscussion);
  assert.equal(general.msgId, 1, "General is topic 1");
  assert.ok(!c.calls.some((x) => x instanceof Api.channels.ReadHistory));
  assert.equal(svc.markRead(KEY, 120), false, "sent once");
});

test("requests: none while the window is not in front, none with receipts off", async () => {
  const c = recorder();
  let front = false;
  const svc = service(c, { readGate: () => front });
  svc.markRead(KEY, 50);
  await svc._reads.flush();
  assert.equal(c.calls.length, 0, "hidden or unfocused: held");
  front = true;
  svc.wakeReads();
  await svc._reads.flush();
  assert.equal(c.calls.length, 1, "sent once the window is back");
  clearTimeout(svc._reads.timer);

  svc.setReadReceipts(false);
  assert.equal(svc.markRead(KEY, 60), false);
  await svc._reads.flush();
  assert.equal(c.calls.length, 1, "off: only local tracking");
  svc.markRead(KEY, 61);
  svc.setReadReceipts(true);
  assert.equal(svc.markRead(KEY, 62), true, "on again");
  svc.setReadReceipts(false);
  await svc._reads.flush();
  assert.equal(c.calls.length, 1, "switching off drops what was queued");

  const quiet = new TelegramService({ apiId: 1, apiHash: "x" });
  quiet.client = c;
  quiet.bots.set(sample.BOT, { key: KEY, entity: bot() });
  quiet.markRead(KEY, 70);
  await quiet._reads.flush();
  assert.equal(c.calls.length, 1, "no gate given: nothing is ever sent");
});

test("requests: what the topic list already shows as read is not marked again", async () => {
  const c = recorder((req) =>
    req instanceof Api.messages.GetForumTopics
      ? new Api.messages.ForumTopics({
        count: 1,
        topics: [new Api.ForumTopic({ id: 5, date: 0, title: "Saha", iconColor: 0, topMessage: 310, readInboxMaxId: 305, readOutboxMaxId: 0, unreadCount: 1, unreadMentionsCount: 0, unreadReactionsCount: 0, fromId: new Api.PeerUser({ userId: big(1) }), notifySettings: new Api.PeerNotifySettings({}) })],
        messages: [],
        chats: [],
        users: [],
        pts: 0,
      })
      : true
  );
  const svc = service(c);
  const topics = await svc._topics();
  assert.equal(topics[0].unread, 1);
  assert.equal(svc.markRead("t5", 300), false);
  assert.equal(svc.markRead("t5", 310), true);
});

// ------------------------------------------------------------------ main/telegram.js: incoming
test("read updates: a bot DM read elsewhere clears to Telegram's count; other chats are ignored", () => {
  const svc = service(recorder());
  const got = [];
  svc.on("read", (x) => got.push(x));
  svc.markRead(KEY, 40);
  svc._onRaw(new Api.UpdateReadHistoryInbox({ peer: new Api.PeerUser({ userId: big(sample.BOT) }), maxId: 42, stillUnreadCount: 0, pts: 1, ptsCount: 1 }));
  svc._onRaw(new Api.UpdateReadHistoryInbox({ peer: new Api.PeerUser({ userId: big(999) }), maxId: 9, stillUnreadCount: 0, pts: 2, ptsCount: 1 }));
  svc._onRaw(new Api.UpdateReadChannelOutbox({ channelId: big(sample.GROUP_CHANNEL), maxId: 3 }));
  assert.deepEqual(got, [{ key: KEY, unread: 0, maxId: 42 }]);
  assert.equal(svc.state.bots[0].unread, 0, "the snapshot for a reloaded window follows");
  assert.equal(svc._reads.pending.size, 0, "the queued mark is covered by the read elsewhere");
  assert.equal(svc.markRead(KEY, 41), false);
  clearTimeout(svc._reads.timer);
});

test("read updates: a topic read elsewhere is fetched again for its count, in one batch", async () => {
  const c = recorder((req) => {
    if (!(req instanceof Api.messages.GetForumTopicsByID)) return true;
    const topic = (id, unread) => new Api.ForumTopic({ id, date: 0, title: `Konu ${id}`, iconColor: 0, topMessage: 500, readInboxMaxId: 499, readOutboxMaxId: 0, unreadCount: unread, unreadMentionsCount: 0, unreadReactionsCount: 0, fromId: new Api.PeerUser({ userId: big(1) }), notifySettings: new Api.PeerNotifySettings({}) });
    return new Api.messages.ForumTopics({ count: 2, topics: [topic(5, 1), topic(1, 0)], messages: [], chats: [], users: [], pts: 0 });
  });
  const svc = service(c);
  const got = [];
  svc.on("read", (x) => got.push(x));
  const upd = (top) => new Api.UpdateReadChannelDiscussionInbox({ channelId: big(sample.GROUP_CHANNEL), topMsgId: top, readMaxId: 499 });
  svc._onRaw(upd(5));
  svc._onRaw(upd(1));
  svc._onRaw(new Api.UpdateReadChannelDiscussionInbox({ channelId: big(42), topMsgId: 7, readMaxId: 1 }));
  clearTimeout(svc._topicReadT);
  await svc._topicReads();
  const byId = c.calls.filter((x) => x instanceof Api.messages.GetForumTopicsByID);
  assert.equal(byId.length, 1);
  assert.deepEqual(byId[0].topics, [5, 1], "only the configured group's topics");
  assert.ok(byId[0].peer instanceof Api.InputPeerChannel);
  assert.deepEqual(got, [
    { key: "t5", unread: 1, maxId: 499 },
    { key: "t1", unread: 0, maxId: 499 },
  ]);
  assert.equal(svc.state.topics[0].unread, 1);
});

test("reconnect: held marks go out and every unread count is read again", async () => {
  const c = recorder((req) => {
    if (req instanceof Api.messages.GetPeerDialogs) {
      const d = new Api.Dialog({ peer: new Api.PeerUser({ userId: big(sample.BOT) }), topMessage: 90, readInboxMaxId: 88, readOutboxMaxId: 0, unreadCount: 2, unreadMentionsCount: 0, unreadReactionsCount: 0, notifySettings: new Api.PeerNotifySettings({}) });
      return new Api.messages.PeerDialogs({ dialogs: [d], messages: [], chats: [], users: [], state: new Api.updates.State({ pts: 0, qts: 0, date: 0, seq: 0, unreadCount: 0 }) });
    }
    if (req instanceof Api.messages.GetForumTopics) return new Api.messages.ForumTopics({ count: 0, topics: [], messages: [], chats: [], users: [], pts: 0 });
    return true;
  });
  const svc = service(c);
  let scheduled = 0;
  svc._countsSoon = () => scheduled++;
  let woke = 0;
  svc._reads.wake = () => woke++;
  svc._onRaw(new UpdateConnectionState(UpdateConnectionState.connected));
  assert.equal(scheduled + woke, 0, "connected without a drop before: nothing to do");
  svc._onRaw(new UpdateConnectionState(UpdateConnectionState.broken));
  svc._onRaw(new UpdateConnectionState(UpdateConnectionState.connected));
  assert.equal(scheduled, 1);
  assert.equal(woke, 1);
  svc._onRaw(new Api.UpdateReadChannelInbox({ channelId: big(sample.GROUP_CHANNEL), maxId: 10, stillUnreadCount: 0, pts: 1 }));
  assert.equal(scheduled, 2, "a whole-group read refreshes the topics too");

  const counts = [];
  svc.on("counts", (x) => counts.push(x.counts));
  await svc.refreshCounts();
  const pd = c.calls.find((x) => x instanceof Api.messages.GetPeerDialogs);
  assert.equal(pd.peers.length, 1);
  assert.ok(pd.peers[0] instanceof Api.InputDialogPeer);
  assert.ok(pd.peers[0].peer instanceof Api.InputPeerUser);
  assert.deepEqual(counts, [{ [KEY]: 2 }]);
  assert.equal(svc.markRead(KEY, 88), false, "Telegram's read mark is remembered");
});

// ------------------------------------------------------------------ renderer/readsync.js
test("renderer: the newest message with any part on screen counts as seen", () => {
  const view = { top: 100, bottom: 500 };
  const items = [
    { id: 1, top: -300, bottom: 90 }, // above
    { id: 2, top: 80, bottom: 120 }, // cut at the top edge
    { id: 3, top: 130, bottom: 480 },
    { id: 4, top: 499, bottom: 900 }, // a sliver at the bottom
    { id: 5, top: 510, bottom: 700 }, // below: not seen
  ];
  assert.equal(RS.visibleMax(view, items), 4);
  assert.equal(RS.visibleMax(view, [{ id: 9, top: 600, bottom: 700 }]), 0);
  assert.equal(RS.visibleMax(view, [{ id: 9, top: 200, bottom: 200 }]), 0, "hidden (no height)");
  assert.equal(RS.visibleMax(view, []), 0);
});

test("renderer: nothing is sent unless the chat is really in front; bursts collapse; each id once", async () => {
  const t = fakeTimers();
  const sent = [];
  let viewing = false;
  let shown = { key: "u1", maxId: 10 };
  const r = RS.create({ viewing: () => viewing, seen: () => shown, send: (k, id) => sent.push([k, id]), timers: t });
  r.check();
  await t.tick(300);
  assert.deepEqual(sent, [], "unfocused or hidden: nothing");
  viewing = true;
  r.check();
  r.check();
  r.check();
  assert.equal(t.pending(), 1, "one look per burst");
  await t.tick(300);
  assert.deepEqual(sent, [["u1", 10]]);
  r.check();
  await t.tick(300);
  assert.equal(sent.length, 1, "same message: not sent again");
  shown = { key: "u1", maxId: 14 };
  r.check();
  await t.tick(300);
  shown = { key: "t5", maxId: 0 };
  r.check();
  await t.tick(300);
  assert.deepEqual(sent, [["u1", 10], ["u1", 14]], "an empty chat sends nothing");
  r.forget();
  shown = { key: "u1", maxId: 14 };
  r.check();
  await t.tick(300);
  assert.equal(sent.length, 3, "forget() allows a resend (receipts switched back on)");
});

test("renderer: read updates only lower badges; reconnect counts are exact only with receipts on", () => {
  assert.equal(RS.afterRead(5, 0), 0);
  assert.equal(RS.afterRead(5, 2), 2);
  assert.equal(RS.afterRead(1, 4), 1, "a read never raises a badge");
  assert.equal(RS.afterRead(3, undefined), 3);

  const unread = new Map([["u1", 3], ["u2", 0], ["t5", 4]]);
  assert.equal(RS.applyCounts(unread, { u1: 1, u2: 2, t5: 9 }, { exact: true, hold: "t5" }), true);
  assert.deepEqual([...unread], [["u1", 1], ["u2", 2], ["t5", 0]], "exact, but the open chat keeps no badge");
  const local = new Map([["u1", 3], ["u2", 0]]);
  RS.applyCounts(local, { u1: 1, u2: 6 }, { exact: false });
  assert.deepEqual([...local], [["u1", 1], ["u2", 0]], "receipts off: Telegram's counts may only lower");
  assert.equal(RS.applyCounts(local, { u1: 1, u2: "x" }, { exact: true }), false);
});

test("renderer: default timers work with a browser-style setTimeout that refuses a foreign this", async () => {
  // in Chromium, obj.setTimeout(...) with obj not the window throws "Illegal invocation"
  const strict = function (fn, ms) {
    if (this !== undefined && this !== box) throw new TypeError("Illegal invocation");
    return setTimeout(fn, ms);
  };
  const box = { setTimeout: strict, clearTimeout };
  box.window = box;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "renderer", "readsync.js"), "utf8"), box);
  const sent = [];
  const r = box.DeckReadSync.create({ viewing: () => true, seen: () => ({ key: "u1", maxId: 3 }), send: (k, id) => sent.push([k, id]), delay: 1 });
  assert.doesNotThrow(() => r.check());
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(sent, [["u1", 3]]);
});
