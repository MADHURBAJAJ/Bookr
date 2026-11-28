// The Bar Count app (28 Nov 2026): people on phones with tick boxes (Serve, Bar count, Kitchen count, Approve counts), a
// live count on the phone with rows typed offline sent later, approval on the phone or at the PC by whoever is ticked,
// and a count left waiting that stops nothing. Names and numbers are invented.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Client, dispose, q, setupBusiness } from './helpers';

afterAll(dispose);
afterEach(() => { vi.useRealTimers(); });

async function phone(businessId: string, mobile: string, pin: string) {
  const p = new Client();
  const r = await p.call('POST', '/serve/signin', { businessId, phone: mobile, pin }, { 'CF-Connecting-IP': '203.0.113.9' });
  if (r.status !== 200) throw new Error(JSON.stringify(r.json));
  return p;
}

async function business() {
  const s = await setupBusiness();
  const { B, owner, ok, businessId } = s;
  const t = Date.now();
  await q("INSERT INTO stock_stores (id, business_id, name, kind, created_at) VALUES (?, ?, 'Sample Bar', 'bar', ?), (?, ?, 'Sample Kitchen', 'kitchen', ?)",
    `bar-${businessId}`, businessId, t, `kit-${businessId}`, businessId, t);
  const rum = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Rum', unit: 'ml', packName: 'bottle', packSize: 750, costPerPack: '600', category: 'Rum' }))).id;
  const beer = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Lager', unit: 'pcs', packName: 'box', packSize: 12, costPerPack: '1200', category: 'Beer' }))).id;
  const oil = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Oil', unit: 'ml', packName: 'can', packSize: 1000, category: 'Kitchen' }))).id;
  await q(`INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, shift_day, at) VALUES
    (?1 || 'a', ?1, ?2, ?3, 'purchase', 3750, '2026-11-27', ?5), (?1 || 'b', ?1, ?4, ?3, 'purchase', 48, '2026-11-27', ?5)`, businessId, rum, `bar-${businessId}`, beer, t - 7_200_000);
  const bar = (await ok(owner.post(`${B}/stock/count-lists`, { name: 'Bar count', storeId: `bar-${businessId}`, categories: ['Rum', 'Beer'] }))).id;
  const kitchen = (await ok(owner.post(`${B}/stock/count-lists`, { name: 'Kitchen count', storeId: `kit-${businessId}`, categories: ['Kitchen'] }))).id;
  return { ...s, rum, beer, oil, bar, kitchen };
}

