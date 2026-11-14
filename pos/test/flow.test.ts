// The counter end to end on a real local D1: sign-in, roles, orders and KOT, bills and numbering, settle with every payment
// mode, paid together, folios, credit, advances, void, limits, tabs and shift close. All data is invented.
import { afterAll, describe, expect, it } from 'vitest';
import { billed, Client, dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('sign-in and roles', () => {
  it('needs the setup code to create a business', async () => {
    const c = new Client();
    const r = await c.call('POST', '/setup', { businessId: crypto.randomUUID(), name: 'X', ownerName: 'X', email: 'x@test.local', password: 'long-enough-pass' }, { 'X-Setup-Token': 'wrong-token-wrong-token-wrong' });
    expect(r.status).toBe(403);
  });

  it('allows PIN sign-in only on a counter device, and locks after 5 wrong PINs', async () => {
    const s = await setupBusiness();
    const elsewhere = new Client();
    expect((await elsewhere.post('/auth/pin', { staffId: s.cashierId, pin: '2468' })).status).toBe(403);

    const device = new Client();
    device.cookies.set('pos_device', s.counter.cookies.get('pos_device')!);
    for (let i = 0; i < 4; i++) expect((await device.post('/auth/pin', { staffId: s.cashierId, pin: '0000' })).status).toBe(401);
    const fifth = await device.post('/auth/pin', { staffId: s.cashierId, pin: '0000' });
    expect(fifth.json.error).toMatch(/locked/);
    expect((await device.post('/auth/pin', { staffId: s.cashierId, pin: '2468' })).status).toBe(429);
  });

  it('checks the role and the business on every request', async () => {
    const s = await setupBusiness();
    const other = await setupBusiness();
    // A cashier cannot change billing names; nobody reaches another business.
    expect((await s.counter.post(`${s.B}/entities`, { name: 'X', kind: 'other', gstRegistered: false, seriesPrefix: 'X' })).status).toBe(403);
    expect((await s.owner.get(`${other.B}/menu`)).status).toBe(404);
    // A captain takes orders but cannot print a bill.
    const captain = new Client();
    captain.cookies.set('pos_device', s.counter.cookies.get('pos_device')!);
    expect((await captain.post('/auth/pin', { staffId: s.captainId, pin: '1357' })).status).toBe(200);
    const order = (await captain.post(`${s.B}/orders`, { kind: 'table', place: 'T9' })).json.id;
    await captain.post(`${s.B}/orders/${order}/items`, { itemId: s.items['Masala Chai'], delta: 1 });
    await captain.post(`${s.B}/orders/${order}/kot`);
    expect((await captain.post(`${s.B}/orders/${order}/bill`, { entityId: s.company })).status).toBe(403);
  });

  it('ends a PIN session when its device is revoked', async () => {
    const s = await setupBusiness();
    const devices = (await s.owner.get(`${s.B}/devices`)).json.devices;
    expect((await s.counter.get('/me')).status).toBe(200);
    await s.owner.post(`${s.B}/devices/${devices[0].id}/revoke`);
    expect((await s.counter.get('/me')).status).toBe(401);
  });
});

describe('orders, KOT and bills', () => {
  it('bills only what went to the kitchen, numbers bills per billing name without gaps, and freezes them', async () => {
    const s = await setupBusiness({ huf: true });
    const order = (await s.counter.post(`${s.B}/orders`, { kind: 'table', place: 'T1' })).json.id;
    await s.counter.post(`${s.B}/orders/${order}/items`, { itemId: s.items['Masala Dosa'], delta: 2 });
    await s.counter.post(`${s.B}/orders/${order}/items`, { itemId: s.items['Beer 650 ml'], delta: 1 });
    expect((await s.counter.post(`${s.B}/orders/${order}/bill`, { entityId: s.company })).json.error).toMatch(/kitchen/);
    const kot = await s.counter.post(`${s.B}/orders/${order}/kot`);
    expect(kot.json.kots.map((k: any) => k.station).sort()).toEqual(['bar', 'kitchen']);

    const b1 = (await s.counter.post(`${s.B}/orders/${order}/bill`, { entityId: s.company })).json.bill;
    expect(b1).toMatchObject({ grossPaise: 68000, cgstPaise: 1700, sgstPaise: 1700, totalPaise: 71400, entityName: 'Sample Hotels Pvt Ltd' });
    expect(b1.billNo).toMatch(/^C-\d{4}-00001$/);
    const b2 = (await billed(s, [['Masala Chai', 1]])).bill;
    expect(b2.billNo).toMatch(/^C-\d{4}-00002$/);
    const h = (await billed(s, [['Masala Chai', 2]], { entityId: s.huf })).bill;
    expect(h.billNo).toMatch(/^H1-\d{4}-00001$/);
    expect(h).toMatchObject({ cgstPaise: 0, totalPaise: 8000 });

    await expect(q('UPDATE bills SET total_paise = 1 WHERE id = ?', b1.id)).rejects.toThrow(/bill_frozen/);
    await expect(q('DELETE FROM bill_lines WHERE bill_id = ?', b1.id)).rejects.toThrow(/bill_frozen/);
  });

  it('needs a reason for a discount and for cancelling an item already sent to the kitchen', async () => {
    const s = await setupBusiness();
    const order = (await s.counter.post(`${s.B}/orders`, { kind: 'table', place: 'T2' })).json.id;
    await s.counter.post(`${s.B}/orders/${order}/items`, { itemId: s.items['Masala Dosa'], delta: 2 });
    await s.counter.post(`${s.B}/orders/${order}/kot`);
    expect((await s.counter.post(`${s.B}/orders/${order}/items`, { itemId: s.items['Masala Dosa'], delta: -1 })).status).toBe(400);
    const cut = await s.counter.post(`${s.B}/orders/${order}/items`, { itemId: s.items['Masala Dosa'], delta: -1, reasonId: s.reasons.kot_cancel });
    expect(cut.json.cancelledSent).toBe(1);

    expect((await s.counter.post(`${s.B}/orders/${order}/bill`, { entityId: s.company, discount: { kind: 'pct', bp: 1000 } })).status).toBe(400);
    const bill = (await s.counter.post(`${s.B}/orders/${order}/bill`, { entityId: s.company, discount: { kind: 'pct', bp: 1000, reasonId: s.reasons.discount } })).json.bill;
    expect(bill).toMatchObject({ discountPaise: 1800, discountReason: 'Regular guest', totalPaise: 17000 }); // 162 + 8.10 = 170.10 → 170
    const day = bill.shiftDay;
    const events = (await s.owner.get(`${s.B}/events?day=${day}`)).json.events.map((e: any) => [e.kind, e.reason]);
    expect(events).toEqual(expect.arrayContaining([['kot_cancel', 'Guest changed mind'], ['discount', 'Regular guest']]));
  });

  it('voids a printed bill with a reason, keeps its number, and bills the order again', async () => {
    const s = await setupBusiness({ huf: true });
    const { order, bill } = await billed(s, [['Masala Dosa', 1]]);
    expect((await s.counter.post(`${s.B}/bills/${bill.id}/void`, {})).status).toBe(400);
    expect((await s.counter.post(`${s.B}/bills/${bill.id}/void`, { reasonId: s.reasons.void })).status).toBe(200);
    const again = (await s.counter.post(`${s.B}/orders/${order}/bill`, { entityId: s.huf })).json.bill;
    expect(again.billNo).toMatch(/^H1-/);
    const rows = await q('SELECT bill_no, status FROM bills WHERE order_id = ? ORDER BY printed_at', order);
    expect(rows.map((r) => r.status)).toEqual(['void', 'printed']);
    expect((await q("SELECT kind FROM outbox WHERE business_id = ? AND kind = 'bill_void'", s.businessId)).length).toBe(1);
  });

  it('stops a billing name before its yearly limit', async () => {
    const s = await setupBusiness({ huf: true });
    await s.owner.put(`${s.B}/entities/${s.huf}`, { name: 'Sample HUF 1', kind: 'huf', gstRegistered: false, seriesPrefix: 'H1', yearlyLimit: '1000', warn1: '300', warn2: '600', stopAt: '900' });
    const first = await billed(s, [['Beer 650 ml', 1]], { entityId: s.huf });
    expect(first.warning).toMatch(/Sample HUF 1 has ₹320/);
    await billed(s, [['Beer 650 ml', 1]], { entityId: s.huf });
    const order = (await s.counter.post(`${s.B}/orders`, { kind: 'table', place: 'T-limit' })).json.id;
    await s.counter.post(`${s.B}/orders/${order}/items`, { itemId: s.items['Beer 650 ml'], delta: 1 });
    await s.counter.post(`${s.B}/orders/${order}/kot`);
    const r = await s.counter.post(`${s.B}/orders/${order}/bill`, { entityId: s.huf });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/stop point/);
  });
});

