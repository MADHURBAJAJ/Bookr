// Linking a WhatsApp number from POS › Settings › WhatsApp (27 Nov 2026): Owner only; the PC (the listener's heartbeat)
// picks the request up, sends the QR, then says how it ended. Both sides in-process, each with its own database.
// All data is invented; the QR rows are a made-up pattern.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app as bookrApp } from '../../src/app';
import { env as bookrEnv, makeBusiness, makeUser, signIn, sql as bookrSql } from '../../test/helpers';
import { Client, dispose, env as posEnv, q, setupBusiness } from './helpers';

const toBookr: typeof fetch = async (url, init) => bookrApp.request(new URL(String(url)).pathname, init as RequestInit, bookrEnv);
afterAll(async () => { vi.unstubAllGlobals(); await dispose(); await bookrSql.end(); });

const SECRET = 'listener-secret-for-tests-only';
let s: Awaited<ReturnType<typeof setupBusiness>>;
let manager: Client;
const L = () => `${s.B}/whatsapp/link`;
const W = () => `${s.B}/whatsapp`;
const rows = Array.from({ length: 21 }, (_, i) => (i % 2 ? '1' : '0').repeat(21));
/** The listener's heartbeat to Bookr. */
const beat = async (b: Record<string, unknown>) => {
  const r = await bookrApp.request('/api/wa/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bookr-WA-Secret': SECRET },
    body: JSON.stringify({ state: 'connected', ...b }) }, bookrEnv);
  expect(r.status).toBe(200);
  return (await r.json() as any).link;
};

beforeAll(async () => {
  (bookrEnv as any).WA_INGEST_SECRET = SECRET;
  const owner = await makeUser('owner');
  const bid = await makeBusiness(owner.id, 'Sample Hostel');
  const key = (await (await signIn(owner.email)).post(`/businesses/${bid}/pos/link`)).json.key as string;
  s = await setupBusiness({ businessId: bid });
  Object.assign(posEnv, { BOOKR_URL: 'https://bookr.example.test', BOOKR_KEYS: JSON.stringify({ [bid]: key }) });
  vi.stubGlobal('fetch', toBookr);
  const [m] = await q('SELECT email FROM staff WHERE id = ?', s.managerId);
  manager = new Client();
  await manager.post('/auth/login', { email: m.email, password: 'manager-password-1' });
});

describe('linking the WhatsApp number from the POS', () => {
  it('cannot be asked while the reception PC is off', async () => {
    const r = await s.owner.post(L(), { action: 'link' });
    expect(r).toMatchObject({ status: 409, json: { error: 'The reception PC is off, so the number cannot be changed now. Switch the PC on first.' } });
  });

  it('links: the PC picks the request up, the Owner sees the QR (a manager does not), then the number', async () => {
    expect(await beat({ linkedLast4: '1111' })).toBeNull();
    expect((await manager.post(L(), { action: 'link' })).status).toBe(403);
    const asked = await s.owner.post(L(), { action: 'link' });
    expect(asked.status).toBe(200);
    expect(asked.json.link).toMatchObject({ pcOn: true, last4: '1111', request: { action: 'link', by: 'POS · Owner (owner)' }, qrRows: null });

    const req = await beat({ linkedLast4: '1111' });
    expect(req).toMatchObject({ action: 'link' });
    await beat({ linkedLast4: null, state: 'waiting_for_qr', link: { id: req.id, qrRows: rows } });
    expect((await s.owner.get(W())).json.link.qrRows).toEqual(rows);
    const seen = (await manager.get(W())).json.link;
    expect(seen.qrRows).toBeNull();
    expect(seen.request).toMatchObject({ action: 'link' });

    expect(await beat({ linkedLast4: '4321', link: { id: req.id, result: 'linked' } })).toBeNull();
    const done = (await s.owner.get(W())).json.link;
    expect(done).toMatchObject({ last4: '4321', linkedBy: 'POS · Owner (owner)', request: null, qrRows: null, lastResult: 'linked' });
    const log = await bookrSql`SELECT action FROM audit_log WHERE action LIKE 'wa.link.%' ORDER BY id`;
    expect(log.map((x: any) => x.action)).toEqual(['wa.link.link', 'wa.link.linked']);
  });

  it('a link not scanned in time, or cancelled, ends with no QR left', async () => {
    await s.owner.post(L(), { action: 'link' });
    const req = await beat({ linkedLast4: '4321' });
    await beat({ linkedLast4: null, link: { id: req.id, qrRows: rows } });
    expect((await s.owner.post(L(), { action: 'cancel' })).json.link).toMatchObject({ request: null, qrRows: null, lastResult: 'cancelled' });
    expect(await beat({ linkedLast4: null, link: { id: req.id, result: 'cancelled' } })).toBeNull();

    // Asked again, and the PC never finishes: after 3½ minutes Bookr ends it itself.
    await s.owner.post(L(), { action: 'link' });
    await bookrSql`UPDATE wa_listener_status SET link_at = link_at - 210000, qr_rows = ${JSON.stringify(rows)} WHERE id = 1`;
    expect(await beat({ linkedLast4: null })).toBeNull();
    const [st] = await bookrSql`SELECT link_id, qr_rows, link_result FROM wa_listener_status WHERE id = 1`;
    expect(st).toMatchObject({ link_id: null, qr_rows: null, link_result: 'expired' });
  });

  it('unlinks, and a cashier cannot touch any of it', async () => {
    await beat({ linkedLast4: '4321' });
    expect((await s.counter.post(L(), { action: 'unlink' })).status).toBe(403);
    await s.owner.post(L(), { action: 'unlink' });
    const req = await beat({ linkedLast4: '4321' });
    expect(req).toMatchObject({ action: 'unlink' });
    await beat({ linkedLast4: null, state: 'not_linked', link: { id: req.id, result: 'unlinked' } });
    expect((await s.owner.get(W())).json.link).toMatchObject({ last4: null, request: null, lastResult: 'unlinked' });
    expect((await s.owner.post(L(), { action: 'unlink' })).json.error).toBe('No WhatsApp number is linked.');
  });

  it('Bookr refuses a POS asking for a role other than the Owner, and bad QR rows from the listener', async () => {
    const key = JSON.parse(String((posEnv as any).BOOKR_KEYS));
    const [bid] = Object.keys(key);
    const r = await bookrApp.request('/api/pos/wa/link', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key[bid]}` },
      body: JSON.stringify({ businessId: bid, action: 'link', by: { name: 'Sample Manager', role: 'manager' } }) }, bookrEnv);
    expect(r.status).toBe(403);
    const bad = await bookrApp.request('/api/wa/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Bookr-WA-Secret': SECRET },
      body: JSON.stringify({ link: { id: crypto.randomUUID(), qrRows: ['<svg>'] } }) }, bookrEnv);
    expect(bad.status).toBe(400);
  });
});
