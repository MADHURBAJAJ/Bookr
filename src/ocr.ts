// "Read page": turns a photo of a register page, expense list or cash summary into draft rows.
// Nothing read here is ever confirmed or approved automatically; every row stays a draft for a person.
// Cells Claude could not read with confidence are listed in ocr_original.unclear and shown as "Needs input".

import { z } from 'zod';
import { newId, now, stmt, type DB } from './db';
import { parsePaise } from './money';
import type { PageImage } from './claude';

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
    unclear: Unclear,
  })),
});

export const ExpenseReading = z.object({
  orientation: Orientation,
  legible: z.boolean(),
  page_total: Amount,
  rows: z.array(z.object({ line: z.number().int(), item: z.string().nullable(), amount: Amount, unclear: Unclear })),
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
  bill_register: `This is a page of a hotel's handwritten bill register. Each line is one settled bill with columns such as: line number, Bill No, Amount, Type (F&B or Room), Cash, UPI XOXO, UPI Bank 2, Card, Remarks.
Return one item in "rows" for every bill line, in page order. bill_type is "fnb" for F&B, "room" for Room, or "unclear".
"amount" is the bill amount column. If a discount is written for a bill (in a Disc or Discount column, or as a remark such as "Disc 20"), put it in "discount"; otherwise null.
For each amount written under a payment column, add an entry to "payments" with that column's heading and its mode (cash, upi or card). A bill can have more than one payment.
Field names for "unclear": bill_no, bill_type, amount, discount, payments, remarks.
${COMMON}`,
  expense_list: `This is a handwritten list of cash expenses for one day. Each line has an item and an amount.
Return one item in "rows" for every expense line, in page order. Do not include the total line as a row; put it in "page_total".
Field names for "unclear": item, amount.
${COMMON}`,
  cash_summary: `This is a handwritten cash account summary for one day. It shows: opening balance, received (total received), balance, expenses (total), and cash in hand.
Field names for "unclear": opening, received, balance, expenses, cash_in_hand.
${COMMON}`,
} as const;

export type ReadableKind = keyof typeof INSTRUCTIONS;
export const SCHEMAS = { bill_register: RegisterReading, expense_list: ExpenseReading, cash_summary: SummaryReading } as const;

/** Rupee text from the page → paise, or null when it is missing or not a clean amount. */
const amount = (v: string | null | undefined) => (v == null || v.trim() === '' ? null : parsePaise(v));

interface Ctx { db: DB; businessId: string; uploadId: string; day: string; model: string }

const base = (ctx: Ctx, orientation: string) => ({ engine: 'claude_vision', model: ctx.model, orientation, readAt: now() });

/** Statements that replace the page's draft register rows with the reading. */
export function registerStatements(ctx: Ctx, r: z.infer<typeof RegisterReading>): { statements: D1PreparedStatement[]; written: number | null } {
  const t = now();
  const statements: D1PreparedStatement[] = [stmt(ctx.db, 'DELETE FROM register_rows WHERE upload_id = ? AND status = ?', ctx.uploadId, 'draft')];
  r.rows.forEach((row, i) => {
    const unclear = new Set(row.unclear);
    const amt = amount(row.amount);
    if (amt === null) unclear.add('amount');
    let disc = amount(row.discount);
    if (row.discount && disc === null) unclear.add('discount');
    if (disc !== null && (disc < 0 || disc > (amt ?? 0))) { unclear.add('discount'); disc = null; }
    if (!row.bill_no) unclear.add('bill_no');
    if (row.bill_type === 'unclear') unclear.add('bill_type');
    const pays = row.payments.map((p) => ({ ...p, paise: amount(p.amount) }));
    if (pays.some((p) => p.paise === null)) unclear.add('payments');
    // No discount written but less was paid than billed: fill the difference in, marked as worked out.
    const inferred: string[] = [];
    const paid = pays.reduce((t, p) => t + (p.paise ?? 0), 0);
    let tip = 0;
    if (disc === null && amt !== null && pays.length && pays.every((p) => p.paise !== null) && paid > 0 && paid !== amt) {
      if (paid < amt) disc = amt - paid;
      else tip = paid - amt; // paid more than billed: a tip
      inferred.push('discount');
    }
    const id = newId();
    statements.push(stmt(ctx.db, `INSERT INTO register_rows (id, business_id, upload_id, line_no, shift_day, bill_no, bill_type, amount_paise, discount_paise, tip_paise, remarks,
      status, ocr_original, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      id, ctx.businessId, ctx.uploadId, i + 1, ctx.day, row.bill_no?.trim() ?? '', row.bill_type === 'unclear' ? null : row.bill_type,
      amt ?? 0, disc ?? 0, tip, row.remarks, JSON.stringify({ ...base(ctx, r.orientation), line: row.line, read: row, unclear: [...unclear], inferred }), t));
    for (const p of pays) {
      if (p.paise === null) continue;
      statements.push(stmt(ctx.db, `INSERT INTO register_payments (id, business_id, register_row_id, mode, column_label, amount_paise, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`, newId(), ctx.businessId, id, p.mode, p.column, p.paise, t));
    }
  });
  return { statements, written: amount(r.page_total) };
}

/** Statements that replace the page's draft expense rows with the reading. Rows have no head: a person chooses it. */
export function expenseStatements(ctx: Ctx, r: z.infer<typeof ExpenseReading>, cashAccountId: string): { statements: D1PreparedStatement[]; written: number | null } {
  const t = now();
  const statements: D1PreparedStatement[] = [stmt(ctx.db, "DELETE FROM transactions WHERE upload_id = ? AND status = 'draft'", ctx.uploadId)];
  r.rows.forEach((row, i) => {
    const unclear = new Set(row.unclear);
    const amt = amount(row.amount);
    if (amt === null || amt <= 0) unclear.add('amount');
    if (!row.item) unclear.add('item');
    statements.push(stmt(ctx.db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, head_id, narration, source, status,
      payment_mode, upload_id, line_no, ocr_original, created_at) VALUES (?, ?, ?, ?, ?, 'expense', NULL, ?, 'cash_photo', 'draft', 'cash', ?, ?, ?, ?)`,
      newId(), ctx.businessId, cashAccountId, ctx.day, amt !== null && amt > 0 ? amt : 0, row.item ?? '',
      ctx.uploadId, i + 1, JSON.stringify({ ...base(ctx, r.orientation), line: row.line, read: row, unclear: [...unclear] }), t));
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
