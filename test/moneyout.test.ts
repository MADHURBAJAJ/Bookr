// Money out: bank debits and cash expenses in one read-only list. Invented lines only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, sql, resetDb } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const T = (cells: (string | number)[]) => cells.join('\t');
const STATEMENT = [
  T(['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)']),
  T([1, 'S20000001', '31/10/2026', '31/10/2026 10:03:47 AM', '-', 'UPI/600000000001/Breakfast/xxab-1@okicici/SAMPLE BANK/ICIaaaa', 'CR', 840, '1840']),
  T([2, 'S20000002', '31/10/2026', '31/10/2026 10:03:48 AM', '-', 'EZY/UPICCMDR_~600000000001~311026', 'DR', 8.92, '1831.08']),
  T([3, 'S20000003', '31/10/2026', '31/10/2026 8:48:36 PM', '-', 'UPI/110000000001/Veg/xxh225@okaxis//ICIbbbb', 'DR', 1418, '413.08']),
  T([4, 'S20000004', '31/10/2026', '31/10/2026 9:00:00 PM', '-', 'UPI/110000000002/salary/xx6056@ybl//ICIcccc', 'DR', 300, '113.08']),
  T([5, 'S20000005', '31/10/2026', '31/10/2026 9:00:01 PM', '-', 'UPI/RVSL110000000002/salary/xx6056@ybl//ICIcccc', 'CR', 300, '413.08']),
  // Before 8 am: still the 31 Oct shift. After 8 am: the 1 Nov shift.
  T([1, 'S20000006', '01/11/2026', '01/11/2026 7:30:00 AM', '-', 'UPI/110000000003/Milk/xxmilk@ybl//ICIdddd', 'DR', 50, '363.08']),
  T([2, 'S20000007', '01/11/2026', '01/11/2026 9:00:00 AM', '-', 'UPI/110000000004/Ice/xxice@ybl//ICIeeee', 'DR', 70, '293.08']),
].join('\n');

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** A hotel with every role, a bank account with a statement, a booked payment and a cash expense page. */
async function hotel() {
  const h = await businessWithAllRoles('Hotel');
  const o = h.clients.owner;
  const acc = (await o.post(`/businesses/${h.bid}/accounts`, { name: 'HUF A', kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
  const veg = (await o.post(`/businesses/${h.bid}/heads`, { name: 'Vegetables', type: 'expense' })).json.id;
  expect((await o.post(`/businesses/${h.bid}/bank/${acc}/paste`, { text: STATEMENT })).json).toMatchObject({ added: 7 });
  const row = async (tran: string) => (await sql`SELECT id FROM bank_rows WHERE tran_id = ${tran}`)[0].id as string;
  // The 1418 payment is booked to Vegetables with a party; the 300 salary and its reversal are left out.
  expect((await o.post(`/businesses/${h.bid}/bank-rows/${await row('S20000003')}/book`, { headId: veg, party: 'Sabzi Wala' })).status).toBe(200);
  expect((await o.post(`/businesses/${h.bid}/bank-rows/ignore-reversals`, {})).json.pairs).toBe(1);
  // Less came in than billed on the 840 credit: a difference expense on the bank, but nothing was paid out.
  await sql`INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, head_id, narration, source, status, matched_bank_row, created_at)
    VALUES (${crypto.randomUUID()}, ${h.bid}, ${acc}, '2026-10-31', 4000, 'expense', ${veg}, 'Difference on UPI', 'bank_sheet', 'approved', ${await row('S20000001')}, 0)`;
  // Cash: one approved row with a head, one draft without.
  const page = (await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=expense_list&day=2026-10-31`, PNG, 'image/png')).json.id;
  const heads = (await o.get(`/businesses/${h.bid}/heads`)).json.heads;
  const util = heads.find((x: any) => x.name === 'Utilities').id;
  expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/expense-rows`, { narration: 'Gas cylinder', amount: '1100', headId: util })).status).toBe(201);
  expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page}/expense-rows`, { narration: 'Auto fare', amount: '150' })).status).toBe(201);
  expect((await h.clients.accountant.post(`/businesses/${h.bid}/uploads/${page}/expense-rows/approve`)).json.approved).toBe(1);
  const cash = (await sql`SELECT id FROM accounts WHERE business_id = ${h.bid} AND kind = 'cash'`)[0].id as string;
  const party = (await sql`SELECT id FROM parties WHERE business_id = ${h.bid} AND name = 'Sabzi Wala'`)[0].id as string;
  const list = (q = '') => o.get(`/businesses/${h.bid}/money-out?from=2026-10-31&to=2026-10-31${q}`);
  return { ...h, acc, veg, util, cash, party, page, list };
}

describe('money out', () => {
  it('lists bank debits and cash expenses of the shifts, each payment once', async () => {
    const h = await hotel();
    const r = (await h.list()).json;
    const by = (n: string) => r.lines.find((l: any) => l.narration === n || l.detail?.includes(n));
    expect(r.lines.map((l: any) => l.amountPaise).sort((a: number, b: number) => a - b)).toEqual([892, 5000, 15000, 30000, 110000, 141800]);
    expect(by('Veg')).toMatchObject({ source: 'bank', accountName: 'HUF A', head: 'Vegetables', party: 'Sabzi Wala', status: 'booked', amountPaise: 141800 });
    expect(by('UPICCMDR')).toMatchObject({ status: 'not_booked', head: null, day: '2026-10-31' });
    expect(by('Milk')).toMatchObject({ status: 'not_booked', day: '2026-10-31' }); // 7:30 am on 1 Nov is the 31 Oct shift
    expect(by('salary')).toMatchObject({ status: 'left_out', note: 'Payment reversed' });
    expect(by('Gas cylinder')).toMatchObject({ source: 'cash_photo', accountName: 'Cash', head: 'Utilities', status: 'approved', uploadId: h.page, at: null });
    expect(by('Auto fare')).toMatchObject({ status: 'draft', head: null });
    // Not listed: credits, the 1 Nov shift's debit, the booked payment's own expense row, a credit's difference.
    expect(r.lines.some((l: any) => l.detail?.includes('Ice') || l.detail?.includes('Breakfast'))).toBe(false);
    expect(r.lines.filter((l: any) => l.amountPaise === 141800)).toHaveLength(1);
    expect(r.lines.some((l: any) => l.amountPaise === 4000)).toBe(false);
    // Totals leave out the reversed payment.
    expect(r.total).toEqual({ count: 5, paise: 272692 });
    expect(r.waiting).toEqual({ count: 3, paise: 20892 });
    expect(r.leftOut).toEqual({ count: 1, paise: 30000 });
    expect(r.byAccount).toEqual([
      { id: h.acc, name: 'HUF A', count: 3, paise: 147692 },
      { id: h.cash, name: 'Cash', count: 2, paise: 125000 },
    ]);
    expect(r.byHead).toEqual([
      { id: h.veg, name: 'Vegetables', count: 1, paise: 141800 },
      { id: h.util, name: 'Utilities', count: 1, paise: 110000 },
      { id: 'none', name: 'No head yet', count: 3, paise: 20892 },
    ]);
    const next = (await h.clients.owner.get(`/businesses/${h.bid}/money-out?from=2026-11-01&to=2026-11-01`)).json;
    expect(next.lines.map((l: any) => l.amountPaise)).toEqual([7000]);
  });

  it('filters by paid from, head, party and not booked, with totals for what is shown', async () => {
    const h = await hotel();
    const cash = (await h.list(`&account=${h.cash}`)).json;
    expect(cash.lines.map((l: any) => l.narration).sort()).toEqual(['Auto fare', 'Gas cylinder']);
    expect(cash.total).toEqual({ count: 2, paise: 125000 });
    expect((await h.list(`&account=${h.acc}`)).json.total).toEqual({ count: 3, paise: 147692 });
    expect((await h.list(`&head=${h.veg}`)).json.total).toEqual({ count: 1, paise: 141800 });
    expect((await h.list('&head=none')).json.total).toEqual({ count: 3, paise: 20892 });
    expect((await h.list(`&party=${h.party}`)).json.lines.map((l: any) => l.amountPaise)).toEqual([141800]);
    const waiting = (await h.list('&waiting=1')).json;
    expect(waiting.lines.map((l: any) => l.status).sort()).toEqual(['draft', 'not_booked', 'not_booked']);
    expect(waiting.total).toEqual({ count: 3, paise: 20892 });
    expect((await h.list(`&waiting=1&account=${h.cash}`)).json.total).toEqual({ count: 1, paise: 15000 });
    expect((await h.clients.owner.get(`/businesses/${h.bid}/money-out?from=2026-11-02&to=2026-10-31`)).status).toBe(400);
    // Without dates: this month so far, by India time.
    const d = (await h.clients.accountant.get(`/businesses/${h.bid}/money-out`)).json;
    expect(d.from).toBe(`${d.to.slice(0, 8)}01`);
    expect(d.options.accounts.map((a: any) => a.name)).toEqual(['Cash', 'HUF A']);
  });

  it('only Owner and Accountant see it, and only their own business', async () => {
    const h = await hotel();
    expect((await h.clients.accountant.get(`/businesses/${h.bid}/money-out?from=2026-10-31&to=2026-10-31`)).json.total.count).toBe(5);
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/money-out`)).status).toBe(403);
    expect((await h.clients.viewer.get(`/businesses/${h.bid}/money-out`)).status).toBe(403);
    const other = await businessWithAllRoles('Other');
    expect((await other.clients.owner.get(`/businesses/${h.bid}/money-out`)).status).toBe(404); // not a member: the business is not shown
    expect((await other.clients.owner.get(`/businesses/${other.bid}/money-out?from=2026-10-31&to=2026-10-31`)).json.lines).toEqual([]);
  });
});
