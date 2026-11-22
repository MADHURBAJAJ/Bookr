// Ticked by Bookr (approved 22 Nov 2026): a register line is ticked when the register, the software and the money agree
// (UPI or card: a credit of the register's amount and the software at most ₹50 away; cash: at most ₹5 away). A line a
// person unticked is left to them. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('Ticked by Bookr', () => {
  it('ticks only lines where all three agree, and never one a person unticked', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([
      ['2610311', '31 12:10', 'UPI', '251'], // ₹1 off, the bank has ₹250: ticked
      ['2610312', '31 12:20', 'UPI', '600'], // no credit: left
      ['2610313', '31 12:30', 'CASH', '2501'], // ₹1 rounding: ticked
      ['2610314', '31 12:40', 'CASH', '381'], // ₹119 more in cash: left
      ['2610315', '31 12:50', 'UPI', '9552'], // ₹552 less, though the bank agrees: left for a reason
      ['2610316', '31 13:00', 'UPI', '230'], // exact with a credit: ticked
    ]);
    await h.register([
      { no: '2610311', amount: '251', discount: '1', pays: [['upi', '250']] },
      { no: '2610312', amount: '600', pays: [['upi', '600']] },
      { no: '2610313', amount: '2501', discount: '1', pays: [['cash', '2500']] },
      { no: '2610314', amount: '500', pays: [['cash', '500']] },
      { no: '2610315', amount: '9552', discount: '552', pays: [['upi', '9000']] },
      { no: '2610316', amount: '230', pays: [['upi', '230']] },
    ]);
    await h.credits([['31 12:11', 250], ['31 12:52', 9000], ['31 13:01', 230], ['1 07:55', 1]]);
    await sql`UPDATE register_rows SET status = 'draft' WHERE business_id = ${h.bid}`;

    const tick = async () => {
      const r = await h.clients.entry_staff.post(`/businesses/${h.bid}/shifts/2026-10-31/auto-tick`, {});
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json.ticked as number;
    };
    const checked = async () => (await sql`SELECT bill_no FROM register_rows WHERE business_id = ${h.bid} AND status = 'checked' ORDER BY bill_no`).map((x: any) => x.bill_no);
    expect(await tick()).toBe(3);
    expect(await checked()).toEqual(['2610311', '2610313', '2610316']);
    expect(await tick()).toBe(0);

    // The page says which ones Bookr ticked.
    const page = (await sql`SELECT upload_id FROM register_rows WHERE id = ${h.rows['2610316']}`)[0].upload_id;
    const u = (await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads/${page}`)).json;
    expect(u.rows.filter((r: any) => r.autoChecked).map((r: any) => r.billNo).sort()).toEqual(['2610311', '2610313', '2610316']);

    // A person unticks one: it stays theirs.
    const untick = await h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${h.rows['2610316']}`, {
      billNo: '2610316', billType: 'fnb', amount: '230', discount: '0', status: 'draft', payments: [{ mode: 'upi', amount: '230', columnLabel: 'UPI XOXO' }] });
    expect(untick.status, JSON.stringify(untick.json)).toBe(200);
    expect(await tick()).toBe(0);
    expect(await checked()).toEqual(['2610311', '2610313']);

    // The Changes tab tells it as Bookr's.
    const items = (await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/changes`)).json.items as any[];
    expect(items.filter((x) => x.action === 'register.auto_check').length).toBe(3);
    // Viewers cannot.
    expect((await h.clients.viewer.post(`/businesses/${h.bid}/shifts/2026-10-31/auto-tick`, {})).status).toBe(403);
  });
});
