'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/mobile-notify-policy');

const MIN = 60000;
const policy = (raw = {}) => P.normalizePolicy(raw);
// Small seeded PRNG so a failing stream can be replayed from its seed.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

test('policy: defaults, clamping, unknown keys ignored, bad entries dropped, non-object rejected', () => {
  assert.deepEqual(P.normalizePolicy(undefined), { v: 1, burst: 5, quietMinutes: 10, maxQuietMinutes: 60, bypass: [], scope: 'mine', agents: [], muted: [] });
  assert.deepEqual(P.normalizePolicy(null), P.normalizePolicy({}));
  const p = P.normalizePolicy({ v: 9, burst: 99, quietMinutes: 0, bypass: ['approval', 'reply', 'question', 'approval'], scope: 'everything', agents: ['ada', 'ada', '../x', 7, 'atlas'], muted: ['bad name'], extra: true });
  assert.deepEqual(p, { v: 1, burst: 20, quietMinutes: 1, maxQuietMinutes: 60, bypass: ['approval', 'question'], scope: 'mine', agents: ['ada', 'atlas'], muted: [] });
  assert.equal(P.normalizePolicy({ burst: 0 }).burst, 1);
  assert.equal(P.normalizePolicy({ burst: 'x' }).burst, 5);
  assert.equal(P.normalizePolicy({ burst: 2.6 }).burst, 3);
  assert.equal(P.normalizePolicy({ quietMinutes: 500 }).quietMinutes, 120);
  assert.equal(P.normalizePolicy({ quietMinutes: 90 }).maxQuietMinutes, 90, 'a base longer than the cap is its own cap');
  assert.equal(P.normalizePolicy({ scope: 'all' }).scope, 'all');
  assert.equal(P.normalizePolicy({ scope: 'followed' }).scope, 'followed');
  assert.equal(P.normalizePolicy({ agents: Array.from({ length: 100 }, (_, i) => `a${i}`) }).agents.length, 64);
  for (const bad of [[], 'mine', 5, true]) assert.throws(() => P.normalizePolicy(bad), /object/);
});

test('kinds: a device that never sent a list gets done/approval/question/error; a stored list wins, also an empty one', () => {
  assert.deepEqual(P.kindsOf(null), ['done', 'approval', 'question', 'error']);
  assert.deepEqual(P.kindsOf(undefined), ['done', 'approval', 'question', 'error']);
  assert.deepEqual(P.kindsOf(['reply', 'done', 'bogus']), ['reply', 'done']);
  assert.deepEqual(P.kindsOf([]), []);
});

test('scope: mine by default, all, followed and muted agents, sub-agent sessions, approvals and questions always', () => {
  const mine = policy();
  const ev = (kind, extra = {}) => ({ kind, profile: 'ada', subagent: false, mine: false, ...extra });
  assert.equal(P.scopeDecision(mine, ev('done')), 'scoped-out');
  assert.equal(P.scopeDecision(mine, ev('reply')), 'scoped-out');
  assert.equal(P.scopeDecision(mine, ev('error')), 'scoped-out');
  assert.equal(P.scopeDecision(mine, ev('done', { mine: true })), null);
  assert.equal(P.scopeDecision(mine, ev('approval')), null);
  assert.equal(P.scopeDecision(mine, ev('question', { subagent: true })), null);
  assert.equal(P.scopeDecision(mine, ev('done', { mine: true, subagent: true })), 'subagent');
  assert.equal(P.scopeDecision(policy({ scope: 'all' }), ev('done')), null);
  assert.equal(P.scopeDecision(policy({ scope: 'all' }), ev('done', { subagent: true })), 'subagent', 'never for sub-agent sessions, whatever the scope');
  assert.equal(P.scopeDecision(policy({ agents: ['ada'] }), ev('done')), null, 'a followed agent counts as mine');
  assert.equal(P.scopeDecision(policy({ agents: ['ada'], muted: ['ada'] }), ev('done', { mine: true })), 'muted', 'mute beats follow and mine');
  assert.equal(P.scopeDecision(policy({ scope: 'all', muted: ['ada'] }), ev('reply')), 'muted');
  assert.equal(P.scopeDecision(policy({ muted: ['ada'] }), ev('approval')), null, 'a muted agent still reaches the phone when it needs you');
  assert.equal(P.scopeDecision(policy({ scope: 'followed' }), ev('done', { mine: true })), 'scoped-out');
  assert.equal(P.scopeDecision(policy({ scope: 'followed', agents: ['ada'] }), ev('done')), null);
});

