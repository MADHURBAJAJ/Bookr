// The counter end to end on a real local D1: sign-in, roles, orders and KOT, bills and numbering, settle with every payment
// mode, paid together, folios, credit, advances, void, limits, tabs and shift close. All data is invented.
import { afterAll, describe, expect, it } from 'vitest';
import { istDay } from '../../src/time';
/** Today's date as printed in bill numbers (YYMMDD, India time). */
const ymd = () => istDay(Date.now()).slice(2).replace(/-/g, '');
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
    expect(kot.json.kots.map((k: any) => k.station).sort()).toEqual(['Bar', 'Kitchen']);

    const b1 = (await s.counter.post(`${s.B}/orders/${order}/bill`, { entityId: s.company })).json.bill;
    expect(b1).toMatchObject({ grossPaise: 68000, cgstPaise: 1700, sgstPaise: 1700, totalPaise: 71400, entityName: 'Sample Hotels Pvt Ltd' });
    expect(b1.billNo).toBe(`C${ymd()}001`);
    const b2 = (await billed(s, [['Masala Chai', 1]])).bill;
    expect(b2.billNo).toBe(`C${ymd()}002`);
    const h = (await billed(s, [['Masala Chai', 2]], { entityId: s.huf })).bill;
    expect(h.billNo).toBe(`H1${ymd()}001`);
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
    // The cashier cannot cancel what the kitchen has without a manager's PIN; a wrong PIN is refused.
    expect((await s.counter.post(`${s.B}/orders/${order}/items`, { itemId: s.items['Masala Dosa'], delta: -1, reasonId: s.reasons.kot_cancel })).status).toBe(403);
    expect((await s.counter.post(`${s.B}/orders/${order}/items`, { itemId: s.items['Masala Dosa'], delta: -1, reasonId: s.reasons.kot_cancel, approverId: s.managerId, approverPin: '0000' })).status).toBe(403);
    const cut = await s.counter.post(`${s.B}/orders/${order}/items`, { itemId: s.items['Masala Dosa'], delta: -1, reasonId: s.reasons.kot_cancel, approverId: s.managerId, approverPin: '9753' });
    expect(cut.json.cancelledSent).toBe(1);

    expect((await s.counter.post(`${s.B}/orders/${order}/bill`, { entityId: s.company, discount: { kind: 'pct', bp: 1000 } })).status).toBe(400);
    const bill = (await s.counter.post(`${s.B}/orders/${order}/bill`, { entityId: s.company, discount: { kind: 'pct', bp: 1000, reasonId: s.reasons.discount } })).json.bill;
    expect(bill).toMatchObject({ discountPaise: 1800, discountReason: 'Regular guest', totalPaise: 17000 }); // 162 + 8.10 = 170.10 → 170
    const day = bill.shiftDay;
    const events = (await s.owner.get(`${s.B}/events?day=${day}`)).json.events.map((e: any) => [e.kind, e.reason]);
    expect(events).toEqual(expect.arrayContaining([['kot_cancel', 'Guest changed mind'], ['discount', 'Regular guest']]));
    expect((await s.owner.get(`${s.B}/events?day=${day}`)).json.events.find((e: any) => e.kind === 'kot_cancel').detail).toBe('Approved by Sample Manager');
  });

  it('voids a printed bill with a reason, keeps its number, and bills the order again', async () => {
    const s = await setupBusiness({ huf: true });
    const { order, bill } = await billed(s, [['Masala Dosa', 1]]);
    expect((await s.counter.post(`${s.B}/bills/${bill.id}/void`, { reasonId: s.reasons.void })).status).toBe(403); // a cashier cannot void
    expect((await s.owner.post(`${s.B}/bills/${bill.id}/void`, {})).status).toBe(400);
    expect((await s.owner.post(`${s.B}/bills/${bill.id}/void`, { reasonId: s.reasons.void })).status).toBe(200);
    const again = (await s.counter.post(`${s.B}/orders/${order}/bill`, { entityId: s.huf })).json.bill;
    expect(again.billNo).toMatch(/^H1\d{9}$/);
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

describe('money out and reports', () => {
  it('takes a paid-out and an advance refund off the cash expected at shift close', async () => {
    const s = await setupBusiness();
    const stay = (await s.counter.post(`${s.B}/stays`, { room: '305', guestName: 'K. Das' })).json.id;
    const folio = (await s.counter.get(`${s.B}/stays`)).json.stays.find((x: any) => x.id === stay).accountId;
    await s.counter.post(`${s.B}/debtors/${folio}/receipts`, { kind: 'advance', payments: [{ mode: 'cash', amount: '1000' }] });
    const { bill } = await billed(s, [['Masala Dosa', 2]]); // 378
    await s.counter.post(`${s.B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'advance', amount: '378', debtorAccountId: folio }] });
    expect((await s.counter.post(`${s.B}/stays/${stay}/check-out`)).status).toBe(409); // ₹622 of advance still held
    expect((await s.counter.post(`${s.B}/debtors/${folio}/refund`, { mode: 'cash', amount: '700' })).json.error).toMatch(/only ₹622/);
    expect((await s.counter.post(`${s.B}/debtors/${folio}/refund`, { mode: 'cash', amount: '622' })).json.balancePaise).toBe(0);
    expect((await s.counter.post(`${s.B}/stays/${stay}/check-out`)).status).toBe(200);

    expect((await s.counter.post(`${s.B}/drawer-outs`, { amount: '150' })).status).toBe(400); // needs what it was for
    expect((await s.counter.post(`${s.B}/drawer-outs`, { amount: '150', note: 'Vegetables' })).status).toBe(201);
    const sum = (await s.counter.get(`${s.B}/shifts/${bill.shiftDay}`)).json.summary;
    expect(sum).toMatchObject({ cashInPaise: 100000, cashOutPaise: 77200 });
    // 500 float + 1,000 advance − 622 refund − 150 vegetables = 728
    const r = await s.counter.post(`${s.B}/shifts/${bill.shiftDay}/close`, { openingFloat: '500', counted: { '500': 1, '200': 1, loose: '28' } });
    expect(r.json).toMatchObject({ expectedPaise: 72800, differencePaise: 0 });
    expect((await q("SELECT count(*) AS n FROM outbox WHERE business_id = ? AND kind = 'drawer_out'", s.businessId))[0].n).toBe(2);
  });

  it('reports sales by billing name with GST, by mode and by item, and who owes what', async () => {
    const s = await setupBusiness({ huf: true });
    const a = (await billed(s, [['Masala Dosa', 2], ['Butter Naan', 1]], { discount: { kind: 'pct', bp: 1000, reasonId: s.reasons.discount } })).bill;
    const b = (await billed(s, [['Beer 650 ml', 1]], { entityId: s.huf })).bill;
    await s.counter.post(`${s.B}/settlements`, { billIds: [a.id], payments: [{ mode: 'cash', amount: rupees(a.totalPaise) }] });
    await s.counter.post(`${s.B}/settlements`, { billIds: [b.id], payments: [{ mode: 'credit', amount: '320', newCredit: { name: 'Sunrise Travels' } }] });
    const day = a.shiftDay;
    expect((await s.counter.get(`${s.B}/reports/sales?from=${day}&to=${day}`)).status).toBe(403); // cashier
    const r = (await s.owner.get(`${s.B}/reports/sales?from=${day}&to=${day}`)).json;
    expect(r.byEntity.map((e: any) => [e.name, e.taxablePaise, e.cgstPaise, e.totalPaise])).toEqual([
      ['Sample Hotels Pvt Ltd', 37800, 945, a.totalPaise], ['Sample HUF 1', 32000, 0, 32000],
    ]);
    expect(r.byMode).toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'cash', paise: a.totalPaise }), expect.objectContaining({ mode: 'credit', paise: 32000 })]));
    expect(r.items[0]).toMatchObject({ name: 'Masala Dosa', qty: 2, amountPaise: 36000 });
    expect(r.discounts).toEqual([{ reason: 'Regular guest', n: 1, paise: 4200 }]);
    const d = (await s.owner.get(`${s.B}/reports/debtors`)).json.accounts.find((x: any) => x.name === 'Sunrise Travels');
    expect(d).toMatchObject({ balancePaise: 32000, d0_30: 32000, d31_60: 0 });
  });
});

const rupees = (p: number) => `${Math.floor(p / 100)}.${String(p % 100).padStart(2, '0')}`;

describe('split bills', () => {
  it('moves chosen items to a new order at the same table, each billed with its own number and GST', async () => {
    const s = await setupBusiness();
    const order = (await s.counter.post(`${s.B}/orders`, { kind: 'table', place: 'T7' })).json.id;
    await s.counter.post(`${s.B}/orders/${order}/items`, { itemId: s.items['Masala Dosa'], delta: 3 });
    await s.counter.post(`${s.B}/orders/${order}/items`, { itemId: s.items['Masala Chai'], delta: 2 });
    await s.counter.post(`${s.B}/orders/${order}/kot`);
    await s.counter.post(`${s.B}/orders/${order}/items`, { itemId: s.items['Masala Dosa'], delta: 1 }); // 4 dosas, 1 not sent yet

    expect((await s.counter.post(`${s.B}/orders/${order}/split`, { lines: [{ itemId: s.items['Masala Dosa'], qty: 4 }, { itemId: s.items['Masala Chai'], qty: 2 }] })).status).toBe(400);
    const r = await s.counter.post(`${s.B}/orders/${order}/split`, { lines: [{ itemId: s.items['Masala Dosa'], qty: 2 }, { itemId: s.items['Masala Chai'], qty: 1 }] });
    expect(r.status).toBe(201);
    const a = (await s.counter.get(`${s.B}/orders/${order}`)).json.order;
    const b = (await s.counter.get(`${s.B}/orders/${r.json.id}`)).json.order;
    expect(b.place).toBe('T7 · 2');
    expect(a.lines.map((l: any) => [l.name, l.qty, l.sentQty])).toEqual([['Masala Dosa', 2, 2], ['Masala Chai', 1, 1]]);
    expect(b.lines.map((l: any) => [l.name, l.qty, l.sentQty])).toEqual([['Masala Dosa', 2, 1], ['Masala Chai', 1, 1]]);

    // Nothing reprints for the kitchen except the dosa not sent before.
    const kot = (await s.counter.post(`${s.B}/orders/${r.json.id}/kot`)).json.kots;
    expect(kot.flatMap((k: any) => k.lines)).toEqual([{ name: 'Masala Dosa', qty: 1, options: [], pricePaise: 18000 }]);
    const billA = (await s.counter.post(`${s.B}/orders/${order}/bill`, { entityId: s.company })).json.bill;
    const billB = (await s.counter.post(`${s.B}/orders/${r.json.id}/bill`, { entityId: s.company })).json.bill;
    expect([billA.totalPaise, billB.totalPaise]).toEqual([42000, 42000]); // 400 + 5% each
    expect(billA.billNo).not.toBe(billB.billNo);
  });
});

describe('credit notes', () => {
  it('gives back chosen items then the rest, numbered in their own series, netting GST and the drawer', async () => {
    const s = await setupBusiness();
    const { bill } = await billed(s, [['Masala Dosa', 3], ['Masala Chai', 2]], { discount: { kind: 'pct', bp: 1000, reasonId: s.reasons.discount } });
    // 540 + 80 = 620, 10% off = 558, GST 27.90 → 585.90 → 586
    expect(bill.totalPaise).toBe(58600);
    const dosa = bill.items.find((i: any) => i.name === 'Masala Dosa');
    expect((await s.counter.post(`${s.B}/bills/${bill.id}/credit-note`, { full: true, reason: 'Cold food', refundMode: 'cash' })).json.error).toMatch(/not paid/);
    await s.counter.post(`${s.B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'cash', amount: '586' }] });

    expect((await s.counter.post(`${s.B}/bills/${bill.id}/credit-note`, { lines: [{ lineId: dosa.id, qty: 1 }], refundMode: 'cash' })).status).toBe(400); // reason
    const one = (await s.counter.post(`${s.B}/bills/${bill.id}/credit-note`, { lines: [{ lineId: dosa.id, qty: 1 }], reason: 'Cold food', refundMode: 'cash' })).json.creditNote;
    // 180 less its 10% share = 162, GST 8.10 → 170.10, exact to the paisa
    expect(one).toMatchObject({ cnNo: `CCN${ymd()}001`, taxablePaise: 16200, cgstPaise: 405, totalPaise: 17010 });
    expect((await s.counter.post(`${s.B}/bills/${bill.id}/credit-note`, { lines: [{ lineId: dosa.id, qty: 3 }], reason: 'x', refundMode: 'cash' })).json.error).toMatch(/more than is left/);
    const rest = (await s.counter.post(`${s.B}/bills/${bill.id}/credit-note`, { full: true, reason: 'Guest left', refundMode: 'none' })).json;
    expect(rest.creditNote.cnNo).toBe(`CCN${ymd()}002`);
    expect(rest.creditNote.totalPaise + one.totalPaise).toBe(58600); // the bill and its notes come to zero
    expect((await s.counter.post(`${s.B}/bills/${bill.id}/credit-note`, { full: true, reason: 'again', refundMode: 'none' })).json.error).toMatch(/already been given back/);

    const sum = (await s.counter.get(`${s.B}/shifts/${bill.shiftDay}`)).json.summary;
    expect(sum).toMatchObject({ cashInPaise: 58600, cashOutPaise: 17010 });
    const r = (await s.owner.get(`${s.B}/reports/sales?from=${bill.shiftDay}&to=${bill.shiftDay}`)).json;
    expect(r.creditNotes[0]).toMatchObject({ n: 2, totalPaise: 58600, cgstPaise: 1395 });
    expect((await q("SELECT body FROM outbox WHERE business_id = ? AND kind = 'credit_note'", s.businessId)).map((x) => JSON.parse(x.body).cnNo)).toEqual([one.cnNo, rest.creditNote.cnNo]);
    await expect(q('UPDATE credit_notes SET total_paise = 1 WHERE business_id = ?', s.businessId)).rejects.toThrow(/credit_note_frozen/);
  });

  it('credits a folio or credit account instead of paying out', async () => {
    const s = await setupBusiness();
    const { bill } = await billed(s, [['Masala Chai', 1]]);
    await s.counter.post(`${s.B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'credit', amount: '42', newCredit: { name: 'Sunrise Travels' } }] });
    const acc = (await s.counter.get(`${s.B}/credit-accounts`)).json.accounts[0];
    await s.counter.post(`${s.B}/bills/${bill.id}/credit-note`, { full: true, reason: 'Wrong order', refundMode: 'account', debtorAccountId: acc.id });
    expect((await s.counter.get(`${s.B}/debtors/${acc.id}`)).json.balancePaise).toBe(0);
  });
});

describe('bar stock', () => {
  it('receives, transfers, takes sales by recipe, records breakage and count variance, and reports it', async () => {
    const s = await setupBusiness();
    const B = s.B;
    const ok = s.ok;
    const main = (await ok(s.owner.post(`${B}/stock/stores`, { name: 'Main store', kind: 'main' }))).id;
    const bar = (await ok(s.owner.post(`${B}/stock/stores`, { name: 'Bar', kind: 'bar' }))).id;
    const whisky = (await ok(s.owner.post(`${B}/stock/items`, { name: 'Sample Whisky', unit: 'ml', packName: 'bottle', packSize: 750, costPerPack: '1800', reorderLevel: 750 }))).id;
    const beer = (await ok(s.owner.post(`${B}/stock/items`, { name: 'Sample Beer 650 ml', unit: 'pcs', packName: 'case', packSize: 12, costPerPack: '1800' }))).id;
    const peg = (await ok(s.owner.post(`${B}/menu`, { name: 'Whisky 30 ml', price: '220', station: 'bar' }))).id;
    s.items['Whisky 30 ml'] = peg;
    await ok(s.owner.put(`${B}/stock/recipes/${peg}`, { lines: [{ stockItemId: whisky, qty: 30 }] }));
    await ok(s.owner.put(`${B}/stock/recipes/${s.items['Beer 650 ml']}`, { lines: [{ stockItemId: beer, qty: 1 }] }));
    expect((await s.counter.post(`${B}/stock/items`, { name: 'X', unit: 'ml', packSize: 1 })).status).toBe(403); // cashier

    await ok(s.owner.post(`${B}/stock/purchases`, { storeId: main, vendor: 'Sample Wines', invoiceNo: 'INV-1', lines: [{ itemId: whisky, packs: 2, costPerPack: '1800' }, { itemId: beer, packs: 1 }] }));
    expect((await s.owner.post(`${B}/stock/transfers`, { fromStoreId: main, toStoreId: bar, lines: [{ itemId: whisky, qty: 2000 }] })).json.error).toMatch(/only 1500 ml/);
    await ok(s.owner.post(`${B}/stock/transfers`, { fromStoreId: main, toStoreId: bar, lines: [{ itemId: whisky, qty: 1500 }, { itemId: beer, qty: 12 }] }));

    // 3 pegs and 2 beers sold; a voided bill takes nothing.
    const { bill } = await billed(s, [['Whisky 30 ml', 3], ['Beer 650 ml', 2]]);
    await s.counter.post(`${B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'cash', amount: rupees(bill.totalPaise) }] });
    const voided = (await billed(s, [['Whisky 30 ml', 1]])).bill;
    await s.owner.post(`${B}/bills/${voided.id}/void`, { reasonId: s.reasons.void });

    await ok(s.owner.post(`${B}/stock/waste`, { storeId: bar, itemId: whisky, qty: 30, reason: 'Spilt' }));
    const count = (await ok(s.owner.post(`${B}/stock/counts`, { storeId: bar, lines: [{ itemId: whisky, counted: 1350 }, { itemId: beer, counted: 10 }] }))).lines;
    expect(count.map((l: any) => [l.name, l.book, l.counted, l.variance])).toEqual([['Sample Whisky', 1380, 1350, -30], ['Sample Beer 650 ml', 10, 10, 0]]);
    expect(count[0].valuePaise).toBe(-7200); // 30 ml of a ₹1,800 bottle

    const day = bill.shiftDay;
    const r = (await ok(s.owner.get(`${B}/stock/report?from=${day}&to=${day}&storeId=${bar}`))).items;
    expect(r.find((x: any) => x.name === 'Sample Whisky')).toMatchObject({ opening: 0, transferIn: 1500, sold: 90, waste: 30, variance: -30, closing: 1350 });
    expect(r.find((x: any) => x.name === 'Sample Beer 650 ml')).toMatchObject({ transferIn: 12, sold: 2, closing: 10 });
    // Bar cost: 3 pegs (₹660) + 2 beers (₹640) sold; recipes used 90 ml whisky (₹216) + 2 beers (₹300); 30 ml spilt and 30 ml missing (₹72 each).
    const cost = (await ok(s.owner.get(`${B}/stock/report?from=${day}&to=${day}&storeId=${bar}`))).cost;
    expect(cost).toEqual({ salesPaise: 130000, expectedCostPaise: 51600, wastePaise: 7200, missingPaise: 7200, actualCostPaise: 66000 });
    expect((await ok(s.owner.get(`${B}/stock/report?from=${day}&to=${day}&storeId=${main}`))).cost).toBeNull();
    const onHand = (await ok(s.owner.get(`${B}/stock`))).items.find((x: any) => x.name === 'Sample Whisky');
    expect(onHand).toMatchObject({ total: 1350, low: false, valuePaise: 324000 });
    const kinds = (await s.owner.get(`${B}/events?day=${day}`)).json.events.map((e: any) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['stock_waste', 'stock_count']));
    await expect(q('UPDATE stock_moves SET qty = 1 WHERE business_id = ?', s.businessId)).rejects.toThrow(/stock_move_frozen/);
  });
});

