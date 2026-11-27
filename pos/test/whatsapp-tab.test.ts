// Settings › WhatsApp (27 Nov 2026): owners and managers see whether WhatsApp reading works and switch groups; only the
// Owner starts reading a new group; cashiers cannot. The POS asks Bookr with its key; Bookr writes the POS person's
// name in its history. Both sides in-process, each with its own database. All data is invented.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app as bookrApp } from '../../src/app';
import { env as bookrEnv, makeBusiness, makeUser, signIn, sql as bookrSql } from '../../test/helpers';
import { Client, dispose, env as posEnv, q, setupBusiness } from './helpers';

const toBookr: typeof fetch = async (url, init) => bookrApp.request(new URL(String(url)).pathname, init as RequestInit, bookrEnv);
afterAll(async () => { vi.unstubAllGlobals(); await dispose(); await bookrSql.end(); });

let s: Awaited<ReturnType<typeof setupBusiness>>;
let bid: string;
let manager: Client;
let payGroup: string;
const W = () => `${s.B}/whatsapp`;

beforeAll(async () => {
  const owner = await makeUser('owner');
  bid = await makeBusiness(owner.id, 'Sample Hostel');
  const key = (await (await signIn(owner.email)).post(`/businesses/${bid}/pos/link`)).json.key as string;
  s = await setupBusiness({ businessId: bid });
  Object.assign(posEnv, { BOOKR_URL: 'https://bookr.example.test', BOOKR_KEYS: JSON.stringify({ [bid]: key }) });
  vi.stubGlobal('fetch', toBookr);

  const [m] = await q('SELECT email FROM staff WHERE id = ?', s.managerId);
  manager = new Client();
  expect((await manager.post('/auth/login', { email: m.email, password: 'manager-password-1' })).status).toBe(200);

  // In Bookr: the listener's heartbeat, a group read with bill proof, one off, and two the phone is in but not read.
  const t = Date.now();
  await bookrSql`UPDATE wa_listener_status SET last_heartbeat_at = ${t - 60_000}, last_message_at = ${t - 120_000}, state = 'connected' WHERE id = 1`;
  payGroup = crypto.randomUUID();
  await bookrSql`INSERT INTO wa_groups (id, business_id, wa_group_id, name, department, active, pos_proof, created_at)
    VALUES (${payGroup}, ${bid}, '120363000000000101@g.us', 'Guest payment', 'Front desk', 1, 1, ${t})`;
  await bookrSql`INSERT INTO wa_groups (id, business_id, wa_group_id, name, active, pos_proof, created_at)
    VALUES (${crypto.randomUUID()}, ${bid}, '120363000000000102@g.us', 'Bar stock', 0, 0, ${t})`;
  await bookrSql`INSERT INTO wa_seen_groups (wa_group_id, name, last_seen_at) VALUES ('120363000000000103@g.us', 'Sample staff', ${t}), ('120363000000000104@g.us', 'Housekeeping', ${t})`;
  await bookrSql`INSERT INTO wa_items (id, business_id, group_id, wa_message_id, sent_at, media_type, file_key, content_sha256, size_bytes, kind, read_status, created_at)
    VALUES (${crypto.randomUUID()}, ${bid}, ${payGroup}, 'm-1', ${t - 120_000}, 'image/jpeg', 'wa/1', 'sha-1', 4, 'upi', 'read', ${t})`;
});

