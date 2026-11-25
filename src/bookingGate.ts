// The booking gate (E1, approved 25 Nov 2026). Before a line of money received is booked under a head, every way of
// booking it (a tile, "Book N selected", a rule) runs these checks on the server. Nothing found: it books as before.
// Something found: it is not booked, and the person is told what it likely is, with that as the main button:
//  - card:       card machine money. Its sales are income from their shifts already; never booked under a head.
//  - held:       a credit chosen on Reconcile for a shift not saved yet (a plan). It is matched when that shift is saved.
//  - waiting:    a bill of this amount waits for its money (7 days either side, any amount, the UPI part of a split bill too).
//  - settlement: a Yes Bank UPI collection settlement while desk UPI bills of the 3 days before it wait.
//  - transfer:   the other half of money moved between the business's own accounts.
//  - cash:       cash from the drawer paid into the bank.
// card and held cannot be overridden. The rest can: "Book anyway" by an Owner or Accountant, with a reason kept on the
// line and in the audit log.
import { all, one, type DB } from './db';
import type { BankRow } from './bank';
import { cashMoveOf } from './cash';
import { transferHints } from './transfers';
import { waitingBillsLike } from './sameSale';
import { addDays } from './time';

export const SETTLEMENT_REMARK = 'UPI collection settlement';
export const SETTLEMENT_BACK_DAYS = 3;

export type GateCheck =
  | { check: 'card'; block: true; text: string }
  | { check: 'held'; block: true; text: string; day: string; billNos: string[] }
  | { check: 'waiting'; block: false; text: string; bills: { billNo: string; day: string; txId: string | null; billPaise: number; upiPaise: number }[] }
  | { check: 'settlement'; block: false; text: string; bills: { billNo: string | null; day: string; amountPaise: number }[]; from: string; to: string }
  | { check: 'transfer'; block: false; text: string; otherAccountId: string; otherAccountName: string; pairRowId: string | null; legId: string | null;
      booked: { rowId: string; headName: string | null } | null }
  | { check: 'cash'; block: false; text: string };

const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const refsOf = (d: string) => new Set(d.match(/\d{9,}/g) ?? []);