describe('paid less or more than the bill', () => {
  it('marks a shortfall as a discount with a reason, and an extra as a tip on that payment', async () => {
    const s = await setupBusiness();
    const { bill } = await billed(s, [['Masala Dosa', 2], ['Butter Naan', 1]]); // 441
    const pay = (body: Record<string, unknown>) => s.counter.post(`${s.B}/settlements`, { billIds: [bill.id], ...body });
    // ₹440 by UPI: ₹1 short.
    expect((await pay({ payments: [{ mode: 'upi', amount: '440', payAccountId: s.upiCompany }] })).json.error).toMatch(/mark it as a discount/);
    expect((await pay({ payments: [{ mode: 'upi', amount: '440', payAccountId: s.upiCompany }], difference: { kind: 'discount' } })).json.error).toMatch(/reason/);
    const r = await pay({ payments: [{ mode: 'upi', amount: '440', payAccountId: s.upiCompany }], difference: { kind: 'discount', reasonId: s.reasons.discount } });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ discountPaise: 100, tipPaise: 0 });
    expect(r.json.bills[0].differences).toEqual([{ kind: 'discount', amountPaise: 100, reason: 'Regular guest', mode: null }]);
    expect(r.json.bills[0].totalPaise).toBe(44100); // the printed bill and its GST do not change
    const msg = JSON.parse((await q("SELECT body FROM outbox WHERE business_id = ? AND kind = 'bill_settled'", s.businessId))[0].body);
    expect(msg).toMatchObject({ discountAtPaymentPaise: 100, discountAtPaymentReason: 'Regular guest' });

    // ₹500 on the card for a ₹189 bill: ₹311 tip... and a tip cannot ride on a room payment.
    const two = (await billed(s, [['Masala Dosa', 1]])).bill;
    expect((await s.counter.post(`${s.B}/settlements`, { billIds: [two.id], payments: [{ mode: 'card', amount: '200', cardApproval: 'AB12CD', cardLast4: '9999' }] })).json.error).toMatch(/Mark it as a tip/);
    const t = await s.counter.post(`${s.B}/settlements`, { billIds: [two.id], payments: [{ mode: 'card', amount: '200', cardApproval: 'AB12CD', cardLast4: '9999' }], difference: { kind: 'tip' } });
    expect(t.json).toMatchObject({ tipPaise: 1100 });
    expect(t.json.bills[0].payments[0]).toMatchObject({ mode: 'card', amountPaise: 18900 });
    const sum = (await s.counter.get(`${s.B}/shifts/${bill.shiftDay}`)).json.summary;
    expect(sum.tips).toEqual([{ mode: 'card', n: 1, paise: 1100 }]);
    expect(sum.discountsAtPayment).toEqual({ n: 1, paise: 100 });
    const stay = (await s.counter.post(`${s.B}/stays`, { room: '9', guestName: 'T. Guest' })).json.id;
    const folio = (await s.counter.get(`${s.B}/stays`)).json.stays.find((x: any) => x.id === stay).accountId;
    const three = (await billed(s, [['Masala Chai', 1]])).bill;
    expect((await s.counter.post(`${s.B}/settlements`, { billIds: [three.id], payments: [{ mode: 'room', amount: '50', debtorAccountId: folio }], difference: { kind: 'tip' } })).json.error).toMatch(/cash, UPI or card/);
  });
});

