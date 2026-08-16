// lib/kst.js — KST (Asia/Seoul, UTC+9) date/time helpers (T3)
// All helpers convert UTC Date objects to KST wall-clock values using
// Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }) — no external deps.
//
// Exports:
//   kstDate(date)        -> 'YYYY-MM-DD' (KST calendar day)
//   kstTimestamp(date)   -> 'YYYY-MM-DDTHH:MM:SS+09:00' (KST ISO8601 with offset;
//                          new Date(ts) parses to the correct UTC instant anywhere)
//   todayStartKst(now)   -> UTC Date of KST midnight (00:00:00) of "today"
//   parseListTime(str, now) -> UTC Date from board-list time string (or null)

const KST_TZ = 'Asia/Seoul';

function kstParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: KST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

/** KST calendar date string 'YYYY-MM-DD' for a UTC Date. */
function kstDate(date = new Date()) {
  const p = kstParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/** KST ISO8601 timestamp 'YYYY-MM-DDTHH:MM:SS+09:00' (KST wall clock + offset). */
function kstTimestamp(date = new Date()) {
  const p = kstParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+09:00`;
}

/** UTC Date of KST midnight (00:00:00) of the current KST day. */
function todayStartKst(now = new Date()) {
  return new Date(`${kstDate(now)}T00:00:00+09:00`);
}

/**
 * Parse a board-list time string into a UTC Date (KST wall clock):
 *   'HH:MM'            -> today (KST) at that time
 *   'YY.MM.DD'         -> that day (KST) at 00:00
 *   'YY.MM.DD HH:MM'   -> that day (KST) at that time
 * Returns null when the string does not match any known format.
 */
function parseListTime(timeStr, now = new Date()) {
  const hm = /^(\d{2}):(\d{2})$/.exec(timeStr);
  if (hm) {
    return new Date(`${kstDate(now)}T${timeStr}:00+09:00`);
  }
  const dm = /^(\d{2})\.(\d{2})\.(\d{2})(?:\s+(\d{2}):(\d{2}))?$/.exec(timeStr);
  if (dm) {
    const [, yy, mm, dd, hh = '00', mi = '00'] = dm;
    return new Date(`${2000 + Number(yy)}-${mm}-${dd}T${hh}:${mi}:00+09:00`);
  }
  return null;
}

export { kstDate, kstTimestamp, todayStartKst, parseListTime };
