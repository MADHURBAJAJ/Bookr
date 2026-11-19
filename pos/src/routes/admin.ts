// Bookr POS admin (approved 19 Nov 2026): the people who run Bookr POS. They add restaurants and their owners, give an
// owner a place at another restaurant, pause and resume restaurants, and reset an owner's password. They see each
// restaurant's name, owners, status and how much it is used (for charging), never its bills, menus or sales. They can
// open a restaurant only while its owner has support access on, and every such visit is listed for the owner.
//
// Their own sign-in: the pos_admin cookie (HttpOnly, a random token whose SHA-256 is stored), separate from staff.
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { all, isUniqueViolation, newId, now, one, stmt } from '../../../src/db';
import { DUMMY_HASH, hashPassword, randomToken, sha256, verifyPassword } from '../../../src/crypto';
import { body, fail, isEmail, isUuid, text } from '../../../src/http';
import { SESSION_COOKIE } from '../auth';
import { defaultStations } from '../stations';
import { audit } from '../util';
import type { AppEnv } from '../types';

export const adminRoutes = new Hono<AppEnv>();
const ADMIN_COOKIE = 'pos_admin';
const HOUR = 3_600_000;
const ADMIN_SESSION_MS = 12 * HOUR;
const SUPPORT_SESSION_MS = 2 * HOUR;
const cookie = (ms: number) => ({ httpOnly: true, secure: true, sameSite: 'Strict' as const, path: '/', maxAge: Math.floor(ms / 1000) });

const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, ADMIN_COOKIE);
  if (!token) fail(401, 'Please sign in as a Bookr POS admin.');
  const a = await one<{ id: string; name: string; email: string }>(c.env.DB, `SELECT a.id, a.name, a.email FROM admin_sessions s JOIN platform_admins a ON a.id = s.admin_id
    WHERE s.id = ? AND s.expires_at > ? AND a.active = 1`, await sha256(token), now());
  if (!a) { deleteCookie(c, ADMIN_COOKIE, { path: '/', secure: true }); fail(401, 'Please sign in as a Bookr POS admin.'); }
  c.set('admin', a);
  await next();
};

async function password(data: Record<string, unknown>, key = 'password') {
  const p = typeof data[key] === 'string' ? (data[key] as string) : '';
  if (p.length < 12) fail(400, 'Password must be at least 12 characters.');
  return hashPassword(p);
}

// The first admin, once, with the setup token (a Worker secret). After that, admins are added by admins.
adminRoutes.post('/admin/setup', async (c) => {
  const expected = c.env.POS_SETUP_TOKEN;
  const given = c.req.header('X-Setup-Token') ?? '';
  if (!expected || given.length !== expected.length || (await sha256(given)) !== (await sha256(expected))) fail(403, 'Setup is not allowed.');
  if (await one(c.env.DB, 'SELECT 1 FROM platform_admins LIMIT 1')) fail(409, 'An admin already exists. Sign in, and add others from there.');
  const data = await body(c);
  const email = text(data, 'email', 'Email', { max: 254 })!;
  if (!isEmail(email)) fail(400, 'Email is not valid.');
  if (await one(c.env.DB, 'SELECT 1 FROM staff WHERE lower(email) = lower(?)', email)) fail(409, 'That email is a restaurant login. Use a separate email for admin work.');
  await stmt(c.env.DB, 'INSERT INTO platform_admins (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    newId(), text(data, 'name', 'Name', { max: 80 })!, email, await password(data), now()).run();
  return c.json({ ok: true }, 201);
});

adminRoutes.post('/admin/login', async (c) => {
  const data = await body(c);
  const email = text(data, 'email', 'Email', { max: 254 })!;
  const a = await one<{ id: string; password_hash: string }>(c.env.DB, 'SELECT id, password_hash FROM platform_admins WHERE lower(email) = lower(?) AND active = 1', email);
  const ok = await verifyPassword(typeof data.password === 'string' ? data.password : '', a?.password_hash ?? DUMMY_HASH);
  if (!a || !ok) fail(401, 'Email or password is incorrect.');
  const token = randomToken();
  const t = now();
  await stmt(c.env.DB, 'INSERT INTO admin_sessions (id, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)', await sha256(token), a.id, t, t + ADMIN_SESSION_MS).run();
  setCookie(c, ADMIN_COOKIE, token, cookie(ADMIN_SESSION_MS));
  return c.json({ ok: true });
});
adminRoutes.post('/admin/logout', async (c) => {
  const token = getCookie(c, ADMIN_COOKIE);
  if (token) await stmt(c.env.DB, 'DELETE FROM admin_sessions WHERE id = ?', await sha256(token)).run();
  deleteCookie(c, ADMIN_COOKIE, { path: '/', secure: true });
  return c.json({ ok: true });
});
adminRoutes.get('/admin/me', requireAdmin, (c) => c.json({ admin: c.get('admin') }));

// Another admin.
adminRoutes.post('/admin/admins', requireAdmin, async (c) => {
  const data = await body(c);
  const email = text(data, 'email', 'Email', { max: 254 })!;
  if (!isEmail(email)) fail(400, 'Email is not valid.');
  if (await one(c.env.DB, 'SELECT 1 FROM staff WHERE lower(email) = lower(?)', email)) fail(409, 'That email is a restaurant login. Use a separate email for admin work.');
  try {
    await stmt(c.env.DB, 'INSERT INTO platform_admins (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      newId(), text(data, 'name', 'Name', { max: 80 })!, email, await password(data), now()).run();
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'That email is already an admin.');
    throw e;
  }
  return c.json({ ok: true }, 201);
});

// The restaurants: name, owners, status, and how much each is used. No bills, menus or sales.
adminRoutes.get('/admin/restaurants', requireAdmin, async (c) => {
  const monthStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1) - 19_800_000;
  const [rs, owners] = await Promise.all([
    all<{ id: string; name: string; status: string; support_access: number; created_at: number; bills_month: number; last_used: number | null }>(c.env.DB,
      `SELECT b.id, b.name, b.status, b.support_access, b.created_at,
        (SELECT count(*) FROM bills x WHERE x.business_id = b.id AND x.printed_at >= ?) AS bills_month,
        (SELECT max(s.created_at) FROM sessions s JOIN staff st ON st.id = s.staff_id WHERE st.business_id = b.id AND st.support = 0) AS last_used
       FROM businesses b ORDER BY b.name`, monthStart),
    all<{ id: string; business_id: string; name: string; email: string; active: number; login_id: string }>(c.env.DB,
      "SELECT id, business_id, name, email, active, login_id FROM staff WHERE role = 'owner' AND support = 0 ORDER BY name"),
  ]);
  return c.json({ restaurants: rs.map((r) => ({ id: r.id, name: r.name, status: r.status, supportAccess: !!r.support_access, createdAt: r.created_at,
    billsThisMonth: r.bills_month, lastUsedAt: r.last_used,
    owners: owners.filter((o) => o.business_id === r.id).map((o) => ({ id: o.id, name: o.name, email: o.email, active: !!o.active })) })) });
});

