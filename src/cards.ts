// Card settlements (Phase 3, part 2): the card company's report of each card payment, matched to the confirmed card
// sale it pays, and each settlement day's net total matched to the bank's ICICIPOS_SET credit, with the fee and GST
// booked by the Card settlement rule. Bookr acts on its own only where it is safe (approved 8 Nov 2026): a payment and a
// bill of the same amount within AUTO_MIN minutes with no other candidate on either side, and a settlement whose bank
// credit carries its date and exactly its net. Everything else waits for a person. Every step can be undone.

import { all, newId, now, one, stmt, type DB } from './db';
import type { CardLine } from './cardsettlement';
import { cashCheck } from './cash';
import { addDays, shiftDayOf, shiftWindow } from './time';

/** Adds the payments not already stored (the card company's Transaction ID is unique). */
export async function importCardLines(db: DB, businessId: string, fileName: string, mailId: string | null, lines: CardLine[]) {
  const have = new Set((await all<{ txn_id: string }>(db, 'SELECT txn_id FROM card_settlements WHERE business_id = ?', businessId)).map((r) => r.txn_id));
  const fresh = lines.filter((l) => !have.has(l.txnId));
  const t = now();
  const statements = fresh.map((l) => stmt(db, `INSERT INTO card_settlements (id, business_id, mail_id, file_name, settled_on, merchant_id, terminal_id,
    batch_no, rrn, txn_id, paid_at, txn_type, amount_paise, fee_paise, gst_paise, net_paise, scheme, card_type, card_last4, auth_code, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (business_id, txn_id) DO NOTHING`,
    newId(), businessId, mailId, fileName, l.settledOn, l.merchantId, l.terminalId, l.batchNo, l.rrn, l.txnId, l.paidAt, l.txnType,
    l.amountPaise, l.feePaise, l.gstPaise, l.netPaise, l.scheme, l.cardType, l.cardLast4, l.authCode, t));
  for (let i = 0; i < statements.length; i += 80) await db.batch(statements.slice(i, i + 80));
  const auto = fresh.length ? await runCardAuto(db, businessId) : { matched: 0, settled: 0 };
  return { added: fresh.length, skipped: lines.length - fresh.length, autoMatched: auto.matched, autoSettled: auto.settled };
}

export interface CardPayment {
  id: string; settled_on: string; merchant_id: string; terminal_id: string; txn_id: string; rrn: string | null; paid_at: number; txn_type: string;
  amount_paise: number; fee_paise: number; gst_paise: number; net_paise: number; scheme: string | null; card_type: string | null;
  card_last4: string | null; file_name: string; bank_row_id: string | null; fee_tx_id: string | null; gst_tx_id: string | null;
}

export interface CardSale {
  id: string; amount_paise: number; bill_no: string | null; shift_day: string; paid_at: number | null; group_head: string | null;
}

/** Confirmed card sales still waiting for their card payment, in shifts from..to. */
export const waitingCard = (db: DB, businessId: string, from: string, to: string) => all<CardSale>(db, `
  SELECT t.id, t.amount_paise, t.bill_no, t.shift_day, sb.paid_at, coalesce(rr.paid_with_row_id, rr.id) AS group_head
  FROM transactions t
  LEFT JOIN bill_comparisons c ON c.id = t.comparison_id
  LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
  LEFT JOIN register_rows rr ON rr.id = c.register_row_id
  WHERE t.business_id = ? AND t.type = 'income' AND t.payment_mode = 'card' AND t.match_status = 'awaiting_card_settlement'
    AND t.shift_day BETWEEN ? AND ? ORDER BY t.shift_day, sb.paid_at, t.bill_no`, businessId, from, to);

const STRONG_MIN = 20;
/** Pre-ticked when paired within this many minutes. */
const TICK_MIN = 60;
const WIDE_MIN = 180;

export interface CardCandidate { transactionIds: string[]; billNos: string[]; amountPaise: number; minutes: number | null; strong: boolean; shiftDay: string }

/**
 * For each card payment not matched yet, card sales of the same amount paid near its time (bills paid together count
 * as one). A sale with no time (register only) fits a payment made in its shift. Clear: paired by closest time first,
 * each payment and sale used once, up to an hour apart.
 */
