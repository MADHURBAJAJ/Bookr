// Directors' accounts (approved 23 Nov 2026): see src/directors.ts. Read by Owner, Accountant and Viewer; changed by
// Owner and Accountant. Every change is audited and can be undone.
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, newId, now, one, stmt, type DB } from '../db';
import { body, date, fail, isUuid, paise, text } from '../http';
import { can } from '../permissions';
import { KIND_WORD, KINDS, ledgers, ledgerStart, nameKey, newNames, people, syncNc, toMove, type Kind } from '../directors';

import { loanRoutes } from './loans';

export const directorRoutes = new Hono<AppEnv>();
// Loans sit with the directors (approved 24 Nov 2026).
directorRoutes.route('/', loanRoutes);
const AUDIT = `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

directorRoutes.get('/businesses/:businessId/directors', requireRole('reports.view'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const editor = can(c.get('role'), 'rows.approve');
  const from = await ledgerStart(db, bid);
  if (from && editor) await syncNc(db, bid, c.get('user').id);
  const [families, names, sorted, move] = await Promise.all([
    ledgers(db, bid),
    from ? newNames(db, bid, from) : [],
    all<{ id: string; name_key: string; kind: string; director_id: string | null }>(db, 'SELECT id, name_key, kind, director_id FROM nc_names WHERE business_id = ? ORDER BY name_key', bid),
    from && editor ? toMove(db, bid, from) : [],
  ]);
  return c.json({ from, editor, families, newNames: names.map((n) => ({ ...n, guess: n.guess ? { id: n.guess.id, name: n.guess.name, family: n.guess.family } : null })),
    names: sorted.map((n) => ({ id: n.id, key: n.name_key, kind: n.kind, directorId: n.director_id })), toMove: move });
});

/** Set up: the day the ledger starts, and a family with its people (names separated by commas). */
directorRoutes.post('/businesses/:businessId/directors', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const from = data.from ? date(data, 'from', 'Start day') : null;
  const family = text(data, 'family', 'Family', { optional: true, max: 60 });
  const names = typeof data.names === 'string' ? data.names.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 12) : [];
  if (family && !names.length) fail(400, 'Name the people in this family.');
  const t = now();
  const user = c.get('user').id;
  const s: D1PreparedStatement[] = [];
  if (from) s.push(stmt(db, 'UPDATE businesses SET directors_from = ? WHERE id = ?', from, bid), stmt(db, AUDIT, bid, user, 'directors.start', 'businesses', bid, null, JSON.stringify({ from }), t));
  const have = new Set((await people(db, bid)).map((p) => p.name.toLowerCase()));
  for (const n of names) {
    if (have.has(n.toLowerCase())) fail(409, `${n} is already a director.`);
    const id = newId();
    s.push(stmt(db, 'INSERT INTO directors (id, business_id, family, name, created_at) VALUES (?, ?, ?, ?, ?)', id, bid, family, n, t),
      stmt(db, AUDIT, bid, user, 'directors.person', 'directors', id, null, JSON.stringify({ family, name: n }), t));
  }
  if (!s.length) fail(400, 'Nothing to save.');
  await db.batch(s);
  return c.json({ ok: true });
});

/** A person's opening balance on the start day: owes the hotel, or the hotel owes them. */
directorRoutes.put('/businesses/:businessId/directors/:id/opening', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const p = isUuid(id) ? await one<{ name: string }>(db, 'SELECT name FROM directors WHERE id = ? AND business_id = ?', id, bid) : null;
  if (!p) fail(404, 'Not found.');
  const from = await ledgerStart(db, bid);
  if (!from) fail(400, 'Choose the day the ledger starts first.');
  const data = await body(c);
  const amount = paise(data, 'amount', 'Opening balance');
  const owed = data.side === 'owed';
  const value = owed ? -amount : amount;
  const old = await one<Record<string, unknown>>(db, "SELECT * FROM director_entries WHERE director_id = ? AND kind = 'opening'", id);
  const t = now();
  const user = c.get('user').id;
  await db.batch([
    stmt(db, "DELETE FROM director_entries WHERE director_id = ? AND kind = 'opening'", id),
    stmt(db, `INSERT INTO director_entries (id, business_id, director_id, day, kind, amount_paise, note, created_by, created_at) VALUES (?, ?, ?, ?, 'opening', ?, ?, ?, ?)`,
      newId(), bid, id, from, value, owed ? 'The hotel owes' : 'Owes the hotel', user, t),
    stmt(db, AUDIT, bid, user, 'directors.opening', 'directors', id, old ? JSON.stringify(old) : null, JSON.stringify({ name: p!.name, amountPaise: value, day: from }), t),
  ]);
  return c.json({ ok: true });
});

const kindOf = (v: unknown, allowed: Kind[]) => (typeof v === 'string' && (allowed as string[]).includes(v) ? v as Kind : fail(400, `Choose ${allowed.map((k) => KIND_WORD[k]).join(', ')}.`));

/**
 * A line in a ledger. With transactionId, the cash line it explains (an approved cash expense): Taken, Given or Repaid
 * keep the cash line (the cash left the drawer); Stock taken removes it (no cash left: goods from stock), kept in the
 * audit so Undo puts it back. Without, a line typed in (amount and day).
 */
directorRoutes.post('/businesses/:businessId/director-entries', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const directorId = typeof data.directorId === 'string' && isUuid(data.directorId) ? data.directorId : fail(400, 'Choose the person.');
  const person = await one<{ name: string; family: string }>(db, 'SELECT name, family FROM directors WHERE id = ? AND business_id = ?', directorId, bid);
  if (!person) fail(404, 'Choose the person.');
  const kind = kindOf(data.kind, ['taken', 'stock_taken', 'given', 'repaid']);
  const note = text(data, 'note', 'Note', { optional: true, max: 200 });
  const t = now();
  const user = c.get('user').id;
  const id = newId();
  if (typeof data.transactionId === 'string') {
    const tx = isUuid(data.transactionId) ? await one<Record<string, unknown> & { id: string; day: string; amount_paise: number; narration: string | null; type: string; status: string }>(db,
      "SELECT * FROM transactions WHERE id = ? AND business_id = ? AND type = 'expense'", data.transactionId, bid) : null;
    if (!tx) fail(404, 'Line not found.');
    if (await one(db, 'SELECT 1 AS x FROM director_entries WHERE transaction_id = ?', tx!.id)) fail(409, 'This line is already in a director\'s account.');
    const keep = kind !== 'stock_taken';
    await db.batch([
      stmt(db, `INSERT INTO director_entries (id, business_id, director_id, day, kind, amount_paise, note, transaction_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, bid, directorId, tx!.day, kind, tx!.amount_paise, note ?? tx!.narration, keep ? tx!.id : null, user, t),
      ...(keep ? [] : [stmt(db, 'DELETE FROM transactions WHERE id = ?', tx!.id)]),
      stmt(db, AUDIT, bid, user, 'directors.entry', 'director_entries', id, keep ? null : JSON.stringify({ removedTx: tx }),
        JSON.stringify({ person: person!.name, family: person!.family, kind, amountPaise: tx!.amount_paise, transactionId: tx!.id, changes: `${person!.family} · ${person!.name} · ${KIND_WORD[kind]} ${rs(tx!.amount_paise)}${keep ? '' : ' (cash line removed: no cash left)'}` }), t),
    ]);
    return c.json({ ok: true, id });
  }
  const day = date(data, 'day', 'Day');
  const amount = paise(data, 'amount', 'Amount');
  if (amount <= 0) fail(400, 'Amount must be more than zero.');
  await db.batch([
    stmt(db, `INSERT INTO director_entries (id, business_id, director_id, day, kind, amount_paise, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, bid, directorId, day, kind, amount, note, user, t),
    stmt(db, AUDIT, bid, user, 'directors.entry', 'director_entries', id, null, JSON.stringify({ person: person!.name, kind, amountPaise: amount, day, changes: `${person!.name} · ${KIND_WORD[kind]} ${rs(amount)}` }), t),
  ]);
  return c.json({ ok: true, id });
});

/** Move past WITHDRAWL lines into the ledgers, each with its person and kind, in one go. The cash lines stay. */
directorRoutes.post('/businesses/:businessId/director-entries/move', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const items = Array.isArray(data.items) ? data.items.slice(0, 300) : [];
  if (!items.length) fail(400, 'Nothing to move.');
  const ppl = new Map((await people(db, bid)).map((p) => [p.id, p]));
  const t = now();
  const user = c.get('user').id;
  const s: D1PreparedStatement[] = [];
  const ids: string[] = [];
  for (const raw of items) {
    const x = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const p = typeof x.directorId === 'string' ? ppl.get(x.directorId) : undefined;
    if (!p) fail(400, 'Choose a person on every line.');
    const kind = kindOf(x.kind, ['taken', 'given', 'repaid']);
    const tx = typeof x.transactionId === 'string' && isUuid(x.transactionId) ? await one<{ id: string; day: string; amount_paise: number; narration: string | null }>(db,
      "SELECT id, day, amount_paise, narration FROM transactions WHERE id = ? AND business_id = ? AND type = 'expense'", x.transactionId, bid) : null;
    if (!tx) fail(404, 'A line was not found: reload.');
    const id = newId();
    ids.push(id);
    s.push(stmt(db, `INSERT INTO director_entries (id, business_id, director_id, day, kind, amount_paise, note, transaction_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, bid, p!.id, tx!.day, kind, tx!.amount_paise, tx!.narration, tx!.id, user, t));
  }
  s.push(stmt(db, AUDIT, bid, user, 'directors.move', 'director_entries', ids[0], null, JSON.stringify({ ids, changes: `${ids.length} WITHDRAWL line${ids.length === 1 ? '' : 's'} moved into the ledgers` }), t));
  try { await db.batch(s); } catch (e) { if (/UNIQUE/i.test(String(e))) fail(409, 'A line is already in a ledger: reload.'); throw e; }
  return c.json({ ok: true, ids });
});

