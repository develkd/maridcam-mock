'use strict';

/**
 * Vertragstest gegen die API-Beschreibung des Backends (api/openapi.json, Kopie von
 * maridcam-backend/docs/api/openapi.json):
 *  1. Jeder Endpunkt des Backends hat hier ein Beispiel (SAMPLES) und ist im Mock nachgebildet.
 *  2. Die Antwort des Mocks hat genau die Felder des Backend-Schemas (keine fehlenden, keine zusätzlichen)
 *     mit passenden Typen.
 * Kommt im Backend ein Endpunkt oder Feld dazu, schlägt dieser Test fehl, bis der Mock nachgezogen ist.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../src/app');
const { pdfFromLines } = require('../src/pdf');

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api', 'openapi.json'), 'utf8'));
const NOW = '2026-11-08T14:00:00Z';
const OMER = '5e0c1a00-0000-4000-8000-000000000004';
const MERYEM_VALID_RECEIPT = 'c0ffee00-0000-4000-8000-000000000009';

let app;
let base;

before(async () => {
  app = createApp({ port: 0, delayMs: 0, tokenTtlSeconds: 3600, prayerTimesUnavailable: false, now: NOW, allowedOrigins: ['*'], quiet: true });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => new Promise((resolve) => app.server.close(resolve)));

async function token() {
  const res = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@maridcam.local', password: 'Admin-Dev-2026!' }),
  });
  return (await res.json()).accessToken;
}

const postJson = (url, body, auth) =>
  fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
  });

const getAuth = async (url) => fetch(base + url, { headers: { Authorization: `Bearer ${await token()}` } });

/**
 * Ein erfolgreicher Beispielaufruf je Endpunkt des Backends ("METHODE /pfad" wie in openapi.json).
 * Neuer Endpunkt im Backend → hier ein Beispiel ergänzen und den Endpunkt in src/routes/ nachbilden.
 */
const SAMPLES = {
  'POST /v1/auth/login': () => postJson('/v1/auth/login', { email: 'admin@maridcam.local', password: 'Admin-Dev-2026!' }),
  'POST /v1/student-registrations': () =>
    postJson('/v1/student-registrations', {
      email: 'vertrag@example.com',
      person: {
        firstName: 'Vertrag',
        lastName: 'Test',
        dateOfBirth: '1990-01-01',
        gender: 'MALE',
        phoneNumber: '+49 30 1234567',
        address: { street: 'Weg', houseNumber: '1', postalCode: '12107', city: 'Berlin', country: 'Deutschland' },
      },
      address: { street: 'Weg', houseNumber: '1', postalCode: '12107', city: 'Berlin', country: 'Deutschland' },
      privacyAccepted: true,
      termsAccepted: true,
      paymentMethod: 'SEPA_DIRECT_DEBIT',
      bank: { contributionAmount: 25, iban: 'DE89370400440532013000', accountHolder: 'Vertrag Test' },
      sepaConsent: true,
    }),
  'GET /v1/prayer-times': () => fetch(`${base}/v1/prayer-times`),
  'GET /v1/admin/cash-payers': () => getAuth('/v1/admin/cash-payers?query=demir'),
  'GET /v1/admin/persons/{personIdentifier}/cash-receipts': () =>
    getAuth('/v1/admin/persons/5e0c1a00-0000-4000-8000-000000000007/cash-receipts'),
  'POST /v1/admin/persons/{personIdentifier}/cash-receipts': async () => {
    const form = new FormData();
    form.append('file', new Blob([pdfFromLines([[12, 'Vertrag']])], { type: 'application/pdf' }), 'vertrag.pdf');
    const data = { receiptNumber: 'V-1', receiptDate: '2026-11-08', amount: 30, months: ['2026-11'], payerName: 'Hatice Çelik' };
    form.append('data', new Blob([JSON.stringify(data)], { type: 'application/json' }));
    return fetch(`${base}/v1/admin/persons/${OMER}/cash-receipts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}` },
      body: form,
    });
  },
  'POST /v1/admin/cash-receipts/{receiptIdentifier}/cancellation': async () =>
    postJson(`/v1/admin/cash-receipts/${MERYEM_VALID_RECEIPT}/cancellation`, { reason: 'Vertragstest' }, await token()),
  'GET /v1/admin/cash-receipts/{receiptIdentifier}/file': () => getAuth(`/v1/admin/cash-receipts/${MERYEM_VALID_RECEIPT}/file`),
};

