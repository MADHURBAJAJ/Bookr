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
import { bookDay, bookDays, bookFor, booksOf, bookReport, depositCandidates, feeChecks, handovers, inHandThrough, receiptRange, seesAllBooks, type HandoverRow } from '../cashbook';
import { can } from '../permissions';
import { refillAll } from '../fees';

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
    all<{ accountId: string; day: string; countedPaise: number; note: string | null; settle: string | null }>(db, `SELECT account_id AS accountId, day,
        counted_paise AS countedPaise, note, settle FROM cash_counts c
      WHERE business_id = ? AND day = (SELECT max(day) FROM cash_counts x WHERE x.account_id = c.account_id)`, bid),
    handovers(db, bid, "AND h.status = 'sent'"),
    handovers(db, bid, "AND h.status <> 'sent' AND h.settled_at >= ?", now() - 7 * 86400000),
  ]);
  const lastCount = new Map(counts.map((x) => [x.accountId, x]));
  const withCash = await Promise.all(books.map(async (b) => {
    const k = lastCount.get(b.id);
    const atCount = k ? await inHandThrough(db, b, k.day) : null;
    return { ...b, inHandPaise: await inHandThrough(db, b, t), lastCount: k ? { day: k.day, countedPaise: k.countedPaise, gapPaise: k.countedPaise - atCount!, note: k.note, settle: k.settle } : null };
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
    all<{ id: string; accountId: string; phone: string | null; createdAt: number }>(db, `SELECT id, account_id AS accountId, phone, created_at AS createdAt FROM invites
      WHERE business_id = ? AND account_id IS NOT NULL AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`, bid, now()),
    all<{ id: string; lastActiveAt: number | null; appFirstAt: number | null; appLastAt: number | null }>(db, `SELECT u.id, u.last_active_at AS lastActiveAt,
        u.app_first_at AS appFirstAt, u.app_last_at AS appLastAt FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.business_id = ?`, bid),
  ]) : [[], []];
  const pendingOf = new Map(pending.map((p) => [p.accountId, { id: p.id, phone: p.phone, createdAt: p.createdAt }]));
  const activeOf = new Map(active.map((a) => [a.id, a]));
  const booksShown = withCash.map((b) => {
    const a = b.cashierUserId ? activeOf.get(b.cashierUserId) : undefined;
    return { ...b, invite: pendingOf.get(b.id) ?? null, cashierLastActive: a?.lastActiveAt ?? null,
      cashierApp: a ? { firstAt: a.appFirstAt, lastAt: a.appLastAt } : null };
  });
  const openShown = await Promise.all(open.filter(visible).map(async (h) => ({
    ...h, deposits: h.toKind === 'bank' && can(role, 'rows.approve') ? await depositCandidates(db, bid, h) : [],
  })));
  const codes = setup ? await all<{ code: string; branchId: string | null }>(db, 'SELECT code, branch_id AS branchId FROM fee_codes WHERE business_id = ? ORDER BY code', bid) : [];
  // Cash holders added and invited by phone, whose person has not joined yet (no school and nobody keeps them yet).
  const pendingHolders = setup ? (await all<{ id: string; name: string; openingBalancePaise: number; openingDate: string }>(db, `SELECT a.id, a.name,
      a.opening_balance_paise AS openingBalancePaise, a.opening_date AS openingDate FROM accounts a
    WHERE a.business_id = ? AND a.kind = 'cash' AND a.branch_id IS NULL AND a.cashier_user_id IS NULL AND a.closed_at IS NULL
      AND (EXISTS (SELECT 1 FROM invites i WHERE i.account_id = a.id)
        OR EXISTS (SELECT 1 FROM audit_log l WHERE l.business_id = a.business_id AND l.action = 'cashbook.create' AND l.row_id = a.id)) ORDER BY a.name`, bid)).map((a) => ({ ...a, invite: pendingOf.get(a.id) ?? null })) : [];
  // Removing or closing a book (23 Nov 2026): which books were ever used (a line, or cash handed to them), and the closed ones.
  const [usedRows, closed] = setup ? await Promise.all([
    all<{ id: string }>(db, `SELECT DISTINCT account_id AS id FROM cash_entries WHERE business_id = ?
      UNION SELECT to_account_id FROM cash_handovers WHERE business_id = ? AND to_account_id IS NOT NULL`, bid, bid),
    booksOf(db, bid, user.id, role, 'only'),
  ]) : [[], []];
  const used = new Set(usedRows.map((r) => r.id));
  return c.json({
    today: t, branches, codes, books: booksShown.map((b) => ({ ...b, used: used.has(b.id) })),
    pendingHolders: pendingHolders.map((b) => ({ ...b, used: used.has(b.id) })), closed, handovers: openShown, done: done.filter(visible),
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

// A cash holder (approved 21 Nov 2026) is a book with no school: a director, a trustee, the accounts office. It is a book
// once someone keeps it (an existing user, or the person who joins by its phone invite).
async function bookInput(db: DB, bid: string, data: Record<string, unknown>, holder = false) {
  const branchId = typeof data.branchId === 'string' && data.branchId ? data.branchId : null;
  const cashierUserId = typeof data.cashierUserId === 'string' && data.cashierUserId ? data.cashierUserId : null;
  if (holder) {
    if (branchId) fail(400, 'A cash holder is not at a school.');
    if (cashierUserId && (!isUuid(cashierUserId) || !(await one(db, 'SELECT 1 AS ok FROM memberships WHERE user_id = ? AND business_id = ?', cashierUserId, bid)))) {
      fail(400, 'Choose a user of this business, or invite them by phone after adding.');
    }
    return { branchId: null, cashierUserId };
  }
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
  const { branchId, cashierUserId } = await bookInput(db, bid, data, data.holder === true);
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
  const accountId = id404(c.req.param('accountId'), 'Cash book');
  // A cash holder nobody keeps yet (added, not joined) is changed here too (21 Nov 2026): most often to give it to a
  // user who already signs in, e.g. a director who joined as Owner.
  const pending = await one<{ id: string; name: string; openingBalancePaise: number; openingDate: string }>(db, `SELECT a.id, a.name,
      a.opening_balance_paise AS openingBalancePaise, a.opening_date AS openingDate FROM accounts a
    WHERE a.id = ? AND a.business_id = ? AND a.kind = 'cash' AND a.branch_id IS NULL AND a.cashier_user_id IS NULL
      AND (EXISTS (SELECT 1 FROM invites i WHERE i.account_id = a.id)
        OR EXISTS (SELECT 1 FROM audit_log l WHERE l.business_id = a.business_id AND l.action = 'cashbook.create' AND l.row_id = a.id))`, accountId, bid);
  const book = pending ? { ...pending, branchId: null, cashierUserId: null as string | null } : await bookFor(db, bid, accountId, user.id, c.get('role'));
  const data = await body(c);
  const { branchId, cashierUserId } = await bookInput(db, bid, data, !book.branchId);
  if (!book.branchId && book.cashierUserId && !cashierUserId) fail(400, 'Choose who keeps this cash holder\'s book.');
  // Schools and cashiers (21 Nov 2026): the name, opening cash and opening date change here too, when sent.
  const name = data.name !== undefined ? text(data, 'name', 'Cashier name', { max: 120 })! : book.name;
  const opening = data.openingBalance !== undefined ? paise(data, 'openingBalance', 'Opening cash') : book.openingBalancePaise;
  const openingDate = data.openingDate !== undefined ? date(data, 'openingDate', 'Opening date') : book.openingDate;
  const t = now();
  try {
    await db.batch([
      stmt(db, `UPDATE accounts SET name = ?, branch_id = ?, cashier_user_id = ?, opening_balance_paise = ?, opening_date = ? WHERE id = ? AND business_id = ?`,
        name, branchId, cashierUserId, opening, openingDate, book.id, bid),
      // Someone now keeps the book: a phone invite still waiting for it would make a second login, so it is cancelled.
      ...(cashierUserId ? [stmt(db, 'UPDATE invites SET revoked_at = ? WHERE account_id = ? AND accepted_at IS NULL AND revoked_at IS NULL', t, book.id)] : []),
      audit(db, { businessId: bid, userId: user.id, action: 'cashbook.update', table: 'accounts', rowId: book.id,
        before: { name: book.name, branchId: book.branchId, cashierUserId: book.cashierUserId, openingBalancePaise: book.openingBalancePaise, openingDate: book.openingDate },
        after: { name, branchId, cashierUserId, openingBalancePaise: opening, openingDate }, at: t }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'An account with this name already exists.');
    throw e;
  }
  // A new opening date changes which fee report days fill the book.
  if (openingDate !== book.openingDate) await refillAll(db, bid, user.id);
  return c.json({ ok: true });
});

// ---- Removing or closing a book (approved 23 Nov 2026). A book never used (no lines, nothing handed to it; counts
// alone do not count as use) is removed outright. A book with history is closed: it leaves the lists and the hand-over
// choices, nobody writes in it, its days stay readable, and it can be reopened. Either way a waiting phone invite for it
// is cancelled; the person's login stays (remove it on Users and roles).

async function anyBook(c: Context<AppEnv>) {
  const b = await one<{ id: string; name: string; branchId: string | null; cashierUserId: string | null; closedAt: number | null; used: number }>(c.env.DB,
    `SELECT a.id, a.name, a.branch_id AS branchId, a.cashier_user_id AS cashierUserId, a.closed_at AS closedAt,
      (EXISTS (SELECT 1 FROM cash_entries e WHERE e.account_id = a.id) OR EXISTS (SELECT 1 FROM cash_handovers h WHERE h.to_account_id = a.id)) AS used
    FROM accounts a WHERE a.id = ? AND a.business_id = ? AND a.kind = 'cash'
      AND (a.branch_id IS NOT NULL OR a.cashier_user_id IS NOT NULL OR EXISTS (SELECT 1 FROM invites i WHERE i.account_id = a.id)
        OR EXISTS (SELECT 1 FROM audit_log l WHERE l.business_id = a.business_id AND l.action = 'cashbook.create' AND l.row_id = a.id))`,
    id404(c.req.param('accountId'), 'Cash book'), c.get('businessId'));
  if (!b) fail(404, 'Cash book not found.');
  return b;
}

cashBookRoutes.delete('/businesses/:businessId/cashbooks/:accountId', requireRole('accounts.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const b = await anyBook(c);
  if (b.used) fail(409, 'This book has lines. Close it instead: its days stay readable.');
  const t = now();
  try {
    await db.batch([
      stmt(db, 'UPDATE invites SET revoked_at = ? WHERE account_id = ? AND accepted_at IS NULL AND revoked_at IS NULL', t, b.id),
      stmt(db, 'UPDATE invites SET account_id = NULL WHERE account_id = ?', b.id),
      stmt(db, 'DELETE FROM cash_counts WHERE account_id = ?', b.id),
      stmt(db, 'DELETE FROM accounts WHERE id = ? AND business_id = ?', b.id, bid),
      audit(db, { businessId: bid, userId: c.get('user').id, action: 'cashbook.remove', table: 'accounts', rowId: b.id,
        before: { name: b.name, branchId: b.branchId, cashierUserId: b.cashierUserId }, at: t }),
    ]);
  } catch (e) {
    if (/FOREIGN KEY/i.test(String(e))) fail(409, 'This book is used elsewhere in the books. Close it instead.');
    throw e;
  }
  return c.json({ ok: true });
});

cashBookRoutes.post('/businesses/:businessId/cashbooks/:accountId/close', requireRole('accounts.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const b = await anyBook(c);
  const close = (await body(c)).closed !== false;
  if (close === !!b.closedAt) return c.json({ ok: true });
  if (close) {
    const waiting = await one<{ n: number }>(db, `SELECT count(*) AS n FROM cash_handovers h JOIN cash_entries o ON o.id = h.from_entry_id
      WHERE h.status = 'sent' AND (o.account_id = ? OR h.to_account_id = ?)`, b.id, b.id);
    if (waiting!.n) fail(409, 'Cash handed over from or to this book is still on the way. Finish or undo it first.');
    const book = await one<{ id: string; branchId: string | null; openingBalancePaise: number; openingDate: string }>(db,
      'SELECT id, branch_id AS branchId, opening_balance_paise AS openingBalancePaise, opening_date AS openingDate FROM accounts WHERE id = ?', b.id);
    const inHand = await inHandThrough(db, book!, today());
    if (inHand) fail(409, `The book still shows ₹ ${(inHand / 100).toLocaleString('en-IN')} in hand. Hand it over first, so the cash is not lost from the books.`);
  }
  const t = now();
  await db.batch([
    stmt(db, 'UPDATE accounts SET closed_at = ?, closed_by = ? WHERE id = ? AND business_id = ?', close ? t : null, close ? user.id : null, b.id, bid),
    ...(close ? [stmt(db, 'UPDATE invites SET revoked_at = ? WHERE account_id = ? AND accepted_at IS NULL AND revoked_at IS NULL', t, b.id)] : []),
    audit(db, { businessId: bid, userId: user.id, action: close ? 'cashbook.close' : 'cashbook.reopen', table: 'accounts', rowId: b.id,
      after: { name: b.name, closed: close }, at: t }),
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
      WHERE a.business_id = ? AND a.kind = 'cash' AND a.id <> ? AND a.closed_at IS NULL AND (a.branch_id IS NOT NULL OR a.cashier_user_id IS NOT NULL) ORDER BY b.name, a.name`, bid, book.id),
    all<{ id: string; name: string }>(db, "SELECT id, name FROM accounts WHERE business_id = ? AND kind = 'bank' ORDER BY name", bid),
    all<{ name: string }>(db, `SELECT DISTINCT p.name FROM cash_handovers h JOIN parties p ON p.id = h.to_party_id WHERE h.business_id = ? ORDER BY p.name`, bid),
  ]);
  const canWrite = !book.closedAt && can(role, 'rows.edit') && (seesAllBooks(role) || book.cashierUserId === user.id);
  return c.json({ ...d, today: today(), heads, targets, banks, people: people.map((p) => p.name), can: { write: canWrite, approve: can(role, 'rows.approve') } });
});

// ---- Add a line: a fee, an expense, other money in or out, or cash handed over (to a book, a person or the bank).

const KINDS = ['fee', 'other_in', 'expense', 'other_out', 'handover_out'] as const;

async function writableBook(c: Context<AppEnv>) {
  const role = c.get('role');
  const user = c.get('user');
  const book = await bookFor(c.env.DB, c.get('businessId'), id404(c.req.param('accountId'), 'Cash book'), user.id, role);
  if (!seesAllBooks(role) && book.cashierUserId !== user.id) fail(403, 'Only this book\'s cashier can write in it.');
  if (book.closedAt) fail(409, 'This book is closed. Reopen it on Schools and cashiers to write in it.');
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
  if (kind === 'fee' && !book.branchId) fail(400, 'A cash holder is not at a school, so takes no fees. Use money in.');
  const day = date(data, 'day', 'Day');
  if (day < book.openingDate) fail(400, `This book starts on ${book.openingDate}.`);
  if (day > today()) fail(400, 'That day has not come yet.');
  const amount = paise(data, 'amount', 'Amount');
  if (amount <= 0) fail(400, 'Amount must be more than ₹0.');
  const narration = text(data, 'narration', 'Details', { optional: true, max: 200 });
  // Cashier app (21 Nov 2026): the cashier writes what an expense or an extra receipt was for; the accountant sets the
  // head later. A head can still be given now.
  let headId: string | null = null;
  if (kind === 'expense' || kind === 'other_in') {
    headId = typeof data.headId === 'string' && data.headId ? data.headId : null;
    if (headId && (!isUuid(headId) || !(await one(db, 'SELECT 1 AS ok FROM heads WHERE id = ? AND business_id = ? AND type = ?', headId, bid, kind === 'expense' ? 'expense' : 'income')))) {
      fail(400, kind === 'expense' ? 'Choose the expense head.' : 'Choose the income head.');
    }
    if (!headId && !narration) fail(400, 'Write what this was for.');
  }
  const entryId = newId();
  const t = now();
  const st: D1PreparedStatement[] = [];
  let to: { kind: 'book' | 'person' | 'bank'; accountId: string | null; partyId: string | null; name: string } | null = null;
  if (kind === 'handover_out') {
    const x = (data.to ?? {}) as Record<string, unknown>;
    if (x.kind === 'book' || x.kind === 'bank') {
      const accountId = typeof x.accountId === 'string' && isUuid(x.accountId) ? x.accountId : null;
      const a = accountId ? await one<{ name: string }>(db, 'SELECT name FROM accounts WHERE id = ? AND business_id = ? AND kind = ? AND closed_at IS NULL', accountId, bid, x.kind === 'bank' ? 'bank' : 'cash') : null;
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

// Changing a book after the fact (approved 22 Nov 2026): a cashier changes or removes their own lines of today and
// yesterday only; older days are changed by the Owner or the Accountant. Nobody changes a day whose count the Owner has
// settled (undo the settle first).
const yesterday = () => new Date(Date.parse(`${today()}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

async function changeWindow(c: Context<AppEnv>, bookId: string, ...days: string[]) {
  if (!can(c.get('role'), 'rows.approve') && days.some((d) => d < yesterday())) {
    fail(403, 'You can change only today\'s and yesterday\'s lines. Ask the owner or the accountant to change an older day.');
  }
  const ph = days.map(() => '?').join(', ');
  if (await one(c.env.DB, `SELECT 1 AS ok FROM cash_counts WHERE account_id = ? AND day IN (${ph}) AND settle IS NOT NULL`, bookId, ...days)) {
    fail(409, 'The owner has settled the count of this day. Undo the settle first.');
  }
}

type LineRow = { id: string; kind: string; day: string; amountPaise: number; narration: string | null; feeReportId: string | null; reviewStatus: string | null; settled: number };

async function lineOf(c: Context<AppEnv>, bookId: string) {
  const entryId = id404(c.req.param('entryId'), 'Line');
  const e = await one<LineRow>(c.env.DB, `SELECT id, kind, day, amount_paise AS amountPaise, narration, fee_report_id AS feeReportId, review_status AS reviewStatus,
      EXISTS (SELECT 1 FROM cash_counts k WHERE k.settle_entry_id = cash_entries.id) AS settled
    FROM cash_entries WHERE id = ? AND account_id = ? AND business_id = ?`, entryId, bookId, c.get('businessId'));
  if (!e) fail(404, 'Line not found.');
  if (e.feeReportId) fail(409, 'This line comes from the fee report. Bring in the day\'s report again to change it.');
  if (e.settled) fail(409, 'This line came from settling a count. Undo the settle to change it.');
  if (e.reviewStatus) fail(409, `The owner has already ${e.reviewStatus} this line.`);
  return e;
}

// Changing a line: the amount, what it was for, or its day. Each change is kept in the audit log (the "edited" history).
cashBookRoutes.patch('/businesses/:businessId/cashbooks/:accountId/entries/:entryId', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const book = await writableBook(c);
  const e = await lineOf(c, book.id);
  if (e.kind === 'fee') fail(409, 'Change the day\'s fee cash in the fee box.');
  if (e.kind === 'handover_in') fail(409, 'This is cash accepted from another book. Remove it, and accept it again if needed.');
  const h = await one<{ status: string }>(db, 'SELECT status FROM cash_handovers WHERE from_entry_id = ?', e.id);
  if (h && h.status !== 'sent') fail(409, 'The other side already shows this cash. Undo it there first.');
  const data = await body(c);
  const day = data.day === undefined ? e.day : date(data, 'day', 'Day');
  if (day < book.openingDate) fail(400, `This book starts on ${book.openingDate}.`);
  if (day > today()) fail(400, 'That day has not come yet.');
  const amount = data.amount === undefined ? e.amountPaise : paise(data, 'amount', 'Amount');
  if (amount <= 0) fail(400, 'Amount must be more than ₹0.');
  const narration = data.narration === undefined ? e.narration : text(data, 'narration', 'Details', { optional: true, max: 200 });
  if ((e.kind === 'expense' || e.kind === 'other_in') && !narration
    && !(await one(db, 'SELECT 1 AS ok FROM cash_entries WHERE id = ? AND head_id IS NOT NULL', e.id))) fail(400, 'Write what this was for.');
  if (day === e.day && amount === e.amountPaise && (narration ?? null) === (e.narration ?? null)) return c.json({ ok: true, changed: false });
  await changeWindow(c, book.id, e.day, day);
  const t = now();
  await db.batch([
    stmt(db, 'UPDATE cash_entries SET day = ?, amount_paise = ?, narration = ? WHERE id = ?', day, amount, narration ?? null, e.id),
    audit(db, { businessId: bid, userId: user.id, action: 'cashbook.entry.edit', table: 'cash_entries', rowId: e.id,
      before: { bookId: book.id, kind: e.kind, day: e.day, amountPaise: e.amountPaise, narration: e.narration },
      after: { bookId: book.id, kind: e.kind, day, amountPaise: amount, narration: narration ?? null }, at: t }),
  ]);
  return c.json({ ok: true, changed: true });
});

// A line's history: when it was written and each change since, newest last.
cashBookRoutes.get('/businesses/:businessId/cashbooks/:accountId/entries/:entryId/history', requireRole('business.view'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const book = await bookFor(db, bid, id404(c.req.param('accountId'), 'Cash book'), user.id, c.get('role'));
  const entryId = id404(c.req.param('entryId'), 'Line');
  if (!(await one(db, 'SELECT 1 AS ok FROM cash_entries WHERE id = ? AND account_id = ?', entryId, book.id))) fail(404, 'Line not found.');
  const rows = await all<{ action: string; before: string | null; after: string | null; at: number; byName: string | null }>(db,
    `SELECT l.action, l.before, l.after, l.created_at AS at, u.name AS byName FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.business_id = ? AND l.row_table = 'cash_entries' AND l.row_id = ? AND l.action IN ('cashbook.entry.add', 'cashbook.entry.edit') ORDER BY l.id`, bid, entryId);
  return c.json({ history: rows.map((r) => ({ action: r.action === 'cashbook.entry.add' ? 'added' : 'edited', at: r.at, byName: r.byName,
    before: r.before ? JSON.parse(r.before) : null, after: r.after ? JSON.parse(r.after) : null })) });
});

// Removing a line. Cash handed over that the other side already shows is undone there first. A line accepting cash from
// another book can be removed: the handover goes back to waiting.
cashBookRoutes.delete('/businesses/:businessId/cashbooks/:accountId/entries/:entryId', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const book = await writableBook(c);
  const e = await lineOf(c, book.id);
  const h = await one<{ id: string; status: string }>(db, 'SELECT id, status FROM cash_handovers WHERE from_entry_id = ?', e.id);
  if (h && h.status !== 'sent') fail(409, 'The other side already shows this cash. Undo it there first.');
  await changeWindow(c, book.id, e.day);
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
  const data = await body(c);
  const counted = paise(data, 'counted', 'Cash counted');
  if (counted < 0) fail(400, 'Cash counted cannot be below ₹0.');
  // A count that is short or extra needs a note (21 Nov 2026); the owner sees it.
  const note = text(data, 'note', 'Note', { optional: true, max: 300 }) ?? null;
  const gap = counted - (await inHandThrough(db, book, day));
  if (gap !== 0 && !note) fail(400, `Cash is ${gap < 0 ? 'short' : 'extra'} ₹ ${(Math.abs(gap) / 100).toLocaleString('en-IN')}. Write why.`);
  const t = now();
  const was = await one<{ countedPaise: number; note: string | null; settle: string | null }>(db, 'SELECT counted_paise AS countedPaise, note, settle FROM cash_counts WHERE account_id = ? AND day = ?', book.id, day);
  if (was?.settle) fail(409, 'The owner has settled this count. Ask the owner to undo it to count again.');
  await db.batch([
    stmt(db, `INSERT INTO cash_counts (id, business_id, account_id, day, counted_paise, counted_by, counted_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id, day) DO UPDATE SET counted_paise = excluded.counted_paise, counted_by = excluded.counted_by, counted_at = excluded.counted_at,
        note = excluded.note`,
      newId(), bid, book.id, day, counted, user.id, t, note),
    audit(db, { businessId: bid, userId: user.id, action: 'cashbook.count', table: 'cash_counts', rowId: `${book.id}:${day}`,
      before: was ?? undefined, after: { countedPaise: counted, note }, at: t }),
  ]);
  return c.json({ ok: true, gapPaise: gap });
});

// ---- Settling a count that came out short or extra (approved 21 Nov 2026, migration 0035). Owner only.

const SETTLE_HEADS = { shortage: { name: 'Cash shortage', type: 'expense', tally: 'Cash Shortage' }, extra: { name: 'Cash extra', type: 'income', tally: 'Cash Extra' } } as const;

async function headFor(db: DB, bid: string, h: { name: string; type: string; tally: string }) {
  const found = await one<{ id: string }>(db, 'SELECT id FROM heads WHERE business_id = ? AND type = ? AND lower(name) = lower(?)', bid, h.type, h.name);
  if (found) return { id: found.id, create: null };
  const id = newId();
  return { id, create: stmt(db, 'INSERT INTO heads (id, business_id, name, type, tally_ledger, is_custom, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)', id, bid, h.name, h.type, h.tally, now()) };
}

cashBookRoutes.post('/businesses/:businessId/cashbooks/:accountId/count/:day/settle', requireRole('members.manage'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const book = await bookFor(db, bid, id404(c.req.param('accountId'), 'Cash book'), user.id, c.get('role'));
  const day = dayParam(c.req.param('day'));
  const data = await body(c);
  const how = data.how;
  if (how !== 'shortage' && how !== 'extra' && how !== 'given_back' && how !== 'found') fail(400, 'Choose how to settle it.');
  const note = text(data, 'note', 'Note', { optional: true, max: 300 }) ?? null;
  const k = await one<{ id: string; countedPaise: number; settle: string | null }>(db,
    'SELECT id, counted_paise AS countedPaise, settle FROM cash_counts WHERE account_id = ? AND day = ?', book.id, day);
  if (!k) fail(404, 'No count on this day.');
  if (k.settle) fail(409, 'This count is already settled.');
  const gap = k.countedPaise - (await inHandThrough(db, book, day));
  if (gap === 0) fail(409, 'This count agrees with the book now. Nothing to settle.');
  if (how === 'shortage' && gap > 0) fail(400, 'The cash is extra, not short.');
  if ((how === 'extra' || how === 'given_back') && gap < 0) fail(400, 'The cash is short, not extra.');
  const t = now();
  const st = [];
  let entryId: string | null = null;
  if (how === 'shortage' || how === 'extra') {
    const head = await headFor(db, bid, SETTLE_HEADS[how]);
    if (head.create) st.push(head.create);
    entryId = newId();
    st.push(stmt(db, `INSERT INTO cash_entries (id, business_id, account_id, day, kind, amount_paise, head_id, narration, entered_by, entered_at, created_at,
        review_status, reviewed_by, reviewed_at, review_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)`,
      entryId, bid, book.id, day, how === 'shortage' ? 'expense' : 'other_in', Math.abs(gap), head.id,
      `${how === 'shortage' ? 'Cash short' : 'Cash extra'} on count${note ? ` · ${note}` : ''}`, user.id, t, t, user.id, t, note));
  }
  st.push(
    stmt(db, 'UPDATE cash_counts SET settle = ?, settle_note = ?, settle_gap_paise = ?, settle_entry_id = ?, settled_by = ?, settled_at = ? WHERE id = ?',
      how, note, gap, entryId, user.id, t, k.id),
    audit(db, { businessId: bid, userId: user.id, action: 'cashbook.count.settle', table: 'cash_counts', rowId: k.id,
      after: { bookId: book.id, day, how, note, gapPaise: gap, entryId }, at: t }),
  );
  await db.batch(st);
  return c.json({ ok: true, gapPaise: gap, entryId });
});

// Undo: the line written for a shortage or extra goes, and the count is open again.
cashBookRoutes.delete('/businesses/:businessId/cashbooks/:accountId/count/:day/settle', requireRole('members.manage'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const book = await bookFor(db, bid, id404(c.req.param('accountId'), 'Cash book'), user.id, c.get('role'));
  const day = dayParam(c.req.param('day'));
  const k = await one<{ id: string; settle: string | null; entryId: string | null }>(db,
    'SELECT id, settle, settle_entry_id AS entryId FROM cash_counts WHERE account_id = ? AND day = ?', book.id, day);
  if (!k?.settle) fail(404, 'This count is not settled.');
  const t = now();
  await db.batch([
    stmt(db, 'UPDATE cash_counts SET settle = NULL, settle_note = NULL, settle_gap_paise = NULL, settle_entry_id = NULL, settled_by = NULL, settled_at = NULL WHERE id = ?', k.id),
    ...(k.entryId ? [stmt(db, 'DELETE FROM cash_entries WHERE id = ? AND account_id = ?', k.entryId, book.id)] : []),
    audit(db, { businessId: bid, userId: user.id, action: 'cashbook.count.unsettle', table: 'cash_counts', rowId: k.id, before: { how: k.settle, entryId: k.entryId }, at: t }),
  ]);
  return c.json({ ok: true });
});

// The Owner's "Needs a look" (owner phone app, approved 21 Nov 2026): cash sent to the Owner's own books or to a person
// to tick, expenses to approve or still without a head, fee totals that differ from the sheet, and counts short or extra
// not settled (each book's latest count: an earlier gap carries into it).
cashBookRoutes.get('/businesses/:businessId/owner-look', requireRole('members.manage'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const t = today();
  const books = await booksOf(db, bid, user.id, c.get('role'));
  const mine = new Set(books.filter((b) => b.cashierUserId === user.id).map((b) => b.id));
  const from = new Date(Date.parse(`${t}T00:00:00Z`) - 13 * 86400000).toISOString().slice(0, 10);
  const [open, expenses, heads, counts] = await Promise.all([
    handovers(db, bid, "AND h.status = 'sent'"),
    all(db, `${reviewSql} AND e.kind = 'expense' AND e.review_status IS NULL ORDER BY e.day, e.entered_at`, bid),
    all<{ id: string; name: string; type: string }>(db, 'SELECT id, name, type FROM heads WHERE business_id = ? ORDER BY type, name', bid),
    all<{ accountId: string; day: string; countedPaise: number; note: string | null; settle: string | null }>(db, `SELECT account_id AS accountId, day,
        counted_paise AS countedPaise, note, settle FROM cash_counts c
      WHERE business_id = ? AND day = (SELECT max(day) FROM cash_counts x WHERE x.account_id = c.account_id)`, bid),
  ]);
  const byId = new Map(books.map((b) => [b.id, b]));
  const gaps = (await Promise.all(counts.filter((k) => !k.settle && byId.has(k.accountId)).map(async (k) => {
    const b = byId.get(k.accountId)!;
    const gap = k.countedPaise - (await inHandThrough(db, b, k.day));
    return gap ? { bookId: b.id, bookName: b.name, branchName: b.branchName, day: k.day, gapPaise: gap, note: k.note } : null;
  }))).filter((x) => x);
  const fees = (await Promise.all(books.filter((b) => b.branchId).map(async (b) =>
    (await feeChecks(db, b, from > b.openingDate ? from : b.openingDate, t, false))
      .filter((f) => f.state === 'less' || f.state === 'more' || f.state === 'kept')
      .map((f) => ({ bookId: b.id, bookName: b.name, branchName: b.branchName, ...f }))))).flat();
  // Cash on the way (approved 21 Nov 2026): sent to the Owner's own book needs them at once; anything else (another book,
  // a person, the bank) once it has waited a day. A bank deposit comes with the bank credits it could be.
  const due = await Promise.all(open.filter((h) => (h.toKind === 'book' && mine.has(h.toAccountId!)) || h.day < t)
    .map(async (h) => ({ ...h, mine: h.toKind === 'book' && mine.has(h.toAccountId!), deposits: h.toKind === 'bank' ? await depositCandidates(db, bid, h) : [] })));
  // Lines written, changed or removed by someone else after that day was counted, in the last 7 days (22 Nov 2026): to
  // see, not to act on. A day whose count was settled cannot be changed, so it never shows.
  const since = Date.parse(`${t}T00:00:00Z`) - 7 * 86400000 - 5.5 * 3600000;
  const changed = (await all<{ action: string; before: string | null; after: string | null; at: number; byName: string | null }>(db,
    `SELECT l.action, l.before, l.after, l.created_at AS at, u.name AS byName FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.business_id = ? AND l.row_table = 'cash_entries' AND l.action IN ('cashbook.entry.add', 'cashbook.entry.edit', 'cashbook.entry.remove')
        AND l.created_at >= ? AND (l.user_id IS NULL OR l.user_id <> ?)
        AND EXISTS (SELECT 1 FROM cash_counts k WHERE k.account_id = json_extract(coalesce(l.after, l.before), '$.bookId') AND k.counted_at < l.created_at AND k.settle IS NULL
          AND k.day IN (json_extract(l.before, '$.day'), json_extract(l.after, '$.day')))
      ORDER BY l.id DESC LIMIT 50`, bid, since, user.id))
    .map((r) => {
      const before = r.before ? JSON.parse(r.before) : null;
      const after = r.after ? JSON.parse(r.after) : null;
      const b = byId.get((after ?? before).bookId);
      return b ? { bookId: b.id, bookName: b.name, branchName: b.branchName, what: r.action.split('.').pop(), at: r.at, byName: r.byName, before, after } : null;
    }).filter((x) => x);
  return c.json({ today: t, handovers: due, expenses, heads, fees, counts: gaps, changed });
});

// ---- The cashier's fee cash total for a day, and sorting out a difference with the fee day sheet (21 Nov 2026).

cashBookRoutes.put('/businesses/:businessId/cashbooks/:accountId/fee/:day', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const book = await writableBook(c);
  const day = dayParam(c.req.param('day'));
  if (!book.branchId) fail(400, 'A cash holder is not at a school, so takes no fees.');
  if (day < book.openingDate || day > today()) fail(400, 'Enter fees for a day from the book\'s start up to today.');
  const data = await body(c);
  const amount = paise(data, 'amount', 'Total cash fees');
  if (amount < 0) fail(400, 'Total cash fees cannot be below ₹0.');
  const rec = data.receipts === undefined || data.receipts === null || data.receipts === '' ? null : Number(data.receipts);
  if (rec !== null && (!Number.isInteger(rec) || rec <= 0 || rec > 5000)) fail(400, 'Receipts must be a whole number.');
  const first = text(data, 'first', 'First receipt no.', { optional: true, max: 30 })?.replace(/\s+/g, '').toUpperCase() || null;
  const last = text(data, 'last', 'Last receipt no.', { optional: true, max: 30 })?.replace(/\s+/g, '').toUpperCase() || null;
  if ((first || last) && !(first && last)) fail(400, 'Give both the first and the last receipt no., or neither.');
  if (first && last && !receiptRange(first, last)) fail(400, 'The last receipt no. must come after the first, with the same start.');
  const [check] = await feeChecks(db, book, day, day, true);
  if (check?.sheetIn) fail(409, 'The fee day sheet is in for this day: the book uses the sheet. Sort out a difference instead.');
  const t = now();
  const id = newId();
  await db.batch([
    stmt(db, "DELETE FROM cash_entries WHERE account_id = ? AND day = ? AND kind = 'fee' AND fee_report_id IS NULL", book.id, day),
    ...(amount > 0 ? [stmt(db, `INSERT INTO cash_entries (id, business_id, account_id, day, kind, amount_paise, narration, entered_by, entered_at, created_at,
        fee_receipts, fee_first, fee_last) VALUES (?, ?, ?, ?, 'fee', ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, bid, book.id, day, amount, 'Fee cash, your total', user.id, t, t, rec, first, last)] : []),
    audit(db, { businessId: bid, userId: user.id, action: 'cashbook.fee', table: 'cash_entries', rowId: `${book.id}:${day}`,
      before: check?.typedPaise != null ? { amountPaise: check.typedPaise, receipts: check.receipts, first: check.first, last: check.last } : undefined,
      after: { amountPaise: amount, receipts: rec, first, last }, at: t }),
  ]);
  return c.json({ ok: true });
});

cashBookRoutes.put('/businesses/:businessId/cashbooks/:accountId/fee/:day/settle', requireRole('rows.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const book = await writableBook(c);
  const day = dayParam(c.req.param('day'));
  const how = (await body(c)).how;
  if (how !== 'kept' && how !== 'sheet' && how !== null) fail(400, 'Say whether to keep your amount or use the sheet.');
  const [check] = await feeChecks(db, book, day, day, true);
  if (!check?.entryId || !check.sheetIn) fail(409, 'There is no difference with the sheet to sort out on this day.');
  if (how === 'kept' && check.diffPaise <= 0) fail(400, 'Only an amount the sheet does not have can be kept.');
  const t = now();
  await db.batch([
    stmt(db, "UPDATE cash_entries SET fee_settle = ? WHERE account_id = ? AND day = ? AND kind = 'fee' AND fee_report_id IS NULL", how, book.id, day),
    audit(db, { businessId: bid, userId: user.id, action: 'cashbook.fee.settle', table: 'cash_entries', rowId: `${book.id}:${day}`,
      before: { settle: check.settle }, after: { settle: how, diffPaise: check.diffPaise, missing: check.missing }, at: t }),
  ]);
  return c.json({ ok: true });
});

// ---- A book's days: what should be in hand, the fee check and the count of each (newest first).

cashBookRoutes.get('/businesses/:businessId/cashbooks/:accountId/days', requireRole('business.view'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const book = await bookFor(db, bid, id404(c.req.param('accountId'), 'Cash book'), user.id, c.get('role'));
  const through = today();
  const from = new Date(Date.parse(`${through}T00:00:00Z`) - 44 * 86400000).toISOString().slice(0, 10);
  const days = await bookDays(db, book, from, through);
  return c.json({ book, today: through, days: days.reverse() });
});

// ---- Report (approved 28 Nov 2026): one book or all of them (Owner, Accountant, Viewer), Today, last 7 days or chosen
// dates. A cashier gets only their own book. The page prints to PDF on the phone.

const REPORT_MAX_DAYS = 92;
cashBookRoutes.get('/businesses/:businessId/cashbook-report', requireRole('business.view'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const role = c.get('role');
  const user = c.get('user');
  const from = dayParam(c.req.query('from'));
  const through = dayParam(c.req.query('to'));
  if (through < from) fail(400, 'The last day must be on or after the first day.');
  if (through > today()) fail(400, 'That day has not come yet.');
  if (Date.parse(`${through}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) >= REPORT_MAX_DAYS * 86400000) fail(400, `Choose at most ${REPORT_MAX_DAYS} days.`);
  const which = c.req.query('book') ?? 'all';
  const books = which === 'all' ? await booksOf(db, bid, user.id, role) : [await bookFor(db, bid, id404(which, 'Cash book'), user.id, role)];
  const reports = [];
  for (const b of books) reports.push(await bookReport(db, bid, b, from, through));
  return c.json({ business: (await one<{ name: string }>(db, 'SELECT name FROM businesses WHERE id = ?', bid))?.name ?? '', from, through,
    all: which === 'all', madeAt: now(), madeBy: user.name, reports });
});

// ---- Expenses and extra receipts: the accountant sets the head, the owner approves an expense or rejects it with a note.

const reviewSql = `SELECT e.id, e.account_id AS accountId, a.name AS bookName, b.name AS branchName, e.day, e.kind, e.amount_paise AS amountPaise, e.narration,
    e.head_id AS headId, h.name AS headName, e.review_status AS reviewStatus, e.review_note AS reviewNote, ru.name AS reviewedByName, e.reviewed_at AS reviewedAt,
    u.name AS enteredByName, e.entered_at AS enteredAt
  FROM cash_entries e JOIN accounts a ON a.id = e.account_id LEFT JOIN branches b ON b.id = a.branch_id LEFT JOIN heads h ON h.id = e.head_id
    LEFT JOIN users u ON u.id = e.entered_by LEFT JOIN users ru ON ru.id = e.reviewed_by
  WHERE e.business_id = ? AND e.kind IN ('expense', 'other_in')`;

cashBookRoutes.get('/businesses/:businessId/cashbooks/:accountId/lines', requireRole('business.view'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const book = await bookFor(db, bid, id404(c.req.param('accountId'), 'Cash book'), user.id, c.get('role'));
  const from = new Date(Date.now() + 5.5 * 3600000 - 60 * 86400000).toISOString().slice(0, 10);
  return c.json({ lines: await all(db, `${reviewSql} AND e.account_id = ? AND e.day >= ? ORDER BY e.day DESC, e.entered_at DESC`, bid, book.id, from) });
});

cashBookRoutes.get('/businesses/:businessId/cashbook-reviews', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const role = c.get('role');
  const [waiting, heads] = await Promise.all([
    all(db, `${reviewSql} AND (e.head_id IS NULL OR (e.kind = 'expense' AND e.review_status IS NULL)) ORDER BY e.day, e.entered_at`, bid),
    all<{ id: string; name: string; type: string }>(db, 'SELECT id, name, type FROM heads WHERE business_id = ? ORDER BY type, name', bid),
  ]);
  return c.json({ lines: waiting, heads, can: { approve: can(role, 'members.manage') } });
});

async function reviewLine(db: DB, bid: string, id: string | undefined) {
  const e = await one<{ id: string; kind: string; headId: string | null; reviewStatus: string | null; amountPaise: number }>(db,
    `SELECT id, kind, head_id AS headId, review_status AS reviewStatus, amount_paise AS amountPaise FROM cash_entries
     WHERE id = ? AND business_id = ? AND kind IN ('expense', 'other_in')`, id404(id, 'Line'), bid);
  if (!e) fail(404, 'Line not found.');
  return e;
}

cashBookRoutes.put('/businesses/:businessId/cashbook-lines/:entryId/head', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const e = await reviewLine(db, bid, c.req.param('entryId'));
  if (e.reviewStatus) fail(409, `The owner has already ${e.reviewStatus} this expense.`);
  const headId = (await body(c)).headId;
  const type = e.kind === 'expense' ? 'expense' : 'income';
  if (typeof headId !== 'string' || !isUuid(headId) || !(await one(db, 'SELECT 1 AS ok FROM heads WHERE id = ? AND business_id = ? AND type = ?', headId, bid, type))) {
    fail(400, `Choose the ${type} head.`);
  }
  const t = now();
  await db.batch([
    stmt(db, 'UPDATE cash_entries SET head_id = ? WHERE id = ?', headId, e.id),
    audit(db, { businessId: bid, userId: user.id, action: 'cashbook.head', table: 'cash_entries', rowId: e.id, before: { headId: e.headId }, after: { headId }, at: t }),
  ]);
  return c.json({ ok: true });
});

cashBookRoutes.post('/businesses/:businessId/cashbook-lines/:entryId/review', requireRole('members.manage'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const user = c.get('user');
  const e = await reviewLine(db, bid, c.req.param('entryId'));
  if (e.kind !== 'expense') fail(400, 'Only expenses are approved.');
  if (await one(db, 'SELECT 1 AS ok FROM cash_counts WHERE settle_entry_id = ?', e.id)) fail(409, 'This line came from settling a count. Undo the settle instead.');
  const data = await body(c);
  const status = data.status;
  if (status !== 'approved' && status !== 'rejected' && status !== null) fail(400, 'Approve or reject.');
  const note = text(data, 'note', 'Note', { optional: true, max: 300 }) ?? null;
  if (status === 'approved' && !e.headId) fail(400, 'The accountant sets the head first.');
  if (status === 'rejected' && !note) fail(400, 'Write why it is rejected.');
  const t = now();
  await db.batch([
    stmt(db, 'UPDATE cash_entries SET review_status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?',
      status, status ? user.id : null, status ? t : null, status ? note : null, e.id),
    audit(db, { businessId: bid, userId: user.id, action: 'cashbook.review', table: 'cash_entries', rowId: e.id,
      before: { status: e.reviewStatus }, after: { status, note }, at: t }),
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
