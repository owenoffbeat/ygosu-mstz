// test/orchestrator.test.mjs — rankings cache atomicity + graceful fallback (F4)
//
// Verifies the three banner root-cause fixes at the storage layer:
//   1. computeAndCacheRankings writes data/rankings.json atomically (tmp +
//      rename) with no .tmp leftover — a kill can never leave a corrupt cache.
//   2. getRankings returns an EMPTY result (computeRankings shape) instead of
//      throwing when the computation fails AND the cache is unreadable — the
//      dashboard shows empty tables, never a 500 banner.
//   3. getRankings falls back to the last successful cache when only the
//      computation fails.
// Isolation follows the repo pattern: store.configure({dataDir}) with a
// per-file tmp dir under os.tmpdir().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { store } from '../server.mjs';
import { computeAndCacheRankings, getRankings } from '../lib/orchestrator.js';

const DATA_DIR = path.join(os.tmpdir(), `ygosu-test-orchestrator-${process.pid}`);
store.configure({ dataDir: DATA_DIR });

const rankingsPath = () => path.join(DATA_DIR, 'rankings.json');
const tmpPath = () => path.join(DATA_DIR, 'rankings.json.tmp');

test.beforeEach(async () => {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  await fs.mkdir(DATA_DIR, { recursive: true });
});

test.after(async () => {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

// --- normal path ---

test('computeAndCacheRankings writes valid JSON cache, no .tmp leftover', async () => {
  await store.appendEvent({ t: 'article', idx: 1, nick: 'a', ts: '2026-08-16T12:00:00+09:00', recv: 5, badge: 1 });
  await store.appendEvent({ t: 'article', idx: 2, nick: 'b', ts: '2026-08-16T13:00:00+09:00', recv: 3, badge: 1 });

  const result = await computeAndCacheRankings();
  const cached = JSON.parse(await fs.readFile(rankingsPath(), 'utf8'));
  assert.deepEqual(cached, result, 'cache file must equal the returned result');
  assert.equal(cached.errors, 0);
  // daily window is "KST today" — date-dependent; weekly (rolling 7 days)
  // always contains the fixture events regardless of run date
  assert.equal(cached.top.posts.weekly.length, 2);
  assert.ok(cached.generatedAt && cached.periods.daily.start && cached.periods.daily.end);
  await assert.rejects(fs.access(tmpPath()), 'rankings.json.tmp must not remain');
});

// --- corruption + failed read -> empty result, no throw ---

test('getRankings: corrupt cache + unreadable events -> empty result, never throws', async () => {
  // corrupt cache (garbage string) + events.jsonl replaced by a DIRECTORY so
  // fs.readFile fails with EISDIR (compute throws, cache parse returns null)
  await fs.writeFile(rankingsPath(), 'garbage not json', 'utf8');
  await fs.mkdir(path.join(DATA_DIR, 'events.jsonl'));

  const result = await getRankings(); // must not throw
  assert.ok(result, 'getRankings must return a payload');
  assert.equal(result.errors, 0);
  assert.ok(Array.isArray(result.top.posts.daily), 'top.posts.daily must be an array');
  assert.ok(Array.isArray(result.top.posts.weekly));
  assert.ok(Array.isArray(result.top.posts.monthly));
  for (const m of ['comments', 'recv', 'given']) {
    for (const p of ['daily', 'weekly', 'monthly']) {
      assert.ok(Array.isArray(result.top[m][p]), `top.${m}.${p} must be an array`);
    }
  }
  assert.ok(result.periods.daily.start && result.periods.daily.end, 'period bounds present');
  assert.ok(result.periods.weekly.start && result.periods.weekly.end);
  assert.ok(result.periods.monthly.start && result.periods.monthly.end);
  assert.equal(result.metrics.posts, 'posts');
  assert.ok(result.generatedAt, 'generatedAt present');
});

// --- valid cache fallback ---

test('getRankings: unreadable events + valid cache -> returns cached payload', async () => {
  const cache = {
    generatedAt: '2026-08-16T12:00:00+09:00',
    periods: { daily: { start: 's', end: 'e' }, weekly: { start: 's', end: 'e' }, monthly: { start: 's', end: 'e' } },
    metrics: { posts: 'posts', comments: 'comments', recv: 'recv', given: 'given' },
    top: { posts: { daily: [{ rank: 1, nick: 'cached-user', count: 42 }], weekly: [], monthly: [] }, comments: { daily: [], weekly: [], monthly: [] }, recv: { daily: [], weekly: [], monthly: [] }, given: { daily: [], weekly: [], monthly: [] } },
    errors: 0,
  };
  await fs.writeFile(rankingsPath(), JSON.stringify(cache), 'utf8');
  await fs.mkdir(path.join(DATA_DIR, 'events.jsonl')); // force compute failure

  const result = await getRankings();
  assert.deepEqual(result, cache, 'must serve the last successful cache');
});
