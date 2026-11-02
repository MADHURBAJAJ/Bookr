import { describe, expect, it } from 'vitest';
import { spreadDifference } from '../src/discounts';

const r = (id: string, rupees: number) => ({ id, amountPaise: rupees * 100 });

describe('discount or tip for bills paid together', () => {
  it('spreads a discount larger than the paying row over the group by amount, adding up exactly', () => {
    const s = spreadDifference(r('4', 3481), [r('3', 385), r('5', 1626), r('6', 13820), r('7', 795)], 860000)!;
    const total = [...s.values()].reduce((t, v) => t + v.discountPaise, 0);
    expect(total).toBe(2010700 - 860000);
    for (const [id, v] of s) expect(v.discountPaise).toBeLessThanOrEqual({ 4: 348100, 3: 38500, 5: 162600, 6: 1382000, 7: 79500 }[id]!);
    expect(s.get('6')!.discountPaise).toBeGreaterThan(s.get('4')!.discountPaise);
  });
  it('a tip goes on the row with the payment', () => {
    const s = spreadDifference(r('a', 100), [r('b', 50)], 16000)!;
    expect(s.get('a')).toEqual({ discountPaise: 0, tipPaise: 1000 });
    expect(s.get('b')).toEqual({ discountPaise: 0, tipPaise: 0 });
  });
  it('a single bill takes the whole discount; more discount than the bills is not explained', () => {
    expect(spreadDifference(r('a', 131), [], 13000)!.get('a')!.discountPaise).toBe(100);
    expect(spreadDifference(r('a', 100), [], 0)!.get('a')!.discountPaise).toBe(10000);
    expect(spreadDifference(r('a', 100), [], -5)).toBeNull();
  });
  it('rounding paise never pushes a bill over its amount', () => {
    const s = spreadDifference(r('a', 1), [r('b', 1), r('c', 1)], 1)!;
    expect([...s.values()].reduce((t, v) => t + v.discountPaise, 0)).toBe(299);
    for (const v of s.values()) expect(v.discountPaise).toBeLessThanOrEqual(100);
  });
});
