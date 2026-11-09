import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, newId, now, one, stmt } from '../db';
import { body, fail, isUuid, optionalPaise, text } from '../http';
import { parseStatementRows, parseStatementText } from '../bankstatement';
import { GoogleError, readSheet, serviceAccountEmail, sheetIdFrom } from '../google';
import { allocate, getRow, importLines, loadRules, matchedSet, matchStatements, ruleFor, settleOnCredit, suggestionsFor, type BankRow } from '../bank';
import { byName, inText, loadHistory, loadParties, pickHead, resolveVendor } from '../parties';
import { adjustStatements } from '../bankadjust';
import { fixBillStatements, undoAll } from '../billfix';
import { repaidFor, repayStatements, undoRepayStatements } from '../repay';
import { cashOver, shiftCards } from '../cards';
import { explainShift } from '../explain';
import { reconcileShift, trialReconcile, unmatchedEntries } from '../reconcile';
import { bookedTx, joinedBill, sameSaleStatements, undoSameSaleStatements, waitingBillsLike } from '../sameSale';
import { billDistance, plannedUpiPaise, shiftChoices, WATCH_DAYS } from '../sales';
import { istDay, shiftWindow } from '../time';
import { accountLabels, columnHints } from '../columnHints';
import { shiftSlips, slipFixStatements } from '../slips';
import { unsettleStatements } from '../cards';
import { cardReportsStatus, syncCardFolder } from '../cardDrive';
import { shiftEntries } from '../entries';

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
      (SELECT max(day) FROM bank_rows r WHERE r.account_id = a.id) AS lastDay
    FROM accounts a LEFT JOIN bank_sources s ON s.account_id = a.id
    WHERE a.business_id = ? AND a.kind = 'bank' ORDER BY a.name`, bid);
  return c.json({ accounts, googleEmail: serviceAccountEmail(c.env), cards: await cardReportsStatus(c.env, c.get('businessId')) });
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
  const [rules, sug, parties, history] = await Promise.all([loadRules(db, bid), suggestionsFor(db, bid, from, to), loadParties(db, bid), loadHistory(db, bid)]);
  const plainNote = (v: string | null) => (v && !/^(UPI|UPI Pay|NA|NO REMARKS?|Payment from Ph|Sent using Payt|Paid via SuperM|Paid via CRED|Scan and Pay|Paid securely v|Navi UPI|Paid in seconds)$/i.test(v.trim()) ? v.trim() : '');
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
          return { item, party: party?.name ?? null, headId: head?.headId ?? rule?.head_id ?? null, headChoices: head?.choices ?? [], learned: !!head?.headId };
        })() : null,
        clear: sug.clear.has(r.id),
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
  const r = await repayStatements(db, bid, ids, mode, note, c.get('user').id, now());
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

bankRoutes.post('/businesses/:businessId/shifts/:day/choices', requireRole('bank.link'), async (c) => {
  const day = c.req.param('day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'Unknown shift.');
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const rowId = typeof data.bankRowId === 'string' && isUuid(data.bankRowId) ? data.bankRowId : fail(400, 'Choose the bank credit.');
  const cids = Array.isArray(data.comparisonIds) ? [...new Set(data.comparisonIds.filter((x): x is string => typeof x === 'string' && isUuid(x)))].slice(0, 30) : [];
  if (!cids.length) fail(400, 'Choose the bill.');
  const shift = await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', bid, day);
  if (!shift) fail(404, 'Unknown shift.');
  if (shift.status === 'confirmed') fail(409, 'This shift is saved: match it on Reconcile directly.');
  const row = await one<{ kind: string; direction: string; status: string; amount_paise: number }>(db,
    'SELECT kind, direction, status, amount_paise FROM bank_rows WHERE id = ? AND business_id = ?', rowId, bid);
  if (!row) fail(404, 'Bank line not found.');
  if (row.kind !== 'upi_in' || row.direction !== 'CR' || row.status !== 'unmatched') fail(409, 'Choose an open UPI credit.');
  const found = await all<{ id: string }>(db, `SELECT id FROM bill_comparisons WHERE business_id = ? AND shift_day = ? AND id IN (${cids.map(() => '?').join(',')})`, bid, day, ...cids);
  if (found.length !== cids.length) fail(404, 'A bill was not found in this shift.');
  const taken = (await shiftChoices(db, bid, day)).some((k) => k.comparisonIds.some((x) => cids.includes(x)));
  if (taken) fail(409, 'A bill is already matched on save.');
  const upi = await plannedUpiPaise(db, bid, day, cids);
  if (upi !== row.amount_paise) fail(409, upi ? 'The credit is not what these bills take by UPI.' : 'These bills have no UPI payment: decide or correct them first.');
  const id = newId();
  try {
    await db.batch([
      stmt(db, `INSERT INTO shift_choices (id, business_id, shift_day, kind, bank_row_id, comparison_ids, created_by, created_at) VALUES (?, ?, ?, 'bank_match', ?, ?, ?, ?)`,
        id, bid, day, rowId, JSON.stringify(cids), c.get('user').id, now()),
      stmt(db, AUDIT, bid, c.get('user').id, 'shift.choice', rowId, null, JSON.stringify({ shiftDay: day, comparisonIds: cids }), now()),
    ]);
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) fail(409, 'This credit is already matched on save.');
    throw e;
  }
  return c.json({ ok: true, id });
});

bankRoutes.delete('/businesses/:businessId/shifts/:day/choices/:id', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('id');
  if (!isUuid(id)) fail(404, 'Not found.');
  const k = await one<{ bank_row_id: string; comparison_ids: string; shift_day: string }>(db, 'SELECT bank_row_id, comparison_ids, shift_day FROM shift_choices WHERE id = ? AND business_id = ?', id, bid);
  if (!k || k.shift_day !== c.req.param('day')) fail(404, 'Not found, or already saved.');
  await db.batch([
    stmt(db, 'DELETE FROM shift_choices WHERE id = ?', id),
    stmt(db, AUDIT, bid, c.get('user').id, 'shift.choice_undone', k.bank_row_id, JSON.stringify({ shiftDay: k.shift_day, comparisonIds: JSON.parse(k.comparison_ids) }), null, now()),
  ]);
  return c.json({ ok: true });
});

/** Reconcile's Cash, UPI and Card tabs: every bill of the shift under its mode, with its evidence and its changes. */
bankRoutes.get('/businesses/:businessId/shifts/:day/entries', requireRole('bank.link'), async (c) => {
  const day = c.req.param('day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'Unknown shift.');
  return c.json(await shiftEntries(c.env.DB, c.get('businessId'), day));
});

bankRoutes.get('/businesses/:businessId/shifts/:day/reconcile', requireRole('bank.link'), async (c) => {
  const day = c.req.param('day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'Unknown shift.');
  const db = c.env.DB;
  const bid = c.get('businessId');
  const shifts = await all<{ day: string; status: string }>(db, 'SELECT shift_day AS day, status FROM shifts WHERE business_id = ? ORDER BY shift_day DESC LIMIT 60', bid);
  const status = (await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', bid, day))?.status;
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
  const slips = await shiftSlips(db, bid, day, leftIds.filter((id) => !hinted.has(id)));
  // The card picture (approved 8 Nov 2026), for a confirmed shift: its card sales are made on confirm.
  // Credits the UPI side already offers to a bill are not offered to a card bill as well.
  const offered = 'clear' in r ? new Set([...r.clear, ...r.likely].map((x) => x.creditId)) : new Set<string>();
  const cards = status === 'confirmed' ? await shiftCards(db, bid, day, await cashOver(db, bid, day), offered) : null;
  // What the card side explains is told there, and counted once (approved 9 Nov 2026).
  if (cards && 'left' in r) {
    const w = shiftWindow(day);
    const cr = new Set(cards.explains.credits.filter((x) => x.postedAt >= w.from && x.postedAt < w.to).map((x) => x.id));
    const bl = new Set(cards.explains.bills.filter((x) => x.shiftDay === day).map((x) => x.id));
    const crPaise = (await Promise.all([...cr].map((id) => one<{ a: number }>(db, 'SELECT amount_paise AS a FROM bank_rows WHERE id = ?', id)))).reduce((t, x) => t + (x?.a ?? 0), 0);
    const blPaise = (await Promise.all([...bl].map((id) => one<{ a: number }>(db, 'SELECT amount_paise AS a FROM transactions WHERE id = ?', id)))).reduce((t, x) => t + (x?.a ?? 0), 0);
    r.strip.creditsLeft -= cr.size; r.strip.creditsLeftPaise -= crPaise;
    r.strip.billsLeft -= bl.size; r.strip.billsLeftPaise -= blPaise;
    r.noBill = r.noBill.filter((x) => !cr.has(x.creditId));
    r.strip.creditsNoBill = r.noBill.length;
  }
  return c.json({ ...r, confirmed: status === 'confirmed', shifts, columnHints: hints, slips, cards });
});

bankRoutes.get('/businesses/:businessId/unmatched', requireRole('bank.link'), async (c) => c.json(await unmatchedEntries(c.env.DB, c.get('businessId'))));

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
  if (days <= WATCH_DAYS) fail(400, `This bill is watched for ${WATCH_DAYS} days; it can be closed after that.`);
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
  await db.batch([stmt(db, AUDIT, ...audit(bid, c.get('user').id, 'bank.same_sale_planned', rowId, null, { comparisonId: cmp.id, shiftDay: cmp.shift_day }, now()))]);
  return c.json({ ok: true });
});

bankRoutes.delete('/businesses/:businessId/comparisons/:id/same-sale', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const rowId = (await body(c)).rowId;
  if (typeof rowId !== 'string' || !isUuid(rowId)) fail(400, 'Choose the credit.');
  await db.batch([stmt(db, AUDIT, ...audit(c.get('businessId'), c.get('user').id, 'bank.same_sale_unplanned', rowId, null, { comparisonId: c.req.param('id') }, now()))]);
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
  const items = (Array.isArray(data.items) ? data.items : []).slice(0, 300) as { rowId?: unknown; headId?: unknown; party?: unknown; item?: unknown; billType?: unknown }[];
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
    try {
      const p = await partyStatements(db, bid, row, partyName, item, chosen, ctx);
      if (!p.headId) { skipped.push(`${row.tran_id}: choose a head.`); continue; }
      const book = await bookStatements(db, bid, row, p.headId, p.partyId, unbilled ? 'Unbilled sale' : null, user, t, unbilled ? `unbilled ${unbilled} sale` : 'chosen in a list', item);
      statements.push(...p.statements, ...book);
      if (p.partyId) ctx.history.unshift({ party_id: p.partyId, head_id: p.headId, narration: item ?? row.remark });
      booked += 1;
    } catch (e) { skipped.push(`${row.tran_id}: ${(e as Error).message}`); }
  }
  for (let i = 0; i < statements.length; i += 90) await db.batch(statements.slice(i, i + 90));
  return c.json({ booked, skipped });
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
  // A credit joined to a later bill goes back to being booked, as it was.
  if (await joinedBill(db, row.id)) {
    const back = await undoSameSaleStatements(db, bid, row.id, c.get('user').id, now());
    if (back) { await db.batch(back); return c.json({ ok: true, unmatched: 1, bookingRestored: true }); }
  }
  // Credits that share a bill are undone together, so no bill is left half matched.
  const set = await matchedSet(db, row.id);
  const inRows = set.rows.map(() => '?').join(',');
  const differences = await all(db, `SELECT * FROM transactions WHERE business_id = ? AND source = 'bank_sheet' AND matched_bank_row IN (${inRows})`, bid, ...set.rows);
  const t = now();
  const undo = await undoAll(db, bid, set.rows, c.get('user').id, t);
  await db.batch([
    ...undo,
    stmt(db, `UPDATE transactions SET matched_bank_row = NULL, match_status = 'awaiting_bank_match' WHERE business_id = ? AND source = 'software_report'
      AND (matched_bank_row IN (${inRows}) OR id IN (SELECT transaction_id FROM bank_matches WHERE bank_row_id IN (${inRows})))`, bid, ...set.rows, ...set.rows),
    stmt(db, `DELETE FROM bank_matches WHERE bank_row_id IN (${inRows})`, ...set.rows),
    stmt(db, `DELETE FROM transactions WHERE business_id = ? AND source = 'bank_sheet' AND matched_bank_row IN (${inRows}) AND id NOT IN (SELECT transaction_id FROM bank_rows WHERE transaction_id IS NOT NULL)`, bid, ...set.rows),
    stmt(db, `UPDATE bank_rows SET status = 'unmatched', done_by = NULL, done_at = NULL WHERE status = 'matched' AND id IN (${inRows})`, ...set.rows),
    stmt(db, AUDIT, ...audit(bid, c.get('user').id, 'bank.unmatch', row.id, { status: 'matched', set: set.rows, differences }, { status: 'unmatched', billsRestored: undo.length > 0 }, t)),
  ]);
  return c.json({ ok: true, unmatched: set.rows.length });
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

async function bookStatements(db: D1Database, bid: string, row: BankRow, headId: string, partyId: string | null, note: string | null, user: string, t: number, how: string, item: string | null = null) {
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
    stmt(db, AUDIT, ...audit(bid, user, 'bank.book', row.id, { status: 'unmatched' }, { status: 'booked', headId, partyId, item, note, how, transactionId: txId }, t)),
  ];
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
  // Asked first by the screens: a bill of this amount waiting means booking this too may count one sale twice.
  if (data.checkBills === true && row.kind === 'upi_in') {
    const bills = await waitingBillsLike(db, bid, row.amount_paise, row.day);
    if (bills.length) return c.json({ ok: false, waitingBills: bills });
  }
  const t = now();
  const statements: D1PreparedStatement[] = [];
  let partyId: string | null = null;
  if (partyName) {
    const p = byName(await loadParties(db, bid), partyName);
    partyId = p?.id ?? newId();
    if (!p) statements.push(stmt(db, 'INSERT INTO parties (id, business_id, name, aliases, default_head_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', partyId, bid, partyName, '[]', headId, t));
  }
  statements.push(...(await bookStatements(db, bid, row, headId, partyId, note, c.get('user').id, t, 'by hand')));
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

/** Undo: a booked line's transaction is removed (kept in the audit log); an ignored line opens again. */
bankRoutes.post('/businesses/:businessId/bank-rows/:rowId/reopen', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const row = await getRow(db, bid, c.req.param('rowId'));
  if (!row) fail(404, 'Not found.');
  if (row.status !== 'booked' && row.status !== 'ignored') fail(409, 'Only a booked or ignored line can be opened again. Unmatch a matched one.');
  const tx = row.transaction_id ? await one(db, 'SELECT * FROM transactions WHERE id = ?', row.transaction_id) : null;
  const t = now();
  await db.batch([
    // A card settlement booked against this credit comes apart with it.
    ...unsettleStatements(db, row.id),
    stmt(db, "UPDATE bank_rows SET status = 'unmatched', transaction_id = NULL, note = NULL, done_by = NULL, done_at = NULL WHERE id = ?", row.id),
    ...(row.transaction_id ? [stmt(db, "DELETE FROM transactions WHERE id = ? AND source = 'bank_sheet'", row.transaction_id)] : []),
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


