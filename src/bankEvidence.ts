// The bank as a third witness on Compare sales (approved 5 Nov 2026). Before a shift is confirmed, each UPI bill is
// paired with an unmatched UPI credit of the same amount near its time, each credit used once, closest first. Where
// the credit settles a difference (mode or amount), that choice is suggested; the person accepts it. No credit
// suggests nothing. On confirm, the credits shown here are matched to the bills' income rows (see confirmShift).

import { labelFits } from './bank';
import { all, one, type DB } from './db';
import { shiftWindow } from './time';

/** Paired within this many minutes of the software's time. */
const NEAR_MIN = 60;
/**
 * The software's time is when the bill was closed, which can be well after the guest paid (approved 8 Nov 2026): a bill
 * with no credit within the hour looks back this far, when that stretch holds only one credit of its amount.
 */
export const FAR_BACK_MIN = 120;

export interface EvidenceBill {
  id: string; billNo?: string | null; paidAt: number | null; difference: string; decision: string | null; grouped: boolean;
  swAmount: number | null; swMode: string | null; rgAmount: number | null; rgMode: string | null;
  /** The register's UPI column(s): the credit must have come into an account with that label, as on UPI matching. */
  labels?: string | null;
  /** UPI payments written for a bill paid in several goes (or partly another way): each needs its own credit. */
  parts?: number[];
}
export interface EvidenceCredit { id: string; amount: number; postedAt: number; label?: string | null; remark?: string | null;
  /** A UPI payment on the card machine (approved 9 Nov 2026): it reaches the bank in the machine's settlement of that day. */
  machine?: { settledOn: string; label: string } }
export interface Evidence {
  creditId: string; amountPaise: number; postedAt: number; minutes: number | null;
  /** Which side's amount the credit equals. */
  fits: 'both' | 'software' | 'register';
  /** The decision the credit points to, when it settles a difference; null when there is nothing to decide. */
  suggest: 'use_software' | 'use_register' | null;
  /** A credit of each side's amount came: the bank cannot say which side is right. */
  bothSides?: boolean;
  /** A bill paid in several UPI goes: one credit per payment. creditId and postedAt are the first; amountPaise is their total. */
  parts?: { creditId: string; amountPaise: number; postedAt: number; machine?: { settledOn: string; label: string } }[];
  /** Paid by UPI on the card machine: the payment's settlement day and label. */
  machine?: { settledOn: string; label: string };
  /** The guest paid one payment in several credits (e.g. a UPI app limit): parts are those credits, all for one payment. */
  split?: boolean;
  /** The credit's UPI note names this bill. */
  byNote?: boolean;
}

