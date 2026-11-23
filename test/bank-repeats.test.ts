// Repeats on Bank → Money out (approved 23 Nov 2026): fees, the same word in the note, the same UPI ID, the same card
// shop; booked by a person with an optional rule; "Not these" hides a card for everyone. Invented lines only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, sql, resetDb } from './helpers';
import { partyFromNote, readNote } from '../src/repeats';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const T = (cells: (string | number)[]) => cells.join('\t');
let n = 0;
const L = (day: string, time: string, desc: string, amount: number) => T([++n, `S3${String(n).padStart(7, '0')}`, `${day}/11/2026`, `${day}/11/2026 ${time}`, '-', desc, 'DR', amount, '1000']);
const STATEMENT = () => [
  T(['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)']),
  L('02', '10:00:00 AM', 'EZY/UPICCMDR_~600000000001~021126', 1.77),
  L('02', '11:00:00 AM', 'EZY/UPICCMDR_~600000000002~021126', 0.84),
  L('03', '11:00:00 AM', 'EZY/UPICCMDR_~600000000003~031126', 10.56),
  L('02', '9:08:00 AM', 'UPI/111000000001/UPI Pay/xx2604@oksbi//ICIa1', 2063),
  L('02', '8:44:00 PM', 'UPI/111000000002/UPI Pay/xx2604@oksbi//ICIa2', 4139),
  L('03', '9:12:00 AM', 'UPI/111000000003/UPI Pay/xx2604@oksbi//ICIa3', 2968),
  L('04', '4:44:00 PM', 'UPI/111000000004/hemantsalary/xx3938@ybl//ICIb1', 16000),
  L('04', '5:27:00 PM', 'UPI/111000000005/salary/xx7.17@oksbi//ICIb2', 25000),
  L('04', '1:31:00 PM', 'UPI/111000000006/sonusalary/xx6593@ptaxis//ICIb3', 9324),
  L('05', '10:55:00 AM', 'UPI/111000000007/madhvimaidsalar/xxpa-1@oksbi//ICIb4', 3666),
  L('05', '11:30:00 AM', 'VPS/AVE MIRIAM /202611051700/630511678152/NORTH GOA', 2268),
  L('06', '9:41:00 AM', 'VPS/AVE MIRIAM /202611061511/630809191237/NORTH GOA', 3390),
  L('06', '2:00:00 PM', 'UPI/111000000008/plumber/xx6882@oksbi//ICIc1', 1800),
  L('06', '3:00:00 PM', 'UPI/111000000009/bajajexp/xx0912@cnrb//ICId1', 5100),
  L('07', '3:00:00 PM', 'UPI/111000000010/bajqjexp/xx0913@cnrb//ICId2', 16900),
  L('08', '3:00:00 PM', 'UPI/111000000011/bajaj/xx26-2@axl//ICId3', 2000),
  L('08', '4:00:00 PM', 'UPI/111000000012/bajajexp/xx4613@ptsbi//ICId4', 2000),
].join('\n');

async function setUp() {
  const h = await businessWithAllRoles('Hotel');
  const o = h.clients.owner;
  const acc = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'HUF A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
  const head = async (name: string) => (await o.post(`/businesses/${h.bid}/heads`, { name, type: 'expense' })).json.id as string | undefined
    ?? (await sql`SELECT id FROM heads WHERE business_id = ${h.bid} AND name = ${name}`)[0].id as string;
  const heads = { upi: await head('UPI charges'), sal: await head('Salaries'), veg: await head('VEGETABLE'), rep: await head('REPAIR & MAINTAINANCE'), bajaj: await head('BAJAJ WITHDRAWL') };
  const p = await o.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: STATEMENT() });
  expect(p.status, JSON.stringify(p.json)).toBe(200);
  return { h, acc, heads, acc2: h.clients.accountant };
}

describe('reading a note', () => {
  it('splits a name from its word', () => {
    expect(partyFromNote('hemantsalary', 'salary')).toBe('Hemant');
    expect(partyFromNote('salary', 'salary')).toBeNull();
    expect(partyFromNote('xoxogas', 'gas')).toBeNull();
    expect(readNote('sonusalary', [{ id: 'h', name: 'Salaries' }])).toEqual({ item: 'salary', party: 'Sonu', headId: 'h' });
    expect(readNote('UPI Pay', [])).toBeNull();
  });
});

