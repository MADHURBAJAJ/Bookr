/**
 * Money received with no bill on either side (Stage 5 of the reconcile plan, approved 10 Nov 2026).
 *
 * Before a credit is called extra, Bookr looks for a bill it could be: a bill closed as owed by a guest or company, a
 * bill larger than the credit it could be part of, and a second credit of the same amount minutes apart (paid twice).
 * These are suggestions; a person chooses.
 *
 * What a credit can then be, without a new table (option a):
 * - Unbilled sale (as before), or an Advance: booked as an unbilled Room sale, "Advance: <guest>". Its room bill joins
 *   it later as the same sale; the advance may be one payment line of the bill, and is looked for over ADVANCE_DAYS.
 * - Refund due, or a Tip for staff: not income. The credit is held (left out with a "Held: …" note), so the income
 *   report never shows it; a refund that goes out is matched to it, a tip is marked paid out.
 */
import { all, type DB } from './db';
import { addDays, shiftDayOf, shiftWindow } from './time';

export const OWED_PREFIX = 'Owed by ';
export const HELD = { refund: 'Held: refund due', tip: 'Held: tip for staff' } as const;
export type HeldKind = keyof typeof HELD;
export const ADVANCE_TAG = 'Advance: ';
/** How far back a payment looks for an owed bill, and an advance for its room bill. */
export const OWED_DAYS = 60;
export const ADVANCE_DAYS = 60;
/** Two credits of the same amount this close together may be one payment made twice. */
export const TWICE_MIN = 10;
const GAP = 1000; // ₹10

export const heldKindOf = (note: string | null): HeldKind | null =>
  note?.startsWith(HELD.refund) ? 'refund' : note?.startsWith(HELD.tip) ? 'tip' : null;
export const isHeldDone = (note: string | null) => / · (paid back|paid out) /.test(note ?? '');

