#!/usr/bin/env node
'use strict';

/**
 * Erzeugt aus den Testdaten (data/*.json) einen Liquibase-Changelog für das Backend-Profil `mock`
 * (H2 in-memory). So nutzen Node-Mock und Backend dieselben Testdaten.
 *
 *   npm run export:liquibase                 → ../maridcam-backend/src/main/resources/db/changelog/mock
 *   node scripts/export-liquibase.js <ziel>  → anderes Zielverzeichnis
 *
 * Relative Platzhalter ({{month-1}}, {{date-3}}, {{datetime-1}}) werden zu H2-SQL-Ausdrücken mit CURRENT_DATE,
 * damit die Daten bei jedem Start des Backends zum aktuellen Datum passen.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { receiptPdf } = require('../src/pdf');

const ROOT = path.join(__dirname, '..');
const DEFAULT_TARGET = path.join(ROOT, '..', 'maridcam-backend', 'src', 'main', 'resources', 'db', 'changelog', 'mock');

// Feste Identifier aus den Backend-Changelogs 006 und 010
const ROLE_STUDENT = '11111111-1111-1111-1111-111111111111';
const ROLE_ADMIN = '33333333-3333-3333-3333-333333333333';
// Argon2id-Hash eines zufälligen, unbekannten Passworts: Schülerkonten können sich nicht anmelden
const STUDENT_PASSWORD_HASH = '$argon2id$v=19$m=60000,t=5,p=1$q5tRFd3pF/Xz2Nd6pXPxRQ$oXHXWOy1IqHC5e0YkfZWBKqDrz8AovjGdjb+5jeHqZE';
const SEPA_CREDITOR_ID = 'DE98ZZZ09999999999';

const readJson = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', name), 'utf8'));

/**
 * Abgeleiteter, stabiler Identifier: 3 Hex-Zeichen je Tabelle + die ersten 5 Zeichen der Quell-UUID + Rest der UUID.
 * Personen (5e0c1…) und Mitarbeiter (ad000…) ergeben so verschiedene Adress- und Konto-Identifier.
 */
const derive = (uuid, tag) => `${tag}${uuid.slice(0, 5)}${uuid.slice(8)}`;

const xml = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------- Platzhalter → H2-SQL

const PLACEHOLDER = /^\{\{(month|date|datetime)([+-]\d+)?\}\}(.*)$/;

function monthStart(offset) {
  return `CAST(DATE_TRUNC('MONTH', DATEADD(MONTH, ${offset}, CURRENT_DATE)) AS DATE)`;
}

/** Datumswert (DATE) als SQL. */
function dateSql(value) {
  const m = PLACEHOLDER.exec(value);
  if (!m) return `DATE '${value}'`;
  const [, kind, offset = '0', rest] = m;
  if (kind === 'date' && !rest) return `DATEADD(DAY, ${Number(offset)}, CURRENT_DATE)`;
  if (kind === 'month' && /^-\d{2}$/.test(rest)) return `DATEADD(DAY, ${Number(rest.slice(1)) - 1}, ${monthStart(Number(offset))})`;
  throw new Error(`Kein Datum: ${value}`);
}

/** Zeitpunkt (TIMESTAMP) als SQL. */
function timestampSql(value) {
  const m = PLACEHOLDER.exec(value);
  if (!m) return `TIMESTAMP '${value.replace('T', ' ').replace('Z', '')}'`;
  const [, kind, offset = '0', rest] = m;
  if (kind === 'datetime' && !rest) return `DATEADD(DAY, ${Number(offset)}, LOCALTIMESTAMP(0))`;
  const time = /^-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(rest);
  if (kind === 'month' && time) {
    const day = `DATEADD(DAY, ${Number(time[1]) - 1}, ${monthStart(Number(offset))})`;
    const seconds = Number(time[2]) * 3600 + Number(time[3]) * 60 + Number(time[4]);
    return `DATEADD(SECOND, ${seconds}, CAST(${day} AS TIMESTAMP))`;
  }
  throw new Error(`Kein Zeitpunkt: ${value}`);
}

/** Beitragsmonat (VARCHAR YYYY-MM) als SQL. */
function monthSql(value) {
  const m = PLACEHOLDER.exec(value);
  if (!m) return `'${value}'`;
  if (m[1] !== 'month' || m[3]) throw new Error(`Kein Monat: ${value}`);
  return `FORMATDATETIME(DATEADD(MONTH, ${Number(m[2] || 0)}, CURRENT_DATE), 'yyyy-MM')`;
}

// ---------------------------------------------------------------- Changelog bauen