export function cardCandidates(payments: Pick<CardPayment, 'id' | 'paid_at' | 'amount_paise' | 'txn_type'>[], sales: CardSale[]) {
  const units: { ids: string[]; bills: string[]; amount: number; paidAt: number | null; shiftDay: string }[] =
    sales.map((s) => ({ ids: [s.id], bills: [s.bill_no ?? ''], amount: s.amount_paise, paidAt: s.paid_at, shiftDay: s.shift_day }));
  const byGroup = new Map<string, CardSale[]>();
  for (const s of sales) if (s.group_head) byGroup.set(s.group_head, [...(byGroup.get(s.group_head) ?? []), s]);
  for (const g of byGroup.values()) {
    if (g.length < 2) continue;
    const times = g.map((s) => s.paid_at).filter((x): x is number => x != null);
    units.push({ ids: g.map((s) => s.id), bills: [...new Set(g.map((s) => s.bill_no ?? ''))], amount: g.reduce((t, s) => t + s.amount_paise, 0),
      paidAt: times.length ? Math.max(...times) : null, shiftDay: g[0].shift_day });
  }
  const candidates = new Map<string, CardCandidate[]>();
  for (const p of payments) {
    if (p.txn_type !== 'PURCHASE') { candidates.set(p.id, []); continue; }
    const list: CardCandidate[] = [];
    for (const u of units) {
      if (u.amount !== p.amount_paise) continue;
      let minutes: number | null = null;
      if (u.paidAt != null) {
        minutes = Math.round(Math.abs(p.paid_at - u.paidAt) / 60000);
        if (minutes > WIDE_MIN) continue;
      } else {
        const w = shiftWindow(u.shiftDay);
        if (p.paid_at < w.from || p.paid_at >= w.to) continue;
      }
      list.push({ transactionIds: u.ids, billNos: u.bills, amountPaise: u.amount, minutes, strong: minutes != null && minutes <= STRONG_MIN, shiftDay: u.shiftDay });
    }
    list.sort((a, b) => (a.minutes ?? 9999) - (b.minutes ?? 9999));
    candidates.set(p.id, list);
  }
  const pairs: { paymentId: string; k: CardCandidate }[] = [];
  for (const [id, list] of candidates) for (const k of list) if (k.minutes != null && k.minutes <= TICK_MIN) pairs.push({ paymentId: id, k });
  pairs.sort((a, b) => a.k.minutes! - b.k.minutes!);
  const usedSale = new Set<string>();
  const clear = new Map<string, CardCandidate>();
  for (const p of pairs) {
    if (clear.has(p.paymentId) || p.k.transactionIds.some((x) => usedSale.has(x))) continue;
    clear.set(p.paymentId, p.k);
    p.k.transactionIds.forEach((x) => usedSale.add(x));
  }
  for (const [id, k] of clear) candidates.set(id, [k, ...candidates.get(id)!.filter((x) => x !== k)]);
  return { candidates, clear };
}

/**
 * Statements that match card payments to card sales (totals already checked by the caller). No user: matched by Bookr
 * (auto in the audit entry), as decideOneSided does.
 */
