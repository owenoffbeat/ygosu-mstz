// lib/rankings.js — pure rankings computation (T6)
// computeRankings(events, {nowKST, givenAvailable}) turns the T3~T5 event log
// into per-metric (posts/comments/recv/given) x per-period (daily/weekly/
// monthly) TOP 10 lists with identity merging:
//   (1) nick -> rno map built from user/comment events (anon excluded)
//   (2) a nick mapped to exactly one rno merges ALL its events (articles
//       included) under `u:<rno>`; otherwise the nick stays `n:<nick>`
//   (3) display nick = nick of the key's latest event (max ts; tie -> later
//       input order wins, so the result is fully deterministic)
// Pure + deterministic: same input -> byte-identical output. Corrupt event
// rows (schema mismatch) are skipped and counted in `errors` — never thrown.
import { kstTimestamp, todayStartKst } from './kst.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIODS = ['daily', 'weekly', 'monthly'];
const METRICS = ['posts', 'comments', 'recv', 'given'];

// KST ISO8601 with +09:00 offset, or a bare KST calendar day 'YYYY-MM-DD'
// (comment events carry day-granularity ts — T4 relative-time approximation).
const TS_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\+09:00)?$/;

/**
 * Event ts -> epoch ms. A bare KST day is parsed as KST midnight so a "today"
 * comment always falls inside the daily window regardless of the current time.
 * Returns null for unparseable values (schema mismatch).
 */
function parseTs(ts) {
  if (typeof ts !== 'string' || !TS_RE.test(ts)) return null;
  const iso = ts.length === 10 ? `${ts}T00:00:00+09:00` : ts;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

// Numeric or numeric-string (T5 vote events carry rno as a string — regex
// extraction; T3/T4 emit numbers). Empty strings are NOT numeric.
function isNum(v) {
  return (
    (typeof v === 'number' && Number.isFinite(v)) ||
    (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))
  );
}

/**
 * Schema check per event type. Required: t, nick, parseable ts, plus the
 * type-specific id (idx / cid / rno). recv is optional (defaults to 0).
 */
function isValid(ev) {
  if (typeof ev !== 'object' || ev === null || Array.isArray(ev)) return false;
  if (typeof ev.t !== 'string' || typeof ev.nick !== 'string') return false;
  if (parseTs(ev.ts) === null) return false;
  switch (ev.t) {
    case 'article':
      return isNum(ev.idx);
    case 'comment':
      return isNum(ev.idx) && isNum(ev.cid);
    case 'user':
      return isNum(ev.rno);
    case 'vote':
      return isNum(ev.idx) && isNum(ev.rno);
    default:
      return false;
  }
}

function recvOf(ev) {
  return isNum(ev.recv) ? Number(ev.recv) : 0;
}

function addToMap(map, nick, rno) {
  let set = map.get(nick);
  if (!set) {
    set = new Set();
    map.set(nick, set);
  }
  set.add(String(rno)); // canonical string — keys stay consistent across types
}

/** Identity key for an event: `u:<rno>` when the nick maps to exactly one
 * rno, else `n:<nick>` (no mapping, or the nick spans multiple rnos). */
function keyFor(ev, nickToRnos) {
  const rnos = nickToRnos.get(ev.nick);
  if (rnos && rnos.size === 1) return `u:${[...rnos][0]}`;
  return `n:${ev.nick}`;
}

