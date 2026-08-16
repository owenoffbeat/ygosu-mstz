// test/dashboard.test.mjs — static verification for the single-file dashboard (T8)
//
// No browser is available in node:test, so this verifies the static contract
// of index.html directly:
//   1. 12 table containers exist (4 metrics x 3 periods, data-metric + data-period)
//   2. Zero external URL references (no http:// or https:// anywhere, incl. comments)
//   3. No external resource loading (no <link>, no @import, no CSS url())
//   4. fetch() calls use relative paths only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const METRICS = ['posts', 'comments', 'recv', 'given'];
const PERIODS = ['daily', 'weekly', 'monthly'];

test('index.html exists and is a single file with Korean title', () => {
  assert.ok(html.length > 1000, 'index.html should be substantial');
  assert.match(html, /<title>스타대학 활동 랭킹<\/title>/, 'Korean title missing');
  assert.match(html, /lang="ko"/, 'lang="ko" missing');
});

test('12 table containers exist (data-metric x data-period)', () => {
  for (const m of METRICS) {
    for (const p of PERIODS) {
      const re = new RegExp(
        `data-metric="${m}"[^>]*data-period="${p}"|data-period="${p}"[^>]*data-metric="${m}"`,
      );
      assert.match(html, re, `missing container data-metric="${m}" data-period="${p}"`);
    }
  }
  // containers carry BOTH attributes on the same element (card sections carry
  // only data-metric, so count only same-element pairs)
  const pairRe = /data-metric="[^"]*"[^>]*data-period="[^"]*"|data-period="[^"]*"[^>]*data-metric="[^"]*"/g;
  const pairs = html.match(pairRe) || [];
  assert.equal(pairs.length, 12, `expected 12 table containers, got ${pairs.length}`);
});

test('zero external URL references (http:// or https://, comments included)', () => {
  assert.doesNotMatch(html, /https?:\/\//, 'found an external URL reference');
});

test('no external resource loading (<link>, @import, CSS url())', () => {
  assert.doesNotMatch(html, /<link\b/i, 'found a <link> tag (external stylesheet/font)');
  assert.doesNotMatch(html, /@import/i, 'found CSS @import');
  assert.doesNotMatch(html, /url\(/i, 'found CSS url() reference');
  assert.doesNotMatch(html, /<script[^>]+src=/i, 'found external <script src>');
});

test('fetch() calls use relative paths only', () => {
  // fetch() is called with URL constants; verify the constants are relative
  const urlConsts = [
    ...html.matchAll(/(?:var|const|let)\s+(\w+_URL)\s*=\s*['"]([^'"]+)['"]/g),
  ].map((m) => m[2]);
  assert.ok(urlConsts.length >= 3, `expected at least 3 URL constants, got ${urlConsts.length}`);
  for (const u of urlConsts) {
    assert.ok(u.startsWith('/'), `URL constant must be server-relative: ${u}`);
    assert.doesNotMatch(u, /^\/\//, `protocol-relative URL constant: ${u}`);
  }
  // and every fetch() call site must exist
  const fetchCalls = (html.match(/fetch\(/g) || []).length;
  assert.ok(fetchCalls >= 3, `expected at least 3 fetch() calls, got ${fetchCalls}`);
  // no fetch() with an inline absolute URL either
  assert.doesNotMatch(html, /fetch\(\s*['"]https?:\/\//, 'fetch() with absolute URL found');
});

test('dashboard controls present (refresh button, progress bar, updated time)', () => {
  assert.match(html, /id="refresh-btn"/, 'refresh button missing');
  assert.match(html, /id="progress-fill"/, 'progress bar missing');
  assert.match(html, /id="updated"/, 'last-updated element missing');
  assert.match(html, /id="phase-label"/, 'phase label missing');
  assert.match(html, /\/api\/rankings/, 'rankings endpoint reference missing');
  assert.match(html, /\/api\/status/, 'status endpoint reference missing');
  assert.match(html, /\/api\/refresh/, 'refresh endpoint reference missing');
});

test('footer data definitions present', () => {
  assert.match(html, /데이터 정의/, 'footer heading missing');
  assert.match(html, /추천한 수 = 해당 기간에 작성된 글에 추천한 횟수/, 'given definition missing');
  assert.match(html, /추천 0 이하인 글의 추천자는 집계되지 않습니다/, 'vote-limit note missing');
  assert.match(html, /익명\(비로그인\) 댓글 작성자는 순위에서 제외/, 'anon note missing');
  assert.match(html, /한국 표준시\(KST\)/, 'KST note missing');
});