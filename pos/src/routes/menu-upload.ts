// The menu as a sheet: download it, change it in Excel or Google Sheets, upload it back (approved 19 Nov 2026).
// Uploading is two steps: check (nothing changes; shows what would) and apply (all of it at once, or none). Only the Owner
// uploads. Each uploaded file is kept in private storage, so what was loaded and when can always be seen.
import { Hono, type Context } from 'hono';
import { all, newId, now } from '../../../src/db';
import { body, fail } from '../../../src/http';
import { requireAction } from '../auth';
import { z } from 'zod';
import { OcrError, readWithClaude } from '../../../src/claude';
import { FIELD_NAMES, FIELDS, HEADER, parseCsv, plan, readSheet, sampleSheet, sheetOf, toCsv, type Columns, type Defaults, type Existing, type Plan, type SheetResult, type TaxMode } from '../menu-sheet';
import { readPrices } from '../addons';
import { syncItemStations } from '../stations';
import { audit } from '../util';
import type { AppEnv } from '../types';

export const menuUploadRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
const MAX = 1024 * 1024;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

async function existing(db: D1Database, bid: string): Promise<Existing> {
  const [items, links, categories, groups, options, stations] = await Promise.all([
    all<{ id: string; name: string; category: string; price_paise: number; station: string; sac: string; tax_mode: TaxMode | null; gst_bp: number | null;
      open_price: number; min_price_paise: number | null; active: number; created_at: number; kot: number | null; station_id: string | null }>(db,
      'SELECT id, name, category, price_paise, station, sac, tax_mode, gst_bp, open_price, min_price_paise, active, created_at, kot, station_id FROM menu_items WHERE business_id = ?', bid),
    all<{ item_id: string; name: string; prices: string | null }>(db, 'SELECT l.item_id, g.name, l.prices FROM menu_item_addons l JOIN addon_groups g ON g.id = l.group_id WHERE l.business_id = ? ORDER BY l.sort', bid),
    all<{ name: string; tax_mode: TaxMode; gst_bp: number | null; kot: number; station_id: string | null }>(db, 'SELECT name, tax_mode, gst_bp, kot, station_id FROM menu_categories WHERE business_id = ? ORDER BY sort, name', bid),
    all<{ id: string; name: string; kind: 'one' | 'any' }>(db, 'SELECT id, name, kind FROM addon_groups WHERE business_id = ?', bid),
    all<{ group_id: string; name: string; add_paise: number }>(db, 'SELECT group_id, name, add_paise FROM addon_options WHERE business_id = ? AND active = 1 ORDER BY sort', bid),
    all<{ id: string; name: string; is_bar: number; active: number }>(db, 'SELECT id, name, is_bar, active FROM stations WHERE business_id = ? ORDER BY sort, name', bid),
  ]);
  return {
    items: items.map((i) => ({ id: i.id, name: i.name, category: i.category, pricePaise: i.price_paise, station: i.station, sac: i.sac, taxMode: i.tax_mode, gstBp: i.gst_bp,
      openPrice: !!i.open_price, minPricePaise: i.min_price_paise, active: !!i.active, createdAt: i.created_at,
      groups: links.filter((l) => l.item_id === i.id).map((l) => l.name), groupPrices: links.filter((l) => l.item_id === i.id).map((l) => readPrices(l.prices)),
      kot: i.kot, stationId: i.station_id })),
    categories: categories.map((c) => ({ name: c.name, taxMode: c.tax_mode, gstBp: c.gst_bp, kot: c.kot, stationId: c.station_id })),
    stations: stations.map((x) => ({ id: x.id, name: x.name, isBar: !!x.is_bar, active: !!x.active })),
    groups: groups.map((g) => ({ ...g, options: options.filter((o) => o.group_id === g.id).map((o) => ({ name: o.name, addPaise: o.add_paise })) })),
  };
}

