// Offline mode (27 Nov 2026): steps made on the counter with no internet are sent up later, run through the usual routes at
// the time they happened, keep the numbers printed on paper, and are saved once even if sent twice. All names and amounts
// here are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { Client, dispose, q, setupBusiness } from './helpers';
import { istDay } from '../../src/time';

afterAll(dispose);

const yymmdd = (t: number) => istDay(t).slice(2).replace(/-/g, '');

async function ready() {
  const s = await setupBusiness();
  const { B, owner, ok } = s;
  const dev = (await ok(owner.get(`${B}/devices`))).devices.find((d: any) => d.name === 'Billing counter');
  return { ...s, deviceId: dev.id as string };
}

describe('offline mode', () => {
  it('gives letters only when the owner turns a device on, and never twice', async () => {
    const s = await ready();
    const { B, owner, counter, ok } = s;
    expect((await counter.get(`${B}/offline/device`)).json.device).toEqual({ name: 'Billing counter', letter: null });
    expect((await counter.post(`${B}/offline/replay`, { stepId: 'step-0000001', at: Date.now(), method: 'POST', path: '/orders', body: {} })).status).toBe(403);
    // A cashier cannot turn it on.
    expect((await counter.post(`${B}/devices/${s.deviceId}/offline`)).status).toBe(403);
    expect((await ok(owner.post(`${B}/devices/${s.deviceId}/offline`))).letter).toBe('A');
    expect((await ok(owner.post(`${B}/devices/${s.deviceId}/offline`))).letter).toBe('A');
    // A second counter device gets B; a revoked device keeps its letter, so A is never given again.
    const other = new Client();
    other.cookies = new Map(owner.cookies);
    const id2 = (await ok(other.post(`${B}/devices`, { name: 'Second counter' }))).id;
    expect((await ok(owner.post(`${B}/devices/${id2}/offline`))).letter).toBe('B');
    expect((await ok(counter.get(`${B}/offline/device`))).device).toEqual({ name: 'Billing counter', letter: 'A' });
  });

  it('sends up an order, KOT, bill and cash payment made offline, at their own time and with their printed numbers', async () => {
    const s = await ready();
    const { B, owner, counter, ok } = s;
    await ok(owner.post(`${B}/devices/${s.deviceId}/offline`));
    const at = Date.now() - 50 * 60_000;
    const local = crypto.randomUUID();
    const localBill = crypto.randomUUID();
    const send = (stepId: string, x: Record<string, unknown>) => ok(counter.post(`${B}/offline/replay`, { stepId, ...x }));

    const made = await send(`${local}:open`, { at, localId: local, method: 'POST', path: '/orders', body: { kind: 'table', place: 'T9' } });
    expect(made.ok).toBe(true);
    const orderId = made.serverId;
    expect(orderId).not.toBe(local);
    expect((await q('SELECT opened_at FROM orders WHERE id = ?', orderId))[0].opened_at).toBe(at);
    // The device's own id is swapped for the server's on later steps.
    await send(`${local}:i1`, { at: at + 1000, method: 'POST', path: `/orders/${local}/items`, body: { itemId: s.items['Masala Dosa'], delta: 2 } });
    await send(`${local}:i2`, { at: at + 2000, method: 'POST', path: `/orders/${local}/items`, body: { itemId: s.items['Butter Naan'], delta: 3 } });
    const kot = await send(`${local}:k1`, { at: at + 3000, method: 'POST', path: `/orders/${local}/kot`, body: {}, kotLabels: { Kitchen: 'A1' } });
    expect(kot.ok).toBe(true);
    const kots = await q('SELECT offline_label, print_at, status, printed_at FROM kots WHERE order_id = ?', orderId);
    expect(kots).toEqual([{ offline_label: 'A1', print_at: 'counter', status: 'ready', printed_at: at + 3000 }]);

    // 2 × 180 + 3 × 60 = 540, GST 5% = 27: 567.
    const billNo = `C${yymmdd(at + 4000)}A001`;
    const billed = await send(`${local}:b1`, { at: at + 4000, localId: localBill, method: 'POST', path: `/orders/${local}/bill`, body: { entityId: s.company }, billNo, expectTotalPaise: 56_700 });
    expect(billed).toMatchObject({ ok: true, data: { bill: { billNo, totalPaise: 56_700 } } });
    expect(billed.mismatch).toBeUndefined();
    const row = (await q('SELECT id, bill_no, print_day, day_seq, offline_device, printed_at FROM bills WHERE order_id = ?', orderId))[0];
    expect(row).toMatchObject({ bill_no: billNo, print_day: istDay(at + 4000), day_seq: null, offline_device: s.deviceId, printed_at: at + 4000 });
    expect(billed.serverId).toBe(row.id);

    // Sent twice (the internet dropped before the answer came back): saved once.
    expect(await send(`${local}:b1`, { at: at + 4000, localId: localBill, method: 'POST', path: `/orders/${local}/bill`, body: { entityId: s.company }, billNo })).toMatchObject({ ok: true, already: true, serverId: row.id });
    expect((await q('SELECT count(*) AS n FROM bills WHERE order_id = ?', orderId))[0].n).toBe(1);

    const paid = await send(`${local}:p1`, { at: at + 5000, method: 'POST', path: '/settlements', body: { billIds: [localBill], payments: [{ mode: 'cash', amount: '567' }] } });
    expect(paid.ok).toBe(true);
    expect((await q('SELECT status, settled_at FROM bills WHERE id = ?', row.id))[0]).toEqual({ status: 'settled', settled_at: at + 5000 });

    // The day's online numbers carry on as before.
    const online = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T10' }))).id;
    await ok(counter.post(`${B}/orders/${online}/items`, { itemId: s.items['Masala Chai'], delta: 1 }));
    await ok(counter.post(`${B}/orders/${online}/kot`));
    const ob = (await ok(counter.post(`${B}/orders/${online}/bill`, { entityId: s.company }))).bill;
    expect(ob.billNo).toBe(`C${yymmdd(Date.now())}001`);
    // The Daily check: offline numbers leave no gap in the day's or the year's count, and are listed as made offline.
    const shiftDay = (await ok(owner.get('/me'))).business.shiftDay;
    const dc = await ok(owner.get(`${B}/reports/daily-check?day=${shiftDay}`));
    expect(dc.series.flatMap((x: any) => x.missing)).toEqual([]);
    expect((await ok(owner.get(`${B}/offline/day?day=${shiftDay}`))).bills).toEqual([{ billNo, totalPaise: 56_700, device: 'Billing counter' }]);
    expect((await counter.get(`${B}/offline/day?day=${shiftDay}`)).status).toBe(403);
    // The counter learns which offline numbers it already used, in case its saved data was cleared.
    expect((await ok(counter.get(`${B}/offline/device`))).used).toMatchObject({ bills: [billNo], kots: [{ label: 'A1' }] });
  });

  it("refuses numbers that are not this device's or that day's, and routes that cannot be sent up", async () => {
    const s = await ready();
    const { B, owner, counter, ok } = s;
    await ok(owner.post(`${B}/devices/${s.deviceId}/offline`));
    const at = Date.now() - 10 * 60_000;
    const local = crypto.randomUUID();
    const send = (stepId: string, x: Record<string, unknown>) => counter.post(`${B}/offline/replay`, { stepId, ...x });
    await ok(send(`${local}:open`, { at, localId: local, method: 'POST', path: '/orders', body: { kind: 'table', place: 'T11' } }));
    await ok(send(`${local}:i1`, { at, method: 'POST', path: `/orders/${local}/items`, body: { itemId: s.items['Masala Chai'], delta: 1 } }));
    await ok(send(`${local}:k1`, { at, method: 'POST', path: `/orders/${local}/kot`, body: {}, kotLabels: { Kitchen: 'A1' } }));
    expect((await send(`${local}:b1`, { at, method: 'POST', path: `/orders/${local}/bill`, body: { entityId: s.company }, billNo: `C${yymmdd(at)}B001` })).status).toBe(400);
    expect((await send(`${local}:b2`, { at, method: 'POST', path: `/orders/${local}/bill`, body: { entityId: s.company }, billNo: 'C990101A001' })).status).toBe(400);
    expect((await send(`${local}:k2`, { at, method: 'POST', path: `/orders/${local}/kot`, body: {}, kotLabels: { Kitchen: 'B4' } })).status).toBe(400);
    expect((await send(`${local}:v1`, { at, method: 'POST', path: `/bills/${local}/void`, body: {} })).status).toBe(400);
    expect((await send(`${local}:old`, { at: Date.now() - 5 * 86_400_000, method: 'POST', path: '/orders', body: { kind: 'takeaway' } })).status).toBe(400);
    // A step the route itself refuses comes back as not saved, with the reason; nothing is marked done.
    const r = await ok(send(`${local}:i9`, { at, method: 'POST', path: `/orders/${local}/items`, body: { itemId: crypto.randomUUID(), delta: 1 } }));
    expect(r).toMatchObject({ ok: false, status: 400, error: 'Item not on the menu.' });
    expect((await q('SELECT count(*) AS n FROM offline_steps WHERE step_id = ?', `${local}:i9`))[0].n).toBe(0);
    // A total that differs from the paper is saved and flagged for the manager.
    const billNo = `C${yymmdd(at)}A001`;
    const b = await ok(send(`${local}:b3`, { at, method: 'POST', path: `/orders/${local}/bill`, body: { entityId: s.company }, billNo, expectTotalPaise: 9_900 }));
    expect(b).toMatchObject({ ok: true, mismatch: true });
    expect((await q('SELECT problem FROM offline_steps WHERE step_id = ?', `${local}:b3`))[0].problem).toMatch(/printed offline on Billing counter for 99.00; it is saved as 42.00/);
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    expect((await ok(owner.get(`${B}/offline/day?day=${day}`))).problems).toHaveLength(1);
  });

  it('a room payment taken offline keeps its receipt number', async () => {
    const s = await ready();
    const { B, owner, counter, ok } = s;
    await ok(owner.post(`${B}/devices/${s.deviceId}/offline`));
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['XII'] }] }));
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'XII', guestName: 'Sample Guest' }))).id;
    await ok(counter.post(`${B}/stays/${stay}/charges`, { amount: '2500', note: 'Room' }));
    const bill = await ok(counter.get(`${B}/stays/${stay}/bill`));
    const at = Date.now() - 5 * 60_000;
    const fy = (await q('SELECT fy_start_month FROM businesses WHERE id = ?', s.businessId))[0];
    expect(fy).toBeTruthy();
    const me = await ok(counter.get('/me'));
    const y = Number(me.business.shiftDay.slice(0, 4));
    const m = Number(me.business.shiftDay.slice(5, 7));
    const start = m >= 4 ? y : y - 1;
    const receiptNo = `RCPT/${String(start).slice(2)}-${String((start + 1) % 100).padStart(2, '0')}/A001`;
    const r = await ok(counter.post(`${B}/offline/replay`, { stepId: `room-pay-${stay}`, at, method: 'POST', path: `/debtors/${bill.stay.accountId}/receipts`,
      body: { kind: 'receipt', payments: [{ mode: 'cash', amount: '2500' }] }, receiptNo }));
    expect(r).toMatchObject({ ok: true, data: { receipt: { receiptNo, totalPaise: 250_000, balancePaise: 0 } } });
    expect((await q('SELECT offline_device, at FROM settlements WHERE receipt_no = ?', receiptNo))[0]).toEqual({ offline_device: s.deviceId, at });
    // The next online receipt takes the yearly count as usual.
    await ok(counter.post(`${B}/stays/${stay}/charges`, { amount: '100', note: 'Laundry' }));
    const r2 = await ok(counter.post(`${B}/debtors/${bill.stay.accountId}/receipts`, { kind: 'receipt', payments: [{ mode: 'cash', amount: '100' }] }));
    expect(r2.receipt.receiptNo).toMatch(/\/0001$/);
  });
});
