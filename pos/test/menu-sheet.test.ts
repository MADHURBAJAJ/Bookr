// The menu as a sheet: download, check, apply. All rows invented.
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/claude', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/claude')>();
  return { ...real, readWithClaude: vi.fn() };
});

import { readWithClaude } from '../../src/claude';
import { groupText, guessColumns, parseCsv, readGroups, readSheet, readStation, readTax } from '../src/menu-sheet';
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
    expect(readTax('abc')).toBeNull();
    for (const [t, want] of [['5%', 'rate:500'], ['GST5', 'rate:500'], ['gst @ 18%', 'rate:1800'], ['18', 'rate:1800'], ['Nil', 'none:'], ['0%', 'none:'],
      ['Billing name (5%)', 'billing:'], ['Liquor', 'liquor:'], ['Non-GST', 'liquor:'], ['VAT', 'liquor:']] as const) {
      const x = readTax(t)!;
      expect(`${x.mode}:${x.bp ?? ''}`, t).toBe(want);
    }
    expect([readStation('KOT'), readStation('Bar Counter'), readStation('Barbecue'), readStation('Main Kitchen')]).toEqual(['kitchen', 'bar', null, 'kitchen']);
    expect(readGroups('Choose one: Steamed / Fried +₹10')).toEqual([{ name: 'Steamed or Fried', def: { name: 'Steamed or Fried', kind: 'one', options: [{ name: 'Steamed', addPaise: 0 }, { name: 'Fried', addPaise: 1000 }] } }]);
    expect(readGroups('Toppings (any): Olives +₹20 / Corn +₹15; Size')).toEqual([
      { name: 'Toppings', def: { name: 'Toppings', kind: 'any', options: [{ name: 'Olives', addPaise: 2000 }, { name: 'Corn', addPaise: 1500 }] } }, { name: 'Size', def: null }]);
    for (const t of ['Extra Cheese +₹50', 'Choose one: Half / Full +₹150', 'Size: Small / Large +₹40', 'Toppings (any): Olives +₹20 / Corn +₹15']) {
      const [g] = readGroups(t) as { def: any }[];
      expect(groupText(g.def)).toBe(t);
    }
    const r = readSheet(parseCsv('Item,Category,Price,Tax,Station\nA,Food,abc,GST 5%,Kitchen\nB,Food,10,GST 7%,Kitchen\nC,Food,10,GST 5%,Hall\nD,Food,10,GST 5%,Kitchen\nd,food,12,GST 5%,Kitchen\n'));
    expect(r.errors).toEqual([
      'Row 2 (A): "abc" is not a price.', 'Row 3 (B): tax "GST 7%" should be Billing name, GST 5% (or 12, 18, 28, 40), No GST (liquor) or No GST.',
      'Row 4 (C): station "Hall" should be Kitchen or Bar.', 'Row 6 (d): the same item and category as row 5.']);
    expect(readSheet(parseCsv('Dish,Notes\nA,x\n')).errors).toEqual(['Choose which column is the Price.']);
  });

  it('understands other layouts: other headings, a title line, section rows, MRP, and asks per category for GST and station', () => {
    expect(guessColumns(['Sr No', 'Item Name', 'Group', 'Rate', 'GST %', 'KOT', 'Veg/NV', 'HSN'])).toEqual(
      { item: 1, category: 2, price: 3, open: -1, min: -1, tax: 4, station: 5, sac: 7, addons: -1 });
    // "Price" is the price even when an "MRP" column is also there.
    expect(guessColumns(['Name', 'MRP', 'Price']).price).toBe(2);
    const sheet = 'Sample Cafe menu 2026\n\nItem Name,Rate,KOT\nSTARTERS,,\nPaneer Tikka,280/-,Kitchen\nCrispy Corn,₹ 220,\nBAR,,\nBeer,320,Bar\nWhisky bottle,MRP,Bar\n';
    const a = readSheet(parseCsv(sheet));
    expect(a.errors).toEqual([]);
    expect(a.needs).toEqual([{ category: 'STARTERS', tax: true, station: true, items: 2 }, { category: 'BAR', tax: true, station: false, items: 2 }]);
    const b = readSheet(parseCsv(sheet), { defaults: { starters: { tax: 'Billing name', station: 'Kitchen' }, BAR: { tax: 'No GST (liquor)' } } });
    expect(b.needs).toEqual([]);
    expect(b.rows.map((r) => [r.line, r.name, r.category, r.pricePaise, r.openPrice, r.station, r.tax.mode])).toEqual([
      [5, 'Paneer Tikka', 'STARTERS', 28000, false, 'kitchen', 'billing'], [6, 'Crispy Corn', 'STARTERS', 22000, false, 'kitchen', 'billing'],
      [8, 'Beer', 'BAR', 32000, false, 'bar', 'liquor'], [9, 'Whisky bottle', 'BAR', 0, true, 'bar', 'liquor']]);
    // A column chosen on screen wins over the guess.
    expect(readSheet(parseCsv('A,B,C\nTea,Drinks,40\n'), { columns: { item: 0, category: 1, price: 2 } }).needs).toEqual([{ category: 'Drinks', tax: true, station: true, items: 1 }]);
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

  it('gives a sample that checks clean, takes column and category choices, and reads a menu photo with Claude', async () => {
    const s = await setupBusiness();
    const sample = await download(s.owner, `${s.B}/menu/sample`);
    expect(sample.status).toBe(200);
    const r = await s.ok(s.owner.post(`${s.B}/menu/upload/check`, { csv: sample.text }));
    expect(r).toMatchObject({ ok: true, exactHeadings: true, needs: [] });
    expect(r.items).toBe(11);

    const other = 'Dish,Price INR,Section\nMasala Tea,40,Drinks\nLassi,90,Drinks\n';
    const a = await s.ok(s.owner.post(`${s.B}/menu/upload/check`, { csv: other }));
    expect(a).toMatchObject({ ok: false, exactHeadings: false, needs: [{ category: 'Drinks', tax: true, station: true, items: 2 }] });
    expect(a.columns).toMatchObject({ item: 0, price: 1, category: 2, tax: -1 });
    const defaults = { Drinks: { tax: 'Billing name', station: 'Kitchen' } };
    const b = await s.ok(s.owner.post(`${s.B}/menu/upload/check`, { csv: other, defaults }));
    expect(b).toMatchObject({ ok: true, added: ['Masala Tea', 'Lassi'] });
    // The hash covers the choices: applying with other choices is refused.
    expect((await s.owner.post(`${s.B}/menu/upload/apply`, { csv: other, defaults: { Drinks: { tax: 'GST 18%', station: 'Kitchen' } }, planHash: b.planHash })).status).toBe(409);
    expect((await s.owner.post(`${s.B}/menu/upload/check`, { csv: other, columns: { price: 99 } })).status).toBe(200);
    expect((await s.owner.post(`${s.B}/menu/upload/check`, { csv: other, columns: { nope: 1 } })).status).toBe(400);

    // A photo of a printed menu: Claude's rows come back as a sheet without GST, to check like any other.
    vi.mocked(readWithClaude).mockResolvedValueOnce({ model: 'test', data: { items: [
      { name: 'Veg Momos', category: 'Snacks', priceRupees: 120, priceAtBilling: false, station: 'Kitchen', addons: 'Choose one: Steamed / Fried +₹10' },
      { name: 'Red Wine bottle', category: 'Bar', priceRupees: null, priceAtBilling: true, station: null, addons: null },
    ] } });
    const photo = await app.request(`/api${s.B}/menu/upload/read`, { method: 'POST', body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
      headers: { 'Content-Type': 'image/jpeg', Cookie: [...s.owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } }, env);
    expect(photo.status).toBe(200);
    const read = await photo.json() as { csv: string; items: number };
    expect(read.items).toBe(2);
    expect(read.csv).toContain('Red Wine bottle,Bar,,Yes,,,');
    const c = await s.ok(s.owner.post(`${s.B}/menu/upload/check`, { csv: read.csv }));
    expect(c.needs).toEqual([{ category: 'Snacks', tax: true, station: false, items: 1 }, { category: 'Bar', tax: true, station: true, items: 1 }]);
    // Only the Owner, and only pages.
    const asCashier = await app.request(`/api${s.B}/menu/upload/read`, { method: 'POST', body: new Uint8Array([1]),
      headers: { 'Content-Type': 'image/jpeg', Cookie: [...s.counter.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } }, env);
    expect(asCashier.status).toBe(403);
    const asText = await app.request(`/api${s.B}/menu/upload/read`, { method: 'POST', body: 'x',
      headers: { 'Content-Type': 'text/plain', Cookie: [...s.owner.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } }, env);
    expect(asText.status).toBe(415);
  });

  it('refuses a file with bad rows, and names them', async () => {
    const s = await setupBusiness();
    const r = await s.ok(s.owner.post(`${s.B}/menu/upload/check`, { csv: 'Item,Category,Price,Tax,Station,Add-ons\nA,Food,10,GST 5%,Kitchen,Nonexistent\n' }));
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(['Row 2 (A): there is no add-on called "Nonexistent". Write it in full, like "Extra Cheese +₹50".']);
    expect((await s.owner.post(`${s.B}/menu/upload/apply`, { csv: 'Item,Category,Price,Tax,Station\nA,Food,10,GST 5%,Kitchen\n', planHash: r.planHash })).status).toBe(409);
  });
});

describe('add-on offered on many items', () => {
  it('sets the items from the add-on, keeps their other add-ons, and only for menu editors', async () => {
    const s = await setupBusiness();
    const items = (await s.owner.get(`${s.B}/menu`)).json.items;
    const [a, b, c] = items;
    const cheese = (await s.ok(s.owner.post(`${s.B}/addon-groups`, { name: 'Extra Cheese', kind: 'any', options: [{ name: 'Extra Cheese', price: '50' }] }))).id;
    const size = (await s.ok(s.owner.post(`${s.B}/addon-groups`, { name: 'Half or Full', kind: 'one', options: [{ name: 'Half', price: '0' }, { name: 'Full', price: '150' }] }))).id;
    await s.ok(s.owner.put(`${s.B}/addon-groups/${size}/items`, { itemIds: [a.id] }));
    await s.ok(s.owner.put(`${s.B}/addon-groups/${cheese}/items`, { itemIds: [a.id, b.id] }));
    let m = (await s.owner.get(`${s.B}/menu`)).json.items;
    const groupsOf = (id: string) => m.find((i: any) => i.id === id).addonGroups;
    expect(groupsOf(a.id)).toEqual([size, cheese]);
    expect(groupsOf(b.id)).toEqual([cheese]);
    await s.ok(s.owner.put(`${s.B}/addon-groups/${cheese}/items`, { itemIds: [b.id, c.id] }));
    m = (await s.owner.get(`${s.B}/menu`)).json.items;
    expect([groupsOf(a.id), groupsOf(b.id), groupsOf(c.id)]).toEqual([[size], [cheese], [cheese]]);
    expect((await s.owner.put(`${s.B}/addon-groups/${cheese}/items`, { itemIds: ['nope'] })).status).toBe(400);
    expect((await s.counter.put(`${s.B}/addon-groups/${cheese}/items`, { itemIds: [] })).status).toBe(403);
    expect((await s.owner.put(`${s.B}/addon-groups/not-a-group/items`, { itemIds: [] })).status).toBe(404);
  });
});

describe('add-on prices per dish', () => {
  it('works out what a choice adds from the dish\'s own prices', async () => {
    const { optionAdd, basePrice } = await import('../src/addons');
    const opts = [{ name: 'Half', addPaise: 0 }, { name: 'Full', addPaise: 15000 }];
    expect(optionAdd('one', opts, opts[1], null)).toBe(15000);
    expect(optionAdd('one', opts, opts[1], { half: 19900, full: 34900 })).toBe(15000);
    expect(optionAdd('one', opts, opts[1], { half: 30000, full: 47500 })).toBe(17500);
    expect(optionAdd('one', opts, opts[0], { half: 30000, full: 47500 })).toBe(0);
    expect(optionAdd('any', [{ name: 'Extra Cheese', addPaise: 5000 }], { name: 'Extra Cheese', addPaise: 5000 }, { 'extra cheese': 8000 })).toBe(8000);
    expect(basePrice([{ kind: 'any', options: [], prices: null }, { kind: 'one', options: opts, prices: { half: 19900, full: 34900 } }])).toBe(19900);
  });

  it('one Half or Full, two dishes, each with its own prices: set on the item, from the add-on, and charged on the order', async () => {
    const s = await setupBusiness();
    const size = (await s.ok(s.owner.post(`${s.B}/addon-groups`, { name: 'Half or Full', kind: 'one', options: [{ name: 'Half', price: '' }, { name: 'Full', price: '' }] }))).id;
    const cheese = (await s.ok(s.owner.post(`${s.B}/addon-groups`, { name: 'Extra Cheese', kind: 'any', options: [{ name: 'Extra Cheese', price: '50' }] }))).id;
    // On the item: no price typed; the Half price becomes the dish's price.
    const chicken = (await s.ok(s.owner.post(`${s.B}/menu`, { name: 'Test Tandoori Chicken', category: 'Tandoor', price: '',
      addonGroups: [{ id: size, prices: { Half: '300', Full: '450' } }, { id: cheese, prices: { 'Extra Cheese': '80' } }] }))).id;
    const biryani = (await s.ok(s.owner.post(`${s.B}/menu`, { name: 'Test Biryani', category: 'Indian', price: '250' }))).id;
    // A half-priced choice is refused; a fixed-price dish with no prices needs its price.
    expect((await s.owner.post(`${s.B}/menu`, { name: 'X', category: 'Y', price: '', addonGroups: [{ id: size, prices: { Half: '100' } }] })).status).toBe(400);
    expect((await s.owner.post(`${s.B}/menu`, { name: 'X', category: 'Y', price: '' })).status).toBe(400);
    // From the add-on's side: tick Biryani with its own prices; Chicken keeps its prices.
    await s.ok(s.owner.put(`${s.B}/addon-groups/${size}/items`, { items: [{ id: chicken, prices: { half: '300', full: '450' } }, { id: biryani, prices: { half: '199', full: '349' } }] }));
    const m = (await s.owner.get(`${s.B}/menu`)).json;
    const item = (id: string) => m.items.find((i: any) => i.id === id);
    expect(item(chicken)).toMatchObject({ pricePaise: 30000, addonPrices: { [size]: { half: 30000, full: 45000 }, [cheese]: { 'extra cheese': 8000 } } });
    expect(item(biryani)).toMatchObject({ pricePaise: 19900, addonPrices: { [size]: { half: 19900, full: 34900 } } });
    const opt = (g: string, n: string) => m.addonGroups.find((x: any) => x.id === g).options.find((o: any) => o.name === n).id;

    const order = (await s.ok(s.counter.post(`${s.B}/orders`, { kind: 'table', place: 'Own prices' }))).id;
    const add = (itemId: string, options: string[]) => s.ok(s.counter.post(`${s.B}/orders/${order}/items`, { itemId, delta: 1, options }));
    await add(chicken, [opt(size, 'Full'), opt(cheese, 'Extra Cheese')]);
    await add(biryani, [opt(size, 'Full')]);
    const r = await add(biryani, [opt(size, 'Half')]);
    const price = (name: string, o: string) => r.order.lines.find((l: any) => l.name === name && l.options.some((x: any) => x.name === o)).pricePaise;
    expect(price('Test Tandoori Chicken', 'Full')).toBe(45000 + 8000);
    expect(price('Test Biryani', 'Full')).toBe(34900);
    expect(price('Test Biryani', 'Half')).toBe(19900);
  });

  it('reads and writes dish prices in the sheet, and refuses mixed or mismatched forms', async () => {
    const s = await setupBusiness();
    const keep = (await s.owner.get(`${s.B}/menu`)).json.items.filter((i: any) => i.active)
      .map((i: any) => `${i.name},${i.category},${i.pricePaise / 100},,,Billing name,${i.station},`);
    const head = 'Item,Category,Price (₹),Price at billing,Lowest price (₹),Tax,Station,Add-ons & choices';
    const csv = [head, ...keep,
      'Sheet Chicken,Tandoor,,,,Billing name,Kitchen,Choose one: Half ₹300 / Full ₹450; Extra Cheese +₹50',
      'Sheet Biryani,Indian,,,,Billing name,Kitchen,Choose one: Half ₹199 / Full ₹349',
      'Sheet Pizza,Snacks,320,,,Billing name,Kitchen,Extra Cheese ₹80'].join('\n');
    const r = await s.ok(s.owner.post(`${s.B}/menu/upload/check`, { csv }));
    expect(r).toMatchObject({ ok: true, added: ['Sheet Chicken', 'Sheet Biryani', 'Sheet Pizza'] });
    await s.ok(s.owner.post(`${s.B}/menu/upload/apply`, { csv, planHash: r.planHash }));
    const m = (await s.owner.get(`${s.B}/menu`)).json;
    const item = (n: string) => m.items.find((i: any) => i.name === n);
    const g = (n: string) => m.addonGroups.find((x: any) => x.name === n);
    expect(g('Half or Full').options.map((o: any) => [o.name, o.addPaise])).toEqual([['Half', 0], ['Full', 0]]);
    expect(item('Sheet Chicken')).toMatchObject({ pricePaise: 30000, addonPrices: { [g('Half or Full').id]: { half: 30000, full: 45000 } } });
    expect(item('Sheet Biryani')).toMatchObject({ pricePaise: 19900 });
    expect(item('Sheet Pizza').addonPrices).toEqual({ [g('Extra Cheese').id]: { 'extra cheese': 8000 } });

    // The download writes the dish prices back; uploading it again changes nothing.
    const sheet = await download(s.owner, `${s.B}/menu/sheet`);
    expect(sheet.text).toContain('Sheet Chicken,Tandoor,300,,,Billing name,Kitchen,996332,Choose one: Half ₹300 / Full ₹450; Extra Cheese +₹50');
    expect(sheet.text).toContain('Sheet Pizza,Snacks,320,,,Billing name,Kitchen,996332,Extra Cheese ₹80');
    const again = await s.ok(s.owner.post(`${s.B}/menu/upload/check`, { csv: sheet.text }));
    expect(again).toMatchObject({ ok: true, added: [], off: [], priceChanges: [], otherChanges: [] });

    const bad = (cell: string) => s.ok(s.owner.post(`${s.B}/menu/upload/check`, { csv: `${head}\nX,Y,100,,,Billing name,Kitchen,"${cell}"\n` })).then((x) => x.errors[0]);
    expect(await bad('Choose one: Half ₹100 / Full +₹50')).toMatch(/not both/);
    expect(await bad('Choose one: Half ₹100 / Full')).toMatch(/give a price for each choice/);
    expect(await bad('Half or Full: Small ₹100 / Large ₹150')).toMatch(/has the choices Half \/ Full; this row has Small \/ Large/);
  });
});