test('breaker: 5 sent, then 10 quiet minutes with held counts, one digest, then 20, 40, 60, 60', () => {
  const p = policy(), s = P.freshState();
  let now = 1_000_000;
  for (let i = 0; i < 5; i++) assert.equal(P.admit(s, p, { kind: 'done', chat: `c${i % 2}` }, now += 1000).action, 'send');
  const windowEnd = now + 10 * MIN;
  assert.equal(s.quietUntil, windowEnd, 'the window starts at the fifth push');
  assert.equal(P.admit(s, p, { kind: 'done', chat: 'c1' }, now += 1000).action, 'hold');
  assert.equal(P.admit(s, p, { kind: 'approval', chat: 'c2' }, now += 1000).action, 'hold');
  assert.equal(P.admit(s, p, { kind: 'done', chat: 'c1' }, now += 1000).action, 'hold');
  assert.equal(P.tick(s, p, windowEnd - 1), null, 'nothing before the window ends');
  assert.deepEqual(P.tick(s, p, windowEnd), { counts: { updates: 3, chats: 2, needsYou: 1 } });
  assert.equal(P.tick(s, p, windowEnd), null, 'one digest per window');
  assert.equal(s.quietUntil, windowEnd + 20 * MIN, 'the next window doubles and starts with the digest');
  // Each later window: one more held event, one digest, the length doubles up to 60.
  let end = s.quietUntil;
  for (const minutes of [40, 60, 60]) {
    assert.equal(P.admit(s, p, { kind: 'done', chat: 'c9' }, end - 5).action, 'hold');
    assert.deepEqual(P.tick(s, p, end), { counts: { updates: 1, chats: 1, needsYou: 0 } });
    assert.equal(s.quietUntil - end, minutes * MIN);
    end = s.quietUntil;
  }
});

test('breaker: seen resets everything and drops the held events; the count restarts from zero', () => {
  const p = policy({ burst: 2, quietMinutes: 3 }), s = P.freshState();
  P.admit(s, p, { kind: 'done', chat: 'a' }, 0); P.admit(s, p, { kind: 'done', chat: 'a' }, 1);
  assert.equal(P.admit(s, p, { kind: 'done', chat: 'a' }, 2).action, 'hold');
  assert.equal(P.admit(s, p, { kind: 'error', chat: 'b' }, 3).action, 'hold');
  assert.equal(P.seen(s), 2);
  assert.deepEqual(s, P.freshState());
  assert.equal(P.tick(s, p, 10 * MIN), null, 'no digest after seen');
  assert.equal(P.admit(s, p, { kind: 'done', chat: 'a' }, 10 * MIN).action, 'send');
  assert.equal(P.admit(s, p, { kind: 'done', chat: 'a' }, 10 * MIN + 1).action, 'send');
  assert.equal(s.quietUntil, 10 * MIN + 1 + 3 * MIN, 'after seen the first window is the base length again');
});

test('breaker: a window that ends with nothing held closes; the next event goes out and starts a longer window', () => {
  const p = policy({ burst: 3, quietMinutes: 10 }), s = P.freshState();
  for (let i = 0; i < 3; i++) assert.equal(P.admit(s, p, { kind: 'done', chat: 'a' }, 0).action, 'send');
  assert.equal(s.quietUntil, 10 * MIN);
  assert.equal(P.tick(s, p, 10 * MIN), null);
  assert.equal(s.quietUntil, 0);
  const late = 15 * MIN;
  assert.equal(P.admit(s, p, { kind: 'done', chat: 'a' }, late).action, 'send');
  assert.equal(s.quietUntil, late + 20 * MIN, 'still unseen: one push, then the next window, twice as long');
  assert.equal(P.admit(s, p, { kind: 'done', chat: 'a' }, late + 1).action, 'hold');
});