describe('tables list', () => {
  it('shows recent tables until a list is saved, then the list in its order; only a manager or owner may change it', async () => {
    const s = await setupBusiness();
    await s.counter.post(`${s.B}/orders`, { kind: 'table', place: 'T10' });
    let r = (await s.counter.get(`${s.B}/orders`)).json;
    expect(r.tables).toEqual(['T10']);
    expect(r.tablesFixed).toBe(false);

    expect((await s.counter.call('PUT', `${s.B}/tables`, { tables: ['T1'] })).status).toBe(403);
    expect((await s.owner.call('PUT', `${s.B}/tables`, { tables: ['T1', 't1'] })).json.error).toMatch(/twice/);
    expect((await s.owner.call('PUT', `${s.B}/tables`, { tables: ['Lawn 1', ' T2 ', 'T1'] })).status).toBe(200);
    r = (await s.counter.get(`${s.B}/orders`)).json;
    expect(r.tables).toEqual(['Lawn 1', 'T2', 'T1']);
    expect(r.tablesFixed).toBe(true);

    // An empty list goes back to recent tables.
    await s.owner.call('PUT', `${s.B}/tables`, { tables: [] });
    expect((await s.counter.get(`${s.B}/orders`)).json.tablesFixed).toBe(false);
  });
});

