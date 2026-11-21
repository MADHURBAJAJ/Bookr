// School cash book (approved 20 Nov 2026). See src/cashbook.ts and migration 0030.
// Who can do what, with the existing roles:
// - Owner and Accountant: set up branches and books (accounts.edit), see every book, write in any book, tick cash
//   handed to a person, match a deposit to the bank statement (rows.approve).
// - Entry staff (the cashier): see and write only the books they keep (rows.edit), accept cash sent to their book.
// - Viewer: sees every book, changes nothing.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, isUniqueViolation, newId, now, one, stmt, type DB } from '../db';
import { body, date, fail, isUuid, paise, signInSql, text } from '../http';
import { bookDay, bookFor, booksOf, depositCandidates, handovers, inHandThrough, seesAllBooks, type HandoverRow } from '../cashbook';
import { can } from '../permissions';

export const cashBookRoutes = new Hono<AppEnv>();

const audit = (db: DB, e: { businessId: string; userId: string; action: string; table: string; rowId: string; before?: unknown; after?: unknown; at: number }) =>
  stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    e.businessId, e.userId, e.action, e.table, e.rowId, e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after), e.at);

const today = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
const dayParam = (v: string | undefined) => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) fail(400, 'Day must be a date (YYYY-MM-DD).');
  return v;
};
const id404 = (v: string | undefined, what: string) => { if (!isUuid(v)) fail(404, `${what} not found.`); return v; };

// ---- Every book the caller may see, with cash in hand today, and cash handed over not yet shown on the other side.

cashBookRoutes.get('/businesses/:businessId/cashbooks', requireRole('business.view'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const role = c.get('role');
  const user = c.get('user');
  const t = today();
  const books = await booksOf(db, bid, user.id, role);
  const mine = new Set(books.map((b) => b.id));
  const [branches, counts, open, done] = await Promise.all([
    all<{ id: string; name: string }>(db, 'SELECT id, name FROM branches WHERE business_id = ? ORDER BY name', bid),
    all<{ accountId: string; day: string; countedPaise: number }>(db, `SELECT account_id AS accountId, day, counted_paise AS countedPaise FROM cash_counts c
      WHERE business_id = ? AND day = (SELECT max(day) FROM cash_counts x WHERE x.account_id = c.account_id)`, bid),
    handovers(db, bid, "AND h.status = 'sent'"),
    handovers(db, bid, "AND h.status <> 'sent' AND h.settled_at >= ?", now() - 7 * 86400000),
  ]);
  const lastCount = new Map(counts.map((x) => [x.accountId, x]));
  const withCash = await Promise.all(books.map(async (b) => {
    const k = lastCount.get(b.id);
    const atCount = k ? await inHandThrough(db, b, k.day) : null;
    return { ...b, inHandPaise: await inHandThrough(db, b, t), lastCount: k ? { day: k.day, countedPaise: k.countedPaise, gapPaise: k.countedPaise - atCount! } : null };
  }));
  // A cashier sees what their own books sent and what was sent to them; the others see it all.
  const visible = (h: HandoverRow) => seesAllBooks(role) || mine.has(h.fromAccountId) || (h.toKind === 'book' && mine.has(h.toAccountId!));
  const setup = can(role, 'accounts.edit');
  const [members, banks] = setup || can(role, 'rows.approve') ? await Promise.all([
    setup ? all<{ id: string; name: string; email: string; role: string }>(db, `SELECT u.id, u.name, ${signInSql('u')} AS email, m.role FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.business_id = ? ORDER BY u.name`, bid) : Promise.resolve([]),
    all<{ id: string; name: string }>(db, "SELECT id, name FROM accounts WHERE business_id = ? AND kind = 'bank' ORDER BY name", bid),
  ]) : [[], []];
  // Inviting a cashier by phone from their book (21 Nov 2026): the Owner sees each book's pending invite and whether
  // its cashier has signed in.
  const invite = can(role, 'members.manage');
  const [pending, active] = invite ? await Promise.all([
    all<{ accountId: string; phone: string | null; createdAt: number }>(db, `SELECT account_id AS accountId, phone, created_at AS createdAt FROM invites
      WHERE business_id = ? AND account_id IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`, bid, now()),
    all<{ id: string; lastActiveAt: number | null }>(db, `SELECT u.id, u.last_active_at AS lastActiveAt FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.business_id = ?`, bid),
  ]) : [[], []];
  const pendingOf = new Map(pending.map((p) => [p.accountId, { phone: p.phone, createdAt: p.createdAt }]));
  const activeOf = new Map(active.map((a) => [a.id, a.lastActiveAt]));
  const booksShown = withCash.map((b) => ({ ...b, invite: pendingOf.get(b.id) ?? null,
    cashierLastActive: b.cashierUserId ? activeOf.get(b.cashierUserId) ?? null : null }));
  const openShown = await Promise.all(open.filter(visible).map(async (h) => ({
    ...h, deposits: h.toKind === 'bank' && can(role, 'rows.approve') ? await depositCandidates(db, bid, h) : [],
  })));
  return c.json({
    today: t, branches, books: booksShown, handovers: openShown, done: done.filter(visible),
    members, banks, can: { setup, invite, approve: can(role, 'rows.approve'), write: can(role, 'rows.edit') },
  });
});

