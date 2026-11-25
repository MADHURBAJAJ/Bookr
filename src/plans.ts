// One list of what a person chose on Reconcile before saving (approved 25 Nov 2026; migration 0043). Every kind of
// choice is a plan of the shift: the bills it is for, and the credits or card payments it holds (its items). A credit or
// a card payment can be held by one plan only, whatever the kind (the database refuses a second). Reconcile, the preview,
// Save, Undo and every list of free credits read this one list. Saving applies the shift's plans and removes them.
import { all, newId, now, stmt, type DB } from './db';

export type PlanKind = 'bank_match' | 'card_match' | 'bill_parts' | 'group_parts' | 'same_sale' | 'card_advance';

export interface Plan {
  id: string; day: string; kind: PlanKind; comparisonIds: string[]; headRowId: string | null;
  bankRowIds: string[]; cardPaymentIds: string[]; createdBy: string | null; createdAt: number;
}

/** A plan id: a UUID, or one moved from the audit log by migration 0043 ('bp-123'). */
export const isPlanId = (v: string | undefined): v is string => typeof v === 'string' && /^[a-z0-9-]{3,64}$/i.test(v);

/** SQL: this bank line (alias.column) is held by a plan. */
export const heldCredit = (col: string) => `EXISTS (SELECT 1 FROM shift_plan_items pi WHERE pi.bank_row_id = ${col})`;
/** SQL: this card payment (alias.column) is held by a plan. */
export const heldPayment = (col: string) => `EXISTS (SELECT 1 FROM shift_plan_items pi WHERE pi.card_payment_id = ${col})`;
/**
 * SQL: this bank line is held by a plan other than this shift's parts plans. A bill (or group) paid in parts pairs with
 * its own ticked credits, so those stay in the shift's credits; one held anywhere else does not. Takes the shift day as a
 * bound value.
 */
export const heldElsewhere = (col: string) => `EXISTS (SELECT 1 FROM shift_plan_items pi JOIN shift_plans pp ON pp.id = pi.plan_id
  WHERE pi.bank_row_id = ${col} AND NOT (pp.kind IN ('bill_parts', 'group_parts') AND pp.shift_day = ?))`;

type Row = { id: string; shift_day: string; kind: PlanKind; comparison_ids: string; head_row_id: string | null; created_by: string | null; created_at: number;
  bank_row_id: string | null; card_payment_id: string | null };

function fold(rows: Row[]): Plan[] {
  const out = new Map<string, Plan>();
  for (const r of rows) {
    let p = out.get(r.id);
    if (!p) {
      p = { id: r.id, day: r.shift_day, kind: r.kind, comparisonIds: JSON.parse(r.comparison_ids) as string[], headRowId: r.head_row_id,
        bankRowIds: [], cardPaymentIds: [], createdBy: r.created_by, createdAt: r.created_at };
      out.set(r.id, p);
    }
    if (r.bank_row_id) p.bankRowIds.push(r.bank_row_id);
    if (r.card_payment_id) p.cardPaymentIds.push(r.card_payment_id);
  }
  // A plan whose credits or payments were all removed (a statement deleted) holds nothing and does nothing.
  return [...out.values()].filter((p) => p.bankRowIds.length || p.cardPaymentIds.length);
}

const SELECT = `SELECT p.id, p.shift_day, p.kind, p.comparison_ids, p.head_row_id, p.created_by, p.created_at, i.bank_row_id, i.card_payment_id
  FROM shift_plans p JOIN shift_plan_items i ON i.plan_id = p.id`;

/** The plans of one shift, oldest first, of the kinds asked (all when none). */
export async function shiftPlans(db: DB, businessId: string, day: string, kinds?: PlanKind[]): Promise<Plan[]> {
  const k = kinds?.length ? ` AND p.kind IN (${kinds.map(() => '?').join(',')})` : '';
  return fold(await all<Row>(db, `${SELECT} WHERE p.business_id = ? AND p.shift_day = ?${k} ORDER BY p.created_at, p.id, i.rowid`, businessId, day, ...(kinds ?? [])));
}

/** One plan by id. */
export async function planById(db: DB, businessId: string, id: string): Promise<Plan | null> {
  return fold(await all<Row>(db, `${SELECT} WHERE p.business_id = ? AND p.id = ? ORDER BY i.rowid`, businessId, id))[0] ?? null;
}

