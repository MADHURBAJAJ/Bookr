// A menu price change and open orders (26 Nov 2026): what was ordered keeps its price; more of it, or a line taken off and
// added again, goes at today's price; a lower price can be put on open orders not billed yet. All names and prices invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, setupBusiness } from './helpers';

afterAll(dispose);

describe('menu price change on open orders', () => {
  it('keeps what was ordered, uses the new price for more, and lowers open orders when asked', async () => {
    const s = await setupBusiness();
    const { B, counter, owner, ok } = s;
    const water = (await ok(owner.post(`${B}/menu`, { name: 'Sample Water', price: '30', station: 'kitchen', category: 'Drinks' }))).id;
    const o1 = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T21' }))).id;
    const o2 = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T22' }))).id;
    await ok(counter.post(`${B}/orders/${o1}/items`, { itemId: water, delta: 2 }));
    await ok(counter.post(`${B}/orders/${o2}/items`, { itemId: water, delta: 1 }));
    const lines = async (o: string) => (await ok(counter.get(`${B}/orders/${o}`))).order.lines.filter((l: any) => l.qty > 0).map((l: any) => [l.qty, l.pricePaise]);

    // The price drops to ₹20: open orders keep ₹30, and the screen is told how many could be lowered.
    const r = await ok(owner.put(`${B}/menu/${water}`, { name: 'Sample Water', price: '20', station: 'kitchen', category: 'Drinks' }));
    expect(r.openHigher).toBe(2);
    // One more on T21: a line of its own at ₹20; the two ordered before stay at ₹30.
    await ok(counter.post(`${B}/orders/${o1}/items`, { itemId: water, delta: 1 }));
    expect(await lines(o1)).toEqual([[2, 3000], [1, 2000]]);
    // T22: taken off, then added again: today's price.
    const l2 = (await ok(counter.get(`${B}/orders/${o2}`))).order.lines[0];
    await ok(counter.post(`${B}/orders/${o2}/items`, { lineId: l2.id, delta: -1 }));
    await ok(counter.post(`${B}/orders/${o2}/items`, { itemId: water, delta: 1 }));
    expect(await lines(o2)).toEqual([[1, 2000]]);
    // Lowered on the open orders: T21's two at ₹30 become ₹20.
    const x = await ok(owner.post(`${B}/menu/${water}/reprice-open`, {}));
    expect(x.places).toEqual(['T21']);
    expect(await lines(o1)).toEqual([[2, 2000], [1, 2000]]);
    // A price rise never touches open orders.
    const up = await ok(owner.put(`${B}/menu/${water}`, { name: 'Sample Water', price: '25', station: 'kitchen', category: 'Drinks' }));
    expect(up.openHigher).toBe(0);
    expect(await lines(o1)).toEqual([[2, 2000], [1, 2000]]);
  });
});
