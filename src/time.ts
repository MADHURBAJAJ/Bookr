// India time and the shift rule. India has no daylight saving, so UTC+5:30 all year.
// Shift of day D = D 08:00:00 up to, not including, D+1 08:00:00, India time.

export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const SHIFT_START_HOUR = 8;

const pad = (n: number) => String(n).padStart(2, '0');

/** India-time wall clock → epoch milliseconds. Month is 1-12. */
export function istToMs(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi, s) - IST_OFFSET_MS;
}

/** The India-time calendar day of a moment. */
export function istDay(ms: number): string {
  const t = new Date(ms + IST_OFFSET_MS);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** The shift a moment belongs to: before 08:00 India time it is the previous day's shift. */
export function shiftDayOf(ms: number): string {
  return istDay(ms - SHIFT_START_HOUR * HOUR);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** [from, to) of a shift in epoch milliseconds. */
export function shiftWindow(day: string): { from: number; to: number } {
  const [y, m, d] = day.split('-').map(Number);
  const from = istToMs(y, m, d, SHIFT_START_HOUR);
  return { from, to: from + DAY };
}

export interface Gap { from: number; to: number }

/**
 * The parts of a shift window not covered by any report. Report times have one-second
 * resolution, so a report covering up to 23:59:59 counts as covering up to 00:00:00.
 */
export function missingInWindow(window: { from: number; to: number }, covers: { from: number; to: number }[]): Gap[] {
  const parts = covers
    .map((c) => ({ from: Math.max(c.from, window.from), to: Math.min(c.to + 1000, window.to) }))
    .filter((c) => c.from < c.to)
    .sort((a, b) => a.from - b.from);
  const gaps: Gap[] = [];
  let cursor = window.from;
  for (const p of parts) {
    if (p.from > cursor) gaps.push({ from: cursor, to: p.from });
    cursor = Math.max(cursor, p.to);
  }
  if (cursor < window.to) gaps.push({ from: cursor, to: window.to });
  return gaps;
}
