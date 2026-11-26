import { removeTwice, undoTwice } from '../countedTwice';
import { Hono, type Context } from 'hono';
import { bookTransferStatements, ownAccounts, transferHints, undoTransferStatements } from '../transfers';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, newId, now, one, stmt } from '../db';
import { body, fail, isUuid, optionalPaise, text } from '../http';
import { parseStatementRows, parseStatementText } from '../bankstatement';
import { GoogleError, readSheet, serviceAccountEmail, sheetIdFrom } from '../google';
import { loanKeys, loanOf } from '../loans';
import { allocate, getRow, importLines, loadRules, matchedSet, matchStatements, ruleFor, settleOnCredit, suggestionsFor, type BankRow } from '../bank';
import { byName, headFromItem, inText, loadHistory, loadItemHistory, loadParties, pickHead, resolveVendor } from '../parties';
import { adjustStatements } from '../bankadjust';
import { fixBillStatements, undoAll } from '../billfix';
import { repaidFor, repayStatements, undoRepayStatements, type ShortageCut } from '../repay';
import { can } from '../permissions';
import { cashOver, isMachineUpi, machineLabel, shiftCards, unsettledDays } from '../cards';
import { trialCards } from '../cardTrial';
import { explainShift } from '../explain';
import { reconcileShift, trialReconcile, unmatchedEntries } from '../reconcile';
import { bookedTx, joinedBill, plansFor, sameSaleStatements, undoSameSaleStatements } from '../sameSale';
import { bookingGate, gateWord, SETTLEMENT_BACK_DAYS, SETTLEMENT_REMARK, type GateCheck } from '../bookingGate';
import { addPlanStatements, dropPlanStatements, heldCredit, heldPayment, isClash, isPlanId, planById, planClash, shiftPlans } from '../plans';
import { billDistance, cardShiftChoices, plannedCardPaise, plannedUpiPaise, shiftChoices, shiftView, WATCH_DAYS } from '../sales';
import { addDays, istDay, shiftDayOf, shiftWindow } from '../time';
import { accountLabels, columnHints } from '../columnHints';
import { shiftSlips, slipFixStatements } from '../slips';
import { cardHere, paidOtherwise, settledHere, upiHere } from '../settledHere';
import { unsettleStatements } from '../cards';
import { cashCheck, cashMoveOf } from '../cash';
import { evidenceFor } from '../paidLater';
import { paidByUpi } from '../paidByUpi';
import { ADVANCE_TAG, creditChecks, HELD, heldKindOf, heldList, isHeldDone, OWED_PREFIX, type HeldKind } from '../extra';
import { cardReportsStatus, syncCardFolder } from '../cardDrive';
import { shiftEntries } from '../entries';
import { hiddenKeys, readNote, repeatsFor } from '../repeats';

export const bankRoutes = new Hono<AppEnv>();

// After any change made here, sales counted on their bank credit's day follow their matches (see settleOnCredit).
bankRoutes.use('/businesses/:businessId/*', async (c, next) => {
  await next();
  if (c.req.method === 'GET' || c.res.status >= 300) return;
  const bid = c.get('businessId');
  if (bid) await c.env.DB.batch(settleOnCredit(c.env.DB, bid));
});

const MAX_PASTE = 2_000_000;
const audit = (bid: string, user: string, action: string, id: string, before: unknown, after: unknown, t: number) =>
  [bid, user, action, id, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), t] as const;
const AUDIT = `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, ?, 'bank_rows', ?, ?, ?, ?)`;
const TX_AUDIT = AUDIT.replace("'bank_rows'", "'transactions'");
/** An audit line on any table. */
const LOG = `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

async function bankAccount(db: D1Database, bid: string, id: string) {
  if (!isUuid(id)) fail(404, 'Not found.');
  const a = await one<{ id: string; name: string }>(db, "SELECT id, name FROM accounts WHERE id = ? AND business_id = ? AND kind = 'bank'", id, bid);
  if (!a) fail(404, 'Bank account not found.');
  return a;
}

// ---- Accounts and where their statements come from

bankRoutes.get('/businesses/:businessId/bank', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const accounts = await all(db, `
    SELECT a.id, a.name, a.account_number AS accountNumber, s.sheet_id AS sheetId, s.tab, s.receives_upi_label AS receivesUpiLabel,
      s.receives_card AS receivesCard, s.last_synced_at AS lastSyncedAt, s.last_sync_note AS lastSyncNote,
      (SELECT count(*) FROM bank_rows r WHERE r.account_id = a.id) AS rows,
      (SELECT count(*) FROM bank_rows r WHERE r.account_id = a.id AND r.status = 'unmatched') AS open,
      (SELECT max(day) FROM bank_rows r WHERE r.account_id = a.id) AS lastDay,
      (SELECT max(posted_at) FROM bank_rows r WHERE r.account_id = a.id) AS lastAt
    FROM accounts a LEFT JOIN bank_sources s ON s.account_id = a.id
    WHERE a.business_id = ? AND a.kind = 'bank' ORDER BY a.name`, bid);
  // For the Bank page's strip and tab counts (approved 10 Nov 2026): lines still open by direction, card days to settle.
  const [open, days] = await Promise.all([
    one<{ cr: number; dr: number }>(db, `SELECT sum(direction = 'CR') AS cr, sum(direction = 'DR') AS dr FROM bank_rows
      WHERE business_id = ? AND status = 'unmatched' AND kind <> 'card_settlement'`, bid),
    unsettledDays(db, bid),
  ]);
  const cards = await cardReportsStatus(c.env, bid);
  return c.json({ accounts, googleEmail: serviceAccountEmail(c.env), open: { in: open?.cr ?? 0, out: open?.dr ?? 0 },
    cards: { ...cards, days: days.length, daysNetPaise: days.reduce((t, d) => t + d.netPaise, 0) } });
});

bankRoutes.put('/businesses/:businessId/bank/:accountId/source', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const a = await bankAccount(db, bid, c.req.param('accountId'));
  const data = await body(c);
  const sheetText = text(data, 'sheet', 'Google Sheet link', { optional: true, max: 300 });
  const sheetId = sheetText ? sheetIdFrom(sheetText) : null;
  if (sheetText && !sheetId) fail(400, 'That does not look like a Google Sheets link.');
  const tab = data.allTabs === true ? null : text(data, 'tab', 'Tab name', { optional: true, max: 100 });
  if (sheetId && !tab && data.allTabs !== true) fail(400, 'Give the tab name, or choose "every tab" for monthly tabs.');
  const label = text(data, 'receivesUpiLabel', 'UPI column', { optional: true, max: 40 });
  const card = data.receivesCard === true ? 1 : 0;
  const t = now();
  await db.batch([
    stmt(db, `INSERT INTO bank_sources (id, business_id, account_id, sheet_id, tab, receives_upi_label, receives_card, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (account_id) DO UPDATE SET sheet_id = excluded.sheet_id, tab = excluded.tab,
      receives_upi_label = excluded.receives_upi_label, receives_card = excluded.receives_card`,
      newId(), bid, a.id, sheetId, tab, label, card, t),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      VALUES (?, ?, 'bank.source', 'accounts', ?, NULL, ?, ?)`, bid, c.get('user').id, a.id, JSON.stringify({ sheetId, tab, label, card }), t),
  ]);
  return c.json({ ok: true });
});

bankRoutes.post('/businesses/:businessId/bank/:accountId/paste', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const a = await bankAccount(db, bid, c.req.param('accountId'));
  const raw = (await body(c)).text;
  if (typeof raw !== 'string' || !raw.trim()) fail(400, 'Paste the rows copied from the sheet.');
  if (raw.length > MAX_PASTE) fail(400, 'That is too much at once. Paste a month at a time.');
  const parsed = parseStatementText(raw);
  if (!parsed.lines.length) fail(400, parsed.problems[0] ?? 'No statement lines found. Copy whole rows from the sheet, including the Transaction ID column.');
  const r = await importLines(db, bid, a.id, parsed.lines);
  return c.json({ ...r, problems: parsed.problems.slice(0, 20) });
});

/** Reads one account's sheet and adds the new lines. A Google problem is noted on the account and returned as text. */
async function syncAccount(env: AppEnv['Bindings'], db: D1Database, bid: string, accountId: string) {
  const src = await one<{ sheet_id: string | null; tab: string | null }>(db, 'SELECT sheet_id, tab FROM bank_sources WHERE account_id = ?', accountId);
  if (!src?.sheet_id) return { ok: false as const, error: 'Give this account its Google Sheet link first, or paste the rows.' };
  let rows: string[][];
  let tabs: string[];
  try { ({ rows, tabs } = await readSheet(env, src.sheet_id, src.tab)); }
  catch (e) {
    if (e instanceof GoogleError) {
      await stmt(db, 'UPDATE bank_sources SET last_sync_note = ? WHERE account_id = ?', e.message, accountId).run();
      return { ok: false as const, error: e.message };
    }
    throw e;
  }
  const parsed = parseStatementRows(rows);
  const r = await importLines(db, bid, accountId, parsed.lines);
  const note = `${r.added} new line${r.added === 1 ? '' : 's'} from ${tabs.length} tab${tabs.length === 1 ? '' : 's'}${parsed.problems.length ? `; ${parsed.problems.length} could not be read` : ''}.`;
  await stmt(db, 'UPDATE bank_sources SET last_synced_at = ?, last_sync_note = ? WHERE account_id = ?', now(), note, accountId).run();
  const last = await one<{ at: number | null }>(db, 'SELECT max(posted_at) AS at FROM bank_rows WHERE account_id = ?', accountId);
  return { ok: true as const, ...r, tabs: tabs.length, problems: parsed.problems.slice(0, 20), lastAt: last?.at ?? null };
}

bankRoutes.post('/businesses/:businessId/bank/:accountId/sync', requireRole('bank.link'), async (c) => {
  const a = await bankAccount(c.env.DB, c.get('businessId'), c.req.param('accountId'));
  const r = await syncAccount(c.env, c.env.DB, c.get('businessId'), a.id);
  if (!r.ok) fail(400, r.error);
  return c.json(r);
});

/** Every account with a Google Sheet, one after another; one failing does not stop the rest. */
bankRoutes.post('/businesses/:businessId/bank/sync-all', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const accounts = await all<{ id: string; name: string }>(db, `SELECT a.id, a.name FROM accounts a JOIN bank_sources s ON s.account_id = a.id
    WHERE a.business_id = ? AND a.kind = 'bank' AND s.sheet_id IS NOT NULL ORDER BY a.name`, bid);
  const results = [];
  for (const a of accounts) {
    try { results.push({ accountId: a.id, name: a.name, ...(await syncAccount(c.env, db, bid, a.id)) }); }
    catch (e) { results.push({ accountId: a.id, name: a.name, ok: false, error: (e as Error).message || 'Could not sync.' }); }
  }
  // The card company's reports in the Drive folder, if one is set: read with the bank, so one Sync brings in both.
  let cards: ({ ok: true } & NonNullable<Awaited<ReturnType<typeof syncCardFolder>>>) | { ok: false; error: string } | null = null;
  try { const r = await syncCardFolder(c.env, bid); cards = r ? { ok: true, ...r } : null; }
  catch (e) { cards = { ok: false, error: (e as Error).message || 'Could not read the card reports.' }; }
  return c.json({ results, cards });
});

// ---- Lines, with what Bookr suggests for each

/** A refund of a paid bill goes back within this long of its payment (a cancelled booking may take weeks). */
const REFUND_BILL_DAYS = 30;

bankRoutes.get('/businesses/:businessId/bank-rows', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const q = c.req.query();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '') ? q.to! : istDay(Date.now());
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? '') ? q.from! : to;
  if (from > to) fail(400, 'From must be on or before To.');
  const account = q.account && isUuid(q.account) ? q.account : null;
  const status = ['unmatched', 'matched', 'booked', 'ignored'].includes(q.status ?? '') ? q.status! : null;
  const rows = await all<BankRow & { account_name: string; head_name: string | null; bills: string | null }>(db, `
    SELECT r.*, a.name AS account_name, h.name AS head_name,
      (SELECT group_concat(t.bill_no, ', ') FROM bank_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.bank_row_id = r.id) AS bills
    FROM bank_rows r JOIN accounts a ON a.id = r.account_id
    LEFT JOIN transactions bt ON bt.id = r.transaction_id LEFT JOIN heads h ON h.id = bt.head_id
    WHERE r.business_id = ? AND r.day BETWEEN ? AND ? AND (? IS NULL OR r.account_id = ?) AND (? IS NULL OR r.status = ?)
    ORDER BY r.posted_at, r.tran_id LIMIT 3000`, bid, from, to, account, account, status, status);
  const [rules, sug, parties, history, transfers, lkeys] = await Promise.all([loadRules(db, bid), suggestionsFor(db, bid, from, to), loadParties(db, bid), loadHistory(db, bid),
    transferHints(db, bid, rows), loanKeys(db, bid)]);
  const itemHistory = rows.some((r) => r.status === 'unmatched' && r.direction === 'DR') ? await loadItemHistory(db, bid) : [];
  // Not a sale (Stage 5): interest named in the description suggests the interest head, when nothing better is known.
  const interestHead = await one<{ id: string }>(db, "SELECT id FROM heads WHERE business_id = ? AND type = 'income' AND lower(name) = 'interest received'", bid);
  // A Yes Bank UPI collection settlement (25 Nov 2026): direct bookings, so the Room income head is suggested.
  const SETTLEMENT = 'UPI collection settlement';
  // A MakeMyTrip payout (26 Nov 2026): room bookings, paid net of its commission; party MakeMyTrip and Room income.
  const isMmt = (r: { direction: string; description: string }) => r.direction === 'CR' && /MAKEMYTRIP/i.test(r.description);
  const roomHead = rows.some((r) => (r.remark === SETTLEMENT || isMmt(r)) && r.status === 'unmatched')
    ? await one<{ id: string }>(db, "SELECT head_id AS id FROM bill_type_heads WHERE business_id = ? AND bill_type = 'room'", bid) : null;
  // A settlement tells whether a desk UPI bill is waiting from the 3 days before it (26 Nov 2026).
  const settlements = rows.filter((r) => r.remark === SETTLEMENT && r.status === 'unmatched' && r.direction === 'CR');
  const waitingSales = settlements.length ? await all<{ shift_day: string }>(db, `SELECT shift_day FROM transactions WHERE business_id = ? AND type = 'income' AND payment_mode = 'upi'
    AND match_status = 'awaiting_bank_match' AND matched_bank_row IS NULL AND shift_day BETWEEN ? AND ?`, bid, addDays(from, -SETTLEMENT_BACK_DAYS), to) : [];
  const deskOf = (day: string) => ({ from: addDays(day, -SETTLEMENT_BACK_DAYS), to: addDays(day, -1),
    waiting: waitingSales.filter((t) => t.shift_day >= addDays(day, -SETTLEMENT_BACK_DAYS) && t.shift_day <= addDays(day, -1)).length });
  // A transfer whose other side was already booked under a head (26 Nov 2026, ₹101 Icici → Yes Bank booked as GENERAL
  // EXP): the same bank reference (9 digits or more) in both lines, the same amount, the other direction, another own account.
  const refsOf = (d: string) => new Set(d.match(/\d{9,}/g) ?? []);
  const lonely = rows.filter((r) => r.status === 'unmatched' && !transfers.get(r.id) && refsOf(r.description).size);
  const bookedSides = lonely.length ? await all<{ id: string; account_id: string; account_name: string; direction: string; amount_paise: number; description: string; posted_at: number; head_name: string | null }>(db, `
    SELECT r.id, r.account_id, a.name AS account_name, r.direction, r.amount_paise, r.description, r.posted_at, h.name AS head_name
    FROM bank_rows r JOIN accounts a ON a.id = r.account_id LEFT JOIN transactions bt ON bt.id = r.transaction_id LEFT JOIN heads h ON h.id = bt.head_id
    WHERE r.business_id = ? AND r.status = 'booked' AND r.day BETWEEN ? AND ? AND r.amount_paise IN (SELECT value FROM json_each(?))`,
    bid, addDays(from, -3), addDays(to, 3), JSON.stringify([...new Set(lonely.map((r) => r.amount_paise))])) : [];
  const bookedLeg = new Map(lonely.flatMap((r) => {
    const mine = refsOf(r.description);
    const o = bookedSides.find((x) => x.account_id !== r.account_id && x.direction !== r.direction && x.amount_paise === r.amount_paise
      && Math.abs(x.posted_at - r.posted_at) <= 3 * 86400e3 && [...refsOf(x.description)].some((k) => mine.has(k)));
    return o ? [[r.id, { rowId: o.id, accountId: o.account_id, accountName: o.account_name, postedAt: o.posted_at, headName: o.head_name, ref: [...refsOf(o.description)].find((k) => mine.has(k))! }] as const] : [];
  }));
  const looksInterest = (r: { direction: string; description: string }) => r.direction === 'CR' && /\bINT(EREST)?\.?\s*(PD|PAID|CR|CREDIT)\b|\bINTEREST\b/i.test(r.description);
  // A bill cancelled after it was paid (Stage 7, approved 10 Nov 2026): money sent back to the UPI ID that paid a bill,
  // of the same amount, within REFUND_BILL_DAYS. Told on the line with the bill, booked as a refund (an expense head
  // named for refunds when there is one); the bill's match stays, so the sale and its refund both show.
  const outs = rows.filter((r) => r.kind === 'upi_out' && r.direction === 'DR' && r.status === 'unmatched' && r.vpa);
  const paidBy = outs.length ? await all<{ id: string; vpa: string; amount_paise: number; posted_at: number; bills: string }>(db, `
    SELECT c.id, c.vpa, c.amount_paise, c.posted_at, group_concat(t.bill_no, ' + ') AS bills
    FROM bank_rows c JOIN bank_matches m ON m.bank_row_id = c.id JOIN transactions t ON t.id = m.transaction_id
    WHERE c.business_id = ? AND c.kind = 'upi_in' AND c.status = 'matched' AND c.vpa IN (SELECT value FROM json_each(?))
    GROUP BY c.id`, bid, JSON.stringify([...new Set(outs.map((r) => r.vpa))])) : [];
  const refundOf = new Map(outs.map((r) => [r.id, paidBy.filter((c) => c.vpa === r.vpa && c.amount_paise === r.amount_paise && c.posted_at < r.posted_at
    && c.posted_at >= r.posted_at - REFUND_BILL_DAYS * 86400e3).sort((a, b) => b.posted_at - a.posted_at)[0]]).filter(([, c]) => c) as [string, (typeof paidBy)[number]][]);
  const refundHead = refundOf.size ? await one<{ id: string }>(db, `SELECT id FROM heads WHERE business_id = ? AND type = 'expense'
    AND (lower(name) LIKE '%refund%' OR lower(name) LIKE '%sales return%') ORDER BY name LIMIT 1`, bid) : null;
  const plainNote = (v: string | null) => (v && !/^(UPI|UPI Pay|NA|NO REMARKS?|Payment from Ph|Sent using Payt|Paid via SuperM|Paid via CRED|Scan and Pay|Paid securely v|Navi UPI|Paid in seconds)$/i.test(v.trim()) ? v.trim() : '');
  const expenseHeads = rows.some((r) => r.status === 'unmatched' && r.direction === 'DR') ? await all<{ id: string; name: string }>(db, "SELECT id, name FROM heads WHERE business_id = ? AND type = 'expense'", bid) : [];
  return c.json({
    from, to,
    rows: rows.map((r) => {
      const rule = r.status === 'unmatched' && r.kind !== 'upi_in' ? ruleFor(rules, r) : null;
      const pair = r.pair_row_id ? rows.find((x) => x.id === r.pair_row_id) : null;
      return {
        id: r.id, accountId: r.account_id, accountName: r.account_name, tranId: r.tran_id, day: r.day, postedAt: r.posted_at, description: r.description,
        direction: r.direction, amountPaise: r.amount_paise, balancePaise: r.balance_paise, kind: r.kind, upiRef: r.upi_ref, vpa: r.vpa, remark: r.remark,
        pairRowId: r.pair_row_id, pairStatus: pair?.status ?? null, status: r.status, note: r.note, headName: r.head_name, bills: r.bills,
        rule: rule ? { id: rule.id, name: rule.name, headId: rule.head_id, partyId: rule.party_id } : null,
        candidates: r.kind === 'upi_in' && r.status === 'unmatched' ? (sug.candidates.get(r.id) ?? []).slice(0, 5) : [],
        suggest: r.status === 'unmatched' ? (() => {
          // As on cash expense lines: the party known by this UPI ID (or named in the note), and its head for this item.
          const item = plainNote(r.remark);
          const party = (r.vpa ? byName(parties, r.vpa) : null) ?? (item ? inText(parties, item) : null);
          const head = party ? pickHead(party, history, item) : null;
          const rf = refundOf.get(r.id);
          if (rf && !head?.headId && !rule) return { item: `Refund: bill ${rf.bills} cancelled`, party: party?.name ?? null, headId: refundHead?.id ?? null, headChoices: head?.choices ?? [], learned: false };
          // Where the head came from, told on the line (approved 14 Nov 2026): the party, a rule, or the same item booked before.
          const fromItem = !head?.headId && !rule && item && r.direction === 'DR' ? headFromItem(itemHistory, item) : null;
          // A note that runs words together (approved 23 Nov 2026): "hemantsalary" → salary, Hemant, Salaries.
          const read = !party && !rule && r.direction === 'DR' ? readNote(r.remark, expenseHeads) : null;
          const guessHead = head?.headId ?? rule?.head_id ?? fromItem ?? (looksInterest(r) ? interestHead?.id ?? null : null) ?? ((r.remark === SETTLEMENT && r.direction === 'CR') || isMmt(r) ? roomHead?.id ?? null : null);
          if (isMmt(r) && !head?.headId && !rule) return { item: 'MakeMyTrip payout', party: party?.name ?? 'MakeMyTrip', headId: roomHead?.id ?? null, headChoices: [], learned: false, from: null, ruleName: null, fromNote: null };
          return { item: read?.item ?? item, party: party?.name ?? read?.party ?? null, headId: guessHead ?? read?.headId ?? null, headChoices: head?.choices ?? [], learned: !!head?.headId,
            from: head?.headId ? 'party' : rule?.head_id ? 'rule' : fromItem ? 'item' : read?.headId ? 'note' : null, ruleName: rule?.name ?? null,
            fromNote: read ? { item: read.item, party: read.party } : null };
        })() : null,
        clear: sug.clear.has(r.id),
        cashMove: r.status === 'unmatched' ? cashMoveOf(r) : null,
        // Money moved between the business's own accounts (approved 14 Nov 2026).
        transfer: transfers.get(r.id) ?? null,
        // A remembered lender or borrower (24 Nov 2026): suggested, never booked by itself.
        loan: r.status === 'unmatched' && r.kind !== 'card_settlement' ? loanOf(lkeys, r) : null,
        ownTransfer: r.status === 'booked' && /^Transfer (to|from) /.test(r.note ?? ''),
        // Kinds the page names (26 Nov 2026): a Yes Bank settlement (with the desk bills waiting before it), a MakeMyTrip
        // payout; a line with a date only (Yes Bank), so no time is shown; a transfer whose other side is booked.
        known: r.remark === SETTLEMENT && r.direction === 'CR' ? 'settlement' : isMmt(r) ? 'mmt' : null,
        desk: r.remark === SETTLEMENT && r.direction === 'CR' && r.status === 'unmatched' ? deskOf(r.day) : null,
        dateOnly: !/^[A-Z]?\d{3,}$/i.test(r.tran_id) && new Date(r.posted_at + 19800e3).toISOString().slice(11, 23) === '12:00:00.000',
        bookedLeg: bookedLeg.get(r.id) ?? null,
        refundOf: refundOf.has(r.id) ? { creditId: refundOf.get(r.id)!.id, postedAt: refundOf.get(r.id)!.posted_at, billNos: refundOf.get(r.id)!.bills } : null,
      };
    }),
  });
});

