#!/usr/bin/env node
// tools/post-text.mjs — 게시판용 스타대학 랭킹 게시글 텍스트 생성 (zero-dep ESM)
// data/rankings.json 을 읽어 4지표(글 작성 수/댓글 작성 수/추천 받은 수/추천한 수) ×
// 3기간(일간/주간/월간) = 12개 표를 plain text로 만들어 stdout에 출력하고,
// post/rankings-<YYYYMMDD-HHMM>.txt 로 저장한다. 네트워크 요청 없음.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RANKINGS = join(ROOT, 'data', 'rankings.json');
const POST_DIR = join(ROOT, 'post');

const METRIC_LABELS = {
  posts: '글 작성 수',
  comments: '댓글 작성 수',
  recv: '추천 받은 수',
  given: '추천한 수',
};
const PERIODS = ['daily', 'weekly', 'monthly'];
const PERIOD_LABELS = { daily: '일간', weekly: '주간', monthly: '월간' };

/** KST wall-clock date('YYYY-MM-DD')/time('HH:MM') — Intl 기반, 외부 의존성 없음. */
function kst(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

let rankings;
try {
  rankings = JSON.parse(readFileSync(RANKINGS, 'utf8'));
} catch (e) {
  console.error(`[post-text] 오류: ${RANKINGS} 을(를) 읽을 수 없습니다 (${e.message})`);
  process.exit(1);
}

const gen = kst(new Date(rankings.generatedAt));
const lines = [];

// 제목 + 집계 기준 안내 (periods의 start/end는 본문에 넣지 않음 — 기준 시각만)
lines.push(`[스타대학 랭킹] ${gen.date} 기준 활동 TOP 10`);
lines.push('');
lines.push('집계 기준');
lines.push(`- 기준 시각: ${gen.date} ${gen.time} (KST)`);
lines.push('- 기간: 일간=오늘 00:00~현재, 주간=최근 7일, 월간=최근 30일 (KST)');
lines.push('- 데이터 출처: 공개 게시글·댓글·추천 정보');
lines.push('');

// 12개 표 (지표 4개 × 기간 3개, 기간 순서: 일간→주간→월간)
for (const metric of Object.keys(METRIC_LABELS)) {
  for (const period of PERIODS) {
    lines.push(`■ ${METRIC_LABELS[metric]} — ${PERIOD_LABELS[period]}`);
    const rows = rankings.top?.[metric]?.[period];
    if (!Array.isArray(rows) || rows.length === 0) {
      lines.push('(데이터 없음)');
    } else {
      for (const r of rows) {
        lines.push(`${r.rank}. ${r.nick} — ${r.count}`);
      }
    }
    lines.push('');
  }
}

// 하단 주석: 집계 방식 요약
lines.push('※ 집계 방식');
lines.push('- 정체성 병합: 닉네임을 변경해도 같은 사용자(회원 ID 기준)로 합산됩니다.');
lines.push('- 익명 댓글 제외: 비로그인(필명) 댓글 작성자는 순위에서 제외됩니다.');
lines.push('- 추천한 수는 하한값: 추천 0 이하인 글의 추천인은 수집되지 않아 실제보다 작을 수 있습니다.');
lines.push('- 모든 기간은 한국 표준시(KST) 기준 롤링 윈도우입니다.');

const text = lines.join('\n') + '\n';

// stdout 출력 (게시글 텍스트만)
process.stdout.write(text);

// 파일 저장: post/rankings-<YYYYMMDD-HHMM>.txt
mkdirSync(POST_DIR, { recursive: true });
const now = kst(new Date());
const stamp = `${now.date.replaceAll('-', '')}-${now.time.replace(':', '')}`;
const file = join(POST_DIR, `rankings-${stamp}.txt`);
writeFileSync(file, text, 'utf8');
console.error(`[post-text] 저장 완료: ${file}`);
