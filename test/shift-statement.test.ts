// The shift's statement (approved 21 Nov 2026): every bank line of the 8 am to 8 am window, all accounts, with a day
// either side for finding an amount; matched lines carry their bills. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('Shift statement', () => {
  it('lists the window and a day either side, by account, with saved matches', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.account('Current B', 'UPI XOXO 2');
    await h.software([['2610311', '31 15:00', 'UPI', '550']]);
    await h.register([{ no: '2610311', amount: '550', pays: [['upi', '550']] }]);
    const [paid] = await h.credits([['31 15:01', 550], ['31 07:00', 550], ['31 21:00', 120]]);
    await h.credits([['31 22:00', 75]], 'Current B');
    await h.decideRest();
    await h.confirm();
    const r = await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/statement`);
    expect(r.status).toBe(200);
    expect(r.json.accounts.map((a: any) => a.name).sort()).toEqual(['Current B', 'HUF A']);
    const inShift = r.json.rows.filter((x: any) => x.inShift);
    expect(inShift.map((x: any) => x.amountPaise)).toEqual([55000, 12000, 7500]);
    expect(inShift.find((x: any) => x.id === paid)).toMatchObject({ status: 'matched', bills: '2610311', kind: 'upi_in', accountName: 'HUF A' });
    // 7 am on the 31st is the shift before: there for finding an amount, not in the shift.
    expect(r.json.rows.find((x: any) => !x.inShift)).toMatchObject({ amountPaise: 55000, shiftDay: '2026-10-30' });
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/shifts/2026-10-31/statement`)).status).toBe(403);
  });
});
