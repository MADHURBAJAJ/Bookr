// A stay's email history (27 Nov 2026): every booking on the bill (one per night), and the same guest's bookings just
// before it that never came onto a bill, each email marked with its night and whether it is on this bill. Invented data.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('stay email history', () => {
  it('lists all the stay\'s bookings and the earlier ones not on the bill', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['H1'] }] }));
    const stay = (await ok(counter.post(`${B}/stays`, { room: 'H1', guestName: 'History Guest' }))).id;
    const day = (await q('SELECT check_in FROM stays WHERE id = ?', stay))[0].check_in as string;
    const add = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
    const t = Date.now();
    const mk = async (id: string, ref: string, ci: string, co: string, onStay: boolean) => {
      await q(`INSERT INTO bookings (id, business_id, source, ext_ref, guest_name, room_type, check_in, check_out, status, amount_paise, paid_paise, created_at, updated_at, stay_id)
        VALUES (?, ?, 'djubo', ?, 'History Guest', 'Deluxe', ?, ?, ?, 100000, 0, ?, ?, ?)`, id, s.businessId, ref, ci, co, onStay ? 'checked_in' : 'approved', t, t, onStay ? stay : null);
      await q(`INSERT INTO inbound_mails (id, business_id, message_id, from_addr, subject, source, received_at, r2_key, status, created_at) VALUES (?, ?, ?, 'djubo@example.com', ?, 'djubo', ?, 'x', 'read', ?)`,
        `m-${id}`, s.businessId, `msg-${id}`, `Booking ${ref}`, t, t);
      await q(`INSERT INTO booking_versions (booking_id, mail_id, business_id, order_at, received_at, data, status) VALUES (?, ?, ?, ?, ?, ?, 'applied')`,
        id, `m-${id}`, s.businessId, t, t, JSON.stringify({ amountPaise: 100000, checkIn: ci, checkOut: co }));
    };
    await mk('00000000-0000-4000-8000-0000000000a1', 'DJ-1', day, add(day, 1), true);
    await mk('00000000-0000-4000-8000-0000000000a2', 'DJ-2', add(day, -1), day, false);      // the night before, sent late
    await mk('00000000-0000-4000-8000-0000000000a3', 'DJ-3', add(day, -2), add(day, -1), false);
    await mk('00000000-0000-4000-8000-0000000000a4', 'DJ-X', add(day, -9), add(day, -8), false); // not joined on: left out
    const h = await ok(counter.get(`${B}/stays/${stay}/history`));
    expect(h.bookings).toBe(3);
    expect(h.offBill).toBe(2);
    expect(h.history.map((x: any) => [x.extRef, x.onBill]).sort()).toEqual([['DJ-1', true], ['DJ-2', false], ['DJ-3', false]]);
  });
});
