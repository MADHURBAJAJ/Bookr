// To do's steps (17 Nov 2026): a bill written twice is told with each line's page and line number and whether it is
// the software's amount, so the extra one can be deleted in place; a bill whose payments do not add up is told with its
// figures. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('To do: rows to correct', () => {
  it('tells each line of a bill written twice, and a bill whose payments do not add up', async () => {
    const h = await hotel();
    await h.software([['26103126', '31 13:01', 'UPI', '10206'], ['26103140', '31 15:00', 'CASH', '500']]);
    await h.register([
      { no: '26103126', amount: '10206', discount: '6', pays: [['upi', '10200']] },
      { no: '26103140', amount: '500', pays: [['cash', '450']] },
      { no: '26103126', amount: '9720', discount: '-486', pays: [['upi', '10206']] },
    ]);
    const v = (await h.view()).json;
    expect(v.repeatedLines).toEqual([{ billNo: '26103126', lines: [
      expect.objectContaining({ pageNo: 1, lineNo: 1, amountPaise: 1020600, sameAsSoftware: true, payments: [expect.objectContaining({ mode: 'upi', amountPaise: 1020000 })] }),
      expect.objectContaining({ pageNo: 1, lineNo: 3, amountPaise: 972000, sameAsSoftware: false }),
    ] }]);
    expect(v.unbalancedRows).toEqual([expect.objectContaining({ billNo: '26103140', amountPaise: 50000, paidPaise: 45000 })]);

    // Deleting the extra line (the To do button) leaves one: nothing repeated any more.
    const extra = v.repeatedLines[0].lines[1];
    expect((await h.clients.owner.del(`/businesses/${h.bid}/register-rows/${extra.rowId}`, { reason: 'written_twice' })).status).toBe(200);
    expect((await h.view()).json.repeatedLines).toEqual([]);
  });
});
