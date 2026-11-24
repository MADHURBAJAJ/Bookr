// Cash drawers (24 Nov 2026): only the person holding the drawer takes cash; a handover at any time (blind count, open
// tables passed on by name, the next cashier accepts with their PIN); a take-over when the holder has left (a manager
// confirms); the day close counts the drawer and keeps the float. All names and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { billed, Client, dispose, setupBusiness } from './helpers';

afterAll(dispose);

describe('cash drawers', () => {
  it('hands over at any time, takes over with a manager, and the day close keeps the float', async () => {
    const s = await setupBusiness();
    const { B, counter, owner, ok, mgr } = s;
    await ok(owner.call('PUT', `${B}/drawer/float`, { amount: '500' }));
    const meeraId = (await ok(owner.post(`${B}/staff`, { name: 'Meera', role: 'cashier', pin: '1122' }))).id;
    const meera = new Client();
    meera.cookies = new Map(counter.cookies);
    meera.cookies.delete('pos_session');
    await ok(meera.post('/auth/pin', { staffId: meeraId, pin: '1122' }));
    const cash = (bill: any) => ({ billIds: [bill.id], payments: [{ mode: 'cash', amount: String(bill.totalPaise / 100) }] });

    // Ravi takes the first cash: the drawer opens with the float, in his name.
    const a = (await billed(s, [['Masala Dosa', 1]])).bill;
    await ok(counter.post(`${B}/settlements`, cash(a)));
    expect((await ok(counter.get('/me'))).drawer).toMatchObject({ holder: 'Ravi' });
    // Meera can't take cash into Ravi's drawer; UPI is fine.
    const b = (await billed(s, [['Butter Naan', 2]])).bill;
    const refused = await meera.post(`${B}/settlements`, cash(b));
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: 'drawer_held', holder: 'Ravi' });
    // A manager may take cash into Ravi's drawer.
    const m = (await billed(s, [['Masala Chai', 1]])).bill;
    await ok(owner.post(`${B}/settlements`, cash(m)));

    // Handover to Meera, on her sign-in: Ravi's PIN and a blind count; T for bill b passes to her by name.
    const expected1 = 50_000 + a.totalPaise + m.totalPaise;
    const ho = (counted: number, extra = {}) => meera.post(`${B}/drawer/handover`, { toId: meeraId, fromPin: '2468', counted: { loose: String(counted / 100) }, ...extra });
    expect((await meera.post(`${B}/drawer/handover`, { toId: meeraId, fromPin: '0000', counted: {} })).status).toBe(403);
    expect((await ho(expected1 - 1000)).json).toMatchObject({ code: 'count_differs', expectedPaise: String(expected1), differencePaise: '-1000' });
    const h = await ok(ho(expected1 - 1000, { reason: 'Change given short' }));
    expect(h).toMatchObject({ from: 'Ravi', to: 'Meera', differencePaise: -1000 });
    const orders = (await ok(meera.get(`${B}/orders`))).orders;
    expect(orders.find((o: any) => o.bill?.id === b.id || o.id === b.orderId)).toMatchObject({ handedFrom: 'Ravi', heldBy: 'Meera' });

    // Meera takes the carried bill's cash; Ravi no longer can.
    await ok(meera.post(`${B}/settlements`, cash(b)));
    const c = (await billed(s, [['Masala Chai', 2]])).bill;
    expect((await counter.post(`${B}/settlements`, cash(c))).json.code).toBe('drawer_held');

    // Meera has left: Ravi takes the drawer over, a manager confirms.
    const expected2 = expected1 - 1000 + b.totalPaise;
    expect((await counter.post(`${B}/drawer/takeover`, { counted: { loose: String(expected2 / 100) } })).json.code).toBe('approval');
    await ok(counter.post(`${B}/drawer/takeover`, { counted: { loose: String(expected2 / 100) }, ...mgr }));
    await ok(counter.post(`${B}/settlements`, cash(c)));

    // The day close counts Ravi's drawer: the float stays, the rest goes to the safe; nobody holds a drawer after it.
    const day = a.shiftDay;
    const total = expected2 + c.totalPaise;
    const close = await ok(counter.post(`${B}/shifts/${day}/close`, { counted: { loose: String(total / 100) } }));
    expect(close).toMatchObject({ differencePaise: 0, safePaise: total - 50_000 });
    expect((await ok(counter.get('/me'))).drawer).toBeNull();
    const daily = await ok(owner.get(`${B}/reports/daily-check?day=${day}`));
    expect(daily.drawers.map((d: any) => [d.holder, d.closeKind, d.differencePaise])).toEqual([['Ravi', 'handover', -1000], ['Meera', 'takeover', 0], ['Ravi', 'day_close', 0]]);
  });
});
