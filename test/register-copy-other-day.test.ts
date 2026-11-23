// Already on another day (approved 21 Nov 2026): a register line whose bill is in another day's software report and on
// that day's register is told as such, with where it is, not as a number the software does not have. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('a register line already on another day', () => {
  it('names the day, the software bill and that day\'s register line', async () => {
    const h = await hotel();
    await h.software([['2610311', '31 12:00', 'UPI', '200'], ['2611011', '1 12:00', 'UPI', '500']]);
    await h.register([{ no: '2610311', amount: '200', pays: [['upi', '200']] },
      { no: '2610311', amount: '200', pays: [['upi', '200']], day: '2026-11-01' }, { no: '2611011', amount: '500', pays: [['upi', '500']], day: '2026-11-01' }]);
    const [first] = await sql`SELECT id, upload_id, line_no FROM register_rows WHERE business_id = ${h.bid} AND shift_day = '2026-10-31' AND bill_no = '2610311'`;
    const [copy] = await sql`SELECT id, upload_id FROM register_rows WHERE business_id = ${h.bid} AND shift_day = '2026-11-01' AND bill_no = '2610311'`;
    const page = (await h.clients.accountant.get(`/businesses/${h.bid}/uploads/${copy.upload_id}`)).json;
    const row = (id: string) => page.rows.find((r: any) => r.id === id);
    // One bill on two days (23 Nov 2026): the same payment on both lines is written twice.
    expect(row(copy.id).twoDays).toMatchObject({ kind: 'written_twice', home: { day: '2026-10-31', rowId: first.id, uploadId: first.upload_id, lineNo: first.line_no,
      amountPaise: 20000, paidPaise: 20000, mode: 'upi', swMode: 'upi', swAmountPaise: 20000 } });
    expect(page.rows.filter((r: any) => r.id !== copy.id).every((r: any) => r.twoDays === null)).toBe(true);
    // The first day's own line is in its software report: nothing said there.
    const own = (await h.clients.accountant.get(`/businesses/${h.bid}/uploads/${first.upload_id}`)).json;
    expect(own.rows.find((r: any) => r.id === first.id).twoDays).toBeNull();
  });
});
