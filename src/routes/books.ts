import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, isUniqueViolation, newId, now, stmt } from '../db';
import { body, date, fail, isUuid, paise, text } from '../http';
import { auditAccountAfter, auditAccountBefore } from '../audit';

export const bookRoutes = new Hono<AppEnv>();

// ---- Accounts: Cash and each bank account, with an opening balance (integer paise) on an opening date.

function accountInput(data: Record<string, unknown>) {
  const kind = data.kind;
  if (kind !== 'cash' && kind !== 'bank') fail(400, 'Kind must be cash or bank.');
  return {
    name: text(data, 'name', 'Account name', { max: 120 })!,
    kind,
    accountNumber: text(data, 'accountNumber', 'Account number', { optional: true, max: 40 }),
    openingBalancePaise: paise(data, 'openingBalance', 'Opening balance'),
    openingDate: date(data, 'openingDate', 'Opening date'),
  };
}

const DUPLICATE_ACCOUNT = 'An account with this name already exists.';

bookRoutes.get('/businesses/:businessId/accounts', requireRole('accounts.view'), async (c) => {
  const accounts = await all(c.env.DB, `
    SELECT id, name, kind, account_number AS accountNumber,
           opening_balance_paise AS openingBalancePaise, opening_date AS openingDate
    FROM accounts WHERE business_id = ? ORDER BY kind = 'bank', name`, c.get('businessId'));
  return c.json({ accounts });
});

// Every account change and its audit row are one batch: both land or neither does.
bookRoutes.post('/businesses/:businessId/accounts', requireRole('accounts.edit'), async (c) => {
  const a = accountInput(await body(c));
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = newId();
  const t = now();
  try {
    await db.batch([
      stmt(db, `INSERT INTO accounts (id, business_id, name, kind, account_number, opening_balance_paise, opening_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, bid, a.name, a.kind, a.accountNumber, a.openingBalancePaise, a.openingDate, t),
      auditAccountAfter(db, { businessId: bid, userId: c.get('user').id, action: 'account.create', accountId: id, at: t, isCreate: true }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, DUPLICATE_ACCOUNT);
    throw e;
  }
  return c.json({ id }, 201);
});

bookRoutes.patch('/businesses/:businessId/accounts/:accountId', requireRole('accounts.edit'), async (c) => {
  const accountId = c.req.param('accountId');
  if (!isUuid(accountId)) fail(404, 'Account not found.');
  const a = accountInput(await body(c));
  const db = c.env.DB;
  const bid = c.get('businessId');
  const e = { businessId: bid, userId: c.get('user').id, action: 'account.update', accountId, at: now() };
  let results: D1Result[];
  try {
    results = await db.batch([
      auditAccountBefore(db, e),
      stmt(db, `UPDATE accounts SET name = ?, kind = ?, account_number = ?, opening_balance_paise = ?, opening_date = ?
        WHERE id = ? AND business_id = ?`, a.name, a.kind, a.accountNumber, a.openingBalancePaise, a.openingDate, accountId, bid),
      auditAccountAfter(db, { ...e, isCreate: false }),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) fail(409, DUPLICATE_ACCOUNT);
    throw err;
  }
  // No row in this business: the batch changed nothing (no audit row either).
  if (!results[1].meta.changes) fail(404, 'Account not found.');
  return c.json({ ok: true });
});

// ---- Heads: income and expense categories, each with an optional Tally ledger name.

const DUPLICATE_HEAD = 'A head with this name already exists.';

bookRoutes.get('/businesses/:businessId/heads', requireRole('heads.view'), async (c) => {
  const rows = await all<{ isCustom: number }>(c.env.DB, `
    SELECT id, name, type, tally_ledger AS tallyLedger, is_custom AS isCustom
    FROM heads WHERE business_id = ?
    ORDER BY type, is_custom, name`, c.get('businessId'));
  return c.json({ heads: rows.map((h) => ({ ...h, isCustom: h.isCustom === 1 })) });
});

bookRoutes.post('/businesses/:businessId/heads', requireRole('heads.edit'), async (c) => {
  const data = await body(c);
  const type = data.type;
  if (type !== 'income' && type !== 'expense') fail(400, 'Type must be income or expense.');
  const name = text(data, 'name', 'Head name', { max: 80 })!;
  const tally = text(data, 'tallyLedger', 'Tally ledger name', { optional: true, max: 120 });
  const id = newId();
  try {
    await stmt(c.env.DB, `INSERT INTO heads (id, business_id, name, type, tally_ledger, is_custom, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)`, id, c.get('businessId'), name, type, tally, now()).run();
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, DUPLICATE_HEAD);
    throw e;
  }
  return c.json({ id }, 201);
});

// Type is fixed once created; name and Tally ledger can change.
bookRoutes.patch('/businesses/:businessId/heads/:headId', requireRole('heads.edit'), async (c) => {
  const headId = c.req.param('headId');
  if (!isUuid(headId)) fail(404, 'Head not found.');
  const data = await body(c);
  const name = text(data, 'name', 'Head name', { max: 80 })!;
  const tally = text(data, 'tallyLedger', 'Tally ledger name', { optional: true, max: 120 });
  try {
    const res = await stmt(c.env.DB, 'UPDATE heads SET name = ?, tally_ledger = ? WHERE id = ? AND business_id = ?',
      name, tally, headId, c.get('businessId')).run();
    if (!res.meta.changes) fail(404, 'Head not found.');
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, DUPLICATE_HEAD);
    throw e;
  }
  return c.json({ ok: true });
});
