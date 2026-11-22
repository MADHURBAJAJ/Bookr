// Bills written twice (approved 23 Nov 2026): Bookr removes the extra copy under rules A, B, B1 and C, offers B2 for one
// tap, and Undo puts a line back for good. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { writtenTwice, type TwinRow } from '../src/writtenTwice';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

let n = 0;
const row = (o: Partial<TwinRow> & { billNo: string; amountPaise: number }): TwinRow => ({
  id: `r${++n}`, page: 1, lineNo: n, discountPaise: 0, status: 'draft', paidWithRowId: null, payments: [], uploadId: 'p1', ...o });
const pay = (mode: string, rupees: number) => ({ mode, amountPaise: rupees * 100 });

describe('Which copy goes', () => {
  it('A: the unpaid copy, when the other is paid at an amount within ₹10', () => {
    const paid = row({ billNo: '26103145', amountPaise: 286100, page: 2, payments: [pay('upi', 2861)] });
    const unpaid = row({ billNo: '26103145', amountPaise: 286100, page: 3 });
    const far = [row({ billNo: '26103159', amountPaise: 18800, payments: [pay('cash', 200)] }), row({ billNo: '26103159', amountPaise: 14800 })];
    const { remove } = writtenTwice([paid, unpaid, ...far]);
    expect(remove).toEqual([{ id: unpaid.id, keepId: paid.id, rule: 'A' }]);
  });
  it('B: the same payment twice keeps the ticked copy, else the first', () => {
    const first = row({ billNo: '26103140', amountPaise: 3200, lineNo: 12, payments: [pay('upi', 32)] });
    const second = row({ billNo: '26103140', amountPaise: 3200, lineNo: 13, payments: [pay('upi', 32)] });
    expect(writtenTwice([first, second]).remove).toEqual([{ id: second.id, keepId: first.id, rule: 'B' }]);
    const a = row({ billNo: '26103160', amountPaise: 20400, lineNo: 7, payments: [pay('cash', 200)] });
    const b = row({ billNo: '26103160', amountPaise: 20900, lineNo: 11, status: 'checked', payments: [pay('cash', 200)] });
    expect(writtenTwice([a, b]).remove).toEqual([{ id: a.id, keepId: b.id, rule: 'B' }]);
    // Different payments: both stay.
    const c = row({ billNo: '26103172', amountPaise: 490000, payments: [pay('upi', 490)] });
    const d = row({ billNo: '26103172', amountPaise: 490000, payments: [pay('cash', 4900)] });
    expect(writtenTwice([c, d]).remove).toEqual([]);
  });
  it('B1: the group copy stays; B2 is only offered, by what the group paid', () => {
    const head = row({ billNo: '26103101', amountPaise: 219900, payments: [pay('upi', 3199)] });
    const member = row({ billNo: '145248', amountPaise: 100000, paidWithRowId: head.id });
    const loose = row({ billNo: '145248', amountPaise: 100000 });
    expect(writtenTwice([head, member, loose]).remove).toEqual([{ id: loose.id, keepId: member.id, rule: 'B1' }]);
    // The group's ₹3,199 covers this bill too: the copy with its own ₹1,000 is offered for removal.
    const own = row({ billNo: '145248', amountPaise: 100000, payments: [pay('cash', 1000)] });
    expect(writtenTwice([head, member, own])).toEqual({ remove: [], offers: [{ id: own.id, keepId: member.id, why: 'covered' }] });
    // The group's ₹2,199 fits without it: the group copy is the extra one.
    const head2 = { ...head, payments: [pay('upi', 2199)] };
    expect(writtenTwice([head2, member, own]).offers).toEqual([{ id: member.id, keepId: own.id, why: 'not_in_group' }]);
  });
  it('C: empty lines with the bill on another line, no number, or the end of the number above', () => {
    const full = row({ billNo: '26103148', amountPaise: 63500, page: 2, payments: [pay('upi', 635)] });
    const empty = row({ billNo: '26103148', amountPaise: 0, page: 3 });
    const above = row({ billNo: '26103110', amountPaise: 1448100, page: 3, lineNo: 40, payments: [pay('cash', 13000), pay('upi', 1481)] });
    const tail = row({ billNo: '3110', amountPaise: 0, page: 3, lineNo: 41 });
    const blank = row({ billNo: '', amountPaise: 0 });
    const alone = row({ billNo: '26103129', amountPaise: 0, remarks: 'x' } as never);
    const { remove } = writtenTwice([full, empty, above, tail, blank, alone]);
    expect(remove.map((x) => [x.id, x.rule])).toEqual([[empty.id, 'C'], [tail.id, 'C'], [blank.id, 'C']]);
  });
  it('never removes a ticked line, a line in a group or one a person put back', () => {
    const paid = row({ billNo: '26103150', amountPaise: 50000, payments: [pay('cash', 500)] });
    const ticked = row({ billNo: '26103150', amountPaise: 50000, status: 'checked' });
    expect(writtenTwice([paid, ticked]).remove).toEqual([]);
    const unpaid = row({ billNo: '26103150', amountPaise: 50000 });
    expect(writtenTwice([paid, unpaid], new Set([unpaid.id])).remove).toEqual([]);
  });
});

