// Settings a business chooses (nothing hotel-specific is fixed in code): business rules, staff and PINs, billing names
// with their GST and limits, UPI accounts, the menu, reason lists, in-house stays and credit accounts.
import { Hono, type Context } from 'hono';
import { all, isUniqueViolation, newId, now, one, stmt } from '../../../src/db';
import { hashPassword } from '../../../src/crypto';
import { body, fail, isEmail, optionalPaise, paise, text } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { isRole } from '../permissions';
import { audit, clock, bizOf, loadBusiness, tableList } from '../util';
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
  };
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE businesses SET name = ?, fy_start_month = ?, shift_start_hour = ?, tab_age_days = ? WHERE id = ?',
      after.name, after.fy_start_month, after.shift_start_hour, after.tab_age_days, id),
    audit(c.env.DB, id, c.get('staff').id, 'business.update', 'businesses', id, before, after),
  ]);
  return c.json({ ok: true });
});

// ---------- tables: the counter's grid, in the order given

settingsRoutes.get(`${B}/tables`, requireAction('menu.edit'), async (c) => {
  return c.json({ tables: tableList(bizOf(c)) ?? [] });
});

settingsRoutes.put(`${B}/tables`, requireAction('menu.edit'), async (c) => {
  const id = c.get('businessId');
  const data = await body(c);
  if (!Array.isArray(data.tables) || data.tables.length > 150) fail(400, 'Tables must be a list of up to 150 names.');
  const names: string[] = [];
  for (const raw of data.tables) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name || name.length > 20) fail(400, 'Each table name must be 1 to 20 characters.');
    if (names.some((n) => n.toLowerCase() === name.toLowerCase())) fail(400, `${name} is in the list twice.`);
    names.push(name);
  }
  const before = tableList(bizOf(c));
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE businesses SET tables = ? WHERE id = ?', names.length ? JSON.stringify(names) : null, id),
    audit(c.env.DB, id, c.get('staff').id, 'tables.update', 'businesses', id, { tables: before }, { tables: names.length ? names : null }),
  ]);
  return c.json({ tables: names });
});

// ---------- staff

