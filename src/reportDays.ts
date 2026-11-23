import { all, type DB } from './db';
import { istDay, istToMs } from './time';

const DAY_MS = 24 * 60 * 60 * 1000;
const dayStart = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return istToMs(y, m, dd); };

/**
 * Calendar days (India time) among `days` that no software report touches (approved 23 Nov 2026). A day is only
 * missing once it is over: today's report cannot exist yet, so today and later days are left out.
 */
export async function daysWithoutReport(db: DB, businessId: string, days: string[], today = istDay(Date.now())): Promise<string[]> {
  const ds = [...new Set(days)].filter((d) => d < today).sort();
  if (!ds.length) return [];
  const reps = await all<{ covers_from: number; covers_to: number }>(db, `SELECT covers_from, covers_to FROM sales_reports
    WHERE business_id = ? AND replaced_by IS NULL AND covers_to >= ? AND covers_from < ?`, businessId, dayStart(ds[0]), dayStart(ds[ds.length - 1]) + DAY_MS);
  return ds.filter((d) => { const f = dayStart(d); return !reps.some((r) => r.covers_from < f + DAY_MS && r.covers_to >= f); });
}

/** The calendar day a new POS number was printed on: 26111313 → 2026-11-13. Null for anything else. */
export function billDate(billNo: string | null | undefined): string | null {
  const m = /^(\d{2})(\d{2})(\d{2})\d{1,3}$/.exec(billNo ?? '');
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return null;
  return `20${m[1]}-${m[2]}-${m[3]}`;
}
