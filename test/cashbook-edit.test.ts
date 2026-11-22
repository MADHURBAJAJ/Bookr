// Changing a cash book after the fact (approved 22 Nov 2026). Invented amounts.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { businessWithAllRoles, resetDb, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 120_000 });

const ist = (n: number) => new Date(Date.now() + 5.5 * 3600000 - n * 86400000).toISOString().slice(0, 10);
const TODAY = ist(0);
const YEST = ist(1);
const OLD = ist(3);

async function setup() {
  const h = await businessWithAllRoles('Bgi Saharanpur');
  const o = h.clients.owner;
  const sms = (await o.post(`/businesses/${h.bid}/branches`, { name: 'Chilkana Road' })).json.id;
  const book = (await o.post(`/businesses/${h.bid}/cashbooks`, { name: 'Anup Maheshwari', branchId: sms, cashierUserId: h.users.entry_staff.id, openingBalance: '10,000', openingDate: ist(9) })).json.id as string;
  const cashier = h.clients.entry_staff;
  const base = `/businesses/${h.bid}/cashbooks/${book}`;
  const add = async (who: typeof o, day: string, kind: string, amount: string, narration = 'Bus fare') =>
    (await who.post(`${base}/entries`, { day, kind, amount, narration })).json.id as string;
  const dayOf = async (day: string) => (await o.get(`${base}/day/${day}`)).json;
  const line = async (day: string, id: string) => (await dayOf(day)).entries.find((e: { id: string }) => e.id === id);
  return { ...h, o, cashier, book, base, add, dayOf, line };
}

describe('changing a line', () => {
  it('the cashier changes today\'s and yesterday\'s lines; an older day only the Owner or Accountant', async () => {
    const { o, cashier, base, add, line, clients } = await setup();
    const t = await add(cashier, TODAY, 'expense', '450');
    expect((await cashier.patch(`${base}/entries/${t}`, { amount: '540', narration: 'Bus fare both ways' })).json).toMatchObject({ ok: true, changed: true });
    expect(await line(TODAY, t)).toMatchObject({ amountPaise: 54000, narration: 'Bus fare both ways', editedByName: expect.any(String), changedAfterCount: false });
    // Moved to yesterday: allowed; to an older day: not for the cashier.
    expect((await cashier.patch(`${base}/entries/${t}`, { day: YEST })).status).toBe(200);
    expect((await line(YEST, t)).amountPaise).toBe(54000);
    expect((await cashier.patch(`${base}/entries/${t}`, { day: OLD })).status).toBe(403);
    const old = await add(cashier, OLD, 'other_out', '200', 'Peon');
    expect((await cashier.patch(`${base}/entries/${old}`, { amount: '250' })).status).toBe(403);
    expect((await cashier.del(`${base}/entries/${old}`)).status).toBe(403);
    expect((await clients.accountant.patch(`${base}/entries/${old}`, { amount: '250' })).status).toBe(200);
    expect((await o.del(`${base}/entries/${old}`)).status).toBe(200);
    expect((await clients.viewer.patch(`${base}/entries/${t}`, { amount: '1' })).status).toBe(403);
    // Nothing changed: nothing written.
    expect((await cashier.patch(`${base}/entries/${t}`, { amount: '540' })).json).toMatchObject({ changed: false });
    // History: written, then each change.
    const hist = (await cashier.get(`${base}/entries/${t}/history`)).json.history;
    expect(hist.map((x: { action: string }) => x.action)).toEqual(['added', 'edited', 'edited']);
    expect(hist[1]).toMatchObject({ before: { amountPaise: 45000 }, after: { amountPaise: 54000 } });
    expect(hist[2]).toMatchObject({ before: { day: TODAY }, after: { day: YEST } });
  });

  it('refuses fee lines, cash accepted, approved expenses (Reopen first), settle lines and settled days', async () => {
    const { o, cashier, base, add, dayOf, bid } = await setup();
    await cashier.put(`${base}/fee/${TODAY}`, { amount: '5,000' });
    const fee = (await dayOf(TODAY)).entries.find((e: { kind: string }) => e.kind === 'fee');
    expect((await cashier.patch(`${base}/entries/${fee.id}`, { amount: '6,000' })).status).toBe(409);
    const exp = await add(cashier, TODAY, 'expense', '300');
    const head = (await o.get(`/businesses/${bid}/owner-look`)).json.heads.find((x: { type: string }) => x.type === 'expense').id;
    await o.put(`/businesses/${bid}/cashbook-lines/${exp}/head`, { headId: head });
    await o.post(`/businesses/${bid}/cashbook-lines/${exp}/review`, { status: 'approved' });
    expect((await cashier.patch(`${base}/entries/${exp}`, { amount: '350' })).status).toBe(409);
    // Reopen: back to waiting, then it can be changed.
    expect((await o.post(`/businesses/${bid}/cashbook-lines/${exp}/review`, { status: null })).status).toBe(200);
    expect((await cashier.patch(`${base}/entries/${exp}`, { amount: '350' })).status).toBe(200);
    // A short settled by the Owner: its line and the day stay as settled until Undo.
    await cashier.put(`${base}/count/${YEST}`, { counted: '9,900', note: 'short' });
    expect((await o.post(`${base}/count/${YEST}/settle`, { how: 'shortage' })).status).toBe(200);
    const short = (await dayOf(YEST)).entries.find((e: { fromSettle: number }) => e.fromSettle);
    expect((await o.patch(`${base}/entries/${short.id}`, { amount: '50' })).status).toBe(409);
    expect((await o.post(`/businesses/${bid}/cashbook-lines/${short.id}/review`, { status: null })).status).toBe(409);
    expect((await cashier.patch(`${base}/entries/${exp}`, { day: YEST })).status).toBe(409);
  });

  it('a change on a counted day is marked and listed for the Owner; a new count clears it', async () => {
    const { o, cashier, base, add, line, bid } = await setup();
    const a = await add(cashier, TODAY, 'expense', '500');
    await cashier.put(`${base}/count/${TODAY}`, { counted: '9,500' });
    expect((await line(TODAY, a)).changedAfterCount).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    await cashier.patch(`${base}/entries/${a}`, { amount: '400' });
    expect((await line(TODAY, a)).changedAfterCount).toBe(true);
    const look = (await o.get(`/businesses/${bid}/owner-look`)).json;
    expect(look.changed).toMatchObject([{ bookName: 'Anup Maheshwari', what: 'edit', before: { amountPaise: 50000 }, after: { amountPaise: 40000 } }]);
    // The Owner's own changes are not listed back to them.
    await o.patch(`${base}/entries/${a}`, { amount: '450' });
    expect((await o.get(`/businesses/${bid}/owner-look`)).json.changed).toHaveLength(1);
    // Counting again: the count is after the change.
    await new Promise((r) => setTimeout(r, 5));
    await cashier.put(`${base}/count/${TODAY}`, { counted: '9,550' });
    expect((await line(TODAY, a)).changedAfterCount).toBe(false);
    expect((await o.get(`/businesses/${bid}/owner-look`)).json.changed).toHaveLength(0);
  });
});
