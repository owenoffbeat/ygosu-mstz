// lib/vote.js — vote-list (recommendations-given) fetcher + parser (T5)
// POSTs board/get_vote_list for articles with recv>0 (vote queue), parses voter
// rows from the response html, and appends vote events. Reuses T2 fetchPool/store.
//
// Row structure (verified from test/fixtures/vote_list_1732853.json — real response, 30 rows):
//   <tr>
//     <td><strong class="badge">1</strong></td>                          <- rank (1-based)
//     <td><a href="javascript:;" onclick="YG_COMMON.show_nick_dropdown(this, '0', '701306', 'Y', 'N')">암애</a></td>
//         ^ rno = 3rd arg of show_nick_dropdown; nick = anchor text
//     <td><span></span></td>                                            <- unused
//     <td><span>26-07-17 22:59:49</span></td>                            <- vote time (absolute, KST)
//   </tr>
// Rows without show_nick_dropdown (e.g. 탈퇴한회원 plain text) are anonymous -> excluded.
import fs from 'node:fs/promises';
import { fetchPool, store } from '../server.mjs';

const VOTE_URL = 'https://m.ygosu.com/action.yg';

// ============================================================
// Parser (pure, fixture-driven)
// ============================================================

const TR_RE = /<tr>([\s\S]*?)<\/tr>/g;
const RNO_RE = /show_nick_dropdown\(this, '0', '(\d+)', 'Y', 'N'\)/;
const NICK_RE = /show_nick_dropdown[^>]*>([^<]*)<\/a>/;
const TIME_RE = /<td><span>(\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})<\/span><\/td>/;

/**
 * 'YY-MM-DD HH:MM:SS' (KST wall clock, e.g. '26-07-17 22:59:49')
 * -> 'YYYY-MM-DDTHH:MM:SS+09:00' (KST ISO8601). 2-digit year -> 2000+.
 * Returns null when the string does not match.
 */
function parseVoteTime(str) {
  const m = /^(\d{2})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(str);
  if (!m) return null;
  const [, yy, mm, dd, hh, mi, ss] = m;
  return `${2000 + Number(yy)}-${mm}-${dd}T${hh}:${mi}:${ss}+09:00`;
}

/**
 * Parse a get_vote_list response ({msg, html}) into voters.
 * Returns [{rno, nick, ts}] — ts is the vote time as KST ISO8601, or null when
 * the row has no parseable time. Anonymous rows (no show_nick_dropdown) are excluded.
 * Non-SUCCESS / malformed responses -> [].
 */
function parseVoteList(json) {
  if (!json || json.msg !== 'SUCCESS' || typeof json.html !== 'string') return [];
  const voters = [];
  for (const m of json.html.matchAll(TR_RE)) {
    const row = m[1];
    const rnoM = row.match(RNO_RE);
    if (!rnoM) continue; // anonymous row (탈퇴한회원 etc.) — excluded
    const nickM = row.match(NICK_RE);
    const timeM = row.match(TIME_RE);
    voters.push({
      rno: rnoM[1],
      nick: nickM ? nickM[1].trim() : '',
      ts: timeM ? parseVoteTime(timeM[1]) : null,
    });
  }
  return voters;
}

// ============================================================
// Fetcher
// ============================================================

/** ts of the article event for idx from events.jsonl (fallback attribution), or null. */
async function findArticleTs(idx) {
  try {
    const text = await fs.readFile(store.eventsFile, 'utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.t === 'article' && ev.idx === idx && ev.ts) return ev.ts;
      } catch {
        // corrupt line — skip
      }
    }
  } catch {
    // ENOENT etc. — no fallback available
  }
  return null;
}

/**
 * Fetch the vote list for one article and append vote events.
 * - Skips when state.votes[idx] exists (resume/delta — (idx,rno) dedupe).
 * - POST https://m.ygosu.com/action.yg, form
 *   path=board/get_vote_list&bid=pan_monstarz&idx=<idx>&return_url=/board/pan_monstarz
 *   with Referer + X-Requested-With + Content-Type headers (T1-verified).
 * - msg != SUCCESS -> one retry, then skip the article with a warning.
 * - Event ts = vote time (KST ISO8601); fallback to the article's ts (articleTs
 *   param, else looked up from events.jsonl) when vote time is missing/unparseable.
 * Returns {idx, skipped, voters, events}.
 */
async function fetchVotes({ idx, articleTs, onWarn } = {}) {
  const state = await store.loadState();
  if (state.votes && state.votes[idx]) {
    return { idx, skipped: true, voters: [], events: 0 };
  }

  const body = `path=board/get_vote_list&bid=pan_monstarz&idx=${idx}&return_url=/board/pan_monstarz`;
  const headers = {
    Referer: `https://m.ygosu.com/board/pan_monstarz/${idx}`,
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  let json = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetchPool.fetch(VOTE_URL, { method: 'POST', headers, body });
    if (!res.ok) throw new Error(`HTTP ${res.status} for vote list idx ${idx}`);
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (json && json.msg === 'SUCCESS') break;
    if (attempt === 0) {
      onWarn?.(`vote list idx ${idx}: msg=${json ? json.msg : 'non-JSON'}; retrying once`);
    }
  }
  if (!json || json.msg !== 'SUCCESS') {
    onWarn?.(`vote list idx ${idx}: msg=${json ? json.msg : 'non-JSON'}; skipping article`);
    return { idx, skipped: true, voters: [], events: 0 };
  }

  const voters = parseVoteList(json);
  const fallbackTs = articleTs ?? (await findArticleTs(idx));
  const seen = new Set();
  let events = 0;
  for (const v of voters) {
    const key = `${idx}:${v.rno}`;
    if (seen.has(key)) continue; // (idx,rno) dedupe within response
    seen.add(key);
    await store.appendEvent({ t: 'vote', idx, rno: v.rno, nick: v.nick, ts: v.ts || fallbackTs });
    events += 1;
  }
  await store.saveState({ ...state, votes: { ...(state.votes || {}), [idx]: [...seen] } });
  return { idx, skipped: false, voters, events };
}

export { parseVoteList, parseVoteTime, fetchVotes, findArticleTs };