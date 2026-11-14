// Transfers between the business's own accounts, parties, and what Bookr learned from items (approved 14 Nov 2026).
// Invented accounts and lines only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, sql, resetDb } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const T = (cells: (string | number)[]) => cells.join('\t');
const HEAD = T(['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)']);
const A_LINES = [HEAD,
  T([1, 'S40000001', '10/11/2026', '10/11/2026 11:02:00 AM', '-', 'NEFT-SELF TRANSFER-REF77', 'DR', 50000, '100000']),
  T([2, 'S40000002', '10/11/2026', '10/11/2026 12:00:00 PM', '-', 'IMPS/P2A/Z99/BIS HOSTEL/xx', 'DR', 7000, '93000']),
  T([3, 'S40000003', '10/11/2026', '10/11/2026 1:00:00 PM', '-', 'UPI/220000000001/Petrol bike/xxpump@ybl//ICIaaaa', 'DR', 300, '92700']),
].join('\n');
const B_LINES = [HEAD,
  T([1, 'S50000001', '10/11/2026', '10/11/2026 11:03:00 AM', '-', 'NEFT CR-ICICI-FROM A', 'CR', 50000, '50000']),
].join('\n');

async function setup() {
  const h = await businessWithAllRoles('Hotel');
  const o = h.clients.owner;
  const a = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'ICICI current', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
  const b = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'HUF', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
  expect((await o.post(`/businesses/${h.bid}/bank/${a}/paste`, { text: A_LINES })).json).toMatchObject({ added: 3 });
  expect((await o.post(`/businesses/${h.bid}/bank/${b}/paste`, { text: B_LINES })).json).toMatchObject({ added: 1 });
  const row = async (tran: string) => (await sql`SELECT id FROM bank_rows WHERE tran_id = ${tran}`)[0].id as string;
  const rows = async () => (await h.clients.accountant.get(`/businesses/${h.bid}/bank-rows?from=2026-11-10&to=2026-11-10`)).json.rows as any[];
  return { ...h, a, b, row, rows };
}

