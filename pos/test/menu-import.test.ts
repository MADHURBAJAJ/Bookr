// The menu sheet import, on invented rows.
import { afterAll, describe, expect, it } from 'vitest';
import { addonsOf, importSql, parseCsv, readMenu, taxOf } from '../scripts/menu-import-lib';
import { db, dispose, setupBusiness } from './helpers';

afterAll(dispose);

const SHEET = `Code,Item,Price (₹),Add-ons & choices,Price at billing,Tax,Category,Station,Pour,Veg,Check,Was called,Was in category
A1,Test Burger,150,"Peri Peri Fries +₹30; Extra Cheese +₹50",,Billing name (5%),Snacks,Kitchen,,,,,
A2,"Test Toast, Butter",90,Extra Cheese +₹50,,Billing name (5%),Snacks,Kitchen,,,,,
A3,Test Chicken,300,Choose one: Half / Full +₹150,,Billing name (5%),Snacks,Kitchen,,,,,
B1,Test Beer,300,,,No GST (liquor),Bar,Bar,,,,,
B2,Test Bottle,,,Yes,No GST (liquor),Bar,Bar,,,,,
B3,Test Soda,60,,,Billing name (5%),Bar,Bar,,,,,
C1,Room Tariff,2000,,,GST 5%,Hotel,Kitchen,,,,,
C2,Test Kit,50,,,No GST,Hotel,Kitchen,,,,,
`;

describe('menu import', () => {
  it('reads taxes and add-ons, and refuses what it cannot read', () => {
    expect(taxOf('GST 18%', 'x')).toEqual({ mode: 'rate', bp: 1800 });
    expect(taxOf('No GST (not a sale)', 'x')).toEqual({ mode: 'none', bp: null });
    expect(() => taxOf('VAT', 'x')).toThrow(/tax "VAT"/);
    expect(addonsOf('Choose one: Steamed / Fried +₹10', 'x')).toEqual([{ name: 'Steamed or Fried', kind: 'one', options: [{ name: 'Steamed', addPaise: 0 }, { name: 'Fried', addPaise: 1000 }] }]);
    expect(() => addonsOf('Extra Cheese', 'Row 9')).toThrow(/Row 9/);
    expect(() => readMenu(parseCsv('Item,Price,Price at billing,Tax,Category,Station,Add-ons\nX,,,GST 5%,Food,Kitchen,\n'))).toThrow(/no price/);
  });

  it('takes the old menu off, sets category GST with item exceptions, and loads add-ons and price at billing', async () => {
    const s = await setupBusiness();
    const menu = readMenu(parseCsv(SHEET));
    expect(menu.categories).toEqual([
      { name: 'Snacks', tax: { mode: 'billing', bp: null } }, { name: 'Bar', tax: { mode: 'liquor', bp: null } }, { name: 'Hotel', tax: expect.anything() },
    ]);
    const sql = importSql(menu, s.businessId, () => crypto.randomUUID(), Date.now());
    await db.batch(sql.map((x) => db.prepare(x)));
    // Run twice: add-ons with the same name are updated, not doubled.
    await db.batch(importSql(menu, s.businessId, () => crypto.randomUUID(), Date.now()).map((x) => db.prepare(x)));

    const m = (await s.owner.get(`${s.B}/menu`)).json;
    const active = m.items.filter((i: any) => i.active);
    expect(active.map((i: any) => i.name).sort()).toEqual(['Room Tariff', 'Test Beer', 'Test Bottle', 'Test Burger', 'Test Chicken', 'Test Kit', 'Test Soda', 'Test Toast, Butter']);
    expect(m.items.filter((i: any) => !i.active).length).toBeGreaterThan(0);
    expect(m.addonGroups.map((g: any) => g.name).sort()).toEqual(['Extra Cheese', 'Half or Full', 'Peri Peri Fries']);
    const item = (n: string) => active.find((i: any) => i.name === n);
    expect(item('Test Soda')).toMatchObject({ taxMode: 'billing' });
    expect(item('Test Beer').taxMode ?? null).toBeNull();
    expect(item('Test Bottle')).toMatchObject({ openPrice: true, pricePaise: 0 });
    expect(item('Room Tariff')).toMatchObject({ sac: '996311' });
    expect(item('Test Burger').addonGroups).toHaveLength(2);
    expect(m.categories.find((c: any) => c.name === 'Bar')).toMatchObject({ taxMode: 'liquor' });

    // The imported menu bills: burger with fries, the bottle at a typed price, the soda at 5% inside the Bar category.
    const o = { order: await s.ok(s.counter.post(`${s.B}/orders`, { kind: 'table', place: 'Imp 1' })) };
    const g = (n: string) => m.addonGroups.find((x: any) => x.name === n).options[0].id;
    await s.ok(s.counter.post(`${s.B}/orders/${o.order.id}/items`, { itemId: item('Test Burger').id, delta: 1, options: [g('Peri Peri Fries')] }));
    await s.ok(s.counter.post(`${s.B}/orders/${o.order.id}/items`, { itemId: item('Test Bottle').id, delta: 1, price: '2500' }));
    await s.ok(s.counter.post(`${s.B}/orders/${o.order.id}/items`, { itemId: item('Test Soda').id, delta: 1 }));
    await s.ok(s.counter.post(`${s.B}/orders/${o.order.id}/kot`));
    const { bill } = await s.ok(s.counter.post(`${s.B}/orders/${o.order.id}/bill`, { entityId: s.company, discount: { kind: 'none' } }));
    expect(bill.taxes).toEqual([
      { kind: 'gst', bp: 500, valuePaise: 24000, cgstPaise: 600, sgstPaise: 600 },
      { kind: 'liquor', bp: 0, valuePaise: 250000, cgstPaise: 0, sgstPaise: 0 },
    ]);
  });
});
