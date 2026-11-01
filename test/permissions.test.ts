import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { can, ROLES, type Action, type Role } from '../src/permissions';
import { addMember, businessWithAllRoles, Client, makeBusiness, makeUser, resetDb, signIn, sql } from './helpers';

afterAll(() => sql.end());

describe('role matrix (matches the Users and roles design)', () => {
  // [action, owner, accountant, entry staff, viewer]
  const table: [Action, boolean, boolean, boolean, boolean][] = [
    ['rows.upload', true, true, true, false],
    ['rows.edit', true, true, true, false],
    ['rows.approve', true, true, false, false],
    ['bank.link', true, true, false, false],
    ['heads.edit', true, true, false, false],
    ['rules.edit', true, true, false, false],
    ['export.run', true, true, false, false],
    ['reports.view', true, true, false, true],
    ['members.manage', true, false, false, false],
    ['business.edit', true, false, false, false],
    ['accounts.edit', true, true, false, false],
    ['accounts.view', true, true, true, true],
    ['heads.view', true, true, true, true],
    ['business.view', true, true, true, true],
  ];
  it.each(table)('%s', (action, ...expected) => {
    expect(ROLES.map((r) => can(r, action))).toEqual(expected);
  });
});

describe('HTTP: every business route checks the role in that business', () => {
  let ctx: Awaited<ReturnType<typeof businessWithAllRoles>>;
  let accountId: string;
  let headId: string;

  beforeAll(async () => {
    await resetDb();
    ctx = await businessWithAllRoles();
    const accounts = await ctx.clients.owner.get(`/businesses/${ctx.bid}/accounts`);
    accountId = accounts.json.accounts[0].id;
    const heads = await ctx.clients.owner.get(`/businesses/${ctx.bid}/heads`);
    headId = heads.json.heads[0].id;
  });

  const account = { name: 'Bank X', kind: 'bank', openingBalance: '1000.50', openingDate: '2026-04-01' };
  let seq = 0;
  // [description, request, allowed roles, success status]
  const cases: [string, (c: Client, bid: string) => Promise<{ status: number }>, Role[], number][] = [
    ['view business', (c, b) => c.get(`/businesses/${b}`), ['owner', 'accountant', 'entry_staff', 'viewer'], 200],
    ['edit business', (c, b) => c.patch(`/businesses/${b}`, { name: 'Biz', fyStart: '2026-04-01' }), ['owner'], 200],
    ['dashboard', (c, b) => c.get(`/businesses/${b}/dashboard`), ['owner', 'accountant', 'viewer'], 200],
    ['list accounts', (c, b) => c.get(`/businesses/${b}/accounts`), ['owner', 'accountant', 'entry_staff', 'viewer'], 200],
    ['add account', (c, b) => c.post(`/businesses/${b}/accounts`, { ...account, name: `Bank ${++seq}` }), ['owner', 'accountant'], 201],
    ['edit account', (c, b) => c.patch(`/businesses/${b}/accounts/${accountId}`, { name: 'Cash', kind: 'cash', openingBalance: '5', openingDate: '2026-04-01' }), ['owner', 'accountant'], 200],
    ['list heads', (c, b) => c.get(`/businesses/${b}/heads`), ['owner', 'accountant', 'entry_staff', 'viewer'], 200],
    ['add head', (c, b) => c.post(`/businesses/${b}/heads`, { name: `Head ${++seq}`, type: 'expense' }), ['owner', 'accountant'], 201],
    ['edit head', (c, b) => c.patch(`/businesses/${b}/heads/${headId}`, { name: 'Sales', tallyLedger: 'Sales Account' }), ['owner', 'accountant'], 200],
    ['list members', (c, b) => c.get(`/businesses/${b}/members`), ['owner'], 200],
    ['invite', (c, b) => c.post(`/businesses/${b}/invites`, { email: `new${++seq}@test.local`, role: 'viewer' }), ['owner'], 201],
  ];

  for (const [name, run, allowed, ok] of cases) {
    for (const role of ROLES) {
      const expected = allowed.includes(role) ? ok : 403;
      it(`${name}: ${role} → ${expected}`, async () => {
        expect((await run(ctx.clients[role], ctx.bid)).status).toBe(expected);
      });
    }
    it(`${name}: signed out → 401`, async () => {
      expect((await run(new Client(), ctx.bid)).status).toBe(401);
    });
  }

  it('changing a role or removing someone is Owner only', async () => {
    const target = ctx.users.viewer.id;
    for (const role of ['accountant', 'entry_staff', 'viewer'] as const) {
      expect((await ctx.clients[role].patch(`/businesses/${ctx.bid}/members/${target}`, { role: 'owner' })).status).toBe(403);
      expect((await ctx.clients[role].del(`/businesses/${ctx.bid}/members/${target}`)).status).toBe(403);
    }
    const [m] = await sql`SELECT role FROM memberships WHERE business_id = ${ctx.bid} AND user_id = ${target}`;
    expect(m.role).toBe('viewer');
  });

  it('an unknown role is refused', async () => {
    const res = await ctx.clients.owner.patch(`/businesses/${ctx.bid}/members/${ctx.users.viewer.id}`, { role: 'admin' });
    expect(res.status).toBe(400);
    const inv = await ctx.clients.owner.post(`/businesses/${ctx.bid}/invites`, { email: 'x@test.local', role: 'superuser' });
    expect(inv.status).toBe(400);
  });
});

