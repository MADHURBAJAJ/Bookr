// A fresh POS database for each test file (local D1, the engine wrangler dev uses) and a small client that keeps cookies.
// All names, amounts and accounts here are invented.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { splitStatements } from '../../test/d1';
import { app } from '../src/app';

const MIGRATIONS = new URL('../migrations/', import.meta.url);

const dir = mkdtempSync(join(tmpdir(), 'pos-d1-'));
const proxy = await getPlatformProxy<{ DB: D1Database }>({ persist: { path: dir } });
export const db = proxy.env.DB;
for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
  await db.batch(splitStatements(readFileSync(new URL(file, MIGRATIONS), 'utf8')).map((s) => db.prepare(s)));
}
export async function dispose() {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
}

export const SETUP_TOKEN = 'test-setup-token-not-a-secret';
export const env = { DB: db, POS_SETUP_TOKEN: SETUP_TOKEN };

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
export async function setupBusiness(opts: { huf?: boolean } = {}) {
  const businessId = crypto.randomUUID();
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
  const upiCompany = (await ok(owner.post(`${B}/pay-accounts`, { name: 'Company QR', entityId: company }))).id;
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

  // The counter: the Owner marks this browser as a counter device, then the cashier signs in with a PIN on it.
  const counter = new Client();
  counter.cookies = new Map(owner.cookies);
  await ok(counter.post(`${B}/devices`, { name: 'Billing counter' }));
  counter.cookies.delete('pos_session');
  await ok(counter.post('/auth/pin', { staffId: cashierId, pin: '2468' }));

  return { businessId, B, owner, counter, company, huf, upiCompany, upiHuf, items, reasons, cashierId, captainId, ok };
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
