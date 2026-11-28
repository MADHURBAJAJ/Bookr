// Serving time (mock and data model approved 28 Nov 2026).
//
// The Serve page, on a server's own phone: a server signs in with a 6-digit PIN (on any phone, no device set-up; approved
// 28 Nov 2026), sees only the running KOTs, and marks items served with a photo. A server's sign-in is a separate cookie
// and table from staff sign-in, so it can never reach a staff route; and every request here checks, on the server, that the
// server is still active and their sign-in is from a shift not yet closed. Wrong PINs block only the connection they came
// from: 10 in 15 minutes, or 30 from a connection servers have signed in from before (the hotel Wi-Fi); a manager can unlock.
//
// The manager's side, on the billing PC (Manager and Owner, checked per request): what is waiting and what was served today,
// mark a forgotten item served (no photo), undo a mark with a reason, see the photos, unlock a connection. The Owner adds
// and removes servers. Every manager mark and every undo goes to the exceptions log.
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { all, newId, now, one, stmt } from '../../../src/db';
import { DUMMY_HASH, hashPassword, randomToken, sha256, verifyPassword } from '../../../src/crypto';
import { body, fail, isUuid, text } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { isWaiting, kotTiles, lineOut, SERVER_UNDO_MS, timedLines } from '../serving';
import { audit, bizOf, clock, event, loadBusiness } from '../util';
import type { AppEnv } from '../types';

export const serveRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
export const SERVE_COOKIE = 'pos_serve';
const MIN = 60_000;
const SESSION_MS = 16 * 60 * MIN;
const TRY_WINDOW_MS = 15 * MIN;
export const WRONG_LIMIT = 10;
export const WRONG_LIMIT_KNOWN = 30;
const KNOWN_MS = 7 * 24 * 60 * MIN;
const MAX_PHOTO = 5 * 1024 * 1024;

const pinKey = (bid: string, pin: string) => sha256(`serve-pin:${bid}:${pin}`);
/** The internet connection a request came from, as a hash per business (the address itself is never stored). */
const connOf = (c: Context<AppEnv>, bid: string) => sha256(`serve-conn:${bid}:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`);
const photoKey = (bid: string, batch: string) => `pos/${bid}/served/${batch}.jpg`;

interface Server { id: string; name: string; businessId: string; businessName: string; shiftDay: string }

async function currentServer(c: Context<AppEnv>): Promise<Server> {
  const token = getCookie(c, SERVE_COOKIE);
  if (!token) fail(401, 'Please sign in with your PIN.');
  const row = await one<{ id: string; name: string; business_id: string; b_name: string; shift_day: string }>(c.env.DB, `
    SELECT sv.id, sv.name, sv.business_id, b.name AS b_name, ss.shift_day FROM serve_sessions ss
    JOIN servers sv ON sv.id = ss.server_id JOIN businesses b ON b.id = sv.business_id
    WHERE ss.id = ? AND ss.expires_at > ? AND sv.active = 1 AND b.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM shift_closes x WHERE x.business_id = b.id AND x.shift_day >= ss.shift_day)`, await sha256(token), now());
  if (!row) {
    deleteCookie(c, SERVE_COOKIE, { path: '/', secure: true });
    fail(401, 'Please sign in with your PIN.');
  }
  return { id: row.id, name: row.name, businessId: row.business_id, businessName: row.b_name, shiftDay: row.shift_day };
}

/** Wrong PINs from this connection in the last 15 minutes, and how many it may have. */
async function tries(db: D1Database, bid: string, conn: string, t: number) {
  const r = await one<{ wrong: number; known: number }>(db, `SELECT
      (SELECT count(*) FROM serve_signins WHERE business_id = ?1 AND conn = ?2 AND ok = 0 AND cleared_at IS NULL AND at > ?3) AS wrong,
      EXISTS (SELECT 1 FROM serve_signins WHERE business_id = ?1 AND conn = ?2 AND ok = 1 AND at > ?4) AS known`, bid, conn, t - TRY_WINDOW_MS, t - KNOWN_MS);
  return { wrong: r?.wrong ?? 0, limit: r?.known ? WRONG_LIMIT_KNOWN : WRONG_LIMIT };
}

// ---------- the server's phone

