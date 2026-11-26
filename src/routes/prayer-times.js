'use strict';

const { ApiError, validation, send } = require('../http');
const { berlinParts, berlinToday, berlinOffsetHours, addDays } = require('../time');
const { monthCalendar, hhmm } = require('../prayer-calc');

const SALAH = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
const toMinutes = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};

function dayRow(config, isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const { rows, iqama } = monthCalendar(y, m, config);
  return { row: rows[d - 1], iqama: iqama[d - 1] };
}

function todayTimes(config, isoDate) {
  const { row, iqama } = dayRow(config, isoDate);
  const [imsak, fajr, shuruq, dhuhr, asr, maghrib, isha] = row;
  return {
    fajr,
    shuruq,
    dhuhr,
    asr,
    maghrib,
    isha,
    imsak,
    jumua: config.jumuaAsDhuhr ? dhuhr : null,
    jumua2: config.jumua2 || null,
    iqama: Object.fromEntries(SALAH.map((name, i) => [name, iqama[i]])),
  };
}

/** GET /v1/prayer-times[?year=&month=] (BE-015), berechnete Näherungswerte. */
function getPrayerTimes(ctx) {
  if (ctx.config.prayerTimesUnavailable) {
    throw new ApiError(503, 'PRAYER_TIMES_UNAVAILABLE', 'Prayer times data is currently unavailable.');
  }
  const params = ctx.url.searchParams;
  const config = ctx.store.mosque;
  const today = berlinToday(ctx.now);
  const nowParts = berlinParts(ctx.now);

  let year = nowParts.year;
  let months = Array.from({ length: 12 }, (_, i) => i + 1);
  if (params.has('year') && params.has('month')) {
    const y = params.get('year');
    const m = params.get('month');
    if (!/^-?\d+$/.test(y) || !/^-?\d+$/.test(m)) throw validation([], 'year and month must be numbers');
    if (Number(m) < 1 || Number(m) > 12) throw validation([], 'month must be between 1 and 12');
    if (Number(y) < 1900 || Number(y) > 2100) throw validation([], 'year must be between 1900 and 2100');
    year = Number(y);
    months = [Number(m)];
  }

  const calendar = {};
  const iqamaCalendar = {};
  for (const month of months) {
    const { rows, iqama } = monthCalendar(year, month, config);
    calendar[month] = rows;
    iqamaCalendar[month] = iqama;
  }

  const times = todayTimes(config, today);
  const nowMinutes = nowParts.hour * 60 + nowParts.minute;
  const upcoming = SALAH.find((name) => toMinutes(times[name]) > nowMinutes);
  let nextPrayer;
  if (upcoming) {
    nextPrayer = { name: upcoming, time: times[upcoming], minutesUntil: toMinutes(times[upcoming]) - nowMinutes };
  } else {
    const tomorrowFajr = todayTimes(config, addDays(today, 1)).fajr;
    nextPrayer = { name: 'fajr', time: tomorrowFajr, minutesUntil: 1440 - nowMinutes + toMinutes(tomorrowFajr) };
  }
  send(ctx.res, 200, {
    mosque: config.mosque,
    date: today,
    hijriDate: '',
    times,
    nextPrayer,
    calendar,
    iqamaCalendar,
  });
}

// Wie PrayerCalendarIcsWriter im Backend (BE-015, Kalender-Abo)
const ICS_LANGUAGES = {
  de: { title: 'Gebetszeiten', iqama: 'Iqama', names: ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Ischa'] },
  tr: { title: 'Namaz Vakitleri', iqama: 'İkamet', names: ['İmsak', 'Öğle', 'İkindi', 'Akşam', 'Yatsı'] },
  en: { title: 'Prayer Times', iqama: 'Iqama', names: ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'] },
};
const MOSQUE_NAME = 'Mariendorf Moschee';
const UID_DOMAIN = 'mariendorf-moschee.de';
const DAYS_BEFORE = 7;
const DAYS_AFTER = 90;

const icsEscape = (text) => String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

/** Zeile nach 75 Bytes (UTF-8) falten, ohne Zeichen zu zerteilen; Fortsetzung beginnt mit einem Leerzeichen. */
function fold(line) {
  const parts = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    const limit = parts.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/** Berliner Ortszeit (Datum + HH:mm) → UTC im iCalendar-Format yyyyMMddTHHmmssZ. */
function utcStamp(isoDate, hhmm, offsetMinutes = 0) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const [h, min] = hhmm.split(':').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d, h, min + offsetMinutes) - berlinOffsetHours(y, m, d) * 3600000);
  return utc.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** GET /v1/prayer-times/calendar.ics?lang=de|tr|en – Kalender-Abo, heute −7 bis +90 Tage. */
function getCalendarIcs(ctx) {
  if (ctx.config.prayerTimesUnavailable) {
    throw new ApiError(503, 'PRAYER_TIMES_UNAVAILABLE', 'Prayer times data is currently unavailable.');
  }
  const config = ctx.store.mosque;
  const code = ctx.url.searchParams.get('lang') || 'de';
  const language = ICS_LANGUAGES[code] || ICS_LANGUAGES.en;
  const today = berlinToday(ctx.now);
  const stamp = ctx.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Mariendorf Moschee//Gebetszeiten//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(`${MOSQUE_NAME} – ${language.title}`)}`,
    `X-WR-TIMEZONE:${config.mosque.timezone}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ];
  for (let offset = -DAYS_BEFORE; offset <= DAYS_AFTER; offset++) {
    const date = addDays(today, offset);
    const times = todayTimes(config, date);
    SALAH.forEach((key, i) => {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${date.replace(/-/g, '')}-${key}@${UID_DOMAIN}`,
        `DTSTAMP:${stamp}`,
        `DTSTART:${utcStamp(date, times[key])}`,
        `DTEND:${utcStamp(date, times[key], 15)}`,
        `SUMMARY:${icsEscape(`${language.names[i]} · ${MOSQUE_NAME}`)}`
      );
      if (times.iqama[key]) lines.push(`DESCRIPTION:${icsEscape(`${language.iqama} ${times.iqama[key]}`)}`);
      lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
    });
  }
  lines.push('END:VCALENDAR');
  send(ctx.res, 200, lines.map(fold).join('\r\n') + '\r\n', {
    'Content-Type': 'text/calendar;charset=UTF-8',
    'Content-Disposition': 'inline; filename="mariendorf-moschee-gebetszeiten.ics"',
    'Cache-Control': 'max-age=3600, public',
  });
}

module.exports = { getPrayerTimes, getCalendarIcs };
