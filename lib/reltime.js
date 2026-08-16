// lib/reltime.js — relative time parser (T4)
// Parses ygosu comment timestamps ("30일 전", "방금 전", ...) into a KST
// calendar day string 'YYYY-MM-DD'. Day-level precision only — the site does
// not expose comment timestamps with full resolution (documented approximation).
//
// Supported inputs:
//   '방금 전'            -> 0 minutes -> today (KST)
//   'N분 전'             -> N minutes ago
//   'N시간 전'           -> N hours ago
//   'N일 전'             -> N days ago
//   'N주 전'             -> N*7 days ago
//   'N개월 전'           -> N*30 days ago
//   'N년 전'             -> N*365 days ago
//   'YY.MM.DD'           -> that day (KST)
//   'YY.MM.DD HH:MM'     -> that day (KST)
// Returns null for anything unrecognized.
import { kstDate, parseListTime } from './kst.js';

const REL_RE = /^(\d+)\s*(분|시간|일|주|개월|년)\s*전$/;

// Hours per unit (weeks/months/years are day-count approximations per plan).
const UNIT_HOURS = {
  분: 1 / 60,
  시간: 1,
  일: 24,
  주: 7 * 24,
  개월: 30 * 24,
  년: 365 * 24,
};

/**
 * Parse a relative/absolute time string into a KST calendar day 'YYYY-MM-DD'.
 * @param {string} str raw wtime text (e.g. "30일 전 ")
 * @param {Date} [now] reference instant (defaults to now)
 * @returns {string|null}
 */
function parseRelativeTime(str, now = new Date()) {
  const s = String(str ?? '').trim();
  if (s === '방금 전' || s === '방금') return kstDate(now);
  const m = REL_RE.exec(s);
  if (m) {
    const hours = UNIT_HOURS[m[2]] * Number(m[1]);
    return kstDate(new Date(now.getTime() - hours * 3600 * 1000));
  }
  const abs = parseListTime(s, now); // 'YY.MM.DD' / 'YY.MM.DD HH:MM'
  if (abs) return kstDate(abs);
  return null;
}

export { parseRelativeTime };