// ---- UPI sales of a shift and their credits

bankRoutes.get('/businesses/:businessId/upi', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const shifts = await all<{ day: string }>(db, "SELECT shift_day AS day FROM shifts WHERE business_id = ? AND status = 'confirmed' ORDER BY shift_day DESC LIMIT 60", bid);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(c.req.query('day') ?? '') ? c.req.query('day')! : shifts[0]?.day ?? istDay(Date.now() - 86400e3);
  const sales = await all(db, `
    SELECT t.id, t.bill_no AS billNo, t.amount_paise AS amountPaise, t.match_status AS matchStatus, t.matched_bank_row AS bankRowId,
      sb.paid_at AS paidAt, r.posted_at AS creditAt, a.name AS accountName, r.tran_id AS tranId, rr.id AS registerRowId, rr.upload_id AS uploadId,
      (SELECT min(s.paid_at) FROM card_matches m JOIN card_settlements s ON s.id = m.settlement_id WHERE m.transaction_id = t.id) AS machineAt,
      rr.amount_paise AS billPaise, rr.discount_paise - rr.tip_paise AS discountPaise,
      (SELECT group_concat(DISTINCT p.column_label) FROM register_payments p WHERE p.register_row_id = coalesce(rr.paid_with_row_id, rr.id) AND p.mode = 'upi') AS labels,
      (SELECT count(*) FROM transactions o WHERE o.comparison_id = t.comparison_id AND o.type = 'income' AND o.payment_mode = 'upi') AS parts, t.comparison_id AS comparisonId,
      CASE WHEN rr.paid_with_row_id IS NOT NULL OR EXISTS (SELECT 1 FROM register_rows m WHERE m.paid_with_row_id = rr.id) THEN coalesce(rr.paid_with_row_id, rr.id) END AS groupHead
    FROM transactions t LEFT JOIN bill_comparisons c ON c.id = t.comparison_id LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
    LEFT JOIN register_rows rr ON rr.id = c.register_row_id
    LEFT JOIN bank_rows r ON r.id = t.matched_bank_row LEFT JOIN accounts a ON a.id = r.account_id
    WHERE t.business_id = ? AND t.shift_day = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.source = 'software_report'
      AND t.id NOT IN (SELECT transaction_id FROM closed_bills WHERE business_id = ?)
    ORDER BY coalesce(sb.paid_at, 0), t.bill_no`, bid, day, bid);
  // Credits not matched yet: the shift's own, then up to an hour either side (late or early postings), more on request.
  const w = shiftWindow(day);
  const more = Math.min(Math.max(Number(c.req.query('more') ?? 1) || 1, 1), 48);
  const credits = (await all<{ postedAt: number }>(db, `SELECT r.id, r.tran_id AS tranId, r.posted_at AS postedAt, r.amount_paise AS amountPaise, r.vpa, r.remark, r.kind,
      a.name AS accountName, s.receives_upi_label AS label
    FROM bank_rows r JOIN accounts a ON a.id = r.account_id LEFT JOIN bank_sources s ON s.account_id = r.account_id
    WHERE r.business_id = ? AND r.direction = 'CR' AND r.kind = 'upi_in' AND r.status = 'unmatched' AND r.posted_at >= ? AND r.posted_at < ?
    ORDER BY r.posted_at`, bid, w.from - 3600e3, w.to + more * 3600e3))
    .map((x) => ({ ...x, outside: x.postedAt < w.from || x.postedAt >= w.to }))
    .sort((a, b) => Number(a.outside) - Number(b.outside) || a.postedAt - b.postedAt);
  const repaid = (await repaidFor(db, bid, day)).map((a) => ({ id: a.id, at: a.created_at, ...JSON.parse(a.after) }));
  return c.json({ day, sales, credits, repaid, moreHours: more, confirmedShifts: shifts.map((s) => s.day) });
});

// ---- A UPI or card sale that was in fact paid another way (the register's mode was a slip)

bankRoutes.post('/businesses/:businessId/sales/repay', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const ids = Array.isArray(data.transactionIds) ? data.transactionIds.filter((x): x is string => typeof x === 'string' && isUuid(x)).slice(0, 30) : [];
  if (!ids.length) fail(400, 'Choose the bill.');
  const mode = data.mode === 'cash' || data.mode === 'card' || data.mode === 'upi' ? data.mode : fail(400, 'Choose cash, card or UPI.');
  const note = text(data, 'note', 'Reason', { max: 300 })!;
  // Settled on a later day, with the earlier day's booked shortage made smaller by the bill (18 Nov 2026): Owner or Accountant.
  let shortage: ShortageCut | null = null;
  if (data.reduceShortage === true) {
    if (!can(c.get('role'), 'cash.writeoff')) fail(403, 'Only an Owner or Accountant can change a booked shortage.');
    const tx = await all<{ shift_day: string; amount_paise: number; payment_mode: string }>(db, `SELECT shift_day, amount_paise, payment_mode FROM transactions
      WHERE business_id = ? AND id IN (${ids.map(() => '?').join(',')})`, bid, ...ids);
    const total = tx.reduce((t, x) => t + x.amount_paise, 0);
    const row = tx.length && tx.every((x) => x.payment_mode === 'cash' && x.shift_day === tx[0].shift_day)
      ? await one<Record<string, unknown> & { id: string; amount_paise: number }>(db, `SELECT * FROM transactions WHERE business_id = ? AND source = 'cash_shortage' AND payment_mode = 'cash' AND type = 'expense' AND shift_day = ?
          ORDER BY amount_paise DESC LIMIT 1`, bid, tx[0].shift_day) : null;
    if (!row) fail(409, 'No cash shortage is booked on that day any more.');
    shortage = { row: row!, fromPaise: row!.amount_paise, toPaise: Math.max(0, row!.amount_paise - total) };
  }
  const r = await repayStatements(db, bid, ids, mode, note, c.get('user').id, now(), { shortage });
  const done = await db.batch(r.statements);
  // The audit entry is the last statement; its id is what Undo puts back from.
  return c.json({ ok: true, bills: r.bills, amountPaise: r.amountPaise, auditId: done.at(-1)?.meta.last_row_id ?? null });
});

bankRoutes.post('/businesses/:businessId/sales/repay/:auditId/undo', requireRole('bank.link'), async (c) => {
  const id = Number(c.req.param('auditId'));
  if (!Number.isInteger(id) || id <= 0) fail(404, 'Not found.');
  await c.env.DB.batch(await undoRepayStatements(c.env.DB, c.get('businessId'), id, c.get('user').id, now()));
  return c.json({ ok: true });
});

// ---- Save reconcile (approved 9 Nov 2026): before a shift is saved, a match is a draft kept per shift, made on Save.

// One credit to its bill(s), or several such pairs in one go (multi-pair tray, approved 10 Nov 2026): every pair is
// checked first, then all are saved together, each as its own choice so Undo still works one pair at a time.
bankRoutes.post('/businesses/:businessId/shifts/:day/choices', requireRole('bank.link'), async (c) => {
  const day = c.req.param('day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'Unknown shift.');
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const raw: unknown[] = Array.isArray(data.pairs) ? data.pairs.slice(0, 60) : [data];
  if (!raw.length) fail(400, 'Choose the bank credit.');
  const pairs = raw.map((p) => {
    const x = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const rowId = typeof x.bankRowId === 'string' && isUuid(x.bankRowId) ? x.bankRowId : fail(400, 'Choose the bank credit.');
    const cids = Array.isArray(x.comparisonIds) ? [...new Set(x.comparisonIds.filter((y): y is string => typeof y === 'string' && isUuid(y)))].slice(0, 30) : [];
    if (!cids.length) fail(400, 'Choose the bill.');
    return { rowId, cids };
  });
  if (new Set(pairs.map((p) => p.rowId)).size !== pairs.length) fail(409, 'A credit is in two pairs.');
  const allIds = pairs.flatMap((p) => p.cids);
  if (new Set(allIds).size !== allIds.length) fail(409, 'A bill is in two pairs.');
  const shift = await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', bid, day);
  if (!shift) fail(404, 'Unknown shift.');
  if (shift.status === 'confirmed') fail(409, 'This shift is saved: match it on Reconcile directly.');
  const existing = await shiftChoices(db, bid, day);
  const machineChosen = new Set((await cardShiftChoices(db, bid, day)).flatMap((k) => k.comparisonIds));
  const ids: string[] = [];
  const stmts = [];
  for (const { rowId, cids } of pairs) {
    const row = await one<{ kind: string; direction: string; status: string; amount_paise: number }>(db,
      'SELECT kind, direction, status, amount_paise FROM bank_rows WHERE id = ? AND business_id = ?', rowId, bid);
    if (!row) fail(404, 'Bank line not found.');
    if (row.kind !== 'upi_in' || row.direction !== 'CR' || row.status !== 'unmatched') fail(409, 'Choose an open UPI credit.');
    const found = await all<{ id: string; bill_no: string | null }>(db, `SELECT id, bill_no FROM bill_comparisons WHERE business_id = ? AND shift_day = ? AND id IN (${cids.map(() => '?').join(',')})`, bid, day, ...cids);
    // A card bill of an earlier saved shift settled here (approved 11 Nov 2026), by its sale's id.
    // A UPI bill of an earlier saved shift paid later here (18 Nov 2026), by its sale's id.
    const here = await settledHere(db, bid, day);
    const later = cardHere(here).filter((x) => cids.includes(x.txId) && !found.some((f) => f.id === x.txId));
    const laterUpi = upiHere(here).filter((x) => cids.includes(x.txId) && !found.some((f) => f.id === x.txId));
    found.push(...[...later, ...laterUpi].map((x) => ({ id: x.txId, bill_no: x.billNo })));
    if (found.length !== cids.length) fail(404, 'A bill was not found in this shift.');
    const named = found.map((f) => f.bill_no).filter(Boolean).join(' + ');
    if (existing.some((k) => k.comparisonIds.some((x) => cids.includes(x)))) fail(409, `${named ? `Bill ${named}` : 'A bill'} is already matched on save.`);
    if (existing.some((k) => k.bankRowId === rowId)) fail(409, 'This credit is already matched on save.');
    if (cids.some((x) => machineChosen.has(x))) fail(409, `${named ? `Bill ${named}` : 'A bill'} is already matched on save to the card machine.`);
    const clash = await planClash(db, bid, { bankRowIds: [rowId], comparisonIds: cids }, [], named ? `Bill ${named}` : 'A bill');
    if (clash) fail(409, clash);
    const upi = await plannedUpiPaise(db, bid, day, cids) + laterUpi.reduce((t, x) => t + x.amountPaise, 0);
    if (upi !== row.amount_paise) fail(409, upi ? `The credit is not what ${named ? `bill ${named} takes` : 'these bills take'} by UPI.` : `${named ? `Bill ${named} has` : 'These bills have'} no UPI payment: decide or correct ${named ? 'it' : 'them'} first.`);
    const plan = addPlanStatements(db, bid, day, 'bank_match', { comparisonIds: cids, bankRowIds: [rowId] }, c.get('user').id);
    ids.push(plan.id);
    stmts.push(...plan.statements,
    stmt(db, AUDIT, bid, c.get('user').id, 'shift.choice', rowId, null, JSON.stringify({ shiftDay: day, comparisonIds: cids }), now()));
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isClash(e)) fail(409, 'This credit is already matched on save.');
    throw e;
  }
  return c.json({ ok: true, id: ids[0], ids });
});

