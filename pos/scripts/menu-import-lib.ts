// Reads the cleaned menu sheet (CSV export) into categories, items and add-ons, ready to load. Pure: tested in
// pos/test/menu-import.test.ts with invented rows. The owner's own menu file is never kept in the repo.

export type TaxMode = 'billing' | 'rate' | 'liquor' | 'none';
export interface Tax { mode: TaxMode; bp: number | null }
export interface AddonGroup { name: string; kind: 'one' | 'any'; options: { name: string; addPaise: number }[] }
export interface ImportItem {
  name: string; category: string; pricePaise: number; station: 'kitchen' | 'bar'; sac: string;
  /** null: the item follows its category. */
  tax: Tax | null; openPrice: boolean; groups: string[];
}
export interface ImportMenu { categories: { name: string; tax: Tax }[]; items: ImportItem[]; groups: AddonGroup[]; notes: string[] }

/** A small CSV reader: quoted fields, doubled quotes, commas and new lines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const rupeesToPaise = (t: string, what: string): number => {
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(t.replace(/[₹,\s]|Rs\.?/g, ''));
  if (!m) throw new Error(`${what}: "${t}" is not a price`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
};

/** The sheet's Tax column: "Billing name (5%)", "GST 18%", "No GST (liquor)", "No GST", "No GST (not a sale)". */
export function taxOf(t: string, where: string): Tax {
  const s = t.trim().toLowerCase();
  if (s.startsWith('billing name')) return { mode: 'billing', bp: null };
  if (s.includes('liquor')) return { mode: 'liquor', bp: null };
  if (s.startsWith('no gst')) return { mode: 'none', bp: null };
  const m = /^gst\s*(\d+)\s*%$/.exec(s);
  if (m && [0, 5, 12, 18, 28, 40].includes(Number(m[1]))) return { mode: 'rate', bp: Number(m[1]) * 100 };
  throw new Error(`${where}: tax "${t}" is not one of: Billing name, GST n%, No GST (liquor), No GST`);
}
const taxKey = (t: Tax) => `${t.mode}:${t.bp ?? ''}`;

/**
 * The sheet's "Add-ons & choices" column, groups split by ";":
 *   "Extra Cheese +₹50"               → an extra, offered on its own
 *   "Choose one: Half / Full +₹150"   → a choice; the first option is the listed price, the others add what they say
 */
export function addonsOf(t: string, where: string): AddonGroup[] {
  return t.split(';').map((x) => x.trim()).filter(Boolean).map((x) => {
    const one = /^choose one:\s*(.+)$/i.exec(x);
    if (one) {
      const options = one[1].split('/').map((o) => {
        const m = /^(.*?)\s*(?:\+\s*(?:₹|Rs\.?)\s*([\d.,]+))?$/.exec(o.trim())!;
        return { name: m[1].trim(), addPaise: m[2] ? rupeesToPaise(m[2], where) : 0 };
      });
      if (options.length < 2 || options.some((o) => !o.name)) throw new Error(`${where}: "${x}" needs two or more choices`);
      return { name: options.map((o) => o.name).join(' or '), kind: 'one' as const, options };
    }
    const m = /^(.*?)\s*\+\s*(?:₹|Rs\.?)\s*([\d.,]+)$/.exec(x);
    if (!m || !m[1].trim()) throw new Error(`${where}: add-on "${x}" should look like "Extra Cheese +₹50"`);
    const name = m[1].trim();
    return { name, kind: 'any' as const, options: [{ name, addPaise: rupeesToPaise(m[2], where) }] };
  });
}

