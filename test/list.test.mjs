// test/list.test.mjs — T3 list parser + crawler tests
// Fixture-driven parsing (test/fixtures/list_page0.html) + fake-HTML crawl rules.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPool, store } from '../server.mjs';
import { parseListPage, parseRecv, crawlList } from '../lib/list.js';
import { kstDate, kstTimestamp, todayStartKst, parseListTime } from '../lib/kst.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/list_page0.html', import.meta.url));
// Isolated per-file data dir: parallel `node --test` runs share the filesystem,
// so each file gets its own tmp dir (store.configure overrides the ./data/ default).
const DATA_DIR = path.join(os.tmpdir(), `ygosu-test-list-${process.pid}`);
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
store.configure({ dataDir: DATA_DIR });

// Fixed "now" so HH:MM times resolve to 2026-08-16 KST (fixture capture day).
const NOW = new Date('2026-08-16T03:00:00Z'); // 2026-08-16 12:00 KST

async function resetData() {
  await fs.rm(DATA_DIR, { recursive: true, force: true });
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

// Build a minimal list page with the same li structure as the fixture.
function fakePage(articles, { pageQuery = false } = {}) {
  const lis = articles.map((a) => {
    const badge = a.badge > 0 ? `<span class='badge mr2'>${a.badge}</span>` : '';
    const q = pageQuery ? `/?page=${a.page ?? 2}` : '';
    return `<li class=''><a href='/board/pan_monstarz/${a.idx}${q}'><span class='subject_wrap'><div class='subject mr2'>제목</div> ${badge}  </span><p> ${a.nick} <span>|</span> ${a.time} <span>|</span> 조회 : <strong class='' style='font-weight: normal;'>10</strong> <span>|</span> 추천 : ${a.recv}</p></a></li>`;
  });
  return `<html><body><ul class="li2">${lis.join('')}</ul></body></html>`;
}

// --- Parser: fixture ---

test('parses fixture: nick/time/recv/badge for all 20 regular rows', async () => {
  const html = await fs.readFile(FIXTURE, 'utf8');
  const articles = parseListPage(html, { now: NOW });
  assert.equal(articles.length, 20, '12 notice + 1 ad + 1 banner skipped');
  const first = articles[0];
  assert.equal(first.idx, 1843678);
  assert.equal(first.nick, '뚱땡이싫어');
  assert.equal(first.ts, '2026-08-16T11:38:00+09:00');
  assert.equal(first.recv, 3);
  assert.equal(first.badge, 3);
  const noBadge = articles.find((a) => a.idx === 1843666);
  assert.equal(noBadge.nick, '세트카전단지');
  assert.equal(noBadge.badge, 0, 'no badge span -> 0');
  assert.equal(noBadge.recv, 0, "recv '-' -> 0");
  const plusRecv = articles.find((a) => a.idx === 1843667);
  assert.equal(plusRecv.recv, 3, "recv '+3' -> 3");
  assert.equal(plusRecv.nick, 'Monstarz');
});

test('skips notice and ad li in fixture', async () => {
  const html = await fs.readFile(FIXTURE, 'utf8');
  const articles = parseListPage(html, { now: NOW });
  const idxs = new Set(articles.map((a) => a.idx));
  for (const noticeIdx of [1842639, 1842713, 1839448, 1644777]) {
    assert.ok(!idxs.has(noticeIdx), `notice idx ${noticeIdx} must be skipped`);
  }
  assert.ok(!idxs.has(1453), 'ad idx must be skipped');
  assert.ok(!articles.some((a) => a.idx === 1843678 && a.nick === ''), 'no empty rows');
});

// --- Parser: time formats ---

test('parses YY.MM.DD and YY.MM.DD HH:MM time formats', () => {
  const html = fakePage([
    { idx: 1, nick: 'a', time: '26.08.15', recv: '-', badge: 0 },
    { idx: 2, nick: 'b', time: '26.08.14 23:59', recv: '+1', badge: 2 },
  ]);
  const articles = parseListPage(html, { now: NOW });
  assert.equal(articles[0].ts, '2026-08-15T00:00:00+09:00', 'YY.MM.DD -> that day 00:00 KST');
  assert.equal(articles[1].ts, '2026-08-14T23:59:00+09:00', 'YY.MM.DD HH:MM -> that day at time');
});

test('accepts article links with ?page=N query (live page 2+ structure)', () => {
  const html = fakePage(
    [
      { idx: 100, nick: 'a', time: '11:00', recv: '+1', badge: 1, page: 2 },
      { idx: 99, nick: 'b', time: '11:00', recv: '-', badge: 0, page: 2 },
    ],
    { pageQuery: true },
  );
  const articles = parseListPage(html, { now: NOW });
  assert.equal(articles.length, 2, '?page=N article links must not be skipped');
  assert.equal(articles[0].idx, 100);
  assert.equal(articles[1].idx, 99);
});

test('parseRecv: - -> 0, +N -> N, -N -> negative, N -> N', () => {
  assert.equal(parseRecv('-'), 0);
  assert.equal(parseRecv('+3'), 3);
  assert.equal(parseRecv('-2'), -2);
  assert.equal(parseRecv('5'), 5);
});

// --- kst helpers ---

test('kst helpers: kstDate/kstTimestamp/todayStartKst/parseListTime', () => {
  const d = new Date('2026-08-15T15:30:00Z'); // 2026-08-16 00:30 KST
  assert.equal(kstDate(d), '2026-08-16');
  assert.equal(kstTimestamp(d), '2026-08-16T00:30:00+09:00');
  const start = todayStartKst(new Date('2026-08-15T15:30:00Z'));
  assert.equal(start.toISOString(), '2026-08-15T15:00:00.000Z', 'KST midnight = 15:00Z prev day');
  assert.equal(parseListTime('11:38', NOW).toISOString(), '2026-08-16T02:38:00.000Z');
  assert.equal(parseListTime('26.08.10', NOW).toISOString(), '2026-08-09T15:00:00.000Z');
  assert.equal(parseListTime('garbage', NOW), null);
});

// --- Crawler: boundary rule ---

test('crawlList stops at boundary (article older than windowStart)', async () => {
  await resetData();
  const pages = [
    fakePage([{ idx: 100, nick: 'a', time: '11:00', recv: '+1', badge: 1 }]),
    fakePage([{ idx: 99, nick: 'b', time: '26.08.10', recv: '-', badge: 0 }]),
    fakePage([{ idx: 98, nick: 'c', time: '11:00', recv: '-', badge: 0 }]),
  ];
  let call = 0;
  fetchPool.configure({
    fetchImpl: async () => fakeResponse(200, pages[call++]),
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });
  const warns = [];
  const windowStart = new Date('2026-08-15T15:00:00Z'); // 2026-08-16 00:00 KST
  const result = await crawlList({ windowStart, onWarn: (w) => warns.push(w), maxPages: 10 });
  assert.equal(result.total, 2, 'both boundary-page articles collected');
  assert.equal(result.pages, 2);
  assert.equal(call, 2, 'page 3 not fetched after boundary');
  assert.ok(warns.some((w) => w.includes('boundary')));
  const lines = (await fs.readFile(EVENTS_FILE, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  const ev = JSON.parse(lines[0]);
  assert.deepEqual(
    { t: ev.t, idx: ev.idx, nick: ev.nick, recv: ev.recv, badge: ev.badge, page: ev.page },
    { t: 'article', idx: 100, nick: 'a', recv: 1, badge: 1, page: 1 },
  );
  assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+09:00$/);
});

// --- Crawler: delta rule ---

test('crawlList stops at delta (all idx already scanned)', async () => {
  await resetData();
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify({ scanned: [100, 99] }));
  const pages = [
    fakePage([{ idx: 100, nick: 'a', time: '11:00', recv: '+1', badge: 1 }]),
    fakePage([{ idx: 98, nick: 'c', time: '11:00', recv: '-', badge: 0 }]),
  ];
  let call = 0;
  fetchPool.configure({
    fetchImpl: async () => fakeResponse(200, pages[call++]),
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });
  const warns = [];
  const result = await crawlList({ windowStart: null, onWarn: (w) => warns.push(w), maxPages: 10 });
  assert.equal(result.total, 0, 'nothing new to append');
  assert.equal(result.pages, 1);
  assert.equal(call, 1, 'page 2 not fetched after delta');
  assert.ok(warns.some((w) => w.includes('delta')));
  await assert.rejects(fs.readFile(EVENTS_FILE, 'utf8'), { code: 'ENOENT' }, 'no events appended');
});

// --- Crawler: empty pages ---

test('crawlList stops after 3 consecutive empty pages', async () => {
  await resetData();
  fetchPool.configure({
    fetchImpl: async () => fakeResponse(200, '<html><body><ul class="li2"></ul></body></html>'),
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });
  const warns = [];
  const result = await crawlList({ windowStart: null, onWarn: (w) => warns.push(w), maxPages: 10 });
  assert.equal(result.total, 0);
  assert.equal(result.pages, 3);
  assert.ok(warns.some((w) => w.includes('3 consecutive empty')));
});

// --- Crawler: max pages ---

test('crawlList stops at YGOSU_MAX_PAGES with warning', async () => {
  await resetData();
  const pages = [
    fakePage([{ idx: 100, nick: 'a', time: '11:00', recv: '-', badge: 0 }]),
    fakePage([{ idx: 99, nick: 'b', time: '11:00', recv: '-', badge: 0 }]),
  ];
  let call = 0;
  fetchPool.configure({
    fetchImpl: async () => fakeResponse(200, pages[call++]),
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });
  const warns = [];
  const result = await crawlList({ windowStart: null, onWarn: (w) => warns.push(w), maxPages: 2 });
  assert.equal(result.total, 2);
  assert.equal(result.pages, 2);
  assert.ok(warns.some((w) => w.includes('YGOSU_MAX_PAGES')));
});

// --- Crawler: queues ---

test('crawlList queues badge>=1 to fetch and recv>0 to vote', async () => {
  await resetData();
  const pages = [
    fakePage([
      { idx: 100, nick: 'a', time: '11:00', recv: '+1', badge: 1 },
      { idx: 99, nick: 'b', time: '11:00', recv: '-', badge: 0 },
      { idx: 98, nick: 'c', time: '11:00', recv: '+5', badge: 0 },
    ]),
  ];
  fetchPool.configure({
    fetchImpl: async () => fakeResponse(200, pages[0]),
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });
  const result = await crawlList({ windowStart: null, maxPages: 1 });
  assert.deepEqual(result.fetchQueue, [100], 'badge>=1 -> fetch queue');
  assert.deepEqual(result.voteQueue, [100, 98], 'recv>0 -> vote queue');
});
