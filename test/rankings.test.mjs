// test/rankings.test.mjs — T6 pure rankings computation tests
// computeRankings is a pure function (no store/fs), so no tmp-dir isolation
// is needed here. All timestamps are KST ISO8601 (+09:00) or KST calendar
// days ('YYYY-MM-DD' — comment day-granularity from T4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRankings } from '../lib/rankings.js';

const NOW = '2026-08-16T12:00:00+09:00';

const article = (idx, nick, ts, recv = 0) => ({ t: 'article', idx, nick, ts, recv, badge: 0 });
const comment = (idx, cid, rno, nick, ts, recv = 0, anon = false) => ({
  t: 'comment',
  idx,
  cid,
  rno,
  nick,
  ts,
  recv,
  ...(anon ? { anon: true } : {}),
});
const user = (rno, nick, idx, ts) => ({ t: 'user', rno, nick, idx, ts });
const vote = (idx, rno, nick, ts) => ({ t: 'vote', idx, rno, nick, ts });

const topOf = (res, metric, period) => res.top[metric][period];

// --- Empty / small inputs ---

test('empty events -> empty tops, no crash', () => {
  const res = computeRankings([], { nowKST: NOW });
  assert.equal(res.errors, 0);
  for (const metric of ['posts', 'comments', 'recv', 'given']) {
    for (const period of ['daily', 'weekly', 'monthly']) {
      assert.deepEqual(res.top[metric][period], []);
    }
  }
  assert.equal(res.generatedAt, NOW);
});

test('fewer than 10 entries OK', () => {
  const events = [article(1, 'a', NOW), article(2, 'b', NOW), article(3, 'c', NOW)];
  const res = computeRankings(events, { nowKST: NOW });
  assert.equal(topOf(res, 'posts', 'daily').length, 3);
});

test('non-array events treated as empty', () => {
  const res = computeRankings(null, { nowKST: NOW });
  assert.equal(res.errors, 0);
  assert.deepEqual(res.top.posts.daily, []);
});

test('invalid nowKST throws TypeError', () => {
  assert.throws(() => computeRankings([], { nowKST: 'garbage' }), TypeError);
});

// --- Sorting ---

test('tie -> key ascending, rank 1-based', () => {
  const events = [
    article(1, 'bbb', NOW),
    article(2, 'bbb', NOW),
    article(3, 'aaa', NOW),
    article(4, 'aaa', NOW),
    article(5, 'ccc', NOW),
    article(6, 'ccc', NOW),
  ];
  const res = computeRankings(events, { nowKST: NOW });
  const daily = topOf(res, 'posts', 'daily');
  assert.deepEqual(daily.map((e) => e.nick), ['aaa', 'bbb', 'ccc']);
  assert.deepEqual(daily.map((e) => e.rank), [1, 2, 3]);
  assert.ok(daily.every((e) => e.count === 2));
});

// --- Anonymous exclusion ---

test('anonymous comments excluded from comments and recv', () => {
  const events = [
    article(1, 'alice', NOW, 5),
    comment(1, 11, 0, '익명1', NOW, 9, true), // anon — excluded from rankings
    comment(1, 12, 7, 'bob', NOW, 3),
  ];
  const res = computeRankings(events, { nowKST: NOW });
  assert.deepEqual(topOf(res, 'recv', 'daily'), [
    { rank: 1, nick: 'alice', count: 5 },
    { rank: 2, nick: 'bob', count: 3 },
  ]);
  assert.deepEqual(topOf(res, 'comments', 'daily'), [{ rank: 1, nick: 'bob', count: 1 }]);
});

// --- Identity merging ---

test('nickname change (same rno, different nicks) merges into one user', () => {
  const events = [
    user(5, 'oldnick', 1, '2026-08-16T10:00:00+09:00'),
    user(5, 'newnick', 2, '2026-08-16T11:00:00+09:00'),
    article(1, 'oldnick', '2026-08-16T10:30:00+09:00'),
    comment(1, 21, 5, 'newnick', '2026-08-16', 2),
  ];
  const res = computeRankings(events, { nowKST: NOW });
  assert.deepEqual(topOf(res, 'posts', 'daily'), [{ rank: 1, nick: 'newnick', count: 1 }]);
  assert.deepEqual(topOf(res, 'comments', 'daily'), [{ rank: 1, nick: 'newnick', count: 1 }]);
  assert.deepEqual(topOf(res, 'recv', 'daily'), [{ rank: 1, nick: 'newnick', count: 2 }]);
});

test('nick->rno map: article + comment with same nick merge under u:rno', () => {
  const events = [
    article(1, 'foo', NOW, 1),
    user(5, 'foo', 1, NOW),
    comment(1, 31, 5, 'foo', '2026-08-16', 4),
  ];
  const res = computeRankings(events, { nowKST: NOW });
  assert.deepEqual(topOf(res, 'posts', 'daily'), [{ rank: 1, nick: 'foo', count: 1 }]);
  assert.deepEqual(topOf(res, 'comments', 'daily'), [{ rank: 1, nick: 'foo', count: 1 }]);
  assert.deepEqual(topOf(res, 'recv', 'daily'), [{ rank: 1, nick: 'foo', count: 5 }]);
});