/**
 * The owner's place at a restaurant: an email already used by an owner keeps its login and password (one person, one
 * password); a new email gets a login with the password given. An email used by a restaurant's own staff (not an
 * owner) or by an admin is refused.
 */
async function ownerRow(c: Context<AppEnv>, bid: string, data: Record<string, unknown>) {
  const email = text(data, 'ownerEmail', "Owner's email", { max: 254 })!;
  if (!isEmail(email)) fail(400, "Owner's email is not valid.");
  if (await one(c.env.DB, 'SELECT 1 FROM platform_admins WHERE lower(email) = lower(?)', email)) fail(409, 'That email is an admin login. Use the owner\'s own email.');
  const known = await one<{ login_id: string; password_hash: string; name: string }>(c.env.DB,
    "SELECT login_id, password_hash, name FROM staff WHERE lower(email) = lower(?) AND role = 'owner' AND login_id IS NOT NULL ORDER BY created_at LIMIT 1", email);
  if (!known && await one(c.env.DB, 'SELECT 1 FROM staff WHERE lower(email) = lower(?)', email)) fail(409, 'That email is used by a restaurant\'s staff. Use another email for this owner.');
  const id = newId();
  const name = text(data, 'ownerName', "Owner's name", { optional: !!known, max: 80 }) ?? known!.name;
  const hash = known ? known.password_hash : await password(data, 'ownerPassword');
  return { id, existing: !!known, stmt: stmt(c.env.DB, "INSERT INTO staff (id, business_id, name, role, email, password_hash, created_at, login_id) VALUES (?, ?, ?, 'owner', ?, ?, ?, ?)",
    id, bid, name, email, hash, now(), known?.login_id ?? id) };
}

