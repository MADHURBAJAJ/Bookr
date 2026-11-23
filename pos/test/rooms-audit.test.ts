// Rooms after the hotel manager's audit (25 Nov 2026): bill to a company or another room, the company on the invoice, room
// credit notes, no-shows, extending a stay, the night audit, Form C, the guest register, housekeeping, room moves, editing
// a reservation, and room sales in reports and the GST working. All names, numbers and amounts are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

async function hotel() {
  const s = await setupBusiness();
  await s.ok(s.owner.call('PUT', `${s.B}/tables`, { sections: [{ name: 'Deluxe', kind: 'rooms', tables: ['X', 'XI', 'XII'] }] }));
  await s.ok(s.owner.call('PUT', `${s.B}/frontdesk/rates`, { rates: { Deluxe: '2100' } }));
  const day = (await s.ok(s.owner.get('/me'))).business.shiftDay;
  const plus = (n: number) => new Date(Date.parse(day) + n * 86_400_000).toISOString().slice(0, 10);
  const stay = async (room: string, guestName: string, extra: Record<string, unknown> = {}) => {
    const r = await s.ok(s.counter.post(`${s.B}/stays`, { room, guestName, checkOutPlan: plus(1), ...extra }));
    await s.ok(s.counter.post(`${s.B}/stays/${r.id}/charges`, { amount: '2100', note: 'Room rent' }));
    return r.id as string;
  };
  return { ...s, day, plus, stay };
}