/** Rows of the sheet → what to load. A category takes the tax most of its items have; the others keep their own. */
export function readMenu(rows: string[][]): ImportMenu {
  const [head, ...data] = rows;
  const col = (...names: string[]) => {
    const i = head.findIndex((h) => names.some((n) => h.trim().toLowerCase() === n.toLowerCase()));
    if (i < 0) throw new Error(`The sheet has no "${names[0]}" column`);
    return i;
  };
  const c = { item: col('Item'), price: col('Price (₹)', 'Price (Rs)', 'Price'), open: col('Price at billing'), tax: col('Tax'),
    cat: col('Category'), station: col('Station'), addons: col('Add-ons & choices', 'Add-ons') };
  const notes: string[] = [];
  const groups = new Map<string, AddonGroup>();
  const raw = data.map((r, i) => {
    const where = `Row ${i + 2} (${(r[c.item] ?? '').trim() || 'no name'})`;
    const name = (r[c.item] ?? '').trim().replace(/^'/, '');
    const category = (r[c.cat] ?? '').trim();
    if (!name || name.length > 80) throw new Error(`${where}: item name must be 1 to 80 characters`);
    if (!category || category.length > 40) throw new Error(`${where}: category must be 1 to 40 characters`);
    const openPrice = /^yes$/i.test((r[c.open] ?? '').trim());
    const priceText = (r[c.price] ?? '').trim();
    const pricePaise = priceText ? rupeesToPaise(priceText, where) : openPrice ? 0 : (() => { throw new Error(`${where}: no price, and not price at billing`); })();
    const st = (r[c.station] ?? '').trim().toLowerCase();
    if (st !== 'kitchen' && st !== 'bar') throw new Error(`${where}: station must be Kitchen or Bar`);
    const gs = addonsOf(r[c.addons] ?? '', where);
    for (const g of gs) {
      const had = groups.get(g.name.toLowerCase());
      if (had && JSON.stringify(had) !== JSON.stringify(g)) throw new Error(`${where}: add-on "${g.name}" has a different price elsewhere`);
      groups.set(g.name.toLowerCase(), g);
    }
    // Room tariff is accommodation (SAC 996311); everything else is food and drink service (996332).
    const sac = /^room tariff$/i.test(name) ? '996311' : '996332';
    return { name, category, pricePaise, station: st as 'kitchen' | 'bar', sac, tax: taxOf(r[c.tax] ?? '', where), openPrice, groups: gs.map((g) => g.name) };
  });
  const cats = [...new Set(raw.map((r) => r.category))];
  const categories = cats.map((name) => {
    const count = new Map<string, { tax: Tax; n: number }>();
    for (const r of raw.filter((x) => x.category === name)) {
      const k = taxKey(r.tax);
      count.set(k, { tax: r.tax, n: (count.get(k)?.n ?? 0) + 1 });
    }
    const top = [...count.values()].sort((a, b) => b.n - a.n)[0];
    if (count.size > 1) notes.push(`${name}: GST is ${describe(top.tax)} for the category; ${raw.filter((x) => x.category === name && taxKey(x.tax) !== taxKey(top.tax)).map((x) => `${x.name} (${describe(x.tax)})`).join(', ')} set on the item`);
    return { name, tax: top.tax };
  });
  const catTax = new Map(categories.map((x) => [x.name, taxKey(x.tax)]));
  const items = raw.map((r) => ({ ...r, tax: taxKey(r.tax) === catTax.get(r.category) ? null : r.tax }));
  return { categories, items, groups: [...groups.values()], notes };
}

export function describe(t: Tax): string {
  return t.mode === 'billing' ? 'the billing name rate' : t.mode === 'rate' ? `GST ${t.bp! / 100}%` : t.mode === 'liquor' ? 'liquor, outside GST' : 'no GST';
}

const lit = (v: string | number | null) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`);

/**
 * SQL that loads the menu for one business, all in one go: the items now on the menu are taken off it (kept, as old bills
 * point at them), categories get their GST, add-ons with the same name are updated in place, and the new items go in.
 */
export function importSql(menu: ImportMenu, businessId: string, newId: () => string, at: number): string[] {
  const B = lit(businessId);
  const out: string[] = [`UPDATE menu_items SET active = 0 WHERE business_id = ${B} AND active = 1;`];
  menu.categories.forEach((c, i) => {
    out.push(`UPDATE menu_categories SET tax_mode = ${lit(c.tax.mode)}, gst_bp = ${lit(c.tax.bp)}, sort = ${i} WHERE business_id = ${B} AND lower(name) = lower(${lit(c.name)});`);
    out.push(`INSERT OR IGNORE INTO menu_categories (id, business_id, name, tax_mode, gst_bp, sort, created_at) VALUES (${lit(newId())}, ${B}, ${lit(c.name)}, ${lit(c.tax.mode)}, ${lit(c.tax.bp)}, ${i}, ${at});`);
  });
  const group = (name: string) => `(SELECT id FROM addon_groups WHERE business_id = ${B} AND lower(name) = lower(${lit(name)}))`;
  for (const g of menu.groups) {
    out.push(`INSERT OR IGNORE INTO addon_groups (id, business_id, name, kind, created_at) VALUES (${lit(newId())}, ${B}, ${lit(g.name)}, ${lit(g.kind)}, ${at});`);
    out.push(`UPDATE addon_groups SET kind = ${lit(g.kind)} WHERE id = ${group(g.name)};`);
    out.push(`DELETE FROM addon_options WHERE group_id = ${group(g.name)};`);
    g.options.forEach((o, i) => out.push(`INSERT INTO addon_options (id, business_id, group_id, name, add_paise, sort, active) VALUES (${lit(newId())}, ${B}, ${group(g.name)}, ${lit(o.name)}, ${o.addPaise}, ${i}, 1);`));
  }
  for (const it of menu.items) {
    const id = newId();
    out.push(`INSERT INTO menu_items (id, business_id, name, category, price_paise, sac, station, tax_mode, gst_bp, open_price, min_price_paise, active, created_at) VALUES (${lit(id)}, ${B}, ${lit(it.name)}, ${lit(it.category)}, ${it.pricePaise}, ${lit(it.sac)}, ${lit(it.station)}, ${lit(it.tax?.mode ?? null)}, ${lit(it.tax?.bp ?? null)}, ${it.openPrice ? 1 : 0}, NULL, 1, ${at});`);
    it.groups.forEach((g, i) => out.push(`INSERT INTO menu_item_addons (item_id, group_id, business_id, sort) VALUES (${lit(id)}, ${group(g)}, ${B}, ${i});`));
  }
  out.push(`INSERT INTO audit_log (business_id, staff_id, action, row_table, row_id, before, after, created_at) VALUES (${B}, NULL, 'menu.import', 'menu_items', ${B}, NULL, ${lit(JSON.stringify({ items: menu.items.length, categories: menu.categories.length, addons: menu.groups.length }))}, ${at});`);
  return out;
}
