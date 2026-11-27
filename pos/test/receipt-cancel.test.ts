// Cancelling a receipt taken by mistake (27 Nov 2026): managers and owners only, the same open day, with a reason. The
// money comes off the bill and the day's totals, the number stays (marked cancelled), Bookr is told, and anything to undo
// first is said. All names and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

async function setup() {
  const s = await setupBusiness();
  const { B, owner, counter, ok } = s;
  await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['C1', 'C2'] }] }));
  const stay = (await ok(counter.post(`${B}/stays`, { room: 'C1', guestName: 'Cancel Guest' }))).id;
  await ok(counter.post(`${B}/stays/${stay}/charges`, { amount: '2000', note: 'Extra bed' }));
  const acc = (await ok(counter.get(`${B}/stays/${stay}/bill`))).stay.accountId;
  const take = async (amount: string, kind = 'receipt') => {
    await ok(counter.post(`${B}/debtors/${acc}/receipts`, { kind, payments: [{ mode: 'upi', amount, payAccountId: s.upiCompany }] }));
    return (await q("SELECT id FROM settlements WHERE kind = 'receipt' AND business_id = ? ORDER BY at DESC, rowid DESC LIMIT 1", s.businessId))[0].id as string;
  };
  return { s, B, owner, counter, ok, stay, acc, take };
}

describe('cancel a receipt', () => {
  it('only a manager or owner cancels; money comes off the bill and the day, once; Bookr is told', async () => {
    const { s, B, owner, counter, ok, stay, take } = await setup();
    const rid = await take('500');
    expect((await ok(counter.get(`${B}/stays/${stay}/bill`))).balancePaise).toBe(150_000);
    expect((await counter.get(`${B}/receipts/${rid}/cancel`)).status).toBe(403);
    const ck = await ok(owner.get(`${B}/receipts/${rid}/cancel`));
    expect(ck.blockers).toEqual([]);
    expect((await owner.post(`${B}/receipts/${rid}/cancel`, {})).status).toBe(400);   // a reason is needed
    const r = await ok(owner.post(`${B}/receipts/${rid}/cancel`, { reason: 'No money was taken', note: 'test' }));
    expect(r.slip).toMatchObject({ totalPaise: 50_000, reason: 'No money was taken' });
    const bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    expect(bill.balancePaise).toBe(200_000);
    expect(bill.lines.filter((l: any) => l.kind === 'receipt').every((l: any) => l.cancelled)).toBe(true);
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    const sum = (await ok(owner.get(`${B}/shifts/${day}`))).summary;
    expect((sum.receipts ?? []).reduce((t: number, x: any) => t + x.paise, 0)).toBe(0);   // left out of the day's money
    expect(sum.cancelledReceipts.map((x: any) => x.reason)).toEqual(['No money was taken']);
    expect(sum.payments.find((p: any) => p.settlementId === rid).cancelled).toBe(1);
    expect((await q("SELECT count(*) AS n FROM outbox WHERE kind = 'receipt' AND body LIKE '%\"kind\":\"cancel\"%'"))[0].n).toBe(1);
    // Twice: refused, with who cancelled it.
    const again = await ok(owner.get(`${B}/receipts/${rid}/cancel`));
    expect(again.blockers[0]).toMatch(/already cancelled/);
    expect((await owner.post(`${B}/receipts/${rid}/cancel`, { reason: 'Typed twice' })).status).toBe(409);
    void s;
  });

  it('says what to do first: checked out, refunded, advance used, day closed', async () => {
    const { s, B, owner, counter, ok, stay, acc, take } = await setup();
    // An advance more than the bill, part refunded: can't be cancelled.
    const adv = await take('3000', 'advance');
    await ok(owner.post(`${B}/debtors/${acc}/refund`, { mode: 'upi', amount: '500' }));
    expect((await ok(owner.get(`${B}/receipts/${adv}/cancel`))).blockers.join(' ')).toMatch(/refunded/);
    // A closed day: can't be cancelled.
    await q(`INSERT INTO shift_closes (id, business_id, shift_day, opening_float_paise, counted, counted_paise, expected_paise, difference_paise, totals, closed_at)
      SELECT 'sc-test', ?, shift_day, 0, '{}', 0, 0, 0, '{}', 1 FROM settlements WHERE id = ?`, s.businessId, adv);
    expect((await ok(owner.get(`${B}/receipts/${adv}/cancel`))).blockers.join(' ')).toMatch(/is closed/);
    void stay; void counter;
  });

  it('a checked-out guest\'s receipt is on a closed bill', async () => {
    const { B, owner, counter, ok, stay, take } = await setup();
    const rid = await take('2000');
    await ok(owner.post(`${B}/stays/${stay}/check-out`, { approverId: undefined }));
    expect((await ok(owner.get(`${B}/receipts/${rid}/cancel`))).blockers.join(' ')).toMatch(/checked out/);
    void counter;
  });

  it('an advance taken before arrival is no longer held once its receipt is cancelled', async () => {
    const { s, B, owner, counter, ok } = await setup();
    const plus = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const r = await ok(counter.post(`${B}/desk-advances`, { guestName: 'Early Sample', phone: '9800012345', checkIn: plus(3), payments: [{ mode: 'upi', amount: '1000', payAccountId: s.upiCompany }] }));
    const sid = (await q('SELECT settlement_id FROM desk_advances WHERE business_id = ?', s.businessId))[0].settlement_id;
    await ok(owner.post(`${B}/receipts/${sid}/cancel`, { reason: 'Wrong guest or room' }));
    expect((await q('SELECT status FROM desk_advances WHERE settlement_id = ?', sid))[0].status).toBe('cancelled');
    void r;
  });
});
