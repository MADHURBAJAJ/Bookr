// A booking that continues a stay (25 Nov 2026): Djubo makes an extension as a new booking. It is offered against the
// guest's in-house rooms, joins the stay (rent on the first room's bill, stays run to its last day), a room can move to
// the one Djubo gives, and check-out makes one invoice with a line per booking. All names and numbers are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);
const add = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

describe('continuing a stay', () => {
  it('offers the extension against the guest\'s rooms, joins it to the stay, moves to Djubo\'s room, and invoices it once', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Boutique', kind: 'rooms', tables: ['XX', 'XXIII', 'XXIV'] }] }));
    const today = (await ok(owner.get('/me'))).business.shiftDay;
    const t = Date.now();
    const bk = async (ref: string, labels: string, inDay: string, outDay: string, amount: number, rooms = 1) => {
      const id = crypto.randomUUID();
      await q(`INSERT INTO bookings (id, business_id, source, ext_ref, guest_name, phone, room_type, room_labels, rooms, check_in, check_out, status, amount_paise, paid_paise, created_at, updated_at)
        VALUES (?, ?, 'djubo', ?, 'Mr.Sample Guest', '9800055555', 'Boutique', ?, ?, ?, ?, 'approved', ?, ?, ?, ?)`, id, s.businessId, ref, labels, rooms, inDay, outDay, amount, amount, t, t);
      return id;
    };
    const first = await bk('DJ-1', 'XX', add(today, -1), today, 250_000);
    const second = await bk('DJ-2', 'XXIII', add(today, -1), today, 250_000);
    const ext = await bk('DJ-3', 'XX, XXIV', today, add(today, 1), 500_000, 2);
    const xx = (await ok(counter.post(`${B}/stays`, { room: 'XX', guestName: 'Mr.Sample Guest', phone: '9800055555', bookingId: first }))).id;
    const x23 = (await ok(counter.post(`${B}/stays`, { room: 'XXIII', guestName: 'Mr.Sample Guest', phone: '9800055555', bookingId: second }))).id;

    // Someone extended XXIII by hand first (₹2,500 typed): it is still offered, and that rent gives way to the booking's.
    await ok(counter.post(`${B}/stays/${x23}/extend`, { to: add(today, 1), rate: '2500', reason: 'Djubo down (test)', ...s.mgr }));   // a manager, without Djubo (26 Nov 2026)
    // The extension is offered against both rooms.
    const arr = (await ok(counter.get(`${B}/bookings/arrivals`))).arrivals.find((a: any) => a.extRef === 'DJ-3');
    expect(arr.continues.map((x: any) => x.room)).toEqual(['XX', 'XXIII']);

    // Joined: XXIII moves to XXIV as Djubo has it; both run to tomorrow; the rent goes on XX's bill.
    const bill = await ok(counter.post(`${B}/bookings/${ext}/continue`, { stays: [{ id: xx }, { id: x23, moveTo: 'XXIV' }] }));
    expect(bill.stay).toMatchObject({ id: xx, room: 'XX', checkOutPlan: add(today, 1) });
    expect(bill.rentPaise).toBe(750_000);
    expect((await q('SELECT room, check_out_plan AS p FROM stays WHERE id = ?', x23))[0]).toEqual({ room: 'XXIV', p: add(today, 1) });
    expect((await ok(counter.get(`${B}/stays/${x23}/bill`))).rentPaise).toBe(250_000);   // its own night only: the hand-typed one gave way
    expect((await q("SELECT status FROM room_status WHERE room = 'XXIII'"))[0].status).toBe('dirty');
    expect((await ok(counter.get(`${B}/bookings/arrivals`))).arrivals.map((a: any) => a.extRef)).not.toContain('DJ-3');
    expect((await counter.post(`${B}/bookings/${ext}/continue`, { stays: [{ id: xx }] })).status).toBe(409);   // once

    // Check-out: one invoice for both nights, a line per booking.
    const out = await ok(counter.post(`${B}/stays/${xx}/check-out`, {}));
    expect(out.bill.invoice).toMatchObject({ checkIn: add(today, -1), checkOut: add(today, 1), nights: 2, totalPaise: 750_000 });
    expect(out.bill.invoice.lines.map((l: any) => l.amountPaise)).toEqual([250_000, 500_000]);
  });
});
