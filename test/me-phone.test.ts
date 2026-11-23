// Also sign in with a mobile number (approved 23 Nov 2026). Invented people and numbers.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, PASSWORD, businessWithAllRoles, resetDb, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const inviteToken = (link: string) => link.split('#/invite/')[1];

describe('also sign in with a mobile number', () => {
  it('an owner adds a number with their password; either signs in; a phone invite joins the same login', async () => {
    const h = await businessWithAllRoles('XOXO');
    const o = h.clients.owner;
    expect((await o.put('/me/phone', { phone: '94120 77777', password: 'wrong-password-x' })).status).toBe(401);
    expect((await o.put('/me/phone', { phone: '123', password: PASSWORD })).status).toBe(400);
    expect((await o.put('/me/phone', { phone: '94120 77777', password: PASSWORD })).json).toMatchObject({ ok: true, phone: '+919412077777' });
    expect((await o.get('/me')).json.user).toMatchObject({ phone: '+919412077777', phoneLogin: false });
    expect((await new Client().post('/auth/login', { email: '94120 77777', password: PASSWORD })).status).toBe(200);
    expect((await new Client().post('/auth/login', { email: h.users.owner.email, password: PASSWORD })).status).toBe(200);
    // Another business invites that number: it is the same person, who confirms with their password.
    const bgi = await businessWithAllRoles('Bgi Saharanpur');
    const inv = await bgi.clients.owner.post(`/businesses/${bgi.bid}/invites`, { phone: '94120 77777', role: 'owner' });
    const guest = new Client();
    expect((await guest.get(`/invites/${inviteToken(inv.json.link)}`)).json).toMatchObject({ hasAccount: true });
    expect((await guest.post(`/invites/${inviteToken(inv.json.link)}/accept`, { password: PASSWORD })).status).toBe(200);
    expect((await guest.get('/me')).json.businesses.map((b: { name: string }) => b.name).sort()).toEqual(['Bgi Saharanpur', 'XOXO']);
    // Taken off: email only again.
    expect((await o.put('/me/phone', { phone: null, password: PASSWORD })).json.phone).toBeNull();
    expect((await new Client().post('/auth/login', { email: '94120 77777', password: PASSWORD })).status).toBe(401);
  });

  it('a number already used by another login is refused; a phone login cannot use this', async () => {
    const h = await businessWithAllRoles('Bgi Saharanpur');
    const o = h.clients.owner;
    const inv = await o.post(`/businesses/${h.bid}/invites`, { phone: '94120 88888', role: 'entry_staff' });
    const cashier = new Client();
    await cashier.post(`/invites/${inviteToken(inv.json.link)}/accept`, { name: 'Ravi Sharma', password: 'long-enough-pw' });
    expect((await o.put('/me/phone', { phone: '94120 88888', password: PASSWORD })).status).toBe(409);
    expect((await cashier.put('/me/phone', { phone: '94120 99999', password: 'long-enough-pw' })).status).toBe(400);
    expect((await cashier.get('/me')).json.user).toMatchObject({ phoneLogin: true, phone: '+919412088888' });
  });

  it('the Owner can take an accountant\'s extra number off again, not a cashier\'s only number', async () => {
    const h = await businessWithAllRoles('Bgi Saharanpur');
    const o = h.clients.owner;
    const acc = h.users.accountant.id;
    expect((await o.patch(`/businesses/${h.bid}/members/${acc}/profile`, { phone: '94120 55555' })).json.phone).toBe('+919412055555');
    expect((await o.patch(`/businesses/${h.bid}/members/${acc}/profile`, { phone: '' })).json.phone).toBeNull();
    const inv = await o.post(`/businesses/${h.bid}/invites`, { phone: '94120 88888', role: 'entry_staff' });
    const cashier = new Client();
    await cashier.post(`/invites/${inviteToken(inv.json.link)}/accept`, { name: 'Ravi Sharma', password: 'long-enough-pw' });
    const id = (await cashier.get('/me')).json.user.id;
    expect((await o.patch(`/businesses/${h.bid}/members/${id}/profile`, { phone: '' })).status).toBe(400);
  });
});
