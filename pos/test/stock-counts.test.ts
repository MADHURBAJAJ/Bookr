// Bar counts with a manager's approval (27 Nov 2026): a count list by category, a count typed from the paper (compared with
// the stock at the time it was counted) or live, two places per item, and stock changing only when a manager approves.
// All names and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('stock counts', () => {
  it('counts from paper at the counted time, waits for a manager, then sets stock', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    const t = Date.now();
    await q("INSERT INTO stock_stores (id, business_id, name, kind, created_at) VALUES ('cs-bar', ?, 'Sample Bar', 'bar', ?)", s.businessId, t);
    const whisky = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Whisky', unit: 'ml', packName: 'bottle', packSize: 750, costPerPack: '1500', category: 'Whisky' }))).id;
    const beer = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Beer', unit: 'pcs', packName: 'box', packSize: 12, costPerPack: '1200', category: 'Beer' }))).id;
    const smoke = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Smokes', unit: 'pcs', packName: 'packet', packSize: 20, category: 'Cigarettes' }))).id;
    // In hand: 3 bottles of whisky two hours ago; 300 ml sold an hour ago (after the count).
    await q(`INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, shift_day, at) VALUES
      ('m1', ?1, ?2, 'cs-bar', 'purchase', 2250, '2026-11-26', ?3), ('m2', ?1, ?2, 'cs-bar', 'sale', -300, '2026-11-26', ?4), ('m3', ?1, ?5, 'cs-bar', 'purchase', 30, '2026-11-26', ?3)`,
      s.businessId, whisky, t - 7_200_000, t - 3_600_000, beer);

    // Only a manager sets the list; cigarettes are off it.
    const body = { name: 'Bar count', storeId: 'cs-bar', categories: ['Whisky', 'Beer', 'Cigarettes'], offItems: [smoke] };
    expect((await counter.post(`${B}/stock/count-lists`, body)).status).toBe(403);
    const list = (await ok(owner.post(`${B}/stock/count-lists`, body))).id;
    const sheet = await ok(counter.get(`${B}/stock/count-lists/${list}/sheet`));
    expect(sheet.groups.map((g: any) => [g.category, g.items.map((i: any) => [i.name, i.inHand])])).toEqual([['Whisky', [['Sample Whisky', 1950]]], ['Beer', [['Sample Beer', 30]]]]);

    // The bartender types the paper: counted 90 minutes ago; whisky 2 btl at the bar + 1 btl in the store; beer 2 boxes + 4.
    const id = (await ok(counter.post(`${B}/stock/count-sessions`, { listId: list, mode: 'after_shift' }))).id;
    const ck = await ok(counter.put(`${B}/stock/count-sessions/${id}`, { countedAt: t - 5_400_000, lines: [{ itemId: whisky, place1: 1500, place2: 750 }, { itemId: beer, place1: 28, place2: 0 }] }));
    const row = (n: string) => ck.groups.flatMap((g: any) => g.items).find((i: any) => i.name === n);
    expect(row('Sample Whisky')).toMatchObject({ inHand: 2250, counted: 2250, diff: 0 });   // the 300 ml sold later is not missing
    expect(row('Sample Beer')).toMatchObject({ inHand: 30, counted: 28, diff: -2 });
    await ok(counter.post(`${B}/stock/count-sessions/${id}/send`, {}));
    expect((await counter.put(`${B}/stock/count-sessions/${id}`, { lines: [] })).status).toBe(409);   // with the manager now

    // A cashier can't approve; nothing has changed yet.
    expect((await counter.post(`${B}/stock/count-sessions/${id}/approve`, {})).status).toBe(403);
    expect((await q("SELECT count(*) AS n FROM stock_moves WHERE kind = 'count'"))[0].n).toBe(0);
    // Sent back for the beer, recounted, sent again, approved.
    await ok(owner.post(`${B}/stock/count-sessions/${id}/back`, { itemIds: [beer], note: 'Check the store' }));
    await ok(counter.put(`${B}/stock/count-sessions/${id}`, { lines: [{ itemId: beer, place1: 24, place2: 3 }] }));
    await ok(counter.post(`${B}/stock/count-sessions/${id}/send`, {}));
    const r = await ok(owner.post(`${B}/stock/count-sessions/${id}/approve`, {}));
    expect(r).toMatchObject({ rows: 2, differ: 1 });
    const moves = await q("SELECT item_id, qty, at FROM stock_moves WHERE kind = 'count'");
    expect(moves).toEqual([{ item_id: beer, qty: -3, at: t - 5_400_000 }]);   // at the counted time
    expect((await q("SELECT sum(qty) AS n FROM stock_moves WHERE item_id = ?", beer))[0].n).toBe(27);
    expect((await q("SELECT sum(qty) AS n FROM stock_moves WHERE item_id = ?", whisky))[0].n).toBe(1950);
  });

  it('a live count compares each row with the stock when it is typed', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    const t = Date.now();
    await q("INSERT INTO stock_stores (id, business_id, name, kind, created_at) VALUES ('cl-bar', ?, 'Sample Bar', 'bar', ?)", s.businessId, t);
    const gin = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Gin', unit: 'ml', packName: 'bottle', packSize: 750, category: 'Gin' }))).id;
    await q("INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, shift_day, at) VALUES ('g1', ?, ?, 'cl-bar', 'purchase', 1500, '2026-11-26', ?)", s.businessId, gin, t - 60_000);
    const list = (await ok(owner.post(`${B}/stock/count-lists`, { name: 'Gin only', storeId: 'cl-bar', categories: ['Gin'] }))).id;
    const id = (await ok(counter.post(`${B}/stock/count-sessions`, { listId: list, mode: 'live' }))).id;
    const ck = await ok(counter.put(`${B}/stock/count-sessions/${id}`, { lines: [{ itemId: gin, place1: 1400, place2: 0 }] }));
    expect(ck.groups[0].items[0]).toMatchObject({ inHand: 1500, counted: 1400, diff: -100 });
    await ok(counter.post(`${B}/stock/count-sessions/${id}/send`, {}));
    await ok(owner.post(`${B}/stock/count-sessions/${id}/approve`, {}));
    expect((await q('SELECT sum(qty) AS n FROM stock_moves WHERE item_id = ?', gin))[0].n).toBe(1400);
  });
});
