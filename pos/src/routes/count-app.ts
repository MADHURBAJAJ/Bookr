// The Bar Count app (mock and data model approved by the owner 28 Nov 2026).
//
// Bar staff count bar stock on their own phones, at /count/<business id>, installed as its own app ("Bar Count"). They sign
// in with the same mobile number and 6-digit PIN as the Serve app (routes/serve.ts: one person, one PIN), and the Owner
// ticks what each person may use (Settings › Staff and PINs › People on phones):
//   bar_count       count lists of a bar store (and the main store)
//   kitchen_count   count lists of a kitchen store (and the main store)
//   approve_counts  approve a count, or send rows back to be counted again, on the phone
// Every request checks, on the server, that the person is still active, signed in from a shift not yet closed, and ticked
// for what they ask. A phone count is a live count (each row compared with the stock when it was typed); rows typed with
// no Wi-Fi are sent later with the time they were typed. Stock changes only when someone ticked for Approve counts
// approves it, here or at the PC; a count waiting for approval never stops the next day's count or the day close.
import { Hono, type Context } from 'hono';
import { all, newId, now, one, stmt } from '../../../src/db';
import { body, fail } from '../../../src/http';
import { loadBusiness } from '../util';
import type { AppEnv } from '../types';
import { currentServer, type Access, type Server } from './serve';
import { approveCount, backCount, countOf, countOut, groupsOf, itemsAll, saveLines, sendCount, type Actor, type CountRow, type List } from './stock-counts';

export const countAppRoutes = new Hono<AppEnv>();

/** May this person count a list kept in a store of this kind? */
export const mayCount = (kind: string, access: Access[]) =>
  kind === 'bar' ? access.includes('bar_count') : kind === 'kitchen' ? access.includes('kitchen_count') : access.includes('bar_count') || access.includes('kitchen_count');
const counts = (s: Server) => s.access.includes('bar_count') || s.access.includes('kitchen_count');
const approves = (s: Server) => s.access.includes('approve_counts');
const actor = (s: Server): Actor => ({ staff: null, server: s.id });

async function person(c: Context<AppEnv>) {
  const s = await currentServer(c);
  if (!counts(s) && !approves(s)) fail(403, 'You are not set up for the Bar Count app. Ask the owner.');
  await stmt(c.env.DB, 'UPDATE servers SET last_seen_at = ? WHERE id = ?', now(), s.id).run();
  return s;
}

/** A count this person may open: their own, or any count when they approve counts. */
async function countFor(c: Context<AppEnv>, s: Server, id: string) {
  const k = await countOf(c.env.DB, s.businessId, id);
  if (k.by_server !== s.id && !approves(s)) fail(404, 'Count not found.');
  return k;
}
/** Their own count, to type into or send. */
async function ownCount(c: Context<AppEnv>, s: Server, id: string) {
  const k = await countOf(c.env.DB, s.businessId, id);
  if (k.by_server !== s.id) fail(404, 'Count not found.');
  const store = await one<{ kind: string }>(c.env.DB, 'SELECT kind FROM stock_stores WHERE id = ?', k.store_id);
  if (!mayCount(store?.kind ?? '', s.access)) fail(403, 'You are not set up to count this store. Ask the owner.');
  return k;
}

// The start screen: the lists this person may count, their open counts, and (if they approve) counts waiting.
countAppRoutes.get('/count/me', async (c) => {
  const s = await person(c);
  const db = c.env.DB;
  const bid = s.businessId;
  const lists = await all<List & { store: string; kind: string }>(db, `SELECT l.id, l.store_id, l.name, l.categories, l.off_items, l.on_items, st.name AS store, st.kind
    FROM count_lists l JOIN stock_stores st ON st.id = l.store_id WHERE l.business_id = ? ORDER BY l.created_at`, bid);
  const items = await itemsAll(db, bid);
  const rowsOf = `(SELECT count(*) FROM stock_count_lines x WHERE x.count_id = k.id)`;
  const mine = await all(db, `SELECT k.id, k.status, k.note, k.created_at AS createdAt, k.sent_at AS sentAt, l.name AS list, ${rowsOf} AS rows,
      (SELECT count(*) FROM stock_count_lines x WHERE x.count_id = k.id AND x.recount = 1) AS again
    FROM stock_counts k LEFT JOIN count_lists l ON l.id = k.list_id
    WHERE k.business_id = ? AND k.by_server = ? AND (k.status IN ('draft', 'sent_back') OR (k.status = 'waiting' AND k.sent_at > ?)) ORDER BY k.created_at DESC LIMIT 20`,
    bid, s.id, now() - 3 * 86_400_000);
  const waiting = approves(s) ? await all(db, `SELECT k.id, k.created_at AS createdAt, k.sent_at AS sentAt, k.mode, l.name AS list, st.name AS store,
      coalesce(sf.name, sv.name) AS byName, ${rowsOf} AS rows
    FROM stock_counts k JOIN stock_stores st ON st.id = k.store_id LEFT JOIN count_lists l ON l.id = k.list_id
    LEFT JOIN staff sf ON sf.id = k.by_staff LEFT JOIN servers sv ON sv.id = k.by_server
    WHERE k.business_id = ? AND k.status = 'waiting' ORDER BY k.sent_at DESC LIMIT 30`, bid) : [];
  return c.json({
    person: { name: s.name, access: s.access }, business: s.businessName, now: now(),
    lists: lists.filter((l) => mayCount(l.kind, s.access)).map((l) => ({ id: l.id, name: l.name, store: l.store, items: groupsOf(l, items).reduce((n, g) => n + g.items.length, 0) })),
    mine, waiting,
  });
});

