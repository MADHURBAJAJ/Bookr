// Funds flow: money in and out of each account between two shifts, transfers between them, and the checks against
// the statement balance. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('funds flow', () => {
  it('places every bank line and cash movement, keeps transfers out of the total, and checks the end against the statement', async () => {
    const h = await hotel();
    const huf = await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 12:00', 'CASH', '1000'], ['2610312', '31 12:30', 'UPI', '500']]);
    await h.register([{ no: '2610311', amount: '1000', pays: [['cash', '1000']] }, { no: '2610312', amount: '500', pays: [['upi', '500']] }]);
    await h.decideRest();
    await h.confirm();
    const { ids: [dep, veg, open] } = await h.lines([
      ['31 15:00', 800, 'CR', 'BY CASH DEPOSIT-MAIN BRANCH'],
      ['31 16:00', 300, 'DR', 'UPI/110000000001/Veg/xxveg@ybl//ICIbbbb'],
      ['31 17:00', 250, 'CR', 'NEFT FROM SOMEONE'],
    ]);
    const o = h.clients.owner;
    const base = `/businesses/${h.bid}`;
    const vegHead = (await o.post(`${base}/heads`, { name: 'Vegetables', type: 'expense' })).json.id;
    expect((await h.clients.accountant.post(`${base}/bank-rows/${dep}/cash-move`, { shiftDay: '2026-10-31' })).status).toBe(200);
    expect((await o.post(`${base}/bank-rows/${veg}/book`, { headId: vegHead })).status).toBe(200);
    await sql`UPDATE bank_rows SET balance_paise = 75000 WHERE id = ${open}`;
    const cash = (await sql`SELECT id FROM accounts WHERE business_id = ${h.bid} AND kind = 'cash'`)[0].id as string;

    const r = (await h.clients.accountant.get(`${base}/reports/funds-flow?from=2026-10-31&to=2026-10-31`)).json;
    const row = (k: string) => r.rows.find((x: any) => x.key === k);
    expect(row('in:cash_sales').amounts).toEqual({ [cash]: 100000 });
    expect(row('in:open')).toMatchObject({ amounts: { [huf]: 25000 }, warn: true });
    expect(row(`out:head:${vegHead}`).amounts).toEqual({ [huf]: 30000 });
    const tr = r.rows.find((x: any) => x.group === 'tr');
    expect(tr).toMatchObject({ label: 'Cash deposited in HUF A', amounts: { [cash]: -80000, [huf]: 80000 } });
    expect(r.end).toMatchObject({ [cash]: 20000, [huf]: 75000 });
    expect(r.checks[huf]).toMatchObject({ what: 'statement', paise: 75000, differencePaise: 0 });
    expect(r.memo.billed).toEqual({ n: 2, paise: 150000 });
    expect(r.memo.upiWaiting).toEqual({ n: 1, paise: 50000 });

    // The next shift starts where this one ended.
    const next = (await o.get(`${base}/reports/funds-flow?from=2026-11-01&to=2026-11-01`)).json;
    expect(next.start).toMatchObject({ [cash]: 20000, [huf]: 75000 });
    expect(next.end).toMatchObject({ [cash]: 20000, [huf]: 75000 });

    // A figure opens its lines.
    const d = (await o.get(`${base}/reports/funds-flow?from=2026-10-31&to=2026-10-31&key=${encodeURIComponent(`out:head:${vegHead}`)}`)).json;
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toMatchObject({ accountId: huf, paise: 30000, day: '2026-10-31' });

    // Bank data: not for entry staff or viewers.
    expect((await h.clients.viewer.get(`${base}/reports/funds-flow`)).status).toBe(403);
    expect((await h.clients.entry_staff.get(`${base}/reports/funds-flow`)).status).toBe(403);
  });
});