export function cardMatchStatements(db: DB, businessId: string, paymentIds: string[], transactionIds: string[], userId: string | null, t: number, extra: Record<string, unknown> = {}) {
  return [
    ...paymentIds.flatMap((pid) => transactionIds.map((tid) => stmt(db, `INSERT INTO card_matches (id, business_id, settlement_id, transaction_id, matched_by, matched_at)
      VALUES (?, ?, ?, ?, ?, ?)`, newId(), businessId, pid, tid, userId, t))),
    ...transactionIds.map((tid) => stmt(db, "UPDATE transactions SET match_status = NULL WHERE id = ? AND match_status = 'awaiting_card_settlement'", tid)),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'card.match', 'card_settlements', ?, NULL, ?, ?)`, businessId, userId, paymentIds[0], JSON.stringify({ paymentIds, transactionIds, ...extra }), t),
  ];
}

/** The settlement day's credit from the card machine: the ICICIPOS_SET line ends with the settlement date (ddmmyy). */
export function settlementDateOf(description: string): string | null {
  const m = /ICICIPOS_SET\S*_(\d{2})(\d{2})(\d{2})\s*$/i.exec(description);
  return m ? `20${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Bank credits from the card machine that could be this settlement: the same net amount, on the day or a few days after. */
export const settlementCredits = (db: DB, businessId: string, settledOn: string, netPaise: number) => all<{
  id: string; account_id: string; account_name: string; day: string; posted_at: number; description: string; amount_paise: number;
}>(db, `SELECT r.id, r.account_id, a.name AS account_name, r.day, r.posted_at, r.description, r.amount_paise FROM bank_rows r
  JOIN accounts a ON a.id = r.account_id
  WHERE r.business_id = ? AND r.kind = 'card_settlement' AND r.direction = 'CR' AND r.status = 'unmatched' AND r.amount_paise = ?
    AND r.day BETWEEN ? AND ? ORDER BY r.posted_at`, businessId, netPaise, addDays(settledOn, -1), addDays(settledOn, 4))
  .then((rows) => rows.sort((a, b) => Number(settlementDateOf(b.description) === settledOn) - Number(settlementDateOf(a.description) === settledOn)));

/** Taking a settlement apart from its bank credit: the fee and GST expenses go (kept in the audit log by the caller). */
export const unsettleStatements = (db: DB, rowId: string) => [
  stmt(db, `DELETE FROM transactions WHERE source = 'bank_sheet' AND id IN (SELECT fee_tx_id FROM card_settlements WHERE bank_row_id = ?
    UNION SELECT gst_tx_id FROM card_settlements WHERE bank_row_id = ?)`, rowId, rowId),
  stmt(db, 'UPDATE card_settlements SET bank_row_id = NULL, fee_tx_id = NULL, gst_tx_id = NULL WHERE bank_row_id = ?', rowId),
];

// ---- Automatic where safe, and the Card settlement rule (approved 8 Nov 2026)

/** Bookr matches a payment to a bill on its own only within this many minutes, when neither has another candidate. */
export const AUTO_MIN = 20;
/** A card tip: the payment is more than the bill by at most this share of the bill (and the bill waits). */
const TIP_SHARE = 0.25;

/** Pairs Bookr may match on its own: the payment's only candidate, within AUTO_MIN, and no other payment wants any of its sales. */
export function autoPairs(payments: Pick<CardPayment, 'id' | 'paid_at' | 'amount_paise' | 'txn_type'>[], sales: CardSale[]) {
  const { candidates } = cardCandidates(payments, sales);
  const wants = new Map<string, Set<string>>();
  for (const [pid, list] of candidates) for (const k of list) for (const tid of k.transactionIds) wants.set(tid, new Set([...(wants.get(tid) ?? []), pid]));
  const out: { paymentId: string; k: CardCandidate }[] = [];
  for (const [pid, list] of candidates) {
    if (list.length !== 1 || list[0].minutes == null || list[0].minutes > AUTO_MIN) continue;
    if (list[0].transactionIds.some((tid) => (wants.get(tid)?.size ?? 0) !== 1)) continue;
    out.push({ paymentId: pid, k: list[0] });
  }
  return out;
}

export interface CardRule { terminalId: string; feeHeadId: string; gstHeadId: string }
export const cardRules = async (db: DB, businessId: string) => new Map((await all<{ terminal_id: string; fee_head_id: string; gst_head_id: string }>(db,
  'SELECT terminal_id, fee_head_id, gst_head_id FROM card_rules WHERE business_id = ?', businessId)).map((r) => [r.terminal_id, { terminalId: r.terminal_id, feeHeadId: r.fee_head_id, gstHeadId: r.gst_head_id }]));

/** The one rule for a set of payments: every terminal in it has a rule, and they agree. Null when not. */
export function ruleFor(list: Pick<CardPayment, 'terminal_id'>[], rules: Map<string, CardRule>): CardRule | null {
  const found = [...new Set(list.map((p) => p.terminal_id))].map((t) => rules.get(t));
  if (!found.length || found.some((r) => !r)) return null;
  return found.every((r) => r!.feeHeadId === found[0]!.feeHeadId && r!.gstHeadId === found[0]!.gstHeadId) ? found[0]! : null;
}

/**
 * A settlement (one day, or days paid together) booked against its bank credit: the fee and the GST on it become two
 * expense rows by the rule, on the bank account and the credit's day. No user: settled by Bookr.
 */
export function settleStatements(db: DB, businessId: string, list: CardPayment[], row: { id: string; account_id: string; day: string }, rule: CardRule | null,
  userId: string | null, t: number) {
  const sum = (k: 'amount_paise' | 'fee_paise' | 'gst_paise' | 'net_paise') => list.reduce((x, p) => x + p[k], 0);
  const [gross, fee, gst, net] = [sum('amount_paise'), sum('fee_paise'), sum('gst_paise'), sum('net_paise')];
  const days = [...new Set(list.map((p) => p.settled_on))].sort();
  const rupees = (p: number) => `₹${(p / 100).toFixed(2)}`;
  const label = days.length > 1 ? `${days.join(' + ')}` : days[0];
  const feeTx = fee > 0 ? newId() : null;
  const gstTx = gst > 0 ? newId() : null;
  const expense = (id: string, amount: number, head: string, narration: string) => stmt(db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, head_id,
    narration, source, status, payment_mode, matched_bank_row, created_at) VALUES (?, ?, ?, ?, ?, 'expense', ?, ?, 'bank_sheet', 'approved', 'card', ?, ?)`,
    id, businessId, row.account_id, row.day, amount, head, narration, row.id, t);
  const note = `Card settlement ${label}: ${list.length} payment${list.length === 1 ? '' : 's'}, ${rupees(gross)} less fee ${rupees(fee)}${gst ? ` and GST ${rupees(gst)}` : ''}`;
  return [
    ...(feeTx ? [expense(feeTx, fee, rule!.feeHeadId, `Card machine fee (MDR), settlement ${label}`)] : []),
    ...(gstTx ? [expense(gstTx, gst, rule!.gstHeadId, `GST on card machine fee, settlement ${label}`)] : []),
    stmt(db, "UPDATE bank_rows SET status = 'booked', transaction_id = ?, note = ?, done_by = ?, done_at = ? WHERE id = ? AND status = 'unmatched'", feeTx ?? gstTx, note, userId, t, row.id),
    ...list.map((p) => stmt(db, 'UPDATE card_settlements SET bank_row_id = ?, fee_tx_id = ?, gst_tx_id = ? WHERE id = ? AND bank_row_id IS NULL', row.id, feeTx, gstTx, p.id)),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'card.settle', 'bank_rows', ?, ?, ?, ?)`,
      businessId, userId, row.id, JSON.stringify({ status: 'unmatched' }),
      JSON.stringify({ status: 'booked', days, payments: list.length, gross, fee, gst, net, feeHeadId: rule?.feeHeadId ?? null, gstHeadId: rule?.gstHeadId ?? null,
        feeTransactionId: feeTx, gstTransactionId: gstTx, ...(userId ? {} : { auto: true }) }), t),
  ];
}

