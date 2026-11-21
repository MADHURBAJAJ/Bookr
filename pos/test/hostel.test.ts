// Hostel changes (21 Nov 2026): tables in sections (rooms, dorm beds and whole dorms, Out House, NC), KOT numbers from 101
// each day, guests kept by phone for their next stay, events with the organiser's commission, and sales by section and hour.
// All names, phone numbers and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { billed, dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

const SECTIONS = [
  { name: 'Private Rooms', kind: 'rooms', tables: ['Room 101', 'Room 102'] },
  { name: 'Dorms', kind: 'dorms', dorms: [{ name: 'Dorm A', beds: 3 }] },
  { name: 'Out House', kind: 'outhouse', tables: ['OH 1', 'OH 2'] },
  { name: 'NC', kind: 'nc', tables: ['Sample Partner'] },
];

describe('hostel', () => {
  it('keeps tables in sections; NC is for managers and closes complimentary; a dorm is sold by bed or whole', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    const t = await ok(owner.put(`${B}/tables`, { sections: SECTIONS }));
    expect(t.tables).toEqual(['Room 101', 'Room 102', 'Dorm A · whole', 'Dorm A · Bed 1', 'Dorm A · Bed 2', 'Dorm A · Bed 3', 'OH 1', 'OH 2', 'Sample Partner']);
    expect((await owner.put(`${B}/tables`, { sections: [...SECTIONS, { name: 'More', kind: 'other', tables: ['OH 1'] }] })).status).toBe(400);   // a name twice
    const board = await ok(counter.get(`${B}/orders`));
    expect(board.sections.map((x: any) => [x.name, x.kind])).toEqual([['Private Rooms', 'rooms'], ['Dorms', 'dorms'], ['Out House', 'outhouse'], ['NC', 'nc']]);

    // NC: a cashier may not open or add to it; a manager closes its bill as complimentary in the person's name.
    expect((await counter.post(`${B}/orders`, { kind: 'table', place: 'Sample Partner' })).status).toBe(403);
    const nc = (await ok(owner.post(`${B}/orders`, { kind: 'table', place: 'Sample Partner' }))).id;
    expect((await counter.post(`${B}/orders/${nc}/items`, { itemId: s.items['Masala Chai'], delta: 1 })).status).toBe(403);
    await ok(owner.post(`${B}/orders/${nc}/items`, { itemId: s.items['Masala Chai'], delta: 2 }));
    await ok(owner.post(`${B}/orders/${nc}/kot`));
    const bill = (await ok(owner.post(`${B}/orders/${nc}/bill`, { entityId: s.company }))).bill;
    expect((await counter.post(`${B}/settlements`, { billIds: [bill.id], nc: true })).status).toBe(403);
    await ok(owner.post(`${B}/settlements`, { billIds: [bill.id], nc: true }));
    expect(await q("SELECT mode, comp_guest, comp_reason FROM payments WHERE business_id = ?", s.businessId)).toEqual([{ mode: 'comp', comp_guest: 'Sample Partner', comp_reason: 'NC (non-chargeable)' }]);
    // A bill from an ordinary table cannot be closed as NC.
    const plain = await billed(s, [['Masala Chai', 1]], {}, 'OH 1');
    expect((await owner.post(`${B}/settlements`, { billIds: [plain.bill.id], nc: true })).status).toBe(400);

    // Dorm: a bed is taken, so the whole dorm cannot be booked; once booked whole, a bed cannot start its own order.
    const bed = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'Dorm A · Bed 2' }))).id;
    expect((await counter.post(`${B}/orders`, { kind: 'table', place: 'Dorm A · whole' })).json.error).toContain('Dorm A · Bed 2 already has an order');
    await q("UPDATE orders SET status = 'cancelled' WHERE id = ?", bed);   // that guest's order is done
    await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'Dorm A · whole' }));
    expect((await counter.post(`${B}/orders`, { kind: 'table', place: 'Dorm A · Bed 1' })).json.error).toContain('booked whole');
  });

  it('numbers KOTs from 101 each shift day', async () => {
    const s = await setupBusiness();
    const { B, counter, ok } = s;
    const o = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T1' }))).id;
    await ok(counter.post(`${B}/orders/${o}/items`, { itemId: s.items['Masala Dosa'], delta: 1 }));
    await ok(counter.post(`${B}/orders/${o}/items`, { itemId: s.items['Beer 650 ml'], delta: 1 }));
    const k1 = (await ok(counter.post(`${B}/orders/${o}/kot`))).kots.map((k: any) => k.kotNo);
    await ok(counter.post(`${B}/orders/${o}/items`, { itemId: s.items['Masala Chai'], delta: 1 }));
    const k2 = (await ok(counter.post(`${B}/orders/${o}/kot`))).kots.map((k: any) => k.kotNo);
    expect([...k1, ...k2].sort()).toEqual([101, 102, 103]);
    // Another shift day starts again at 101.
    await q('UPDATE kots SET shift_day = ? WHERE business_id = ?', '2026-01-01', s.businessId);
    await ok(counter.post(`${B}/orders/${o}/items`, { itemId: s.items['Masala Chai'], delta: 1 }));
    expect((await ok(counter.post(`${B}/orders/${o}/kot`))).kots[0].kotNo).toBe(101);
  });

  it('keeps a guest by phone for their next stay, and finds stays by phone', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    const first = (await ok(owner.post(`${B}/stays`, { room: '101', guestName: 'Sample Guest', phone: '+91 98765 43210', city: 'Sample City' }))).id;
    expect((await ok(owner.get(`${B}/stays`))).stays[0]).toMatchObject({ room: '101', guestName: 'Sample Guest', phone: '9876543210' });
    expect((await ok(counter.get(`${B}/stays`))).stays[0].phone).toBe('9876543210');   // the till sees the number to search by
    await ok(owner.post(`${B}/stays/${first}/check-out`, {}));
    const back = (await ok(owner.get(`${B}/guests/lookup?phone=09876543210`))).guest;
    expect(back).toMatchObject({ name: 'Sample Guest', phone: '9876543210', city: 'Sample City', stays: [{ room: '101' }] });
    await ok(owner.post(`${B}/stays`, { room: '102', guestName: 'Sample Guest K', phone: '9876543210' }));
    expect(await q('SELECT name, city FROM guests WHERE business_id = ?', s.businessId)).toEqual([{ name: 'Sample Guest K', city: 'Sample City' }]);
    expect((await ok(owner.get(`${B}/guests/lookup?phone=9876543210`))).guest.stays.map((x: any) => x.room)).toEqual(['102', '101']);
    expect((await owner.post(`${B}/stays`, { room: '103', guestName: 'X', phone: '12' })).status).toBe(400);
  });

  it('counts an event’s bills at its tables, its commission and what has been paid; sales by section and hour', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok } = s;
    await ok(owner.put(`${B}/tables`, { sections: SECTIONS }));
    const t = Date.now();
    expect((await owner.post(`${B}/event-mode`, { name: 'Sample Night', organiser: 'Sample Events', startsAt: t - 3_600_000, endsAt: t + 3_600_000, commission: 20, sections: ['Nope'] })).status).toBe(400);
    const ev = (await ok(owner.post(`${B}/event-mode`, { name: 'Sample Night', organiser: 'Sample Events', startsAt: t - 3_600_000, endsAt: t + 3_600_000, commission: 20, sections: ['Out House'], menu: ['Food'] }))).id;
    expect((await owner.post(`${B}/event-mode`, { name: 'Clash', organiser: 'X', startsAt: t, endsAt: t + 7_200_000, commission: 10, sections: ['Out House'] })).status).toBe(409);
    expect((await ok(counter.get(`${B}/event-mode/now`))).event).toMatchObject({ id: ev, name: 'Sample Night', menu: ['Food'] });
    expect((await counter.get(`${B}/event-mode`)).status).toBe(403);

    const oh = await billed(s, [['Masala Dosa', 1]], {}, 'OH 1');           // 180 before GST: counts
    await billed(s, [['Masala Dosa', 1]], {}, 'Room 101');                   // another section: does not
    let e = (await ok(owner.get(`${B}/event-mode`))).events[0];
    expect(e).toMatchObject({ bills: 1, netPaise: 18000, commissionPaise: 3600, paidPaise: 0, duePaise: 3600 });
    await ok(owner.post(`${B}/event-mode/${ev}/payments`, { amount: '20', mode: 'cash' }));
    e = (await ok(owner.get(`${B}/event-mode`))).events[0];
    expect(e).toMatchObject({ paidPaise: 2000, duePaise: 1600, payments: [{ amountPaise: 2000, mode: 'cash' }] });
    expect(await q("SELECT kind, mode, amount_paise FROM drawer_outs WHERE business_id = ?", s.businessId)).toEqual([{ kind: 'paid_out', mode: 'cash', amount_paise: 2000 }]);
    await ok(owner.post(`${B}/event-mode/${ev}/end`, {}));
    expect((await ok(counter.get(`${B}/event-mode/now`))).event).toBeNull();

    const day = oh.bill.shiftDay;
    const secs = (await ok(owner.get(`${B}/reports/sections?from=${day}&to=${day}`))).sections;
    expect(secs.map((x: any) => [x.section, x.bills, x.netPaise])).toEqual([['Private Rooms', 1, 18000], ['Out House', 1, 18000]]);
    const hrs = await ok(owner.get(`${B}/reports/hours?from=${t - 3_600_000}&to=${t + 3_600_000}&section=Out%20House`));
    expect([hrs.bills, hrs.totalPaise, hrs.hours.length >= 2]).toEqual([1, 18000, true]);
  });
});