describe('transfers between own accounts', () => {
  it('pairs a debit and a credit of the same amount in two accounts, books both as one transfer, and Undo opens both', async () => {
    const h = await setup();
    const [out, inn] = [await h.row('S40000001'), await h.row('S50000001')];
    const rs = await h.rows();
    expect(rs.find((r) => r.id === out).transfer).toMatchObject({ otherAccountId: h.b, otherAccountName: 'HUF', pairRowId: inn, why: 'pair' });
    expect(rs.find((r) => r.id === inn).transfer).toMatchObject({ otherAccountId: h.a, pairRowId: out, why: 'pair' });
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/${out}/own-transfer`, { otherAccountId: h.b, pairRowId: inn })).status).toBe(200);
    const tx = await sql`SELECT account_id, type, amount_paise, json_extract(ocr_original, '$.leg') AS leg FROM transactions WHERE business_id = ${h.bid} ORDER BY leg`;
    expect(tx).toEqual([{ account_id: h.b, type: 'transfer', amount_paise: 5000000, leg: 'in' }, { account_id: h.a, type: 'transfer', amount_paise: 5000000, leg: 'out' }]);
    expect((await sql`SELECT status FROM bank_rows WHERE id IN (${out}, ${inn})`).map((r: any) => r.status)).toEqual(['booked', 'booked']);
    // Not money spent: listed on All payments as a transfer, left out of the totals.
    const mo = (await h.clients.accountant.get(`/businesses/${h.bid}/money-out?from=2026-11-10&to=2026-11-10`)).json;
    expect(mo.lines.find((l: any) => l.id === out).status).toBe('transfer');
    expect(mo.transfers).toEqual({ count: 1, paise: 5000000 });
    expect(mo.total.paise).toBe(700000 + 30000);
    // Undo from the other side: both rows go, both lines open.
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/${inn}/reopen`, {})).status).toBe(200);
    expect(await sql`SELECT id FROM transactions WHERE business_id = ${h.bid}`).toEqual([]);
    expect((await sql`SELECT status FROM bank_rows WHERE id IN (${out}, ${inn})`).map((r: any) => r.status)).toEqual(['unmatched', 'unmatched']);
  });

  it('knows a line by words written on the other account, and remembers a word when booked by hand; the other side joins later', async () => {
    const h = await setup();
    const hostel = await h.row('S40000002');
    expect((await h.rows()).find((r) => r.id === hostel).transfer).toBeNull();
    expect((await h.clients.accountant.put(`/businesses/${h.bid}/accounts/${h.b}/identifiers`, { identifiers: ['huf.madhur@okicici', 'x'] })).json.identifiers).toEqual(['huf.madhur@okicici']);
    // Booked by hand, one-sided, remembering "BIS HOSTEL" on HUF.
    const res = await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/${hostel}/own-transfer`, { otherAccountId: h.b, remember: 'BIS HOSTEL' });
    expect(res.json).toMatchObject({ ok: true, remembered: 'BIS HOSTEL' });
    const acc = (await h.clients.accountant.get(`/businesses/${h.bid}/accounts`)).json.accounts.find((x: any) => x.id === h.b);
    expect(acc.identifiers).toEqual(['huf.madhur@okicici', 'BIS HOSTEL']);
    // HUF's credit of 7000 comes later: it joins the transfer already booked, no new rows.
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${h.b}/paste`, { text: [HEAD, T([2, 'S50000002', '10/11/2026', '10/11/2026 12:01:00 PM', '-', 'IMPS CR FROM ICICI', 'CR', 7000, '57000'])].join('\n') });
    const cr = await h.row('S50000002');
    const hint = (await h.rows()).find((r) => r.id === cr).transfer;
    expect(hint).toMatchObject({ why: 'leg', otherAccountId: h.a });
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/${cr}/own-transfer`, { otherAccountId: h.a, legId: hint.legId })).status).toBe(200);
    expect((await sql`SELECT count(*) AS n FROM transactions WHERE business_id = ${h.bid}`)[0].n).toBe(2);
    expect((await sql`SELECT status FROM bank_rows WHERE id = ${cr}`)[0].status).toBe('booked');
    // A new line naming BIS HOSTEL is known by itself.
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${h.a}/paste`, { text: [HEAD, T([4, 'S40000004', '10/11/2026', '10/11/2026 6:00:00 PM', '-', 'IMPS/P2A/Z98/BIS HOSTEL/yy', 'DR', 1234, '91466'])].join('\n') });
    expect((await h.rows()).find((r) => r.id === undefined || r.tranId === 'S40000004').transfer).toMatchObject({ why: 'words', otherAccountId: h.b, word: 'BIS HOSTEL' });
  });

  it('refuses a booked line, the same account, or cash; Viewer and Entry staff cannot book', async () => {
    const h = await setup();
    const out = await h.row('S40000001');
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/${out}/own-transfer`, { otherAccountId: h.a })).status).toBe(400);
    const cash = (await sql`SELECT id FROM accounts WHERE business_id = ${h.bid} AND kind = 'cash'`)[0]?.id;
    if (cash) expect((await h.clients.accountant.post(`/businesses/${h.bid}/bank-rows/${out}/own-transfer`, { otherAccountId: cash })).status).toBe(400);
    expect((await h.clients.viewer.post(`/businesses/${h.bid}/bank-rows/${out}/own-transfer`, { otherAccountId: h.b })).status).toBe(403);
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/bank-rows/${out}/own-transfer`, { otherAccountId: h.b })).status).toBe(403);
  });
});

