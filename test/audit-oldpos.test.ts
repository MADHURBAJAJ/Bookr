// Old POS bills (approved 9 Nov 2026): 140000–159999, or the last 3 digits of one, are counted from the register on
// Reconcile in one click; a short number that fits a new POS bill stays with a person. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { bill, hotel } from './auditKit';
import { fullOldPos, isOldPosBill, isShortOldPos } from '../src/sales';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('old POS numbers', () => {
  it('a full number is 140000–159999', () => {
    expect(['140000', '145232', '159999'].every(isOldPosBill)).toBe(true);
    expect(['139999', '160000', '14523', '1452321', '26110157', '', null].some(isOldPosBill)).toBe(false);
  });
  it('3 digits are old POS only with a whole software report, an old POS still in use, and no new POS bill they could be', () => {
    expect(isShortOldPos('231', [], true, true)).toBe(true);
    expect(isShortOldPos('231', [], false, true)).toBe(false); // the report does not cover the shift
    expect(isShortOldPos('231', [], true, false)).toBe(false); // no full old POS number for a week
    expect(isShortOldPos('157', [{ kind: 'pending' } as never], true, true)).toBe(false);
    expect(['23', '2310', '23a', ''].some((n) => isShortOldPos(n, [], true, true))).toBe(false);
  });
  it('the full number comes from the full old POS numbers around it on the page', () => {
    const page = [
      { bill_no: '145230', line_no: 1, upload_id: 'p' },
      { bill_no: '231', line_no: 2, upload_id: 'p' },
      { bill_no: '145235', line_no: 3, upload_id: 'p' },
    ];
    expect(fullOldPos(page[1], page)).toBe('145231');
    expect(fullOldPos({ bill_no: '231', line_no: 1, upload_id: 'q' }, page)).toBeNull(); // another page
  });
});

describe('old POS bills on Compare and Reconcile', () => {
  it('full and short old POS bills are listed ticked on Reconcile and counted from the register in one go; a short new POS number stays', async () => {
    const h = await hotel();
    await h.software([
      ['2610311', '31 12:00', 'CASH', '250'],
      ['261031157', '31 13:00', 'CASH', '600'], // written as "157" in the register
      ['2610312', '1 07:59', 'CASH', '1'],
    ]);
    await h.register([
      { no: '2610311', amount: '250', pays: [['cash', '250']] },
      { no: '145230', amount: '300', pays: [['cash', '300']] },
      { no: '231', amount: '400', pays: [['cash', '400']] },
      { no: '145235', amount: '500', pays: [['cash', '500']] },
      { no: '157', amount: '600', pays: [['cash', '600']] },
      { no: '2610312', amount: '1', pays: [['cash', '1']] },
    ]);
    const v = await h.view();
    expect(v.json.oldPos).toMatchObject({ lastSeen: '2026-10-31', inUse: true });
    expect(bill(v, '145230').oldPos).toMatchObject({ kind: 'full' });
    expect(bill(v, '231').oldPos).toMatchObject({ kind: 'short', fullNo: '145231' });
    expect(bill(v, '157').oldPos).toBeNull();

    const r = await h.reconcile();
    const list = r.oldPos.bills;
    expect(list.map((b: any) => b.billNo).sort()).toEqual(['145230', '145235', '231']);
    expect(list.every((b: any) => b.reviewed)).toBe(true);
    // The one button: full ones as "Old POS bill", short ones as "Old POS bill, short number".
    for (const [note, kind] of [['Old POS bill', 'full'], ['Old POS bill, short number', 'short']]) {
      const ids = list.filter((b: any) => b.kind === kind).map((b: any) => b.comparisonId);
      const res = await h.clients.accountant.post(`/businesses/${h.bid}/shifts/2026-10-31/register-only`, { ids, note });
      expect(res.json).toMatchObject({ decided: ids.length, skipped: [] });
    }
    const after = await h.view();
    expect(bill(after, '231')).toMatchObject({ decision: 'use_register', note: 'Old POS bill, short number' });
    expect(bill(after, '145235')).toMatchObject({ decision: 'use_register', note: 'Old POS bill' });
    expect(bill(after, '157').decision).toBeFalsy();
    expect((await h.reconcile()).oldPos.bills).toEqual([]);

    // A week with no full old POS number: 3 digits are no longer taken as old POS.
    const later = await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-11-10`);
    expect(later.json.oldPos).toMatchObject({ lastSeen: '2026-10-31', inUse: false });
  });
});
