#!/usr/bin/env node
// tools/post-html.mjs — GitHub Pages 정적 대시보드 생성기 (zero-dep ESM)
//
// data/rankings.json 을 읽어 docs/ 에 Pages 용 출력 2개를 쓴다:
//   1. docs/rankings.json  — 데이터 사본 (JSON 그대로)
//   2. docs/index.html     — 자체완결 정적 대시보드 (외부 리소스 0, <style>+<script> 인라인)
//                            원본 index.html 의 UI(다크 테마, 지표 4×기간 3 탭, TOP10 표)를 재현.
//                            fetch 대상은 상대경로 ./rankings.json, 실패 시 배너+30초 재시도,
//                            성공 시 5분마다 자동 재조회로 화면 갱신.
//
// rankings.json 이 없거나 깨져 있으면 에러 + exit 1.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.YGOSU_DATA_DIR
  ? resolve(process.env.YGOSU_DATA_DIR)
  : join(ROOT, 'data');
const RANKINGS_FILE = join(DATA_DIR, 'rankings.json');
const DOCS_DIR = join(ROOT, 'docs');

let rankingsText;
try {
  rankingsText = readFileSync(RANKINGS_FILE, 'utf8');
} catch (e) {
  console.error(`[post-html] 오류: ${RANKINGS_FILE} 을(를) 읽을 수 없습니다 (${e.message})`);
  process.exit(1);
}
try {
  JSON.parse(rankingsText); // 깨진 JSON 은 여기서 실패 — exit 1
} catch (e) {
  console.error(`[post-html] 오류: ${RANKINGS_FILE} 이(가) 유효한 JSON 이 아닙니다 (${e.message})`);
  process.exit(1);
}

// ============================================================
// 카드 마크업 생성 (지표 4 × 기간 3 = 12개 테이블)
// ============================================================

const METRIC_CARDS = [
  {
    key: 'posts',
    label: '글작성수',
    icon:
      '<path d="M12 20h9"></path>' +
      '<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"></path>',
  },
  {
    key: 'comments',
    label: '댓글작성수',
    icon:
      '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>',
  },
  {
    key: 'given',
    label: '추천한 수',
    icon:
      '<path d="M7 10v12"></path>' +
      '<path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"></path>',
  },
  {
    key: 'recv',
    label: '추천받은 수',
    icon:
      '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>',
  },
];
const PERIODS = [
  { key: 'daily', label: '일간' },
  { key: 'weekly', label: '주간' },
  { key: 'monthly', label: '월간' },
];

