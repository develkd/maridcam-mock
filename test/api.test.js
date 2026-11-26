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
  registrationType: 'STUDENT',
  language: 'de',
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
  ...overrides,
});

const adultMember = (overrides = {}) =>
  registration({
    registrationType: 'MEMBER',
    email: 'mitglied@example.com',
    person: { ...registration().person, firstName: 'Neues', lastName: 'Mitglied', dateOfBirth: '1990-03-03' },
    guardian: undefined,
    paymentMethod: 'STANDING_ORDER',
    ...overrides,
  });

const fieldsOf = async (res) => (await res.json()).fieldErrors.map((f) => f.field);

test('Anmeldung: 201 mit Zahlungsreferenz; Barzahler erscheint in der Suche; E-Mail doppelt 409', async () => {
  const res = await json('POST', '/v1/student-registrations', registration());
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.accountStatus, 'PENDING_EMAIL_VERIFICATION');
  assert.match(body.paymentReference, /^[0-9a-f]{32}$/);
  assert.equal('mandateReference' in body, false);

  const token = await adminToken();
  const found = await (await json('GET', '/v1/admin/cash-payers?query=neuer%20vater', undefined, token)).json();
  assert.equal(found.total, 1);
  assert.deepEqual(found.items[0].paidMonths, []);

  const again = await json('POST', '/v1/student-registrations', registration({ email: 'NEU@example.com' }));
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, 'EMAIL_ALREADY_REGISTERED');
});

test('Anmeldung BE-022: Mitglied mit Dauerauftrag; erscheint nicht bei den Barzahlern; alte SEPA-Felder werden ignoriert', async () => {
  const res = await json('POST', '/v1/student-registrations', adultMember({ sepaConsent: true, bank: { contributionAmount: 12.5, iban: 'DE89370400440532013000', accountHolder: 'X' } }));
  assert.equal(res.status, 201);
  const person = app.store.findPersonByEmail('mitglied@example.com');
  assert.equal(person.registrationType, 'MEMBER');
  assert.equal(person.paymentMethod, 'STANDING_ORDER');
  assert.equal('iban' in person, false);

  const token = await adminToken();
  const found = await (await json('GET', '/v1/admin/cash-payers?query=neues', undefined, token)).json();
  assert.equal(found.total, 0);
});

test('Anmeldung BE-022: Feldfehler für Anmeldeart, alte Zahlarten, Beitrag unter 1 €, Sprache', async () => {
  let res = await json('POST', '/v1/student-registrations', registration({ registrationType: 'GAST' }));
  assert.equal(res.status, 400);
  assert.deepEqual(await fieldsOf(res), ['registrationType']);

  for (const old of ['SEPA_DIRECT_DEBIT', 'BANK_TRANSFER']) {
    res = await json('POST', '/v1/student-registrations', registration({ paymentMethod: old }));
    assert.deepEqual(await fieldsOf(res), ['paymentMethod']);
  }

  for (const amount of [0, 0.99, 1.234]) {
    res = await json('POST', '/v1/student-registrations', registration({ bank: { contributionAmount: amount } }));
    assert.deepEqual(await fieldsOf(res), ['bank.contributionAmount'], `Beitrag ${amount}`);
  }
  res = await json('POST', '/v1/student-registrations', registration({ bank: { contributionAmount: 1 } }));
  assert.equal(res.status, 201);

  res = await json('POST', '/v1/student-registrations', registration({ email: 'sprache@example.com', language: 'fr' }));
  assert.deepEqual(await fieldsOf(res), ['language']);
});

