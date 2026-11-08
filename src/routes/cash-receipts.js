'use strict';

const crypto = require('node:crypto');
const { ApiError, validation, fieldError, send, readBody, readJson, parseMultipart } = require('../http');
const { berlinToday, toIsoSeconds } = require('../time');
const { requireAdmin } = require('./auth');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = 11 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_EXCEPT_LINEBREAK_TAB = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const fullName = (p) => `${p.firstName} ${p.lastName}`;

function checkUuid(value, field) {
  if (!UUID.test(value)) throw validation([fieldError(field, 'must be a valid UUID')]);
}

function toResponse(r) {
  return {
    receiptIdentifier: r.receiptIdentifier,
    receiptNumber: r.receiptNumber,
    receiptDate: r.receiptDate,
    amount: r.amount,
    months: r.months,
    payerName: r.payerName,
    fileName: r.fileName,
    contentType: r.contentType,
    uploadedAt: r.uploadedAt,
    uploadedBy: r.uploadedBy,
    status: r.cancellation ? 'CANCELLED' : 'VALID',
    cancelledAt: r.cancellation?.cancelledAt ?? null,
    cancelledBy: r.cancellation?.cancelledBy ?? null,
    cancellationReason: r.cancellation?.reason ?? null,
  };
}

/** GET /v1/admin/cash-payers?query=&page=&size= (BE-020) */
function searchCashPayers(ctx) {
  requireAdmin(ctx);
  const params = ctx.url.searchParams;
  const errors = [];
  const query = (params.get('query') || '').trim();
  const page = params.has('page') ? Number(params.get('page')) : 0;
  const size = params.has('size') ? Number(params.get('size')) : 20;
  if (query.length > 100) errors.push(fieldError('query', 'size must be between 0 and 100'));
  if (!Number.isInteger(page) || page < 0) errors.push(fieldError('page', 'must be greater than or equal to 0'));
  if (!Number.isInteger(size) || size < 1 || size > 100) errors.push(fieldError('size', 'must be between 1 and 100'));
  if (errors.length) throw validation(errors);

  const needle = query.toLowerCase();
  const matches = (p) => {
    if (!needle) return true;
    const names = [p, ...p.guardians].flatMap((x) => [x.firstName, x.lastName, fullName(x)]);
    return names.some((n) => n.toLowerCase().includes(needle));
  };
  const collator = new Intl.Collator('de', { sensitivity: 'base' });
  const all = ctx.store.persons
    .filter((p) => p.paymentMethod === 'CASH' && matches(p))
    .sort(
      (a, b) =>
        collator.compare(a.lastName, b.lastName) ||
        collator.compare(a.firstName, b.firstName) ||
        a.identifier.localeCompare(b.identifier)
    );
  const items = all.slice(page * size, page * size + size).map((p) => ({
    personIdentifier: p.identifier,
    firstName: p.firstName,
    lastName: p.lastName,
    dateOfBirth: p.dateOfBirth,
    contributionAmount: p.contributionAmount,
    payerName: p.guardians.length ? fullName(p.guardians[0]) : fullName(p),
    paidMonths: ctx.store.paidMonths(p.identifier),
  }));
  send(ctx.res, 200, { items, page, size, total: all.length });
}

/** GET /v1/admin/persons/{id}/cash-receipts – neueste zuerst. */
function listReceipts(ctx, personIdentifier) {
  requireAdmin(ctx);
  checkUuid(personIdentifier, 'personIdentifier');
  if (!ctx.store.findPerson(personIdentifier)) throw new ApiError(404, 'PERSON_NOT_FOUND', 'Person not found.');
  const list = ctx.store
    .receiptsOf(personIdentifier)
    .slice()
    .sort((a, b) => b.receiptDate.localeCompare(a.receiptDate) || b.uploadedAt.localeCompare(a.uploadedAt))
    .map(toResponse);
  send(ctx.res, 200, list);
}

function detectFileType(buffer) {
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return { type: 'application/pdf', ext: 'pdf' };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { type: 'image/png', ext: 'png' };
  }
  return null;
}

function sanitizeFileName(name, ext) {
  let base = String(name || '').split(/[\\/]/).pop();
  base = base.replace(/[\u0000-\u001f\u007f\\/:*?"<>|;]/g, '_').replace(/\s+/g, ' ').replace(/^\.+/, '').trim();
  if (base.length > 255) {
    const dot = base.lastIndexOf('.');
    const suffix = dot > 0 ? base.slice(dot) : '';
    base = base.slice(0, 255 - suffix.length) + suffix;
  }
  return base || `quittung.${ext}`;
}

function validateReceiptData(data, today) {
  const errors = [];
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const receiptNumber = text(data.receiptNumber);
  if (!receiptNumber) errors.push(fieldError('receiptNumber', 'must not be blank'));
  else if (receiptNumber.length > 50 || CONTROL.test(receiptNumber)) {
    errors.push(fieldError('receiptNumber', 'must be 1 to 50 characters without control characters'));
  }
  const receiptDate = text(data.receiptDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDate) || Number.isNaN(Date.parse(receiptDate))) {
    errors.push(fieldError('receiptDate', 'must be a date (YYYY-MM-DD)'));
  }
  const amount = data.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) errors.push(fieldError('amount', 'must not be null'));
  else if (amount <= 0) errors.push(fieldError('amount', 'must be greater than 0'));
  else if (!/^\d{1,7}(\.\d{1,2})?$/.test(String(amount))) {
    errors.push(fieldError('amount', 'numeric value out of bounds (<7 digits>.<2 digits> expected)'));
  }
  const months = data.months;
  if (!Array.isArray(months) || months.length < 1 || months.length > 12) {
    errors.push(fieldError('months', 'must contain 1 to 12 months'));
  } else if (months.some((m) => typeof m !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(m))) {
    errors.push(fieldError('months', 'must be months in format YYYY-MM'));
  } else if (new Set(months).size !== months.length) {
    errors.push(fieldError('months', 'must not contain duplicates'));
  }
  const payerName = text(data.payerName);
  if (!payerName) errors.push(fieldError('payerName', 'must not be blank'));
  else if (payerName.length > 200 || CONTROL.test(payerName)) {
    errors.push(fieldError('payerName', 'must be 1 to 200 characters without control characters'));
  }
  if (errors.length) throw validation(errors);
  if (receiptDate > today) throw validation([fieldError('receiptDate', 'must not be in the future')]);
  return { receiptNumber: receiptNumber.toUpperCase(), receiptDate, amount, months: [...months].sort(), payerName };
}

