// Bookr POS admin: restaurants added by an admin, owners who see only the restaurants given to them, pausing, and
// support visits only while the owner allows them. All names and emails invented.
import { afterAll, describe, expect, it } from 'vitest';
import { Client, dispose, q, SETUP_TOKEN } from './helpers';

afterAll(dispose);
const ok = async (p: Promise<{ status: number; json: any }>) => { const x = await p; if (x.status >= 300) throw new Error(`${x.status} ${JSON.stringify(x.json)}`); return x.json; };

describe('Bookr POS admin', () => {
  it('runs restaurants without seeing inside them; owners see only their own; support only when allowed', async () => {
    const admin = new Client();
    expect((await admin.post('/admin/setup', { name: 'Admin', email: 'admin@bookrpos.test', password: 'admin-password-123' })).status).toBe(403); // no token
    await ok(admin.call('POST', '/admin/setup', { name: 'Admin', email: 'admin@bookrpos.test', password: 'admin-password-123' }, { 'X-Setup-Token': SETUP_TOKEN }));
    expect((await admin.call('POST', '/admin/setup', { name: 'B', email: 'b@bookrpos.test', password: 'admin-password-123' }, { 'X-Setup-Token': SETUP_TOKEN })).status).toBe(409);
    expect((await admin.get('/admin/restaurants')).status).toBe(401);
    await ok(admin.post('/admin/login', { email: 'admin@bookrpos.test', password: 'admin-password-123' }));

    // Two customers: Asha has two restaurants, Ravi one.
    const r1 = (await ok(admin.post('/admin/restaurants', { name: 'Asha Café', ownerName: 'Asha', ownerEmail: 'asha@cafe.test', ownerPassword: 'asha-password-123' }))).id;
    const r3 = (await ok(admin.post('/admin/restaurants', { name: 'Ravi Dhaba', ownerName: 'Ravi', ownerEmail: 'ravi@dhaba.test', ownerPassword: 'ravi-password-123' }))).id;
    const asha = new Client();
    await ok(asha.post('/auth/login', { email: 'asha@cafe.test', password: 'asha-password-123' }));
    await ok(asha.post(`/businesses/${r1}/menu`, { name: 'Filter Coffee', price: '60', category: 'Drinks' }));
    // Her second restaurant, its menu copied from her first; Ravi's menu cannot be copied into hers.
    expect((await admin.post('/admin/restaurants', { name: 'X', ownerEmail: 'asha@cafe.test', copyFrom: r3 })).status).toBe(400);
    const r2 = (await ok(admin.post('/admin/restaurants', { name: 'Asha Café Juhu', ownerEmail: 'asha@cafe.test', copyFrom: r1 }))).id;

    let me = await ok(asha.get('/me'));
    expect(me.restaurants.map((r: any) => r.name)).toEqual(['Asha Café', 'Asha Café Juhu']);
    await ok(asha.post('/auth/switch', { businessId: r2 }));
    me = await ok(asha.get('/me'));
    expect(me.business.id).toBe(r2);
    const m2 = await ok(asha.get(`/businesses/${r2}/menu`));
    expect(m2.items.map((i: any) => i.name)).toEqual(['Filter Coffee']);
    expect(m2.stations.map((x: any) => x.name)).toEqual(['Kitchen', 'Bar']);
    // Her one password opens both; Ravi's restaurant is not hers to switch to or read.
    expect((await asha.post('/auth/switch', { businessId: r3 })).status).toBe(404);
    expect((await asha.get(`/businesses/${r3}/menu`)).status).toBe(404);
    // A restaurant cannot take someone else's email for its staff.
    expect((await asha.post(`/businesses/${r2}/staff`, { name: 'Fake', role: 'manager', email: 'ravi@dhaba.test', password: 'whatever-password-1' })).status).toBe(409);

    // The admin's list: names, owners, status, use; no sales.
    const list = (await ok(admin.get('/admin/restaurants'))).restaurants;
    const row = list.find((r: any) => r.id === r1);
    expect(row).toMatchObject({ name: 'Asha Café', status: 'active', supportAccess: false, billsThisMonth: 0, owners: [{ name: 'Asha', email: 'asha@cafe.test' }] });
    expect(Object.keys(row).sort()).toEqual(['billsThisMonth', 'createdAt', 'id', 'lastUsedAt', 'name', 'owners', 'status', 'supportAccess']);
    // Not an admin: no admin pages.
    expect((await asha.get('/admin/restaurants')).status).toBe(401);

    // Support: refused until the owner turns it on; the visit is listed for her; turning it off ends it.
    expect((await admin.post(`/admin/restaurants/${r2}/visit`)).status).toBe(403);
    await ok(asha.put(`/businesses/${r2}/support`, { on: true }));
    await ok(admin.post(`/admin/restaurants/${r2}/visit`));
    const sme = await ok(admin.get('/me'));
    expect(sme).toMatchObject({ staff: { name: 'Bookr POS support', role: 'manager' }, support: true, restaurants: [] });
    expect((await admin.get(`/businesses/${r2}/staff`)).status).toBe(403); // a manager: no staff screen
    expect((await ok(asha.get(`/businesses/${r2}/support`))).visits).toEqual([{ at: expect.any(Number), by: 'Admin (admin@bookrpos.test)' }]);
    await ok(asha.put(`/businesses/${r2}/support`, { on: false }));
    expect((await admin.get('/me')).status).toBe(401);

    // Pausing: everyone there is signed out and cannot come back until resumed; her other restaurant still works.
    await ok(admin.put(`/admin/restaurants/${r2}`, { status: 'paused' }));
    expect((await asha.get('/me')).status).toBe(401);
    await ok(asha.post('/auth/login', { email: 'asha@cafe.test', password: 'asha-password-123' }));
    me = await ok(asha.get('/me'));
    expect([me.business.id, me.restaurants.map((r: any) => r.id)]).toEqual([r1, [r1]]);
    expect((await asha.post('/auth/switch', { businessId: r2 })).status).toBe(404);
    await ok(admin.put(`/admin/restaurants/${r2}`, { status: 'active' }));

    // A new password from the admin works at both of her restaurants.
    const ashaRow = (await q("SELECT id FROM staff WHERE business_id = ? AND email = 'asha@cafe.test'", r1))[0].id;
    await ok(admin.post(`/admin/owners/${ashaRow}/password`, { password: 'new-asha-password-1' }));
    expect((await asha.post('/auth/login', { email: 'asha@cafe.test', password: 'asha-password-123' })).status).toBe(401);
    await ok(asha.post('/auth/login', { email: 'asha@cafe.test', password: 'new-asha-password-1' }));
    await ok(asha.post('/auth/switch', { businessId: r2 }));
  });
});