// ---- Set up: branches, and books (a cash account with a branch and a cashier).

cashBookRoutes.post('/businesses/:businessId/branches', requireRole('accounts.edit'), async (c) => {
  const name = text(await body(c), 'name', 'Branch name', { max: 80 })!;
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = newId();
  const t = now();
  try {
    await db.batch([
      stmt(db, 'INSERT INTO branches (id, business_id, name, created_at) VALUES (?, ?, ?, ?)', id, bid, name, t),
      audit(db, { businessId: bid, userId: c.get('user').id, action: 'branch.create', table: 'branches', rowId: id, after: { name }, at: t }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'A branch with this name already exists.');
    throw e;
  }
  return c.json({ id }, 201);
});

async function bookInput(db: DB, bid: string, data: Record<string, unknown>) {
  const branchId = typeof data.branchId === 'string' && data.branchId ? data.branchId : null;
  const cashierUserId = typeof data.cashierUserId === 'string' && data.cashierUserId ? data.cashierUserId : null;
  if (!branchId) fail(400, 'Choose the branch.');
  if (!isUuid(branchId) || !(await one(db, 'SELECT 1 AS ok FROM branches WHERE id = ? AND business_id = ?', branchId, bid))) fail(400, 'Choose the branch.');
  if (cashierUserId && (!isUuid(cashierUserId) || !(await one(db, 'SELECT 1 AS ok FROM memberships WHERE user_id = ? AND business_id = ?', cashierUserId, bid)))) {
    fail(400, 'The cashier must be a user of this business. Invite them first on Users and roles.');
  }
  return { branchId, cashierUserId };
}

cashBookRoutes.post('/businesses/:businessId/cashbooks', requireRole('accounts.edit'), async (c) => {
  const data = await body(c);
  const db = c.env.DB;
  const bid = c.get('businessId');
  const name = text(data, 'name', 'Book name', { max: 120 })!;
  const { branchId, cashierUserId } = await bookInput(db, bid, data);
  const opening = paise(data, 'openingBalance', 'Opening cash');
  const openingDate = date(data, 'openingDate', 'Opening date');
  const id = newId();
  const t = now();
  try {
    await db.batch([
      stmt(db, `INSERT INTO accounts (id, business_id, name, kind, opening_balance_paise, opening_date, created_at, branch_id, cashier_user_id)
        VALUES (?, ?, ?, 'cash', ?, ?, ?, ?, ?)`, id, bid, name, opening, openingDate, t, branchId, cashierUserId),
      audit(db, { businessId: bid, userId: c.get('user').id, action: 'cashbook.create', table: 'accounts', rowId: id,
        after: { name, branchId, cashierUserId, openingBalancePaise: opening, openingDate }, at: t }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'An account with this name already exists.');
    throw e;
  }
  return c.json({ id }, 201);
});

cashBookRoutes.patch('/businesses/:businessId/cashbooks/:accountId', requireRole('accounts.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const book = await bookFor(db, bid, id404(c.req.param('accountId'), 'Cash book'), user.id, c.get('role'));
  const { branchId, cashierUserId } = await bookInput(db, bid, await body(c));
  const t = now();
  await db.batch([
    stmt(db, 'UPDATE accounts SET branch_id = ?, cashier_user_id = ? WHERE id = ? AND business_id = ?', branchId, cashierUserId, book.id, bid),
    audit(db, { businessId: bid, userId: user.id, action: 'cashbook.update', table: 'accounts', rowId: book.id,
      before: { branchId: book.branchId, cashierUserId: book.cashierUserId }, after: { branchId, cashierUserId }, at: t }),
  ]);
  return c.json({ ok: true });
});

// ---- One day of a book.

cashBookRoutes.get('/businesses/:businessId/cashbooks/:accountId/day/:day', requireRole('business.view'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const role = c.get('role');
  const user = c.get('user');
  const book = await bookFor(db, bid, id404(c.req.param('accountId'), 'Cash book'), user.id, role);
  const day = dayParam(c.req.param('day'));
  const [d, heads, targets, banks, people] = await Promise.all([
    bookDay(db, bid, book, day),
    all<{ id: string; name: string; type: string }>(db, 'SELECT id, name, type FROM heads WHERE business_id = ? ORDER BY type, name', bid),
    all<{ id: string; name: string; branchName: string | null; cashierName: string | null }>(db, `SELECT a.id, a.name, b.name AS branchName, u.name AS cashierName
      FROM accounts a LEFT JOIN branches b ON b.id = a.branch_id LEFT JOIN users u ON u.id = a.cashier_user_id
      WHERE a.business_id = ? AND a.kind = 'cash' AND a.id <> ? AND (a.branch_id IS NOT NULL OR a.cashier_user_id IS NOT NULL) ORDER BY b.name, a.name`, bid, book.id),
    all<{ id: string; name: string }>(db, "SELECT id, name FROM accounts WHERE business_id = ? AND kind = 'bank' ORDER BY name", bid),
    all<{ name: string }>(db, `SELECT DISTINCT p.name FROM cash_handovers h JOIN parties p ON p.id = h.to_party_id WHERE h.business_id = ? ORDER BY p.name`, bid),
  ]);
  const canWrite = can(role, 'rows.edit') && (seesAllBooks(role) || book.cashierUserId === user.id);
  return c.json({ ...d, today: today(), heads, targets, banks, people: people.map((p) => p.name), can: { write: canWrite, approve: can(role, 'rows.approve') } });
});

// ---- Add a line: a fee, an expense, other money in or out, or cash handed over (to a book, a person or the bank).

const KINDS = ['fee', 'other_in', 'expense', 'other_out', 'handover_out'] as const;

async function writableBook(c: Context<AppEnv>) {
  const role = c.get('role');
  const user = c.get('user');
  const book = await bookFor(c.env.DB, c.get('businessId'), id404(c.req.param('accountId'), 'Cash book'), user.id, role);
  if (!seesAllBooks(role) && book.cashierUserId !== user.id) fail(403, 'Only this book\'s cashier can write in it.');
  return book;
}

cashBookRoutes.post('/businesses/:businessId/cashbooks/:accountId/entries', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const book = await writableBook(c);
  const data = await body(c);
  const kind = data.kind as (typeof KINDS)[number];
  if (!KINDS.includes(kind)) fail(400, 'Choose what this line is: fee, expense, other money in or out, or hand over.');
  const day = date(data, 'day', 'Day');
  if (day < book.openingDate) fail(400, `This book starts on ${book.openingDate}.`);
  if (day > today()) fail(400, 'That day has not come yet.');
  const amount = paise(data, 'amount', 'Amount');
  if (amount <= 0) fail(400, 'Amount must be more than ₹0.');
  const narration = text(data, 'narration', 'Details', { optional: true, max: 200 });
  let headId: string | null = null;
  if (kind === 'expense') {
    headId = typeof data.headId === 'string' && data.headId ? data.headId : null;
    if (!headId || !isUuid(headId) || !(await one(db, "SELECT 1 AS ok FROM heads WHERE id = ? AND business_id = ? AND type = 'expense'", headId, bid))) fail(400, 'Choose the expense head.');
  }
  const entryId = newId();
  const t = now();
  const st: D1PreparedStatement[] = [];
  let to: { kind: 'book' | 'person' | 'bank'; accountId: string | null; partyId: string | null; name: string } | null = null;
  if (kind === 'handover_out') {
    const x = (data.to ?? {}) as Record<string, unknown>;
    if (x.kind === 'book' || x.kind === 'bank') {
      const accountId = typeof x.accountId === 'string' && isUuid(x.accountId) ? x.accountId : null;
      const a = accountId ? await one<{ name: string }>(db, 'SELECT name FROM accounts WHERE id = ? AND business_id = ? AND kind = ?', accountId, bid, x.kind === 'bank' ? 'bank' : 'cash') : null;
      if (!a) fail(400, x.kind === 'bank' ? 'Choose the bank account.' : 'Choose the cashier\'s book.');
      if (accountId === book.id) fail(400, 'Cash cannot be handed to the same book.');
      to = { kind: x.kind, accountId, partyId: null, name: a.name };
    } else if (x.kind === 'person') {
      const name = text(x, 'name', 'Person\'s name', { max: 80 })!;
      const found = await one<{ id: string; name: string }>(db, 'SELECT id, name FROM parties WHERE business_id = ? AND lower(name) = lower(?)', bid, name);
      const partyId = found?.id ?? newId();
      if (!found) st.push(stmt(db, 'INSERT INTO parties (id, business_id, name, created_at) VALUES (?, ?, ?, ?)', partyId, bid, name, t));
      to = { kind: 'person', accountId: null, partyId, name: found?.name ?? name };
    } else fail(400, 'Say who the cash went to: another cashier, a person, or the bank.');
  }
  st.push(stmt(db, `INSERT INTO cash_entries (id, business_id, account_id, day, kind, amount_paise, head_id, narration, entered_by, entered_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, entryId, bid, book.id, day, kind, amount, headId, narration, user.id, t, t));
  if (to) {
    st.push(stmt(db, `INSERT INTO cash_handovers (id, business_id, from_entry_id, to_kind, to_account_id, to_party_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId(), bid, entryId, to.kind, to.accountId, to.partyId, t));
  }
  st.push(audit(db, { businessId: bid, userId: user.id, action: 'cashbook.entry.add', table: 'cash_entries', rowId: entryId,
    after: { bookId: book.id, day, kind, amountPaise: amount, headId, narration, to: to ? { kind: to.kind, name: to.name } : null }, at: t }));
  await db.batch(st);
  return c.json({ id: entryId }, 201);
});

// Removing a line. Cash handed over that the other side already shows is undone there first. A line accepting cash from
// another book can be removed: the handover goes back to waiting.
cashBookRoutes.delete('/businesses/:businessId/cashbooks/:accountId/entries/:entryId', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const book = await writableBook(c);
  const entryId = id404(c.req.param('entryId'), 'Line');
  const e = await one<{ id: string; kind: string; day: string; amountPaise: number; narration: string | null; feeReportId: string | null }>(db,
    'SELECT id, kind, day, amount_paise AS amountPaise, narration, fee_report_id AS feeReportId FROM cash_entries WHERE id = ? AND account_id = ? AND business_id = ?', entryId, book.id, bid);
  if (!e) fail(404, 'Line not found.');
  if (e.feeReportId) fail(409, 'This line comes from the fee report. Bring in the day\'s report again to change it.');
  const h = await one<{ id: string; status: string }>(db, 'SELECT id, status FROM cash_handovers WHERE from_entry_id = ?', e.id);
  if (h && h.status !== 'sent') fail(409, 'The other side already shows this cash. Undo it there first.');
  const t = now();
  await db.batch([
    stmt(db, "UPDATE cash_handovers SET to_entry_id = NULL, status = 'sent', settled_by = NULL, settled_at = NULL WHERE to_entry_id = ?", e.id),
    stmt(db, 'DELETE FROM cash_entries WHERE id = ?', e.id),
    audit(db, { businessId: bid, userId: user.id, action: 'cashbook.entry.remove', table: 'cash_entries', rowId: e.id, before: { bookId: book.id, id: e.id, kind: e.kind, day: e.day, amountPaise: e.amountPaise, narration: e.narration }, at: t }),
  ]);
  return c.json({ ok: true });
});

// ---- Cash counted at the end of a day.

cashBookRoutes.put('/businesses/:businessId/cashbooks/:accountId/count/:day', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const book = await writableBook(c);
  const day = dayParam(c.req.param('day'));
  if (day < book.openingDate || day > today()) fail(400, 'Count a day from the book\'s start up to today.');
  const counted = paise(await body(c), 'counted', 'Cash counted');
  if (counted < 0) fail(400, 'Cash counted cannot be below ₹0.');
  const t = now();
  const was = await one<{ countedPaise: number }>(db, 'SELECT counted_paise AS countedPaise FROM cash_counts WHERE account_id = ? AND day = ?', book.id, day);
  await db.batch([
    stmt(db, `INSERT INTO cash_counts (id, business_id, account_id, day, counted_paise, counted_by, counted_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id, day) DO UPDATE SET counted_paise = excluded.counted_paise, counted_by = excluded.counted_by, counted_at = excluded.counted_at`,
      newId(), bid, book.id, day, counted, user.id, t),
    audit(db, { businessId: bid, userId: user.id, action: 'cashbook.count', table: 'cash_counts', rowId: `${book.id}:${day}`,
      before: was ?? undefined, after: { countedPaise: counted }, at: t }),
  ]);
  return c.json({ ok: true });
});

// ---- The other side of a handover.

async function handoverOf(db: DB, bid: string, id: string | undefined) {
  const [h] = await handovers(db, bid, 'AND h.id = ?', id404(id, 'Handover'));
  if (!h) fail(404, 'Handover not found.');
  return h;
}

// Accepting cash: into the receiving book (its cashier, or Owner/Accountant), or from a person (Owner/Accountant).
cashBookRoutes.post('/businesses/:businessId/handovers/:handoverId/receive', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const role = c.get('role');
  const user = c.get('user');
  const h = await handoverOf(db, bid, c.req.param('handoverId'));
  if (h.status !== 'sent') fail(409, 'This cash is already shown as received.');
  const t = now();
  if (h.toKind === 'bank') fail(400, 'Cash taken to the bank is matched to the deposit in the bank statement.');
  if (h.toKind === 'person') {
    if (!can(role, 'rows.approve')) fail(403, 'Owner or Accountant ticks cash handed to a person.');
    await db.batch([
      stmt(db, "UPDATE cash_handovers SET status = 'received', settled_by = ?, settled_at = ? WHERE id = ? AND status = 'sent'", user.id, t, h.id),
      audit(db, { businessId: bid, userId: user.id, action: 'cashbook.handover.received', table: 'cash_handovers', rowId: h.id, after: { status: 'received' }, at: t }),
    ]);
    return c.json({ ok: true });
  }
  const book = await bookFor(db, bid, h.toAccountId!, user.id, role);
  if (!seesAllBooks(role) && book.cashierUserId !== user.id) fail(403, 'Only the receiving cashier can accept this.');
  const data = await body(c);
  const day = typeof data.day === 'string' && data.day ? dayParam(data.day) : h.day < book.openingDate ? book.openingDate : h.day;
  if (day < h.day) fail(400, 'Cash cannot be received before the day it was handed over.');
  if (day < book.openingDate || day > today()) fail(400, 'Choose a day from the book\'s start up to today.');
  const entryId = newId();
  await db.batch([
    stmt(db, `INSERT INTO cash_entries (id, business_id, account_id, day, kind, amount_paise, narration, entered_by, entered_at, created_at)
      VALUES (?, ?, ?, ?, 'handover_in', ?, ?, ?, ?, ?)`, entryId, bid, book.id, day, h.amountPaise, `From ${h.fromBookName}${h.narration ? `: ${h.narration}` : ''}`.slice(0, 200), user.id, t, t),
    stmt(db, "UPDATE cash_handovers SET to_entry_id = ?, status = 'received', settled_by = ?, settled_at = ? WHERE id = ? AND status = 'sent'", entryId, user.id, t, h.id),
    audit(db, { businessId: bid, userId: user.id, action: 'cashbook.handover.received', table: 'cash_handovers', rowId: h.id, after: { status: 'received', entryId, day }, at: t }),
  ]);
  return c.json({ ok: true, entryId });
});

