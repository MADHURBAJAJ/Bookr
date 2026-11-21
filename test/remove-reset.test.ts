// Remove login, password reset and change number or name (approved 21 Nov 2026; migration 0034). Invented people and numbers.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, businessWithAllRoles, resetDb, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const D = '2026-11-20';
const inviteToken = (link: string) => link.split('#/invite/')[1];
const resetToken = (link: string) => link.split('#/reset/')[1];

async function schoolWithCashier() {
  const h = await businessWithAllRoles('Bgi Saharanpur');
  const o = h.clients.owner;
  const sms = (await o.post(`/businesses/${h.bid}/branches`, { name: 'Chilkana Road' })).json.id;
  const book = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Anup Maheshwari', branchId: sms, openingBalance: '0', openingDate: '2026-11-19' })).json.id;
  const inv = await o.post(`/businesses/${h.bid}/invites`, { phone: '94120 66666', role: 'entry_staff', accountId: book });
  const anup = new Client();
  expect((await anup.post(`/invites/${inviteToken(inv.json.link)}/accept`, { name: 'Anup Maheshwari', password: 'long-enough-pw' })).status).toBe(200);
  const anupId = (await anup.get('/me')).json.user.id;
  return { h, o, sms, book, anup, anupId };
}

describe('remove login', () => {
  it('is refused while cash he handed over waits; then his book keeps its lines, has no cashier, and he is signed out', async () => {
    const { h, o, sms, book, anup, anupId } = await schoolWithCashier();
    const other = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Ravi Sharma', branchId: sms, cashierUserId: h.users.entry_staff.id, openingBalance: '0', openingDate: '2026-11-19' })).json.id;
    await anup.post(`/businesses/${h.bid}/cashbooks/${book}/entries`, { day: D, kind: 'other_in', amount: '5,000', narration: 'Admission forms' });
    await anup.post(`/businesses/${h.bid}/cashbooks/${book}/entries`, { day: D, kind: 'handover_out', amount: '3,000', to: { kind: 'book', accountId: other } });

    let chk = (await o.get(`/businesses/${h.bid}/members/${anupId}/remove-check`)).json;
    expect(chk.books).toMatchObject([{ id: book, inHandPaise: 200000 }]);
    expect(chk.waiting).toMatchObject([{ amountPaise: 300000, toName: 'Ravi Sharma' }]);
    const refused = await o.del(`/businesses/${h.bid}/members/${anupId}`);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/waiting.*3,000.*Ravi Sharma/);

    // Ravi accepts it: nothing waits; ₹ 2,000 still in the book is only a warning.
    const waiting = (await h.clients.entry_staff.get(`/businesses/${h.bid}/cashbooks/${other}/day/${D}`)).json.waiting;
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/handovers/${waiting[0].id}/receive`, { day: D })).status).toBe(200);
    chk = (await o.get(`/businesses/${h.bid}/members/${anupId}/remove-check`)).json;
    expect(chk.waiting).toHaveLength(0);
    // Only the Owner removes.
    expect((await h.clients.accountant.del(`/businesses/${h.bid}/members/${anupId}`)).status).toBe(403);
    expect((await o.del(`/businesses/${h.bid}/members/${anupId}`)).json).toMatchObject({ ok: true, books: 1 });

    // His login is gone: signed out, cannot see the business. His book and lines stay, waiting for a new cashier.
    expect((await anup.get('/me')).status).toBe(401);
    const list = (await o.get(`/businesses/${h.bid}/cashbooks`)).json;
    expect(list.books.find((b: { id: string }) => b.id === book)).toMatchObject({ cashierUserId: null, inHandPaise: 200000 });
    expect((await o.get(`/businesses/${h.bid}/cashbooks/${book}/day/${D}`)).json.entries).toHaveLength(2);
    expect((await o.get(`/businesses/${h.bid}/members`)).json.members.map((m: { id: string }) => m.id)).not.toContain(anupId);

    // A new cashier is invited to the same book.
    const inv = await o.post(`/businesses/${h.bid}/invites`, { phone: '94120 99999', role: 'entry_staff', accountId: book });
    const neha = new Client();
    expect((await neha.post(`/invites/${inviteToken(inv.json.link)}/accept`, { name: 'Neha Verma', password: 'long-enough-pw' })).status).toBe(200);
    expect((await o.get(`/businesses/${h.bid}/cashbooks`)).json.books.find((b: { id: string }) => b.id === book)).toMatchObject({ cashierName: 'Neha Verma' });
  });

  it('a cash holder who joined by phone goes back to waiting for someone to keep it', async () => {
    const h = await businessWithAllRoles('Bgi Saharanpur');
    const o = h.clients.owner;
    await o.post(`/businesses/${h.bid}/branches`, { name: 'Chilkana Road' });
    const tr = (await o.post(`/businesses/${h.bid}/cashbooks`, { holder: true, name: 'Rakesh Gupta (Trustee)', openingBalance: '0', openingDate: '2026-11-19' })).json.id;
    const inv = await o.post(`/businesses/${h.bid}/invites`, { phone: '94120 77777', role: 'entry_staff', accountId: tr });
    const rk = new Client();
    await rk.post(`/invites/${inviteToken(inv.json.link)}/accept`, { name: 'Rakesh Gupta', password: 'long-enough-pw' });
    const rkId = (await rk.get('/me')).json.user.id;
    expect((await o.del(`/businesses/${h.bid}/members/${rkId}`)).status).toBe(200);
    const list = (await o.get(`/businesses/${h.bid}/cashbooks`)).json;
    expect(list.books.map((b: { id: string }) => b.id)).not.toContain(tr);
    expect(list.pendingHolders.map((b: { id: string }) => b.id)).toContain(tr);
  });
});

describe('password reset', () => {
  it('the Owner sends a link; it works once for 24 hours, signs out every phone, and the old password stops working', async () => {
    const { h, o, anup, anupId } = await schoolWithCashier();
    // Not for an Owner, and only the Owner makes one.
    expect((await o.post(`/businesses/${h.bid}/members/${h.users.owner.id}/reset`, {})).status).toBe(403);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/members/${anupId}/reset`, {})).status).toBe(403);
    const first = await o.post(`/businesses/${h.bid}/members/${anupId}/reset`, {});
    expect(first.status).toBe(201);
    expect(first.json.phone).toBe('+919412066666');
    expect(first.json.expiresAt - Date.now()).toBeGreaterThan(23.9 * 3600000);
    // A newer link replaces the older one.
    const link = (await o.post(`/businesses/${h.bid}/members/${anupId}/reset`, {})).json.link;
    const guest = new Client();
    expect((await guest.get(`/resets/${resetToken(first.json.link)}`)).status).toBe(404);
    expect((await guest.get(`/resets/${resetToken(link)}`)).json).toEqual({ name: 'Anup Maheshwari', signIn: '+919412066666' });
    // The old password still works until the new one is set.
    const phone2 = new Client();
    expect((await phone2.post('/auth/login', { email: '94120 66666', password: 'long-enough-pw' })).status).toBe(200);
    expect((await guest.post(`/resets/${resetToken(link)}`, { password: 'short' })).status).toBe(400);
    expect((await guest.post(`/resets/${resetToken(link)}`, { password: 'a-new-password-1' })).status).toBe(200);
    // Signed in on this phone; every other phone signed out; old password refused; the link is used up.
    expect((await guest.get('/me')).json.user.id).toBe(anupId);
    expect((await anup.get('/me')).status).toBe(401);
    expect((await phone2.get('/me')).status).toBe(401);
    expect((await new Client().post('/auth/login', { email: '94120 66666', password: 'long-enough-pw' })).status).toBe(401);
    expect((await new Client().post('/auth/login', { email: '94120 66666', password: 'a-new-password-1' })).status).toBe(200);
    expect((await new Client().post(`/resets/${resetToken(link)}`, { password: 'another-password' })).status).toBe(404);
  });

  it('a link stops working after 24 hours, when the person is removed, or if they become an Owner', async () => {
    const { h, o, anupId } = await schoolWithCashier();
    const late = (await o.post(`/businesses/${h.bid}/members/${anupId}/reset`, {})).json.link;
    await sql`UPDATE password_resets SET expires_at = ${Date.now() - 1}`;
    expect((await new Client().get(`/resets/${resetToken(late)}`)).status).toBe(404);

    const owner = (await o.post(`/businesses/${h.bid}/members/${anupId}/reset`, {})).json.link;
    await o.patch(`/businesses/${h.bid}/members/${anupId}`, { role: 'owner' });
    expect((await new Client().post(`/resets/${resetToken(owner)}`, { password: 'a-new-password-1' })).status).toBe(404);
    await o.patch(`/businesses/${h.bid}/members/${anupId}`, { role: 'entry_staff' });

    const removed = (await o.post(`/businesses/${h.bid}/members/${anupId}/reset`, {})).json.link;
    await o.del(`/businesses/${h.bid}/members/${anupId}`);
    expect((await new Client().get(`/resets/${resetToken(removed)}`)).status).toBe(404);
  });
});

