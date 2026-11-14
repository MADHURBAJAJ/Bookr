// Pure billing rules: no database here, so each rule is tested on its own (pos/test/billing.test.ts).
import { IST_OFFSET_MS, istDay } from '../../src/time';

const HOUR = 60 * 60 * 1000;

/** The shift a moment belongs to, for a business whose shift starts at `startHour` (India time). */
export function shiftDayAt(ms: number, startHour: number): string {
  return istDay(ms - startHour * HOUR);
}

/** The financial year label of a day ('2026-11-14' with an April start → '2026-27'). */
export function fyOf(day: string, startMonth: number): string {
  const [y, m] = day.split('-').map(Number);
  const start = m >= startMonth ? y : y - 1;
  if (startMonth === 1) return String(start);
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Bill number: PREFIX-YYYY-NNNNN using the FY's two short years ('C', '2026-27', 418 → 'C-2627-00418'). At most 16 characters. */
export function billNo(prefix: string, fy: string, seq: number): string {
  const short = fy.length === 7 ? fy.slice(2, 4) + fy.slice(5, 7) : fy.slice(2);
  const n = String(seq).padStart(5, '0');
  const out = `${prefix}-${short}-${n}`;
  if (out.length > 16) throw new Error('bill_no_too_long');
  return out;
}

export interface Line { qty: number; pricePaise: number }
export type Discount = { kind: 'none' } | { kind: 'pct'; bp: number } | { kind: 'amount'; paise: number };

export interface Totals {
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  roundOffPaise: number;
  totalPaise: number;
}

// Half away from zero on whole paise; only ever applied to non-negative values here.
const roundDiv = (n: number, d: number) => Math.floor((n * 2 + d) / (2 * d));

/**
 * Bill totals. Prices are taken as before tax; GST (CGST + SGST, half each) is charged on the value after discount,
 * and the total is rounded to the rupee with the round-off shown. A business not registered for GST passes rate 0.
 */
export function billTotals(lines: Line[], discount: Discount, gstRateBp: number): Totals {
  const gross = lines.reduce((s, l) => s + l.qty * l.pricePaise, 0);
  let disc = 0;
  if (discount.kind === 'pct') disc = roundDiv(gross * discount.bp, 10000);
  if (discount.kind === 'amount') disc = discount.paise;
  if (disc < 0 || disc > gross) throw new Error('bad_discount');
  const taxable = gross - disc;
  const half = roundDiv(taxable * gstRateBp, 20000);
  const raw = taxable + 2 * half;
  const total = roundDiv(raw, 100) * 100;
  return { grossPaise: gross, discountPaise: disc, taxablePaise: taxable, cgstPaise: half, sgstPaise: half, roundOffPaise: total - raw, totalPaise: total };
}

/**
 * Shares payments over bills in order: each payment fills the first bill still owing, then the next. Bills paid together
 * and a bill paid several ways come out as payment × bill pieces that add up both ways.
 */
export function allocate(payments: { id: string; amountPaise: number }[], bills: { id: string; totalPaise: number }[]): { paymentId: string; billId: string; amountPaise: number }[] {
  const owing = bills.map((b) => ({ id: b.id, left: b.totalPaise }));
  const out: { paymentId: string; billId: string; amountPaise: number }[] = [];
  let i = 0;
  for (const p of payments) {
    let left = p.amountPaise;
    while (left > 0) {
      while (i < owing.length && owing[i].left === 0) i++;
      if (i >= owing.length) throw new Error('overpaid');
      const take = Math.min(left, owing[i].left);
      out.push({ paymentId: p.id, billId: owing[i].id, amountPaise: take });
      owing[i].left -= take;
      left -= take;
    }
  }
  if (owing.some((o) => o.left !== 0)) throw new Error('underpaid');
  return out;
}

/** Where a billing name stands against its yearly limit, after adding `addPaise`. */
export function limitState(entity: { warn1_paise: number | null; warn2_paise: number | null; stop_paise: number | null }, yearPaise: number, addPaise = 0): 'ok' | 'warn1' | 'warn2' | 'stop' {
  const t = yearPaise + addPaise;
  if (entity.stop_paise !== null && t > entity.stop_paise) return 'stop';
  if (entity.warn2_paise !== null && t >= entity.warn2_paise) return 'warn2';
  if (entity.warn1_paise !== null && t >= entity.warn1_paise) return 'warn1';
  return 'ok';
}

/** Rupee text for messages: 123456 → '₹1,234.56', 100000 → '₹1,000'. */
export function rs(p: number): string {
  const neg = p < 0;
  const a = Math.abs(p);
  const r = Math.floor(a / 100).toLocaleString('en-IN');
  const ps = a % 100;
  return `${neg ? '-' : ''}₹${r}${ps ? '.' + String(ps).padStart(2, '0') : ''}`;
}

export { IST_OFFSET_MS };
