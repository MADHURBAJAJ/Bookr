// Parties and what Bookr has learned from items (approved 14 Nov 2026).
// - Parties: each party with its usual head, the heads it was booked to, its total and last payment in a month, and
//   a likely duplicate ("Same as Blinkit?", never merged by itself). Merge moves every line to the other party.
// - Items: the word an item is known by, the head it goes to, and how many lines; Change and Forget are kept in the
//   audit log and used by the item learning from then on.
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, now, one, stmt } from '../db';
import { body, fail, isUuid } from '../http';
import { itemKey, itemOverrides } from '../parties';

export const expenseRoutes = new Hono<AppEnv>();

const AUD = `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
// Words that do not make two names different ("Blinkit" and "BLINKIT COMMERCE PVT LTD").
const FILLER = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'commerce', 'india', 'the', 'and', 'co', 'company', 'enterprises', 'traders', 'store', 'stores', 'mart', 'services', 'com', 'www']);
export const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w && !FILLER.has(w)).join(' ');

expenseRoutes.get('/businesses/:businessId/parties-summary', requireRole('heads.view'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const q = c.req.query('month');
  const month = q && /^\d{4}-\d{2}$/.test(q) ? q : new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 7);
  const parties = await all<{ id: string; name: string; aliases: string; defaultHeadId: string | null; defaultHead: string | null;
    monthPaise: number | null; monthLines: number; lastDay: string | null; lines: number; heads: string }>(db, `
    SELECT p.id, p.name, p.aliases, p.default_head_id AS defaultHeadId, dh.name AS defaultHead,
      (SELECT sum(t.amount_paise) FROM transactions t WHERE t.party_id = p.id AND t.type = 'expense' AND substr(t.day, 1, 7) = ?) AS monthPaise,
      (SELECT count(*) FROM transactions t WHERE t.party_id = p.id AND t.type = 'expense' AND substr(t.day, 1, 7) = ?) AS monthLines,
      (SELECT max(t.day) FROM transactions t WHERE t.party_id = p.id AND t.type = 'expense') AS lastDay,
      (SELECT count(*) FROM transactions t WHERE t.party_id = p.id) AS lines,
      (SELECT json_group_array(json_object('id', head_id, 'name', hn, 'lines', n)) FROM (SELECT t.head_id, h.name AS hn, count(*) AS n FROM transactions t JOIN heads h ON h.id = t.head_id
         WHERE t.party_id = p.id AND t.type = 'expense' GROUP BY t.head_id ORDER BY n DESC)) AS heads
    FROM parties p LEFT JOIN heads dh ON dh.id = p.default_head_id WHERE p.business_id = ? ORDER BY lower(p.name)`, month, month, bid);
  const keys = parties.map((p) => ({ id: p.id, name: p.name, key: nameKey(p.name), lines: p.lines }));
  // A likely duplicate: the same name once filler words go, or one name inside the other. Points at the one with more lines (or the shorter name).
  const sameAs = (p: (typeof keys)[number]) => keys.filter((o) => o.id !== p.id && o.key.length >= 4 && p.key.length >= 4
    && (o.key === p.key || ` ${o.key} `.includes(` ${p.key} `) || ` ${p.key} `.includes(` ${o.key} `)) && (o.lines > p.lines || (o.lines === p.lines && o.name.length < p.name.length)))
    .sort((a, b) => b.lines - a.lines)[0] ?? null;
  return c.json({
    month,
    parties: parties.map((p, i) => ({ ...p, aliases: JSON.parse(p.aliases), heads: JSON.parse(p.heads), monthPaise: p.monthPaise ?? 0,
      sameAs: (() => { const s = sameAs(keys[i]); return s ? { id: s.id, name: s.name } : null; })() }))
      .sort((a, b) => b.monthPaise - a.monthPaise || a.name.localeCompare(b.name)),
  });
});

/** Merge: every line, other spelling and the remembered head move to the other party; this one goes. Owner or Accountant. */
expenseRoutes.post('/businesses/:businessId/parties/:partyId/merge', requireRole('heads.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const id = c.req.param('partyId');
  const into = (await body(c)).into;
  if (!isUuid(id) || typeof into !== 'string' || !isUuid(into) || into === id) fail(400, 'Choose the party to merge into.');
  const [from, to] = await Promise.all([
    one<{ id: string; name: string; aliases: string; default_head_id: string | null }>(db, 'SELECT id, name, aliases, default_head_id FROM parties WHERE id = ? AND business_id = ?', id, bid),
    one<{ id: string; name: string; aliases: string; default_head_id: string | null }>(db, 'SELECT id, name, aliases, default_head_id FROM parties WHERE id = ? AND business_id = ?', into, bid)]);
  if (!from || !to) fail(404, 'Party not found.');
  const lines = await all<{ id: string }>(db, 'SELECT id FROM transactions WHERE party_id = ? AND business_id = ?', id, bid);
  const aliases = [...new Map([...JSON.parse(to!.aliases) as string[], from!.name, ...JSON.parse(from!.aliases) as string[]]
    .filter((a) => a.toLowerCase().trim() !== to!.name.toLowerCase().trim()).map((a) => [a.toLowerCase().trim(), a] as const)).values()].slice(0, 30);
  await db.batch([
    stmt(db, 'UPDATE transactions SET party_id = ? WHERE party_id = ? AND business_id = ?', into, id, bid),
    stmt(db, 'UPDATE rules SET party_id = ? WHERE party_id = ? AND business_id = ?', into, id, bid),
    stmt(db, 'UPDATE parties SET aliases = ?, default_head_id = coalesce(default_head_id, ?) WHERE id = ?', JSON.stringify(aliases), from!.default_head_id, into),
    stmt(db, 'DELETE FROM parties WHERE id = ? AND business_id = ?', id, bid),
    stmt(db, AUD, bid, c.get('user').id, 'party.merge', 'parties', id, JSON.stringify({ party: from, lines: lines.map((l) => l.id) }), JSON.stringify({ into, name: to!.name }), now()),
  ]);
  return c.json({ ok: true, moved: lines.length });
});

/** What Bookr has learned from items: each item word, the head its latest line went to, and how many lines. */
expenseRoutes.get('/businesses/:businessId/learned-items', requireRole('heads.view'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const [rows, over, heads] = await Promise.all([
    all<{ narration: string; head_id: string; created_at: number }>(db, `SELECT narration, head_id, created_at FROM transactions WHERE business_id = ? AND type = 'expense'
      AND head_id IS NOT NULL AND narration IS NOT NULL AND trim(narration) <> '' ORDER BY created_at DESC LIMIT 5000`, bid),
    itemOverrides(db, bid),
    all<{ id: string; name: string }>(db, "SELECT id, name FROM heads WHERE business_id = ? AND type = 'expense'", bid),
  ]);
  const nameOf = new Map(heads.map((h) => [h.id, h.name]));
  const m = new Map<string, { word: string; headId: string; lines: number; heads: Set<string>; set: boolean }>();
  for (const r of rows) {
    const w = itemKey(r.narration);
    if (!w) continue;
    const o = over.get(w);
    if (o && r.created_at <= o.at) continue;
    const g = m.get(w) ?? { word: w, headId: r.head_id, lines: 0, heads: new Set<string>(), set: false };
    g.lines += 1; g.heads.add(r.head_id);
    m.set(w, g);
  }
  for (const [w, o] of over) if (o.headId && !m.has(w)) m.set(w, { word: w, headId: o.headId, lines: 0, heads: new Set([o.headId]), set: true });
  for (const [w, o] of over) { const g = m.get(w); if (g && o.headId && g.lines === 0) g.set = true; }
  return c.json({
    items: [...m.values()].sort((a, b) => b.lines - a.lines || a.word.localeCompare(b.word)).slice(0, 300)
      .map((g) => ({ word: g.word, headId: g.headId, head: nameOf.get(g.headId) ?? null, lines: g.lines, mixed: g.heads.size > 1, set: g.set })),
  });
});

/** Change: this item goes to this head from now on. Forget (headId null): its earlier lines are not used any more. */
expenseRoutes.put('/businesses/:businessId/learned-items', requireRole('heads.edit'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const data = await body(c);
  const word = typeof data.word === 'string' ? itemKey(data.word) : null;
  if (!word) fail(400, 'Say the item word.');
  const headId = data.headId == null ? null : typeof data.headId === 'string' && isUuid(data.headId) ? data.headId : fail(400, 'Choose the head.');
  if (headId && !(await one(db, "SELECT 1 AS x FROM heads WHERE id = ? AND business_id = ? AND type = 'expense'", headId, bid))) fail(400, 'Choose an expense head.');
  await db.batch([stmt(db, AUD, bid, c.get('user').id, headId ? 'item.head_set' : 'item.forget', 'heads', headId ?? word, null, JSON.stringify({ word, headId }), now())]);
  return c.json({ ok: true, word });
});
