import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, Client, makeBusiness, makeUser, PASSWORD, resetDb, signIn, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);

describe('sign in and sessions', () => {
  it('wrong password and unknown email get the same answer', async () => {
    const u = await makeUser('u');
    const bad = await new Client().post('/auth/login', { email: u.email, password: 'nope-nope-nope' });
    const unknown = await new Client().post('/auth/login', { email: 'nobody@test.local', password: PASSWORD });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.json.error).toBe(unknown.json.error);
  });

  it('email match ignores case', async () => {
    const u = await makeUser('u');
    expect((await new Client().post('/auth/login', { email: u.email.toUpperCase(), password: PASSWORD })).status).toBe(200);
  });

  it('the cookie is HttpOnly and Secure and only the token hash is stored', async () => {
    const u = await makeUser('u');
    const { app } = await import('../src/app');
    const { env } = await import('./helpers');
    const res = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: u.email, password: PASSWORD }),
    }, env);
    const cookie = res.headers.get('Set-Cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    const token = cookie.split(';')[0].split('=')[1];
    const rows = await sql`SELECT id FROM sessions`;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(token);
  });

  it('sign out ends the session on the server', async () => {
    const u = await makeUser('u');
    const c = await signIn(u.email);
    const saved = c.cookie;
    expect((await c.post('/auth/logout')).status).toBe(200);
    c.cookie = saved; // replaying the old cookie must not work
    expect((await c.get('/me')).status).toBe(401);
  });

  it('an expired session is refused', async () => {
    const u = await makeUser('u');
    const c = await signIn(u.email);
    await sql`UPDATE sessions SET expires_at = ${Date.now() - 1000}`;
    expect((await c.get('/me')).status).toBe(401);
  });

  it('a made-up cookie is refused', async () => {
    const c = new Client();
    c.cookie = 'bookr_session=forged';
    expect((await c.get('/me')).status).toBe(401);
  });
});

