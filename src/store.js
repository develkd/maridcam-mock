'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { berlinToday, addDays, addMonths, toIsoSeconds } = require('./time');
const { receiptPdf } = require('./pdf');

const DATA_DIR = path.join(__dirname, '..', 'data');

const readSeed = (name) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));

/**
 * Ersetzt relative Platzhalter in den Testdaten, damit die Daten immer zum aktuellen Datum passen:
 *   {{month}}, {{month-2}}, {{month+1}}  → YYYY-MM
 *   {{date}}, {{date-3}}                 → YYYY-MM-DD (Tage relativ zu heute)
 *   {{datetime-5}}                       → ISO-Zeitpunkt (Tage relativ zu jetzt)
 */
function resolvePlaceholders(value, now) {
  const today = berlinToday(now);
  const thisMonth = today.slice(0, 7);
  const replace = (text) =>
    text.replace(/\{\{(month|date|datetime)([+-]\d+)?\}\}/g, (_, kind, offset) => {
      const n = Number(offset || 0);
      if (kind === 'month') return addMonths(thisMonth, n);
      if (kind === 'date') return addDays(today, n);
      return toIsoSeconds(new Date(now.getTime() + n * 86400000));
    });
  if (typeof value === 'string') return replace(value);
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, now));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolvePlaceholders(v, now)]));
  }
  return value;
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/** Arbeitsspeicher-Datenbank des Mocks. Änderungen gehen bei Neustart oder Reset verloren. */
class Store {
  constructor(clock) {
    this.clock = clock;
    this.reset();
  }

  reset() {
    const now = this.clock();
    this.admins = readSeed('admins.json');
    this.mosque = readSeed('mosque.json');
    this.persons = resolvePlaceholders(readSeed('persons.json'), now);
    this.receipts = [];
    this.files = new Map();
    for (const [index, seed] of resolvePlaceholders(readSeed('cash-receipts.json'), now).entries()) {
      const person = this.findPerson(seed.personIdentifier);
      const content = receiptPdf({ ...seed, person });
      // Zeitversatz je Quittung, damit die Sortierung nach uploadedAt eindeutig ist
      const uploadedAt = seed.uploadedAt || `${seed.receiptDate}T${String(9 + (index % 8)).padStart(2, '0')}:15:00Z`;
      this.receipts.push({
        receiptIdentifier: seed.receiptIdentifier,
        personIdentifier: seed.personIdentifier,
        receiptNumber: seed.receiptNumber.toUpperCase(),
        receiptDate: seed.receiptDate,
        amount: seed.amount,
        months: [...seed.months].sort(),
        payerName: seed.payerName,
        fileName: seed.fileName,
        contentType: 'application/pdf',
        uploadedAt,
        uploadedBy: seed.uploadedBy,
        cancellation: seed.cancellation,
      });
      this.files.set(seed.receiptIdentifier, { content, sha256: sha256(content) });
    }
    this.loginFailures = new Map();

    // BE-023: Bestätigungs-Tokens; gespeichert wird wie im Backend nur der SHA-256-Hash
    this.confirmations = resolvePlaceholders(readSeed('email-confirmations.json'), now).map((c) => ({
      tokenHash: sha256(Buffer.from(c.token, 'utf8')),
      personIdentifier: c.personIdentifier,
      createdAt: c.createdAt,
      expiresAt: c.expiresAt,
      usedAt: c.usedAt,
      mailStatus: c.mailStatus,
    }));
    // nur für /__mock: Links der zuletzt erzeugten bzw. vorbereiteten Tokens (Mails werden nicht verschickt)
    this.confirmationLinks = resolvePlaceholders(readSeed('email-confirmations.json'), now).map((c) => ({
      token: c.token,
      note: c.note,
    }));

    // BE-024: eine Bankverbindung des Vereins
    const bank = resolvePlaceholders(readSeed('association-bank-account.json'), now);
    this.bankAccount = { accountHolder: bank.accountHolder, iban: bank.iban, bankName: bank.bankName, updatedAt: bank.updatedAt };
    this.bankAccountSaved = false;

    // BE-025: Mail-Einstellungen – wie im Backend zu Beginn leer (Changelog 018 legt keine Zeile an)
    this.mailSettings = null;
  }

  findConfirmation(rawToken) {
    const hash = sha256(Buffer.from(rawToken, 'utf8'));
    return this.confirmations.find((c) => c.tokenHash === hash) || null;
  }

  addConfirmation(rawToken, personIdentifier, createdAt, expiresAt, note) {
    this.confirmations.push({
      tokenHash: sha256(Buffer.from(rawToken, 'utf8')),
      personIdentifier,
      createdAt,
      expiresAt,
      usedAt: null,
      mailStatus: 'SENT',
    });
    this.confirmationLinks.unshift({ token: rawToken, note });
    this.confirmationLinks = this.confirmationLinks.slice(0, 20);
  }

  findPerson(identifier) {
    return this.persons.find((p) => p.identifier === identifier) || null;
  }

  findPersonByEmail(email) {
    const wanted = email.trim().toLowerCase();
    return this.persons.find((p) => p.email.toLowerCase() === wanted) || null;
  }

  findReceipt(identifier) {
    return this.receipts.find((r) => r.receiptIdentifier === identifier) || null;
  }

  receiptsOf(personIdentifier) {
    return this.receipts.filter((r) => r.personIdentifier === personIdentifier);
  }

  /** Durch gültige (nicht stornierte) Quittungen belegte Monate einer Person, aufsteigend. */
  paidMonths(personIdentifier) {
    const months = new Set();
    for (const r of this.receiptsOf(personIdentifier)) {
      if (!r.cancellation) r.months.forEach((m) => months.add(m));
    }
    return [...months].sort();
  }

  addReceipt(receipt, content) {
    this.receipts.push(receipt);
    this.files.set(receipt.receiptIdentifier, { content, sha256: sha256(content) });
  }

  addPerson(person) {
    this.persons.push(person);
  }
}

module.exports = { Store, resolvePlaceholders, sha256 };
