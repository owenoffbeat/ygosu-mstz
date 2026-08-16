// lib/list.js — board list crawler + parser (T3)
// Parses <ul class="li2"> rows from m.ygosu.com/board/pan_monstarz and crawls
// pages with boundary/delta stop rules. Reuses T2 fetchPool/store.
import { config, fetchPool, store } from '../server.mjs';
import { parseListTime, kstTimestamp } from './kst.js';

const LIST_URL = 'https://m.ygosu.com/board/pan_monstarz';

// --- Parser (pure, fixture-driven: test/fixtures/list_page0.html) ---

const LI_RE = /<li[^>]*>[\s\S]*?<\/li>/g;
const LI_OPEN_RE = /<li[^>]*>/;
const HREF_RE = /href='([^']+)'/;
const IDX_RE = /\/board\/pan_monstarz\/(\d+)/;
const BADGE_RE = /<span class='badge mr2'>(\d+)<\/span>/;
const P_RE = /<p>([\s\S]*?)<\/p>/;
// <p> NICK <span>|</span> TIME <span>|</span> 조회 : <strong>N</strong> <span>|</span> 추천 : RECV </p>
const META_RE =
  /^\s*([^<]+?)\s*<span>\|<\/span>\s*(\d{2}:\d{2}|\d{2}\.\d{2}\.\d{2}(?:\s+\d{2}:\d{2})?)\s*<span>\|<\/span>\s*조회\s*:\s*<strong[^>]*>([^<]*)<\/strong>\s*<span>\|<\/span>\s*추천\s*:\s*([+-]?\d+|-)\s*$/;

function parseRecv(raw) {
  if (raw === '-') return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Parse a board list page HTML into article rows.
 * Skips: notice li (class contains 'notice'), ad li (href starts /board/ad/),
 * best-list links (best_article / /board/best), and li without a pan_monstarz
 * article link or meta <p> (banners, category/pagination links).
 * Article links may carry a ?page=N query (site appends it from page 2) — the
 * idx regex matches first, so those are still accepted.
 * Returns [{idx, nick, ts, recv, badge}] with ts as KST ISO8601.
 */
function parseListPage(html, { now = new Date() } = {}) {
  const ulStart = html.indexOf('<ul class="li2">');
  if (ulStart === -1) return [];
  const ulEnd = html.indexOf('</ul>', ulStart);
  const block = html.slice(ulStart, ulEnd === -1 ? undefined : ulEnd + 5);
  const articles = [];
  for (const li of block.matchAll(LI_RE)) {
    const liHtml = li[0];
    const liOpen = (liHtml.match(LI_OPEN_RE) || [''])[0];
    if (/notice/.test(liOpen)) continue;
    const hrefMatch = liHtml.match(HREF_RE);
    if (!hrefMatch) continue;
    const href = hrefMatch[1];
    if (href.startsWith('/board/ad/')) continue;
    if (href.includes('best_article') || href.includes('/board/best')) continue;
    const idxMatch = href.match(IDX_RE);
    if (!idxMatch) continue;
    const badgeMatch = liHtml.match(BADGE_RE);
    const badge = badgeMatch ? Number(badgeMatch[1]) : 0;
    const pMatch = liHtml.match(P_RE);
    if (!pMatch) continue;
    const meta = pMatch[1].match(META_RE);
    if (!meta) continue;
    const [, nick, timeStr, , recvRaw] = meta;
    const ts = parseListTime(timeStr, now);
    if (!ts) continue;
    articles.push({
      idx: Number(idxMatch[1]),
      nick: nick.trim(),
      ts: kstTimestamp(ts),
      recv: parseRecv(recvRaw),
      badge,
    });
  }
  return articles;
}

// --- Crawler ---

/**
 * Crawl the board list from page 1, appending article events and updating
 * state.scanned. Stop rules (checked after each page is processed):
 *   boundary — any article older than windowStart (list is newest-first)
 *   delta    — every non-notice idx on the page already in state.scanned
 *   empty    — 3 consecutive pages with zero articles (warning)
 *   maxPages — YGOSU_MAX_PAGES exceeded (warning)
 * Returns {total, pages, fetchQueue, voteQueue}.
 */
async function crawlList({ windowStart, onWarn, maxPages = config.maxPages } = {}) {
  const state = await store.loadState();
  const scanned = new Set(state.scanned || []);
  const fetchQueue = [];
  const voteQueue = [];
  const now = new Date();
  let page = 1; // site is 1-indexed; page=0 aliases to page=1 (verified live)
  let processed = 0;
  let emptyStreak = 0;
  let total = 0;

  while (page <= maxPages) {
    const url = `${LIST_URL}?page=${page}`;
    let html;
    try {
      const res = await fetchPool.fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      onWarn?.(`list page ${page} fetch failed: ${err.message}`);
      break;
    }
    const articles = parseListPage(html, { now });
    processed += 1;

    if (articles.length === 0) {
      emptyStreak += 1;
      if (emptyStreak >= 3) {
        onWarn?.(`list crawl stopped: 3 consecutive empty pages (page ${page})`);
        break;
      }
    } else {
      emptyStreak = 0;
    }

    const boundaryHit = windowStart != null && articles.some((a) => new Date(a.ts) < windowStart);
    const deltaHit = articles.length > 0 && articles.every((a) => scanned.has(a.idx));

    for (const a of articles) {
      if (scanned.has(a.idx)) continue;
      scanned.add(a.idx);
      const event = { t: 'article', idx: a.idx, nick: a.nick, ts: a.ts, recv: a.recv, badge: a.badge, page };
      await store.appendEvent(event);
      total += 1;
      if (a.badge >= 1) fetchQueue.push(a.idx);
      if (a.recv > 0) voteQueue.push(a.idx);
    }

    if (boundaryHit) {
      onWarn?.(`list crawl stopped: boundary reached at page ${page} (article older than windowStart)`);
      break;
    }
    if (deltaHit) {
      onWarn?.(`list crawl stopped: delta rule (all idx already scanned) at page ${page}`);
      break;
    }
    page += 1;
  }

  if (page > maxPages) {
    onWarn?.(`list crawl stopped: YGOSU_MAX_PAGES (${maxPages}) reached`);
  }

  await store.saveState({ ...state, scanned: [...scanned] });
  return { total, pages: processed, fetchQueue, voteQueue };
}

export { parseListPage, parseRecv, crawlList };
