// Many menu items changed at once from the Menu screen's ticked rows. All names invented.
import { afterAll, describe, expect, it } from 'vitest';
import { billed, dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('menu bulk changes', () => {
  it('changes ticked items together, keeps ordered items for old bills, and stays inside the restaurant', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, items, ok } = s;
    const ids = [items['Masala Dosa'], items['Butter Naan'], items['Masala Chai']];
    const row = async (id: string) => (await q('SELECT category, active, station_id, kot, tax_mode, gst_bp FROM menu_items WHERE id = ?', id))[0];

    await ok(owner.post(`${B}/menu/bulk`, { ids, action: 'off' }));
    expect((await Promise.all(ids.map(row))).map((r) => r.active)).toEqual([0, 0, 0]);
    await ok(owner.post(`${B}/menu/bulk`, { ids, action: 'on' }));

    await ok(owner.post(`${B}/menu/bulk`, { ids: ids.slice(0, 2), action: 'category', value: 'Breakfast' }));
    expect((await row(ids[0])).category).toBe('Breakfast');
    expect((await q('SELECT 1 FROM menu_categories WHERE business_id = ? AND name = ?', s.businessId, 'Breakfast')).length).toBe(1);

    await ok(owner.post(`${B}/menu/bulk`, { ids, action: 'tax', value: { taxMode: 'rate', gstRate: 18 } }));
    expect(await row(ids[2])).toMatchObject({ tax_mode: 'rate', gst_bp: 1800 });
    await ok(owner.post(`${B}/menu/bulk`, { ids, action: 'tax', value: { taxMode: 'category' } }));
    expect(await row(ids[2])).toMatchObject({ tax_mode: null, gst_bp: null });

    const bar = (await ok(owner.get(`${B}/menu`))).stations.find((x: any) => x.name === 'Bar').id;
    await ok(owner.post(`${B}/menu/bulk`, { ids: [ids[2]], action: 'station', value: bar }));
    expect(await row(ids[2])).toMatchObject({ station_id: bar, kot: null });
    await ok(owner.post(`${B}/menu/bulk`, { ids: [ids[2]], action: 'station', value: 'none' }));
    expect(await row(ids[2])).toMatchObject({ station_id: null, kot: 0 });

    // Delete: Dosa was ordered, so it stays (off the menu) for its bill; Naan never was, so it goes.
    await billed(s, [['Masala Dosa', 1]]);
    const r = await ok(owner.post(`${B}/menu/bulk`, { ids: ids.slice(0, 2), action: 'delete' }));
    expect(r).toMatchObject({ deleted: 1, takenOff: 1 });
    expect(await row(ids[0])).toMatchObject({ active: 0 });
    expect(await row(ids[1])).toBeUndefined();
    const log = await q("SELECT action, row_id FROM audit_log WHERE business_id = ? AND action LIKE 'menu.bulk.%' ORDER BY id", s.businessId);
    expect(log.map((x) => x.action)).toEqual(['menu.bulk.off', 'menu.bulk.on', 'menu.bulk.category', 'menu.bulk.tax', 'menu.bulk.tax', 'menu.bulk.station', 'menu.bulk.station', 'menu.bulk.delete']);

    // Another restaurant's item, an unknown change, or a cashier: refused, and nothing changes.
    const other = await setupBusiness();
    expect((await owner.post(`${B}/menu/bulk`, { ids: [ids[2], other.items['Masala Dosa']], action: 'off' })).status).toBe(404);
    expect((await row(ids[2])).active).toBe(1);
    expect((await owner.post(`${B}/menu/bulk`, { ids: [ids[2]], action: 'price' })).status).toBe(400);
    expect((await counter.post(`${B}/menu/bulk`, { ids: [ids[2]], action: 'off' })).status).toBe(403);
  });
});
