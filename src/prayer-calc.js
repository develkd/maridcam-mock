'use strict';

/**
 * Näherungsweise Berechnung von Gebetszeiten aus dem Sonnenstand (Verfahren wie praytimes.org).
 * Nur für den Mock: Die Werte sehen plausibel aus, sind aber KEINE gültigen Gebetszeiten der Moschee.
 */
const { berlinOffsetHours, daysInMonth, pad } = require('./time');

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const fix = (a, b) => ((a % b) + b) % b;
const sin = (d) => Math.sin(rad(d));
const cos = (d) => Math.cos(rad(d));
const tan = (d) => Math.tan(rad(d));

function julian(year, month, day) {
  if (month <= 2) {
    year -= 1;
    month += 12;
  }
  const a = Math.floor(year / 100);
  const b = 2 - a + Math.floor(a / 4);
  return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + b - 1524.5;
}

function sunPosition(jd) {
  const d = jd - 2451545.0;
  const g = fix(357.529 + 0.98560028 * d, 360);
  const q = fix(280.459 + 0.98564736 * d, 360);
  const l = fix(q + 1.915 * sin(g) + 0.02 * sin(2 * g), 360);
  const e = 23.439 - 0.00000036 * d;
  const ra = fix(deg(Math.atan2(cos(e) * sin(l), cos(l))) / 15, 24);
  return { declination: deg(Math.asin(sin(e) * sin(l))), equation: q / 15 - ra };
}

/** Uhrzeiten (Dezimalstunden, lokale Zeit) eines Tages. */
function dayTimes(year, month, day, location, calc) {
  const { latitude: lat, longitude: lng } = location;
  const tz = berlinOffsetHours(year, month, day);
  const jd = julian(year, month, day) - lng / (15 * 24);

  const noonAt = (t) => fix(12 - sunPosition(jd + t).equation, 24);
  const angleTime = (angle, t, beforeNoon) => {
    const { declination } = sunPosition(jd + t);
    const cosH = (-sin(angle) - sin(declination) * sin(lat)) / (cos(declination) * cos(lat));
    if (cosH < -1 || cosH > 1) return NaN; // Sonne erreicht den Winkel nicht (Sommer in hohen Breiten)
    const h = deg(Math.acos(cosH)) / 15;
    return noonAt(t) + (beforeNoon ? -h : h);
  };
  const asrTime = (factor, t) => {
    const { declination } = sunPosition(jd + t);
    const angle = -deg(Math.atan(1 / (factor + tan(Math.abs(lat - declination)))));
    return angleTime(angle, t, false);
  };

  const sunrise = angleTime(0.833, 6 / 24, true);
  const sunset = angleTime(0.833, 18 / 24, false);
  let fajr = angleTime(calc.fajrAngle, 5 / 24, true);
  let isha = angleTime(calc.ishaAngle, 18 / 24, false);
  const dhuhr = noonAt(12 / 24);
  const asr = asrTime(calc.asrShadowFactor, 13 / 24);

  // Ausgleich für hohe Breiten („Angle Based“): höchstens Winkel/60 der Nacht vor Sonnenaufgang bzw. nach Sonnenuntergang
  const night = 24 - (sunset - sunrise);
  const fajrMax = (calc.fajrAngle / 60) * night;
  const ishaMax = (calc.ishaAngle / 60) * night;
  if (Number.isNaN(fajr) || sunrise - fajr > fajrMax) fajr = sunrise - fajrMax;
  if (Number.isNaN(isha) || isha - sunset > ishaMax) isha = sunset + ishaMax;

  const shift = tz - lng / 15;
  const adjust = calc.adjustMinutes || {};
  const minutes = (hours, key) => Math.round((hours + shift) * 60) + (adjust[key] || 0);
  const fajrMin = minutes(fajr, 'fajr');
  return {
    imsak: fajrMin - (calc.imsakMinutesBeforeFajr || 0),
    fajr: fajrMin,
    shuruq: minutes(sunrise, 'shuruq'),
    dhuhr: minutes(dhuhr, 'dhuhr'),
    asr: minutes(asr, 'asr'),
    maghrib: minutes(sunset, 'maghrib'),
    isha: minutes(isha, 'isha'),
  };
}

const hhmm = (minutes) => {
  const m = fix(Math.round(minutes), 1440);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};

/** Kalenderzeilen eines Monats: [Imsak, Fajr, Shuruq, Dhuhr, Asr, Maghrib, Isha] bzw. Iqama [Fajr, Dhuhr, Asr, Maghrib, Isha]. */
function monthCalendar(year, month, config) {
  const rows = [];
  const iqama = [];
  for (let day = 1; day <= daysInMonth(year, month); day++) {
    const t = dayTimes(year, month, day, config.mosque, config.calculation);
    rows.push([t.imsak, t.fajr, t.shuruq, t.dhuhr, t.asr, t.maghrib, t.isha].map(hhmm));
    iqama.push(['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'].map((k) => hhmm(t[k] + (config.iqamaMinutesAfter?.[k] || 0))));
  }
  return { rows, iqama };
}

module.exports = { dayTimes, monthCalendar, hhmm };
