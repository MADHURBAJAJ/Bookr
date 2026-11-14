// Bills the software calls U/N (approved 14 Nov 2026): the same amount in the register is counted from the register by
// Bookr; one the register does not have waits on Payments › Complimentary for Paid by, Complimentary or Leave out. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('U/N bills', () => {
  it('same amount in the register is counted from the register; different amount waits; not in the register is on the Complimentary tab with its actions', async () => {
    const h = await hotel();
    await h.software([['2610321', '31 19:00', 'U/N' as never, '400'], ['2610322', '31 19:30', 'U/N' as never, '700'],
      ['2610323', '31 20:00', 'U/N' as never, '250'], ['2610324', '31 20:30', 'U/N' as never, '120'], ['2610325', '31 21:00', 'U/N' as never, '90']]);
    await h.register([{ no: '2610321', amount: '400', pays: [['upi', '400']] }, { no: '2610322', amount: '650', pays: [['cash', '650']] }]);
    const acc = h.clients.accountant;
    const cmp = async (bill: string) => (await sql`SELECT id, difference, decision, decided_by, note FROM bill_comparisons WHERE bill_no = ${bill}`)[0];

    // Case 1: same amount, the register's UPI is the only mode known.
    expect(await cmp('2610321')).toMatchObject({ difference: 'mode', decision: 'use_register', decided_by: null, note: 'Counted from the register: the software report does not say how it was paid' });
    // Case 2: amounts differ: a person decides.
    expect(await cmp('2610322')).toMatchObject({ difference: 'amount_and_mode', decision: null });

    // Case 3: not in the register: on the tab, needing a look.
    const tab = async () => (await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/complimentary`)).json;
    let t = await tab();
    expect(t.lines.map((l: any) => [l.billNo, l.why, l.status, l.valuePaise])).toEqual([
      ['2610323', 'unknown', 'look', 25000], ['2610324', 'unknown', 'look', 12000], ['2610325', 'unknown', 'look', 9000]]);
    expect(t.valuePaise).toBe(0);

    // Paid by Card: a register line is added and the bill is counted.
    const c23 = (await cmp('2610323')).id;
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${c23}/paid-by`, { mode: 'card' })).status).toBe(200);
    expect(await cmp('2610323')).toMatchObject({ difference: 'mode', decision: 'use_register' });
    // Complimentary with the guest's name.
    const c24 = (await cmp('2610324')).id;
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${c24}/complimentary`, { guestName: 'Staff meal' })).status).toBe(200);
    // Left out with a reason.
    const c25 = (await cmp('2610325')).id;
    expect((await acc.put(`/businesses/${h.bid}/comparisons/${c25}`, { decision: 'leave_out', note: 'Cancelled' })).status).toBe(200);
    t = await tab();
    expect(t.lines.map((l: any) => [l.billNo, l.why, l.status])).toEqual([['2610324', 'marked', 'ok']]);

    // A person can change Bookr's choice; undoing Paid by puts the bill back on the tab.
    expect((await acc.put(`/businesses/${h.bid}/comparisons/${(await cmp('2610321')).id}`, { decision: 'leave_out', note: 'Test bill' })).status).toBe(200);
    expect((await cmp('2610321')).decision).toBe('leave_out');
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${c23}/paid-by/undo`, {})).status).toBe(200);
    expect((await tab()).lines.map((l: any) => l.billNo)).toContain('2610323');
  });
});