/** Takes a line out of a ledger (Undo). A stock-taken line gets its cash line back. NC lines follow their bills. */
directorRoutes.delete('/businesses/:businessId/director-entries/:id', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const e = isUuid(id) ? await one<Record<string, unknown> & { kind: string }>(db, 'SELECT * FROM director_entries WHERE id = ? AND business_id = ?', id, bid) : null;
  if (!e) fail(404, 'Not found.');
  if (e!.kind === 'nc') fail(400, 'An NC line follows its bill: change the name on the bill, or sort the name again.');
  if (e!.transaction_id && await one(db, "SELECT 1 AS x FROM transactions WHERE id = ? AND type = 'transfer' AND json_extract(ocr_original, '$.card') = 'booked'", e!.transaction_id))
    fail(409, 'This line came from a card payment: Undo it on that shift\'s Card tab.');
  const made = await one<{ before: string | null }>(db, "SELECT before FROM audit_log WHERE business_id = ? AND action = 'directors.entry' AND row_id = ? ORDER BY id DESC LIMIT 1", bid, id);
  const removed = made?.before ? (JSON.parse(made.before) as { removedTx?: Record<string, unknown> }).removedTx : undefined;
  const s: D1PreparedStatement[] = [stmt(db, 'DELETE FROM director_entries WHERE id = ?', id)];
  if (removed) { const k = Object.keys(removed); s.push(stmt(db, `INSERT INTO transactions (${k.join(', ')}) VALUES (${k.map(() => '?').join(', ')})`, ...k.map((x) => removed[x] as never))); }
  s.push(stmt(db, AUDIT, bid, c.get('user').id, 'directors.entry_removed', 'director_entries', id, JSON.stringify(e), JSON.stringify({ changes: `Taken out of the ledger${removed ? ', cash line back' : ''}` }), now()));
  await db.batch(s);
  return c.json({ ok: true });
});

