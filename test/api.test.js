'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/app');
const { pdfFromLines } = require('../src/pdf');

// Feste Zeit, damit Platzhalter, Monate und „nächstes Gebet“ stabil sind: 8. Nov. 2026, 15:00 Berlin
const NOW = '2026-11-08T14:00:00Z';
const ELIF = '5e0c1a00-0000-4000-8000-000000000001';
const MERYEM = '5e0c1a00-0000-4000-8000-000000000007';
const OMER = '5e0c1a00-0000-4000-8000-000000000004';
const MAX_SEPA = '5e0c1a00-0000-4000-8000-000000000025';

let app;
let base;

before(async () => {
  app = createApp({ port: 0, delayMs: 0, tokenTtlSeconds: 3600, prayerTimesUnavailable: false, now: NOW, allowedOrigins: ['*'], quiet: true });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => new Promise((resolve) => app.server.close(resolve)));

beforeEach(() => app.store.reset());

const json = (method, path, body, token) =>
  fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function adminToken() {
  const res = await json('POST', '/v1/auth/login', { email: 'admin@maridcam.local', password: 'Admin-Dev-2026!' });
  return (await res.json()).accessToken;
}

function upload(token, personId, data, file = pdfFromLines([[12, 'Test']]), fileName = 'quittung.pdf') {
  const form = new FormData();
  form.append('file', new Blob([file], { type: 'application/pdf' }), fileName);
  form.append('data', new Blob([JSON.stringify(data)], { type: 'application/json' }));
  return fetch(`${base}/v1/admin/persons/${personId}/cash-receipts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
}

const receiptData = (overrides = {}) => ({
  receiptNumber: 'q-9001',
  receiptDate: '2026-11-08',
  amount: 30,
  months: ['2026-11'],
  payerName: 'Hatice Çelik',
  ...overrides,
});

test('Login: Erfolg liefert Token, falsches Passwort 401, nach 5 Fehlversuchen 429', async () => {
  const ok = await json('POST', '/v1/auth/login', { email: ' ADMIN@maridcam.local ', password: 'Admin-Dev-2026!' });
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.tokenType, 'Bearer');
  assert.equal(body.expiresIn, 3600);
  assert.deepEqual(body.roles, ['ADMIN']);

  for (let i = 0; i < 5; i++) {
    const res = await json('POST', '/v1/auth/login', { email: 'admin@maridcam.local', password: 'falsch' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'INVALID_CREDENTIALS');
  }
  const locked = await json('POST', '/v1/auth/login', { email: 'admin@maridcam.local', password: 'Admin-Dev-2026!' });
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).code, 'LOGIN_TEMPORARILY_LOCKED');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
});

test('Login: Konto ohne ADMIN und gesperrtes Konto werden abgelehnt, leere Felder 400', async () => {
  for (const [email, password] of [['lehrer@maridcam.local', 'Lehrer-Dev-2026!'], ['gesperrt@maridcam.local', 'Gesperrt-Dev-2026!']]) {
    const res = await json('POST', '/v1/auth/login', { email, password });
    assert.equal(res.status, 401);
  }
  const res = await json('POST', '/v1/auth/login', { email: '', password: '' });
  assert.equal(res.status, 400);
  const fields = (await res.json()).fieldErrors.map((f) => f.field);
  assert.deepEqual(fields, ['email', 'password']);
});

test('Admin-Endpunkte ohne Token: 401 UNAUTHENTICATED mit WWW-Authenticate', async () => {
  const res = await fetch(`${base}/v1/admin/cash-payers`);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await res.json()).code, 'UNAUTHENTICATED');
});

test('Barzahler: nur CASH, sortiert, mit Seiten und Suche über Erziehungsberechtigte', async () => {
  const token = await adminToken();
  const first = await (await json('GET', '/v1/admin/cash-payers', undefined, token)).json();
  assert.equal(first.total, 24);
  assert.equal(first.items.length, 20);
  assert.equal(first.items[0].lastName, 'Ahmadi');
  assert.ok(!first.items.some((p) => p.personIdentifier === MAX_SEPA));
  const second = await (await json('GET', '/v1/admin/cash-payers?page=1&size=20', undefined, token)).json();
  assert.equal(second.items.length, 4);

  const search = await (await json('GET', '/v1/admin/cash-payers?query=hatice', undefined, token)).json();
  assert.deepEqual(search.items.map((p) => p.firstName), ['Ömer']);
  assert.equal(search.items[0].payerName, 'Hatice Çelik');

  const elif = (await (await json('GET', '/v1/admin/cash-payers?query=Elif%20Demir', undefined, token)).json()).items[0];
  assert.deepEqual(elif.paidMonths, ['2026-09', '2026-10', '2026-11']);

  const invalid = await json('GET', '/v1/admin/cash-payers?size=0', undefined, token);
  assert.equal(invalid.status, 400);
});

test('Quittungsliste: neueste zuerst, stornierte bleiben sichtbar und zählen nicht als bezahlt', async () => {
  const token = await adminToken();
  const list = await (await json('GET', `/v1/admin/persons/${MERYEM}/cash-receipts`, undefined, token)).json();
  assert.deepEqual(list.map((r) => [r.receiptNumber, r.status]), [['Q-1029', 'CANCELLED'], ['Q-1016', 'VALID']]);
  assert.ok(list[0].cancellationReason);
  const meryem = (await (await json('GET', '/v1/admin/cash-payers?query=meryem', undefined, token)).json()).items[0];
  assert.deepEqual(meryem.paidMonths, ['2026-10']);

  const unknown = await json('GET', '/v1/admin/persons/5e0c1a00-0000-4000-8000-000000000999/cash-receipts', undefined, token);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, 'PERSON_NOT_FOUND');
});

test('Upload: 201, Nummer in Großbuchstaben, danach als bezahlt; Fehlerfälle wie im Backend', async () => {
  const token = await adminToken();
  const res = await upload(token, OMER, receiptData());
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.receiptNumber, 'Q-9001');
  assert.equal(created.uploadedBy, 'admin@maridcam.local');
  assert.equal(created.status, 'VALID');
  assert.match(res.headers.get('location'), /\/file$/);

  const file = await fetch(`${base}/v1/admin/cash-receipts/${created.receiptIdentifier}/file`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.ok((await file.arrayBuffer()).byteLength > 100);

  const duplicateNumber = await upload(token, OMER, receiptData({ months: ['2026-12'] }));
  assert.equal(duplicateNumber.status, 409);
  assert.equal((await duplicateNumber.json()).code, 'RECEIPT_NUMBER_ALREADY_EXISTS');

  const monthPaid = await upload(token, OMER, receiptData({ receiptNumber: 'Q-9002' }));
  assert.equal(monthPaid.status, 409);
  assert.deepEqual(await monthPaid.json().then((b) => [b.code, b.fieldErrors[0].field]), ['MONTH_ALREADY_PAID', 'months']);

  const future = await upload(token, OMER, receiptData({ receiptNumber: 'Q-9003', receiptDate: '2026-11-09', months: ['2026-12'] }));
  assert.equal(future.status, 400);
  assert.equal((await future.json()).fieldErrors[0].field, 'receiptDate');

  const notCash = await upload(token, MAX_SEPA, receiptData({ receiptNumber: 'Q-9004' }));
  assert.equal(notCash.status, 409);
  assert.equal((await notCash.json()).code, 'PAYMENT_METHOD_NOT_CASH');

  const wrongType = await upload(token, OMER, receiptData({ receiptNumber: 'Q-9005', months: ['2027-01'] }), Buffer.from('kein Bild'), 'notiz.txt');
  assert.equal(wrongType.status, 415);
  assert.equal((await wrongType.json()).code, 'UNSUPPORTED_FILE_TYPE');

  const invalid = await upload(token, OMER, receiptData({ receiptNumber: '', amount: 0, months: [] }));
  assert.equal(invalid.status, 400);
  assert.deepEqual((await invalid.json()).fieldErrors.map((f) => f.field), ['receiptNumber', 'amount', 'months']);
});

test('Storno: setzt Status, gibt Monat frei, zweites Storno 409', async () => {
  const token = await adminToken();
  const elifReceipts = await (await json('GET', `/v1/admin/persons/${ELIF}/cash-receipts`, undefined, token)).json();
  const november = elifReceipts.find((r) => r.months.includes('2026-11'));

  const empty = await json('POST', `/v1/admin/cash-receipts/${november.receiptIdentifier}/cancellation`, { reason: '  ' }, token);
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).fieldErrors[0].field, 'reason');

  const res = await json('POST', `/v1/admin/cash-receipts/${november.receiptIdentifier}/cancellation`, { reason: ' Falsche Person ' }, token);
  assert.equal(res.status, 200);
  const cancelled = await res.json();
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.cancellationReason, 'Falsche Person');
  assert.equal(cancelled.cancelledAt, '2026-11-08T14:00:00Z');

  const again = await json('POST', `/v1/admin/cash-receipts/${november.receiptIdentifier}/cancellation`, { reason: 'nochmal' }, token);
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, 'RECEIPT_ALREADY_CANCELLED');

  const reupload = await upload(token, ELIF, receiptData({ receiptNumber: 'Q-9100', payerName: 'Ahmet Demir', amount: 25 }));
  assert.equal(reupload.status, 201);
});

const registration = (overrides = {}) => ({
  email: 'neu@example.com',
  person: {
    firstName: 'Neue',
    lastName: 'Schülerin',
    dateOfBirth: '2014-05-05',
    gender: 'FEMALE',
    phoneNumber: '+49 30 1234567',
    address: { street: 'Mariendorfer Damm', houseNumber: '1', postalCode: '12107', city: 'Berlin', country: 'Deutschland' },
  },
  address: { street: 'Mariendorfer Damm', houseNumber: '1', postalCode: '12107', city: 'Berlin', country: 'Deutschland' },
  guardian: { firstName: 'Neuer', lastName: 'Vater', email: 'vater@example.com', phoneNumber: '+49 176 1234567' },
  privacyAccepted: true,
  termsAccepted: true,
  paymentMethod: 'CASH',
  bank: { contributionAmount: 25 },
  sepaConsent: false,
  ...overrides,
});

test('Anmeldung: 201; Barzahler erscheint danach in der Suche; E-Mail doppelt 409', async () => {
  const res = await json('POST', '/v1/student-registrations', registration());
  assert.equal(res.status, 201);
  assert.equal((await res.json()).accountStatus, 'PENDING_EMAIL_VERIFICATION');

  const token = await adminToken();
  const found = await (await json('GET', '/v1/admin/cash-payers?query=neuer%20vater', undefined, token)).json();
  assert.equal(found.total, 1);
  assert.deepEqual(found.items[0].paidMonths, []);

  const again = await json('POST', '/v1/student-registrations', registration({ email: 'NEU@example.com' }));
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, 'EMAIL_ALREADY_REGISTERED');
});

test('Anmeldung: Regeln für Erziehungsberechtigte, SEPA und Einwilligungen', async () => {
  const noGuardian = await json('POST', '/v1/student-registrations', registration({ guardian: undefined }));
  assert.equal(noGuardian.status, 400);
  assert.equal((await noGuardian.json()).fieldErrors[0].field, 'guardian');

  const sepa = registration({ paymentMethod: 'SEPA_DIRECT_DEBIT', bank: { contributionAmount: 25, iban: 'DE00123', accountHolder: 'X' }, sepaConsent: true });
  const badIban = await json('POST', '/v1/student-registrations', sepa);
  assert.equal(badIban.status, 400);
  assert.equal((await badIban.json()).fieldErrors[0].field, 'bank.iban');

  const noMandate = registration({ paymentMethod: 'SEPA_DIRECT_DEBIT', bank: { contributionAmount: 25, iban: 'DE89 3704 0044 0532 0130 00', accountHolder: 'X' }, sepaConsent: false });
  const missing = await json('POST', '/v1/student-registrations', noMandate);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, 'REQUIRED_CONSENT_MISSING');
});

test('Gebetszeiten: heutige Zeiten, nächstes Gebet, Kalender für Jahr oder Monat', async () => {
  const all = await (await fetch(`${base}/v1/prayer-times`)).json();
  assert.equal(all.date, '2026-11-08');
  assert.equal(Object.keys(all.calendar).length, 12);
  assert.equal(all.calendar['2'].length, 28);
  assert.equal(all.calendar['11'][7].length, 7);
  assert.equal(all.iqamaCalendar['11'][7].length, 5);
  assert.equal(all.times.fajr, all.calendar['11'][7][1]);
  // 15:00 Uhr in Berlin: Asr ist vorbei, als Nächstes kommt Maghrib
  assert.equal(all.nextPrayer.name, 'maghrib');
  assert.ok(all.nextPrayer.minutesUntil > 0);
  for (const row of Object.values(all.calendar).flat()) {
    const minutes = row.map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)));
    for (let i = 2; i < minutes.length; i++) assert.ok(minutes[i] > minutes[i - 1], `Reihenfolge ${row}`);
  }

  const leap = await (await fetch(`${base}/v1/prayer-times?year=2028&month=2`)).json();
  assert.deepEqual(Object.keys(leap.calendar), ['2']);
  assert.equal(leap.calendar['2'].length, 29);

  const invalid = await fetch(`${base}/v1/prayer-times?year=2026&month=13`);
  assert.equal(invalid.status, 400);
});

test('Kalender-Abo (.ics) und CORS-Preflight', async () => {
  const ics = await fetch(`${base}/v1/prayer-times/calendar.ics?lang=de`);
  assert.match(ics.headers.get('content-type'), /text\/calendar/);
  const text = await ics.text();
  assert.match(text, /^BEGIN:VCALENDAR/);
  assert.equal(text.match(/BEGIN:VEVENT/g).length, 300);
  assert.match(text, /SUMMARY:Fadschr/);

  const preflight = await fetch(`${base}/v1/admin/cash-payers`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:4200', 'Access-Control-Request-Method': 'GET' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:4200');
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
});

test('Mock-Reset stellt die Testdaten wieder her', async () => {
  const token = await adminToken();
  await upload(token, OMER, receiptData());
  assert.equal(app.store.receipts.length, 24);
  const res = await fetch(`${base}/__mock/reset`, { method: 'POST' });
  assert.equal(res.status, 204);
  assert.equal(app.store.receipts.length, 23);
});