/** Suggestions for one unmatched credit. */
export async function creditChecks(db: DB, businessId: string, row: { id: string; amount_paise: number; posted_at: number; vpa: string | null }) {
  const day = shiftDayOf(row.posted_at);
  const near = { from: shiftWindow(addDays(day, -1)).from, to: shiftWindow(addDays(day, 1)).to };
  const [owed, twice, waiting, others] = await Promise.all([
    all<{ txId: string; billNo: string | null; day: string; amountPaise: number; note: string }>(db, `
      SELECT t.id AS txId, t.bill_no AS billNo, t.shift_day AS day, t.amount_paise AS amountPaise, b.note
      FROM closed_bills b JOIN transactions t ON t.id = b.transaction_id
      WHERE b.business_id = ? AND b.note LIKE ? AND t.matched_bank_row IS NULL AND abs(t.amount_paise - ?) <= ? AND t.shift_day >= ? AND t.shift_day <= ?
      ORDER BY abs(t.amount_paise - ?), t.shift_day DESC LIMIT 3`,
      businessId, `${OWED_PREFIX}%`, row.amount_paise, GAP, addDays(day, -OWED_DAYS), day, row.amount_paise),
    all<{ id: string; postedAt: number; vpa: string | null; status: string }>(db, `
      SELECT id, posted_at AS postedAt, vpa, status FROM bank_rows
      WHERE business_id = ? AND kind = 'upi_in' AND id <> ? AND amount_paise = ? AND abs(posted_at - ?) <= ?
      ORDER BY abs(posted_at - ?) LIMIT 1`, businessId, row.id, row.amount_paise, row.posted_at, TWICE_MIN * 60000, row.posted_at),
    // Bills still waiting for a credit, as large as this one or larger (21 Nov 2026: only a near-equal amount is told,
    // this credit alone or with one or two other credits left over near it).
    all<{ txId: string; billNo: string | null; day: string; amountPaise: number }>(db, `
      SELECT t.id AS txId, t.bill_no AS billNo, t.shift_day AS day, t.amount_paise AS amountPaise
      FROM transactions t LEFT JOIN bill_comparisons c ON c.id = t.comparison_id LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
      WHERE t.business_id = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.match_status = 'awaiting_bank_match' AND t.matched_bank_row IS NULL
        AND t.amount_paise >= ? - max(?, ? / 100) AND t.shift_day BETWEEN ? AND ? AND (sb.paid_at IS NULL OR sb.paid_at BETWEEN ? AND ?)
      ORDER BY t.amount_paise LIMIT 20`, businessId, row.amount_paise, GAP, row.amount_paise, addDays(day, -1), addDays(day, 1), near.from, near.to),
    all<{ id: string; amountPaise: number; postedAt: number }>(db, `
      SELECT id, amount_paise AS amountPaise, posted_at AS postedAt FROM bank_rows
      WHERE business_id = ? AND kind = 'upi_in' AND direction = 'CR' AND status = 'unmatched' AND id <> ? AND posted_at >= ? AND posted_at < ?
      ORDER BY posted_at LIMIT 300`, businessId, row.id, near.from, near.to),
  ]);
  const t2 = twice[0];
  // The same payer, where the bank shows both; otherwise only the amount and the minutes.
  // xxz555@axl and xxz555@ybl are one payer on two UPI apps (20 Nov 2026): the name before @ is compared.
  const who = (v: string | null) => (v ?? '').toLowerCase().split('@')[0];
  const same = !!row.vpa && !!t2?.vpa && who(row.vpa) === who(t2.vpa);
  const paidTwice = t2 && (!row.vpa || !t2.vpa || same)
    ? { id: t2.id, postedAt: t2.postedAt, minutes: Math.round(Math.abs(t2.postedAt - row.posted_at) / 60000), samePayer: same, status: t2.status } : null;
  // Near: within ₹10 or 1% of the bill, whichever is more.
  const near1 = (bill: number, got: number) => Math.abs(bill - got) <= Math.max(GAP, Math.floor(bill / 100));
  const parts: { txId: string; billNo: string | null; day: string; amountPaise: number; credits: { id: string; amountPaise: number; postedAt: number }[]; exact: boolean }[] = [];
  for (const b of waiting) {
    if (near1(b.amountPaise, row.amount_paise)) { parts.push({ ...b, credits: [], exact: b.amountPaise === row.amount_paise }); continue; }
    const fit = others.filter((o) => o.amountPaise < b.amountPaise);
    let found: typeof others | null = null;
    for (let i = 0; i < fit.length && !found; i++) {
      if (near1(b.amountPaise, row.amount_paise + fit[i].amountPaise)) found = [fit[i]];
      for (let j = i + 1; j < fit.length && !found; j++) if (near1(b.amountPaise, row.amount_paise + fit[i].amountPaise + fit[j].amountPaise)) found = [fit[i], fit[j]];
    }
    if (found) parts.push({ ...b, credits: found, exact: b.amountPaise === row.amount_paise + found.reduce((t, x) => t + x.amountPaise, 0) });
    if (parts.length >= 3) break;
  }
  return { day, owed, paidTwice, parts };
}

/** Credits held as a refund due or a tip for staff, and for a refund not paid back yet, the payments out that could be it. */
export async function heldList(db: DB, businessId: string) {
  const rows = await all<{ id: string; amountPaise: number; postedAt: number; vpa: string | null; note: string; accountName: string | null; paidById: string | null }>(db, `
    SELECT r.id, r.amount_paise AS amountPaise, r.posted_at AS postedAt, r.vpa, r.note, a.name AS accountName,
      (SELECT d.id FROM bank_rows d WHERE d.pair_row_id = r.id AND d.direction = 'DR' LIMIT 1) AS paidById
    FROM bank_rows r LEFT JOIN accounts a ON a.id = r.account_id
    WHERE r.business_id = ? AND r.status = 'ignored' AND r.direction = 'CR' AND (r.note LIKE 'Held: refund due%' OR r.note LIKE 'Held: tip for staff%')
    ORDER BY r.posted_at DESC LIMIT 200`, businessId);
  const out = [];
  for (const r of rows) {
    const kind = heldKindOf(r.note)!;
    const done = isHeldDone(r.note);
    const outs = kind === 'refund' && !done ? await all<{ id: string; postedAt: number; vpa: string | null; description: string }>(db, `
      SELECT id, posted_at AS postedAt, vpa, description FROM bank_rows
      WHERE business_id = ? AND direction = 'DR' AND status = 'unmatched' AND amount_paise = ? AND posted_at > ? AND posted_at <= ?
      ORDER BY (vpa IS NOT NULL AND vpa = ?) DESC, posted_at LIMIT 3`, businessId, r.amountPaise, r.postedAt, r.postedAt + OWED_DAYS * 86400000, r.vpa ?? '') : [];
    out.push({ ...r, kind, done, day: shiftDayOf(r.postedAt), outs });
  }
  return out;
}