// Paid in parts (approved 23 Nov 2026): Match all on a group's two to four credits. Matched when the shift is saved.
bankRoutes.post('/businesses/:businessId/shifts/:day/group-parts', requireRole('bank.link'), async (c) => {
  const day = c.req.param('day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'Unknown shift.');
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const headId = typeof data.headId === 'string' && isUuid(data.headId) ? data.headId : fail(400, 'Choose the bills.');
  const creditIds = Array.isArray(data.creditIds) ? data.creditIds.filter((x): x is string => typeof x === 'string' && isUuid(x)) : [];
  const view = await shiftView(db, bid, day);
  if (view.status === 'confirmed') fail(409, 'This shift is saved: match it on Reconcile directly.');
  const g = view.paidGroups.find((x) => x.id === headId);
  const parts = g?.bank && 'parts' in g.bank ? g.bank.parts : undefined;
  if (!g || !parts || parts.length !== creditIds.length || !parts.every((p) => creditIds.includes(p.creditId))) fail(409, 'These credits no longer add up to these bills: reload.');
  if (g!.bank && 'accepted' in g!.bank && g!.bank.accepted) return c.json({ ok: true, unchanged: true, planId: g!.bank.acceptId, auditId: g!.bank.acceptId });
  const old = (await shiftPlans(db, bid, day, ['group_parts'])).filter((p) => p.headRowId === headId).map((p) => p.id);
  const clash = await planClash(db, bid, { bankRowIds: creditIds }, old, `Bills ${g!.billNos.join(' + ')}`);
  if (clash) fail(409, clash);
  const plan = addPlanStatements(db, bid, day, 'group_parts', { headRowId: headId, bankRowIds: creditIds }, c.get('user').id);
  try {
    await db.batch([...dropPlanStatements(db, old), ...plan.statements, stmt(db, LOG, bid, c.get('user').id, 'bank.group_parts', 'register_rows', headId, null,
      JSON.stringify({ shiftDay: day, billNos: g!.billNos, creditIds, amounts: parts!.map((p) => p.amountPaise), planId: plan.id }), now())]);
  } catch (e) {
    if (isClash(e)) fail(409, 'One of these credits is already chosen on save.');
    throw e;
  }
  return c.json({ ok: true, planId: plan.id, auditId: plan.id });
});

/** Undo a plan of a shift not saved yet: Match all on a group paid in parts, or credits ticked for a bill paid in parts. */
async function undoPartsPlan(c: Context<AppEnv>, kind: 'group_parts' | 'bill_parts') {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('planId');
  if (!isPlanId(id)) fail(404, 'Not found.');
  const plan = await planById(db, bid, id!);
  if (!plan || plan.kind !== kind) return c.json({ ok: true, unchanged: true });
  const s = await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', bid, plan.day);
  if (s?.status === 'confirmed') fail(409, 'This shift is saved: unmatch the credits on Reconcile.');
  await db.batch([...dropPlanStatements(db, [plan.id]), stmt(db, LOG, bid, c.get('user').id, `bank.${kind}_undone`, 'shift_plans', plan.id, null,
    JSON.stringify({ shiftDay: plan.day, comparisonIds: plan.comparisonIds, headRowId: plan.headRowId, creditIds: plan.bankRowIds }), now())]);
  return c.json({ ok: true });
}

bankRoutes.post('/businesses/:businessId/group-parts/:planId/undo', requireRole('bank.link'), (c) => undoPartsPlan(c, 'group_parts'));

// A bill paid in several goes, its credits ticked by a person (25 Nov 2026): kept in the audit log and used when the
// shift is saved, whatever the time between the credits and the bill. Each credit must equal one UPI payment written
// on the bill's register row.
bankRoutes.post('/businesses/:businessId/shifts/:day/bill-parts', requireRole('bank.link'), async (c) => {
  const day = c.req.param('day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'Unknown shift.');
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const cmpId = typeof data.comparisonId === 'string' && isUuid(data.comparisonId) ? data.comparisonId : fail(400, 'Choose the bill.');
  const creditIds = Array.isArray(data.creditIds) ? [...new Set(data.creditIds.filter((x): x is string => typeof x === 'string' && isUuid(x)))] : [];
  if (creditIds.length < 2 || creditIds.length > 6) fail(400, 'Choose two to six credits.');
  const shift = await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', bid, day);
  if (!shift) fail(404, 'Unknown shift.');
  if (shift!.status === 'confirmed') fail(409, 'This shift is saved: match it on Reconcile directly.');
  const cmp = await one<{ id: string; bill_no: string | null; register_row_id: string | null }>(db,
    'SELECT id, bill_no, register_row_id FROM bill_comparisons WHERE id = ? AND business_id = ? AND shift_day = ?', cmpId, bid, day);
  if (!cmp) fail(404, 'A bill was not found in this shift.');
  const named = cmp!.bill_no ? `Bill ${cmp!.bill_no}` : 'This bill';
  if (!cmp!.register_row_id) fail(409, `${named} has no register row to hold its payments.`);
  const row = await one<{ paid_with_row_id: string | null }>(db, 'SELECT paid_with_row_id FROM register_rows WHERE id = ? AND business_id = ?', cmp!.register_row_id, bid);
  if (!row || row.paid_with_row_id) fail(409, `${named} is paid together with another row.`);
  const upi = (await all<{ amount_paise: number }>(db, "SELECT amount_paise FROM register_payments WHERE register_row_id = ? AND mode = 'upi'", cmp!.register_row_id)).map((p) => p.amount_paise);
  const credits = await all<{ id: string; kind: string; direction: string; status: string; amount_paise: number }>(db,
    `SELECT id, kind, direction, status, amount_paise FROM bank_rows WHERE business_id = ? AND id IN (${creditIds.map(() => '?').join(',')})`, bid, ...creditIds);
  if (credits.length !== creditIds.length) fail(404, 'Bank line not found.');
  if (credits.some((r) => r.kind !== 'upi_in' || r.direction !== 'CR' || r.status !== 'unmatched')) fail(409, 'Choose open UPI credits.');
  const key = (xs: number[]) => [...xs].sort((a, b) => a - b).join(',');
  if (key(upi) !== key(credits.map((r) => r.amount_paise))) fail(409, `${named}'s register row does not have one UPI payment for each credit: write them on its row first.`);
  const old = (await shiftPlans(db, bid, day, ['bill_parts'])).filter((p) => p.comparisonIds[0] === cmpId);
  const ids = (xs: string[]) => [...xs].sort().join(',');
  if (old.length === 1 && ids(old[0].bankRowIds) === ids(creditIds)) return c.json({ ok: true, planId: old[0].id, auditId: old[0].id, unchanged: true });
  const clash = await planClash(db, bid, { bankRowIds: creditIds, comparisonIds: [cmpId] }, old.map((p) => p.id), named);
  if (clash) fail(409, clash);
  const user = c.get('user').id;
  const plan = addPlanStatements(db, bid, day, 'bill_parts', { comparisonIds: [cmpId], bankRowIds: creditIds }, user);
  try {
    await db.batch([...dropPlanStatements(db, old.map((p) => p.id)), ...plan.statements, stmt(db, LOG, bid, user, 'bank.bill_parts', 'bill_comparisons', cmpId, null,
      JSON.stringify({ shiftDay: day, billNo: cmp!.bill_no, creditIds, amounts: credits.map((x) => x.amount_paise), planId: plan.id }), now())]);
  } catch (e) {
    if (isClash(e)) fail(409, 'One of these credits is already chosen on save.');
    throw e;
  }
  return c.json({ ok: true, planId: plan.id, auditId: plan.id });
});

bankRoutes.post('/businesses/:businessId/bill-parts/:planId/undo', requireRole('bank.link'), (c) => undoPartsPlan(c, 'bill_parts'));

// A card machine payment matched to its bill(s) before saving (approved 10 Nov 2026), made on Save like a UPI match.
bankRoutes.post('/businesses/:businessId/shifts/:day/card-choices', requireRole('bank.link'), async (c) => {
  const day = c.req.param('day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'Unknown shift.');
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  // One payment to its bill(s), or several pairs at once (card tray, approved 10 Nov 2026): all checked, then all saved.
  const raw: unknown[] = Array.isArray(data.pairs) ? data.pairs.slice(0, 60) : [data];
  if (!raw.length) fail(400, 'Choose the card payment.');
  const pairs = raw.map((x0) => {
    const x = (x0 && typeof x0 === 'object' ? x0 : {}) as Record<string, unknown>;
    const pid = typeof x.paymentId === 'string' && isUuid(x.paymentId) ? x.paymentId : fail(400, 'Choose the card payment.');
    const cids = Array.isArray(x.comparisonIds) ? [...new Set(x.comparisonIds.filter((y): y is string => typeof y === 'string' && isUuid(y)))].slice(0, 30) : [];
    if (!cids.length) fail(400, 'Choose the bill.');
    return { pid, cids };
  });
  if (new Set(pairs.map((p) => p.pid)).size !== pairs.length) fail(409, 'A card payment is in two pairs.');
  const allIds = pairs.flatMap((p) => p.cids);
  if (new Set(allIds).size !== allIds.length) fail(409, 'A bill is in two pairs.');
  const shift = await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', bid, day);
  if (!shift) fail(404, 'Unknown shift.');
  if (shift.status === 'confirmed') fail(409, 'This shift is saved: match it on Reconcile directly.');
  const existing = await cardShiftChoices(db, bid, day);
  // A bill matched on save to a bank credit is not matched to the machine too.
  const bankChosen = new Set((await shiftChoices(db, bid, day)).flatMap((k) => k.comparisonIds));
  const ids: string[] = [];
  const stmts = [];
  for (const { pid, cids } of pairs) {
    const p = await one<{ txn_type: string; amount_paise: number; pay_mode: string | null; scheme: string | null; matched: number }>(db,
      `SELECT txn_type, amount_paise, pay_mode, scheme, EXISTS (SELECT 1 FROM card_matches m WHERE m.settlement_id = s.id) AS matched
      FROM card_settlements s WHERE id = ? AND business_id = ?`, pid, bid);
    if (!p) fail(404, 'Card payment not found.');
    if (p.txn_type !== 'PURCHASE') fail(409, 'Only a sale on the machine pays a bill.');
    if (p.matched) fail(409, 'This card payment is already matched.');
    const found = await all<{ id: string; bill_no: string | null }>(db, `SELECT id, bill_no FROM bill_comparisons WHERE business_id = ? AND shift_day = ? AND id IN (${cids.map(() => '?').join(',')})`, bid, day, ...cids);
    // A card bill of an earlier saved shift settled here (approved 11 Nov 2026), by its sale's id.
    const later = cardHere(await settledHere(db, bid, day)).filter((x) => cids.includes(x.txId) && !found.some((f) => f.id === x.txId));
    found.push(...later.map((x) => ({ id: x.txId, bill_no: x.billNo })));
    if (found.length !== cids.length) fail(404, 'A bill was not found in this shift.');
    const named = found.map((f) => f.bill_no).filter(Boolean).join(' + ');
    if (existing.some((k) => k.comparisonIds.some((x) => cids.includes(x)))) fail(409, `${named ? `Bill ${named}` : 'A bill'} is already matched on save.`);
    if (existing.some((k) => k.paymentId === pid)) fail(409, 'This card payment is already matched on save.');
    if (cids.some((x) => bankChosen.has(x))) fail(409, `${named ? `Bill ${named}` : 'A bill'} is already matched on save to a bank credit.`);
    const card = await plannedCardPaise(db, bid, day, cids) + later.reduce((t, x) => t + x.amountPaise, 0);
    // UPI on the machine (approved 11 Nov 2026) pays a card bill like a swipe, or a UPI bill, matched to the machine on save.
    const upi = isMachineUpi(p) && card !== p.amount_paise ? await plannedUpiPaise(db, bid, day, cids) : 0;
    if (card !== p.amount_paise && upi !== p.amount_paise) fail(409, card || upi ? `The payment is not what ${named ? `bill ${named} takes` : 'these bills take'} by ${isMachineUpi(p) ? 'card or UPI' : 'card'}.` : `${named ? `Bill ${named} has` : 'These bills have'} no ${isMachineUpi(p) ? 'card or UPI' : 'card'} payment: decide or correct ${named ? 'it' : 'them'} first.`);
    const clash = await planClash(db, bid, { cardPaymentIds: [pid], comparisonIds: cids }, [], named ? `Bill ${named}` : 'A bill');
    if (clash) fail(409, clash);
    const plan = addPlanStatements(db, bid, day, 'card_match', { comparisonIds: cids, cardPaymentIds: [pid] }, c.get('user').id);
    ids.push(plan.id);
    stmts.push(...plan.statements,
    stmt(db, AUDIT, bid, c.get('user').id, 'shift.choice', pid, null, JSON.stringify({ shiftDay: day, comparisonIds: cids, card: true }), now()));
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    if (isClash(e)) fail(409, 'This card payment is already matched on save.');
    throw e;
  }
  return c.json({ ok: true, id: ids[0], ids });
});

bankRoutes.delete('/businesses/:businessId/shifts/:day/choices/:id', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('id');
  if (!isPlanId(id)) fail(404, 'Not found.');
  const k = await planById(db, bid, id!);
  if (!k || k.day !== c.req.param('day') || (k.kind !== 'bank_match' && k.kind !== 'card_match')) fail(404, 'Not found, or already saved.');
  await db.batch([
    ...dropPlanStatements(db, [k!.id]),
    stmt(db, AUDIT, bid, c.get('user').id, 'shift.choice_undone', k!.bankRowIds[0] ?? k!.cardPaymentIds[0],
      JSON.stringify({ shiftDay: k!.day, comparisonIds: k!.comparisonIds, ...(k!.kind === 'card_match' ? { card: true } : {}) }), null, now()),
  ]);
  return c.json({ ok: true });
});

/** Reconcile's Cash, UPI and Card tabs: every bill of the shift under its mode, with its evidence and its changes. */
bankRoutes.get('/businesses/:businessId/shifts/:day/entries', requireRole('bank.link'), async (c) => {
  const day = c.req.param('day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'Unknown shift.');
  return c.json(await shiftEntries(c.env.DB, c.get('businessId'), day));
});

/**
 * The tray's "shifts either side" (approved 10 Nov 2026): credits and card payments of the shift before and after that are
 * still open there (not paired, chosen or matched), so a bill here can take a credit that landed after 8 am, or a
 * late-night payment counted on the next shift. Asked for only when a person ticks it on, so Reconcile stays quick.
 */
bankRoutes.get('/businesses/:businessId/shifts/:day/nearby', requireRole('bank.link'), async (c) => {
  const day = c.req.param('day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'Unknown shift.');
  const db = c.env.DB;
  const bid = c.get('businessId');
  // The shift before and the shift after are read at the same time.
  const sides = await Promise.all([addDays(day, -1), addDays(day, 1)].map(async (adj) => {
    const credits: unknown[] = [];
    const payments: unknown[] = [];
    const status = (await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', bid, adj))?.status;
    const w = shiftWindow(adj);
    if (status && status !== 'confirmed') {
      const [r, k] = await Promise.all([trialReconcile(db, bid, adj), trialCards(db, bid, adj)]);
      credits.push(...r.open.credits.map((x) => ({ ...x, shiftDay: adj })));
      payments.push(...k.open.payments.map((x) => ({ ...x, shiftDay: adj })));
      return { credits, payments };
    }
    // A saved shift (or none): whatever is still open in its hours.
    const [cr, pays] = await Promise.all([
      all<{ id: string; amountPaise: number; postedAt: number; accountName: string | null; remark: string | null; label: string | null }>(db, `SELECT r.id, r.amount_paise AS amountPaise, r.posted_at AS postedAt,
        a.name AS accountName, r.remark, s.receives_upi_label AS label FROM bank_rows r LEFT JOIN accounts a ON a.id = r.account_id LEFT JOIN bank_sources s ON s.account_id = r.account_id
        WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.status = 'unmatched' AND r.posted_at >= ? AND r.posted_at < ?
          AND NOT ${heldCredit('r.id')} ORDER BY r.posted_at`, bid, w.from, w.to),
      all<{ id: string; paid_at: number; amount_paise: number; txn_type: string; terminal_id: string; pay_mode: string | null; scheme: string | null; card_type: string | null; card_last4: string | null }>(db,
        `SELECT s.id, s.paid_at, s.amount_paise, s.txn_type, s.terminal_id, s.pay_mode, s.scheme, s.card_type, s.card_last4 FROM card_settlements s
        WHERE s.business_id = ? AND s.txn_type = 'PURCHASE' AND s.paid_at >= ? AND s.paid_at < ?
          AND NOT EXISTS (SELECT 1 FROM card_matches m WHERE m.settlement_id = s.id) AND NOT ${heldPayment('s.id')} ORDER BY s.paid_at`, bid, w.from, w.to),
    ]);
    credits.push(...cr.map((x) => ({ ...x, shiftDay: adj })));
    payments.push(...pays.filter((p) => !isMachineUpi(p)).map((p) => ({ id: p.id, paidAt: p.paid_at, amountPaise: p.amount_paise, txnType: p.txn_type, terminalId: p.terminal_id, upi: false,
      label: machineLabel(p), shiftDay: adj })));
    return { credits, payments };
  }));
  return c.json({ credits: sides.flatMap((x) => x.credits), payments: sides.flatMap((x) => x.payments) });
});

bankRoutes.get('/businesses/:businessId/shifts/:day/reconcile', requireRole('bank.link'), async (c) => {
  const day = c.req.param('day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'Unknown shift.');
  const db = c.env.DB;
  const bid = c.get('businessId');
  const [shifts, st] = await Promise.all([
    all<{ day: string; status: string }>(db, 'SELECT shift_day AS day, status FROM shifts WHERE business_id = ? ORDER BY shift_day DESC LIMIT 60', bid),
    one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', bid, day),
  ]);
  const status = st?.status;
  // The parts that do not depend on the UPI picture are started now and run beside it (fewer trips to the database).
  const quiet = <T>(p: Promise<T>) => { p.catch(() => {}); return p; };
  const trialCardsP = status === 'confirmed' ? null : quiet(trialCards(db, bid, day));
  const cashOverP = status === 'confirmed' ? quiet(cashOver(db, bid, day)) : null;
  const byUpiP = status === 'confirmed' ? null : quiet(paidByUpi(db, bid, day));
  const hereP = quiet(settledHere(db, bid, day));
  const [r, hints] = await Promise.all([status === 'confirmed' ? reconcileShift(db, bid, day) : trialReconcile(db, bid, day), columnHints(db, bid, day)]);
  // Credits nothing pairs that a register slip on a nearby bill explains (a column hint explains its own credit). Every
  // leftover credit is tried, not only those with no bill of their amount: a ₹32 credit is left over when two ₹32 bills
  // exist and neither is its own.
  const hinted = new Set(hints.map((h) => h.creditId));
  let leftIds: string[];
  if ('left' in r) leftIds = r.left;
  else {
    const carded = new Set(r.fixes.flatMap((k) => k.uses).filter((u) => u.startsWith('cr:')).map((u) => u.slice(3)));
    leftIds = r.open.credits.map((x) => x.id).filter((id) => !carded.has(id));
  }
  const slipsP = shiftSlips(db, bid, day, leftIds.filter((id) => !hinted.has(id)));
  // The card picture (approved 8 Nov 2026), for a confirmed shift: its card sales are made on confirm.
  // Credits the UPI side already offers to a bill are not offered to a card bill as well.
  const offered = 'clear' in r ? new Set([...r.clear, ...r.likely].map((x) => x.creditId)) : new Set<string>();
  // Before saving, the trial card picture (approved 10 Nov 2026): what Save would match, and what needs a person.
  const [slips, cards] = await Promise.all([slipsP, status === 'confirmed' ? cashOverP!.then((over) => shiftCards(db, bid, day, over, offered)) : trialCardsP!]);
  // What the card side explains is told there, and counted once (approved 9 Nov 2026).
  let cardCredits = 0;
  if (cards && !('trial' in cards) && 'left' in r) {
    const w = shiftWindow(day);
    const cr = new Set(cards.explains.credits.filter((x) => x.postedAt >= w.from && x.postedAt < w.to).map((x) => x.id));
    const bl = new Set(cards.explains.bills.filter((x) => x.shiftDay === day).map((x) => x.id));
    // Summed in chunks (D1 takes at most 100 values a query), all chunks at once.
    const sumOf = async (table: string, ids: string[]) => {
      const parts = [];
      for (let i = 0; i < ids.length; i += 90) parts.push(ids.slice(i, i + 90));
      const rows = await Promise.all(parts.map((p) => one<{ a: number | null }>(db, `SELECT sum(amount_paise) AS a FROM ${table} WHERE id IN (${p.map(() => '?').join(',')})`, ...p)));
      return rows.reduce((t, x) => t + (x?.a ?? 0), 0);
    };
    const [crPaise, blPaise] = await Promise.all([sumOf('bank_rows', [...cr]), sumOf('transactions', [...bl])]);
    cardCredits = crPaise;
    r.strip.creditsLeft -= cr.size; r.strip.creditsLeftPaise -= crPaise;
    r.strip.billsLeft -= bl.size; r.strip.billsLeftPaise -= blPaise;
    r.noBill = r.noBill.filter((x) => !cr.has(x.creditId));
    r.strip.creditsNoBill = r.noBill.length;
  }
  // Card or cash bills one UPI credit paid instead (approved 11 Nov 2026), before saving.
  const byUpi = byUpiP ? await byUpiP : [];
  // Bills of an earlier saved shift settled here, counted there in another mode (approved 11 Nov 2026).
  const here = await hereP;
  // With the payment that fits and the earlier day's cash short and booked shortage (18 Nov 2026), so the person sees
  // what the change does to that day.
  const fromChecks = new Map<string, Awaited<ReturnType<typeof cashCheck>>>();
  const paidLater = await Promise.all(paidOtherwise(here).map(async (x) => {
    if (!fromChecks.has(x.fromDay)) fromChecks.set(x.fromDay, await cashCheck(db, bid, x.fromDay));
    const k = fromChecks.get(x.fromDay)!;
    const ln = x.rowId ? await one<{ line_no: number | null }>(db, 'SELECT line_no FROM register_rows WHERE id = ?', x.rowId) : null;
    const evidence = x.rowMode === 'card' || x.rowMode === 'upi'
      ? await evidenceFor(db, bid, { mode: x.rowMode, day, amountPaise: x.amountPaise, uploadId: x.uploadId, rowId: x.rowId }, ln?.line_no ?? null) : null;
    return { ...x, evidence, fromCash: { differencePaise: k.settled ? 0 : k.differencePaise, shortagePaise: k.shortagePaise } };
  }));
  // Changed already (the earlier sale now has the line's mode): told with its Undo until its money is matched.
  const changed = here.filter((x) => x.txMode === x.rowMode && x.open);
  const audits = changed.length ? await all<{ id: number; after: string }>(db, `SELECT a.id, a.after FROM audit_log a WHERE a.business_id = ? AND a.action = 'sale.repaid'
    AND json_extract(a.after, '$.settledLater') = 1 AND NOT EXISTS (SELECT 1 FROM audit_log u WHERE u.business_id = a.business_id AND u.action = 'sale.repay_undone' AND u.row_id = CAST(a.id AS TEXT))
    ORDER BY a.id DESC`, bid) : [];
  const paidLaterDone = changed.flatMap((x) => {
    const a = audits.find((y) => (JSON.parse(y.after) as { transactionIds: string[] }).transactionIds.includes(x.txId));
    return a ? [{ ...x, auditId: a.id, from: (JSON.parse(a.after) as { from: string }).from }] : [];
  });
  // The next shift, when not saved yet, may hold the bill of money received here (an advance at check-in, billed at
  // check-out): told before a credit is booked with no bill (approved 11 Nov 2026).
  const next = addDays(day, 1);
  const nextShift = { day: next, saved: shifts.some((x) => x.day === next && x.status === 'confirmed') };
  const upiBook = await upiBankVsBookr(db, bid, day, r.strip, cardCredits);
  return c.json({ ...r, confirmed: status === 'confirmed', shifts, columnHints: hints, slips, cards, byUpi, paidLater, paidLaterDone, nextShift, upiBook });
});

// The shift's statement (approved 21 Nov 2026): every bank line of the 8 am to 8 am window, all accounts and kinds, with
// what a saved match or booking says. A day either side comes too, for finding an amount. The draft's uses (matches made
// on save) are laid over it on the page from the Reconcile answer.
bankRoutes.get('/businesses/:businessId/shifts/:day/statement', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const day = c.req.param('day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'Day must be YYYY-MM-DD.');
  const w = shiftWindow(day);
  const DAY = 24 * 3600e3;
  const [accounts, rows] = await Promise.all([
    all<{ id: string; name: string }>(db, "SELECT id, name FROM accounts WHERE business_id = ? AND kind = 'bank' ORDER BY name", bid),
    all<{ id: string; accountId: string; accountName: string; postedAt: number; amountPaise: number; direction: string; kind: string; status: string;
      vpa: string | null; remark: string | null; description: string; note: string | null; headName: string | null; bills: string | null }>(db, `
      SELECT r.id, r.account_id AS accountId, a.name AS accountName, r.posted_at AS postedAt, r.amount_paise AS amountPaise, r.direction, r.kind, r.status,
        r.vpa, r.remark, r.description, r.note, h.name AS headName,
        (SELECT group_concat(t.bill_no, ' + ') FROM bank_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.bank_row_id = r.id) AS bills
      FROM bank_rows r JOIN accounts a ON a.id = r.account_id LEFT JOIN transactions bt ON bt.id = r.transaction_id LEFT JOIN heads h ON h.id = bt.head_id
      WHERE r.business_id = ? AND r.posted_at >= ? AND r.posted_at < ? ORDER BY r.posted_at, r.tran_id LIMIT 3000`, bid, w.from - DAY, w.to + DAY),
  ]);
  return c.json({ day, from: w.from, to: w.to, accounts,
    rows: rows.map((r) => ({ ...r, description: r.description.slice(0, 80), inShift: r.postedAt >= w.from && r.postedAt < w.to, shiftDay: shiftDayOf(r.postedAt) })) });
});

bankRoutes.get('/businesses/:businessId/unmatched', requireRole('bank.link'), async (c) => c.json(await unmatchedEntries(c.env.DB, c.get('businessId'))));

/** Counted twice (20 Nov 2026): the half of a payment written in two columns that never comes is removed, with a reason. */
bankRoutes.post('/businesses/:businessId/sales/:txId/counted-twice', requireRole('sales.decide'), async (c) => {
  const id = c.req.param('txId');
  if (!isUuid(id)) fail(404, 'Not found.');
  const note = text(await body(c), 'note', 'Reason', { max: 300 })!;
  return c.json(await removeTwice(c.env.DB, c.get('businessId'), id, note, c.get('user').id));
});
bankRoutes.post('/businesses/:businessId/counted-twice/:auditId/undo', requireRole('sales.decide'), async (c) => {
  const id = Number(c.req.param('auditId'));
  if (!Number.isInteger(id) || id <= 0) fail(404, 'Not found.');
  return c.json(await undoTwice(c.env.DB, c.get('businessId'), id, c.get('user').id));
});

/** Closes a bill whose credit will never come, after the watch and with a reason. The sale stays in income. Owner or Accountant. */
bankRoutes.post('/businesses/:businessId/sales/:txId/close', requireRole('sales.decide'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('txId');
  if (!isUuid(id)) fail(404, 'Not found.');
  const note = text(await body(c), 'note', 'Reason', { max: 300 })!;
  const tx = await one<{ shift_day: string; match_status: string | null; matched_bank_row: string | null; payment_mode: string }>(db,
    "SELECT shift_day, match_status, matched_bank_row, payment_mode FROM transactions WHERE id = ? AND business_id = ? AND type = 'income'", id, bid);
  if (!tx) fail(404, 'Not found.');
  if (tx.payment_mode !== 'upi' || tx.matched_bank_row || tx.match_status !== 'awaiting_bank_match') fail(409, 'Only a UPI bill still waiting for its credit can be closed.');
  const days = Math.round((Date.parse(istDay(Date.now())) - Date.parse(tx.shift_day)) / 86400000);
  // Owed by a guest or company (Stage 5): known now, so it need not wait out the watch.
  if (days <= WATCH_DAYS && !note.startsWith(OWED_PREFIX)) fail(400, `This bill is watched for ${WATCH_DAYS} days; it can be closed after that.`);
  const t = now();
  const user = c.get('user').id;
  await db.batch([
    stmt(db, "UPDATE transactions SET match_status = NULL WHERE id = ? AND match_status = 'awaiting_bank_match'", id),
    stmt(db, 'INSERT INTO closed_bills (transaction_id, business_id, note, closed_by, closed_at) VALUES (?, ?, ?, ?, ?)', id, bid, note, user, t),
    stmt(db, TX_AUDIT, ...audit(bid, user, 'sale.closed', id, { matchStatus: 'awaiting_bank_match' }, { note }, t)),
  ]);
  return c.json({ ok: true });
});

/** A credit booked directly and a bill that came later are one sale. A person says so. */
bankRoutes.post('/businesses/:businessId/sales/:txId/same-sale', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const rowId = (await body(c)).rowId;
  if (typeof rowId !== 'string' || !isUuid(rowId)) fail(400, 'Choose the credit.');
  const [row, booked, bill] = await Promise.all([getRow(db, bid, rowId), bookedTx(db, bid, rowId),
    one<{ id: string; day: string; status: string; ocr_original: string | null; head_id: string | null; amount_paise: number; payment_mode: string; match_status: string | null; matched_bank_row: string | null }>(db,
      "SELECT id, day, status, ocr_original, head_id, amount_paise, payment_mode, match_status, matched_bank_row FROM transactions WHERE id = ? AND business_id = ? AND type = 'income'", c.req.param('txId'), bid)]);
  if (!row || !bill) fail(404, 'Not found.');
  if (!booked) fail(409, 'This credit is no longer booked as a sale.');
  if (bill.payment_mode !== 'upi' || bill.match_status !== 'awaiting_bank_match' || bill.matched_bank_row) fail(409, 'This bill is not waiting for a credit.');
  if (bill.amount_paise !== row.amount_paise) fail(400, 'The bill and the credit are not the same amount.');
  await db.batch(sameSaleStatements(db, bid, row, booked, { id: bill.id, day: bill.day, status: bill.status, ocr_original: bill.ocr_original, head_id: bill.head_id }, c.get('user').id, now()));
  return c.json({ ok: true });
});

/** Before confirming there is no sale to join yet: the wish is recorded, and the confirm does it. */
bankRoutes.post('/businesses/:businessId/comparisons/:id/same-sale', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const rowId = (await body(c)).rowId;
  if (typeof rowId !== 'string' || !isUuid(rowId)) fail(400, 'Choose the credit.');
  const cmp = await one<{ id: string; shift_day: string }>(db, 'SELECT id, shift_day FROM bill_comparisons WHERE id = ? AND business_id = ?', c.req.param('id'), bid);
  if (!cmp) fail(404, 'Not found.');
  if ((await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', bid, cmp.shift_day))?.status === 'confirmed') fail(409, 'This shift is already confirmed.');
  if (!(await bookedTx(db, bid, rowId))) fail(409, 'This credit is no longer booked as a sale.');
  const clash = await planClash(db, bid, { bankRowIds: [rowId], comparisonIds: [cmp!.id] }, [], 'This bill');
  if (clash) fail(409, clash);
  const plan = addPlanStatements(db, bid, cmp!.shift_day, 'same_sale', { comparisonIds: [cmp!.id], bankRowIds: [rowId] }, c.get('user').id);
  try {
    await db.batch([...plan.statements, stmt(db, AUDIT, ...audit(bid, c.get('user').id, 'bank.same_sale_planned', rowId, null, { comparisonId: cmp!.id, shiftDay: cmp!.shift_day, planId: plan.id }, now()))]);
  } catch (e) {
    if (isClash(e)) fail(409, 'This credit is already chosen on save.');
    throw e;
  }
  return c.json({ ok: true, planId: plan.id });
});

bankRoutes.delete('/businesses/:businessId/comparisons/:id/same-sale', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const rowId = (await body(c)).rowId;
  if (typeof rowId !== 'string' || !isUuid(rowId)) fail(400, 'Choose the credit.');
  const bid = c.get('businessId');
  const plans = (await all<{ id: string }>(db, `SELECT p.id FROM shift_plans p JOIN shift_plan_items i ON i.plan_id = p.id
    WHERE p.business_id = ? AND p.kind = 'same_sale' AND i.bank_row_id = ?`, bid, rowId)).map((x) => x.id);
  await db.batch([...dropPlanStatements(db, plans), stmt(db, AUDIT, ...audit(bid, c.get('user').id, 'bank.same_sale_unplanned', rowId, null, { comparisonId: c.req.param('id') }, now()))]);
  return c.json({ ok: true });
});

bankRoutes.post('/businesses/:businessId/sales/:txId/reopen', requireRole('sales.decide'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('txId');
  if (!isUuid(id)) fail(404, 'Not found.');
  const closed = await one<{ note: string }>(db, 'SELECT note FROM closed_bills WHERE transaction_id = ? AND business_id = ?', id, bid);
  if (!closed) fail(404, 'This bill is not closed.');
  const t = now();
  const user = c.get('user').id;
  await db.batch([
    stmt(db, "UPDATE transactions SET match_status = 'awaiting_bank_match' WHERE id = ? AND matched_bank_row IS NULL", id),
    stmt(db, 'DELETE FROM closed_bills WHERE transaction_id = ?', id),
    stmt(db, TX_AUDIT, ...audit(bid, user, 'sale.reopened', id, { note: closed.note }, { matchStatus: 'awaiting_bank_match' }, t)),
  ]);
  return c.json({ ok: true });
});

/**
 * UPI shortage (approved 26 Nov 2026): a saved UPI sale whose money never came. An Owner or Accountant books it as an
 * expense under "UPI shortage" (on no account: a UPI sale sits on none until matched), with a reason; the sale stops
 * waiting. Kept like a cash shortage (source cash_shortage) but with payment mode UPI, so no cash check counts it. Undo takes the expense off and the bill waits again. Only a bill counted as a sale can be booked this way.
 */
export const UPI_SHORTAGE_HEAD = { name: 'UPI shortage', tally: 'UPI Shortage' };
const UPI_SHORT_NOTE = 'UPI shortage booked';
bankRoutes.post('/businesses/:businessId/upi-shortage', requireRole('cash.writeoff'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const note = text(data, 'note', 'Reason', { max: 300 })!;
  const txId = typeof data.txId === 'string' && isUuid(data.txId) ? data.txId : null;
  const cmpId = typeof data.comparisonId === 'string' && isUuid(data.comparisonId) ? data.comparisonId : null;
  if (!txId && !cmpId) fail(400, 'Choose the bill.');
  const sale = await one<{ id: string; shift_day: string; amount_paise: number; bill_no: string | null; comparison_id: string | null; status: string }>(db, `
    SELECT t.id, t.shift_day, t.amount_paise, t.bill_no, t.comparison_id, s.status FROM transactions t JOIN shifts s ON s.business_id = t.business_id AND s.shift_day = t.shift_day
    WHERE t.business_id = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.match_status = 'awaiting_bank_match' AND t.matched_bank_row IS NULL
      AND (t.id = ? OR t.comparison_id = ?) AND t.id NOT IN (SELECT transaction_id FROM closed_bills WHERE business_id = ?) LIMIT 1`, bid, txId, cmpId, bid);
  if (!sale) fail(409, 'Only a UPI bill counted as a sale and still waiting for its money can be booked as a shortage.');
  if (sale!.status !== 'confirmed') fail(409, 'Save the shift first.');
  const t = now();
  const user = c.get('user').id;
  const statements: D1PreparedStatement[] = [];
  let head = await one<{ id: string }>(db, "SELECT id FROM heads WHERE business_id = ? AND type = 'expense' AND lower(name) = lower(?)", bid, UPI_SHORTAGE_HEAD.name);
  if (!head) {
    head = { id: newId() };
    statements.push(stmt(db, "INSERT INTO heads (id, business_id, name, type, tally_ledger, is_custom, created_at) VALUES (?, ?, ?, 'expense', ?, 0, ?)",
      head.id, bid, UPI_SHORTAGE_HEAD.name, UPI_SHORTAGE_HEAD.tally, t));
  }
  const id = newId();
  const bill = sale!.bill_no ?? 'no number';
  statements.push(
    stmt(db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, head_id, narration, source, status, payment_mode, shift_day, bill_no, created_at, ocr_original)
      VALUES (?, ?, NULL, ?, ?, 'expense', ?, ?, 'cash_shortage', 'approved', 'upi', ?, ?, ?, ?)`, id, bid, sale!.shift_day, sale!.amount_paise, head.id,
      `UPI shortage, ${sale!.shift_day} shift: bill ${bill} not received · ${note}`, sale!.shift_day, sale!.bill_no, t,
      JSON.stringify({ saleId: sale!.id, comparisonId: sale!.comparison_id, billNo: sale!.bill_no })),
    stmt(db, "UPDATE transactions SET match_status = NULL WHERE id = ? AND match_status = 'awaiting_bank_match'", sale!.id),
    stmt(db, 'INSERT INTO closed_bills (transaction_id, business_id, note, closed_by, closed_at) VALUES (?, ?, ?, ?, ?)', sale!.id, bid, `${UPI_SHORT_NOTE}: ${note}`.slice(0, 300), user, t),
    stmt(db, TX_AUDIT, ...audit(bid, user, 'sale.upi_shortage', id, null, { saleId: sale!.id, billNo: sale!.bill_no, amountPaise: sale!.amount_paise, note }, t)),
  );
  if (sale!.comparison_id) statements.push(stmt(db, 'UPDATE bill_comparisons SET closed_at = ?, closed_by = ?, close_note = ? WHERE id = ? AND business_id = ? AND closed_at IS NULL',
    t, user, `${UPI_SHORT_NOTE}: ${note}`.slice(0, 300), sale!.comparison_id, bid));
  await db.batch(statements);
  return c.json({ ok: true, id, amountPaise: sale!.amount_paise, billNo: sale!.bill_no });
});

bankRoutes.post('/businesses/:businessId/upi-shortage/:id/undo', requireRole('cash.writeoff'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('id');
  if (!isUuid(id)) fail(404, 'Not found.');
  const x = await one<{ id: string; ocr_original: string | null }>(db, "SELECT id, ocr_original FROM transactions WHERE id = ? AND business_id = ? AND source = 'cash_shortage' AND payment_mode = 'upi' AND type = 'expense'", id, bid);
  if (!x) fail(404, 'This UPI shortage is not booked.');
  let o: { saleId?: string; comparisonId?: string | null } = {};
  try { o = JSON.parse(x!.ocr_original ?? '{}') ?? {}; } catch { /* none */ }
  const t = now();
  const user = c.get('user').id;
  const statements = [
    stmt(db, 'DELETE FROM transactions WHERE id = ? AND business_id = ?', id, bid),
    stmt(db, TX_AUDIT, ...audit(bid, user, 'sale.upi_shortage_undone', id, { saleId: o.saleId ?? null }, null, t)),
  ];
  if (o.saleId) statements.push(
    stmt(db, "UPDATE transactions SET match_status = 'awaiting_bank_match' WHERE id = ? AND business_id = ? AND matched_bank_row IS NULL", o.saleId, bid),
    stmt(db, 'DELETE FROM closed_bills WHERE transaction_id = ? AND business_id = ?', o.saleId, bid));
  if (o.comparisonId) statements.push(stmt(db, `UPDATE bill_comparisons SET closed_at = NULL, closed_by = NULL, close_note = NULL
    WHERE id = ? AND business_id = ? AND close_note LIKE '${UPI_SHORT_NOTE}%'`, o.comparisonId, bid));
  await db.batch(statements);
  return c.json({ ok: true });
});

/**
 * Cash moved between the drawer and the bank (Stage 6, approved 10 Nov 2026): a deposit (credit) or cash taken out for
 * the drawer (debit). Not income and not an expense: two transfer rows, out of one account and into the other, and the
 * cash check of the shift the cash left (or reached) the drawer counts it. Undo (reopen) removes both.
 */
bankRoutes.post('/businesses/:businessId/bank-rows/:rowId/cash-move', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row) fail(404, 'Not found.');
  if (row!.status !== 'unmatched') fail(409, 'This line is already matched, booked or skipped.');
  if (row!.kind === 'upi_in' || row!.kind === 'upi_out' || row!.kind === 'card_settlement') fail(400, 'A UPI or card line is not cash.');
  const data = await body(c);
  const shiftDay = data.shiftDay == null || data.shiftDay === '' ? shiftDayOf(row!.posted_at) : String(data.shiftDay);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(shiftDay)) fail(400, 'Choose the shift.');
  const cash = await one<{ id: string }>(db, `SELECT id FROM accounts WHERE business_id = ? AND kind = 'cash' ORDER BY lower(name) = 'cash' DESC, created_at LIMIT 1`, bid);
  if (!cash) fail(400, 'This business has no cash account.');
  const deposit = row!.direction === 'CR';
  const t = now();
  const user = c.get('user').id;
  const bankLeg = newId();
  const cashLeg = newId();
  const what = deposit ? 'Cash deposited to the bank' : 'Cash taken out for the drawer';
  const meta = (leg: 'in' | 'out') => JSON.stringify({ transfer: deposit ? 'cash_deposit' : 'cash_withdrawal', leg, bankRowId: row!.id });
  await db.batch([
    stmt(db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, narration, source, status, shift_day, ocr_original, created_at)
      VALUES (?, ?, ?, ?, ?, 'transfer', ?, 'bank_sheet', 'approved', ?, ?, ?)`, bankLeg, bid, row!.account_id, row!.day, row!.amount_paise, `${what} (${row!.description})`, shiftDay, meta(deposit ? 'in' : 'out'), t),
    stmt(db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, narration, source, status, shift_day, ocr_original, created_at)
      VALUES (?, ?, ?, ?, ?, 'transfer', ?, 'bank_sheet', 'approved', ?, ?, ?)`, cashLeg, bid, cash!.id, row!.day, row!.amount_paise, what, shiftDay, meta(deposit ? 'out' : 'in'), t),
    stmt(db, "UPDATE bank_rows SET status = 'booked', transaction_id = ?, note = ?, done_by = ?, done_at = ? WHERE id = ? AND status = 'unmatched'",
      bankLeg, `${deposit ? 'Cash deposited' : 'Cash for the drawer'}: ${shiftDay} shift`, user, t, row!.id),
    stmt(db, AUDIT, ...audit(bid, user, 'bank.cash_move', row!.id, { status: 'unmatched' }, { deposit, shiftDay, transactions: [bankLeg, cashLeg] }, t)),
  ]);
  return c.json({ ok: true, shiftDay });
});

// ---- Money received with no bill (Stage 5, approved 10 Nov 2026)

/** What an unmatched credit could be, before it is called extra: an owed bill, part of a bill, a payment made twice. */
bankRoutes.get('/businesses/:businessId/bank-rows/:rowId/checks', requireRole('bank.link'), async (c) => {
  const row = await getRow(c.env.DB, c.get('businessId'), c.req.param('rowId'));
  if (!row || row.direction !== 'CR') fail(404, 'Not found.');
  return c.json(await creditChecks(c.env.DB, c.get('businessId'), row!));
});

/** A credit is the payment of a bill closed as owed: the bill is opened again and matched to it. */
bankRoutes.post('/businesses/:businessId/bank-rows/:rowId/owed-paid', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row || row.kind !== 'upi_in') fail(404, 'Not found.');
  if (row!.status !== 'unmatched') fail(409, 'This credit is already matched, booked or held.');
  const txId = (await body(c)).txId;
  if (typeof txId !== 'string' || !isUuid(txId)) fail(400, 'Choose the bill.');
  const owed = (await creditChecks(db, bid, row!)).owed.find((x) => x.txId === txId);
  if (!owed) fail(409, 'This bill is not closed as owed, or its amount is more than ₹10 from the credit.');
  const t = now();
  const user = c.get('user').id;
  await db.batch([
    stmt(db, "UPDATE transactions SET match_status = 'awaiting_bank_match' WHERE id = ? AND matched_bank_row IS NULL", txId),
    stmt(db, 'DELETE FROM closed_bills WHERE transaction_id = ?', txId),
    stmt(db, TX_AUDIT, ...audit(bid, user, 'sale.reopened', txId as string, { note: owed!.note }, { paidBy: row!.id }, t)),
    ...matchStatements(db, bid, row!.id, [txId as string], user, t),
  ]);
  return c.json({ ok: true });
});

/** Not income: a refund due or a tip for staff. The credit is held with a note until the money goes back or out. */
bankRoutes.post('/businesses/:businessId/bank-rows/:rowId/hold', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row || row.direction !== 'CR') fail(404, 'Not found.');
  if (row!.status !== 'unmatched') fail(409, 'This line is already matched, booked or held.');
  const data = await body(c);
  const kind = data.kind === 'refund' || data.kind === 'tip' ? (data.kind as HeldKind) : fail(400, 'Choose refund due or tip for staff.');
  const who = text(data, 'note', kind === 'refund' ? 'To whom' : 'Note', { max: 200 })!;
  const note = `${HELD[kind as HeldKind]} · ${who}`;
  const t = now();
  const user = c.get('user').id;
  await db.batch([
    stmt(db, "UPDATE bank_rows SET status = 'ignored', note = ?, done_by = ?, done_at = ? WHERE id = ? AND status = 'unmatched'", note, user, t, row!.id),
    stmt(db, AUDIT, ...audit(bid, user, 'bank.hold', row!.id, { status: 'unmatched' }, { status: 'ignored', kind, note }, t)),
  ]);
  return c.json({ ok: true, note });
});

bankRoutes.get('/businesses/:businessId/held', requireRole('bank.link'), async (c) => c.json({ held: await heldList(c.env.DB, c.get('businessId')) }));

/** A held refund paid back (matched to the payment going out), or a held tip paid out to staff. */
bankRoutes.post('/businesses/:businessId/bank-rows/:rowId/held-done', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  const kind = heldKindOf(row?.note ?? null);
  if (!row || row.status !== 'ignored' || !kind) fail(404, 'This credit is not held.');
  if (isHeldDone(row!.note)) fail(409, 'This is already paid.');
  const t = now();
  const user = c.get('user').id;
  const statements: D1PreparedStatement[] = [];
  if (kind === 'refund') {
    const outId = (await body(c)).outRowId;
    if (typeof outId !== 'string' || !isUuid(outId)) fail(400, 'Choose the payment that paid it back.');
    const out = await getRow(db, bid, outId as string);
    if (!out || out.direction !== 'DR' || out.status !== 'unmatched') fail(409, 'That payment is not an open payment out.');
    if (out!.amount_paise !== row!.amount_paise || out!.posted_at <= row!.posted_at) fail(400, 'The refund must be the same amount, after the credit.');
    statements.push(
      stmt(db, "UPDATE bank_rows SET status = 'ignored', pair_row_id = ?, note = ?, done_by = ?, done_at = ? WHERE id = ? AND status = 'unmatched'",
        row!.id, `Refund paid back for the ${istDay(row!.posted_at)} credit`, user, t, out!.id),
      stmt(db, 'UPDATE bank_rows SET note = ? WHERE id = ?', `${row!.note} · paid back ${istDay(out!.posted_at)}`, row!.id));
  } else {
    statements.push(stmt(db, 'UPDATE bank_rows SET note = ? WHERE id = ?', `${row!.note} · paid out ${istDay(t)}`, row!.id));
  }
  statements.push(stmt(db, AUDIT, ...audit(bid, user, 'bank.held_done', row!.id, { note: row!.note }, { kind }, t)));
  await db.batch(statements);
  return c.json({ ok: true });
});

bankRoutes.get('/businesses/:businessId/shifts/:day/explain', requireRole('bank.link'), async (c) => {
  const day = c.req.param('day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'Unknown shift.');
  return c.json(await explainShift(c.env.DB, c.get('businessId'), day));
});

// ---- Matching a credit to sales (a person confirms; never automatic)

async function checkMatch(db: D1Database, bid: string, row: BankRow, ids: string[], allowDifference = false) {
  if (row.status !== 'unmatched') fail(409, 'This line is already matched, booked or ignored.');
  if (row.direction !== 'CR') fail(400, 'Only money received can be matched to sales.');
  if (!ids.length || ids.some((x) => !isUuid(x))) fail(400, 'Choose the sale or sales this credit pays.');
  const tx = await all<{ id: string; amount_paise: number; match_status: string | null; matched_bank_row: string | null }>(db,
    `SELECT id, amount_paise, match_status, matched_bank_row FROM transactions WHERE business_id = ? AND type = 'income' AND payment_mode = 'upi'
      AND id IN (${ids.map(() => '?').join(',')})`, bid, ...ids);
  if (tx.length !== new Set(ids).size) fail(400, 'One of those sales was not found.');
  if (tx.some((t) => t.matched_bank_row || t.match_status !== 'awaiting_bank_match')) fail(409, 'One of those sales is already matched.');
  const total = tx.reduce((s, t) => s + t.amount_paise, 0);
  if (total !== row.amount_paise && !allowDifference) fail(400, `The sales add up to ₹${(total / 100).toFixed(2)}, the credit is ₹${(row.amount_paise / 100).toFixed(2)}.`);
  return total;
}

bankRoutes.post('/businesses/:businessId/bank-rows/:rowId/match', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row) fail(404, 'Not found.');
  const data = await body(c);
  const ids = Array.isArray(data.transactionIds) ? data.transactionIds.filter((x): x is string => typeof x === 'string') : [];
  if (ids.length > 30) fail(400, 'At most 30 sales for one credit.');
  await checkMatch(db, bid, row, ids);
  await db.batch(matchStatements(db, bid, row.id, ids, c.get('user').id, now()));
  return c.json({ ok: true });
});

/**
 * A UPI payment written under the wrong account's column: the person changes the column to the account the money
 * came into (see columnHints). On a confirmed shift the credit can be matched in the same step. Both are recorded.
 */
bankRoutes.post('/businesses/:businessId/register-payments/:paymentId/column', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const pay = await one<{ id: string; mode: string; column_label: string | null; register_row_id: string }>(db,
    `SELECT p.id, p.mode, p.column_label, p.register_row_id FROM register_payments p WHERE p.id = ? AND p.business_id = ?`, c.req.param('paymentId'), bid);
  if (!pay) fail(404, 'Not found.');
  if (pay.mode !== 'upi') fail(400, 'Only a UPI payment has an account column.');
  const data = await body(c);
  const labels = await accountLabels(db, bid);
  // Written as given ("UPI BANK 2" and "UPI Bank 2" are one column), so undo puts back what was there.
  const key = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const label = typeof data.columnLabel === 'string' ? data.columnLabel.trim().slice(0, 40) : '';
  if (!label || !labels.some((l) => key(l) === key(label))) fail(400, 'Choose the column of an account that receives UPI.');
  const t = now();
  const user = c.get('user').id;
  const statements = [
    stmt(db, 'UPDATE register_payments SET column_label = ? WHERE id = ?', label, pay.id),
    stmt(db, AUDIT.replace("'bank_rows'", "'register_payments'"), ...audit(bid, user, 'register.column_changed', pay.id, { columnLabel: pay.column_label }, { columnLabel: label }, t)),
  ];
  let matched = false;
  if (typeof data.creditId === 'string') {
    const row = await getRow(db, bid, data.creditId);
    if (!row) fail(404, 'That credit was not found.');
    const ids = Array.isArray(data.transactionIds) ? data.transactionIds.filter((x): x is string => typeof x === 'string').slice(0, 30) : [];
    await checkMatch(db, bid, row, ids);
    statements.push(...matchStatements(db, bid, row.id, ids, user, t));
    matched = true;
  }
  await db.batch(statements);
  return c.json({ ok: true, matched });
});

/**
 * A register slip on a confirmed shift, corrected from this credit (see slips.ts): the correction is worked out again
 * here, recorded, and the credit matched, all in one step. Unmatch puts it all back. Before confirming, the register
 * row is simply edited.
 */
bankRoutes.post('/businesses/:businessId/bank-rows/:rowId/slip-fix', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row) fail(404, 'Not found.');
  if (row.status !== 'unmatched') fail(409, 'This credit is already matched, booked or ignored.');
  const data = await body(c);
  const day = typeof data.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.day) ? data.day : fail(400, 'Unknown shift.');
  const status = (await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', bid, day))?.status;
  if (status !== 'confirmed') fail(400, 'This shift is not confirmed yet: correct the bill on its register row.');
  // A swap is worked out from both its credits.
  const partner = typeof data.partnerCreditId === 'string' && isUuid(data.partnerCreditId) ? [data.partnerCreditId] : [];
  const slip = (await shiftSlips(db, bid, day, [row.id, ...partner])).find((x) => x.key === data.key);
  if (!slip) fail(409, 'This correction no longer fits the bill. Reload the page.');
  await db.batch(await slipFixStatements(db, bid, row, slip, c.get('user').id, now()));
  return c.json({ ok: true });
});

/** The person ticks clear suggestions and confirms them together; each is checked again here. */
bankRoutes.post('/businesses/:businessId/bank-rows/match-clear', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const ids = Array.isArray(data.ids) ? data.ids.filter((x): x is string => typeof x === 'string' && isUuid(x)).slice(0, 500) : [];
  if (!ids.length) fail(400, 'Choose the suggestions to confirm.');
  const days = await all<{ day: string }>(db, `SELECT DISTINCT day FROM bank_rows WHERE business_id = ? AND id IN (${ids.map(() => '?').join(',')})`, bid, ...ids.slice(0, 90));
  if (!days.length) fail(404, 'Not found.');
  const sorted = days.map((d) => d.day).sort();
  const sug = await suggestionsFor(db, bid, sorted[0], sorted[sorted.length - 1]);
  const t = now();
  const user = c.get('user').id;
  const statements: D1PreparedStatement[] = [];
  let done = 0;
  for (const id of ids) {
    const k = sug.clear.get(id);
    if (!k || k.adjust) continue; // a match that changes the register goes through match-many with adjust
    statements.push(...matchStatements(db, bid, id, k.transactionIds, user, t + done));
    done += 1;
  }
  for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90));
  return c.json({ matched: done, skipped: ids.length - done });
});

/** Several credits, each with the sale(s) the person chose for it. Each is checked as on its own; failures are listed. */
bankRoutes.post('/businesses/:businessId/bank-rows/match-many', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const pairs = (Array.isArray(data.pairs) ? data.pairs : []).slice(0, 300) as { rowId?: unknown; transactionIds?: unknown; adjust?: unknown }[];
  if (!pairs.length) fail(400, 'Choose the credits to match.');
  const t = now();
  const user = c.get('user').id;
  const used = new Set<string>();
  const statements: D1PreparedStatement[] = [];
  const skipped: string[] = [];
  let matched = 0;
  for (const p of pairs) {
    const rowId = typeof p.rowId === 'string' && isUuid(p.rowId) ? p.rowId : null;
    const ids = Array.isArray(p.transactionIds) ? p.transactionIds.filter((x): x is string => typeof x === 'string' && isUuid(x)) : [];
    const row = rowId ? await getRow(db, bid, rowId) : null;
    if (!row) { skipped.push('A line was not found.'); continue; }
    if (ids.some((x) => used.has(x))) { skipped.push(`${row.tran_id}: that bill is chosen for another credit too.`); continue; }
    let total = 0;
    try { total = await checkMatch(db, bid, row, ids, p.adjust === true); }
    catch (e) { skipped.push(`${row.tran_id}: ${(e as Error).message}`); continue; }
    ids.forEach((x) => used.add(x));
    // The bank shows the bill amount and the register a discount or tip: the register is corrected as it is matched.
    if (p.adjust === true && total !== row.amount_paise) {
      try {
        const adj = await adjustStatements(db, bid, row.id, ids, row.amount_paise, 'Bank shows the bill amount: register discount/tip corrected', user, t + matched, [row.amount_paise]);
        statements.push(...adj.statements);
        for (const x of ids) {
          statements.push(stmt(db, 'INSERT INTO bank_matches (id, business_id, bank_row_id, transaction_id, amount_paise, matched_by, matched_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            newId(), bid, row.id, x, adj.nets.get(x)!, user, t + matched));
          statements.push(stmt(db, "UPDATE transactions SET matched_bank_row = ?, match_status = NULL WHERE id = ? AND matched_bank_row IS NULL AND match_status = 'awaiting_bank_match'", row.id, x));
        }
        statements.push(stmt(db, "UPDATE bank_rows SET status = 'matched', done_by = ?, done_at = ? WHERE id = ? AND status = 'unmatched'", user, t, row.id));
        statements.push(stmt(db, AUDIT, ...audit(bid, user, 'bank.match_adjust_bills', row.id, null, { sales: ids, changed: adj.changed, how: 'bank shows the bill amount' }, t)));
        matched += 1;
      } catch (e) { skipped.push(`${row.tran_id}: ${(e as Error).message}`); }
      continue;
    }
    // Each credit of a bulk action keeps its own time, so unmatching one does not undo the others.
    statements.push(...matchStatements(db, bid, row.id, ids, user, t + matched));
    matched += 1;
  }
  for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90));
  return c.json({ matched, skipped });
});

/** Several lines booked under the head the person chose for each (money in: income heads; money out: expense heads). */
bankRoutes.post('/businesses/:businessId/bank-rows/book-many', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const items = (Array.isArray(data.items) ? data.items : []).slice(0, 300) as { rowId?: unknown; headId?: unknown; party?: unknown; item?: unknown; billType?: unknown; override?: unknown }[];
  // check: only say which lines the booking gate would stop, booking nothing ("Book N selected" asks first).
  const checkOnly = data.check === true;
  const look: { rowId: string; tranId: string; amountPaise: number; day: string; checks: GateCheck[]; canOverride: boolean }[] = [];
  const clear: string[] = [];
  if (!items.length) fail(400, 'Choose the lines to book.');
  const t = now();
  const user = c.get('user').id;
  const ctx = { parties: await loadParties(db, bid), history: await loadHistory(db, bid) };
  // A sale nobody billed (e.g. drinks in a rush, paid by UPI): booked under the bill type's income head, like billed sales.
  const typeHeads = new Map((await all<{ bill_type: string; head_id: string }>(db, 'SELECT bill_type, head_id FROM bill_type_heads WHERE business_id = ?', bid)).map((x) => [x.bill_type, x.head_id]));
  const statements: D1PreparedStatement[] = [];
  const skipped: string[] = [];
  let booked = 0;
  for (const it of items) {
    const rowId = typeof it.rowId === 'string' && isUuid(it.rowId) ? it.rowId : null;
    const unbilled = it.billType === 'fnb' || it.billType === 'room' ? it.billType : null;
    const chosen = unbilled ? typeHeads.get(unbilled) ?? null : typeof it.headId === 'string' && isUuid(it.headId) ? it.headId : null;
    const partyName = typeof it.party === 'string' && it.party.trim() ? it.party.trim().slice(0, 120) : null;
    const typed = typeof it.item === 'string' && it.item.trim() ? it.item.trim().slice(0, 200) : null;
    const item = unbilled ? `Sale not billed (${unbilled === 'fnb' ? 'F&B' : 'Room'})${typed ? `: ${typed}` : ''}` : typed;
    const row = rowId ? await getRow(db, bid, rowId) : null;
    if (!row || row.status !== 'unmatched') { skipped.push(`${row?.tran_id ?? 'A line'}: already done or not found.`); continue; }
    if (unbilled && row.direction !== 'CR') { skipped.push(`${row.tran_id}: only money received can be a sale.`); continue; }
    if (unbilled && !chosen) { skipped.push(`${row.tran_id}: choose the income head for ${unbilled === 'fnb' ? 'F&B' : 'Room'} bills on Heads and rules first.`); continue; }
    if (chosen) { try { await headFits(db, bid, row, chosen); } catch (e) { skipped.push(`${row.tran_id}: ${(e as Error).message}`); continue; } }
    const g = await passGate(c, row, it.override);
    if (!g.ok) {
      look.push({ rowId: row.id, tranId: row.tran_id, amountPaise: row.amount_paise, day: row.day, checks: g.checks, canOverride: g.canOverride });
      skipped.push(`${row.tran_id}: ${gateWord(g.checks)}.`);
      continue;
    }
    if (checkOnly) { clear.push(row.id); continue; }
    try {
      const p = await partyStatements(db, bid, row, partyName, item, chosen, ctx);
      if (!p.headId) { skipped.push(`${row.tran_id}: choose a head.`); continue; }
      const book = await bookStatements(db, bid, row, p.headId, p.partyId, [unbilled ? 'Unbilled sale' : null, g.note].filter(Boolean).join(' · ') || null, user, t,
        unbilled ? `unbilled ${unbilled} sale` : 'chosen in a list', item, g.gate);
      statements.push(...p.statements, ...book);
      if (p.partyId) ctx.history.unshift({ party_id: p.partyId, head_id: p.headId, narration: item ?? row.remark });
      booked += 1;
    } catch (e) { skipped.push(`${row.tran_id}: ${(e as Error).message}`); }
  }
  if (checkOnly) return c.json({ clear, look, skipped: skipped.filter((x) => !look.some((l) => x.startsWith(`${l.tranId}:`))) });
  for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90));
  return c.json({ booked, skipped, look });
});

/**
 * A credit and the bills it pays when the amounts differ (e.g. a typo in the register, a short payment).
 * The difference is booked as its own entry on the bank account under the head chosen, with a reason:
 * an expense when less came in than billed, income when more came in. Unmatching removes it again.
 */
bankRoutes.post('/businesses/:businessId/bank-rows/:rowId/match-with-difference', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row) fail(404, 'Not found.');
  const data = await body(c);
  const ids = Array.isArray(data.transactionIds) ? data.transactionIds.filter((x): x is string => typeof x === 'string').slice(0, 30) : [];
  const total = await checkMatch(db, bid, row, ids, true);
  const diff = row.amount_paise - total; // negative: less received than billed
  const t = now();
  const user = c.get('user').id;
  const statements = matchStatements(db, bid, row.id, ids, user, t);
  if (diff !== 0) {
    const headId = typeof data.headId === 'string' && isUuid(data.headId) ? data.headId : fail(400, 'Choose the head for the difference.');
    const note = text(data, 'note', 'Reason for the difference', { max: 300 })!;
    const head = await one<{ type: string }>(db, 'SELECT type FROM heads WHERE id = ? AND business_id = ?', headId, bid);
    const type = diff < 0 ? 'expense' : 'income';
    if (!head || head.type !== type) fail(400, diff < 0 ? 'Less came in than was billed: choose an expense head (e.g. Discount allowed).' : 'More came in than was billed: choose an income head.');
    if (Math.abs(diff) > total) fail(400, 'The difference is larger than the bills. Check the bills chosen.');
    const txId = newId();
    statements.push(
      stmt(db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, head_id, narration, source, status, payment_mode, matched_bank_row, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'bank_sheet', 'approved', 'upi', ?, ?)`, txId, bid, row.account_id, row.day, Math.abs(diff), type, headId,
        `Difference on UPI ${row.tran_id}: ${note}`, row.id, t),
      stmt(db, AUDIT, ...audit(bid, user, 'bank.match_difference', row.id, null, { differencePaise: diff, headId, note, transactionId: txId, sales: ids }, t)),
    );
  }
  await db.batch(statements);
  return c.json({ ok: true, differencePaise: diff });
});

/**
 * Desk bills in a Yes Bank settlement (approved 25 Nov 2026). A settlement is one day's direct-booking UPI paid out in
 * one sum; rarely a desk guest paid into it. The desk UPI sales still waiting for their money, from saved shifts of the
 * 3 days before the settlement's date (it pays out money collected before that day: 26 Nov 2026), can be matched to it, and the rest is booked under an income head (Room
 * income). Unmatch on the line undoes both.
 */
bankRoutes.get('/businesses/:businessId/bank-rows/:rowId/desk-bills', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row) fail(404, 'Not found.');
  if (row!.remark !== SETTLEMENT_REMARK || row!.direction !== 'CR') fail(400, 'Only a UPI collection settlement holds desk bills.');
  const [bills, heads, room] = await Promise.all([
    all<{ id: string; billNo: string | null; amountPaise: number; shiftDay: string }>(db, `SELECT t.id, t.bill_no AS billNo, t.amount_paise AS amountPaise, t.shift_day AS shiftDay
      FROM transactions t WHERE t.business_id = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.match_status = 'awaiting_bank_match' AND t.matched_bank_row IS NULL
        AND t.shift_day BETWEEN ? AND ? ORDER BY t.shift_day, t.bill_no`, bid, addDays(row!.day, -SETTLEMENT_BACK_DAYS), addDays(row!.day, -1)),
    all<{ id: string; name: string }>(db, "SELECT id, name FROM heads WHERE business_id = ? AND type = 'income' ORDER BY name", bid),
    one<{ id: string }>(db, "SELECT head_id AS id FROM bill_type_heads WHERE business_id = ? AND bill_type = 'room'", bid),
  ]);
  return c.json({ bills, heads, headId: room?.id ?? null, from: addDays(row!.day, -SETTLEMENT_BACK_DAYS), to: addDays(row!.day, -1) });
});

