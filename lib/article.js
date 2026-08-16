// lib/article.js — article + comment fetcher/parser (T4)
// Fetches articles from the fetch queue (badge>=1 only), parses the author
// identity (rno), reply_info (re-emitted verbatim for pagination), and all
// comments (author rno/nick, relative time, recv count) with global cid
// dedupe (best-reply list duplicates the same comment). When the unique cid
// count is below the list badge, paginates via POST /action.yg
// (path=reply/reply_list_action) until the response's pagecount/pagenum says
// stop. Reuses T2 fetchPool/store and T3 kst helpers.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchPool, store } from '../server.mjs';
import { kstTimestamp } from './kst.js';
import { parseRelativeTime } from './reltime.js';

const ARTICLE_URL = (idx) => `https://m.ygosu.com/board/pan_monstarz/${idx}`;
const ACTION_URL = 'https://m.ygosu.com/action.yg'; // m.ygosu.com host verified in T1 (ygosu.com -> 404)
const EVENTS_FILE = fileURLToPath(new URL('../data/events.jsonl', import.meta.url));
const MAX_REPLY_PAGES = 100; // safety cap; real runs stop on pagecount/pagenum

// --- Parsing rules (fixture test/fixtures/article_1732853.html) ---

const DROPDOWN_RE = /show_nick_dropdown\(this, '0', '(\d+)', 'Y', 'N'\)/;
const REPLY_INFO_RE = /var reply_info_str='([A-Za-z0-9+/=]+)'/;
const TITLE_CNT_RE = /<h4 class="article_title">[\s\S]*?<em>\[(\d+)\]<\/em>/;
// title_info meta: 'YY-MM-DD HH:MM:SS' (dash-separated, seconds included)
const TITLE_TS_RE = /(\d{2})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
const LI_RE = /<li[^>]*>[\s\S]*?<\/li>/g;
const CID_RE = /reply_body_pan_monstarz_(\d+)/;
const WTIME_RE = /<span class='wtime'>([^<]+)/;
// anchor text of the first show_nick_dropdown anchor inside a block
const NICK_ANCHOR_RE = /show_nick_dropdown\(this, '0', '\d+', 'Y', 'N'\)[\s\S]*?<\/a>/;

/** Text of the first show_nick_dropdown anchor in html (tags stripped, trimmed). */
function extractNick(html) {
  const m = html.match(NICK_ANCHOR_RE);
  if (!m) return null;
  const gt = m[0].indexOf('>');
  if (gt === -1) return null;
  const text = m[0]
    .slice(gt + 1)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
  return text || null;
}

/**
 * Parse one comment <li>. Returns null when the li is not a comment
 * (no reply_body_pan_monstarz_<cid> id — e.g. banner li).
 * rno = 3rd arg of show_nick_dropdown; 0 when absent (anonymous).
 */
function parseCommentLi(liHtml, { now = new Date() } = {}) {
  const cidMatch = liHtml.match(CID_RE);
  if (!cidMatch) return null;
  const cid = Number(cidMatch[1]);
  const rnoMatch = liHtml.match(DROPDOWN_RE);
  const rno = rnoMatch ? Number(rnoMatch[1]) : 0;
  const nick = extractNick(liHtml);
  const wtimeMatch = liHtml.match(WTIME_RE);
  const ts = wtimeMatch ? parseRelativeTime(wtimeMatch[1], now) : null;
  const goodMatch = liHtml.match(new RegExp(`board_pan_monstarz_reply_${cid}_good['"]>(\\d+)`));
  const recv = goodMatch ? Number(goodMatch[1]) : 0;
  return { cid, rno, nick, ts, recv };
}

/** Parse all comment <li> in html (deduped by cid). */
function parseComments(html, { now = new Date() } = {}) {
  const comments = [];
  const seen = new Set();
  for (const li of html.matchAll(LI_RE)) {
    const c = parseCommentLi(li[0], { now });
    if (c && !seen.has(c.cid)) {
      seen.add(c.cid);
      comments.push(c);
    }
  }
  return comments;
}

/**
 * Parse an article page (fixture article_1732853.html).
 * Returns { authorRno, authorNick, replyInfo, titleCnt, articleTs, comments }
 * where comments are deduped by cid across best_reply_list_layer +
 * reply_list_layer (the best comment appears in both lists).
 */
function parseArticlePage(html, { now = new Date() } = {}) {
  const authorRnoMatch = html.match(DROPDOWN_RE); // first dropdown = article author
  const authorRno = authorRnoMatch ? Number(authorRnoMatch[1]) : null;
  const authorNick = extractNick(html);
  const replyInfoMatch = html.match(REPLY_INFO_RE);
  const replyInfo = replyInfoMatch ? replyInfoMatch[1] : null;
  const titleCntMatch = html.match(TITLE_CNT_RE);
  const titleCnt = titleCntMatch ? Number(titleCntMatch[1]) : null;
  const tsMatch = html.match(TITLE_TS_RE);
  const articleTs = tsMatch
    ? kstTimestamp(
        new Date(
          `${2000 + Number(tsMatch[1])}-${tsMatch[2]}-${tsMatch[3]}T${tsMatch[4]}:${tsMatch[5]}:${tsMatch[6]}+09:00`,
        ),
      )
    : null;

  const comments = [];
  const seen = new Set();
  for (const ulId of ['best_reply_list_layer', 'reply_list_layer']) {
    const start = html.indexOf(`id = '${ulId}'`);
    if (start === -1) continue;
    const end = html.indexOf('</ul>', start);
    const block = html.slice(start, end === -1 ? undefined : end + 5);
    for (const li of block.matchAll(LI_RE)) {
      const c = parseCommentLi(li[0], { now });
      if (c && !seen.has(c.cid)) {
        seen.add(c.cid);
        comments.push(c);
      }
    }
  }
  return { authorRno, authorNick, replyInfo, titleCnt, articleTs, comments };
}