/** What stops this line being booked under a head now. Empty: book it. Only money received is checked. */
export async function bookingGate(db: DB, businessId: string, row: BankRow): Promise<GateCheck[]> {
  if (row.direction !== 'CR' || row.status !== 'unmatched') return [];
  if (row.kind === 'card_settlement') {
    return [{ check: 'card', block: true, text: 'Card machine money: its card sales are income from their shifts already. Settle it on Card settlements, which books only the fee and GST.' }];
  }
  const out: GateCheck[] = [];
  const held = await one<{ shift_day: string; comparison_ids: string; kind: string }>(db, `SELECT p.shift_day, p.comparison_ids, p.kind FROM shift_plan_items i
    JOIN shift_plans p ON p.id = i.plan_id WHERE i.business_id = ? AND i.bank_row_id = ?`, businessId, row.id);
  if (held) {
    const ids = JSON.parse(held.comparison_ids) as string[];
    const names = ids.length ? (await all<{ bill_no: string | null }>(db, `SELECT bill_no FROM bill_comparisons WHERE business_id = ? AND id IN (${ids.map(() => '?').join(',')})
      UNION ALL SELECT bill_no FROM transactions WHERE business_id = ? AND id IN (${ids.map(() => '?').join(',')})`, businessId, ...ids, businessId, ...ids)).map((x) => x.bill_no ?? '?') : [];
    out.push({ check: 'held', block: true, day: held.shift_day, billNos: names,
      text: `This credit is chosen on ${held.shift_day} Reconcile${names.length ? ` for bill ${names.join(' + ')}` : ''}: it is matched when that shift is saved.` });
    return out;
  }

  // The other half of a transfer between own accounts: an open line, a transfer booked from the other side, or the other
  // side booked under a head with the same bank reference (then that booking is put back first).
  const hint = (await transferHints(db, businessId, [row])).get(row.id);
  if (hint && hint.why !== 'words') {
    out.push({ check: 'transfer', block: false, otherAccountId: hint.otherAccountId, otherAccountName: hint.otherAccountName, pairRowId: hint.pairRowId, legId: hint.legId, booked: null,
      text: `The same ${rs(row.amount_paise)} left ${hint.otherAccountName}: money moved between your own accounts, not income.` });
  } else {
    const mine = refsOf(row.description);
    if (mine.size) {
      const sides = await all<{ id: string; account_id: string; account_name: string; description: string; head_name: string | null }>(db, `
        SELECT r.id, r.account_id, a.name AS account_name, r.description, h.name AS head_name
        FROM bank_rows r JOIN accounts a ON a.id = r.account_id LEFT JOIN transactions bt ON bt.id = r.transaction_id LEFT JOIN heads h ON h.id = bt.head_id
        WHERE r.business_id = ? AND r.status = 'booked' AND r.direction = 'DR' AND r.account_id <> ? AND r.amount_paise = ? AND r.posted_at BETWEEN ? AND ?
          AND coalesce(bt.type, '') <> 'transfer'`, businessId, row.account_id, row.amount_paise, row.posted_at - 3 * 86400e3, row.posted_at + 3 * 86400e3);
      const o = sides.find((x) => [...refsOf(x.description)].some((k) => mine.has(k)));
      if (o) out.push({ check: 'transfer', block: false, otherAccountId: o.account_id, otherAccountName: o.account_name, pairRowId: o.id, legId: null,
        booked: { rowId: o.id, headName: o.head_name },
        text: `The same ${rs(row.amount_paise)} left ${o.account_name} (same reference), booked there as ${o.head_name ?? 'an expense'}: money moved between your own accounts.` });
    }
  }

  if (cashMoveOf(row) === 'deposit') {
    out.push({ check: 'cash', block: false, text: 'Cash from the drawer paid into the bank is not income: the cash sales were counted on their shift.' });
  }

  if (row.remark === SETTLEMENT_REMARK) {
    const from = addDays(row.day, -SETTLEMENT_BACK_DAYS);
    const to = addDays(row.day, -1);
    const bills = await all<{ billNo: string | null; day: string; amountPaise: number }>(db, `SELECT t.bill_no AS billNo, t.shift_day AS day, t.amount_paise AS amountPaise
      FROM transactions t WHERE t.business_id = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.match_status = 'awaiting_bank_match' AND t.matched_bank_row IS NULL
        AND t.shift_day BETWEEN ? AND ? AND t.amount_paise <= ? AND t.id NOT IN (SELECT transaction_id FROM closed_bills WHERE business_id = ?)
      ORDER BY t.shift_day, t.bill_no LIMIT 10`, businessId, from, to, row.amount_paise, businessId);
    if (bills.length) out.push({ check: 'settlement', block: false, bills, from, to,
      text: `Desk UPI bills of ${from} to ${to} still wait for their money: this settlement may hold them.` });
  } else {
    const bills = await waitingBillsLike(db, businessId, row.amount_paise, row.day, row.id);
    if (bills.length) out.push({ check: 'waiting', block: false, bills,
      text: `${bills.length === 1 ? `Bill ${bills[0].billNo} waits` : `${bills.length} bills wait`} for ${rs(row.amount_paise)}: booking this too would count one sale twice.` });
  }
  return out;
}

/** A short reason for a list ("Book N selected"): the first check, in a few words. */
export function gateWord(checks: GateCheck[]) {
  const c = checks[0];
  if (!c) return '';
  switch (c.check) {
    case 'card': return 'card machine money';
    case 'held': return `chosen on ${c.day} Reconcile`;
    case 'waiting': return `bill ${c.bills.map((b) => b.billNo).join(', ')} waiting`;
    case 'settlement': return `desk bill ${c.bills.map((b) => b.billNo ?? '?').join(', ')} may be inside`;
    case 'transfer': return `transfer from ${c.otherAccountName}`;
    case 'cash': return 'cash deposited';
  }
}
