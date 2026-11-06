// Pure Phase 2 rules: shift boundaries, coverage gaps, CSV parsing and redaction, difference types.
import { describe, expect, it } from 'vitest';
import { addDays, istDay, istToMs, missingInWindow, shiftDayOf, shiftWindow } from '../src/time';
import { csvRows, parseDateTime, parseSalesCsv } from '../src/salescsv';
import { billDistance, classify, numberFlags, registerMode, suggestBills, withDatePrefix, type NumberContext } from '../src/sales';
import { parsePaise } from '../src/money';
import { creditsWithoutBill, pairEvidence, type EvidenceBill } from '../src/bankEvidence';
import { tableSets } from '../src/explain';
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

  it('a register bill with a discount or tip matches when the software shows its amount before them', () => {
    expect(classify({ amount: 23000, mode: 'card' }, { amount: 21900, mode: 'card', gross: 23000 })).toBe('match');   // discount 11
    expect(classify({ amount: 17900, mode: 'upi' }, { amount: 18800, mode: 'upi', gross: 17900 })).toBe('match');     // tip 9
    expect(classify({ amount: 21900, mode: 'card' }, { amount: 21900, mode: 'card', gross: 23000 })).toBe('match');   // software already net
    expect(classify({ amount: 25000, mode: 'card' }, { amount: 21900, mode: 'card', gross: 23000 })).toBe('amount');  // a real difference
    expect(classify({ amount: 23000, mode: 'upi' }, { amount: 21900, mode: 'card', gross: 23000 })).toBe('mode');     // mode still checked
    expect(classify({ amount: 21900, mode: 'card' }, { amount: 21900, mode: 'card', gross: 21900 })).toBe('match');
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

  it('a bill already matched exactly by another row is still offered, marked as on the register', () => {
    const m = suggestBills([row('x', '26103154', 230), row('a', '3154', 230)], sw).get('a')!;
    expect(m.options.find((o) => o.billNo === '26103154')?.taken).toBe(true);
  });

  it('typo distance counts swaps as one edit', () => {
    expect(billDistance('12345', '12354')).toBe(1);
    expect(billDistance('12345', '1245')).toBe(1);
    expect(billDistance('12345', '12345')).toBe(0);
  });
});

describe('bank evidence on Compare sales', () => {
  const w = { from: 0, to: 24 * 3600e3 };
  const bill = (id: string, o: Partial<EvidenceBill>): EvidenceBill => ({ id, paidAt: null, difference: 'match', decision: null, grouped: false,
    swAmount: null, swMode: null, rgAmount: null, rgMode: null, ...o });
  const M = 60000;

  it('pairs by closest time, each credit once, and suggests only the UPI side the credit equals', () => {
    const bills = [
      bill('a', { paidAt: 100 * M, difference: 'mode', swAmount: 500, swMode: 'upi', rgAmount: 500, rgMode: 'cash' }),
      bill('b', { paidAt: 130 * M, difference: 'match', swAmount: 500, swMode: 'upi', rgAmount: 500, rgMode: 'upi' }),
      bill('c', { paidAt: 200 * M, difference: 'amount', swAmount: 900, swMode: 'upi', rgAmount: 990, rgMode: 'upi' }),
      bill('d', { paidAt: 300 * M, difference: 'mode', swAmount: 700, swMode: 'cash', rgAmount: 700, rgMode: 'card' }), // no UPI side
    ];
    const credits = [{ id: 'x', amount: 500, postedAt: 128 * M }, { id: 'y', amount: 500, postedAt: 104 * M }, { id: 'z', amount: 990, postedAt: 205 * M },
      { id: 'q', amount: 700, postedAt: 301 * M }];
    const { evidence } = pairEvidence(bills, credits, w);
    expect(evidence.get('a')).toMatchObject({ creditId: 'y', minutes: 4, suggest: 'use_software', fits: 'both' });
    expect(evidence.get('b')).toMatchObject({ creditId: 'x', suggest: null });
    expect(evidence.get('c')).toMatchObject({ creditId: 'z', suggest: 'use_register', fits: 'register' });
    expect(evidence.has('d')).toBe(false);
  });

  it('pairs a bill with no time only when it and the credit are each other\'s only choice', () => {
    const one = pairEvidence([bill('r', { difference: 'missing_in_software', rgAmount: 400, rgMode: 'upi' })], [{ id: 'k', amount: 400, postedAt: 3600e3 }], w);
    expect(one.evidence.get('r')).toMatchObject({ creditId: 'k', minutes: null });
    const two = pairEvidence([bill('r', { rgAmount: 400, rgMode: 'upi' }), bill('s', { rgAmount: 400, rgMode: 'upi' })], [{ id: 'k', amount: 400, postedAt: 3600e3 }], w);
    expect(two.evidence.size).toBe(0);
  });

  it('a credit into an account with another UPI label does not pair with the bill', () => {
    const b = bill('a', { paidAt: 100 * M, swAmount: 500, swMode: 'upi', rgAmount: 500, rgMode: 'upi', labels: 'UPI XOXO' });
    expect(pairEvidence([b], [{ id: 'x', amount: 500, postedAt: 101 * M, label: 'UPI Bank 2' }], w).evidence.size).toBe(0);
    expect(pairEvidence([b], [{ id: 'x', amount: 500, postedAt: 101 * M, label: 'UPI XOXO' }], w).evidence.get('a')).toMatchObject({ creditId: 'x' });
  });

  it('money with no bill: a credit in the shift that no bill of the shift could be', () => {
    const bills = [bill('a', { swAmount: 500, swMode: 'upi' })];
    const credits = [{ id: 'x', amount: 300, postedAt: 10 }, { id: 'y', amount: 500, postedAt: 20 }, { id: 'z', amount: 300, postedAt: w.to + 10 }];
    expect(creditsWithoutBill(credits, new Set(), bills, w).map((c) => c.id)).toEqual(['x']);
  });

  it('money with no bill: the total of bills paid together by UPI is a bill amount too', () => {
    const bills = [bill('a', { rgAmount: 200, rgMode: 'upi', grouped: true }), bill('b', { rgAmount: 100, rgMode: 'upi', grouped: true })];
    const credits = [{ id: 'x', amount: 300, postedAt: 10 }, { id: 'y', amount: 400, postedAt: 20 }];
    expect(creditsWithoutBill(credits, new Set(), bills, w, [300]).map((c) => c.id)).toEqual(['y']);
  });
});

