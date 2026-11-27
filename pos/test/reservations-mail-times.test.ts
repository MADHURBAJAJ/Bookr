// Reservations sorted by the latest email (28 Nov 2026): each booking in the list says when its first and latest emails came,
// and how many there were, counting its MakeMyTrip twin's. Invented data.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('reservations list email times', () => {
  it('gives each booking its first and latest email times and the count', async () => {
    const s = await setupBusiness();
    const { B, counter, ok } = s;
    const day = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const out = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const t0 = Date.now() - 3 * 3_600_000;
    const bk = async (id: string, source: string, ref: string, matchId: string | null) => q(`INSERT INTO bookings (id, business_id, source, ext_ref, guest_name, room_type,
        check_in, check_out, status, amount_paise, paid_paise, created_at, updated_at, match_id) VALUES (?, ?, ?, ?, 'Mail Guest', 'Deluxe', ?, ?, 'approved', 100000, 0, ?, ?, ?)`,
      id, s.businessId, source, ref, day, out, t0, t0, matchId);
    const mail = async (bookingId: string, n: number, at: number) => {
      await q(`INSERT INTO inbound_mails (id, business_id, message_id, from_addr, subject, source, received_at, r2_key, status, created_at) VALUES (?, ?, ?, 'x@example.com', 'Booking', 'djubo', ?, 'x', 'read', ?)`,
        `m-${n}`, s.businessId, `msg-${n}`, at, at);
      await q(`INSERT INTO booking_versions (booking_id, mail_id, business_id, order_at, received_at, data, status) VALUES (?, ?, ?, ?, ?, '{}', 'applied')`, bookingId, `m-${n}`, s.businessId, at, at);
    };
    const A = '00000000-0000-4000-8000-0000000000b1';
    const M = '00000000-0000-4000-8000-0000000000b2';
    const C = '00000000-0000-4000-8000-0000000000b3';
    await bk(A, 'djubo', 'DJ-A', null);
    await bk(M, 'mmt', 'MMT-A', A);            // the MakeMyTrip twin of DJ-A: its email counts for DJ-A
    await bk(C, 'djubo', 'DJ-C', null);         // no email history kept (before the history began)
    await mail(A, 1, t0);
    await mail(A, 2, t0 + 3_600_000);
    await mail(M, 3, t0 + 2 * 3_600_000);
    const r = await ok(counter.get(`${B}/reservations`));
    const a = r.bookings.find((x: any) => x.extRef === 'DJ-A');
    expect([a.mailFirstAt, a.mailAt, a.mailCount]).toEqual([t0, t0 + 2 * 3_600_000, 3]);
    expect(r.bookings.find((x: any) => x.extRef === 'MMT-A')).toBeUndefined();
    const c = r.bookings.find((x: any) => x.extRef === 'DJ-C');
    expect([c.mailAt, c.mailCount, c.createdAt]).toEqual([null, 0, t0]);
  });
});
