// The menu as a sheet (CSV): download it, change it in Excel or Google Sheets, upload it back. Pure: no database here, so
// the rules are tested on their own (pos/test/menu-sheet.test.ts, invented rows).
//
// Columns: Item, Category, Price (₹), Price at billing, Lowest price, Tax, Station, SAC, Add-ons & choices. Other columns
// are ignored. Lowest price and SAC may be left out: then they stay as they are.
//
// Matching (approved 19 Nov 2026): a row updates the item with the same name in the same category (capitals and spaces
// ignored), or else the one item with that name anywhere; its recipes and history stay. Other rows are new items. Items
// on the menu that the file does not have are taken off it (kept for old bills).
import { basePrice, priceKey, type Prices } from './addons';

export type TaxMode = 'billing' | 'rate' | 'liquor' | 'none';
export interface Tax { mode: TaxMode; bp: number | null }
export interface Group { name: string; kind: 'one' | 'any'; options: { name: string; addPaise: number }[] }
/** A group named on a row: its full form, or only its name (an add-on already set up). */
/**
 * An add-on named on a row: its full form, or only its name (an add-on already set up). `loose`: the row gives this
 * dish's own prices (Half ₹300 / Full ₹450), so its form only names the options; `prices` are those prices.
 */
type GroupRef = { name: string; def: Group | null; loose?: boolean; prices?: Prices | null };
export interface Row {
  /** station: as written (a station's name, Kitchen / Bar or another word for them), checked against the stations later. */
  line: number; name: string; category: string; pricePaise: number; openPrice: boolean; station: string; kot: boolean;
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
      rows.push(row); // blank lines kept, so row numbers match the spreadsheet
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  while (rows.length && rows[rows.length - 1].every((c) => !c.trim())) rows.pop();
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

/** "Billing name", "GST 18%", "No GST (liquor)", "No GST"; also "5%", "GST5", "18", "Nil", "Exempt", "Liquor", "Non-GST". */
export function readTax(t: string): Tax | null {
  const s = norm(t).replace(/[@()]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (s.startsWith('billing name') || s.startsWith('food gst') || s === 'billing' || s === 'default' || s === 'as per billing name') return { mode: 'billing', bp: null };
  if (/liquor|alcohol|non[- ]?gst|\bvat\b/.test(s)) return { mode: 'liquor', bp: null };
  if (/^(no gst|no tax|nil|nil rated|exempt|exempted|none|-)$/.test(s) || s.startsWith('no gst')) return { mode: 'none', bp: null };
  const m = /^(?:gst|igst|tax)?\s*(\d+(?:\.\d+)?)\s*%?$/.exec(s) ?? /^(\d+(?:\.\d+)?)\s*%?\s*gst$/.exec(s);
  if (m && [0, 5, 12, 18, 28, 40].includes(Number(m[1]))) return Number(m[1]) === 0 ? { mode: 'none', bp: null } : { mode: 'rate', bp: Number(m[1]) * 100 };
  return null;
}
/** A Station cell that means the item makes no KOT (on the bill only). */
export const isNoKot = (t: string) => /^(no kot|no-kot|nokot|none|no|not sent|bill only|counter only|-)$/.test(norm(t));
/** "Kitchen" or "Bar", and the usual other words for them (for a station not named that way). */
export function readStation(t: string): 'kitchen' | 'bar' | null {
  const s = norm(t);
  if (/^(kitchen|k|kot|food|restaurant|tandoor|chinese|main kitchen|cafe|bakery)$/.test(s) || s.includes('kitchen')) return 'kitchen';
  if (/^(bar|b|bot|bar counter|liquor|drinks|beverage bar)$/.test(s) || /\bbar\b/.test(s)) return 'bar';
  return null;
}
const YES = /^(yes|y|true|1|open|typed|at billing)$/i;
/** Price cells that mean "typed at billing": MRP, market price, at actuals. */
const OPEN_WORDS = /^(mrp|as per mrp|market price|mp|at actual|at actuals|as per actual|variable|open|price at billing|on request)$/i;

export const taxText = (t: Tax) => (t.mode === 'billing' ? 'Billing name' : t.mode === 'rate' ? `GST ${t.bp! / 100}%` : t.mode === 'liquor' ? 'No GST (liquor)' : 'No GST');
const taxKey = (t: Tax) => `${t.mode}:${t.bp ?? ''}`;

/** "Full +₹150" (adds 150 on every dish), "Full ₹450" (this dish's own price), or "Full". */
const opt = (o: string) => {
  const m = /^(.*?)\s*(?:(\+)\s*)?(?:(?:₹|Rs\.?)\s*([\d.,]+))?$/i.exec(o.trim())!;
  const amount = m[3] ? money(m[3]) : undefined;
  return { name: m[1].trim(), plus: !!m[2] && !!m[3], amount, bad: amount === null };
};
/**
 * The "Add-ons & choices" column, groups split by ";":
 *   Extra Cheese +₹50                         an extra, ₹50 on every dish
 *   Extra Cheese ₹80                          an extra at this dish's own price
 *   Choose one: Half ₹300 / Full ₹450         a choice (named "Half or Full") with this dish's own prices
 *   Choose one: Half / Full +₹150             a choice; Full adds ₹150 on every dish
 *   Tandoori size: Half ₹300 / Full ₹450      a choice with its own name
 *   Toppings (any): Olives +₹20 / Corn +₹20   extras under one name
 *   Tandoori size                             an add-on already set up, as it is
 */
export function readGroups(t: string): GroupRef[] | string {
  const out: GroupRef[] = [];
  for (const x of t.split(';').map((s) => s.trim()).filter(Boolean)) {
    const head = /^(.+?)\s*:\s*(.+)$/.exec(x);
    if (head) {
      const any = /\(any\)$/i.test(head[1]);
      const label = head[1].replace(/\(any\)$/i, '').trim();
      const options = head[2].split('/').map(opt);
      if (options.some((o) => !o.name || o.bad)) return `"${x}": each option needs a name and, if it has one, a price like ₹300 or +₹50`;
      if (!any && options.length < 2) return `"${x}": a choice needs two or more options`;
      const plus = options.some((o) => o.plus), own = options.some((o) => !o.plus && o.amount !== undefined);
      if (plus && own) return `"${x}": write either prices for this dish (₹300) or amounts added on every dish (+₹150), not both`;
      if (own && !any && options.some((o) => o.amount === undefined)) return `"${x}": give a price for each choice`;
      const name = /^choose one$/i.test(label) ? options.map((o) => o.name).join(' or ') : label;
      const def: Group = { name, kind: any ? 'any' : 'one', options: options.map((o) => ({ name: o.name, addPaise: o.plus || (own && any) ? o.amount ?? 0 : 0 })) };
      out.push(own ? { name, def, loose: true, prices: Object.fromEntries(options.filter((o) => o.amount !== undefined).map((o) => [priceKey(o.name), o.amount!])) } : { name, def });
      continue;
    }
    const o = opt(x);
    if (!o.name || o.bad) return `"${x}" should look like "Extra Cheese +₹50"`;
    if (o.amount === undefined) out.push({ name: o.name, def: null });
    else {
      const def: Group = { name: o.name, kind: 'any', options: [{ name: o.name, addPaise: o.amount! }] };
      out.push(o.plus ? { name: o.name, def } : { name: o.name, def, loose: true, prices: { [priceKey(o.name)]: o.amount! } });
    }
  }
  return out;
}
/** How a group is written in the sheet (the reverse of readGroups). */
export function groupText(g: Group, prices?: Prices | null): string {
  if (prices && Object.keys(prices).length) {
    const own = (x: Group['options'][number]) => `${x.name} ${rs(prices[priceKey(x.name)] ?? x.addPaise)}`;
    if (g.kind === 'any' && g.options.length === 1 && norm(g.options[0].name) === norm(g.name)) return own(g.options[0]);
    const label = g.kind === 'one' && norm(g.name) === norm(g.options.map((x) => x.name).join(' or ')) ? 'Choose one' : `${g.name}${g.kind === 'any' ? ' (any)' : ''}`;
    return `${label}: ${g.options.map(own).join(' / ')}`;
  }
  const o = (x: Group['options'][number]) => `${x.name}${x.addPaise ? ` +${rs(x.addPaise)}` : ''}`;
  if (g.kind === 'any' && g.options.length === 1 && norm(g.options[0].name) === norm(g.name) && g.options[0].addPaise) return o(g.options[0]);
  if (g.kind === 'one' && norm(g.name) === norm(g.options.map((x) => x.name).join(' or '))) return `Choose one: ${g.options.map(o).join(' / ')}`;
  return `${g.name}${g.kind === 'any' ? ' (any)' : ''}: ${g.options.map(o).join(' / ')}`;
}

/**
 * Add-ons and choices in the sheet: off for now (owner, 19 Nov 2026). The upload neither reads nor writes them, and
 * leaves the add-ons already on each dish as they are; they are set in Settings → Add-ons. The reading below stays for
 * when they come back (readSheet with { addons: true }).
 */
export const SHEET_ADDONS = false;
const ALL_FIELDS = ['item', 'category', 'price', 'open', 'min', 'tax', 'station', 'sac', 'addons'] as const;
export type Field = (typeof ALL_FIELDS)[number];
export const FIELDS: readonly Field[] = SHEET_ADDONS ? ALL_FIELDS : ALL_FIELDS.filter((f) => f !== 'addons');
const ALL_HEADER = ['Item', 'Category', 'Price (₹)', 'Price at billing', 'Lowest price (₹)', 'Tax', 'Station', 'SAC', 'Add-ons & choices'];
export const HEADER = SHEET_ADDONS ? ALL_HEADER : ALL_HEADER.slice(0, -1);
export type Columns = Record<Field, number>;
export const FIELD_NAMES: Record<Field, string> = { item: 'Item', category: 'Category', price: 'Price', open: 'Price at billing', min: 'Lowest price',
  tax: 'Tax (GST)', station: 'Station', sac: 'SAC', addons: 'Add-ons & choices' };
// The headings each column is known by, in other POS exports and hand-made sheets. Compared without capitals, spaces,
// dots or symbols; the first heading that matches wins, so an exact heading is never taken by a looser one.
const KNOWN: Record<Field, string[]> = {
  item: ['item', 'name', 'item name', 'itemname', 'dish', 'dish name', 'product', 'product name', 'description', 'menu item', 'particulars'],
  category: ['category', 'category name', 'group', 'group name', 'item group', 'section', 'department', 'dept', 'menu group', 'menu category', 'sub category'],
  price: ['price', 'price (₹)', 'price (rs)', 'rate', 'rate (₹)', 'selling price', 'sale price', 'sp', 'mrp', 'amount', 'price inr', 'base price', 'dine in price', 'unit price'],
  open: ['price at billing', 'open price', 'variable price', 'open rate', 'price typed', 'ask price'],
  min: ['lowest price', 'lowest price (₹)', 'minimum price', 'min price', 'floor price'],
  tax: ['tax', 'gst', 'gst %', 'gst rate', 'tax rate', 'tax %', 'tax slab', 'gst slab', 'tax type', 'tax category'],
  station: ['station', 'kot', 'kitchen', 'printer', 'kot printer', 'counter', 'section printer', 'kitchen station', 'prep station'],
  sac: ['sac', 'hsn', 'hsn/sac', 'hsn sac', 'sac code', 'hsn code'],
  addons: ['add-ons & choices', 'add-ons', 'addons', 'add ons', 'modifiers', 'variants', 'options', 'extras', 'toppings'],
};
const squash = (h: string) => norm(h).replace(/[^a-z0-9%₹/&]+/g, ' ').trim();
/** Which column is which, from the headings. -1: not in the file. */
export function guessColumns(head: string[], fields: readonly Field[] = FIELDS): Columns {
  const out = Object.fromEntries(ALL_FIELDS.map((f) => [f, -1])) as Columns;
  const taken = new Set<number>();
  const hs = head.map(squash);
  // Exact headings first, field by field, then the known other names, so "Price" and "Rate" in one file go where they belong.
  for (const pass of [0, 1]) for (const f of fields) {
    if (out[f] >= 0) continue;
    const names = pass === 0 ? [squash(ALL_HEADER[ALL_FIELDS.indexOf(f)]), squash(FIELD_NAMES[f])] : KNOWN[f].map(squash);
    for (const n of names) {
      const i = hs.findIndex((h, k) => !taken.has(k) && h === n);
      if (i >= 0) { out[f] = i; taken.add(i); break; }
    }
  }
  return out;
}

export interface Defaults { [category: string]: { tax?: string; station?: string } }
export interface SheetResult {
  rows: Row[]; errors: string[]; headings: string[]; columns: Columns;
  /** Categories with rows that have no tax or no station: chosen once for the whole category. */
  needs: { category: string; tax: boolean; station: boolean; items: number }[];
  /** Whether add-ons were read; when not, the upload keeps each dish's add-ons as they are. */
  addons?: boolean;
}

/**
 * Reads the sheet. Columns are taken from `columns` when given (chosen on screen), else guessed from the headings.
 * A blank or missing Tax or Station is taken from `defaults` for the row's category, or asked for; never guessed.
 * Every bad row is reported (row number as in the spreadsheet), not just the first.
 */
export function readSheet(rows: string[][], opts: { columns?: Partial<Columns>; defaults?: Defaults; addons?: boolean } = {}): SheetResult {
  const withAddons = opts.addons ?? SHEET_ADDONS;
  const fields = withAddons ? ALL_FIELDS : FIELDS;
  const empty = Object.fromEntries(ALL_FIELDS.map((f) => [f, -1])) as Columns;
  if (!rows.some((r) => r.some((v) => v.trim()))) return { rows: [], errors: ['The file is empty.'], headings: [], columns: empty, needs: [] };
  // The heading row: the first row that names an item column (a title line or a blank line above it is skipped).
  let h = rows.slice(0, 10).findIndex((r) => guessColumns(r, fields).item >= 0);
  if (h < 0) h = 0;
  const head = rows[h];
  const data = rows.slice(h + 1);
  const c = { ...guessColumns(head, fields), ...Object.fromEntries(Object.entries(opts.columns ?? {})
    .filter(([k, v]) => (fields as readonly string[]).includes(k) && typeof v === 'number' && v >= -1 && v < head.length)) } as Columns;
  if (!withAddons) c.addons = -1;
  const base = { headings: head, columns: c, needs: [] as SheetResult['needs'], addons: withAddons };
  const missing = (['item', 'price'] as const).filter((k) => c[k] < 0);
  if (missing.length) return { ...base, rows: [], errors: [`Choose which column is the ${missing.map((k) => FIELD_NAMES[k]).join(' and the ')}.`] };
  if (data.length > 2000) return { ...base, rows: [], errors: ['The file has more than 2,000 items.'] };
  const defaults = new Map(Object.entries(opts.defaults ?? {}).map(([k, v]) => [norm(k), v]));
  const errors: string[] = [];
  const out: Row[] = [];
  const seen = new Map<string, number>();
  const needs = new Map<string, SheetResult['needs'][number]>();
  let lastCategory = '';
  data.forEach((r, i) => {
    const line = h + i + 2;
    const get = (k: number) => (k < 0 ? '' : (r[k] ?? '').trim());
    const name = get(c.item).replace(/^'(?=[=+\-@])/, '');
    // A row with a name but nothing else under a "category" layout (a heading row inside the list) sets the category.
    if (name && c.category < 0 && r.every((v, k) => k === c.item || !v.trim())) { lastCategory = name; return; }
    if (!name && r.every((v) => !v.trim())) return;
    const bad = (why: string) => errors.push(`Row ${line}${name ? ` (${name})` : ''}: ${why}`);
    const category = (c.category >= 0 ? get(c.category) : '') || lastCategory || 'Menu';
    if (c.category >= 0 && get(c.category)) lastCategory = get(c.category);
    if (!name || name.length > 80) return bad('the item name must be 1 to 80 characters.');
    if (category.length > 40) return bad('the category must be at most 40 characters.');
    const key = `${norm(name)}|${norm(category)}`;
    if (seen.has(key)) return bad(`the same item and category as row ${seen.get(key)}.`);
    seen.set(key, line);
    const groups = readGroups(get(c.addons));
    if (typeof groups === 'string') return bad(groups);
    if (groups.length > 10) return bad('at most 10 add-ons on one item.');
    const priceCell = get(c.price).replace(/\/-$/, '').trim();
    const openPrice = YES.test(get(c.open)) || OPEN_WORDS.test(priceCell);
    // A dish whose choice carries its prices (Half ₹300 / Full ₹450) takes its price from the first choice.
    const choicePriced = groups.some((g) => g.def?.kind === 'one' && g.prices);
    const p = priceCell && !OPEN_WORDS.test(priceCell) ? money(priceCell) : openPrice || choicePriced ? 0 : null;
    if (p === null) return bad(priceCell ? `"${get(c.price)}" is not a price.` : 'no price, and not price at billing.');
    let minPricePaise: number | null | undefined;
    if (c.min >= 0) {
      minPricePaise = get(c.min) ? money(get(c.min)) : null;
      if (get(c.min) && minPricePaise === null) return bad(`lowest price "${get(c.min)}" is not a price.`);
      if (!openPrice) minPricePaise = null;
    }
    const d = defaults.get(norm(category)) ?? {};
    const taxCell = get(c.tax);
    const tax = readTax(taxCell || d.tax || '');
    if (taxCell && !readTax(taxCell)) return bad(`tax "${taxCell}" should be Billing name, GST 5% (or 12, 18, 28, 40), No GST (liquor) or No GST.`);
    const st = get(c.station) || d.station || '';
    if (!tax || !st) {
      const n = needs.get(norm(category)) ?? { category, tax: false, station: false, items: 0 };
      n.tax ||= !tax; n.station ||= !st; n.items++;
      needs.set(norm(category), n);
      return;
    }
    const sac = c.sac >= 0 && get(c.sac) ? get(c.sac) : undefined;
    if (sac !== undefined && !/^\d{4,8}$/.test(sac)) return bad('SAC must be 4 to 8 digits.');
    out.push({ line, name, category, pricePaise: p, openPrice, station: isNoKot(st) ? '' : st, kot: !isNoKot(st), tax, groups, minPricePaise, sac });
  });
  return { ...base, rows: out, errors, needs: [...needs.values()] };
}

/** A small sheet with invented rows, showing every column and the forms each one takes. */
export function sampleSheet(): string {
  return toCsv([HEADER,
    ['Paneer Tikka', 'Starters', '280', '', '', 'Billing name', 'Kitchen', '996332'],
    ['Veg Burger', 'Snacks', '160', '', '', 'Billing name', 'Kitchen', ''],
    ['Tandoori Chicken', 'Tandoor', '300', '', '', 'Billing name', 'Kitchen', ''],
    ['Masala Dosa', 'South Indian', '150', '', '', 'Billing name', 'Kitchen', ''],
    ['Beer 650 ml', 'Bar', '320', '', '', 'No GST (liquor)', 'Bar', ''],
    ['Whisky bottle 750 ml', 'Bar', '', 'Yes', '3500', 'No GST (liquor)', 'Bar', ''],
    ['Fresh Lime Soda', 'Bar', '90', '', '', 'Billing name', 'Bar', ''],
    ['Cigarette (single)', 'Cigarettes', '20', '', '', 'No GST', 'No KOT', ''],
    ['Pool Table (per hour)', 'Games', '300', '', '', 'GST 18%', 'No KOT', '999692'],
    ['Locker deposit', 'Hotel', '200', '', '', 'No GST', 'No KOT', ''],
  ].map((r) => r.slice(0, HEADER.length)));
}

// ---------- the plan: what an upload would change, worked out against the menu as it is

export interface ExistingItem {
  id: string; name: string; category: string; pricePaise: number; station: string; sac: string; taxMode: TaxMode | null; gstBp: number | null;
  openPrice: boolean; minPricePaise: number | null; active: boolean; groups: string[]; createdAt: number;
  /** This dish's own prices for each of its add-ons (same order as groups), or null. */
  groupPrices?: (Prices | null)[];
  /** Its own KOT setting and station; null: from its category. */
  kot?: number | null; stationId?: string | null;
}
export interface Station { id: string; name: string; isBar: boolean; active: boolean }
export interface Existing {
  items: ExistingItem[]; categories: { name: string; taxMode: TaxMode; gstBp: number | null; kot?: number; stationId?: string | null }[];
  groups: (Group & { id: string })[]; stations?: Station[];
}

export interface PlanItem {
  id: string | null; name: string; category: string; pricePaise: number; station: string; sac: string; tax: Tax | null;
  openPrice: boolean; minPricePaise: number | null; groups: string[]; groupPrices: (Prices | null)[];
  /** Its own KOT setting and station when they differ from its category's, else null. */
  ownKot: number | null; ownStationId: string | null;
}
/** Where a category's or an item's KOTs go: a station, or none. */
export interface Route { kot: boolean; stationId: string | null }
export interface Plan {
  items: PlanItem[];
  off: { id: string; name: string; category: string }[];
  categories: { name: string; tax: Tax; was: Tax | null; route: Route; routeText: string; wasRoute: string | null }[];
  groups: { name: string; def: Group; was: Group | null }[];
  added: string[]; back: string[]; priceChanges: { name: string; from: number; to: number }[]; otherChanges: { name: string; what: string[] }[];
  notes: string[]; errors: string[];
}

const effective = (t: { taxMode: TaxMode | null; gstBp: number | null }, cat: Tax | undefined): Tax =>
  t.taxMode ? { mode: t.taxMode, bp: t.gstBp } : cat ?? { mode: 'billing', bp: null };

export function plan(sheet: { rows: Row[]; errors: string[]; needs?: SheetResult['needs']; addons?: boolean }, now: Existing): Plan {
  // Add-ons not in the sheet (for now): each dish keeps the add-ons and own prices it has; new dishes start with none.
  const keepAddons = sheet.addons === false;
  const errors = [...sheet.errors];
  for (const n of sheet.needs ?? []) errors.push(`${n.category}: choose ${[n.tax && 'the GST', n.station && 'the station'].filter(Boolean).join(' and ')} for its ${n.items} item${n.items === 1 ? '' : 's'} without one.`);
  const rows = sheet.rows;
  // Add-ons: a full form sets the group (the same everywhere it is written); a bare name must already exist. A form with
  // this dish's own prices only names the options: they must match the add-on, which it sets up only if it is new.
  const defs = new Map<string, Group>();
  const loose = new Map<string, { def: Group; line: number; name: string }>();
  for (const r of rows) for (const g of r.groups) {
    if (!g.def) continue;
    if (g.loose) { if (!loose.has(norm(g.name))) loose.set(norm(g.name), { def: g.def, line: r.line, name: r.name }); continue; }
    const had = defs.get(norm(g.name));
    if (had && JSON.stringify(had) !== JSON.stringify(g.def)) errors.push(`Row ${r.line} (${r.name}): add-on "${g.name}" is written differently on another row.`);
    defs.set(norm(g.name), g.def);
  }
  const oldGroups = new Map(now.groups.map((g) => [norm(g.name), g]));
  const shape = (g: Group) => `${g.kind}:${g.options.map((o) => norm(o.name)).join('/')}`;
  for (const r of rows) for (const g of r.groups) {
    if (!g.loose || !g.def) continue;
    const known = defs.get(norm(g.name)) ?? oldGroups.get(norm(g.name)) ?? loose.get(norm(g.name))!.def;
    if (shape(known) !== shape(g.def)) errors.push(`Row ${r.line} (${r.name}): add-on "${g.name}" has ${known.kind === 'one' ? 'the choices' : 'the options'} ${known.options.map((o) => o.name).join(' / ')}; this row has ${g.def.options.map((o) => o.name).join(' / ')}.`);
  }
  for (const [k, l] of loose) if (!defs.has(k) && !oldGroups.has(k)) defs.set(k, l.def);
  for (const r of rows) for (const g of r.groups) {
    if (!g.def && !defs.has(norm(g.name)) && !oldGroups.has(norm(g.name))) errors.push(`Row ${r.line} (${r.name}): there is no add-on called "${g.name}". Write it in full, like "Extra Cheese +₹50".`);
  }
  const groupName = (n: string) => defs.get(norm(n))?.name ?? oldGroups.get(norm(n))?.name ?? n;
  const groupOf = (n: string): Group | undefined => defs.get(norm(n)) ?? oldGroups.get(norm(n));

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
    return { name, tax: top, was: oldCat.get(norm(name)) ?? null, route: { kot: true, stationId: null } as Route, routeText: '', wasRoute: null as string | null };
  });
  const catTax = new Map(categories.map((c) => [norm(c.name), c.tax]));

  // KOT and station, the same way: each row's station is checked against the stations; a category goes where most of its
  // items go, and an item that goes elsewhere (or makes no KOT) keeps its own.
  const stations = (now.stations ?? []).filter((x) => x.active);
  const allStations = now.stations ?? [];
  const stName = (id: string | null | undefined) => allStations.find((x) => x.id === id)?.name ?? 'Kitchen';
  const routeText = (r: Route) => (r.kot ? stName(r.stationId) : 'No KOT');
  const routeKey = (r: Route) => (r.kot ? `k:${r.stationId}` : 'no');
  const findStation = (t: string) => stations.find((x) => norm(x.name) === norm(t))
    ?? (readStation(t) ? stations.find((x) => x.isBar === (readStation(t) === 'bar')) : undefined);
  const rowRoute = new Map<number, Route>();
  for (const r of rows) {
    if (!r.kot) { rowRoute.set(r.line, { kot: false, stationId: null }); continue; }
    const st = findStation(r.station);
    if (!st) { errors.push(`Row ${r.line} (${r.name}): there is no station called "${r.station}". Use one of ${stations.map((x) => x.name).join(', ')} or No KOT, or add it in Settings → Stations first.`); continue; }
    rowRoute.set(r.line, { kot: true, stationId: st.id });
  }
  const oldCatRoute = new Map(now.categories.map((c) => [norm(c.name), { kot: c.kot !== 0, stationId: c.stationId ?? null } as Route]));
  const catRoute = new Map<string, Route>();
  for (const k of categories) {
    const count = new Map<string, { r: Route; n: number }>();
    for (const r of rows.filter((x) => norm(x.category) === norm(k.name) && rowRoute.has(x.line))) {
      const rr = rowRoute.get(r.line)!;
      count.set(routeKey(rr), { r: rr, n: (count.get(routeKey(rr))?.n ?? 0) + 1 });
    }
    const top = [...count.values()].sort((a, b) => b.n - a.n)[0]?.r ?? { kot: true, stationId: stations.find((x) => !x.isBar)?.id ?? null };
    // A no-KOT category still names a station (its old one, else the first kitchen), for items that print after all.
    const route = top.kot ? top : { kot: false, stationId: oldCatRoute.get(norm(k.name))?.stationId ?? stations.find((x) => !x.isBar)?.id ?? null };
    catRoute.set(norm(k.name), route);
    const own = rows.filter((x) => norm(x.category) === norm(k.name) && rowRoute.has(x.line) && routeKey(rowRoute.get(x.line)!) !== routeKey(top));
    if (own.length) notes.push(`${k.name}: KOT to ${routeText(top)} for the category; set on the item: ${own.map((x) => `${x.name} (${routeText(rowRoute.get(x.line)!)})`).join(', ')}.`);
    const was = oldCatRoute.get(norm(k.name));
    Object.assign(k, { route, routeText: routeText(top), wasRoute: was ? routeText(was) : null });
  }

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
    const gnames = keepAddons ? x?.groups ?? [] : r.groups.map((g) => g.name);
    const groupPrices = keepAddons ? x?.groupPrices ?? gnames.map(() => null) : r.groups.map((g) => g.prices ?? null);
    const base = r.openPrice ? null : basePrice(gnames.map((n, i) => ({ kind: groupOf(n)?.kind ?? 'any', options: groupOf(n)?.options ?? [], prices: groupPrices[i] ?? null })));
    if (keepAddons && base !== null && base !== r.pricePaise && x) notes.push(`${r.name}: its price comes from its ${gnames.find((n) => groupOf(n)?.kind === 'one')} prices (${rs(base)}), set in Settings → Add-ons; the file's ${rs(r.pricePaise)} is not used.`);
    const route = rowRoute.get(r.line) ?? { kot: true, stationId: null };
    const cr = catRoute.get(norm(r.category))!;
    const bar = allStations.find((s2) => s2.id === (route.kot ? route.stationId : cr.stationId))?.isBar ?? false;
    const p: PlanItem = { id: x?.id ?? null, name: r.name, category: r.category, pricePaise: base ?? r.pricePaise, station: bar ? 'bar' : 'kitchen',
      ownKot: route.kot === cr.kot ? null : route.kot ? 1 : 0, ownStationId: route.kot && route.stationId !== cr.stationId ? route.stationId : null,
      sac: r.sac ?? x?.sac ?? (/^room tariff$/i.test(r.name) ? '996311' : '996332'), tax, openPrice: r.openPrice,
      minPricePaise: r.minPricePaise !== undefined ? r.minPricePaise : r.openPrice ? x?.minPricePaise ?? null : null, groups: gnames.map((n) => groupName(n)), groupPrices };
    if (!x) { added.push(r.name); return p; }
    if (!x.active) back.push(r.name);
    if (!r.openPrice && x.pricePaise !== p.pricePaise) priceChanges.push({ name: r.name, from: x.pricePaise, to: p.pricePaise });
    const what: string[] = [];
    if (x.name !== r.name) what.push(`name "${x.name}" → "${r.name}"`);
    if (x.category !== r.category) what.push(`category ${x.category} → ${r.category}`);
    const xc = oldCatRoute.get(norm(x.category));
    const xRoute: Route = { kot: (x.kot ?? (xc?.kot === false ? 0 : 1)) !== 0, stationId: x.stationId ?? xc?.stationId ?? null };
    if (now.stations && routeText(xRoute) !== routeText(route)) what.push(`KOT ${routeText(xRoute)} → ${routeText(route)}`);
    const was = effective(x, oldCat.get(norm(x.category)));
    if (taxKey(was) !== taxKey(r.tax)) what.push(`tax ${taxText(was)} → ${taxText(r.tax)}`);
    if (x.openPrice !== r.openPrice) what.push(r.openPrice ? 'price now typed at billing' : `fixed price ${rs(p.pricePaise)}`);
    if (r.openPrice && x.minPricePaise !== p.minPricePaise) what.push(`lowest price ${x.minPricePaise === null ? 'none' : rs(x.minPricePaise)} → ${p.minPricePaise === null ? 'none' : rs(p.minPricePaise)}`);
    if (x.sac !== p.sac) what.push(`SAC ${x.sac} → ${p.sac}`);
    const g0 = x.groups.join(', '), g1 = p.groups.join(', ');
    if (norm(g0) !== norm(g1)) what.push(`add-ons ${g0 || 'none'} → ${g1 || 'none'}`);
    else {
      const pricesOf = (gs: string[], ps: (Prices | null)[] | undefined) => JSON.stringify(gs.map((n, i) => [norm(n), ps?.[i] ?? null]));
      const changed = p.groups.filter((n, i) => pricesOf([n], [groupPrices[i]]) !== pricesOf([x.groups[i]], [x.groupPrices?.[i] ?? null]));
      if (changed.length) what.push(`own prices for ${changed.join(', ')}`);
    }
    if (what.length) otherChanges.push({ name: r.name, what });
    return p;
  });
  const off = now.items.filter((i) => i.active && !used.has(i.id)).map((i) => ({ id: i.id, name: i.name, category: i.category }));
  const groups = [...defs.values()].map((def) => {
    const was = oldGroups.get(norm(def.name));
    return { name: def.name, def, was: was ? { name: was.name, kind: was.kind, options: was.options.map((o) => ({ name: o.name, addPaise: o.addPaise })) } : null };
  });
  if (!rows.length && !errors.length && !sheet.needs?.length) errors.push('The file has no items.');
  return { items, off, categories, groups, added, back, priceChanges, otherChanges, notes, errors };
}