describe('On a shift', () => {
  it('removes the copies when a page is opened, lists them, and Undo puts one back for good', async () => {
    const h = await hotel();
    await h.software([['26103145', '31 12:00', 'UPI', '2861'], ['26103140', '31 12:10', 'UPI', '32']]);
    await h.register([
      { no: '26103145', amount: '2861', pays: [['upi', '2861']] },
      { no: '26103140', amount: '32', pays: [['upi', '32']] },
      { no: '26103145b', amount: '2861', pays: [['cash', '1']] },
      { no: '26103140b', amount: '32', pays: [['upi', '32']] },
    ]);
    // The copies as read: one unpaid (A), one with the same payment (B).
    await sql`UPDATE register_rows SET status = 'draft', bill_no = '26103145' WHERE id = ${h.rows['26103145b']}`;
    await sql`DELETE FROM register_payments WHERE register_row_id = ${h.rows['26103145b']}`;
    await sql`UPDATE register_rows SET status = 'draft', bill_no = '26103140' WHERE id = ${h.rows['26103140b']}`;
    const r = await h.clients.entry_staff.post(`/businesses/${h.bid}/shifts/2026-10-31/auto-tick`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.removed).toBe(2);
    const left = async () => (await sql`SELECT id FROM register_rows WHERE business_id = ${h.bid}`).map((x: any) => x.id).sort();
    expect(await left()).toEqual([h.rows['26103145'], h.rows['26103140']].sort());

    const page = (await sql`SELECT upload_id FROM register_rows WHERE id = ${h.rows['26103145']}`)[0].upload_id;
    const u = (await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads/${page}`)).json;
    const gone = u.deletedRows.filter((d: any) => d.auto);
    expect(gone.map((d: any) => d.rule).sort()).toEqual(['A', 'B']);
    expect(gone.every((d: any) => d.restorable && d.reason === 'written_twice' && !('row' in d))).toBe(true);

    // Viewers cannot put lines back; entry staff can, and Bookr leaves it from then on.
    const a = gone.find((d: any) => d.rule === 'A');
    expect((await h.clients.viewer.post(`/businesses/${h.bid}/register-rows/${a.rowId}/restore`, {})).status).toBe(403);
    const back = await h.clients.entry_staff.post(`/businesses/${h.bid}/register-rows/${a.rowId}/restore`, {});
    expect(back.status, JSON.stringify(back.json)).toBe(200);
    expect(await left()).toContain(a.rowId);
    await sql`DELETE FROM audit_log WHERE business_id = ${h.bid} AND action = 'register.auto_check'`;
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/shifts/2026-10-31/auto-tick`, {})).json.removed).toBe(0);
    expect(await left()).toContain(a.rowId);
    const u2 = (await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads/${page}`)).json;
    expect(u2.deletedRows.map((d: any) => d.rule)).toEqual(['B']);
    // Changes tells both as Bookr's, and the putting back as the person's.
    const items = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/changes`)).json.items as any[];
    expect(items.filter((x) => x.action === 'register.delete' && x.auto).length).toBe(2);
    expect(items.some((x) => x.action === 'register.restore' && !x.auto)).toBe(true);
  });
});
