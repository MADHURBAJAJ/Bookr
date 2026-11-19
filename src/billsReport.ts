/**
 * Reports → All bills (approved 19 Nov 2026): every bill of the shifts, from the register and the software report, one
 * row each, with a tag (in both, both with the amounts differing, only in the register, only in the software,
 * complimentary), what was counted, and how its payment came. Old POS bills (only in the register, an old number) are
 * folded into one line per shift. Read-only.
 *
 * How the payment came, from what is saved: the UPI credits matched to the bill (with the other bills a credit paid
 * and a UPI card fee on it), the card machine payments matched to it, cash in the drawer or the short count it explains,
 * or "not come" when the bill waits with no money. Unsaved shifts say so.
 */
import type { DB } from './db';
import { all } from './db';
import { addDays, istDay } from './time';
import { isNewPosBill } from './sales';
import { machineLabel } from './cards';
import { waitingPicture } from './waiting';
import { cashCheck } from './cash';

export type BillTag = 'both' | 'differ' | 'register' | 'software' | 'comp';
export interface Payment { kind: 'upi' | 'card' | 'cash' | 'none' | 'unsaved' | 'short'; text: string; bad?: boolean }
export interface BillLine {
  id: string; day: string; billNo: string; paidAt: number | null; tag: BillTag; oldPos: boolean; difference: string; decision: string | null;
  software: { amountPaise: number | null; mode: string | null } | null; register: { amountPaise: number | null; mode: string | null } | null;
  counted: { amountPaise: number; mode: string | null } | null; note: string | null; apartPaise: number | null; payment: Payment[]; notCome: boolean;
}

