// The Yes Bank statement (25 Nov 2026): dates only, Withdrawals and Deposits in their own columns. Invented figures.
import { describe, expect, it } from 'vitest';
import { parseStatementText } from '../src/bankstatement';

const T = (...rows: string[][]) => rows.map((r) => r.join('\t')).join('\n');

describe('a Yes Bank statement', () => {
  it('reads each line by its reference, money in and out, the day kept, and settlements kept from bill matching', () => {
    const p = parseStatementText(T(
      ['999900001111', 'SOME HOTEL PRIVATE LIMITED'],
      ['Opening Balance', 'INR 0.00'],
      [''],
      ['Transaction Date', 'Value Date', 'Description', 'Reference Number', 'Withdrawals', 'Deposits', 'Running Balance'],
      ['14/10/2026', '14/10/2026', '115000000001/800000001 UPI Collection Settlement/SOME HOTEL/CBS PAYABLE ACC', 'YESF26287000000001', '', '12,345.00', 'INR 1,12,345.00'],
      ['13/10/2026', '13/10/2026', 'IMPS/NA/XXXX0001/RRN:600000000001/PC000001/OTHER BANK LIMI/own account/IFB', 'YESI66286000000001', '50,000.00', '', 'INR 1,00,000.00'],
    ));
    expect(p.problems).toEqual([]);
    expect(p.lines).toHaveLength(2);
    const [a, b] = p.lines;
    expect(a).toMatchObject({ tranId: 'YESF26287000000001', day: '2026-10-14', direction: 'CR', amountPaise: 1234500, balancePaise: 11234500, kind: 'other', remark: 'UPI collection settlement' });
    expect(new Date(a.postedAt + 5.5 * 3600e3).toISOString().slice(11, 16)).toBe('12:00');
    expect(b).toMatchObject({ tranId: 'YESI66286000000001', day: '2026-10-13', direction: 'DR', amountPaise: 5000000, kind: 'other', upiRef: '600000000001' });
  });
});
