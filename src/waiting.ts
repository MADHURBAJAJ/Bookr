/**
 * Waiting means "needs a look" (Stage 2 of the reconcile plan, approved 10 Nov 2026).
 *
 * Every bill that waits is in one of two groups:
 * - look: something should have turned up and has not. Counted on the Waiting tab, To do and the dashboard.
 * - grey: nothing is wrong yet; it waits for a file to come in (the register, the software report, the bank, the card
 *   report) or for its shift to be saved. Shown, not counted.
 * A bill left out is not waiting (its reason stays on the bill). A cash bill not in the register whose shift's cash
 * count agrees is not waiting either: the cash backs it.
 */
import type { DB } from './db';
import { all, one } from './db';
import { addDays, shiftWindow } from './time';
import { cardShiftChoices, coverage, shiftChoices, waitingBills, WATCH_DAYS } from './sales';
import { cashCheck } from './cash';
import { isMachineUpi, machineLabel } from './cards';

export type WaitFor = 'register' | 'software' | 'bank' | 'card' | 'count' | 'carry' | 'unsaved' | 'chosen';
export interface Offer { id: string; kind: 'credit' | 'payment'; amountPaise: number; at: number; shiftDay: string; label: string | null }
export interface WaitItem {
  key: string; comparisonId: string | null; billNo: string; day: string; amountPaise: number; mode: string | null;
  side: 'software' | 'register' | 'both'; confirmed: boolean; group: 'look' | 'grey'; waitFor: WaitFor | null; reason: string;
  daysWaiting: number; watchEnd: string | null; unresolved: boolean; watchNote: string | null; offers: Offer[];
  /** On the one line of an unsaved shift: how many of its bills are on one side only. */
  count?: number;
  /** Chosen on an unsaved shift's Reconcile (12 Nov 2026): that shift, and the money it is matched to when saved. */
  chosenOn?: string; chosenWith?: string;
  /** A matched credit the bank reversed (Stage 6): the reversal line, to make the bill unpaid again. */
  reversalId?: string;
}

