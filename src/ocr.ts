// "Read page": turns a photo of a register page, expense list or cash summary into draft rows.
// Nothing read here is ever confirmed or approved automatically; every row stays a draft for a person.
// Cells Claude could not read with confidence are listed in ocr_original.unclear and shown as "Needs input".

import { z } from 'zod';
import { newId, now, stmt, type DB } from './db';
import { parsePaise } from './money';
import type { PageImage } from './claude';
import { byName, inText, pickHead, type Party, type PastLine } from './parties';
import { spreadDifference } from './discounts';

const Orientation = z.enum(['upright', 'rotated_90_clockwise', 'rotated_180', 'rotated_90_counterclockwise']);
const Amount = z.string().nullable().describe('Digits exactly as written, with a decimal point if written, no currency sign. null if unreadable or blank.');
const Unclear = z.array(z.string()).describe('Names of the fields in this item you could not read with confidence.');

export const RegisterReading = z.object({
  orientation: Orientation,
  legible: z.boolean().describe('false if the page as a whole is too blurred, dark or cut off to read.'),
  page_total: Amount.describe('The total written at the bottom of the page, or null if none.'),
  rows: z.array(z.object({
    line: z.number().int(),
    bill_no: z.string().nullable(),
    bill_type: z.enum(['fnb', 'room', 'unclear']),
    amount: Amount,
    discount: Amount.describe('Discount written for this bill, if any. null when none is written.'),
    payments: z.array(z.object({
      column: z.string().describe('Column heading the amount is written under, e.g. "Cash", "UPI XOXO", "UPI Bank 2", "Card".'),
      mode: z.enum(['cash', 'upi', 'card']),
      amount: Amount,
    })),
    remarks: z.string().nullable(),
    paid_with_line: z.number().int().nullable().describe('If this bill has no payment of its own because one amount written on another line (often joined by a bracket or brace across rows) pays for several bills, the line number where that amount is written. Otherwise null.'),
    unclear: Unclear,
  })),
});

// Register pages are read as a grid first: the printed headings, then every line cell by cell under them.
// Bookr builds the bill rows from the grid (see gridToReading), so a payment stays on the line it is written on.
export const RegisterGrid = z.object({
  orientation: Orientation,
  legible: z.boolean().describe('false if the page as a whole is too blurred, dark or cut off to read.'),
  page_total: Amount.describe('The total written at the bottom of the page, or null if none.'),
  headings: z.array(z.string()).describe('The printed column headings, left to right, exactly as printed.'),
  lines: z.array(z.object({
    line: z.number().int().describe('Position of this line on the page: 1 for the first bill line, 2 for the next, and so on.'),
    cells: z.array(z.string().nullable()).describe('One entry per heading, in the same order: the cell exactly as written. null if the cell is blank or holds only a dash.'),
    paid_with_line: z.number().int().nullable().describe('If this bill has no payment of its own because one amount written on another line (often joined by a bracket or brace across rows) pays for several bills, the "line" where that amount is written. Otherwise null.'),
    unclear_columns: z.array(z.string()).describe('Headings of the cells on this line you could not read with confidence.'),
  })),
});

export const ExpenseReading = z.object({
  orientation: Orientation,
  legible: z.boolean(),
  page_total: Amount,
  rows: z.array(z.object({
    line: z.number().int(),
    item: z.string().nullable(),
    vendor: z.string().nullable().describe('The shop or vendor the money was paid to, if the line names one (e.g. "Blinkit", "Ramesh vegetables"). null if none.'),
    amount: Amount,
    unclear: Unclear,
  })),
});

export const SummaryReading = z.object({
  orientation: Orientation,
  legible: z.boolean(),
  opening: Amount,
  received: Amount,
  balance: Amount,
  expenses: Amount,
  cash_in_hand: Amount,
  unclear: Unclear,
});

