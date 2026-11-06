// The explainer (step B1, 3 Nov 2026): for one confirmed shift, what is left after the plain matching (UPI sales
// not found in the bank, credits with no bill, half-bills) is checked against the usual mistakes. Each explanation
// becomes a card with the evidence in words and a one-click fix that calls an existing, recorded and reversible
// correction. Nothing is applied by itself. Cards never share a bill or a credit: best explanation first.

import { all, one, type DB } from './db';
import { billDistance, sameBillNo } from './sales';
import { suggestionsFor } from './bank';
import { cashCheck } from './cash';
import { addDays, shiftWindow } from './time';

/** A call, or on a trial reconcile a change to a register row (op) or a link to open (href). */
export interface Action { label: string; method?: 'POST' | 'PUT' | 'DELETE'; path?: string; body?: Record<string, unknown>; primary?: boolean; needsNote?: string;
  op?: 'fixNumber' | 'setMode'; rowId?: string; uploadId?: string; billNo?: string; mode?: string; href?: string }
/** What each of the three says, and which one is wrong (shown struck out). */
export interface Witnesses { software: string | null; register: string | null; bank: string; odd: 'software' | 'register' | 'bank' | null }
export interface Card { key: string; kind: string; title: string; evidence: string[]; score: number; uses: string[]; actions: Action[]; billNos: string[]; witnesses?: Witnesses }

const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const rupees = (p: number) => (p / 100).toFixed(2);
const hm = (ms: number) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));
const mins = (a: number, b: number) => Math.round(Math.abs(a - b) / 60000);

interface Sale { id: string; net: number; billNo: string | null; comparisonId: string | null; paidAt: number | null; difference: string | null; regId: string | null;
  swAmount: number | null; gross: number | null; grouped: number; parts: number }
const TABLE_MAX = 10;

/**
 * Sets of 2 to 10 bills adding up exactly to an amount, bills within 45 minutes of each other. Stops at two sets
 * (two means a person decides) or after a fixed amount of searching. Bills come sorted largest first.
 */
export function tableSets<T extends { net: number; paidAt: number | null }>(bills: T[], amount: number): T[][] {
  const found: T[][] = [];
  let steps = 0;
  const pick: T[] = [];
  const walk = (i: number, left: number) => {
    if (found.length > 1 || ++steps > 200_000) return;
    if (left === 0) {
      const times = pick.map((x) => x.paidAt!);
      if (pick.length >= 2 && Math.max(...times) - Math.min(...times) <= 45 * 60000) found.push([...pick]);
      return;
    }
    if (pick.length === TABLE_MAX) return;
    for (let j = i; j < bills.length; j++) {
      if (bills[j].net > left) continue;
      pick.push(bills[j]);
      walk(j + 1, left - bills[j].net);
      pick.pop();
      if (found.length > 1) return;
    }
  };
  walk(0, amount);
  return steps > 200_000 ? [] : found;
}

interface Credit { id: string; amount: number; postedAt: number; vpa: string | null; tranId: string }