describe('sales insights and menu mix', () => {
  it('splits net sales by hour, service type and order taker, counts covers, and shows the menu mix and what did not sell', async () => {
    const s = await setupBusiness();
    const { B, counter, ok } = s;
    // A table of 4 and a takeaway, then one voided bill that must not count as sales.
    const t = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T1', covers: 4 }))).id;
    await ok(counter.post(`${B}/orders/${t}/items`, { itemId: s.items['Masala Dosa'], delta: 2 }));
    await ok(counter.post(`${B}/orders/${t}/items`, { itemId: s.items['Beer 650 ml'], delta: 1 }));
    await ok(counter.post(`${B}/orders/${t}/kot`));
    const tb = (await ok(counter.post(`${B}/orders/${t}/bill`, { entityId: s.company }))).bill;
    const k = (await ok(counter.post(`${B}/orders`, { kind: 'takeaway' }))).id;
    await ok(counter.post(`${B}/orders/${k}/items`, { itemId: s.items['Butter Naan'], delta: 3 }));
    await ok(counter.post(`${B}/orders/${k}/kot`));
    await ok(counter.post(`${B}/orders/${k}/bill`, { entityId: s.company }));
    const v = await billed(s, [['Masala Dosa', 1]]);
    await ok(s.owner.post(`${B}/bills/${v.bill.id}/void`, { reasonId: s.reasons.void }));

    const day = tb.shiftDay;
    expect((await counter.get(`${B}/reports/insights?from=${day}&to=${day}`)).status).toBe(403); // cashier
    const r = (await s.owner.get(`${B}/reports/insights?from=${day}&to=${day}`)).json;

    const table = r.byService.find((x: any) => x.kind === 'table');
    expect(table).toMatchObject({ bills: 1, netPaise: 68000, covers: 4, coveredNetPaise: 68000, placeDays: 1 });
    expect(r.byService.find((x: any) => x.kind === 'takeaway')).toMatchObject({ bills: 1, netPaise: 18000 });
    // By KOT time: every KOT of the day counts (the voided bill's food still went to the kitchen).
    const sent = (st: string, k: 'items' | 'valuePaise') => r.byHour.filter((h: any) => h.station === st).reduce((n: number, h: any) => n + h[k], 0);
    expect(sent('kitchen', 'items')).toBe(6);
    expect(sent('kitchen', 'valuePaise')).toBe(2 * 18000 + 3 * 6000 + 18000);
    expect(sent('bar', 'items')).toBe(1);
    expect(r.byHour.every((h: any) => h.hour >= 0 && h.hour < 24)).toBe(true);
    expect(r.coversByHour.reduce((n: number, h: any) => n + h.covers, 0)).toBe(4);

    const taker = r.byStaff[0];
    expect(taker).toMatchObject({ bills: 2, netPaise: 86000, voids: 1 });

    const bar = r.mix.find((m: any) => m.station === 'bar');
    expect(bar).toMatchObject({ qty: 1, amountPaise: 32000 });
    expect(r.mix.filter((m: any) => m.station === 'kitchen').reduce((n: number, m: any) => n + m.amountPaise, 0)).toBe(54000);
    expect(r.items[0]).toMatchObject({ name: 'Masala Dosa', qty: 2, amountPaise: 36000 });
    expect(r.notSold).toEqual([{ name: 'Masala Chai', category: 'Food', station: 'kitchen' }]);
  });
});

