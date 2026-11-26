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

/**
 * Bill number by print date (from 19 Nov 2026): the billing name's letter, the date printed as YYMMDD (India time) and
 * the number within that day, at least 3 digits ('C', '2026-11-19', 1 → 'C261119001'). At most 16 characters (GST).
 */
export function billNo(prefix: string, printDay: string, n: number): string {
  const out = `${prefix}${printDay.slice(2, 4)}${printDay.slice(5, 7)}${printDay.slice(8, 10)}${String(n).padStart(3, '0')}`;
  if (out.length > 16) throw new Error('bill_no_too_long');
  return out;
}
/** Credit note number the same way, with CN after the letter ('C', '2026-11-19', 1 → 'CCN261119001'). */
export const creditNoteNo = (prefix: string, printDay: string, n: number) => billNo(`${prefix}CN`, printDay, n);

/**
 * How a line is taxed: GST at a rate (bp: 500 = 5%; 0 for a billing name not registered), liquor (outside GST), or exempt
 * (no GST). Both of the last two are kept apart from the taxable value.
 */
export type LineTax = { kind: 'gst'; bp: number } | { kind: 'liquor' } | { kind: 'exempt' };
/** A bill line. Without `tax`, `taxed: false` = liquor and anything else = GST at the bill's rate. */
/** `discPaise`: a discount on this line alone (an item made free, or a share off it), taken before the bill's discount. */
/** `incl`: its price already includes GST (worked out of it, not added). `sc`: it carries the bill's service charge. */
export interface Line { qty: number; pricePaise: number; taxed?: boolean; tax?: LineTax; discPaise?: number; incl?: boolean; sc?: boolean }
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
  /** Service charge, already inside the rows' values (GST is charged on it with its lines). */
  serviceChargePaise?: number;
}

// Half away from zero on whole paise; only ever applied to non-negative values here.
const roundDiv = (n: number, d: number) => Math.floor((n * 2 + d) / (2 * d));

export const taxOf = (l: Line, gstRateBp: number): LineTax => l.tax ?? (l.taxed === false ? { kind: 'liquor' } : { kind: 'gst', bp: gstRateBp });
const KIND_ORDER = { gst: 0, liquor: 1, exempt: 2 } as const;
const taxKey = (t: LineTax) => `${t.kind}:${t.kind === 'gst' ? t.bp : 0}`;

type Piece = { gross: number; tax: LineTax; incl?: boolean; sc?: boolean };
/** Lines grouped by tax (GST rates lowest first, then liquor, then exempt) and by how they are charged (price with GST
 *  in it, service charge), each with its gross value. */
function buckets(lines: Piece[]) {
  const m = new Map<string, Piece>();
  for (const l of lines) {
    const k = `${taxKey(l.tax)}:${l.incl ? 1 : 0}:${l.sc ? 1 : 0}`;
    const b = m.get(k) ?? { tax: l.tax, incl: !!l.incl, sc: !!l.sc, gross: 0 };
    b.gross += l.gross;
    m.set(k, b);
  }
  return [...m.values()].filter((b) => b.gross > 0).sort((a, b) => KIND_ORDER[a.tax.kind] - KIND_ORDER[b.tax.kind]
    || (a.tax.kind === 'gst' && b.tax.kind === 'gst' ? a.tax.bp - b.tax.bp : 0) || Number(a.incl) - Number(b.incl) || Number(a.sc) - Number(b.sc));
}
/**
 * One bucket after its share of the discount: the value before GST (a price with GST in it has its GST worked out of
 * it, so the guest pays the menu price), its service charge on that value, and half its GST (CGST = SGST), charged on
 * the service charge too. Liquor and exempt carry no GST; their service charge goes into their value.
 */