test('Anmeldung BE-022/BE-018: Mindestalter Mitglied, Erziehungsberechtigte, Einwilligungen', async () => {
  let res = await json('POST', '/v1/student-registrations', adultMember({ person: { ...adultMember().person, dateOfBirth: '2010-01-01' } }));
  assert.equal(res.status, 400);
  assert.deepEqual(await fieldsOf(res), ['person.dateOfBirth']);

  res = await json('POST', '/v1/student-registrations', adultMember({ guardian: registration().guardian }));
  assert.deepEqual(await fieldsOf(res), ['guardian']);

  res = await json('POST', '/v1/student-registrations', registration({ guardian: undefined }));
  assert.deepEqual(await fieldsOf(res), ['guardian']);

  res = await json('POST', '/v1/student-registrations', registration({ privacyAccepted: false }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'REQUIRED_CONSENT_MISSING');
});

const confirm = (tokenValue) => json('POST', '/v1/student-registrations/email-confirmation', { token: tokenValue });
const seededToken = (index) => require('../data/email-confirmations.json')[index].token;

test('E-Mail-Bestätigung BE-023: gültig → ACTIVE, zweimal → 409, abgelaufen → 410, unbekannt → 400', async () => {
  const kerem = app.store.findPerson('5e0c1a00-0000-4000-8000-000000000022');
  assert.equal(kerem.accountStatus, 'PENDING_EMAIL_VERIFICATION');

  let res = await confirm(seededToken(0));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { accountStatus: 'ACTIVE' });
  assert.equal(kerem.accountStatus, 'ACTIVE');

  res = await confirm(seededToken(0));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'EMAIL_CONFIRMATION_TOKEN_ALREADY_USED');

  res = await confirm(seededToken(2));
  assert.equal(res.status, 410);
  assert.equal((await res.json()).code, 'EMAIL_CONFIRMATION_TOKEN_EXPIRED');

  res = await confirm(seededToken(3));
  assert.equal(res.status, 409);

  for (const bad of ['zu-kurz', 'A'.repeat(43)]) {
    res = await confirm(bad);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'EMAIL_CONFIRMATION_TOKEN_INVALID');
  }

  res = await confirm('');
  assert.deepEqual(await fieldsOf(res), ['token']);
});

test('E-Mail-Bestätigung: neue Anmeldung erzeugt einen Link unter /__mock, der das Konto aktiviert', async () => {
  await json('POST', '/v1/student-registrations', registration());
  const info = await (await fetch(`${base}/__mock`)).json();
  const link = new URL(info.confirmationLinks[0].link);
  assert.equal(link.pathname, '/student-registration/confirm');
  const res = await confirm(link.searchParams.get('token'));
  assert.equal(res.status, 200);
  assert.equal(app.store.findPersonByEmail('neu@example.com').accountStatus, 'ACTIVE');
});

test('Bankverbindung BE-024: öffentlich lesbar, IBAN in Vierergruppen, Admin-PUT mit Prüfung', async () => {
  let res = await fetch(`${base}/v1/association-bank-account`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['accountHolder', 'bankName', 'configured', 'iban']);
  assert.equal(body.iban, 'DE89 3704 0044 0532 0130 00');
  assert.equal(body.configured, true);
  assert.match(body.bankName, /MOCKDATEN/);

  const put = async (data, auth) =>
    fetch(`${base}/v1/admin/association-bank-account`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(data),
    });
  assert.equal((await put({ accountHolder: 'A', iban: 'DE89370400440532013000', bankName: 'B' })).status, 401);

  const token = await adminToken();
  res = await put({ accountHolder: 'A', iban: 'DE89370400440532013001', bankName: 'B' }, token);
  assert.equal(res.status, 400);
  const error = await res.json();
  assert.deepEqual(error.fieldErrors.map((f) => f.field), ['iban']);
  assert.ok(!JSON.stringify(error).includes('DE89370400440532013001'), 'IBAN darf nicht im Fehler stehen');

  res = await put({ accountHolder: '[Kontoinhaber]', iban: 'DE89370400440532013000', bankName: 'B' }, token);
  assert.deepEqual(await fieldsOf(res), ['accountHolder']);

  res = await put({ accountHolder: 'Verein', iban: 'de02 1203 0000 0000 2020 51', bankName: 'Bank' }, token);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).iban, 'DE02 1203 0000 0000 2020 51');
});

test('Bankverbindung: MOCK_BANK_ACCOUNT=placeholder liefert den Platzhalter (configured=false)', async () => {
  const other = createApp({ port: 0, now: NOW, quiet: true, allowedOrigins: ['*'], bankAccountPlaceholder: true });
  await new Promise((resolve) => other.server.listen(0, '127.0.0.1', resolve));
  const res = await fetch(`http://127.0.0.1:${other.server.address().port}/v1/association-bank-account`);
  assert.deepEqual(await res.json(), {
    accountHolder: 'Mariendorf Moschee e.V.',
    iban: 'DE00 0000 0000 0000 0000 00',
    bankName: '[Kreditinstitut]',
    configured: false,
  });
  await new Promise((resolve) => other.server.close(resolve));
});