const rs = (p: number) => `₹ ${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const timeOf = (ms: number) => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).toLowerCase();

export function billsRange(q: { from?: string; to?: string; day?: string }, today = istDay(Date.now())) {
  const iso = (v?: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v ?? '') ? v! : null);
  const one = iso(q.day);
  const to = one ?? iso(q.to) ?? addDays(today, -1);
  let from = one ?? iso(q.from) ?? to;
  if (from > to) from = to;
  if (from < addDays(to, -30)) from = addDays(to, -30);
  return { from, to };
}

export async function allBills(db: DB, businessId: string, from: string, to: string, today = istDay(Date.now())) {
  const [rows, shifts, txs, credits, cards, picture, counts] = await Promise.all([
    all<{ id: string; day: string; bill_no: string; difference: string; decision: string | null; note: string | null; close_note: string | null;
      sw_amount_paise: number | null; sw_mode: string | null; rg_amount_paise: number | null; rg_mode: string | null; software_bill_id: string | null; register_row_id: string | null; paid_at: number | null }>(db, `
      SELECT c.id, c.shift_day AS day, c.bill_no, c.difference, c.decision, c.note, c.close_note, c.sw_amount_paise, c.sw_mode, c.rg_amount_paise, c.rg_mode,
        c.software_bill_id, c.register_row_id, sb.paid_at
      FROM bill_comparisons c LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
      WHERE c.business_id = ? AND c.shift_day BETWEEN ? AND ? ORDER BY c.shift_day, coalesce(sb.paid_at, 0), c.bill_no LIMIT 6000`, businessId, from, to),
    all<{ day: string; status: string }>(db, 'SELECT shift_day AS day, status FROM shifts WHERE business_id = ? AND shift_day BETWEEN ? AND ?', businessId, from, to),
    all<{ comparison_id: string; amount: number; mode: string | null }>(db, `SELECT comparison_id, sum(amount_paise) AS amount, max(payment_mode) AS mode FROM transactions
      WHERE business_id = ? AND type = 'income' AND comparison_id IS NOT NULL AND shift_day BETWEEN ? AND ? GROUP BY comparison_id`, businessId, from, to),
    all<{ comparison_id: string; bill_no: string; row_id: string; amount: number; posted_at: number; tran_id: string; others: string | null; fee: number | null }>(db, `
      SELECT t.comparison_id, t.bill_no, r.id AS row_id, r.amount_paise AS amount, r.posted_at, r.tran_id,
        (SELECT group_concat(o.bill_no, ', ') FROM bank_matches m2 JOIN transactions o ON o.id = m2.transaction_id WHERE m2.bank_row_id = r.id AND o.id <> t.id) AS others,
        (SELECT f.amount_paise FROM bank_rows f WHERE f.pair_row_id = r.id AND f.kind = 'upi_fee' LIMIT 1) AS fee
      FROM bank_matches m JOIN transactions t ON t.id = m.transaction_id JOIN bank_rows r ON r.id = m.bank_row_id
      WHERE m.business_id = ? AND t.comparison_id IS NOT NULL AND t.shift_day BETWEEN ? AND ? ORDER BY r.posted_at`, businessId, from, to),
    all<{ comparison_id: string; amount_paise: number; paid_at: number; scheme: string | null; card_type: string | null; card_last4: string | null; pay_mode: string | null; others: string | null }>(db, `
      SELECT t.comparison_id, s.amount_paise, s.paid_at, s.scheme, s.card_type, s.card_last4, s.pay_mode,
        (SELECT group_concat(o.bill_no, ', ') FROM card_matches m2 JOIN transactions o ON o.id = m2.transaction_id WHERE m2.settlement_id = s.id AND o.id <> t.id) AS others
      FROM card_matches m JOIN transactions t ON t.id = m.transaction_id JOIN card_settlements s ON s.id = m.settlement_id
      WHERE m.business_id = ? AND t.comparison_id IS NOT NULL AND t.shift_day BETWEEN ? AND ? ORDER BY s.paid_at`, businessId, from, to),
    waitingPicture(db, businessId, today),
    all<{ day: string }>(db, `SELECT DISTINCT shift_day AS day FROM cash_summaries WHERE business_id = ? AND status = 'approved' AND shift_day BETWEEN ? AND ?`, businessId, from, to),
  ]);
  const saved = new Set(shifts.filter((s) => s.status === 'confirmed').map((s) => s.day));
  const counted = new Set(counts.map((c) => c.day));
  const txOf = new Map(txs.map((t) => [t.comparison_id, t]));
  const group = <T extends { comparison_id: string }>(xs: T[]) => { const m = new Map<string, T[]>(); for (const x of xs) m.set(x.comparison_id, [...(m.get(x.comparison_id) ?? []), x]); return m; };
  const creditsOf = group(credits);
  const cardsOf = group(cards);
  const notCome = new Set(picture.look.filter((x) => x.kind === 'not_received').flatMap((x) => (x.comparisonId ? [x.comparisonId] : [])));
  const notComeBill = new Set(picture.look.filter((x) => x.kind === 'not_received').flatMap((x) => x.billNo.split(' + ').map((b) => `${x.day}|${b}`)));
  // The cash a short count waits on (as on each saved shift's Cash panel).
  const checks = await Promise.all([...counted].filter((d) => saved.has(d)).map((d) => cashCheck(db, businessId, d)));
  const shortBy = new Map<string, { partPaise: number; differencePaise: number }>();
  for (const k of checks) for (const b of k.explained?.bills ?? []) shortBy.set(b.id, { partPaise: b.partPaise, differencePaise: k.differencePaise ?? 0 });

  const lines: BillLine[] = rows.map((c) => {
    const sw = c.software_bill_id || c.sw_amount_paise != null ? { amountPaise: c.sw_amount_paise, mode: c.sw_mode } : null;
    const rg = c.register_row_id || c.rg_amount_paise != null ? { amountPaise: c.rg_amount_paise, mode: c.rg_mode } : null;
    const tag: BillTag = c.difference === 'complimentary' ? 'comp' : sw && rg ? (c.difference === 'match' ? 'both' : 'differ') : rg ? 'register' : 'software';
    const tx = txOf.get(c.id);
    const out = c.decision === 'leave_out' || c.difference === 'complimentary';
    const countedAs = tx ? { amountPaise: tx.amount, mode: tx.mode } : out ? null
      : c.decision === 'use_register' ? (rg?.amountPaise != null ? { amountPaise: rg.amountPaise, mode: rg.mode } : null)
        : sw?.amountPaise != null ? { amountPaise: sw.amountPaise, mode: sw.mode } : rg?.amountPaise != null ? { amountPaise: rg.amountPaise, mode: rg.mode } : null;
    const payment: Payment[] = [];
    const cr = creditsOf.get(c.id) ?? [];
    if (cr.length) {
      const parts = cr.length > 1 ? `UPI in ${cr.length} parts: ${cr.map((x) => rs(x.amount)).join(' + ')} · ${cr.map((x) => timeOf(x.posted_at)).join(', ')}`
        : `UPI ${rs(cr[0].amount)}${cr[0].others ? ` with ${cr[0].others}` : ''} · ${timeOf(cr[0].posted_at)} · ${cr[0].tran_id}`;
      const fees = cr.filter((x) => x.fee);
      payment.push({ kind: 'upi', text: `${parts}${fees.length ? ` · fee ${fees.map((x) => rs(x.fee!)).join(' + ')}` : ''}${cr.length > 1 && cr.some((x) => x.others) ? ` · with ${[...new Set(cr.flatMap((x) => x.others ? [x.others] : []))].join(', ')}` : ''}` });
    }
    for (const k of cardsOf.get(c.id) ?? []) payment.push({ kind: 'card', text: `Card machine · ${machineLabel(k)} · ${rs(k.amount_paise)}${k.others ? ` with ${k.others}` : ''} · ${timeOf(k.paid_at)}` });
    const isNotCome = !out && (notCome.has(c.id) || notComeBill.has(`${c.day}|${c.bill_no}`));
    const short = shortBy.get(c.id);
    if (!payment.length && !out) {
      if (!saved.has(c.day)) payment.push({ kind: 'unsaved', text: 'Shift not saved yet' });
      else if (short && (countedAs?.mode ?? 'cash') === 'cash') payment.push({ kind: 'short', text: `Not in the drawer: the count is ${rs(-short.differencePaise)} short`, bad: true });
      else if (isNotCome) payment.push({ kind: 'none', text: countedAs?.mode === 'card' ? 'No card machine payment yet' : countedAs?.mode === 'upi' ? 'No UPI credit yet' : 'Money not come', bad: true });
      else if (countedAs?.mode === 'cash') payment.push({ kind: 'cash', text: counted.has(c.day) ? 'Cash · in the drawer' : 'Cash · count not saved yet' });
      else if (countedAs) payment.push({ kind: 'none', text: countedAs.mode === 'upi' ? 'No UPI credit matched' : countedAs.mode === 'card' ? 'No card payment matched' : 'Not matched' });
    }
    const apart = sw?.amountPaise != null && rg?.amountPaise != null && sw.amountPaise !== rg.amountPaise ? Math.abs(sw.amountPaise - rg.amountPaise) : null;
    return { id: c.id, day: c.day, billNo: c.bill_no, paidAt: c.paid_at, tag, oldPos: tag === 'register' && !isNewPosBill(c.bill_no), difference: c.difference, decision: c.decision,
      software: sw, register: rg, counted: countedAs, note: c.close_note ?? c.note, apartPaise: apart, payment,
      notCome: isNotCome || payment.some((p) => p.bad) };
  });
  return { from, to, lines, savedDays: [...saved].sort(), truncated: rows.length === 6000 };
}
