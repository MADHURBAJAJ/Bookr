// The menu as a sheet: download, check, apply. All rows invented.
import { afterAll, describe, expect, it } from 'vitest';
import { groupText, parseCsv, readGroups, readSheet, readTax } from '../src/menu-sheet';
import { app } from '../src/app';
import { Client, dispose, env, q, setupBusiness } from './helpers';

/** A file download (not JSON). */
async function download(c: Client, path: string) {
  const r = await app.request(`/api${path}`, { headers: { Cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } }, env);
  return { status: r.status, text: await r.text(), type: r.headers.get('Content-Type') };
}

afterAll(dispose);

describe('reading the sheet', () => {
  it('reads taxes, add-ons and every bad row', () => {
    expect(readTax('GST 18%')).toEqual({ mode: 'rate', bp: 1800 });
    expect(readTax('No GST (not a sale)')).toEqual({ mode: 'none', bp: null });
    expect(readTax('VAT')).toBeNull();
    expect(readGroups('Choose one: Steamed / Fried +₹10')).toEqual([{ name: 'Steamed or Fried', def: { name: 'Steamed or Fried', kind: 'one', options: [{ name: 'Steamed', addPaise: 0 }, { name: 'Fried', addPaise: 1000 }] } }]);
    expect(readGroups('Toppings (any): Olives +₹20 / Corn +₹15; Size')).toEqual([
      { name: 'Toppings', def: { name: 'Toppings', kind: 'any', options: [{ name: 'Olives', addPaise: 2000 }, { name: 'Corn', addPaise: 1500 }] } }, { name: 'Size', def: null }]);
    for (const t of ['Extra Cheese +₹50', 'Choose one: Half / Full +₹150', 'Size: Small / Large +₹40', 'Toppings (any): Olives +₹20 / Corn +₹15']) {
      const [g] = readGroups(t) as { def: any }[];
      expect(groupText(g.def)).toBe(t);
    }
    const r = readSheet(parseCsv('Item,Category,Price,Tax,Station\nA,Food,abc,GST 5%,Kitchen\nB,Food,10,VAT,Kitchen\nC,Food,10,GST 5%,Hall\nD,Food,10,GST 5%,Kitchen\nd,food,12,GST 5%,Kitchen\n'));
    expect(r.errors).toEqual([
      'Row 2 (A): "abc" is not a price.', 'Row 3 (B): tax "VAT" should be Billing name, GST 5% (or 12, 18, 28, 40, 0), No GST (liquor) or No GST.',
      'Row 4 (C): station must be Kitchen or Bar.', 'Row 6 (d): the same item and category as row 5.']);
    expect(readSheet(parseCsv('Name,Price\nA,1\n')).errors[0]).toMatch(/missing these columns: Category, Tax, Station/);
  });
});

