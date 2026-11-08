'use strict';

const ZONE = 'Europe/Berlin';

/** Datum und Uhrzeit in Berlin als Zahlen. */
function berlinParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

const pad = (n) => String(n).padStart(2, '0');

/** Heutiges Datum in Berlin als YYYY-MM-DD. */
function berlinToday(now) {
  const p = berlinParts(now);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Abstand Berlin–UTC in Stunden für einen Kalendertag (MEZ +1, MESZ +2). */
function berlinOffsetHours(year, month, day) {
  const utcNoon = new Date(Date.UTC(year, month - 1, day, 12));
  return berlinParts(utcNoon).hour - 12;
}

/** Verschiebt ein YYYY-MM-DD-Datum um `days` Tage. */
function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/** Verschiebt einen Monat YYYY-MM um `months` Monate. */
function addMonths(isoMonth, months) {
  const [y, m] = isoMonth.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, 1));
  return date.toISOString().slice(0, 7);
}

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

const toIsoSeconds = (date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

module.exports = { ZONE, berlinParts, berlinToday, berlinOffsetHours, addDays, addMonths, daysInMonth, pad, toIsoSeconds };