test('breaker: bypass kinds are sent inside a window and never counted; a missed tick is caught up by admit', () => {
  const p = policy({ burst: 1, bypass: ['approval'] }), s = P.freshState();
  assert.equal(P.admit(s, p, { kind: 'approval', chat: 'a' }, 0).action, 'bypass');
  assert.equal(s.sent, 0);
  assert.equal(P.admit(s, p, { kind: 'done', chat: 'a' }, 1).action, 'send');
  assert.equal(P.admit(s, p, { kind: 'approval', chat: 'a' }, 2).action, 'bypass');
  assert.equal(P.admit(s, p, { kind: 'question', chat: 'a' }, 3).action, 'hold', 'question is not in bypass');
  const late = P.admit(s, p, { kind: 'done', chat: 'b' }, 11 * MIN);
  assert.deepEqual(late.digest, { counts: { updates: 1, chats: 1, needsYou: 1 } }, 'the overdue digest comes with the verdict');
  assert.equal(late.action, 'hold', 'and the event falls into the next window');
});

test('breaker: refund undoes a send whose transport failed; restore survives JSON and garbage', () => {
  const p = policy({ burst: 3 }), s = P.freshState();
  P.admit(s, p, { kind: 'done', chat: 'a' }, 0); P.refund(s); P.refund(s);
  assert.equal(s.sent, 0);
  P.admit(s, p, { kind: 'done', chat: 'a' }, 0); P.admit(s, p, { kind: 'done', chat: 'a' }, 0); P.admit(s, p, { kind: 'done', chat: 'a' }, 0);
  P.admit(s, p, { kind: 'question', chat: 'b' }, 1);
  assert.deepEqual(P.restoreState(JSON.parse(JSON.stringify(s))), s);
  assert.deepEqual(P.restoreState('x'), P.freshState());
  assert.deepEqual(P.restoreState({ sent: -1, quietUntil: 'soon', held: { updates: 2.5, chats: ['a', 'a', 7] } }), { ...P.freshState(), held: { updates: 0, needsYou: 0, chats: ['a'], moreChats: 0 } });
  assert.equal(P.isFresh(P.freshState()), true);
  assert.equal(P.isFresh(s), false);
});

test('breaker: distinct chats beyond the remembered limit are still counted', () => {
  const p = policy({ burst: 1 }), s = P.freshState();
  P.admit(s, p, { kind: 'done', chat: 'first' }, 0);
  for (let i = 0; i < 250; i++) P.admit(s, p, { kind: 'done', chat: `chat-${i}` }, 1);
  assert.equal(s.held.chats.length, 200);
  assert.deepEqual(P.tick(s, p, 10 * MIN).counts, { updates: 250, chats: 250, needsYou: 0 });
});