bankRoutes.post('/businesses/:businessId/bank-rows/:rowId/settlement-split', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row) fail(404, 'Not found.');
  if (row!.remark !== SETTLEMENT_REMARK || row!.direction !== 'CR') fail(400, 'Only a UPI collection settlement holds desk bills.');
  const data = await body(c);
  const ids = [...new Set(Array.isArray(data.transactionIds) ? data.transactionIds.filter((x): x is string => typeof x === 'string') : [])].slice(0, 30);
  const total = await checkMatch(db, bid, row!, ids, true);
  const days = await all<{ shift_day: string | null }>(db, `SELECT shift_day FROM transactions WHERE business_id = ? AND id IN (${ids.map(() => '?').join(',')})`, bid, ...ids);
  if (days.some((d) => !d.shift_day || d.shift_day < addDays(row!.day, -SETTLEMENT_BACK_DAYS) || d.shift_day > addDays(row!.day, -1))) fail(400, 'A bill is not from this settlement\'s days.');
  const rest = row!.amount_paise - total;
  if (rest < 0) fail(400, `The bills add up to ₹${(total / 100).toFixed(2)}, more than the settlement.`);
  const t = now();
  const user = c.get('user').id;
  const statements = matchStatements(db, bid, row!.id, ids, user, t);
  let txId: string | null = null;
  if (rest > 0) {
    const headId = typeof data.headId === 'string' && isUuid(data.headId) ? data.headId : fail(400, 'Choose the head for the direct bookings.');
    const head = await one<{ type: string }>(db, 'SELECT type FROM heads WHERE id = ? AND business_id = ?', headId, bid);
    if (!head || head.type !== 'income') fail(400, 'Choose an income head for the direct bookings.');
    txId = newId();
    statements.push(stmt(db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, head_id, narration, source, status, payment_mode, matched_bank_row, created_at)
      VALUES (?, ?, ?, ?, ?, 'income', ?, ?, 'bank_sheet', 'approved', 'upi', ?, ?)`, txId, bid, row!.account_id, row!.day, rest, headId,
      `Direct bookings in UPI settlement ${row!.tran_id}`, row!.id, t));
  }
  statements.push(stmt(db, AUDIT, ...audit(bid, user, 'bank.settlement_split', row!.id, null, { sales: ids, deskPaise: total, restPaise: rest, headId: data.headId ?? null, transactionId: txId }, t)));
  await db.batch(statements);
  return c.json({ ok: true, deskPaise: total, restPaise: rest });
});

/**
 * Credits and bills chosen together: one credit for several bills, several credits for one bill (a guest paying in
 * two goes), or several of each. The credits are split over the bills in order. A difference between the totals is
 * booked apart under the chosen head with a reason, as with one credit.
 */
bankRoutes.post('/businesses/:businessId/bank-rows/match-set', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const rowIds = [...new Set(Array.isArray(data.rowIds) ? data.rowIds.filter((x): x is string => typeof x === 'string' && isUuid(x)) : [])].slice(0, 20);
  const txIds = [...new Set(Array.isArray(data.transactionIds) ? data.transactionIds.filter((x): x is string => typeof x === 'string' && isUuid(x)) : [])].slice(0, 30);
  if (!rowIds.length) fail(400, 'Choose the bank credit or credits.');
  if (!txIds.length) fail(400, 'Choose the bill or bills.');
  const rows = await all<BankRow>(db, `SELECT * FROM bank_rows WHERE business_id = ? AND id IN (${rowIds.map(() => '?').join(',')}) ORDER BY posted_at`, bid, ...rowIds);
  if (rows.length !== rowIds.length) fail(404, 'A credit was not found.');
  if (rows.some((r) => r.status !== 'unmatched')) fail(409, 'One of those credits is already matched, booked or skipped.');
  if (rows.some((r) => r.direction !== 'CR')) fail(400, 'Only money received can be matched to sales.');
  const tx = await all<{ id: string; amount_paise: number; match_status: string | null; matched_bank_row: string | null }>(db,
    `SELECT id, amount_paise, match_status, matched_bank_row FROM transactions WHERE business_id = ? AND type = 'income' AND payment_mode = 'upi'
      AND id IN (${txIds.map(() => '?').join(',')}) ORDER BY bill_no`, bid, ...txIds);
  if (tx.length !== txIds.length) fail(400, 'One of those bills was not found.');
  if (tx.some((t) => t.matched_bank_row || t.match_status !== 'awaiting_bank_match')) fail(409, 'One of those bills is already matched.');
  const bank = rows.reduce((t, r) => t + r.amount_paise, 0);
  const bills = tx.reduce((t, x) => t + x.amount_paise, 0);
  const diff = bank - bills;
  const t = now();
  const user = c.get('user').id;
  const credits = rows.map((r) => ({ id: r.id, amount: r.amount_paise }));
  // "Change the bills": what came in is what the bills were paid; register and income rows are corrected.
  if (diff !== 0 && data.treat === 'bills') {
    const note = text(data, 'note', 'Reason for the difference', { max: 300 })!;
    const adj = await adjustStatements(db, bid, rows[0].id, tx.map((x) => x.id), bank, note, user, t, rows.map((r) => r.amount_paise));
    const links = allocate(credits, tx.map((x) => ({ id: x.id, amount: adj.nets.get(x.id)! })));
    const statements: D1PreparedStatement[] = [...adj.statements];
    for (const l of links) {
      statements.push(stmt(db, 'INSERT INTO bank_matches (id, business_id, bank_row_id, transaction_id, amount_paise, matched_by, matched_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        newId(), bid, l.rowId, l.transactionId, l.amount, user, t));
    }
    for (const x of tx) {
      statements.push(stmt(db, "UPDATE transactions SET matched_bank_row = ?, match_status = NULL WHERE id = ? AND matched_bank_row IS NULL AND match_status = 'awaiting_bank_match'",
        links.find((l) => l.transactionId === x.id)?.rowId ?? rows[0].id, x.id));
    }
    for (const r of rows) statements.push(stmt(db, "UPDATE bank_rows SET status = 'matched', done_by = ?, done_at = ? WHERE id = ? AND status = 'unmatched'", user, t, r.id));
    statements.push(stmt(db, AUDIT, ...audit(bid, user, 'bank.match_adjust_bills', rows[0].id, null, { rows: rowIds, sales: txIds, differencePaise: diff, note, changed: adj.changed }, t)));
    try { await db.batch(statements); }
    catch (e) {
      if (String((e as Error).message).includes('shift_confirmed')) fail(409, 'The register could not be changed. Reopen the shift and correct it there, or book the difference under a head.');
      throw e;
    }
    return c.json({ ok: true, differencePaise: diff, changed: adj.changed });
  }
  // With a difference, the credits are split over what the bills and the difference need.
  const links = allocate(credits, tx.map((x) => ({ id: x.id, amount: x.amount_paise })));
  const statements: D1PreparedStatement[] = [];
  if (diff < 0) {
    // Less came in than billed: the last bills are paid only in part; the shortfall is the difference entry.
    const paid = new Map<string, number>();
    let room = bank;
    for (const x of tx) { const p = Math.min(room, x.amount_paise); paid.set(x.id, p); room -= p; }
    links.length = 0;
    links.push(...allocate(credits, tx.filter((x) => (paid.get(x.id) ?? 0) > 0).map((x) => ({ id: x.id, amount: paid.get(x.id)! }))));
  }
  for (const l of links) {
    statements.push(stmt(db, 'INSERT INTO bank_matches (id, business_id, bank_row_id, transaction_id, amount_paise, matched_by, matched_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      newId(), bid, l.rowId, l.transactionId, l.amount, user, t));
  }
  for (const x of tx) {
    statements.push(stmt(db, "UPDATE transactions SET matched_bank_row = ?, match_status = NULL WHERE id = ? AND matched_bank_row IS NULL AND match_status = 'awaiting_bank_match'",
      links.find((l) => l.transactionId === x.id)?.rowId ?? rows[0].id, x.id));
  }
  for (const r of rows) statements.push(stmt(db, "UPDATE bank_rows SET status = 'matched', done_by = ?, done_at = ? WHERE id = ? AND status = 'unmatched'", user, t, r.id));
  if (diff !== 0) {
    const headId = typeof data.headId === 'string' && isUuid(data.headId) ? data.headId : fail(400, 'Choose the head for the difference.');
    const note = text(data, 'note', 'Reason for the difference', { max: 300 })!;
    const head = await one<{ type: string }>(db, 'SELECT type FROM heads WHERE id = ? AND business_id = ?', headId, bid);
    const type = diff < 0 ? 'expense' : 'income';
    if (!head || head.type !== type) fail(400, diff < 0 ? 'Less came in than was billed: choose an expense head (e.g. Discount allowed).' : 'More came in than was billed: choose an income head.');
    if (Math.abs(diff) > Math.max(bank, bills)) fail(400, 'The difference is larger than the amounts chosen. Check the ticks.');
    statements.push(stmt(db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, head_id, narration, source, status, payment_mode, matched_bank_row, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'bank_sheet', 'approved', 'upi', ?, ?)`, newId(), bid, rows[0].account_id, rows[0].day, Math.abs(diff), type, headId,
      `Difference on UPI ${rows.map((r) => r.tran_id).join(' + ')}: ${note}`, rows[0].id, t));
  }
  statements.push(stmt(db, AUDIT, ...audit(bid, user, 'bank.match_set', rows[0].id, null, { rows: rowIds, sales: txIds, links, differencePaise: diff }, t)));
  await db.batch(statements);
  return c.json({ ok: true, differencePaise: diff, links: links.length });
});

