// Cash tab (14 Nov 2026): a cash bill whose register side says UPI tells whether the bank has that payment. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('cash tab: the other side', () => {
  it('says when no UPI credit backs the register, and when one does', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610331', '31 12:28', 'CASH', '164']]);
    await h.register([{ no: '2610331', amount: '164', discount: '4', pays: [['upi', '160']] }]);
    const cash = async () => (await h.clients.accountant.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`)).json;
    let b = (await cash()).bills.find((x: any) => x.billNo === '2610331');
    expect(b.witness).toEqual({ mode: 'upi', amountPaise: 16000, found: null });
    await h.credits([['31 12:30', 160]]);
    b = (await cash()).bills.find((x: any) => x.billNo === '2610331');
    expect(b.witness.found).toMatch(/^Bank UPI credit at 12:30/);
    // Switching the side: Use register takes the cash off.
    const c = (await sql`SELECT id FROM bill_comparisons WHERE bill_no = '2610331'`)[0].id;
    expect((await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${c}`, { decision: 'use_software' })).status).toBe(200);
    expect((await cash()).bills.find((x: any) => x.billNo === '2610331').countedPaise).toBe(16400);
    expect((await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${c}`, { decision: 'use_register' })).status).toBe(200);
    expect((await cash()).bills.find((x: any) => x.billNo === '2610331').countedPaise).toBe(0);
  });

  it('a bill paid a rounded amount is counted as paid, not a difference', async () => {
    const h = await hotel();
    await h.software([['2610341', '31 12:00', 'CASH', '633'], ['2610342', '31 13:00', 'CASH', '547']]);
    await h.register([{ no: '2610341', amount: '633', discount: '3', pays: [['cash', '630']] }, { no: '2610342', amount: '547', discount: '-3', pays: [['cash', '550']] }]);
    const k = (await h.clients.accountant.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`)).json;
    expect(k.bills.map((b: any) => [b.billNo, b.differs, b.roundedPaise, b.countedPaise])).toEqual([['2610341', false, 300, 63000], ['2610342', false, -300, 55000]]);
  });
});