const GAP = 1000; // ₹10: an offer may be this far from the bill (a tip or a discount)
const rs = (p: number) => `₹ ${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function waitingPicture(db: DB, businessId: string, today: string) {
  const [bills, upiSales, cardSales, lastBank, lastCard, regDays] = await Promise.all([
    waitingBills(db, businessId, today),
    // Saved UPI and card sales whose money has not been matched yet.
    all<{ id: string; comparisonId: string | null; billNo: string; day: string; amountPaise: number; paidAt: number | null }>(db, `
      SELECT t.id, t.comparison_id AS comparisonId, t.bill_no AS billNo, t.shift_day AS day, t.amount_paise AS amountPaise, sb.paid_at AS paidAt
      FROM transactions t LEFT JOIN bill_comparisons c ON c.id = t.comparison_id LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
      WHERE t.business_id = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.match_status = 'awaiting_bank_match' AND t.matched_bank_row IS NULL
      ORDER BY t.shift_day, t.bill_no LIMIT 500`, businessId),
    all<{ id: string; comparisonId: string | null; billNo: string; day: string; amountPaise: number; paidAt: number | null }>(db, `
      SELECT t.id, t.comparison_id AS comparisonId, t.bill_no AS billNo, t.shift_day AS day, t.amount_paise AS amountPaise, sb.paid_at AS paidAt
      FROM transactions t LEFT JOIN bill_comparisons c ON c.id = t.comparison_id LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
      WHERE t.business_id = ? AND t.type = 'income' AND t.payment_mode = 'card' AND t.match_status = 'awaiting_card_settlement'
      ORDER BY t.shift_day, t.bill_no LIMIT 500`, businessId),
    one<{ at: number | null }>(db, `SELECT max(r.posted_at) AS at FROM bank_rows r JOIN bank_sources s ON s.account_id = r.account_id
      WHERE r.business_id = ? AND s.receives_upi_label IS NOT NULL`, businessId),
    one<{ paid: number | null; settled: string | null }>(db, 'SELECT max(paid_at) AS paid, max(settled_on) AS settled FROM card_settlements WHERE business_id = ?', businessId),
    all<{ day: string }>(db, 'SELECT DISTINCT shift_day AS day FROM register_rows WHERE business_id = ?', businessId),
  ]);
  const hasRegister = new Set(regDays.map((r) => r.day));
  const bankIn = (day: string) => (lastBank?.at ?? 0) >= shiftWindow(day).to - 30 * 60000;
  const cardIn = (day: string) => (lastCard?.paid ?? 0) >= shiftWindow(day).to || (lastCard?.settled ?? '') >= addDays(day, 2);
  const days = (day: string) => Math.round((Date.parse(today) - Date.parse(day)) / 86400000);
  const statusOf = new Map((await all<{ day: string; status: string }>(db, 'SELECT shift_day AS day, status FROM shifts WHERE business_id = ?', businessId)).map((s) => [s.day, s.status]));
  const swCovered = new Map<string, boolean>();
  const softwareIn = async (day: string) => {
    if (!swCovered.has(day)) swCovered.set(day, !(await coverage(db, businessId, day)).gaps.length);
    return swCovered.get(day)!;
  };
  const cashOf = new Map<string, Awaited<ReturnType<typeof cashCheck>>>();
  const cash = async (day: string) => {
    if (!cashOf.has(day)) cashOf.set(day, await cashCheck(db, businessId, day));
    return cashOf.get(day)!;
  };

  // Offers: open credits (or card payments) within ₹10, on the bill's shift and the shifts either side.
  const span = (day: string) => ({ from: shiftWindow(addDays(day, -1)).from, to: shiftWindow(addDays(day, 1)).to });
  const credits = async (day: string, amount: number, at: number | null): Promise<Offer[]> => {
    const w = span(day);
    const rows = await all<{ id: string; amount: number; at: number; label: string | null }>(db, `SELECT r.id, r.amount_paise AS amount, r.posted_at AS at, a.name AS label
      FROM bank_rows r LEFT JOIN accounts a ON a.id = r.account_id
      WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.status = 'unmatched' AND r.posted_at >= ? AND r.posted_at < ? AND abs(r.amount_paise - ?) <= ?
        AND NOT EXISTS (SELECT 1 FROM shift_choices k WHERE k.bank_row_id = r.id)`, businessId, w.from, w.to, amount, GAP);
    return rank(rows.map((r) => ({ id: r.id, kind: 'credit' as const, amountPaise: r.amount, at: r.at, shiftDay: dayOf(r.at, day), label: r.label })), amount, at);
  };
  const payments = async (day: string, amount: number, at: number | null): Promise<Offer[]> => {
    const w = span(day);
    const rows = await all<{ id: string; amount_paise: number; paid_at: number; pay_mode: string | null; scheme: string | null; card_type: string | null; card_last4: string | null }>(db, `
      SELECT s.id, s.amount_paise, s.paid_at, s.pay_mode, s.scheme, s.card_type, s.card_last4 FROM card_settlements s
      WHERE s.business_id = ? AND s.txn_type = 'PURCHASE' AND s.paid_at >= ? AND s.paid_at < ? AND abs(s.amount_paise - ?) <= ?
        AND NOT EXISTS (SELECT 1 FROM card_matches m WHERE m.settlement_id = s.id) AND NOT EXISTS (SELECT 1 FROM shift_choices k WHERE k.card_payment_id = s.id)`,
      businessId, w.from, w.to, amount, GAP);
    return rank(rows.filter((p) => !isMachineUpi(p)).map((p) => ({ id: p.id, kind: 'payment' as const, amountPaise: p.amount_paise, at: p.paid_at, shiftDay: dayOf(p.paid_at, day), label: machineLabel(p) })), amount, at);
  };

  const out: WaitItem[] = [];
  const seen = new Set<string>();
  const sales = new Map([...upiSales, ...cardSales].filter((t) => t.comparisonId).map((t) => [t.comparisonId!, t]));

  // Bills found on one side only. Waiting starts when a shift is saved (approved 10 Nov 2026): before that, every bill is
  // still open on its shift's own tabs, and its pairs are only Bookr's guesses. An unsaved shift is one grey line.
  const unsaved = new Map<string, number>();
  for (const [day, status] of statusOf) if (status !== 'confirmed') unsaved.set(day, 0);
  for (const b of bills.filter((x) => !x.oddNumber)) {
    seen.add(b.id);
    if (!b.confirmed) { unsaved.set(b.day, (unsaved.get(b.day) ?? 0) + 1); continue; }
    const confirmed = b.confirmed;
    const base = { key: `c:${b.id}`, comparisonId: b.id, billNo: b.billNo, day: b.day, amountPaise: b.amountPaise ?? 0, mode: b.mode, side: b.side as 'software' | 'register',
      confirmed, daysWaiting: b.daysWaiting, watchEnd: b.watchEnd, unresolved: b.unresolved, watchNote: b.watchNote, offers: [] as Offer[] };
    const grey = (waitFor: WaitFor, reason: string) => out.push({ ...base, group: 'grey', waitFor, reason, unresolved: false });
    const look = (reason: string, offers: Offer[] = []) => out.push({ ...base, group: 'look', waitFor: null, reason, offers });
    if (b.decision === 'carry_forward') {
      const next = addDays(b.day, 1);
      if (statusOf.get(next) === 'confirmed') look(`Carried forward, but the ${next} shift was saved without it`);
      else grey('carry', `Carried forward to the ${next} shift`);
      continue;
    }
    if (b.side === 'register') {
      // In the register only: the software bill may come on another day. Waits 7 days (a billing gap).
      if (!(await softwareIn(b.day))) grey('software', 'Until the software report covers the shift');
      else look('In the register, not in the software report');
      continue;
    }
    // In the software only.
    if (!hasRegister.has(b.day)) { grey('register', 'Until the register is in'); continue; }
    const sale = sales.get(b.id);
    if (b.mode === 'cash') {
      const k = await cash(b.day);
      if (k.differencePaise === null) { grey('count', 'Until the cash count is in'); continue; }
      if (k.settled || k.differencePaise >= 0) continue; // the cash backs it: not waiting
      const part = k.explained?.bills.find((x) => x.id === b.id);
      look(part ? `Not in the register; explains ${rs(part.partPaise)} of the ${rs(-k.differencePaise)} short cash count`
        : `Not in the register, and the cash count is ${rs(-k.differencePaise)} short`);
      continue;
    }
    if (b.mode === 'upi') {
      if (!sale) continue; // its credit is matched: the bank backs it
      if (!bankIn(b.day)) { grey('bank', 'Until bank sync'); continue; }
      const offers = await credits(b.day, base.amountPaise, sale?.paidAt ?? null);
      look(offers.length ? 'Not in the register, and no credit matched yet' : 'Not in the register, and no credit of this amount in the bank', offers);
      continue;
    }
    if (b.mode === 'card') {
      if (!sale) continue; // its machine payment is matched
      if (!cardIn(b.day)) { grey('card', 'Until the card report'); continue; }
      const offers = await payments(b.day, base.amountPaise, sale?.paidAt ?? null);
      look(offers.length ? 'Not in the register, and no machine payment matched yet' : 'Not in the register, and no machine payment of this amount', offers);
      continue;
    }
    look('Not in the register; the software does not say how it was paid');
  }

  // A saved sale already chosen on a later shift that is not saved yet (12 Nov 2026), e.g. a bill settled the next day:
  // nothing is wrong, it is matched when that shift is saved. Shown, not counted.
  const at = (ms: number) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));
  const chosenFor = new Map<string, { day: string; with: string }>();
  const openDays = (await all<{ d: string }>(db, `SELECT DISTINCT k.shift_day AS d FROM shift_choices k LEFT JOIN shifts s ON s.business_id = k.business_id AND s.shift_day = k.shift_day
    WHERE k.business_id = ? AND coalesce(s.status, '') <> 'confirmed'`, businessId)).map((x) => x.d);
  for (const d of openDays) {
    const [ups, cards] = await Promise.all([shiftChoices(db, businessId, d), cardShiftChoices(db, businessId, d)]);
    const note = (ids: string[], nos: string[], i: number, money: string) => {
      const others = nos.filter((_, j) => j !== i);
      return `${money}${others.length ? `, with bill ${others.join(' + ')}` : ''}`;
    };
    for (const k of ups) if (k.open) k.comparisonIds.forEach((id, i) => chosenFor.set(id, { day: d, with: note(k.comparisonIds, k.billNos, i, `credit ${rs(k.amountPaise)} at ${at(k.postedAt)}`) }));
    for (const k of cards) if (k.open) k.comparisonIds.forEach((id, i) => chosenFor.set(id, { day: d, with: note(k.comparisonIds, k.billNos, i, `${k.label} ${rs(k.amountPaise)} at ${at(k.paidAt)}`) }));
  }
  const chosenOf = (t: { id: string; comparisonId: string | null }) => chosenFor.get(t.id) ?? (t.comparisonId ? chosenFor.get(t.comparisonId) : undefined);

  // Saved sales with both sides, waiting for their money.
  for (const t of upiSales) {
    if (t.comparisonId && seen.has(t.comparisonId)) continue;
    const ch = chosenOf(t);
    if (ch) {
      out.push({ key: `t:${t.id}`, comparisonId: t.comparisonId, billNo: t.billNo, day: t.day, amountPaise: t.amountPaise, mode: 'upi', side: 'both', confirmed: true, group: 'grey',
        waitFor: 'chosen', reason: `Chosen on the ${ch.day} shift: ${ch.with}. Matched when that shift is saved`, chosenOn: ch.day, chosenWith: ch.with,
        daysWaiting: days(t.day), watchEnd: null, unresolved: false, watchNote: null, offers: [] });
      continue;
    }
    const base = { key: `t:${t.id}`, comparisonId: t.comparisonId, billNo: t.billNo, day: t.day, amountPaise: t.amountPaise, mode: 'upi', side: 'both' as const, confirmed: true,
      daysWaiting: days(t.day), watchEnd: null, unresolved: false, watchNote: null };
    if (!bankIn(t.day)) { out.push({ ...base, group: 'grey', waitFor: 'bank', reason: 'Until bank sync', offers: [] }); continue; }
    const offers = await credits(t.day, t.amountPaise, t.paidAt);
    out.push({ ...base, group: 'look', waitFor: null, reason: 'Saved, no credit matched yet', offers, unresolved: days(t.day) > WATCH_DAYS });
  }
  for (const t of cardSales) {
    if (t.comparisonId && seen.has(t.comparisonId)) continue;
    const ch = chosenOf(t);
    if (ch) {
      out.push({ key: `t:${t.id}`, comparisonId: t.comparisonId, billNo: t.billNo, day: t.day, amountPaise: t.amountPaise, mode: 'card', side: 'both', confirmed: true, group: 'grey',
        waitFor: 'chosen', reason: `Chosen on the ${ch.day} shift: ${ch.with}. Matched when that shift is saved`, chosenOn: ch.day, chosenWith: ch.with,
        daysWaiting: days(t.day), watchEnd: null, unresolved: false, watchNote: null, offers: [] });
      continue;
    }
    const base = { key: `t:${t.id}`, comparisonId: t.comparisonId, billNo: t.billNo, day: t.day, amountPaise: t.amountPaise, mode: 'card', side: 'both' as const, confirmed: true,
      daysWaiting: days(t.day), watchEnd: null, unresolved: false, watchNote: null };
    if (!cardIn(t.day)) { out.push({ ...base, group: 'grey', waitFor: 'card', reason: 'Until the card report', offers: [] }); continue; }
    const offers = await payments(t.day, t.amountPaise, t.paidAt);
    out.push({ ...base, group: 'look', waitFor: null, reason: 'Saved, no machine payment matched yet', offers, unresolved: days(t.day) > WATCH_DAYS });
  }

  // A credit matched to a bill, then reversed by the bank (Stage 6, 10 Nov 2026): the bill is paid by money that went back.
  const reversed = await all<{ revId: string; revAt: number; amount: number; creditAt: number; txId: string; billNo: string | null; day: string; comparisonId: string | null }>(db, `
    SELECT r.id AS revId, r.posted_at AS revAt, c.amount_paise AS amount, c.posted_at AS creditAt, t.id AS txId, t.bill_no AS billNo, t.shift_day AS day, t.comparison_id AS comparisonId
    FROM bank_rows r JOIN bank_rows c ON c.id = r.pair_row_id JOIN bank_matches m ON m.bank_row_id = c.id JOIN transactions t ON t.id = m.transaction_id
    WHERE r.business_id = ? AND r.kind = 'reversal' AND r.status = 'unmatched' AND c.status = 'matched'`, businessId);
  for (const x of reversed) {
    out.push({ key: `r:${x.revId}:${x.txId}`, comparisonId: x.comparisonId, billNo: x.billNo ?? '', day: x.day, amountPaise: x.amount, mode: 'upi', side: 'both', confirmed: true,
      group: 'look', waitFor: null, reason: `Its ${rs(x.amount)} credit was reversed by the bank on ${dayOf(x.revAt, x.day)}: the payment failed`, daysWaiting: days(x.day),
      watchEnd: null, unresolved: false, watchNote: null, offers: [], reversalId: x.revId });
  }
  for (const [day, n] of unsaved) {
    out.push({ key: `s:${day}`, comparisonId: null, billNo: '', day, amountPaise: 0, mode: null, side: 'both', confirmed: false, group: 'grey', waitFor: 'unsaved',
      reason: `The ${day} shift is not saved yet`, daysWaiting: days(day), watchEnd: null, unresolved: false, watchNote: null, offers: [], count: n });
  }
  const sortKey = (x: WaitItem) => `${x.day}\u0000${x.billNo}`;
  out.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));
  return {
    watchDays: WATCH_DAYS,
    look: out.filter((x) => x.group === 'look'),
    grey: out.filter((x) => x.group === 'grey'),
    oddNumbers: bills.filter((x) => x.oddNumber),
  };
}

/** The shift a credit or payment falls in (8 am to 8 am), among the bill's shift and the two either side. */
function dayOf(at: number, day: string) {
  for (const d of [addDays(day, -1), day, addDays(day, 1)]) { const w = shiftWindow(d); if (at >= w.from && at < w.to) return d; }
  return day;
}
/** Closest amount first, then closest in time to the bill; at most three. */
function rank(xs: Offer[], amount: number, at: number | null) {
  return xs.sort((a, b) => Math.abs(a.amountPaise - amount) - Math.abs(b.amountPaise - amount) || (at == null ? a.at - b.at : Math.abs(a.at - at) - Math.abs(b.at - at))).slice(0, 3);
}
