import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, SUMMARY_IN_USE } from '../db';
import { fail } from '../http';
import { addDays, shiftDayOf } from '../time';

export const fundsRoutes = new Hono<AppEnv>();

/**
 * Funds flow (approved 14 Nov 2026): the money that actually moved between two shifts, one column per account.
 * Read-only; nothing is stored. Days are shifts (8 am to 8 am, India time).
 * - Bank accounts: every statement line counts, on the shift of its posted time, placed by what it was matched or
 *   booked to (bills, a card settlement, a head, a transfer, left out, or still open). A card settlement is shown
 *   gross (what the card payments were) with the card company's fees and GST as money out, so the two net to the
 *   line. A transfer leg booked on an account whose statement does not have it yet counts too.
 * - Cash accounts: the cash sales of confirmed shifts, cash expenses (drafts too, as "not approved yet": the cash
 *   has gone), shortages booked, and cash moved to or from the bank.
 * - Funds at start: the account's opening balance on its opening date, plus every movement since, up to the period.
 * - Check: a bank account's end figure against the balance on its last statement line in the period; a cash
 *   account's against the cash counted on the last cash summary page (worked out for that shift).
 * Bank data, so the same people as Bank sync ('bank.link').
 */

// India time less 8 hours (19 800 000 − 28 800 000 ms), as on Bank sync and Money out.
const SHIFT_OF = "date((r.posted_at - 9000000) / 1000, 'unixepoch')";
const TX_DAY = `coalesce(t.shift_day, CASE WHEN json_extract(t.ocr_original, '$.at') IS NOT NULL
  THEN date((json_extract(t.ocr_original, '$.at') - 9000000) / 1000, 'unixepoch') END, t.day)`;
// Cash account rows, and transfer legs on a bank account that no statement line carries yet.
const TX_WHERE = `t.business_id = ? AND (a.kind = 'cash' AND t.type IN ('income', 'expense', 'transfer')
  OR a.kind = 'bank' AND t.type = 'transfer' AND NOT EXISTS (SELECT 1 FROM bank_rows b WHERE b.transaction_id = t.id))`;

type Account = { id: string; name: string; kind: 'cash' | 'bank'; opening_balance_paise: number; opening_date: string };
type BankRow = {
  id: string; account_id: string; direction: 'CR' | 'DR'; amount_paise: number; status: string; kind: string; description: string; note: string | null;
  day: string; tx_id: string | null; tx_type: string | null; head_id: string | null; head: string | null; narration: string | null;
  cards: number; card_gross: number;
};
type Tx = {
  id: string; account_id: string; day: string; amount_paise: number; type: string; status: string; source: string; payment_mode: string | null;
  head_id: string | null; head: string | null; narration: string | null; leg: string | null;
};
type Leg = { id: string; account_id: string; kind: string | null; partner: string | null; bank_row_id: string | null; leg: string | null };
export type FlowRow = { key: string; group: 'in' | 'out' | 'tr'; section: string; label: string; warn?: boolean; amounts: Record<string, number> };
type Line = { key: string; accountId: string; day: string; text: string; paise: number };

const SECTION_ORDER = ['sales', 'advance', 'income', 'left_out', 'open', 'expenses', 'card_fees', 'not_approved', 'transfers'];