/** What "Fix the bill" needs for a credit and the register bill it was suggested with. */
bankRoutes.get('/businesses/:businessId/bank-rows/:rowId/fix-options', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row) fail(404, 'Not found.');
  const tx = c.req.query('tx') ?? '';
  if (!isUuid(tx)) fail(400, 'Choose the bill to fix.');
  const reg = await one<{ id: string; billNo: string; amountPaise: number; discountPaise: number; shiftDay: string; payments: string; uploadId: string; status: string }>(db, `
    SELECT r.id, r.bill_no AS billNo, r.amount_paise AS amountPaise, r.discount_paise - r.tip_paise AS discountPaise, r.shift_day AS shiftDay, r.upload_id AS uploadId,
      s.status, (SELECT json_group_array(json_object('mode', p.mode, 'amountPaise', p.amount_paise, 'label', p.column_label)) FROM register_payments p WHERE p.register_row_id = r.id) AS payments
    FROM transactions t JOIN bill_comparisons c ON c.id = t.comparison_id JOIN register_rows r ON r.id = c.register_row_id
    LEFT JOIN shifts s ON s.business_id = r.business_id AND s.shift_day = r.shift_day
    WHERE t.id = ? AND t.business_id = ?`, tx, bid);
  if (!reg) fail(400, 'That bill has no register line to fix.');
  // Bills of the same shift that are only in the software report: the likely right number, closest first.
  const sw = await all<{ billNo: string; amountPaise: number; mode: string; paidAt: number | null; decision: string | null }>(db, `
    SELECT c.bill_no AS billNo, c.sw_amount_paise AS amountPaise, c.sw_mode AS mode, b.paid_at AS paidAt, c.decision
    FROM bill_comparisons c LEFT JOIN software_bills b ON b.id = c.software_bill_id
    WHERE c.business_id = ? AND c.shift_day = ? AND c.difference = 'missing_in_register' AND c.register_row_id IS NULL`, bid, reg.shiftDay);
  const ranked = sw.map((x) => ({ ...x, distance: billDistance(reg.billNo, x.billNo), minutes: x.paidAt ? Math.round(Math.abs(row.posted_at - x.paidAt) / 60000) : null }))
    .sort((a, b) => a.distance - b.distance || (a.minutes ?? 9999) - (b.minutes ?? 9999));
  return c.json({ credit: { id: row.id, amountPaise: row.amount_paise, postedAt: row.posted_at }, register: { ...reg, payments: JSON.parse(reg.payments) }, softwareOnly: ranked.slice(0, 12) });
});