/** Open card settlement credits from the bank. */
export const openSettlementCredits = (db: DB, businessId: string) => all<{ id: string; account_id: string; account_name: string; day: string; posted_at: number; description: string; amount_paise: number }>(db, `
  SELECT r.id, r.account_id, a.name AS account_name, r.day, r.posted_at, r.description, r.amount_paise FROM bank_rows r JOIN accounts a ON a.id = r.account_id
  WHERE r.business_id = ? AND r.kind = 'card_settlement' AND r.direction = 'CR' AND r.status = 'unmatched' ORDER BY r.posted_at`, businessId);

/** Unsettled payments by settlement day and merchant (a day partly settled is left to a person). */
export async function unsettledDays(db: DB, businessId: string) {
  const list = await all<CardPayment>(db, `SELECT * FROM card_settlements s WHERE business_id = ? AND bank_row_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM card_settlements o WHERE o.business_id = s.business_id AND o.settled_on = s.settled_on AND o.merchant_id = s.merchant_id AND o.bank_row_id IS NOT NULL)
    ORDER BY settled_on`, businessId);
  const days = new Map<string, CardPayment[]>();
  for (const p of list) days.set(`${p.settled_on}|${p.merchant_id}`, [...(days.get(`${p.settled_on}|${p.merchant_id}`) ?? []), p]);
  return [...days.values()].map((ps) => ({ settledOn: ps[0].settled_on, merchantId: ps[0].merchant_id, payments: ps, netPaise: ps.reduce((t, p) => t + p.net_paise, 0) }));
}