describe('rooms after the audit', () => {
  it('a company pays: balance moved to its credit account, its GSTIN on the invoice (B2B in the GST working); room sales report', async () => {
    const s = await hotel();
    const { B, counter, ok, mgr, day } = s;
    const st = await s.stay('X', 'Company Guest');
    expect((await counter.post(`${B}/stays/${st}/transfer`, { to: 'credit', newCredit: { name: 'Sample Travels', phone: '9800070707' } })).status).toBe(403);
    let bill = await ok(counter.post(`${B}/stays/${st}/transfer`, { to: 'credit', newCredit: { name: 'Sample Travels', phone: '9800070707' }, ...mgr }));
    expect(bill.balancePaise).toBe(0);
    const out = await ok(counter.post(`${B}/stays/${st}/check-out`, { billTo: { name: 'Sample Travels', gstin: '29ABCDE1234F1Z5' } }));
    expect(out.bill.invoice).toMatchObject({ billToName: 'Sample Travels', billToGstin: '29ABCDE1234F1Z5', totalPaise: 210_000, gstRateBp: 500 });
    expect((await ok(counter.get(`${B}/credit-accounts`))).accounts).toMatchObject([{ name: 'Sample Travels', balancePaise: 210_000, oldestDays: 0 }]);
    // Reprint after check-out; a room credit note (manager) takes GST back at the invoice's rate.
    bill = await ok(counter.get(`${B}/stays/${st}/bill`));
    expect(bill.invoice.invoiceNo).toMatch(/^CR\d{4}-0001$/);
    const invId = (await q('SELECT id FROM room_invoices WHERE stay_id = ?', st))[0].id;
    expect((await counter.post(`${B}/room-invoices/${invId}/credit-note`, { amount: '3000', reason: 'Too much', refundMode: 'none', ...mgr })).status).toBe(400);
    const cn = await ok(counter.post(`${B}/room-invoices/${invId}/credit-note`, { amount: '210', reason: 'AC not working one night', refundMode: 'none', ...mgr }));
    expect(cn.cnNo).toMatch(/^RCN\/\d\d-\d\d\/0001$/);
    expect(cn.bill.invoice.creditNotes).toMatchObject([{ totalPaise: 21_000, taxablePaise: 20_000, cgstPaise: 500, sgstPaise: 500 }]);
    const rep = await ok(s.owner.get(`${B}/reports/rooms?from=${day}&to=${day}`));
    expect(rep.totals).toMatchObject({ invoices: 1, totalPaise: 189_000 });
    const gst = await ok(s.owner.get(`${B}/reports/gstr1?month=${day.slice(0, 7)}`));
    expect(gst.rooms[0]).toMatchObject({ b2b: [{ gstin: '29ABCDE1234F1Z5', totalPaise: 210_000 }], b2cs: [{ ratePct: 5, taxablePaise: -20_000 }] });
  });

  it('a group pays from one room; a room move; housekeeping after check-out; extending a stay', async () => {
    const s = await hotel();
    const { B, counter, ok, plus } = s;
    const a = await s.stay('X', 'Group Lead');
    const b = await s.stay('XI', 'Group Member');
    await ok(counter.post(`${B}/stays/${b}/transfer`, { to: 'room', stayId: a }));
    expect((await ok(counter.get(`${B}/stays/${a}/bill`))).balancePaise).toBe(420_000);
    // The member moves to XII; XI becomes dirty; checking in to a dirty room is asked about.
    await ok(counter.post(`${B}/stays/${b}/move`, { room: 'XII', reason: 'AC not working' }));
    const hk = await ok(counter.get(`${B}/frontdesk/housekeeping`));
    expect(hk.sections[0].rooms.find((r: any) => r.room === 'XI')).toMatchObject({ status: 'dirty' });
    expect(hk.sections[0].rooms.find((r: any) => r.room === 'XII')).toMatchObject({ guest: 'Group Member' });
    const ask = await counter.post(`${B}/stays`, { room: 'XI', guestName: 'Next Guest' });
    expect(ask).toMatchObject({ status: 409, json: { code: 'room_dirty' } });
    await ok(counter.post(`${B}/frontdesk/housekeeping`, { rooms: ['XI'], status: 'clean' }));
    await ok(counter.post(`${B}/stays`, { room: 'XI', guestName: 'Next Guest' }));
    // Extend the lead by two nights at ₹2,100.
    const ext = await ok(counter.post(`${B}/stays/${a}/extend`, { to: plus(3), rate: '2100' }));
    expect([ext.stay.checkOutPlan, ext.rentPaise]).toEqual([plus(3), 630_000]);
  });

  it('night audit: no-shows (advance kept), overstays, Form C; the guest register keeps ID as last 4', async () => {
    const s = await hotel();
    const { B, counter, ok, day, plus } = s;
    const r = await ok(counter.post(`${B}/reservations`, { checkIn: day, checkOut: plus(1), guestName: 'Late Guest', phone: '9800061616', source: 'Phone',
      lines: [{ type: 'Deluxe', roomNames: ['XII'], adults: 1, rate: '2100' }], payments: [{ mode: 'cash', amount: '1000' }] }));
    const f = await s.stay('X', 'Foreign Guest', { nationality: 'French', foreign: { passport: '12AB34567', visa: 'Tourist' }, idDocs: [{ type: 'Passport', number: '12AB34567' }] });
    await q('UPDATE stays SET check_out_plan = ? WHERE id = ?', plus(-1), f);
    let audit = await ok(counter.get(`${B}/frontdesk/audit`));
    expect(audit.notArrived.map((x: any) => x.guestName)).toEqual(['Late Guest']);
    expect(audit.overstays.map((x: any) => x.guestName)).toEqual(['Foreign Guest']);
    expect(audit.formC).toMatchObject([{ guestName: 'Foreign Guest', level: 'amber' }]);
    await ok(counter.post(`${B}/reservations/${r.id}/no-show`, { advance: 'keep' }));
    await ok(counter.post(`${B}/stays/${f}/form-c`));
    audit = await ok(counter.get(`${B}/frontdesk/audit`));
    expect([audit.notArrived, audit.formC]).toEqual([[], []]);
    expect((await ok(s.owner.get(`${B}/reports/rooms?from=${day}&to=${day}`))).totals.noShowPaise).toBe(100_000);
    const reg = await ok(counter.get(`${B}/frontdesk/register?q=foreign`));
    expect(reg.stays).toMatchObject([{ guestName: 'Foreign Guest', idDocs: [{ type: 'Passport', last4: '4567' }], foreign: { passportLast4: '4567', formC: true } }]);
    expect(JSON.stringify(reg)).not.toContain('12AB34567');
  });

  it('editing a reservation: new dates and room, checked for free rooms without counting itself', async () => {
    const s = await hotel();
    const { B, counter, ok, plus } = s;
    const base = { guestName: 'Change Guest', phone: '9800062626', source: 'Phone' };
    const r = await ok(counter.post(`${B}/reservations`, { ...base, checkIn: plus(2), checkOut: plus(3), lines: [{ type: 'Deluxe', roomNames: ['X'], adults: 2, rate: '2100' }] }));
    await ok(counter.post(`${B}/reservations`, { ...base, guestName: 'Other', phone: '9800063636', checkIn: plus(3), checkOut: plus(4), lines: [{ type: 'Deluxe', roomNames: ['XI'], adults: 1, rate: '2100' }] }));
    expect((await counter.call('PUT', `${B}/reservations/${r.id}`, { ...base, checkIn: plus(2), checkOut: plus(4), lines: [{ type: 'Deluxe', roomNames: ['XI'], adults: 2, rate: '2100' }] })).status).toBe(409);
    const e = await ok(counter.call('PUT', `${B}/reservations/${r.id}`, { ...base, checkIn: plus(2), checkOut: plus(4), lines: [{ type: 'Deluxe', roomNames: ['X'], adults: 2, rate: '2100' }] }));
    expect(e.totalPaise).toBe(420_000);
  });
});
