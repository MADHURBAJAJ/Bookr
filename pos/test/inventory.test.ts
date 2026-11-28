// The inventory manager's views (22 Nov 2026): what to buy, what was used, what was bought, bills not yet received,
// and opening stock. All items, vendors and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { billed, dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('inventory', () => {
  it('lists shortages from usage, consumption with the dishes behind it, purchases with price rises, and opening stock apart', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    const bar = (await ok(owner.post(`${B}/stock/stores`, { name: 'Bar', kind: 'bar' }))).id;
    const beer = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Lager', unit: 'pcs', packName: 'case', packSize: 12, costPerPack: '1200', reorderLevel: 6 }))).id;
    const rum = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Rum', unit: 'ml', packName: 'bottle', packSize: 750, costPerPack: '600' }))).id;
    await ok(owner.put(`${B}/stock/recipes/${s.items['Beer 650 ml']}`, { lines: [{ stockItemId: beer, qty: 1 }] }));

    // Opening stock: 1 case on the shelf. Not a purchase: left out of spend.
    await ok(owner.post(`${B}/stock/purchases`, { storeId: bar, opening: true, lines: [{ itemId: beer, packs: 1, costPerPack: '1200' }] }));
    expect((await owner.post(`${B}/stock/purchases`, { storeId: bar, vendor: 'Opening Stock', lines: [{ itemId: beer, packs: 1 }] })).status).toBe(400);
    // Two purchases: the second case costs more (a 10% rise).
    await ok(owner.post(`${B}/stock/purchases`, { storeId: bar, vendor: 'Sample Traders', invoiceNo: 'ST-1', lines: [{ itemId: rum, packs: 2, costPerPack: '600' }] }));
    await ok(owner.post(`${B}/stock/purchases`, { storeId: bar, vendor: 'Sample Traders', invoiceNo: 'ST-2', lines: [{ itemId: beer, packs: 1, costPerPack: '1320' }] }));

    // Sell 8 beers (settled bills take stock out), break 1, and a count finds 2 missing.
    const b1 = await billed(s, [['Beer 650 ml', 8]]);
    await ok(counter.post(`${B}/settlements`, { billIds: [b1.bill.id], payments: [{ mode: 'cash', amount: String(b1.bill.totalPaise / 100) }] }));
    await ok(owner.post(`${B}/stock/waste`, { storeId: bar, itemId: beer, qty: 1, reason: 'Bottle broken' }));
    await ok(owner.post(`${B}/stock/counts`, { storeId: bar, lines: [{ itemId: beer, counted: 13 }] }));   // book 24 - 8 - 1 = 15

    const day = b1.bill.shiftDay;
    const use = await ok(owner.get(`${B}/stock/consumption?from=${day}&to=${day}`));
    const lager = use.items.find((x: any) => x.name === 'Sample Lager');
    expect(lager).toMatchObject({ sold: 8, waste: 1, missing: 2, used: 11, topDishes: [{ dish: 'Beer 650 ml', qty: 8, units: 8 }] });
    expect(lager.usedValuePaise).toBe(Math.round((11 * 132000) / 12));          // at the last price paid

    const short = await ok(owner.get(`${B}/stock/shortages?days=1&cover=7`));
    const l = short.items.find((x: any) => x.name === 'Sample Lager');
    // 13 left, 11 used in a day: about a day left, under 3 days, so order 7 days' worth + reorder level - stock = 77 + 6 - 13 = 70 beers = 6 cases.
    expect(l).toMatchObject({ onHand: 13, usedPerDay: 11, daysLeft: 1.2, why: 'under 3 days left', orderPacks: 6, lastVendor: 'Sample Traders', costPerPackPaise: 132000 });
    expect(short.items.find((x: any) => x.name === 'Sample Rum')).toMatchObject({ why: null, usedPerDay: 0 });

    const buys = await ok(owner.get(`${B}/stock/purchases?from=${day}&to=${day}`));
    expect(buys.totalPaise).toBe(120000 + 132000);                                // opening stock not counted
    expect(buys.byVendor).toEqual([{ vendor: 'Sample Traders', receipts: 2, amountPaise: 252000 }]);
    const rise = buys.receipts.find((x: any) => x.invoice === 'ST-2');
    expect(rise).toMatchObject({ priceRises: 1, lines: [{ item: 'Sample Lager', packs: 1, costPerPackPaise: 132000, prevCostPerPackPaise: 120000, risePct: 10 }] });
    expect(buys.receipts.find((x: any) => x.opening)).toMatchObject({ vendor: 'Opening stock', amountPaise: 120000 });
  });

  it('receives whole packs and loose pieces: 12 of a box of 24 is 0 boxes + 12', async () => {
    const s = await setupBusiness();
    const { B, owner, ok } = s;
    const bar = (await ok(owner.post(`${B}/stock/stores`, { name: 'Bar', kind: 'bar' }))).id;
    const cooler = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Cooler', unit: 'pcs', packName: 'box', packSize: 24, costPerPack: '1600' }))).id;
    await ok(owner.post(`${B}/stock/purchases`, { storeId: bar, vendor: 'Sample Traders', invoiceNo: 'ST-9', lines: [
      { itemId: cooler, packs: 0, loose: 12, costPerPack: '1680' }, { itemId: cooler, packs: 1, loose: 6, costPerPack: '1680' }, { itemId: cooler, packs: 2 }] }));
    expect(await q("SELECT qty FROM stock_moves WHERE item_id = ? AND kind = 'purchase' ORDER BY qty", cooler)).toEqual([{ qty: 12 }, { qty: 30 }, { qty: 48 }]);
    expect((await owner.post(`${B}/stock/purchases`, { storeId: bar, vendor: 'Sample Traders', lines: [{ itemId: cooler, packs: 0, loose: 0 }] })).status).toBe(400);
    expect((await owner.post(`${B}/stock/purchases`, { storeId: bar, vendor: 'Sample Traders', lines: [{ itemId: cooler, packs: 0.5 }] })).status).toBe(400);
  });

  it("an item's first count is its opening stock, not stock found extra; later counts are variances", async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    const bar = (await ok(owner.post(`${B}/stock/stores`, { name: 'Bar', kind: 'bar' }))).id;
    const beer = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Lager', unit: 'pcs', packName: 'case', packSize: 12, costPerPack: '1200' }))).id;
    await ok(owner.put(`${B}/stock/recipes/${s.items['Beer 650 ml']}`, { lines: [{ stockItemId: beer, qty: 1 }] }));
    // Sold before any stock was entered: the book goes below zero.
    const b1 = await billed(s, [['Beer 650 ml', 2]]);
    await ok(counter.post(`${B}/settlements`, { billIds: [b1.bill.id], payments: [{ mode: 'cash', amount: String(b1.bill.totalPaise / 100) }] }));
    // The first count finds 10 on the shelf: opening stock, nothing extra.
    const first = (await ok(owner.post(`${B}/stock/counts`, { storeId: bar, lines: [{ itemId: beer, counted: 10 }] }))).lines;
    expect(first).toMatchObject([{ book: -2, counted: 10, variance: 0, opening: true, valuePaise: 0 }]);
    // The next count finds 1 missing: a variance as before.
    await ok(owner.post(`${B}/stock/counts`, { storeId: bar, lines: [{ itemId: beer, counted: 9 }] }));
    expect(await q("SELECT kind, qty, vendor FROM stock_moves WHERE item_id = ? AND kind IN ('purchase', 'count') ORDER BY at, kind DESC", beer)).toEqual([
      { kind: 'purchase', qty: 12, vendor: 'Opening stock' }, { kind: 'count', qty: -1, vendor: null }]);
    const day = b1.bill.shiftDay;
    const r = await ok(owner.get(`${B}/stock/report?storeId=${bar}&from=${day}&to=${day}`));
    expect(r.items[0]).toMatchObject({ opening: 0, received: 12, sold: 2, variance: -1, closing: 9 });
    expect(r.cost.missingPaise).toBe(10000);   // one beer at 1200 / 12
    expect(r.cost.actualCostPaise).toBeGreaterThan(0);
  });

  it('lists bill photos not yet received, and discards one; a received one stays', async () => {
    const s = await setupBusiness();
    const { B, owner, ok } = s;
    const t = Date.now();
    await q("INSERT INTO purchase_bills (id, business_id, vendor, status, created_at) VALUES ('00000000-0000-4000-8000-0000000000b1', ?, 'Sample Dairy', 'draft', ?)", s.businessId, t);
    await q("INSERT INTO purchase_bills (id, business_id, vendor, status, created_at, received_at) VALUES ('00000000-0000-4000-8000-0000000000b2', ?, 'Sample Farm', 'received', ?, ?)", s.businessId, t, t);
    expect((await ok(owner.get(`${B}/stock/bills`))).bills.map((x: any) => x.vendor)).toEqual(['Sample Dairy']);
    expect((await owner.call('DELETE', `${B}/stock/bills/00000000-0000-4000-8000-0000000000b2`, {})).status).toBe(409);
    await ok(owner.call('DELETE', `${B}/stock/bills/00000000-0000-4000-8000-0000000000b1`, {}));
    expect((await ok(owner.get(`${B}/stock/bills`))).bills).toEqual([]);
    expect((await s.counter.get(`${B}/stock/shortages`)).status).toBe(403);
  });
});
