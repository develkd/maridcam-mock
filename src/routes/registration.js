'use strict';

const crypto = require('node:crypto');
const { ApiError, validation, fieldError, readJson, send } = require('../http');
const { berlinToday, toIsoSeconds } = require('../time');

// BE-022: Anmeldeart und Zahlart (löst BE-017 ab: kein SEPA, keine IBAN mehr)
const REGISTRATION_TYPES = ['MEMBER', 'STUDENT'];
const PAYMENT_METHODS = ['CASH', 'STANDING_ORDER'];
const LANGUAGES = ['de', 'tr', 'en'];
const MEMBER_MINIMUM_AGE = 18;
const MIN_CONTRIBUTION = 1;
const ADDRESS_FIELDS = ['street', 'houseNumber', 'postalCode', 'city', 'country'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// BE-023: Token = 32 Zufallsbytes Base64url ohne Padding = 43 Zeichen; gültig 48 h
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const CONFIRMATION_TTL_MS = 48 * 3600 * 1000;

const blank = (v) => typeof v !== 'string' || !v.trim();

function ageOn(dateOfBirth, today) {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

function checkAddress(address, prefix, errors) {
  if (!address || typeof address !== 'object') {
    errors.push(fieldError(prefix, 'must not be null'));
    return;
  }
  for (const f of ADDRESS_FIELDS) if (blank(address[f])) errors.push(fieldError(`${prefix}.${f}`, 'must not be blank'));
}

/** BE-022: zufällige UUID v4 ohne Bindestriche (^[0-9a-f]{32}$), wie UuidPaymentReferenceGenerator. */
const paymentReference = () => crypto.randomUUID().replace(/-/g, '');

/**
 * POST /v1/student-registrations – Regeln aus BE-006, BE-018, BE-022 und BE-023. Legt die Person im Mock an
 * (mit Zahlart CASH erscheint sie danach in der Barzahler-Suche) und erzeugt ein Bestätigungs-Token. Mails verschickt
 * der Mock nicht; der Bestätigungslink steht im Log und unter GET /__mock.
 */
async function registerStudent(ctx) {
  const body = (await readJson(ctx.req)) || {};
  const errors = [];
  const person = body.person;

  if (!REGISTRATION_TYPES.includes(body.registrationType)) {
    errors.push(fieldError('registrationType', 'must be one of MEMBER, STUDENT'));
  }
  if (!person || typeof person !== 'object') {
    errors.push(fieldError('person', 'must not be null'));
  } else {
    for (const f of ['firstName', 'lastName', 'gender', 'phoneNumber']) {
      if (blank(person[f])) errors.push(fieldError(`person.${f}`, 'must not be blank'));
    }
    if (typeof person.dateOfBirth !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(person.dateOfBirth)) {
      errors.push(fieldError('person.dateOfBirth', 'must not be null'));
    }
    checkAddress(person.address, 'person.address', errors);
  }
  checkAddress(body.address, 'address', errors);
  if (blank(body.email)) errors.push(fieldError('email', 'must not be blank'));
  else if (!EMAIL.test(body.email.trim())) errors.push(fieldError('email', 'must be a well-formed email address'));
  for (const f of ['privacyAccepted', 'termsAccepted']) {
    if (typeof body[f] !== 'boolean') errors.push(fieldError(f, 'must not be null'));
  }
  if (body.language !== undefined && body.language !== null && !LANGUAGES.includes(body.language)) {
    errors.push(fieldError('language', 'must be one of de, tr, en'));
  }

  // Alte Felder (sepaConsent, bank.iban, bank.accountHolder) werden wie im Backend ignoriert.
  if (!PAYMENT_METHODS.includes(body.paymentMethod)) {
    errors.push(fieldError('paymentMethod', 'must be one of CASH, STANDING_ORDER'));
  }
  const bank = body.bank;
  if (!bank || typeof bank !== 'object') {
    errors.push(fieldError('bank', 'must not be null'));
  } else {
    const amount = bank.contributionAmount;
    if (typeof amount !== 'number' || amount < MIN_CONTRIBUTION || !/^\d{1,7}(\.\d{1,2})?$/.test(String(amount))) {
      errors.push(fieldError('bank.contributionAmount', 'must be at least 1.00 with at most 2 decimals'));
    }
  }

  const guardian = body.guardian;
  if (guardian) {
    for (const [f, max] of [['firstName', 100], ['lastName', 100], ['email', 254], ['phoneNumber', 50]]) {
      if (blank(guardian[f])) errors.push(fieldError(`guardian.${f}`, 'must not be blank'));
      else if (guardian[f].length > max) errors.push(fieldError(`guardian.${f}`, `size must be between 0 and ${max}`));
    }
    if (!blank(guardian.email) && !EMAIL.test(guardian.email.trim())) {
      errors.push(fieldError('guardian.email', 'must be a well-formed email address'));
    }
  }
  if (errors.length) throw validation(errors);

  // Reihenfolge wie im RegisterStudentHandler: Zustimmungen → Geburtsdatum → Mindestalter Mitglied → Erziehungsberechtigte → E-Mail
  if (!body.privacyAccepted || !body.termsAccepted) {
    throw new ApiError(400, 'REQUIRED_CONSENT_MISSING', 'Required consent is missing.');
  }
  const today = berlinToday(ctx.now);
  if (person.dateOfBirth >= today) throw validation([fieldError('person.dateOfBirth', 'must be a past date')]);
  const age = ageOn(person.dateOfBirth, today);
  const isMember = body.registrationType === 'MEMBER';
  if (isMember && age < MEMBER_MINIMUM_AGE) {
    throw validation([fieldError('person.dateOfBirth', 'members must be at least 18 years old')]);
  }
  if (isMember && guardian) throw validation([fieldError('guardian', 'is not allowed for members')]);
  if (!isMember && age < 18 && !guardian) throw validation([fieldError('guardian', 'is required for persons under 18')]);
  if (!isMember && age >= 18 && guardian) throw validation([fieldError('guardian', 'is not allowed for persons aged 18 or over')]);
  if (ctx.store.findPersonByEmail(body.email)) {
    throw new ApiError(409, 'EMAIL_ALREADY_REGISTERED', 'Email is already registered.');
  }

  const identifier = crypto.randomUUID();
  const reference = paymentReference();
  ctx.store.addPerson({
    identifier,
    registrationType: body.registrationType,
    firstName: person.firstName.trim(),
    lastName: person.lastName.trim(),
    dateOfBirth: person.dateOfBirth,
    gender: person.gender,
    email: body.email.trim().toLowerCase(),
    phoneNumber: person.phoneNumber,
    address: person.address,
    paymentMethod: body.paymentMethod,
    contributionAmount: bank.contributionAmount,
    guardians: guardian
      ? [{ firstName: guardian.firstName.trim(), lastName: guardian.lastName.trim(), email: guardian.email, phoneNumber: guardian.phoneNumber }]
      : [],
    accountStatus: 'PENDING_EMAIL_VERIFICATION',
    registeredAt: toIsoSeconds(ctx.now),
    paymentReference: reference,
  });

  const token = crypto.randomBytes(32).toString('base64url');
  const createdAt = toIsoSeconds(ctx.now);
  const expiresAt = toIsoSeconds(new Date(ctx.now.getTime() + CONFIRMATION_TTL_MS));
  ctx.store.addConfirmation(token, identifier, createdAt, expiresAt, `neue Anmeldung ${createdAt}`);
  if (!ctx.config.quiet) {
    console.log(`  Bestätigungslink (Mail wird nicht verschickt): ${confirmationLink(ctx.config, token)}`);
  }

  send(ctx.res, 201, {
    personIdentifier: identifier,
    userAccountIdentifier: crypto.randomUUID(),
    accountStatus: 'PENDING_EMAIL_VERIFICATION',
    paymentReference: reference,
  });
}

function confirmationLink(config, token) {
  return `${config.frontendBaseUrl.replace(/\/+$/, '')}/student-registration/confirm?token=${token}`;
}

/** POST /v1/student-registrations/email-confirmation (BE-023). */
async function confirmEmail(ctx) {
  const body = (await readJson(ctx.req)) || {};
  const token = body.token;
  if (typeof token !== 'string' || !token.trim() || token.length > 200) {
    throw validation([fieldError('token', 'must not be blank and at most 200 characters')]);
  }
  // Prüfreihenfolge wie im Backend: Format → bekannt → Konto bestätigbar → benutzt → abgelaufen
  const invalid = () => new ApiError(400, 'EMAIL_CONFIRMATION_TOKEN_INVALID', 'Confirmation token is invalid.');
  if (!TOKEN_FORMAT.test(token)) throw invalid();
  const confirmation = ctx.store.findConfirmation(token);
  if (!confirmation) throw invalid();
  const person = ctx.store.findPerson(confirmation.personIdentifier);
  if (!person || ['BLOCKED', 'DELETED'].includes(person.accountStatus)) throw invalid();
  if (confirmation.usedAt) {
    throw new ApiError(409, 'EMAIL_CONFIRMATION_TOKEN_ALREADY_USED', 'Confirmation token was already used.');
  }
  if (Date.parse(confirmation.expiresAt) <= ctx.now.getTime()) {
    throw new ApiError(410, 'EMAIL_CONFIRMATION_TOKEN_EXPIRED', 'Confirmation token has expired.');
  }
  confirmation.usedAt = toIsoSeconds(ctx.now);
  person.accountStatus = 'ACTIVE';
  send(ctx.res, 200, { accountStatus: 'ACTIVE' });
}

module.exports = { registerStudent, confirmEmail, confirmationLink };