const col = (name, value) => `            <column name="${name}" value="${xml(value)}"/>`;
const colNum = (name, value) => `            <column name="${name}" valueNumeric="${value}"/>`;
const colBool = (name, value) => `            <column name="${name}" valueBoolean="${value}"/>`;
const colSql = (name, sql) => `            <column name="${name}" valueComputed="${xml(sql)}"/>`;
const colDate = (name, value) => `            <column name="${name}" valueDate="${value}"/>`;
const colBlob = (name, file) => `            <column name="${name}" valueBlobFile="${xml(file)}"/>`;
const idOf = (table, identifier) => `(SELECT id FROM ${table} WHERE identifier = '${identifier}')`;
const insert = (table, columns) => `        <insert tableName="${table}">\n${columns.filter(Boolean).join('\n')}\n        </insert>`;
const changeSet = (id, comment, inserts) =>
  `    <changeSet id="${id}" author="maridcam-mock" context="mock">\n        <comment>${xml(comment)}</comment>\n${inserts.join('\n')}\n    </changeSet>`;

function addressInsert(identifier, address) {
  return insert('addresses', [
    col('identifier', identifier),
    col('street', address.street),
    col('house_number', address.houseNumber),
    col('postal_code', address.postalCode),
    col('city', address.city),
    col('country', address.country),
  ]);
}

function personInserts({ identifier, firstName, lastName, dateOfBirth, gender, phoneNumber, address }) {
  const addressIdentifier = derive(identifier, 'a0d');
  return [
    addressInsert(addressIdentifier, address),
    insert('persons', [
      col('identifier', identifier),
      col('first_name', firstName),
      col('last_name', lastName),
      dateOfBirth && colDate('date_of_birth', dateOfBirth),
      gender && col('gender', gender),
      phoneNumber && col('phone_number', phoneNumber),
      colSql('address_id', idOf('addresses', addressIdentifier)),
    ]),
  ];
}

function accountInserts(personIdentifier, accountIdentifier, email, passwordHash, status, roles) {
  return [
    insert('user_accounts', [
      col('identifier', accountIdentifier),
      col('email', email),
      col('password_hash', passwordHash),
      col('status', status),
      col('person_identifier', personIdentifier),
    ]),
    ...roles.map((role) => insert('person_roles', [col('person_identifier', personIdentifier), col('role_identifier', role)])),
  ];
}