/** The menu as the sheet, for download (active items only). */
export function sheetOf(now: Existing): string {
  const cat = new Map(now.categories.map((c) => [norm(c.name), { mode: c.taxMode, bp: c.gstBp } as Tax]));
  const catR = new Map(now.categories.map((c) => [norm(c.name), c]));
  const route = (i: ExistingItem) => {
    const c = catR.get(norm(i.category));
    if ((i.kot ?? c?.kot ?? 1) === 0) return 'No KOT';
    const st = (now.stations ?? []).find((s) => s.id === (i.stationId ?? c?.stationId));
    return st?.name ?? (i.station === 'bar' ? 'Bar' : 'Kitchen');
  };
  const gs = new Map(now.groups.map((g) => [norm(g.name), g]));
  const items = now.items.filter((i) => i.active);
  const order = now.categories.map((c) => norm(c.name));
  items.sort((a, b) => (order.indexOf(norm(a.category)) + 1 || 1e9) - (order.indexOf(norm(b.category)) + 1 || 1e9) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return toCsv([HEADER, ...items.map((i) => [i.name, i.category, i.openPrice ? '' : (i.pricePaise / 100).toFixed(2).replace(/\.00$/, ''), i.openPrice ? 'Yes' : '',
    i.openPrice && i.minPricePaise !== null ? (i.minPricePaise / 100).toFixed(2).replace(/\.00$/, '') : '', taxText(effective(i, cat.get(norm(i.category)))),
    route(i), i.sac, ...(SHEET_ADDONS ? [i.groups.map((n, k) => { const g = gs.get(norm(n)); return g ? groupText(g, i.groupPrices?.[k]) : n; }).join('; ')] : [])])]);
}