function charge(b: Piece, after: number, scBp: number) {
  const bp = b.tax.kind === 'gst' ? b.tax.bp : 0;
  const inside = !!b.incl && bp > 0;
  let half = inside ? roundDiv(after * bp, 2 * (10000 + bp)) : 0;
  const value = after - 2 * half;
  const sc = b.sc && scBp > 0 ? roundDiv(value * scBp, 10000) : 0;
  half = inside ? half + roundDiv(sc * bp, 20000) : roundDiv((value + sc) * bp, 20000);
  return { value: value + sc, sc, half };
}
/** Buckets with their discount shares into tax rows, one per kind and rate, and the service charge in them. */
function rowsOf(bs: Piece[], shares: number[], scBp: number) {
  const m = new Map<string, TaxRow>();
  let sc = 0;
  bs.forEach((b, i) => {
    const x = charge(b, b.gross - shares[i], scBp);
    sc += x.sc;
    const k = taxKey(b.tax);
    const r = m.get(k) ?? { kind: b.tax.kind, bp: b.tax.kind === 'gst' ? b.tax.bp : 0, valuePaise: 0, cgstPaise: 0, sgstPaise: 0 };
    r.valuePaise += x.value; r.cgstPaise += x.half; r.sgstPaise += x.half;
    m.set(k, r);
  });
  return { rows: [...m.values()], sc };
}
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
export function billTotals(lines: Line[], discount: Discount, gstRateBp: number, serviceChargeBp = 0): Totals & { taxes: TaxRow[] } {
  const gross = lines.reduce((s, l) => s + l.qty * l.pricePaise, 0);
  // Line discounts first, each off its own line (so its own tax row); the bill's discount then shares the rest by value.
  const lineDisc = lines.reduce((s, l) => s + (l.discPaise ?? 0), 0);
  if (lines.some((l) => (l.discPaise ?? 0) < 0 || (l.discPaise ?? 0) > l.qty * l.pricePaise)) throw new Error('bad_discount');
  const base = gross - lineDisc;
  let disc = 0;
  if (discount.kind === 'pct') disc = roundDiv(base * discount.bp, 10000);
  if (discount.kind === 'amount') disc = discount.paise;
  if (disc < 0 || disc > base) throw new Error('bad_discount');
  const bs = buckets(lines.map((l) => ({ gross: l.qty * l.pricePaise - (l.discPaise ?? 0), tax: taxOf(l, gstRateBp), incl: l.incl, sc: l.sc })));
  let left = disc;
  const shares = bs.map((b, i) => {
    const share = i === bs.length - 1 ? left : roundDiv(b.gross * disc, base);
    left -= share;
    return share;
  });
  const { rows: taxes, sc } = rowsOf(bs, shares, serviceChargeBp);
  const sums = sumRows(taxes);
  const raw = sums.taxablePaise + sums.nonGstPaise + sums.cgstPaise + sums.sgstPaise;
  const total = roundDiv(raw, 100) * 100;
  return { grossPaise: gross, discountPaise: lineDisc + disc, ...sums, roundOffPaise: total - raw, totalPaise: total, serviceChargePaise: sc, taxes };
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

export interface BillAmounts extends Totals { gstRateBp: number; taxes?: TaxRow[]; serviceChargeBp?: number }

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
export function creditNote(bill: BillAmounts, already: Totals, alreadyRows: TaxRow[], lines: Piece[], lastOne: boolean): Totals & { taxes: TaxRow[] } {
  const billRows = billTaxRows(bill, bill.taxes ?? []);
  if (lastOne) {
    const left = (k: Exclude<keyof Totals, 'serviceChargePaise'>) => bill[k] - already[k];
    const taxes = billRows.map((r) => {
      const a = alreadyRows.filter((x) => x.kind === r.kind && x.bp === r.bp);
      const minus = (f: (x: TaxRow) => number) => a.reduce((t, x) => t + f(x), 0);
      return { ...r, valuePaise: r.valuePaise - minus((x) => x.valuePaise), cgstPaise: r.cgstPaise - minus((x) => x.cgstPaise), sgstPaise: r.sgstPaise - minus((x) => x.sgstPaise) };
    }).filter((r) => r.valuePaise || r.cgstPaise || r.sgstPaise);
    return { grossPaise: left('grossPaise'), discountPaise: left('discountPaise'), taxablePaise: left('taxablePaise'), nonGstPaise: left('nonGstPaise'),
      cgstPaise: left('cgstPaise'), sgstPaise: left('sgstPaise'), roundOffPaise: left('roundOffPaise'), totalPaise: left('totalPaise'),
      serviceChargePaise: (bill.serviceChargePaise ?? 0) - (already.serviceChargePaise ?? 0), taxes };
  }
  const share = (v: number) => (bill.grossPaise ? roundDiv(v * bill.discountPaise, bill.grossPaise) : 0);
  const bs = buckets(lines);
  const shares = bs.map((b) => share(b.gross));
  const { rows: taxes, sc } = rowsOf(bs, shares, bill.serviceChargeBp ?? 0);
  const sums = sumRows(taxes);
  const gross = lines.reduce((t, l) => t + l.gross, 0);
  const values = sums.taxablePaise + sums.nonGstPaise;
  return { grossPaise: gross, discountPaise: shares.reduce((t, x) => t + x, 0), ...sums, roundOffPaise: 0, totalPaise: values + sums.cgstPaise + sums.sgstPaise,
    serviceChargePaise: sc, taxes };
}

export { IST_OFFSET_MS };
