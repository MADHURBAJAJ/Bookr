import { Hono } from 'hono';
import PostalMime from 'postal-mime';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, newId, now, one, stmt } from '../db';
import { body, fail, isUuid, text } from '../http';
import { readCardReport } from '../cardsettlement';
import { cardAddedRow, cardCandidates, cardMatchStatements, isMachineUpi, machineUpiStatements, cardRules, daysTogether, importCardLines, openSettlementCredits, ruleFor, runCardAuto, settleStatements,
  settlementCredits, settlementCosts, chargesOf, isCardCharge, unsettledDays, unsettleStatements, waitingCard, type CardPayment } from '../cards';
import { readMail, readReportFile } from '../mail';
import { repayStatements } from '../repay';
import { matchStatements } from '../bank';
import { syncCardFolder } from '../cardDrive';
import { folderIdFrom, GoogleError, serviceAccountEmail } from '../google';
import { addDays, istDay, shiftDayOf } from '../time';

export const cardRoutes = new Hono<AppEnv>();

const MAX_FILE = 3_000_000;
const AUDIT = `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const isDay = (v: string | undefined): v is string => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');
const ids = (v: unknown, max = 50) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && isUuid(x)))].slice(0, max) : []);

/** Card payments settled from..to, each with its bill (or suggestions), grouped by settlement day, with the bank credit. */
cardRoutes.get('/businesses/:businessId/cards', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const q = c.req.query();
  const to = isDay(q.to) ? q.to : istDay(Date.now());
  const from = isDay(q.from) ? q.from : addDays(to, -13);
  if (from > to) fail(400, 'From must be on or before To.');
  const [payments, matches, waiting, mails, heads] = await Promise.all([
    all<CardPayment>(db, `SELECT * FROM card_settlements WHERE business_id = ? AND settled_on BETWEEN ? AND ? ORDER BY settled_on DESC, paid_at`, bid, from, to),
    all<{ settlement_id: string; transaction_id: string; matched_at: number; bill_no: string | null; shift_day: string | null; amount_paise: number }>(db, `
      SELECT m.settlement_id, m.transaction_id, m.matched_at, t.bill_no, t.shift_day, t.amount_paise FROM card_matches m
      JOIN card_settlements s ON s.id = m.settlement_id JOIN transactions t ON t.id = m.transaction_id
      WHERE m.business_id = ? AND s.settled_on BETWEEN ? AND ?`, bid, from, to),
    waitingCard(db, bid, addDays(from, -5), to),
    all(db, `SELECT id, from_addr AS "from", subject, received_at AS receivedAt, status, note FROM inbound_mails
      WHERE business_id = ? ORDER BY received_at DESC LIMIT 10`, bid),
    all<{ id: string; name: string; tally_ledger: string | null }>(db, "SELECT id, name, tally_ledger FROM heads WHERE business_id = ? AND type = 'expense' ORDER BY name", bid),
  ]);
  const open = payments.filter((p) => !matches.some((m) => m.settlement_id === p.id));
  const sug = cardCandidates(open, waiting);
  const bankRows = await all<{ id: string; account_name: string; day: string; posted_at: number; amount_paise: number; description: string; head_name: string | null }>(db, `
    SELECT r.id, a.name AS account_name, r.day, r.posted_at, r.amount_paise, r.description, h.name AS head_name FROM bank_rows r
    JOIN accounts a ON a.id = r.account_id LEFT JOIN transactions t ON t.id = r.transaction_id LEFT JOIN heads h ON h.id = t.head_id
    WHERE r.id IN (SELECT bank_row_id FROM card_settlements WHERE business_id = ? AND settled_on BETWEEN ? AND ?)`, bid, from, to);
  const groups = new Map<string, CardPayment[]>();
  for (const p of payments) groups.set(`${p.settled_on}|${p.merchant_id}`, [...(groups.get(`${p.settled_on}|${p.merchant_id}`) ?? []), p]);
  const sum = (list: CardPayment[], k: 'amount_paise' | 'fee_paise' | 'gst_paise' | 'net_paise') => list.reduce((t, p) => t + p[k], 0);
  const settlements = await Promise.all([...groups.values()].map(async (list) => {
    const s = list[0];
    const linked = list.find((p) => p.bank_row_id)?.bank_row_id ?? null;
    const row = linked ? bankRows.find((r) => r.id === linked) ?? null : null;
    const net = sum(list, 'net_paise');
    const credits = linked ? [] : await settlementCredits(db, bid, s.settled_on, net);
    return {
      settledOn: s.settled_on, merchantId: s.merchant_id, terminals: [...new Set(list.map((p) => p.terminal_id))], files: [...new Set(list.map((p) => p.file_name))],
      amountPaise: settlementCosts(list).gross, feePaise: settlementCosts(list).fee, chargesPaise: chargesOf(list), gstPaise: settlementCosts(list).gst, netPaise: net,
      partlySettled: !!linked && list.some((p) => !p.bank_row_id),
      bank: row ? { id: row.id, accountName: row.account_name, day: row.day, postedAt: row.posted_at, amountPaise: row.amount_paise, description: row.description, feeHead: row.head_name }
        : null,
      credits: credits.map((r) => ({ id: r.id, accountName: r.account_name, day: r.day, postedAt: r.posted_at, amountPaise: r.amount_paise, description: r.description })),
      payments: list.map((p) => {
        const mine = matches.filter((m) => m.settlement_id === p.id);
        const set = mine.length ? matches.filter((m) => m.matched_at === mine[0].matched_at) : [];
        return {
          id: p.id, txnId: p.txn_id, rrn: p.rrn, paidAt: p.paid_at, shiftDay: shiftDayOf(p.paid_at), txnType: p.txn_type, amountPaise: p.amount_paise,
          feePaise: p.fee_paise, gstPaise: p.gst_paise, netPaise: p.net_paise, scheme: p.scheme, cardType: p.card_type, cardLast4: p.card_last4,
          matched: mine.length ? { bills: [...new Set(set.map((m) => m.bill_no ?? ''))], shiftDays: [...new Set(set.map((m) => m.shift_day))], payments: new Set(set.map((m) => m.settlement_id)).size } : null,
          candidates: (sug.candidates.get(p.id) ?? []).slice(0, 5), clear: sug.clear.has(p.id), charge: isCardCharge(p),
        };
      }),
    };
  }));
  const feeHead = heads.find((h) => /card|mdr|merchant/i.test(h.name)) ?? heads.find((h) => /bank charges/i.test(h.tally_ledger ?? '') || /bank charges/i.test(h.name));
  const folder = await one<{ card_drive_folder: string | null }>(db, 'SELECT card_drive_folder FROM businesses WHERE id = ?', bid);
  return c.json({
    from, to, settlements, mails, driveFolder: folder?.card_drive_folder ?? null, googleEmail: serviceAccountEmail(c.env),
    waiting: waiting.map((w) => ({ id: w.id, billNo: w.bill_no, shiftDay: w.shift_day, amountPaise: w.amount_paise, paidAt: w.paid_at })),
    feeHeads: heads.map((h) => ({ id: h.id, name: h.name })), suggestedFeeHeadId: feeHead?.id ?? null,
    rules: [...(await cardRules(db, bid)).values()],
    together: daysTogether(await unsettledDays(db, bid), await openSettlementCredits(db, bid)),
  });
});

/** A card report file dropped in by hand (the same reading as a mailed one), sent as base64 inside JSON. */
cardRoutes.post('/businesses/:businessId/cards/file', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const name = text(data, 'name', 'File name', { max: 200 })!;
  if (!/\.xlsx$/i.test(name)) fail(400, 'Choose the card company\'s Excel (.xlsx) file.');
  if (typeof data.data !== 'string' || !data.data) fail(400, 'The file is empty.');
  if (data.data.length > MAX_FILE) fail(400, 'That file is too large for a card settlement report.');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(data.data), (ch) => ch.charCodeAt(0)); } catch { fail(400, 'The file could not be read.'); }
  const r = await readCardReport(bytes);
  if (!r.lines.length) fail(400, r.problems[0] ?? 'No card payments found in this file.');
  const done = await importCardLines(db, bid, name, null, r.lines);
  await stmt(db, AUDIT, bid, c.get('user').id, 'card.import', 'card_settlements', name, null, JSON.stringify({ name, ...done }), now()).run();
  return c.json({ ...done, settledOn: [...new Set(r.lines.map((l) => l.settledOn))], problems: r.problems.slice(0, 20) });
});

/**
 * Matches card payments to card sales, one set at a time: a payment and its bill, one payment for bills paid together,
 * or one bill paid on two cards. Each set's totals must agree. Sets that cannot be matched are skipped and listed.
 */
cardRoutes.post('/businesses/:businessId/cards/match', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const sets = Array.isArray(data.sets) ? data.sets.slice(0, 200) : [];
  if (!sets.length) fail(400, 'Choose the payments to match.');
  const t = now();
  const user = c.get('user').id;
  const statements: D1PreparedStatement[] = [];
  const problems: string[] = [];
  const usedP = new Set<string>();
  const usedT = new Set<string>();
  for (const [i, s] of sets.entries()) {
    const pids = ids((s as Record<string, unknown>)?.paymentIds);
    const tids = ids((s as Record<string, unknown>)?.transactionIds);
    if (!pids.length || !tids.length || pids.some((x) => usedP.has(x)) || tids.some((x) => usedT.has(x))) { problems.push('A payment or bill was chosen twice.'); continue; }
    const q = (n: number) => Array(n).fill('?').join(',');
    const pays = await all<{ id: string; amount_paise: number; txn_type: string; matched: number }>(db, `SELECT id, amount_paise, txn_type,
      EXISTS (SELECT 1 FROM card_matches m WHERE m.settlement_id = card_settlements.id) AS matched
      FROM card_settlements WHERE business_id = ? AND id IN (${q(pids.length)})`, bid, ...pids);
    const sales = await all<{ id: string; amount_paise: number; bill_no: string | null }>(db, `SELECT id, amount_paise, bill_no FROM transactions
      WHERE business_id = ? AND type = 'income' AND payment_mode = 'card' AND match_status = 'awaiting_card_settlement' AND id IN (${q(tids.length)})`, bid, ...tids);
    if (pays.length !== pids.length || pays.some((p) => p.matched || p.txn_type !== 'PURCHASE')) { problems.push('A payment is already matched, or is not a purchase.'); continue; }
    if (sales.length !== tids.length) { problems.push('A bill is already matched, or is not a confirmed card sale.'); continue; }
    const paid = pays.reduce((x, p) => x + p.amount_paise, 0);
    const billed = sales.reduce((x, p) => x + p.amount_paise, 0);
    if (paid !== billed) { problems.push(`Bill ${sales.map((x) => x.bill_no).join(' + ')}: the card payments come to a different amount than the bills.`); continue; }
    pids.forEach((x) => usedP.add(x));
    tids.forEach((x) => usedT.add(x));
    // Each set gets its own time, so unmatching one set leaves the others of a bulk action alone.
    statements.push(...cardMatchStatements(db, bid, pids, tids, user, t + i));
  }
  if (!statements.length) fail(409, problems[0] ?? 'Nothing to match.');
  await db.batch(statements);
  return c.json({ matched: sets.length - problems.length, problems });
});

/** Unmatches a payment, with every payment and bill matched in the same action. The bills wait again. */
cardRoutes.post('/businesses/:businessId/cards/:paymentId/unmatch', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const pid = c.req.param('paymentId');
  if (!isUuid(pid)) fail(404, 'Not found.');
  const first = await one<{ matched_at: number }>(db, 'SELECT matched_at FROM card_matches WHERE business_id = ? AND settlement_id = ?', bid, pid);
  if (!first) fail(409, 'This payment is not matched.');
  const set = await all<{ id: string; settlement_id: string; transaction_id: string }>(db, 'SELECT id, settlement_id, transaction_id FROM card_matches WHERE business_id = ? AND matched_at = ?', bid, first.matched_at);
  const t = now();
  const added = await all<Record<string, unknown> & { id: string }>(db, `SELECT * FROM transactions WHERE business_id = ? AND source = 'bank_sheet'
    AND id IN (${set.map(() => '?').join(',')})`, bid, ...set.map((m) => m.transaction_id));
  await db.batch([
    stmt(db, 'DELETE FROM card_matches WHERE business_id = ? AND matched_at = ?', bid, first.matched_at),
    // A tip on the card, or a swipe booked to a head, was added with the match: it goes with it (kept in the audit log).
    ...added.map((x) => stmt(db, "DELETE FROM transactions WHERE id = ? AND source = 'bank_sheet'", x.id)),
    ...[...new Set(set.map((m) => m.transaction_id))].map((tid) => stmt(db, `UPDATE transactions SET match_status = CASE payment_mode WHEN 'card' THEN 'awaiting_card_settlement' ELSE 'awaiting_bank_match' END
      WHERE id = ? AND match_status IS NULL AND (payment_mode = 'card' OR (payment_mode = 'upi' AND matched_bank_row IS NULL))
        AND NOT EXISTS (SELECT 1 FROM card_matches m WHERE m.transaction_id = transactions.id)`, tid)),
    stmt(db, AUDIT, bid, c.get('user').id, 'card.unmatch', 'card_settlements', pid, JSON.stringify({ matches: set, added }), null, t),
  ]);
  return c.json({ ok: true });
});

/**
 * Settlement days and the bank credit that brought their net amount (one day, or days ICICI paid together): the credit is
 * booked against them, and the fee and the GST on it become two expense rows by the Card settlement rule.
 */
cardRoutes.post('/businesses/:businessId/cards/settle', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const days = (Array.isArray(data.days) ? data.days : [data.settledOn]).filter((d): d is string => typeof d === 'string' && isDay(d)).slice(0, 7);
  if (!days.length) fail(400, 'Choose the settlement day.');
  const merchantId = text(data, 'merchantId', 'Merchant ID', { max: 40 })!;
  const rowId = typeof data.bankRowId === 'string' && isUuid(data.bankRowId) ? data.bankRowId : fail(400, 'Choose the bank credit.');
  const list = await all<CardPayment>(db, `SELECT * FROM card_settlements WHERE business_id = ? AND merchant_id = ? AND settled_on IN (${days.map(() => '?').join(',')})`,
    bid, merchantId, ...days);
  if (!list.length) fail(404, 'No card payments were settled that day.');
  if (new Set(list.map((p) => p.settled_on)).size !== new Set(days).size) fail(404, 'No card payments were settled on one of those days.');
  if (list.some((p) => p.bank_row_id)) fail(409, 'This settlement is already matched to the bank.');
  const row = await one<{ id: string; account_id: string; day: string; amount_paise: number; status: string; kind: string; direction: string }>(db,
    'SELECT id, account_id, day, amount_paise, status, kind, direction FROM bank_rows WHERE id = ? AND business_id = ?', rowId, bid);
  if (!row) fail(404, 'Bank line not found.');
  if (row.status !== 'unmatched' || row.direction !== 'CR' || row.kind !== 'card_settlement') fail(409, 'Choose an open card settlement credit from the bank.');
  const net = list.reduce((t, p) => t + p.net_paise, 0);
  if (row.amount_paise !== net) fail(409, 'The bank credit is not the settlement\'s net amount.');
  const costs = settlementCosts(list);
  const charges = costs.fee + costs.gst;
  const rule = ruleFor(list, await cardRules(db, bid));
  if (charges > 0 && !rule) fail(400, 'Set the Card settlement rule on Heads and rules first.');
  await db.batch(settleStatements(db, bid, list, row, rule, c.get('user').id, now()));
  return c.json({ ok: true, feePaise: costs.fee, gstPaise: costs.gst });
});

/** Takes a settlement apart from its bank credit; the fee and GST expenses are removed (kept in the audit log). */
cardRoutes.post('/businesses/:businessId/cards/unsettle', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const rowId = typeof data.bankRowId === 'string' && isUuid(data.bankRowId) ? data.bankRowId : fail(400, 'Choose the bank credit.');
  const row = await one<{ id: string; status: string; note: string | null; transaction_id: string | null }>(db, 'SELECT id, status, note, transaction_id FROM bank_rows WHERE id = ? AND business_id = ?', rowId, bid);
  if (!row || !(await one(db, 'SELECT 1 FROM card_settlements WHERE bank_row_id = ?', rowId))) fail(404, 'This bank line is not matched to a card settlement.');
  const tx = await all(db, `SELECT * FROM transactions WHERE id IN (SELECT fee_tx_id FROM card_settlements WHERE bank_row_id = ?
    UNION SELECT gst_tx_id FROM card_settlements WHERE bank_row_id = ?)`, rowId, rowId);
  await db.batch([
    ...unsettleStatements(db, rowId),
    stmt(db, "UPDATE bank_rows SET status = 'unmatched', transaction_id = NULL, note = NULL, done_by = NULL, done_at = NULL WHERE id = ?", rowId),
    stmt(db, AUDIT, bid, c.get('user').id, 'card.unsettle', 'bank_rows', rowId, JSON.stringify({ status: row.status, note: row.note, transactions: tx }), JSON.stringify({ status: 'unmatched' }), now()),
  ]);
  return c.json({ ok: true });
});

/** Reads a stored mail again (e.g. after the reading was improved). Payments already in Bookr are not added twice. */
cardRoutes.post('/businesses/:businessId/inbound-mails/:id/read', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('id');
  if (!isUuid(id)) fail(404, 'Not found.');
  const m = await one<{ r2_key: string; subject: string }>(db, 'SELECT r2_key, subject FROM inbound_mails WHERE id = ? AND business_id = ?', id, bid);
  if (!m) fail(404, 'Mail not found.');
  const obj = await c.env.UPLOADS.get(m.r2_key);
  if (!obj) fail(404, 'The stored mail is missing.');
  // A file from the Drive folder is kept as the file itself; a mail as the whole mail.
  if (m.r2_key.endsWith('.xlsx')) {
    const r = await readReportFile(db, bid, id, m.subject, new Uint8Array(await obj.arrayBuffer()));
    const status = r.ok ? 'read' : 'failed';
    await stmt(db, 'UPDATE inbound_mails SET status = ?, note = ? WHERE id = ?', status, r.note.slice(0, 1000), id).run();
    return c.json({ status, note: r.note });
  }
  const r = await readMail(db, bid, id, await PostalMime.parse(await obj.arrayBuffer()));
  return c.json(r);
});

/** The Google Drive folder the card reports are saved into (Owner and Accountant). Empty clears it. */
cardRoutes.put('/businesses/:businessId/cards/folder', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const v = text(await body(c), 'folder', 'Drive folder link', { optional: true, max: 300 });
  const folderId = v ? folderIdFrom(v) : null;
  if (v && !folderId) fail(400, 'That does not look like a Google Drive folder link.');
  const before = await one<{ card_drive_folder: string | null }>(db, 'SELECT card_drive_folder FROM businesses WHERE id = ?', bid);
  await db.batch([
    stmt(db, 'UPDATE businesses SET card_drive_folder = ? WHERE id = ?', folderId, bid),
    stmt(db, AUDIT, bid, c.get('user').id, 'card.folder', 'businesses', bid, JSON.stringify({ folder: before?.card_drive_folder ?? null }), JSON.stringify({ folder: folderId }), now()),
  ]);
  return c.json({ ok: true, folderId });
});

/** Reads the folder's new card reports now (also done by "Sync all bank accounts"). */
cardRoutes.post('/businesses/:businessId/cards/sync', requireRole('bank.link'), async (c) => {
  try {
    const r = await syncCardFolder(c.env, c.get('businessId'));
    if (!r) fail(400, 'Set the Google Drive folder of the card reports first.');
    return c.json(r);
  } catch (e) {
    if (e instanceof GoogleError) fail(400, e.message);
    throw e;
  }
});

/** The Card settlement rule for each card machine: where its fee and the GST on the fee are booked. */
cardRoutes.get('/businesses/:businessId/cards/rules', requireRole('heads.view'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const [rules, terminals] = await Promise.all([
    cardRules(db, bid),
    all<{ terminal_id: string; merchant_id: string; payments: number }>(db, 'SELECT terminal_id, merchant_id, count(*) AS payments FROM card_settlements WHERE business_id = ? GROUP BY terminal_id, merchant_id', bid),
  ]);
  const ids = [...new Set([...terminals.map((t) => t.terminal_id), ...rules.keys()])].sort();
  return c.json({ terminals: ids.map((id) => ({ terminalId: id, merchantId: terminals.find((t) => t.terminal_id === id)?.merchant_id ?? null,
    payments: terminals.filter((t) => t.terminal_id === id).reduce((a, t) => a + t.payments, 0), rule: rules.get(id) ?? null })) });
});

/** Sets (or replaces) a card machine's rule. Settlements waiting on it are settled by Bookr straight after, where safe. */
cardRoutes.put('/businesses/:businessId/cards/rules/:terminalId', requireRole('heads.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const terminal = c.req.param('terminalId');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(terminal)) fail(400, 'That is not a card machine (terminal) ID.');
  const data = await body(c);
  const fee = typeof data.feeHeadId === 'string' && isUuid(data.feeHeadId) ? data.feeHeadId : fail(400, 'Choose the head for the card fee.');
  const gst = typeof data.gstHeadId === 'string' && isUuid(data.gstHeadId) ? data.gstHeadId : fail(400, 'Choose the head for the GST on the fee.');
  const heads = await all<{ id: string; type: string }>(db, 'SELECT id, type FROM heads WHERE business_id = ? AND id IN (?, ?)', bid, fee, gst);
  if (heads.length !== new Set([fee, gst]).size || heads.some((h) => h.type !== 'expense')) fail(400, 'The card fee and its GST go under expense heads.');
  const before = await one(db, 'SELECT fee_head_id, gst_head_id FROM card_rules WHERE business_id = ? AND terminal_id = ?', bid, terminal);
  const t = now();
  await db.batch([
    stmt(db, `INSERT INTO card_rules (id, business_id, terminal_id, fee_head_id, gst_head_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (business_id, terminal_id) DO UPDATE SET fee_head_id = excluded.fee_head_id, gst_head_id = excluded.gst_head_id`, newId(), bid, terminal, fee, gst, c.get('user').id, t),
    stmt(db, AUDIT, bid, c.get('user').id, 'card.rule', 'card_rules', terminal, before ? JSON.stringify(before) : null, JSON.stringify({ fee_head_id: fee, gst_head_id: gst }), t),
  ]);
  const auto = await runCardAuto(db, bid);
  return c.json({ ok: true, autoSettled: auto.settled, autoMatched: auto.matched });
});

/**
 * A card payment more than its bill (a tip on the card): matched, and the difference booked as a tip income row on the
 * same shift, which goes again on Unmatch.
 */
cardRoutes.post('/businesses/:businessId/cards/:paymentId/tip', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const pid = c.req.param('paymentId');
  if (!isUuid(pid)) fail(404, 'Not found.');
  const data = await body(c);
  const tid = typeof data.transactionId === 'string' && isUuid(data.transactionId) ? data.transactionId : fail(400, 'Choose the bill.');
  const p = await one<CardPayment & { matched: number }>(db, `SELECT *, EXISTS (SELECT 1 FROM card_matches m WHERE m.settlement_id = card_settlements.id) AS matched
    FROM card_settlements WHERE id = ? AND business_id = ?`, pid, bid);
  if (!p) fail(404, 'Card payment not found.');
  if (p.matched || p.txn_type !== 'PURCHASE') fail(409, 'This payment is already matched, or is not a purchase.');
  const sale = await one<{ id: string; amount_paise: number; bill_no: string | null; shift_day: string; head_id: string | null }>(db, `SELECT id, amount_paise, bill_no, shift_day, head_id
    FROM transactions WHERE id = ? AND business_id = ? AND type = 'income' AND payment_mode = 'card' AND match_status = 'awaiting_card_settlement'`, tid, bid);
  if (!sale) fail(409, 'This bill is already matched, or is not a confirmed card sale.');
  const tip = p.amount_paise - sale.amount_paise;
  if (tip <= 0 || tip > sale.amount_paise * 0.25) fail(400, 'A tip on the card is a payment a little more than its bill.');
  const head = text(data, 'headId', 'Head', { optional: true, max: 40 });
  const headId = head && isUuid(head) && await one(db, "SELECT 1 AS x FROM heads WHERE id = ? AND business_id = ? AND type = 'income'", head, bid) ? head : sale.head_id;
  const t = now();
  const tipTx = newId();
  await db.batch([
    stmt(db, `INSERT INTO transactions (id, business_id, day, amount_paise, type, head_id, narration, source, status, payment_mode, bill_no, shift_day, match_status, ocr_original, created_at)
      VALUES (?, ?, ?, ?, 'income', ?, ?, 'bank_sheet', 'approved', 'card', ?, ?, 'awaiting_card_settlement', ?, ?)`, tipTx, bid, sale.shift_day, tip, headId,
      `Tip on the card, bill ${sale.bill_no ?? ''}`, sale.bill_no, sale.shift_day, cardAddedRow('tip', pid), t),
    ...cardMatchStatements(db, bid, [pid], [tid, tipTx], c.get('user').id, t, { tipPaise: tip }),
  ]);
  return c.json({ ok: true, tipPaise: tip });
});

/** A card payment with no bill (an advance, a room payment taken on the restaurant machine): booked to an income head. */
cardRoutes.post('/businesses/:businessId/cards/:paymentId/book', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const pid = c.req.param('paymentId');
  if (!isUuid(pid)) fail(404, 'Not found.');
  const data = await body(c);
  const headId = typeof data.headId === 'string' && isUuid(data.headId) ? data.headId : fail(400, 'Choose the head.');
  const note = text(data, 'note', 'Note', { optional: true, max: 200 });
  if (!await one(db, "SELECT 1 AS x FROM heads WHERE id = ? AND business_id = ? AND type = 'income'", headId, bid)) fail(400, 'A card payment goes under an income head.');
  const p = await one<CardPayment & { matched: number }>(db, `SELECT *, EXISTS (SELECT 1 FROM card_matches m WHERE m.settlement_id = card_settlements.id) AS matched
    FROM card_settlements WHERE id = ? AND business_id = ?`, pid, bid);
  if (!p) fail(404, 'Card payment not found.');
  if (p.matched || p.txn_type !== 'PURCHASE') fail(409, 'This payment is already matched, or is not a purchase.');
  const day = shiftDayOf(p.paid_at);
  const t = now();
  const tx = newId();
  await db.batch([
    stmt(db, `INSERT INTO transactions (id, business_id, day, amount_paise, type, head_id, narration, source, status, payment_mode, shift_day, match_status, ocr_original, created_at)
      VALUES (?, ?, ?, ?, 'income', ?, ?, 'bank_sheet', 'approved', 'card', ?, 'awaiting_card_settlement', ?, ?)`, tx, bid, day, p.amount_paise, headId,
      note || `Card payment, card ${p.card_last4 ? `…${p.card_last4}` : ''} (no bill)`, day, cardAddedRow('booked', pid), t),
    ...cardMatchStatements(db, bid, [pid], [tx], c.get('user').id, t, { booked: true, headId }),
  ]);
  return c.json({ ok: true });
});

// ---- Card machine and the bank (approved 9 Nov 2026): a bill paid another way than written. A person confirms each;
// the mode change is recorded as "paid another way" (sale.repaid) and the match as usual, so both can be undone.

/** A card bill the machine never got, paid by a UPI credit of its amount: changed to UPI and matched to that credit. */
cardRoutes.post('/businesses/:businessId/cards/was-upi', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const tids = ids(data.transactionIds, 30);
  if (!tids.length) fail(400, 'Choose the bill.');
  const rowId = typeof data.bankRowId === 'string' && isUuid(data.bankRowId) ? data.bankRowId : fail(400, 'Choose the bank credit.');
  const row = await one<{ id: string; kind: string; direction: string; status: string; amount_paise: number }>(db,
    'SELECT id, kind, direction, status, amount_paise FROM bank_rows WHERE id = ? AND business_id = ?', rowId, bid);
  if (!row) fail(404, 'Bank line not found.');
  if (row.kind !== 'upi_in' || row.direction !== 'CR' || row.status !== 'unmatched') fail(409, 'Choose an open UPI credit.');
  const sales = await all<{ payment_mode: string }>(db, `SELECT payment_mode FROM transactions WHERE business_id = ? AND id IN (${tids.map(() => '?').join(',')})`, bid, ...tids);
  if (sales.some((x) => x.payment_mode !== 'card')) fail(409, 'Only a card bill is changed here.');
  const t = now();
  const user = c.get('user').id;
  const r = await repayStatements(db, bid, tids, 'upi', 'Paid by UPI, not on the card machine: the bank credit shows it (Reconcile)', user, t);
  if (r.amountPaise !== row.amount_paise) fail(409, 'The bank credit is not the bill\'s amount.');
  const done = await db.batch([...r.statements, ...matchStatements(db, bid, row.id, tids, user, t + 1)]);
  return c.json({ ok: true, bills: r.bills, auditId: done[r.statements.length - 1]?.meta.last_row_id ?? null });
});

/**
 * UPI paid on the card machine (approved 9 Nov 2026): the bill stays UPI (a cash bill becomes UPI, recorded as paid
 * another way) and is matched to the machine payment; it is received through the machine's settlement.
 */
cardRoutes.post('/businesses/:businessId/cards/:paymentId/upi-on-machine', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const pid = c.req.param('paymentId');
  if (!isUuid(pid)) fail(404, 'Not found.');
  const tids = ids((await body(c)).transactionIds, 30);
  if (!tids.length) fail(400, 'Choose the bill.');
  const p = await one<CardPayment & { matched: number }>(db, `SELECT *, EXISTS (SELECT 1 FROM card_matches m WHERE m.settlement_id = card_settlements.id) AS matched
    FROM card_settlements WHERE id = ? AND business_id = ?`, pid, bid);
  if (!p) fail(404, 'Card payment not found.');
  if (p.matched || p.txn_type !== 'PURCHASE' || !isMachineUpi(p)) fail(409, 'Choose a UPI payment on the machine that is not matched yet.');
  const sales = await all<{ id: string; amount_paise: number; payment_mode: string; match_status: string | null; matched_bank_row: string | null }>(db,
    `SELECT id, amount_paise, payment_mode, match_status, matched_bank_row FROM transactions WHERE business_id = ? AND type = 'income' AND id IN (${tids.map(() => '?').join(',')})`, bid, ...tids);
  if (sales.length !== tids.length) fail(404, 'A sale was not found.');
  if (sales.some((x) => !(x.payment_mode === 'upi' && x.match_status === 'awaiting_bank_match' && !x.matched_bank_row) && !(x.payment_mode === 'cash' && x.match_status == null)))
    fail(409, 'Only a UPI bill still waiting for its money, or a cash bill, is matched here.');
  if (sales.reduce((t, x) => t + x.amount_paise, 0) !== p.amount_paise) fail(409, 'The payment is not the bill\'s amount.');
  const t = now();
  const user = c.get('user').id;
  const cash = sales.filter((x) => x.payment_mode === 'cash').map((x) => x.id);
  const r = cash.length ? await repayStatements(db, bid, cash, 'upi', 'Paid by UPI on the card machine: the card report shows it (Reconcile)', user, t) : null;
  const done = await db.batch([...(r?.statements ?? []), ...machineUpiStatements(db, bid, pid, tids, user, t + 1, 'UPI on the machine, matched by a person')]);
  return c.json({ ok: true, auditId: r ? done[r.statements.length - 1]?.meta.last_row_id ?? null : null });
});

/** A machine payment whose bill was written as UPI or cash: the bill is changed to card and matched to the payment. */
cardRoutes.post('/businesses/:businessId/cards/:paymentId/was-card', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const pid = c.req.param('paymentId');
  if (!isUuid(pid)) fail(404, 'Not found.');
  const tids = ids((await body(c)).transactionIds, 30);
  if (!tids.length) fail(400, 'Choose the bill.');
  const p = await one<CardPayment & { matched: number }>(db, `SELECT *, EXISTS (SELECT 1 FROM card_matches m WHERE m.settlement_id = card_settlements.id) AS matched
    FROM card_settlements WHERE id = ? AND business_id = ?`, pid, bid);
  if (!p) fail(404, 'Card payment not found.');
  if (p.matched || p.txn_type !== 'PURCHASE') fail(409, 'This payment is already matched, or is not a purchase.');
  if (isMachineUpi(p)) fail(409, 'This was paid by UPI on the machine: the bill stays UPI. Match it as UPI on the machine.');
  const t = now();
  const user = c.get('user').id;
  const r = await repayStatements(db, bid, tids, 'card', `Paid on the card machine (card): the card report shows it (Reconcile)`, user, t);
  if (r.amountPaise !== p.amount_paise) fail(409, 'The card payment is not the bill\'s amount.');
  const done = await db.batch([...r.statements, ...cardMatchStatements(db, bid, [pid], tids, user, t + 1)]);
  return c.json({ ok: true, bills: r.bills, auditId: done[r.statements.length - 1]?.meta.last_row_id ?? null });
});