// Plain string comparison — deterministic across ICU/locale environments.
function cmpKey(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function zeroMetric() {
  return { posts: 0, comments: 0, recv: 0, given: 0 };
}

/**
 * Compute TOP 10 rankings from the event log.
 * @param {Array} events T3~T5 events ({t:'article'|'comment'|'user'|'vote'}).
 * @param {object} [opts]
 * @param {Date|string|number} [opts.nowKST] "now" — any Date-parseable value
 *   (KST wall clock). Defaults to the current time.
 * @param {boolean} [opts.givenAvailable] false -> the given metric is reported
 *   as {unavailable:true} (T1 vote-API skip decision). Default true.
 * @returns {object} {generatedAt, periods, metrics, top, errors}
 */
function computeRankings(events, { nowKST = new Date(), givenAvailable = true } = {}) {
  const now = new Date(nowKST);
  const nowMs = now.getTime();
  if (Number.isNaN(nowMs)) throw new TypeError(`computeRankings: invalid nowKST ${nowKST}`);
  const todayStartMs = todayStartKst(now).getTime();
  const windows = {
    daily: { start: todayStartMs, end: nowMs }, // KST today 00:00 ~ now
    weekly: { start: nowMs - 7 * DAY_MS, end: nowMs }, // rolling 7 days
    monthly: { start: nowMs - 30 * DAY_MS, end: nowMs }, // rolling 30 days
  };

  // Pass 1: validate + build the nick -> rno identity map. Only user/comment
  // events contribute; anonymous comments (rno 0) establish no identity.
  const valid = [];
  const nickToRnos = new Map();
  let errors = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    if (!isValid(ev)) {
      errors += 1;
      continue;
    }
    valid.push(ev);
    if (ev.t === 'user' && Number(ev.rno) > 0) addToMap(nickToRnos, ev.nick, ev.rno);
    else if (ev.t === 'comment' && !ev.anon && Number(ev.rno) > 0) addToMap(nickToRnos, ev.nick, ev.rno);
  }

  // Pass 2: attribute events to identity keys per period window. User events
  // carry identity nicks (latest-nick tracking) but no metric counts.
  const counts = new Map(); // key -> {daily: metric, weekly: metric, monthly: metric}
  const latest = new Map(); // key -> {tsMs, nick, order} (display nick)
  valid.forEach((ev, order) => {
    if (ev.t === 'comment' && (ev.anon || Number(ev.rno) === 0)) return; // anonymous — excluded
    const tsMs = parseTs(ev.ts);
    const key = keyFor(ev, nickToRnos);
    const prev = latest.get(key);
    if (!prev || tsMs > prev.tsMs || (tsMs === prev.tsMs && order > prev.order)) {
      latest.set(key, { tsMs, nick: ev.nick, order });
    }
    if (ev.t === 'user') return; // identity event — no metric contribution

    let c = counts.get(key);
    if (!c) {
      c = { daily: zeroMetric(), weekly: zeroMetric(), monthly: zeroMetric() };
      counts.set(key, c);
    }
    for (const period of PERIODS) {
      const w = windows[period];
      if (tsMs < w.start || tsMs > w.end) continue;
      const m = c[period];
      if (ev.t === 'article') {
        m.posts += 1;
        m.recv += recvOf(ev);
      } else if (ev.t === 'comment') {
        m.comments += 1;
        m.recv += recvOf(ev);
      } else if (ev.t === 'vote') {
        m.given += 1;
      }
    }
  });

  // Rank per metric x period: count desc, key asc, rank 1-based, TOP 10.
  const top = {};
  for (const metric of METRICS) {
    top[metric] = {};
    for (const period of PERIODS) {
      const entries = [];
      for (const [key, c] of counts) {
        const count = c[period][metric];
        if (count > 0) entries.push({ key, count });
      }
      entries.sort((a, b) => b.count - a.count || cmpKey(a.key, b.key));
      top[metric][period] = entries.slice(0, 10).map((e, i) => ({
        rank: i + 1,
        nick: latest.get(e.key).nick,
        count: e.count,
      }));
    }
  }

  const metrics = { posts: 'posts', comments: 'comments', recv: 'recv', given: 'given' };
  if (!givenAvailable) {
    metrics.given = { unavailable: true };
    top.given = { unavailable: true };
  }

  return {
    generatedAt: kstTimestamp(now),
    periods: {
      daily: { start: kstTimestamp(new Date(windows.daily.start)), end: kstTimestamp(new Date(windows.daily.end)) },
      weekly: { start: kstTimestamp(new Date(windows.weekly.start)), end: kstTimestamp(new Date(windows.weekly.end)) },
      monthly: { start: kstTimestamp(new Date(windows.monthly.start)), end: kstTimestamp(new Date(windows.monthly.end)) },
    },
    metrics,
    top,
    errors,
  };
}

export { computeRankings };