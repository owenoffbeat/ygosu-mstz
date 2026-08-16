#!/usr/bin/env node
// server.mjs — zero-dependency HTTP server + rate-limited fetch pool + JSONL/state store
// ygosu-rank-dashboard (T2). Node >= 18. ESM (.mjs), no package.json, no external deps.
//
// Modules (exported for reuse by T3-T7):
//   config     — environment variables (YGOSU_*)
//   fetchPool  — Promise semaphore + start-interval jitter + backoff retry
//   store      — data/events.jsonl append + data/state.json atomic write/load
//   server     — node:http routing (/, /api/health, 404 JSON)
//   HttpError  — HTTP failure marker with .status (vs plain Error = network failure)

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ============================================================
// config — environment variables
// ============================================================

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) {
    console.warn(`[config] invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
    return fallback;
  }
  return n;
}

const config = {
  port: intEnv('YGOSU_PORT', 8787),
  windowDays: intEnv('YGOSU_WINDOW_DAYS', 30),
  maxConcurrency: intEnv('YGOSU_MAX_CONCURRENCY', 3),
  delayMs: intEnv('YGOSU_DELAY_MS', 150),
  maxPages: intEnv('YGOSU_MAX_PAGES', 3000),
  maxRetries: intEnv('YGOSU_MAX_RETRIES', 3),
  cookie: process.env.YGOSU_COOKIE || null, // optional session cookie (contingency path)
};

// ============================================================
// fetchPool — Promise semaphore + start-interval jitter + backoff retry
// ============================================================

const UA =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Mobile Safari/537.36 ygosu-rank-dashboard/1.0';

/** HTTP-level failure after retries exhausted; .status distinguishes it from network errors. */
class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchPool = {
  _fetchImpl: globalThis.fetch,
  _maxConcurrency: config.maxConcurrency,
  _delayMs: config.delayMs,
  _maxRetries: config.maxRetries,
  _backoffMs: 1000, // retry backoff base: 1s/3s/9s (overridable for tests)
  _active: 0,
  _waiters: [],
  _lastStart: 0,

  /** Override pool settings (tests inject fake fetch + fast timings here). */
  configure(opts = {}) {
    if (opts.maxConcurrency !== undefined) this._maxConcurrency = opts.maxConcurrency;
    if (opts.delayMs !== undefined) this._delayMs = opts.delayMs;
    if (opts.maxRetries !== undefined) this._maxRetries = opts.maxRetries;
    if (opts.backoffMs !== undefined) this._backoffMs = opts.backoffMs;
    if (opts.fetchImpl !== undefined) this._fetchImpl = opts.fetchImpl;
  },

  async _acquire() {
    if (this._active >= this._maxConcurrency) {
      await new Promise((resolve) => this._waiters.push(resolve));
    }
    this._active += 1;
  },

  _release() {
    this._active -= 1;
    const next = this._waiters.shift();
    if (next) next();
  },

  // Space request STARTS by delayMs..2*delayMs (jitter). First request starts immediately.
  async _waitTurn() {
    const jitter = this._delayMs + Math.random() * this._delayMs;
    const startAt = Math.max(this._lastStart + jitter, Date.now());
    this._lastStart = startAt;
    const wait = startAt - Date.now();
    if (wait > 0) await sleep(wait);
  },

  /**
   * fetch(url, {method, headers, body}) -> Response-like {status, ok, headers, text(), json()}
   *
   * - Never more than maxConcurrency in flight; request starts spaced delayMs..2*delayMs apart.
   * - Retries 429 / 5xx / network errors with 1s/3s/9s backoff, up to maxRetries times.
   * - Final failure: throws HttpError (has .status) for HTTP errors, plain Error for network errors.
   */
  async fetch(url, { method = 'GET', headers = {}, body } = {}) {
    await this._acquire();
    try {
      await this._waitTurn();
      const reqHeaders = {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        ...headers,
      };
      if (config.cookie) reqHeaders.Cookie = config.cookie;

      let lastError = null;
      for (let attempt = 0; attempt <= this._maxRetries; attempt += 1) {
        try {
          const res = await this._fetchImpl(url, { method, headers: reqHeaders, body });
          if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
            lastError = new HttpError(`HTTP ${res.status} for ${url}`, res.status);
          } else {
            return res;
          }
        } catch (err) {
          lastError = err; // network-level failure
        }
        if (attempt < this._maxRetries) {
          await sleep(this._backoffMs * 3 ** attempt); // 1s, 3s, 9s
        }
      }
      throw lastError;
    } finally {
      this._release();
    }
  },
};

// ============================================================
// store — JSONL event log + atomic state persistence
// ============================================================

const DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url));
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const store = {
  /** Append one event object as a JSON line to data/events.jsonl (append-only). */
  async appendEvent(obj) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(EVENTS_FILE, `${JSON.stringify(obj)}\n`, 'utf8');
  },

  /** Load data/state.json; returns {} when missing or corrupt (events.jsonl stays source of truth). */
  async loadState() {
    try {
      return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      console.warn(`[store] state.json unreadable (${err.message}); starting fresh`);
      return {};
    }
  },

  /** Atomically write data/state.json (tmp file + rename). */
  async saveState(obj) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, STATE_FILE);
  },
};

// ============================================================
// server — node:http routing
// ============================================================

const INDEX_FILE = fileURLToPath(new URL('./index.html', import.meta.url));

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function serveIndex(res) {
  let html;
  try {
    html = await fs.readFile(INDEX_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html not found — dashboard not built yet (planned in T8)');
      return;
    }
    throw err;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/') return serveIndex(res);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, node: process.version });
  }
  return sendJson(res, 404, { error: 'not found', path: url.pathname });
}

const server = {
  start() {
    const httpServer = http.createServer((req, res) => {
      route(req, res).catch((err) => {
        console.error('[server] route error:', err);
        sendJson(res, 500, { error: 'internal server error' });
      });
    });
    httpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[server] ERROR: port ${config.port} is already in use — set YGOSU_PORT to a free port`,
        );
        process.exit(1);
      }
      throw err;
    });
    httpServer.listen(config.port, () => {
      console.log(`[server] ygosu-rank-dashboard listening on http://localhost:${config.port}`);
    });
    return httpServer;
  },
};

// Start only when executed directly (node server.mjs), not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.start();
}

export { config, fetchPool, store, server, HttpError };