/** Fix the bill a credit pays, on a confirmed shift, and match the credit to it. Recorded; Unmatch undoes all of it. */
bankRoutes.post('/businesses/:businessId/bank-rows/:rowId/fix-bill', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row) fail(404, 'Not found.');
  if (row.status !== 'unmatched' || row.direction !== 'CR') fail(409, 'Only an unmatched credit can be used to fix a bill.');
  const data = await body(c);
  const registerRowId = typeof data.registerRowId === 'string' && isUuid(data.registerRowId) ? data.registerRowId : fail(400, 'Choose the register line.');
  const billNo = text(data, 'billNo', 'Bill number', { max: 30 })!;
  const amount = optionalPaise(data, 'amount', 'Bill amount') ?? fail(400, 'Give the bill amount.');
  const discount = optionalPaise(data, 'discount', 'Discount') ?? 0;
  const note = text(data, 'note', 'Reason', { max: 300 })!;
  const t = now();
  const user = c.get('user').id;
  const fix = await fixBillStatements(db, bid, row, { registerRowId, billNo, amountPaise: amount, discountPaise: discount, note }, user, t);
  try {
    await db.batch([
      ...fix.statements,
      ...matchStatements(db, bid, row.id, [fix.transactionId], user, t),
      stmt(db, AUDIT, ...audit(bid, user, 'bank.fix_bill', row.id, null, { registerRowId, billNo, amountPaise: amount, discountPaise: discount, note, changed: fix.changed }, t)),
    ]);
  } catch (e) {
    if (String((e as Error).message).includes('shift_confirmed')) fail(409, 'The register could not be changed this way. Reopen the shift and correct it on the register page.');
    throw e;
  }
  return c.json({ ok: true, changed: fix.changed });
});

