// Pure Phase 2 rules: shift boundaries, coverage gaps, CSV parsing and redaction, difference types.
import { describe, expect, it } from 'vitest';
import { addDays, istDay, istToMs, missingInWindow, shiftDayOf, shiftWindow } from '../src/time';
import { csvRows, parseDateTime, parseSalesCsv } from '../src/salescsv';
import { billDistance, classify, registerMode, suggestBills } from '../src/sales';
import { parsePaise } from '../src/money';
import { buildSalesCsv, REPORT_1_NOV_EARLY, REPORT_31_OCT } from '../demo/sample-data';

describe('shift rule (8 am to 8 am, India time)', () => {
  it('07:59:59 belongs to the previous day, 08:00:00 to the same day', () => {
    expect(shiftDayOf(istToMs(2026, 10, 31, 7, 59, 59))).toBe('2026-10-30');
    expect(shiftDayOf(istToMs(2026, 10, 31, 8, 0, 0))).toBe('2026-10-31');
    expect(shiftDayOf(istToMs(2026, 11, 1, 7, 58, 30))).toBe('2026-10-31');
    expect(shiftDayOf(istToMs(2026, 11, 1, 0, 0, 0))).toBe('2026-10-31');
  });

  it('works across month and year ends', () => {
    expect(shiftDayOf(istToMs(2027, 1, 1, 3, 0, 0))).toBe('2026-12-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });

  it('uses India time, not UTC', () => {
    // 31 Oct 02:00 UTC is 31 Oct 07:30 India time: still the 30 Oct shift.
    expect(shiftDayOf(Date.UTC(2026, 9, 31, 2, 0, 0))).toBe('2026-10-30');
    expect(istDay(Date.UTC(2026, 9, 30, 19, 0, 0))).toBe('2026-10-31');
  });

  it('a shift window is exactly 24 hours from 08:00', () => {
    const w = shiftWindow('2026-10-31');
    expect(w.from).toBe(istToMs(2026, 10, 31, 8));
    expect(w.to - w.from).toBe(24 * 3600 * 1000);
  });
});

describe('coverage gaps', () => {
  const w = shiftWindow('2026-10-31');
  const at = (d: number, h: number, m = 0, s = 0) => istToMs(2026, d > 31 ? 11 : 10, d > 31 ? d - 31 : d, h, m, s);

  it('one day file leaves the early hours of the next day missing', () => {
    const gaps = missingInWindow(w, [{ from: at(31, 0), to: at(31, 23, 59, 59) }]);
    expect(gaps).toEqual([{ from: at(32, 0), to: w.to }]);
  });

  it('two files that meet at midnight cover the shift', () => {
    expect(missingInWindow(w, [{ from: at(31, 0), to: at(31, 23, 59, 59) }, { from: at(32, 0), to: at(32, 7, 59, 59) }])).toEqual([]);
  });

  it('a file that ends at its last bill leaves a gap, at either end', () => {
    const gaps = missingInWindow(w, [{ from: at(31, 9, 17, 38), to: at(31, 23, 40, 55) }, { from: at(32, 0, 35, 10), to: at(32, 7, 58, 30) }]);
    expect(gaps).toHaveLength(3);
    expect(gaps[0]).toEqual({ from: w.from, to: at(31, 9, 17, 38) });
    expect(gaps[2].to).toBe(w.to);
  });

  it('a report spanning several days covers every shift inside it', () => {
    const cover = [{ from: istToMs(2026, 10, 29, 0), to: istToMs(2026, 11, 2, 23, 59, 59) }];
    expect(missingInWindow(shiftWindow('2026-10-30'), cover)).toEqual([]);
    expect(missingInWindow(shiftWindow('2026-11-01'), cover)).toEqual([]);
  });
});

describe('money parsing', () => {
  it('turns rupee text into integer paise without floats', () => {
    expect(parsePaise('2,45,000.50')).toBe(24500050);
    expect(parsePaise('0.1')).toBe(10);
    expect(parsePaise('1240.50')).toBe(124050);
    expect(parsePaise('1.005')).toBeNull();
    expect(parsePaise('abc')).toBeNull();
  });
});

describe('software sales CSV', () => {
  const csv = buildSalesCsv(REPORT_31_OCT);

  it('reads every bill with its time, mode and amount in paise', () => {
    const r = parseSalesCsv(csv);
    expect(r.problems).toEqual([]);
    expect(r.bills).toHaveLength(16);
    const b = r.bills.find((x) => x.billNo === '26103121')!;
    expect(b).toMatchObject({ posNo: 'POS-1', mode: 'cash', amountPaise: 124050, paidAt: istToMs(2026, 10, 31, 21, 15, 0) });
    expect(r.bills.find((x) => x.billNo === '2610318')!.mode).toBe('unknown');
    expect(r.footer!.totalPaise).toBe(r.bills.reduce((s, x) => s + x.amountPaise, 0));
  });

  it('never returns or keeps a name', () => {
    const r = parseSalesCsv(csv);
    expect(JSON.stringify(r.bills)).not.toMatch(/Asha|Vikram|U\/N"/);
    expect(r.redacted).not.toMatch(/Asha|Vikram|Room 4/);
    const rows = csvRows(r.redacted);
    expect(rows[0][4]).toBe('NAME');
    expect(rows.slice(1, 17).every((row) => row[4] === '')).toBe(true);
    expect(r.redacted).toContain('TOTAL SALE');
  });

  it('refuses a file whose footer does not match its bills', () => {
    expect(parseSalesCsv(buildSalesCsv(REPORT_31_OCT, { breakFooter: 'count' })).problems.join(' ')).toMatch(/footer says 17/);
    expect(parseSalesCsv(buildSalesCsv(REPORT_31_OCT, { breakFooter: 'upi' })).problems.join(' ')).toMatch(/UPI bills add up/);
  });

  it('refuses bad dates, bad amounts, repeated bills and a missing footer', () => {
    const bad = buildSalesCsv([{ ...REPORT_1_NOV_EARLY[0], when: '2026-11-01 00:35' }, { ...REPORT_1_NOV_EARLY[1], amount: 'abc' }]);
    const p = parseSalesCsv(bad).problems.join(' ');
    expect(p).toMatch(/DATE\/TIME/);
    expect(p).toMatch(/BILL AMOUNT/);
    const twice = buildSalesCsv([REPORT_1_NOV_EARLY[0], REPORT_1_NOV_EARLY[0]]);
    expect(parseSalesCsv(twice).problems.join(' ')).toMatch(/appears twice/);
    const noFooter = csv.split('\r\n').filter((l) => !/TOTAL|,,UPI|,,CARD|,,CASH/.test(l)).join('\n');
    expect(parseSalesCsv(noFooter).problems.join(' ')).toMatch(/footer is missing/);
  });

  it('accepts a footer written in one cell and a byte-order mark', () => {
    const text = '﻿' + buildSalesCsv(REPORT_1_NOV_EARLY).replace(/,,TOTAL BILLS,(\d+)/, 'TOTAL BILLS : $1');
    expect(parseSalesCsv(text).problems).toEqual([]);
  });

  it('reads DATE/TIME as India time', () => {
    expect(parseDateTime('31-10-2026.09:17:38')).toBe(istToMs(2026, 10, 31, 9, 17, 38));
    expect(parseDateTime('31-13-2026.09:17:38')).toBeNull();
  });
});

describe('difference types', () => {
  it('covers every case the design lists', () => {
    expect(classify({ amount: 100, mode: 'upi' }, { amount: 100, mode: 'upi' })).toBe('match');
    expect(classify({ amount: 100, mode: 'upi' }, { amount: 90, mode: 'upi' })).toBe('amount');
    expect(classify({ amount: 100, mode: 'upi' }, { amount: 100, mode: 'cash' })).toBe('mode');
    expect(classify({ amount: 100, mode: 'upi' }, { amount: 90, mode: 'cash' })).toBe('amount_and_mode');
    expect(classify({ amount: 100, mode: 'upi' }, null)).toBe('missing_in_register');
    expect(classify(null, { amount: 100, mode: 'cash' })).toBe('missing_in_software');
    expect(classify({ amount: 0, mode: 'cash' }, { amount: 0, mode: null })).toBe('complimentary');
    expect(classify({ amount: 0, mode: 'cash' }, null)).toBe('complimentary');
  });

  it('an unknown software mode or a part-cash part-UPI register bill is a mode difference', () => {
    expect(classify({ amount: 650, mode: 'unknown' }, { amount: 650, mode: 'upi' })).toBe('mode');
    const mixed = registerMode([{ register_row_id: 'x', mode: 'cash', amount_paise: 1, column_label: null }, { register_row_id: 'x', mode: 'upi', amount_paise: 1, column_label: null }]);
    expect(mixed).toBe('mixed');
    expect(classify({ amount: 2, mode: 'upi' }, { amount: 2, mode: mixed })).toBe('mode');
  });
});

describe('bill number suggestions', () => {
  const sw = [
    { bill_no: '26103154', pos_no: 'POS-1', amount_paise: 23000, mode: 'upi', paid_at: 1 },
    { bill_no: '26103156', pos_no: 'POS-1', amount_paise: 23000, mode: 'card', paid_at: 2 },
    { bill_no: '26103157', pos_no: 'POS-1', amount_paise: 23000, mode: 'cash', paid_at: 3 },
    { bill_no: '26103160', pos_no: 'POS-1', amount_paise: 36800, mode: 'upi', paid_at: 4 },
    { bill_no: '26103199', pos_no: 'POS-1', amount_paise: 0, mode: 'cash', paid_at: 5 },
  ];
  const row = (id: string, bill_no: string, rupees: number) => ({ id, bill_no, amount_paise: rupees * 100 });

  it('an exact number needs nothing', () => {
    expect(suggestBills([row('a', '26103160', 368)], sw).get('a')).toEqual({ exact: true, options: [] });
  });

  it('a short number offers the bill ending in those digits', () => {
    const m = suggestBills([row('a', '3154', 230)], sw).get('a')!;
    expect(m.exact).toBe(false);
    expect(m.options[0]).toMatchObject({ billNo: '26103154', why: 'short', amountMatches: true });
  });

  it('a one-digit typo, a missing digit or two swapped digits is offered, same amount first', () => {
    expect(suggestBills([row('a', '26103610', 368)], sw).get('a')!.options[0]).toMatchObject({ billNo: '26103160', why: 'typo' }); // swapped
    expect(suggestBills([row('a', '2610316', 368)], sw).get('a')!.options[0]).toMatchObject({ billNo: '26103160', why: 'typo' });  // missing digit
    expect(suggestBills([row('a', '26103150', 368)], sw).get('a')!.options.map((o) => o.billNo)).toContain('26103160');          // one wrong
  });

  it('a short number with a slip is offered only when the amount matches', () => {
    expect(suggestBills([row('a', '3158', 230)], sw).get('a')!.options.map((o) => o.why)).toEqual(['short_typo', 'short_typo', 'short_typo']);
    expect(suggestBills([row('a', '3158', 999)], sw).get('a')!.options).toEqual([]);
  });

  it('with no number written, bills with the same amount are offered; complimentary bills never are', () => {
    expect(suggestBills([row('a', '', 368)], sw).get('a')!.options.map((o) => o.billNo)).toEqual(['26103160']);
    expect(suggestBills([row('a', '', 0)], sw).get('a')!.options).toEqual([]);
  });

  it('a bill already matched exactly by another row is not offered again', () => {
    const m = suggestBills([row('x', '26103154', 230), row('a', '3154', 230)], sw).get('a')!;
    expect(m.options.map((o) => o.billNo)).not.toContain('26103154');
  });

  it('typo distance counts swaps as one edit', () => {
    expect(billDistance('12345', '12354')).toBe(1);
    expect(billDistance('12345', '1245')).toBe(1);
    expect(billDistance('12345', '12345')).toBe(0);
  });
});
