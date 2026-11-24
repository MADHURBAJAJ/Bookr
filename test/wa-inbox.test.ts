// WhatsApp inbox, phase 4 (24 Nov 2026): the inbox cards, review actions, the file, and the group setup.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/claude', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/claude')>();
  return { ...real, readWithClaude: vi.fn() };
});

import { pairGroup } from '../src/waPair';
import { istToMs } from '../src/time';
import { businessWithAllRoles, Client, env, resetDb, sql, uploads } from './helpers';

vi.setConfig({ testTimeout: 60_000 });
afterAll(() => sql.end());
const at = (d: number, h: number, m: number, s = 30) => istToMs(2026, 11, d, h, m, s);
const ASHWIN = '919800000000';
const SECRET = 'test-secret-0123456789abcdef';

let bid: string;
let groupId: string;
let owner: Client, accountant: Client, staff: Client, viewer: Client;
let ownerId: string;
let n = 0;
const W = () => `/businesses/${bid}/wa`;

const add = async (o: { kind: 'upi' | 'bill' | 'other'; amount?: number | null; sent: number; utr?: string; billNo?: string; caption?: string;
  reply?: string; status?: string; read?: string; app?: string }) => {
  const id = crypto.randomUUID();
  n++;
  const extracted = o.kind === 'upi' ? { reading: { legible: 'clear', upi: { app: o.app ?? 'Paytm', payee_vpa: 'exosparkgoainn@icici' } } } : { reading: { legible: 'clear' } };
  await uploads.put(`wa/${bid}/${id}`, new Uint8Array([0xff, 0xd8, 0xff, n % 250]));
  await sql`INSERT INTO wa_items (id, business_id, group_id, wa_message_id, sender_number, sender_name, sent_at, media_type, file_key, content_sha256, size_bytes,
      caption, reply_to_id, kind, read_status, extracted_json, amount_paise, utr, bill_no, status, created_at)
    VALUES (${id}, ${bid}, ${groupId}, ${'m-' + id}, ${ASHWIN}, 'Ashwin New XOXO', ${o.sent}, 'image/jpeg', ${`wa/${bid}/${id}`}, ${'s' + n + id}, 4,
      ${o.caption ?? null}, ${o.reply ?? null}, ${o.kind}, ${o.read ?? 'read'}, ${JSON.stringify(extracted)},
      ${o.amount == null ? null : o.amount * 100}, ${o.utr ?? null}, ${o.billNo ?? null}, ${o.status ?? 'pending'}, ${Date.now() + n})`;
  return id;
};
const pairAll = () => pairGroup(env.DB, groupId, at(23, 0, 0), at(25, 0, 0));
const status = async (id: string) => (await sql`SELECT status, paid_as, tip_paise, reviewed_by FROM wa_items WHERE id = ${id}`)[0];
const pairIdOf = async (upi: string) => (await sql`SELECT id FROM wa_pairs WHERE upi_item_id = ${upi}`)[0]?.id as string | undefined;

beforeEach(async () => {
  await resetDb();
  const h = await businessWithAllRoles('XOXO');
  bid = h.bid;
  ownerId = h.users.owner.id;
  ({ owner, accountant, entry_staff: staff, viewer } = h.clients);
  groupId = crypto.randomUUID();
  await sql`INSERT INTO wa_groups (id, business_id, wa_group_id, name, active, created_at) VALUES (${groupId}, ${bid}, '120363000000000001@g.us', 'Guest payment', 1, ${Date.now()})`;
  await sql`UPDATE wa_listener_status SET last_heartbeat_at = NULL, last_message_at = NULL, state = NULL, version = NULL`;
  await sql`DELETE FROM wa_seen_groups`;
});

