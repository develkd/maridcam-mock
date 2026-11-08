'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { buildChangelog, dateSql, timestampSql, monthSql } = require('../scripts/export-liquibase');

test('Platzhalter werden zu H2-Ausdrücken relativ zu CURRENT_DATE', () => {
  assert.equal(monthSql('{{month-1}}'), "FORMATDATETIME(DATEADD(MONTH, -1, CURRENT_DATE), 'yyyy-MM')");
  assert.equal(dateSql('{{date-3}}'), 'DATEADD(DAY, -3, CURRENT_DATE)');
  assert.match(dateSql('{{month-2}}-04'), /^DATEADD\(DAY, 3, CAST\(DATE_TRUNC\('MONTH', DATEADD\(MONTH, -2, CURRENT_DATE\)\) AS DATE\)\)$/);
  assert.match(timestampSql('{{month-2}}-02T16:40:00Z'), /^DATEADD\(SECOND, 60000, CAST\(/);
  assert.equal(timestampSql('{{datetime-1}}'), 'DATEADD(DAY, -1, LOCALTIMESTAMP(0))');
  assert.equal(dateSql('2026-01-05'), "DATE '2026-01-05'");
  assert.throws(() => monthSql('{{date-1}}'));
});

test('Changelog enthält alle Testdaten, eindeutige Identifier und je Quittung einen Beleg', () => {
  const { changelog, files } = buildChangelog();
  const count = (table) => (changelog.match(new RegExp(`<insert tableName="${table}">`, 'g')) || []).length;
  assert.equal(count('persons'), 26 + 4);
  assert.equal(count('user_accounts'), 26 + 4);
  assert.equal(count('payment_details'), 26);
  assert.equal(count('sepa_mandates'), 1);
  assert.equal(count('cash_receipts'), 23);
  assert.equal(count('cash_receipt_files'), 23);
  assert.equal(count('cash_receipt_cancellations'), 2);
  assert.equal(files.size, 23);
  for (const content of files.values()) assert.equal(content.subarray(0, 5).toString(), '%PDF-');

  const ids = [...changelog.matchAll(/<column name="identifier" value="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'doppelte Identifier');
  assert.ok(!changelog.includes('{{'), 'unaufgelöster Platzhalter');
  assert.ok(!/Admin-Dev-2026!/.test(changelog), 'Klartext-Passwort im Changelog');
});

test('npm run export:liquibase schreibt Changelog und Belege ins Zielverzeichnis', () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'maridcam-export-'));
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'export-liquibase.js'), target]);
  assert.ok(fs.existsSync(path.join(target, 'mock-data.xml')));
  assert.equal(fs.readdirSync(path.join(target, 'files')).length, 23);
  fs.rmSync(target, { recursive: true, force: true });
});
