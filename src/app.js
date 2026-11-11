'use strict';

const http = require('node:http');

const { ApiError, errorBody, send } = require('./http');
const { Store } = require('./store');
const { login } = require('./routes/auth');
const cash = require('./routes/cash-receipts');
const { registerStudent } = require('./routes/registration');
const { getPrayerTimes, getCalendarIcs } = require('./routes/prayer-times');

/** Einstellungen aus Umgebungsvariablen (siehe README). */
function configFromEnv(env = process.env) {
  return {
    port: Number(env.PORT || 8080),
    host: env.HOST || '127.0.0.1',
    delayMs: Number(env.MOCK_DELAY_MS || 0),
    tokenTtlSeconds: Number(env.MOCK_TOKEN_TTL_SECONDS || 3600),
    // Schlüssel für die Token-Signatur; nur Mockdaten, daher mit festem Standardwert
    tokenSecret: env.MOCK_TOKEN_SECRET || 'maridcam-mock-token-secret',
    prayerTimesUnavailable: env.MOCK_PRAYER_TIMES === 'unavailable',
    now: env.MOCK_NOW || '',
    allowedOrigins: (env.MOCK_CORS_ORIGINS || '*').split(',').map((o) => o.trim()),
  };
}

const ROUTES = [
  ['POST', /^\/v1\/auth\/login$/, (ctx) => login(ctx)],
  ['POST', /^\/v1\/student-registrations$/, (ctx) => registerStudent(ctx)],
  ['GET', /^\/v1\/prayer-times$/, (ctx) => getPrayerTimes(ctx)],
  ['GET', /^\/v1\/prayer-times\/calendar\.ics$/, (ctx) => getCalendarIcs(ctx)],
  ['GET', /^\/v1\/admin\/cash-payers$/, (ctx) => cash.searchCashPayers(ctx)],
  ['GET', /^\/v1\/admin\/persons\/([^/]+)\/cash-receipts$/, (ctx, id) => cash.listReceipts(ctx, id)],
  ['POST', /^\/v1\/admin\/persons\/([^/]+)\/cash-receipts$/, (ctx, id) => cash.uploadReceipt(ctx, id)],
  ['POST', /^\/v1\/admin\/cash-receipts\/([^/]+)\/cancellation$/, (ctx, id) => cash.cancelReceipt(ctx, id)],
  ['GET', /^\/v1\/admin\/cash-receipts\/([^/]+)\/file$/, (ctx, id) => cash.downloadFile(ctx, id)],
  // Hilfs-Endpunkte nur im Mock
  ['GET', /^\/__mock$/, (ctx) => mockInfo(ctx)],
  ['POST', /^\/__mock\/reset$/, (ctx) => mockReset(ctx)],
];

function mockInfo(ctx) {
  const { store, config } = ctx;
  send(ctx.res, 200, {
    name: 'maridcam-mock',
    now: ctx.now.toISOString(),
    settings: {
      delayMs: config.delayMs,
      tokenTtlSeconds: config.tokenTtlSeconds,
      prayerTimesUnavailable: config.prayerTimesUnavailable,
      fixedNow: config.now || null,
    },
    accounts: store.admins.map(({ email, password, roles, status, note }) => ({ email, password, roles, status, note })),
    counts: {
      persons: store.persons.length,
      cashPayers: store.persons.filter((p) => p.paymentMethod === 'CASH').length,
      receipts: store.receipts.length,
      cancelledReceipts: store.receipts.filter((r) => r.cancellation).length,
    },
  });
}

function mockReset(ctx) {
  ctx.store.reset();
  send(ctx.res, 204);
}

function corsHeaders(req, config) {
  const origin = req.headers.origin;
  if (!origin) return {};
  const allowed = config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin);
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Expose-Headers': 'Content-Disposition,Location,Retry-After',
    'Access-Control-Max-Age': '3600',
    Vary: 'Origin',
  };
}

/** Request-Handler (req, res) im Stil von node:http – genutzt vom lokalen Server und von der Netlify Function. */
function createHandler(config = configFromEnv()) {
  config = { tokenSecret: 'maridcam-mock-token-secret', ...config };
  const clock = () => (config.now ? new Date(config.now) : new Date());
  const store = new Store(clock);

  const handler = async (req, res) => {
    const cors = corsHeaders(req, config);
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, headers = {}) => originalWriteHead(status, { ...cors, ...headers });

    const url = new URL(req.url, 'http://mock.local');
    const now = clock();
    const started = Date.now();
    res.on('finish', () => {
      if (!config.quiet) console.log(`${req.method} ${url.pathname}${url.search} → ${res.statusCode} (${Date.now() - started} ms)`);
    });

    if (req.method === 'OPTIONS') {
      send(res, 204);
      return;
    }
    if (config.delayMs > 0 && !url.pathname.startsWith('/__mock')) {
      await new Promise((resolve) => setTimeout(resolve, config.delayMs));
    }

    const ctx = { req, res, url, store, config, now };
    try {
      const pathMatches = ROUTES.filter(([, pattern]) => pattern.test(url.pathname));
      const route = pathMatches.find(([method]) => method === req.method);
      if (!route) {
        if (pathMatches.length) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
        throw new ApiError(404, 'NOT_FOUND', 'Not found.');
      }
      const [, pattern, handler] = route;
      const params = pattern.exec(url.pathname).slice(1).map(decodeURIComponent);
      await handler(ctx, ...params);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof ApiError) {
        send(res, err.status, errorBody(err, now), err.headers);
      } else {
        console.error(err);
        send(res, 500, errorBody(new ApiError(500, 'INTERNAL_ERROR', 'Unexpected error.'), now));
      }
    }
  };

  return { handler, store, config };
}

function createApp(config = configFromEnv()) {
  const { handler, store, config: effective } = createHandler(config);
  return { server: http.createServer(handler), store, config: effective };
}

module.exports = { createApp, createHandler, configFromEnv };
