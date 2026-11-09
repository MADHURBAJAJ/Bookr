// The dashboard's jobs waiting (GET /home): counts read from what is stored, per role. Invented lines only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, sql, resetDb } from './helpers';
import { addDays, istDay } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const T = (cells: (string | number)[]) => cells.join('\t');
const STATEMENT = [
  T(['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)']),
  T([1, 'S30000001', '31/10/2026', '31/10/2026 10:03:47 AM', '-', 'UPI/600000000001/Breakfast/xxab-1@okicici/SAMPLE BANK/ICIaaaa', 'CR', 840, '1840']),
  T([2, 'S30000002', '31/10/2026', '31/10/2026 8:48:36 PM', '-', 'UPI/110000000001/Veg/xxh225@okaxis//ICIbbbb', 'DR', 1418, '422']),
  T([3, 'S30000003', '31/10/2026', '31/10/2026 9:00:00 PM', '-', 'UPI/110000000002/salary/xx6056@ybl//ICIcccc', 'DR', 300, '122']),
  T([4, 'S30000004', '31/10/2026', '31/10/2026 9:00:01 PM', '-', 'UPI/RVSL110000000002/salary/xx6056@ybl//ICIcccc', 'CR', 300, '422']),
  // 7:30 am on 1 Nov is still the 31 Oct shift.
  T([1, 'S30000005', '01/11/2026', '01/11/2026 7:30:00 AM', '-', 'UPI/110000000003/Milk/xxmilk@ybl//ICIdddd', 'DR', 50, '372']),
  T([2, 'S30000006', '01/11/2026', '01/11/2026 9:00:00 AM', '-', 'UPI/110000000004/Ice/xxice@ybl//ICIeeee', 'DR', 70, '302']),
].join('\n');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function hotel() {
  const h = await businessWithAllRoles('Hotel');
  const o = h.clients.owner;
  const acc = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'HUF A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
  const veg = (await o.post(`/businesses/${h.bid}/heads`, { name: 'Vegetables', type: 'expense' })).json.id;
  expect((await o.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: STATEMENT })).json).toMatchObject({ added: 6 });
  const row = async (tran: string) => (await sql`SELECT id FROM bank_rows WHERE tran_id = ${tran}`)[0].id as string;
  // One payment booked, the salary and its reversal left out: the 50 and the 70 wait.
  expect((await o.post(`/businesses/${h.bid}/bank-rows/${await row('S30000002')}/book`, { headId: veg, party: 'Sabzi Wala' })).status).toBe(200);
  expect((await o.post(`/businesses/${h.bid}/bank-rows/ignore-reversals`, {})).json.pairs).toBe(1);
  // An expense page: one row approved, one still a draft.
  const page = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=expense_list&day=2026-10-31`, PNG, 'image/png')).json.id;
  const util = (await o.get(`/businesses/${h.bid}/heads`)).json.heads.find((x: any) => x.name === 'Utilities').id;
  await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/expense-rows`, { narration: 'Gas cylinder', amount: '1100', headId: util });
  await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/expense-rows`, { narration: 'Auto fare', amount: '150' });
  expect((await h.clients.accountant.post(`/businesses/${h.bid}/uploads/${page}/expense-rows/approve`)).json.approved).toBe(1);
  return { ...h, acc, page, home: (role: keyof typeof h.clients = 'owner') => h.clients[role].get(`/businesses/${h.bid}/home`) };
}

describe('dashboard', () => {
  it('Book expenses counts bank payments not booked yet, by account, up to the last bank line; cash drafts are not counted', async () => {
    const h = await hotel();
    const r = (await h.home()).json;
    // 50 and 70 wait; the booked 1418 and the left-out salary do not; the 150 cash draft is not a bank payment.
    expect(r.bookExpenses).toEqual({
      count: 2, paise: 12000, oldestDay: '2026-10-31',
      accounts: [{ id: h.acc, name: 'HUF A', count: 2, paise: 12000, oldestDay: '2026-10-31', lastAt: expect.any(Number) }],
    });
    const last = (await sql`SELECT max(posted_at) AS at FROM bank_rows WHERE account_id = ${h.acc}`)[0].at;
    expect(r.bookExpenses.accounts[0].lastAt).toBe(last);
    expect(r.fresh.bank).toEqual([expect.objectContaining({ id: h.acc, name: 'HUF A', lastAt: last })]);
    // Booking one takes it off.
    const ice = (await sql`SELECT id FROM bank_rows WHERE tran_id = 'S30000006'`)[0].id;
    const util = (await h.clients.owner.get(`/businesses/${h.bid}/heads`)).json.heads.find((x: any) => x.name === 'Utilities').id;
    expect((await h.clients.owner.post(`/businesses/${h.bid}/bank-rows/${ice}/book`, { headId: util })).status).toBe(200);
    expect((await h.home()).json.bookExpenses).toMatchObject({ count: 1, paise: 5000 });
  });

  it('counts UPI credits not matched, card days not settled and expense photos to approve', async () => {
    const h = await hotel();
    const r = (await h.home('accountant')).json;
    expect(r.upi.credits).toMatchObject({ count: 1, paise: 84000, oldestDay: '2026-10-31' });
    expect(r.cards).toEqual({ days: 0, netPaise: 0, oldestDay: null });
    expect(r.photos).toEqual({ count: 1, paise: 15000, pages: [{ uploadId: h.page, day: '2026-10-31', count: 1, paise: 15000 }] });
  });

  it('lists recent shifts not confirmed with what is left, and the cash check of confirmed ones', async () => {
    const h = await hotel();
    const today = istDay(Date.now());
    const open = addDays(today, -2);
    const done = addDays(today, -3);
    await sql`INSERT INTO shifts (id, business_id, shift_day, status, created_at) VALUES (${crypto.randomUUID()}, ${h.bid}, ${open}, 'open', 0)`;
    await sql`INSERT INTO shifts (id, business_id, shift_day, status, created_at) VALUES (${crypto.randomUUID()}, ${h.bid}, ${done}, 'confirmed', 0)`;
    const r = (await h.home()).json;
    expect(r.shifts).toEqual({ count: 1, list: [{ day: open, status: 'open', toCheck: 0, toDecide: 0, bank: { billsLeft: 0, creditsLeft: 0, cardsLeft: 0 } }] });
    // The confirmed shift has no cash count yet.
    expect(r.cash).toEqual([{ day: done, differencePaise: null, counted: false }]);
  });

  it('shows each role only its part: Viewer gets no bank, cash or photos; Entry staff keep Bring in', async () => {
    const h = await hotel();
    const v = (await h.home('viewer')).json;
    expect(v).toMatchObject({ bookExpenses: null, upi: null, cards: null, cash: null, photos: null });
    expect(v.fresh).toMatchObject({ bank: null, cards: null });
    expect(v.shifts).toBeDefined();
    expect(v.waitingBills).toBeDefined();
    expect((await h.home('entry_staff')).status).toBe(403);
    expect((await h.home('owner')).json.bookExpenses.count).toBe(2);
  });
});
