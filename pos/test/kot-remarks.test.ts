// Remarks on the KOT (26 Nov 2026): a remark keeps its items a line of their own and prints on the KOT under them; a
// note for the order prints on every KOT sent after it; what has gone to the kitchen keeps its remark. Invented data.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, setupBusiness } from './helpers';

afterAll(dispose);

describe('KOT remarks', () => {
  it('splits by remark, prints remark and note on the KOT, and leaves sent items as they were', async () => {
    const s = await setupBusiness();
    const { B, counter, ok } = s;
    const o = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T9' }))).id;
    const chai = s.items['Masala Chai'];
    let r = await ok(counter.post(`${B}/orders/${o}/items`, { itemId: chai, delta: 2 }));
    r = await ok(counter.call('PUT', `${B}/orders/${o}/lines/${r.order.lines[0].id}/remark`, { remark: 'Extra sugar' }));
    r = await ok(counter.post(`${B}/orders/${o}/items`, { itemId: chai, delta: 1 }));
    expect(r.order.lines.map((l: any) => [l.qty, l.remark])).toEqual([[2, 'Extra sugar'], [1, null]]);
    // Another 1 with the same remark joins that line.
    const plain = r.order.lines.find((l: any) => !l.remark).id;
    r = await ok(counter.post(`${B}/orders/${o}/items`, { itemId: chai, delta: 1 }));
    r = await ok(counter.call('PUT', `${B}/orders/${o}/lines/${plain}/remark`, { remark: 'extra sugar' }));
    expect(r.order.lines.map((l: any) => [l.qty, l.remark])).toEqual([[4, 'extra sugar']]);
    expect((await counter.call('PUT', `${B}/orders/${o}/lines/${plain}/remark`, { remark: 'x'.repeat(121) })).status).toBe(400);
    await ok(counter.call('PUT', `${B}/orders/${o}/note`, { note: 'Extra tissues' }));

    const k = await ok(counter.post(`${B}/orders/${o}/kot`));
    expect(k.kots[0]).toMatchObject({ note: 'Extra tissues', lines: [expect.objectContaining({ qty: 4, name: 'Masala Chai', remark: 'extra sugar' })] });
    // Sent: its remark can't change; a new one on top is its own line.
    const sentLine = (await ok(counter.get(`${B}/orders/${o}`))).order.lines[0].id;
    expect((await counter.call('PUT', `${B}/orders/${o}/lines/${sentLine}/remark`, { remark: 'No sugar' })).status).toBe(409);
    r = await ok(counter.post(`${B}/orders/${o}/items`, { itemId: chai, delta: 1 }));
    const fresh = r.order.lines.find((l: any) => l.qty > l.sentQty);
    r = await ok(counter.call('PUT', `${B}/orders/${o}/lines/${fresh.id}/remark`, { remark: 'No sugar' }));
    expect(r.order.lines.map((l: any) => [l.qty, l.sentQty, l.remark])).toEqual([[4, 4, 'extra sugar'], [1, 0, 'No sugar']]);
    // The bill does not carry remarks: two lines of the same dish at the same price.
    await ok(counter.post(`${B}/orders/${o}/kot`));
    const bill = (await ok(counter.post(`${B}/orders/${o}/bill`, { entityId: s.company }))).bill;
    expect(bill.items.map((i: any) => [i.name, i.qty])).toEqual([['Masala Chai', 4], ['Masala Chai', 1]]);
  });
});
