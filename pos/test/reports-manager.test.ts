// The manager's reports (21 Nov 2026): NC and complimentary bills kept out of sales, comparison with an earlier period,
// profit per dish from recipes, and losses with who and why. All items, people and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { billed, dispose, setupBusiness } from './helpers';

afterAll(dispose);

describe('manager reports', () => {
  it('keeps NC out of sales, costs dishes from recipes and lists losses', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    const kitchen = (await ok(owner.post(`${B}/stock/stores`, { name: 'Kitchen', kind: 'kitchen' }))).id;
    const bar = (await ok(owner.post(`${B}/stock/stores`, { name: 'Bar', kind: 'bar' }))).id;
    const batter = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Batter', unit: 'g', packName: 'kg', packSize: 1000, costPerPack: '100' }))).id;
    const lager = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Lager', unit: 'pcs', packName: 'case', packSize: 12, costPerPack: '1200' }))).id;
    await ok(owner.put(`${B}/stock/recipes/${s.items['Masala Dosa']}`, { lines: [{ stockItemId: batter, qty: 200 }] }));   // ₹20 a dosa
    await ok(owner.put(`${B}/stock/recipes/${s.items['Beer 650 ml']}`, { lines: [{ stockItemId: lager, qty: 1 }] }));     // ₹100 a beer
    await ok(owner.post(`${B}/stock/purchases`, { storeId: kitchen, opening: true, lines: [{ itemId: batter, packs: 5 }] }));
    await ok(owner.post(`${B}/stock/purchases`, { storeId: bar, opening: true, lines: [{ itemId: lager, packs: 1 }] }));

    // Paid: 3 dosa and 2 beers. Complimentary: a naan. Paid with a 10% discount: a chai (no recipe).
    const b1 = await billed(s, [['Masala Dosa', 3], ['Beer 650 ml', 2]]);
    await ok(counter.post(`${B}/settlements`, { billIds: [b1.bill.id], payments: [{ mode: 'cash', amount: String(b1.bill.totalPaise / 100) }] }));
    const b2 = await billed(s, [['Butter Naan', 1]]);
    await ok(owner.post(`${B}/settlements`, { billIds: [b2.bill.id], payments: [{ mode: 'comp', amount: String(b2.bill.totalPaise / 100), compGuest: 'Sample Guest', reasonId: s.reasons.comp }] }));
    const b3 = await billed(s, [['Masala Chai', 1]], { discount: { kind: 'pct', bp: 1000, reasonId: s.reasons.discount } });
    await ok(counter.post(`${B}/settlements`, { billIds: [b3.bill.id], payments: [{ mode: 'cash', amount: String(b3.bill.totalPaise / 100) }] }));
    await ok(owner.post(`${B}/stock/waste`, { storeId: bar, itemId: lager, qty: 1, reason: 'Bottle broken' }));
    const day = b1.bill.shiftDay;

    const sales = await ok(owner.get(`${B}/reports/sales?from=${day}&to=${day}`));
    expect(sales.paid).toMatchObject({ bills: 2, netPaise: 54000 + 64000 + 3600 });
    expect(sales.nc).toEqual({ bills: 1, menuPaise: 6000 });
    expect(sales.byEntity[0].bills).toBe(3);                                        // the GST table keeps every bill
    expect(sales.items.map((i: any) => i.name)).not.toContain('Butter Naan');
    expect(sales.prev).toMatchObject({ bills: 0, netPaise: 0 });
    expect(Date.parse(day) - Date.parse(sales.prev.from)).toBe(7 * 86_400_000);    // one shift: the same day last week

    const p = await ok(owner.get(`${B}/reports/profit?from=${day}&to=${day}`));
    const kit = p.stations.find((x: any) => x.station === 'kitchen');
    expect(kit).toMatchObject({ costPaise: 6000, costedSalesPaise: 54000, costPct: 11.1, notCosted: 1 });
    expect(p.dishes.find((d: any) => d.name === 'Masala Dosa')).toMatchObject({ qty: 3, costPaise: 6000, profitPaise: 48000, group: 'best' });
    expect(p.dishes.find((d: any) => d.name === 'Masala Chai')).toMatchObject({ costPaise: null, group: null });
    expect(p.dishes.find((d: any) => d.name === 'Beer 650 ml')).toMatchObject({ costPaise: 20000, profitPaise: 44000 });
    expect(p.dishes.find((d: any) => d.name === 'Butter Naan')).toBeUndefined();

    const l = await ok(owner.get(`${B}/reports/losses?from=${day}&to=${day}`));
    expect(l.events.find((e: any) => e.kind === 'comp')).toMatchObject({ amountPaise: b2.bill.totalPaise, reason: "Owner's guest" });
    expect(l.events.find((e: any) => e.kind === 'discount')).toMatchObject({ amountPaise: 400, reason: 'Regular guest' });
    expect(l.stock).toEqual([{ name: 'Sample Lager', unit: 'pcs', kind: 'waste', qty: 1, valuePaise: 10000 }]);

    const d = await ok(owner.get(`${B}/reports/daily-check?day=${day}`));
    expect(d.sales).toMatchObject({ bills: 2, ncBills: 1, ncMenuPaise: 6000 });
    expect((await counter.get(`${B}/reports/profit?from=${day}&to=${day}`)).status).toBe(403);
  });
});