fundsRoutes.get('/businesses/:businessId/reports/funds-flow', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const q = c.req.query();
  const isDay = (v: string | undefined) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');
  const today = shiftDayOf(Date.now());
  const accounts = await all<Account>(db, `SELECT id, name, kind, opening_balance_paise, opening_date FROM accounts WHERE business_id = ?
    ORDER BY kind = 'bank', created_at, lower(name)`, bid);
  const start = accounts.length ? accounts.map((a) => a.opening_date).sort()[0] : today;
  const to = isDay(q.to) ? q.to! : today;
  let from = isDay(q.from) ? q.from! : `${to.slice(0, 8)}01`;
  if (from < start) from = start;
  if (from > to) fail(400, to < start ? `The books start on ${start}. Choose shifts from then on.` : 'From must be on or before To.');
  if (addDays(from, 400) < to) fail(400, 'Choose at most about a year at a time.');
  const key = typeof q.key === 'string' && q.key.length <= 120 ? q.key : null;

  const [before, beforeTx, rows, txs, legs, statement, counted, billed] = await Promise.all([
    // Movement on each bank account from its opening date to the shift before the period.
    all<{ account_id: string; paise: number }>(db, `SELECT r.account_id, sum(CASE r.direction WHEN 'CR' THEN r.amount_paise ELSE -r.amount_paise END) AS paise
      FROM bank_rows r JOIN accounts a ON a.id = r.account_id
      WHERE r.business_id = ? AND r.day < ? AND ${SHIFT_OF} >= a.opening_date AND ${SHIFT_OF} < ? GROUP BY r.account_id`, bid, addDays(from, 1), from),
    all<{ account_id: string; paise: number }>(db, `SELECT t.account_id, sum(CASE
        WHEN t.type = 'income' THEN t.amount_paise WHEN t.type = 'expense' THEN -t.amount_paise
        WHEN json_extract(t.ocr_original, '$.leg') = 'in' THEN t.amount_paise ELSE -t.amount_paise END) AS paise
      FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE ${TX_WHERE} AND ${TX_DAY} >= a.opening_date AND ${TX_DAY} < ? GROUP BY t.account_id`, bid, from),
    all<BankRow>(db, `SELECT r.id, r.account_id, r.direction, r.amount_paise, r.status, r.kind, r.description, r.note, ${SHIFT_OF} AS day,
        t.id AS tx_id, t.type AS tx_type, t.head_id, h.name AS head, t.narration,
        (SELECT count(*) FROM card_settlements s WHERE s.bank_row_id = r.id) AS cards,
        (SELECT coalesce(sum(s.amount_paise), 0) FROM card_settlements s WHERE s.bank_row_id = r.id) AS card_gross
      FROM bank_rows r JOIN accounts a ON a.id = r.account_id
      LEFT JOIN transactions t ON t.id = r.transaction_id LEFT JOIN heads h ON h.id = t.head_id
      WHERE r.business_id = ? AND r.day BETWEEN ? AND ? AND ${SHIFT_OF} BETWEEN ? AND ? AND ${SHIFT_OF} >= a.opening_date
      ORDER BY r.posted_at`, bid, from, addDays(to, 1), from, to),
    all<Tx>(db, `SELECT t.id, t.account_id, ${TX_DAY} AS day, t.amount_paise, t.type, t.status, t.source, t.payment_mode, t.head_id, h.name AS head, t.narration,
        json_extract(t.ocr_original, '$.leg') AS leg
      FROM transactions t JOIN accounts a ON a.id = t.account_id LEFT JOIN heads h ON h.id = t.head_id
      WHERE ${TX_WHERE} AND ${TX_DAY} BETWEEN ? AND ? AND ${TX_DAY} >= a.opening_date ORDER BY 3`, bid, from, to),
    all<Leg>(db, `SELECT id, account_id, json_extract(ocr_original, '$.transfer') AS kind, json_extract(ocr_original, '$.partner') AS partner,
        json_extract(ocr_original, '$.bankRowId') AS bank_row_id, json_extract(ocr_original, '$.leg') AS leg
      FROM transactions WHERE business_id = ? AND type = 'transfer'`, bid),
    // The balance on each bank account's last statement line up to the end of the period.
    all<{ account_id: string; balance_paise: number | null; day: string }>(db, `SELECT account_id, balance_paise, day FROM (
        SELECT r.account_id, r.balance_paise, ${SHIFT_OF} AS day,
          row_number() OVER (PARTITION BY r.account_id ORDER BY r.posted_at DESC, r.rowid DESC) AS n
        FROM bank_rows r JOIN accounts a ON a.id = r.account_id
        WHERE r.business_id = ? AND r.day <= ? AND ${SHIFT_OF} <= ? AND ${SHIFT_OF} >= a.opening_date) WHERE n = 1`, bid, addDays(to, 1), to),
    // The cash counted on the last cash summary page up to the end of the period.
    all<{ shift_day: string; cash_in_hand_paise: number; ocr_original: string | null }>(db, `SELECT shift_day, cash_in_hand_paise, ocr_original FROM cash_summaries
      WHERE business_id = ? AND shift_day <= ? AND shift_day >= ? AND cash_in_hand_paise IS NOT NULL AND ${SUMMARY_IN_USE}
      ORDER BY shift_day DESC, status = 'approved' DESC, created_at DESC LIMIT 1`, bid, to, start),
    // Sales billed in these shifts, and what of them has not come in yet.
    all<{ mode: string | null; waiting: number; n: number; paise: number }>(db, `SELECT payment_mode AS mode, match_status IS NOT NULL AS waiting, count(*) AS n, coalesce(sum(amount_paise), 0) AS paise
      FROM transactions WHERE business_id = ? AND source = 'software_report' AND type = 'income' AND shift_day BETWEEN ? AND ?
      GROUP BY 1, 2`, bid, from, to),
  ]);

  const accName = new Map(accounts.map((a) => [a.id, a.name]));
  const accKind = new Map(accounts.map((a) => [a.id, a.kind]));
  const legById = new Map(legs.map((l) => [l.id, l]));
  // The other account of a transfer leg: the partner row of an own transfer, or the other leg of a cash move.
  const otherOf = (legId: string | null, accountId: string) => {
    const l = legId ? legById.get(legId) : undefined;
    if (!l) return null;
    if (l.partner) return legById.get(l.partner)?.account_id ?? null;
    if (l.bank_row_id) return legs.find((x) => x.id !== l.id && x.bank_row_id === l.bank_row_id && x.kind === l.kind)?.account_id ?? null;
    return accountId === l.account_id ? null : l.account_id;
  };

  const flow = new Map<string, FlowRow>();
  const lines: Line[] = [];
  const add = (k: string, group: FlowRow['group'], section: string, label: string, accountId: string, paise: number, day: string, text: string, warn = false) => {
    const r = flow.get(k) ?? { key: k, group, section, label, ...(warn ? { warn } : {}), amounts: {} };
    r.amounts[accountId] = (r.amounts[accountId] ?? 0) + paise;
    flow.set(k, r);
    if (key === k) lines.push({ key: k, accountId, day, text, paise });
  };
  const transfer = (accountId: string, other: string | null, leg: 'in' | 'out', paise: number, day: string, text: string) => {
    const [a, b] = leg === 'out' ? [accountId, other] : [other, accountId];
    const name = (id: string | null) => (id ? accName.get(id) ?? 'Another account' : 'An account not known');
    const label = accKind.get(a ?? '') === 'cash' && b ? `Cash deposited in ${name(b)}`
      : accKind.get(b ?? '') === 'cash' && a ? `Cash taken out of ${name(a)}` : `${name(a)} → ${name(b)}`;
    add(`tr:${a ?? 'x'}>${b ?? 'x'}`, 'tr', 'transfers', label, accountId, leg === 'in' ? paise : -paise, day, text);
  };
  const kindOfIncome = (narration: string | null) => (/\bAdvance:/i.test(narration ?? '') ? 'advance' : /Sale not billed|Unbilled sale/i.test(narration ?? '') ? 'not_billed' : null);

  for (const r of rows) {
    const cr = r.direction === 'CR';
    const text = r.narration || r.note || r.description;
    if (cr && r.cards > 0) {
      // Card payments gross, the card company's fees and GST out: the two net to what reached the bank.
      add('in:card', 'in', 'sales', 'Card settlements (card payments)', r.account_id, r.card_gross, r.day, `${r.description} (${r.cards} card payment${r.cards === 1 ? '' : 's'})`);
      if (r.card_gross !== r.amount_paise) add('out:card_fees', 'out', 'card_fees', 'Card machine fees and GST', r.account_id, r.card_gross - r.amount_paise, r.day, r.note || r.description);
    } else if (r.tx_type === 'transfer') transfer(r.account_id, otherOf(r.tx_id, r.account_id), cr ? 'in' : 'out', r.amount_paise, r.day, text);
    else if (r.status === 'ignored') add(cr ? 'in:left_out' : 'out:left_out', cr ? 'in' : 'out', 'left_out', 'Left out on Bank (reversals and such)', r.account_id, r.amount_paise, r.day, `${r.description}${r.note ? ` · ${r.note}` : ''}`);
    else if (r.status === 'unmatched') {
      if (cr) add('in:open', 'in', 'open', 'Not explained yet', r.account_id, r.amount_paise, r.day, r.description, true);
      else add('out:open', 'out', 'open', 'Not booked yet', r.account_id, r.amount_paise, r.day, r.description, true);
    } else if (cr && r.status === 'matched') add('in:upi_bills', 'in', 'sales', 'UPI received for bills', r.account_id, r.amount_paise, r.day, r.note || r.description);
    else if (cr && r.tx_type === 'income') {
      const k = kindOfIncome(r.narration);
      if (k === 'advance') add('in:advance', 'in', 'advance', 'Advances received', r.account_id, r.amount_paise, r.day, text);
      else if (k === 'not_billed') add('in:not_billed', 'in', 'sales', 'Sales not billed', r.account_id, r.amount_paise, r.day, text);
      else add(`in:head:${r.head_id ?? 'none'}`, 'in', 'income', r.head ?? 'No head', r.account_id, r.amount_paise, r.day, text);
    } else if (!cr && r.tx_type === 'expense') add(`out:head:${r.head_id ?? 'none'}`, 'out', 'expenses', r.head ?? 'No head yet', r.account_id, r.amount_paise, r.day, text, !r.head_id);
    else add(cr ? 'in:other' : 'out:other', cr ? 'in' : 'out', cr ? 'income' : 'expenses', cr ? 'Other money in' : 'Other money out', r.account_id, r.amount_paise, r.day, text);
  }
  for (const t of txs) {
    const text = t.narration || '';
    if (t.type === 'transfer') transfer(t.account_id, otherOf(t.id, t.account_id), t.leg === 'in' ? 'in' : 'out', t.amount_paise, t.day,
      `${text}${accKind.get(t.account_id) === 'bank' ? ' (not on the statement yet)' : ''}`);
    else if (t.type === 'income') {
      const k = t.source === 'software_report' && t.payment_mode === 'cash' ? 'cash' : kindOfIncome(t.narration);
      if (k === 'cash') add('in:cash_sales', 'in', 'sales', 'Cash sales', t.account_id, t.amount_paise, t.day, text);
      else if (k === 'advance') add('in:advance', 'in', 'advance', 'Advances received', t.account_id, t.amount_paise, t.day, text);
      else if (k === 'not_billed') add('in:not_billed', 'in', 'sales', 'Sales not billed', t.account_id, t.amount_paise, t.day, text);
      else add(`in:head:${t.head_id ?? 'none'}`, 'in', 'income', t.head ?? 'No head', t.account_id, t.amount_paise, t.day, text);
    } else if (t.status === 'draft') add('out:not_approved', 'out', 'not_approved', 'Cash expenses not approved yet', t.account_id, t.amount_paise, t.day, text, true);
    else add(`out:head:${t.head_id ?? 'none'}`, 'out', 'expenses', t.head ?? 'No head yet', t.account_id, t.amount_paise, t.day, text, !t.head_id);
  }

  const startOf: Record<string, number> = {};
  for (const a of accounts) startOf[a.id] = a.opening_date <= from ? a.opening_balance_paise : 0;
  for (const b of [...before, ...beforeTx]) startOf[b.account_id] = (startOf[b.account_id] ?? 0) + b.paise;
  // An account opened inside the period: its opening balance is money it brought in.
  for (const a of accounts) if (a.opening_date > from && a.opening_date <= to && a.opening_balance_paise) add('in:opening', 'in', 'income', 'Opening balance of an account opened in the period', a.id, a.opening_balance_paise, a.opening_date, `${a.name}: opening balance`);

  const signed = (r: FlowRow, id: string) => (r.amounts[id] ?? 0) * (r.group === 'out' ? -1 : 1);
  const list = [...flow.values()].sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section)
    || Math.abs(Object.values(b.amounts).reduce((s, x) => s + x, 0)) - Math.abs(Object.values(a.amounts).reduce((s, x) => s + x, 0)));
  const endOf: Record<string, number> = {};
  for (const a of accounts) endOf[a.id] = (startOf[a.id] ?? 0) + list.reduce((s, r) => s + signed(r, a.id), 0);

  // Checks. Cash: worked out for the shift of the last count, which may be before the end of the period.
  const checks: Record<string, { what: 'statement' | 'counted'; day: string; paise: number | null; differencePaise: number | null } | null> = {};
  for (const a of accounts) {
    if (a.kind === 'bank') {
      const s = statement.find((x) => x.account_id === a.id);
      checks[a.id] = s ? { what: 'statement', day: s.day, paise: s.balance_paise, differencePaise: s.balance_paise === null ? null : s.balance_paise - endOf[a.id] } : null;
    } else checks[a.id] = null;
  }
  const cashIds = accounts.filter((a) => a.kind === 'cash').map((a) => a.id);
  if (counted[0] && cashIds.length === 1) {
    const d = counted[0].shift_day;
    const a = accounts.find((x) => x.id === cashIds[0])!;
    const at = d >= to ? endOf[a.id] : await cashAt(db, bid, a, d);
    checks[a.id] = { what: 'counted', day: d, paise: counted[0].cash_in_hand_paise, differencePaise: counted[0].cash_in_hand_paise - at };
  }
  // What the cash check needs said (17 Nov 2026): a count from a sheet revised by hand, and shifts not saved yet, whose
  // cash sales are not in the books.
  const rev = (() => { try { return (JSON.parse(counted[0]?.ocr_original ?? '{}') as { revision?: { reason: string; note: string | null } }).revision ?? null; } catch { return null; } })();
  const unsaved = (await all<{ day: string }>(db, `SELECT DISTINCT b.shift_day AS day FROM software_bills b WHERE b.business_id = ? AND b.shift_day BETWEEN ? AND ?
    AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.business_id = b.business_id AND s.shift_day = b.shift_day AND s.status = 'confirmed') ORDER BY b.shift_day`, bid, from, to)).map((x) => x.day);
  const cashNotes = { revised: counted[0] && rev ? { day: counted[0].shift_day, reason: rev.reason, note: rev.note } : null, unsaved };

  const sum = (f: (b: typeof billed[number]) => boolean) => billed.filter(f).reduce((s, b) => ({ n: s.n + b.n, paise: s.paise + b.paise }), { n: 0, paise: 0 });
  return c.json({
    from, to, booksStart: start,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, kind: a.kind, openingDate: a.opening_date })),
    start: startOf, rows: list, end: endOf, checks, cashNotes,
    memo: {
      billed: sum(() => true),
      upiWaiting: sum((b) => b.mode === 'upi' && !!b.waiting),
      cardWaiting: sum((b) => b.mode === 'card' && !!b.waiting),
    },
    ...(key ? { key, lines } : {}),
  });
});

/** A cash account's balance at the end of a shift: opening balance plus every movement from its opening date. */
async function cashAt(db: D1Database, bid: string, a: Account, day: string) {
  if (day < a.opening_date) return a.opening_balance_paise;
  const r = await all<{ paise: number }>(db, `SELECT coalesce(sum(CASE
      WHEN t.type = 'income' THEN t.amount_paise WHEN t.type = 'expense' THEN -t.amount_paise
      WHEN json_extract(t.ocr_original, '$.leg') = 'in' THEN t.amount_paise ELSE -t.amount_paise END), 0) AS paise
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE ${TX_WHERE} AND t.account_id = ? AND ${TX_DAY} BETWEEN ? AND ?`, bid, a.id, a.opening_date, day);
  return a.opening_balance_paise + (r[0]?.paise ?? 0);
}
