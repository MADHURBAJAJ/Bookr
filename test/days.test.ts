// Days (approved 25 Nov 2026): a day is closed when its shift is saved, every credit of it is dealt with and no bill of
// it waits. Read only. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 180_000 });

describe('Days', () => {
  it('closes a saved day once every credit is dealt with and no bill waits; unsaved days are grey; the day adds up', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610601', '31 14:00', 'UPI', '450'], ['2610602', '31 15:00', 'UPI', '300']]);
    await h.register([{ no: '2610601', amount: '450', pays: [['upi', '450']] }, { no: '2610602', amount: '300', pays: [['upi', '300']] }]);
    await h.decideRest('2026-10-31', () => 'use_register');
    await h.credits([['31 14:05', 450]]);
    const site = (await h.lines([['31 16:00', 12500, 'CR', 'NEFT/N30512345/MAKEMYTRIP INDIA PVT LTD']])).ids[0];
    await h.confirm();
    const [late] = await h.credits([['1 11:00', 300]]);
    const [stray] = await h.credits([['2 11:00', 99]]);
    const o = h.clients.owner;
    const list = async () => (await o.get(`/businesses/${h.bid}/days`)).json;
    const dayOf = (p: { days: { day: string }[] }, d: string) => p.days.find((x) => x.day === d) as Record<string, unknown>;

    // 31 Oct: saved, the MakeMyTrip payout open and bill 2610602 waiting. 1 and 2 Nov: not saved.
    let p = await list();
    expect(dayOf(p, '2026-10-31')).toMatchObject({ status: 'open', creditsOpen: 1, billsWaiting: 1 });
    expect(dayOf(p, '2026-11-01')).toMatchObject({ status: 'unsaved', creditsOpen: 1 });
    expect(p.groups.find((g: { cause: string }) => g.cause === 'site')).toMatchObject({ n: 1, paise: 1250000, days: ['2026-10-31'] });
    expect(p.groups.find((g: { cause: string }) => g.cause === 'unsaved')).toMatchObject({ n: 2 });
    expect(p.billGroups).toEqual([expect.objectContaining({ mode: 'upi', n: 1, paise: 30000 })]);

    // The day, line by line, adds up to its money in.
    const d = (await o.get(`/businesses/${h.bid}/days/2026-10-31`)).json;
    expect(d.inPaise).toBe(1295000);
    expect(d.lines.reduce((t: number, l: { paise: number }) => t + l.paise, 0)).toBe(d.inPaise);
    expect(d.lines).toEqual(expect.arrayContaining([expect.objectContaining({ label: 'Matched to bills', n: 1, paise: 45000, state: 'done' }),
      expect.objectContaining({ label: 'Booking site payouts', state: 'open', paise: 1250000 })]));
    expect(d.bills).toEqual([expect.objectContaining({ billNo: '2610602', amountPaise: 30000 })]);

    // Book the payout and match the late credit to its bill: 31 Oct closes. Nothing on Days did either.
    const booked = await o.post(`/businesses/${h.bid}/bank-rows/${site}/book`, { headId: h.fnb });
    expect(booked.status, JSON.stringify(booked.json)).toBe(200);
    const sale = (await sql`SELECT id FROM transactions WHERE bill_no = '2610602' AND type = 'income'`)[0].id;
    expect((await o.post(`/businesses/${h.bid}/bank-rows/${late}/match`, { transactionIds: [sale] })).status).toBe(200);
    p = await list();
    expect(dayOf(p, '2026-10-31')).toMatchObject({ status: 'closed', creditsOpen: 0, billsWaiting: 0 });
    expect(p.closed).toBeGreaterThanOrEqual(1);
    expect(p.groups.find((g: { cause: string }) => g.cause === 'site')).toBeUndefined();
    expect(p.groups.find((g: { cause: string }) => g.cause === 'unsaved')).toMatchObject({ n: 1, days: ['2026-11-02'] });
    expect(stray).toBeTruthy();

    // Today carries the count; only people who work the bank see Days.
    const home = (await o.get(`/businesses/${h.bid}/home`)).json;
    expect(home.days).toMatchObject({ total: p.days.length, closed: p.closed });
    expect((await h.clients.viewer.get(`/businesses/${h.bid}/days`)).status).toBe(403);
    expect((await o.get(`/businesses/${h.bid}/days/31-10-2026`)).status).toBe(400);
  });
});
