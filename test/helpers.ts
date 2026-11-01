import postgres from 'postgres';
import { app } from '../src/app';
import { hashPassword } from '../src/crypto';
import { createBusiness } from '../src/defaults';
import type { Role } from '../src/permissions';
import { TEST_DB_URL } from './global-setup';

export const env = { HYPERDRIVE: { connectionString: TEST_DB_URL } };
export const sql = postgres(TEST_DB_URL, { max: 2, onnotice: () => {} });
export const PASSWORD = 'test-password-1234';
let hash: string | undefined;
let n = 0;

export async function resetDb() {
  await sql`TRUNCATE businesses, users, memberships, sessions, invites, accounts, heads, audit_log CASCADE`;
}

export async function makeUser(label = 'user') {
  hash ??= await hashPassword(PASSWORD);
  const email = `${label}-${++n}@test.local`;
  const [u] = await sql<{ id: string }[]>`
    INSERT INTO users (name, email, password_hash) VALUES (${label}, ${email}, ${hash}) RETURNING id`;
  return { id: u.id, email };
}

export async function makeBusiness(ownerId: string, name = 'Biz') {
  return createBusiness(sql, { name, fyStart: '2026-04-01', ownerId });
}

export async function addMember(businessId: string, userId: string, role: Role) {
  await sql`INSERT INTO memberships (business_id, user_id, role) VALUES (${businessId}, ${userId}, ${role})`;
}

/** A tiny client that keeps the session cookie between calls. */
export class Client {
  cookie = '';
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(
      `/api${path}`,
      {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(this.cookie ? { Cookie: this.cookie } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      env,
    );
    const set = res.headers.get('Set-Cookie');
    if (set) {
      const pair = set.split(';')[0];
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  get = (p: string) => this.call('GET', p);
  post = (p: string, b: unknown = {}) => this.call('POST', p, b);
  patch = (p: string, b: unknown = {}) => this.call('PATCH', p, b);
  del = (p: string) => this.call('DELETE', p, {});
}

export async function signIn(email: string, password = PASSWORD) {
  const client = new Client();
  const res = await client.post('/auth/login', { email, password });
  if (res.status !== 200) throw new Error(`sign in failed: ${res.status}`);
  return client;
}

/** One business with one signed-in person per role. */
export async function businessWithAllRoles(name = 'Biz') {
  const owner = await makeUser('owner');
  const bid = await makeBusiness(owner.id, name);
  const users: Record<Role, { id: string; email: string }> = {
    owner,
    accountant: await makeUser('accountant'),
    entry_staff: await makeUser('staff'),
    viewer: await makeUser('viewer'),
  };
  for (const role of ['accountant', 'entry_staff', 'viewer'] as const) await addMember(bid, users[role].id, role);
  const clients = {} as Record<Role, Client>;
  for (const role of Object.keys(users) as Role[]) clients[role] = await signIn(users[role].email);
  return { bid, users, clients };
}
