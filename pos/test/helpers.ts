// A fresh POS database for each test file and a small client that keeps cookies. All names, amounts and accounts here are
// invented. By default the database is SQLite inside the test process (test/sqlite-d1.ts, as Bookr's tests): the POS
// migrations are applied once into a template file that each test file copies. D1_REAL=1 uses wrangler's local D1 instead
// (the engine wrangler dev uses), which is slower but is the real engine: worth a run before a live deploy.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { splitStatements } from '../../test/d1';
import { memoryR2, sqliteD1 } from '../../test/sqlite-d1';
import { app } from '../src/app';

const MIGRATIONS = new URL('../migrations/', import.meta.url);
const migrationFiles = () =>
  readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort().map((f) => ({ name: f, text: readFileSync(new URL(f, MIGRATIONS), 'utf8') }));

// The template is named after the POS migrations' contents, so a changed or added migration makes a new one. Test files that
// start together may each build it; the last rename wins and every copy is the same.
async function template(): Promise<string> {
  const files = migrationFiles();
  const hash = createHash('sha256');
  for (const f of files) hash.update(f.name).update('\0').update(f.text).update('\0');
  const path = join(tmpdir(), `pos-test-template-${hash.digest('hex').slice(0, 16)}.sqlite`);
  if (existsSync(path)) return path;
  const building = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  const t = sqliteD1(building);
  try {
    for (const f of files) await t.db.batch(splitStatements(f.text).map((x) => t.db.prepare(x)));
  } finally {
    t.close();
  }
  renameSync(building, path);
  return path;
}

async function open(): Promise<{ db: D1Database; bills: R2Bucket; dispose: () => Promise<void> }> {
  if (process.env.D1_REAL === '1') {
    const { getPlatformProxy } = await import('wrangler');
    const dir = mkdtempSync(join(tmpdir(), 'pos-d1-'));
    const proxy = await getPlatformProxy<{ DB: D1Database; UPLOADS: R2Bucket }>({ persist: { path: dir } });
    for (const f of migrationFiles()) await proxy.env.DB.batch(splitStatements(f.text).map((x) => proxy.env.DB.prepare(x)));
    return { db: proxy.env.DB, bills: proxy.env.UPLOADS, dispose: async () => { await proxy.dispose(); rmSync(dir, { recursive: true, force: true }); } };
  }
  const dir = mkdtempSync(join(tmpdir(), 'pos-db-'));
  const file = join(dir, 'test.sqlite');
  copyFileSync(await template(), file);
  const { db, close } = sqliteD1(file);
  return { db, bills: memoryR2(), dispose: async () => { close(); rmSync(dir, { recursive: true, force: true }); } };
}

const opened = await open();
export const db = opened.db;
export const dispose = opened.dispose;

export const SETUP_TOKEN = 'test-setup-token-not-a-secret';
// BILLS: an R2 bucket (in memory, or the root config's local one with D1_REAL=1), so bill photos are stored and read back in tests.
export const env = { DB: db, POS_SETUP_TOKEN: SETUP_TOKEN, BILLS: opened.bills };

export async function q(sql: string, ...params: unknown[]): Promise<any[]> {
  return (await db.prepare(sql).bind(...params).all()).results;
}

