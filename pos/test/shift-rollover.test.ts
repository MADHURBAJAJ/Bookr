// Shift close at the shift's hour (24 Nov 2026): a close by hand starts the next shift at once; a shift nobody closed is
// closed by itself at 8 am with its drawer "not counted", orders and printed bills carry on, the drawer is counted later
// (cash taken since is taken off), and an owner can reopen the last closed shift. All data is invented.
import { afterAll, describe, expect, it } from 'vitest';
import { billed, db, dispose, q, setupBusiness } from './helpers';
import { autoCloseAll } from '../src/routes/shifts';

afterAll(dispose);

const next = (d: string) => new Date(Date.parse(d) + 86_400_000).toISOString().slice(0, 10);
/** 8:05 am India time on the day after `day`: just after that shift's hour. */
const after8 = (day: string) => Date.parse(next(day) + 'T00:00:00Z') + 8 * 3_600_000 + 5 * 60_000 - 19_800_000;

describe('shift rollover', () => {
  it('a close by hand starts the next shift: later bills and money go there, and that shift cannot be closed before it starts', async () => {
    const s = await setupBusiness();
    const { B, counter, ok } = s;
    const { bill } = await billed(s, [['Masala Dosa', 1]]);
    const day = bill.shiftDay;
    await ok(counter.post(`${B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'cash', amount: String(bill.totalPaise / 100) }] }));
    const cash = bill.totalPaise;
    await ok(counter.post(`${B}/shifts/${day}/close`, { openingFloat: '0', counted: { loose: String(cash / 100) } }));
    expect((await ok(counter.get('/me'))).business.shiftDay).toBe(next(day));
    const late = (await billed(s, [['Masala Chai', 1]])).bill;
    expect(late.shiftDay).toBe(next(day));
    const pay = await ok(counter.post(`${B}/settlements`, { billIds: [late.id], payments: [{ mode: 'cash', amount: String(late.totalPaise / 100) }] }));
    expect(pay.bills[0].status).toBe('settled');
    const r = await counter.post(`${B}/shifts/${next(day)}/close`, { openingFloat: '0', counted: {} });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/only just started/);
  });

  it('closes by itself at 8 am, carries open work over, is counted later, and an owner can reopen it', async () => {
    const s = await setupBusiness();
    const { B, counter, owner, ok } = s;
    const paid = (await billed(s, [['Masala Dosa', 1]])).bill;
    const day = paid.shiftDay;
    await ok(counter.post(`${B}/settlements`, { billIds: [paid.id], payments: [{ mode: 'cash', amount: String(paid.totalPaise / 100) }] }));
    const open = (await billed(s, [['Butter Naan', 2]])).bill;          // printed, not paid at 8 am
    await autoCloseAll(db, after8(day));
    const row = (await q('SELECT auto, counted_at, totals FROM shift_closes WHERE business_id = ? AND shift_day = ?', s.businessId, day))[0];
    expect(row).toMatchObject({ auto: 1, counted_at: null });
    expect(JSON.parse(row.totals).carried.unpaidBills.map((b: any) => b.bill_no)).toEqual([open.billNo]);
    expect(await autoCloseAll(db, after8(day))).toBe(0);                // once only
    expect((await q("SELECT count(*) AS n FROM outbox WHERE business_id = ? AND kind = 'shift_closed'", s.businessId))[0].n).toBe(0);
    let daily = await ok(owner.get(`${B}/reports/daily-check?day=${day}`));
    expect(daily.shiftClose).toMatchObject({ countedAt: null, auto: true });

    // The carried bill is paid in the next shift.
    await ok(counter.post(`${B}/settlements`, { billIds: [open.id], payments: [{ mode: 'cash', amount: String(open.totalPaise / 100) }] }));
    const shift = await ok(counter.get(`${B}/shifts/${next(day)}`));
    expect(shift.lastClosed).toMatchObject({ shiftDay: day, countedAt: null, auto: true });

    // Counted later: the whole drawer holds both shifts' cash; what came in since is taken off.
    const all = (paid.totalPaise + open.totalPaise) / 100;
    expect((await counter.post(`${B}/shifts/${day}/count`, { openingFloat: '0', counted: { loose: String(all - 10) } })).json.error).toMatch(/reason/);
    const c = await ok(counter.post(`${B}/shifts/${day}/count`, { openingFloat: '0', counted: { loose: String(all) } }));
    expect(c).toMatchObject({ differencePaise: 0, sincePaise: open.totalPaise, expectedPaise: paid.totalPaise + open.totalPaise });
    expect((await counter.post(`${B}/shifts/${day}/count`, { openingFloat: '0', counted: {} })).status).toBe(409);
    expect((await q("SELECT count(*) AS n FROM outbox WHERE business_id = ? AND kind = 'shift_closed'", s.businessId))[0].n).toBe(1);
    daily = await ok(owner.get(`${B}/reports/daily-check?day=${day}`));
    expect(daily.shiftClose.countedAt).toBeGreaterThan(0);

    // Reopen: owner only, with a reason, kept in the log.
    expect((await counter.post(`${B}/shifts/${day}/reopen`, { reason: 'Recount' })).status).toBe(403);
    expect((await owner.post(`${B}/shifts/${day}/reopen`, {})).status).toBe(400);
    await ok(owner.post(`${B}/shifts/${day}/reopen`, { reason: 'Recount the drawer' }));
    expect(await q('SELECT 1 FROM shift_closes WHERE business_id = ? AND shift_day = ?', s.businessId, day)).toHaveLength(0);
    expect((await q("SELECT count(*) AS n FROM audit_log WHERE business_id = ? AND action = 'shift.reopen'", s.businessId))[0].n).toBe(1);
  });

  it('does not close a shift in which nothing happened', async () => {
    const s = await setupBusiness();
    const day = (await s.ok(s.owner.get('/me'))).business.shiftDay;
    await autoCloseAll(db, after8(day));
    expect(await q('SELECT 1 FROM shift_closes WHERE business_id = ?', s.businessId)).toHaveLength(0);
  });
});