test('nick spanning multiple rnos stays n:<nick>', () => {
  const events = [
    user(5, 'foo', 1, NOW),
    user(7, 'foo', 2, NOW),
    article(1, 'foo', NOW),
    comment(1, 41, 5, 'foo', '2026-08-16'),
  ];
  const res = computeRankings(events, { nowKST: NOW });
  assert.deepEqual(topOf(res, 'posts', 'daily'), [{ rank: 1, nick: 'foo', count: 1 }]);
  assert.deepEqual(topOf(res, 'comments', 'daily'), [{ rank: 1, nick: 'foo', count: 1 }]);
});

test('latest nick tie-break: same ts -> later input wins', () => {
  const events = [
    comment(1, 81, 5, 'old', '2026-08-16', 1),
    comment(2, 82, 5, 'new', '2026-08-16', 1),
  ];
  const res = computeRankings(events, { nowKST: NOW });
  assert.deepEqual(topOf(res, 'comments', 'daily'), [{ rank: 1, nick: 'new', count: 2 }]);
});

test('user events contribute no metric counts', () => {
  const events = [user(5, 'foo', 1, NOW)];
  const res = computeRankings(events, { nowKST: NOW });
  for (const metric of ['posts', 'comments', 'recv', 'given']) {
    assert.deepEqual(res.top[metric].daily, []);
  }
});

// --- Period boundaries (rolling windows, KST) ---

test('daily boundary: yesterday 23:59 excluded, today 00:00 included', () => {
  const events = [
    article(1, 'yesterday', '2026-08-15T23:59:00+09:00'),
    article(2, 'today', '2026-08-16T00:00:00+09:00'),
  ];
  const res = computeRankings(events, { nowKST: NOW });
  assert.deepEqual(topOf(res, 'posts', 'daily'), [{ rank: 1, nick: 'today', count: 1 }]);
  assert.deepEqual(topOf(res, 'posts', 'weekly'), [
    { rank: 1, nick: 'today', count: 1 },
    { rank: 2, nick: 'yesterday', count: 1 },
  ]);
});

test('weekly boundary: 6d ago in, 7d exact in, 7d+1s out', () => {
  const events = [
    article(1, 'six', '2026-08-10T12:00:00+09:00'),
    article(2, 'seven', '2026-08-09T12:00:00+09:00'),
    article(3, 'sevenplus', '2026-08-09T11:59:59+09:00'),
  ];
  const res = computeRankings(events, { nowKST: NOW });
  assert.deepEqual(topOf(res, 'posts', 'weekly').map((e) => e.nick).sort(), ['seven', 'six']);
  assert.deepEqual(topOf(res, 'posts', 'monthly').map((e) => e.nick).sort(), ['seven', 'sevenplus', 'six']);
});

test('monthly boundary: 29d in, 30d exact in, 30d+1s out', () => {
  const events = [
    article(1, 'twentynine', '2026-07-18T12:00:00+09:00'),
    article(2, 'thirty', '2026-07-17T12:00:00+09:00'),
    article(3, 'thirtyplus', '2026-07-17T11:59:59+09:00'),
  ];
  const res = computeRankings(events, { nowKST: NOW });
  assert.deepEqual(topOf(res, 'posts', 'monthly').map((e) => e.nick).sort(), ['thirty', 'twentynine']);
});

test('comment KST day ts counts in daily (parsed as KST midnight)', () => {
  const events = [
    comment(1, 51, 5, 'bob', '2026-08-16', 1), // today
    comment(2, 52, 6, 'carol', '2026-08-15', 1), // yesterday
  ];
  const res = computeRankings(events, { nowKST: NOW });
  assert.deepEqual(topOf(res, 'comments', 'daily'), [{ rank: 1, nick: 'bob', count: 1 }]);
  assert.equal(topOf(res, 'comments', 'weekly').length, 2);
});

test('periods expose KST window boundaries', () => {
  const res = computeRankings([], { nowKST: NOW });
  assert.deepEqual(res.periods.daily, { start: '2026-08-16T00:00:00+09:00', end: NOW });
  assert.deepEqual(res.periods.weekly, { start: '2026-08-09T12:00:00+09:00', end: NOW });
  assert.deepEqual(res.periods.monthly, { start: '2026-07-17T12:00:00+09:00', end: NOW });
});

// --- Metrics ---