/**
 * Days ICICI paid in one credit: two or three settlement days of a merchant in a row whose nets add up exactly to an
 * open credit dated the last of them. Offered, never done by Bookr.
 */
export function daysTogether(days: Awaited<ReturnType<typeof unsettledDays>>, credits: Awaited<ReturnType<typeof openSettlementCredits>>) {
  const out: { days: string[]; merchantId: string; creditId: string; netPaise: number }[] = [];
  const byMerchant = new Map<string, typeof days>();
  for (const d of days) byMerchant.set(d.merchantId, [...(byMerchant.get(d.merchantId) ?? []), d]);
  for (const [merchantId, list] of byMerchant) {
    for (let i = 0; i < list.length; i++) for (let n = 2; n <= 3 && i + n <= list.length; n++) {
      const run = list.slice(i, i + n);
      const net = run.reduce((t, d) => t + d.netPaise, 0);
      const last = run[run.length - 1].settledOn;
      const c = credits.filter((x) => x.amount_paise === net && (settlementDateOf(x.description) === last || settlementDateOf(x.description) == null) && x.day >= run[0].settledOn && x.day <= addDays(last, 4));
      if (c.length === 1) out.push({ days: run.map((d) => d.settledOn), merchantId, creditId: c[0].id, netPaise: net });
    }
  }
  return out;
}

/**
 * What Bookr does on its own, after card reports, bank lines or a confirmed shift arrive: matches the safe pairs, then
 * settles each day whose credit carries its date and exactly its net, by the rule. Returns how many of each.
 */
export async function runCardAuto(db: DB, businessId: string) {
  const t = now();
  const open = await all<CardPayment>(db, `SELECT * FROM card_settlements s WHERE business_id = ? AND txn_type = 'PURCHASE'
    AND NOT EXISTS (SELECT 1 FROM card_matches m WHERE m.settlement_id = s.id) ORDER BY paid_at LIMIT 2000`, businessId);
  let matched = 0;
  if (open.length) {
    const from = addDays(shiftDayOf(open[0].paid_at), -1);
    const to = addDays(shiftDayOf(open[open.length - 1].paid_at), 1);
    const pairs = autoPairs(open, await waitingCard(db, businessId, from, to));
    const statements = pairs.flatMap((p, i) => cardMatchStatements(db, businessId, [p.paymentId], p.k.transactionIds, null, t + i, { auto: true, minutes: p.k.minutes }));
    for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90));
    matched = pairs.length;
  }
  const [days, credits, rules] = await Promise.all([unsettledDays(db, businessId), openSettlementCredits(db, businessId), cardRules(db, businessId)]);
  const claims = new Map<string, number>();
  const fits = days.map((d) => ({ d, c: credits.filter((x) => x.amount_paise === d.netPaise && settlementDateOf(x.description) === d.settledOn) }));
  for (const f of fits) if (f.c.length === 1) claims.set(f.c[0].id, (claims.get(f.c[0].id) ?? 0) + 1);
  let settled = 0;
  for (const [i, f] of fits.entries()) {
    if (f.c.length !== 1 || claims.get(f.c[0].id) !== 1) continue;
    const fee = f.d.payments.reduce((x, p) => x + p.fee_paise + p.gst_paise, 0);
    const rule = ruleFor(f.d.payments, rules);
    if (fee > 0 && !rule) continue;
    await db.batch(settleStatements(db, businessId, f.d.payments, f.c[0], rule, null, t + 1000 + i));
    settled += 1;
  }
  return { matched, settled };
}

