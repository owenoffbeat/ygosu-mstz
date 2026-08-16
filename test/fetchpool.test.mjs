// test/fetchpool.test.mjs — injected-fetch tests for backoff retries and concurrency cap
// No real network: fetchPool.configure({fetchImpl}) injects a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPool } from '../server.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeResponse(status, body = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    async text() {
      return body;
    },
    async json() {
      return JSON.parse(body);
    },
  };
}

test('retries 500 responses with backoff, then succeeds', async () => {
  let calls = 0;
  fetchPool.configure({
    fetchImpl: async () => {
      calls += 1;
      return calls < 3 ? fakeResponse(500) : fakeResponse(200, 'ok');
    },
    backoffMs: 1,
    delayMs: 0,
    maxRetries: 3,
  });
  const res = await fetchPool.fetch('http://example.test/');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
  assert.equal(calls, 3, '2 failures + 1 success');
});

test('retries 429 with backoff, then succeeds', async () => {
  let calls = 0;
  fetchPool.configure({
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? fakeResponse(429) : fakeResponse(200);
    },
    backoffMs: 1,
    delayMs: 0,
    maxRetries: 3,
  });
  const res = await fetchPool.fetch('http://example.test/');
  assert.equal(res.status, 200);
  assert.equal(calls, 2);
});

test('throws HttpError with .status after retries exhausted (5xx)', async () => {
  let calls = 0;
  fetchPool.configure({
    fetchImpl: async () => {
      calls += 1;
      return fakeResponse(503);
    },
    backoffMs: 1,
    delayMs: 0,
    maxRetries: 3,
  });
  await assert.rejects(fetchPool.fetch('http://example.test/'), (err) => {
    assert.ok(err instanceof Error);
    assert.equal(err.status, 503);
    return true;
  });
  assert.equal(calls, 4, '1 initial attempt + 3 retries');
});

test('throws plain Error after retries exhausted (network failure)', async () => {
  let calls = 0;
  fetchPool.configure({
    fetchImpl: async () => {
      calls += 1;
      throw new Error('ECONNRESET');
    },
    backoffMs: 1,
    delayMs: 0,
    maxRetries: 3,
  });
  await assert.rejects(fetchPool.fetch('http://example.test/'), /ECONNRESET/);
  assert.equal(calls, 4);
});

test('never exceeds max concurrency (cap 3)', async () => {
  let active = 0;
  let peak = 0;
  fetchPool.configure({
    fetchImpl: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(30);
      active -= 1;
      return fakeResponse(200);
    },
    delayMs: 0,
    maxRetries: 0,
    maxConcurrency: 3,
  });
  await Promise.all(Array.from({ length: 10 }, () => fetchPool.fetch('http://example.test/')));
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded cap 3`);
  assert.equal(peak, 3, 'pool should saturate up to the cap');
});

test('spaces request starts by at least delayMs (jitter floor)', async () => {
  const starts = [];
  fetchPool.configure({
    fetchImpl: async () => {
      starts.push(Date.now());
      return fakeResponse(200);
    },
    delayMs: 25,
    maxRetries: 0,
    maxConcurrency: 10,
  });
  await Promise.all(Array.from({ length: 5 }, () => fetchPool.fetch('http://example.test/')));
  const sorted = [...starts].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i] - sorted[i - 1];
    assert.ok(gap >= 20, `start gap ${gap}ms < 20ms (delayMs=25)`);
  }
});

test('sends fixed UA + Accept headers and merges caller headers', async () => {
  let seen = null;
  fetchPool.configure({
    fetchImpl: async (_url, opts) => {
      seen = opts.headers;
      return fakeResponse(200);
    },
    delayMs: 0,
    maxRetries: 0,
  });
  await fetchPool.fetch('http://example.test/', { headers: { 'X-Test': '1' } });
  assert.match(seen['User-Agent'], /ygosu-rank-dashboard\/1\.0/);
  assert.equal(seen['Accept'], 'text/html,application/xhtml+xml');
  assert.equal(seen['X-Test'], '1');
});