'use strict';

const { ApiError, validation, send } = require('../http');
const { berlinParts, berlinToday, addDays } = require('../time');
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

const ICS_NAMES = {
  de: { fajr: 'Fadschr', dhuhr: 'Zuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Ischa', calendar: 'Gebetszeiten' },
  tr: { fajr: 'Sabah', dhuhr: 'Öğle', asr: 'İkindi', maghrib: 'Akşam', isha: 'Yatsı', calendar: 'Namaz Vakitleri' },
  en: { fajr: 'Fajr', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha', calendar: 'Prayer Times' },
};

/** GET /v1/prayer-times/calendar.ics?lang= – Kalender-Abo für 60 Tage ab heute. */
function getCalendarIcs(ctx) {
  const config = ctx.store.mosque;
  const lang = ICS_NAMES[ctx.url.searchParams.get('lang')] ? ctx.url.searchParams.get('lang') : 'en';
  const names = ICS_NAMES[lang];
  const today = berlinToday(ctx.now);
  const stamp = ctx.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//maridcam-mock//prayer-times//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${config.mosque.name} – ${names.calendar} (Mock)`,
    'X-WR-TIMEZONE:Europe/Berlin',
    'REFRESH-INTERVAL;VALUE=DURATION:P1D',
  ];
  for (let i = 0; i < 60; i++) {
    const date = addDays(today, i);
    const times = todayTimes(config, date);
    for (const name of SALAH) {
      const day = date.replace(/-/g, '');
      const start = `${day}T${times[name].replace(':', '')}00`;
      const end = `${day}T${hhmm(Math.min(toMinutes(times[name]) + 15, 1439)).replace(':', '')}00`;
      lines.push(
        'BEGIN:VEVENT',
        `UID:${date}-${name}@maridcam-mock`,
        `DTSTAMP:${stamp}`,
        `DTSTART;TZID=Europe/Berlin:${start}`,
        `DTEND;TZID=Europe/Berlin:${end}`,
        `SUMMARY:${names[name]}`,
        'END:VEVENT'
      );
    }
  }
  lines.push('END:VCALENDAR');
  send(ctx.res, 200, lines.join('\r\n') + '\r\n', {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'inline; filename="gebetszeiten.ics"',
  });
}

module.exports = { getPrayerTimes, getCalendarIcs };