/** A name on complimentary bills, sorted once: director (which person), staff, or someone else. */
directorRoutes.post('/businesses/:businessId/nc-names', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const key = nameKey(text(data, 'name', 'Name', { max: 120 }));
  if (!key) fail(400, 'The name has no letters.');
  const kind = data.kind === 'director' || data.kind === 'staff' || data.kind === 'other' ? data.kind : fail(400, 'Choose director, staff or other.');
  const directorId = kind === 'director' ? (typeof data.directorId === 'string' && isUuid(data.directorId) ? data.directorId : fail(400, 'Choose the person.')) : null;
  if (directorId && !(await one(db, 'SELECT 1 AS x FROM directors WHERE id = ? AND business_id = ?', directorId, bid))) fail(404, 'Choose the person.');
  const old = await one<Record<string, unknown>>(db, 'SELECT * FROM nc_names WHERE business_id = ? AND name_key = ?', bid, key);
  const t = now();
  const user = c.get('user').id;
  await db.batch([
    stmt(db, `INSERT INTO nc_names (id, business_id, name_key, kind, director_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (business_id, name_key) DO UPDATE SET kind = excluded.kind, director_id = excluded.director_id, created_by = excluded.created_by, created_at = excluded.created_at`,
      newId(), bid, key, kind, directorId, user, t),
    stmt(db, AUDIT, bid, user, 'directors.nc_name', 'nc_names', key, old ? JSON.stringify(old) : null, JSON.stringify({ key, kind, directorId }), t),
  ]);
  const sync = await syncNc(db, bid, user);
  return c.json({ ok: true, ...sync });
});

directorRoutes.delete('/businesses/:businessId/nc-names/:key', requireRole('rows.approve'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const key = nameKey(c.req.param('key'));
  const old = await one<Record<string, unknown>>(db, 'SELECT * FROM nc_names WHERE business_id = ? AND name_key = ?', bid, key);
  if (!old) return c.json({ ok: true, unchanged: true });
  await db.batch([
    stmt(db, 'DELETE FROM nc_names WHERE business_id = ? AND name_key = ?', bid, key),
    stmt(db, AUDIT, bid, c.get('user').id, 'directors.nc_name_removed', 'nc_names', key, JSON.stringify(old), null, now()),
  ]);
  await syncNc(db, bid, c.get('user').id);
  return c.json({ ok: true });
});

export async function ncNamesFor(db: DB, bid: string) {
  return all<{ name_key: string; kind: string; director_id: string | null; person: string | null; family: string | null }>(db,
    'SELECT n.name_key, n.kind, n.director_id, d.name AS person, d.family FROM nc_names n LEFT JOIN directors d ON d.id = n.director_id WHERE n.business_id = ?', bid);
}
export { KINDS };