serveRoutes.post('/serve/signin', async (c) => {
  const data = await body(c);
  const bid = typeof data.businessId === 'string' ? data.businessId : '';
  if (!isUuid(bid)) fail(404, 'This Serve link is not right. Ask the manager for the link.');
  const pin = typeof data.pin === 'string' ? data.pin : '';
  const phone = mobileOf(data.phone);
  const biz = await one<{ status: string }>(c.env.DB, 'SELECT status FROM businesses WHERE id = ?', bid);
  if (!biz) fail(404, 'This Serve link is not right. Ask the manager for the link.');
  if (biz.status !== 'active') fail(403, 'This restaurant is paused.');
  const b = await loadBusiness(c.env.DB, bid);
  const t = now();
  const day = clock(b, t).shiftDay;
  const conn = await connOf(c, bid);
  const tr = await tries(c.env.DB, bid, conn, t);
  if (tr.wrong >= tr.limit) fail(429, 'Too many wrong PINs from this connection. Wait 15 minutes, or ask a manager to unlock it.');
  // The mobile number says who it is (28 Nov 2026); the PIN proves it.
  const sv = /^\d{6}$/.test(pin) && phone ? await one<{ id: string; pin_hash: string }>(c.env.DB,
    'SELECT id, pin_hash FROM servers WHERE business_id = ? AND phone = ? AND active = 1', bid, phone) : null;
  const ok = await verifyPassword(pin, sv?.pin_hash ?? DUMMY_HASH);
  if (!sv || !ok) {
    await stmt(c.env.DB, 'INSERT INTO serve_signins (business_id, conn, ok, server_id, shift_day, at) VALUES (?, ?, 0, NULL, ?, ?)', bid, conn, day, t).run();
    fail(401, tr.wrong + 1 >= tr.limit ? 'Wrong mobile number or PIN. Too many tries: this connection is blocked for 15 minutes.' : 'Wrong mobile number or PIN.');
  }
  const token = randomToken();
  await c.env.DB.batch([
    stmt(c.env.DB, 'INSERT INTO serve_sessions (id, server_id, business_id, shift_day, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', await sha256(token), sv.id, bid, day, t, t + SESSION_MS),
    stmt(c.env.DB, 'INSERT INTO serve_signins (business_id, conn, ok, server_id, shift_day, at) VALUES (?, ?, 1, ?, ?, ?)', bid, conn, sv.id, day, t),
    stmt(c.env.DB, 'UPDATE servers SET last_seen_at = ? WHERE id = ?', t, sv.id),
  ]);
  setCookie(c, SERVE_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_MS / 1000 });
  return c.json({ ok: true });
});

serveRoutes.post('/serve/signout', async (c) => {
  const token = getCookie(c, SERVE_COOKIE);
  if (token) await stmt(c.env.DB, 'DELETE FROM serve_sessions WHERE id = ?', await sha256(token)).run();
  deleteCookie(c, SERVE_COOKIE, { path: '/', secure: true });
  return c.json({ ok: true });
});

// The running KOTs, most late first, with the server's own taps they may still undo.
serveRoutes.get('/serve/kots', async (c) => {
  const s = await currentServer(c);
  const t = now();
  const [lines] = await Promise.all([
    timedLines(c.env.DB, s.businessId, { running: true, now: t }),
    stmt(c.env.DB, 'UPDATE servers SET last_seen_at = ? WHERE id = ?', t, s.id).run(),
  ]);
  const mine = await all<{ batch: string; at: number; photo: number; place: string; n: number }>(c.env.DB, `
    SELECT ks.batch, max(ks.served_at) AS at, max(ks.photo_at IS NOT NULL) AS photo, o.place, count(*) AS n FROM kot_served ks
    JOIN kots k ON k.id = ks.kot_id JOIN orders o ON o.id = k.order_id
    WHERE ks.business_id = ? AND ks.server_id = ? AND ks.served_at > ? GROUP BY ks.batch, o.place ORDER BY at DESC`, s.businessId, s.id, t - SERVER_UNDO_MS);
  return c.json({ server: { name: s.name }, business: s.businessName, now: t, kots: kotTiles(lines, t),
    recent: mine.map((m) => ({ batch: m.batch, at: m.at, place: m.place, items: m.n, photo: !!m.photo, undoUntil: m.at + SERVER_UNDO_MS })) });
});