describe('settle', () => {
  it('closes a bill only when payments add up, with the card slip details, and sends Bookr one message per bill', async () => {
    const s = await setupBusiness();
    const { bill } = await billed(s, [['Masala Dosa', 2], ['Butter Naan', 1]]); // 420 + 21 = 441
    const pay = (payments: unknown[]) => s.counter.post(`${s.B}/settlements`, { billIds: [bill.id], payments });
    expect((await pay([{ mode: 'cash', amount: '400' }])).json.error).toMatch(/₹41 is still to pay/);
    expect((await pay([{ mode: 'cash', amount: '241' }, { mode: 'card', amount: '200', cardApproval: '12', cardLast4: '4242' }])).json.error).toMatch(/approval code/);
    const r = await pay([{ mode: 'cash', amount: '241', tendered: '300' }, { mode: 'card', amount: '200', cardApproval: 'a1b2c3', cardLast4: '4242' }]);
    expect(r.status).toBe(201);
    expect(r.json.changePaise).toBe(5900);
    expect(r.json.bills[0].payments.map((p: any) => [p.mode, p.amountPaise])).toEqual([['cash', 24100], ['card', 20000]]);

    const msg = await q("SELECT body FROM outbox WHERE business_id = ? AND kind = 'bill_settled'", s.businessId);
    expect(msg).toHaveLength(1);
    const m = JSON.parse(msg[0].body);
    expect(m.bill).toMatchObject({ billNo: bill.billNo, totalPaise: 44100, entityName: 'Sample Hotels Pvt Ltd' });
    expect(m.payments).toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'card', cardApproval: 'A1B2C3', cardLast4: '4242', amountPaise: 20000 })]));
    expect((await pay([{ mode: 'cash', amount: '441' }])).json.error).toMatch(/already paid/);
  });

  it('pays two bills together with one UPI payment, asking first when the QR belongs to another billing name', async () => {
    const s = await setupBusiness({ huf: true });
    const a = (await billed(s, [['Masala Dosa', 1]])).bill; // 189
    const b = (await billed(s, [['Masala Chai', 2]])).bill; // 84
    const body = { billIds: [a.id, b.id], payments: [{ mode: 'upi', amount: '273', payAccountId: s.upiHuf }] };
    const first = await s.counter.post(`${s.B}/settlements`, body);
    expect(first.json.code).toBe('entity_mismatch');
    expect((await s.counter.post(`${s.B}/settlements`, { ...body, payments: [{ mode: 'upi', amount: '273', payAccountId: s.upiCompany }] })).status).toBe(201);
    const alloc = await q('SELECT b.bill_no, a.amount_paise FROM allocations a JOIN bills b ON b.id = a.bill_id WHERE a.business_id = ? ORDER BY b.bill_no', s.businessId);
    expect(alloc.map((x) => x.amount_paise)).toEqual([18900, 8400]);
    const msgs = (await q("SELECT body FROM outbox WHERE business_id = ? AND kind = 'bill_settled'", s.businessId)).map((x) => JSON.parse(x.body));
    expect(msgs.find((m) => m.billId === a.id).paidTogetherWith).toEqual([b.billNo]);
  });

  it('needs the guest name and a reason for a complimentary bill', async () => {
    const s = await setupBusiness();
    const { bill } = await billed(s, [['Masala Chai', 1]]);
    expect((await s.counter.post(`${s.B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'comp', amount: '42', reasonId: s.reasons.comp }] })).json.error).toMatch(/guest's name/);
    expect((await s.counter.post(`${s.B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'comp', amount: '42', compGuest: 'P. Rao' }] })).json.error).toMatch(/reason/);
    expect((await s.counter.post(`${s.B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'comp', amount: '42', compGuest: 'P. Rao', reasonId: s.reasons.comp }] })).status).toBe(201);
    const e = (await s.owner.get(`${s.B}/events?day=${bill.shiftDay}`)).json.events.find((x: any) => x.kind === 'comp');
    expect(e).toMatchObject({ reason: "Owner's guest", detail: 'Guest: P. Rao', byName: 'Ravi' });
  });

  it('posts to a room folio, which must be paid before check-out', async () => {
    const s = await setupBusiness();
    const stay = (await s.counter.post(`${s.B}/stays`, { room: '204', guestName: 'A. Mehra' })).json.id;
    const folio = (await s.counter.get(`${s.B}/stays`)).json.stays.find((x: any) => x.id === stay).accountId;
    const { bill } = await billed(s, [['Masala Dosa', 1]]);
    expect((await s.counter.post(`${s.B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'room', amount: '189', debtorAccountId: folio }] })).status).toBe(201);
    expect((await s.counter.get(`${s.B}/debtors/${folio}`)).json.balancePaise).toBe(18900);
    expect((await s.counter.post(`${s.B}/stays/${stay}/check-out`)).status).toBe(409);
    const r = await s.counter.post(`${s.B}/debtors/${folio}/receipts`, { kind: 'receipt', payments: [{ mode: 'upi', amount: '189', payAccountId: s.upiCompany }] });
    expect(r.json.balancePaise).toBe(0);
    expect((await s.counter.post(`${s.B}/stays/${stay}/check-out`)).status).toBe(200);
    expect((await q("SELECT kind FROM outbox WHERE business_id = ? AND kind = 'receipt'", s.businessId)).length).toBe(1);
  });

  it('creates a credit account at the counter and keeps to its limit; an advance pays a later bill', async () => {
    const s = await setupBusiness();
    const one = (await billed(s, [['Masala Dosa', 1]])).bill;
    expect((await s.counter.post(`${s.B}/settlements`, { billIds: [one.id], payments: [{ mode: 'credit', amount: '189', newCredit: { name: 'Sunrise Travels', phone: '9800000000' } }] })).status).toBe(201);
    const acc = (await s.counter.get(`${s.B}/credit-accounts`)).json.accounts[0];
    expect(acc).toMatchObject({ name: 'Sunrise Travels', balancePaise: 18900 });
    await s.owner.put(`${s.B}/credit-accounts/${acc.id}`, { name: 'Sunrise Travels', creditLimit: '200' });
    const two = (await billed(s, [['Masala Chai', 1]])).bill;
    expect((await s.counter.post(`${s.B}/settlements`, { billIds: [two.id], payments: [{ mode: 'credit', amount: '42', debtorAccountId: acc.id }] })).json.error).toMatch(/credit limit/);

    // An advance taken first, then used.
    expect((await s.counter.post(`${s.B}/debtors/${acc.id}/receipts`, { kind: 'receipt', payments: [{ mode: 'cash', amount: '500' }] })).json.error).toMatch(/owes ₹189/);
    await s.counter.post(`${s.B}/debtors/${acc.id}/receipts`, { kind: 'advance', payments: [{ mode: 'cash', amount: '500' }] });
    expect((await s.counter.post(`${s.B}/settlements`, { billIds: [two.id], payments: [{ mode: 'advance', amount: '42', debtorAccountId: acc.id }] })).status).toBe(201);
    expect((await s.counter.get(`${s.B}/debtors/${acc.id}`)).json.balancePaise).toBe(18900 - 50000 + 4200);
  });
});