export async function explainShift(db: DB, businessId: string, day: string) {
  const w = shiftWindow(day);
  const base = `/businesses/${businessId}`;
  const shift = await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', businessId, day);
  if (shift?.status !== 'confirmed') return { coverage: null, cards: [] as Card[], note: 'The explainer works on confirmed shifts.' };

  // Is the bank in? The statement runs to about 8 am; accounts take turns, so the latest line of any UPI account counts.
  const last = await one<{ at: number | null }>(db, `SELECT max(r.posted_at) AS at FROM bank_rows r JOIN bank_sources s ON s.account_id = r.account_id
    WHERE r.business_id = ? AND s.receives_upi_label IS NOT NULL`, businessId);
  const covered = (last?.at ?? 0) >= w.to - 30 * 60000;

  const [sales, credits, softwareOnly, cash, sug] = await Promise.all([
    all<Sale>(db, `SELECT t.id, t.amount_paise AS net, t.bill_no AS billNo, t.comparison_id AS comparisonId, sb.paid_at AS paidAt, c.difference,
        c.register_row_id AS regId, c.sw_amount_paise AS swAmount, rr.amount_paise AS gross,
        (rr.paid_with_row_id IS NOT NULL OR EXISTS (SELECT 1 FROM register_rows m WHERE m.paid_with_row_id = rr.id)) AS grouped,
        (SELECT count(*) FROM transactions o WHERE o.comparison_id = t.comparison_id AND o.type = 'income') AS parts
      FROM transactions t LEFT JOIN bill_comparisons c ON c.id = t.comparison_id LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
      LEFT JOIN register_rows rr ON rr.id = c.register_row_id
      WHERE t.business_id = ? AND t.shift_day = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.match_status = 'awaiting_bank_match'
        AND t.matched_bank_row IS NULL`, businessId, day),
    all<Credit>(db, `SELECT r.id, r.amount_paise AS amount, r.posted_at AS postedAt, r.vpa, r.tran_id AS tranId FROM bank_rows r
      WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.status = 'unmatched' AND r.posted_at >= ? AND r.posted_at < ? ORDER BY r.posted_at`,
      businessId, w.from - 3600e3, w.to + 3600e3),
    all<{ id: string; billNo: string; swAmount: number; swMode: string; paidAt: number | null; matched: number }>(db, `
      SELECT c.id, c.bill_no AS billNo, c.sw_amount_paise AS swAmount, c.sw_mode AS swMode, b.paid_at AS paidAt,
        EXISTS (SELECT 1 FROM transactions t WHERE t.comparison_id = c.id AND t.matched_bank_row IS NOT NULL) AS matched
      FROM bill_comparisons c LEFT JOIN software_bills b ON b.id = c.software_bill_id
      WHERE c.business_id = ? AND c.shift_day = ? AND c.difference = 'missing_in_register' AND c.register_row_id IS NULL`, businessId, day),
    cashCheck(db, businessId, day),
    suggestionsFor(db, businessId, day, addDays(day, 1)),
  ]);

  const cards: Card[] = [];
  const near = (c: Credit, at: number | null, limit = 60) => (at == null ? c.postedAt >= w.from - 3600e3 && c.postedAt < w.to + 3600e3 : mins(c.postedAt, at) <= limit);

  // 1. Bill number typo: a register-only bill and a software-only bill with numbers alike, and a credit that fits.
  for (const r of sales.filter((x) => x.difference === 'missing_in_software' && x.regId && x.parts === 1 && !x.grouped && x.billNo)) {
    for (const s of softwareOnly.filter((x) => !x.matched)) {
      const dist = billDistance(r.billNo!, s.billNo);
      const alike = sameBillNo(r.billNo!, s.billNo) || dist <= 2;
      if (!alike) continue;
      for (const m of credits.filter((c) => c.amount === r.net && near(c, s.paidAt))) {
        const gap = s.swAmount - m.amount;
        const minutes = s.paidAt ? mins(m.postedAt, s.paidAt) : null;
        cards.push({
          key: `typo:${r.id}:${s.id}:${m.id}`, kind: 'number_typo', billNos: [s.billNo, r.billNo!],
          title: `Register bill ${r.billNo} is probably ${s.billNo}`,
          evidence: [
            `The register has ${r.billNo} (${rs(r.net)}), not in the software report; the software has ${s.billNo} (${rs(s.swAmount)}), not in the register.`,
            `A UPI credit of ${rs(m.amount)} at ${hm(m.postedAt)}${minutes != null ? `, ${minutes} min from bill ${s.billNo}` : ''}, the amount the register says was paid.`,
            gap > 0 ? `So the bill was ${rs(s.swAmount)} with a ${rs(gap)} discount.` : gap < 0 ? `So the bill was ${rs(s.swAmount)} with a ${rs(-gap)} tip.` : 'The amounts agree.',
            `Fixing joins the two halves into one bill, so it is no longer counted twice.`,
          ],
          score: 90 - dist * 8 - (minutes ?? 30) / 3, uses: [`tx:${r.id}`, `cmp:${s.id}`, `cr:${m.id}`],
          witnesses: { software: `Bill ${s.billNo} · ${rs(s.swAmount)}`, register: `Bill ${r.billNo} · ${rs(r.net)}`, bank: `${rs(m.amount)} at ${hm(m.postedAt)}`, odd: 'register' },
          actions: [{ label: `Fix: bill ${s.billNo}, ${gap >= 0 ? `discount ${rs(gap)}` : `tip ${rs(-gap)}`}`, primary: true, method: 'POST',
            path: `${base}/bank-rows/${m.id}/fix-bill`, body: { registerRowId: r.regId, billNo: s.billNo, amount: rupees(s.swAmount), discount: rupees(gap), note: `Register typo ${r.billNo} for ${s.billNo} (explainer)` } }],
        });
      }
    }
  }

  // 2. Payment written wrong: the bank received the full bill amount; the register shows a tip or discount.
  for (const x of sales.filter((y) => y.parts === 1 && !y.grouped && y.gross != null && y.gross !== y.net)) {
    for (const m of credits.filter((c) => c.amount === x.gross && near(c, x.paidAt))) {
      const minutes = x.paidAt ? mins(m.postedAt, x.paidAt) : null;
      const d = x.net - x.gross!;
      cards.push({
        key: `paid:${x.id}:${m.id}`, kind: 'payment_written_wrong', billNos: [x.billNo ?? ''],
        title: `Bill ${x.billNo}: payment probably written as ${rs(x.net)} instead of ${rs(x.gross!)}`,
        evidence: [
          `The bill is ${rs(x.gross!)}; the register says ${rs(x.net)} was received (${d > 0 ? `a ${rs(d)} tip` : `a ${rs(-d)} discount`}).`,
          `The bank received exactly ${rs(x.gross!)} at ${hm(m.postedAt)}${minutes != null ? `, ${minutes} min from the bill` : ''}.`,
          `Fixing sets the payment to ${rs(x.gross!)} and removes the ${d > 0 ? 'tip' : 'discount'}.`,
        ],
        score: 80 - (minutes ?? 30) / 3, uses: [`tx:${x.id}`, `cr:${m.id}`],
        witnesses: { software: x.swAmount != null ? `Bill ${rs(x.swAmount)}` : null, register: `Paid ${rs(x.net)} (${d > 0 ? `${rs(d)} tip` : `${rs(-d)} discount`})`, bank: `${rs(m.amount)} at ${hm(m.postedAt)}`, odd: 'register' },
        actions: [{ label: `Fix: payment ${rs(x.gross!)}, no ${d > 0 ? 'tip' : 'discount'}`, primary: true, method: 'POST',
          path: `${base}/bank-rows/match-many`, body: { pairs: [{ rowId: m.id, transactionIds: [x.id], adjust: true }] } }],
      });
    }
  }

  // 3. Paid in two goes: a bill with several UPI payments, and credits from one payer close together that add up to the bill.
  const multi = new Map<string, Sale[]>();
  for (const x of sales.filter((y) => y.parts > 1 && !y.grouped && y.comparisonId)) multi.set(x.comparisonId!, [...(multi.get(x.comparisonId!) ?? []), x]);
  for (const parts of multi.values()) {
    if (parts.length !== parts[0].parts || parts[0].gross == null) continue;
    const bill = parts[0];
    const target = bill.gross!;
    const byPayer = new Map<string, Credit[]>();
    for (const c of credits.filter((y) => y.vpa && near(y, bill.paidAt, 90))) byPayer.set(c.vpa!, [...(byPayer.get(c.vpa!) ?? []), c]);
    for (const [vpa, cs] of byPayer) {
      // Two or three payments within 30 minutes of each other that add up to the bill.
      const combos: Credit[][] = [];
      for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
        combos.push([cs[i], cs[j]]);
        for (let k = j + 1; k < cs.length; k++) combos.push([cs[i], cs[j], cs[k]]);
      }
      for (const combo of combos) {
        if (combo.length !== parts.length) continue;
        if (combo.reduce((t, c) => t + c.amount, 0) !== target) continue;
        if (mins(combo[0].postedAt, combo[combo.length - 1].postedAt) > 30) continue;
        const written = parts.map((p) => rs(p.net)).join(' + ');
        cards.push({
          key: `split:${bill.comparisonId}:${combo.map((c) => c.id).join(',')}`, kind: 'paid_in_parts', billNos: [bill.billNo ?? ''],
          title: `Bill ${bill.billNo}: paid in ${combo.length} goes, ${combo.map((c) => rs(c.amount)).join(' + ')}`,
          evidence: [
            `The register shows ${written} for a ${rs(target)} bill.`,
            `The same payer (${vpa}) paid ${combo.map((c) => `${rs(c.amount)} at ${hm(c.postedAt)}`).join(' and ')}: ${rs(target)}, the whole bill.`,
            'Fixing writes the payments as the bank shows them and removes any discount the register needed to add up.',
          ],
          score: 85, uses: [...parts.map((p) => `tx:${p.id}`), ...combo.map((c) => `cr:${c.id}`)],
          witnesses: { software: bill.swAmount != null ? `Bill ${rs(bill.swAmount)}` : null, register: `Paid ${written}`, bank: combo.map((c) => `${rs(c.amount)} at ${hm(c.postedAt)}`).join(' + '), odd: 'register' },
          actions: [{ label: `Fix: payments ${combo.map((c) => rs(c.amount)).join(' + ')}`, primary: true, method: 'POST', path: `${base}/bank-rows/match-set`,
            body: { rowIds: combo.map((c) => c.id), transactionIds: parts.map((p) => p.id), treat: 'bills', note: `Paid in ${combo.length} goes (explainer)` } }],
        });
      }
    }
  }

  // A credit some single bill of its amount could take is left to the plain matching.
  const single = (m: Credit) => sales.some((x) => (x.net === m.amount || x.gross === m.amount) && near(m, x.paidAt));
  // Bills with no credit of their own amount near them: the ones a table credit can explain.
  const loose = sales.filter((x) => x.parts === 1 && !x.grouped && x.paidAt != null
    && !credits.some((c) => (c.amount === x.net || c.amount === x.gross) && near(c, x.paidAt)));

  // One credit for a table: 2 to 10 bills paid within 45 minutes of each other, not marked paid together, that add up
  // exactly to one credit (approved 5 Nov 2026; tables of up to 8 bills were matched by hand on 2 Nov). Offered only
  // when exactly one set of bills fits.
  for (const m of credits.filter((c) => !single(c))) {
    const pool = loose.filter((x) => x.net < m.amount && mins(m.postedAt, x.paidAt!) <= 60)
      .sort((a, b) => mins(m.postedAt, a.paidAt!) - mins(m.postedAt, b.paidAt!)).slice(0, 24)
      .sort((a, b) => b.net - a.net);
    const sets = tableSets(pool, m.amount);
    if (sets.length !== 1) continue;
    const set = sets[0];
    const times = set.map((x) => x.paidAt!);
    cards.push({
      key: `table:${m.id}`, kind: 'one_credit_many_bills', billNos: set.map((x) => x.billNo ?? ''),
      title: `${rs(m.amount)} at ${hm(m.postedAt)} pays ${set.length} bills: ${set.map((x) => x.billNo).join(', ')}`,
      evidence: [
        `Bills ${set.map((x) => `${x.billNo} (${rs(x.net)})`).join(', ')} add up to exactly ${rs(m.amount)}.`,
        `They were paid between ${hm(Math.min(...times))} and ${hm(Math.max(...times))}; the credit came at ${hm(m.postedAt)}. No other set of bills fits.`,
        'Probably one table paying at once. Matching ties the credit to all of them.',
      ],
      score: 75, uses: [...set.map((x) => `tx:${x.id}`), `cr:${m.id}`],
      witnesses: { software: `${set.length} bills · ${rs(m.amount)}`, register: `${set.length} bills, each paid on its own`, bank: `One credit ${rs(m.amount)} at ${hm(m.postedAt)}`, odd: 'register' },
      actions: [{ label: `Match to ${set.length} bills`, primary: true, method: 'POST', path: `${base}/bank-rows/match-set`,
        body: { rowIds: [m.id], transactionIds: set.map((x) => x.id) } }],
    });
  }

  // 4. Clear matches waiting for a click.
  const clearIds = [...sug.clear].filter(([id, k]) => !k.adjust && credits.some((c) => c.id === id)).map(([id]) => id);
  if (clearIds.length) {
    cards.push({
      key: `clear:${day}`, kind: 'clear_matches', billNos: [], title: `${clearIds.length} UPI credit${clearIds.length > 1 ? 's match' : ' matches'} a bill of the same amount`,
      evidence: ['Same amount, paired by the closest time (within an hour), each bill and credit used once.'],
      score: 60, uses: clearIds.map((id) => `cr:${id}`),
      actions: [{ label: `Match ${clearIds.length}`, primary: true, method: 'POST', path: `${base}/bank-rows/match-clear`, body: { ids: clearIds } }],
    });
  }

  // Keep the best explanation for each bill and credit.
  cards.sort((a, b) => b.score - a.score);
  const used = new Set<string>();
  const kept: Card[] = [];
  for (const c of cards) {
    const free = c.kind === 'clear_matches' ? c.uses.filter((u) => !used.has(u)) : c.uses;
    if (c.kind !== 'clear_matches' && c.uses.some((u) => used.has(u))) continue;
    if (c.kind === 'clear_matches') {
      if (!free.length) continue;
      const ids = free.map((u) => u.slice(3));
      c.uses = free; c.title = `${ids.length} UPI credit${ids.length > 1 ? 's match' : ' matches'} a bill of the same amount`;
      c.actions = [{ ...c.actions[0], label: `Match ${ids.length}`, body: { ids } }];
    }
    c.uses.forEach((u) => used.add(u));
    kept.push(c);
  }

  // 5. UPI bills with no credit of their amount anywhere near: probably paid another way (needs the bank to be in).
  if (covered) {
    for (const x of sales.filter((y) => y.parts === 1 && !y.grouped && !used.has(`tx:${y.id}`))) {
      const any = credits.some((c) => (c.amount === x.net || c.amount === x.gross) && near(c, x.paidAt, 180));
      if (any) continue;
      const cashFits = cash.differencePaise != null && cash.differencePaise === x.net;
      kept.push({
        key: `mode:${x.id}`, kind: 'no_upi_credit', billNos: [x.billNo ?? ''],
        title: `Bill ${x.billNo} (${rs(x.net)}): no UPI payment of this amount in the bank`,
        evidence: [
          `No credit of ${rs(x.net)}${x.gross && x.gross !== x.net ? ` or ${rs(x.gross)}` : ''} in any account around ${x.paidAt ? hm(x.paidAt) : 'this shift'}.`,
          cashFits ? `The shift's cash is ${rs(x.net)} more than expected: exactly this bill. It was probably paid in cash.` : 'If it was paid by cash or card, change it; otherwise it may have been missed by the bank or the register.',
        ],
        score: cashFits ? 70 : 30, uses: [`tx:${x.id}`],
        actions: [
          { label: 'Was cash', primary: cashFits, method: 'POST', path: `${base}/sales/repay`, body: { transactionIds: [x.id], mode: 'cash', note: `No UPI credit; paid in cash${cashFits ? ' (cash over by the same amount)' : ''} (explainer)` } },
          { label: 'Was card', method: 'POST', path: `${base}/sales/repay`, body: { transactionIds: [x.id], mode: 'card', note: 'No UPI credit; paid by card (explainer)' } },
        ],
      });
    }
  }
  kept.sort((a, b) => b.score - a.score);
  return { coverage: { covered, lastBankAt: last?.at ?? null, shiftEnd: w.to }, cards: kept, note: null };
}