const COMMON = `Read the page exactly as written. The photo may be sideways or upside down: say how it is turned in "orientation", and read it in the correct direction.
Copy every number digit for digit. Never add up, correct, round or guess a value. If a cell is blank, return null. If you cannot read a cell with confidence, return your best reading and put that field's name in "unclear"; if you cannot read it at all, return null and list it in "unclear".
Ignore printed headings, ruled lines and any "SAMPLE" stamp.`;

export const INSTRUCTIONS = {
  bill_register: `This is a page of a hotel's handwritten bill register, a ruled table. Each line is one settled bill.
Read it as a grid. First list the printed column headings, left to right, in "headings" (for example: S.No, Bill No, Bill Amt, Type, Cash, UPI XOXO, UPI Bank 2, Card, Remarks). If a column has no printed heading, give it a short name of your own.
Then, for every bill line in page order, give "cells": one entry per heading, in the same order, holding exactly what is written in that cell on that line. Follow the ruled line across the page so that every value stays on its own line; never move a value up or down to another line. A blank cell or a dash is null.
Write the bill type cell as written (for example "F&B", "Room"). A discount written in the remarks (such as "Disc 20") stays in the remarks cell.
Sometimes one amount pays for several bills: it is written once, often with a bracket or brace joining those lines. Keep the amount in the cell where it is written, leave the other lines' payment cells null, and set their "paid_with_line" to the line where it is written. Otherwise "paid_with_line" is null.
List in "unclear_columns" the headings of any cells on that line you could not read with confidence.
${COMMON}`,
  expense_list: `This is a handwritten list of cash expenses for one day. Each line has an item and an amount.
Return one item in "rows" for every expense line, in page order. Do not include the total line as a row; put it in "page_total".
If a line names who was paid (a shop, app, staff member or person, e.g. "Blinkit", "Zepto", "Ramesh veg", "Raju salary"), put that in "vendor"; keep the item text as written.
Field names for "unclear": item, amount.
${COMMON}`,
  cash_summary: `This is a handwritten cash account summary for one day. It shows: opening balance, received (total received), balance, expenses (total), and cash in hand.
Field names for "unclear": opening, received, balance, expenses, cash_in_hand.
${COMMON}`,
} as const;

export type ReadableKind = keyof typeof INSTRUCTIONS;
export const SCHEMAS = { bill_register: RegisterGrid, expense_list: ExpenseReading, cash_summary: SummaryReading } as const;

/** Rupee text from the page → paise, or null when it is missing or not a clean amount. */
const amount = (v: string | null | undefined) => (v == null || v.trim() === '' ? null : parsePaise(v));

interface Ctx { db: DB; businessId: string; uploadId: string; day: string; model: string }

const base = (ctx: Ctx, orientation: string) => ({ engine: 'claude_vision', model: ctx.model, orientation, readAt: now() });

type Reading = z.infer<typeof RegisterReading>;
type Grid = z.infer<typeof RegisterGrid>;
type Role = 'line' | 'bill_no' | 'amount' | 'type' | 'discount' | 'cash' | 'upi' | 'card' | 'remarks' | null;