settingsRoutes.get(`${B}/staff`, requireAction('staff.manage'), async (c) => {
  return c.json({ staff: await all(c.env.DB, `SELECT id, name, role, email, pin_hash IS NOT NULL AS hasPin, active
    FROM staff WHERE business_id = ? ORDER BY active DESC, name`, c.get('businessId')) });
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

settingsRoutes.post(`${B}/staff`, requireAction('staff.manage'), async (c) => {
  const f = await staffFields(await body(c), true);
  if (!f.pin && f.role !== 'owner' && f.role !== 'manager') fail(400, 'Counter staff need a PIN.');
  const id = newId();
  try {
    await c.env.DB.batch([
      stmt(c.env.DB, 'INSERT INTO staff (id, business_id, name, role, email, password_hash, pin_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
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
  const before = await one<{ name: string; role: string; email: string | null; active: number; password_hash: string | null }>(c.env.DB,
    'SELECT name, role, email, active, password_hash FROM staff WHERE id = ? AND business_id = ?', id, bid);
  if (!before) fail(404, 'Person not found.');
  const data = await body(c);
  const f = await staffFields(data, false);
  if ((f.role === 'owner' || f.role === 'manager') && !(f.email && (f.password || before.password_hash))) fail(400, 'An Owner or manager needs an email and a password.');
  const active = data.active === false ? 0 : 1;
  if (before.role === 'owner' && (f.role !== 'owner' || !active)) {
    const owners = await one<{ n: number }>(c.env.DB, "SELECT count(*) AS n FROM staff WHERE business_id = ? AND role = 'owner' AND active = 1", bid);
    if ((owners?.n ?? 0) <= 1) fail(409, 'A business always keeps one active Owner.');
  }
  const sets = ['name = ?', 'role = ?', 'email = ?', 'active = ?'];
  const vals: unknown[] = [f.name, f.role, f.email, active];
  if (f.password) { sets.push('password_hash = ?'); vals.push(await hashPassword(f.password)); }
  if (f.pin) { sets.push('pin_hash = ?'); vals.push(await hashPassword(f.pin)); }
  await c.env.DB.batch([
    stmt(c.env.DB, `UPDATE staff SET ${sets.join(', ')} WHERE id = ? AND business_id = ?`, ...vals, id, bid),
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
  const [items, links, categories, groups, options] = await Promise.all([
    all(c.env.DB, `SELECT id, name, category, price_paise AS pricePaise, sac, station, active, tax_mode AS taxMode, gst_bp AS gstBp,
      open_price AS openPrice, min_price_paise AS minPricePaise FROM menu_items WHERE business_id = ? ORDER BY category, name`, bid),
    all<{ item_id: string; group_id: string }>(c.env.DB, 'SELECT item_id, group_id FROM menu_item_addons WHERE business_id = ? ORDER BY sort', bid),
    all(c.env.DB, 'SELECT id, name, tax_mode AS taxMode, gst_bp AS gstBp FROM menu_categories WHERE business_id = ? ORDER BY sort, name', bid),
    all<{ id: string; name: string; kind: string }>(c.env.DB, 'SELECT id, name, kind FROM addon_groups WHERE business_id = ? ORDER BY name', bid),
    all<{ id: string; group_id: string; name: string; add_paise: number }>(c.env.DB,
      'SELECT id, group_id, name, add_paise FROM addon_options WHERE business_id = ? AND active = 1 ORDER BY sort, name', bid),
  ]);
  return c.json({
    items: items.map((i) => ({ ...i, openPrice: !!i.openPrice, addonGroups: links.filter((l) => l.item_id === i.id).map((l) => l.group_id) })),
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
  const station = data.station ?? 'kitchen';
  if (station !== 'kitchen' && station !== 'bar') fail(400, 'Station must be kitchen or bar.');
  const sac = text(data, 'sac', 'SAC', { optional: true, max: 8 }) ?? '996332';
  if (!/^\d{4,8}$/.test(sac)) fail(400, 'SAC must be 4 to 8 digits.');
  const open = data.openPrice === true;
  const price = open ? (optionalPaise(data, 'price', 'Price') ?? 0) : paise(data, 'price', 'Price');
  if (price < 0) fail(400, 'Price cannot be negative.');
  const groups = data.addonGroups ?? [];
  if (!Array.isArray(groups) || groups.some((g) => typeof g !== 'string') || groups.length > 10) fail(400, 'Add-ons must be a list of add-on groups.');
  return { name: text(data, 'name', 'Item name', { max: 80 })!, category: text(data, 'category', 'Category', { optional: true, max: 40 }) ?? 'Other', price_paise: price, sac, station,
    ...taxFields(data, true), open_price: open ? 1 : 0, min_price_paise: open ? optionalPaise(data, 'minPrice', 'Lowest price') : null,
    addon_groups: [...new Set(groups as string[])], active: data.active === false ? 0 : 1 };
}

/** Statements that set a dish's add-on groups (each must be the business's own) and make sure its category exists. */
async function itemExtras(c: { env: { DB: D1Database } }, bid: string, id: string, f: ReturnType<typeof itemFields>) {
  if (f.addon_groups.length) {
    const known = await all<{ id: string }>(c.env.DB, `SELECT id FROM addon_groups WHERE business_id = ? AND id IN (${f.addon_groups.map(() => '?').join(',')})`, bid, ...f.addon_groups);
    if (known.length !== f.addon_groups.length) fail(400, 'An add-on group was not found.');
  }
  return [
    stmt(c.env.DB, 'DELETE FROM menu_item_addons WHERE item_id = ?', id),
    ...f.addon_groups.map((g, i) => stmt(c.env.DB, 'INSERT INTO menu_item_addons (item_id, group_id, business_id, sort) VALUES (?, ?, ?, ?)', id, g, bid, i)),
    stmt(c.env.DB, 'INSERT OR IGNORE INTO menu_categories (id, business_id, name, created_at) VALUES (?, ?, ?, ?)', newId(), bid, f.category, now()),
  ];
}

settingsRoutes.post(`${B}/menu`, requireAction('menu.edit'), async (c) => {
  const bid = c.get('businessId');
  const f = itemFields(await body(c));
  const id = newId();
  const extras = await itemExtras(c, bid, id, f);
  await c.env.DB.batch([
    stmt(c.env.DB, `INSERT INTO menu_items (id, business_id, name, category, price_paise, sac, station, tax_mode, gst_bp, open_price, min_price_paise, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, bid, f.name, f.category, f.price_paise, f.sac, f.station, f.tax_mode, f.gst_bp, f.open_price, f.min_price_paise, f.active, now()),
    ...extras,
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
    stmt(c.env.DB, `UPDATE menu_items SET name = ?, category = ?, price_paise = ?, sac = ?, station = ?, tax_mode = ?, gst_bp = ?, open_price = ?, min_price_paise = ?, active = ?
      WHERE id = ?`, f.name, f.category, f.price_paise, f.sac, f.station, f.tax_mode, f.gst_bp, f.open_price, f.min_price_paise, f.active, id),
    ...extras,
    audit(c.env.DB, bid, c.get('staff').id, 'menu.update', 'menu_items', id, before, f),
  ]);
  return c.json({ ok: true });
});

// A category's tax, which its items take unless they say otherwise.
settingsRoutes.put(`${B}/menu-categories/:id`, requireAction('menu.edit'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const before = await one(c.env.DB, 'SELECT name, tax_mode, gst_bp FROM menu_categories WHERE id = ? AND business_id = ?', id, bid);
  if (!before) fail(404, 'Category not found.');
  const f = taxFields(await body(c), false);
  await c.env.DB.batch([
    stmt(c.env.DB, 'UPDATE menu_categories SET tax_mode = ?, gst_bp = ? WHERE id = ?', f.tax_mode, f.gst_bp, id),
    audit(c.env.DB, bid, c.get('staff').id, 'category.tax', 'menu_categories', id, before, f),
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
  return c.json({ stays: await all(c.env.DB, `SELECT s.id, s.room, s.guest_name AS guestName, s.check_in AS checkIn, d.id AS accountId,
      coalesce((SELECT sum(amount_paise) FROM debtor_entries e WHERE e.account_id = d.id), 0) AS balancePaise
    FROM stays s JOIN debtor_accounts d ON d.stay_id = s.id
    WHERE s.business_id = ? AND s.checked_out_at IS NULL ORDER BY s.room`, c.get('businessId')) });
});

settingsRoutes.post(`${B}/stays`, requireAction('stays.edit'), async (c) => {
  const bid = c.get('businessId');
  const b = bizOf(c);
  const data = await body(c);
  const room = text(data, 'room', 'Room', { max: 20 })!;
  const guest = text(data, 'guestName', 'Guest name', { max: 80 })!;
  const id = newId();
  const t = now();
  try {
    await c.env.DB.batch([
      stmt(c.env.DB, 'INSERT INTO stays (id, business_id, room, guest_name, check_in, opened_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, bid, room, guest, clock(b, t).shiftDay, c.get('staff').id, t),
      stmt(c.env.DB, "INSERT INTO debtor_accounts (id, business_id, kind, name, stay_id, created_by, created_at) VALUES (?, ?, 'room', ?, ?, ?, ?)",
        newId(), bid, `Room ${room} · ${guest}`, id, c.get('staff').id, t),
      audit(c.env.DB, bid, c.get('staff').id, 'stay.open', 'stays', id, null, { room, guest }),
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) fail(409, `Room ${room} already has an open stay. Check it out first.`);
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
