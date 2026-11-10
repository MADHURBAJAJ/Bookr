// Reads the hotel software's daily sales CSV. See docs/phase2-context.md, "CSV format".
//
// - Bills are rows whose SI.NO is a number. Blank lines and a footer follow.
// - The footer (TOTAL BILLS, UPI, CARD, CASH, TOTAL SALE) is the control total.
// - NAME is never returned, and the copy kept in storage has it blanked.
// - Amounts become integer paise; DATE/TIME is India time.

import { parsePaise } from './money';
import { istToMs } from './time';

export type Mode = 'upi' | 'card' | 'cash' | 'unknown';

export interface ParsedBill {
  siNo: string;
  posNo: string;
  billNo: string;
  paidAt: number;
  mode: Mode;
  amountPaise: number;
  discountPaise: number;
}

export interface Footer {
  bills: number;
  upiPaise: number;
  cardPaise: number;
  cashPaise: number;
  totalPaise: number;
}

export interface ParsedReport {
  bills: ParsedBill[];
  footer: Footer | null;
  firstPaidAt: number | null;
  lastPaidAt: number | null;
  /** Every reason the file cannot be imported. Empty means it can. */
  problems: string[];
  /** A bill number seen again in the same file (Stage 7, approved 10 Nov 2026): imported once, the repeat kept apart
   *  for a person to choose which line to keep. Counted in the footer checks. */
  twice: ParsedBill[];
  /** The same file with the NAME column blanked, for storage. */
  redacted: string;
}