bankRoutes.delete('/businesses/:businessId/bank-rows/:rowId/match', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row) fail(404, 'Not found.');
  if (row.status !== 'matched') fail(409, 'This line is not matched.');
  const u = await unmatchStatements(db, bid, row, c.get('user').id, now());
  await db.batch(u.statements);
  return c.json({ ok: true, unmatched: u.count, ...(u.bookingRestored ? { bookingRestored: true } : {}) });
});

/** Undoing a credit's match: the bills it paid wait for a credit again. Shared by Unmatch and a reversed payment. */
async function unmatchStatements(db: D1Database, bid: string, row: BankRow, user: string, t: number): Promise<{ statements: D1PreparedStatement[]; count: number; bookingRestored?: boolean }> {
  // A credit joined to a later bill goes back to being booked, as it was.
  if (await joinedBill(db, row.id)) {
    const back = await undoSameSaleStatements(db, bid, row.id, user, t);
    if (back) return { statements: back, count: 1, bookingRestored: true };
  }
  // Credits that share a bill are undone together, so no bill is left half matched.
  const set = await matchedSet(db, row.id);
  const inRows = set.rows.map(() => '?').join(',');
  const differences = await all(db, `SELECT * FROM transactions WHERE business_id = ? AND source = 'bank_sheet' AND matched_bank_row IN (${inRows})`, bid, ...set.rows);
  const undo = await undoAll(db, bid, set.rows, user, t);
  return { count: set.rows.length, statements: [
    ...undo,
    stmt(db, `UPDATE transactions SET matched_bank_row = NULL, match_status = 'awaiting_bank_match' WHERE business_id = ? AND source = 'software_report'
      AND (matched_bank_row IN (${inRows}) OR id IN (SELECT transaction_id FROM bank_matches WHERE bank_row_id IN (${inRows})))`, bid, ...set.rows, ...set.rows),
    stmt(db, `DELETE FROM bank_matches WHERE bank_row_id IN (${inRows})`, ...set.rows),
    stmt(db, `DELETE FROM transactions WHERE business_id = ? AND source = 'bank_sheet' AND matched_bank_row IN (${inRows}) AND id NOT IN (SELECT transaction_id FROM bank_rows WHERE transaction_id IS NOT NULL)`, bid, ...set.rows),
    stmt(db, `UPDATE bank_rows SET status = 'unmatched', done_by = NULL, done_at = NULL WHERE status = 'matched' AND id IN (${inRows})`, ...set.rows),
    stmt(db, AUDIT, ...audit(bid, user, 'bank.unmatch', row.id, { status: 'matched', set: set.rows, differences }, { status: 'unmatched', billsRestored: undo.length > 0 }, t)),
  ] };
}

/**
 * A credit reversed by the bank after it was matched to a bill (Stage 6, approved 10 Nov 2026): the guest's payment
 * failed. The match is undone, both lines are left out as reversed, and the bill waits for its money again.
 */
bankRoutes.post('/businesses/:businessId/bank-rows/:rowId/reversed-unpaid', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const rev = await getRow(db, bid, c.req.param('rowId'));
  if (!rev || rev.kind !== 'reversal' || !rev.pair_row_id) fail(404, 'Not a reversal of a payment in Bookr.');
  if (rev!.status !== 'unmatched') fail(409, 'This reversal is already dealt with.');
  const cr = await getRow(db, bid, rev!.pair_row_id!);
  if (!cr || cr.status !== 'matched') fail(409, 'The reversed credit is not matched to a bill.');
  const t = now();
  const user = c.get('user').id;
  const u = await unmatchStatements(db, bid, cr!, user, t);
  await db.batch([
    ...u.statements,
    // A credit that had been booked as a sale and joined to its bill: the booking goes too, since the money went back.
    stmt(db, "DELETE FROM transactions WHERE id = (SELECT transaction_id FROM bank_rows WHERE id = ?) AND source = 'bank_sheet'", cr!.id),
    stmt(db, "UPDATE bank_rows SET status = 'ignored', transaction_id = NULL, note = 'Payment reversed by the bank: the bill is unpaid again', done_by = ?, done_at = ? WHERE id IN (?, ?)", user, t + 1, rev!.id, cr!.id),
    stmt(db, AUDIT, ...audit(bid, user, 'bank.reversed_unpaid', cr!.id, { status: 'matched' }, { reversedBy: rev!.id }, t + 1)),
  ]);
  return c.json({ ok: true });
});

// ---- Booking a line as income or expense under a head, or leaving it out

/**
 * The party a bank line is booked with, as on cash expense lines: a named party (new ones are remembered with the
 * head chosen), or one known by this UPI ID or named in the note. The UPI ID is remembered on the party, so the
 * next payment to or from it gets the party and its head by itself.
 */
async function partyStatements(db: D1Database, bid: string, row: BankRow, partyName: string | null, item: string | null, headId: string | null,
  ctx: { parties: Awaited<ReturnType<typeof loadParties>>; history: Awaited<ReturnType<typeof loadHistory>> }) {
  const named = partyName ? byName(ctx.parties, partyName) : null;
  const byVpa = !partyName && row.vpa ? byName(ctx.parties, row.vpa) : null;
  const v = resolveVendor(db, bid, ctx.parties, { vendor: partyName ?? byVpa?.name ?? null, narration: item ?? row.remark ?? '', headId }, ctx.history);
  const statements = [...v.statements];
  const party = v.partyId ? ctx.parties.find((p) => p.id === v.partyId) ?? named ?? byVpa : null;
  if (party && row.vpa) {
    const aliases = JSON.parse(party.aliases || '[]') as string[];
    if (!aliases.map((a) => a.toLowerCase()).includes(row.vpa.toLowerCase()) && party.name.toLowerCase() !== row.vpa.toLowerCase()) {
      aliases.push(row.vpa);
      party.aliases = JSON.stringify(aliases);
      statements.push(stmt(db, 'UPDATE parties SET aliases = ? WHERE id = ?', party.aliases, party.id));
    }
  }
  return { partyId: v.partyId, headId: v.headId, statements };
}

/** The head is of the line's kind: income for money received, an expense for money paid. */
async function headFits(db: D1Database, bid: string, row: BankRow, headId: string) {
  const head = await one<{ type: string }>(db, 'SELECT type FROM heads WHERE id = ? AND business_id = ?', headId, bid);
  if (!head) fail(400, 'Choose a head.');
  if (head!.type !== (row.direction === 'CR' ? 'income' : 'expense')) fail(400, row.direction === 'CR' ? 'Money received goes under an income head.' : 'Money paid goes under an expense head.');
}

