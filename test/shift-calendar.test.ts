// The shift calendar: each day saved, in progress or not started, what is still open, and the oldest shift to do.
// Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { shiftDayOf } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('shift calendar', () => {
  it('marks each day and points at the oldest shift not saved, from the bank books start', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await sql`UPDATE accounts SET opening_date = '2026-10-30' WHERE business_id = ${h.bid} AND kind = 'bank'`;
    // 30 Oct: a register page and a UPI credit not matched. 31 Oct: saved.
    await h.software([['2610311', '31 12:00', 'CASH', '1000']]);
    await h.register([{ no: '2610311', amount: '1000', pays: [['cash', '1000']] }, { day: '2026-10-30', no: '2610301', amount: '100', pays: [['cash', '100']] }]);
    expect((await h.clients.accountant.get(`/businesses/${h.bid}/shifts/2026-10-30`)).status).toBe(200);
    await h.lines([['30 15:00', 500, 'CR', 'UPI/110000000002/Guest/xxguest@ybl//ICIbbbb']]);
    await h.decideRest('2026-10-31');
    await h.confirm();
    const base = `/businesses/${h.bid}/shifts/calendar`;

    const r = (await h.clients.accountant.get(`${base}?month=2026-10`)).json;
    const at = (d: string) => r.days.find((x: any) => x.day === d);
    expect(r).toMatchObject({ month: '2026-10', workStart: '2026-10-30', oldestToDo: '2026-10-30' });
    expect(r.days).toHaveLength(31);
    expect(at('2026-10-31')).toMatchObject({ state: 'saved', off: false });
    // Not saved: only what stops saving counts (owner, 25 Nov 2026). Its UPI credit is matched on save, so not counted.
    expect(at('2026-10-30')).toMatchObject({ state: 'started', off: false, open: 0 });
    const seen = (await h.clients.viewer.get(`${base}?month=2026-10`)).json;
    expect(seen.days.find((x: any) => x.day === '2026-10-30')).toMatchObject({ state: 'started', open: 0 });
    // A bill to decide does count before saving.
    await sql`UPDATE bill_comparisons SET difference = 'amount', decision = NULL WHERE business_id = ${h.bid} AND shift_day = '2026-10-30'`;
    expect((await h.clients.accountant.get(`${base}?month=2026-10`)).json.days.find((x: any) => x.day === '2026-10-30')).toMatchObject({ open: 1 });
    // Saved: a UPI credit with no bill counts (the bank's people only).
    await h.lines([['31 16:00', 77, 'CR', 'UPI/110000000003/Guest/yyguest@ybl//ICIbbbb']]);
    expect((await h.clients.accountant.get(`${base}?month=2026-10`)).json.days.find((x: any) => x.day === '2026-10-31')).toMatchObject({ state: 'saved', open: 1 });
    expect((await h.clients.viewer.get(`${base}?month=2026-10`)).json.days.find((x: any) => x.day === '2026-10-31')).toMatchObject({ open: 0 });
    // Before the bank's books start but after the cash book's: can be opened, no mark.
    expect(at('2026-10-29')).toMatchObject({ state: null });
    expect(at('2026-10-29').off).toBe(r.booksStart > '2026-10-29');

    const nov = (await h.clients.accountant.get(`${base}?month=2026-11`)).json;
    expect(nov.days.find((x: any) => x.day === '2026-11-01')).toMatchObject({ state: 'not_started', off: false });

    // Days after the shift running now cannot be opened.
    const today = shiftDayOf(Date.now());
    const now = (await h.clients.viewer.get(`${base}?month=${today.slice(0, 7)}`)).json;
    for (const x of now.days) expect(x.off).toBe(x.day > today || x.day < now.booksStart);

    // A month before the books start: nothing to open.
    await sql`UPDATE accounts SET opening_date = '2026-10-30' WHERE business_id = ${h.bid}`;
    const sep = (await h.clients.accountant.get(`${base}?month=2026-09`)).json;
    expect(sep.days.every((x: any) => x.off && x.state === null)).toBe(true);
  });
});