function buildChangelog() {
  const persons = readJson('persons.json');
  const receipts = readJson('cash-receipts.json');
  const admins = readJson('admins.json');
  const files = new Map();

  const registrations = persons.flatMap((p) => [
    ...personInserts(p),
    ...accountInserts(p.identifier, derive(p.identifier, 'acc'), p.email, STUDENT_PASSWORD_HASH, 'PENDING_EMAIL_VERIFICATION', [ROLE_STUDENT]),
  ]);

  const payments = persons.flatMap((p) => {
    const paymentIdentifier = derive(p.identifier, '9a0');
    const rows = [
      insert('payment_details', [
        col('identifier', paymentIdentifier),
        col('person_identifier', p.identifier),
        col('payment_method', p.paymentMethod),
        colNum('contribution_amount', p.contributionAmount),
      ]),
    ];
    if (p.paymentMethod === 'SEPA_DIRECT_DEBIT') {
      const created = timestampSql(p.registeredAt);
      rows.push(
        insert('sepa_mandates', [
          col('identifier', derive(p.identifier, '5e9')),
          col('payment_details_identifier', paymentIdentifier),
          col('mandate_reference', `MRD-MOCK-${p.identifier.slice(-12).toUpperCase()}`),
          col('creditor_identifier', SEPA_CREDITOR_ID),
          col('account_holder', p.accountHolder),
          col('iban', p.iban),
          col('mandate_type', 'RCUR'),
          colSql('signed_at', created),
        ])
      );
    }
    return rows;
  });

  const guardians = persons.flatMap((p) =>
    p.guardians.map((g, k) =>
      insert('guardians', [
        col('identifier', derive(p.identifier, `6a${k}`)),
        col('person_identifier', p.identifier),
        col('first_name', g.firstName),
        col('last_name', g.lastName),
        col('email', g.email),
        col('phone_number', g.phoneNumber),
      ])
    )
  );

  const staff = admins.flatMap((a) => [
    ...personInserts({
      identifier: a.identifier,
      firstName: a.firstName,
      lastName: a.lastName,
      address: { street: 'Mariendorfer Damm', houseNumber: '1', postalCode: '12107', city: 'Berlin', country: 'Deutschland' },
    }),
    ...accountInserts(a.identifier, derive(a.identifier, 'acc'), a.email, a.passwordHash, a.status, a.roles.includes('ADMIN') ? [ROLE_ADMIN] : []),
  ]);

  const cash = receipts.flatMap((r, index) => {
    const person = persons.find((p) => p.identifier === r.personIdentifier);
    const pdf = receiptPdf({ ...r, person }, { withDates: false });
    const fileName = `files/${r.receiptNumber.toLowerCase()}.pdf`;
    files.set(fileName, pdf);
    const receiptDate = dateSql(r.receiptDate);
    // wie im Node-Mock: Upload am Quittungstag, je Quittung zu einer anderen Stunde
    const uploadedAt = `DATEADD(MINUTE, ${(9 + (index % 8)) * 60 + 15}, CAST(${receiptDate} AS TIMESTAMP))`;
    const rows = [
      insert('cash_receipts', [
        col('identifier', r.receiptIdentifier),
        col('person_identifier', r.personIdentifier),
        col('receipt_number', r.receiptNumber.toUpperCase()),
        colSql('receipt_date', receiptDate),
        colNum('amount', r.amount),
        col('payer_name', r.payerName),
        col('file_name', r.fileName),
        col('content_type', 'application/pdf'),
        colNum('file_size', pdf.length),
        col('sha256', crypto.createHash('sha256').update(pdf).digest('hex')),
        colSql('uploaded_at', uploadedAt),
        col('uploaded_by', r.uploadedBy),
      ]),
      insert('cash_receipt_files', [col('receipt_identifier', r.receiptIdentifier), colBlob('content', fileName)]),
      ...r.months.map((month) =>
        insert('cash_receipt_months', [
          col('receipt_identifier', r.receiptIdentifier),
          col('person_identifier', r.personIdentifier),
          colSql('contribution_month', monthSql(month)),
          r.cancellation ? null : colBool('occupied', true),
        ])
      ),
    ];
    if (r.cancellation) {
      rows.push(
        insert('cash_receipt_cancellations', [
          col('receipt_identifier', r.receiptIdentifier),
          colSql('cancelled_at', timestampSql(r.cancellation.cancelledAt)),
          col('cancelled_by', r.cancellation.cancelledBy),
          col('reason', r.cancellation.reason),
        ])
      );
    }
    return rows;
  });

  const changelog = `<?xml version="1.0" encoding="UTF-8"?>
<!--
  GENERIERT von develkd/maridcam-mock (scripts/export-liquibase.js) aus data/*.json – nicht von Hand ändern.
  Neu erzeugen: im Repo maridcam-mock "npm run export:liquibase".
  Nur für das Backend-Profil "mock" (H2 in-memory), eingebunden über db.changelog-mock.xml.
  ${persons.length} Anmeldungen, ${admins.length} Mitarbeiterkonten, ${receipts.length} Quittungen (${receipts.filter((r) => r.cancellation).length} storniert)
-->
<databaseChangeLog xmlns="http://www.liquibase.org/xml/ns/dbchangelog"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                   xsi:schemaLocation="http://www.liquibase.org/xml/ns/dbchangelog
                   https://www.liquibase.org/xml/ns/dbchangelog/dbchangelog-4.30.xsd">

${changeSet('mock-1', 'Anmeldungen: Adressen, Personen, Konten (PENDING_EMAIL_VERIFICATION), Rolle STUDENT', registrations)}

${changeSet('mock-2', 'Zahlungsdaten und SEPA-Mandate', payments)}

${changeSet('mock-3', 'Erziehungsberechtigte', guardians)}

${changeSet('mock-4', 'Mitarbeiterkonten (Passwörter siehe maridcam-mock/README.md)', staff)}

${changeSet('mock-5', 'Barzahlungs-Quittungen mit Belegen, Monaten und Stornos', cash)}

</databaseChangeLog>
`;
  return { changelog, files };
}

function main() {
  const target = path.resolve(process.argv[2] || DEFAULT_TARGET);
  const { changelog, files } = buildChangelog();
  fs.rmSync(path.join(target, 'files'), { recursive: true, force: true });
  fs.mkdirSync(path.join(target, 'files'), { recursive: true });
  fs.writeFileSync(path.join(target, 'mock-data.xml'), changelog);
  for (const [name, content] of files) fs.writeFileSync(path.join(target, name), content);
  console.log(`Liquibase-Testdaten geschrieben: ${target} (mock-data.xml + ${files.size} Belege)`);
}

if (require.main === module) main();

module.exports = { buildChangelog, dateSql, timestampSql, monthSql };