async function bookStatements(db: D1Database, bid: string, row: BankRow, headId: string, partyId: string | null, note: string | null, user: string, t: number, how: string, item: string | null = null,
  gate: { checks: string[]; reason: string } | null = null) {
  const head = await one<{ type: string }>(db, 'SELECT type FROM heads WHERE id = ? AND business_id = ?', headId, bid);
  if (!head) fail(400, 'Choose a head.');
  const type = row.direction === 'CR' ? 'income' : 'expense';
  if (head.type !== type) fail(400, row.direction === 'CR' ? 'Money received goes under an income head.' : 'Money paid goes under an expense head.');
  const txId = newId();
  return [
    stmt(db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, head_id, narration, source, status, payment_mode, party_id, matched_bank_row, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'bank_sheet', 'approved', ?, ?, ?, ?)`,
      txId, bid, row.account_id, row.day, row.amount_paise, type, headId, [item || row.description, note].filter(Boolean).join(' — '),
      row.kind === 'upi_in' || row.kind === 'upi_out' || row.kind === 'upi_fee' ? 'upi' : null, partyId, row.id, t),
    stmt(db, "UPDATE bank_rows SET status = 'booked', transaction_id = ?, note = ?, done_by = ?, done_at = ? WHERE id = ? AND status = 'unmatched'", txId, note, user, t, row.id),
    stmt(db, AUDIT, ...audit(bid, user, 'bank.book', row.id, { status: 'unmatched' }, { status: 'booked', headId, partyId, item, note, how, transactionId: txId, ...(gate ? { gate } : {}) }, t)),
  ];
}

/**
 * The booking gate for one line (src/bookingGate.ts): pass when nothing is found, or when an Owner or Accountant books it
 * anyway with a reason and nothing found is a hard stop. The reason is kept on the line's note and in the audit log.
 */
async function passGate(c: Context<AppEnv>, row: BankRow, override: unknown): Promise<{ ok: true; note: string | null; gate: { checks: string[]; reason: string } | null } | { ok: false; checks: GateCheck[]; canOverride: boolean }> {
  const checks = await bookingGate(c.env.DB, c.get('businessId'), row);
  if (!checks.length) return { ok: true, note: null, gate: null };
  const allowed = !checks.some((k) => k.block) && can(c.get('role'), 'bank.book_anyway');
  const reason = override && typeof override === 'object' && typeof (override as { reason?: unknown }).reason === 'string' ? (override as { reason: string }).reason.trim().slice(0, 200) : '';
  if (allowed && reason.length >= 3) return { ok: true, note: `Booked anyway (${gateWord(checks)}): ${reason}`, gate: { checks: checks.map((k) => k.check), reason } };
  return { ok: false, checks, canOverride: allowed };
}

bankRoutes.post('/businesses/:businessId/bank-rows/:rowId/book', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row) fail(404, 'Not found.');
  if (row.status !== 'unmatched') fail(409, 'This line is already matched, booked or ignored.');
  const data = await body(c);
  const headId = typeof data.headId === 'string' && isUuid(data.headId) ? data.headId : fail(400, 'Choose a head.');
  const partyName = text(data, 'party', 'Party', { optional: true, max: 120 });
  const note = text(data, 'note', 'Note', { optional: true, max: 300 });
  const item = text(data, 'item', 'Item', { optional: true, max: 120 });
  await headFits(db, bid, row!, headId);
  // The booking gate (25 Nov 2026): checked every time, whatever the screen.
  const g = await passGate(c, row!, data.override);
  if (!g.ok) return c.json({ ok: false, gate: { checks: g.checks, canOverride: g.canOverride, amountPaise: row!.amount_paise, day: row!.day } });
  const t = now();
  const statements: D1PreparedStatement[] = [];
  let partyId: string | null = null;
  if (partyName) {
    const p = byName(await loadParties(db, bid), partyName);
    partyId = p?.id ?? newId();
    if (!p) statements.push(stmt(db, 'INSERT INTO parties (id, business_id, name, aliases, default_head_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', partyId, bid, partyName, '[]', headId, t));
  }
  statements.push(...(await bookStatements(db, bid, row!, headId, partyId, [note, g.note].filter(Boolean).join(' · ') || null, c.get('user').id, t, 'by hand', item, g.gate)));
  await db.batch(statements);
  return c.json({ ok: true });
});

/** Books the chosen lines with the head their rule gives; lines without a rule (or already done) are skipped. */
bankRoutes.post('/businesses/:businessId/bank-rows/book-by-rules', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const ids = Array.isArray(data.ids) ? data.ids.filter((x): x is string => typeof x === 'string' && isUuid(x)).slice(0, 300) : [];
  if (!ids.length) fail(400, 'Choose the lines to book.');
  const rows = await all<BankRow>(db, `SELECT * FROM bank_rows WHERE business_id = ? AND status = 'unmatched' AND id IN (${ids.map(() => '?').join(',')})`, bid, ...ids.slice(0, 95));
  const rules = await loadRules(db, bid);
  const t = now();
  const user = c.get('user').id;
  const statements: D1PreparedStatement[] = [];
  let booked = 0;
  for (const r of rows) {
    const rule = r.kind === 'upi_in' ? null : ruleFor(rules, r);
    if (!rule) continue;
    // A rule books nothing the booking gate stops: those wait for a person.
    if ((await bookingGate(db, bid, r)).length) continue;
    statements.push(...(await bookStatements(db, bid, r, rule.head_id, rule.party_id, `Rule: ${rule.name}`, user, t, `rule ${rule.id}`)));
    booked += 1;
  }
  for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90));
  return c.json({ booked, skipped: ids.length - booked });
});

bankRoutes.post('/businesses/:businessId/bank-rows/:rowId/ignore', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row) fail(404, 'Not found.');
  if (row.status !== 'unmatched') fail(409, 'This line is already matched, booked or ignored.');
  const note = text(await body(c), 'note', 'Reason', { max: 300 })!;
  const t = now();
  await db.batch([
    stmt(db, "UPDATE bank_rows SET status = 'ignored', note = ?, done_by = ?, done_at = ? WHERE id = ? AND status = 'unmatched'", note, c.get('user').id, t, row.id),
    stmt(db, AUDIT, ...audit(bid, c.get('user').id, 'bank.ignore', row.id, { status: 'unmatched' }, { status: 'ignored', note }, t)),
  ]);
  return c.json({ ok: true });
});

/** A payment and its reversal cancel out: both are left out together. */
bankRoutes.post('/businesses/:businessId/bank-rows/ignore-reversals', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const pairs = await all<{ rev: string; out: string }>(db, `SELECT r.id AS rev, d.id AS out FROM bank_rows r JOIN bank_rows d ON d.id = r.pair_row_id
    WHERE r.business_id = ? AND r.kind = 'reversal' AND r.status = 'unmatched' AND d.status = 'unmatched'`, bid);
  const t = now();
  const user = c.get('user').id;
  const statements = pairs.flatMap((p) => [
    stmt(db, "UPDATE bank_rows SET status = 'ignored', note = 'Payment reversed', done_by = ?, done_at = ? WHERE id IN (?, ?) AND status = 'unmatched'", user, t, p.rev, p.out),
    stmt(db, AUDIT, ...audit(bid, user, 'bank.ignore_reversal', p.rev, null, { pairedWith: p.out }, t)),
  ]);
  for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90));
  return c.json({ pairs: pairs.length });
});

/**
 * A transfer between the business's own accounts (approved 14 Nov 2026), booked by a person from either line:
 * with its pair (the other account's line), or joined to a transfer booked earlier from the other side (legId), or
 * one-sided (the other side's line joins it when it comes). "remember" keeps a word of the description on the other
 * account, so its next line is known by itself.
 */
bankRoutes.post('/businesses/:businessId/bank-rows/:rowId/own-transfer', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row) fail(404, 'Not found.');
  if (row!.status !== 'unmatched') fail(409, 'This line is already matched, booked or skipped.');
  const data = await body(c);
  const otherAccountId = typeof data.otherAccountId === 'string' && isUuid(data.otherAccountId) ? data.otherAccountId : fail(400, 'Choose the other account.');
  if (otherAccountId === row!.account_id) fail(400, 'Choose another account.');
  const accounts = await ownAccounts(db, bid);
  const other = accounts.find((a) => a.id === otherAccountId);
  if (!other || other.kind !== 'bank') fail(400, 'Choose another bank account of this business. Cash goes through Cash deposited / Cash for the drawer.');
  const pair = typeof data.pairRowId === 'string' && isUuid(data.pairRowId) ? await getRow(db, bid, data.pairRowId) : null;
  if (pair && (pair.status !== 'unmatched' || pair.account_id !== otherAccountId || pair.amount_paise !== row!.amount_paise || pair.direction === row!.direction))
    fail(409, 'The other line is not a matching transfer any more. Reload.');
  const legId = typeof data.legId === 'string' && isUuid(data.legId) ? data.legId : null;
  if (legId) {
    const leg = await one<{ n: number }>(db, `SELECT count(*) AS n FROM transactions WHERE id = ? AND business_id = ? AND account_id = ? AND type = 'transfer' AND amount_paise = ?
      AND json_extract(ocr_original, '$.transfer') = 'own' AND json_extract(ocr_original, '$.bankRowId') IS NULL`, legId, bid, row!.account_id, row!.amount_paise);
    if (!leg?.n) fail(409, 'That transfer already has its line. Reload.');
  }
  const remember = typeof data.remember === 'string' ? data.remember.trim().slice(0, 60) : '';
  const t = now();
  const user = c.get('user').id;
  const st = await bookTransferStatements(db, bid, row!, otherAccountId, pair, legId, user, t);
  if (!st) fail(400, 'Choose the other account.');
  const ids: string[] = (() => { try { return JSON.parse(other!.identifiers); } catch { return []; } })();
  const learn = remember.length >= 3 && !ids.some((w) => w.toLowerCase() === remember.toLowerCase());
  await db.batch([...st!,
    ...(learn ? [stmt(db, 'UPDATE accounts SET identifiers = ? WHERE id = ? AND business_id = ?', JSON.stringify([...ids, remember]), other!.id, bid),
      stmt(db, AUDIT, ...audit(bid, user, 'account.identifier_learned', row!.id, { identifiers: ids }, { accountId: other!.id, word: remember }, t))] : [])]);
  return c.json({ ok: true, remembered: learn ? remember : null });
});

/** Undo: a booked line's transaction is removed (kept in the audit log); an ignored line opens again. */
bankRoutes.post('/businesses/:businessId/bank-rows/:rowId/reopen', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row) fail(404, 'Not found.');
  if (row.status !== 'booked' && row.status !== 'ignored') fail(409, 'Only a booked or ignored line can be opened again. Unmatch a matched one.');
  const tx = row.transaction_id ? await one(db, 'SELECT * FROM transactions WHERE id = ?', row.transaction_id) : null;
  const t = now();
  // A transfer between own accounts: both rows go and both lines open again (approved 14 Nov 2026).
  const own = row.transaction_id ? await undoTransferStatements(db, bid, row.transaction_id) : [];
  await db.batch([
    ...own,
    // A card settlement booked against this credit comes apart with it.
    ...unsettleStatements(db, row.id),
    stmt(db, "UPDATE bank_rows SET status = 'unmatched', transaction_id = NULL, note = NULL, done_by = NULL, done_at = NULL WHERE id = ?", row.id),
    // A held credit's refund going out is opened again with it (Stage 5).
    ...(heldKindOf(row.note) ? [stmt(db, "UPDATE bank_rows SET status = 'unmatched', note = NULL, pair_row_id = NULL, done_by = NULL, done_at = NULL WHERE pair_row_id = ? AND direction = 'DR' AND status = 'ignored'", row.id)] : []),
    ...(row.transaction_id ? [stmt(db, "DELETE FROM transactions WHERE id = ? AND source = 'bank_sheet'", row.transaction_id)] : []),
    // Cash moved between the drawer and the bank (Stage 6): both legs go.
    stmt(db, "DELETE FROM transactions WHERE business_id = ? AND type = 'transfer' AND json_extract(ocr_original, '$.bankRowId') = ?", bid, row.id),
    // Booked to a loan (24 Nov 2026): its interest row and the loan's line go too.
    stmt(db, "DELETE FROM transactions WHERE business_id = ? AND json_extract(ocr_original, '$.loanBankRowId') = ?", bid, row.id),
    stmt(db, 'DELETE FROM loan_entries WHERE business_id = ? AND bank_row_id = ?', bid, row.id),
    stmt(db, AUDIT, ...audit(bid, c.get('user').id, 'bank.reopen', row.id, { status: row.status, note: row.note, transaction: tx }, { status: 'unmatched' }, t)),
  ]);
  return c.json({ ok: true });
});

// ---- Rules (Owner and Accountant edit; checked top to bottom)

function ruleInput(data: Record<string, unknown>) {
  const contains = text(data, 'contains', 'Description contains', { optional: true, max: 80 });
  const vpa = text(data, 'vpa', 'UPI ID', { optional: true, max: 80 });
  if (!contains && !vpa) fail(400, 'A rule needs words the description contains, or a UPI ID.');
  const direction = data.direction === 'CR' || data.direction === 'DR' ? data.direction : null;
  const accountId = typeof data.accountId === 'string' && isUuid(data.accountId) ? data.accountId : null;
  const headId = typeof data.headId === 'string' && isUuid(data.headId) ? data.headId : fail(400, 'Choose the head this rule gives.');
  const partyId = typeof data.partyId === 'string' && isUuid(data.partyId) ? data.partyId : null;
  return { name: text(data, 'name', 'Rule name', { max: 80 })!, contains, vpa: vpa?.toLowerCase() ?? null, direction, accountId, headId, partyId,
    min: optionalPaise(data, 'min', 'Smallest amount'), max: optionalPaise(data, 'max', 'Largest amount') };
}

async function checkRuleRefs(db: D1Database, bid: string, r: ReturnType<typeof ruleInput>) {
  const head = await one<{ type: string }>(db, 'SELECT type FROM heads WHERE id = ? AND business_id = ?', r.headId, bid);
  if (!head) fail(400, 'Choose the head this rule gives.');
  if (r.direction && head.type !== (r.direction === 'CR' ? 'income' : 'expense')) fail(400, 'Money received goes under an income head; money paid under an expense head.');
  if (r.accountId && !(await one(db, "SELECT 1 AS ok FROM accounts WHERE id = ? AND business_id = ? AND kind = 'bank'", r.accountId, bid))) fail(400, 'Unknown bank account.');
  if (r.partyId && !(await one(db, 'SELECT 1 AS ok FROM parties WHERE id = ? AND business_id = ?', r.partyId, bid))) fail(400, 'Unknown party.');
}

// Repeats on Money out (approved 23 Nov 2026): see src/repeats.ts. Counted over every open line, not only the dates shown.
bankRoutes.get('/businesses/:businessId/bank-repeats', requireRole('bank.link'), async (c) => c.json({ repeats: await repeatsFor(c.env.DB, c.get('businessId')),
  hidden: [...(await hiddenKeys(c.env.DB, c.get('businessId')))] }));

/** "Not these": the card is hidden for everyone; Undo shows it again. */
bankRoutes.post('/businesses/:businessId/bank-repeats/:action{hide|unhide}', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const key = text(await body(c), 'key', 'Card', { max: 200 })!;
  await db.batch([stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, ?, 'bank_rows', ?, NULL, ?, ?)`,
    bid, c.get('user').id, `repeats.${c.req.param('action')}`, key, JSON.stringify({ changes: c.req.param('action') === 'hide' ? `Repeats card hidden: ${key}` : `Repeats card shown again: ${key}` }), now())]);
  return c.json({ ok: true });
});

bankRoutes.get('/businesses/:businessId/rules', requireRole('heads.view'), async (c) => {
  const rules = await all(c.env.DB, `SELECT r.id, r.position, r.name, r.direction, r.account_id AS accountId, r.contains, r.vpa, r.min_paise AS minPaise,
    r.max_paise AS maxPaise, r.head_id AS headId, r.party_id AS partyId, h.name AS headName, p.name AS partyName
    FROM rules r JOIN heads h ON h.id = r.head_id LEFT JOIN parties p ON p.id = r.party_id WHERE r.business_id = ? ORDER BY r.position, r.created_at`, c.get('businessId'));
  return c.json({ rules });
});

bankRoutes.post('/businesses/:businessId/rules', requireRole('rules.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const r = ruleInput(await body(c));
  await checkRuleRefs(db, bid, r);
  const id = newId();
  const t = now();
  const pos = (await one<{ p: number }>(db, 'SELECT coalesce(max(position), 0) + 1 AS p FROM rules WHERE business_id = ?', bid))!.p;
  await db.batch([
    stmt(db, `INSERT INTO rules (id, business_id, position, name, direction, account_id, contains, vpa, min_paise, max_paise, head_id, party_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, bid, pos, r.name, r.direction, r.accountId, r.contains, r.vpa, r.min, r.max, r.headId, r.partyId, c.get('user').id, t),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'rule.create', 'rules', ?, NULL, ?, ?)`,
      bid, c.get('user').id, id, JSON.stringify(r), t),
  ]);
  return c.json({ id }, 201);
});

bankRoutes.put('/businesses/:businessId/rules/:ruleId', requireRole('rules.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('ruleId');
  const before = isUuid(id) ? await one(db, 'SELECT * FROM rules WHERE id = ? AND business_id = ?', id, bid) : null;
  if (!before) fail(404, 'Not found.');
  const data = await body(c);
  const r = ruleInput(data);
  await checkRuleRefs(db, bid, r);
  const position = typeof data.position === 'number' && Number.isInteger(data.position) ? data.position : (before as { position: number }).position;
  await db.batch([
    stmt(db, `UPDATE rules SET name = ?, direction = ?, account_id = ?, contains = ?, vpa = ?, min_paise = ?, max_paise = ?, head_id = ?, party_id = ?, position = ? WHERE id = ?`,
      r.name, r.direction, r.accountId, r.contains, r.vpa, r.min, r.max, r.headId, r.partyId, position, id),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'rule.edit', 'rules', ?, ?, ?, ?)`,
      bid, c.get('user').id, id, JSON.stringify(before), JSON.stringify({ ...r, position }), now()),
  ]);
  return c.json({ ok: true });
});

bankRoutes.delete('/businesses/:businessId/rules/:ruleId', requireRole('rules.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('ruleId');
  const before = isUuid(id) ? await one(db, 'SELECT * FROM rules WHERE id = ? AND business_id = ?', id, bid) : null;
  if (!before) fail(404, 'Not found.');
  await db.batch([
    stmt(db, 'DELETE FROM rules WHERE id = ?', id),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'rule.delete', 'rules', ?, ?, NULL, ?)`,
      bid, c.get('user').id, id, JSON.stringify(before), now()),
  ]);
  return c.json({ ok: true });
});



/** UPI: the bank against Bookr (approved 20 Nov 2026). Every UPI credit of the shift's window (8 am to 8 am), split into
 * this shift's bills, other days' bills, card-tab money, sales booked with no bill and what is not booked yet; and this
 * shift's bills paid by a credit outside the window. */
async function upiBankVsBookr(db: D1Database, bid: string, day: string, strip: { upiSalesPaise: number; bills: number; billsLeftPaise: number; billsLeft: number; creditsLeft: number; creditsLeftPaise: number }, cardPaise: number) {
  const w = shiftWindow(day);
  const [tot, other, outside, waiting] = await Promise.all([
    all<{ status: string; n: number; a: number }>(db, `SELECT status, count(*) AS n, sum(amount_paise) AS a FROM bank_rows
      WHERE business_id = ? AND kind = 'upi_in' AND direction = 'CR' AND status != 'ignored' AND posted_at >= ? AND posted_at < ? GROUP BY status`, bid, w.from, w.to),
    all<{ id: string; amountPaise: number; postedAt: number; bills: string; day: string }>(db, `SELECT r.id, r.amount_paise AS amountPaise, r.posted_at AS postedAt,
        group_concat(t.bill_no, ' + ') AS bills, max(t.shift_day) AS day
      FROM bank_rows r JOIN bank_matches m ON m.bank_row_id = r.id JOIN transactions t ON t.id = m.transaction_id
      WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.status = 'matched' AND r.posted_at >= ? AND r.posted_at < ?
      GROUP BY r.id HAVING sum(t.shift_day = ?) = 0 ORDER BY r.posted_at`, bid, w.from, w.to, day),
    all<{ id: string; amountPaise: number; postedAt: number; bills: string }>(db, `SELECT r.id, r.amount_paise AS amountPaise, r.posted_at AS postedAt,
        group_concat(t.bill_no, ' + ') AS bills
      FROM transactions t JOIN bank_matches m ON m.transaction_id = t.id JOIN bank_rows r ON r.id = m.bank_row_id
      WHERE t.business_id = ? AND t.shift_day = ? AND t.payment_mode = 'upi' AND r.kind = 'upi_in' AND (r.posted_at < ? OR r.posted_at >= ?)
      GROUP BY r.id ORDER BY r.posted_at`, bid, day, w.from, w.to),
    // UPI bills of the shifts either side still waiting for their payment (21 Nov 2026): one quiet line on this tab.
    all<{ billNo: string | null; amountPaise: number; day: string }>(db, `SELECT t.bill_no AS billNo, t.amount_paise AS amountPaise, t.shift_day AS day
      FROM transactions t WHERE t.business_id = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.match_status = 'awaiting_bank_match'
        AND t.matched_bank_row IS NULL AND t.shift_day BETWEEN ? AND ? AND t.shift_day <> ?
        AND t.id NOT IN (SELECT transaction_id FROM closed_bills WHERE business_id = ?)
      ORDER BY t.shift_day, t.bill_no LIMIT 5`, bid, addDays(day, -1), addDays(day, 1), day, bid),
  ]);
  const totalPaise = tot.reduce((t, x) => t + (x.a ?? 0), 0);
  const booked0 = tot.find((x) => x.status === 'booked');
  // Same sale chosen, done on save (21 Nov 2026): the booked credit pays its bill now. In the window it counts for the
  // bills, not as a sale with no bill; from another shift the bill is paid on another day.
  const plans = await plansFor(db, bid, day);
  const planned = plans.length ? await all<{ id: string; amountPaise: number; postedAt: number; billNo: string }>(db, `SELECT r.id, r.amount_paise AS amountPaise, r.posted_at AS postedAt, c.bill_no AS billNo
    FROM bank_rows r JOIN bill_comparisons c ON c.business_id = r.business_id WHERE r.business_id = ? AND r.status = 'booked' AND (${plans.map(() => '(r.id = ? AND c.id = ?)').join(' OR ')})`,
    bid, ...plans.flatMap((p) => [p.rowId, p.comparisonId])) : [];
  const joinIn = planned.filter((x) => x.postedAt >= w.from && x.postedAt < w.to);
  const joinOut = planned.filter((x) => x.postedAt < w.from || x.postedAt >= w.to);
  const booked = booked0 ? { ...booked0, n: booked0.n - joinIn.length, a: (booked0.a ?? 0) - joinIn.reduce((t, x) => t + x.amountPaise, 0) } : undefined;
  const otherPaise = other.reduce((t, x) => t + x.amountPaise, 0);
  const forBillsPaise = totalPaise - (booked?.a ?? 0) - strip.creditsLeftPaise - otherPaise - cardPaise;
  return {
    totalPaise, payments: tot.reduce((t, x) => t + x.n, 0),
    forBillsPaise,
    other: other.map((x) => ({ amountPaise: x.amountPaise, postedAt: x.postedAt, bills: x.bills, day: x.day })),
    cardPaise,
    bookedPaise: booked?.a ?? 0, booked: booked?.n ?? 0,
    leftPaise: strip.creditsLeftPaise, left: strip.creditsLeft,
    elsewhere: [...outside.map((x) => ({ amountPaise: x.amountPaise, postedAt: x.postedAt, bills: x.bills, day: shiftDayOf(x.postedAt) })),
      ...joinOut.map((x) => ({ amountPaise: x.amountPaise, postedAt: x.postedAt, bills: x.billNo, day: shiftDayOf(x.postedAt) }))],
    waiting,
  };
}