describe('menu upload', () => {
  it('only the Owner uploads; the downloaded menu uploads back with nothing changed', async () => {
    const s = await setupBusiness();
    const sheet = await download(s.owner, `${s.B}/menu/sheet`);
    expect(sheet).toMatchObject({ status: 200, type: 'text/csv; charset=utf-8' });
    expect((await s.counter.post(`${s.B}/menu/upload/check`, { csv: 'x' })).status).toBe(403);
    const csv = sheet.text;
    expect(csv.split('\n')[0]).toContain('Item,Category,Price (₹),Price at billing,Lowest price (₹),Tax,Station,SAC,Add-ons & choices');
    const r = await s.ok(s.owner.post(`${s.B}/menu/upload/check`, { csv }));
    expect(r).toMatchObject({ ok: true, errors: [], added: [], off: [], back: [], priceChanges: [], otherChanges: [] });
  });

  it('checks, then applies: keeps matched items, adds, takes off, sets category GST and add-ons, and keeps the file', async () => {
    const s = await setupBusiness();
    const menu = (await s.owner.get(`${s.B}/menu`)).json.items.filter((i: any) => i.active);
    const [keep, drop] = menu;
    const csv = [
      'Item,Category,Price (₹),Price at billing,Lowest price (₹),Tax,Station,Add-ons & choices',
      `${keep.name.toUpperCase()},${keep.category},999,,,Billing name,Kitchen,"Extra Cheese +₹50; Choose one: Half / Full +₹150"`,
      ...menu.slice(2).map((i: any) => `${i.name},${i.category},${i.pricePaise / 100},,,Billing name,${i.station},`),
      'Test Bottle,Bar,,Yes,2000,No GST (liquor),Bar,',
      'Test Beer,Bar,300,,,No GST (liquor),Bar,',
      'Test Soda,Bar,60,,,Billing name,Bar,',
      'Test Kit,Hotel,50,,,No GST,Kitchen,Extra Cheese',
    ].join('\n');
    const r = await s.ok(s.owner.post(`${s.B}/menu/upload/check`, { csv }));
    expect(r.ok).toBe(true);
    expect(r.added).toEqual(['Test Bottle', 'Test Beer', 'Test Soda', 'Test Kit']);
    expect(r.off).toEqual([`${drop.name} (${drop.category})`]);
    expect(r.priceChanges).toEqual([{ name: keep.name.toUpperCase(), from: keep.pricePaise, to: 99900 }]);
    expect(r.categories.find((c: any) => c.name === 'Bar').tax).toEqual({ mode: 'liquor', bp: null });
    expect(r.notes).toEqual(['Bar: No GST (liquor) for the category; set on the item: Test Soda (Billing name).']);
    // Nothing changed yet.
    expect((await q('SELECT count(*) AS n FROM menu_items WHERE business_id = ?', s.businessId))[0].n).toBe(menu.length);

    expect((await s.owner.post(`${s.B}/menu/upload/apply`, { csv, planHash: 'stale' })).status).toBe(409);
    expect((await s.counter.post(`${s.B}/menu/upload/apply`, { csv, planHash: r.planHash })).status).toBe(403);
    const done = await s.ok(s.owner.post(`${s.B}/menu/upload/apply`, { csv, planHash: r.planHash }));
    expect(done).toMatchObject({ items: menu.length - 1 + 4, added: 4, off: 1, priceChanges: 1 });

    const m = (await s.owner.get(`${s.B}/menu`)).json;
    const byName = (n: string) => m.items.find((i: any) => i.name === n);
    expect(byName(keep.name.toUpperCase())).toMatchObject({ id: keep.id, pricePaise: 99900, active: 1 });
    expect(byName(drop.name)).toMatchObject({ id: drop.id, active: 0 });
    expect(byName('Test Bottle')).toMatchObject({ openPrice: true, minPricePaise: 200000, taxMode: null });
    expect(byName('Test Soda')).toMatchObject({ taxMode: 'billing' });
    expect(byName('Test Kit').addonGroups).toHaveLength(1);
    expect(m.addonGroups.map((g: any) => g.name).sort()).toEqual(['Extra Cheese', 'Half or Full']);
    expect(m.categories.find((c: any) => c.name === 'Bar')).toMatchObject({ taxMode: 'liquor' });

    // The same file again changes nothing; the file is kept and can be downloaded.
    const again = await s.ok(s.owner.post(`${s.B}/menu/upload/check`, { csv }));
    expect(again).toMatchObject({ added: [], off: [], priceChanges: [], otherChanges: [] });
    const { uploads } = await s.ok(s.owner.get(`${s.B}/menu/uploads`));
    expect(uploads).toHaveLength(1);
    const file = await download(s.owner, `${s.B}/menu/uploads/${uploads[0].name}`);
    expect(file).toMatchObject({ status: 200, text: csv });
    expect((await download(s.owner, `${s.B}/menu/uploads/..%2Fx.csv`)).status).toBe(404);
    expect((await q("SELECT action FROM audit_log WHERE business_id = ? AND action = 'menu.upload'", s.businessId))).toHaveLength(1);
  });

  it('refuses a file with bad rows, and names them', async () => {
    const s = await setupBusiness();
    const r = await s.ok(s.owner.post(`${s.B}/menu/upload/check`, { csv: 'Item,Category,Price,Tax,Station,Add-ons\nA,Food,10,GST 5%,Kitchen,Nonexistent\n' }));
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['Row 2 (A): there is no add-on called "Nonexistent". Write it in full, like "Extra Cheese +₹50".']);
    expect((await s.owner.post(`${s.B}/menu/upload/apply`, { csv: 'Item,Category,Price,Tax,Station\nA,Food,10,GST 5%,Kitchen\n', planHash: r.planHash })).status).toBe(409);
  });
});