/** A guest splitting one payment: credits this close together, two or three of them. */
const SPLIT_SPAN_MIN = 30;
/** A UPI note naming a bill is believed this far from the bill's time (a guest paying ahead, or late). */
const NOTE_MIN = 12 * 60;
/** Does a UPI note name this bill number (as a whole number, not inside a longer one)? */
export const noteNames = (remark: string | null | undefined, billNo: string | null | undefined) =>
  !!remark && !!billNo && billNo.length >= 3 && new RegExp(`(^|\\D)${billNo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\D|$)`).test(remark);

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
    return { creditId: c.id, amountPaise: c.amount, postedAt: c.postedAt, minutes, fits: sw && rg ? 'both' : sw ? 'software' : 'register', suggest: suggestion(b, c.amount),
      ...(c.machine ? { machine: c.machine } : {}) };
  };
  // A credit whose UPI note names a bill of its amount pays that bill, before any pairing by time (audit, 9 Nov 2026).
  for (const c of credits) {
    if (!c.remark) continue;
    const named = bills.filter((b) => !b.grouped && b.decision !== 'leave_out' && b.decision !== 'carry_forward' && noteNames(c.remark, b.billNo)
      && upiAmounts(b).some((a) => a.amount === c.amount) && labelFits(b.labels ?? null, c.label ?? null)
      && (b.paidAt != null ? Math.abs(c.postedAt - b.paidAt) <= NOTE_MIN * 60000 : c.postedAt >= window.from && c.postedAt < window.to + 3600e3));
    if (named.length !== 1 || out.has(named[0].id)) continue;
    const b = named[0];
    out.set(b.id, { ...make(b, c, b.paidAt != null ? Math.round(Math.abs(c.postedAt - b.paidAt) / 60000) : null), byNote: true });
    used.add(c.id);
  }
  for (const p of timed) {
    if (out.has(p.bill.id) || used.has(p.credit.id)) continue;
    out.set(p.bill.id, make(p.bill, p.credit, p.minutes));
    used.add(p.credit.id);
  }
  const left = untimed.filter((p) => !out.has(p.bill.id) && !used.has(p.credit.id));
  for (const p of left) {
    const sameBill = new Set(left.filter((q) => q.bill.id === p.bill.id).map((q) => q.credit.id));
    const sameCredit = new Set(left.filter((q) => q.credit.id === p.credit.id).map((q) => q.bill.id));
    // A credit some timed bill could also take is not certain either: one within its reach (2 h before to 1 h after).
    const wanted = bills.some((b) => b.paidAt != null && !out.has(b.id) && upiAmounts(b).some((a) => a.amount === p.credit.amount)
      && p.credit.postedAt >= b.paidAt - FAR_BACK_MIN * 60000 && p.credit.postedAt <= b.paidAt + NEAR_MIN * 60000);
    if (sameBill.size !== 1 || sameCredit.size !== 1 || wanted) continue;
    out.set(p.bill.id, make(p.bill, p.credit, null));
    used.add(p.credit.id);
  }
  // Paid well before the bill was closed: a timed bill still without a credit takes the one credit of its amount from
  // FAR_BACK_MIN before its time to NEAR_MIN after, when no other credit of that amount lies there (taken or not) and no
  // other bill still without a credit could take it.
  const reach = (b: EvidenceBill, c: EvidenceCredit) => b.paidAt != null && c.postedAt >= b.paidAt - FAR_BACK_MIN * 60000 && c.postedAt <= b.paidAt + NEAR_MIN * 60000;
  const looking = (b: EvidenceBill) => b.paidAt != null && !out.has(b.id) && !b.grouped && !b.parts?.length && b.decision !== 'leave_out' && b.decision !== 'carry_forward';
  for (const b of bills) {
    if (!looking(b)) continue;
    const fits = [...new Map(upiAmounts(b).flatMap((a) => credits.filter((c) => c.amount === a.amount && labelFits(b.labels ?? null, c.label ?? null) && reach(b, c)))
      .map((c) => [c.id, c])).values()];
    if (fits.length !== 1 || used.has(fits[0].id)) continue;
    const c = fits[0];
    if (bills.some((o) => o.id !== b.id && looking(o) && upiAmounts(o).some((a) => a.amount === c.amount) && reach(o, c))) continue;
    out.set(b.id, make(b, c, Math.round(Math.abs(c.postedAt - b.paidAt!) / 60000)));
    used.add(c.id);
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
    // The credits equal the register's UPI part of a bill the software calls one mode (UPI, or card or cash for a split
    // card + UPI, Stage 7): they back the register's split. The card part is checked against the machine (sales.ts).
    const split = !!b.swMode && b.swMode !== 'mixed' && b.swMode !== 'unknown' && b.rgMode === 'mixed' && b.swAmount !== total && (b.difference === 'mode' || b.difference === 'amount_and_mode') ? 'use_register' as const : null;
    out.set(b.id, { ...make(b, ordered[0].c, b.paidAt != null ? Math.max(...picks.map((x) => x.minutes ?? 0)) : null), amountPaise: total,
      fits: b.swAmount === total ? 'both' : 'register', suggest: suggestion(b, total) ?? split,
      parts: ordered.map((x) => ({ creditId: x.c.id, amountPaise: x.c.amount, postedAt: x.c.postedAt, ...(x.c.machine ? { machine: x.c.machine } : {}) })) });
    for (const x of picks) used.add(x.c.id);
  }
  // One payment, several credits (audit, 9 Nov 2026): a guest whose UPI app stops at a limit pays a bill in two or three
  // goes, while the register writes one. A timed bill still without a credit, written as one UPI payment, takes two or
  // three free credits within SPLIT_SPAN_MIN of each other, in its reach, that add up exactly to its UPI amount, when
  // that is the only such set, none of them is an amount some bill still looking could take, and no other bill could
  // take any of them this way.
  const looking2 = bills.filter((b) => b.paidAt != null && !out.has(b.id) && !b.grouped && !(b.parts && b.parts.length > 1)
    && b.decision !== 'leave_out' && b.decision !== 'carry_forward');
  const wantedAmount = new Set(looking2.flatMap((b) => upiAmounts(b).map((a) => a.amount)));
  const sets = new Map<string, EvidenceCredit[][]>();
  for (const b of looking2) {
    const pool = credits.filter((c) => !used.has(c.id) && !wantedAmount.has(c.amount) && reach(b, c) && labelFits(b.labels ?? null, c.label ?? null)).slice(0, 20);
    const found: EvidenceCredit[][] = [];
    const targets = new Set(upiAmounts(b).map((a) => a.amount));
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
      const two = [pool[i], pool[j]];
      if (targets.has(pool[i].amount + pool[j].amount)) found.push(two);
      for (let k = j + 1; k < pool.length; k++) if (targets.has(pool[i].amount + pool[j].amount + pool[k].amount)) found.push([...two, pool[k]]);
    }
    const tight = found.filter((set) => { const ts = set.map((c) => c.postedAt); return Math.max(...ts) - Math.min(...ts) <= SPLIT_SPAN_MIN * 60000; });
    if (tight.length) sets.set(b.id, tight);
  }
  for (const b of looking2) {
    const mine = sets.get(b.id);
    if (!mine || mine.length !== 1) continue;
    const set = [...mine[0]].sort((x, y) => x.postedAt - y.postedAt);
    const ids = new Set(set.map((c) => c.id));
    if ([...sets].some(([id, other]) => id !== b.id && other.some((o) => o.some((c) => ids.has(c.id))))) continue;
    const total = set.reduce((t, c) => t + c.amount, 0);
    out.set(b.id, { ...make(b, set[0], Math.max(...set.map((c) => Math.round(Math.abs(c.postedAt - b.paidAt!) / 60000)))), amountPaise: total,
      fits: b.swAmount === total && b.rgAmount === total ? 'both' : b.swAmount === total ? 'software' : 'register', suggest: suggestion(b, total), split: true,
      parts: set.map((c) => ({ creditId: c.id, amountPaise: c.amount, postedAt: c.postedAt, ...(c.machine ? { machine: c.machine } : {}) })) });
    set.forEach((c) => used.add(c.id));
  }
  // A credit backs one side only when the other side's amount has no free credit near too (audit, 9 Nov 2026): with a
  // credit for each, the bank cannot choose.
  for (const b of bills) {
    const e = out.get(b.id);
    if (!e?.suggest || e.parts) continue;
    const other = e.suggest === 'use_register' ? b.swAmount : b.rgAmount;
    if (other == null || other === e.amountPaise) continue;
    const rival = credits.some((c) => !used.has(c.id) && c.amount === other && (b.paidAt == null ? c.postedAt >= window.from && c.postedAt < window.to + 3600e3
      : c.postedAt >= b.paidAt - FAR_BACK_MIN * 60000 && c.postedAt <= b.paidAt + NEAR_MIN * 60000));
    if (rival) out.set(b.id, { ...e, suggest: null, bothSides: true });
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
  return all<EvidenceCredit>(db, `SELECT r.id, r.amount_paise AS amount, r.posted_at AS postedAt, s.receives_upi_label AS label, r.remark FROM bank_rows r
    LEFT JOIN bank_sources s ON s.account_id = r.account_id
    WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.status = 'unmatched' AND r.posted_at >= ? AND r.posted_at < ?
      AND NOT EXISTS (SELECT 1 FROM shift_choices k WHERE k.bank_row_id = r.id) ORDER BY r.posted_at`,
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
  // A left-out bill is no bill; each UPI go of a bill paid in several is one (audit, 9 Nov 2026).
  const live = bills.filter((b) => b.decision !== 'leave_out' && b.decision !== 'carry_forward');
  const amounts = new Set([...live.flatMap((b) => [b.swAmount, b.rgAmount, ...(b.parts ?? [])]).filter((x): x is number => x != null), ...groupPaid]);
  return credits.filter((c) => !used.has(c.id) && c.postedAt >= window.from && c.postedAt < window.to && !amounts.has(c.amount) && !nearGroup(c.amount, groupPaid));
}

/** A group's one payment can come in a few rupees off what was written (a discount or rounding): up to this much. */
export const GROUP_SLACK_PAISE = 1000;
export const nearGroup = (amount: number, groupPaid: number[]) => groupPaid.some((g) => g !== amount && Math.abs(g - amount) <= GROUP_SLACK_PAISE);