/** Plans on any shift not saved yet that hold one of these credits / payments or are for one of these bills. */
export async function plansTouching(db: DB, businessId: string, x: { bankRowIds?: string[]; cardPaymentIds?: string[]; comparisonIds?: string[]; headRowIds?: string[] }): Promise<Plan[]> {
  const conds: string[] = [];
  const args: unknown[] = [];
  const list = (xs: string[]) => xs.map(() => '?').join(',');
  if (x.bankRowIds?.length) { conds.push(`EXISTS (SELECT 1 FROM shift_plan_items q WHERE q.plan_id = p.id AND q.bank_row_id IN (${list(x.bankRowIds)}))`); args.push(...x.bankRowIds); }
  if (x.cardPaymentIds?.length) { conds.push(`EXISTS (SELECT 1 FROM shift_plan_items q WHERE q.plan_id = p.id AND q.card_payment_id IN (${list(x.cardPaymentIds)}))`); args.push(...x.cardPaymentIds); }
  if (x.comparisonIds?.length) { conds.push(`EXISTS (SELECT 1 FROM json_each(p.comparison_ids) j WHERE j.value IN (${list(x.comparisonIds)}))`); args.push(...x.comparisonIds); }
  if (x.headRowIds?.length) { conds.push(`p.head_row_id IN (${list(x.headRowIds)})`); args.push(...x.headRowIds); }
  if (!conds.length) return [];
  return fold(await all<Row>(db, `${SELECT} WHERE p.business_id = ? AND (${conds.join(' OR ')})
    AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.business_id = p.business_id AND s.shift_day = p.shift_day AND s.status = 'confirmed')
    ORDER BY p.created_at, p.id, i.rowid`, businessId, ...args));
}

const KIND_WORD: Record<PlanKind, string> = {
  bank_match: 'matched on save', card_match: 'matched on save to the card machine', bill_parts: 'ticked for a bill paid in parts',
  group_parts: 'matched on save to bills paid in parts', same_sale: 'chosen as the same sale as a bill', card_advance: 'chosen as a card advance for a bill',
};

/**
 * Why a new plan cannot be made: a credit or payment is held by another plan, or a bill is in one already. Null when free.
 * `except` names plans this one replaces.
 */
export async function planClash(db: DB, businessId: string, want: { bankRowIds?: string[]; cardPaymentIds?: string[]; comparisonIds?: string[]; headRowIds?: string[] }, except: string[] = [], billName = 'A bill') {
  const others = (await plansTouching(db, businessId, want)).filter((p) => !except.includes(p.id));
  for (const p of others) {
    if (want.bankRowIds?.some((id) => p.bankRowIds.includes(id))) return `${want.bankRowIds.length > 1 ? 'One of these credits' : 'This credit'} is already ${KIND_WORD[p.kind]}${p.day ? ` (${p.day})` : ''}.`;
    if (want.cardPaymentIds?.some((id) => p.cardPaymentIds.includes(id))) return `This card payment is already ${KIND_WORD[p.kind]}${p.day ? ` (${p.day})` : ''}.`;
    if (want.comparisonIds?.some((id) => p.comparisonIds.includes(id))) return `${billName} is already ${KIND_WORD[p.kind]}.`;
    if (want.headRowIds?.some((id) => p.headRowId === id)) return `${billName} are already ${KIND_WORD[p.kind]}.`;
  }
  return null;
}

/** The statements that make a plan, and its id. */
export function addPlanStatements(db: DB, businessId: string, day: string, kind: PlanKind, x: { comparisonIds?: string[]; headRowId?: string | null; bankRowIds?: string[]; cardPaymentIds?: string[] },
  userId: string | null, at = now(), id = newId()) {
  return {
    id,
    statements: [
      stmt(db, `INSERT INTO shift_plans (id, business_id, shift_day, kind, comparison_ids, head_row_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, businessId, day, kind, JSON.stringify(x.comparisonIds ?? []), x.headRowId ?? null, userId, at),
      ...(x.bankRowIds ?? []).map((r) => stmt(db, 'INSERT INTO shift_plan_items (plan_id, business_id, bank_row_id) VALUES (?, ?, ?)', id, businessId, r)),
      ...(x.cardPaymentIds ?? []).map((r) => stmt(db, 'INSERT INTO shift_plan_items (plan_id, business_id, card_payment_id) VALUES (?, ?, ?)', id, businessId, r)),
    ],
  };
}

/** The statements that remove plans (their items too). */
export function dropPlanStatements(db: DB, ids: string[]) {
  return ids.flatMap((id) => [stmt(db, 'DELETE FROM shift_plan_items WHERE plan_id = ?', id), stmt(db, 'DELETE FROM shift_plans WHERE id = ?', id)]);
}

/** Saving a shift: all its plans go (applied or, when they no longer fit, said). */
export function dropShiftPlansStatements(db: DB, businessId: string, day: string) {
  return [
    stmt(db, 'DELETE FROM shift_plan_items WHERE plan_id IN (SELECT id FROM shift_plans WHERE business_id = ? AND shift_day = ?)', businessId, day),
    stmt(db, 'DELETE FROM shift_plans WHERE business_id = ? AND shift_day = ?', businessId, day),
  ];
}

/** A plan made a moment ago clashed in the database (two people at once): said like a clash found first. */
export const isClash = (e: unknown) => /UNIQUE/i.test(String(e));
