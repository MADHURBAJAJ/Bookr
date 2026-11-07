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
  /** UPI payments written for a bill paid in several goes (or partly another way): each needs its own credit. */
  parts?: number[];
}
export interface EvidenceCredit { id: string; amount: number; postedAt: number; label?: string | null }
export interface Evidence {
  creditId: string; amountPaise: number; postedAt: number; minutes: number | null;
  /** Which side's amount the credit equals. */
  fits: 'both' | 'software' | 'register';
  /** The decision the credit points to, when it settles a difference; null when there is nothing to decide. */
  suggest: 'use_software' | 'use_register' | null;
  /** A bill paid in several UPI goes: one credit per payment. creditId and postedAt are the first; amountPaise is their total. */
  parts?: { creditId: string; amountPaise: number; postedAt: number }[];
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
  // A bill paid in several goes (7 Nov 2026): each UPI payment pairs with its own credit of that amount, within an hour
  // of the bill, closest first. Without a software time, each part must have only one credit in the shift. All or none.
  for (const b of bills) {
    if (!b.parts?.length || out.has(b.id) || b.grouped || b.decision === 'leave_out' || b.decision === 'carry_forward') continue;
    const picks: { c: EvidenceCredit; minutes: number | null }[] = [];
    for (const amount of [...b.parts].sort((x, y) => y - x)) {
      const fits = credits.filter((c) => c.amount === amount && !used.has(c.id) && !picks.some((x) => x.c.id === c.id) && labelFits(b.labels ?? null, c.label ?? null)
        && (b.paidAt != null ? Math.abs(c.postedAt - b.paidAt) <= NEAR_MIN * 60000 : c.postedAt >= window.from && c.postedAt < window.to + 3600e3));
      if (b.paidAt == null && fits.length !== 1) break;
      const best = fits.map((c) => ({ c, minutes: b.paidAt != null ? Math.round(Math.abs(c.postedAt - b.paidAt) / 60000) : null }))
        .sort((x, y) => (x.minutes ?? 0) - (y.minutes ?? 0))[0];
      if (!best) break;
      picks.push(best);
    }
    if (picks.length !== b.parts.length) continue;
    const total = picks.reduce((t, x) => t + x.c.amount, 0);
    const ordered = [...picks].sort((x, y) => x.c.postedAt - y.c.postedAt);
    out.set(b.id, { ...make(b, ordered[0].c, b.paidAt != null ? Math.max(...picks.map((x) => x.minutes ?? 0)) : null), amountPaise: total,
      fits: b.swAmount === total ? 'both' : 'register', suggest: suggestion(b, total),
      parts: ordered.map((x) => ({ creditId: x.c.id, amountPaise: x.c.amount, postedAt: x.c.postedAt })) });
    for (const x of picks) used.add(x.c.id);
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
 * Bills paid together, for Compare sales: the first credit in the shift equal to a group's UPI total, each credit used
 * once and none a single bill has taken. Shown only: it says nothing about which bills the money paid for.
 */
export function pairGroups(groups: { id: string; upiPaise: number; labels: string | null }[], credits: EvidenceCredit[], used: Set<string>, window: { from: number; to: number }) {
  const taken = new Set(used);
  const out = new Map<string, EvidenceCredit>();
  for (const g of groups) {
    if (!g.upiPaise) continue;
    const c = credits.find((x) => !taken.has(x.id) && x.amount === g.upiPaise && x.postedAt >= window.from && x.postedAt < window.to + 3600e3 && labelFits(g.labels, x.label ?? null));
    if (c) { taken.add(c.id); out.set(g.id, c); }
  }
  return out;
}

/**
 * Credits inside the shift that no bill of this shift could explain (no bill of that amount at all, nor a group of
 * bills paid together by UPI, whose one credit is the group's total): money in with no bill. A warning only; it may
 * belong to another shift or not be a sale.
 */
export function creditsWithoutBill(credits: EvidenceCredit[], used: Set<string>, bills: EvidenceBill[], window: { from: number; to: number }, groupPaid: number[] = []) {
  const amounts = new Set([...bills.flatMap((b) => [b.swAmount, b.rgAmount]).filter((x): x is number => x != null), ...groupPaid]);
  return credits.filter((c) => !used.has(c.id) && c.postedAt >= window.from && c.postedAt < window.to && !amounts.has(c.amount));
}