describe('roles are per business', () => {
  beforeEach(resetDb);

  it('an Owner of one business who is a Viewer in another cannot change the other', async () => {
    const a = await makeUser('a');
    const b = await makeUser('b');
    const bizA = await makeBusiness(a.id, 'A');
    const bizB = await makeBusiness(b.id, 'B');
    await addMember(bizB, a.id, 'viewer');
    const client = await signIn(a.email);

    expect((await client.post(`/businesses/${bizA}/heads`, { name: 'X', type: 'income' })).status).toBe(201);
    expect((await client.post(`/businesses/${bizB}/heads`, { name: 'X', type: 'income' })).status).toBe(403);
    expect((await client.get(`/businesses/${bizB}/members`)).status).toBe(403);
    expect((await client.get(`/businesses/${bizB}/heads`)).status).toBe(200);
  });

  it('a non-member gets 404, not 403, so business ids cannot be probed', async () => {
    const a = await makeUser('a');
    const b = await makeUser('b');
    const bizB = await makeBusiness(b.id, 'B');
    await makeBusiness(a.id, 'A');
    const client = await signIn(a.email);
    expect((await client.get(`/businesses/${bizB}`)).status).toBe(404);
    expect((await client.get(`/businesses/${bizB}/accounts`)).status).toBe(404);
    expect((await client.get(`/businesses/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
    expect((await client.get(`/businesses/not-a-uuid`)).status).toBe(404);
  });

  it("cannot reach another business's rows through a business you own", async () => {
    const a = await makeUser('a');
    const b = await makeUser('b');
    const bizA = await makeBusiness(a.id, 'A');
    const bizB = await makeBusiness(b.id, 'B');
    const [acctB] = await sql`SELECT id FROM accounts WHERE business_id = ${bizB}`;
    const [headB] = await sql`SELECT id FROM heads WHERE business_id = ${bizB} LIMIT 1`;
    const client = await signIn(a.email);
    const acct = { name: 'Hacked', kind: 'cash', openingBalance: '1', openingDate: '2026-04-01' };
    expect((await client.patch(`/businesses/${bizA}/accounts/${acctB.id}`, acct)).status).toBe(404);
    expect((await client.patch(`/businesses/${bizA}/heads/${headB.id}`, { name: 'Hacked' })).status).toBe(404);
    expect((await client.patch(`/businesses/${bizA}/members/${b.id}`, { role: 'viewer' })).status).toBe(404);
    expect((await client.get(`/businesses/${bizA}/members/${b.id}/memberships`)).json.memberships).toEqual([]);
    const [still] = await sql`SELECT name FROM accounts WHERE id = ${acctB.id}`;
    expect(still.name).toBe('Cash');
  });

  it("an Owner sees a person's other roles only in businesses they also own", async () => {
    const a = await makeUser('a');
    const b = await makeUser('b');
    const p = await makeUser('p');
    const bizA = await makeBusiness(a.id, 'A');
    const bizA2 = await makeBusiness(a.id, 'A2');
    const bizB = await makeBusiness(b.id, 'B');
    await addMember(bizA, p.id, 'accountant');
    await addMember(bizA2, p.id, 'viewer');
    await addMember(bizB, p.id, 'owner');
    const client = await signIn(a.email);
    const res = await client.get(`/businesses/${bizA}/members/${p.id}/memberships`);
    expect(res.json.memberships.map((m: { name: string }) => m.name)).toEqual(['A', 'A2']);
  });

  it('/me lists only your own businesses and roles', async () => {
    const a = await makeUser('a');
    const b = await makeUser('b');
    const bizA = await makeBusiness(a.id, 'A');
    await makeBusiness(b.id, 'B');
    const me = await (await signIn(a.email)).get('/me');
    expect(me.json.businesses).toHaveLength(1);
    expect(me.json.businesses[0]).toMatchObject({ id: bizA, role: 'owner' });
  });
});

describe('creating a business', () => {
  beforeEach(resetDb);

  it('only someone who is an Owner somewhere can create one, and becomes its Owner', async () => {
    const owner = await makeUser('o');
    const staff = await makeUser('s');
    const biz = await makeBusiness(owner.id);
    await addMember(biz, staff.id, 'accountant');
    const body = { name: 'New Co', fyStart: '2026-04-01' };
    expect((await (await signIn(staff.email)).post('/businesses', body)).status).toBe(403);
    const res = await (await signIn(owner.email)).post('/businesses', body);
    expect(res.status).toBe(201);
    const [m] = await sql`SELECT role FROM memberships WHERE business_id = ${res.json.id} AND user_id = ${owner.id}`;
    expect(m.role).toBe('owner');
    const heads = await sql`SELECT count(*)::int AS n FROM heads WHERE business_id = ${res.json.id} AND NOT is_custom`;
    expect(heads[0].n).toBeGreaterThan(0);
  });

  it('signed out cannot create one', async () => {
    expect((await new Client().post('/businesses', { name: 'X', fyStart: '2026-04-01' })).status).toBe(401);
  });
});

describe('a business always keeps an Owner', () => {
  beforeEach(resetDb);

  it('the last Owner cannot be demoted or removed', async () => {
    const o = await makeUser('o');
    const biz = await makeBusiness(o.id);
    const c = await signIn(o.email);
    expect((await c.patch(`/businesses/${biz}/members/${o.id}`, { role: 'accountant' })).status).toBe(409);
    expect((await c.del(`/businesses/${biz}/members/${o.id}`)).status).toBe(409);
  });

  it('with two Owners, one can step down — and then loses Owner rights at once', async () => {
    const o1 = await makeUser('o1');
    const o2 = await makeUser('o2');
    const biz = await makeBusiness(o1.id);
    await addMember(biz, o2.id, 'owner');
    const c1 = await signIn(o1.email);
    expect((await c1.patch(`/businesses/${biz}/members/${o1.id}`, { role: 'viewer' })).status).toBe(200);
    expect((await c1.get(`/businesses/${biz}/members`)).status).toBe(403);
    expect((await c1.post(`/businesses/${biz}/heads`, { name: 'Y', type: 'income' })).status).toBe(403);
  });

  it('a removed person loses access at once', async () => {
    const { bid, users, clients } = await businessWithAllRoles();
    expect((await clients.owner.del(`/businesses/${bid}/members/${users.accountant.id}`)).status).toBe(200);
    expect((await clients.accountant.get(`/businesses/${bid}/accounts`)).status).toBe(404);
  });
});

describe('audit log', () => {
  beforeEach(resetDb);

  it('every account change by an Accountant is logged with who, before and after', async () => {
    const { bid, users, clients } = await businessWithAllRoles();
    const created = await clients.accountant.post(`/businesses/${bid}/accounts`, {
      name: 'HDFC', kind: 'bank', accountNumber: 'XX12', openingBalance: '1000', openingDate: '2026-04-01',
    });
    expect(created.status).toBe(201);
    const id = created.json.id;
    expect((await clients.accountant.patch(`/businesses/${bid}/accounts/${id}`, {
      name: 'HDFC Current', kind: 'bank', accountNumber: 'XX12', openingBalance: '2500.50', openingDate: '2026-04-01',
    })).status).toBe(200);

    const rows = await sql`SELECT action, user_id, business_id, before, after FROM audit_log WHERE row_id = ${id} ORDER BY id`;
    expect(rows.map((r) => r.action)).toEqual(['account.create', 'account.update']);
    expect(rows.every((r) => r.user_id === users.accountant.id && r.business_id === bid)).toBe(true);
    expect(rows[0].before).toBeNull();
    expect(rows[0].after).toMatchObject({ name: 'HDFC', openingBalance: '1000.00' });
    expect(rows[1].before).toMatchObject({ name: 'HDFC', openingBalance: '1000.00' });
    expect(rows[1].after).toMatchObject({ name: 'HDFC Current', openingBalance: '2500.50' });
  });

  it('a refused change leaves no audit row', async () => {
    const { bid, clients } = await businessWithAllRoles();
    const [cash] = await sql`SELECT id FROM accounts WHERE business_id = ${bid}`;
    const body = { name: 'Cash', kind: 'cash', openingBalance: '9', openingDate: '2026-04-01' };
    expect((await clients.entry_staff.patch(`/businesses/${bid}/accounts/${cash.id}`, body)).status).toBe(403);
    expect((await clients.accountant.post(`/businesses/${bid}/accounts`, { ...body, name: 'cash' })).status).toBe(409);
    const [n] = await sql`SELECT count(*)::int AS n FROM audit_log`;
    expect(n.n).toBe(0);
  });
});