function cardHtml(card) {
  const tabs = PERIODS.map((p, i) =>
    `<button class="tab${i === 0 ? ' is-active' : ''}" type="button" role="tab" ` +
    `aria-selected="${i === 0}" data-period="${p.key}">${p.label}</button>`,
  ).join('\n');
  const tables = PERIODS.map((p, i) =>
    `<div class="tbl" id="tbl-${card.key}-${p.key}" data-metric="${card.key}" data-period="${p.key}"${i === 0 ? '' : ' hidden'}>` +
    `<table><thead><tr><th class="c-rank">순위</th><th>닉네임</th>` +
    `<th class="c-count">개수</th></tr></thead><tbody></tbody></table>` +
    `<div class="tbl-empty" hidden></div></div>`,
  ).join('\n');
  return (
    `<section class="card" data-metric="${card.key}" aria-label="${card.label} 랭킹">\n` +
    `  <div class="card-head">\n` +
    `    <div class="card-title">\n` +
    `      <span class="card-icon" aria-hidden="true">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
    `stroke-linecap="round" stroke-linejoin="round">${card.icon}</svg></span>\n` +
    `      <h2>${card.label}</h2>\n` +
    `    </div>\n` +
    `    <div class="tabs" role="tablist" aria-label="기간 선택">\n${tabs}\n    </div>\n` +
    `  </div>\n${tables}\n</section>`
  );
}

const CARDS_HTML = METRIC_CARDS.map(cardHtml).join('\n\n');

// ============================================================
// 인라인 스크립트 — backtick / ${} 금지 (생성 템플릿 안에 들어가므로)
// ============================================================

const INLINE_SCRIPT = `(function () {
  'use strict';

  var RANKINGS_URL = 'https://owenoffbeat.github.io/ygosu-mstz/rankings.json?v=' + Date.now();
  var RETRY_MS = 30 * 1000;      // fetch 실패 시 재시도 간격
  var REFRESH_MS = 5 * 60 * 1000; // 성공 시 자동 재조회 간격 (새로고침 없이 최신 데이터)
  var METRICS = ['posts', 'comments', 'given', 'recv'];
  var PERIODS = ['daily', 'weekly', 'monthly'];
  var timer = null;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtKST(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var parts = new Intl.DateTimeFormat('ko-KR', {
      timeZone: 'Asia/Seoul',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(d);
    var get = function (t) {
      var hit = parts.filter(function (p) { return p.type === t; })[0];
      return hit ? hit.value : '';
    };
    return get('year') + '-' + get('month') + '-' + get('day') + ' ' +
      get('hour') + ':' + get('minute') + ':' + get('second');
  }

  var bannerEl = document.getElementById('banner');
  var bannerText = document.getElementById('banner-text');
  var updatedEl = document.getElementById('updated');

  function showBanner(msg) {
    bannerText.textContent = msg;
    bannerEl.hidden = false;
  }

  function hideBanner() {
    bannerEl.hidden = true;
  }

  function render(data) {
    if (!data || typeof data !== 'object') return;
    updatedEl.textContent = '마지막 갱신: ' + fmtKST(data.generatedAt);

    var givenUnavailable = !!(data.top && data.top.given && data.top.given.unavailable);

    METRICS.forEach(function (m) {
      PERIODS.forEach(function (p) {
        var box = document.getElementById('tbl-' + m + '-' + p);
        if (!box) return;
        var tbody = box.querySelector('tbody');
        var empty = box.querySelector('.tbl-empty');

        if (m === 'given' && givenUnavailable) {
          tbody.innerHTML = '';
          empty.textContent = '추천한 수 지표는 제공되지 않습니다';
          empty.hidden = false;
          return;
        }

        var rows = data.top && data.top[m] && data.top[m][p];
        if (!Array.isArray(rows) || rows.length === 0) {
          tbody.innerHTML = '';
          empty.textContent = '아직 데이터가 없습니다';
          empty.hidden = false;
          return;
        }

        empty.hidden = true;
        var max = 1;
        rows.forEach(function (r) {
          var c = Number(r.count) || 0;
          if (c > max) max = c;
        });

        tbody.innerHTML = rows.map(function (r) {
          var rank = Number(r.rank) || 0;
          var count = Number(r.count) || 0;
          var pct = Math.max(2, Math.round((count / max) * 100));
          var medal = rank >= 1 && rank <= 3 ? ' r' + rank : '';
          return '<tr>' +
            '<td class="c-rank"><span class="rank' + medal + '">' + rank + '</span></td>' +
            '<td class="c-nick" title="' + esc(r.nick) + '">' + esc(r.nick) + '</td>' +
            '<td class="c-count"><span class="bar"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
            '<span class="num">' + count + '</span></td>' +
            '</tr>';
        }).join('');
      });
    });
  }

  function schedule(delay) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(load, delay);
  }

  function load() {
    fetch(RANKINGS_URL)
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        hideBanner();
        render(data);
        schedule(REFRESH_MS); // 성공 시 5분 뒤 자동 재조회
      })
      .catch(function () {
        showBanner('랭킹 데이터를 불러오지 못했습니다 — 30초 후 자동으로 다시 시도합니다');
        schedule(RETRY_MS); // 실패 시 30초 뒤 자동 재시도
      });
  }

  // 기간 탭 전환
  Array.prototype.slice.call(document.querySelectorAll('.card')).forEach(function (card) {
    var tabs = card.querySelectorAll('.tab');
    var tables = card.querySelectorAll('.tbl');
    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var period = tab.getAttribute('data-period');
        tabs.forEach(function (t) {
          var on = t === tab;
          t.classList.toggle('is-active', on);
          t.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        tables.forEach(function (tbl) {
          tbl.hidden = tbl.getAttribute('data-period') !== period;
        });
      });
    });
  });

  load();
})();`;

// ============================================================
// 최종 HTML 조립
// ============================================================

const PAGE_HTML = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>스타대학 활동 랭킹</title>
<style>
  :root {
    --bg: #0c0f16;
    --bg-2: #101827;
    --card: #141a26;
    --card-2: #182030;
    --border: #232c3f;
    --border-soft: #1d2534;
    --text: #e9edf5;
    --text-dim: #9aa5b8;
    --text-faint: #66718a;
    --accent: #4f8cff;
    --accent-2: #2dd4bf;
    --gold: #f6c453;
    --silver: #c3ccda;
    --bronze: #d08a5a;
    --danger: #ff7a7a;
    --radius: 14px;
    --shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  [hidden] { display: none !important; }

  html { color-scheme: dark; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic",
      "Apple SD Gothic Neo", sans-serif;
    background: radial-gradient(1200px 600px at 85% -10%, var(--bg-2), transparent 60%),
      radial-gradient(900px 500px at -10% 110%, #101b2e, transparent 55%), var(--bg);
    color: var(--text);
    line-height: 1.5;
    min-height: 100vh;
    padding: 24px 16px 40px;
  }

  .wrap { max-width: 1080px; margin: 0 auto; }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 18px;
  }

  .brand { display: flex; align-items: center; gap: 14px; }

  .brand-mark {
    width: 46px;
    height: 46px;
    border-radius: 13px;
    display: grid;
    place-items: center;
    color: #fff;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    box-shadow: 0 6px 18px rgba(79, 140, 255, 0.35);
    flex: none;
  }

  .brand-mark svg { width: 24px; height: 24px; }

  h1 { font-size: 21px; font-weight: 800; letter-spacing: -0.02em; }

  .sub { font-size: 12.5px; color: var(--text-dim); margin-top: 2px; }

  .updated { font-size: 12.5px; color: var(--text-dim); font-variant-numeric: tabular-nums; }

  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    background: rgba(255, 122, 122, 0.08);
    border: 1px solid rgba(255, 122, 122, 0.4);
    color: var(--danger);
    font-size: 13px;
    font-weight: 600;
    border-radius: 12px;
    padding: 11px 14px;
    margin-bottom: 18px;
  }

  .banner svg { width: 16px; height: 16px; flex: none; }

  .banner[hidden] { display: none; }

  .cards {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;
  }

  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    box-shadow: var(--shadow);
    min-width: 0;
  }

  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 12px;
  }

  .card-title { display: flex; align-items: center; gap: 10px; }

  .card-icon {
    width: 34px;
    height: 34px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    color: #fff;
    background: linear-gradient(135deg, #2b3a5c, #1d2740);
    border: 1px solid var(--border);
    flex: none;
  }

  .card-icon svg { width: 17px; height: 17px; }

  .card h2 { font-size: 15px; font-weight: 800; letter-spacing: -0.01em; }

  .tabs {
    display: inline-flex;
    gap: 2px;
    background: #0e1320;
    border: 1px solid var(--border-soft);
    border-radius: 10px;
    padding: 3px;
  }

  .tab {
    border: 0;
    background: transparent;
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    font-weight: 700;
    padding: 5px 12px;
    border-radius: 7px;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }

  .tab:hover { color: var(--text); }

  .tab.is-active {
    background: linear-gradient(135deg, var(--accent), #3b6fd8);
    color: #fff;
  }

  .tbl table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
  }

  .tbl thead th {
    font-size: 11px;
    font-weight: 700;
    color: var(--text-faint);
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border);
    letter-spacing: 0.04em;
  }

  .tbl thead th.c-rank { width: 52px; }
  .tbl thead th.c-count { width: 46%; text-align: right; }

  .tbl tbody td {
    padding: 7px 8px;
    border-bottom: 1px solid var(--border-soft);
    font-size: 13px;
    vertical-align: middle;
  }

  .tbl tbody tr:last-child td { border-bottom: 0; }

  .tbl tbody tr { transition: background 0.12s ease; }

  .tbl tbody tr:hover { background: var(--card-2); }

  .c-rank { width: 52px; }

  .rank {
    display: inline-grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    font-size: 11.5px;
    font-weight: 800;
    color: var(--text-faint);
    background: transparent;
  }

  .rank.r1 {
    background: linear-gradient(135deg, #ffe08a, var(--gold));
    color: #3a2c05;
    box-shadow: 0 0 10px rgba(246, 196, 83, 0.45);
  }

  .rank.r2 {
    background: linear-gradient(135deg, #e8eef7, var(--silver));
    color: #2c3442;
    box-shadow: 0 0 8px rgba(195, 204, 218, 0.35);
  }

  .rank.r3 {
    background: linear-gradient(135deg, #e8a97e, var(--bronze));
    color: #3d2410;
    box-shadow: 0 0 8px rgba(208, 138, 90, 0.35);
  }

  .c-nick {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }

  .c-count { text-align: right; }

  .c-count .bar {
    display: inline-block;
    vertical-align: middle;
    width: calc(100% - 44px);
    max-width: 120px;
    height: 6px;
    border-radius: 3px;
    background: #0a0e16;
    border: 1px solid var(--border-soft);
    overflow: hidden;
  }

  .c-count .bar-fill {
    display: block;
    height: 100%;
    border-radius: 3px;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
    transition: width 0.4s ease;
  }

  .c-count .num {
    display: inline-block;
    width: 36px;
    text-align: right;
    font-size: 12.5px;
    font-weight: 700;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .tbl-empty {
    padding: 26px 10px;
    text-align: center;
    font-size: 12.5px;
    color: var(--text-faint);
  }

  @media (max-width: 760px) {
    body { padding: 16px 10px 32px; }
    .topbar { flex-direction: column; align-items: flex-start; }
    .cards { grid-template-columns: 1fr; }
    .card-head { flex-direction: column; align-items: flex-start; }
    .tabs { width: 100%; }
    .tab { flex: 1; text-align: center; }
    .tbl thead th.c-count { width: 40%; }
    h1 { font-size: 18px; }
  }

  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<div class="wrap">

  <header class="topbar">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
          stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="20" x2="12" y2="10"></line>
          <line x1="18" y1="20" x2="18" y2="4"></line>
          <line x1="6" y1="20" x2="6" y2="16"></line>
        </svg>
      </span>
      <div>
        <h1>스타대학 활동 랭킹</h1>
      </div>
    </div>
    <span class="updated" id="updated">마지막 갱신: —</span>
  </header>

  <div class="banner" id="banner" hidden>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="8" x2="12" y2="12"></line>
      <line x1="12" y1="16" x2="12.01" y2="16"></line>
    </svg>
    <span id="banner-text">랭킹 데이터를 불러오지 못했습니다.</span>
  </div>

  <main class="cards" id="cards">
${CARDS_HTML}
  </main>

</div>

<script>
${INLINE_SCRIPT}
</script>
</body>
</html>
`;

mkdirSync(DOCS_DIR, { recursive: true });
copyFileSync(RANKINGS_FILE, join(DOCS_DIR, 'rankings.json'));
writeFileSync(join(DOCS_DIR, 'index.html'), PAGE_HTML, 'utf8');
console.log(`[post-html] 생성 완료: ${join(DOCS_DIR, 'index.html')}, ${join(DOCS_DIR, 'rankings.json')}`);