describe('one credit for a table', () => {
  const b = (net: number, min: number) => ({ net, paidAt: min * 60000 });
  it('finds the one set of bills adding up to the credit, up to 10 bills within 45 minutes', () => {
    const bills = [b(900, 0), b(400, 5), b(350, 10), b(250, 12)].sort((x, y) => y.net - x.net);
    expect(tableSets(bills, 1000).map((s) => s.map((x) => x.net))).toEqual([[400, 350, 250]]);
    const ten = Array.from({ length: 10 }, (_, i) => b(100 + i, i));
    expect(tableSets(ten, ten.reduce((t, x) => t + x.net, 0))[0]).toHaveLength(10);
  });
  it('offers nothing when two sets fit, or the bills are too far apart', () => {
    expect(tableSets([b(500, 0), b(500, 1), b(500, 2)], 1000)).toHaveLength(2);
    expect(tableSets([b(600, 0), b(400, 60)], 1000)).toHaveLength(0);
  });
});

describe('typo flags on register numbers', () => {
  const ctx = (o: Partial<NumberContext> = {}): NumberContext => ({ day: '2026-11-01', pending: [], ranges: new Map(), taken: new Set(), ...o });
  const row = (bill_no: string, amount_paise = 53200) => ({ bill_no, amount_paise });

  it('tries the shift date, the next and previous day as a prefix, also where the number holds part of the date', () => {
    expect(withDatePrefix('110157', '2026-11-01')).toEqual(['26110157']);
    expect(withDatePrefix('76', '2026-11-01')).toEqual(expect.arrayContaining(['26110176', '26110276', '26103176']));
    expect(withDatePrefix('076', '2026-11-01')).toContain('26110176');
    expect(withDatePrefix('145232', '2026-11-01')).toEqual([]);
    expect(withDatePrefix('000', '2026-11-01')).toEqual([]);
    expect(withDatePrefix('26110157', '2026-11-01')).toEqual([]);
  });

  it('a prefixed number equal to a waiting bill with the same amount is flagged; another amount is not', () => {
    const pending = [{ billNo: '26103157', day: '2026-10-31', amountPaise: 53200 }];
    expect(numberFlags(row('157'), ctx({ pending }))).toEqual([expect.objectContaining({ kind: 'pending', billNo: '26103157', day: '2026-10-31', sameShift: false })]);
    expect(numberFlags(row('157', 100), ctx({ pending }))).toEqual([]);
    expect(numberFlags({ ...row('157', 100), gross_paise: 53200 }, ctx({ pending }))).toHaveLength(1);
  });

  it('one digit off a pending bill with the same amount is flagged, in this shift or an earlier one', () => {
    const pending = [{ billNo: '26110151', day: '2026-11-01', amountPaise: 53200 }, { billNo: '26103158', day: '2026-10-31', amountPaise: 53200 }];
    const f = numberFlags(row('26110157'), ctx({ pending }));
    expect(f).toEqual([expect.objectContaining({ kind: 'pending_typo', billNo: '26110151', sameShift: true })]);
    expect(numberFlags(row('26103168'), ctx({ pending }))).toEqual([expect.objectContaining({ kind: 'pending_typo', billNo: '26103158', sameShift: false })]);
    expect(numberFlags(row('26110157'), ctx({ pending, taken: new Set(['26110151']) }))).toEqual([]); // that bill has its own line
  });

  it('running numbers: only speaks when the reports for that date are complete', () => {
    const ranges = new Map([['261101', { max: 109, complete: true }], ['261102', { max: 40, complete: false }]]);
    expect(numberFlags(row('261101157'), ctx({ ranges }))).toEqual([expect.objectContaining({ kind: 'beyond_range', seq: 157, max: 109, date: '2026-11-01' })]);
    expect(numberFlags(row('26110199'), ctx({ ranges }))).toEqual([]);
    expect(numberFlags(row('26110299'), ctx({ ranges }))).toEqual([]);
    expect(numberFlags(row('76'), ctx({ ranges }))).toEqual([expect.objectContaining({ kind: 'in_range', billNo: '26110176', max: 109 })]);
    expect(numberFlags(row('230'), ctx({ ranges }))).toEqual([]); // past every date's range
    expect(numberFlags(row('76'), ctx({ ranges, taken: new Set(['26110176']) }))).toEqual([]);
  });

  it('an old POS number far from any date says nothing', () => {
    expect(numberFlags(row('145232'), ctx({ ranges: new Map([['261101', { max: 109, complete: true }]]) }))).toEqual([]);
  });
});
