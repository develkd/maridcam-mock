'use strict';

const crypto = require('node:crypto');
const { ApiError, validation, fieldError, readJson, send } = require('../http');
const { berlinToday, toIsoSeconds } = require('../time');

const PAYMENT_METHODS = ['SEPA_DIRECT_DEBIT', 'BANK_TRANSFER', 'CASH'];
const ADDRESS_FIELDS = ['street', 'houseNumber', 'postalCode', 'city', 'country'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const blank = (v) => typeof v !== 'string' || !v.trim();

function validIban(value) {
  const iban = String(value).replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

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

/**
 * POST /v1/student-registrations – prüft die wichtigsten Regeln aus BE-006/BE-017/BE-018
 * und legt die Person im Mock an. Mit Zahlungsart CASH taucht sie danach in der Barzahler-Suche auf.
 */
async function registerStudent(ctx) {
  const body = (await readJson(ctx.req)) || {};
  const errors = [];
  const person = body.person;

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
  for (const f of ['privacyAccepted', 'termsAccepted', 'sepaConsent']) {
    if (typeof body[f] !== 'boolean') errors.push(fieldError(f, 'must not be null'));
  }

  const method = body.paymentMethod;
  if (!PAYMENT_METHODS.includes(method)) errors.push(fieldError('paymentMethod', 'must be one of ' + PAYMENT_METHODS.join(', ')));
  const bank = body.bank;
  if (!bank || typeof bank !== 'object') {
    errors.push(fieldError('bank', 'must not be null'));
  } else {
    const amount = bank.contributionAmount;
    if (typeof amount !== 'number' || amount < 0 || !/^\d{1,7}(\.\d{1,2})?$/.test(String(amount))) {
      errors.push(fieldError('bank.contributionAmount', 'must be a positive amount with at most 2 decimals'));
    }
    if (method === 'SEPA_DIRECT_DEBIT') {
      if (blank(bank.iban) || !validIban(bank.iban)) errors.push(fieldError('bank.iban', 'must be a valid IBAN'));
      if (blank(bank.accountHolder) || bank.accountHolder.length > 200) {
        errors.push(fieldError('bank.accountHolder', 'must not be blank'));
      }
    } else if (method) {
      if (bank.iban) errors.push(fieldError('bank.iban', 'must be empty for this payment method'));
      if (bank.accountHolder) errors.push(fieldError('bank.accountHolder', 'must be empty for this payment method'));
      if (body.sepaConsent === true) errors.push(fieldError('sepaConsent', 'must be false for this payment method'));
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

  const today = berlinToday(ctx.now);
  const adult = ageOn(person.dateOfBirth, today) >= 18;
  if (!adult && !guardian) throw validation([fieldError('guardian', 'is required for persons under 18')]);
  if (adult && guardian) throw validation([fieldError('guardian', 'is not allowed for persons aged 18 or over')]);

  if (!body.privacyAccepted || !body.termsAccepted || (method === 'SEPA_DIRECT_DEBIT' && !body.sepaConsent)) {
    throw new ApiError(400, 'REQUIRED_CONSENT_MISSING', 'Required consent is missing.');
  }
  if (ctx.store.findPersonByEmail(body.email)) {
    throw new ApiError(409, 'EMAIL_ALREADY_REGISTERED', 'Email is already registered.');
  }

  const identifier = crypto.randomUUID();
  ctx.store.addPerson({
    identifier,
    firstName: person.firstName.trim(),
    lastName: person.lastName.trim(),
    dateOfBirth: person.dateOfBirth,
    gender: person.gender,
    email: body.email.trim().toLowerCase(),
    phoneNumber: person.phoneNumber,
    address: person.address,
    paymentMethod: method,
    contributionAmount: bank.contributionAmount,
    guardians: guardian
      ? [{ firstName: guardian.firstName.trim(), lastName: guardian.lastName.trim(), email: guardian.email, phoneNumber: guardian.phoneNumber }]
      : [],
    accountStatus: 'PENDING_EMAIL_VERIFICATION',
    registeredAt: toIsoSeconds(ctx.now),
  });
  send(ctx.res, 201, {
    personIdentifier: identifier,
    userAccountIdentifier: crypto.randomUUID(),
    accountStatus: 'PENDING_EMAIL_VERIFICATION',
  });
}

module.exports = { registerStudent, validIban };
