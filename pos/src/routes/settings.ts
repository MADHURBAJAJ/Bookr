// Settings a business chooses (nothing hotel-specific is fixed in code): business rules, staff and PINs, billing names
// with their GST and limits, UPI accounts, the menu, reason lists, in-house stays and credit accounts.
import { Hono, type Context } from 'hono';
import { all, isUniqueViolation, newId, now, one, stmt } from '../../../src/db';
import { hashPassword } from '../../../src/crypto';
import { body, fail, isEmail, isUuid, optionalPaise, paise, text } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { can, isRole } from '../permissions';
import { basePrice, priceKey, readPrices, type Prices } from '../addons';
import { isOnline, syncItemStations } from '../stations';
import { audit, clock, bizOf, dormWhole, loadBusiness, placeOf, SECTION_KINDS, sectionTables, tableLayout, tableList, type SectionKind } from '../util';
import type { AppEnv } from '../types';

export const settingsRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
settingsRoutes.use(`${B}/*`, requireStaff);

const int = (v: unknown, label: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(400, `${label} must be a whole number from ${min} to ${max}.`);
  return v;
};
const flag = (v: unknown) => v === true;

// ---------- business rules

settingsRoutes.put(`${B}/settings`, requireAction('staff.manage'), async (c) => {
  const id = c.get('businessId');
  const data = await body(c);
  const before = await loadBusiness(c.env.DB, id);
  const after = {
    name: text(data, 'name', 'Business name')!,
    fy_start_month: int(data.fyStartMonth, 'Financial year start month', 1, 12),
    shift_start_hour: int(data.shiftStartHour, 'Shift start hour', 0, 23),
    tab_age_days: int(data.tabAgeDays, 'Tab age limit (days)', 1, 60),
    // Optional so older screens keep working: the discount a cashier gives alone, in whole percent.
    disc_limit_bp: data.discLimitPct === undefined ? before.disc_limit_bp : int(data.discLimitPct, 'Discount a cashier may give alone (%)', 0, 100) * 100,
  };
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE businesses SET name = ?, fy_start_month = ?, shift_start_hour = ?, tab_age_days = ?, disc_limit_bp = ? WHERE id = ?',
      after.name, after.fy_start_month, after.shift_start_hour, after.tab_age_days, after.disc_limit_bp, id),
    audit(c.env.DB, id, c.get('staff').id, 'business.update', 'businesses', id, before, after),
  ]);
  return c.json({ ok: true });
});

// ---------- tables: the counter's grid, in the order given

settingsRoutes.get(`${B}/tables`, requireAction('menu.edit'), async (c) => {
  return c.json({ tables: tableList(bizOf(c)) ?? [], sections: tableLayout(bizOf(c)) ?? [] });
});

// The counter's tables in sections (Private Rooms, Dorms, Out House, NC, others), in order. An older plain list
// ({tables: [...]}) is kept as one section.
settingsRoutes.put(`${B}/tables`, requireAction('menu.edit'), async (c) => {
  const id = c.get('businessId');
  const data = await body(c);
  const raw = Array.isArray(data.sections) ? data.sections : Array.isArray(data.tables) ? [{ name: 'Tables', kind: 'other', tables: data.tables }] : null;
  if (!raw || raw.length > 40) fail(400, 'Up to 40 sections and room categories.');
  const seen = new Set<string>();
  const unique = (name: string) => { if (seen.has(name.toLowerCase())) fail(400, `${name} is in the list twice.`); seen.add(name.toLowerCase()); };
  const sections: { name: string; kind: SectionKind; tables?: string[]; dorms?: { name: string; beds: number }[] }[] = [];
  const names = new Set<string>();
  for (const r of raw as Record<string, unknown>[]) {
    const name = typeof r?.name === 'string' ? r.name.trim() : '';
    if (!name || name.length > 30) fail(400, 'Each section needs a name of up to 30 characters.');
    if (names.has(name.toLowerCase())) fail(400, `Two sections are called ${name}.`);
    names.add(name.toLowerCase());
    const kind = (SECTION_KINDS as readonly string[]).includes(r.kind as string) ? (r.kind as SectionKind) : fail(400, `${name}: choose what kind of section it is.`);
    if (kind === 'dorms') {
      if (!Array.isArray(r.dorms) || r.dorms.length > 30) fail(400, `${name}: list up to 30 dorms.`);
      const dorms = (r.dorms as Record<string, unknown>[]).map((d) => {
        const dn = typeof d?.name === 'string' ? d.name.trim() : '';
        if (!dn || dn.length > 24) fail(400, `${name}: each dorm needs a name of up to 24 characters.`);
        const beds = d.beds;
        if (typeof beds !== 'number' || !Number.isInteger(beds) || beds < 1 || beds > 30) fail(400, `${dn}: beds must be 1 to 30.`);
        return { name: dn, beds };
      });
      for (const t of sectionTables({ kind, dorms })) unique(t);
      sections.push({ name, kind, dorms });
    } else {
      if (!Array.isArray(r.tables) || r.tables.length > 150) fail(400, `${name}: up to 150 tables.`);
      const tables = (r.tables as unknown[]).map((t) => {
        const tn = typeof t === 'string' ? t.trim() : '';
        if (!tn || tn.length > 30) fail(400, `${name}: each table name must be 1 to 30 characters.`);
        unique(tn);
        return tn;
      });
      sections.push({ name, kind, tables });
    }
  }
  if (seen.size > 600) fail(400, 'Up to 600 tables, rooms and beds in all.');
  const keep = sections.filter((x) => (x.tables?.length ?? 0) + (x.dorms?.length ?? 0) > 0);
  const before = tableLayout(bizOf(c));
  // A room, bed or table cannot go (or be renamed) while a guest is checked in there or an order is open on it.
  const gone = (before ?? []).flatMap((x) => x.tables).filter((t) => !seen.has(t.toLowerCase()));
  if (gone.length) {
    const json = JSON.stringify(gone.map((t) => t.toLowerCase()));
    const [st, od] = await Promise.all([
      all<{ room: string; guest_name: string }>(c.env.DB, 'SELECT room, guest_name FROM stays WHERE business_id = ? AND checked_out_at IS NULL AND lower(room) IN (SELECT value FROM json_each(?))', id, json),
      all<{ place: string }>(c.env.DB, "SELECT place FROM orders WHERE business_id = ? AND kind = 'table' AND status IN ('open', 'tab', 'billed') AND lower(place) IN (SELECT value FROM json_each(?))", id, json),
    ]);
    const busy = [...st.map((x) => `${x.room} (${x.guest_name} staying)`), ...od.map((x) => `${x.place} (order open)`)];
    if (busy.length) fail(409, `In use, so not removed or renamed: ${busy.join(', ')}. Check the guest out or close the order first.`);
  }
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE businesses SET tables = ? WHERE id = ?', keep.length ? JSON.stringify({ sections: keep }) : null, id),
    audit(c.env.DB, id, c.get('staff').id, 'tables.update', 'businesses', id, { sections: before }, { sections: keep.length ? keep : null }),
  ]);
  return c.json({ tables: keep.flatMap((x) => sectionTables(x)), sections: keep });
});

// ---------- staff

settingsRoutes.get(`${B}/staff`, requireAction('staff.manage'), async (c) => {
  return c.json({ staff: await all(c.env.DB, `SELECT id, name, role, email, pin_hash IS NOT NULL AS hasPin, active, support
    FROM staff WHERE business_id = ? ORDER BY support, active DESC, name`, c.get('businessId')) });
});

