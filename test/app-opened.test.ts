// Opened from the home-screen icon (approved 28 Nov 2026, migration 0045): first and last time, shown to the Owner.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, resetDb, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

describe('opened from the app icon', () => {
  it('is kept when the app says so, and the Owner sees it on the cashier\'s book', async () => {
    const h = await businessWithAllRoles('Test School Group');
    const o = h.clients.owner;
    const br = (await o.post(`/businesses/${h.bid}/branches`, { name: 'North Campus' })).json.id;
    const book = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Cashier North', branchId: br, cashierUserId: h.users.entry_staff.id, openingBalance: '0', openingDate: '2026-11-10' })).json.id;
    const shown = async () => (await o.get(`/businesses/${h.bid}/cashbooks`)).json.books.find((b: { id: string }) => b.id === book).cashierApp;

    // A browser tab only: nothing kept.
    await h.clients.entry_staff.get(`/businesses/${h.bid}/cashbooks`);
    expect(await shown()).toEqual({ firstAt: null, lastAt: null });

    await h.clients.entry_staff.call('GET', `/businesses/${h.bid}/cashbooks`, undefined, { 'X-Bookr-App': '1' });
    const first = await shown();
    expect(first.firstAt).toBeGreaterThan(0);
    expect(first.lastAt).toBe(first.firstAt);

    // Later opens move only the last time.
    await sql`UPDATE users SET app_last_at = app_last_at - 3600000, app_first_at = app_first_at - 3600000 WHERE id = ${h.users.entry_staff.id}`;
    await h.clients.entry_staff.call('GET', '/me', undefined, { 'X-Bookr-App': '1' });
    const later = await shown();
    expect(later.firstAt).toBe(first.firstAt - 3600000);
    expect(later.lastAt).toBeGreaterThan(later.firstAt);
    // The cashier does not get it.
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/cashbooks`)).json.books[0].cashierApp).toBeNull();
  });
});
