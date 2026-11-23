// Software report not uploaded (approved 23 Nov 2026): lines of a day with no report are not called missing from the
// software, get no other numbers offered, and Home lists the days. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { istToMs } from '../src/time';
import { completeBillNo } from '../src/ocr';
import { billDate } from '../src/reportDays';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('Software report not uploaded', () => {
  it('a full number of a day with no report is kept as written', () => {
    const sw = new Map([['26103102', 50000]]);
    expect(completeBillNo('26110102', [50000], sw, new Set(), new Map(), new Set(['261101']))).toBeNull();
    expect(billDate('26111313')).toBe('2026-11-13');
    expect(billDate('145248')).toBeNull();
  });

  it('says which days are missing, and offers nothing for their lines', async () => {
    const h = await hotel();
    // The report covers 31 Oct only: 1 Nov (the shift's last 8 hours, and the date of bill 26110102) has none.
    await h.software([['26103145', '31 12:00', 'CASH', '2861'], ['26103102', '31 12:10', 'CASH', '500']], istToMs(2026, 10, 31, 23, 59, 59));
    await h.register([
      { no: '26103145', amount: '2861', pays: [['cash', '2861']] },
      { no: '26110102', amount: '500', pays: [['cash', '500']] },
    ]);
    const page = (await sql`SELECT upload_id FROM register_rows WHERE id = ${h.rows['26110102']}`)[0].upload_id;
    const u = (await h.clients.entry_staff.get(`/businesses/${h.bid}/uploads/${page}`)).json;
    expect(u.reportMissing).toEqual(['2026-11-01']);
    const line = u.rows.find((r: any) => r.billNo === '26110102');
    expect(line.billMatch.exact).toBe(false);
    // Without the rule it would be "Same bill as 26103102? A digit or two off".
    expect(line.numberFlags).toEqual([]);

    const home = (await h.clients.owner.get(`/businesses/${h.bid}/home`)).json;
    if (Date.now() < istToMs(2026, 11, 30)) expect(home.missingReports[0]).toEqual({ day: '2026-11-01', register: false });
    expect(home.missingReports.some((m: any) => m.day === '2026-10-31')).toBe(false);
  });
});