describe('daily check and GSTR-1', () => {
  it('lists the day, every unpaid order holding sent food, and breaks in a bill-number series', async () => {
    const s = await setupBusiness();
    const { B, counter, owner, ok } = s;
    const paid = (await billed(s, [['Masala Dosa', 2]])).bill;
    await ok(counter.post(`${B}/settlements`, { billIds: [paid.id], payments: [{ mode: 'cash', amount: rupees(paid.totalPaise) }] }));
    const voided = (await billed(s, [['Butter Naan', 1]], {}, 'T7')).bill;
    await ok(owner.post(`${B}/bills/${voided.id}/void`, { reasonId: s.reasons.void })); // T7 reopens, its naan not paid for
    const open = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T8' }))).id;
    await ok(counter.post(`${B}/orders/${open}/items`, { itemId: s.items['Beer 650 ml'], delta: 1 }));
    await ok(counter.post(`${B}/orders/${open}/kot`));
    const notSent = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T9' }))).id;
    await ok(counter.post(`${B}/orders/${notSent}/items`, { itemId: s.items['Masala Chai'], delta: 1 })); // never sent: not listed

    const day = paid.shiftDay;
    expect((await counter.get(`${B}/reports/daily-check?day=${day}`)).status).toBe(403); // cashier
    let r = (await owner.get(`${B}/reports/daily-check?day=${day}`)).json;
    expect(r.sales).toMatchObject({ bills: 1, netPaise: 36000, voids: 1 });
    expect(r.events.void).toEqual({ n: 1, paise: voided.totalPaise });
    expect(r.unpaid.map((o: any) => [o.place, o.sentPaise, o.voided])).toEqual([['T7', 6000, true], ['T8', 32000, false]]);
    expect(r.series).toEqual([{ name: expect.any(String), prefix: 'C', count: 2, last: 2, lastNo: `C${ymd()}002`, missing: [] }]);
    expect(r.shiftClose).toBeNull();

    // A bill number that skips one shows as missing.
    await q(`INSERT INTO bills (id, business_id, order_id, entity_id, fy, seq, bill_no, shift_day, printed_at, printed_by, gross_paise, discount_paise, taxable_paise, gst_rate_bp, cgst_paise, sgst_paise, round_off_paise, total_paise, status, print_day, day_seq)
      SELECT 'gap-bill', business_id, order_id, entity_id, fy, 4, 'C' || ? || '004', shift_day, printed_at, printed_by, gross_paise, 0, taxable_paise, gst_rate_bp, cgst_paise, sgst_paise, round_off_paise, total_paise, 'settled', print_day, 4 FROM bills WHERE id = ?`, ymd(), paid.id);
    r = (await owner.get(`${B}/reports/daily-check?day=${day}`)).json;
    // Named as it would have been printed: the day's third bill, and the year's third.
    expect(r.series[0]).toMatchObject({ count: 3, last: 4, lastNo: `C${ymd()}004`, missing: [`C${ymd()}003`, `bill 3 of ${r.fy}`] });
  });

  it('gives B2C sales by rate net of credit notes, the SAC summary and the document summary for the month', async () => {
    const s = await setupBusiness();
    const { B, counter, owner, ok } = s;
    const a = (await billed(s, [['Masala Dosa', 2]])).bill; // ₹360 + 5%
    await ok(counter.post(`${B}/settlements`, { billIds: [a.id], payments: [{ mode: 'cash', amount: rupees(a.totalPaise) }] }));
    const v = (await billed(s, [['Butter Naan', 1]])).bill;
    await ok(owner.post(`${B}/bills/${v.id}/void`, { reasonId: s.reasons.void }));
    const dosa = a.items.find((i: any) => i.name === 'Masala Dosa');
    await ok(counter.post(`${B}/bills/${a.id}/credit-note`, { lines: [{ lineId: dosa.id, qty: 1 }], reason: 'Cold food', refundMode: 'cash' }));

    const month = new Date(a.printedAt + 19_800_000).toISOString().slice(0, 7);
    expect((await owner.get(`${B}/reports/gstr1?month=2026-13`)).status).toBe(400);
    const r = (await owner.get(`${B}/reports/gstr1?month=${month}`)).json;
    expect(r.entities).toHaveLength(1);
    const e = r.entities[0];
    expect(e.registered).toBe(true);
    expect(e.b2cs).toEqual([{ ratePct: 5, taxablePaise: 18000, cgstPaise: 450, sgstPaise: 450 }]); // 36000 - 18000; 900 - 450 each
    expect(e.sac).toEqual([{ sac: '996332', ratePct: 5, qty: 2, taxablePaise: 36000, cgstPaise: 900, sgstPaise: 900 }]);
    expect(e.invoices).toMatchObject({ total: 2, cancelled: 1 });
    expect(e.creditNotes).toMatchObject({ total: 1, cancelled: 0 });
  });
});

