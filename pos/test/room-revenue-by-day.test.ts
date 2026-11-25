// Room revenue by day (25 Nov 2026): each stay's rent split equally over its nights, counted night by night (in house up
// to today), never advances or payments; extra charges on the day added. All names and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);
const add = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

describe('room revenue by day', () => {
  it('spreads a stay\'s rent over its nights, leaves out the advance, and puts an extra charge on its day', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['101', '102'] }] }));
    const today = (await ok(owner.get('/me'))).business.shiftDay;
    const t = Date.now();
    const id = crypto.randomUUID();
    await q(`INSERT INTO bookings (id, business_id, source, ext_ref, guest_name, room_type, check_in, check_out, status, amount_paise, paid_paise, created_at, updated_at)
      VALUES (?, ?, 'djubo', 'DJ-R1', 'Sample Night Guest', 'Deluxe', ?, ?, 'approved', 630000, 0, ?, ?)`, id, s.businessId, add(today, -2), add(today, 1), t, t);
    const stay = (await ok(counter.post(`${B}/stays`, { room: '101', guestName: 'Sample Night Guest', bookingId: id }))).id;
    const acc = (await ok(counter.get(`${B}/stays/${stay}/bill`))).stay.accountId;
    await ok(counter.post(`${B}/debtors/${acc}/receipts`, { kind: 'receipt', payments: [{ mode: 'cash', amount: '3000' }] }));   // money in: not revenue
    await ok(counter.post(`${B}/stays/${stay}/charges`, { amount: '525', note: 'Extra bed' }));

    const r = (await ok(owner.get(`${B}/reports/rooms?from=${add(today, -2)}&to=${add(today, 1)}`))).byDay;
    expect(r.upTo).toBe(today);   // nights after today are not earned yet
    expect(r.days.map((d: any) => [d.day, d.roomsSold, d.grossPaise])).toEqual([
      [add(today, -2), 1, 210_000], [add(today, -1), 1, 210_000], [today, 1, 210_000 + 52_500]]);
    expect(r.days[0]).toMatchObject({ taxablePaise: 200_000, gstPaise: 10_000, notInvoicedPaise: 210_000, adrPaise: 200_000, occupancyPct: 50 });
    expect(r.totals).toMatchObject({ roomsSold: 3, bedsSold: 0, grossPaise: 682_500 });
  });
});
