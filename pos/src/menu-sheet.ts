// The menu as a sheet (CSV): download it, change it in Excel or Google Sheets, upload it back. Pure: no database here, so
// the rules are tested on their own (pos/test/menu-sheet.test.ts, invented rows).
//
// Columns: Item, Category, Price (₹), Price at billing, Lowest price, Tax, Station, SAC, Add-ons & choices. Other columns
// are ignored. Lowest price and SAC may be left out: then they stay as they are.
//
// Matching (approved 19 Nov 2026): a row updates the item with the same name in the same category (capitals and spaces
// ignored), or else the one item with that name anywhere; its recipes and history stay. Other rows are new items. Items
// on the menu that the file does not have are taken off it (kept for old bills).

export type TaxMode = 'billing' | 'rate' | 'liquor' | 'none';
export interface Tax { mode: TaxMode; bp: number | null }
export interface Group { name: string; kind: 'one' | 'any'; options: { name: string; addPaise: number }[] }
/** A group named on a row: its full form, or only its name (an add-on already set up). */
type GroupRef = { name: string; def: Group | null };
export interface Row {
  line: number; name: string; category: string; pricePaise: number; openPrice: boolean; station: 'kitchen' | 'bar';
  tax: Tax; groups: GroupRef[];
  /** undefined: the column is not in the file, keep what the item has. */
  minPricePaise?: number | null; sac?: string;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** A small CSV reader: quoted fields, doubled quotes, commas and new lines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  const t = text.replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const cell = (v: string | number) => {
  let s = String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`; // never a formula when opened in Excel
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: (string | number)[][]) => rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';

function money(t: string): number | null {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(t.replace(/[₹,\s]|Rs\.?/gi, ''));
  return m ? Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0')) : null;
}

/** "Billing name", "GST 18%", "No GST (liquor)", "No GST". */
export function readTax(t: string): Tax | null {
  const s = norm(t);
  if (s.startsWith('billing name')) return { mode: 'billing', bp: null };
  if (s.includes('liquor')) return { mode: 'liquor', bp: null };
  if (s.startsWith('no gst') || s === 'exempt') return { mode: 'none', bp: null };
  const m = /^gst\s*(\d+)\s*%$/.exec(s);
  if (m && [0, 5, 12, 18, 28, 40].includes(Number(m[1]))) return { mode: 'rate', bp: Number(m[1]) * 100 };
  return null;
}
export const taxText = (t: Tax) => (t.mode === 'billing' ? 'Billing name' : t.mode === 'rate' ? `GST ${t.bp! / 100}%` : t.mode === 'liquor' ? 'No GST (liquor)' : 'No GST');
const taxKey = (t: Tax) => `${t.mode}:${t.bp ?? ''}`;

const opt = (o: string) => {
  const m = /^(.*?)\s*(?:\+\s*(?:₹|Rs\.?)\s*([\d.,]+))?$/i.exec(o.trim())!;
  return { name: m[1].trim(), addPaise: m[2] ? money(m[2]) : 0 };
};
/**
 * The "Add-ons & choices" column, groups split by ";":
 *   Extra Cheese +₹50                       an extra of its own
 *   Choose one: Half / Full +₹150           a choice (named "Half or Full")
 *   Tandoori size: Half / Full +₹150        a choice with its own name
 *   Toppings (any): Olives +₹20 / Corn +₹20 extras under one name
 *   Tandoori size                           an add-on already set up, as it is
 */
export function readGroups(t: string): GroupRef[] | string {
  const out: GroupRef[] = [];
  for (const x of t.split(';').map((s) => s.trim()).filter(Boolean)) {
    const head = /^(.+?)\s*:\s*(.+)$/.exec(x);
    if (head) {
      const any = /\(any\)$/i.test(head[1]);
      const label = head[1].replace(/\(any\)$/i, '').trim();
      const options = head[2].split('/').map(opt);
      if (options.some((o) => !o.name || o.addPaise === null)) return `"${x}": each choice needs a name and, if it costs more, +₹ and the amount`;
      if (!any && options.length < 2) return `"${x}": a choice needs two or more options`;
      const name = /^choose one$/i.test(label) ? options.map((o) => o.name).join(' or ') : label;
      out.push({ name, def: { name, kind: any ? 'any' : 'one', options: options as Group['options'] } });
      continue;
    }
    const o = opt(x);
    if (!o.name || o.addPaise === null) return `"${x}" should look like "Extra Cheese +₹50"`;
    out.push(/\+/.test(x) ? { name: o.name, def: { name: o.name, kind: 'any', options: [o as Group['options'][number]] } } : { name: o.name, def: null });
  }
  return out;
}
/** How a group is written in the sheet (the reverse of readGroups). */
export function groupText(g: Group): string {
  const o = (x: Group['options'][number]) => `${x.name}${x.addPaise ? ` +${rs(x.addPaise)}` : ''}`;
  if (g.kind === 'any' && g.options.length === 1 && norm(g.options[0].name) === norm(g.name) && g.options[0].addPaise) return o(g.options[0]);
  if (g.kind === 'one' && norm(g.name) === norm(g.options.map((x) => x.name).join(' or '))) return `Choose one: ${g.options.map(o).join(' / ')}`;
  return `${g.name}${g.kind === 'any' ? ' (any)' : ''}: ${g.options.map(o).join(' / ')}`;
}

export const HEADER = ['Item', 'Category', 'Price (₹)', 'Price at billing', 'Lowest price (₹)', 'Tax', 'Station', 'SAC', 'Add-ons & choices'];

/** Reads the sheet. Every bad row is reported (row number as in the spreadsheet), not just the first. */
export function readSheet(rows: string[][]): { rows: Row[]; errors: string[] } {
  if (!rows.length) return { rows: [], errors: ['The file is empty.'] };
  const [head, ...data] = rows;
  const find = (...names: string[]) => head.findIndex((h) => names.some((n) => norm(h) === norm(n)));
  const c = { item: find('Item', 'Name'), cat: find('Category'), price: find('Price (₹)', 'Price (Rs)', 'Price'), open: find('Price at billing'),
    min: find('Lowest price (₹)', 'Lowest price'), tax: find('Tax', 'GST'), station: find('Station'), sac: find('SAC'), addons: find('Add-ons & choices', 'Add-ons') };
  const missing = (['item', 'cat', 'price', 'tax', 'station'] as const).filter((k) => c[k] < 0);
  const label = { item: 'Item', cat: 'Category', price: 'Price (₹)', tax: 'Tax', station: 'Station' };
  if (missing.length) return { rows: [], errors: [`The file is missing these columns: ${missing.map((k) => label[k]).join(', ')}. Download the menu to see the layout.`] };
  if (data.length > 2000) return { rows: [], errors: ['The file has more than 2,000 items.'] };
  const errors: string[] = [];
  const out: Row[] = [];
  const seen = new Map<string, number>();
  data.forEach((r, i) => {
    const line = i + 2;
    const get = (k: number) => (k < 0 ? '' : (r[k] ?? '').trim());
    const name = get(c.item).replace(/^'(?=[=+\-@])/, '');
    const bad = (why: string) => errors.push(`Row ${line}${name ? ` (${name})` : ''}: ${why}`);
    const category = get(c.cat);
    if (!name || name.length > 80) return bad('the item name must be 1 to 80 characters.');
    if (!category || category.length > 40) return bad('the category must be 1 to 40 characters.');
    const key = `${norm(name)}|${norm(category)}`;
    if (seen.has(key)) return bad(`the same item and category as row ${seen.get(key)}.`);
    seen.set(key, line);
    const openPrice = /^(yes|y)$/i.test(get(c.open));
    const p = get(c.price) ? money(get(c.price)) : openPrice ? 0 : null;
    if (p === null) return bad(get(c.price) ? `"${get(c.price)}" is not a price.` : 'no price, and not price at billing.');
    let minPricePaise: number | null | undefined;
    if (c.min >= 0) {
      minPricePaise = get(c.min) ? money(get(c.min)) : null;
      if (get(c.min) && minPricePaise === null) return bad(`lowest price "${get(c.min)}" is not a price.`);
      if (!openPrice) minPricePaise = null;
    }
    const tax = readTax(get(c.tax));
    if (!tax) return bad(`tax "${get(c.tax)}" should be Billing name, GST 5% (or 12, 18, 28, 40, 0), No GST (liquor) or No GST.`);
    const st = norm(get(c.station));
    if (st !== 'kitchen' && st !== 'bar') return bad('station must be Kitchen or Bar.');
    const sac = c.sac >= 0 && get(c.sac) ? get(c.sac) : undefined;
    if (sac !== undefined && !/^\d{4,8}$/.test(sac)) return bad('SAC must be 4 to 8 digits.');
    const groups = readGroups(get(c.addons));
    if (typeof groups === 'string') return bad(groups);
    if (groups.length > 10) return bad('at most 10 add-ons on one item.');
    out.push({ line, name, category, pricePaise: p, openPrice, station: st, tax, groups, minPricePaise, sac });
  });
  return { rows: out, errors };
}

// ---------- the plan: what an upload would change, worked out against the menu as it is

export interface ExistingItem {
  id: string; name: string; category: string; pricePaise: number; station: string; sac: string; taxMode: TaxMode | null; gstBp: number | null;
  openPrice: boolean; minPricePaise: number | null; active: boolean; groups: string[]; createdAt: number;
}
export interface Existing { items: ExistingItem[]; categories: { name: string; taxMode: TaxMode; gstBp: number | null }[]; groups: (Group & { id: string })[] }

export interface PlanItem {
  id: string | null; name: string; category: string; pricePaise: number; station: string; sac: string; tax: Tax | null;
  openPrice: boolean; minPricePaise: number | null; groups: string[];
}
export interface Plan {
  items: PlanItem[];
  off: { id: string; name: string; category: string }[];
  categories: { name: string; tax: Tax; was: Tax | null }[];
  groups: { name: string; def: Group; was: Group | null }[];
  added: string[]; back: string[]; priceChanges: { name: string; from: number; to: number }[]; otherChanges: { name: string; what: string[] }[];
  notes: string[]; errors: string[];
}

const effective = (t: { taxMode: TaxMode | null; gstBp: number | null }, cat: Tax | undefined): Tax =>
  t.taxMode ? { mode: t.taxMode, bp: t.gstBp } : cat ?? { mode: 'billing', bp: null };

export function plan(sheet: { rows: Row[]; errors: string[] }, now: Existing): Plan {
  const errors = [...sheet.errors];
  const rows = sheet.rows;
  // Add-ons: a full form sets the group (the same everywhere it is written); a bare name must already exist.
  const defs = new Map<string, Group>();
  for (const r of rows) for (const g of r.groups) {
    if (!g.def) continue;
    const had = defs.get(norm(g.name));
    if (had && JSON.stringify(had) !== JSON.stringify(g.def)) errors.push(`Row ${r.line} (${r.name}): add-on "${g.name}" is written differently on another row.`);
    defs.set(norm(g.name), g.def);
  }
  const oldGroups = new Map(now.groups.map((g) => [norm(g.name), g]));
  for (const r of rows) for (const g of r.groups) {
    if (!g.def && !defs.has(norm(g.name)) && !oldGroups.has(norm(g.name))) errors.push(`Row ${r.line} (${r.name}): there is no add-on called "${g.name}". Write it in full, like "Extra Cheese +₹50".`);
  }
  const groupName = (n: string) => defs.get(norm(n))?.name ?? oldGroups.get(norm(n))?.name ?? n;

  // Category GST: what most of its items have; the other items keep their own.
  const notes: string[] = [];
  const catOrder = [...new Map(rows.map((r) => [norm(r.category), r.category])).values()];
  const oldCat = new Map(now.categories.map((c) => [norm(c.name), { mode: c.taxMode, bp: c.gstBp } as Tax]));
  const categories = catOrder.map((name) => {
    const count = new Map<string, { tax: Tax; n: number }>();
    for (const r of rows.filter((x) => norm(x.category) === norm(name))) count.set(taxKey(r.tax), { tax: r.tax, n: (count.get(taxKey(r.tax))?.n ?? 0) + 1 });
    const top = [...count.values()].sort((a, b) => b.n - a.n)[0].tax;
    const own = rows.filter((x) => norm(x.category) === norm(name) && taxKey(x.tax) !== taxKey(top));
    if (own.length) notes.push(`${name}: ${taxText(top)} for the category; set on the item: ${own.map((x) => `${x.name} (${taxText(x.tax)})`).join(', ')}.`);
    return { name, tax: top, was: oldCat.get(norm(name)) ?? null };
  });
  const catTax = new Map(categories.map((c) => [norm(c.name), c.tax]));

  // Match rows to items: same name and category first, then the one item with that name.
  const pick = (xs: ExistingItem[]) => [...xs].sort((a, b) => Number(b.active) - Number(a.active) || b.createdAt - a.createdAt)[0];
  const used = new Set<string>();
  const match = new Map<number, ExistingItem>();
  for (const r of rows) {
    const x = pick(now.items.filter((i) => !used.has(i.id) && norm(i.name) === norm(r.name) && norm(i.category) === norm(r.category)));
    if (x) { match.set(r.line, x); used.add(x.id); }
  }
  for (const r of rows) {
    if (match.has(r.line) || rows.filter((y) => norm(y.name) === norm(r.name)).length > 1) continue;
    const xs = now.items.filter((i) => !used.has(i.id) && norm(i.name) === norm(r.name));
    const x = xs.filter((i) => i.active).length === 1 ? xs.find((i) => i.active)! : xs.length === 1 ? xs[0] : undefined;
    if (x) { match.set(r.line, x); used.add(x.id); }
  }

  const added: string[] = [], back: string[] = [], priceChanges: Plan['priceChanges'] = [], otherChanges: Plan['otherChanges'] = [];
  const items: PlanItem[] = rows.map((r) => {
    const x = match.get(r.line);
    const tax = taxKey(r.tax) === taxKey(catTax.get(norm(r.category))!) ? null : r.tax;
    const p: PlanItem = { id: x?.id ?? null, name: r.name, category: r.category, pricePaise: r.pricePaise, station: r.station,
      sac: r.sac ?? x?.sac ?? (/^room tariff$/i.test(r.name) ? '996311' : '996332'), tax, openPrice: r.openPrice,
      minPricePaise: r.minPricePaise !== undefined ? r.minPricePaise : r.openPrice ? x?.minPricePaise ?? null : null, groups: r.groups.map((g) => groupName(g.name)) };
    if (!x) { added.push(r.name); return p; }
    if (!x.active) back.push(r.name);
    if (!r.openPrice && x.pricePaise !== r.pricePaise) priceChanges.push({ name: r.name, from: x.pricePaise, to: r.pricePaise });
    const what: string[] = [];
    if (x.name !== r.name) what.push(`name "${x.name}" → "${r.name}"`);
    if (x.category !== r.category) what.push(`category ${x.category} → ${r.category}`);
    if (x.station !== r.station) what.push(`station ${x.station} → ${r.station}`);
    const was = effective(x, oldCat.get(norm(x.category)));
    if (taxKey(was) !== taxKey(r.tax)) what.push(`tax ${taxText(was)} → ${taxText(r.tax)}`);
    if (x.openPrice !== r.openPrice) what.push(r.openPrice ? 'price now typed at billing' : `fixed price ${rs(r.pricePaise)}`);
    if (r.openPrice && x.minPricePaise !== p.minPricePaise) what.push(`lowest price ${x.minPricePaise === null ? 'none' : rs(x.minPricePaise)} → ${p.minPricePaise === null ? 'none' : rs(p.minPricePaise)}`);
    if (x.sac !== p.sac) what.push(`SAC ${x.sac} → ${p.sac}`);
    const g0 = x.groups.join(', '), g1 = p.groups.join(', ');
    if (norm(g0) !== norm(g1)) what.push(`add-ons ${g0 || 'none'} → ${g1 || 'none'}`);
    if (what.length) otherChanges.push({ name: r.name, what });
    return p;
  });
  const off = now.items.filter((i) => i.active && !used.has(i.id)).map((i) => ({ id: i.id, name: i.name, category: i.category }));
  const groups = [...defs.values()].map((def) => {
    const was = oldGroups.get(norm(def.name));
    return { name: def.name, def, was: was ? { name: was.name, kind: was.kind, options: was.options.map((o) => ({ name: o.name, addPaise: o.addPaise })) } : null };
  });
  if (!rows.length && !errors.length) errors.push('The file has no items.');
  return { items, off, categories, groups, added, back, priceChanges, otherChanges, notes, errors };
}

/** The menu as the sheet, for download (active items only). */
export function sheetOf(now: Existing): string {
  const cat = new Map(now.categories.map((c) => [norm(c.name), { mode: c.taxMode, bp: c.gstBp } as Tax]));
  const gs = new Map(now.groups.map((g) => [norm(g.name), g]));
  const items = now.items.filter((i) => i.active);
  const order = now.categories.map((c) => norm(c.name));
  items.sort((a, b) => (order.indexOf(norm(a.category)) + 1 || 1e9) - (order.indexOf(norm(b.category)) + 1 || 1e9) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return toCsv([HEADER, ...items.map((i) => [i.name, i.category, i.openPrice ? '' : (i.pricePaise / 100).toFixed(2).replace(/\.00$/, ''), i.openPrice ? 'Yes' : '',
    i.openPrice && i.minPricePaise !== null ? (i.minPricePaise / 100).toFixed(2).replace(/\.00$/, '') : '', taxText(effective(i, cat.get(norm(i.category)))),
    i.station === 'bar' ? 'Bar' : 'Kitchen', i.sac, i.groups.map((n) => { const g = gs.get(norm(n)); return g ? groupText(g) : n; }).join('; ')])]);
}