/** A sale or tip row Bookr added for a card payment (a tip on the card, or a swipe booked to a head): removed on unmatch. */
export const cardAddedRow = (kind: 'tip' | 'booked', paymentId: string) => JSON.stringify({ card: kind, paymentId });

/**
 * The card picture for one confirmed shift, for its Reconcile: its card bills and the payments swiped in it, what Bookr
 * or a person matched, what needs a person, card bills with no swipe once the report is in, and the settlements.
 */
export async function shiftCards(db: DB, businessId: string, day: string, cashOverPaise: number | null) {
  const w = shiftWindow(day);
  const [sales, payments, last, rules] = await Promise.all([
    all<{ id: string; amount_paise: number; bill_no: string | null; paid_at: number | null; match_status: string | null; group_head: string | null; source: string }>(db, `
      SELECT t.id, t.amount_paise, t.bill_no, sb.paid_at, t.match_status, coalesce(rr.paid_with_row_id, rr.id) AS group_head, t.source FROM transactions t
      LEFT JOIN bill_comparisons c ON c.id = t.comparison_id LEFT JOIN software_bills sb ON sb.id = c.software_bill_id LEFT JOIN register_rows rr ON rr.id = c.register_row_id
      WHERE t.business_id = ? AND t.shift_day = ? AND t.type = 'income' AND t.payment_mode = 'card' ORDER BY sb.paid_at, t.bill_no`, businessId, day),
    all<CardPayment & { matched_by: string | null; matched_at: number | null; matched: number }>(db, `
      SELECT s.*, (SELECT m.matched_by FROM card_matches m WHERE m.settlement_id = s.id LIMIT 1) AS matched_by,
        (SELECT m.matched_at FROM card_matches m WHERE m.settlement_id = s.id LIMIT 1) AS matched_at,
        EXISTS (SELECT 1 FROM card_matches m WHERE m.settlement_id = s.id) AS matched
      FROM card_settlements s WHERE s.business_id = ? AND s.paid_at >= ? AND s.paid_at < ? ORDER BY s.paid_at`, businessId, w.from, w.to),
    one<{ paid: number | null; settled: string | null }>(db, 'SELECT max(paid_at) AS paid, max(settled_on) AS settled FROM card_settlements WHERE business_id = ?', businessId),
    cardRules(db, businessId),
  ]);
  // The card report is in for this shift once a later swipe, or a settlement two days on, has arrived.
  const covered = (last?.paid ?? 0) >= w.to || (last?.settled ?? '') >= addDays(day, 2);
  const matches = sales.length ? await all<{ settlement_id: string; transaction_id: string }>(db,
    `SELECT settlement_id, transaction_id FROM card_matches WHERE business_id = ? AND transaction_id IN (${sales.map(() => '?').join(',')})`, businessId, ...sales.map((x) => x.id)) : [];
  const bills = sales.filter((x) => x.source === 'software_report');
  const waiting = bills.filter((x) => x.match_status === 'awaiting_card_settlement');
  const openPays = payments.filter((p) => !p.matched);
  // Candidates for this shift's open swipes, among card sales still waiting from the day before to the day after.
  const near = await waitingCard(db, businessId, addDays(day, -1), addDays(day, 1));
  const { candidates } = cardCandidates(openPays, near);
  const tipFor = (p: CardPayment) => near.filter((s) => s.paid_at != null && p.amount_paise > s.amount_paise && p.amount_paise - s.amount_paise <= s.amount_paise * TIP_SHARE
    && Math.abs(p.paid_at - s.paid_at) <= AUTO_MIN * 60000).sort((a, b) => Math.abs(p.paid_at - a.paid_at!) - Math.abs(p.paid_at - b.paid_at!))[0] ?? null;
  const pay = (p: CardPayment) => ({ id: p.id, paidAt: p.paid_at, amountPaise: p.amount_paise, txnType: p.txn_type, cardType: p.card_type, cardLast4: p.card_last4, terminalId: p.terminal_id });
  const needs = openPays.map((p) => {
    const list = (candidates.get(p.id) ?? []).slice(0, 5);
    const tip = !list.length && p.txn_type === 'PURCHASE' ? tipFor(p) : null;
    return { payment: pay(p), why: p.txn_type !== 'PURCHASE' ? 'not_purchase' : list.length ? (list.length > 1 ? 'several' : 'one') : tip ? 'tip' : 'no_bill',
      candidates: list, tip: tip ? { transactionId: tip.id, billNo: tip.bill_no, amountPaise: tip.amount_paise, paidAt: tip.paid_at, tipPaise: p.amount_paise - tip.amount_paise } : null };
  });
  const offered = new Set(needs.flatMap((n) => [...n.candidates.flatMap((k) => k.transactionIds), ...(n.tip ? [n.tip.transactionId] : [])]));
  const noSwipe = covered ? waiting.filter((x) => !offered.has(x.id)).map((x) => ({ transactionId: x.id, billNo: x.bill_no, amountPaise: x.amount_paise, paidAt: x.paid_at,
    groupHead: x.group_head, cashFits: cashOverPaise != null && cashOverPaise === x.amount_paise })) : [];
  const done = payments.filter((p) => p.matched).map((p) => {
    const tx = matches.filter((m) => m.settlement_id === p.id).map((m) => sales.find((x) => x.id === m.transaction_id)).filter(Boolean) as typeof sales;
    return { payment: pay(p), byBookr: !p.matched_by, bills: [...new Set(tx.filter((x) => x.source === 'software_report').map((x) => x.bill_no ?? ''))],
      tipPaise: tx.filter((x) => x.source === 'bank_sheet').reduce((a, x) => a + x.amount_paise, 0), booked: tx.length > 0 && tx.every((x) => x.source === 'bank_sheet') };
  });
  // The settlements this shift's swipes are in.
  const days = [...new Set(payments.map((p) => `${p.settled_on}|${p.merchant_id}`))];
  const settlements = await Promise.all(days.map(async (k) => {
    const [on, merchant] = k.split('|');
    const list = await all<CardPayment>(db, 'SELECT * FROM card_settlements WHERE business_id = ? AND settled_on = ? AND merchant_id = ?', businessId, on, merchant);
    const sum = (f: 'amount_paise' | 'fee_paise' | 'gst_paise' | 'net_paise') => list.reduce((a, p) => a + p[f], 0);
    const rowId = list.find((p) => p.bank_row_id)?.bank_row_id ?? null;
    const row = rowId ? await one<{ id: string; day: string; posted_at: number; description: string; done_by: string | null; account_name: string }>(db,
      'SELECT r.id, r.day, r.posted_at, r.description, r.done_by, a.name AS account_name FROM bank_rows r JOIN accounts a ON a.id = r.account_id WHERE r.id = ?', rowId) : null;
    const rule = ruleFor(list, rules);
    return { settledOn: on, merchantId: merchant, payments: list.length, amountPaise: sum('amount_paise'), feePaise: sum('fee_paise'), gstPaise: sum('gst_paise'), netPaise: sum('net_paise'),
      ruleSet: !!rule, bank: row ? { id: row.id, day: row.day, postedAt: row.posted_at, description: row.description, accountName: row.account_name, byBookr: !row.done_by } : null };
  }));
  const sum = (xs: { amount_paise?: number; amountPaise?: number }[]) => xs.reduce((a, x) => a + (x.amount_paise ?? x.amountPaise ?? 0), 0);
  const matchedBills = bills.filter((x) => !x.match_status);
  return {
    day, covered,
    strip: { billsPaise: sum(bills), bills: bills.length, matchedPaise: sum(matchedBills), matched: matchedBills.length, byBookr: done.filter((d) => d.byBookr).length,
      noSwipePaise: sum(noSwipe), noSwipe: noSwipe.length, noBillPaise: sum(needs.filter((n) => n.why === 'no_bill').map((n) => n.payment)), noBill: needs.filter((n) => n.why === 'no_bill').length },
    needs, noSwipe, done, settlements,
    left: needs.length + noSwipe.length,
  };
}

/** How much the shift's counted cash is over what should be in hand (null when not over, or not counted). */
export async function cashOver(db: DB, businessId: string, day: string) {
  const d = (await cashCheck(db, businessId, day)).differencePaise;
  return d != null && d > 0 ? d : null;
}
