// The menu as a sheet: download it, change it in Excel or Google Sheets, upload it back (approved 19 Nov 2026).
// Uploading is two steps: check (nothing changes; shows what would) and apply (all of it at once, or none). Only the Owner
// uploads. Each uploaded file is kept in private storage, so what was loaded and when can always be seen.
import { Hono, type Context } from 'hono';
import { all, newId, now } from '../../../src/db';
import { body, fail } from '../../../src/http';
import { requireAction } from '../auth';
import { parseCsv, plan, readSheet, sheetOf, type Existing, type Plan, type TaxMode } from '../menu-sheet';
import { audit } from '../util';
import type { AppEnv } from '../types';

export const menuUploadRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
const MAX = 1024 * 1024;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

async function existing(db: D1Database, bid: string): Promise<Existing> {
  const [items, links, categories, groups, options] = await Promise.all([
    all<{ id: string; name: string; category: string; price_paise: number; station: string; sac: string; tax_mode: TaxMode | null; gst_bp: number | null;
      open_price: number; min_price_paise: number | null; active: number; created_at: number }>(db,
      'SELECT id, name, category, price_paise, station, sac, tax_mode, gst_bp, open_price, min_price_paise, active, created_at FROM menu_items WHERE business_id = ?', bid),
    all<{ item_id: string; name: string }>(db, 'SELECT l.item_id, g.name FROM menu_item_addons l JOIN addon_groups g ON g.id = l.group_id WHERE l.business_id = ? ORDER BY l.sort', bid),
    all<{ name: string; tax_mode: TaxMode; gst_bp: number | null }>(db, 'SELECT name, tax_mode, gst_bp FROM menu_categories WHERE business_id = ? ORDER BY sort, name', bid),
    all<{ id: string; name: string; kind: 'one' | 'any' }>(db, 'SELECT id, name, kind FROM addon_groups WHERE business_id = ?', bid),
    all<{ group_id: string; name: string; add_paise: number }>(db, 'SELECT group_id, name, add_paise FROM addon_options WHERE business_id = ? AND active = 1 ORDER BY sort', bid),
  ]);
  return {
    items: items.map((i) => ({ id: i.id, name: i.name, category: i.category, pricePaise: i.price_paise, station: i.station, sac: i.sac, taxMode: i.tax_mode, gstBp: i.gst_bp,
      openPrice: !!i.open_price, minPricePaise: i.min_price_paise, active: !!i.active, createdAt: i.created_at, groups: links.filter((l) => l.item_id === i.id).map((l) => l.name) })),
    categories: categories.map((c) => ({ name: c.name, taxMode: c.tax_mode, gstBp: c.gst_bp })),
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
  const now0 = await existing(c.env.DB, bid);
  const p = plan(readSheet(parseCsv(csv)), now0);
  return { csv, now: now0, plan: p, hash: await sha(JSON.stringify(p)), data };
}
const summary = (p: Plan, hash: string) => ({
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
  return c.json(summary(r.plan, r.hash));
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
    db.prepare(`UPDATE menu_categories SET tax_mode = ${x('mode')}, gst_bp = ${x('bp')}, sort = ${x('sort')} FROM json_each(?) j
      WHERE menu_categories.business_id = ? AND lower(menu_categories.name) = lower(${x('name')})`)
      .bind(J(p.categories.map((k, i) => ({ name: k.name, mode: k.tax.mode, bp: k.tax.bp, sort: i }))), bid),
    db.prepare(`INSERT OR IGNORE INTO menu_categories (id, business_id, name, tax_mode, gst_bp, sort, created_at)
      SELECT ${x('id')}, ?, ${x('name')}, ${x('mode')}, ${x('bp')}, ${x('sort')}, ? FROM json_each(?) j`)
      .bind(bid, t, J(p.categories.map((k, i) => ({ id: newId(), name: k.name, mode: k.tax.mode, bp: k.tax.bp, sort: i })))),
    db.prepare(`INSERT OR IGNORE INTO addon_groups (id, business_id, name, kind, created_at) SELECT ${x('id')}, ?, ${x('name')}, ${x('kind')}, ? FROM json_each(?) j`)
      .bind(bid, t, J(p.groups.map((g) => ({ id: gid.get(norm(g.name)), name: g.def.name, kind: g.def.kind })))),
    db.prepare(`UPDATE addon_groups SET name = ${x('name')}, kind = ${x('kind')} FROM json_each(?) j WHERE addon_groups.id = ${x('id')} AND addon_groups.business_id = ?`)
      .bind(J(p.groups.map((g) => ({ id: gid.get(norm(g.name)), name: g.def.name, kind: g.def.kind }))), bid),
    db.prepare('DELETE FROM addon_options WHERE business_id = ? AND group_id IN (SELECT value FROM json_each(?))')
      .bind(bid, J(p.groups.map((g) => gid.get(norm(g.name))))),
    db.prepare(`INSERT INTO addon_options (id, business_id, group_id, name, add_paise, sort, active) SELECT ${x('id')}, ?, ${x('group')}, ${x('name')}, ${x('add')}, ${x('sort')}, 1 FROM json_each(?) j`)
      .bind(bid, J(p.groups.flatMap((g) => g.def.options.map((o, i) => ({ id: newId(), group: gid.get(norm(g.name)), name: o.name, add: o.addPaise, sort: i }))))),
    db.prepare(`UPDATE menu_items SET name = ${x('name')}, category = ${x('category')}, price_paise = ${x('price')}, station = ${x('station')}, sac = ${x('sac')},
      tax_mode = ${x('mode')}, gst_bp = ${x('bp')}, open_price = ${x('open')}, min_price_paise = ${x('min')}, active = 1
      FROM json_each(?) j WHERE menu_items.id = ${x('id')} AND menu_items.business_id = ?`)
      .bind(J(items.filter((i) => !i.isNew).map(row)), bid),
    db.prepare(`INSERT INTO menu_items (id, business_id, name, category, price_paise, sac, station, tax_mode, gst_bp, open_price, min_price_paise, active, created_at)
      SELECT ${x('id')}, ?, ${x('name')}, ${x('category')}, ${x('price')}, ${x('sac')}, ${x('station')}, ${x('mode')}, ${x('bp')}, ${x('open')}, ${x('min')}, 1, ? FROM json_each(?) j`)
      .bind(bid, t, J(items.filter((i) => i.isNew).map(row))),
    db.prepare('UPDATE menu_items SET active = 0 WHERE business_id = ? AND id IN (SELECT value FROM json_each(?))').bind(bid, J(p.off.map((o) => o.id))),
    db.prepare('DELETE FROM menu_item_addons WHERE business_id = ? AND item_id IN (SELECT value FROM json_each(?))').bind(bid, J(items.map((i) => i.id))),
    db.prepare(`INSERT INTO menu_item_addons (item_id, group_id, business_id, sort) SELECT ${x('item')}, ${x('group')}, ?, ${x('sort')} FROM json_each(?) j`)
      .bind(bid, J(items.flatMap((i) => i.groups.map((g, n) => ({ item: i.id, group: gid.get(norm(g)), sort: n }))))),
  ];
  // Keep the file first: a menu is never loaded without its copy.
  let key: string | null = null;
  if (c.env.BILLS) {
    key = `pos/${bid}/menus/${new Date(t).toISOString().replace(/[:.]/g, '-')}.csv`;
    await c.env.BILLS.put(key, r.csv, { httpMetadata: { contentType: 'text/csv; charset=utf-8' }, customMetadata: { by: staff.name, items: String(items.length) } });
  }
  await db.batch([...stmts, audit(db, bid, staff.id, 'menu.upload', 'menu_items', bid, null,
    { file: key, items: items.length, added: p.added.length, off: p.off.length, priceChanges: p.priceChanges.length, otherChanges: p.otherChanges.length })]);
  return c.json({ ok: true, items: items.length, added: p.added.length, off: p.off.length, priceChanges: p.priceChanges.length, file: key });

  function row(i: (typeof items)[number]) {
    return { id: i.id, name: i.name, category: i.category, price: i.pricePaise, station: i.station, sac: i.sac, mode: i.tax?.mode ?? null, bp: i.tax?.bp ?? null,
      open: i.openPrice ? 1 : 0, min: i.minPricePaise };
  }
});

// Files uploaded before, newest first, and each one as it was.
menuUploadRoutes.get(`${B}/menu/uploads`, requireAction('menu.upload'), async (c) => {
  if (!c.env.BILLS) return c.json({ uploads: [] });
  const list = await c.env.BILLS.list({ prefix: `pos/${c.get('businessId')}/menus/`, include: ['customMetadata'] });
  return c.json({ uploads: list.objects.map((o) => ({ name: o.key.split('/').pop(), at: o.uploaded.getTime(), by: o.customMetadata?.by ?? null, items: Number(o.customMetadata?.items ?? 0) }))
    .sort((a, b) => b.at - a.at).slice(0, 30) });
});
menuUploadRoutes.get(`${B}/menu/uploads/:name`, requireAction('menu.upload'), async (c) => {
  const name = c.req.param('name');
  if (!/^[\w-]+\.csv$/.test(name) || !c.env.BILLS) fail(404, 'File not found.');
  const obj = await c.env.BILLS.get(`pos/${c.get('businessId')}/menus/${name}`);
  if (!obj) fail(404, 'File not found.');
  return c.body(await obj.text(), 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="menu-${name}"` });
});