/** Endpunkte, die nur der Mock hat (nicht in openapi.json des Backends). */
const MOCK_ONLY = ['GET /v1/prayer-times/calendar.ics', 'GET /__mock', 'POST /__mock/reset'];

const operations = Object.entries(SPEC.paths).flatMap(([p, ops]) =>
  Object.entries(ops)
    .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
    .map(([method, op]) => ({ key: `${method.toUpperCase()} ${p}`, op }))
);

const resolve = (schema) => {
  let s = schema;
  while (s && s.$ref) s = s.$ref.split('/').slice(1).reduce((node, part) => node[part], SPEC);
  return s || {};
};

/** Vergleicht einen JSON-Wert mit dem Schema; liefert Abweichungen als Text. */
function mismatches(value, schema, where = '$') {
  const s = resolve(schema);
  if (value === null || value === undefined) return []; // springdoc markiert nullable Felder nicht zuverlässig
  const type = s.type || (s.properties ? 'object' : undefined);
  if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) return [`${where}: Objekt erwartet`];
    if (s.properties) {
      const expected = Object.keys(s.properties).sort();
      const actual = Object.keys(value).sort();
      const missing = expected.filter((k) => !actual.includes(k)).map((k) => `${where}.${k}: fehlt im Mock`);
      const extra = actual.filter((k) => !expected.includes(k)).map((k) => `${where}.${k}: nicht im Backend`);
      const nested = expected
        .filter((k) => actual.includes(k))
        .flatMap((k) => mismatches(value[k], s.properties[k], `${where}.${k}`));
      return [...missing, ...extra, ...nested];
    }
    if (s.additionalProperties && typeof s.additionalProperties === 'object') {
      return Object.entries(value).flatMap(([k, v]) => mismatches(v, s.additionalProperties, `${where}[${k}]`));
    }
    return [];
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return [`${where}: Liste erwartet`];
    return value.slice(0, 3).flatMap((v, i) => mismatches(v, s.items, `${where}[${i}]`));
  }
  if (type === 'string') return typeof value === 'string' ? [] : [`${where}: Text erwartet`];
  if (type === 'integer') return Number.isInteger(value) ? [] : [`${where}: Ganzzahl erwartet`];
  if (type === 'number') return typeof value === 'number' ? [] : [`${where}: Zahl erwartet`];
  if (type === 'boolean') return typeof value === 'boolean' ? [] : [`${where}: true/false erwartet`];
  return [];
}

test('Jeder Endpunkt des Backends ist im Mock nachgebildet und hat ein Beispiel', () => {
  const missing = operations.map((o) => o.key).filter((key) => !SAMPLES[key]);
  assert.deepEqual(missing, [], `Neue Endpunkte im Backend ohne Mock/Beispiel: ${missing.join(', ')}`);
  const stale = Object.keys(SAMPLES).filter((key) => !operations.some((o) => o.key === key));
  assert.deepEqual(stale, [], `Beispiele für Endpunkte, die es im Backend nicht mehr gibt: ${stale.join(', ')}`);
});

for (const { key, op } of operations) {
  test(`Antwort passt zum Backend-Schema: ${key}`, { skip: !SAMPLES[key] && 'kein Beispiel' }, async () => {
    app.store.reset();
    const res = await SAMPLES[key]();
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(res.status >= 200 && res.status < 300, `${key}: Status ${res.status} – ${body.toString('utf8', 0, 500)}`);
    const content = op.responses?.['200']?.content || op.responses?.['201']?.content || {};
    const schema = (content['application/json'] || content['*/*'])?.schema;
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    if (!schema || !isJson) return; // z. B. Datei-Download
    const problems = mismatches(JSON.parse(body.toString('utf8')), schema);
    assert.deepEqual(problems, [], `${key}:\n  ${problems.join('\n  ')}`);
  });
}

test('Mock-eigene Endpunkte sind dokumentiert', () => {
  for (const key of MOCK_ONLY) assert.ok(!operations.some((o) => o.key === key), `${key} gibt es jetzt im Backend`);
});
