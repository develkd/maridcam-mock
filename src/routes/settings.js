'use strict';

const { validation, fieldError, readJson, send } = require('../http');
const { toIsoSeconds } = require('../time');
const { requireAdmin } = require('./auth');

const NO_STORE = { 'Cache-Control': 'no-store' };
const CONTROL = /[\u0000-\u001f\u007f]/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PLACEHOLDER = { accountHolder: 'Mariendorf Moschee e.V.', iban: 'DE00000000000000000000', bankName: '[Kreditinstitut]' };

// ---------------------------------------------------------------- Bankverbindung des Vereins (BE-024)

function validIban(value) {
  const iban = String(value).replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (iban.startsWith('DE') && iban.length !== 22) return false;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

const bracketed = (text) => /^\s*\[.*\]\s*$/.test(String(text));
const groupIban = (iban) => iban.replace(/\s+/g, '').toUpperCase().replace(/(.{4})/g, '$1 ').trim();

/** Wie AssociationBankAccount.configured(): gültige IBAN und keine Platzhalter in eckigen Klammern. */
const isConfigured = (a) => validIban(a.iban) && !bracketed(a.accountHolder) && !bracketed(a.bankName);

function currentBankAccount(ctx) {
  // Mit MOCK_BANK_ACCOUNT=placeholder gilt der Platzhalter, bis die Verwaltung per PUT eine Bankverbindung speichert.
  return ctx.config.bankAccountPlaceholder && !ctx.store.bankAccountSaved ? PLACEHOLDER : ctx.store.bankAccount;
}

function bankAccountBody(account) {
  return {
    accountHolder: account.accountHolder,
    iban: groupIban(account.iban),
    bankName: account.bankName,
    configured: isConfigured(account),
  };
}

/** GET /v1/association-bank-account – öffentlich, immer 200. */
function getBankAccount(ctx) {
  send(ctx.res, 200, bankAccountBody(currentBankAccount(ctx)), NO_STORE);
}

/** PUT /v1/admin/association-bank-account */
async function putBankAccount(ctx) {
  requireAdmin(ctx);
  const body = (await readJson(ctx.req)) || {};
  const errors = [];
  for (const [field, max] of [['accountHolder', 70], ['bankName', 100]]) {
    const value = body[field];
    if (typeof value !== 'string' || !value.trim()) errors.push(fieldError(field, 'must not be blank'));
    else if (value.trim().length > max) errors.push(fieldError(field, `size must be between 1 and ${max}`));
    else if (bracketed(value)) errors.push(fieldError(field, 'must not be a placeholder'));
  }
  if (typeof body.iban !== 'string' || !body.iban.trim()) errors.push(fieldError('iban', 'must not be blank'));
  else if (!validIban(body.iban)) errors.push(fieldError('iban', 'must be a valid IBAN'));
  if (errors.length) throw validation(errors);

  ctx.store.bankAccount = {
    accountHolder: body.accountHolder.trim(),
    iban: body.iban.replace(/\s+/g, '').toUpperCase(),
    bankName: body.bankName.trim(),
    updatedAt: toIsoSeconds(ctx.now),
  };
  ctx.store.bankAccountSaved = true;
  send(ctx.res, 200, bankAccountBody(ctx.store.bankAccount), NO_STORE);
}

// ---------------------------------------------------------------- Mail-Einstellungen (BE-025)

function mailSettingsBody(settings) {
  if (!settings) {
    return { host: null, port: 587, username: null, from: null, startTls: true, passwordSet: false, configured: false, updatedAt: null };
  }
  const passwordSet = Boolean(settings.password);
  return {
    host: settings.host,
    port: settings.port,
    username: settings.username,
    from: settings.from,
    startTls: settings.startTls,
    passwordSet,
    configured: Boolean(settings.host && settings.from && (!settings.username || passwordSet)),
    updatedAt: settings.updatedAt,
  };
}

/** GET /v1/admin/mail-settings – das Passwort wird nie ausgegeben. */
function getMailSettings(ctx) {
  requireAdmin(ctx);
  send(ctx.res, 200, mailSettingsBody(ctx.store.mailSettings), NO_STORE);
}

/** PUT /v1/admin/mail-settings – fehlendes/leeres Passwort = gespeichertes behalten. */
async function putMailSettings(ctx) {
  requireAdmin(ctx);
  const body = (await readJson(ctx.req)) || {};
  const errors = [];
  const host = typeof body.host === 'string' ? body.host.trim() : '';
  if (!host || host.length > 255 || !/^[A-Za-z0-9.-]+$/.test(host)) errors.push(fieldError('host', 'must be a host name or IP address'));
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) errors.push(fieldError('port', 'must be between 1 and 65535'));
  const username = typeof body.username === 'string' && body.username.trim() ? body.username.trim() : null;
  if (username && (username.length > 255 || CONTROL.test(username))) errors.push(fieldError('username', 'size must be between 0 and 255'));
  const from = typeof body.from === 'string' ? body.from.trim() : '';
  if (!from || from.length > 254 || !EMAIL.test(from)) errors.push(fieldError('from', 'must be a well-formed email address'));
  let password = typeof body.password === 'string' && body.password !== '' ? body.password : null;
  if (password && (password.length > 200 || CONTROL.test(password))) errors.push(fieldError('password', 'must be at most 200 characters'));
  if (errors.length) throw validation(errors);

  const stored = ctx.store.mailSettings?.password || null;
  if (password && /(^|\.)gmail\.com$/i.test(host)) password = password.replace(/\s+/g, ''); // App-Passwort in Vierergruppen
  const effectivePassword = password || stored;
  if (username && !effectivePassword) throw validation([fieldError('password', 'is required when a username is set')]);

  ctx.store.mailSettings = {
    host,
    port: body.port,
    username,
    from,
    startTls: typeof body.startTls === 'boolean' ? body.startTls : true,
    password: effectivePassword,
    updatedAt: toIsoSeconds(ctx.now),
  };
  send(ctx.res, 200, mailSettingsBody(ctx.store.mailSettings), NO_STORE);
}

module.exports = { getBankAccount, putBankAccount, getMailSettings, putMailSettings, validIban, isConfigured };