export class Client {
  cookies = new Map<string, string>();
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await app.request(`/api${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }, env);
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (v) this.cookies.set(k, v); else this.cookies.delete(k);
    }
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
  get = (p: string) => this.call('GET', p);
  post = (p: string, b: unknown = {}) => this.call('POST', p, b);
  put = (p: string, b: unknown = {}) => this.call('PUT', p, b);
}

let n = 0;
/** A business with an Owner signed in, a counter device, a cashier and captain with PINs, a menu and reasons. */
export async function setupBusiness(opts: { huf?: boolean; businessId?: string; bookrAccountId?: string } = {}) {
  const businessId = opts.businessId ?? crypto.randomUUID();
  const email = `owner-${++n}@test.local`;
  const owner = new Client();
  let r = await owner.call('POST', '/setup', { businessId, name: 'Sample Hotel', ownerName: 'Owner', email, password: 'owner-password-123' }, { 'X-Setup-Token': SETUP_TOKEN });
  if (r.status !== 200) throw new Error(JSON.stringify(r.json));
  r = await owner.post('/auth/login', { email, password: 'owner-password-123' });
  if (r.status !== 200) throw new Error(JSON.stringify(r.json));
  const B = `/businesses/${businessId}`;
  const ok = async (p: Promise<{ status: number; json: any }>) => { const x = await p; if (x.status >= 300) throw new Error(JSON.stringify(x.json)); return x.json; };

  const company = (await ok(owner.post(`${B}/entities`, { name: 'Sample Hotels Pvt Ltd', kind: 'company', gstRegistered: true, gstin: '29ABCDE1234F1Z5', gstRateBp: 500, seriesPrefix: 'C' }))).id;
  const huf = opts.huf ? (await ok(owner.post(`${B}/entities`, { name: 'Sample HUF 1', kind: 'huf', gstRegistered: false, seriesPrefix: 'H1', yearlyLimit: '2000000', warn1: '1500000', warn2: '1800000', stopAt: '1950000' }))).id : null;
  const upiCompany = (await ok(owner.post(`${B}/pay-accounts`, { name: 'Company QR', entityId: company, bookrAccountId: opts.bookrAccountId }))).id;
  const upiHuf = huf ? (await ok(owner.post(`${B}/pay-accounts`, { name: 'HUF 1 QR', entityId: huf }))).id : null;

  const items: Record<string, string> = {};
  for (const [name, price, station] of [['Masala Dosa', '180', 'kitchen'], ['Butter Naan', '60', 'kitchen'], ['Masala Chai', '40', 'kitchen'], ['Beer 650 ml', '320', 'bar']] as const) {
    items[name] = (await ok(owner.post(`${B}/menu`, { name, price, station, category: 'Food' }))).id;
  }
  const reasons: Record<string, string> = {};
  for (const [kind, label] of [['discount', 'Regular guest'], ['comp', "Owner's guest"], ['void', 'Wrong billing name'], ['kot_cancel', 'Guest changed mind']] as const) {
    reasons[kind] = (await ok(owner.post(`${B}/reasons`, { kind, label }))).id;
  }
  const cashierId = (await ok(owner.post(`${B}/staff`, { name: 'Ravi', role: 'cashier', pin: '2468' }))).id;
  const captainId = (await ok(owner.post(`${B}/staff`, { name: 'Suresh', role: 'captain', pin: '1357' }))).id;
  // A manager with a PIN: approves cancelling what the kitchen already has (21 Nov 2026).
  const managerId = (await ok(owner.post(`${B}/staff`, { name: 'Sample Manager', role: 'manager', pin: '9753', email: `manager-${n}@test.local`, password: 'manager-password-1' }))).id;

  // The counter: the Owner marks this browser as a counter device, then the cashier signs in with a PIN on it.
  const counter = new Client();
  counter.cookies = new Map(owner.cookies);
  await ok(counter.post(`${B}/devices`, { name: 'Billing counter' }));
  counter.cookies.delete('pos_session');
  await ok(counter.post('/auth/pin', { staffId: cashierId, pin: '2468' }));

  // A manager's PIN sent with a step a cashier may not take alone (21 Nov 2026).
  const mgr = { approverId: managerId, approverPin: '9753' };
  return { businessId, B, owner, counter, company, huf, upiCompany, upiHuf, items, reasons, cashierId, captainId, managerId, mgr, ok };
}

/** Opens a table order, adds items, sends the KOT and prints the bill. */
export async function billed(s: Awaited<ReturnType<typeof setupBusiness>>, items: [string, number][], bill: Record<string, unknown> = {}, place = `T${++n}`) {
  const { B, counter, ok } = s;
  const order = (await ok(counter.post(`${B}/orders`, { kind: 'table', place }))).id;
  for (const [name, qty] of items) await ok(counter.post(`${B}/orders/${order}/items`, { itemId: s.items[name], delta: qty }));
  await ok(counter.post(`${B}/orders/${order}/kot`));
  const r = await ok(counter.post(`${B}/orders/${order}/bill`, { entityId: s.company, ...bill }));
  return { order, bill: r.bill, warning: r.warning };
}