// Bookr POS support: off unless the Owner turns it on. While on, a Bookr POS admin can open this restaurant (as a
// manager) to help; every visit is listed here. Turning it off ends any support visit at once.
settingsRoutes.get(`${B}/support`, requireAction('staff.manage'), async (c) => {
  const bid = c.get('businessId');
  const b = await one<{ support_access: number }>(c.env.DB, 'SELECT support_access FROM businesses WHERE id = ?', bid);
  const visits = await all<{ after: string; created_at: number }>(c.env.DB,
    "SELECT after, created_at FROM audit_log WHERE business_id = ? AND action = 'support.visit' ORDER BY created_at DESC LIMIT 30", bid);
  return c.json({ on: !!b!.support_access, visits: visits.map((v) => ({ at: v.created_at, by: (JSON.parse(v.after ?? '{}') as { admin?: string }).admin ?? 'Bookr POS' })) });
});
settingsRoutes.put(`${B}/support`, requireAction('staff.manage'), async (c) => {
  const bid = c.get('businessId');
  const data = await body(c);
  if (typeof data.on !== 'boolean') fail(400, 'Support access must be on or off.');
  if (c.get('support')) fail(403, 'Bookr POS support cannot change support access.');
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE businesses SET support_access = ? WHERE id = ?', data.on ? 1 : 0, bid),
    ...(data.on ? [] : [
      stmt(c.env.DB, 'DELETE FROM sessions WHERE staff_id IN (SELECT id FROM staff WHERE business_id = ? AND support = 1)', bid),
      stmt(c.env.DB, 'UPDATE staff SET active = 0 WHERE business_id = ? AND support = 1', bid),
    ]),
    audit(c.env.DB, bid, c.get('staff').id, data.on ? 'support.on' : 'support.off', 'businesses', bid, null, null),
  ]);
  return c.json({ ok: true });
});

async function staffFields(data: Record<string, unknown>, needLogin: boolean) {
  const role = data.role;
  if (!isRole(role)) fail(400, 'Role must be owner, manager, cashier or captain.');
  const name = text(data, 'name', 'Name', { max: 80 })!;
  const email = text(data, 'email', 'Email', { optional: true, max: 254 });
  if (email && !isEmail(email)) fail(400, 'Email is not valid.');
  const password = typeof data.password === 'string' && data.password ? data.password : null;
  if (password !== null && password.length < 12) fail(400, 'Password must be at least 12 characters.');
  const pin = typeof data.pin === 'string' && data.pin ? data.pin : null;
  if (pin !== null && !/^\d{4,6}$/.test(pin)) fail(400, 'PIN must be 4 to 6 digits.');
  if (needLogin && (role === 'owner' || role === 'manager') && (!email || !password)) fail(400, 'An Owner or manager needs an email and a password.');
  return { role, name, email, password, pin };
}

/**
 * An email belongs to one person (one login) across all of Bookr POS. A restaurant may not give its staff an email that
 * someone else already signs in with, here or at another restaurant: that would let one restaurant reach another.
 */
async function emailFree(db: D1Database, email: string | null, exceptStaffId: string | null) {
  if (!email) return;
  const other = await one(db, 'SELECT 1 FROM staff WHERE lower(email) = lower(?) AND id IS NOT ? LIMIT 1', email, exceptStaffId);
  const admin = await one(db, 'SELECT 1 FROM platform_admins WHERE lower(email) = lower(?)', email);
  if (other || admin) fail(409, 'That email is already used. Use another email for this person.');
}