describe('change number or name', () => {
  it('the Owner changes a cashier\'s number and fixes his name; he signs in with the new number', async () => {
    const { h, o, anupId } = await schoolWithCashier();
    expect((await o.patch(`/businesses/${h.bid}/members/${anupId}/profile`, { phone: '123' })).status).toBe(400);
    // Another person's number is refused.
    await sql`UPDATE users SET phone = '+919412011111' WHERE id = ${h.users.viewer.id}`;
    expect((await o.patch(`/businesses/${h.bid}/members/${anupId}/profile`, { phone: '94120 11111' })).status).toBe(409);
    expect((await h.clients.accountant.patch(`/businesses/${h.bid}/members/${anupId}/profile`, { name: 'Anup M' })).status).toBe(403);
    expect((await o.patch(`/businesses/${h.bid}/members/${h.users.owner.id}/profile`, { name: 'X' })).status).toBe(403);
    const res = await o.patch(`/businesses/${h.bid}/members/${anupId}/profile`, { name: 'Anup Maheshwari Ji', phone: '98370 12345' });
    expect(res.json).toMatchObject({ ok: true, name: 'Anup Maheshwari Ji', phone: '+919837012345' });
    expect((await new Client().post('/auth/login', { email: '94120 66666', password: 'long-enough-pw' })).status).toBe(401);
    const c = new Client();
    expect((await c.post('/auth/login', { email: '98370 12345', password: 'long-enough-pw' })).status).toBe(200);
    expect((await c.get('/me')).json.user).toMatchObject({ name: 'Anup Maheshwari Ji', email: '+919837012345' });
    const m = (await o.get(`/businesses/${h.bid}/members`)).json.members.find((x: { id: string }) => x.id === anupId);
    expect(m).toMatchObject({ email: '+919837012345', phone: '+919837012345', ownerAnywhere: 0 });
    // The old number is free again: a new cashier can be invited with it.
    expect((await o.post(`/businesses/${h.bid}/invites`, { phone: '94120 66666', role: 'entry_staff' })).status).toBe(201);
  });
});
