// Cashiers sign in with their mobile number (approved 21 Nov 2026; migration 0032). Invented numbers.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, businessWithAllRoles, resetDb, sql } from './helpers';
import { normalizePhone } from '../src/http';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const tokenOf = (link: string) => link.split('#/invite/')[1];

describe('phone sign-in', () => {
  it('reads a mobile number however it is typed', () => {
    expect(normalizePhone('94120 55555')).toBe('+919412055555');
    expect(normalizePhone('+91 94120-55555')).toBe('+919412055555');
    expect(normalizePhone('09412055555')).toBe('+919412055555');
    expect(normalizePhone('919412055555')).toBe('+919412055555');
    expect(normalizePhone('12345 67890')).toBeNull();
    expect(normalizePhone('9412')).toBeNull();
  });

  it('an invite by phone for a cash book: the cashier joins, is that book\'s cashier, and signs in with the number', async () => {
    const h = await businessWithAllRoles('Bgi Saharanpur');
    const o = h.clients.owner;
    const bis = (await o.post(`/businesses/${h.bid}/branches`, { name: 'Bajaj International School' })).json.id;
    const book = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Rajesh Kumar', branchId: bis, openingBalance: '0', openingDate: '2026-11-21' })).json.id;
    expect((await o.post(`/businesses/${h.bid}/invites`, { phone: '12345', role: 'entry_staff', accountId: book })).status).toBe(400);
    // Only the Owner invites.
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/invites`, { phone: '94120 55555', role: 'entry_staff', accountId: book })).status).toBe(403);
    const inv = await o.post(`/businesses/${h.bid}/invites`, { phone: '94120 55555', role: 'entry_staff', accountId: book });
    expect(inv.status).toBe(201);
    expect(inv.json.phone).toBe('+919412055555');
    let list = (await o.get(`/businesses/${h.bid}/cashbooks`)).json;
    expect(list.books[0]).toMatchObject({ cashierUserId: null, invite: { phone: '+919412055555' } });
    // Sending again replaces the earlier link.
    const again = await o.post(`/businesses/${h.bid}/invites`, { phone: '9412055555', role: 'entry_staff', accountId: book });
    const guest = new Client();
    expect((await guest.get(`/invites/${tokenOf(inv.json.link)}`)).status).toBe(404);
    const info = (await guest.get(`/invites/${tokenOf(again.json.link)}`)).json;
    expect(info).toMatchObject({ businessName: 'Bgi Saharanpur', phone: '+919412055555', email: null, hasAccount: false });
    expect((await guest.post(`/invites/${tokenOf(again.json.link)}/accept`, { name: 'Rajesh Kumar', password: 'long-enough-pw' })).status).toBe(200);
    // Joined: Entry staff, the book's cashier, sees only that book; the stand-in email is never shown.
    const me = (await guest.get('/me')).json;
    expect(me.user.email).toBe('+919412055555');
    expect(me.businesses).toMatchObject([{ id: h.bid, role: 'entry_staff' }]);
    list = (await o.get(`/businesses/${h.bid}/cashbooks`)).json;
    expect(list.books[0]).toMatchObject({ cashierName: 'Rajesh Kumar', invite: null });
    expect(list.books[0].cashierLastActive).toBeTruthy();
    expect((await guest.get(`/businesses/${h.bid}/cashbooks`)).json.books.map((b: { id: string }) => b.id)).toEqual([book]);
    const members = (await o.get(`/businesses/${h.bid}/members`)).json.members;
    expect(members.find((m: { name: string }) => m.name === 'Rajesh Kumar').email).toBe('+919412055555');
    // Signs in again with the number, typed any way.
    const phoneClient = new Client();
    expect((await phoneClient.post('/auth/login', { email: '094120 55555', password: 'long-enough-pw' })).status).toBe(200);
    expect((await new Client().post('/auth/login', { email: '94120 55555', password: 'wrong-password' })).status).toBe(401);
    // A number already in the business cannot be invited again.
    expect((await o.post(`/businesses/${h.bid}/invites`, { phone: '94120 55555', role: 'entry_staff' })).status).toBe(409);
  });

  it('an invite cannot name another business\'s book, and a bad number cannot be stored', async () => {
    const h = await businessWithAllRoles('One');
    const other = await businessWithAllRoles('Two');
    const br = (await other.clients.owner.post(`/businesses/${other.bid}/branches`, { name: 'X' })).json.id;
    const theirs = (await other.clients.owner.post(`/businesses/${other.bid}/cashbooks`, { name: 'Theirs', branchId: br, openingBalance: '0', openingDate: '2026-11-21' })).json.id;
    expect((await h.clients.owner.post(`/businesses/${h.bid}/invites`, { phone: '9412055555', role: 'entry_staff', accountId: theirs })).status).toBe(400);
    await expect(sql`INSERT INTO users (id, name, email, phone, password_hash, created_at) VALUES ('u-bad', 'Bad', 'b@x.in', '9412055555', 'x', 1)`).rejects.toThrow(/phone_format/);
  });
});