/** POST /v1/admin/persons/{id}/cash-receipts (multipart: file + data) */
async function uploadReceipt(ctx, personIdentifier) {
  const adminEmail = requireAdmin(ctx);
  checkUuid(personIdentifier, 'personIdentifier');
  const raw = await readBody(ctx.req, MAX_REQUEST_BYTES);
  const parts = parseMultipart(raw, ctx.req.headers['content-type']);

  if (!parts.data) throw validation([fieldError('data', 'must not be null')]);
  let data;
  try {
    data = JSON.parse(parts.data.data.toString('utf8'));
  } catch {
    throw validation([], 'Malformed request body.');
  }
  const input = validateReceiptData(data || {}, berlinToday(ctx.now));

  const file = parts.file;
  if (!file || file.data.length === 0) throw validation([fieldError('file', 'must not be empty')]);
  if (file.data.length > MAX_FILE_BYTES) {
    throw new ApiError(413, 'FILE_TOO_LARGE', 'File is too large.', [fieldError('file', 'must not exceed 10 MB')]);
  }
  const detected = detectFileType(file.data);
  if (!detected) {
    throw new ApiError(415, 'UNSUPPORTED_FILE_TYPE', 'Unsupported file type.', [
      fieldError('file', 'must be a PDF, JPEG or PNG file'),
    ]);
  }

  const { store } = ctx;
  const person = store.findPerson(personIdentifier);
  if (!person) throw new ApiError(404, 'PERSON_NOT_FOUND', 'Person not found.');
  if (person.paymentMethod !== 'CASH') {
    throw new ApiError(409, 'PAYMENT_METHOD_NOT_CASH', 'Person does not pay in cash.');
  }
  if (store.receipts.some((r) => r.receiptNumber === input.receiptNumber)) {
    throw new ApiError(409, 'RECEIPT_NUMBER_ALREADY_EXISTS', 'Receipt number already exists.', [
      fieldError('receiptNumber', 'already exists'),
    ]);
  }
  const paid = new Set(store.paidMonths(personIdentifier));
  if (input.months.some((m) => paid.has(m))) {
    throw new ApiError(409, 'MONTH_ALREADY_PAID', 'Month already paid.', [fieldError('months', 'already paid')]);
  }

  const receipt = {
    receiptIdentifier: crypto.randomUUID(),
    personIdentifier,
    ...input,
    fileName: sanitizeFileName(file.filename, detected.ext),
    contentType: detected.type,
    uploadedAt: toIsoSeconds(ctx.now),
    uploadedBy: adminEmail,
    cancellation: null,
  };
  store.addReceipt(receipt, file.data);
  send(ctx.res, 201, toResponse(receipt), {
    Location: `/v1/admin/cash-receipts/${receipt.receiptIdentifier}/file`,
  });
}

/** POST /v1/admin/cash-receipts/{id}/cancellation (BE-021) */
async function cancelReceipt(ctx, receiptIdentifier) {
  const adminEmail = requireAdmin(ctx);
  checkUuid(receiptIdentifier, 'receiptIdentifier');
  const body = await readJson(ctx.req);
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > 500 || CONTROL_EXCEPT_LINEBREAK_TAB.test(reason)) {
    throw validation([fieldError('reason', 'must be 1 to 500 characters without control characters')]);
  }
  const receipt = ctx.store.findReceipt(receiptIdentifier);
  if (!receipt) throw new ApiError(404, 'RECEIPT_NOT_FOUND', 'Receipt not found.');
  if (receipt.cancellation) throw new ApiError(409, 'RECEIPT_ALREADY_CANCELLED', 'Receipt is already cancelled.');
  receipt.cancellation = { cancelledAt: toIsoSeconds(ctx.now), cancelledBy: adminEmail, reason };
  send(ctx.res, 200, toResponse(receipt));
}

/** GET /v1/admin/cash-receipts/{id}/file */
function downloadFile(ctx, receiptIdentifier) {
  requireAdmin(ctx);
  checkUuid(receiptIdentifier, 'receiptIdentifier');
  const receipt = ctx.store.findReceipt(receiptIdentifier);
  const file = ctx.store.files.get(receiptIdentifier);
  if (!receipt || !file) throw new ApiError(404, 'RECEIPT_NOT_FOUND', 'Receipt not found.');
  const asciiName = receipt.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
  const disposition =
    asciiName === receipt.fileName
      ? `attachment; filename="${asciiName}"`
      : `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(receipt.fileName)}`;
  send(ctx.res, 200, file.content, {
    'Content-Type': receipt.contentType,
    'Content-Disposition': disposition,
    'Content-Length': file.content.length,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
}

module.exports = { searchCashPayers, listReceipts, uploadReceipt, cancelReceipt, downloadFile, detectFileType };