// Start counting a list, or carry on with this person's count of it that is not sent yet (or was sent back).
countAppRoutes.post('/count/start', async (c) => {
  const s = await person(c);
  const db = c.env.DB;
  const data = await body(c);
  const l = typeof data.listId === 'string'
    ? await one<{ id: string; store_id: string; kind: string }>(db, 'SELECT l.id, l.store_id, st.kind FROM count_lists l JOIN stock_stores st ON st.id = l.store_id WHERE l.id = ? AND l.business_id = ?', data.listId, s.businessId)
    : null;
  if (!l) fail(404, 'Count list not found.');
  if (!mayCount(l.kind, s.access)) fail(403, 'You are not set up to count this list. Ask the owner.');
  const open = await one<{ id: string }>(db, "SELECT id FROM stock_counts WHERE business_id = ? AND by_server = ? AND list_id = ? AND status IN ('draft', 'sent_back') ORDER BY created_at DESC LIMIT 1",
    s.businessId, s.id, l.id);
  if (open) return c.json({ id: open.id });
  const id = newId();
  await stmt(db, "INSERT INTO stock_counts (id, business_id, store_id, list_id, mode, counted_at, by_server, created_at) VALUES (?, ?, ?, ?, 'live', NULL, ?, ?)",
    id, s.businessId, l.store_id, l.id, s.id, now()).run();
  return c.json({ id }, 201);
});

countAppRoutes.get('/count/counts/:id', async (c) => {
  const s = await person(c);
  const k = await countFor(c, s, c.req.param('id'));
  return c.json({ ...(await countOut(c.env.DB, s.businessId, k)), mine: k.by_server === s.id, canApprove: approves(s) && k.status === 'waiting' });
});

// Rows as they are typed. The phone sends each row with the time it was typed, and sends again what the Wi-Fi dropped.
countAppRoutes.put('/count/counts/:id', async (c) => {
  const s = await person(c);
  const k = await ownCount(c, s, c.req.param('id'));
  const data = await body(c);
  if (data.countedAt !== undefined) fail(400, 'A phone count is a live count.');
  await saveLines(c.env.DB, s.businessId, k, data, { typedAt: true });
  const n = await one<{ n: number }>(c.env.DB, 'SELECT count(*) AS n FROM stock_count_lines WHERE count_id = ?', k.id);
  return c.json({ ok: true, rows: n?.n ?? 0 });
});

countAppRoutes.post('/count/counts/:id/send', async (c) => {
  const s = await person(c);
  const k = await ownCount(c, s, c.req.param('id'));
  const rows = await sendCount(c.env.DB, s.businessId, k, actor(s));
  return c.json({ ok: true, rows });
});

// Approving and sending back on the phone: only people ticked for Approve counts.
async function toCheck(c: Context<AppEnv>): Promise<{ s: Server; k: CountRow }> {
  const s = await person(c);
  if (!approves(s)) fail(403, 'Only people the Owner has ticked for Approve counts can check counts.');
  return { s, k: await countOf(c.env.DB, s.businessId, c.req.param('id') ?? '') };
}
countAppRoutes.post('/count/counts/:id/back', async (c) => {
  const { s, k } = await toCheck(c);
  await backCount(c.env.DB, s.businessId, k, await body(c), actor(s));
  return c.json({ ok: true });
});
countAppRoutes.post('/count/counts/:id/approve', async (c) => {
  const { s, k } = await toCheck(c);
  const r = await approveCount(c.env.DB, await loadBusiness(c.env.DB, s.businessId), k, actor(s));
  return c.json({ ok: true, ...r });
});
