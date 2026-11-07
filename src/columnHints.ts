// A UPI payment written under the wrong account's column (approved 7 Nov 2026). The register says "UPI Bank 2" but
// the money came into another account. When no credit of that amount came into the written account near the bill,
// and one did come into another account, Bookr says so and offers to change the column. Nothing changes by itself.
// Shown only to people who can match the bank (Owner, Accountant): the routes check the role before calling this.

import { labelFits } from './bank';
import { all, type DB } from './db';
import { shiftWindow } from './time';

/** Paired within this many minutes of the software's time, as on Compare sales. */
const NEAR_MIN = 60;

export interface HintPay { paymentId: string; rowId: string; uploadId: string; billNo: string | null; amount: number; label: string | null; paidAt: number | null }
export interface HintCredit { id: string; amount: number; postedAt: number; label: string | null; accountName: string }
export interface ColumnHint {
  paymentId: string; rowId: string; uploadId: string; billNo: string | null; amountPaise: number;
  fromLabel: string; toLabel: string; accountName: string; creditId: string; postedAt: number; minutes: number | null;
  /** On a confirmed shift: the bill's UPI sales the credit would be matched to, when they add up to it. */
  transactionIds?: string[];
}

const norm = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Pairs each payment with a credit first in its own column's account (closest first, each credit once); a payment
 * left without one is then offered a credit of the same amount in another account. A payment with no software time
 * takes a credit only when it is the only one in the shift.
 */
export function wrongColumn(pays: HintPay[], credits: HintCredit[], window: { from: number; to: number }, accountLabels: string[]): ColumnHint[] {
  const labels = new Set(accountLabels.map(norm).filter(Boolean));
  const near = (p: HintPay, c: HintCredit) => p.paidAt != null
    ? Math.abs(c.postedAt - p.paidAt) <= NEAR_MIN * 60000
    : c.postedAt >= window.from - 3600e3 && c.postedAt < window.to + 3600e3;
  const minutes = (p: HintPay, c: HintCredit) => (p.paidAt != null ? Math.round(Math.abs(c.postedAt - p.paidAt) / 60000) : null);
  const used = new Set<string>();
  const paid = new Set<string>();
  const assign = (fits: (p: HintPay, c: HintCredit) => boolean, take: (p: HintPay, c: HintCredit) => void) => {
    const timed: { p: HintPay; c: HintCredit; m: number }[] = [];
    for (const p of pays) for (const c of credits) if (p.paidAt != null && c.amount === p.amount && near(p, c) && fits(p, c)) timed.push({ p, c, m: minutes(p, c)! });
    timed.sort((a, b) => a.m - b.m);
    for (const x of timed) if (!paid.has(x.p.paymentId) && !used.has(x.c.id)) { take(x.p, x.c); paid.add(x.p.paymentId); used.add(x.c.id); }
    for (const p of pays) {
      if (p.paidAt != null || paid.has(p.paymentId)) continue;
      const options = credits.filter((c) => !used.has(c.id) && c.amount === p.amount && near(p, c) && fits(p, c));
      const rivals = pays.filter((q) => !paid.has(q.paymentId) && q.amount === p.amount);
      if (options.length !== 1 || rivals.length !== 1) continue;
      take(p, options[0]); paid.add(p.paymentId); used.add(options[0].id);
    }
  };
  // First: every payment whose column fits the credit's account (a plain "UPI" column fits any).
  assign((p, c) => labelFits(p.label, c.label), () => {});
  // Then: a payment written under one account's column, and a credit in another account.
  const out: ColumnHint[] = [];
  assign((p, c) => labels.has(norm(p.label)) && !!c.label && labels.has(norm(c.label)) && norm(c.label) !== norm(p.label),
    (p, c) => out.push({ paymentId: p.paymentId, rowId: p.rowId, uploadId: p.uploadId, billNo: p.billNo, amountPaise: p.amount,
      fromLabel: p.label!, toLabel: c.label!, accountName: c.accountName, creditId: c.id, postedAt: c.postedAt, minutes: minutes(p, c) }));
  return out;
}

/** The labels on accounts that receive UPI. */
export const accountLabels = async (db: DB, businessId: string) =>
  (await all<{ label: string }>(db, 'SELECT receives_upi_label AS label FROM bank_sources WHERE business_id = ? AND receives_upi_label IS NOT NULL', businessId)).map((x) => x.label);

/**
 * Hints for one shift. Before it is confirmed, every UPI payment counts. After, only payments whose sales still wait
 * for the bank, with those sales' ids so the change and the match can be made together.
 */
export async function columnHints(db: DB, businessId: string, day: string): Promise<ColumnHint[]> {
  const w = shiftWindow(day);
  const [labels, pays, credits, waiting, status] = await Promise.all([
    accountLabels(db, businessId),
    all<HintPay>(db, `SELECT p.id AS paymentId, r.id AS rowId, r.upload_id AS uploadId, r.bill_no AS billNo, p.amount_paise AS amount, p.column_label AS label,
        (SELECT max(sb.paid_at) FROM register_rows m JOIN software_bills sb ON sb.business_id = m.business_id AND sb.shift_day = m.shift_day AND sb.bill_no = m.bill_no
          WHERE m.id = r.id OR m.paid_with_row_id = r.id) AS paidAt
      FROM register_payments p JOIN register_rows r ON r.id = p.register_row_id
      WHERE r.business_id = ? AND r.shift_day = ? AND p.mode = 'upi' AND p.amount_paise > 0 ORDER BY r.upload_id, r.line_no`, businessId, day),
    all<HintCredit>(db, `SELECT r.id, r.amount_paise AS amount, r.posted_at AS postedAt, s.receives_upi_label AS label, a.name AS accountName FROM bank_rows r
      JOIN accounts a ON a.id = r.account_id LEFT JOIN bank_sources s ON s.account_id = r.account_id
      WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.status = 'unmatched' AND r.posted_at >= ? AND r.posted_at < ? ORDER BY r.posted_at`,
      businessId, w.from - 3600e3, w.to + 3 * 3600e3),
    all<{ id: string; rowId: string; amount: number; head: string }>(db, `SELECT t.id, rr.id AS rowId, t.amount_paise AS amount, coalesce(rr.paid_with_row_id, rr.id) AS head
      FROM transactions t JOIN bill_comparisons c ON c.id = t.comparison_id JOIN register_rows rr ON rr.id = c.register_row_id
      WHERE t.business_id = ? AND t.shift_day = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.match_status = 'awaiting_bank_match' AND t.matched_bank_row IS NULL`,
      businessId, day),
    all<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', businessId, day),
  ]);
  if (!labels.length) return [];
  if (status[0]?.status !== 'confirmed') return wrongColumn(pays, credits, w, labels);
  // Confirmed: the payment's sales are its row's (or, for bills paid together, the group's) UPI sales still waiting.
  const salesOf = (p: HintPay) => {
    const mine = waiting.filter((t) => t.head === p.rowId);
    if (mine.reduce((s, t) => s + t.amount, 0) === p.amount) return mine.map((t) => t.id);
    const one = mine.find((t) => t.amount === p.amount);
    return one ? [one.id] : null;
  };
  const open = pays.map((p) => ({ p, ids: salesOf(p) })).filter((x) => x.ids);
  const idsOf = new Map(open.map((x) => [x.p.paymentId, x.ids!]));
  return wrongColumn(open.map((x) => x.p), credits, w, labels).map((h) => ({ ...h, transactionIds: idsOf.get(h.paymentId) }));
}