describe('items and parties', () => {
  it('suggests a bank payment head from the same item, groups All payments by party and item, and Change / Forget steer the learning', async () => {
    const h = await setup();
    const o = h.clients.owner;
    const heads = (await o.get(`/businesses/${h.bid}/heads`)).json.heads;
    const util = heads.find((x: any) => x.name === 'Utilities').id;
    const misc = heads.find((x: any) => x.type === 'expense' && x.id !== util).id;
    // Petrol booked once to Utilities by hand; the next petrol line is suggested Utilities from the item.
    const petrol = await h.row('S40000003');
    expect((await o.post(`/businesses/${h.bid}/bank-rows/${petrol}/book`, { headId: util, note: 'Petrol bike' })).status).toBe(200);
    await o.post(`/businesses/${h.bid}/bank/${h.a}/paste`, { text: [HEAD, T([5, 'S40000005', '10/11/2026', '10/11/2026 7:00:00 PM', '-', 'UPI/220000000002/Petrol/xxother@ybl//ICIbbbb', 'DR', 200, '91266'])].join('\n') });
    const next = (await h.rows()).find((r) => r.tranId === 'S40000005');
    expect(next.suggest).toMatchObject({ headId: util, from: 'item' });
    const items = (await h.clients.accountant.get(`/businesses/${h.bid}/learned-items`)).json.items;
    expect(items.find((x: any) => x.word === 'petrol')).toMatchObject({ headId: util, lines: 1 });
    // Change petrol to another head: the next line follows it.
    expect((await h.clients.accountant.put(`/businesses/${h.bid}/learned-items`, { word: 'Petrol', headId: misc })).status).toBe(200);
    expect((await h.rows()).find((r) => r.tranId === 'S40000005').suggest).toMatchObject({ headId: misc, from: 'item' });
    // Forget: nothing is suggested from the item.
    expect((await h.clients.accountant.put(`/businesses/${h.bid}/learned-items`, { word: 'petrol', headId: null })).status).toBe(200);
    expect((await h.rows()).find((r) => r.tranId === 'S40000005').suggest.from).toBeNull();
    expect((await h.clients.viewer.put(`/businesses/${h.bid}/learned-items`, { word: 'petrol', headId: null })).status).toBe(403);
    const mo = (await h.clients.accountant.get(`/businesses/${h.bid}/money-out?from=2026-11-10&to=2026-11-10`)).json;
    expect(mo.byItem.find((g: any) => g.id === 'petrol')).toMatchObject({ count: 2, paise: 50000 });
    expect(mo.byParty.length).toBeGreaterThan(0);
    expect((await h.clients.accountant.get(`/businesses/${h.bid}/money-out?from=2026-11-10&to=2026-11-10&item=petrol`)).json.lines).toHaveLength(2);
  });

  it('lists parties with month totals, flags a likely duplicate, and Merge moves the lines', async () => {
    const h = await setup();
    const o = h.clients.owner;
    const util = (await o.get(`/businesses/${h.bid}/heads`)).json.heads.find((x: any) => x.name === 'Utilities').id;
    expect((await o.post(`/businesses/${h.bid}/bank-rows/${await h.row('S40000003')}/book`, { headId: util, party: 'Blinkit', note: 'veg' })).status).toBe(200);
    expect((await o.post(`/businesses/${h.bid}/bank-rows/${await h.row('S40000002')}/book`, { headId: util, party: 'BLINKIT COMMERCE PVT LTD', note: 'milk' })).status).toBe(200);
    // One line each: the shorter name is the one to keep.
    const s = (await h.clients.accountant.get(`/businesses/${h.bid}/parties-summary?month=2026-11`)).json;
    const big = s.parties.find((p: any) => p.name === 'BLINKIT COMMERCE PVT LTD');
    const small = s.parties.find((p: any) => p.name === 'Blinkit');
    expect(big.monthPaise).toBe(700000);
    expect(big.sameAs).toEqual({ id: small.id, name: 'Blinkit' });
    expect(small.sameAs).toBeNull();
    expect((await h.clients.viewer.post(`/businesses/${h.bid}/parties/${big.id}/merge`, { into: small.id })).status).toBe(403);
    expect((await h.clients.accountant.post(`/businesses/${h.bid}/parties/${big.id}/merge`, { into: small.id })).json).toEqual({ ok: true, moved: 1 });
    const after = (await h.clients.accountant.get(`/businesses/${h.bid}/parties-summary?month=2026-11`)).json.parties;
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ name: 'Blinkit', monthPaise: 730000, aliases: ['BLINKIT COMMERCE PVT LTD'] });
  });
});
