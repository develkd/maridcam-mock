'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { sign, verify } = require('../src/routes/auth');

const load = async () =>
  (await import(pathToFileURL(path.join(__dirname, '..', 'netlify', 'functions', 'api.mjs')).href)).default;

const call = (fn, method, urlPath, { body, headers } = {}) =>
  fn(new Request(`https://maridcam-mock.example${urlPath}`, { method, body, headers }));

test('Netlify Function: Login, Admin-Endpunkt mit Token, Fehlerformat, 204 ohne Body', async () => {
  const fn = await load();

  const login = await call(fn, 'POST', '/v1/auth/login', {
    body: JSON.stringify({ email: 'admin@maridcam.local', password: 'Admin-Dev-2026!' }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(login.status, 200);
  const { accessToken } = await login.json();

  const payers = await call(fn, 'GET', '/v1/admin/cash-payers?query=ahmet', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(payers.status, 200);
  assert.equal((await payers.json()).total, 2);

  const unauthorized = await call(fn, 'GET', '/v1/admin/cash-payers');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await unauthorized.json()).code, 'UNAUTHENTICATED');

  const reset = await call(fn, 'POST', '/__mock/reset');
  assert.equal(reset.status, 204);
  assert.equal(await reset.text(), '');
});

test('Netlify Function: Multipart-Upload und Datei-Download', async () => {
  const fn = await load();
  const login = await call(fn, 'POST', '/v1/auth/login', {
    body: JSON.stringify({ email: 'admin@maridcam.local', password: 'Admin-Dev-2026!' }),
    headers: { 'content-type': 'application/json' },
  });
  const auth = { authorization: `Bearer ${(await login.json()).accessToken}` };

  const form = new FormData();
  form.append('file', new Blob([Buffer.from('%PDF-1.4 netlify')], { type: 'application/pdf' }), 'beleg.pdf');
  const data = { receiptNumber: 'NF-1', receiptDate: '2026-01-05', amount: 30, months: ['2031-02'], payerName: 'Hatice Çelik' };
  form.append('data', new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const upload = await call(fn, 'POST', '/v1/admin/persons/5e0c1a00-0000-4000-8000-000000000004/cash-receipts', {
    body: form,
    headers: auth,
  });
  assert.equal(upload.status, 201);
  const receipt = await upload.json();

  const file = await call(fn, 'GET', `/v1/admin/cash-receipts/${receipt.receiptIdentifier}/file`, { headers: auth });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), '%PDF-1.4 netlify');
});

test('Tokens: signiert, ohne Speicher prüfbar, Manipulation wird erkannt', () => {
  const token = sign({ email: 'admin@maridcam.local', roles: ['ADMIN'], exp: 4102444800 }, 'geheim');
  assert.deepEqual(verify(token, 'geheim').roles, ['ADMIN']);
  assert.equal(verify(token, 'anderer-schluessel'), null);

  const [header, , signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ email: 'x', roles: ['ADMIN'], exp: 4102444800 })).toString('base64url');
  assert.equal(verify(`${header}.${forged}.${signature}`, 'geheim'), null);
  assert.equal(verify('kein.token', 'geheim'), null);
});