describe('Settings › WhatsApp', () => {
  it('shows the reception PC, the groups read with today\'s photos, and the groups not read', async () => {
    const r = await s.owner.get(W());
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ connected: true, listener: { state: 'connected' } });
    expect(r.json.groups.map((g: any) => [g.name, g.active, g.posProof, g.today])).toEqual([['Guest payment', true, true, 1], ['Bar stock', false, false, 0]]);
    expect(r.json.seen.map((g: any) => g.name)).toEqual(['Housekeeping', 'Sample staff']);
    expect((await manager.get(W())).status).toBe(200);
  });

  it('lets a manager switch a group off and its bill proof, and Bookr records who did it', async () => {
    const r = await manager.call('PATCH', `${W()}/groups/${payGroup}`, { active: false });
    expect(r.status).toBe(200);
    expect(r.json.groups.find((g: any) => g.id === payGroup).active).toBe(false);
    await manager.call('PATCH', `${W()}/groups/${payGroup}`, { active: true, posProof: false });
    const [g] = await bookrSql`SELECT active, pos_proof FROM wa_groups WHERE id = ${payGroup}`;
    expect(g).toMatchObject({ active: 1, pos_proof: 0 });
    const log = await bookrSql`SELECT user_id, after FROM audit_log WHERE business_id = ${bid} AND action = 'wa.group.edit' ORDER BY id`;
    expect(log).toHaveLength(2);
    expect(log[0].user_id).toBeNull();
    expect(JSON.parse(log[0].after)).toMatchObject({ active: 0, by: 'POS · Sample Manager (manager)' });
  });

  it('lets only the Owner start reading a new group, from the groups the phone is in', async () => {
    const add = { waGroupId: '120363000000000103@g.us', department: 'Staff', posProof: false };
    expect((await manager.post(`${W()}/groups`, add)).status).toBe(403);
    expect((await s.owner.post(`${W()}/groups`, { ...add, waGroupId: '120363000000009999@g.us' })).json.error).toBe('The reception phone is not in that group.');
    const r = await s.owner.post(`${W()}/groups`, add);
    expect(r.status).toBe(201);
    expect(r.json.groups.find((g: any) => g.name === 'Sample staff')).toMatchObject({ active: true, posProof: false, department: 'Staff' });
    expect(r.json.seen.map((g: any) => g.name)).toEqual(['Housekeeping']);
    const [log] = await bookrSql`SELECT after FROM audit_log WHERE business_id = ${bid} AND action = 'wa.group.add'`;
    expect(JSON.parse(log.after).by).toBe('POS · Owner (owner)');
  });

  it('refuses cashiers, another business\'s group, and says when Bookr is not connected', async () => {
    expect((await s.counter.get(W())).status).toBe(403);
    expect((await s.counter.call('PATCH', `${W()}/groups/${payGroup}`, { active: false })).status).toBe(403);
    expect((await s.owner.call('PATCH', `${W()}/groups/${crypto.randomUUID()}`, { active: false })).status).toBe(404);
    expect((await s.owner.call('PATCH', `${W()}/groups/${payGroup}`, {})).status).toBe(400);

    const keys = (posEnv as any).BOOKR_KEYS;
    delete (posEnv as any).BOOKR_KEYS;
    expect((await s.owner.get(W())).json).toEqual({ connected: false });
    expect((await s.owner.call('PATCH', `${W()}/groups/${payGroup}`, { active: false })).status).toBe(409);
    Object.assign(posEnv, { BOOKR_KEYS: keys });

    // A Bookr not yet updated for this tab: says so plainly.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'Not found.' }), { status: 404 }));
    expect((await s.owner.get(W())).json.error).toBe('Bookr has not been updated for this tab yet: deploy Bookr (not only the POS).');
    vi.stubGlobal('fetch', toBookr);
  });

  it('Bookr refuses a wrong key, and a POS claiming a role that may not do it', async () => {
    const call = (path: string, b: unknown, key = 'wrong') => bookrApp.request(`/api/pos/${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(b) }, bookrEnv);
    expect((await call('wa', { businessId: bid })).status).toBe(401);
    const key = JSON.parse(String((posEnv as any).BOOKR_KEYS))[bid];
    expect((await call('wa/edit', { businessId: bid, groupId: payGroup, active: false, by: { name: 'Ravi', role: 'cashier' } }, key)).status).toBe(403);
    expect((await call('wa/add', { businessId: bid, waGroupId: '120363000000000104@g.us', by: { name: 'Sample Manager', role: 'manager' } }, key)).status).toBe(403);
  });
});
