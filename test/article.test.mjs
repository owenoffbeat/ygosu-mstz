// test/article.test.mjs — T4 article/comment parser + fetcher tests
// Fixture-driven parsing (article_1732853.html, reply_ajax.json) + fake-fetch
// crawler tests (pagination loop, resume skip, anon flag, error path).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchPool, store } from '../server.mjs';
import { parseArticlePage, parseComments, crawlArticles } from '../lib/article.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/article_1732853.html', import.meta.url));
const AJAX_FIXTURE = fileURLToPath(new URL('./fixtures/reply_ajax.json', import.meta.url));
// Isolated per-file data dir: parallel `node --test` runs share the filesystem,
// so each file gets its own tmp dir (store.configure overrides the ./data/ default).
const DATA_DIR = path.join(os.tmpdir(), `ygosu-test-article-${process.pid}`);
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
store.configure({ dataDir: DATA_DIR });

// Fixed reference: 2026-08-16 21:00 KST (fixture capture day).
const NOW = new Date('2026-08-16T12:00:00Z');

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

// Minimal article page with the same structure as the fixture.
function fakeArticleHtml(comments, { replyInfo = 'ZmFrZXJlcGx5aW5mbw==' } = {}) {
  const lis = comments
    .map((c) => {
      const dropdown =
        c.rno > 0
          ? `<a href="javascript:;" onclick="YG_COMMON.show_nick_dropdown(this, '0', '${c.rno}', 'Y', 'N')">${c.nick}</a>`
          : '';
      return `<li class=""><div class='desc' id='reply_body_pan_monstarz_${c.cid}'><p>${dropdown}<span class='wtime'>1일 전 <i>|</i></span></p><div class='det'>x</div><div class='buttons'><span id='board_pan_monstarz_reply_${c.cid}_good'>${c.recv}</span></div></div></li>`;
    })
    .join('');
  return `<html><body>
<h4 class="article_title">테스트 <em>[3]</em></h4>
<p><a href="javascript:;" onclick="YG_COMMON.show_nick_dropdown(this, '0', '999', 'Y', 'N')">작성자</a><span>|</span> 26-08-15 10:00:00 <span>|</span> 조회 : 1 <span>|</span> 추천 : +1</p>
<script>var reply_info_str='${replyInfo}'</script>
<ul id = 'best_reply_list_layer' class="comment"></ul>
<ul id = 'reply_list_layer' class="comment">${lis}</ul>
</body></html>`;
}

// --- Parser: article fixture ---

test('parses fixture: author rno, nick, reply_info, title count, article ts', async () => {
  const html = await fs.readFile(FIXTURE, 'utf8');
  const p = parseArticlePage(html, { now: NOW });
  assert.equal(p.authorRno, 678199, 'first dropdown 3rd arg = author rno');
  assert.equal(p.authorNick, '408주종발효');
  assert.match(p.replyInfo, /^[A-Za-z0-9+/=]+$/);
  assert.equal(p.replyInfo.length, 412, '412-char base64 PHP-serialized reply_info');
  assert.equal(p.titleCnt, 18, 'article_title <em>[18]</em>');
  assert.equal(p.articleTs, '2026-07-17T22:59:26+09:00', 'title_info YY-MM-DD HH:MM:SS -> KST ISO8601');
});

test('parses fixture comments: 18 unique cids, best-list dedupe', async () => {
  const html = await fs.readFile(FIXTURE, 'utf8');
  const p = parseArticlePage(html, { now: NOW });
  assert.equal(p.comments.length, 18, '19 raw li matches -> 18 unique (3656453 in best + reply lists)');
  assert.equal(new Set(p.comments.map((c) => c.cid)).size, 18, 'no duplicate cids');

  const best = p.comments.find((c) => c.cid === 3656453);
  assert.equal(best.rno, 678199);
  assert.equal(best.nick, '408주종발효');
  assert.equal(best.recv, 9, 'board_pan_monstarz_reply_3656453_good = 9');
  assert.equal(best.ts, '2026-07-17', '30일 전 from NOW');

  const anon = p.comments.find((c) => c.cid === 3656442);
  assert.equal(anon.rno, 701306);
  assert.equal(anon.nick, '암애');
  assert.equal(anon.recv, 0);

  const reply = p.comments.find((c) => c.cid === 3656459);
  assert.equal(reply.nick, '퀸주', 'reply @parent prefix lives in body; anchor text is the author nick');
  assert.equal(reply.rno, 703128);

  const recv2 = p.comments.find((c) => c.cid === 3656482);
  assert.equal(recv2.recv, 2);
  assert.equal(recv2.nick, '408주종발효');
});

