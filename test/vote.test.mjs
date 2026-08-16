// test/vote.test.mjs — T5 vote-list parser + fetcher tests
// Fixture-driven: test/fixtures/vote_list_1732853.json (real get_vote_list response,
// 30 rows: 26 with rno + 4 anonymous 탈퇴한회원 rows). Derived responses below are
// built only from real fixture fragments (repeated html / time-stripped rows).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPool } from '../server.mjs';
import { parseVoteList, parseVoteTime, fetchVotes } from '../lib/vote.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/vote_list_1732853.json', import.meta.url));
const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

async function resetData() {
  await fs.rm(EVENTS_FILE, { force: true });
  await fs.rm(STATE_FILE, { force: true });
}

after(() => resetData());

function fakeResponse(status, body = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body);
    },
  };
}

async function loadFixture() {
  return JSON.parse(await fs.readFile(FIXTURE, 'utf8'));
}

async function readEvents() {
  try {
    const text = await fs.readFile(EVENTS_FILE, 'utf8');
    return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// --- Parser: fixture ---

test('parseVoteList fixture: 30 rows -> 26 voters (4 anonymous excluded)', async () => {
  const voters = parseVoteList(await loadFixture());
  assert.equal(voters.length, 26, 'rows 4/6/7/16 (탈퇴한회원, no rno) excluded');
  assert.deepEqual(voters[0], { rno: '701306', nick: '암애', ts: '2026-07-17T22:59:49+09:00' });
  assert.deepEqual(voters[1], { rno: '701265', nick: '폭탄공장막긴혀따', ts: '2026-07-17T22:59:57+09:00' });
  assert.deepEqual(
    voters[20],
    { rno: '701599', nick: 'cbhdjshg', ts: '2026-07-18T00:03:38+09:00' },
    'cross-day vote time (26-07-18 00:03:38)',
  );
  assert.deepEqual(voters[25], { rno: '471072', nick: '종국장', ts: '2026-07-18T22:42:29+09:00' });
  for (const v of voters) {
    assert.match(v.rno, /^\d+$/);
    assert.ok(v.nick.length > 0, 'nick non-empty');
    assert.match(v.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
  }
});

test('parseVoteList: non-SUCCESS / malformed -> []', () => {
  assert.deepEqual(parseVoteList({ msg: 'NEED_LOGIN', html: '' }), []);
  assert.deepEqual(parseVoteList(null), []);
  assert.deepEqual(parseVoteList({ msg: 'SUCCESS' }), []);
});

// --- parseVoteTime ---

test('parseVoteTime: YY-MM-DD HH:MM:SS -> KST ISO8601 (2-digit year -> 2000+)', () => {
  assert.equal(parseVoteTime('26-07-17 22:59:49'), '2026-07-17T22:59:49+09:00');
  assert.equal(parseVoteTime('99-12-31 23:59:59'), '2099-12-31T23:59:59+09:00');
  assert.equal(parseVoteTime('26-07-17'), null, 'missing time part');
  assert.equal(parseVoteTime('garbage'), null);
  assert.equal(parseVoteTime(''), null);
});

// --- Fetcher: fixture-driven ---

test('fetchVotes: appends 26 vote events, (idx,rno) unique, resume skips', async () => {
  await resetData();
  const fixture = await loadFixture();
  let calls = 0;
  fetchPool.configure({
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse(200, JSON.stringify(fixture));
    },
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });

  const res = await fetchVotes({ idx: 1732853, articleTs: '2026-07-17T23:00:00+09:00' });
  assert.equal(res.skipped, false);
  assert.equal(res.events, 26);
  assert.equal(res.voters.length, 26);

  const events = await readEvents();
  assert.equal(events.length, 26);
  for (const ev of events) {
    assert.equal(ev.t, 'vote');
    assert.equal(ev.idx, 1732853);
    assert.match(ev.rno, /^\d+$/);
    assert.ok(ev.nick.length > 0);
    assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
  }
  assert.equal(events[0].ts, '2026-07-17T22:59:49+09:00', 'vote time used, not article ts');
  const keys = new Set(events.map((e) => `${e.idx}:${e.rno}`));
  assert.equal(keys.size, 26, '(idx,rno) unique');

  // Resume: same idx -> skipped, no new events, no fetch call
  const res2 = await fetchVotes({ idx: 1732853 });
  assert.equal(res2.skipped, true);
  assert.equal(res2.events, 0);
  assert.equal(calls, 1, 'no second fetch on resume');
  assert.equal((await readEvents()).length, 26);
});

test('fetchVotes: skip mode when state.votes[idx] pre-seeded', async () => {
  await resetData();
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify({ votes: { 1732853: ['701306'] } }));
  let calls = 0;
  fetchPool.configure({
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse(200, '{}');
    },
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });
  const res = await fetchVotes({ idx: 1732853 });
  assert.equal(res.skipped, true);
  assert.equal(calls, 0, 'no fetch when already processed');
  assert.equal((await readEvents()).length, 0);
});

