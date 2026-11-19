// KOT stations: KOT on or off and the station by category and by item, a station's own device, cancel KOTs. Invented data.
import { afterAll, describe, expect, it } from 'vitest';
import { Client, dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

/** A browser the Owner sets up as a station's device. */
async function stationDevice(s: Awaited<ReturnType<typeof setupBusiness>>, stationId: string) {
  const d = new Client();
  d.cookies = new Map(s.owner.cookies);
  await s.ok(d.post(`${s.B}/devices`, { name: 'Station tablet', stationId }));
  d.cookies.delete('pos_session');
  return d;
}

describe('KOT stations', () => {
  it('starts with Kitchen and Bar; routes by category and item; no-KOT items skip the kitchen and need no reason', async () => {
    const s = await setupBusiness();
    const { stations } = await s.ok(s.owner.get(`${s.B}/stations`));
    expect(stations.map((x: any) => [x.name, x.isBar, x.how])).toEqual([['Kitchen', false, 'paper'], ['Bar', true, 'paper']]);
    const [kitchen, bar] = stations;
    const tandoor = (await s.ok(s.owner.post(`${s.B}/stations`, { name: 'Tandoor', how: 'screen' }))).id;
    expect((await s.owner.post(`${s.B}/stations`, { name: 'tandoor' })).status).toBe(409);
    expect((await s.counter.post(`${s.B}/stations`, { name: 'X' })).status).toBe(403);

    // Category "Breads" to the tandoor; a cigarette with no KOT; Butter Naan (Food) to the tandoor on its own.
    await s.ok(s.owner.post(`${s.B}/menu`, { name: 'Tandoori Roti', price: '30', category: 'Breads' }));
    const cig = (await s.ok(s.owner.post(`${s.B}/menu`, { name: 'Test Cigarette', price: '20', category: 'Cigarettes', kot: 'no' }))).id;
    let m = (await s.owner.get(`${s.B}/menu`)).json;
    const cat = (n: string) => m.categories.find((c: any) => c.name === n);
    await s.ok(s.owner.put(`${s.B}/menu-categories/${cat('Breads').id}`, { stationId: tandoor }));
    const naan = m.items.find((i: any) => i.name === 'Butter Naan');
    await s.ok(s.owner.put(`${s.B}/menu/${naan.id}`, { name: naan.name, category: 'Food', price: '60', stationId: tandoor }));
    m = (await s.owner.get(`${s.B}/menu`)).json;
    expect(m.items.find((i: any) => i.name === 'Beer 650 ml')).toMatchObject({ station: 'bar', stationId: bar.id });
    expect(m.items.find((i: any) => i.name === 'Butter Naan')).toMatchObject({ station: 'kitchen', stationId: tandoor });
    expect(cat('Food')).toMatchObject({ kot: 1, stationId: kitchen.id });

    const o = (await s.ok(s.counter.post(`${s.B}/orders`, { kind: 'table', place: 'K1' }))).id;
    const add = (itemId: string, delta = 1) => s.ok(s.counter.post(`${s.B}/orders/${o}/items`, { itemId, delta }));
    await add(s.items['Masala Dosa']);
    await add(naan.id, 2);
    await add(m.items.find((i: any) => i.name === 'Tandoori Roti').id, 3);
    await add(s.items['Beer 650 ml']);
    let r = await add(cig, 2);
    expect(r.order.lines.find((l: any) => l.name === 'Test Cigarette')).toMatchObject({ qty: 2, sentQty: 2, noKot: true });
    const kots = (await s.ok(s.counter.post(`${s.B}/orders/${o}/kot`))).kots;
    expect(kots.map((k: any) => [k.station, k.printAt, k.lines.map((l: any) => `${l.qty} ${l.name}`).join(', ')])).toEqual([
      ['Kitchen', 'counter', '1 Masala Dosa'], ['Tandoor', 'counter', '2 Butter Naan, 3 Tandoori Roti'], ['Bar', 'counter', '1 Beer 650 ml']]);
    // A no-KOT item comes off without a reason and makes no KOT; more of it needs no KOT either.
    const cigLine = r.order.lines.find((l: any) => l.name === 'Test Cigarette');
    r = await s.ok(s.counter.post(`${s.B}/orders/${o}/items`, { lineId: cigLine.id, delta: -1 }));
    expect(r).toMatchObject({ cancelledSent: 0, kots: [] });
    await add(cig);
    expect((await s.counter.post(`${s.B}/orders/${o}/kot`)).status).toBe(409); // nothing new to send
    expect((await s.counter.post(`${s.B}/orders/${o}/bill`, { entityId: s.company })).status).toBe(201);

    // A station still in use cannot be taken out of use.
    expect((await s.owner.put(`${s.B}/stations/${tandoor}`, { name: 'Tandoor', how: 'screen', active: false })).status).toBe(409);
    // A station marked as bar makes its items count as bar (stock and bar reports).
    await s.ok(s.owner.put(`${s.B}/stations/${tandoor}`, { name: 'Tandoor', how: 'screen', isBar: true }));
    expect((await q("SELECT station FROM menu_items WHERE name = 'Butter Naan' AND business_id = ?", s.businessId))[0].station).toBe('bar');
  });

  it("a station's device prints and shows only its KOTs; when it is offline the counter prints them; a cancel goes too", async () => {
    const s = await setupBusiness();
    const { stations } = await s.ok(s.owner.get(`${s.B}/stations`));
    const [kitchen, bar] = stations;
    await s.ok(s.owner.put(`${s.B}/stations/${kitchen.id}`, { name: 'Kitchen', how: 'both', copies: 2 }));
    const kd = await stationDevice(s, kitchen.id);
    // The station device asks (and so is online); the bar has no device.
    let st = await s.ok(kd.get('/station'));
    expect(st).toMatchObject({ station: { name: 'Kitchen', how: 'both', copies: 2 }, kots: [] });

    const o = (await s.ok(s.counter.post(`${s.B}/orders`, { kind: 'table', place: 'K2' }))).id;
    await s.ok(s.counter.post(`${s.B}/orders/${o}/items`, { itemId: s.items['Masala Dosa'], delta: 2 }));
    await s.ok(s.counter.post(`${s.B}/orders/${o}/items`, { itemId: s.items['Beer 650 ml'], delta: 1 }));
    const kots = (await s.ok(s.counter.post(`${s.B}/orders/${o}/kot`))).kots;
    expect(kots.map((k: any) => [k.station, k.printAt, k.copies])).toEqual([['Kitchen', 'station', 2], ['Bar', 'counter', 1]]);

    st = await s.ok(kd.get('/station'));
    expect(st.kots).toHaveLength(1);
    const k = st.kots[0];
    expect(k).toMatchObject({ place: 'K2', status: 'new', toPrint: true, lines: [{ name: 'Masala Dosa', qty: 2 }] });
    await s.ok(kd.post(`/station/kots/${k.id}/printed`));
    await s.ok(kd.post(`/station/kots/${k.id}/start`));
    st = await s.ok(kd.get('/station'));
    expect(st.kots[0]).toMatchObject({ status: 'started', toPrint: false });
    await s.ok(kd.post(`/station/kots/${k.id}/ready`));
    expect((await s.ok(kd.get('/station'))).kots).toEqual([]);

    // The bar's KOT is not the kitchen's to see or touch.
    const barKot = (await q("SELECT id FROM kots WHERE business_id = ? AND station = 'Bar'", s.businessId))[0].id;
    expect((await kd.post(`/station/kots/${barKot}/ready`)).status).toBe(404);
    // A station device is not a counter: no PIN sign-in, no business screens.
    expect((await kd.post('/auth/pin', { staffId: s.cashierId, pin: '2468' })).status).toBe(403);
    expect((await kd.get(`${s.B}/orders`)).status).toBe(401);
    expect((await s.counter.get('/station')).status).toBe(401);

    // Cancelling a dosa already sent tells the kitchen with a cancel KOT.
    const line = (await s.ok(s.counter.get(`${s.B}/orders/${o}`))).order.lines.find((l: any) => l.name === 'Masala Dosa');
    const r = await s.ok(s.counter.post(`${s.B}/orders/${o}/items`, { lineId: line.id, delta: -1, reasonId: s.reasons.kot_cancel }));
    expect(r.kots).toEqual([expect.objectContaining({ station: 'Kitchen', printAt: 'station', lines: [expect.objectContaining({ name: 'Masala Dosa', qty: -1, cancelled: true })] })]);
    expect((await s.ok(kd.get('/station'))).kots[0]).toMatchObject({ toPrint: true, lines: [{ qty: -1, cancelled: true }] });

    // Offline (not asked for a minute): its KOTs print at the counter.
    await q('UPDATE devices SET last_seen_at = ? WHERE station_id = ?', Date.now() - 120_000, kitchen.id);
    await s.ok(s.counter.post(`${s.B}/orders/${o}/items`, { itemId: s.items['Masala Dosa'], delta: 1 }));
    const k2 = (await s.ok(s.counter.post(`${s.B}/orders/${o}/kot`))).kots;
    expect(k2.map((x: any) => [x.station, x.printAt])).toEqual([['Kitchen', 'counter']]);
    const dev = (await s.ok(s.owner.get(`${s.B}/devices`))).devices.find((d: any) => d.station === 'Kitchen');
    expect(dev).toMatchObject({ name: 'Station tablet' });
    void bar;
  });
});