// A new restaurant with its owner; Kitchen and Bar stations to start. Copying a menu comes only from another restaurant
// of the same owner, so no restaurant's menu is ever copied into a stranger's.
adminRoutes.post('/admin/restaurants', requireAdmin, async (c) => {
  const data = await body(c);
  const name = text(data, 'name', 'Restaurant name', { max: 80 })!;
  const bid = newId();
  const t = now();
  const owner = await ownerRow(c, bid, data);
  let copyFrom: string | null = null;
  if (data.copyFrom) {
    if (typeof data.copyFrom !== 'string' || !isUuid(data.copyFrom) || !owner.existing) fail(400, 'A menu can be copied only from another restaurant of the same owner.');
    const same = await one(c.env.DB, `SELECT 1 FROM staff a JOIN staff b ON b.login_id = a.login_id WHERE lower(a.email) = lower(?) AND a.role = 'owner'
      AND b.business_id = ? AND b.role = 'owner'`, data.ownerEmail, data.copyFrom);
    if (!same) fail(400, 'A menu can be copied only from another restaurant of the same owner.');
    copyFrom = data.copyFrom as string;
  }
  await c.env.DB.batch([
    stmt(c.env.DB, 'INSERT INTO businesses (id, name, created_at) VALUES (?, ?, ?)', bid, name, t),
    owner.stmt,
    ...(copyFrom ? copyStatements(c.env.DB, copyFrom, bid, t) : defaultStations(c.env.DB, bid, t)),
    stmt(c.env.DB, `INSERT INTO audit_log (business_id, staff_id, action, row_table, row_id, before, after, created_at) VALUES (?, NULL, 'restaurant.create', 'businesses', ?, NULL, ?, ?)`,
      bid, bid, JSON.stringify({ admin: c.get('admin').email, name, copiedMenu: !!copyFrom }), t),
  ]);
  return c.json({ id: bid, ownerHadLogin: owner.existing }, 201);
});

/** Copies a restaurant's stations, reasons, categories, menu and add-ons (prices included) into a new one. */
function copyStatements(db: D1Database, from: string, to: string, t: number) {
  // New ids are made in SQL from the old ones (the new restaurant's first 8 characters, then the rest of the old id),
  // so the links between copied rows (station of a category, add-ons of a dish) still hold. `to` is our own new id.
  const remap = (col: string) => `lower(substr('${to}', 1, 8) || substr(${col}, 9))`;
  return [
    stmt(db, `INSERT INTO stations (id, business_id, name, how, copies, is_bar, sort, active, created_at) SELECT ${remap('id')}, ?, name, how, copies, is_bar, sort, active, ? FROM stations WHERE business_id = ?`, to, t, from),
    stmt(db, `INSERT INTO reasons (id, business_id, kind, label, active, created_at) SELECT ${remap('id')}, ?, kind, label, active, ? FROM reasons WHERE business_id = ? AND active = 1`, to, t, from),
    stmt(db, `INSERT INTO menu_categories (id, business_id, name, tax_mode, gst_bp, sort, created_at, kot, station_id)
      SELECT ${remap('id')}, ?, name, tax_mode, gst_bp, sort, ?, kot, CASE WHEN station_id IS NULL THEN NULL ELSE ${remap('station_id')} END FROM menu_categories WHERE business_id = ?`, to, t, from),
    stmt(db, `INSERT INTO menu_items (id, business_id, name, category, price_paise, sac, station, active, created_at, tax_mode, gst_bp, open_price, min_price_paise, kot, station_id)
      SELECT ${remap('id')}, ?, name, category, price_paise, sac, station, active, ?, tax_mode, gst_bp, open_price, min_price_paise, kot,
        CASE WHEN station_id IS NULL THEN NULL ELSE ${remap('station_id')} END FROM menu_items WHERE business_id = ? AND active = 1`, to, t, from),
    stmt(db, `INSERT INTO addon_groups (id, business_id, name, kind, created_at) SELECT ${remap('id')}, ?, name, kind, ? FROM addon_groups WHERE business_id = ?`, to, t, from),
    stmt(db, `INSERT INTO addon_options (id, business_id, group_id, name, add_paise, sort, active) SELECT ${remap('id')}, ?, ${remap('group_id')}, name, add_paise, sort, active FROM addon_options WHERE business_id = ?`, to, from),
    stmt(db, `INSERT INTO menu_item_addons (item_id, group_id, business_id, sort, prices) SELECT ${remap('l.item_id')}, ${remap('l.group_id')}, ?, l.sort, l.prices
      FROM menu_item_addons l JOIN menu_items m ON m.id = l.item_id WHERE l.business_id = ? AND m.active = 1`, to, from),
  ];
}

// Pause or resume. Pausing ends everyone's sign-in there at once; the data stays.
adminRoutes.put('/admin/restaurants/:id', requireAdmin, async (c) => {
  const bid = c.req.param('id');
  const data = await body(c);
  if (data.status !== 'active' && data.status !== 'paused') fail(400, 'Status must be active or paused.');
  const b = await one<{ status: string }>(c.env.DB, 'SELECT status FROM businesses WHERE id = ?', bid);
  if (!b) fail(404, 'Restaurant not found.');
  const name = data.name === undefined ? null : text(data, 'name', 'Restaurant name', { max: 80 });
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE businesses SET status = ?, name = coalesce(?, name) WHERE id = ?', data.status, name, bid),
    ...(data.status === 'paused' ? [stmt(c.env.DB, 'DELETE FROM sessions WHERE staff_id IN (SELECT id FROM staff WHERE business_id = ?)', bid)] : []),
    stmt(c.env.DB, `INSERT INTO audit_log (business_id, staff_id, action, row_table, row_id, before, after, created_at) VALUES (?, NULL, ?, 'businesses', ?, ?, ?, ?)`,
      bid, `restaurant.${data.status === 'paused' ? 'pause' : 'resume'}`, bid, JSON.stringify({ status: b.status }), JSON.stringify({ status: data.status, admin: c.get('admin').email }), now()),
  ]);
  return c.json({ ok: true });
});