test('fetchVotes: duplicate rno within response deduped (fixture html repeated)', async () => {
  await resetData();
  const fixture = await loadFixture();
  const dup = { msg: 'SUCCESS', html: fixture.html + fixture.html }; // same 26 voters twice
  fetchPool.configure({
    fetchImpl: async () => fakeResponse(200, JSON.stringify(dup)),
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });
  const res = await fetchVotes({ idx: 1732853 });
  assert.equal(res.events, 26, 'duplicate rows collapse to unique (idx,rno)');
  assert.equal((await readEvents()).length, 26);
});

test('fetchVotes: msg != SUCCESS -> retry once, then skip with warning', async () => {
  await resetData();
  let calls = 0;
  fetchPool.configure({
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse(200, JSON.stringify({ msg: 'NEED_LOGIN', html: '' }));
    },
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });
  const warns = [];
  const res = await fetchVotes({ idx: 1732853, onWarn: (w) => warns.push(w) });
  assert.equal(res.skipped, true);
  assert.equal(res.events, 0);
  assert.equal(calls, 2, 'one retry after non-SUCCESS');
  assert.equal(warns.length, 2);
  assert.match(warns[0], /retrying once/);
  assert.match(warns[1], /skipping article/);
  assert.equal((await readEvents()).length, 0);
});

test('fetchVotes: missing vote time -> fallback to article ts (param, then events.jsonl)', async () => {
  await resetData();
  const fixture = await loadFixture();
  // Strip vote times -> empty <td><span></span></td> (same fragment as fixture 3rd td)
  const noTime = {
    msg: 'SUCCESS',
    html: fixture.html.replace(
      /<td><span>\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}<\/span><\/td>/g,
      '<td><span></span></td>',
    ),
  };
  fetchPool.configure({
    fetchImpl: async () => fakeResponse(200, JSON.stringify(noTime)),
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });

  // Variant A: explicit articleTs param
  const resA = await fetchVotes({ idx: 1732853, articleTs: '2026-07-17T23:00:00+09:00' });
  assert.equal(resA.events, 26);
  let votes = (await readEvents()).filter((e) => e.t === 'vote');
  assert.ok(votes.every((e) => e.ts === '2026-07-17T23:00:00+09:00'), 'fallback to articleTs param');

  // Variant B: no param -> looked up from events.jsonl article event
  await resetData();
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(
    EVENTS_FILE,
    `${JSON.stringify({ t: 'article', idx: 1732853, ts: '2026-07-17T22:00:00+09:00' })}\n`,
  );
  const resB = await fetchVotes({ idx: 1732853 });
  assert.equal(resB.events, 26);
  votes = (await readEvents()).filter((e) => e.t === 'vote');
  assert.ok(votes.every((e) => e.ts === '2026-07-17T22:00:00+09:00'), 'fallback from events.jsonl article event');
});