/** What a printed register heading holds. Unknown headings (closure time and the like) are ignored. */
export function headingRole(h: string): Role {
  const x = h.toLowerCase().replace(/[^a-z0-9&#]+/g, ' ').trim();
  if (/^(s ?no|sl|sr|sno|serial|#|no)\b/.test(x) && !/bill/.test(x)) return 'line';
  if (/upi|gpay|g pay|paytm|phonepe|qr/.test(x)) return 'upi';
  if (/card|swipe|pos\b/.test(x)) return 'card';
  if (/cash/.test(x)) return 'cash';
  if (/disc/.test(x)) return 'discount';
  if (/amt|amount|total|rs\b|value/.test(x)) return 'amount';
  if (/bill|inv/.test(x)) return 'bill_no';
  if (/type|f ?& ?b|room/.test(x)) return 'type';
  if (/remark|note|comment/.test(x)) return 'remarks';
  return null;
}

/** This hotel's register, used when the printed headings cannot be told apart. */
export const DEFAULT_HEADINGS = ['S.No', 'Bill No', 'Bill Amt', 'Type', 'Cash', 'UPI XOXO', 'UPI Bank 2', 'Card', 'Remarks'];

const typeOf = (v: string | null): Reading['rows'][number]['bill_type'] => {
  if (!v) return 'unclear';
  const x = v.toLowerCase();
  if (/room|\brm\b/.test(x)) return 'room';
  if (/f\s*[&+/]?\s*b|food|bar|fnb|rest/.test(x)) return 'fnb';
  return 'unclear';
};
const blank = (v: string | null | undefined) => v == null || /^[\s\-–—_.]*$/.test(v) || /^nil$/i.test(v.trim());

/** The grid Claude read → bill rows: each cell is taken from the column whose heading names it. */
export function gridToReading(g: Grid): Reading {
  let headings = g.headings;
  let roles = headings.map(headingRole);
  if (!roles.includes('amount') || !roles.some((r) => r === 'cash' || r === 'upi' || r === 'card')) {
    headings = DEFAULT_HEADINGS;
    roles = headings.map(headingRole);
  }
  const field = (r: Role) => (r === 'cash' || r === 'upi' || r === 'card' ? 'payments' : r === 'line' || r === null ? null : r === 'type' ? 'bill_type' : r);
  return {
    orientation: g.orientation, legible: g.legible, page_total: g.page_total,
    rows: g.lines.map((l) => {
      const unclear = new Set<string>();
      // A line with the wrong number of cells cannot be placed under the headings with confidence.
      if (l.cells.length !== headings.length) { unclear.add('amount'); unclear.add('payments'); }
      for (const u of l.unclear_columns) {
        const i = headings.findIndex((h) => h.trim().toLowerCase() === u.trim().toLowerCase());
        const f = field(i >= 0 ? roles[i] : headingRole(u));
        if (f) unclear.add(f);
      }
      const cell = (r: Role) => { const i = roles.indexOf(r); const v = i >= 0 ? l.cells[i] ?? null : null; return blank(v) ? null : v!.trim(); };
      const payments = roles.flatMap((r, i) => {
        if (r !== 'cash' && r !== 'upi' && r !== 'card') return [];
        const v = l.cells[i];
        if (blank(v)) return [];
        const paise = parsePaise(v!.trim());
        if (paise === 0) return [];
        return [{ column: headings[i], mode: r, amount: v!.trim() }];
      });
      const remarks = cell('remarks');
      let discount = cell('discount');
      const inRemark = remarks?.match(/\bdis(?:c(?:ount)?)?\.?\s*[:=\-]?\s*(?:rs\.?|₹)?\s*(\d+(?:\.\d+)?)/i);
      if (!discount && inRemark) discount = inRemark[1];
      return { line: l.line, bill_no: cell('bill_no'), bill_type: typeOf(cell('type')), amount: cell('amount'), discount, payments,
        remarks, paid_with_line: l.paid_with_line, unclear: [...unclear] };
    }),
  };
}

/** Reading as Claude returned it: a grid (now) or bill rows (pages read before grids). */
export const asReading = (data: Grid | Reading): Reading => ('lines' in data ? gridToReading(data) : data);

const explainedInRemark = (r: string | null) => !!r && /dis|tip|less|off|comp|nc\b|round|kot|credit|due/i.test(r);

// A tip larger than this share of the bill, or a discount larger than LARGE_DISCOUNT_PCT, is not taken as explained.
const LARGE_TIP_PCT = 10;
const LARGE_DISCOUNT_PCT = 20;

export interface DraftRow {
  id: string; line: number; read: Reading['rows'][number]; billNo: string; amt: number | null; disc: number | null; tip: number;
  pays: { column: string; mode: 'cash' | 'upi' | 'card'; paise: number | null }[];
  unclear: Set<string>; inferred: string[]; paidWith: string | null; completedFrom?: string;
}

export interface Slip { direction: 'down' | 'up'; lines: number[] }

/**
 * Payments read one line off: on several lines in a row, what was paid fits the bill amount of the next line
 * ("up": the payment sits a line above its bill) or of the line before ("down"). Bills paid together break a run.
 * Returns the longest run of at least two such lines, as the lines whose payments would move.
 */
export function findSlip(rows: { line: number; amt: number | null; paid: number | null; grouped: boolean }[]): Slip | null {
  // A payment fits a bill when the difference could be an ordinary discount or tip (up to 20% less, 10% more).
  const fits = (paid: number | null, amt: number | null) => paid !== null && amt !== null && amt > 0
    && paid * 100 >= amt * (100 - LARGE_DISCOUNT_PCT) && paid * 100 <= amt * (100 + LARGE_TIP_PCT);
  // A run carries on through lines whose payment fits either bill; it needs at least two lines whose payment
  // does not fit their own bill at all.
  let best: Slip | null = null;
  for (const direction of ['up', 'down'] as const) {
    let run: number[] = [];
    let clear = 0;
    const close = () => { if (clear >= 2 && (!best || run.length > best.lines.length)) best = { direction, lines: [...run] }; run = []; clear = 0; };
    for (let i = 0; i + 1 < rows.length; i++) {
      const [a, b] = [rows[i], rows[i + 1]];
      // "up": line a holds line b's payment. "down": line b holds line a's payment.
      const [holder, bill] = direction === 'up' ? [a, b] : [b, a];
      if (!a.grouped && !b.grouped && fits(holder.paid, bill.amt)) {
        run.push(holder.line);
        if (!fits(holder.paid, holder.amt)) clear++;
      } else close();
    }
    close();
  }
  return best;
}

/** Bill rows for a reading: values, bills paid together, short bill numbers completed, differences filled or marked. */
export function draftRegisterRows(r: Reading, opts: { softwareBills?: string[]; takenBills?: string[] } = {}): DraftRow[] {
  const rows: DraftRow[] = r.rows.map((row) => {
    const unclear = new Set(row.unclear);
    const amt = amount(row.amount);
    if (amt === null) unclear.add('amount');
    let disc = amount(row.discount);
    if (row.discount && disc === null) unclear.add('discount');
    if (disc !== null && (disc < 0 || disc > (amt ?? 0))) { unclear.add('discount'); disc = null; }
    if (!row.bill_no) unclear.add('bill_no');
    // Most sales are F&B: an unreadable type is taken as F&B and shown as assumed, for a person to change if wrong.
    const assumedType = row.bill_type === 'unclear';
    const pays = row.payments.map((p) => ({ column: p.column, mode: p.mode, paise: amount(p.amount) }));
    if (pays.some((p) => p.paise === null)) unclear.add('payments');
    return { id: newId(), line: row.line, read: row, billNo: row.bill_no?.trim() ?? '', amt, disc, tip: 0, pays, unclear,
      inferred: assumedType ? ['bill_type'] : [], paidWith: null };
  });

  // Short bill numbers ("3114" for 26103114): completed when exactly one bill of the shift's software report ends
  // with them and no other register line has it. Several candidates: left as written and marked unclear.
  const sw = new Set(opts.softwareBills ?? []);
  if (sw.size) {
    const used = new Set([...(opts.takenBills ?? []), ...rows.map((x) => x.billNo).filter((b) => sw.has(b))]);
    for (const x of rows) {
      if (!/^\d{2,}$/.test(x.billNo) || sw.has(x.billNo)) continue;
      const found = [...sw].filter((b) => b.length > x.billNo.length && b.endsWith(x.billNo) && !used.has(b));
      if (found.length === 1) {
        x.completedFrom = x.billNo; x.billNo = found[0]; used.add(found[0]);
        x.inferred.push('bill_no');
      } else if (found.length > 1) x.unclear.add('bill_no');
    }
  }

  // Bills paid together: a row pointing at the line where one shared payment is written. No chains.
  const byLine = new Map(rows.map((x) => [x.line, x]));
  for (const x of rows) {
    const head = x.read.paid_with_line != null ? byLine.get(x.read.paid_with_line) : undefined;
    if (!head || head === x || head.read.paid_with_line != null) continue;
    x.paidWith = head.id;
    x.pays = [];
    x.inferred.push('payments');
  }

  // Payments read a line off: those lines' payments are marked unclear, and the page offers to move them back.
  const paidOf = (x: DraftRow) => (x.pays.length && x.pays.every((p) => p.paise !== null) ? x.pays.reduce((t, p) => t + p.paise!, 0) : null);
  const grouped = new Set(rows.flatMap((x) => (x.paidWith ? [x.id, x.paidWith] : [])));
  const slip = findSlip(rows.map((x) => ({ line: x.line, amt: x.amt, paid: paidOf(x), grouped: grouped.has(x.id) })));
  const slipped = new Set(slip?.lines ?? []);
  if (slip) for (const x of rows) if (slipped.has(x.line)) x.unclear.add('payments');

  // No discount written but the payment differs from the bill(s): fill the difference in, marked as worked out.
  // A positive difference is a discount, a negative one a tip. For bills paid together a discount is spread
  // over the group's bills by amount; a tip goes on the row with the payment. Written discounts are kept.
  // A difference nothing explains is marked unclear instead of being taken on trust: a large discount or tip
  // with no remark about it, or a written discount that still does not add up to the payment.
  for (const x of rows) {
    if (x.paidWith || x.amt === null || x.pays.some((p) => p.paise === null)) continue;
    const members = rows.filter((m) => m.paidWith === x.id);
    const group = [x, ...members];
    if (!x.pays.length) {
      if (!members.length && !explainedInRemark(x.read.remarks)) x.unclear.add('payments');
      continue;
    }
    if (group.some((m) => m.amt === null)) continue;
    const paid = paidOf(x)!;
    if (paid <= 0) continue;
    const billed = group.reduce((t, m) => t + m.amt!, 0);
    if (group.some((m) => m.disc !== null)) {
      if (paid !== billed - group.reduce((t, m) => t + (m.disc ?? 0), 0) && !explainedInRemark(x.read.remarks)) x.unclear.add('payments');
      continue;
    }
    const spread = spreadDifference({ id: x.id, amountPaise: x.amt }, members.map((m) => ({ id: m.id, amountPaise: m.amt! })), paid);
    if (!spread) continue;
    const gap = billed - paid;
    const large = gap > 0 ? gap * 100 > LARGE_DISCOUNT_PCT * billed : -gap * 100 > LARGE_TIP_PCT * billed;
    if (large && !group.some((m) => explainedInRemark(m.read.remarks))) x.unclear.add('payments');
    for (const m of group) {
      const v = spread.get(m.id)!;
      if (!v.discountPaise && !v.tipPaise) continue;
      m.disc = v.discountPaise; m.tip = v.tipPaise;
      m.inferred.push('discount');
    }
  }
  return rows;
}

/** Statements that replace the page's draft register rows with the reading. */
export function registerStatements(ctx: Ctx, data: Grid | Reading, opts: { softwareBills?: string[]; takenBills?: string[] } = {}): { statements: D1PreparedStatement[]; written: number | null } {
  const t = now();
  const r = asReading(data);
  const statements: D1PreparedStatement[] = [stmt(ctx.db, 'DELETE FROM register_rows WHERE upload_id = ? AND status = ?', ctx.uploadId, 'draft')];
  const rows = draftRegisterRows(r, opts);
  rows.forEach((x, i) => {
    statements.push(stmt(ctx.db, `INSERT INTO register_rows (id, business_id, upload_id, line_no, shift_day, bill_no, bill_type, amount_paise, discount_paise, tip_paise,
      paid_with_row_id, remarks, status, ocr_original, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      x.id, ctx.businessId, ctx.uploadId, i + 1, ctx.day, x.billNo, x.read.bill_type === 'unclear' ? 'fnb' : x.read.bill_type,
      x.amt ?? 0, x.disc ?? 0, x.tip, null, x.read.remarks,
      JSON.stringify({ ...base(ctx, r.orientation), line: x.line, read: x.read, ...('lines' in data ? { grid: data.lines.find((l) => l.line === x.line)?.cells ?? null } : {}),
        unclear: [...x.unclear], inferred: x.inferred, ...(x.completedFrom ? { completedFrom: x.completedFrom } : {}) }), t));
    for (const p of x.pays) {
      if (p.paise === null) continue;
      statements.push(stmt(ctx.db, `INSERT INTO register_payments (id, business_id, register_row_id, mode, column_label, amount_paise, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, newId(), ctx.businessId, x.id, p.mode, p.column, p.paise, t));
    }
  });
  // Links last, once every row of the page exists.
  for (const x of rows) if (x.paidWith) statements.push(stmt(ctx.db, 'UPDATE register_rows SET paid_with_row_id = ? WHERE id = ?', x.paidWith, x.id));
  return { statements, written: amount(r.page_total) };
}

/** Statements that replace the page's draft expense rows with the reading. Rows have no head: a person chooses it. */
export function expenseStatements(ctx: Ctx, r: z.infer<typeof ExpenseReading>, cashAccountId: string, parties: Party[] = [], history: PastLine[] = []): { statements: D1PreparedStatement[]; written: number | null } {
  const t = now();
  const statements: D1PreparedStatement[] = [stmt(ctx.db, "DELETE FROM transactions WHERE upload_id = ? AND status = 'draft'", ctx.uploadId)];
  r.rows.forEach((row, i) => {
    const unclear = new Set(row.unclear);
    const amt = amount(row.amount);
    if (amt === null || amt <= 0) unclear.add('amount');
    if (!row.item) unclear.add('item');
    // A vendor already known gives the line its remembered head ("Learned"); an unknown one waits for a person.
    const party = (row.vendor ? byName(parties, row.vendor) : null) ?? inText(parties, `${row.item ?? ''} ${row.vendor ?? ''}`);
    const headId = party ? pickHead(party, history, row.item ?? '').headId : null;
    statements.push(stmt(ctx.db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, head_id, narration, source, status,
      payment_mode, upload_id, line_no, party_id, ocr_original, created_at) VALUES (?, ?, ?, ?, ?, 'expense', ?, ?, 'cash_photo', 'draft', 'cash', ?, ?, ?, ?, ?)`,
      newId(), ctx.businessId, cashAccountId, ctx.day, amt !== null && amt > 0 ? amt : 0, headId, row.item ?? '',
      ctx.uploadId, i + 1, party?.id ?? null,
      JSON.stringify({ ...base(ctx, r.orientation), line: row.line, read: row, unclear: [...unclear], inferred: headId ? ['head'] : [] }), t));
  });
  return { statements, written: amount(r.page_total) };
}

/** Statement that fills the cash summary's five figures from the reading, as a draft. */
export function summaryStatement(ctx: Ctx, r: z.infer<typeof SummaryReading>): D1PreparedStatement {
  const unclear = new Set(r.unclear);
  const v = { opening: amount(r.opening), received: amount(r.received), balance: amount(r.balance), expenses: amount(r.expenses), cash_in_hand: amount(r.cash_in_hand) };
  for (const [k, x] of Object.entries(v)) if (x === null) unclear.add(k);
  return stmt(ctx.db, `UPDATE cash_summaries SET opening_paise = ?, received_paise = ?, balance_paise = ?, expenses_paise = ?, cash_in_hand_paise = ?,
    status = 'draft', ocr_original = ? WHERE upload_id = ? AND status <> 'approved'`,
    v.opening, v.received, v.balance, v.expenses, v.cash_in_hand, JSON.stringify({ ...base(ctx, r.orientation), read: r, unclear: [...unclear] }), ctx.uploadId);
}

export type { PageImage };