test('property: random streams never exceed the burst inside a window, one digest per window, counts add up', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const random = rng(seed);
    const burst = 1 + Math.floor(random() * 8), quietMinutes = 1 + Math.floor(random() * 15);
    const bypass = random() < 0.3 ? ['approval'] : [];
    const p = policy({ burst, quietMinutes, bypass }), s = P.freshState();
    const base = p.quietMinutes * MIN, cap = p.maxQuietMinutes * MIN;
    let now = 0, sinceSeen = 0, windowsSinceSeen = 0, heldSinceDigest = 0, lastWindow = null;
    let pushes = []; // times of counted pushes and digests (bypass excluded) since the last seen
    // Any interval of one base quiet length without a seen holds at most burst + 1 pushes (digests included).
    const checkSegment = () => {
      for (let i = 0; i < pushes.length; i++) {
        let j = i;
        while (j + 1 < pushes.length && pushes[j + 1] - pushes[i] < base) j++;
        assert.ok(j - i + 1 <= burst + 1, `${j - i + 1} pushes within ${quietMinutes} min (${ctx()})`);
      }
      pushes = [];
    };
    const digestsPerWindow = new Map();
    const ctx = () => `seed ${seed} burst ${burst} quiet ${quietMinutes}`;
    const onDigest = (digest, at, endedWindow) => {
      assert.ok(endedWindow && at >= endedWindow.until, `digest only at the end of a window (${ctx()})`);
      const key = endedWindow.start;
      digestsPerWindow.set(key, (digestsPerWindow.get(key) || 0) + 1);
      assert.equal(digestsPerWindow.get(key), 1, `at most one digest per window (${ctx()})`);
      assert.equal(digest.counts.updates, heldSinceDigest, `digest counts every held event (${ctx()})`);
      heldSinceDigest = 0;
      pushes.push(at);
    };
    for (let step = 0; step < 400; step++) {
      now += Math.floor(random() * random() * 6 * MIN);
      const before = s.quietUntil ? { start: s.quietUntil - s.quietMs, until: s.quietUntil } : lastWindow;
      const roll = random();
      if (roll < 0.04) {
        const dropped = P.seen(s);
        assert.equal(dropped, heldSinceDigest, `seen reports the held count (${ctx()})`);
        heldSinceDigest = 0; sinceSeen = 0; windowsSinceSeen = 0; lastWindow = null;
        checkSegment();
        continue;
      }
      if (roll < 0.25) {
        const digest = P.tick(s, p, now);
        if (digest) onDigest(digest, now, before);
      } else {
        const kind = ['done', 'error', 'approval', 'question', 'reply'][Math.floor(random() * 5)];
        const inWindow = s.quietUntil > now;
        const verdict = P.admit(s, p, { kind, chat: `c${Math.floor(random() * 6)}` }, now);
        if (verdict.digest) onDigest(verdict.digest, now, before);
        if (verdict.action === 'bypass') assert.ok(bypass.includes(kind));
        else if (verdict.action === 'hold') heldSinceDigest++;
        else {
          assert.ok(!inWindow, `no push inside a quiet window (${ctx()})`);
          sinceSeen++;
          pushes.push(now);
          if (windowsSinceSeen === 0) assert.ok(sinceSeen <= burst, `at most burst pushes before the first window (${ctx()})`);
        }
      }
      if (s.quietUntil && (!lastWindow || lastWindow.until !== s.quietUntil)) {
        // A new window: the first after seen has the base length, later ones double up to the cap.
        const expected = windowsSinceSeen === 0 ? Math.min(base, cap) : Math.min((lastWindow.until - lastWindow.start) * 2, cap);
        assert.equal(s.quietMs, expected, `window length (${ctx()})`);
        windowsSinceSeen++;
        lastWindow = { start: s.quietUntil - s.quietMs, until: s.quietUntil };
      }
    }
    checkSegment();
  }
});

test('governor: one device object over the pure functions, with an injected clock', () => {
  let now = 0;
  const g = new P.NotifyGovernor({ policy: { burst: 2, quietMinutes: 1 }, kinds: null, now: () => now });
  assert.deepEqual(g.admit({ kind: 'reply', profile: 'ada', mine: true }), { decision: 'drop', reason: 'kind-off' });
  assert.deepEqual(g.admit({ kind: 'done', profile: 'ada', mine: false }), { decision: 'drop', reason: 'scoped-out' });
  assert.deepEqual(g.admit({ kind: 'done', profile: 'ada', mine: true, merge: true }), { decision: 'merge' });
  assert.equal(g.admit({ kind: 'done', profile: 'ada', mine: true, chat: 'x' }).decision, 'send');
  assert.equal(g.admit({ kind: 'approval', profile: 'ada', chat: 'x' }).decision, 'send');
  assert.equal(g.admit({ kind: 'done', profile: 'ada', mine: true, chat: 'x' }).decision, 'hold');
  assert.equal(g.tick(), null);
  now = MIN;
  assert.deepEqual(g.tick(), { counts: { updates: 1, chats: 1, needsYou: 0 } });
  assert.equal(g.seen(), 0);
  g.configure({ scope: 'all' }, ['reply']);
  assert.equal(g.admit({ kind: 'reply', profile: 'ada', chat: 'x' }).decision, 'send');
  assert.deepEqual(JSON.parse(JSON.stringify(g)), g.state);
});
