// Stock at the KOT (24 Nov 2026): a dish's recipe leaves its store when it is sent to the kitchen or bar, a no-KOT item
// when it is added; cancelled before it is made it goes back, after it is made it is wastage with the reason; payment
// moves no stock. Orders opened before the change keep the old rule (stock at payment). All names and amounts invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';
import { stockRule } from '../src/stock';

afterAll(dispose);

describe('stock at the KOT', () => {
  it('takes stock at the KOT, gives it back or counts it as wastage on cancel, and none at payment', async () => {
    const saved = stockRule.kotFrom;
    stockRule.kotFrom = 0;
    try {
      const s = await setupBusiness();
      const { B, counter, ok, mgr } = s;
      const t = Date.now();
      await q("INSERT INTO stock_stores (id, business_id, name, kind, created_at) VALUES ('st-bar', ?, 'Sample Bar', 'bar', ?), ('st-kit', ?, 'Sample Kitchen', 'kitchen', ?)", s.businessId, t, s.businessId, t);
      await q("INSERT INTO stock_items (id, business_id, name, unit, pack_size, created_at) VALUES ('si-beer', ?, 'Sample Beer', 'pcs', 12, ?), ('si-batter', ?, 'Sample Batter', 'g', 1000, ?)", s.businessId, t, s.businessId, t);
      await q("INSERT INTO recipes (menu_item_id, stock_item_id, business_id, qty) VALUES (?, 'si-beer', ?, 1), (?, 'si-batter', ?, 150)", s.items['Beer 650 ml'], s.businessId, s.items['Masala Dosa'], s.businessId);
      const used = async (item: string, kind = 'sale') => 0 - ((await q('SELECT coalesce(sum(qty), 0) AS n FROM stock_moves WHERE item_id = ? AND kind = ?', item, kind))[0].n) + 0;

      const order = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T9' }))).id;
      await ok(counter.post(`${B}/orders/${order}/items`, { itemId: s.items['Beer 650 ml'], delta: 3 }));
      await ok(counter.post(`${B}/orders/${order}/items`, { itemId: s.items['Masala Dosa'], delta: 2 }));
      expect(await used('si-beer')).toBe(0);                      // nothing yet: not sent
      await ok(counter.post(`${B}/orders/${order}/kot`));
      expect([await used('si-beer'), await used('si-batter')]).toEqual([3, 300]);
      expect((await q("SELECT store_id FROM stock_moves WHERE item_id = 'si-beer'"))[0].store_id).toBe('st-bar');

      // One beer cancelled, not opened: back to the bar. One dosa cancelled after it was made: wastage with the reason.
      const lines = (await ok(counter.get(`${B}/orders/${order}`))).order.lines;
      const beer = lines.find((l: any) => l.itemId === s.items['Beer 650 ml']);
      const dosa = lines.find((l: any) => l.itemId === s.items['Masala Dosa']);
      await ok(counter.post(`${B}/orders/${order}/items`, { lineId: beer.id, delta: -1, reasonId: s.reasons.kot_cancel, made: false, ...mgr }));
      await ok(counter.post(`${B}/orders/${order}/items`, { lineId: dosa.id, delta: -1, reasonId: s.reasons.kot_cancel, made: true, ...mgr }));
      expect([await used('si-beer'), await used('si-batter'), await used('si-batter', 'waste')]).toEqual([2, 150, 150]);
      expect((await q("SELECT reason FROM stock_moves WHERE kind = 'waste'"))[0].reason).toMatch(/^Made, then cancelled: /);

      // Billing and payment move no stock.
      await ok(counter.post(`${B}/orders/${order}/bill`, { entityId: s.company }));
      const bill = (await ok(counter.get(`${B}/orders/${order}`))).order;
      const b = (await q('SELECT id, total_paise FROM bills WHERE order_id = ?', order))[0];
      await ok(counter.post(`${B}/settlements`, { billIds: [b.id], payments: [{ mode: 'cash', amount: String(b.total_paise / 100) }] }));
      expect(bill).toBeTruthy();
      expect([await used('si-beer'), await used('si-batter')]).toEqual([2, 150]);

      // A whole order cancelled before anything was made: all of it goes back.
      const o2 = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T10' }))).id;
      await ok(counter.post(`${B}/orders/${o2}/items`, { itemId: s.items['Beer 650 ml'], delta: 2 }));
      await ok(counter.post(`${B}/orders/${o2}/kot`));
      expect(await used('si-beer')).toBe(4);
      await ok(counter.post(`${B}/orders/${o2}/cancel`, { reasonId: s.reasons.kot_cancel, made: false, ...mgr }));
      expect(await used('si-beer')).toBe(2);
    } finally {
      stockRule.kotFrom = saved;
    }
  });

  it('an order opened before the change takes its stock at payment, once', async () => {
    const s = await setupBusiness();
    const { B, counter, ok } = s;
    const t = Date.now();
    await q("INSERT INTO stock_stores (id, business_id, name, kind, created_at) VALUES ('st-bar2', ?, 'Sample Bar', 'bar', ?)", s.businessId, t);
    await q("INSERT INTO stock_items (id, business_id, name, unit, pack_size, created_at) VALUES ('si-beer2', ?, 'Sample Beer', 'pcs', 12, ?)", s.businessId, t);
    await q("INSERT INTO recipes (menu_item_id, stock_item_id, business_id, qty) VALUES (?, 'si-beer2', ?, 1)", s.items['Beer 650 ml'], s.businessId);
    const order = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T11' }))).id;
    await q('UPDATE orders SET opened_at = ? WHERE id = ?', stockRule.kotFrom - 60_000, order);
    await ok(counter.post(`${B}/orders/${order}/items`, { itemId: s.items['Beer 650 ml'], delta: 2 }));
    await ok(counter.post(`${B}/orders/${order}/kot`));
    expect((await q("SELECT count(*) AS n FROM stock_moves WHERE item_id = 'si-beer2'"))[0].n).toBe(0);
    await ok(counter.post(`${B}/orders/${order}/bill`, { entityId: s.company }));
    const b = (await q('SELECT id, total_paise FROM bills WHERE order_id = ?', order))[0];
    await ok(counter.post(`${B}/settlements`, { billIds: [b.id], payments: [{ mode: 'cash', amount: String(b.total_paise / 100) }] }));
    expect((await q("SELECT sum(qty) AS n FROM stock_moves WHERE item_id = 'si-beer2' AND kind = 'sale'"))[0].n).toBe(-2);
  });
});
