/**
 * Lab-local (Houston) calendar helpers. Vercel functions run in UTC, so
 * anything that depends on "what day is it" -- PO numbers, delivery
 * windows, overdue checks -- must go through these instead of
 * Date#getDate()/getDay(), which would roll over at 6-7 PM Central.
 */
const TZ = 'America/Chicago';
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
});

// { y, m, d, weekday (Sun=0..Sat=6), ymd: 'YYYY-MM-DD' } for an instant, in Central time.
function labDate(value) {
  const parts = {};
  fmt.formatToParts(value ? new Date(value) : new Date()).forEach((p) => { parts[p.type] = p.value; });
  const y = Number(parts.year), m = Number(parts.month), d = Number(parts.day);
  return { y, m, d, weekday: WEEKDAYS[parts.weekday], ymd: parts.year + '-' + parts.month + '-' + parts.day };
}

// Calendar-day arithmetic on a 'YYYY-MM-DD' string (no time zone involved).
function addDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

module.exports = { labDate, addDays };
