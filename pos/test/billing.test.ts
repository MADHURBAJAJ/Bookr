import { describe, expect, it } from 'vitest';
import { allocate, billNo, billTotals, fyOf, limitState, rs, shiftDayAt } from '../src/billing';
import { istToMs } from '../../src/time';

describe('shift day and financial year', () => {
  it('cuts the shift at the business start hour, India time', () => {
    expect(shiftDayAt(istToMs(2026, 11, 14, 7, 59), 8)).toBe('2026-11-13');
    expect(shiftDayAt(istToMs(2026, 11, 14, 8, 0), 8)).toBe('2026-11-14');
    expect(shiftDayAt(istToMs(2026, 11, 14, 5, 30), 6)).toBe('2026-11-13');
    expect(shiftDayAt(istToMs(2026, 11, 14, 0, 30), 0)).toBe('2026-11-14');
  });
  it('labels the financial year from its start month', () => {
    expect(fyOf('2026-11-14', 4)).toBe('2026-27');
    expect(fyOf('2027-03-31', 4)).toBe('2026-27');
    expect(fyOf('2027-04-01', 4)).toBe('2027-28');
    expect(fyOf('2026-11-14', 1)).toBe('2026');
  });
});

describe('bill numbers', () => {
  it('uses prefix, short year and a 5-digit running number, within 16 characters', () => {
    expect(billNo('C', '2026-27', 418)).toBe('C-2627-00418');
    expect(billNo('H3', '2026-27', 7)).toBe('H3-2627-00007');
    expect(billNo('ABCD', '2026-27', 123456)).toBe('ABCD-2627-123456');
    expect(billNo('ABCD', '2026-27', 123456).length).toBeLessThanOrEqual(16);
  });
});

describe('bill totals', () => {
  const lines = [{ qty: 2, pricePaise: 18000 }, { qty: 1, pricePaise: 6000 }]; // ₹420
  it('adds 5% GST as CGST and SGST halves and rounds to the rupee', () => {
    expect(billTotals(lines, { kind: 'none' }, 500)).toEqual({
      grossPaise: 42000, discountPaise: 0, taxablePaise: 42000, cgstPaise: 1050, sgstPaise: 1050, roundOffPaise: 0, totalPaise: 44100,
    });
  });
  it('charges GST after the discount', () => {
    const t = billTotals(lines, { kind: 'pct', bp: 1000 }, 500); // 10% off 420 = 378; GST 18.90
    expect(t.discountPaise).toBe(4200);
    expect(t.taxablePaise).toBe(37800);
    expect(t.cgstPaise).toBe(945);
    expect(t.totalPaise).toBe(39700); // 396.90 rounds to 397
    expect(t.roundOffPaise).toBe(10);
  });
  it('rounds down when under half a rupee', () => {
    const t = billTotals([{ qty: 1, pricePaise: 10500 }], { kind: 'none' }, 500); // 105 + 5.26 (2.63 x 2) = 110.26
    expect(t.totalPaise).toBe(11000);
    expect(t.roundOffPaise).toBe(-26);
  });
  it('charges no GST for a billing name not registered', () => {
    const t = billTotals(lines, { kind: 'amount', paise: 2000 }, 0);
    expect(t).toMatchObject({ discountPaise: 2000, taxablePaise: 40000, cgstPaise: 0, sgstPaise: 0, totalPaise: 40000 });
  });
  it('refuses a discount larger than the bill', () => {
    expect(() => billTotals(lines, { kind: 'amount', paise: 50000 }, 500)).toThrow();
  });
});

describe('sharing payments over bills', () => {
  it('fills bills in order: one payment for two bills (paid together)', () => {
    expect(allocate([{ id: 'p', amountPaise: 1000 }], [{ id: 'a', totalPaise: 600 }, { id: 'b', totalPaise: 400 }])).toEqual([
      { paymentId: 'p', billId: 'a', amountPaise: 600 }, { paymentId: 'p', billId: 'b', amountPaise: 400 },
    ]);
  });
  it('splits two payments over two bills so both sides add up', () => {
    const out = allocate([{ id: 'cash', amountPaise: 700 }, { id: 'upi', amountPaise: 300 }], [{ id: 'a', totalPaise: 600 }, { id: 'b', totalPaise: 400 }]);
    expect(out).toEqual([
      { paymentId: 'cash', billId: 'a', amountPaise: 600 }, { paymentId: 'cash', billId: 'b', amountPaise: 100 }, { paymentId: 'upi', billId: 'b', amountPaise: 300 },
    ]);
  });
  it('refuses more or less than the bills', () => {
    expect(() => allocate([{ id: 'p', amountPaise: 1100 }], [{ id: 'a', totalPaise: 1000 }])).toThrow('overpaid');
    expect(() => allocate([{ id: 'p', amountPaise: 900 }], [{ id: 'a', totalPaise: 1000 }])).toThrow('underpaid');
  });
});

describe('yearly limits', () => {
  const e = { warn1_paise: 1500000_00, warn2_paise: 1800000_00, stop_paise: 1950000_00 };
  it('warns at each level and stops past the stop point', () => {
    expect(limitState(e, 1000000_00)).toBe('ok');
    expect(limitState(e, 1499999_00, 100)).toBe('warn1');
    expect(limitState(e, 1800000_00)).toBe('warn2');
    expect(limitState(e, 1949999_00, 200)).toBe('stop');
    expect(limitState({ warn1_paise: null, warn2_paise: null, stop_paise: null }, 9e12)).toBe('ok');
  });
  it('formats rupees', () => {
    expect(rs(123456)).toBe('₹1,234.56');
    expect(rs(2000000_00)).toBe('₹20,00,000');
  });
});
