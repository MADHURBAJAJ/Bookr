// Reads the fee software's daily report, FeeDaySheet.xls (approved 20 Nov 2026). The file is a web page holding one
// table, not a real spreadsheet: a header row (S.No, Enrollment Code, Admission No, Student Name, ReceiptNo, Receipt
// Date, Class/Section, Remarks, System Generated Receipt No(Online), Academic Year, FeeType, PaymentMode, Cashier,
// Amount), one row per fee line, then the report's own totals (Cash, UPI by app, card by machine bank, transfers,
// cancelled, cheque bounce, refunds, net). Columns are found by their header, so their order may change.

import { parsePaise } from './money';

export type FeeMode = 'cash' | 'upi' | 'card' | 'bank' | 'cheque' | 'other';
export interface FeeLine {
  lineNo: number; day: string; receiptNo: string; code: string; enrollmentCode: string | null; admissionNo: string | null;
  student: string | null; classSection: string | null; feeType: string | null; mode: FeeMode; modeText: string; cashier: string | null;
  amountPaise: number;
}
export interface FeeReport { day: string; lines: FeeLine[]; footer: { label: string; detail: string; amountPaise: number | null }[] }

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
/** "20 Nov 2026" -> 2026-11-20; also 20/11/2026 and 2026-11-20. */
export function feeDay(text: string): string | null {
  const t = text.trim();
  let m = /^(\d{1,2})[\s-]+([A-Za-z]{3})[A-Za-z]*[\s-]+(\d{4})$/.exec(t);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

export function feeMode(text: string): FeeMode {
  const t = text.toLowerCase();
  if (/^cash$/.test(t.trim())) return 'cash';
  if (/upi|google pay|gpay|paytm|phone ?pe|bhim/.test(t)) return 'upi';
  if (/card|swipe|pos/.test(t)) return 'card';
  if (/cheque|check|\bdd\b|demand draft/.test(t)) return 'cheque';
  if (/bank|neft|imps|rtgs|transfer/.test(t)) return 'bank';
  return 'other';
}

/** The school's code inside a receipt number: 26SMSSMS3872 -> SMSSMS, 26BISPBIST4352 -> BISPBIST. */
export function receiptCode(receiptNo: string): string {
  const m = /^\d*([A-Za-z]+)/.exec(receiptNo.trim());
  return (m ? m[1] : receiptNo.trim()).toUpperCase();
}

/** "  ANUP  MAHERSHWARI " -> "anup mahershwari": how cashier names are compared. */
export const nameKey = (v: string) => v.toLowerCase().replace(/[^a-z0-9.']+/g, ' ').trim();

const cellText = (h: string) => h.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/\s+/g, ' ').trim();

function rowsOf(html: string): string[][] {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => cellText(c[1])));
}

export function parseFeeReport(html: string): FeeReport {
  const rows = rowsOf(html);
  const hi = rows.findIndex((r) => r.some((c) => /^receipt ?no$/i.test(c)) && r.some((c) => /^amount$/i.test(c)));
  if (hi < 0) throw new Error('This is not a fee day sheet: no ReceiptNo and Amount columns.');
  const head = rows[hi].map((c) => c.toLowerCase());
  const col = (...names: RegExp[]) => head.findIndex((h) => names.some((n) => n.test(h)));
  const at = {
    sno: col(/^s\.? ?no/), enrol: col(/enrol+ment/), adm: col(/admission/), student: col(/student/), receipt: col(/^receipt ?no$/),
    date: col(/receipt date/), cls: col(/class/), fee: col(/fee ?type/), mode: col(/payment ?mode|mode/), cashier: col(/cashier|collected by|user/),
    amount: col(/^amount$/),
  };
  const lines: FeeLine[] = [];
  const footer: FeeReport['footer'] = [];
  let reportDay: string | null = null;
  for (const r of rows.slice(hi + 1)) {
    const isLine = r.length >= head.length && /^\d+$/.test(r[at.sno] ?? '') && r[at.receipt];
    if (!isLine) {
      const joined = r.join(' ').trim();
      if (!joined) continue;
      const d = /Receipt Date\s*:\s*(.+)$/i.exec(joined) ?? /^(.+?)\s*:\s*Total Amount/i.exec(joined);
      if (d) reportDay ??= feeDay(d[1]);
      const last = r[r.length - 1];
      const amount = r.length >= 2 ? parsePaise(last.replace(/,/g, '')) : null;
      // "Google Pay : 50850.00, Paytm : 93138.00, Phone Pe : 30720.00 UPI" -> detail (the split) and label (UPI).
      const text = r.length >= 2 ? r[r.length - 2] : '';
      const split = /^(.*\d)\s+([A-Za-z][^\d]*)$/.exec(text);
      const label = (split ? split[2] : text).trim();
      const detail = split ? split[1].trim() : '';
      if (amount !== null && label) footer.push({ label: /total amount/i.test(label) ? 'Total' : label, detail, amountPaise: amount });
      continue;
    }
    const amount = parsePaise((r[at.amount] ?? '').replace(/,/g, ''));
    const day = at.date >= 0 ? feeDay(r[at.date] ?? '') : null;
    if (amount === null || !day) throw new Error(`Line ${r[at.sno]}: could not read its date or amount.`);
    const v = (i: number) => (i >= 0 && r[i] ? r[i] : null);
    const modeText = v(at.mode) ?? '';
    lines.push({
      lineNo: Number(r[at.sno]), day, receiptNo: r[at.receipt], code: receiptCode(r[at.receipt]), enrollmentCode: v(at.enrol), admissionNo: v(at.adm),
      student: v(at.student), classSection: v(at.cls), feeType: v(at.fee), mode: feeMode(modeText), modeText, cashier: v(at.cashier), amountPaise: amount,
    });
  }
  if (!lines.length) throw new Error('No fee lines found in this file.');
  const days = [...new Set(lines.map((l) => l.day))];
  if (days.length > 1) throw new Error(`This file holds more than one day (${days.join(', ')}). Bring in one day at a time.`);
  return { day: reportDay ?? days[0], lines, footer };
}
