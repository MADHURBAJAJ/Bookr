// Settings a business chooses (nothing hotel-specific is fixed in code): business rules, staff and PINs, billing names
// with their GST and limits, UPI accounts, the menu, reason lists, in-house stays and credit accounts.
import { djuboPays } from '../djubo-desk';
import { Hono, type Context } from 'hono';
import { all, isUniqueViolation, newId, now, one, stmt, type DB } from '../../../src/db';
import { hashPassword } from '../../../src/crypto';
import { body, fail, isEmail, isUuid, optionalPaise, paise, text } from '../../../src/http';
import { approval, approverOf, isManager, requireAction, requireStaff } from '../auth';
import { bookingUnits, continuesOf, folioLines, nightsBetween, roomTax, syncStay } from '../rooms';
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

// The service charge rate (26 Nov 2026), set with the billing names: 0 = none. Which items carry it is set by category.
settingsRoutes.put(`${B}/service-charge`, requireAction('entities.edit'), async (c) => {
  const id = c.get('businessId');
  const data = await body(c);
  const pct = data.pct;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 20 || Math.round(pct * 100) !== pct * 100) fail(400, 'Service charge must be 0 to 20%, at most two decimals.');
  const before = await one<{ service_charge_bp: number }>(c.env.DB, 'SELECT service_charge_bp FROM businesses WHERE id = ?', id);
  const bp = Math.round(pct * 100);
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE businesses SET service_charge_bp = ? WHERE id = ?', bp, id),
    audit(c.env.DB, id, c.get('staff').id, 'business.service_charge', 'businesses', id, before, { service_charge_bp: bp }),
  ]);
  return c.json({ ok: true, serviceChargeBp: bp });
});

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
        if (d.letters === true && beds > 26) fail(400, `${dn}: beds named by letter go up to Z (26).`);
        return { name: dn, beds, ...(d.letters === true ? { letters: true } : {}) };
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
      service_charge AS serviceCharge, price_incl AS priceIncl, open_price AS openPrice, min_price_paise AS minPricePaise, kot, station_id AS stationId FROM menu_items WHERE business_id = ? ORDER BY category, name`, bid),
    all<{ item_id: string; group_id: string; prices: string | null }>(c.env.DB, 'SELECT item_id, group_id, prices FROM menu_item_addons WHERE business_id = ? ORDER BY sort', bid),
    all(c.env.DB, `SELECT id, name, tax_mode AS taxMode, gst_bp AS gstBp, kot, station_id AS stationId, service_charge AS serviceCharge, price_incl AS priceIncl
      FROM menu_categories WHERE business_id = ? ORDER BY sort, name`, bid),
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
    addon_groups: groups, active: data.active === false ? 0 : 1, station_id: stationId, kot: kotRaw === 'category' ? null : kotRaw === 'yes' ? 1 : 0,
    service_charge: followYesNo(data.serviceCharge, 'Service charge'), price_incl: followYesNo(data.priceIncl, 'Price includes GST') };
}

/** An item's own choice (26 Nov 2026): 'category' (or left out) = as its category, 'yes' = 1, 'no' = 0. */
function followYesNo(v: unknown, what: string): number | null {
  if (v === undefined || v === null || v === 'category') return null;
  if (v === 'yes' || v === true) return 1;
  if (v === 'no' || v === false) return 0;
  fail(400, `${what} must be from the category, yes or no.`);
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
    stmt(c.env.DB, `INSERT INTO menu_items (id, business_id, name, category, price_paise, sac, station, tax_mode, gst_bp, open_price, min_price_paise, active, created_at, kot, station_id,
        service_charge, price_incl) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, bid, f.name, f.category, f.price_paise, f.sac, f.station, f.tax_mode, f.gst_bp, f.open_price, f.min_price_paise, f.active, now(), f.kot, f.station_id ?? null,
      f.service_charge, f.price_incl),
    ...extras,
    syncItemStations(c.env.DB, bid),
    audit(c.env.DB, bid, c.get('staff').id, 'menu.create', 'menu_items', id, null, f),
  ]);
  return c.json({ id }, 201);
});

settingsRoutes.put(`${B}/menu/:id`, requireAction('menu.edit'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const before = await one<Record<string, unknown> & { service_charge: number | null; price_incl: number | null }>(c.env.DB,
    'SELECT name, category, price_paise, sac, station, tax_mode, gst_bp, open_price, min_price_paise, active, service_charge, price_incl FROM menu_items WHERE id = ? AND business_id = ?', id, bid);
  if (!before) fail(404, 'Item not found.');
  const data = await body(c);
  const f = itemFields(data);
  // A screen that does not send the new choices keeps what the item had.
  if (data.serviceCharge === undefined) f.service_charge = before.service_charge;
  if (data.priceIncl === undefined) f.price_incl = before.price_incl;
  const extras = await itemExtras(c, bid, id, f);
  await c.env.DB.batch([
    stmt(c.env.DB, `UPDATE menu_items SET name = ?, category = ?, price_paise = ?, sac = ?, station = ?, tax_mode = ?, gst_bp = ?, open_price = ?, min_price_paise = ?, active = ?,
      kot = ?, station_id = ?, service_charge = ?, price_incl = ? WHERE id = ?`, f.name, f.category, f.price_paise, f.sac, f.station, f.tax_mode, f.gst_bp, f.open_price, f.min_price_paise,
      f.active, f.kot, f.station_id ?? null, f.service_charge, f.price_incl, id),
    ...extras,
    syncItemStations(c.env.DB, bid),
    audit(c.env.DB, bid, c.get('staff').id, 'menu.update', 'menu_items', id, before, f),
  ]);
  // A lower price (26 Nov 2026): how many open orders, not billed yet, still have it at the old price (offered to lower).
  const lower = !f.open_price && (f.price_paise as number) < (before.price_paise as number);
  const openHigher = lower ? (await one<{ n: number }>(c.env.DB, `SELECT count(DISTINCT l.order_id) AS n FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE o.business_id = ? AND o.status IN ('open', 'tab') AND l.item_id = ? AND l.qty > 0 AND l.options IS NULL AND l.price_paise > ?`, bid, id, f.price_paise))!.n : 0;
  return c.json({ ok: true, openHigher });
});