cashBookRoutes.post('/businesses/:businessId/handovers/:handoverId/deposit', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const h = await handoverOf(db, bid, c.req.param('handoverId'));
  if (h.toKind !== 'bank') fail(400, 'Only cash taken to the bank is matched to a deposit.');
  if (h.status !== 'sent') fail(409, 'This cash is already matched to a deposit.');
  const rowId = (await body(c)).bankRowId;
  const ok = (await depositCandidates(db, bid, h)).find((r) => r.id === rowId);
  if (!ok) fail(400, `Choose a deposit of this amount in ${h.toName} within a week of the handover.`);
  const t = now();
  await db.batch([
    stmt(db, "UPDATE cash_handovers SET bank_row_id = ?, status = 'deposited', settled_by = ?, settled_at = ? WHERE id = ? AND status = 'sent'", ok.id, user.id, t, h.id),
    audit(db, { businessId: bid, userId: user.id, action: 'cashbook.handover.deposited', table: 'cash_handovers', rowId: h.id, after: { status: 'deposited', bankRowId: ok.id }, at: t }),
  ]);
  return c.json({ ok: true });
});

// Undo: back to waiting. A book's accepting line is removed with it.
cashBookRoutes.post('/businesses/:businessId/handovers/:handoverId/undo', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const role = c.get('role');
  const user = c.get('user');
  const h = await handoverOf(db, bid, c.req.param('handoverId'));
  if (h.status === 'sent') return c.json({ ok: true });
  if (h.toKind === 'book') {
    const book = await bookFor(db, bid, h.toAccountId!, user.id, role);
    if (!seesAllBooks(role) && book.cashierUserId !== user.id) fail(403, 'Only the receiving cashier can undo this.');
  } else if (!can(role, 'rows.approve')) fail(403, 'Owner or Accountant can undo this.');
  const t = now();
  await db.batch([
    stmt(db, "UPDATE cash_handovers SET to_entry_id = NULL, bank_row_id = NULL, status = 'sent', settled_by = NULL, settled_at = NULL WHERE id = ?", h.id),
    ...(h.toEntryId ? [stmt(db, 'DELETE FROM cash_entries WHERE id = ?', h.toEntryId)] : []),
    audit(db, { businessId: bid, userId: user.id, action: 'cashbook.handover.undo', table: 'cash_handovers', rowId: h.id,
      before: { status: h.status, toEntryId: h.toEntryId, bankRowId: h.bankRowId }, after: { status: 'sent' }, at: t }),
  ]);
  return c.json({ ok: true });
});
