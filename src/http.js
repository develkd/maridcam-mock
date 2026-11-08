'use strict';

/** Fehler im Format des Backends (BE-007). */
class ApiError extends Error {
  constructor(status, code, message, fieldErrors = [], headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.headers = headers;
  }
}

const validation = (fieldErrors = [], message = 'Validation failed.') =>
  new ApiError(400, 'VALIDATION_FAILED', message, fieldErrors);

const fieldError = (field, message) => ({ field, message });

function errorBody(err, now) {
  return {
    code: err.code,
    message: err.message,
    fieldErrors: err.fieldErrors,
    timestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

function send(res, status, body, headers = {}) {
  if (body === undefined || body === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    res.writeHead(status, headers);
    res.end(body);
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
}

/** Liest den Request-Body; bricht bei mehr als `limit` Bytes mit 413 ab. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      req.resume();
      reject(new ApiError(413, 'FILE_TOO_LARGE', 'File is too large.', [fieldError('file', 'must not exceed 10 MB')]));
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new ApiError(413, 'FILE_TOO_LARGE', 'File is too large.', [fieldError('file', 'must not exceed 10 MB')]));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => !failed && resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit = 1024 * 1024) {
  const type = String(req.headers['content-type'] || '');
  if (!type.toLowerCase().startsWith('application/json')) {
    throw validation([], 'Content type must be application/json.');
  }
  const raw = await readBody(req, limit);
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw validation([], 'Malformed request body.');
  }
}

/** Minimaler multipart/form-data-Parser: liefert { name: { filename?, contentType?, data: Buffer } }. */
function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw validation([], 'Malformed multipart request.');
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = {};
  let start = body.indexOf(boundary);
  while (start !== -1) {
    const next = body.indexOf(boundary, start + boundary.length);
    if (next === -1) break;
    // Teil zwischen "--boundary\r\n" und "\r\n--boundary"
    const part = body.subarray(start + boundary.length + 2, next - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerText = part.subarray(0, headerEnd).toString('utf8');
      const data = part.subarray(headerEnd + 4);
      const disposition = /content-disposition:[^\r\n]*/i.exec(headerText)?.[0] || '';
      const name = /\bname="([^"]*)"/i.exec(disposition)?.[1];
      const filename = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];
      const partType = /content-type:\s*([^\r\n;]+)/i.exec(headerText)?.[1];
      if (name) parts[name] = { filename, contentType: partType, data };
    }
    start = next;
  }
  return parts;
}

module.exports = { ApiError, validation, fieldError, errorBody, send, readBody, readJson, parseMultipart };
