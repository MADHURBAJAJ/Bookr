import { now, one, stmt, type DB } from '../../src/db';
import { fail } from '../../src/http';
import { fyOf, shiftDayAt } from './billing';

export interface Business { id: string; name: string; fy_start_month: number; shift_start_hour: number; tab_age_days: number; tables: string | null; disc_limit_bp: number }

export async function loadBusiness(db: DB, id: string): Promise<Business> {
  const b = await one<Business>(db, 'SELECT id, name, fy_start_month, shift_start_hour, tab_age_days, tables, disc_limit_bp FROM businesses WHERE id = ?', id);
  if (!b) fail(404, 'Business not found.');
  return b;
}

// ---------- tables in sections (21 Nov 2026): Private Rooms, Dorms, Out House, NC, others
// Stored in businesses.tables as {"sections": [...]}; an older plain list ["T1", "T2"] reads as one section "Tables".
// A dorm section lists dorms with their bed count; its tables are made from them: "Dorm A · whole", "Dorm A · Bed 1"...
export const SECTION_KINDS = ['rooms', 'dorms', 'outhouse', 'nc', 'other'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];
/** A dorm: its name and bed count; `letters`: beds named by letter as in Djubo ("II B"), else "II · Bed 2" (23 Nov 2026). */
export interface Dorm { name: string; beds: number; letters?: boolean }
export interface Section { name: string; kind: SectionKind; tables: string[]; dorms?: Dorm[] }
export const dormWhole = (dorm: string) => `${dorm} · whole`;
export const dormBed = (dorm: string, n: number, letters = false) => (letters ? `${dorm} ${String.fromCharCode(64 + n)}` : `${dorm} · Bed ${n}`);

export function sectionTables(s: { kind: string; tables?: unknown; dorms?: Dorm[] }): string[] {
  if (s.kind === 'dorms') return (s.dorms ?? []).flatMap((d) => [dormWhole(d.name), ...Array.from({ length: d.beds }, (_, i) => dormBed(d.name, i + 1, d.letters))]);
  return Array.isArray(s.tables) ? s.tables.map(String) : [];
}

/** The restaurant's table sections from Settings, or null when it has none (the counter then shows recent tables). */
export function tableLayout(b: Business): Section[] | null {
  if (!b.tables) return null;
  try {
    const v = JSON.parse(b.tables);
    if (Array.isArray(v)) return v.length ? [{ name: 'Tables', kind: 'other', tables: v.map(String) }] : null;
    const secs = Array.isArray(v?.sections) ? (v.sections as Section[]) : [];
    const out = secs.map((s) => ({ name: String(s.name), kind: (SECTION_KINDS as readonly string[]).includes(s.kind) ? s.kind : 'other',
      tables: sectionTables(s), ...(s.kind === 'dorms' ? { dorms: s.dorms ?? [] } : {}) }));
    return out.some((s) => s.tables.length) ? out : null;
  } catch { return null; }
}

/** Every table, in order, across the sections; or null when there is no list. */
export function tableList(b: Business): string[] | null {
  const l = tableLayout(b);
  return l ? l.flatMap((s) => s.tables) : null;
}

/** Which section a table is in, and for a dorm table which dorm and whether it is the whole dorm. */
export function placeOf(layout: Section[] | null, place: string): { section: Section; dorm?: string; whole?: boolean } | null {
  const p = place.trim().toLowerCase();
  for (const s of layout ?? []) {
    if (s.kind === 'dorms') {
      for (const d of s.dorms ?? []) {
        if (dormWhole(d.name).toLowerCase() === p) return { section: s, dorm: d.name, whole: true };
        for (let i = 1; i <= d.beds; i++) if (dormBed(d.name, i, d.letters).toLowerCase() === p) return { section: s, dorm: d.name, whole: false };
      }
    } else if (s.tables.some((t) => t.toLowerCase() === p)) return { section: s };
  }
  return null;
}
export const isNcPlace = (layout: Section[] | null, place: string) => placeOf(layout, place)?.section.kind === 'nc';

/** The signed-in person's business, already loaded with their session. */
export function bizOf(c: { get(k: 'business'): Business }): Business {
  return c.get('business');
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