describe('bar handovers', () => {
  it('shows each bar count with what went missing since the one before, and who billed bar items in between', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    const bar = (await ok(owner.post(`${B}/stock/stores`, { name: 'Bar', kind: 'bar' }))).id;
    const whisky = (await ok(owner.post(`${B}/stock/items`, { name: 'Sample Whisky', unit: 'ml', packName: 'bottle', packSize: 750, costPerPack: '1500' }))).id; // ₹2 a ml
    const peg = (await ok(owner.post(`${B}/menu`, { name: 'Whisky 30 ml', price: '200', station: 'bar' }))).id;
    s.items['Whisky 30 ml'] = peg;
    await ok(owner.put(`${B}/stock/recipes/${peg}`, { lines: [{ stockItemId: whisky, qty: 30 }] }));
    await ok(owner.post(`${B}/stock/purchases`, { storeId: bar, vendor: 'Sample Wines', lines: [{ itemId: whisky, packs: 1 }] }));

    // Opening count agrees; the cashier then sells 3 pegs; 30 ml is spilt; the closing count finds 30 ml more missing.
    await ok(owner.post(`${B}/stock/counts`, { storeId: bar, lines: [{ itemId: whisky, counted: 750 }] }));
    const { bill } = await billed(s, [['Whisky 30 ml', 3]]);
    await ok(counter.post(`${B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'cash', amount: rupees(bill.totalPaise) }] }));
    await ok(owner.post(`${B}/stock/waste`, { storeId: bar, itemId: whisky, qty: 30, reason: 'Spilt' }));
    await ok(owner.post(`${B}/stock/counts`, { storeId: bar, lines: [{ itemId: whisky, counted: 600 }] })); // book 630

    const day = bill.shiftDay;
    const h = (await ok(owner.get(`${B}/stock/handovers?from=${day}&to=${day}&storeId=${bar}`))).counts;
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ missingPaise: 6000, extraPaise: 0, wastePaise: 6000, detail: '1 item counted, 1 differ' });
    expect(h[0].billedBy).toEqual([{ name: expect.any(String), paise: 60000 }]);
    expect(h[1]).toMatchObject({ missingPaise: 0, detail: '1 item counted, all agree', sinceAt: null });

    const d = (await ok(owner.get(`${B}/reports/daily-check?day=${day}`)));
    expect(d.bar).toEqual({ counts: 2, missingPaise: 6000, extraPaise: 0, breakagePaise: 6000 });
    expect(d.events.stock_count).toEqual({ n: 1, paise: -6000 }); // the summaries are not counted as exceptions
  });
});

describe('liquor without GST', () => {
  it('bills liquor on the same bill with no GST, keeps it apart in credit notes, and puts it in GSTR-1 Table 8', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.put(`${B}/menu/${s.items['Beer 650 ml']}`, { name: 'Beer 650 ml', price: '320', station: 'bar', tax: 'none' }));
    expect((await owner.put(`${B}/menu/${s.items['Beer 650 ml']}`, { name: 'Beer 650 ml', price: '320', station: 'bar', tax: 'vat' })).status).toBe(400);

    const { bill } = await billed(s, [['Masala Dosa', 2], ['Beer 650 ml', 1]]);
    // Food ₹360 + 5% = ₹378; beer ₹320 with no tax: ₹698.
    expect(bill).toMatchObject({ grossPaise: 68000, taxablePaise: 36000, nonGstPaise: 32000, cgstPaise: 900, sgstPaise: 900, totalPaise: 69800 });
    expect(bill.items.find((i: any) => i.name === 'Beer 650 ml').taxed).toBe(0);
    await ok(counter.post(`${B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'cash', amount: rupees(bill.totalPaise) }] }));

    const month = new Date(bill.printedAt + 19_800_000).toISOString().slice(0, 7);
    const g = (await ok(owner.get(`${B}/reports/gstr1?month=${month}`))).entities[0];
    expect(g.b2cs).toEqual([{ ratePct: 5, taxablePaise: 36000, cgstPaise: 900, sgstPaise: 900 }]);
    expect(g.sac).toEqual([{ sac: '996332', ratePct: 5, qty: 2, taxablePaise: 36000, cgstPaise: 900, sgstPaise: 900 }]);
    expect(g.nonGstPaise).toBe(32000);
    const day = (await ok(owner.get(`${B}/reports/daily-check?day=${bill.shiftDay}`))).sales;
    expect(day.netPaise).toBe(68000); // net sales include liquor

    // Money back on the beer: no GST in the credit note.
    const beer = bill.items.find((i: any) => i.name === 'Beer 650 ml');
    const cn = (await ok(counter.post(`${B}/bills/${bill.id}/credit-note`, { lines: [{ lineId: beer.id, qty: 1 }], reason: 'Flat beer', refundMode: 'cash' }))).creditNote;
    expect(cn).toMatchObject({ taxablePaise: 0, nonGstPaise: 32000, cgstPaise: 0, totalPaise: 32000 });
    await expect(q('UPDATE bills SET nongst_paise = 0 WHERE id = ?', bill.id)).rejects.toThrow(/bill_frozen/);
  });
});