// --- Parser: pagination AJAX response ---

test('parseComments on reply_ajax.json html: 18 unique, banner li skipped', async () => {
  const j = JSON.parse(await fs.readFile(AJAX_FIXTURE, 'utf8'));
  assert.equal(j.pagecount, null, 'fixture is a single-page response');
  const comments = parseComments(j.html, { now: NOW });
  assert.equal(comments.length, 18, 'banner li (no cid) skipped');
  assert.equal(new Set(comments.map((c) => c.cid)).size, 18);
  const best = comments.find((c) => c.cid === 3656453);
  assert.equal(best.recv, 9);
  assert.equal(best.ts, '2026-07-17');
  assert.ok(comments.some((c) => c.ts === '2026-07-18'), '29일 전 comment -> 2026-07-18');
});

// --- Parser: anonymous comment ---

test('anonymous comment (no dropdown) -> rno 0', () => {
  const li = `<li class=""><div class='desc' id='reply_body_pan_monstarz_9999'><p><span class='wtime'>1일 전 <i>|</i></span></p><div class='det'>익명</div><div class='buttons'><span id='board_pan_monstarz_reply_9999_good'>0</span></div></div></li>`;
  const comments = parseComments(`<ul id = 'reply_list_layer' class="comment">${li}</ul>`, { now: NOW });
  assert.equal(comments.length, 1);
  assert.equal(comments[0].rno, 0);
  assert.equal(comments[0].nick, null);
});

// --- Crawler: fetch + events ---

test('crawlArticles: appends user + 18 comment events, dedupes, marks fetched', async () => {
  await resetData();
  const html = await fs.readFile(FIXTURE, 'utf8');
  fetchPool.configure({
    fetchImpl: async () => fakeResponse(200, html),
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });
  const articleMap = new Map([[1732853, { badge: 18, ts: '2026-07-17T22:59:26+09:00', nick: '408주종발효' }]]);
  const errors = [];
  const result = await crawlArticles({ fetchQueue: [1732853], articleMap, now: NOW, onError: (e) => errors.push(e) });
  assert.equal(result.processed, 1);
  assert.equal(result.skipped, 0);
  assert.equal(errors.length, 0);
  assert.equal(result.report[0].uniqueCids, 18);
  assert.equal(result.report[0].pagesFetched, 0, '18 cids == badge 18 -> no pagination');

  const events = (await fs.readFile(EVENTS_FILE, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const user = events.filter((e) => e.t === 'user');
  assert.equal(user.length, 1);
  assert.deepEqual(
    { t: user[0].t, rno: user[0].rno, nick: user[0].nick, idx: user[0].idx, ts: user[0].ts },
    { t: 'user', rno: 678199, nick: '408주종발효', idx: 1732853, ts: '2026-07-17T22:59:26+09:00' },
  );
  const comments = events.filter((e) => e.t === 'comment');
  assert.equal(comments.length, 18);
  assert.equal(new Set(comments.map((c) => c.cid)).size, 18, 'no duplicate cids in events');
  assert.ok(comments.every((c) => c.idx === 1732853 && /^\d{4}-\d{2}-\d{2}$/.test(c.ts)));
  assert.ok(comments.some((c) => c.ts === '2026-07-17'), '30일 전 -> 07-17');
  assert.ok(comments.some((c) => c.ts === '2026-07-18'), '29일 전 -> 07-18');
  const state = await store.loadState();
  assert.deepEqual(state.fetched, [1732853]);
});

// --- Crawler: resume/delta ---

test('crawlArticles: skips already-fetched idx (resume/delta), no network call', async () => {
  await resetData();
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify({ fetched: [1732853] }));
  let calls = 0;
  fetchPool.configure({
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse(200, '');
    },
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });
  const result = await crawlArticles({ fetchQueue: [1732853], articleMap: new Map() });
  assert.equal(result.processed, 0);
  assert.equal(result.skipped, 1);
  assert.equal(calls, 0, 'no network call for fetched idx');
  await assert.rejects(fs.readFile(EVENTS_FILE, 'utf8'), { code: 'ENOENT' }, 'no events appended');
});

// --- Crawler: pagination ---

