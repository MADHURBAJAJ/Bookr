// A guest's name and phone on an order (22 Nov 2026): optional on a table, required on a tab and a new credit account;
// a returning guest found by phone; a phone saved under another name asked about; the phone masked on screen, kept on the
// bill, never printed. All names and numbers are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('guests on orders', () => {
  it('keeps the name and phone, finds a returning guest and asks when the name differs', async () => {
    const s = await setupBusiness();
    const { B, counter, ok } = s;
    // A walk-in with no guest, then the guest added on the order.
    const a = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T1' }))).id;
    expect((await ok(counter.get(`${B}/orders/${a}`))).order.guest).toEqual({ name: null, phone: null, visits: 0, lastVisit: null });
    const g1 = (await ok(counter.post(`${B}/orders/${a}/guest`, { guestName: 'Sample Guest', guestPhone: '+91 98000 11111' }))).guest;
    expect(g1).toEqual({ name: 'Sample Guest', phone: '••••1111', visits: 0, lastVisit: null });
    expect((await ok(counter.get(`${B}/orders`))).orders.find((o: any) => o.id === a)).toMatchObject({ guestName: 'Sample Guest', guestPhone: '••••1111' });
    // The full number is kept, and goes on the bill when it is printed.
    await ok(counter.post(`${B}/orders/${a}/items`, { itemId: s.items['Masala Chai'], delta: 1 }));
    await ok(counter.post(`${B}/orders/${a}/kot`));
    const bill = (await ok(counter.post(`${B}/orders/${a}/bill`, { entityId: s.company }))).bill;
    expect((await q('SELECT guest_phone FROM bills WHERE id = ?', bill.id))[0].guest_phone).toBe('9800011111');
    expect(JSON.stringify(bill)).not.toContain('9800011111');

    // The same phone again: the name comes from the guest list, with the earlier visit.
    const b = (await ok(counter.post(`${B}/orders`, { kind: 'takeaway', guestPhone: '9800011111' }))).id;
    expect((await ok(counter.get(`${B}/orders/${b}`))).order.guest).toMatchObject({ name: 'Sample Guest', visits: 1 });
    // A different name with that phone is asked about; then the saved name is kept, or the guest renamed.
    const c = await counter.post(`${B}/orders`, { kind: 'takeaway', guestName: 'Other Name', guestPhone: '9800011111' });
    expect(c).toMatchObject({ status: 409, json: { code: 'guest_differs', savedName: 'Sample Guest' } });
    const kept = (await ok(counter.post(`${B}/orders`, { kind: 'takeaway', guestName: 'Other Name', guestPhone: '9800011111', guestChoice: 'saved' }))).id;
    expect((await ok(counter.get(`${B}/orders/${kept}`))).order.guestName).toBe('Sample Guest');
    await ok(counter.post(`${B}/orders/${kept}/guest`, { guestName: 'S. Guest', guestChoice: 'update' }));   // phone kept from the order
    expect((await q('SELECT name FROM guests WHERE phone = ?', '9800011111'))[0].name).toBe('S. Guest');

    // A phone alone is kept on the order but does not join the guest list.
    const d = (await ok(counter.post(`${B}/orders`, { kind: 'takeaway', guestPhone: '9800022222' }))).id;
    expect((await ok(counter.get(`${B}/orders/${d}`))).order.guest).toMatchObject({ name: null, phone: '••••2222' });
    expect(await q('SELECT 1 FROM guests WHERE phone = ?', '9800022222')).toEqual([]);
  });

  it('needs name and phone for a tab and a new credit account; a split keeps the guest; a room order takes the stay', async () => {
    const s = await setupBusiness();
    const { B, owner, counter, ok, mgr } = s;
    const o = (await ok(counter.post(`${B}/orders`, { kind: 'table', place: 'T2', guestName: 'Tab Guest' }))).id;
    await ok(counter.post(`${B}/orders/${o}/items`, { itemId: s.items['Masala Chai'], delta: 2 }));
    await ok(counter.post(`${B}/orders/${o}/kot`));
    // Split: the new bill keeps the guest.
    const lines = (await ok(counter.get(`${B}/orders/${o}`))).order.lines;
    const split = (await ok(counter.post(`${B}/orders/${o}/split`, { lines: [{ lineId: lines[0].id, qty: 1 }] }))).id;
    expect((await ok(counter.get(`${B}/orders/${split}`))).order.guestName).toBe('Tab Guest');
    expect((await counter.post(`${B}/orders/${o}/tab`, {})).json.error).toMatch(/phone/);
    await ok(counter.post(`${B}/orders/${o}/tab`, { guestPhone: '9800033333' }));
    expect((await ok(counter.get(`${B}/orders/${o}`))).order).toMatchObject({ status: 'tab', guestName: 'Tab Guest', guestPhone: '••••3333' });
    // A tab's guest cannot be cleared.
    expect((await counter.post(`${B}/orders/${o}/guest`, { guestName: '', guestPhone: '' })).status).toBe(400);

    // A new credit account needs a phone.
    await ok(counter.post(`${B}/orders/${split}/kot`)).catch(() => null);
    const bill = (await ok(counter.post(`${B}/orders/${split}/bill`, { entityId: s.company }))).bill;
    const pay = { billIds: [bill.id], payments: [{ mode: 'credit', amount: String(bill.totalPaise / 100), newCredit: { name: 'Sample Travels' } }], ...mgr };
    expect((await counter.post(`${B}/settlements`, pay)).json.error).toMatch(/phone/);
    await ok(counter.post(`${B}/settlements`, { ...pay, payments: [{ ...pay.payments[0], newCredit: { name: 'Sample Travels', phone: '9800044444' } }] }));

    // Room service: the guest's name and phone come from the check-in.
    await ok(owner.post(`${B}/stays`, { room: '101', guestName: 'Room Guest', phone: '9800055555' }));
    const stay = (await ok(counter.get(`${B}/stays`))).stays[0];
    const r = (await ok(counter.post(`${B}/orders`, { kind: 'room', place: 'Room 101', stayId: stay.id }))).id;
    expect((await ok(counter.get(`${B}/orders/${r}`))).order).toMatchObject({ guestName: 'Room Guest', guestPhone: '••••5555' });
  });
});