async function sha(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function checked(c: Context<AppEnv>, bid: string) {
  const data = await body(c);
  const csv = data.csv;
  if (typeof csv !== 'string' || !csv.trim()) fail(400, 'Choose a CSV file.');
  if (csv.length > MAX) fail(400, 'The file is larger than 1 MB.');
  const columns: Partial<Columns> = {};
  if (data.columns !== undefined) {
    if (!data.columns || typeof data.columns !== 'object') fail(400, 'Columns must be a list of choices.');
    for (const [k, v] of Object.entries(data.columns as Record<string, unknown>)) {
      if (!(FIELDS as readonly string[]).includes(k) || !Number.isInteger(v) || (v as number) < -1 || (v as number) > 200) fail(400, 'A column choice is not valid.');
      columns[k as keyof Columns] = v as number;
    }
  }
  const defaults: Defaults = {};
  if (data.defaults !== undefined) {
    const d = data.defaults as Record<string, unknown>;
    if (!d || typeof d !== 'object' || Object.keys(d).length > 300) fail(400, 'Category choices are not valid.');
    for (const [k, v] of Object.entries(d)) {
      const x = (v ?? {}) as Record<string, unknown>;
      if (k.length > 40 || [x.tax, x.station].some((y) => y !== undefined && (typeof y !== 'string' || y.length > 40))) fail(400, 'Category choices are not valid.');
      defaults[k] = { tax: x.tax as string | undefined, station: x.station as string | undefined };
    }
  }
  const now0 = await existing(c.env.DB, bid);
  const sheet = readSheet(parseCsv(csv), { columns, defaults });
  const p = plan(sheet, now0);
  return { csv, now: now0, plan: p, sheet, hash: await sha(JSON.stringify({ p, columns: sheet.columns })), data };
}
const summary = (p: Plan, hash: string, sheet: SheetResult) => ({
  headings: sheet.headings, columns: sheet.columns, fields: FIELDS.map((f) => ({ key: f, name: FIELD_NAMES[f] })), needs: sheet.needs,
  exactHeadings: FIELDS.every((f, i) => sheet.columns[f] < 0 || sheet.headings[sheet.columns[f]]?.trim().toLowerCase() === HEADER[i].toLowerCase()),
  ok: !p.errors.length, planHash: hash, errors: p.errors.slice(0, 100), errorCount: p.errors.length,
  items: p.items.length, added: p.added, back: p.back, off: p.off.map((o) => `${o.name} (${o.category})`), priceChanges: p.priceChanges, otherChanges: p.otherChanges,
  categories: p.categories, groups: p.groups.map((g) => ({ ...g, items: p.items.filter((i) => i.groups.some((n) => norm(n) === norm(g.name))).length })),
  openPrice: p.items.filter((i) => i.openPrice).length, notes: p.notes,
});

// The menu as the sheet, to change and upload back.
menuUploadRoutes.get(`${B}/menu/sheet`, requireAction('menu.edit'), async (c) => {
  const csv = sheetOf(await existing(c.env.DB, c.get('businessId')));
  return c.body('﻿' + csv, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="menu.csv"' });
});

menuUploadRoutes.post(`${B}/menu/upload/check`, requireAction('menu.upload'), async (c) => {
  const r = await checked(c, c.get('businessId'));
  return c.json(summary(r.plan, r.hash, r.sheet));
});

menuUploadRoutes.post(`${B}/menu/upload/apply`, requireAction('menu.upload'), async (c) => {
  const bid = c.get('businessId');
  const r = await checked(c, bid);
  if (r.plan.errors.length) fail(400, 'The file has rows to fix. Check it again.');
  if (r.data.planHash !== r.hash) fail(409, 'The menu or the file changed since you checked it. Check it again.');
  const p = r.plan;
  const t = now();
  const db = c.env.DB;
  const staff = c.get('staff');

  // Add-on group ids: the one already set up with that name, or a new one.
  const gid = new Map(r.now.groups.map((g) => [norm(g.name), g.id]));
  for (const g of p.groups) if (!gid.has(norm(g.name))) gid.set(norm(g.name), newId());
  const items = p.items.map((i) => ({ ...i, id: i.id ?? newId(), isNew: !i.id }));
  const J = (v: unknown) => JSON.stringify(v);
  const x = (k: string) => `json_extract(j.value, '$.${k}')`;

  const stmts = [
    db.prepare(`UPDATE menu_categories SET tax_mode = ${x('mode')}, gst_bp = ${x('bp')}, sort = ${x('sort')}, kot = ${x('kot')}, station_id = ${x('st')} FROM json_each(?) j
      WHERE menu_categories.business_id = ? AND lower(menu_categories.name) = lower(${x('name')})`)
      .bind(J(p.categories.map((k, i) => ({ name: k.name, mode: k.tax.mode, bp: k.tax.bp, sort: i, kot: k.route.kot ? 1 : 0, st: k.route.stationId }))), bid),
    db.prepare(`INSERT OR IGNORE INTO menu_categories (id, business_id, name, tax_mode, gst_bp, sort, created_at, kot, station_id)
      SELECT ${x('id')}, ?, ${x('name')}, ${x('mode')}, ${x('bp')}, ${x('sort')}, ?, ${x('kot')}, ${x('st')} FROM json_each(?) j`)
      .bind(bid, t, J(p.categories.map((k, i) => ({ id: newId(), name: k.name, mode: k.tax.mode, bp: k.tax.bp, sort: i, kot: k.route.kot ? 1 : 0, st: k.route.stationId })))),
    db.prepare(`INSERT OR IGNORE INTO addon_groups (id, business_id, name, kind, created_at) SELECT ${x('id')}, ?, ${x('name')}, ${x('kind')}, ? FROM json_each(?) j`)
      .bind(bid, t, J(p.groups.map((g) => ({ id: gid.get(norm(g.name)), name: g.def.name, kind: g.def.kind })))),
    db.prepare(`UPDATE addon_groups SET name = ${x('name')}, kind = ${x('kind')} FROM json_each(?) j WHERE addon_groups.id = ${x('id')} AND addon_groups.business_id = ?`)
      .bind(J(p.groups.map((g) => ({ id: gid.get(norm(g.name)), name: g.def.name, kind: g.def.kind }))), bid),
    db.prepare('DELETE FROM addon_options WHERE business_id = ? AND group_id IN (SELECT value FROM json_each(?))')
      .bind(bid, J(p.groups.map((g) => gid.get(norm(g.name))))),
    db.prepare(`INSERT INTO addon_options (id, business_id, group_id, name, add_paise, sort, active) SELECT ${x('id')}, ?, ${x('group')}, ${x('name')}, ${x('add')}, ${x('sort')}, 1 FROM json_each(?) j`)
      .bind(bid, J(p.groups.flatMap((g) => g.def.options.map((o, i) => ({ id: newId(), group: gid.get(norm(g.name)), name: o.name, add: o.addPaise, sort: i }))))),
    db.prepare(`UPDATE menu_items SET name = ${x('name')}, category = ${x('category')}, price_paise = ${x('price')}, station = ${x('station')}, sac = ${x('sac')},
      tax_mode = ${x('mode')}, gst_bp = ${x('bp')}, open_price = ${x('open')}, min_price_paise = ${x('min')}, active = 1, kot = ${x('kot')}, station_id = ${x('st')}
      FROM json_each(?) j WHERE menu_items.id = ${x('id')} AND menu_items.business_id = ?`)
      .bind(J(items.filter((i) => !i.isNew).map(row)), bid),
    db.prepare(`INSERT INTO menu_items (id, business_id, name, category, price_paise, sac, station, tax_mode, gst_bp, open_price, min_price_paise, active, created_at, kot, station_id)
      SELECT ${x('id')}, ?, ${x('name')}, ${x('category')}, ${x('price')}, ${x('sac')}, ${x('station')}, ${x('mode')}, ${x('bp')}, ${x('open')}, ${x('min')}, 1, ?, ${x('kot')}, ${x('st')} FROM json_each(?) j`)
      .bind(bid, t, J(items.filter((i) => i.isNew).map(row))),
    db.prepare('UPDATE menu_items SET active = 0 WHERE business_id = ? AND id IN (SELECT value FROM json_each(?))').bind(bid, J(p.off.map((o) => o.id))),
    db.prepare('DELETE FROM menu_item_addons WHERE business_id = ? AND item_id IN (SELECT value FROM json_each(?))').bind(bid, J(items.map((i) => i.id))),
    db.prepare(`INSERT INTO menu_item_addons (item_id, group_id, business_id, sort, prices) SELECT ${x('item')}, ${x('group')}, ?, ${x('sort')}, ${x('prices')} FROM json_each(?) j`)
      .bind(bid, J(items.flatMap((i) => i.groups.map((g, n) => ({ item: i.id, group: gid.get(norm(g)), sort: n, prices: i.groupPrices[n] ? J(i.groupPrices[n]) : null }))))),
  ];
  // Keep the file first: a menu is never loaded without its copy.
  let key: string | null = null;
  if (c.env.BILLS) {
    key = `pos/${bid}/menus/${new Date(t).toISOString().replace(/[:.]/g, '-')}.csv`;
    await c.env.BILLS.put(key, r.csv, { httpMetadata: { contentType: 'text/csv; charset=utf-8' }, customMetadata: { by: staff.name, items: String(items.length) } });
  }
  await db.batch([...stmts, syncItemStations(db, bid), audit(db, bid, staff.id, 'menu.upload', 'menu_items', bid, null,
    { file: key, items: items.length, added: p.added.length, off: p.off.length, priceChanges: p.priceChanges.length, otherChanges: p.otherChanges.length })]);
  return c.json({ ok: true, items: items.length, added: p.added.length, off: p.off.length, priceChanges: p.priceChanges.length, file: key });

  function row(i: (typeof items)[number]) {
    return { id: i.id, name: i.name, category: i.category, price: i.pricePaise, station: i.station, sac: i.sac, mode: i.tax?.mode ?? null, bp: i.tax?.bp ?? null,
      open: i.openPrice ? 1 : 0, min: i.minPricePaise, kot: i.ownKot, st: i.ownStationId };
  }
});

// A small sheet with invented rows showing every column, to fill in.
menuUploadRoutes.get(`${B}/menu/sample`, requireAction('menu.edit'), (c) =>
  c.body('\uFEFF' + sampleSheet(), 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="menu-sample.csv"' }));

// A photo or PDF of a printed menu, read by Claude into the sheet layout, then checked like any other upload. Claude
// leaves GST empty (asked per category on screen) and the station when the menu does not make it plain. The page is kept.
const MenuReading = z.object({
  items: z.array(z.object({
    name: z.string(), category: z.string().nullable(), priceRupees: z.number().nullable(), priceAtBilling: z.boolean(),
    station: z.enum(['Kitchen', 'Bar']).nullable(), addons: z.string().nullable(),
  })),
});
const MENU_READ = `This is a page of a restaurant and bar menu in India (a photo or a PDF). List every item on it, in order:
- name: the item as printed (fix only obvious spelling slips; keep sizes like "30 ml", "650 ml", "Half").
- category: the heading the item is under, as printed (title case); null if there is none.
- priceRupees: the price as a number. If an item shows two prices for sizes (Half / Full, Small / Large, 30 ml / 60 ml),
  list it once with the first (smaller) price; the other sizes are set up later in the app.
  If the menu says MRP, market price, at actuals or shows no price, use null and set priceAtBilling true.
- priceAtBilling: true only as said above.
- station: "Bar" for alcohol, cocktails, mocktails and cold drinks served at a bar when the menu shows a bar section;
  "Kitchen" for food; null when you cannot tell.
- addons: always null (extras are set up later in the app).
Do not guess GST or taxes: leave them out. Never invent an item or a price: use null for anything you cannot read.`;
const MAX_READ = 10 * 1024 * 1024;
const READS_PER_DAY = 20;

menuUploadRoutes.post(`${B}/menu/upload/read`, requireAction('menu.upload'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const type = (c.req.header('Content-Type') ?? '').split(';')[0].trim();
  if (type !== 'image/jpeg' && type !== 'image/png' && type !== 'application/pdf') fail(400, 'Send a JPEG or PNG photo, or a PDF, of the menu.');
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.length) fail(400, 'The file is empty.');
  if (bytes.length > MAX_READ) fail(400, 'The file is larger than 10 MB.');
  const t = now();
  const used = await all<{ n: number }>(db, "SELECT count(*) AS n FROM audit_log WHERE business_id = ? AND action = 'menu.read' AND created_at > ?", bid, t - 86_400_000);
  if (used[0].n >= READS_PER_DAY) fail(429, `Today's ${READS_PER_DAY} menu readings are used up. Try again tomorrow, or fill in the sample sheet.`);
  let key: string | null = null;
  if (c.env.BILLS) {
    key = `pos/${bid}/menus/read-${new Date(t).toISOString().replace(/[:.]/g, '-')}.${type === 'application/pdf' ? 'pdf' : type === 'image/png' ? 'png' : 'jpg'}`;
    await c.env.BILLS.put(key, bytes, { httpMetadata: { contentType: type }, customMetadata: { by: c.get('staff').name } });
  }
  let read: z.infer<typeof MenuReading>;
  try {
    read = (await readWithClaude(c.env, { bytes, mediaType: type }, MENU_READ, MenuReading)).data;
  } catch (e) {
    if (e instanceof OcrError) fail(e.status, e.message.replace(/type the rows in/gi, 'fill in the sample sheet'));
    throw e;
  }
  await audit(db, bid, c.get('staff').id, 'menu.read', 'menu_items', bid, null, { file: key, items: read.items.length }).run();
  const rp = (n: number | null) => (n === null ? '' : String(Math.round(n * 100) / 100));
  const csv = toCsv([['Item', 'Category', 'Price (₹)', 'Price at billing', 'Tax', 'Station'],
    ...read.items.map((i) => [i.name, i.category ?? '', rp(i.priceRupees), i.priceAtBilling || i.priceRupees === null ? 'Yes' : '', '', i.station ?? ''])]);
  return c.json({ csv, items: read.items.length });
});

// Files uploaded before, newest first, and each one as it was.
menuUploadRoutes.get(`${B}/menu/uploads`, requireAction('menu.upload'), async (c) => {
  if (!c.env.BILLS) return c.json({ uploads: [] });
  const list = await c.env.BILLS.list({ prefix: `pos/${c.get('businessId')}/menus/`, include: ['customMetadata'] });
  return c.json({ uploads: list.objects.filter((o) => o.key.endsWith('.csv') && !o.key.includes('/read-')).map((o) => ({ name: o.key.split('/').pop(), at: o.uploaded.getTime(), by: o.customMetadata?.by ?? null, items: Number(o.customMetadata?.items ?? 0) }))
    .sort((a, b) => b.at - a.at).slice(0, 30) });
});
menuUploadRoutes.get(`${B}/menu/uploads/:name`, requireAction('menu.upload'), async (c) => {
  const name = c.req.param('name');
  if (!/^[\w-]+\.csv$/.test(name) || !c.env.BILLS) fail(404, 'File not found.');
  const obj = await c.env.BILLS.get(`pos/${c.get('businessId')}/menus/${name}`);
  if (!obj) fail(404, 'File not found.');
  return c.body(await obj.text(), 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="menu-${name}"` });
});