// Give an owner (by email) a place at this restaurant; an owner who already has a login keeps their password.
adminRoutes.post('/admin/restaurants/:id/owners', requireAdmin, async (c) => {
  const bid = c.req.param('id');
  if (!await one(c.env.DB, 'SELECT 1 FROM businesses WHERE id = ?', bid)) fail(404, 'Restaurant not found.');
  const data = await body(c);
  if (await one(c.env.DB, 'SELECT 1 FROM staff WHERE business_id = ? AND lower(email) = lower(?)', bid, data.ownerEmail ?? '')) fail(409, 'That person is already at this restaurant.');
  const owner = await ownerRow(c, bid, data);
  await c.env.DB.batch([owner.stmt,
    stmt(c.env.DB, `INSERT INTO audit_log (business_id, staff_id, action, row_table, row_id, before, after, created_at) VALUES (?, NULL, 'owner.add', 'staff', ?, NULL, ?, ?)`,
      bid, owner.id, JSON.stringify({ admin: c.get('admin').email, email: data.ownerEmail }), now())]);
  return c.json({ id: owner.id, ownerHadLogin: owner.existing }, 201);
});

// A new password for an owner: it changes at every restaurant they sign in at, and ends their sign-ins.
adminRoutes.post('/admin/owners/:id/password', requireAdmin, async (c) => {
  const st = await one<{ login_id: string; business_id: string }>(c.env.DB, "SELECT login_id, business_id FROM staff WHERE id = ? AND role = 'owner' AND support = 0", c.req.param('id'));
  if (!st) fail(404, 'Owner not found.');
  const hash = await password(await body(c));
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE staff SET password_hash = ? WHERE login_id = ?', hash, st.login_id),
    stmt(c.env.DB, 'DELETE FROM sessions WHERE staff_id IN (SELECT id FROM staff WHERE login_id = ?)', st.login_id),
    stmt(c.env.DB, `INSERT INTO audit_log (business_id, staff_id, action, row_table, row_id, before, after, created_at) VALUES (?, NULL, 'owner.password', 'staff', ?, NULL, ?, ?)`,
      st.business_id, c.req.param('id'), JSON.stringify({ admin: c.get('admin').email }), now()),
  ]);
  return c.json({ ok: true });
});

// Open a restaurant to help, only while its owner has support access on: signs this browser in there as Bookr POS
// support (a manager: no staff, billing names or settings of the business) for 2 hours, and lists the visit for the owner.
adminRoutes.post('/admin/restaurants/:id/visit', requireAdmin, async (c) => {
  const bid = c.req.param('id');
  const b = await one<{ status: string; support_access: number }>(c.env.DB, 'SELECT status, support_access FROM businesses WHERE id = ?', bid);
  if (!b) fail(404, 'Restaurant not found.');
  if (!b.support_access) fail(403, 'The owner has not turned on support access. Ask them to turn it on in Settings → Staff and PINs.');
  if (b.status !== 'active') fail(409, 'This restaurant is paused.');
  const admin = c.get('admin');
  let st = await one<{ id: string }>(c.env.DB, 'SELECT id FROM staff WHERE business_id = ? AND support = 1', bid);
  const t = now();
  const statements = [];
  if (!st) {
    st = { id: newId() };
    statements.push(stmt(c.env.DB, "INSERT INTO staff (id, business_id, name, role, email, password_hash, created_at, support) VALUES (?, ?, 'Bookr POS support', 'manager', ?, ?, ?, 1)",
      st.id, bid, `support+${bid}@bookrpos.invalid`, await hashPassword(randomToken()), t));
  } else statements.push(stmt(c.env.DB, 'UPDATE staff SET active = 1 WHERE id = ?', st.id));
  const token = randomToken();
  statements.push(
    stmt(c.env.DB, "INSERT INTO sessions (id, staff_id, device_id, kind, created_at, expires_at) VALUES (?, ?, NULL, 'password', ?, ?)", await sha256(token), st.id, t, t + SUPPORT_SESSION_MS),
    audit(c.env.DB, bid, st.id, 'support.visit', 'businesses', bid, null, { admin: `${admin.name} (${admin.email})` }),
  );
  await c.env.DB.batch(statements);
  setCookie(c, SESSION_COOKIE, token, cookie(SUPPORT_SESSION_MS));
  return c.json({ ok: true });
});