describe('Bar Count app', () => {
  it('only the Owner ticks access; each tick is checked on every request', async () => {
    const s = await business();
    const { B, owner, counter, ok, businessId } = s;
    // Added before, or with no ticks given: Serve only, as now.
    const anil = (await ok(owner.post(`${B}/servers`, { name: 'Anil', phone: '9800022201', pin: '482915' }))).id;
    expect((await ok(owner.get(`${B}/servers`))).servers[0].access).toEqual(['serve']);
    expect((await counter.put(`${B}/servers/${anil}`, { access: ['bar_count'] })).status).toBe(403);
    expect((await owner.put(`${B}/servers/${anil}`, { access: ['everything'] })).status).toBe(400);

    const p = await phone(businessId, '9800022201', '482915');
    expect((await p.get('/count/me')).status).toBe(403);               // not ticked for Bar Count
    expect((await p.get('/serve/kots')).status).toBe(200);
    await ok(owner.put(`${B}/servers/${anil}`, { access: ['bar_count'] }));
    expect((await p.get('/serve/kots')).status).toBe(403);             // Serve taken away: at once, same sign-in
    const me = await ok(p.get('/count/me'));
    expect(me.lists.map((l: any) => l.name)).toEqual(['Bar count']);   // not the kitchen list
    expect((await p.post('/count/start', { listId: s.kitchen })).status).toBe(403);
    expect(me.waiting).toEqual([]);

    // Staff at the PC: the Owner always approves; managers start ticked and can be unticked; a cashier can be ticked.
    const staff = (await ok(owner.get(`${B}/staff`))).staff;
    const tick = (n: string) => !!staff.find((x: any) => x.name === n).countApprove;
    expect([tick('Owner'), tick('Sample Manager'), tick('Ravi')]).toEqual([true, true, false]);
    const ownerId = staff.find((x: any) => x.name === 'Owner').id;
    expect((await owner.put(`${B}/staff/${ownerId}/count-approve`, { on: false })).status).toBe(409);
    expect((await counter.put(`${B}/staff/${s.cashierId}/count-approve`, { on: true })).status).toBe(403);
  });

  it('counts on the phone, keeps rows typed offline at their time, and is approved on the phone', async () => {
    const s = await business();
    const { B, owner, ok, businessId } = s;
    await ok(owner.post(`${B}/servers`, { name: 'Ramesh', phone: '9800022202', pin: '551177', access: ['bar_count'] }));
    await ok(owner.post(`${B}/servers`, { name: 'Sunita', phone: '9800022203', pin: '663311', access: ['approve_counts'] }));
    const ramesh = await phone(businessId, '9800022202', '551177');
    const sunita = await phone(businessId, '9800022203', '663311');

    vi.useFakeTimers({ toFake: ['Date'] });
    const id = (await ok(ramesh.post('/count/start', { listId: s.bar }))).id;
    expect((await ok(ramesh.post('/count/start', { listId: s.bar }))).id).toBe(id);   // carries on with the same count
    // The rum is typed with no Wi-Fi 5 minutes in (5 bottles in hand then); 750 ml is sold after; the row reaches the server
    // 20 minutes in, and is compared with the stock when it was typed.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const typedAt = Date.now();
    vi.setSystemTime(Date.now() + 15 * 60_000);
    await q("INSERT INTO stock_moves (id, business_id, item_id, store_id, kind, qty, shift_day, at) VALUES (?, ?, ?, ?, 'sale', -750, '2026-11-27', ?)",
      `sale-${businessId}`, businessId, s.rum, `bar-${businessId}`, Date.now());
    await ok(ramesh.put(`/count/counts/${id}`, { lines: [{ itemId: s.rum, place1: 750 + 180, place2: 2250, typedAt }, { itemId: s.beer, place1: 10, place2: 34 }] }));
    // A late copy of an older row does not undo a newer one.
    await ok(ramesh.put(`/count/counts/${id}`, { lines: [{ itemId: s.rum, place1: 1, place2: 1, typedAt: typedAt - 500 }] }));
    const ck = await ok(ramesh.get(`/count/counts/${id}`));
    const row = (n: string) => ck.groups.flatMap((g: any) => g.items).find((i: any) => i.name === n);
    expect(row('Sample Rum')).toMatchObject({ inHand: 3750, counted: 3180, diff: -570 });   // the sale after it was typed is not missing
    expect(row('Sample Lager')).toMatchObject({ counted: 44, diff: -4 });
    expect(ck.count).toMatchObject({ by: 'Ramesh', onPhone: true, mode: 'live' });

    // Not hers to type into; not his to approve.
    expect((await sunita.put(`/count/counts/${id}`, { lines: [] })).status).toBe(404);
    expect((await ramesh.post(`/count/counts/${id}/approve`, {})).status).toBe(403);
    await ok(ramesh.post(`/count/counts/${id}/send`, {}));
    expect((await ok(ramesh.get('/count/me'))).mine[0]).toMatchObject({ id, status: 'waiting' });

    // Sunita sends the beer back; Ramesh counts it again; she approves.
    expect((await ok(sunita.get('/count/me'))).waiting.map((w: any) => [w.id, w.byName])).toEqual([[id, 'Ramesh']]);
    await ok(sunita.post(`/count/counts/${id}/back`, { itemIds: [s.beer], note: 'Check the cold room' }));
    const again = (await ok(ramesh.get('/count/me'))).mine[0];
    expect(again).toMatchObject({ status: 'sent_back', again: 1, note: 'Check the cold room' });
    await ok(ramesh.put(`/count/counts/${id}`, { lines: [{ itemId: s.beer, place1: 12, place2: 34 }] }));
    await ok(ramesh.post(`/count/counts/${id}/send`, {}));
    expect(await ok(sunita.post(`/count/counts/${id}/approve`, {}))).toMatchObject({ rows: 2, differ: 2 });
    const moves = await q("SELECT item_id, qty, at FROM stock_moves WHERE kind = 'count' AND business_id = ? ORDER BY qty", businessId);
    expect(moves).toEqual([{ item_id: s.rum, qty: -570, at: typedAt }, { item_id: s.beer, qty: -2, at: expect.any(Number) }]);
    const k = (await q('SELECT status, by_server, decided_by_server, decided_by FROM stock_counts WHERE id = ?', id))[0];
    expect(k.status).toBe('approved'); expect(k.decided_by).toBeNull(); expect(k.decided_by_server).not.toBeNull();
    // The PC list shows who counted it, on the phone.
    const list = (await ok(owner.get(`${B}/stock/count-sessions`))).counts;
    expect(list[0]).toMatchObject({ byName: 'Ramesh', onPhone: 1, status: 'approved' });
  });

  it('a waiting count stops nothing; at the PC only ticked staff approve', async () => {
    const s = await business();
    const { B, owner, counter, ok, businessId } = s;
    await ok(owner.post(`${B}/servers`, { name: 'Ramesh', phone: '9800022204', pin: '551177', access: ['bar_count'] }));
    const ramesh = await phone(businessId, '9800022204', '551177');
    const first = (await ok(ramesh.post('/count/start', { listId: s.bar }))).id;
    await ok(ramesh.put(`/count/counts/${first}`, { lines: [{ itemId: s.beer, place1: 48, place2: 0 }] }));
    await ok(ramesh.post(`/count/counts/${first}/send`, {}));
    // Still waiting: the next count starts all the same.
    const second = (await ok(ramesh.post('/count/start', { listId: s.bar }))).id;
    expect(second).not.toBe(first);

    // The manager is unticked: can no longer approve at the PC. A cashier the Owner ticks can.
    const manager = new Client();
    const mEmail = (await q('SELECT email FROM staff WHERE id = ?', s.managerId))[0].email;
    await ok(manager.post('/auth/login', { email: mEmail, password: 'manager-password-1' }));
    await ok(owner.put(`${B}/staff/${s.managerId}/count-approve`, { on: false }));
    expect((await manager.post(`${B}/stock/count-sessions/${first}/approve`, {})).status).toBe(403);
    expect((await ok(manager.get(`${B}/stock/count-sessions`))).canApprove).toBe(false);
    expect((await counter.post(`${B}/stock/count-sessions/${first}/approve`, {})).status).toBe(403);
    await ok(owner.put(`${B}/staff/${s.cashierId}/count-approve`, { on: true }));
    expect(await ok(counter.post(`${B}/stock/count-sessions/${first}/approve`, {}))).toMatchObject({ rows: 1, differ: 0 });

    // Removed: the phone stops at once.
    const id = (await ok(owner.get(`${B}/servers`))).servers[0].id;
    await ok(owner.put(`${B}/servers/${id}`, { active: false }));
    expect((await ramesh.get('/count/me')).status).toBe(401);
  });
});
