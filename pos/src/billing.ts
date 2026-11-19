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

/**
 * How a line is taxed: GST at a rate (bp: 500 = 5%; 0 for a billing name not registered), liquor (outside GST), or exempt
 * (no GST). Both of the last two are kept apart from the taxable value.
 */
export type LineTax = { kind: 'gst'; bp: number } | { kind: 'liquor' } | { kind: 'exempt' };
/** A bill line. Without `tax`, `taxed: false` = liquor and anything else = GST at the bill's rate. */
export interface Line { qty: number; pricePaise: number; taxed?: boolean; tax?: LineTax }
/** One row of a bill's tax: all its lines of one kind and rate, after their share of the discount. */
export interface TaxRow { kind: 'gst' | 'liquor' | 'exempt'; bp: number; valuePaise: number; cgstPaise: number; sgstPaise: number }
export type Discount = { kind: 'none' } | { kind: 'pct'; bp: number } | { kind: 'amount'; paise: number };

export interface Totals {
  grossPaise: number;
  discountPaise: number;
  taxablePaise: number;
  /** Untaxed lines (liquor) after their share of the discount: outside GST, in the total, never in the taxable value. */
  nonGstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  roundOffPaise: number;
  totalPaise: number;
}

// Half away from zero on whole paise; only ever applied to non-negative values here.
const roundDiv = (n: number, d: number) => Math.floor((n * 2 + d) / (2 * d));

export const taxOf = (l: Line, gstRateBp: number): LineTax => l.tax ?? (l.taxed === false ? { kind: 'liquor' } : { kind: 'gst', bp: gstRateBp });
const KIND_ORDER = { gst: 0, liquor: 1, exempt: 2 } as const;
const taxKey = (t: LineTax) => `${t.kind}:${t.kind === 'gst' ? t.bp : 0}`;

/** Lines grouped by tax (GST rates lowest first, then liquor, then exempt), each with its gross value. */
function buckets(lines: { gross: number; tax: LineTax }[]) {
  const m = new Map<string, { tax: LineTax; gross: number }>();
  for (const l of lines) {
    const k = taxKey(l.tax);
    const b = m.get(k) ?? { tax: l.tax, gross: 0 };
    b.gross += l.gross;
    m.set(k, b);
  }
  return [...m.values()].filter((b) => b.gross > 0).sort((a, b) => KIND_ORDER[a.tax.kind] - KIND_ORDER[b.tax.kind]
    || (a.tax.kind === 'gst' && b.tax.kind === 'gst' ? a.tax.bp - b.tax.bp : 0));
}
const row = (tax: LineTax, value: number): TaxRow => {
  const half = tax.kind === 'gst' ? roundDiv(value * tax.bp, 20000) : 0;
  return { kind: tax.kind, bp: tax.kind === 'gst' ? tax.bp : 0, valuePaise: value, cgstPaise: half, sgstPaise: half };
};
function sumRows(rows: TaxRow[]) {
  const s = (f: (r: TaxRow) => number) => rows.reduce((t, r) => t + f(r), 0);
  return { taxablePaise: s((r) => (r.kind === 'gst' ? r.valuePaise : 0)), nonGstPaise: s((r) => (r.kind === 'gst' ? 0 : r.valuePaise)),
    cgstPaise: s((r) => r.cgstPaise), sgstPaise: s((r) => r.sgstPaise) };
}

/**
 * Bill totals. Prices are taken as before tax. The discount is shared over the bill's tax rows by value (each row but the
 * last takes its rounded share, the last what is left, so the shares add up exactly). GST (CGST + SGST, half each) is
 * charged per row at its own rate; liquor and exempt rows carry none and stay out of the taxable value. The total is
 * rounded to the rupee with the round-off shown. A billing name not registered for GST passes rate 0.
 */
