#!/usr/bin/env node
// tools/cloud-crawl.mjs — GitHub Actions 크론 전용 무서버 크롤러 실행기 (zero-dep ESM)
//
// server.mjs 를 시작하지 않고 lib/orchestrator.js 의 단일 비동기 수집 파이프라인을
// 직접 실행한다. server.mjs 의 서버 시작은 process.argv[1] 가드에 막혀 있고,
// 크롤러가 진행되는 동안 이벤트 루프가 살아 있으므로 별도 서버 없이 완주한다.
//
// 흐름:
//   1. data/crawl.lock 잠금 획득 (2차 동시 실행 방어 — GitHub Actions concurrency
//      가 1차 방어). 15분 미만 전에 만들어진 잠금이 있으면 "already running"
//      으로 스킵(exit 0). 잠금이 오래됐으면(크래시 잔재) 갱신 후 진행.
//   2. startRefresh() 호출. 반환 {ok:false, running:true} 이면 프로세스 내부에서
//      이미 수집 중 → "이미 실행 중" exit 0.
//   3. isRunning() 이 false 가 될 때까지 5초 폴링 (수집 완료 대기).
//   4. getRankings() 로 data/rankings.json 캐시 갱신 (post-html.mjs 가 사용).
//   5. [cloud-crawl] done (elapsed: Xs) 로그 후 exit 0. 예외 시 exit 1.
//
// 동시성(3)·지연(150ms)·재시도(3) 제한은 server.mjs config 기본값을 그대로 쓴다.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRefresh, isRunning, getRankings } from '../lib/orchestrator.js';

const DATA_DIR = process.env.YGOSU_DATA_DIR
  ? path.resolve(process.env.YGOSU_DATA_DIR)
  : fileURLToPath(new URL('../data/', import.meta.url));
const LOCK_FILE = path.join(DATA_DIR, 'crawl.lock');
const LOCK_STALE_MS = 15 * 60 * 1000; // 잠금 유효 시간 — 크론 간격(15분)과 동일
const POLL_MS = 5000;

/** 잠금 파일 내용 {pid, at} — 없거나 깨졌으면 null. */
async function readLock() {
  try {
    const raw = JSON.parse(await fs.readFile(LOCK_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 잠금 획득. 최근(15분 미만) 잠금이 있으면 false(스킵), 그 외엔 잠금을
 * {pid, at: Date.now()} 로 덮어쓰고 true. 충돌/크래시로 남은 오래된 잠금은
 * 무시하고 이어간다.
 */
async function acquireLock() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const existing = await readLock();
  if (existing && typeof existing.at === 'number' && Date.now() - existing.at < LOCK_STALE_MS) {
    return false;
  }
  await fs.writeFile(LOCK_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
  return true;
}

async function main() {
  const startedAt = Date.now();

  if (!(await acquireLock())) {
    console.log('[cloud-crawl] already running (lock held) — skipping');
    return;
  }
  try {
    const res = startRefresh();
    if (res && res.ok === false && res.running === true) {
      console.log('[cloud-crawl] already running — skipping');
      return;
    }
    while (isRunning()) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    await getRankings(); // 수집 완료 후 rankings.json 캐시 갱신 (docs 생성 전 스냅샷)
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[cloud-crawl] done (elapsed: ${elapsed}s)`);
  } finally {
    await fs.rm(LOCK_FILE, { force: true }).catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[cloud-crawl] failed: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
