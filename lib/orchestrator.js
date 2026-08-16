// lib/orchestrator.js — refresh orchestration + rankings/status API support (T7)
//
// Single-flight async scraping pipeline: list (boundary/delta rules) ->
// article fetch queue -> vote fetch queue. Each phase's crawl state lives in
// data/state.json (scanned/fetched/votes), so a server restart resumes from
// saved state — crawlList/crawlArticles/fetchVotes skip already-processed
// idxs, and the orchestrator rebuilds pending queues from state.scanned.
//
// Progress {phase, listPage, scanned, fetched, votes, errors[], startedAt,
// lastRun} is persisted under state.progress (merged into the CURRENT state
// at every save — never clobbers crawl state). Rankings are computed from
// events.jsonl and cached to data/rankings.json; the cache is recomputed on
// refresh completion and served as the last-successful fallback when a
// computation fails (partial failures are allowed).
import fs from 'node:fs/promises';
import path from 'node:path';
import { config, store } from '../server.mjs';
import { crawlList } from './list.js';
import { crawlArticles, loadArticleMap } from './article.js';
import { fetchVotes } from './vote.js';
import { computeRankings } from './rankings.js';
import { kstTimestamp } from './kst.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ERRORS = 100; // keep the most recent errors in progress

const rankingsFile = () => path.join(store.dataDir, 'rankings.json');

let running = false;

// ============================================================
// progress helpers (persisted under state.progress)
// ============================================================

async function loadProgress() {
  const state = await store.loadState();
  return (
    state.progress || {
      phase: 'idle',
      listPage: 0,
      scanned: 0,
      fetched: 0,
      votes: 0,
      errors: [],
      startedAt: null,
      lastRun: null,
    }
  );
}

/** Persist progress merged into the CURRENT state (never clobbers crawl state). */
async function saveProgress(progress) {
  const cur = await store.loadState();
  progress.scanned = (cur.scanned || []).length;
  progress.fetched = (cur.fetched || []).length;
  progress.votes = Object.keys(cur.votes || {}).length;
  await store.saveState({ ...cur, progress });
}

function pushError(progress, message) {
  progress.errors.push({ at: kstTimestamp(), message });
  if (progress.errors.length > MAX_ERRORS) {
    progress.errors.splice(0, progress.errors.length - MAX_ERRORS);
  }
  console.warn(`[orchestrator] ${message}`);
}

// ============================================================
// events / rankings
// ============================================================

async function loadEvents() {
  const events = [];
  let text;
  try {
    text = await fs.readFile(store.eventsFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return events;
    throw err;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // corrupt line — computeRankings counts it as an error
    }
  }
  return events;
}

