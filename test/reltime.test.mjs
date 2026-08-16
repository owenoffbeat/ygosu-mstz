// test/reltime.test.mjs — T4 relative-time parser tests
// All relative units + absolute formats -> KST calendar day.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRelativeTime } from '../lib/reltime.js';

// Fixed reference: 2026-08-16 21:00 KST (fixture capture day).
const NOW = new Date('2026-08-16T12:00:00Z');

test('방금 전 -> today (0 minutes)', () => {
  assert.equal(parseRelativeTime('방금 전', NOW), '2026-08-16');
  assert.equal(parseRelativeTime('방금', NOW), '2026-08-16');
});

test('N분 전', () => {
  assert.equal(parseRelativeTime('5분 전', NOW), '2026-08-16');
  assert.equal(parseRelativeTime('59분 전', NOW), '2026-08-16');
});

test('N시간 전', () => {
  assert.equal(parseRelativeTime('3시간 전', NOW), '2026-08-16');
  assert.equal(parseRelativeTime('20시간 전', NOW), '2026-08-16', '21:00 KST - 20h = 01:00 KST same day');
  assert.equal(parseRelativeTime('22시간 전', NOW), '2026-08-15', '21:00 KST - 22h = 23:00 KST prev day');
});

test('N일 전', () => {
  assert.equal(parseRelativeTime('1일 전', NOW), '2026-08-15');
  assert.equal(parseRelativeTime('30일 전', NOW), '2026-07-17', 'matches fixture article ts 26-07-17');
});

test('N주 전 = N*7일', () => {
  assert.equal(parseRelativeTime('1주 전', NOW), '2026-08-09');
  assert.equal(parseRelativeTime('2주 전', NOW), '2026-08-02');
});

test('N개월 전 = N*30일', () => {
  assert.equal(parseRelativeTime('1개월 전', NOW), '2026-07-17');
  assert.equal(parseRelativeTime('2개월 전', NOW), '2026-06-17');
});

test('N년 전 = N*365일', () => {
  assert.equal(parseRelativeTime('1년 전', NOW), '2025-08-16');
});

test('absolute formats YY.MM.DD and YY.MM.DD HH:MM', () => {
  assert.equal(parseRelativeTime('26.07.17', NOW), '2026-07-17');
  assert.equal(parseRelativeTime('26.07.17 22:59', NOW), '2026-07-17');
});

test('whitespace tolerated, invalid -> null', () => {
  assert.equal(parseRelativeTime(' 30일 전 ', NOW), '2026-07-17');
  assert.equal(parseRelativeTime('garbage', NOW), null);
  assert.equal(parseRelativeTime('', NOW), null);
  assert.equal(parseRelativeTime(null, NOW), null);
});