describe('tabs and shift close', () => {
  it('carries tabs over, blocks the close until orders and bills are dealt with, and records the drawer', async () => {
    const s = await setupBusiness();
    const tab = (await s.counter.post(`${s.B}/orders`, { kind: 'table', place: 'Lounge', guestName: 'R. Nair' })).json.id;
    await s.counter.post(`${s.B}/orders/${tab}/items`, { itemId: s.items['Masala Chai'], delta: 3 });
    await s.counter.post(`${s.B}/orders/${tab}/kot`);
    const { bill } = await billed(s, [['Masala Dosa', 1]]);
    const day = bill.shiftDay;
    const close = (body: unknown) => s.counter.post(`${s.B}/shifts/${day}/close`, body);

    expect((await close({ openingFloat: '1000' })).json.error).toMatch(/Lounge/);
    await s.counter.post(`${s.B}/orders/${tab}/tab`, {});
    expect((await close({ openingFloat: '1000' })).json.error).toMatch(/printed but not paid/);
    await s.counter.post(`${s.B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'cash', amount: '189' }] });

    // Expected 1,000 float + 189 cash = 1,189; counted 1,180 is ₹9 short and needs a reason.
    const counted = { '500': 2, '100': 1, '50': 1, '20': 1, loose: '10' };
    expect((await close({ openingFloat: '1000', counted })).json.error).toMatch(/reason/);
    const r = await close({ openingFloat: '1000', counted, reason: 'Change given short' });
    expect(r.json).toMatchObject({ expectedPaise: 118900, countedPaise: 118000, differencePaise: -900 });
    const summary = (await s.counter.get(`${s.B}/shifts/${day}`)).json;
    expect(summary.summary.tabs[0]).toMatchObject({ guest: 'R. Nair', paise: 12000 });
    expect(JSON.parse((await q("SELECT body FROM outbox WHERE business_id = ? AND kind = 'shift_closed'", s.businessId))[0].body).tabs).toHaveLength(1);

    // Nothing more is paid into the closed shift.
    const late = (await billed(s, [['Masala Chai', 1]])).bill;
    if (late.shiftDay === day) {
      expect((await s.counter.post(`${s.B}/settlements`, { billIds: [late.id], payments: [{ mode: 'cash', amount: '42' }] })).json.error).toMatch(/closed/);
    }
  });
});
