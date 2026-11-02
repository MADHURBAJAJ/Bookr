import { app } from '../src/app';
import { hashPassword } from '../src/crypto';
import { createBusiness } from '../src/defaults';
import { now } from '../src/db';
import type { Role } from '../src/permissions';
import { createTestDb } from './d1';

const { db, uploads, dispose } = await createTestDb();
export const env: Record<string, unknown> & { DB: D1Database; UPLOADS: R2Bucket } = { DB: db, UPLOADS: uploads };
export { db, uploads };
export const PASSWORD = 'test-password-1234';
let hash: string | undefined;
let n = 0;

/** Runs SQL against the test D1: sql`SELECT ... WHERE id = ${id}` → rows. */
export async function sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<any[]> {
  return (await db.prepare(strings.join('?')).bind(...values).all()).results;
}
sql.end = dispose;

export async function resetDb() {
  // Businesses first: their memberships, invites, accounts, heads and audit rows go with them.
  await db.batch([db.prepare('DELETE FROM businesses'), db.prepare('DELETE FROM users')]);
}

export async function makeUser(label = 'user') {
  hash ??= await hashPassword(PASSWORD);
  const email = `${label}-${++n}@test.local`;
  const id = crypto.randomUUID();
  await db.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, label, email, hash, now()).run();
  return { id, email };
}

export async function makeBusiness(ownerId: string, name = 'Biz') {
  return createBusiness(db, { name, fyStart: '2026-04-01', ownerId });
}

export async function addMember(businessId: string, userId: string, role: Role) {
  await db.prepare('INSERT INTO memberships (business_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
    .bind(businessId, userId, role, now()).run();
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
  /** Sends a raw file body, as the Upload screen does. */
  async upload(path: string, bytes: Uint8Array<ArrayBuffer>, type: string) {
    const res = await app.request(`/api${path}`, { method: 'POST', headers: { 'Content-Type': type, ...(this.cookie ? { Cookie: this.cookie } : {}) }, body: bytes }, env);
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  }
  async raw(path: string) {
    return app.request(`/api${path}`, { headers: this.cookie ? { Cookie: this.cookie } : {} }, env);
  }
  get = (p: string) => this.call('GET', p);
  put = (p: string, b: unknown = {}) => this.call('PUT', p, b);
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