settingsRoutes.post(`${B}/staff`, requireAction('staff.manage'), async (c) => {
  const f = await staffFields(await body(c), true);
  if (!f.pin && f.role !== 'owner' && f.role !== 'manager') fail(400, 'Counter staff need a PIN.');
  await emailFree(c.env.DB, f.email, null);
  const id = newId();
  try {
    await c.env.DB.batch([
      stmt(c.env.DB, 'INSERT INTO staff (id, business_id, name, role, email, password_hash, pin_hash, created_at, login_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CASE WHEN ?5 IS NULL THEN NULL ELSE ?1 END)',
        id, c.get('businessId'), f.name, f.role, f.email, f.password ? await hashPassword(f.password) : null, f.pin ? await hashPassword(f.pin) : null, now()),
      audit(c.env.DB, c.get('businessId'), c.get('staff').id, 'staff.create', 'staff', id, null, { name: f.name, role: f.role, email: f.email, pin: !!f.pin }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'That email is already used.');
    throw e;
  }
  return c.json({ id }, 201);
});

settingsRoutes.put(`${B}/staff/:id`, requireAction('staff.manage'), async (c) => {
  const id = c.req.param('id');
  const bid = c.get('businessId');
  const before = await one<{ name: string; role: string; email: string | null; active: number; password_hash: string | null; login_id: string | null; support: number }>(c.env.DB,
    'SELECT name, role, email, active, password_hash, login_id, support FROM staff WHERE id = ? AND business_id = ?', id, bid);
  if (!before) fail(404, 'Person not found.');
  if (before.support) fail(409, 'This is Bookr POS support. Turn support access off to remove it.');
  const data = await body(c);
  const f = await staffFields(data, false);
  // A changed email must be free; a person with places at other restaurants keeps their email (an admin changes it).
  if ((f.email ?? '').toLowerCase() !== (before.email ?? '').toLowerCase()) {
    const shared = before.login_id ? await one<{ n: number }>(c.env.DB, 'SELECT count(*) AS n FROM staff WHERE login_id = ?', before.login_id) : null;
    if ((shared?.n ?? 0) > 1) fail(409, 'This person signs in at other restaurants too. Ask Bookr POS to change their email.');
    await emailFree(c.env.DB, f.email, id);
  }
  if ((f.role === 'owner' || f.role === 'manager') && !(f.email && (f.password || before.password_hash))) fail(400, 'An Owner or manager needs an email and a password.');
  const active = data.active === false ? 0 : 1;
  if (before.role === 'owner' && (f.role !== 'owner' || !active)) {
    const owners = await one<{ n: number }>(c.env.DB, "SELECT count(*) AS n FROM staff WHERE business_id = ? AND role = 'owner' AND active = 1", bid);
    if ((owners?.n ?? 0) <= 1) fail(409, 'A business always keeps one active Owner.');
  }
  const sets = ['name = ?', 'role = ?', 'email = ?', 'active = ?', 'login_id = ?'];
  const vals: unknown[] = [f.name, f.role, f.email, active, f.email ? before.login_id ?? id : null];
  // A person with places at several restaurants has one password: only they change it, and it changes everywhere.
  const sharedLogin = before.login_id ? ((await one<{ n: number }>(c.env.DB, 'SELECT count(*) AS n FROM staff WHERE login_id = ?', before.login_id))?.n ?? 0) > 1 : false;
  if (f.password && sharedLogin && c.get('loginId') !== before.login_id) fail(409, 'This person signs in at other restaurants too: only they can change their password.');
  const newHash = f.password ? await hashPassword(f.password) : null;
  if (newHash && !sharedLogin) { sets.push('password_hash = ?'); vals.push(newHash); }
  if (f.pin) { sets.push('pin_hash = ?'); vals.push(await hashPassword(f.pin)); }
  await c.env.DB.batch([
    stmt(c.env.DB, `UPDATE staff SET ${sets.join(', ')} WHERE id = ? AND business_id = ?`, ...vals, id, bid),
    ...(newHash && sharedLogin ? [stmt(c.env.DB, 'UPDATE staff SET password_hash = ? WHERE login_id = ?', newHash, before.login_id)] : []),
    ...(active ? [] : [stmt(c.env.DB, 'DELETE FROM sessions WHERE staff_id = ?', id)]),
    audit(c.env.DB, bid, c.get('staff').id, 'staff.update', 'staff', id,
      { name: before.name, role: before.role, email: before.email, active: before.active },
      { name: f.name, role: f.role, email: f.email, active, passwordChanged: !!f.password, pinChanged: !!f.pin }),
  ]);
  return c.json({ ok: true });
});

// ---------- billing names (entities)

interface EntityRow {
  id: string; name: string; kind: string; gst_registered: number; gstin: string | null; gst_rate_bp: number; series_prefix: string;
  yearly_limit_paise: number | null; warn1_paise: number | null; warn2_paise: number | null; stop_paise: number | null;
  is_default: number; offered: number; active: number;
}

settingsRoutes.get(`${B}/entities`, requireAction('pos.view'), async (c) => {
  const { fy } = clock(bizOf(c));
  const rows = await all<EntityRow & { year_paise: number }>(c.env.DB, `
    SELECT e.*, coalesce((SELECT sum(total_paise) FROM bills b WHERE b.entity_id = e.id AND b.fy = ? AND b.status <> 'void'), 0) AS year_paise
    FROM billing_entities e WHERE e.business_id = ? ORDER BY e.is_default DESC, e.name`, fy, c.get('businessId'));
  return c.json({ fy, entities: rows });
});

function entityFields(data: Record<string, unknown>) {
  const kinds = ['company', 'llp', 'partnership', 'proprietor', 'huf', 'other'];
  if (typeof data.kind !== 'string' || !kinds.includes(data.kind)) fail(400, 'Kind must be company, LLP, partnership, proprietor, HUF or other.');
  const gst = flag(data.gstRegistered);
  const gstin = gst ? text(data, 'gstin', 'GSTIN', { max: 15 })! : null;
  if (gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(gstin)) fail(400, 'GSTIN must be 15 characters.');
  const rate = gst ? int(data.gstRateBp, 'GST rate (basis points, 500 = 5%)', 0, 2800) : 0;
  const prefix = text(data, 'seriesPrefix', 'Bill series prefix', { max: 4 })!.toUpperCase();
  if (!/^[A-Z0-9]{1,4}$/.test(prefix)) fail(400, 'Bill series prefix must be 1 to 4 letters or digits.');
  const limit = optionalPaise(data, 'yearlyLimit', 'Yearly limit');
  const warn1 = optionalPaise(data, 'warn1', 'First warning');
  const warn2 = optionalPaise(data, 'warn2', 'Second warning');
  const stop = optionalPaise(data, 'stopAt', 'Stop at');
  if (limit === null && (warn1 !== null || warn2 !== null || stop !== null)) fail(400, 'Warnings need a yearly limit.');
  for (const v of [warn1, warn2, stop]) if (v !== null && limit !== null && (v <= 0 || v > limit)) fail(400, 'Warnings and the stop point must be above zero and not above the yearly limit.');
  return {
    name: text(data, 'name', 'Name on the bill', { max: 100 })!, kind: data.kind, gst_registered: gst ? 1 : 0, gstin, gst_rate_bp: rate,
    series_prefix: prefix, yearly_limit_paise: limit, warn1_paise: warn1, warn2_paise: warn2, stop_paise: stop ?? limit,
    is_default: flag(data.isDefault) ? 1 : 0, offered: data.offered === false ? 0 : 1, active: data.active === false ? 0 : 1,
  };
}

settingsRoutes.post(`${B}/entities`, requireAction('entities.edit'), async (c) => {
  const bid = c.get('businessId');
  const f = entityFields(await body(c));
  const first = !(await one(c.env.DB, 'SELECT 1 FROM billing_entities WHERE business_id = ?', bid));
  if (first) f.is_default = 1;
  const id = newId();
  try {
    await c.env.DB.batch([
      ...(f.is_default ? [stmt(c.env.DB, 'UPDATE billing_entities SET is_default = 0 WHERE business_id = ?', bid)] : []),
      stmt(c.env.DB, `INSERT INTO billing_entities (id, business_id, name, kind, gst_registered, gstin, gst_rate_bp, series_prefix,
        yearly_limit_paise, warn1_paise, warn2_paise, stop_paise, is_default, offered, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, bid, f.name, f.kind, f.gst_registered, f.gstin, f.gst_rate_bp, f.series_prefix,
        f.yearly_limit_paise, f.warn1_paise, f.warn2_paise, f.stop_paise, f.is_default, f.offered, f.active, now()),
      audit(c.env.DB, bid, c.get('staff').id, 'entity.create', 'billing_entities', id, null, f),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'Another billing name already uses that series prefix.');
    throw e;
  }
  return c.json({ id }, 201);
});

settingsRoutes.put(`${B}/entities/:id`, requireAction('entities.edit'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const before = await one<EntityRow>(c.env.DB, 'SELECT * FROM billing_entities WHERE id = ? AND business_id = ?', id, bid);
  if (!before) fail(404, 'Billing name not found.');
  const f = entityFields(await body(c));
  if (before.is_default && !f.is_default) fail(400, 'Choose another billing name as the default instead.');
  if (f.series_prefix !== before.series_prefix && (await one(c.env.DB, 'SELECT 1 FROM bills WHERE entity_id = ?', id))) {
    fail(409, 'This billing name already has bills; its series prefix cannot change. Add a new billing name for a new series.');
  }
  if (f.is_default && (!f.active || !f.offered)) fail(400, 'The default billing name must be active and offered.');
  try {
    await c.env.DB.batch([
      ...(f.is_default && !before.is_default ? [stmt(c.env.DB, 'UPDATE billing_entities SET is_default = 0 WHERE business_id = ?', bid)] : []),
      stmt(c.env.DB, `UPDATE billing_entities SET name = ?, kind = ?, gst_registered = ?, gstin = ?, gst_rate_bp = ?, series_prefix = ?,
        yearly_limit_paise = ?, warn1_paise = ?, warn2_paise = ?, stop_paise = ?, is_default = ?, offered = ?, active = ? WHERE id = ?`,
        f.name, f.kind, f.gst_registered, f.gstin, f.gst_rate_bp, f.series_prefix, f.yearly_limit_paise, f.warn1_paise, f.warn2_paise,
        f.stop_paise, f.is_default, f.offered, f.active, id),
      audit(c.env.DB, bid, c.get('staff').id, 'entity.update', 'billing_entities', id, before, f),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'Another billing name already uses that series prefix.');
    throw e;
  }
  return c.json({ ok: true });
});

// ---------- UPI accounts (each belongs to a billing name)

settingsRoutes.get(`${B}/pay-accounts`, requireAction('pos.view'), async (c) => {
  return c.json({ accounts: await all(c.env.DB, `SELECT a.id, a.name, a.entity_id AS entityId, e.name AS entityName, a.bookr_account_id AS bookrAccountId, a.active
    FROM pay_accounts a JOIN billing_entities e ON e.id = a.entity_id WHERE a.business_id = ? ORDER BY a.active DESC, a.name`, c.get('businessId')) });
});

settingsRoutes.post(`${B}/pay-accounts`, requireAction('entities.edit'), async (c) => {
  const bid = c.get('businessId');
  const data = await body(c);
  const name = text(data, 'name', 'Account name', { max: 80 })!;
  const entityId = text(data, 'entityId', 'Billing name')!;
  if (!(await one(c.env.DB, 'SELECT 1 FROM billing_entities WHERE id = ? AND business_id = ?', entityId, bid))) fail(400, 'Billing name not found.');
  const bookr = text(data, 'bookrAccountId', 'Bookr account', { optional: true, max: 40 });
  const id = newId();
  await c.env.DB.batch([
    stmt(c.env.DB, 'INSERT INTO pay_accounts (id, business_id, name, entity_id, bookr_account_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, bid, name, entityId, bookr, now()),
    audit(c.env.DB, bid, c.get('staff').id, 'pay_account.create', 'pay_accounts', id, null, { name, entityId, bookr }),
  ]);
  return c.json({ id }, 201);
});

settingsRoutes.put(`${B}/pay-accounts/:id`, requireAction('entities.edit'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const before = await one(c.env.DB, 'SELECT name, entity_id, bookr_account_id, active FROM pay_accounts WHERE id = ? AND business_id = ?', id, bid);
  if (!before) fail(404, 'Account not found.');
  const data = await body(c);
  const name = text(data, 'name', 'Account name', { max: 80 })!;
  const entityId = text(data, 'entityId', 'Billing name')!;
  if (!(await one(c.env.DB, 'SELECT 1 FROM billing_entities WHERE id = ? AND business_id = ?', entityId, bid))) fail(400, 'Billing name not found.');
  const bookr = text(data, 'bookrAccountId', 'Bookr account', { optional: true, max: 40 });
  const active = data.active === false ? 0 : 1;
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE pay_accounts SET name = ?, entity_id = ?, bookr_account_id = ?, active = ? WHERE id = ?', name, entityId, bookr, active, id),
    audit(c.env.DB, bid, c.get('staff').id, 'pay_account.update', 'pay_accounts', id, before, { name, entityId, bookr, active }),
  ]);
  return c.json({ ok: true });
});

// ---------- menu

settingsRoutes.get(`${B}/menu`, requireAction('pos.view'), async (c) => {
  const bid = c.get('businessId');
  const [items, links, categories, groups, options, stations] = await Promise.all([
    all(c.env.DB, `SELECT id, name, category, price_paise AS pricePaise, sac, station, active, tax_mode AS taxMode, gst_bp AS gstBp,
      open_price AS openPrice, min_price_paise AS minPricePaise, kot, station_id AS stationId FROM menu_items WHERE business_id = ? ORDER BY category, name`, bid),
    all<{ item_id: string; group_id: string; prices: string | null }>(c.env.DB, 'SELECT item_id, group_id, prices FROM menu_item_addons WHERE business_id = ? ORDER BY sort', bid),
    all(c.env.DB, 'SELECT id, name, tax_mode AS taxMode, gst_bp AS gstBp, kot, station_id AS stationId FROM menu_categories WHERE business_id = ? ORDER BY sort, name', bid),
    all<{ id: string; name: string; kind: string }>(c.env.DB, 'SELECT id, name, kind FROM addon_groups WHERE business_id = ? ORDER BY name', bid),
    all<{ id: string; group_id: string; name: string; add_paise: number }>(c.env.DB,
      'SELECT id, group_id, name, add_paise FROM addon_options WHERE business_id = ? AND active = 1 ORDER BY sort, name', bid),
    stationList(c.env.DB, bid),
  ]);
  return c.json({
    stations,
    items: items.map((i) => {
      const mine = links.filter((l) => l.item_id === i.id);
      return { ...i, openPrice: !!i.openPrice, addonGroups: mine.map((l) => l.group_id),
        addonPrices: Object.fromEntries(mine.filter((l) => readPrices(l.prices)).map((l) => [l.group_id, readPrices(l.prices)])) };
    }),
    categories,
    addonGroups: groups.map((g) => ({ ...g, options: options.filter((o) => o.group_id === g.id).map((o) => ({ id: o.id, name: o.name, addPaise: o.add_paise })) })),
  });
});

/** A tax choice from a form: from the category (items only), the billing name, a GST rate, liquor (outside GST), or none. */
function taxFields(data: Record<string, unknown>, forItem: boolean): { tax_mode: string | null; gst_bp: number | null } {
  if (data.tax !== undefined && data.tax !== 'gst' && data.tax !== 'none') fail(400, 'Tax must be gst, or none for liquor.');
  const mode = data.taxMode ?? (data.tax === 'none' ? 'liquor' : forItem ? 'category' : 'billing');
  if (forItem && mode === 'category') return { tax_mode: null, gst_bp: null };
  if (mode === 'billing' || mode === 'liquor' || mode === 'none') return { tax_mode: mode, gst_bp: null };
  if (mode === 'rate') {
    const r = data.gstRate;
    if (typeof r !== 'number' || ![0, 5, 12, 18, 28, 40].includes(r)) fail(400, 'GST rate must be 0, 5, 12, 18, 28 or 40 percent.');
    return { tax_mode: 'rate', gst_bp: r * 100 };
  }
  fail(400, 'Tax must be from the category, the billing name, a GST rate, liquor, or none.');
}

function itemFields(data: Record<string, unknown>) {
  // Where its KOT goes: stationId (null or '' = its category's), and kot: 'category', 'yes' or 'no'. The older
  // station 'kitchen' / 'bar' still works: it picks the business's first kitchen or bar station.
  const station = data.station ?? 'kitchen';
  if (station !== 'kitchen' && station !== 'bar') fail(400, 'Station must be kitchen or bar.');
  const stationId = data.stationId === undefined ? undefined : data.stationId === null || data.stationId === '' ? null : String(data.stationId);
  const kotRaw = data.kot ?? 'category';
  if (kotRaw !== 'category' && kotRaw !== 'yes' && kotRaw !== 'no') fail(400, 'KOT must be from the category, yes or no.');
  const sac = text(data, 'sac', 'SAC', { optional: true, max: 8 }) ?? '996332';
  if (!/^\d{4,8}$/.test(sac)) fail(400, 'SAC must be 4 to 8 digits.');
  const open = data.openPrice === true;
  // The price may be left out when a "pick one" sets it (the first option's price on this dish); checked in itemExtras.
  const price = optionalPaise(data, 'price', 'Price');
  if (price !== null && price < 0) fail(400, 'Price cannot be negative.');
  // Add-ons: a group id, or { id, prices: { option name: rupees } } for this dish's own prices.
  const raw = data.addonGroups ?? [];
  if (!Array.isArray(raw) || raw.length > 10) fail(400, 'Add-ons must be a list of add-on groups.');
  const groups = raw.map((g) => {
    if (typeof g === 'string') return { id: g, prices: null as Record<string, unknown> | null };
    const x = (g ?? {}) as Record<string, unknown>;
    if (typeof x.id !== 'string' || (x.prices !== undefined && x.prices !== null && (typeof x.prices !== 'object' || Array.isArray(x.prices)))) fail(400, 'Add-ons must be a list of add-on groups.');
    return { id: x.id, prices: (x.prices ?? null) as Record<string, unknown> | null };
  });
  if (new Set(groups.map((g) => g.id)).size !== groups.length) fail(400, 'Each add-on once.');
  return { name: text(data, 'name', 'Item name', { max: 80 })!, category: text(data, 'category', 'Category', { optional: true, max: 40 }) ?? 'Other', price_paise: price, sac, station,
    ...taxFields(data, true), open_price: open ? 1 : 0, min_price_paise: open ? optionalPaise(data, 'minPrice', 'Lowest price') : null,
    addon_groups: groups, active: data.active === false ? 0 : 1, station_id: stationId, kot: kotRaw === 'category' ? null : kotRaw === 'yes' ? 1 : 0 };
}

/**
 * A dish's own prices for one add-on, from a form ({ "Half": "300", "Full": "450" }) to paise by option name.
 * A "pick one" is priced for all its options or none; an "add any" may price any of its options.
 */
function dishPrices(raw: Record<string, unknown> | null, g: { name: string; kind: string; options: { name: string }[] }, item: string): Prices | null {
  if (!raw) return null;
  const known = new Map(g.options.map((o) => [priceKey(o.name), o.name]));
  const out: Prices = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === '' || v === null || v === undefined) continue;
    if (!known.has(priceKey(k))) fail(400, `${g.name} has no option called ${k}.`);
    const p = paise({ v: typeof v === 'number' ? String(v) : v }, 'v', `${item}: price of ${known.get(priceKey(k))}`);
    if (p < 0) fail(400, `${item}: a price cannot be negative.`);
    out[priceKey(k)] = p;
  }
  const n = Object.keys(out).length;
  if (!n) return null;
  if (g.kind === 'one' && n !== g.options.length) fail(400, `${item}: type a price for each of ${g.options.map((o) => o.name).join(', ')}, or none.`);
  return out;
}
async function groupsWithOptions(db: D1Database, bid: string, ids: string[]) {
  if (!ids.length) return [];
  const [gs, os] = await Promise.all([
    all<{ id: string; name: string; kind: string }>(db, 'SELECT id, name, kind FROM addon_groups WHERE business_id = ? AND id IN (SELECT value FROM json_each(?))', bid, JSON.stringify(ids)),
    all<{ group_id: string; name: string; add_paise: number }>(db, 'SELECT group_id, name, add_paise FROM addon_options WHERE business_id = ? AND active = 1 AND group_id IN (SELECT value FROM json_each(?)) ORDER BY sort, name', bid, JSON.stringify(ids)),
  ]);
  return gs.map((g) => ({ ...g, options: os.filter((o) => o.group_id === g.id).map((o) => ({ name: o.name, addPaise: o.add_paise })) }));
}

/**
 * Statements that set a dish's add-ons with its own prices (each add-on must be the business's own) and make sure its
 * category exists. Fills in the dish's price from a priced "pick one" (its first option), which then wins over a typed one.
 */
async function itemExtras(c: { env: { DB: D1Database } }, bid: string, id: string, f: ReturnType<typeof itemFields>) {
  const gs = await groupsWithOptions(c.env.DB, bid, f.addon_groups.map((g) => g.id));
  if (gs.length !== f.addon_groups.length) fail(400, 'An add-on group was not found.');
  const links = f.addon_groups.map((x) => { const g = gs.find((y) => y.id === x.id)!; return { ...g, prices: dishPrices(x.prices, g, f.name) }; });
  // The station: the one chosen (the business's own), else for the older kitchen / bar field the first such station,
  // kept on the item only when it differs from its category's.
  const sts = await stationList(c.env.DB, bid);
  if (f.station_id && !sts.some((x) => x.id === f.station_id)) fail(400, 'That station was not found.');
  const cat = await one<{ station_id: string | null }>(c.env.DB, 'SELECT station_id FROM menu_categories WHERE business_id = ? AND lower(name) = lower(?)', bid, f.category);
  if (f.station_id === undefined) {
    const legacy = sts.find((x) => x.isBar === (f.station === 'bar') && x.active) ?? sts[0];
    const catSt = sts.find((x) => x.id === cat?.station_id);
    // A new category is made with this station, so the item follows it; an existing one is followed unless it differs.
    f.station_id = !cat || (catSt && catSt.isBar === legacy?.isBar) ? null : legacy?.id ?? null;
  }
  const own = sts.find((x) => x.id === (f.station_id ?? cat?.station_id));
  if (own) f.station = own.isBar ? 'bar' : 'kitchen';
  const base = f.open_price ? null : basePrice(links);
  if (base !== null) f.price_paise = base;
  if (f.price_paise === null) { if (f.open_price) f.price_paise = 0; else fail(400, 'Type the price.'); }
  return [
    stmt(c.env.DB, 'DELETE FROM menu_item_addons WHERE item_id = ?', id),
    ...links.map((g, i) => stmt(c.env.DB, 'INSERT INTO menu_item_addons (item_id, group_id, business_id, sort, prices) VALUES (?, ?, ?, ?, ?)', id, g.id, bid, i, g.prices ? JSON.stringify(g.prices) : null)),
    stmt(c.env.DB, 'INSERT OR IGNORE INTO menu_categories (id, business_id, name, station_id, created_at) VALUES (?, ?, ?, ?, ?)', newId(), bid, f.category,
      f.station_id ?? sts.find((x) => x.isBar === (f.station === 'bar') && x.active)?.id ?? sts[0]?.id ?? null, now()),
  ];
}

settingsRoutes.post(`${B}/menu`, requireAction('menu.edit'), async (c) => {
  const bid = c.get('businessId');
  const f = itemFields(await body(c));
  const id = newId();
  const extras = await itemExtras(c, bid, id, f);
  await c.env.DB.batch([
    stmt(c.env.DB, `INSERT INTO menu_items (id, business_id, name, category, price_paise, sac, station, tax_mode, gst_bp, open_price, min_price_paise, active, created_at, kot, station_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, bid, f.name, f.category, f.price_paise, f.sac, f.station, f.tax_mode, f.gst_bp, f.open_price, f.min_price_paise, f.active, now(), f.kot, f.station_id ?? null),
    ...extras,
    syncItemStations(c.env.DB, bid),
    audit(c.env.DB, bid, c.get('staff').id, 'menu.create', 'menu_items', id, null, f),
  ]);
  return c.json({ id }, 201);
});

settingsRoutes.put(`${B}/menu/:id`, requireAction('menu.edit'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const before = await one(c.env.DB, 'SELECT name, category, price_paise, sac, station, tax_mode, gst_bp, open_price, min_price_paise, active FROM menu_items WHERE id = ? AND business_id = ?', id, bid);
  if (!before) fail(404, 'Item not found.');
  const f = itemFields(await body(c));
  const extras = await itemExtras(c, bid, id, f);
  await c.env.DB.batch([
    stmt(c.env.DB, `UPDATE menu_items SET name = ?, category = ?, price_paise = ?, sac = ?, station = ?, tax_mode = ?, gst_bp = ?, open_price = ?, min_price_paise = ?, active = ?,
      kot = ?, station_id = ? WHERE id = ?`, f.name, f.category, f.price_paise, f.sac, f.station, f.tax_mode, f.gst_bp, f.open_price, f.min_price_paise, f.active, f.kot, f.station_id ?? null, id),
    ...extras,
    syncItemStations(c.env.DB, bid),
    audit(c.env.DB, bid, c.get('staff').id, 'menu.update', 'menu_items', id, before, f),
  ]);
  return c.json({ ok: true });
});

/**
 * One change to many items at once, from the Menu screen's ticked rows: take off or put back on the menu, delete, move
 * to a category, send to a station (or No KOT, or as the category says), or set the tax. All or nothing, one audit entry.
 * Delete removes an item only if it was never ordered; one that was is taken off the menu instead, so every past bill,
 * KOT and report still shows it.
 */
settingsRoutes.post(`${B}/menu/bulk`, requireAction('menu.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  const ids = data.ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 2000 || !ids.every((x) => typeof x === 'string' && isUuid(x))) fail(400, 'Choose at least one item.');
  const uniq = [...new Set(ids as string[])];
  const json = JSON.stringify(uniq);
  const before = await all<{ id: string; name: string; category: string; active: number; station_id: string | null; kot: number | null; tax_mode: string | null; gst_bp: number | null; used: number }>(db,
    `SELECT id, name, category, active, station_id, kot, tax_mode, gst_bp,
       EXISTS (SELECT 1 FROM order_lines l WHERE l.item_id = m.id) OR EXISTS (SELECT 1 FROM bill_lines l WHERE l.item_id = m.id) AS used
     FROM menu_items m WHERE business_id = ? AND id IN (SELECT value FROM json_each(?))`, bid, json);
  if (before.length !== uniq.length) fail(404, 'An item was not found. Reload the page and try again.');
  const IN = 'business_id = ? AND id IN (SELECT value FROM json_each(?))';
  const action = data.action;
  const s: D1PreparedStatement[] = [];
  let result: Record<string, unknown> = { changed: uniq.length };
  if (action === 'off' || action === 'on') {
    s.push(stmt(db, `UPDATE menu_items SET active = ? WHERE ${IN}`, action === 'on' ? 1 : 0, bid, json));
  } else if (action === 'delete') {
    const used = before.filter((m) => m.used).map((m) => m.id);
    const unused = before.filter((m) => !m.used).map((m) => m.id);
    if (unused.length) s.push(stmt(db, `DELETE FROM menu_items WHERE ${IN}`, bid, JSON.stringify(unused)));
    if (used.length) s.push(stmt(db, `UPDATE menu_items SET active = 0 WHERE ${IN}`, bid, JSON.stringify(used)));
    result = { deleted: unused.length, takenOff: used.length };
  } else if (action === 'category') {
    const name = text(data, 'value', 'Category', { max: 40 })!;
    const sts = await stationList(db, bid);
    const first = sts.find((x) => x.active && !x.isBar) ?? sts.find((x) => x.active) ?? sts[0];
    s.push(stmt(db, 'INSERT OR IGNORE INTO menu_categories (id, business_id, name, station_id, created_at) VALUES (?, ?, ?, ?, ?)', newId(), bid, name, first?.id ?? null, now()));
    s.push(stmt(db, `UPDATE menu_items SET category = coalesce((SELECT c.name FROM menu_categories c WHERE c.business_id = ?1 AND lower(c.name) = lower(?3)), ?3)
      WHERE business_id = ?1 AND id IN (SELECT value FROM json_each(?2))`, bid, json, name));
  } else if (action === 'station') {
    const v = data.value;
    if (v === 'category') s.push(stmt(db, `UPDATE menu_items SET station_id = NULL, kot = NULL WHERE ${IN}`, bid, json));
    else if (v === 'none') s.push(stmt(db, `UPDATE menu_items SET station_id = NULL, kot = 0 WHERE ${IN}`, bid, json));
    else {
      if (typeof v !== 'string' || !(await stationList(db, bid)).some((x) => x.id === v && x.active)) fail(400, 'That station was not found.');
      // A station chosen means a KOT: kept as the category says when the category prints one, else this item prints its own.
      s.push(stmt(db, `UPDATE menu_items SET station_id = ?1, kot = CASE WHEN coalesce((SELECT c.kot FROM menu_categories c WHERE c.business_id = menu_items.business_id
        AND lower(c.name) = lower(menu_items.category)), 1) = 1 THEN NULL ELSE 1 END WHERE business_id = ?2 AND id IN (SELECT value FROM json_each(?3))`, v, bid, json));
    }
  } else if (action === 'tax') {
    const f = taxFields((data.value ?? {}) as Record<string, unknown>, true);
    s.push(stmt(db, `UPDATE menu_items SET tax_mode = ?, gst_bp = ? WHERE ${IN}`, f.tax_mode, f.gst_bp, bid, json));
  } else fail(400, 'Unknown change.');
  await db.batch([
    ...s,
    syncItemStations(db, bid),
    audit(db, bid, c.get('staff').id, `menu.bulk.${action}`, 'menu_items', `${uniq.length} items`,
      before.map(({ used, ...m }) => m), { ids: uniq, value: data.value ?? null, ...result }),
  ]);
  return c.json({ ok: true, ...result });
});

// A category's tax, which its items take unless they say otherwise.
settingsRoutes.put(`${B}/menu-categories/:id`, requireAction('menu.edit'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const before = await one<{ name: string; tax_mode: string; gst_bp: number | null; kot: number; station_id: string | null }>(c.env.DB,
    'SELECT name, tax_mode, gst_bp, kot, station_id FROM menu_categories WHERE id = ? AND business_id = ?', id, bid);
  if (!before) fail(404, 'Category not found.');
  const data = await body(c);
  // Any of: its tax (taxMode, gstRate), whether its items make a KOT (kot: true / false), and its station.
  const f = data.taxMode !== undefined || data.tax !== undefined ? taxFields(data, false) : { tax_mode: before.tax_mode, gst_bp: before.gst_bp };
  if (data.kot !== undefined && typeof data.kot !== 'boolean') fail(400, 'KOT must be yes or no.');
  const kot = data.kot === undefined ? before.kot : data.kot ? 1 : 0;
  let stationId = before.station_id;
  if (data.stationId !== undefined) {
    if (!(await stationList(c.env.DB, bid)).some((x) => x.id === data.stationId)) fail(400, 'That station was not found.');
    stationId = data.stationId as string;
  }
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE menu_categories SET tax_mode = ?, gst_bp = ?, kot = ?, station_id = ? WHERE id = ?', f.tax_mode, f.gst_bp, kot, stationId, id),
    syncItemStations(c.env.DB, bid),
    audit(c.env.DB, bid, c.get('staff').id, 'category.update', 'menu_categories', id, before, { ...f, kot, station_id: stationId }),
  ]);
  return c.json({ ok: true });
});

// Add-on groups: "choose one" (Half / Full) or "add any" (Peri Peri Fries, Extra Cheese), each with its options and prices.
// Saving replaces the options; orders keep the names and prices they were taken with.
async function saveGroup(c: Context<AppEnv>, id: string | null) {
  const bid = c.get('businessId');
  const data = await body(c);
  const name = text(data, 'name', 'Add-on name', { max: 60 })!;
  const kind = data.kind;
  if (kind !== 'one' && kind !== 'any') fail(400, 'Choose "pick one" or "add any".');
  const raw = Array.isArray(data.options) ? data.options : [];
  if (!raw.length || raw.length > 20) fail(400, 'Add between 1 and 20 options.');
  if (kind === 'one' && raw.length < 2) fail(400, 'A "pick one" add-on needs at least two options.');
  const opts = raw.map((o, i) => {
    const r = (o ?? {}) as Record<string, unknown>;
    return { name: text(r, 'name', `Option ${i + 1}`, { max: 60 })!, add: optionalPaise(r, 'price', `Price of option ${i + 1}`) ?? 0 };
  });
  const gid = id ?? newId();
  let before = null;
  if (id) {
    before = await one(c.env.DB, 'SELECT name, kind FROM addon_groups WHERE id = ? AND business_id = ?', id, bid);
    if (!before) fail(404, 'Add-on not found.');
  }
  try {
    await c.env.DB.batch([
      id ? stmt(c.env.DB, 'UPDATE addon_groups SET name = ?, kind = ? WHERE id = ?', name, kind, id)
        : stmt(c.env.DB, 'INSERT INTO addon_groups (id, business_id, name, kind, created_at) VALUES (?, ?, ?, ?, ?)', gid, bid, name, kind, now()),
      stmt(c.env.DB, 'DELETE FROM addon_options WHERE group_id = ?', gid),
      ...opts.map((o, i) => stmt(c.env.DB, 'INSERT INTO addon_options (id, business_id, group_id, name, add_paise, sort) VALUES (?, ?, ?, ?, ?, ?)', newId(), bid, gid, o.name, o.add, i)),
      audit(c.env.DB, bid, c.get('staff').id, id ? 'addons.update' : 'addons.create', 'addon_groups', gid, before, { name, kind, options: opts }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, `There is already an add-on called ${name}.`);
    throw e;
  }
  return c.json({ id: gid }, id ? 200 : 201);
}
settingsRoutes.post(`${B}/addon-groups`, requireAction('menu.edit'), (c) => saveGroup(c, null));
settingsRoutes.put(`${B}/addon-groups/:id`, requireAction('menu.edit'), (c) => saveGroup(c, c.req.param('id')));
// Which items offer an add-on, set from the add-on's side (tick many items at once), each with its own prices if given.
// Items keep their other add-ons; an item newly ticked gets this one after the ones it has. A priced "pick one" also
// sets the dish's price to its first option's price (not for price-at-billing dishes).
settingsRoutes.put(`${B}/addon-groups/:id/items`, requireAction('menu.edit'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const [g] = await groupsWithOptions(c.env.DB, bid, [id]);
  if (!g) fail(404, 'Add-on not found.');
  const data = await body(c);
  // { items: [{ id, prices? }] }, or { itemIds: [...] } (no prices of their own).
  const raw = Array.isArray(data.items) ? data.items : Array.isArray(data.itemIds) ? (data.itemIds as unknown[]).map((x) => ({ id: x })) : null;
  if (!raw || raw.length > 3000) fail(400, 'Items must be a list.');
  const list = raw.map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    if (typeof r.id !== 'string' || (r.prices !== undefined && r.prices !== null && (typeof r.prices !== 'object' || Array.isArray(r.prices)))) fail(400, 'Items must be a list.');
    return { id: r.id, prices: (r.prices ?? null) as Record<string, unknown> | null };
  });
  if (new Set(list.map((x) => x.id)).size !== list.length) fail(400, 'Each item once.');
  const known = list.length ? await all<{ id: string; name: string; open_price: number }>(c.env.DB,
    'SELECT id, name, open_price FROM menu_items WHERE business_id = ? AND id IN (SELECT value FROM json_each(?))', bid, JSON.stringify(list.map((x) => x.id))) : [];
  if (known.length !== list.length) fail(400, 'An item was not found.');
  const rows = list.map((x) => { const it = known.find((k) => k.id === x.id)!; return { ...x, open: !!it.open_price, prices: dishPrices(x.prices, g, it.name) }; });
  const want = JSON.stringify(rows.map((x) => x.id));
  const before = await all<{ item_id: string }>(c.env.DB, 'SELECT item_id FROM menu_item_addons WHERE group_id = ?', id);
  await c.env.DB.batch([
    stmt(c.env.DB, 'DELETE FROM menu_item_addons WHERE group_id = ? AND item_id NOT IN (SELECT value FROM json_each(?))', id, want),
    stmt(c.env.DB, `INSERT OR IGNORE INTO menu_item_addons (item_id, group_id, business_id, sort)
      SELECT j.value, ?, ?, (SELECT coalesce(max(sort), -1) + 1 FROM menu_item_addons m WHERE m.item_id = j.value) FROM json_each(?) j`, id, bid, want),
    stmt(c.env.DB, `UPDATE menu_item_addons SET prices = json_extract(j.value, '$.prices') FROM json_each(?) j
      WHERE menu_item_addons.group_id = ? AND menu_item_addons.item_id = json_extract(j.value, '$.id')`,
      JSON.stringify(rows.map((x) => ({ id: x.id, prices: x.prices ? JSON.stringify(x.prices) : null }))), id),
    ...(g.kind === 'one' ? rows.filter((x) => x.prices && !x.open).map((x) =>
      stmt(c.env.DB, 'UPDATE menu_items SET price_paise = ? WHERE id = ? AND business_id = ?', basePrice([{ ...g, prices: x.prices }]), x.id, bid)) : []),
    audit(c.env.DB, bid, c.get('staff').id, 'addons.items', 'addon_groups', id, { items: before.length }, { name: g.name, items: rows.length, priced: rows.filter((x) => x.prices).length }),
  ]);
  return c.json({ ok: true, items: rows.length });
});

// ---------- KOT stations (approved 19 Nov 2026)

export async function stationList(db: D1Database, bid: string) {
  const t = now();
  const rows = await all<{ id: string; name: string; how: string; copies: number; is_bar: number; active: number; seen: number | null; devices: number }>(db,
    `SELECT s.id, s.name, s.how, s.copies, s.is_bar, s.active,
      (SELECT max(d.last_seen_at) FROM devices d WHERE d.station_id = s.id AND d.revoked_at IS NULL) AS seen,
      (SELECT count(*) FROM devices d WHERE d.station_id = s.id AND d.revoked_at IS NULL) AS devices
     FROM stations s WHERE s.business_id = ? ORDER BY s.sort, s.name`, bid);
  return rows.map((r) => ({ id: r.id, name: r.name, how: r.how, copies: r.copies, isBar: !!r.is_bar, active: !!r.active, devices: r.devices, lastSeenAt: r.seen, online: isOnline(r.seen, t) }));
}
settingsRoutes.get(`${B}/stations`, requireAction('pos.view'), async (c) => c.json({ stations: await stationList(c.env.DB, c.get('businessId')) }));

function stationFields(data: Record<string, unknown>) {
  const how = data.how ?? 'paper';
  if (how !== 'paper' && how !== 'screen' && how !== 'both') fail(400, 'A station gets KOTs on paper, on a screen, or both.');
  const copies = data.copies ?? 1;
  if (typeof copies !== 'number' || !Number.isInteger(copies) || copies < 1 || copies > 3) fail(400, 'Copies must be 1 to 3.');
  return { name: text(data, 'name', 'Station name', { max: 40 })!, how, copies, is_bar: data.isBar === true ? 1 : 0, active: data.active === false ? 0 : 1 };
}
settingsRoutes.post(`${B}/stations`, requireAction('menu.edit'), async (c) => {
  const bid = c.get('businessId');
  const f = stationFields(await body(c));
  const id = newId();
  try {
    await c.env.DB.batch([
      stmt(c.env.DB, 'INSERT INTO stations (id, business_id, name, how, copies, is_bar, active, sort, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, coalesce(max(sort), -1) + 1, ? FROM stations WHERE business_id = ?',
        id, bid, f.name, f.how, f.copies, f.is_bar, f.active, now(), bid),
      audit(c.env.DB, bid, c.get('staff').id, 'station.create', 'stations', id, null, f),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, `There is already a station called ${f.name}.`);
    throw e;
  }
  return c.json({ id }, 201);
});
settingsRoutes.put(`${B}/stations/:id`, requireAction('menu.edit'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const before = await one(c.env.DB, 'SELECT name, how, copies, is_bar, active FROM stations WHERE id = ? AND business_id = ?', id, bid);
  if (!before) fail(404, 'Station not found.');
  const f = stationFields(await body(c));
  if (!f.active) {
    const used = await one<{ n: number }>(c.env.DB, `SELECT (SELECT count(*) FROM menu_categories WHERE station_id = ?) + (SELECT count(*) FROM menu_items WHERE station_id = ? AND active = 1) AS n`, id, id);
    if (used!.n) fail(409, 'Categories or items still send their KOTs here. Move them to another station first.');
  }
  try {
    await c.env.DB.batch([
      stmt(c.env.DB, 'UPDATE stations SET name = ?, how = ?, copies = ?, is_bar = ?, active = ? WHERE id = ?', f.name, f.how, f.copies, f.is_bar, f.active, id),
      syncItemStations(c.env.DB, bid),
      audit(c.env.DB, bid, c.get('staff').id, 'station.update', 'stations', id, before, f),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, `There is already a station called ${f.name}.`);
    throw e;
  }
  return c.json({ ok: true });
});

// ---------- reasons

settingsRoutes.get(`${B}/reasons`, requireAction('pos.view'), async (c) => {
  return c.json({ reasons: await all(c.env.DB, 'SELECT id, kind, label FROM reasons WHERE business_id = ? AND active = 1 ORDER BY kind, label', c.get('businessId')) });
});

settingsRoutes.post(`${B}/reasons`, requireAction('menu.edit'), async (c) => {
  const bid = c.get('businessId');
  const data = await body(c);
  if (!['discount', 'comp', 'void', 'kot_cancel'].includes(data.kind as string)) fail(400, 'Kind must be discount, comp, void or kot_cancel.');
  const label = text(data, 'label', 'Reason', { max: 60 })!;
  const id = newId();
  try {
    await c.env.DB.batch([
      stmt(c.env.DB, 'INSERT INTO reasons (id, business_id, kind, label, created_at) VALUES (?, ?, ?, ?, ?)', id, bid, data.kind, label, now()),
      audit(c.env.DB, bid, c.get('staff').id, 'reason.create', 'reasons', id, null, { kind: data.kind, label }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, 'That reason is already in the list.');
    throw e;
  }
  return c.json({ id }, 201);
});

settingsRoutes.post(`${B}/reasons/:id/retire`, requireAction('menu.edit'), async (c) => {
  const bid = c.get('businessId');
  const r = await stmt(c.env.DB, 'UPDATE reasons SET active = 0 WHERE id = ? AND business_id = ?', c.req.param('id'), bid).run();
  if (!r.meta.changes) fail(404, 'Reason not found.');
  await audit(c.env.DB, bid, c.get('staff').id, 'reason.retire', 'reasons', c.req.param('id'), null, null).run();
  return c.json({ ok: true });
});

// ---------- in-house stays and credit accounts

settingsRoutes.get(`${B}/stays`, requireAction('pos.view'), async (c) => {
  const rows = await all<{ phone: string | null }>(c.env.DB, `SELECT s.id, s.room, s.guest_name AS guestName, s.check_in AS checkIn, d.id AS accountId, s.phone,
      coalesce((SELECT sum(amount_paise) FROM debtor_entries e WHERE e.account_id = d.id), 0) AS balancePaise
    FROM stays s JOIN debtor_accounts d ON d.stay_id = s.id
    WHERE s.business_id = ? AND s.checked_out_at IS NULL ORDER BY s.room`, c.get('businessId'));
  // Phone numbers are for the till (finding a guest to put a bill on their room); a captain sees only the last 4 digits.
  const full = can(c.get('staff').role, 'stays.edit');
  return c.json({ stays: rows.map((r) => ({ ...r, phone: r.phone ? (full ? r.phone : `••••${r.phone.slice(-4)}`) : null })) });
});

/**
 * A phone number as kept (22 Nov 2026): an Indian mobile as its 10 digits (a typed +91 or leading 0 is dropped), which
 * must start 6, 7, 8 or 9; a foreign number typed with + and its country code, as 8 to 15 digits. Obvious fakes
 * (one digit repeated, 1234567890) are refused. Empty: no phone.
 */
export function phoneKey(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const problem = phoneProblem(v);
  if (problem) fail(400, problem);
  return phoneDigits(v);
}
const phoneDigits = (v: string) => {
  let d = v.replace(/\D/g, '');
  if (v.trim().startsWith('+')) return d.startsWith('91') && d.length === 12 ? d.slice(2) : d;
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
};
/** Why a typed phone is not valid, in plain words; null when it is. The counter screen runs the same check as it is typed. */
export function phoneProblem(v: string): string | null {
  const foreign = v.trim().startsWith('+') && !/^\+\s*91/.test(v.trim());
  const d = phoneDigits(v);
  if (/[^\d\s+()-]/.test(v.trim())) return 'Phone: use digits only.';
  if (foreign) return d.length < 8 || d.length > 15 ? `Phone: ${d.length} digits. A foreign number has 8 to 15 digits with its country code.` : null;
  if (d.length !== 10) return `Phone: ${d.length} digit${d.length === 1 ? '' : 's'}. A mobile has 10, starting 6, 7, 8 or 9. A foreign number starts with + and the country code.`;
  if (!/^[6-9]/.test(d)) return 'Phone: a mobile starts with 6, 7, 8 or 9. A foreign number starts with + and the country code.';
  if (/^(\d)\1+$/.test(d) || d === '9876543210' || d === '6789012345') return 'Phone: that does not look like a real number.';
  return null;
}

// A returning guest, found by phone at check-in: their details and earlier stays (room, dates, what was charged).
settingsRoutes.get(`${B}/guests/lookup`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const phone = phoneKey(c.req.query('phone') ?? '');
  if (!phone) return c.json({ guest: null });
  const g = await one<{ id: string; name: string; phone: string; city: string | null }>(c.env.DB, 'SELECT id, name, phone, city FROM guests WHERE business_id = ? AND phone = ?', bid, phone);
  if (!g) return c.json({ guest: null });
  const stays = await all(c.env.DB, `SELECT s.room, s.check_in AS checkIn, s.checked_out_at AS checkedOutAt,
      coalesce((SELECT sum(e.amount_paise) FROM debtor_entries e WHERE e.account_id = d.id AND e.amount_paise > 0), 0) AS chargedPaise
    FROM stays s LEFT JOIN debtor_accounts d ON d.stay_id = s.id WHERE s.business_id = ? AND s.guest_id = ? ORDER BY s.created_at DESC LIMIT 10`, bid, g.id);
  return c.json({ guest: { ...g, stays } });
});

settingsRoutes.post(`${B}/stays`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const b = bizOf(c);
  const data = await body(c);
  let room = text(data, 'room', 'Room', { max: 40 })!;
  const guest = text(data, 'guestName', 'Guest name', { max: 80 })!;
  // Rooms and beds come from Settings, Rooms and tables (21 Nov 2026): once any are set up, a stay is in one of them,
  // under its exact name, so its tile, its orders and its folio match. A dorm is checked in by bed, or whole for a group.
  const layout = tableLayout(b);
  const stayable = (layout ?? []).filter((x) => x.kind === 'rooms' || x.kind === 'dorms');
  if (stayable.length) {
    const all_ = stayable.flatMap((x) => x.tables);
    const key = room.toLowerCase().replace(/\broom\b/g, '').replace(/[^a-z0-9]/g, '');
    const name = all_.find((t) => t.toLowerCase() === room.toLowerCase()) ?? all_.find((t) => t.toLowerCase().replace(/\broom\b/g, '').replace(/[^a-z0-9]/g, '') === key);
    if (!name) fail(400, 'Choose a room or bed from the list (Settings, Rooms and tables).');
    room = name;
    const at = placeOf(layout, room);
    if (at?.dorm) {
      const others = at.whole ? sectionTables({ kind: 'dorms', dorms: at.section.dorms!.filter((d) => d.name === at.dorm) }).filter((x) => x !== dormWhole(at.dorm!)) : [dormWhole(at.dorm)];
      const busy = await all<{ room: string }>(c.env.DB, `SELECT room FROM stays WHERE business_id = ? AND checked_out_at IS NULL AND lower(room) IN (SELECT lower(value) FROM json_each(?))`, bid, JSON.stringify(others));
      if (busy.length) fail(409, at.whole ? `${busy.map((x) => x.room).join(', ')} already ${busy.length === 1 ? 'has a guest' : 'have guests'}: the whole dorm cannot be booked.` : `${at.dorm} is booked whole for a group.`);
    }
  }
  const phone = phoneKey(data.phone);
  const city = text(data, 'city', 'City', { optional: true, max: 60 });
  const id = newId();
  const t = now();
  // The guest is kept for next time, by phone: a returning guest's name and city are brought up to date.
  const known = phone ? await one<{ id: string }>(c.env.DB, 'SELECT id FROM guests WHERE business_id = ? AND phone = ?', bid, phone) : null;
  const guestId = phone ? known?.id ?? newId() : null;
  try {
    await c.env.DB.batch([
      ...(phone ? [known
        ? stmt(c.env.DB, 'UPDATE guests SET name = ?, city = coalesce(?, city), updated_at = ? WHERE id = ?', guest, city, t, guestId)
        : stmt(c.env.DB, 'INSERT INTO guests (id, business_id, name, phone, city, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', guestId, bid, guest, phone, city, t, t)] : []),
      stmt(c.env.DB, 'INSERT INTO stays (id, business_id, room, guest_name, check_in, opened_by, created_at, guest_id, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, bid, room, guest, clock(b, t).shiftDay, c.get('staff').id, t, guestId, phone),
      stmt(c.env.DB, "INSERT INTO debtor_accounts (id, business_id, kind, name, stay_id, created_by, created_at) VALUES (?, ?, 'room', ?, ?, ?, ?)",
        newId(), bid, `${/^\d/.test(room) ? 'Room ' : ''}${room} · ${guest}`, id, c.get('staff').id, t),
      audit(c.env.DB, bid, c.get('staff').id, 'stay.open', 'stays', id, null, { room, guest, returning: !!known }),
      // Checked in from a booking read from mail (23 Nov 2026): the booking is marked checked in, with its stay.
      ...(typeof data.bookingId === 'string' && isUuid(data.bookingId)
        ? [stmt(c.env.DB, `UPDATE bookings SET status = 'checked_in', stay_id = ?, updated_at = ? WHERE business_id = ? AND status IN ('approved', 'new')
            AND (id = ?4 OR id = (SELECT match_id FROM bookings WHERE id = ?4))`, id, t, bid, data.bookingId)] : []),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, `${/^\d/.test(room) ? 'Room ' : ''}${room} already has a guest. Check them out first.`);
    throw e;
  }
  return c.json({ id }, 201);
});

// Check-out: the folio must be settled first (a receipt against its account), so nothing owed is forgotten.
settingsRoutes.post(`${B}/stays/:id/check-out`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const row = await one<{ balance: number }>(c.env.DB, `SELECT coalesce((SELECT sum(amount_paise) FROM debtor_entries e WHERE e.account_id = d.id), 0) AS balance
    FROM stays s JOIN debtor_accounts d ON d.stay_id = s.id WHERE s.id = ? AND s.business_id = ? AND s.checked_out_at IS NULL`, id, bid);
  if (!row) fail(404, 'Open stay not found.');
  if (row.balance !== 0) fail(409, `The folio still has a balance. Take the guest's payment (or refund an advance) first.`);
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE stays SET checked_out_at = ? WHERE id = ?', now(), id),
    audit(c.env.DB, bid, c.get('staff').id, 'stay.check_out', 'stays', id, null, null),
  ]);
  return c.json({ ok: true });
});

settingsRoutes.get(`${B}/credit-accounts`, requireAction('pos.view'), async (c) => {
  return c.json({ accounts: await all(c.env.DB, `SELECT d.id, d.name, d.phone, d.credit_limit_paise AS creditLimitPaise,
      coalesce((SELECT sum(amount_paise) FROM debtor_entries e WHERE e.account_id = d.id), 0) AS balancePaise
    FROM debtor_accounts d WHERE d.business_id = ? AND d.kind = 'credit' ORDER BY d.name`, c.get('businessId')) });
});

settingsRoutes.put(`${B}/credit-accounts/:id`, requireAction('reports.view'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const before = await one(c.env.DB, "SELECT name, phone, credit_limit_paise FROM debtor_accounts WHERE id = ? AND business_id = ? AND kind = 'credit'", id, bid);
  if (!before) fail(404, 'Credit account not found.');
  const data = await body(c);
  const after = {
    name: text(data, 'name', 'Name', { max: 80 })!,
    phone: text(data, 'phone', 'Phone', { optional: true, max: 20 }),
    credit_limit_paise: optionalPaise(data, 'creditLimit', 'Credit limit'),
  };
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE debtor_accounts SET name = ?, phone = ?, credit_limit_paise = ? WHERE id = ?', after.name, after.phone, after.credit_limit_paise, id),
    audit(c.env.DB, bid, c.get('staff').id, 'credit_account.update', 'debtor_accounts', id, before, after),
  ]);
  return c.json({ ok: true });
});