test('recv = article.recv + comment.recv (anon excluded)', () => {
  const events = [
    article(1, 'alice', NOW, 5),
    comment(1, 71, 7, 'bob', '2026-08-16', 3),
    comment(1, 72, 0, 'anon', '2026-08-16', 9, true),
  ];
  const res = computeRankings(events, { nowKST: NOW });
  assert.deepEqual(topOf(res, 'recv', 'daily'), [
    { rank: 1, nick: 'alice', count: 5 },
    { rank: 2, nick: 'bob', count: 3 },
  ]);
});

test('missing recv defaults to 0 (no crash, not ranked)', () => {
  const events = [article(1, 'alice', NOW)];
  const res = computeRankings(events, { nowKST: NOW });
  assert.deepEqual(topOf(res, 'recv', 'daily'), []);
  assert.deepEqual(topOf(res, 'posts', 'daily'), [{ rank: 1, nick: 'alice', count: 1 }]);
});

test('given = vote events by ts', () => {
  const events = [
    vote(1, 9, 'voter', '2026-08-16T11:00:00+09:00'),
    vote(2, 9, 'voter', '2026-08-10T12:00:00+09:00'),
    vote(3, 10, 'other', '2026-08-15T23:59:00+09:00'),
  ];
  const res = computeRankings(events, { nowKST: NOW });
  assert.deepEqual(topOf(res, 'given', 'daily'), [{ rank: 1, nick: 'voter', count: 1 }]);
  assert.deepEqual(topOf(res, 'given', 'weekly'), [
    { rank: 1, nick: 'voter', count: 2 },
    { rank: 2, nick: 'other', count: 1 },
  ]);
});

test('string rno (T5 vote events) accepted and merged via nick map', () => {
  const events = [
    user(5, 'foo', 1, NOW),
    article(1, 'foo', NOW, 1),
    vote(1, '5', 'foo', '2026-08-16T11:00:00+09:00'), // rno as string (real T5 output)
  ];
  const res = computeRankings(events, { nowKST: NOW });
  assert.equal(res.errors, 0);
  assert.deepEqual(topOf(res, 'given', 'daily'), [{ rank: 1, nick: 'foo', count: 1 }]);
  assert.deepEqual(topOf(res, 'posts', 'daily'), [{ rank: 1, nick: 'foo', count: 1 }]);
});

test('givenAvailable=false -> given {unavailable:true}', () => {
  const events = [vote(1, 9, 'voter', NOW)];
  const res = computeRankings(events, { nowKST: NOW, givenAvailable: false });
  assert.deepEqual(res.top.given, { unavailable: true });
  assert.deepEqual(res.metrics.given, { unavailable: true });
  assert.equal(res.top.posts.daily.length, 0);
});

// --- TOP 10 cap ---

test('TOP 10 cap: 12 users -> 10 entries, ranks 1..10', () => {
  const events = [];
  for (let i = 1; i <= 12; i += 1) events.push(article(i, `user${String(i).padStart(2, '0')}`, NOW));
  const res = computeRankings(events, { nowKST: NOW });
  const daily = topOf(res, 'posts', 'daily');
  assert.equal(daily.length, 10);
  assert.deepEqual(daily.map((e) => e.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(daily.every((e) => e.count === 1));
});

// --- Corrupt events ---

test('corrupt events skipped, counted in errors, no crash', () => {
  const events = [
    article(1, 'ok', NOW, 1),
    { t: 'article', idx: 2, nick: 'no-ts' }, // missing ts
    { t: 'article', idx: 3, nick: 'bad-ts', ts: 'not-a-date' }, // unparseable ts
    { t: 'article', idx: 4, nick: 'wrong-offset', ts: '2026-08-16T12:00:00+00:00' }, // non-KST offset
    { t: 'comment', idx: 1, nick: 'no-cid', ts: NOW }, // missing cid
    { t: 'user', nick: 'no-rno', ts: NOW }, // missing rno
    { t: 'vote', idx: 1, nick: 'no-rno', ts: NOW }, // missing rno
    { t: 'bogus', nick: 'x', ts: NOW }, // unknown type
    null,
    'string',
    42,
    { t: 'article', idx: 5, nick: 'ok2', ts: NOW }, // valid
  ];
  const res = computeRankings(events, { nowKST: NOW });
  assert.equal(res.errors, 10);
  assert.equal(topOf(res, 'posts', 'daily').length, 2);
});

// --- Determinism ---

test('deterministic: same input twice -> identical result', () => {
  const events = [
    article(1, 'foo', NOW, 3),
    user(5, 'foo', 1, NOW),
    comment(1, 61, 5, 'foo', '2026-08-16', 2),
    comment(2, 62, 0, 'anon', '2026-08-16', 5, true),
    vote(1, 9, 'voter', '2026-08-16T11:00:00+09:00'),
    article(2, 'bar', '2026-08-10T12:00:00+09:00', 1),
    { t: 'bogus', nick: 'x', ts: NOW },
  ];
  const a = computeRankings(events, { nowKST: NOW });
  const b = computeRankings(events, { nowKST: NOW });
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});