describe('request guards', () => {
  it('a cross-site change is refused', async () => {
    const u = await makeUser('u');
    const c = await signIn(u.email);
    const res = await c.call('POST', '/businesses', { name: 'X', fyStart: '2026-04-01' }, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
  });

  it('a change that is not JSON is refused', async () => {
    const u = await makeUser('u');
    const c = await signIn(u.email);
    const res = await c.call('POST', '/auth/logout', undefined, { 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(res.status).toBe(415);
  });
});

describe('invites', () => {
  async function setup() {
    const owner = await makeUser('owner');
    const bid = await makeBusiness(owner.id, 'Sample Co');
    const oc = await signIn(owner.email);
    return { owner, bid, oc };
  }
  const tokenOf = (link: string) => link.split('/invite/')[1];

  it('a new person accepts, gets exactly the invited role, and is signed in', async () => {
    const { bid, oc } = await setup();
    const inv = await oc.post(`/businesses/${bid}/invites`, { email: 'New.Person@test.local', role: 'entry_staff' });
    expect(inv.status).toBe(201);
    const token = tokenOf(inv.json.link);

    const info = await new Client().get(`/invites/${token}`);
    expect(info.json).toMatchObject({ businessName: 'Sample Co', email: 'new.person@test.local', role: 'entry_staff', hasAccount: false });

    const guest = new Client();
    expect((await guest.post(`/invites/${token}/accept`, { name: 'New', password: 'short' })).status).toBe(400);
    expect((await guest.post(`/invites/${token}/accept`, { name: 'New', password: 'long-enough-pw' })).status).toBe(200);
    const me = await guest.get('/me');
    expect(me.json.businesses).toEqual([expect.objectContaining({ id: bid, role: 'entry_staff' })]);
    expect((await guest.post(`/businesses/${bid}/heads`, { name: 'Z', type: 'income' })).status).toBe(403);
  });

  it('a link works once', async () => {
    const { bid, oc } = await setup();
    const token = tokenOf((await oc.post(`/businesses/${bid}/invites`, { email: 'a@test.local', role: 'viewer' })).json.link);
    expect((await new Client().post(`/invites/${token}/accept`, { name: 'A', password: 'long-enough-pw' })).status).toBe(200);
    expect((await new Client().post(`/invites/${token}/accept`, { name: 'B', password: 'long-enough-pw' })).status).toBe(404);
  });

  it('revoked, replaced and expired links do not work', async () => {
    const { bid, oc } = await setup();
    const first = await oc.post(`/businesses/${bid}/invites`, { email: 'a@test.local', role: 'viewer' });
    const second = await oc.post(`/businesses/${bid}/invites`, { email: 'a@test.local', role: 'accountant' });
    expect((await new Client().get(`/invites/${tokenOf(first.json.link)}`)).status).toBe(404); // replaced

    expect((await oc.del(`/businesses/${bid}/invites/${second.json.id}`)).status).toBe(200);
    expect((await new Client().get(`/invites/${tokenOf(second.json.link)}`)).status).toBe(404); // revoked

    const third = await oc.post(`/businesses/${bid}/invites`, { email: 'b@test.local', role: 'viewer' });
    await sql`UPDATE invites SET expires_at = ${Date.now() - 1000} WHERE id = ${third.json.id}`;
    expect((await new Client().post(`/invites/${tokenOf(third.json.link)}/accept`, { name: 'B', password: 'long-enough-pw' })).status).toBe(404);
  });

  it('an existing person must give their own password to accept', async () => {
    const { bid, oc } = await setup();
    const p = await makeUser('p');
    const token = tokenOf((await oc.post(`/businesses/${bid}/invites`, { email: p.email, role: 'accountant' })).json.link);
    expect((await new Client().get(`/invites/${token}`)).json.hasAccount).toBe(true);
    expect((await new Client().post(`/invites/${token}/accept`, { password: 'wrong-password-x' })).status).toBe(401);
    const [none] = await sql`SELECT count(*) AS n FROM memberships WHERE business_id = ${bid} AND user_id = ${p.id}`;
    expect(none.n).toBe(0);
    expect((await new Client().post(`/invites/${token}/accept`, { password: PASSWORD })).status).toBe(200);
    const [m] = await sql`SELECT role FROM memberships WHERE business_id = ${bid} AND user_id = ${p.id}`;
    expect(m.role).toBe('accountant');
  });

  it('cannot invite someone who is already in the business', async () => {
    const { bid, oc } = await setup();
    const p = await makeUser('p');
    await addMember(bid, p.id, 'viewer');
    expect((await oc.post(`/businesses/${bid}/invites`, { email: p.email.toUpperCase(), role: 'owner' })).status).toBe(409);
  });

  it("an Owner cannot revoke another business's invite", async () => {
    const { bid, oc } = await setup();
    const other = await makeUser('other');
    const bid2 = await makeBusiness(other.id, 'Other');
    const inv = await (await signIn(other.email)).post(`/businesses/${bid2}/invites`, { email: 'x@test.local', role: 'viewer' });
    expect((await oc.del(`/businesses/${bid}/invites/${inv.json.id}`)).status).toBe(404);
  });

  it('the token is stored only as a hash', async () => {
    const { bid, oc } = await setup();
    const token = tokenOf((await oc.post(`/businesses/${bid}/invites`, { email: 'a@test.local', role: 'viewer' })).json.link);
    const [row] = await sql`SELECT token_hash FROM invites`;
    expect(row.token_hash).not.toContain(token);
  });
});

describe('accounts and heads input', () => {
  it('rejects bad amounts and dates, and duplicate names', async () => {
    const o = await makeUser('o');
    const bid = await makeBusiness(o.id);
    const c = await signIn(o.email);
    const base = { name: 'HDFC', kind: 'bank', openingBalance: '2,45,000.50', openingDate: '2026-04-01' };
    expect((await c.post(`/businesses/${bid}/accounts`, base)).status).toBe(201);
    expect((await c.post(`/businesses/${bid}/accounts`, { ...base, name: 'hdfc' })).status).toBe(409);
    expect((await c.post(`/businesses/${bid}/accounts`, { ...base, name: 'B', openingBalance: '1.234' })).status).toBe(400);
    expect((await c.post(`/businesses/${bid}/accounts`, { ...base, name: 'B', openingDate: '01/04/2026' })).status).toBe(400);
    expect((await c.post(`/businesses/${bid}/accounts`, { ...base, name: 'B', kind: 'wallet' })).status).toBe(400);
    const list = await c.get(`/businesses/${bid}/accounts`);
    expect(list.json.accounts.find((a: { name: string }) => a.name === 'HDFC').openingBalancePaise).toBe(24500050);
    expect((await c.post(`/businesses/${bid}/heads`, { name: 'sales', type: 'income' })).status).toBe(409);
    expect((await c.post(`/businesses/${bid}/heads`, { name: 'Sales', type: 'expense' })).status).toBe(201);
  });
});