export function billTotals(lines: Line[], discount: Discount, gstRateBp: number): Totals & { taxes: TaxRow[] } {
  const gross = lines.reduce((s, l) => s + l.qty * l.pricePaise, 0);
  let disc = 0;
  if (discount.kind === 'pct') disc = roundDiv(gross * discount.bp, 10000);
  if (discount.kind === 'amount') disc = discount.paise;
  if (disc < 0 || disc > gross) throw new Error('bad_discount');
  const bs = buckets(lines.map((l) => ({ gross: l.qty * l.pricePaise, tax: taxOf(l, gstRateBp) })));
  let left = disc;
  const taxes = bs.map((b, i) => {
    const share = i === bs.length - 1 ? left : roundDiv(b.gross * disc, gross);
    left -= share;
    return row(b.tax, b.gross - share);
  });
  const sums = sumRows(taxes);
  const raw = sums.taxablePaise + sums.nonGstPaise + sums.cgstPaise + sums.sgstPaise;
  const total = roundDiv(raw, 100) * 100;
  return { grossPaise: gross, discountPaise: disc, ...sums, roundOffPaise: total - raw, totalPaise: total, taxes };
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

/**
 * Like allocate, but the payments may come to less or more than the bills: what is still owed at the end is returned per
 * bill (a discount at payment), and what is left over is returned per payment that carried it (a tip).
 */
export function allocateLoose(payments: { id: string; amountPaise: number }[], bills: { id: string; totalPaise: number }[]) {
  const owing = bills.map((b) => ({ id: b.id, left: b.totalPaise }));
  const pieces: { paymentId: string; billId: string; amountPaise: number }[] = [];
  const over: { paymentId: string; amountPaise: number }[] = [];
  let i = 0;
  for (const p of payments) {
    let left = p.amountPaise;
    while (left > 0) {
      while (i < owing.length && owing[i].left === 0) i++;
      if (i >= owing.length) { over.push({ paymentId: p.id, amountPaise: left }); break; }
      const take = Math.min(left, owing[i].left);
      pieces.push({ paymentId: p.id, billId: owing[i].id, amountPaise: take });
      owing[i].left -= take;
      left -= take;
    }
  }
  return { pieces, over, short: owing.filter((o) => o.left > 0).map((o) => ({ billId: o.id, amountPaise: o.left })) };
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

/** Credit note number: PREFIX-CNYYYY-NNNN ('C', '2026-27', 1 → 'C-CN2627-0001'). At most 16 characters. */
export function creditNoteNo(prefix: string, fy: string, seq: number): string {
  const short = fy.length === 7 ? fy.slice(2, 4) + fy.slice(5, 7) : fy.slice(2);
  const out = `${prefix}-CN${short}-${String(seq).padStart(4, '0')}`;
  if (out.length > 16) throw new Error('cn_no_too_long');
  return out;
}

export interface BillAmounts extends Totals { gstRateBp: number; taxes?: TaxRow[] }

/** A bill's tax rows: as written, or for a bill from before rows were kept, its GST at its rate and its liquor. */
export function billTaxRows(bill: { gstRateBp: number; taxablePaise: number; nonGstPaise: number; cgstPaise: number; sgstPaise: number }, rows: TaxRow[]): TaxRow[] {
  if (rows.length) return rows;
  const out: TaxRow[] = [];
  if (bill.taxablePaise || bill.cgstPaise) out.push({ kind: 'gst', bp: bill.gstRateBp, valuePaise: bill.taxablePaise, cgstPaise: bill.cgstPaise, sgstPaise: bill.sgstPaise });
  if (bill.nonGstPaise) out.push({ kind: 'liquor', bp: 0, valuePaise: bill.nonGstPaise, cgstPaise: 0, sgstPaise: 0 });
  return out;
}

/**
 * What a credit note takes back. Credited lines carry the bill's own discount share and GST rate; values are exact to the
 * paisa (no rupee rounding). When this note credits everything still left on the bill, it takes exactly what is left,
 * so a bill and its credit notes always come to zero together.
 */
export function creditTotals(bill: BillAmounts, already: Totals, linesGross: number, lastOne: boolean, taxedLinesGross = linesGross): Totals {
  const lines: { gross: number; tax: LineTax }[] = [{ gross: taxedLinesGross, tax: { kind: 'gst', bp: bill.gstRateBp } }, { gross: linesGross - taxedLinesGross, tax: { kind: 'liquor' } }];
  const { taxes: _t, ...totals } = creditNote(bill, already, [], lines, lastOne);
  return totals;
}

/**
 * A credit note by tax row: each credited line's value takes the bill's discount share, and GST at the line's own rate.
 * When it credits everything still left on the bill, each row takes exactly what is left of it.
 */
export function creditNote(bill: BillAmounts, already: Totals, alreadyRows: TaxRow[], lines: { gross: number; tax: LineTax }[], lastOne: boolean): Totals & { taxes: TaxRow[] } {
  const billRows = billTaxRows(bill, bill.taxes ?? []);
  if (lastOne) {
    const left = (k: keyof Totals) => bill[k] - already[k];
    const taxes = billRows.map((r) => {
      const a = alreadyRows.filter((x) => x.kind === r.kind && x.bp === r.bp);
      const minus = (f: (x: TaxRow) => number) => a.reduce((t, x) => t + f(x), 0);
      return { ...r, valuePaise: r.valuePaise - minus((x) => x.valuePaise), cgstPaise: r.cgstPaise - minus((x) => x.cgstPaise), sgstPaise: r.sgstPaise - minus((x) => x.sgstPaise) };
    }).filter((r) => r.valuePaise || r.cgstPaise || r.sgstPaise);
    return { grossPaise: left('grossPaise'), discountPaise: left('discountPaise'), taxablePaise: left('taxablePaise'), nonGstPaise: left('nonGstPaise'),
      cgstPaise: left('cgstPaise'), sgstPaise: left('sgstPaise'), roundOffPaise: left('roundOffPaise'), totalPaise: left('totalPaise'), taxes };
  }
  const share = (v: number) => (bill.grossPaise ? roundDiv(v * bill.discountPaise, bill.grossPaise) : 0);
  const taxes = buckets(lines).map((b) => row(b.tax, b.gross - share(b.gross)));
  const sums = sumRows(taxes);
  const gross = lines.reduce((t, l) => t + l.gross, 0);
  const values = sums.taxablePaise + sums.nonGstPaise;
  return { grossPaise: gross, discountPaise: gross - values, ...sums, roundOffPaise: 0, totalPaise: values + sums.cgstPaise + sums.sgstPaise, taxes };
}

export { IST_OFFSET_MS };