describe('repeats', () => {
  it('fees, a word in the note, a UPI ID and a card shop; booked with a rule; hidden and shown again', async () => {
    const { h, heads, acc2 } = await setUp();
    let r = await acc2.get(`/businesses/${h.bid}/bank-repeats`);
    expect(r.status).toBe(200);
    const by = (k: string) => r.json.repeats.find((x: any) => x.key === k);
    expect(by('fee')).toMatchObject({ count: 3, totalPaise: 1317, headId: heads.upi, contains: 'EZY/UPICCMDR' });
    const sal = by('word:salary');
    expect(sal).toMatchObject({ count: 3, headId: heads.sal, payees: 3 });
    expect(sal.lines.map((l: any) => l.party).sort()).toEqual(['Hemant', 'Sonu', null]);
    expect(sal.maybe).toEqual([expect.objectContaining({ amountPaise: 366600, party: 'Madhvimaid', maybe: true })]);
    expect(by('vpa:xx2604@oksbi')).toMatchObject({ count: 3, days: 2, headId: null });
    expect(by('card:ave miriam')).toMatchObject({ count: 2 });
    // The WITHDRAWL head names the family: bajajexp and bajaj from any payee (the typo bajqjexp is not guessed).
    expect(by('word:bajaj')).toMatchObject({ count: 3, headId: heads.bajaj });
    // One plumber line is not a repeat.
    expect(r.json.repeats.some((x: any) => x.key === 'word:plumber')).toBe(false);
    // Entry staff and viewers do not see the cards.
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/bank-repeats`)).status).toBe(403);

    // Book the UPI ID's lines with a party and a rule, as the card does.
    const v = by('vpa:xx2604@oksbi');
    const b = await acc2.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: v.lines.map((l: any) => ({ rowId: l.id, headId: heads.veg, party: 'Ramesh veg' })) });
    expect(b.json.booked).toBe(3);
    expect((await acc2.post(`/businesses/${h.bid}/rules`, { name: 'Ramesh veg', direction: 'DR', vpa: 'xx2604@oksbi', headId: heads.veg })).status).toBe(201);
    // The fee card's rule: the next fee comes with UPI charges, and the card goes.
    const f = by('fee');
    await acc2.post(`/businesses/${h.bid}/bank-rows/book-many`, { items: f.lines.map((l: any) => ({ rowId: l.id, headId: heads.upi, item: 'UPI card fee' })) });
    await acc2.post(`/businesses/${h.bid}/rules`, { name: 'UPI card fee', direction: 'DR', contains: 'EZY/UPICCMDR', headId: heads.upi });
    const acc = (await sql`SELECT id FROM accounts WHERE business_id = ${h.bid} AND kind = 'bank'`)[0].id;
    await h.clients.owner.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: [STATEMENT().split('\n')[0], L('07', '10:00:00 AM', 'EZY/UPICCMDR_~600000000009~071126', 2.12)].join('\n') });
    const rows = (await acc2.get(`/businesses/${h.bid}/bank-rows?from=2026-11-07&to=2026-11-08`)).json.rows;
    expect(rows.find((x: any) => x.kind === 'upi_fee').suggest).toMatchObject({ headId: heads.upi, from: 'rule' });
    r = await acc2.get(`/businesses/${h.bid}/bank-repeats`);
    expect(r.json.repeats.map((x: any) => x.key).sort()).toEqual(['card:ave miriam', 'word:bajaj', 'word:salary']);

    // Not these: hidden for everyone, shown again by Undo.
    expect((await acc2.post(`/businesses/${h.bid}/bank-repeats/hide`, { key: 'card:ave miriam' })).status).toBe(200);
    r = await h.clients.owner.get(`/businesses/${h.bid}/bank-repeats`);
    expect(r.json.repeats.map((x: any) => x.key).sort()).toEqual(['word:bajaj', 'word:salary']);
    expect(r.json.hidden).toEqual(['card:ave miriam']);
    await acc2.post(`/businesses/${h.bid}/bank-repeats/unhide`, { key: 'card:ave miriam' });
    expect((await acc2.get(`/businesses/${h.bid}/bank-repeats`)).json.repeats).toHaveLength(3);
  });

  it('a joined note is read on the line: item, party and head, marked from the note', async () => {
    const { h, heads, acc2 } = await setUp();
    const rows = (await acc2.get(`/businesses/${h.bid}/bank-rows?from=2026-11-04&to=2026-11-05`)).json.rows;
    expect(rows.find((x: any) => x.remark === 'hemantsalary').suggest).toMatchObject({ item: 'salary', party: 'Hemant', headId: heads.sal, from: 'note' });
    expect(rows.find((x: any) => x.remark === 'salary').suggest.from).not.toBe('note');
  });
});