// Mark items of a KOT served (the server's tap, after the photo is taken). The time is now: it cannot be typed.
serveRoutes.post('/serve/kots/:id/served', async (c) => {
  const s = await currentServer(c);
  const data = await body(c);
  const want = data.lines;
  if (!Array.isArray(want) || !want.length || want.length > 50 || !want.every((n) => Number.isInteger(n) && n >= 0)) fail(400, 'Choose what is going out.');
  const t = now();
  const kotId = c.req.param('id');
  const lines = (await timedLines(c.env.DB, s.businessId, { running: true, now: t })).filter((l) => l.kotId === kotId);
  if (!lines.length) fail(404, 'This KOT is not on the running list any more.');
  const chosen = [...new Set(want as number[])].map((n) => lines.find((l) => l.lineNo === n));
  if (chosen.some((l) => !l)) fail(400, 'An item is not on this KOT.');
  const fresh = chosen.filter((l) => l && isWaiting(l)) as typeof lines;
  if (!fresh.length) fail(409, 'These items are already marked served.');
  const batch = newId();
  const b = await loadBusiness(c.env.DB, s.businessId);
  const day = clock(b, t).shiftDay;
  await c.env.DB.batch(fresh.map((l) => l.servedId
    // Undone by a manager before: served again now; the first time stays.
    ? stmt(c.env.DB, 'UPDATE kot_served SET served_at = ?, batch = ?, server_id = ?, staff_id = NULL, photo_at = NULL WHERE id = ?', t, batch, s.id, l.servedId)
    : stmt(c.env.DB, `INSERT INTO kot_served (id, business_id, kot_id, line_no, batch, first_at, served_at, server_id, shift_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(), s.businessId, kotId, l.lineNo, batch, t, t, s.id, day)));
  return c.json({ batch, at: t, items: fresh.length, undoUntil: t + SERVER_UNDO_MS }, 201);
});

// The photo of the KOT and the food for one tap (JPEG, the request body). Only the server who tapped.
serveRoutes.post('/serve/photo/:batch', async (c) => {
  const s = await currentServer(c);
  const batch = c.req.param('batch');
  if (!isUuid(batch)) fail(404, 'Not found.');
  const rows = await all<{ id: string }>(c.env.DB, 'SELECT id FROM kot_served WHERE batch = ? AND business_id = ? AND server_id = ? AND served_at IS NOT NULL', batch, s.businessId, s.id);
  if (!rows.length) fail(404, 'Not found.');
  if (!c.env.BILLS) fail(503, 'Photos are not set up on the server yet. The items are marked served.');
  const type = (c.req.header('Content-Type') ?? '').split(';')[0].trim();
  if (type !== 'image/jpeg') fail(400, 'Send the photo as a JPEG.');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.length) fail(400, 'The photo is empty.');
  if (bytes.length > MAX_PHOTO) fail(400, 'The photo is larger than 5 MB.');
  await c.env.BILLS.put(photoKey(s.businessId, batch), bytes, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { by: s.name } });
  await stmt(c.env.DB, 'UPDATE kot_served SET photo_at = ? WHERE batch = ? AND business_id = ?', now(), batch, s.businessId).run();
  return c.json({ ok: true });
});

// A server's own undo, for 2 minutes after the tap: the mark is taken away (as if never made) and the undo is logged.
serveRoutes.post('/serve/undo/:batch', async (c) => {
  const s = await currentServer(c);
  const batch = c.req.param('batch');
  const t = now();
  const rows = await all<{ id: string; served_at: number; name: string; place: string }>(c.env.DB, `
    SELECT ks.id, ks.served_at, ks.kot_id, ks.line_no, o.place, json_extract(k.lines, '$[' || ks.line_no || '].name') AS name, json_extract(k.lines, '$[' || ks.line_no || '].qty') AS qty
    FROM kot_served ks JOIN kots k ON k.id = ks.kot_id JOIN orders o ON o.id = k.order_id
    WHERE ks.batch = ? AND ks.business_id = ? AND ks.server_id = ? AND ks.served_at IS NOT NULL`, batch, s.businessId, s.id);
  if (!rows.length) fail(404, 'Nothing to undo.');
  if (rows.some((r) => t - r.served_at > SERVER_UNDO_MS)) fail(409, 'More than 2 minutes have passed. Ask a manager to undo it.');
  const b = await loadBusiness(c.env.DB, s.businessId);
  const day = clock(b, t).shiftDay;
  // A row served again after a manager's undo keeps its first time; only rows this tap made are removed.
  await c.env.DB.batch([
    stmt(c.env.DB, `UPDATE kot_served SET served_at = NULL, photo_at = NULL WHERE batch = ? AND business_id = ? AND first_at < served_at`, batch, s.businessId),
    stmt(c.env.DB, 'DELETE FROM kot_served WHERE batch = ? AND business_id = ? AND first_at = served_at', batch, s.businessId),
    stmt(c.env.DB, 'INSERT INTO pos_events (business_id, kind, ref, amount_paise, reason, detail, by_staff, shift_day, at) VALUES (?, ?, ?, NULL, NULL, ?, NULL, ?, ?)',
      s.businessId, 'serve_undo', `${rows[0].place} · ${rows.map((r) => r.name).join(', ')}`, `server:${s.name}`, day, t),
  ]);
  if (c.env.BILLS) await c.env.BILLS.delete(photoKey(s.businessId, batch)).catch(() => {});
  return c.json({ ok: true });
});

// ---------- the manager's side (billing PC)

serveRoutes.use(`${B}/serving/*`, requireStaff);
serveRoutes.use(`${B}/serving`, requireStaff);
serveRoutes.use(`${B}/servers/*`, requireStaff);
serveRoutes.use(`${B}/servers`, requireStaff);

// For the tables screen: each running KOT with its items' state (anyone at the counter).
serveRoutes.get(`${B}/serving/live`, requireAction('pos.view'), async (c) => {
  const t = now();
  return c.json({ now: t, lines: (await timedLines(c.env.DB, c.get('businessId'), { running: true, now: t })).map((l) => lineOut(l, t)) });
});

// Tables › Serving: what is waiting, what was served this shift, and today's undos and manager marks.
serveRoutes.get(`${B}/serving`, requireAction('serve.manage'), async (c) => {
  const bid = c.get('businessId');
  const t = now();
  const day = clock(bizOf(c), t).shiftDay;
  const [running, today, log] = await Promise.all([
    timedLines(c.env.DB, bid, { running: true, now: t }),
    timedLines(c.env.DB, bid, { from: day, to: day }),
    all<{ kind: string; ref: string; reason: string | null; detail: string | null; by: string | null; at: number }>(c.env.DB,
      `SELECT e.kind, e.ref, e.reason, e.detail, st.name AS by, e.at FROM pos_events e LEFT JOIN staff st ON st.id = e.by_staff
       WHERE e.business_id = ? AND e.shift_day = ? AND e.kind IN ('serve_undo', 'serve_manager') ORDER BY e.at DESC`, bid, day),
  ]);
  return c.json({
    now: t, shiftDay: day,
    waiting: running.filter(isWaiting).map((l) => lineOut(l, t)).sort((a, b) => (a.leftMins ?? 0) - (b.leftMins ?? 0)),
    served: today.filter((l) => l.firstAt !== null).map((l) => ({ ...lineOut(l, t), undoneAt: l.undoneAt, undoneBy: l.undoneBy, undoReason: l.undoReason }))
      .sort((a, b) => (b.firstAt ?? 0) - (a.firstAt ?? 0)),
    log: log.map((e) => ({ kind: e.kind, ref: e.ref, reason: e.reason, at: e.at, by: e.detail?.startsWith('server:') ? `${e.detail.slice(7)} (server, within 2 min)` : e.by })),
  });
});

async function managerLine(c: Context<AppEnv>, kotId: unknown, lineNo: unknown) {
  if (typeof kotId !== 'string' || !Number.isInteger(lineNo)) fail(400, 'Choose an item.');
  const bid = c.get('businessId');
  const k = await one<{ shift_day: string }>(c.env.DB, 'SELECT shift_day FROM kots WHERE id = ? AND business_id = ?', kotId, bid);
  if (!k) fail(404, 'Item not found.');
  const l = (await timedLines(c.env.DB, bid, { from: k.shift_day, to: k.shift_day })).find((x) => x.kotId === kotId && x.lineNo === lineNo);
  if (!l) fail(404, 'Item not found.');
  return l;
}

// A server forgot: the manager marks it served now, with no photo (counted apart; on the Daily check).
serveRoutes.post(`${B}/serving/mark`, requireAction('serve.manage'), async (c) => {
  const data = await body(c);
  const l = await managerLine(c, data.kotId, data.lineNo);
  if (!isWaiting(l)) fail(409, 'This item is already marked served.');
  const bid = c.get('businessId');
  const staff = c.get('staff');
  const t = now();
  const day = clock(bizOf(c), t).shiftDay;
  await c.env.DB.batch([
    l.servedId
      ? stmt(c.env.DB, 'UPDATE kot_served SET served_at = ?, batch = ?, server_id = NULL, staff_id = ?, photo_at = NULL WHERE id = ?', t, newId(), staff.id, l.servedId)
      : stmt(c.env.DB, 'INSERT INTO kot_served (id, business_id, kot_id, line_no, batch, first_at, served_at, staff_id, shift_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        newId(), bid, l.kotId, l.lineNo, newId(), t, t, staff.id, day),
    event(c.env.DB, bid, 'serve_manager', `${l.place} · ${l.qty} × ${l.name}`, null, null, 'Marked served by a manager, no photo', staff.id, day),
  ]);
  return c.json({ ok: true });
});

// Undo a mark, with a reason: back on the servers' list. The first served time is kept, so late stays late.
serveRoutes.post(`${B}/serving/undo`, requireAction('serve.manage'), async (c) => {
  const data = await body(c);
  const reason = text(data, 'reason', 'Reason', { max: 80 })!;
  const l = await managerLine(c, data.kotId, data.lineNo);
  if (isWaiting(l) || !l.servedId) fail(409, 'This item is not marked served.');
  const bid = c.get('businessId');
  const staff = c.get('staff');
  const t = now();
  const day = clock(bizOf(c), t).shiftDay;
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE kot_served SET served_at = NULL, undone_at = ?, undone_by = ?, undo_reason = ? WHERE id = ?', t, staff.name, reason, l.servedId),
    event(c.env.DB, bid, 'serve_undo', `${l.place} · ${l.qty} × ${l.name}`, null, reason, null, staff.id, day),
  ]);
  return c.json({ ok: true });
});

// The photo of one tap (Manager and Owner only).
serveRoutes.get(`${B}/serving/photo/:batch`, requireAction('serve.manage'), async (c) => {
  const batch = c.req.param('batch');
  const bid = c.get('businessId');
  if (!isUuid(batch) || !(await one(c.env.DB, 'SELECT 1 FROM kot_served WHERE batch = ? AND business_id = ? AND photo_at IS NOT NULL', batch, bid)) || !c.env.BILLS) fail(404, 'Photo not found.');
  const obj = await c.env.BILLS.get(photoKey(bid, batch));
  if (!obj) fail(404, 'Photo not found.');
  return new Response(obj.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' } });
});

// Connections blocked by wrong server PINs now, and unlocking one (Manager and Owner).
serveRoutes.get(`${B}/serving/blocks`, requireAction('serve.manage'), async (c) => {
  const bid = c.get('businessId');
  const t = now();
  const rows = await all<{ conn: string; wrong: number; last: number; known: number }>(c.env.DB, `
    SELECT s.conn, count(*) AS wrong, max(s.at) AS last,
      EXISTS (SELECT 1 FROM serve_signins k WHERE k.business_id = s.business_id AND k.conn = s.conn AND k.ok = 1 AND k.at > ?3) AS known
    FROM serve_signins s WHERE s.business_id = ?1 AND s.ok = 0 AND s.cleared_at IS NULL AND s.at > ?2 GROUP BY s.conn`, bid, t - TRY_WINDOW_MS, t - KNOWN_MS);
  return c.json({ blocks: rows.filter((r) => r.wrong >= (r.known ? WRONG_LIMIT_KNOWN : WRONG_LIMIT))
    .map((r) => ({ conn: r.conn, wrong: r.wrong, last: r.last, known: !!r.known, until: r.last + TRY_WINDOW_MS })) });
});
serveRoutes.post(`${B}/serving/unblock`, requireAction('serve.manage'), async (c) => {
  const data = await body(c);
  if (typeof data.conn !== 'string') fail(400, 'Choose a connection.');
  const bid = c.get('businessId');
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE serve_signins SET cleared_at = ? WHERE business_id = ? AND conn = ? AND ok = 0 AND cleared_at IS NULL', now(), bid, data.conn),
    audit(c.env.DB, bid, c.get('staff').id, 'serve.unblock', 'serve_signins', data.conn, null, null),
  ]);
  return c.json({ ok: true });
});

// ---------- servers (the Owner adds and removes them, in Settings › Staff)

serveRoutes.get(`${B}/servers`, requireAction('staff.manage'), async (c) => {
  const rows = await all<{ id: string; name: string; phone: string | null; active: number; created_at: number; last_seen_at: number | null }>(c.env.DB,
    'SELECT id, name, phone, active, created_at, last_seen_at FROM servers WHERE business_id = ? ORDER BY active DESC, name', c.get('businessId'));
  return c.json({ servers: rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, active: !!r.active, createdAt: r.created_at, lastSeenAt: r.last_seen_at })) });
});

/** A 10-digit Indian mobile number from what was typed (+91, spaces and dashes allowed), or null. */
const mobileOf = (v: unknown) => { const d = typeof v === 'string' ? v.replace(/\D/g, '') : ''; const m = d.length === 12 && d.startsWith('91') ? d.slice(2) : d; return /^[6-9]\d{9}$/.test(m) ? m : null; };
const SIMPLE_PINS = new Set(['123456', '654321', '012345', '543210', '123123', '112233']);
async function checkPin(c: Context<AppEnv>, pin: unknown, _except: string | null): Promise<{ key: string; hash: string }> {
  if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) fail(400, 'A server PIN is 6 digits.');
  // The mobile says who it is (28 Nov 2026), so PINs may repeat between servers; very easy ones are refused.
  if (/^(\d)\1{5}$/.test(pin) || SIMPLE_PINS.has(pin)) fail(400, 'That PIN is too easy to guess. Choose another.');
  return { key: await pinKey(c.get('businessId'), pin), hash: await hashPassword(pin) };
}
async function checkPhone(c: Context<AppEnv>, v: unknown, except: string | null) {
  const phone = mobileOf(v);
  if (!phone) fail(400, 'Type the server\'s 10-digit mobile number.');
  if (await one(c.env.DB, 'SELECT 1 FROM servers WHERE business_id = ? AND phone = ? AND active = 1 AND id <> ?', c.get('businessId'), phone, except ?? '')) fail(409, 'Another server has this mobile number.');
  return phone;
}

serveRoutes.post(`${B}/servers`, requireAction('staff.manage'), async (c) => {
  const data = await body(c);
  const name = text(data, 'name', 'Name', { max: 60 })!;
  const phone = await checkPhone(c, data.phone, null);
  const p = await checkPin(c, data.pin, null);
  const id = newId();
  const bid = c.get('businessId');
  await c.env.DB.batch([
    stmt(c.env.DB, 'INSERT INTO servers (id, business_id, name, phone, pin_key, pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, bid, name, phone, p.key, p.hash, now()),
    audit(c.env.DB, bid, c.get('staff').id, 'server.create', 'servers', id, null, { name, phone: `••${phone.slice(-4)}` }),
  ]);
  return c.json({ id }, 201);
});

// Rename, a new PIN, or remove (active false): a removed server's sign-ins end at once.
serveRoutes.put(`${B}/servers/:id`, requireAction('staff.manage'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const before = await one<{ name: string; active: number; phone: string | null }>(c.env.DB, 'SELECT name, active, phone FROM servers WHERE id = ? AND business_id = ?', id, bid);
  if (!before) fail(404, 'Server not found.');
  const data = await body(c);
  const name = data.name === undefined ? before.name : text(data, 'name', 'Name', { max: 60 })!;
  if (data.active !== undefined && typeof data.active !== 'boolean') fail(400, 'Active must be yes or no.');
  const active = data.active === undefined ? before.active : data.active ? 1 : 0;
  const p = data.pin !== undefined && data.pin !== '' ? await checkPin(c, data.pin, id) : null;
  if (active && !before.active && !p) fail(400, 'Give a new PIN to bring a server back.');
  const phone = data.phone !== undefined && data.phone !== '' ? await checkPhone(c, data.phone, id) : before.phone;
  if (active && !phone) fail(400, 'Type the server\'s 10-digit mobile number.');
  const phoneChanged = phone !== before.phone;
  await c.env.DB.batch([
    stmt(c.env.DB, `UPDATE servers SET name = ?, active = ?, phone = ?${p ? ', pin_key = ?, pin_hash = ?' : ''} WHERE id = ?`, ...[name, active, phone, ...(p ? [p.key, p.hash] : []), id]),
    ...(phoneChanged ? [stmt(c.env.DB, 'DELETE FROM serve_sessions WHERE server_id = ?', id)] : []),
    ...(active ? [] : [stmt(c.env.DB, 'DELETE FROM serve_sessions WHERE server_id = ?', id)]),
    ...(p ? [stmt(c.env.DB, 'DELETE FROM serve_sessions WHERE server_id = ?', id)] : []),
    audit(c.env.DB, bid, c.get('staff').id, 'server.update', 'servers', id, before, { name, active, pinChanged: !!p }),
  ]);
  return c.json({ ok: true });
});