test('Mail-Einstellungen BE-025: leer zu Beginn, PUT speichert, Passwort wird nie ausgegeben', async () => {
  const token = await adminToken();
  let res = await json('GET', '/v1/admin/mail-settings', undefined, token);
  assert.deepEqual(await res.json(), {
    host: null, port: 587, username: null, from: null, startTls: true, passwordSet: false, configured: false, updatedAt: null,
  });

  const put = (data) =>
    fetch(`${base}/v1/admin/mail-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
    });
  res = await put({ host: 'smtp.gmail.com', port: 587, username: 'verein@example.com', from: 'verein@example.com' });
  assert.deepEqual(await fieldsOf(res), ['password']);

  res = await put({ host: 'smtp gmail', port: 70000, from: 'kein-mail' });
  assert.deepEqual(await fieldsOf(res), ['host', 'port', 'from']);

  res = await put({ host: 'smtp.gmail.com', port: 587, username: 'verein@example.com', from: 'verein@example.com', password: 'abcd efgh ijkl mnop' });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.passwordSet, true);
  assert.equal(body.configured, true);
  assert.equal(body.updatedAt, '2026-11-08T14:00:00Z');
  assert.ok(!JSON.stringify(body).includes('abcd'), 'Passwort darf nie ausgegeben werden');
  assert.equal(app.store.mailSettings.password, 'abcdefghijklmnop', 'Gmail: Leerzeichen entfernt');

  // ohne Passwort: gespeichertes bleibt
  res = await put({ host: 'smtp.gmail.com', port: 465, username: 'verein@example.com', from: 'verein@example.com', startTls: false });
  body = await res.json();
  assert.equal(body.port, 465);
  assert.equal(body.startTls, false);
  assert.equal(body.passwordSet, true);
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

test('Kalender-Abo (.ics) wie im Backend und CORS-Preflight', async () => {
  const ics = await fetch(`${base}/v1/prayer-times/calendar.ics?lang=tr`);
  assert.match(ics.headers.get('content-type'), /^text\/calendar/);
  assert.equal(ics.headers.get('content-disposition'), 'inline; filename="mariendorf-moschee-gebetszeiten.ics"');
  assert.equal(ics.headers.get('cache-control'), 'max-age=3600, public');
  const text = await ics.text();
  assert.match(text, /^BEGIN:VCALENDAR\r\n/);
  assert.equal(text.match(/BEGIN:VEVENT/g).length, (7 + 1 + 90) * 5); // heute −7 bis +90 Tage
  assert.match(text, /UID:20261101-fajr@mariendorf-moschee\.de/);
  assert.match(text, /SUMMARY:Öğle · Mariendorf Moschee/);
  assert.match(text, /DESCRIPTION:İkamet \d\d:\d\d/);
  assert.match(text, /DTSTART:\d{8}T\d{6}Z/);
  assert.ok(text.split('\r\n').every((line) => Buffer.byteLength(line) <= 75), 'Zeilen höchstens 75 Bytes');

  const fallback = await (await fetch(`${base}/v1/prayer-times/calendar.ics?lang=xx`)).text();
  assert.match(fallback, /X-WR-CALNAME:Mariendorf Moschee – Prayer Times/);

  const preflight = await fetch(`${base}/v1/admin/mail-settings`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:4200', 'Access-Control-Request-Method': 'PUT' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://localhost:4200');
  assert.match(preflight.headers.get('access-control-allow-methods'), /PUT/);
});

test('Mock-Reset stellt die Testdaten wieder her', async () => {
  const token = await adminToken();
  await upload(token, OMER, receiptData());
  assert.equal(app.store.receipts.length, 24);
  const res = await fetch(`${base}/__mock/reset`, { method: 'POST' });
  assert.equal(res.status, 204);
  assert.equal(app.store.receipts.length, 23);
});
