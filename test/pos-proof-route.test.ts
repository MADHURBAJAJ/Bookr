// Payment proof list (24 Nov 2026): Bookr's answer to the POS, and the same list in Bookr from the bills the POS sent.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { istToMs } from '../src/time';
import { businessWithAllRoles, Client, resetDb, sql } from './helpers';

vi.setConfig({ testTimeout: 60_000 });
afterAll(() => sql.end());
const at = (h: number, m: number) => istToMs(2026, 11, 24, h, m);

let bid: string;
let owner: Client, viewer: Client;
let key: string;
let groupId: string;
let n = 0;

const add = async (o: { kind: 'upi' | 'bill' | 'card' | 'other'; amount?: number; sent: number; billNo?: string; caption?: string; read?: string; group?: string; status?: string }) => {
  const id = crypto.randomUUID();
  n++;
  await sql`INSERT INTO wa_items (id, business_id, group_id, wa_message_id, sender_name, sent_at, media_type, file_key, content_sha256, size_bytes,
      caption, kind, read_status, amount_paise, bill_no, status, created_at)
    VALUES (${id}, ${bid}, ${o.group ?? groupId}, ${'m-' + id}, 'Reception', ${o.sent}, 'image/jpeg', ${'wa/' + id}, ${'s' + n + id}, 4,
      ${o.caption ?? null}, ${o.kind}, ${o.read ?? 'read'}, ${o.amount == null ? null : o.amount * 100}, ${o.billNo ?? null}, ${o.status ?? 'pending'}, ${Date.now() + n})`;
  return id;
};
const ask = (body: unknown, k = key) => new Client().call('POST', '/pos/proof', body, { Authorization: `Bearer ${k}` });
const bill = (no: string, rupees: number, mode: string, paidAt: number, state = 'settled') => ({
  key: `b-${no}`, billNo: no, kind: 'bill', state, totalPaise: rupees * 100, at: paidAt, label: 'T4',
  tenders: state === 'printed' ? [] : [{ paymentId: `p-${no}`, mode, amountPaise: rupees * 100, totalPaise: rupees * 100, paidAt }],
});

beforeEach(async () => {
  await resetDb();
  const h = await businessWithAllRoles('XOXO');
  bid = h.bid;
  ({ owner, viewer } = h.clients);
  key = (await owner.post(`/businesses/${bid}/pos/link`)).json.key;
  groupId = crypto.randomUUID();
  await sql`INSERT INTO wa_groups (id, business_id, wa_group_id, name, active, pos_proof, created_at) VALUES (${groupId}, ${bid}, '120363000000000001@g.us', 'Guest payment', 1, 1, ${Date.now()})`;
});

describe('POST /pos/proof', () => {
  it('answers each bill with its proof, the extras, and how many photos are still being read', async () => {
    await add({ kind: 'upi', amount: 2497, sent: at(12, 1), caption: 'C261124007' });
    await add({ kind: 'bill', amount: 950, billNo: 'C261124008', caption: 'cash', sent: at(13, 0) });
    await add({ kind: 'upi', amount: 500, sent: at(14, 0) });
    await add({ kind: 'upi', sent: at(14, 5), read: 'waiting' });
    await add({ kind: 'upi', amount: 300, sent: at(14, 6), status: 'duplicate' });
    // A staff group's photo is not proof.
    const staff = crypto.randomUUID();
    await sql`INSERT INTO wa_groups (id, business_id, wa_group_id, name, active, created_at) VALUES (${staff}, ${bid}, '120363000000000002@g.us', 'XOXO staff', 1, ${Date.now()})`;
    await add({ kind: 'upi', amount: 700, sent: at(15, 0), group: staff });

    const r = await ask({ businessId: bid, shiftDay: '2026-11-24', startHour: 8, bills: [
      bill('C261124007', 2497, 'upi', at(12, 0)), bill('C261124008', 950, 'cash', at(12, 55)), bill('C261124009', 400, 'upi', at(13, 30)),
      bill('C261124010', 800, 'upi', at(16, 0), 'printed'),
    ] });
    expect(r.status).toBe(200);
    expect(r.json.rows.map((x: any) => [x.billNo, x.status])).toEqual([
      ['C261124007', 'matched'], ['C261124008', 'matched'], ['C261124009', 'missing'], ['C261124010', 'waiting']]);
    expect(r.json.extras.map((e: any) => e.what)).toEqual(['UPI ₹500, no POS bill']);
    expect(r.json.reading).toBe(1);
    expect(r.json.listener).toEqual({ lastSeenAt: null, state: null });
  });

  it('refuses a wrong key, another business and bad bills', async () => {
    expect((await ask({ businessId: bid, shiftDay: '2026-11-24', bills: [] }, 'wrong')).status).toBe(401);
    expect((await ask({ businessId: crypto.randomUUID(), shiftDay: '2026-11-24', bills: [] })).status).toBe(401);
    expect((await ask({ businessId: bid, shiftDay: '24 Nov', bills: [] })).status).toBe(400);
    const bad = await ask({ businessId: bid, shiftDay: '2026-11-24', bills: [{ ...bill('C1', 1, 'cheque', at(9, 0)) }] });
    expect(bad).toMatchObject({ status: 400, json: { error: 'mode cheque is not known.' } });
  });
});