// Lowers an item's price on open orders not billed yet to today's menu price (26 Nov 2026): a lower price is in the guest's
// favour. A dish with add-ons, a typed price, or on a printed bill is left as it is.
settingsRoutes.post(`${B}/menu/:id/reprice-open`, requireAction('menu.edit'), async (c) => {
  const bid = c.get('businessId');
  const m = await one<{ id: string; name: string; price_paise: number; open_price: number }>(c.env.DB, 'SELECT id, name, price_paise, open_price FROM menu_items WHERE id = ? AND business_id = ?', c.req.param('id'), bid);
  if (!m) fail(404, 'Item not found.');
  if (m.open_price) fail(409, 'This item has its price typed at the counter.');
  const rows = await all<{ id: string; place: string; price_paise: number; qty: number }>(c.env.DB, `SELECT l.id, o.place, l.price_paise, l.qty FROM order_lines l JOIN orders o ON o.id = l.order_id
    WHERE o.business_id = ? AND o.status IN ('open', 'tab') AND l.item_id = ? AND l.qty > 0 AND l.options IS NULL AND l.price_paise > ?`, bid, m.id, m.price_paise);
  if (rows.length) await c.env.DB.batch([
    ...rows.map((r) => stmt(c.env.DB, 'UPDATE order_lines SET price_paise = ? WHERE id = ?', m.price_paise, r.id)),
    audit(c.env.DB, bid, c.get('staff').id, 'menu.reprice_open', 'menu_items', m.id, { lines: rows.map((r) => ({ place: r.place, pricePaise: r.price_paise, qty: r.qty })) }, { pricePaise: m.price_paise }),
  ]);
  return c.json({ ok: true, lines: rows.length, places: [...new Set(rows.map((r) => r.place))] });
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
  const before = await all<{ id: string; name: string; category: string; active: number; station_id: string | null; kot: number | null; tax_mode: string | null; gst_bp: number | null;
    service_charge: number | null; price_incl: number | null; used: number }>(db,
    `SELECT id, name, category, active, station_id, kot, tax_mode, gst_bp, service_charge, price_incl,
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
  } else if (action === 'serviceCharge' || action === 'priceIncl') {
    // Service charge or price-includes-GST for the ticked items (26 Nov 2026): 'category', 'yes' or 'no'.
    const v = followYesNo(data.value, action === 'serviceCharge' ? 'Service charge' : 'Price includes GST');
    s.push(stmt(db, `UPDATE menu_items SET ${action === 'serviceCharge' ? 'service_charge' : 'price_incl'} = ? WHERE ${IN}`, v, bid, json));
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
  const before = await one<{ name: string; tax_mode: string; gst_bp: number | null; kot: number; station_id: string | null; service_charge: number; price_incl: number }>(c.env.DB,
    'SELECT name, tax_mode, gst_bp, kot, station_id, service_charge, price_incl FROM menu_categories WHERE id = ? AND business_id = ?', id, bid);
  if (!before) fail(404, 'Category not found.');
  const data = await body(c);
  // Any of: its tax (taxMode, gstRate), whether its items make a KOT (kot: true / false), and its station.
  const f = data.taxMode !== undefined || data.tax !== undefined ? taxFields(data, false) : { tax_mode: before.tax_mode, gst_bp: before.gst_bp };
  if (data.kot !== undefined && typeof data.kot !== 'boolean') fail(400, 'KOT must be yes or no.');
  // Service charge and price includes GST (26 Nov 2026): yes or no for the category's items.
  for (const [k, what] of [['serviceCharge', 'Service charge'], ['priceIncl', 'Price includes GST']] as const) {
    if (data[k] !== undefined && typeof data[k] !== 'boolean') fail(400, `${what} must be yes or no.`);
  }
  const sc = data.serviceCharge === undefined ? before.service_charge : data.serviceCharge ? 1 : 0;
  const incl = data.priceIncl === undefined ? before.price_incl : data.priceIncl ? 1 : 0;
  const kot = data.kot === undefined ? before.kot : data.kot ? 1 : 0;
  let stationId = before.station_id;
  if (data.stationId !== undefined) {
    if (!(await stationList(c.env.DB, bid)).some((x) => x.id === data.stationId)) fail(400, 'That station was not found.');
    stationId = data.stationId as string;
  }
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE menu_categories SET tax_mode = ?, gst_bp = ?, kot = ?, station_id = ?, service_charge = ?, price_incl = ? WHERE id = ?', f.tax_mode, f.gst_bp, kot, stationId, sc, incl, id),
    syncItemStations(c.env.DB, bid),
    audit(c.env.DB, bid, c.get('staff').id, 'category.update', 'menu_categories', id, before, { ...f, kot, station_id: stationId, service_charge: sc, price_incl: incl }),
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
      s.group_stay_id AS groupStayId, (SELECT g.room FROM stays g WHERE g.id = s.group_stay_id) AS groupRoom,
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

/**
 * A past stay (25 Nov 2026): a guest missed at the desk who has already left is recorded in the room Djubo gave them, even
 * when today's guest is in it now. While its bill is settled the stay is kept under the room's name with this mark, so it
 * never takes the room from anyone; at check-out it gets the room's own name, and the room is not marked dirty.
 */
export const PAST_STAY = ' (past stay)';
/** A guest who left the room with the bill still open (27 Nov 2026): the room is free for the next guest; checked out later. */
export const LEFT_ROOM = ' (left room)';
export const realRoom = (room: string) => (room.endsWith(PAST_STAY) ? room.slice(0, -PAST_STAY.length) : room.endsWith(LEFT_ROOM) ? room.slice(0, -LEFT_ROOM.length) : room);

settingsRoutes.post(`${B}/stays`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const b = bizOf(c);
  const data = await body(c);
  const guest = text(data, 'guestName', 'Guest name', { max: 80 })!;
  let past = false;
  if (data.past === true) {
    const pb = typeof data.bookingId === 'string' && isUuid(data.bookingId)
      ? await one<{ check_out: string | null }>(c.env.DB, 'SELECT check_out FROM bookings WHERE id = ? AND business_id = ?', data.bookingId, bid) : null;
    if (!pb?.check_out || pb.check_out > clock(b).shiftDay) fail(409, 'Only a booking whose stay has ended can be recorded as a past stay.');
    past = true;
  }
  // Rooms and beds come from Settings, Rooms and tables (21 Nov 2026): once any are set up, a stay is in one of them,
  // under its exact name, so its tile, its orders and its folio match. A dorm is checked in by bed, or whole for a group.
  const layout = tableLayout(b);
  const stayable = (layout ?? []).filter((x) => x.kind === 'rooms' || x.kind === 'dorms');
  const checkRoom = async (typed: string) => {
    if (!stayable.length) return typed;
    const all_ = stayable.flatMap((x) => x.tables);
    const key = typed.toLowerCase().replace(/\broom\b/g, '').replace(/[^a-z0-9]/g, '');
    const name = all_.find((t) => t.toLowerCase() === typed.toLowerCase()) ?? all_.find((t) => t.toLowerCase().replace(/\broom\b/g, '').replace(/[^a-z0-9]/g, '') === key);
    if (!name) fail(400, `Choose a room or bed from the list (Settings, Rooms and tables)${typed ? `: ${typed} is not there` : ''}.`);
    const at = placeOf(layout, name);
    if (at?.dorm && !past) {
      const others = at.whole ? sectionTables({ kind: 'dorms', dorms: at.section.dorms!.filter((d) => d.name === at.dorm) }).filter((x) => x !== dormWhole(at.dorm!)) : [dormWhole(at.dorm)];
      const busy = await all<{ room: string }>(c.env.DB, `SELECT room FROM stays WHERE business_id = ? AND checked_out_at IS NULL AND lower(room) IN (SELECT lower(value) FROM json_each(?))`, bid, JSON.stringify(others));
      if (busy.length) fail(409, at.whole ? `${busy.map((x) => x.room).join(', ')} already ${busy.length === 1 ? 'has a guest' : 'have guests'}: the whole dorm cannot be booked.` : `${at.dorm} is booked whole for a group.`);
    }
    return name;
  };
  const room = await checkRoom(text(data, 'room', 'Room', { max: 40 })!);
  // One check-in for a booking of several rooms or beds (24 Nov 2026): the other rooms come in `rooms`; each becomes its
  // own stay in the group of the first, so it shows taken, while the rent, food and payments go on the first room's bill.
  const extraTyped = Array.isArray(data.rooms) ? (data.rooms as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 30) : [];
  const extra: string[] = [];
  for (const x of extraTyped) {
    const n = await checkRoom(x.trim().slice(0, 40));
    if (n.toLowerCase() !== room.toLowerCase() && !extra.some((e) => e.toLowerCase() === n.toLowerCase())) extra.push(n);
  }
  const wholeOf = (n: string) => placeOf(layout, n);
  for (const n of [room, ...extra]) {
    const at = wholeOf(n);
    if (at?.dorm && [room, ...extra].some((o) => o !== n && wholeOf(o)?.dorm === at.dorm && (at.whole || wholeOf(o)?.whole))) fail(409, `${at.dorm} cannot be taken whole and by bed in one check-in.`);
  }
  // Housekeeping (25 Nov 2026): a room still marked dirty is asked about first (not for a past stay: nobody moves in).
  const dirty = data.dirtyOk === true || past ? [] : await all<{ room: string }>(c.env.DB, "SELECT room FROM room_status WHERE business_id = ? AND status = 'dirty' AND room IN (SELECT value FROM json_each(?))",
    bid, JSON.stringify([room, ...extra]));
  if (dirty.length) {
    const names = dirty.map((x) => x.room).join(', ');
    return c.json({ error: `${names} ${dirty.length === 1 ? 'is' : 'are'} marked dirty (not cleaned since the last guest). Check in anyway?`, code: 'room_dirty' }, 409);
  }
  const phone = phoneKey(data.phone);
  const city = text(data, 'city', 'City', { optional: true, max: 60 });
  const id = newId();
  const t = now();
  // Check-in details for the registration card (25 Nov 2026): guests, each adult's ID (type and last 4 digits only),
  // address and travel, a foreign guest's passport and visa (Form C). A card number is given at every check-in.
  const ci = readCheckIn(data);
  const res = typeof data.reservationId === 'string' && isUuid(data.reservationId)
    ? await one<{ id: string; status: string; check_out: string; lines: string; check_in: string; booking_id: string | null; stay_id: string | null }>(c.env.DB,
      'SELECT id, status, check_out, lines, check_in, booking_id, stay_id FROM reservations WHERE id = ? AND business_id = ?', data.reservationId, bid) : null;
  if (typeof data.reservationId === 'string' && (!res || res.status === 'cancelled')) fail(404, 'Reservation not found, or cancelled.');
  const { fy } = clock(b, t);
  // A late check-in (25 Nov 2026): a booking from an earlier day, missed at the desk, is checked in with its own date, so its
  // nights, rent and register are right. Up to 2 days late any counter staff may; older (up to 7 days) needs a manager.
  let checkInDay = clock(b, t).shiftDay;
  let daysLate = 0;
  if (typeof data.bookingId === 'string' && isUuid(data.bookingId)) {
    const bk = await one<{ check_in: string | null }>(c.env.DB, 'SELECT check_in FROM bookings WHERE id = ? AND business_id = ?', data.bookingId, bid);
    if (bk?.check_in && bk.check_in < checkInDay) {
      daysLate = Math.round((Date.parse(checkInDay) - Date.parse(bk.check_in)) / 86_400_000);
      if (daysLate > 7) fail(409, 'This booking is more than 7 days old: it cannot be checked in late.');
      if (daysLate > 2 && !isManager(c)) await approverOf(c, data.approverId, data.approverPin);
      checkInDay = bk.check_in;
    }
  }
  // A booking that continues a guest already in house is their extension (26 Nov 2026): it joins their stay (Continue),
  // never a second stay and a second bill.
  if (typeof data.bookingId === 'string' && isUuid(data.bookingId) && !past) {
    const bk = await one<{ id: string; phone: string | null; guest_name: string | null; check_in: string | null }>(c.env.DB, 'SELECT id, phone, guest_name, check_in FROM bookings WHERE id = ? AND business_id = ?', data.bookingId, bid);
    const cont = bk ? (await continuesOf(c.env.DB, bid, [{ id: bk.id, phone: bk.phone, guestName: bk.guest_name, checkIn: bk.check_in }])).get(bk.id) : undefined;
    if (cont?.length) fail(409, `${cont.map((x) => `${x.room} · ${x.guestName}`).join(', ')} is already in house: this booking is their extension. Press Continue on it instead of Check in.`);
  }
  // The guest is kept for next time, by phone: a returning guest's name and city are brought up to date.
  const known = phone ? await one<{ id: string }>(c.env.DB, 'SELECT id FROM guests WHERE business_id = ? AND phone = ?', bid, phone) : null;
  const guestId = phone ? known?.id ?? newId() : null;
  try {
    await c.env.DB.batch([
      ...(phone ? [known
        ? stmt(c.env.DB, 'UPDATE guests SET name = ?, city = coalesce(?, city), updated_at = ? WHERE id = ?', guest, city, t, guestId)
        : stmt(c.env.DB, 'INSERT INTO guests (id, business_id, name, phone, city, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', guestId, bid, guest, phone, city, t, t)] : []),
      stmt(c.env.DB, `INSERT INTO stays (id, business_id, room, guest_name, check_in, opened_by, created_at, guest_id, phone, adults, children, id_docs, address, coming_from,
          going_to, nationality, foreign_info, check_out_plan, reservation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, bid, past ? room + PAST_STAY : room, guest, checkInDay, c.get('staff').id, t, guestId, phone, ci.adults, ci.children, ci.idDocs, ci.address, ci.comingFrom, ci.goingTo,
        ci.nationality, ci.foreign, ci.checkOutPlan ?? res?.check_out ?? null, res?.id ?? null),
      stmt(c.env.DB, 'INSERT OR IGNORE INTO grc_series (business_id, fy, next_no) VALUES (?, ?, 1)', bid, fy),
      stmt(c.env.DB, `UPDATE stays SET grc_no = (SELECT 'GRC-' || substr(?, 3, 2) || substr(?, 6, 2) || '-' || printf('%04d', next_no) FROM grc_series WHERE business_id = ? AND fy = ?) WHERE id = ?`,
        fy, fy, bid, fy, id),
      stmt(c.env.DB, 'UPDATE grc_series SET next_no = next_no + 1 WHERE business_id = ? AND fy = ?', bid, fy),
      ...(res ? [stmt(c.env.DB, 'UPDATE reservations SET stay_id = coalesce(stay_id, ?) WHERE id = ?', id, res.id)] : []),
      stmt(c.env.DB, "INSERT INTO debtor_accounts (id, business_id, kind, name, stay_id, created_by, created_at) VALUES (?, ?, 'room', ?, ?, ?, ?)",
        newId(), bid, `${/^\d/.test(room) ? 'Room ' : ''}${room} · ${guest}`, id, c.get('staff').id, t),
      ...extra.flatMap((r0) => {
        const r = past ? r0 + PAST_STAY : r0;
        const m = newId();
        return [
          stmt(c.env.DB, `INSERT INTO stays (id, business_id, room, guest_name, check_in, opened_by, created_at, guest_id, phone, check_out_plan, group_stay_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, m, bid, r, guest, checkInDay, c.get('staff').id, t, guestId, phone, ci.checkOutPlan ?? res?.check_out ?? null, id),
          stmt(c.env.DB, "INSERT INTO debtor_accounts (id, business_id, kind, name, stay_id, created_by, created_at) VALUES (?, ?, 'room', ?, ?, ?, ?)",
            newId(), bid, `${/^\d/.test(r) ? 'Room ' : ''}${r} · ${guest} (with ${room})`, m, c.get('staff').id, t),
        ];
      }),
      // Booked for more rooms or beds than picked, the others sharing (26 Nov 2026): no "beds missing" flag for them.
      ...(Number.isInteger(data.sharingBeds) && (data.sharingBeds as number) > 0 ? [stmt(c.env.DB, 'UPDATE stays SET sharing_beds = ? WHERE id = ?', Math.min(30, data.sharingBeds as number), id)] : []),
      audit(c.env.DB, bid, c.get('staff').id, 'stay.open', 'stays', id, null, { room, guest, returning: !!known, ...(extra.length ? { withRooms: extra } : {}), ...(daysLate ? { lateDays: daysLate, checkIn: checkInDay } : {}), ...(past ? { past: true } : {}) }),
      // Checked in from a booking read from mail (23 Nov 2026): the booking is marked checked in, with its stay.
      ...(typeof data.bookingId === 'string' && isUuid(data.bookingId)
        ? [stmt(c.env.DB, `UPDATE bookings SET status = 'checked_in', stay_id = ?, updated_at = ? WHERE business_id = ? AND status IN ('approved', 'new')
            AND (id = ?4 OR id = (SELECT match_id FROM bookings WHERE id = ?4))`, id, t, bid, data.bookingId)] : []),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) {
      if (!extra.length) fail(409, `${/^\d/.test(room) ? 'Room ' : ''}${room} already has a guest. Check them out first.`);
      const taken = await all<{ room: string }>(c.env.DB, 'SELECT room FROM stays WHERE business_id = ? AND checked_out_at IS NULL AND lower(room) IN (SELECT lower(value) FROM json_each(?))',
        bid, JSON.stringify([room, ...extra]));
      fail(409, `${taken.map((x) => x.room).join(', ') || 'A room'} already ${taken.length === 1 ? 'has a guest' : 'have guests'}. Check them out first, or choose other rooms.`);
    }
    throw e;
  }
  // Food already ordered on the room's tile with nobody linked (opened before the guest came) becomes the guest's
  // (27 Nov 2026): its bill goes to their room bill. Not for a past stay.
  if (!past) {
    const mine = await all<{ id: string; room: string }>(c.env.DB, 'SELECT id, room FROM stays WHERE (id = ?1 OR group_stay_id = ?1) AND checked_out_at IS NULL', id);
    await c.env.DB.batch(mine.map((m) => stmt(c.env.DB, `UPDATE orders SET stay_id = ? WHERE business_id = ? AND kind = 'table' AND stay_id IS NULL
      AND status IN ('open', 'tab', 'billed') AND lower(place) = lower(?)`, m.id, bid, m.room)));
  }
  // From a booking: its room rent and what was paid before arrival go on the room's bill (24 Nov 2026).
  if (typeof data.bookingId === 'string') await syncStay(c.env.DB, bid, id);
  // From a reservation made here and not yet in Djubo: its rate for this room goes on the bill (replaced by Djubo's
  // rent when the booking's mail arrives), and its advance moves onto the bill.
  if (res) {
    if (!res.booking_id && typeof data.bookingId !== 'string') {
      const lines = JSON.parse(res.lines) as { type: string; ratePaise: number; roomNames?: string[] }[];
      const sec = (layout ?? []).find((x) => x.tables.includes(room));
      const line = lines.find((l) => l.roomNames?.includes(room)) ?? lines.find((l) => l.type === sec?.name) ?? lines[0];
      const n = Math.max(1, Math.round((Date.parse(res.check_out) - Date.parse(clock(b, t).shiftDay)) / 86_400_000));
      if (line) await stmt(c.env.DB, `INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, note, by_staff, at)
        SELECT ?, ?, d.id, 'room_rent', ?, ?, ?, ? FROM debtor_accounts d WHERE d.stay_id = ?`, newId(), bid, line.ratePaise * n,
        `Room rent · ${n} night${n === 1 ? '' : 's'} × ₹${(line.ratePaise / 100).toLocaleString('en-IN')} (reservation)`, c.get('staff').id, t, id).run();
    }
    await syncStay(c.env.DB, bid, id);
  }
  return c.json({ id, rooms: [room, ...extra], grcNo: (await one<{ g: string }>(c.env.DB, 'SELECT grc_no AS g FROM stays WHERE id = ?', id))?.g ?? null }, 201);
});

const ID_TYPES = ['Aadhaar', 'Driving licence', 'Passport', 'Voter ID', 'PAN', 'Other'];
/** Check-in details as typed; an ID's number is kept only as its last 4 digits. */
function readCheckIn(data: Record<string, unknown>) {
  const num = (k: string, label: string) => {
    const v = data[k];
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 99) fail(400, `${label} must be a whole number.`);
    return n;
  };
  const docs = Array.isArray(data.idDocs) ? (data.idDocs as Record<string, unknown>[]).slice(0, 20).map((d, i) => {
    const type = typeof d?.type === 'string' && ID_TYPES.includes(d.type) ? d.type : fail(400, `Guest ${i + 1}: choose the ID type.`);
    const digits = String(d.number ?? d.last4 ?? '').replace(/[^0-9A-Za-z]/g, '');
    if (digits.length < 4) fail(400, `Guest ${i + 1}: type at least the last 4 characters of the ID.`);
    return { type, last4: digits.slice(-4).toUpperCase(), name: typeof d.name === 'string' ? d.name.trim().slice(0, 80) : '' };
  }) : [];
  const f = data.foreign && typeof data.foreign === 'object' ? data.foreign as Record<string, unknown> : null;
  const foreign = f ? JSON.stringify({ passportLast4: String(f.passport ?? '').replace(/\W/g, '').slice(-4).toUpperCase() || null, visa: typeof f.visa === 'string' ? f.visa.slice(0, 40) : null,
    visaExpiry: typeof f.visaExpiry === 'string' ? f.visaExpiry.slice(0, 10) : null, arrivedOn: typeof f.arrivedOn === 'string' ? f.arrivedOn.slice(0, 10) : null, formC: f.formC === true }) : null;
  const plan = typeof data.checkOutPlan === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.checkOutPlan) ? data.checkOutPlan : null;
  return {
    adults: num('adults', 'Adults'), children: num('children', 'Children'), idDocs: docs.length ? JSON.stringify(docs) : null,
    address: text(data, 'address', 'Address', { optional: true, max: 200 }), comingFrom: text(data, 'comingFrom', 'Coming from', { optional: true, max: 60 }),
    goingTo: text(data, 'goingTo', 'Going to', { optional: true, max: 60 }), nationality: text(data, 'nationality', 'Nationality', { optional: true, max: 40 }),
    foreign, checkOutPlan: plan,
  };
}

// The guest registration card for a stay (printed at check-in, or again later).
settingsRoutes.get(`${B}/stays/:id/grc`, requireAction('stays.edit'), async (c) => {
  const s = await one<Record<string, unknown> & { id_docs: string | null; foreign_info: string | null }>(c.env.DB, `SELECT s.id, s.room, s.guest_name AS guestName, s.phone, s.created_at AS arrivedAt,
      s.check_in AS checkIn, coalesce(s.check_out_plan, (SELECT max(k.check_out) FROM bookings k WHERE k.stay_id = s.id)) AS checkOut, s.adults, s.children, s.id_docs, s.address,
      s.coming_from AS comingFrom, s.going_to AS goingTo, s.nationality, s.foreign_info, s.grc_no AS grcNo, g.city
    FROM stays s LEFT JOIN guests g ON g.id = s.guest_id WHERE s.id = ? AND s.business_id = ?`, isUuid(c.req.param('id')) ? c.req.param('id') : null, c.get('businessId'));
  if (!s) fail(404, 'Stay not found.');
  const bill = await stayBill(c, s.id as string);
  const { id_docs, foreign_info, ...rest } = s;
  return c.json({ grc: { ...rest, idDocs: id_docs ? JSON.parse(id_docs) : [], foreign: foreign_info ? JSON.parse(foreign_info) : null, business: bizOf(c).name,
    rentPaise: bill.rentPaise, prepaidPaise: bill.prepaidPaise, paidPaise: bill.paidPaise, mealPlan: (bill.booking as { mealPlan?: string } | null)?.mealPlan ?? null } });
});

// ---------- the room's bill (24 Nov 2026): rent from the booking, charges added by hand, food, payments, the invoice

/**
 * A stay with its folio account. A room or bed checked in with others (24 Nov 2026) is billed on the group's first room,
 * so it gives that stay, unless `own` (moving or checking out just that bed).
 */
export async function openStay(c: Context<AppEnv>, id: string, own = false) {
  if (!isUuid(id)) fail(404, 'Stay not found.');
  const s = await one<{ id: string; room: string; guest_name: string; phone: string | null; check_in: string; checked_out_at: number | null; account_id: string; group_stay_id: string | null }>(c.env.DB,
    `SELECT s.id, s.room, s.guest_name, s.phone, s.check_in, s.checked_out_at, d.id AS account_id, s.group_stay_id FROM stays s JOIN debtor_accounts d ON d.stay_id = s.id
     WHERE s.id = ? AND s.business_id = ?`, id, c.get('businessId'));
  if (!s) fail(404, 'Stay not found.');
  if (s.group_stay_id && !own) return openStay(c, s.group_stay_id, true);
  return s;
}

/** The other rooms or beds checked in with a stay (24 Nov 2026), in house first. */
export async function groupOf(db: Parameters<typeof all>[0], stayId: string) {
  return all<{ id: string; room: string; checkedOutAt: number | null }>(db,
    'SELECT id, room, checked_out_at AS checkedOutAt FROM stays WHERE group_stay_id = ? ORDER BY checked_out_at IS NOT NULL, room', stayId);
}

/** The stay's tax invoice as printed, or null before check-out. */
async function invoiceOut(c: Context<AppEnv>, stayId: string) {
  const r = await one<Record<string, unknown> & { lines: string; entity_id: string; id: string }>(c.env.DB, `SELECT i.id, i.invoice_no AS invoiceNo, i.at, i.guest_name AS guestName, i.phone, i.room,
      i.bill_to_name AS billToName, i.bill_to_gstin AS billToGstin, i.bill_to_address AS billToAddress,
      i.check_in AS checkIn, i.check_out AS checkOut, i.nights, i.lines, i.gst_rate_bp AS gstRateBp, i.taxable_paise AS taxablePaise, i.cgst_paise AS cgstPaise,
      i.sgst_paise AS sgstPaise, i.total_paise AS totalPaise, i.entity_id, e.name AS entityName, e.gstin, e.gst_registered AS gstRegistered
    FROM room_invoices i JOIN billing_entities e ON e.id = i.entity_id WHERE i.stay_id = ? AND i.business_id = ?`, stayId, c.get('businessId'));
  if (!r) return null;
  const { entity_id: _e, lines, ...rest } = r;
  // Room credit notes against it (25 Nov 2026).
  const creditNotes = await all(c.env.DB, `SELECT cn_no AS cnNo, reason, taxable_paise AS taxablePaise, cgst_paise AS cgstPaise, sgst_paise AS sgstPaise, total_paise AS totalPaise,
    refund_mode AS refundMode, at FROM room_credit_notes WHERE invoice_id = ? ORDER BY seq`, r.id);
  return { ...rest, lines: JSON.parse(lines) as { name: string; amountPaise: number }[], creditNotes };
}

/** What the room bill shows: the stay, its booking, every line on the folio, the balance, and the invoice once made. */
export async function stayBill(c: Context<AppEnv>, id: string) {
  const db = c.env.DB;
  const s = await openStay(c, id);
  const [lines, booking, invoice, group] = await Promise.all([
    folioLines(db, s.account_id),
    one(db, `SELECT id, ext_ref AS extRef, source, guest_name AS guestName, channel, room_type AS roomType, room_labels AS roomLabels, rooms, guests, check_in AS checkIn, check_out AS checkOut,
        amount_paise AS amountPaise, paid_paise AS paidPaise, booked_at AS bookedAt, changed_at AS changedAt, meal_plan AS mealPlan, requests, ota_ref AS otaRef, pnr,
        from_report AS fromReport, report_due_paise AS reportDuePaise
      FROM bookings WHERE stay_id = ? ORDER BY source = 'djubo' DESC, updated_at DESC LIMIT 1`, s.id),
    invoiceOut(c, s.id),
    groupOf(db, s.id),
  ]);
  const sum = (k: string[]) => lines.filter((l) => k.includes(l.kind)).reduce((t, l) => t + l.amountPaise, 0);
  const extra = await one<{ plan: string | null; foreign_info: string | null; form_c_at: number | null; company: string | null; gstin: string | null }>(db, `SELECT
      coalesce(s.check_out_plan, (SELECT max(k.check_out) FROM bookings k WHERE k.stay_id = s.id)) AS plan, s.foreign_info, s.form_c_at, r.company, r.gstin
    FROM stays s LEFT JOIN reservations r ON r.id = s.reservation_id WHERE s.id = ?`, s.id);
  return { stay: { id: s.id, room: s.room, guestName: s.guest_name, phone: s.phone, checkIn: s.check_in, checkedOutAt: s.checked_out_at, accountId: s.account_id,
      checkOutPlan: extra?.plan ?? null, foreign: !!extra?.foreign_info, formCAt: extra?.form_c_at ?? null, company: extra?.company ?? null, gstin: extra?.gstin ?? null, group },
    booking, lines, invoice, balancePaise: lines.reduce((t, l) => t + l.amountPaise, 0),
    // Money reception marked in Djubo for this stay, waiting for how it was paid (26 Nov 2026).
    djubo: (await djuboPays(db, c.get('businessId'), bizOf(c).shift_start_hour)).pays.filter((x) => x.stayId === s.id && !x.settlementId),
    rentPaise: sum(['room_rent']), prepaidPaise: -sum(['prepaid']), foodPaise: sum(['charge']), paidPaise: -sum(['receipt', 'advance', 'deposit', 'credit_note']) - sum(['refund']) };
}

settingsRoutes.get(`${B}/stays/:id/bill`, requireAction('stays.edit'), async (c) => c.json(await stayBill(c, c.req.param('id'))));

// The total rent of a booking filled in from Djubo's daily report (24 Nov 2026): the report has only what is still to
// collect, so reception types the total from Djubo once. What Djubo said was still to collect when the booking was first
// read stays to collect; the rest counts as paid before arrival.
settingsRoutes.post(`${B}/stays/:id/report-rent`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const s = await openStay(c, c.req.param('id'));
  if (s.checked_out_at) fail(409, 'This guest has checked out.');
  const data = await body(c);
  const total = paise(data, 'total', 'Total rent');
  if (total <= 0) fail(400, 'Total rent must be above zero.');
  const bk = await one<{ id: string; amount_paise: number | null; report_due_paise: number | null }>(c.env.DB,
    'SELECT id, amount_paise, report_due_paise FROM bookings WHERE stay_id = ? AND business_id = ? AND from_report = 1 ORDER BY updated_at DESC LIMIT 1', s.id, bid);
  if (!bk) fail(409, 'This stay is not from Djubo\'s daily report: add rent with Add charge.');
  if (bk.amount_paise !== null) fail(409, 'The total rent is already on this bill.');
  const due = Math.max(0, bk.report_due_paise ?? 0);
  if (due > total) fail(400, `Djubo said ${rupeesText(due)} was still to collect, more than this total. Check the total in Djubo.`);
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE bookings SET amount_paise = ?, paid_paise = ?, updated_at = ? WHERE id = ?', total, total - due, now(), bk.id),
    audit(c.env.DB, bid, c.get('staff').id, 'stay.report_rent', 'stays', s.id, null, { totalPaise: total, paidBeforePaise: total - due }),
  ]);
  await syncStay(c.env.DB, bid, s.id);
  return c.json(await stayBill(c, s.id), 201);
});

// A charge on the room by hand: rent when no booking mail came (a direct guest), an extra bed, a late check-out. Taking
// rent off (a discount at the desk, a mistake) needs a manager.
settingsRoutes.post(`${B}/stays/:id/charges`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const s = await openStay(c, c.req.param('id'));
  if (s.checked_out_at) fail(409, 'This guest has checked out.');
  const data = await body(c);
  const amount = paise(data, 'amount', 'Amount');
  if (amount <= 0) fail(400, 'Amount must be above zero.');
  const note = text(data, 'note', 'What the charge is for', { max: 80 })!;
  const lower = data.lower === true;
  // Room rent comes from Djubo (26 Nov 2026, owner's choice): staff add extras only; a manager may add rent by hand.
  if (!lower && /\b(rent|night|nights|extension|extend|tariff)\b/i.test(note) && !isManager(c)
    && await one(c.env.DB, 'SELECT 1 FROM bookings WHERE stay_id IN (SELECT id FROM stays WHERE id = ?1 OR group_stay_id = ?1) AND business_id = ?2', s.id, bid))
    fail(403, 'Room rent comes from Djubo: extend or change the booking in Djubo. Extras (extra bed, late check-out, laundry) can be added here; a manager can add rent by hand.');
  let noteOut = note;
  if (lower) {
    const rent = (await one<{ r: number }>(c.env.DB, "SELECT coalesce(sum(amount_paise), 0) AS r FROM debtor_entries WHERE account_id = ? AND kind = 'room_rent'", s.account_id))!.r;
    if (amount > rent) fail(409, `Only ${rupeesText(rent)} of room rent is on this bill.`);
    const approver = await approval(c, data, 'Taking rent off a room bill');
    if (!isManager(c)) noteOut = `${note} · Approved by ${approver.name}`.slice(0, 120);
  }
  const t = now();
  await c.env.DB.batch([
    stmt(c.env.DB, "INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, note, by_staff, at) VALUES (?, ?, ?, 'room_rent', ?, ?, ?, ?)",
      newId(), bid, s.account_id, lower ? -amount : amount, noteOut, c.get('staff').id, t),
    audit(c.env.DB, bid, c.get('staff').id, lower ? 'stay.rent_off' : 'stay.charge', 'stays', s.id, null, { amountPaise: lower ? -amount : amount, note: noteOut }),
  ]);
  return c.json(await stayBill(c, s.id), 201);
});
const rupeesText = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Check-out: the folio must be settled first (a receipt against its account), so nothing owed is forgotten.
settingsRoutes.post(`${B}/stays/:id/check-out`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const db = c.env.DB;
  const row = await one<{ balance: number; account_id: string; room: string; guest_name: string; phone: string | null; check_in: string; group_stay_id: string | null }>(db,
    `SELECT coalesce((SELECT sum(amount_paise) FROM debtor_entries e WHERE e.account_id = d.id), 0) AS balance, d.id AS account_id, s.room, s.guest_name, s.phone, s.check_in, s.group_stay_id
    FROM stays s JOIN debtor_accounts d ON d.stay_id = s.id WHERE s.id = ? AND s.business_id = ? AND s.checked_out_at IS NULL`, id, bid);
  if (!row) fail(404, 'Open stay not found.');
  // A group (24 Nov 2026): one bed may leave early (its bill is the first room's); the first room checks out the rest with it.
  const members = row.group_stay_id ? [] : await all<{ id: string; room: string; balance: number }>(db,
    `SELECT s.id, s.room, coalesce((SELECT sum(e.amount_paise) FROM debtor_entries e JOIN debtor_accounts d ON d.id = e.account_id WHERE d.stay_id = s.id), 0) AS balance
     FROM stays s WHERE s.group_stay_id = ? AND s.checked_out_at IS NULL ORDER BY s.room`, id);
  // Food still open on the guest (27 Nov 2026): an order open, on a tab, or printed and not paid, on this room or bed (the
  // first room: on every one of the group's). It would stay tied to a guest who left, block that bed's tile for the next
  // guest, and could no longer go on a room bill. Close it first: on the room bill, or paid.
  const leaving = [id, ...members.map((m) => m.id)];
  const food = await all<{ id: string; place: string; status: string; amountPaise: number }>(db, `SELECT o.id, o.place, o.status,
      coalesce((SELECT b.total_paise FROM bills b WHERE b.order_id = o.id AND b.status = 'printed'), (SELECT coalesce(sum(l.price_paise * l.qty), 0) FROM order_lines l WHERE l.order_id = o.id)) AS amountPaise
    FROM orders o WHERE o.business_id = ? AND o.status IN ('open', 'tab', 'billed') AND o.stay_id IN (${leaving.map(() => '?').join(', ')}) ORDER BY o.place`, bid, ...leaving);
  if (food.length) {
    const what = (f: { place: string; status: string; amountPaise: number }) => `${f.place}: ${rupeesText(f.amountPaise)} ${f.status === 'billed' ? 'printed, not paid' : f.status === 'tab' ? 'on a tab' : 'open'}`;
    return c.json({ error: `Food is still open: ${food.map(what).join(' · ')}. Put it on the room bill or take payment first.`, code: 'open_food', orders: food }, 409);
  }
  const owing = [...(row.group_stay_id ? [{ room: row.room, balance: row.balance }] : []), ...members].filter((m) => m.balance !== 0);
  if (owing.length) fail(409, `${owing.map((m) => m.room).join(', ')} still ${owing.length === 1 ? 'has' : 'have'} money on ${owing.length === 1 ? 'its' : 'their'} own bill: move it to the first room's bill first (Move to another room).`);
  // A past stay's room (25 Nov 2026) takes its own name at check-out, and is not marked dirty: nobody left it today.
  // A guest who left the room earlier: it was marked dirty then, and someone else may be in it now.
  const dirtyStmt = (room: string, at: number) => (room.endsWith(PAST_STAY) || room.endsWith(LEFT_ROOM) ? [] : [stmt(db, `INSERT INTO room_status (business_id, room, status, by_staff, at) VALUES (?, ?, 'dirty', ?, ?)
    ON CONFLICT (business_id, room) DO UPDATE SET status = 'dirty', note = NULL, by_staff = excluded.by_staff, at = excluded.at`, bid, room, c.get('staff').id, at)]);
  if (row.group_stay_id) {
    const t0 = now();
    await db.batch([
      stmt(db, 'UPDATE stays SET checked_out_at = ?, room = ? WHERE id = ?', t0, realRoom(row.room), id),
      ...dirtyStmt(row.room, t0),
      audit(db, bid, c.get('staff').id, 'stay.check_out', 'stays', id, null, { group: row.group_stay_id }),
    ]);
    return c.json({ ok: true, bill: await stayBill(c, id) });
  }
  const allRooms = [row.room, ...(await all<{ room: string }>(db, 'SELECT room FROM stays WHERE group_stay_id = ? ORDER BY room', id)).map((x) => x.room)].map(realRoom).join(', ');
  // A stay that began before the POS (25 Nov 2026, the owner's choice): its booking came from Djubo's daily report, with no
  // total rent. Unless the total is typed, it checks out without a POS invoice (Djubo or the OTA has the stay's invoice);
  // what Djubo said was still to collect must still be paid first. The Daily check lists every check-out without one.
  const rentUnknown = !!(await one(db, 'SELECT 1 FROM bookings WHERE stay_id = ? AND from_report = 1 AND amount_paise IS NULL', id));
  if (row.balance > 0) fail(409, `${rupeesText(row.balance)} is still to pay on this room. Take the guest's payment first.`);
  if (row.balance < 0) fail(409, `${rupeesText(-row.balance)} of the guest's deposit or advance is left. Refund it first.`);
  // No room rent on the bill at all (a walk-in whose rent was never added, or a free room): a manager approves, so a
  // cashier cannot check out a stay that brought in nothing on their own (25 Nov 2026).
  const rentOnBill = (await one<{ s: number }>(db, "SELECT coalesce(sum(amount_paise), 0) AS s FROM debtor_entries WHERE account_id = ? AND kind = 'room_rent'", row.account_id))!.s;
  let freeApprovedBy: string | null = null;
  if (!row.group_stay_id && !rentUnknown && rentOnBill <= 0) {
    const data0 = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
    freeApprovedBy = isManager(c) ? c.get('staff').name : (await approverOf(c, data0.approverId, data0.approverPin)).name;
  }
  // Who the invoice is made out to (25 Nov 2026): a company that pays or claims GST, typed at check-out or from the reservation.
  let data: Record<string, unknown> = {};
  try { data = await c.req.json(); } catch { /* no body */ }
  const res = await one<{ company: string | null; gstin: string | null }>(db, 'SELECT r.company, r.gstin FROM stays s JOIN reservations r ON r.id = s.reservation_id WHERE s.id = ?', id);
  const billTo = (data.billTo && typeof data.billTo === 'object' ? data.billTo : {}) as Record<string, unknown>;
  const toName = (typeof billTo.name === 'string' && billTo.name.trim() ? billTo.name.trim().slice(0, 120) : res?.company) ?? null;
  const toGstin = ((typeof billTo.gstin === 'string' && billTo.gstin.trim() ? billTo.gstin.trim() : res?.gstin) ?? '').toUpperCase() || null;
  if (toGstin && !/^\d{2}[A-Z0-9]{13}$/.test(toGstin)) fail(400, 'GSTIN has 15 characters, starting with 2 digits.');
  const toAddress = typeof billTo.address === 'string' && billTo.address.trim() ? billTo.address.trim().slice(0, 200) : null;
  // The stay's tax invoice for its room rent (24 Nov 2026): made once, here, in its own series per billing name and year.
  const rent = await all<{ amount_paise: number; note: string | null; booking_id: string | null }>(db,
    "SELECT amount_paise, note, booking_id FROM debtor_entries WHERE account_id = ? AND kind = 'room_rent' ORDER BY at, id", row.account_id);
  const total = rent.reduce((t, r) => t + r.amount_paise, 0);
  const b = bizOf(c);
  const { t, shiftDay, fy } = clock(b);
  const batch = [];
  if (total > 0) {
    // The stay's bookings (25 Nov 2026: an extension made in Djubo as a new booking is a second one): the invoice runs from
    // the first check-in to the last check-out, with a line per booking.
    const units = (await bookingUnits(db, id)).filter((u) => u.bk.status !== 'cancelled');
    const ins = units.map((u) => u.bk.check_in).filter((x): x is string => !!x).sort();
    const outs = units.map((u) => u.bk.check_out).filter((x): x is string => !!x).sort();
    const bk = units.length ? { check_in: ins[0] ?? null, check_out: outs[outs.length - 1] ?? null, rooms: Math.max(...units.map((u) => u.bk.rooms ?? 1)) } : null;
    const plan = (await one<{ p: string | null }>(db, 'SELECT check_out_plan AS p FROM stays WHERE id = ?', id))?.p ?? null;
    // Leaving on the day of arrival (a day use, or a check-out after midnight within the shift): the planned date, else the next day.
    const checkOut = shiftDay > row.check_in ? shiftDay : bk?.check_out ?? (plan && plan > row.check_in ? plan : new Date(Date.parse(row.check_in) + 86_400_000).toISOString().slice(0, 10));
    const nights = bk?.check_in && bk.check_out ? nightsBetween(bk.check_in, bk.check_out) : nightsBetween(row.check_in, checkOut);
    const ent = await one<{ id: string; gst_registered: number; series_prefix: string }>(db,
      'SELECT id, gst_registered, series_prefix FROM billing_entities WHERE business_id = ? AND active = 1 ORDER BY is_default DESC, created_at LIMIT 1', bid);
    if (!ent) fail(409, 'Add a billing name in Settings first: the room invoice is made in it.');
    const tax = roomTax(total, Math.round(total / nights / Math.max(1, bk?.rooms ?? 1)), ent.gst_registered === 1);
    const fromBooking = rent.filter((r) => r.booking_id).reduce((s0, r) => s0 + r.amount_paise, 0);
    const perBooking = units.length > 1 ? [...units].sort((x, y) => String(x.bk.check_in).localeCompare(String(y.bk.check_in))).map((u) => {
      const n = u.bk.check_in && u.bk.check_out ? nightsBetween(u.bk.check_in, u.bk.check_out) : 1;
      return { name: `Room ${allRooms} · ${n} night${n === 1 ? '' : 's'} (Djubo ${u.bk.ext_ref})`, amountPaise: rent.filter((r) => r.booking_id && u.ids.includes(r.booking_id)).reduce((s0, r) => s0 + r.amount_paise, 0) };
    }).filter((l) => l.amountPaise) : null;
    const lines = [
      ...(perBooking ?? (fromBooking ? [{ name: `Room ${allRooms} · ${nights} night${nights === 1 ? '' : 's'}`, amountPaise: fromBooking }] : [])),
      ...rent.filter((r) => !r.booking_id).map((r) => ({ name: r.note ?? 'Room charge', amountPaise: r.amount_paise })),
    ];
    batch.push(
      stmt(db, 'INSERT OR IGNORE INTO room_invoice_series (entity_id, fy, next_no) VALUES (?, ?, 1)', ent.id, fy),
      stmt(db, `INSERT INTO room_invoices (id, business_id, stay_id, entity_id, fy, seq, invoice_no, shift_day, guest_name, phone, room, check_in, check_out, nights, lines,
          gst_rate_bp, taxable_paise, cgst_paise, sgst_paise, total_paise, by_staff, at, bill_to_name, bill_to_gstin, bill_to_address)
        SELECT ?, ?, ?, ?, ?, next_no, ? || 'R' || substr(?, 3, 2) || substr(?, 6, 2) || '-' || printf('%04d', next_no), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM room_invoice_series WHERE entity_id = ? AND fy = ?`,
        newId(), bid, id, ent.id, fy, ent.series_prefix, fy, fy, shiftDay, row.guest_name, row.phone, allRooms.slice(0, 200), bk?.check_in ?? row.check_in, bk?.check_out ?? checkOut, nights,
        JSON.stringify(lines), tax.bp, tax.taxablePaise, tax.cgstPaise, tax.sgstPaise, total, c.get('staff').id, t, toName, toGstin, toAddress, ent.id, fy),
      stmt(db, 'UPDATE room_invoice_series SET next_no = next_no + 1 WHERE entity_id = ? AND fy = ?', ent.id, fy),
    );
  }
  await db.batch([
    ...batch,
    stmt(db, 'UPDATE stays SET checked_out_at = ?, room = ? WHERE id = ?', t, realRoom(row.room), id),
    ...members.map((m) => stmt(db, 'UPDATE stays SET checked_out_at = ?, room = ? WHERE id = ? AND checked_out_at IS NULL', t, realRoom(m.room), m.id)),
    // Housekeeping (25 Nov 2026): the room is dirty until cleaned (each of a group's rooms and beds; not a past stay's).
    ...[row.room, ...members.map((m) => m.room)].flatMap((r) => dirtyStmt(r, t)),
    audit(db, bid, c.get('staff').id, 'stay.check_out', 'stays', id, null, total > 0 ? null : { noInvoice: rentUnknown ? 'rent not known (Djubo daily report)' : 'no room rent on the bill', ...(freeApprovedBy ? { approvedBy: freeApprovedBy } : {}) }),
  ]);
  return c.json({ ok: true, bill: await stayBill(c, id) });
});

settingsRoutes.get(`${B}/credit-accounts`, requireAction('pos.view'), async (c) => {
  const accounts = await all<{ id: string; balancePaise: number }>(c.env.DB, `SELECT d.id, d.name, d.phone, d.credit_limit_paise AS creditLimitPaise,
      coalesce((SELECT sum(amount_paise) FROM debtor_entries e WHERE e.account_id = d.id), 0) AS balancePaise
    FROM debtor_accounts d WHERE d.business_id = ? AND d.kind = 'credit' ORDER BY d.name`, c.get('businessId'));
  // How old the oldest unpaid bill is (25 Nov 2026): what is owed is taken to be the newest charges.
  const charges = await all<{ account_id: string; amount_paise: number; at: number }>(c.env.DB, `SELECT e.account_id, e.amount_paise, e.at FROM debtor_entries e
    JOIN debtor_accounts d ON d.id = e.account_id WHERE d.business_id = ? AND d.kind = 'credit' AND e.amount_paise > 0 AND e.kind IN ('charge', 'advance_used', 'transfer') ORDER BY e.at DESC`, c.get('businessId'));
  const t = now();
  return c.json({ accounts: accounts.map((a) => {
    let left = a.balancePaise;
    let oldest: number | null = null;
    for (const ch of charges.filter((x) => x.account_id === a.id)) { if (left <= 0) break; left -= ch.amount_paise; oldest = ch.at; }
    return { ...a, oldestDays: oldest === null ? null : Math.floor((t - oldest) / 86_400_000) };
  }) });
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

// ---------- a booking's rooms or beds missing in the POS (26 Nov 2026)
// The POS is the record of who is in which bed (reception places guests as rooms are free; Djubo's beds are a suggestion).
// A group with fewer beds here than its booking is flagged on Today; reception adds the beds where the guests are, or marks
// that they share.

/** Open groups whose booking has more rooms or beds than they have here (beds, plus those marked sharing). */
export async function missingBeds(db: DB, bid: string) {
  const rows = await all<{ id: string; room: string; guest_name: string; booked: number; have: number; sharing: number; labels: string | null; ext_ref: string }>(db, `
    SELECT s.id, s.room, s.guest_name, s.sharing_beds AS sharing,
      -- Djubo splits an OTA booking per room or bed (27 Nov 2026): when the stay has a Djubo booking, count its rooms, not the OTA's.
      (SELECT max(coalesce(k.rooms, 1)) FROM bookings k WHERE k.stay_id = s.id AND k.status = 'checked_in'
        AND (k.source = 'djubo' OR NOT EXISTS (SELECT 1 FROM bookings d WHERE d.stay_id = s.id AND d.status = 'checked_in' AND d.source = 'djubo'))) AS booked,
      1 + (SELECT count(*) FROM stays m WHERE m.group_stay_id = s.id AND m.checked_out_at IS NULL) AS have,
      (SELECT k.room_labels FROM bookings k WHERE k.stay_id = s.id AND k.source = 'djubo' ORDER BY k.updated_at DESC LIMIT 1) AS labels,
      (SELECT k.ext_ref FROM bookings k WHERE k.stay_id = s.id ORDER BY k.source = 'djubo' DESC, k.updated_at DESC LIMIT 1) AS ext_ref
    FROM stays s WHERE s.business_id = ? AND s.checked_out_at IS NULL AND s.group_stay_id IS NULL`, bid);
  return rows.filter((r) => (r.booked ?? 1) > r.have + r.sharing).map((r) => ({ stayId: r.id, room: r.room, guestName: r.guest_name, extRef: r.ext_ref,
    booked: r.booked, have: r.have, sharing: r.sharing, missing: r.booked - r.have - r.sharing, djuboBeds: r.labels }));
}

// Adds rooms or beds to a guest's group (where the guests really are): each its own stay, shown as theirs; one bill on the first.
settingsRoutes.post(`${B}/stays/:id/add-beds`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const head = await one<{ id: string; room: string; guest_name: string; check_in: string; guest_id: string | null; phone: string | null; check_out_plan: string | null }>(db,
    `SELECT id, room, guest_name, check_in, guest_id, phone, check_out_plan FROM stays WHERE id = ? AND business_id = ? AND checked_out_at IS NULL AND group_stay_id IS NULL`, c.req.param('id'), bid);
  if (!head) fail(404, 'Open stay not found (a group is changed from its first room).');
  const data = await body(c);
  const layout = tableLayout(bizOf(c));
  const all_ = (layout ?? []).filter((x) => x.kind === 'rooms' || x.kind === 'dorms').flatMap((x) => x.tables).filter((t) => !/· whole$/.test(t));
  const asked = Array.isArray(data.rooms) ? (data.rooms as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 30) : [];
  const rooms = [...new Set(asked.map((x) => all_.find((t) => t.toLowerCase() === x.trim().toLowerCase())).filter((x): x is string => !!x))];
  if (!rooms.length || rooms.length !== asked.length) fail(400, 'Choose rooms or beds from the list.');
  const t = now();
  const staff = c.get('staff');
  try {
    await db.batch([
      ...rooms.flatMap((r) => { const m = newId(); return [
        stmt(db, `INSERT INTO stays (id, business_id, room, guest_name, check_in, opened_by, created_at, guest_id, phone, check_out_plan, group_stay_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          m, bid, r, head.guest_name, head.check_in, staff.id, t, head.guest_id, head.phone, head.check_out_plan, head.id),
        stmt(db, "INSERT INTO debtor_accounts (id, business_id, kind, name, stay_id, created_by, created_at) VALUES (?, ?, 'room', ?, ?, ?, ?)",
          newId(), bid, `${/^\d/.test(r) ? 'Room ' : ''}${r} · ${head.guest_name} (with ${head.room})`, m, staff.id, t),
      ]; }),
      audit(db, bid, staff.id, 'stay.add_beds', 'stays', head.id, null, { rooms }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) {
      const taken = await all<{ room: string; guest_name: string }>(db, 'SELECT room, guest_name FROM stays WHERE business_id = ? AND checked_out_at IS NULL AND lower(room) IN (SELECT lower(value) FROM json_each(?))', bid, JSON.stringify(rooms));
      fail(409, `${taken.map((x) => `${x.room} (${x.guest_name})`).join(', ') || 'A bed'} already has a guest.`);
    }
    throw e;
  }
  return c.json({ ok: true, rooms }, 201);
});

// The rest of the booking's beds are not needed: the guests share (clears the flag).
settingsRoutes.post(`${B}/stays/:id/sharing`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const data = await body(c);
  const n = Number.isInteger(data.beds) && (data.beds as number) > 0 && (data.beds as number) <= 30 ? data.beds as number : fail(400, 'How many beds are shared?');
  const s = await one<{ id: string }>(c.env.DB, 'SELECT id FROM stays WHERE id = ? AND business_id = ? AND checked_out_at IS NULL AND group_stay_id IS NULL', c.req.param('id'), bid);
  if (!s) fail(404, 'Open stay not found.');
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE stays SET sharing_beds = sharing_beds + ? WHERE id = ?', n, s.id),
    audit(c.env.DB, bid, c.get('staff').id, 'stay.sharing_beds', 'stays', s.id, null, { beds: n }),
  ]);
  return c.json({ ok: true });
});