describe('menu v2: add-ons, price at billing, GST by category and item', () => {
  it('takes choices and add-ons into one priced line, merges the same choices, and shows them on the KOT and bill', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    const burger = (await ok(owner.post(`${B}/menu`, { name: 'Veg Burger', category: 'Continental', price: '249' }))).id;
    const fries = (await ok(owner.post(`${B}/addon-groups`, { name: 'Peri Peri Fries', kind: 'any', options: [{ name: 'Peri Peri Fries', price: '30' }] }))).id;
    const cheese = (await ok(owner.post(`${B}/addon-groups`, { name: 'Extra Cheese', kind: 'any', options: [{ name: 'Extra Cheese', price: '50' }] }))).id;
    const size = (await ok(owner.post(`${B}/addon-groups`, { name: 'Size', kind: 'one', options: [{ name: 'Half', price: '0' }, { name: 'Full', price: '150' }] }))).id;
    expect((await owner.post(`${B}/addon-groups`, { name: 'Size', kind: 'one', options: [{ name: 'A' }, { name: 'B' }] })).status).toBe(409);
    expect((await counter.post(`${B}/addon-groups`, { name: 'X', kind: 'any', options: [{ name: 'X' }] })).status).toBe(403); // cashier
    await ok(owner.put(`${B}/menu/${burger}`, { name: 'Veg Burger', category: 'Continental', price: '249', addonGroups: [fries, cheese] }));
    const tandoori = (await ok(owner.post(`${B}/menu`, { name: 'Tandoori Chicken', category: 'Tandoor', price: '299', addonGroups: [size] }))).id;
    const menu = (await ok(counter.get(`${B}/menu`)));
    const opt = (g: string, n: string) => menu.addonGroups.find((x: any) => x.id === g).options.find((o: any) => o.name === n).id;
    expect(menu.items.find((i: any) => i.id === burger).addonGroups).toEqual([fries, cheese]);

    const o = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T1' }))).id;
    const add = (body: object) => counter.post(`${B}/orders/${o}/items`, { delta: 1, ...body });
    expect((await add({ itemId: tandoori })).json.error).toMatch(/Choose one Size/);
    expect((await add({ itemId: burger, options: [opt(size, 'Full')] })).json.error).toMatch(/not offered/);
    await ok(add({ itemId: burger, options: [opt(fries, 'Peri Peri Fries'), opt(cheese, 'Extra Cheese')] }));
    await ok(add({ itemId: burger, options: [opt(cheese, 'Extra Cheese'), opt(fries, 'Peri Peri Fries')] })); // same choices, other order: same line
    await ok(add({ itemId: burger }));
    let order = (await ok(add({ itemId: tandoori, options: [opt(size, 'Full')] }))).order;
    expect(order.lines.map((l: any) => [l.name, l.qty, l.pricePaise, l.options.map((x: any) => x.name)])).toEqual([
      ['Veg Burger', 2, 32900, ['Peri Peri Fries', 'Extra Cheese']],
      ['Veg Burger', 1, 24900, []],
      ['Tandoori Chicken', 1, 44900, ['Full']],
    ]);
    // Taking one off a line goes by the line.
    order = (await ok(counter.post(`${B}/orders/${o}/items`, { lineId: order.lines[0].id, delta: -1 }))).order;
    expect(order.lines[0].qty).toBe(1);
    const kots = (await ok(counter.post(`${B}/orders/${o}/kot`))).kots;
    expect(kots[0].lines[0]).toEqual({ name: 'Veg Burger', qty: 1, options: ['Peri Peri Fries', 'Extra Cheese'], pricePaise: 32900 });
    const bill = (await ok(counter.post(`${B}/orders/${o}/bill`, { entityId: s.company }))).bill;
    expect(bill.items.map((i: any) => [i.name, i.amountPaise, i.options.map((x: any) => x.name)])).toEqual([
      ['Veg Burger', 32900, ['Peri Peri Fries', 'Extra Cheese']], ['Veg Burger', 24900, []], ['Tandoori Chicken', 44900, ['Full']]]);
    expect(bill.grossPaise).toBe(102700);
  });

  it('takes a typed price for a price-at-billing item, never below its lowest price, and lists it on the Daily check', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    const bottle = (await ok(owner.post(`${B}/menu`, { name: 'Sample Whisky Bottle', category: 'Bar Bottles', station: 'bar', openPrice: true, minPrice: '3000', taxMode: 'liquor' }))).id;
    const o = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'Bar 1' }))).id;
    const add = (price?: string) => counter.post(`${B}/orders/${o}/items`, { itemId: bottle, delta: 1, price });
    expect((await add()).json.error).toMatch(/amount in rupees/);
    expect((await add('2500')).json.error).toMatch(/cannot be less than ₹3,000/);
    await ok(add('3500'));
    const order = (await ok(add('3200'))).order;
    expect(order.lines.map((l: any) => [l.pricePaise, l.typedPrice])).toEqual([[350000, true], [320000, true]]);
    await ok(counter.post(`${B}/orders/${o}/kot`));
    const bill = (await ok(counter.post(`${B}/orders/${o}/bill`, { entityId: s.company }))).bill;
    expect(bill).toMatchObject({ taxablePaise: 0, nonGstPaise: 670000, cgstPaise: 0, totalPaise: 670000 });
    const d = await ok(owner.get(`${B}/reports/daily-check?day=${bill.shiftDay}`));
    expect(d.typedPrices.map((x: any) => [x.name, x.pricePaise, x.minPricePaise])).toEqual([['Sample Whisky Bottle', 350000, 300000], ['Sample Whisky Bottle', 320000, 300000]]);
    expect(d.typedPrices[0].byName).toBeTruthy();
  });

  it('taxes by item, then category, then billing name; keeps rates apart on the bill, credit notes and GSTR-1', async () => {
    const s = await setupBusiness({ huf: true });
    const { B, owner, counter, ok } = s;
    const mk = async (name: string, category: string, price: string, tax: object = {}) => (await ok(owner.post(`${B}/menu`, { name, category, price, ...tax }))).id;
    const dosa = await mk('Test Dosa', 'South Indian', '100');
    const pool = await mk('Pool Table', 'Games', '200');
    const beer = await mk('Test Beer', 'Bar', '300');
    const cig = await mk('Test Cigarette', 'Smokes', '50', { taxMode: 'none' });
    const tonic = await mk('Test Tonic', 'Bar', '80', { taxMode: 'billing' }); // in the bar's category, but taxed like food
    const cats = (await ok(owner.get(`${B}/menu`))).categories;
    const cat = (n: string) => cats.find((k: any) => k.name === n).id;
    await ok(owner.put(`${B}/menu-categories/${cat('Games')}`, { taxMode: 'rate', gstRate: 18 }));
    await ok(owner.put(`${B}/menu-categories/${cat('Bar')}`, { taxMode: 'liquor' }));
    expect((await owner.put(`${B}/menu-categories/${cat('Bar')}`, { taxMode: 'rate', gstRate: 7 })).status).toBe(400);

    const o = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T2' }))).id;
    for (const id of [dosa, pool, beer, cig, tonic]) await ok(counter.post(`${B}/orders/${o}/items`, { itemId: id, delta: 1 }));
    await ok(counter.post(`${B}/orders/${o}/kot`));
    const bill = (await ok(counter.post(`${B}/orders/${o}/bill`, { entityId: s.company }))).bill;
    expect(bill.taxes).toEqual([
      { kind: 'gst', bp: 500, valuePaise: 18000, cgstPaise: 450, sgstPaise: 450 },
      { kind: 'gst', bp: 1800, valuePaise: 20000, cgstPaise: 1800, sgstPaise: 1800 },
      { kind: 'liquor', bp: 0, valuePaise: 30000, cgstPaise: 0, sgstPaise: 0 },
      { kind: 'exempt', bp: 0, valuePaise: 5000, cgstPaise: 0, sgstPaise: 0 },
    ]);
    expect(bill).toMatchObject({ taxablePaise: 38000, nonGstPaise: 35000, cgstPaise: 2250, sgstPaise: 2250, totalPaise: 77500 });
    await ok(counter.post(`${B}/settlements`, { billIds: [bill.id], payments: [{ mode: 'cash', amount: rupees(bill.totalPaise) }] }));
    // Money back on the pool table: its own 18%.
    const poolLine = bill.items.find((i: any) => i.name === 'Pool Table');
    expect(poolLine).toMatchObject({ taxKind: 'gst', gstBp: 1800 });
    const cn = (await ok(counter.post(`${B}/bills/${bill.id}/credit-note`, { lines: [{ lineId: poolLine.id, qty: 1 }], reason: 'Table broken', refundMode: 'cash' }))).creditNote;
    expect(cn).toMatchObject({ taxablePaise: 20000, cgstPaise: 1800, sgstPaise: 1800, totalPaise: 23600 });

    const month = new Date(bill.printedAt + 19_800_000).toISOString().slice(0, 7);
    const g = (await ok(owner.get(`${B}/reports/gstr1?month=${month}`))).entities.find((e: any) => e.registered);
    expect(g.b2cs).toEqual([{ ratePct: 5, taxablePaise: 18000, cgstPaise: 450, sgstPaise: 450 }]); // 18% netted to nothing by the credit note
    expect(g).toMatchObject({ nonGstPaise: 30000, exemptPaise: 5000 });
    expect(g.sac.map((x: any) => [x.ratePct, x.qty])).toEqual([[5, 2], [18, 1]]);

    // The HUF is not registered: no GST on anything, liquor still kept apart.
    const o2 = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T3' }))).id;
    for (const id of [pool, beer]) await ok(counter.post(`${B}/orders/${o2}/items`, { itemId: id, delta: 1 }));
    await ok(counter.post(`${B}/orders/${o2}/kot`));
    const hufBill = (await ok(counter.post(`${B}/orders/${o2}/bill`, { entityId: s.huf }))).bill;
    expect(hufBill.taxes).toEqual([{ kind: 'gst', bp: 0, valuePaise: 20000, cgstPaise: 0, sgstPaise: 0 }, { kind: 'liquor', bp: 0, valuePaise: 30000, cgstPaise: 0, sgstPaise: 0 }]);
    await expect(q('UPDATE bill_taxes SET value_paise = 1 WHERE bill_id = ?', bill.id)).rejects.toThrow(/bill_frozen/);
  });
});
