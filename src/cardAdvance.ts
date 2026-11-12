// An advance paid on the card machine (approved 12 Nov 2026): booked as an unbilled Room sale, "Advance: <guest>", when
// it is paid; the room bill made later (at check-out) uses it. As with a UPI advance, a person chooses it before saving
// the bill's shift, and the save joins them: the booking goes, the payment is matched to the bill's card sale, and the
// sale stays on the day the money came. Undo (unmatch) puts the booking back.
import { all, one, stmt, type DB } from './db';
import { cardMatchStatements } from './cards';
import { ADVANCE_DAYS, ADVANCE_TAG } from './extra';
import { addDays, shiftWindow } from './time';

export interface CardAdvance { paymentId: string; amountPaise: number; paidAt: number; txId: string; txDay: string; what: string; scheme: string | null; card_type: string | null; card_last4: string | null; pay_mode: string | null }

/** Card payments booked as an advance, paid up to ADVANCE_DAYS before this shift ends and still booked. */
export function cardAdvances(db: DB, businessId: string, day: string) {
  return all<CardAdvance>(db, `SELECT s.id AS paymentId, s.amount_paise AS amountPaise, s.paid_at AS paidAt, t.id AS txId, t.day AS txDay, t.narration AS what,
      s.scheme, s.card_type, s.card_last4, s.pay_mode
    FROM card_settlements s JOIN card_matches m ON m.settlement_id = s.id JOIN transactions t ON t.id = m.transaction_id
    WHERE s.business_id = ? AND s.paid_at >= ? AND s.paid_at < ? AND t.source = 'bank_sheet' AND json_extract(t.ocr_original, '$.card') = 'booked' AND t.narration LIKE ?
    ORDER BY s.paid_at`, businessId, shiftWindow(addDays(day, -ADVANCE_DAYS)).from, shiftWindow(day).to, `%${ADVANCE_TAG}%`);
}

/** Choices kept in the audit log until the save: the last word for each payment stands. */
export async function cardAdvancePlans(db: DB, businessId: string, day: string) {
  const rows = await all<{ action: string; rowId: string; after: string }>(db, `SELECT action, row_id AS rowId, after FROM audit_log
    WHERE business_id = ? AND action IN ('card.advance_planned', 'card.advance_unplanned') AND json_extract(after, '$.shiftDay') = ? ORDER BY id`, businessId, day);
  const last = new Map<string, { action: string; comparisonId: string }>();
  for (const r of rows) last.set(r.rowId, { action: r.action, comparisonId: (JSON.parse(r.after) as { comparisonId: string }).comparisonId });
  return [...last].filter(([, x]) => x.action === 'card.advance_planned').map(([paymentId, x]) => ({ paymentId, comparisonId: x.comparisonId }));
}

/** The booking goes, the sale takes the advance's day, and the payment is matched to the sale. Works on a sale made earlier in the same batch. */
export async function joinCardAdvanceStatements(db: DB, businessId: string, paymentId: string, saleId: string, saleDay: string, userId: string, t: number) {
  const booked = await one<Record<string, unknown> & { id: string; day: string; head_id: string | null }>(db, `SELECT t.* FROM card_matches m JOIN transactions t ON t.id = m.transaction_id
    WHERE m.business_id = ? AND m.settlement_id = ? AND t.source = 'bank_sheet' AND json_extract(t.ocr_original, '$.card') = 'booked'`, businessId, paymentId);
  if (!booked) return null;
  const matches = await all<Record<string, unknown>>(db, 'SELECT * FROM card_matches WHERE business_id = ? AND settlement_id = ?', businessId, paymentId);
  return [
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'card.advance_joined', 'card_settlements', ?, ?, ?, ?)`,
      businessId, userId, paymentId, JSON.stringify({ booked, matches, saleDay }), JSON.stringify({ transactionId: saleId, day: booked.day }), t),
    stmt(db, 'DELETE FROM card_matches WHERE business_id = ? AND settlement_id = ?', businessId, paymentId),
    stmt(db, "DELETE FROM transactions WHERE id = ? AND source = 'bank_sheet'", booked.id),
    stmt(db, `UPDATE transactions SET day = ?, head_id = coalesce(head_id, ?), ocr_original = json_set(coalesce(ocr_original, '{}'), '$.cardAdvance', ?) WHERE id = ?`,
      booked.day, booked.head_id, paymentId, saleId),
    ...cardMatchStatements(db, businessId, [paymentId], [saleId], userId, t + 1, { how: 'advance on the card machine, joined on saving the shift' }),
  ];
}

/** Undo of a join: the sale waits for its card payment on its own day again, and the advance booking comes back. */
export async function undoCardAdvanceStatements(db: DB, businessId: string, paymentId: string, userId: string, t: number) {
  const a = await one<{ before: string; after: string }>(db, "SELECT before, after FROM audit_log WHERE business_id = ? AND action = 'card.advance_joined' AND row_id = ? ORDER BY id DESC LIMIT 1", businessId, paymentId);
  if (!a) return null;
  const b = JSON.parse(a.before) as { booked: Record<string, unknown>; matches: Record<string, unknown>[]; saleDay: string };
  const saleId = (JSON.parse(a.after) as { transactionId: string }).transactionId;
  const cols = Object.keys(b.booked);
  return [
    stmt(db, 'DELETE FROM card_matches WHERE business_id = ? AND settlement_id = ?', businessId, paymentId),
    stmt(db, `UPDATE transactions SET day = ?, match_status = 'awaiting_card_settlement', ocr_original = json_remove(ocr_original, '$.cardAdvance') WHERE id = ?`, b.saleDay, saleId),
    stmt(db, `INSERT INTO transactions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((k) => b.booked[k])),
    ...b.matches.map((m) => { const k = Object.keys(m); return stmt(db, `INSERT INTO card_matches (${k.join(', ')}) VALUES (${k.map(() => '?').join(', ')})`, ...k.map((x) => m[x])); }),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'card.advance_undone', 'card_settlements', ?, NULL, ?, ?)`,
      businessId, userId, paymentId, JSON.stringify({ transactionId: saleId, bookingRestored: b.booked.id }), t),
  ];
}
