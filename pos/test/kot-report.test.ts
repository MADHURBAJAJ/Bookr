// Reports › KOTs (28 Nov 2026): every KOT with its dishes, categories and prices, dishes cancelled after sending (with who
// and why), the bill each ended on, and food sent but not billed. Managers and owners only. All data is invented.
import { afterAll, describe, expect, it } from 'vitest';
import { billed, dispose, setupBusiness } from './helpers';

afterAll(dispose);

describe('KOT report', () => {
  it('lists KOTs with bills, cancels and not-billed food, for managers and owners only', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    // A paid table.
    const paid = await billed(s, [['Masala Dosa', 2]]);
    await ok(counter.post(`${B}/settlements`, { billIds: [paid.bill.id], payments: [{ mode: 'cash', amount: String(paid.bill.totalPaise / 100) }] }));
    // A table where one Masala Dosa is cancelled after sending (manager's PIN), then billed and paid.
    const cx = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T9' }))).id;
    await ok(counter.post(`${B}/orders/${cx}/items`, { itemId: s.items['Masala Dosa'], delta: 2 }));
    await ok(counter.post(`${B}/orders/${cx}/kot`));
    await ok(counter.post(`${B}/orders/${cx}/items`, { itemId: s.items['Masala Dosa'], delta: -1, reasonId: s.reasons.kot_cancel, approverId: s.managerId, approverPin: '9753' }));
    // A bill voided: the table is open again. Then the order is cancelled: sent, not billed.
    const voided = await billed(s, [['Masala Dosa', 1]]);
    await ok(owner.post(`${B}/bills/${voided.bill.id}/void`, { reasonId: s.reasons.void }));
    const day0 = (await ok(owner.get('/me'))).business.shiftDay;
    expect((await ok(owner.get(`${B}/reports/kots?from=${day0}&to=${day0}`))).kots.find((k: any) => k.bill.no === voided.bill.billNo).bill.state).toBe('open');
    await ok(owner.post(`${B}/orders/${voided.order}/cancel`, { reasonId: s.reasons.kot_cancel }));

    const day = (await ok(owner.get('/me'))).business.shiftDay;
    expect((await counter.get(`${B}/reports/kots?from=${day}&to=${day}`)).status).toBe(403);
    const r = await ok(owner.get(`${B}/reports/kots?from=${day}&to=${day}`));
    const normal = r.kots.filter((k: any) => !k.cancelKot);
    expect(normal).toHaveLength(3);
    expect(r.kots.filter((k: any) => k.cancelKot)).toHaveLength(2);   // T9's dish, and the cancelled order
    const byPlace = (p: string) => normal.find((k: any) => k.place === p);
    const p = normal.find((k: any) => k.bill.state === 'paid');
    expect(p.bill.state).toBe('paid');
    expect(p.lines[0]).toMatchObject({ name: 'Masala Dosa', qty: 2, cancelledQty: 0, notBilledQty: 0 });
    expect(p.lines[0].category).toBeTruthy();
    expect(p.lines[0].pricePaise).toBeGreaterThan(0);
    const c = byPlace('T9');
    expect(c.lines[0]).toMatchObject({ qty: 2, cancelledQty: 1, cancelReason: 'Guest changed mind' });
    expect(c.bill.state).toBe('open');
    const v = normal.find((k: any) => k.bill.state === 'cancelled');
    // The order's cancel told the kitchen (a cancel KOT, with its reason): cancelled after sending, nothing left unbilled.
    expect(v.lines[0]).toMatchObject({ qty: 1, cancelledQty: 1, notBilledQty: 0, cancelReason: 'Guest changed mind' });
    expect(r.photos).toBe(true);
  });
});
