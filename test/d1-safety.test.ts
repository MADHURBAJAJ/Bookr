// Rules that must hold on D1, where there are no open transactions.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, businessWithAllRoles, Client, makeBusiness, makeUser, resetDb, signIn, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);

describe('a business keeps an Owner even when requests race', () => {
  it('two Owners demoting each other at the same moment: exactly one wins', async () => {
    const o1 = await makeUser('o1');
    const o2 = await makeUser('o2');
    const bid = await makeBusiness(o1.id);
    await addMember(bid, o2.id, 'owner');
    const [c1, c2] = [await signIn(o1.email), await signIn(o2.email)];
    const results = await Promise.all([
      c1.patch(`/businesses/${bid}/members/${o2.id}`, { role: 'viewer' }),
      c2.patch(`/businesses/${bid}/members/${o1.id}`, { role: 'viewer' }),
    ]);
    // The loser either hits the last-Owner rule (409) or has already lost Owner rights (403).
    expect(results.map((r) => r.status).sort()).toEqual([200, expect.any(Number)]);
    expect([403, 409]).toContain(results.map((r) => r.status).sort()[1]);
    const [owners] = await sql`SELECT count(*) AS n FROM memberships WHERE business_id = ${bid} AND role = 'owner'`;
    expect(owners.n).toBe(1);
  });

  it('removing and demoting the last two Owners together still leaves one', async () => {
    const o1 = await makeUser('o1');
    const o2 = await makeUser('o2');
    const bid = await makeBusiness(o1.id);
    await addMember(bid, o2.id, 'owner');
    const c1 = await signIn(o1.email);
    await Promise.all([
      c1.del(`/businesses/${bid}/members/${o2.id}`),
      c1.patch(`/businesses/${bid}/members/${o1.id}`, { role: 'accountant' }),
    ]);
    const [owners] = await sql`SELECT count(*) AS n FROM memberships WHERE business_id = ${bid} AND role = 'owner'`;
    expect(owners.n).toBe(1);
  });

  it('the database itself refuses to drop the last Owner', async () => {
    const o = await makeUser('o');
    const bid = await makeBusiness(o.id);
    await expect(sql`UPDATE memberships SET role = 'viewer' WHERE business_id = ${bid}`).rejects.toThrow(/last_owner/);
    await expect(sql`DELETE FROM memberships WHERE business_id = ${bid}`).rejects.toThrow(/last_owner/);
  });

  it('deleting a whole business still works', async () => {
    const o = await makeUser('o');
    const bid = await makeBusiness(o.id);
    await sql`DELETE FROM businesses WHERE id = ${bid}`;
    const [left] = await sql`SELECT count(*) AS n FROM memberships WHERE business_id = ${bid}`;
    expect(left.n).toBe(0);
  });
});

describe('an invite is used once even when requests race', () => {
  it('two people accepting the same link together: one membership, one new user', async () => {
    const o = await makeUser('o');
    const bid = await makeBusiness(o.id);
    const inv = await (await signIn(o.email)).post(`/businesses/${bid}/invites`, { email: 'race@test.local', role: 'viewer' });
    const token = inv.json.link.split('/invite/')[1];
    const results = await Promise.all([
      new Client().post(`/invites/${token}/accept`, { name: 'A', password: 'long-enough-pw' }),
      new Client().post(`/invites/${token}/accept`, { name: 'B', password: 'long-enough-pw' }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const [users] = await sql`SELECT count(*) AS n FROM users WHERE email = 'race@test.local'`;
    expect(users.n).toBe(1);
    const [members] = await sql`SELECT count(*) AS n FROM memberships WHERE business_id = ${bid}`;
    expect(members.n).toBe(2);
  });

  it('a failed accept creates no user and no membership', async () => {
    const o = await makeUser('o');
    const bid = await makeBusiness(o.id);
    const inv = await (await signIn(o.email)).post(`/businesses/${bid}/invites`, { email: 'gone@test.local', role: 'viewer' });
    // The invite is revoked between the page loading and the person pressing Accept.
    await sql`UPDATE invites SET revoked_at = ${Date.now()} WHERE id = ${inv.json.id}`;
    const token = inv.json.link.split('/invite/')[1];
    expect((await new Client().post(`/invites/${token}/accept`, { name: 'G', password: 'long-enough-pw' })).status).toBe(404);
    const [users] = await sql`SELECT count(*) AS n FROM users WHERE email = 'gone@test.local'`;
    expect(users.n).toBe(0);
  });
});

describe('money is integer paise', () => {
  it('stores and returns whole paise, with no floating point', async () => {
    const { bid, clients } = await businessWithAllRoles();
    const res = await clients.accountant.post(`/businesses/${bid}/accounts`, {
      name: 'HDFC', kind: 'bank', openingBalance: '0.10', openingDate: '2026-04-01',
    });
    expect(res.status).toBe(201);
    const [row] = await sql`SELECT opening_balance_paise AS p, typeof(opening_balance_paise) AS t FROM accounts WHERE id = ${res.json.id}`;
    expect(row).toEqual({ p: 10, t: 'integer' });
    await clients.accountant.post(`/businesses/${bid}/accounts`, { name: 'ICICI', kind: 'bank', openingBalance: '0.20', openingDate: '2026-04-01' });
    const dash = await clients.owner.get(`/businesses/${bid}/dashboard`);
    const total = dash.json.accounts.reduce((s: number, a: { openingBalancePaise: number }) => s + a.openingBalancePaise, 0);
    expect(total).toBe(30); // 0.1 + 0.2 in floats would not be exact
    expect(Number.isInteger(total)).toBe(true);
  });

  it('accepts Indian grouping and negatives, refuses floats sent as numbers and a third decimal', async () => {
    const { bid, clients } = await businessWithAllRoles();
    const post = (name: string, openingBalance: unknown) =>
      clients.owner.post(`/businesses/${bid}/accounts`, { name, kind: 'bank', openingBalance, openingDate: '2026-04-01' });
    const ok = await post('A', '12,34,567.8');
    expect(ok.status).toBe(201);
    const [a] = await sql`SELECT opening_balance_paise AS p FROM accounts WHERE id = ${ok.json.id}`;
    expect(a.p).toBe(123456780);
    const neg = await post('B', '-500');
    const [b] = await sql`SELECT opening_balance_paise AS p FROM accounts WHERE id = ${neg.json.id}`;
    expect(b.p).toBe(-50000);
    expect((await post('C', 1000.5)).status).toBe(400);
    expect((await post('D', '1.005')).status).toBe(400);
  });

  it('the database refuses a non-integer amount', async () => {
    const o = await makeUser('o');
    const bid = await makeBusiness(o.id);
    await expect(sql`UPDATE accounts SET opening_balance_paise = 10.5 WHERE business_id = ${bid}`).rejects.toThrow(/CHECK/);
  });

  it('an edit to a missing account writes no audit row', async () => {
    const { bid, clients } = await businessWithAllRoles();
    const res = await clients.owner.patch(`/businesses/${bid}/accounts/00000000-0000-4000-8000-000000000000`, {
      name: 'X', kind: 'cash', openingBalance: '1', openingDate: '2026-04-01',
    });
    expect(res.status).toBe(404);
    const [n] = await sql`SELECT count(*) AS n FROM audit_log`;
    expect(n.n).toBe(0);
  });
});