test('crawlArticles: paginates via reply_list_action until pagecount, re-emits reply_info', async () => {
  await resetData();
  const articleHtml = fakeArticleHtml([
    { cid: 1001, rno: 111, nick: '닉1', recv: 0 },
    { cid: 1004, rno: 0, nick: null, recv: 0 }, // anonymous
  ]);
  const posts = [];
  const postHeaders = [];
  fetchPool.configure({
    fetchImpl: async (url, opts = {}) => {
      if (opts.method === 'POST') {
        posts.push(opts.body);
        postHeaders.push(opts.headers);
        const page = new URLSearchParams(opts.body).get('page');
        const li = (cid, rno, nick) =>
          `<li class=""><div class='desc' id='reply_body_pan_monstarz_${cid}'><p><a href="javascript:;" onclick="YG_COMMON.show_nick_dropdown(this, '0', '${rno}', 'Y', 'N')">${nick}</a><span class='wtime'>1일 전 <i>|</i></span></p><div class='det'>x</div><div class='buttons'><span id='board_pan_monstarz_reply_${cid}_good'>0</span></div></div></li>`;
        const body =
          page === '1'
            ? JSON.stringify({ msg: 'SUCCESS', pagecount: 2, pagenum: 1, html: li(1002, 222, '닉2') })
            : JSON.stringify({ msg: 'SUCCESS', pagecount: 2, pagenum: 2, html: li(1003, 333, '닉3') });
        return fakeResponse(200, body);
      }
      return fakeResponse(200, articleHtml);
    },
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });
  const articleMap = new Map([[7777, { badge: 3, ts: '2026-08-15T10:00:00+09:00', nick: '작성자' }]]);
  const result = await crawlArticles({ fetchQueue: [7777], articleMap, now: NOW });
  assert.equal(result.report[0].pagesFetched, 2, 'pagecount 2 -> 2 POSTs');
  assert.equal(posts.length, 2, 'no extra POSTs beyond pagecount');

  assert.equal(
    posts[0],
    'path=reply%2Freply_list_action&reply_info=ZmFrZXJlcGx5aW5mbw%3D%3D&page=1',
    'reply_info re-emitted verbatim (base64 = encoded, --data-urlencode equivalent)',
  );
  assert.equal(new URLSearchParams(posts[1]).get('page'), '2');
  const h = postHeaders[0];
  assert.equal(h.Referer, 'https://m.ygosu.com/board/pan_monstarz/7777');
  assert.equal(h['X-Requested-With'], 'XMLHttpRequest');
  assert.equal(h['Content-Type'], 'application/x-www-form-urlencoded');

  const events = (await fs.readFile(EVENTS_FILE, 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const user = events.filter((e) => e.t === 'user');
  assert.equal(user.length, 1);
  assert.equal(user[0].rno, 999);
  const comments = events.filter((e) => e.t === 'comment');
  assert.deepEqual(
    comments.map((c) => c.cid).sort((a, b) => a - b),
    [1001, 1002, 1003, 1004],
    'page comments merged, no duplicates',
  );
  const anon = comments.find((c) => c.cid === 1004);
  assert.equal(anon.anon, true, 'rno=0 comment flagged anon');
  assert.equal(anon.rno, 0);
  assert.ok(comments.every((c) => c.ts === '2026-08-15', '1일 전 from NOW'));
});

test('crawlArticles: single-page response (pagecount null) -> exactly 1 POST', async () => {
  await resetData();
  const articleHtml = fakeArticleHtml([{ cid: 1001, rno: 111, nick: '닉1', recv: 0 }]);
  let posts = 0;
  fetchPool.configure({
    fetchImpl: async (url, opts = {}) => {
      if (opts.method === 'POST') {
        posts += 1;
        return fakeResponse(
          200,
          JSON.stringify({ msg: 'SUCCESS', pagecount: null, pagenum: 0, html: '' }),
        );
      }
      return fakeResponse(200, articleHtml);
    },
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });
  const articleMap = new Map([[7777, { badge: 3, ts: '2026-08-15T10:00:00+09:00', nick: '작성자' }]]);
  const result = await crawlArticles({ fetchQueue: [7777], articleMap });
  assert.equal(result.report[0].pagesFetched, 1);
  assert.equal(posts, 1, 'pagecount null -> single page, stop');
});

// --- Crawler: failure path ---

test('crawlArticles: fetch failure -> onError per article, run continues', async () => {
  await resetData();
  fetchPool.configure({
    fetchImpl: async () => {
      throw new Error('network down');
    },
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });
  const errors = [];
  const result = await crawlArticles({ fetchQueue: [1, 2], articleMap: new Map(), onError: (e) => errors.push(e) });
  assert.equal(result.processed, 0);
  assert.equal(errors.length, 2, 'both articles reported, no crash');
  assert.ok(errors[0].includes('article 1 failed'));
  await assert.rejects(fs.readFile(EVENTS_FILE, 'utf8'), { code: 'ENOENT' });
});