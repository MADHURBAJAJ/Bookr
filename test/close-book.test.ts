// Removing a book never used, closing one with history (approved 23 Nov 2026, migration 0036). Invented amounts.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, resetDb, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const TODAY = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

async function setup() {
  const h = await businessWithAllRoles('Bgi Saharanpur');
  const o = h.clients.owner;
  const sms = (await o.post(`/businesses/${h.bid}/branches`, { name: 'Bajaj International School' })).json.id;
  const mk = async (name: string, cashierUserId: string | null = null) =>
    (await o.post(`/businesses/${h.bid}/cashbooks`, { name, branchId: sms, cashierUserId, openingBalance: '0', openingDate: TODAY })).json.id as string;
  const list = async () => (await o.get(`/businesses/${h.bid}/cashbooks`)).json;
  return { ...h, o, mk, list };
}

describe('removing and closing a book', () => {
  it('a book never used is removed (a count alone is no use); its waiting invite is cancelled; only setup roles', async () => {
    const { o, mk, list, bid, clients } = await setup();
    const madhur = await mk('MADHUR BAJAJ');
    const inv = await o.post(`/businesses/${bid}/invites`, { phone: '9412055555', role: 'entry_staff', accountId: madhur });
    expect(inv.status).toBe(201);
    await o.put(`/businesses/${bid}/cashbooks/${madhur}/count/${TODAY}`, { counted: '0' });
    expect((await list()).books.find((b: { id: string }) => b.id === madhur)).toMatchObject({ used: false });
    expect((await clients.entry_staff.del(`/businesses/${bid}/cashbooks/${madhur}`)).status).toBe(403);
    expect((await o.del(`/businesses/${bid}/cashbooks/${madhur}`)).status).toBe(200);
    expect((await list()).books.some((b: { id: string }) => b.id === madhur)).toBe(false);
    expect((await o.get(`/businesses/${bid}/cashbooks/${madhur}/day/${TODAY}`)).status).toBe(404);
  });

  it('a book with lines cannot be removed; it is closed once its cash is handed over, read only, and reopened', async () => {
    const { o, mk, list, bid, users, clients } = await setup();
    const rajesh = await mk('Rajesh Kumar', users.entry_staff.id);
    const other = await mk('Anup Maheshwari');
    const base = `/businesses/${bid}/cashbooks/${rajesh}`;
    await clients.entry_staff.post(`${base}/entries`, { day: TODAY, kind: 'other_in', amount: '500', narration: 'Form' });
    expect((await list()).books.find((b: { id: string }) => b.id === rajesh)).toMatchObject({ used: true });
    expect((await o.del(base)).status).toBe(409);
    // ₹ 500 in hand: hand it over first; while it is on the way the book cannot close either.
    expect((await o.post(`${base}/close`, { closed: true })).json.error).toMatch(/in hand/);
    await clients.entry_staff.post(`${base}/entries`, { day: TODAY, kind: 'handover_out', amount: '500', to: { kind: 'book', accountId: other } });
    expect((await o.post(`${base}/close`, { closed: true })).json.error).toMatch(/on the way/);
    const h = (await list()).handovers[0];
    await o.post(`/businesses/${bid}/handovers/${h.id}/receive`, {});
    expect((await o.post(`${base}/close`, { closed: true })).status).toBe(200);
    const l = await list();
    expect(l.books.some((b: { id: string }) => b.id === rajesh)).toBe(false);
    expect(l.closed).toMatchObject([{ id: rajesh, name: 'Rajesh Kumar' }]);
    // Read only: days readable, nothing written, not a hand-over choice.
    const d = (await o.get(`${base}/day/${TODAY}`)).json;
    expect(d.can.write).toBe(false);
    expect(d.entries).toHaveLength(2);
    expect((await clients.entry_staff.post(`${base}/entries`, { day: TODAY, kind: 'expense', amount: '10', narration: 'x' })).status).toBe(409);
    expect((await o.get(`/businesses/${bid}/cashbooks/${other}/day/${TODAY}`)).json.targets.some((t: { id: string }) => t.id === rajesh)).toBe(false);
    expect((await o.post(`/businesses/${bid}/cashbooks/${other}/entries`, { day: TODAY, kind: 'handover_out', amount: '100', to: { kind: 'book', accountId: rajesh } })).status).toBe(400);
    // The cashier no longer sees it.
    expect((await clients.entry_staff.get(`/businesses/${bid}/cashbooks`)).json.books).toHaveLength(0);
    // Reopen.
    expect((await o.post(`${base}/close`, { closed: false })).status).toBe(200);
    expect((await list()).books.some((b: { id: string }) => b.id === rajesh)).toBe(true);
    expect((await o.get(`${base}/day/${TODAY}`)).json.can.write).toBe(true);
  });
});