describe('the inbox', () => {
  it('shows pairs and photos on their own as cards, by shift (8 am to 8 am), in the order sent', async () => {
    const u1 = await add({ kind: 'upi', amount: 2497, sent: at(23, 21, 8), utr: '319852358212' });
    const b1 = await add({ kind: 'bill', amount: 2497, billNo: '26112317', sent: at(23, 21, 8, 50) });
    const b5 = await add({ kind: 'bill', amount: 125, billNo: '26112376', sent: at(23, 21, 53) });
    const u17 = await add({ kind: 'upi', amount: 385, caption: '2611241', sent: at(24, 0, 13) });
    const b18 = await add({ kind: 'bill', amount: 368, billNo: '2611241', sent: at(24, 0, 14) });
    await sql`UPDATE wa_items SET reply_to_id = ${'m-' + u17} WHERE id = ${b18}`;
    const late = await add({ kind: 'other', sent: at(24, 9, 0) });
    await pairAll();
    const r = await owner.get(`${W()}/inbox`);
    expect(r.status).toBe(200);
    expect(r.json.counts).toEqual({ pending: 6, confirmed: 0, rejected: 0, duplicate: 0 });
    expect(r.json.shifts.map((s: any) => s.day)).toEqual(['2026-11-24', '2026-11-23']);
    const night = r.json.shifts[1].cards;
    expect(night.map((c: any) => [c.upi?.id ?? null, c.bill?.id ?? null, c.diffPaise, c.agrees])).toEqual([
      [u1, b1, 0, true], [null, b5, null, false], [u17, b18, 1700, false],
    ]);
    expect(night[0].pair).toMatchObject({ confidence: 80, byHand: false });
    expect(night[0].upi).toMatchObject({ app: 'Paytm', sender: 'Ashwin New XOXO', utr: '319852358212', payee: 'exosparkgoainn@icici' });
    expect(r.json.shifts[0].cards[0].other.id).toBe(late);
  });

  it('is for the Owner and Accountant only', async () => {
    expect((await accountant.get(`${W()}/inbox`)).status).toBe(200);
    expect((await staff.get(`${W()}/inbox`)).status).toBe(403);
    expect((await viewer.get(`${W()}/inbox`)).status).toBe(403);
    expect((await new Client().get(`${W()}/inbox`)).status).toBe(401);
    expect((await staff.get(`${W()}/groups`)).status).toBe(403);
  });

  it('says when the listener is offline (never called in, or more than 30 minutes ago)', async () => {
    let l = (await owner.get(`${W()}/inbox`)).json.listener;
    expect(l).toMatchObject({ never: true, offline: true });
    await sql`UPDATE wa_listener_status SET last_heartbeat_at = ${Date.now() - 29 * 60_000}, state = 'connected'`;
    l = (await owner.get(`${W()}/inbox`)).json.listener;
    expect(l).toMatchObject({ never: false, offline: false, state: 'connected' });
    await sql`UPDATE wa_listener_status SET last_heartbeat_at = ${Date.now() - 31 * 60_000}`;
    expect((await owner.get(`${W()}/inbox`)).json.listener.offline).toBe(true);
  });

  it('serves the photo to its own business only', async () => {
    const u = await add({ kind: 'upi', amount: 230, sent: at(23, 21, 9) });
    const res = await owner.raw(`${W()}/items/${u}/file`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect([...new Uint8Array(await res.arrayBuffer())].slice(0, 3)).toEqual([0xff, 0xd8, 0xff]);
    expect((await staff.raw(`${W()}/items/${u}/file`)).status).toBe(403);
    const other = await businessWithAllRoles('Other');
    expect((await other.clients.owner.raw(`/businesses/${other.bid}/wa/items/${u}/file`)).status).toBe(404);
  });
});

describe('review', () => {
  it('confirms a pair; a tip only when the guest paid more; Undo puts both back', async () => {
    const u = await add({ kind: 'upi', amount: 385, caption: '2611241', sent: at(24, 0, 13) });
    const b = await add({ kind: 'bill', amount: 368, billNo: '2611241', sent: at(24, 0, 14) });
    await pairAll();
    const p = (await pairIdOf(u))!;
    expect((await owner.post(`${W()}/pairs/${p}/confirm`, { tip: true })).status).toBe(200);
    expect(await status(u)).toMatchObject({ status: 'confirmed', tip_paise: 1700, reviewed_by: ownerId });
    expect(await status(b)).toMatchObject({ status: 'confirmed', paid_as: 'upi' });
    expect((await owner.post(`${W()}/pairs/${p}/confirm`)).status).toBe(409);
    const audit = await sql`SELECT action FROM audit_log WHERE business_id = ${bid} AND action LIKE 'wa.%'`;
    expect(audit.map((a) => a.action)).toEqual(['wa.confirm']);

    expect((await owner.post(`${W()}/items/${b}/restore`)).status).toBe(200);
    expect(await status(u)).toMatchObject({ status: 'pending', tip_paise: null, reviewed_by: null });
    expect(await status(b)).toMatchObject({ status: 'pending', paid_as: null });
    expect(await pairIdOf(u)).toBe(p);

    const eq = await add({ kind: 'upi', amount: 230, sent: at(23, 21, 9) });
    await add({ kind: 'bill', amount: 230, billNo: '26112386', sent: at(23, 21, 9, 50) });
    await pairAll();
    const r = await owner.post(`${W()}/pairs/${await pairIdOf(eq)}/confirm`, { tip: true });
    expect(r).toMatchObject({ status: 400, json: { error: expect.stringContaining('not more than the bill') } });
  });

  it('Confirm all that agree confirms only same-amount pairs Bookr is sure of', async () => {
    const u1 = await add({ kind: 'upi', amount: 2497, sent: at(23, 21, 8) });
    await add({ kind: 'bill', amount: 2497, billNo: '26112317', sent: at(23, 21, 8, 50) });
    const u8 = await add({ kind: 'upi', amount: 200, sent: at(23, 22, 1) });
    await add({ kind: 'bill', amount: 200, billNo: '26112390', sent: at(23, 22, 27) }); // 26 min apart: 70
    const u11 = await add({ kind: 'upi', amount: 900, sent: at(23, 23, 1) });
    await add({ kind: 'bill', amount: 839, billNo: '26112392', sent: at(23, 23, 2) });
    await pairAll();
    const ids = [await pairIdOf(u1), await pairIdOf(u8), await pairIdOf(u11)];
    const r = await accountant.post(`${W()}/confirm-agreeing`, { pairIds: ids });
    expect(r.json).toEqual({ confirmed: 1 });
    expect((await status(u1)).status).toBe('confirmed');
    expect((await status(u8)).status).toBe('pending');
    expect((await status(u11)).status).toBe('pending');
  });

  it('a bill with no UPI photo is confirmed as cash; a paired photo is confirmed with its pair', async () => {
    const b5 = await add({ kind: 'bill', amount: 125, billNo: '26112376', sent: at(23, 21, 53) });
    expect((await owner.post(`${W()}/items/${b5}/confirm`)).status).toBe(400);
    expect((await owner.post(`${W()}/items/${b5}/confirm`, { paidAs: 'cash' })).status).toBe(200);
    expect(await status(b5)).toMatchObject({ status: 'confirmed', paid_as: 'cash' });

    const u = await add({ kind: 'upi', amount: 230, sent: at(23, 21, 9) });
    await add({ kind: 'bill', amount: 230, billNo: '26112386', sent: at(23, 21, 9, 50) });
    await pairAll();
    expect((await owner.post(`${W()}/items/${u}/confirm`)).status).toBe(409);
    const alone = await add({ kind: 'upi', amount: 999, sent: at(23, 12, 0) });
    expect((await owner.post(`${W()}/items/${alone}/confirm`)).status).toBe(200);
    expect((await status(alone)).paid_as).toBeNull();
  });

  it('rejecting a photo takes its pair apart and Bookr pairs again what is left', async () => {
    const u1 = await add({ kind: 'upi', amount: 230, sent: at(23, 21, 9) });
    const b1 = await add({ kind: 'bill', amount: 230, billNo: '26112386', sent: at(23, 21, 9, 50) });
    await pairAll();
    expect((await owner.post(`${W()}/items/${u1}/reject`)).status).toBe(200);
    expect((await status(u1)).status).toBe('rejected');
    expect(await pairIdOf(u1)).toBeUndefined();
    // A second copy of the payment posted later now pairs with the bill.
    const u2 = await add({ kind: 'upi', amount: 230, sent: at(23, 21, 12) });
    await pairAll();
    expect((await sql`SELECT upi_item_id FROM wa_pairs WHERE bill_item_id = ${b1}`)[0].upi_item_id).toBe(u2);
    const tab = await owner.get(`${W()}/inbox?tab=rejected`);
    expect(tab.json.shifts[0].cards[0].upi.id).toBe(u1);
    expect((await owner.post(`${W()}/items/${u1}/restore`)).status).toBe(200);
    expect((await status(u1)).status).toBe('pending');
  });

  it('corrects what was read: the photo then counts as read and pairs', async () => {
    const u8 = await add({ kind: 'upi', amount: null, sent: at(23, 22, 1), read: 'failed' });
    const b9 = await add({ kind: 'bill', amount: 200, billNo: '26112390', sent: at(23, 22, 5) });
    await pairAll();
    expect(await pairIdOf(u8)).toBeUndefined();
    const r = await owner.patch(`${W()}/items/${u8}`, { amount: '200', utr: ' 3198 5235 8212 ', paidAt: '2026-11-23 22:01' });
    expect(r.status).toBe(200);
    const row = (await sql`SELECT amount_paise, utr, doc_at, read_status FROM wa_items WHERE id = ${u8}`)[0];
    expect(row).toMatchObject({ amount_paise: 20000, utr: '319852358212', doc_at: istToMs(2026, 11, 23, 22, 1), read_status: 'read' });
    expect((await sql`SELECT bill_item_id FROM wa_pairs WHERE upi_item_id = ${u8}`)[0].bill_item_id).toBe(b9);
    expect((await owner.patch(`${W()}/items/${u8}`, { amount: '-5' })).status).toBe(400);
    expect((await owner.patch(`${W()}/items/${u8}`, { kind: 'cheque' })).status).toBe(400);
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'wa.edit'`)[0].n).toBe(1);
  });

  it('pairs and unpairs by hand; Bookr does not pair them again', async () => {
    const u = await add({ kind: 'upi', amount: 900, sent: at(23, 23, 1) });
    const b = await add({ kind: 'bill', amount: 839, billNo: '26112392', sent: at(23, 23, 2) });
    const b10 = await add({ kind: 'bill', amount: 368, billNo: '26112391', sent: at(23, 22, 39) });
    await pairAll();
    const p = (await pairIdOf(u))!;
    expect((await owner.del(`${W()}/pairs/${p}`)).status).toBe(200);
    await pairAll();
    expect(await pairIdOf(u)).toBeUndefined();
    const r = await owner.post(`${W()}/pairs`, { upiItemId: u, billItemId: b10 });
    expect(r.status).toBe(201);
    expect((await sql`SELECT bill_item_id, by_hand FROM wa_pairs WHERE upi_item_id = ${u}`)[0]).toMatchObject({ bill_item_id: b10, by_hand: 1 });
    expect((await owner.post(`${W()}/pairs`, { upiItemId: b, billItemId: u })).status).toBe(400);
  });
});

describe('groups', () => {
  it('lists the groups the listener sees and starts reading one, with a department and head', async () => {
    env.WA_INGEST_SECRET = SECRET;
    const hb = await new Client().call('POST', '/wa/heartbeat', { state: 'connected', groups: [
      { id: '120363000000000002@g.us', name: 'XOXO staff' }, { id: '120363000000000001@g.us', name: 'Guest payment' }] },
    { 'X-Bookr-WA-Secret': SECRET });
    expect(hb.status).toBe(200);
    const g = await owner.get(`${W()}/groups`);
    expect(g.json.groups.map((x: any) => x.name)).toEqual(['Guest payment']);
    expect(g.json.seen.map((x: any) => x.name)).toEqual(['XOXO staff']); // one already read is not offered
    const head = g.json.heads.find((h: any) => h.name === 'Sales');
    const r = await owner.post(`${W()}/groups`, { waGroupId: '120363000000000002@g.us', department: 'Café', defaultHeadId: head.id });
    expect(r.status).toBe(201);
    const after = await owner.get(`${W()}/groups`);
    expect(after.json.groups.find((x: any) => x.name === 'XOXO staff')).toMatchObject({ department: 'Café', defaultHeadId: head.id, active: true });
    expect(after.json.seen).toEqual([]);
    expect(after.json.departments).toEqual(['Café']);

    expect((await owner.patch(`${W()}/groups/${groupId}`, { active: false, department: 'Front desk' })).status).toBe(200);
    expect((await sql`SELECT active, department FROM wa_groups WHERE id = ${groupId}`)[0]).toMatchObject({ active: 0, department: 'Front desk' });
    expect((await owner.patch(`${W()}/groups/${groupId}`, { defaultHeadId: crypto.randomUUID() })).status).toBe(400);

    const other = await businessWithAllRoles('Other');
    const taken = await other.clients.owner.post(`/businesses/${other.bid}/wa/groups`, { waGroupId: '120363000000000002@g.us', name: 'XOXO staff' });
    expect(taken).toMatchObject({ status: 409, json: { error: 'This group is read for another business.' } });
  });

  it('the heartbeat keeps the groups it sees', async () => {
    const { heartbeat } = await import('../src/wa');
    await heartbeat(env.DB, { groups: [{ id: '120363000000000009@g.us', name: 'Vendor bills' }] });
    await heartbeat(env.DB, { groups: [{ id: '120363000000000009@g.us', name: 'Vendor bills (new)' }] });
    expect(await sql`SELECT name FROM wa_seen_groups`).toEqual([{ name: 'Vendor bills (new)' }]);
  });
});