/** RFC 4180 rows: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const quote = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const norm = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

const COLUMNS = { SINO: 'si', POSNO: 'pos', DATETIME: 'when', BILLNO: 'bill', NAME: 'name', MODEOFPAYMENT: 'mode', BILLAMOUNT: 'amount', DISCOUNT: 'discount' } as const;
type Col = (typeof COLUMNS)[keyof typeof COLUMNS];

const FOOTER_LABELS: Record<string, keyof Footer> = { TOTALBILLS: 'bills', UPI: 'upiPaise', CARD: 'cardPaise', CASH: 'cashPaise', TOTALSALE: 'totalPaise' };

function parseMode(v: string): Mode {
  const m = v.trim().toUpperCase();
  return m === 'UPI' ? 'upi' : m === 'CARD' ? 'card' : m === 'CASH' ? 'cash' : 'unknown';
}

/** "31-10-2026.09:17:38", India time → epoch ms. */
export function parseDateTime(v: string): number | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})[.\s](\d{2}):(\d{2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const [d, mo, y, h, mi, s] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return istToMs(y, mo, d, h, mi, s);
}

/** A footer cell like "UPI" followed by a number, or "UPI : 44,147" in one cell. */
function footerEntry(row: string[]): [keyof Footer, string] | null {
  for (let i = 0; i < row.length; i++) {
    const cell = row[i].trim();
    const inline = /^([A-Za-z ]+?)\s*[:=]\s*([\d,]+(?:\.\d+)?)$/.exec(cell);
    if (inline && FOOTER_LABELS[norm(inline[1])]) return [FOOTER_LABELS[norm(inline[1])], inline[2]];
    const key = FOOTER_LABELS[norm(cell)];
    if (key) {
      const value = row.slice(i + 1).map((c) => c.trim()).find((c) => c !== '' && c !== ':');
      if (value !== undefined) return [key, value];
    }
  }
  return null;
}

export function parseSalesCsv(text: string): ParsedReport {
  const rows = csvRows(text);
  const problems: string[] = [];
  const headerIndex = rows.findIndex((r) => r.some((c) => norm(c) === 'BILLNO') && r.some((c) => norm(c) === 'MODEOFPAYMENT'));
  if (headerIndex < 0) {
    return { bills: [], footer: null, firstPaidAt: null, lastPaidAt: null, problems: ['No header row with BILL NO and MODE OF PAYMENT was found.'], redacted: '', twice: [] };
  }
  const cols: Partial<Record<Col, number>> = {};
  rows[headerIndex].forEach((c, i) => {
    const key = COLUMNS[norm(c) as keyof typeof COLUMNS];
    if (key && cols[key] === undefined) cols[key] = i;
  });
  for (const [label, key] of [['SI.NO', 'si'], ['POS.NO', 'pos'], ['DATE/TIME', 'when'], ['BILL NO', 'bill'], ['MODE OF PAYMENT', 'mode'], ['BILL AMOUNT', 'amount']] as const) {
    if (cols[key] === undefined) problems.push(`Column ${label} is missing.`);
  }
  if (problems.length) return { bills: [], footer: null, firstPaidAt: null, lastPaidAt: null, problems, redacted: '', twice: [] };

  const cell = (r: string[], k: Col) => (cols[k] === undefined ? '' : (r[cols[k]!] ?? '').trim());
  const bills: ParsedBill[] = [];
  const footer: Partial<Record<keyof Footer, number>> = {};
  const seen = new Set<string>();
  const twice: ParsedBill[] = [];

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 1;
    if (/^\d+$/.test(cell(r, 'si'))) {
      const paidAt = parseDateTime(cell(r, 'when'));
      const amount = parsePaise(cell(r, 'amount'));
      const discount = cell(r, 'discount') === '' ? 0 : parsePaise(cell(r, 'discount'));
      const billNo = cell(r, 'bill');
      const posNo = cell(r, 'pos');
      if (paidAt === null) problems.push(`Line ${line}: DATE/TIME "${cell(r, 'when')}" is not like 31-10-2026.09:17:38.`);
      if (amount === null || amount < 0) problems.push(`Line ${line}: BILL AMOUNT "${cell(r, 'amount')}" is not an amount.`);
      if (discount === null) problems.push(`Line ${line}: DISCOUNT "${cell(r, 'discount')}" is not an amount.`);
      if (!billNo) problems.push(`Line ${line}: BILL NO is empty.`);
      const key = `${posNo}\u0000${billNo}`;
      const again = !!billNo && seen.has(key);
      seen.add(key);
      if (paidAt !== null && amount !== null && discount !== null && billNo) {
        (again ? twice : bills).push({ siNo: cell(r, 'si'), posNo, billNo, paidAt, mode: parseMode(cell(r, 'mode')), amountPaise: amount, discountPaise: discount });
      }
      continue;
    }
    const entry = footerEntry(r);
    if (entry) {
      const [key, raw] = entry;
      const value = key === 'bills' ? (/^\d+$/.test(raw.replace(/,/g, '')) ? Number(raw.replace(/,/g, '')) : null) : parsePaise(raw);
      if (value === null) problems.push(`Line ${line}: footer value "${raw}" is not a number.`);
      else footer[key] = value;
    }
  }

  let fullFooter: Footer | null = null;
  const missing = (Object.keys(FOOTER_LABELS) as string[]).filter((k) => footer[FOOTER_LABELS[k]] === undefined);
  if (missing.length) {
    problems.push(`The footer is missing: ${missing.map((k) => ({ TOTALBILLS: 'TOTAL BILLS', TOTALSALE: 'TOTAL SALE' } as Record<string, string>)[k] ?? k).join(', ')}.`);
  } else {
    fullFooter = footer as Footer;
    const all = [...bills, ...twice];
    const sum = (mode?: Mode) => all.filter((b) => !mode || b.mode === mode).reduce((s, b) => s + b.amountPaise, 0);
    const rupees = (p: number) => `${p < 0 ? '-' : ''}${Math.trunc(Math.abs(p) / 100)}.${String(Math.abs(p) % 100).padStart(2, '0')}`;
    if (all.length !== fullFooter.bills) problems.push(`The file has ${all.length} bills but the footer says ${fullFooter.bills}.`);
    for (const [mode, label, want] of [['upi', 'UPI', fullFooter.upiPaise], ['card', 'CARD', fullFooter.cardPaise], ['cash', 'CASH', fullFooter.cashPaise]] as const) {
      if (sum(mode) !== want) problems.push(`${label} bills add up to ${rupees(sum(mode))} but the footer says ${rupees(want)}.`);
    }
    if (sum() !== fullFooter.totalPaise) problems.push(`All bills add up to ${rupees(sum())} but TOTAL SALE says ${rupees(fullFooter.totalPaise)}.`);
  }
  if (!bills.length && !problems.length) problems.push('The file has no bills.');

  const times = bills.map((b) => b.paidAt);
  const redacted = rows
    .map((r, i) => (i > headerIndex && cols.name !== undefined && r.length > cols.name ? r.map((c, j) => (j === cols.name ? '' : c)) : r))
    .map((r) => r.map(quote).join(','))
    .join('\n');

  return {
    bills,
    footer: fullFooter,
    firstPaidAt: times.length ? Math.min(...times) : null,
    lastPaidAt: times.length ? Math.max(...times) : null,
    problems,
    redacted,
    twice,
  };
}
