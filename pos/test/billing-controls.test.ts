// Billing controls (21 Nov 2026): a manager's PIN above the discount limit and for a free item, a short payment or a
// refund; an item made free gives nothing back on a credit note; a payment's type corrected while its shift is open.
// All names and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { billed, dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('billing controls', () => {
  it('asks for a manager above the discount limit and for a free item, and a free item is not refunded', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok, mgr } = s;
    // Up to 10% (the default) a cashier gives alone; 15% needs a manager.
    const ten = await billed(s, [['Masala Chai', 1]], { discount: { kind: 'pct', bp: 1000, reasonId: s.reasons.discount } });
    expect(ten.bill.discountPaise).toBe(400);
    const order = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T90' }))).id;
    await ok(counter.post(`${B}/orders/${order}/items`, { itemId: s.items['Masala Dosa'], delta: 2 }));
    await ok(counter.post(`${B}/orders/${order}/items`, { itemId: s.items['Masala Chai'], delta: 1 }));
    await ok(counter.post(`${B}/orders/${order}/kot`));
    const over = await counter.post(`${B}/orders/${order}/bill`, { entityId: s.company, discount: { kind: 'pct', bp: 1500, reasonId: s.reasons.discount } });
    expect(over).toMatchObject({ status: 403, json: { code: 'approval' } });
    // The chai made free: a manager approves.
    const lines = (await ok(counter.get(`${B}/orders/${order}`))).order.lines;
    const chai = lines.find((l: any) => l.name === 'Masala Chai');
    const freeBody = { entityId: s.company, lineDiscounts: [{ lineId: chai.id, bp: 10000 }], discountReasonId: s.reasons.discount };
    expect((await counter.post(`${B}/orders/${order}/bill`, freeBody)).json.code).toBe('approval');
    const bill = (await ok(counter.post(`${B}/orders/${order}/bill`, { ...freeBody, ...mgr }))).bill;
    expect(bill).toMatchObject({ grossPaise: 40000, discountPaise: 4000, taxablePaise: 36000, cgstPaise: 900, sgstPaise: 900, totalPaise: 37800 });
    expect(bill.items.find((i: any) => i.name === 'Masala Chai').discountPaise).toBe(4000);
    const ev = (await ok(owner.get(`${B}/events?day=${bill.shiftDay}`))).events.find((e: any) => e.kind === 'discount' && e.ref === bill.billNo);
    expect(ev.detail).toBe('Items: Masala Chai free · Approved by Sample Manager');

    // Paying ₹300 of ₹378 (over 10% short) needs a manager; with one it settles.
    const short = { billIds: [bill.id], payments: [{ mode: 'cash', amount: '300' }], difference: { kind: 'discount', reasonId: s.reasons.discount } };
    expect((await counter.post(`${B}/settlements`, short)).json.code).toBe('approval');
    await ok(counter.post(`${B}/settlements`, { ...short, ...mgr }));

    // Giving money back needs a manager; the free chai gives nothing back, a dosa gives back its price with GST.
    const chaiLine = bill.items.find((i: any) => i.name === 'Masala Chai');
    const dosaLine = bill.items.find((i: any) => i.name === 'Masala Dosa');
    expect((await counter.post(`${B}/bills/${bill.id}/credit-note`, { lines: [{ lineId: dosaLine.id, qty: 1 }], reason: 'Cold', refundMode: 'cash' })).json.code).toBe('approval');
    expect((await counter.post(`${B}/bills/${bill.id}/credit-note`, { ...mgr, lines: [{ lineId: chaiLine.id, qty: 1 }], reason: 'Cold', refundMode: 'cash' })).status).toBe(409);
    const cn = (await ok(counter.post(`${B}/bills/${bill.id}/credit-note`, { ...mgr, lines: [{ lineId: dosaLine.id, qty: 1 }], reason: 'Cold', refundMode: 'cash' }))).creditNote;
    expect(cn).toMatchObject({ taxablePaise: 18000, cgstPaise: 450, sgstPaise: 450, totalPaise: 18900 });

    // The Owner raises the limit to 20%: 15% then goes through alone.
    const b = (await ok(owner.get('/me'))).business;
    await ok(owner.call('PUT', `${B}/settings`, { name: b.name, fyStartMonth: b.fy_start_month, shiftStartHour: b.shift_start_hour, tabAgeDays: b.tab_age_days, discLimitPct: 20 }));
    expect((await ok(owner.get('/me'))).business.disc_limit_bp).toBe(2000);
    const fifteen = await billed(s, [['Masala Chai', 1]], { discount: { kind: 'pct', bp: 1500, reasonId: s.reasons.discount } });
    expect(fifteen.bill.discountPaise).toBe(600);
  });

  it('changes a payment taken as the wrong type while the shift is open, with a manager', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok, mgr } = s;
    const { bill } = await billed(s, [['Masala Dosa', 1]]);
    const paid = (await ok(counter.post(`${B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'cash', amount: String(bill.totalPaise / 100) }] }))).bills[0];
    const pay = paid.payments[0];
    const change = { mode: 'upi', payAccountId: s.upiCompany, reason: 'Guest paid by UPI' };
    expect((await counter.post(`${B}/payments/${pay.id}/change`, change)).json.code).toBe('approval');
    expect((await counter.post(`${B}/payments/${pay.id}/change`, { ...mgr, mode: 'upi', reason: 'x' })).status).toBe(400);   // which QR
    await ok(counter.post(`${B}/payments/${pay.id}/change`, { ...change, ...mgr }));
    const after = (await ok(owner.get(`${B}/bills/${bill.id}`))).bill.payments[0];
    expect(after).toMatchObject({ mode: 'upi', payAccount: 'Company QR', amountPaise: bill.totalPaise });
    const sales = await ok(owner.get(`${B}/reports/sales?from=${bill.shiftDay}&to=${bill.shiftDay}`));
    expect(sales.byMode).toEqual([{ mode: 'upi', n: 1, paise: bill.totalPaise }]);
    const ev = (await ok(owner.get(`${B}/events?day=${bill.shiftDay}`))).events.find((e: any) => e.kind === 'pay_change');
    expect(ev).toMatchObject({ ref: bill.billNo, reason: 'Guest paid by UPI', detail: 'Cash → UPI (Company QR) · Approved by Sample Manager' });
    // The waiting message for Bookr carries the new type.
    const msg = JSON.parse((await q("SELECT body FROM outbox WHERE business_id = ? AND kind = 'bill_settled'", s.businessId))[0].body);
    expect(msg.payments[0]).toMatchObject({ mode: 'upi', payAccountName: 'Company QR' });
    // Once the shift is closed, nothing changes.
    await q("INSERT INTO shift_closes (id, business_id, shift_day, opening_float_paise, counted, counted_paise, expected_paise, difference_paise, totals, closed_at) VALUES ('00000000-0000-4000-8000-00000000c105', ?, ?, 0, '{}', 0, 0, 0, '{}', 1)", s.businessId, bill.shiftDay);
    expect((await owner.post(`${B}/payments/${pay.id}/change`, { mode: 'cash', reason: 'Back to cash' })).status).toBe(409);
    // A complimentary payment is never changed.
    expect((await owner.post(`${B}/payments/${pay.id}x/change`, { mode: 'cash', reason: 'x' })).status).toBe(404);
  });
});