describe('which groups count', () => {
  it('only groups switched on for POS proof; the switch is in the group settings', async () => {
    await add({ kind: 'upi', amount: 500, sent: at(14, 0) });
    const ask24 = async () => (await ask({ businessId: bid, shiftDay: '2026-11-24', bills: [] })).json.extras.length;
    expect(await ask24()).toBe(1);
    expect((await owner.call('PATCH', `/businesses/${bid}/wa/groups/${groupId}`, { posProof: false })).status).toBe(200);
    expect(await ask24()).toBe(0);
    expect((await owner.get(`/businesses/${bid}/wa/groups`)).json.groups[0]).toMatchObject({ name: 'Guest payment', posProof: false });
    expect((await owner.call('PATCH', `/businesses/${bid}/wa/groups/${groupId}`, { posProof: 'yes' })).status).toBe(400);
  });
});

describe('GET /businesses/:id/pos/proof', () => {
  it('builds the list from the bills the POS sent Bookr', async () => {
    const msg = crypto.randomUUID();
    await sql`INSERT INTO pos_messages (id, business_id, kind, body, outcome, received_at) VALUES (${msg}, ${bid}, 'bill_settled', '{}', 'stored', ${Date.now()})`;
    await sql`INSERT INTO pos_bills (id, business_id, message_id, bill_no, entity_name, gst_registered, printed_at, settled_at, shift_day, gross_paise, discount_paise,
        cgst_paise, sgst_paise, round_off_paise, total_paise) VALUES ('pb1', ${bid}, ${msg}, 'C261124007', 'Exospark', 1, ${at(11, 50)}, ${at(12, 0)}, '2026-11-24', 249700, 0, 0, 0, 0, 249700)`;
    await sql`INSERT INTO pos_payment_lines (id, business_id, message_id, bill_id, payment_id, kind, mode, amount_paise, payment_total_paise, paid_at, shift_day)
      VALUES ('l1', ${bid}, ${msg}, 'pb1', 'pay1', 'bill', 'upi', 249700, 249700, ${at(12, 0)}, '2026-11-24'),
             ('l2', ${bid}, ${msg}, NULL, 'pay2', 'receipt', 'cash', 100000, 100000, ${at(15, 0)}, '2026-11-24')`;
    await add({ kind: 'upi', amount: 2497, sent: at(12, 3) });
    const r = await viewer.get(`/businesses/${bid}/pos/proof?day=2026-11-24`);
    expect(r.status).toBe(200);
    expect(r.json.rows.map((x: any) => [x.billNo, x.kind, x.status])).toEqual([['C261124007', 'bill', 'matched'], [null, 'receipt', 'missing']]);
  });
});

describe('bills of other shifts, found by their number (28 Nov 2026)', () => {
  const sentBill = async (id: string, no: string, day: string, rupees: number, printedAt: number) => {
    const msg = crypto.randomUUID();
    await sql`INSERT INTO pos_messages (id, business_id, kind, body, outcome, received_at) VALUES (${msg}, ${bid}, 'bill_settled', '{}', 'stored', ${Date.now()})`;
    await sql`INSERT INTO pos_bills (id, business_id, message_id, bill_no, entity_name, gst_registered, place, printed_at, settled_at, shift_day, gross_paise, discount_paise,
        cgst_paise, sgst_paise, round_off_paise, total_paise) VALUES (${id}, ${bid}, ${msg}, ${no}, 'Exospark', 1, 'OH 6', ${printedAt}, ${printedAt}, ${day}, ${rupees * 100}, 0, 0, 0, 0, ${rupees * 100})`;
    await sql`INSERT INTO pos_payment_lines (id, business_id, message_id, bill_id, payment_id, kind, mode, amount_paise, payment_total_paise, paid_at, shift_day)
      VALUES (${'l-' + id}, ${bid}, ${msg}, ${id}, ${'pay-' + id}, 'bill', 'upi', ${rupees * 100}, ${rupees * 100}, ${printedAt}, ${day})`;
  };

  it('proof posted after 8 am for last night\'s bill is not an extra today; that bill\'s own shift shows it, even posted days later', async () => {
    // Printed 7:49 am on 25 Nov: the 24 Nov shift. Proof posted 8:35 am: the 25 Nov shift.
    const printed = istToMs(2026, 11, 25, 7, 49);
    await sentBill('pb17', 'C261125017', '2026-11-24', 368, printed);
    await add({ kind: 'upi', amount: 360, sent: istToMs(2026, 11, 25, 8, 35), caption: 'C261125017' });
    const today = await ask({ businessId: bid, shiftDay: '2026-11-25', bills: [] });
    expect(today.json.extras).toEqual([]);
    expect(today.json.earlier.map((x: any) => [x.billNo, x.shiftDay, x.status, x.differences])).toEqual([
      ['C261125017', '2026-11-24', 'difference', ['UPI ₹360 posted, settled ₹368 UPI']]]);

    // Its own shift: a row; and a bill photo posted three days later, naming it, is found too.
    await add({ kind: 'bill', amount: 368, billNo: 'C261125017', sent: istToMs(2026, 11, 28, 11, 0) });
    const own = await viewer.get(`/businesses/${bid}/pos/proof?day=2026-11-24`);
    expect(own.json.rows.map((x: any) => [x.billNo, x.status, x.proof.map((e: any) => e.kind)])).toEqual([['C261125017', 'difference', ['upi', 'bill']]]);
  });
});
