// Occupancy, ADR and RevPAR on Reports › Rooms (25 Nov 2026). All names and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, setupBusiness } from './helpers';

afterAll(dispose);

describe('occupancy, ADR and RevPAR', () => {
  it('counts rooms and dorm beds apart, a whole dorm fills every bed, ADR as earned', async () => {
    const s = await setupBusiness();
    const { B, ok, counter, owner } = s;
    await ok(owner.call('PUT', `${B}/tables`, { sections: [
      { name: 'Deluxe', kind: 'rooms', tables: ['X', 'XI', 'XII', 'XIII'] },
      { name: 'Quad', kind: 'dorms', dorms: [{ name: 'D', beds: 2, letters: true }] }] }));
    const day = (await ok(owner.get('/me'))).business.shiftDay;
    const next = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    const stay = async (room: string, guestName: string, rent: string) => {
      const r = await ok(counter.post(`${B}/stays`, { room, guestName, checkOutPlan: next }));
      await ok(counter.post(`${B}/stays/${r.id}/charges`, { amount: rent, note: 'Room rent' }));
      return r.id as string;
    };
    const x = await stay('X', 'Guest One', '2100');
    await stay('XI', 'Guest Two', '2100');
    await stay('D · whole', 'Group Three', '1400');
    let rep = await ok(owner.get(`${B}/reports/rooms?from=${day}&to=${day}`));
    expect(rep.occupancy).toMatchObject({ days: 1, rooms: { available: 4, sold: 2, pct: 50 }, beds: { available: 2, sold: 2, pct: 100 }, pct: 66.7 });
    // ADR is revenue before GST per night sold, as earned each night (25 Nov 2026): known before anyone checks out.
    const earned = (r: any) => Math.round(r.byDay.totals.taxablePaise / (r.byDay.totals.roomsSold + r.byDay.totals.bedsSold));
    expect(rep.occupancy.adrPaise).toBe(earned(rep));
    expect(rep.byDay.totals).toMatchObject({ roomsSold: 2, bedsSold: 2, grossPaise: 560_000 });
    // A day-use check-out still counts its night.
    const bill = await ok(counter.get(`${B}/stays/${x}/bill`));
    await ok(counter.post(`${B}/debtors/${bill.stay.accountId}/receipts`, { kind: 'receipt', payments: [{ mode: 'cash', amount: '2100' }] }));
    await ok(counter.post(`${B}/stays/${x}/check-out`, {}));
    rep = await ok(owner.get(`${B}/reports/rooms?from=${day}&to=${day}`));
    expect(rep.occupancy.rooms.sold).toBe(2);
    expect(rep.occupancy.adrPaise).toBe(earned(rep));
    expect(rep.occupancy.revparPaise).toBe(Math.round(rep.occupancy.adrPaise * (4 / 6)));
    // Days after today are not counted as available.
    rep = await ok(owner.get(`${B}/reports/rooms?from=${day}&to=${next}`));
    expect(rep.occupancy).toMatchObject({ days: 1, upTo: day });
  });
});