/** Count events.jsonl lines per type (corrupt lines count toward total only). */
async function countEvents() {
  const counts = { article: 0, comment: 0, user: 0, vote: 0, total: 0 };
  let text;
  try {
    text = await fs.readFile(store.eventsFile, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return counts;
    throw err;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    counts.total += 1;
    try {
      const ev = JSON.parse(line);
      if (counts[ev.t] !== undefined) counts[ev.t] += 1;
    } catch {
      // corrupt line — not counted per type
    }
  }
  return counts;
}

/** computeRankings(events.jsonl) -> write data/rankings.json cache -> result. */
async function computeAndCacheRankings() {
  const events = await loadEvents();
  const result = computeRankings(events, { givenAvailable: true });
  await fs.mkdir(store.dataDir, { recursive: true });
  await fs.writeFile(rankingsFile(), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

async function readRankingsCache() {
  try {
    return JSON.parse(await fs.readFile(rankingsFile(), 'utf8'));
  } catch {
    return null;
  }
}

// ============================================================
// queue rebuild (resume/delta: pending idxs from saved state)
// ============================================================

/**
 * Pending fetch/vote idxs from state.scanned that are not yet in
 * state.fetched / state.votes. Used to continue an interrupted run: the list
 * phase's delta rule stops after one page when everything is scanned, so the
 * remaining queues must be rebuilt from saved state.
 */
async function buildPendingQueues(articleMap) {
  const state = await store.loadState();
  const fetched = new Set(state.fetched || []);
  const votes = state.votes || {};
  const fetchQueue = [];
  const voteQueue = [];
  for (const idx of state.scanned || []) {
    const a = articleMap.get(idx);
    if (!a) continue;
    if ((a.badge ?? 0) >= 1 && !fetched.has(idx)) fetchQueue.push(idx);
    if ((a.recv ?? 0) > 0 && !votes[idx]) voteQueue.push(idx);
  }
  return { fetchQueue, voteQueue };
}

// ============================================================
// the run
// ============================================================

async function runRefresh() {
  const windowStart = new Date(Date.now() - config.windowDays * DAY_MS);
  const progress = await loadProgress();
  const resumePhase = progress.phase; // captured before phase is overwritten below
  if (['done', 'error', 'idle'].includes(progress.phase)) {
    // fresh run — reset progress (keep lastRun for reference)
    progress.phase = 'list';
    progress.listPage = 0;
    progress.scanned = 0;
    progress.fetched = 0;
    progress.votes = 0;
    progress.errors = [];
    progress.startedAt = kstTimestamp();
  }
  console.log(
    `[orchestrator] refresh started (windowDays=${config.windowDays}, maxPages=${config.maxPages}, resumePhase=${progress.phase})`,
  );

  // Phase 1: list (boundary/delta rules; resume continues from the last page)
  progress.phase = 'list';
  await saveProgress(progress);
  const listResult = await crawlList({
    windowStart,
    startPage: resumePhase === 'list' && progress.listPage > 0 ? progress.listPage + 1 : 1,
    onWarn: (m) => console.log(`[orchestrator] ${m}`),
    onError: (m) => pushError(progress, m),
    onProgress: async ({ page }) => {
      progress.listPage = page;
      await saveProgress(progress);
    },
  });
  progress.listPage = listResult.pages;
  await saveProgress(progress);
  console.log(
    `[orchestrator] list: pages=${listResult.pages}, newArticles=${listResult.total}, fetchQueue=${listResult.fetchQueue.length}, voteQueue=${listResult.voteQueue.length}`,
  );

  // Phase 2: articles (fetch queue; resume skips state.fetched)
  progress.phase = 'articles';
  await saveProgress(progress);
  const articleMap = await loadArticleMap();
  const pending = await buildPendingQueues(articleMap);
  const fetchQueue = [...new Set([...listResult.fetchQueue, ...pending.fetchQueue])];
  const articleResult = await crawlArticles({
    fetchQueue,
    articleMap,
    onWarn: (m) => console.log(`[orchestrator] ${m}`),
    onError: (m) => pushError(progress, m),
  });
  await saveProgress(progress);
  console.log(
    `[orchestrator] articles: processed=${articleResult.processed}, skipped=${articleResult.skipped}, total=${articleResult.total}`,
  );

  // Phase 3: votes (vote queue; resume skips state.votes)
  progress.phase = 'votes';
  await saveProgress(progress);
  const voteQueue = [...new Set([...listResult.voteQueue, ...pending.voteQueue])];
  let votesProcessed = 0;
  let votesSkipped = 0;
  for (const idx of voteQueue) {
    try {
      const r = await fetchVotes({
        idx,
        articleTs: articleMap.get(idx)?.ts,
        onWarn: (m) => console.log(`[orchestrator] ${m}`),
      });
      if (r.skipped) votesSkipped += 1;
      else votesProcessed += 1;
    } catch (err) {
      pushError(progress, `vote ${idx} failed: ${err.message}`);
    }
    await saveProgress(progress);
  }
  console.log(
    `[orchestrator] votes: processed=${votesProcessed}, skipped=${votesSkipped}, total=${voteQueue.length}`,
  );

  progress.phase = 'done';
  progress.lastRun = kstTimestamp();
  await saveProgress(progress);
  await computeAndCacheRankings(); // refresh completion recomputes the cache
  console.log(
    `[orchestrator] refresh done: scanned=${progress.scanned}, fetched=${progress.fetched}, votes=${progress.votes}, errors=${progress.errors.length}`,
  );
}

// ============================================================
// public API
// ============================================================

/**
 * Start an async refresh run. Single-flight: returns {ok:false, running:true}
 * when a run is already in progress (concurrent runs are never started).
 */
function startRefresh() {
  if (running) return { ok: false, running: true };
  running = true;
  (async () => {
    try {
      await runRefresh();
    } catch (err) {
      console.error('[orchestrator] refresh run failed:', err);
      const progress = await loadProgress();
      pushError(progress, `run failed: ${err.message}`);
      progress.phase = 'error';
      await saveProgress(progress);
    } finally {
      running = false;
    }
  })();
  return { ok: true, running: true };
}

function isRunning() {
  return running;
}

/**
 * GET /api/rankings: compute from events.jsonl + write the cache; fall back
 * to the last successful cache when computation fails (partial failures keep
 * the last good data).
 */
async function getRankings() {
  try {
    return await computeAndCacheRankings();
  } catch (err) {
    const cached = await readRankingsCache();
    if (cached) return cached;
    throw err;
  }
}

/** GET /api/status: progress + eventCounts. Counts are read live from the
 * current state so mid-phase progress (fetched/votes) is always accurate. */
async function getStatus() {
  const state = await store.loadState();
  const p = state.progress || {};
  const eventCounts = await countEvents();
  return {
    ok: true,
    running,
    progress: {
      phase: p.phase || 'idle',
      listPage: p.listPage || 0,
      scanned: (state.scanned || []).length,
      fetched: (state.fetched || []).length,
      votes: Object.keys(state.votes || {}).length,
      errors: p.errors || [],
      startedAt: p.startedAt || null,
      lastRun: p.lastRun || null,
    },
    eventCounts,
    generatedAt: kstTimestamp(),
  };
}

export { startRefresh, isRunning, getRankings, getStatus, computeAndCacheRankings };