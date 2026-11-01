import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { body, date, fail, isUniqueViolation, isUuid, money, text } from '../http';
import { audit } from '../audit';

export const bookRoutes = new Hono<AppEnv>();

// ---- Accounts: Cash and each bank account, with an opening balance on an opening date.

const ACCOUNT_COLUMNS = `id, name, kind, account_number AS "accountNumber",
  opening_balance::text AS "openingBalance", to_char(opening_date, 'YYYY-MM-DD') AS "openingDate"`;

function accountInput(data: Record<string, unknown>) {
  const kind = data.kind;
  if (kind !== 'cash' && kind !== 'bank') fail(400, 'Kind must be cash or bank.');
  return {
    name: text(data, 'name', 'Account name', { max: 120 })!,
    kind,
    accountNumber: text(data, 'accountNumber', 'Account number', { optional: true, max: 40 }),
    openingBalance: money(data, 'openingBalance', 'Opening balance'),
    openingDate: date(data, 'openingDate', 'Opening date'),
  };
}

bookRoutes.get('/businesses/:businessId/accounts', requireRole('accounts.view'), async (c) => {
  const accounts = await c.get('sql').unsafe(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE business_id = $1 ORDER BY kind = 'bank', name`,
    [c.get('businessId')],
  );
  return c.json({ accounts });
});

// Every account change is written to the audit log in the same transaction.
bookRoutes.post('/businesses/:businessId/accounts', requireRole('accounts.edit'), async (c) => {
  const a = accountInput(await body(c));
  const bid = c.get('businessId');
  try {
    const id = await c.get('sql').begin(async (tx) => {
      const [row] = await tx.unsafe(
        `INSERT INTO accounts (business_id, name, kind, account_number, opening_balance, opening_date)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${ACCOUNT_COLUMNS}`,
        [bid, a.name, a.kind, a.accountNumber, a.openingBalance, a.openingDate],
      );
      await audit(tx, { businessId: bid, userId: c.get('user').id, action: 'account.create', table: 'accounts', rowId: row.id, before: null, after: row });
      return row.id as string;
    });
    return c.json({ id }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'An account with this name already exists.');
    throw e;
  }
});

bookRoutes.patch('/businesses/:businessId/accounts/:accountId', requireRole('accounts.edit'), async (c) => {
  const accountId = c.req.param('accountId');
  if (!isUuid(accountId)) fail(404, 'Account not found.');
  const a = accountInput(await body(c));
  const bid = c.get('businessId');
  try {
    await c.get('sql').begin(async (tx) => {
      const [before] = await tx.unsafe(
        `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1 AND business_id = $2 FOR UPDATE`,
        [accountId, bid],
      );
      if (!before) fail(404, 'Account not found.');
      const [after] = await tx.unsafe(
        `UPDATE accounts SET name = $3, kind = $4, account_number = $5, opening_balance = $6, opening_date = $7
         WHERE id = $1 AND business_id = $2 RETURNING ${ACCOUNT_COLUMNS}`,
        [accountId, bid, a.name, a.kind, a.accountNumber, a.openingBalance, a.openingDate],
      );
      await audit(tx, { businessId: bid, userId: c.get('user').id, action: 'account.update', table: 'accounts', rowId: accountId, before, after });
    });
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'An account with this name already exists.');
    throw e;
  }
  return c.json({ ok: true });
});

// ---- Heads: income and expense categories, each with an optional Tally ledger name.

bookRoutes.get('/businesses/:businessId/heads', requireRole('heads.view'), async (c) => {
  const heads = await c.get('sql')`
    SELECT id, name, type, tally_ledger AS "tallyLedger", is_custom AS "isCustom"
    FROM heads WHERE business_id = ${c.get('businessId')}
    ORDER BY type, is_custom, name`;
  return c.json({ heads });
});

bookRoutes.post('/businesses/:businessId/heads', requireRole('heads.edit'), async (c) => {
  const data = await body(c);
  const type = data.type;
  if (type !== 'income' && type !== 'expense') fail(400, 'Type must be income or expense.');
  const name = text(data, 'name', 'Head name', { max: 80 })!;
  const tally = text(data, 'tallyLedger', 'Tally ledger name', { optional: true, max: 120 });
  try {
    const [row] = await c.get('sql')`
      INSERT INTO heads (business_id, name, type, tally_ledger, is_custom)
      VALUES (${c.get('businessId')}, ${name}, ${type}, ${tally}, true)
      RETURNING id`;
    return c.json({ id: row.id }, 201);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'A head with this name already exists.');
    throw e;
  }
});

// Type is fixed once created; name and Tally ledger can change.
bookRoutes.patch('/businesses/:businessId/heads/:headId', requireRole('heads.edit'), async (c) => {
  const headId = c.req.param('headId');
  if (!isUuid(headId)) fail(404, 'Head not found.');
  const data = await body(c);
  const name = text(data, 'name', 'Head name', { max: 80 })!;
  const tally = text(data, 'tallyLedger', 'Tally ledger name', { optional: true, max: 120 });
  try {
    const rows = await c.get('sql')`
      UPDATE heads SET name = ${name}, tally_ledger = ${tally}
      WHERE id = ${headId} AND business_id = ${c.get('businessId')}
      RETURNING id`;
    if (!rows.length) fail(404, 'Head not found.');
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'A head with this name already exists.');
    throw e;
  }
  return c.json({ ok: true });
});
