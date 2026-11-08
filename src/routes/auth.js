'use strict';

const crypto = require('node:crypto');
const { ApiError, validation, fieldError, readJson, send } = require('../http');

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

const base64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** POST /v1/auth/login (BE-019) inkl. Sperre nach 5 Fehlversuchen je E-Mail. */
async function login(ctx) {
  const { req, res, store, config } = ctx;
  const body = await readJson(req);
  const errors = [];
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email) errors.push(fieldError('email', 'must not be blank'));
  else if (email.length > 320) errors.push(fieldError('email', 'size must be between 0 and 320'));
  if (!password) errors.push(fieldError('password', 'must not be blank'));
  else if (password.length > 256) errors.push(fieldError('password', 'size must be between 0 and 256'));
  if (errors.length) throw validation(errors);

  const key = email.toLowerCase();
  const now = ctx.now.getTime();
  const failures = store.loginFailures.get(key);
  if (failures && now - failures.last > LOCK_MS) store.loginFailures.delete(key);
  const current = store.loginFailures.get(key);
  if (current && current.count >= MAX_FAILURES && now - current.last <= LOCK_MS) {
    const retryAfter = Math.ceil((LOCK_MS - (now - current.last)) / 1000);
    throw new ApiError(429, 'LOGIN_TEMPORARILY_LOCKED', 'Too many failed login attempts.', [], {
      'Retry-After': String(retryAfter),
    });
  }

  const account = store.admins.find((a) => a.email.toLowerCase() === key);
  const ok = account && account.password === password && account.status === 'ACTIVE' && account.roles.includes('ADMIN');
  if (!ok) {
    store.loginFailures.set(key, { count: (current?.count || 0) + 1, last: now });
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
  }
  store.loginFailures.delete(key);

  const expiresIn = config.tokenTtlSeconds;
  const iat = Math.floor(now / 1000);
  const claims = { iss: 'maridcam-mock', sub: account.email, email: account.email, roles: account.roles, iat, exp: iat + expiresIn, jti: crypto.randomUUID() };
  const accessToken = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims)}.mock`;
  store.tokens.set(accessToken, { email: account.email, roles: account.roles, expiresAt: now + expiresIn * 1000 });
  send(res, 200, { accessToken, tokenType: 'Bearer', expiresIn, roles: account.roles });
}

/** Prüft das Bearer-Token für /v1/admin/** und liefert die E-Mail des Admins. */
function requireAdmin(ctx) {
  const header = String(ctx.req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const session = token ? ctx.store.tokens.get(token) : null;
  if (!session || session.expiresAt <= ctx.now.getTime()) {
    if (session) ctx.store.tokens.delete(token);
    throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required.', [], { 'WWW-Authenticate': 'Bearer' });
  }
  if (!session.roles.includes('ADMIN')) throw new ApiError(403, 'FORBIDDEN', 'Access denied.');
  return session.email;
}

module.exports = { login, requireAdmin };
