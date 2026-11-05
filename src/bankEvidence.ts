// The bank as a third witness on Compare sales (approved 5 Nov 2026). Before a shift is confirmed, each UPI bill is
// paired with an unmatched UPI credit of the same amount near its time, each credit used once, closest first. Where
// the credit settles a difference (mode or amount), that choice is suggested; the person accepts it. No credit
// suggests nothing. On confirm, the credits shown here are matched to the bills' income rows (see confirmShift).

import { labelFits } from './bank';
import { all, one, type DB } from './db';
import { shiftWindow } from './time';

/** Paired within this many minutes of the software's time. */
const NEAR_MIN = 60;

export interface EvidenceBill {
  id: string; paidAt: number | null; difference: string; decision: string | null; grouped: boolean;
  swAmount: number | null; swMode: string | null; rgAmount: number | null; rgMode: string | null;
  /** The register's UPI column(s): the credit must have come into an account with that label, as on UPI matching. */
  labels?: string | null;
}
export interface EvidenceCredit { id: string; amount: number; postedAt: number; label?: string | null }
export interface Evidence {
  creditId: string; amountPaise: number; postedAt: number; minutes: number | null;
  /** Which side's amount the credit equals. */
  fits: 'both' | 'software' | 'register';
  /** The decision the credit points to, when it settles a difference; null when there is nothing to decide. */
  suggest: 'use_software' | 'use_register' | null;
}

/** Amounts a bill could have been paid by UPI: a side counts when it says UPI, or when the other side does (mode slips). */
function upiAmounts(b: EvidenceBill): { amount: number; side: 'software' | 'register' }[] {
  const swUpi = b.swMode === 'upi';
  const rgUpi = b.rgMode === 'upi';
  if (!swUpi && !rgUpi) return [];
  const out: { amount: number; side: 'software' | 'register' }[] = [];
  if (b.swAmount != null) out.push({ amount: b.swAmount, side: 'software' });
  if (b.rgAmount != null) out.push({ amount: b.rgAmount, side: 'register' });
  return out;
}

/** What the credit says about the difference. Only a side that says UPI can be the one the bank backs. */
function suggestion(b: EvidenceBill, amount: number): Evidence['suggest'] {
  const sw = b.swAmount === amount && b.swMode === 'upi';
  const rg = b.rgAmount === amount && b.rgMode === 'upi';
  if (b.difference === 'mode' || b.difference === 'amount' || b.difference === 'amount_and_mode') {
    if (sw && !rg) return 'use_software';
    if (rg && !sw) return 'use_register';
  }
  return null;
}

/**
 * Pairs bills and credits. A bill with a software time pairs within an hour, closest first. A register-only bill
 * (no time) pairs only when it and a credit inside the shift are each other's only choice.
 */
export function pairEvidence(bills: EvidenceBill[], credits: EvidenceCredit[], window: { from: number; to: number }) {
  const timed: { bill: EvidenceBill; credit: EvidenceCredit; minutes: number; side: 'software' | 'register' }[] = [];
  const untimed: { bill: EvidenceBill; credit: EvidenceCredit; side: 'software' | 'register' }[] = [];
  for (const b of bills) {
    if (b.grouped || b.decision === 'leave_out' || b.decision === 'carry_forward') continue;
    for (const a of upiAmounts(b)) {
      for (const c of credits) {
        if (c.amount !== a.amount || !labelFits(b.labels ?? null, c.label ?? null)) continue;
        if (b.paidAt != null) {
          const minutes = Math.round(Math.abs(c.postedAt - b.paidAt) / 60000);
          if (minutes <= NEAR_MIN) timed.push({ bill: b, credit: c, minutes, side: a.side });
        } else if (c.postedAt >= window.from && c.postedAt < window.to + 3600e3) {
          untimed.push({ bill: b, credit: c, side: a.side });
        }
      }
    }
  }
  timed.sort((x, y) => x.minutes - y.minutes);
  const out = new Map<string, Evidence>();
  const used = new Set<string>();
  const make = (b: EvidenceBill, c: EvidenceCredit, minutes: number | null): Evidence => {
    const sw = b.swAmount === c.amount;
    const rg = b.rgAmount === c.amount;
    return { creditId: c.id, amountPaise: c.amount, postedAt: c.postedAt, minutes, fits: sw && rg ? 'both' : sw ? 'software' : 'register', suggest: suggestion(b, c.amount) };
  };
  for (const p of timed) {
    if (out.has(p.bill.id) || used.has(p.credit.id)) continue;
    out.set(p.bill.id, make(p.bill, p.credit, p.minutes));
    used.add(p.credit.id);
  }
  const left = untimed.filter((p) => !out.has(p.bill.id) && !used.has(p.credit.id));
  for (const p of left) {
    const sameBill = new Set(left.filter((q) => q.bill.id === p.bill.id).map((q) => q.credit.id));
    const sameCredit = new Set(left.filter((q) => q.credit.id === p.credit.id).map((q) => q.bill.id));
    // A credit some timed bill could also take is not certain either.
    const wanted = bills.some((b) => b.paidAt != null && !out.has(b.id) && upiAmounts(b).some((a) => a.amount === p.credit.amount));
    if (sameBill.size !== 1 || sameCredit.size !== 1 || wanted) continue;
    out.set(p.bill.id, make(p.bill, p.credit, null));
    used.add(p.credit.id);
  }
  return { evidence: out, used };
}

/** Is the bank in for a shift? The statement runs to about 8 am; the latest line of any UPI account counts. */
export async function bankIn(db: DB, businessId: string, day: string) {
  const w = shiftWindow(day);
  const last = await one<{ at: number | null }>(db, `SELECT max(r.posted_at) AS at FROM bank_rows r JOIN bank_sources s ON s.account_id = r.account_id
    WHERE r.business_id = ? AND s.receives_upi_label IS NOT NULL`, businessId);
  return { covered: (last?.at ?? 0) >= w.to - 30 * 60000, lastBankAt: last?.at ?? null };
}

/** Unmatched UPI credits that could pay this shift's bills: from an hour before it starts to three hours after it ends. */
export const shiftCredits = (db: DB, businessId: string, day: string) => {
  const w = shiftWindow(day);
  return all<EvidenceCredit>(db, `SELECT r.id, r.amount_paise AS amount, r.posted_at AS postedAt, s.receives_upi_label AS label FROM bank_rows r
    LEFT JOIN bank_sources s ON s.account_id = r.account_id
    WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.status = 'unmatched' AND r.posted_at >= ? AND r.posted_at < ? ORDER BY r.posted_at`,
    businessId, w.from - 3600e3, w.to + 3 * 3600e3);
};

/**
 * Credits inside the shift that no bill of this shift could explain (no bill of that amount at all): money in with
 * no bill. A warning only; it may belong to another shift or not be a sale.
 */
export function creditsWithoutBill(credits: EvidenceCredit[], used: Set<string>, bills: EvidenceBill[], window: { from: number; to: number }) {
  const amounts = new Set(bills.flatMap((b) => [b.swAmount, b.rgAmount]).filter((x): x is number => x != null));
  return credits.filter((c) => !used.has(c.id) && c.postedAt >= window.from && c.postedAt < window.to && !amounts.has(c.amount));
}
