import { now, one, stmt, type DB } from '../../src/db';
import { fail } from '../../src/http';
import { fyOf, shiftDayAt } from './billing';

export interface Business { id: string; name: string; fy_start_month: number; shift_start_hour: number; tab_age_days: number }

export async function loadBusiness(db: DB, id: string): Promise<Business> {
  const b = await one<Business>(db, 'SELECT id, name, fy_start_month, shift_start_hour, tab_age_days FROM businesses WHERE id = ?', id);
  if (!b) fail(404, 'Business not found.');
  return b;
}

/** The current shift day and financial year of a business, at `t` (default now). */
export function clock(b: Business, t = now()) {
  const shiftDay = shiftDayAt(t, b.shift_start_hour);
  return { t, shiftDay, fy: fyOf(shiftDay, b.fy_start_month) };
}

/** An audit row (before and after as JSON) for the same batch as the change. */
export function audit(db: DB, businessId: string, staffId: string, action: string, table: string, rowId: string, before: unknown, after: unknown) {
  return stmt(db, 'INSERT INTO audit_log (business_id, staff_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    businessId, staffId, action, table, rowId, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), now());
}

export function event(db: DB, businessId: string, kind: string, ref: string, amountPaise: number | null, reason: string | null, detail: string | null, staffId: string, shiftDay: string) {
  return stmt(db, 'INSERT INTO pos_events (business_id, kind, ref, amount_paise, reason, detail, by_staff, shift_day, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    businessId, kind, ref, amountPaise, reason, detail, staffId, shiftDay, now());
}

/** An active reason of a kind, by id; its label is what is stored on the bill or event. */
export async function reasonLabel(db: DB, businessId: string, kind: string, id: unknown, label: string): Promise<string> {
  if (typeof id !== 'string' || !id) fail(400, `${label} is required.`);
  const r = await one<{ label: string }>(db, 'SELECT label FROM reasons WHERE id = ? AND business_id = ? AND kind = ? AND active = 1', id, businessId, kind);
  if (!r) fail(400, `${label} is not one of the reasons set up.`);
  return r.label;
}

const msg = (e: unknown) => { const x = e as { message?: string; cause?: { message?: string } }; return `${x?.message ?? ''} ${x?.cause?.message ?? ''}`; };
export const isTrigger = (e: unknown, code: string) => msg(e).includes(code);