// --- Crawler ---

/** Load idx -> {badge, ts, nick} from article events in data/events.jsonl. */
async function loadArticleMap() {
  const map = new Map();
  let text;
  try {
    text = await fs.readFile(EVENTS_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return map;
    throw err;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.t === 'article') map.set(ev.idx, { badge: ev.badge ?? 0, ts: ev.ts, nick: ev.nick });
    } catch {
      // tolerate corrupt lines — events.jsonl is append-only
    }
  }
  return map;
}

/**
 * POST reply/reply_list_action. reply_info is re-emitted verbatim via
 * URLSearchParams (equivalent to curl --data-urlencode — base64 +/= encoded).
 */
async function postReplyList(idx, replyInfo, page) {
  const body = new URLSearchParams({
    path: 'reply/reply_list_action',
    reply_info: replyInfo,
    page: String(page),
  });
  const res = await fetchPool.fetch(ACTION_URL, {
    method: 'POST',
    headers: {
      Referer: `https://m.ygosu.com/board/pan_monstarz/${idx}`,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Paginate page=1..pagecount via reply_list_action, merging new comments into
 * byCid (global dedupe). Termination is driven by the response's
 * pagecount/pagenum fields (no comment_cnt in paginated responses — T1).
 * Returns the number of pages fetched.
 */
async function fetchReplyPages(idx, replyInfo, byCid, { now = new Date() } = {}) {
  let page = 1;
  let pagesFetched = 0;
  while (page <= MAX_REPLY_PAGES) {
    const data = await postReplyList(idx, replyInfo, page);
    for (const c of parseComments(data.html || '', { now })) {
      if (!byCid.has(c.cid)) byCid.set(c.cid, c);
    }
    for (const c of parseComments(data.best_html || '', { now })) {
      if (!byCid.has(c.cid)) byCid.set(c.cid, c);
    }
    pagesFetched += 1;
    const pc = data.pagecount;
    if (pc == null) break; // single page — all comments server-rendered
    if (data.pagenum >= pc) break; // last page reached
    page += 1;
  }
  return pagesFetched;
}

/**
 * Fetch one article: GET the article page, parse author + comments, paginate
 * when unique cids < list badge. Returns { events, uniqueCids, badge,
 * pagesFetched, titleCnt }.
 */
async function fetchArticle(idx, articleEvent, { now = new Date() } = {}) {
  const res = await fetchPool.fetch(ARTICLE_URL(idx));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const parsed = parseArticlePage(html, { now });

  const byCid = new Map();
  for (const c of parsed.comments) byCid.set(c.cid, c);

  const badge = articleEvent?.badge ?? 0;
  let pagesFetched = 0;
  if (byCid.size < badge && parsed.replyInfo) {
    pagesFetched = await fetchReplyPages(idx, parsed.replyInfo, byCid, { now });
  }

  const events = [];
  if (parsed.authorRno != null && parsed.authorRno > 0) {
    // identity-merge event: nick/ts fall back to the article page when the
    // list event is unavailable
    events.push({
      t: 'user',
      rno: parsed.authorRno,
      nick: articleEvent?.nick ?? parsed.authorNick,
      idx,
      ts: articleEvent?.ts ?? parsed.articleTs,
    });
  }
  for (const c of byCid.values()) {
    events.push({
      t: 'comment',
      idx,
      cid: c.cid,
      rno: c.rno,
      nick: c.nick,
      ts: c.ts, // KST calendar day (relative-time approximation)
      recv: c.recv,
      ...(c.rno === 0 ? { anon: true } : {}),
    });
  }
  return { events, uniqueCids: byCid.size, badge, pagesFetched, titleCnt: parsed.titleCnt };
}

/**
 * Process the fetch queue (badge>=1 idxs from T3 crawlList). Skips idxs
 * already in state.fetched (resume/delta). Appends user + comment events and
 * saves state.fetched after each article (crash-safe resume). Per-article
 * failures are reported via onError and do not stop the run.
 * Returns { processed, skipped, total, report: [{idx, uniqueCids, badge,
 * pagesFetched, titleCnt}] }.
 */
async function crawlArticles({ fetchQueue, articleMap, onWarn, onError } = {}) {
  const state = await store.loadState();
  const fetched = new Set(state.fetched || []);
  const map = articleMap ?? (await loadArticleMap());
  const now = new Date();
  let processed = 0;
  let skipped = 0;
  const report = [];

  for (const idx of fetchQueue) {
    if (fetched.has(idx)) {
      skipped += 1;
      continue;
    }
    try {
      const { events, uniqueCids, badge, pagesFetched, titleCnt } = await fetchArticle(idx, map.get(idx), { now });
      for (const ev of events) await store.appendEvent(ev);
      fetched.add(idx);
      processed += 1;
      await store.saveState({ ...state, fetched: [...fetched] });
      report.push({ idx, uniqueCids, badge, pagesFetched, titleCnt });
      if (titleCnt != null && titleCnt !== uniqueCids) {
        onWarn?.(`article ${idx}: title count ${titleCnt} != parsed unique cids ${uniqueCids}`);
      }
    } catch (err) {
      onError?.(`article ${idx} failed: ${err.message}`);
    }
  }
  return { processed, skipped, total: fetchQueue.length, report };
}

export { parseArticlePage, parseComments, parseCommentLi, extractNick, crawlArticles, fetchArticle };