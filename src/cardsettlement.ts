// The card machine's settlement report (ICICI POS, one Excel file per settlement day): one row per card payment with
// its time, amount, the card company's fee and GST, and what reaches the bank. Then TID / MID subtotals and a Grand
// Total, used as a control total. Nothing here touches the database.

import { parsePaise } from './money';
import { istToMs } from './time';

// ---- Reading an .xlsx: a zip of XML files. Workers have no Excel library, and these files are small and plain.

/** The files inside a zip, by name. Reads the central directory, so sizes are right even when written streaming. */
export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip');
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory');
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, await inflate(data));
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const unescapeXml = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#\d+);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    : ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]);
const textOf = (xml: string) => unescapeXml([...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const colIndex = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** The first sheet's rows as text, cells in their columns. */
export async function xlsxRows(bytes: Uint8Array): Promise<string[][]> {
  const files = await unzip(bytes);
  const dec = new TextDecoder();
  const shared = files.has('xl/sharedStrings.xml')
    ? [...dec.decode(files.get('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  const sheetName = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0];
  if (!sheetName) throw new Error('no sheet');
  const rows: string[][] = [];
  for (const r of dec.decode(files.get(sheetName)).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const inner = c[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      const value = type === 'inlineStr' ? textOf(inner) : type === 's' ? shared[Number(v)] ?? '' : unescapeXml(v ?? '');
      row[ref ? colIndex(ref) : row.length] = value;
    }
    rows.push(Array.from(row, (x) => x ?? ''));
  }
  return rows;
}

// ---- The ICICI POS report

export interface CardLine {
  settledOn: string; merchantId: string; terminalId: string; batchNo: string | null; rrn: string | null; txnId: string;
  paidAt: number; txnType: string; amountPaise: number; feePaise: number; gstPaise: number; netPaise: number;
  scheme: string | null; cardType: string | null; cardLast4: string | null; authCode: string | null;
}

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const pad = (n: number) => String(n).padStart(2, '0');

/** "05-NOV-2026" (or "05-NOV-26", "05-11-2026") → 2026-11-05. */
function dayOf(v: string): string | null {
  const m = /^(\d{1,2})[-/ ]([A-Za-z]{3}|\d{1,2})[-/ ](\d{2}|\d{4})$/.exec(v.trim());
  if (!m) return null;
  const mo = /\d/.test(m[2]) ? Number(m[2]) : MONTHS[m[2].toUpperCase()];
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  if (!mo || mo > 12 || Number(m[1]) < 1 || Number(m[1]) > 31) return null;
  return `${y}-${pad(mo)}-${pad(Number(m[1]))}`;
}

/** "04-11-2026 02:38:24", India time → ms. */
function timeOf(v: string): number | null {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(v.trim());
  if (!m) return null;
  return istToMs(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
}

/** Rupees as the sheet holds them ("648.0", "-11.53", "1,599.00") → paise. */
function paiseOf(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const exact = parsePaise(t);
  if (exact != null) return exact;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const HEADINGS = {
  settledOn: /^date of settlement/i, merchantId: /^merchant id$/i, terminalId: /^terminal id$/i, batchNo: /^batch/i, rrn: /^rrn$/i,
  scheme: /^scheme/i, cardType: /^card type$/i, amount: /^transaction amount$/i, charges: /^transaction charges$/i, gst: /^gst$/i,
  net: /^net settlement/i, paidAt: /^transaction date$/i, txnId: /^transaction id$/i, txnType: /^transaction type$/i, card: /^card number$/i,
  authCode: /^auth/i,
} as const;
type Field = keyof typeof HEADINGS;

/** A file name from the card company looks like <MID>_<NAME>_<DDMMYYYY>_ICICI_POS_CD.xlsx. */
export const isCardReportName = (name: string) => /ICICI_POS.*\.xlsx$/i.test(name);

/** Payment rows of the report, with problems found (a missing column, a line that cannot be read, totals that differ). */
export function parseCardReport(rows: string[][]): { lines: CardLine[]; problems: string[] } {
  const problems: string[] = [];
  const h = rows.findIndex((r) => r.some((c) => HEADINGS.txnId.test(c.trim())) && r.some((c) => HEADINGS.net.test(c.trim())));
  if (h < 0) return { lines: [], problems: ['This is not a card settlement report: the Transaction ID and Net Settlement Amount columns were not found.'] };
  const col = {} as Record<Field, number>;
  for (const [k, re] of Object.entries(HEADINGS) as [Field, RegExp][]) col[k] = rows[h].findIndex((c) => re.test(c.trim()));
  const missing = (['settledOn', 'terminalId', 'amount', 'charges', 'net', 'paidAt', 'txnId'] as Field[]).filter((k) => col[k] < 0);
  if (missing.length) return { lines: [], problems: [`The report has no ${missing.join(', ')} column.`] };
  const cell = (r: string[], k: Field) => (col[k] >= 0 ? (r[col[k]] ?? '').trim() : '');

  const lines: CardLine[] = [];
  let grand: { amount: number | null; net: number | null } | null = null;
  rows.slice(h + 1).forEach((r, i) => {
    if (r.some((c) => /^grand total$/i.test(c.trim()))) { grand = { amount: paiseOf(cell(r, 'amount')), net: paiseOf(cell(r, 'net')) }; return; }
    const txnId = cell(r, 'txnId');
    if (!txnId) return; // blank lines and the TID / MID subtotals
    const lineNo = h + i + 2;
    const settledOn = dayOf(cell(r, 'settledOn'));
    const paidAt = timeOf(cell(r, 'paidAt'));
    const amount = paiseOf(cell(r, 'amount'));
    const charges = paiseOf(cell(r, 'charges')) ?? 0;
    const gst = paiseOf(cell(r, 'gst')) ?? 0;
    const net = paiseOf(cell(r, 'net'));
    if (!settledOn || paidAt == null || amount == null || net == null) {
      problems.push(`Row ${lineNo} (${txnId}) could not be read: ${!settledOn ? 'settlement date' : paidAt == null ? 'transaction date' : amount == null ? 'amount' : 'net amount'}.`);
      return;
    }
    // The report shows what was kept as negative numbers; Bookr keeps the fee and GST as positive amounts.
    const fee = Math.abs(charges);
    const gstPaise = Math.abs(gst);
    if (amount - fee - gstPaise !== net) problems.push(`Row ${lineNo} (${txnId}): amount less fee and GST is not the net amount.`);
    const last4 = /(\d{4})\s*$/.exec(cell(r, 'card'))?.[1] ?? null;
    lines.push({
      settledOn, merchantId: cell(r, 'merchantId'), terminalId: cell(r, 'terminalId'), batchNo: cell(r, 'batchNo') || null, rrn: cell(r, 'rrn') || null,
      txnId, paidAt, txnType: (cell(r, 'txnType') || 'PURCHASE').toUpperCase(), amountPaise: amount, feePaise: fee, gstPaise, netPaise: net,
      scheme: cell(r, 'scheme') || null, cardType: cell(r, 'cardType') || null, cardLast4: last4, authCode: cell(r, 'authCode') || null,
    });
  });
  const g = grand as { amount: number | null; net: number | null } | null;
  if (g && lines.length) {
    const sum = (k: 'amountPaise' | 'netPaise') => lines.reduce((t, l) => t + l[k], 0);
    if (g.amount != null && g.amount !== sum('amountPaise')) problems.push('The payments do not add up to the Grand Total amount.');
    if (g.net != null && g.net !== sum('netPaise')) problems.push('The payments do not add up to the Grand Total net amount.');
  }
  if (!lines.length && !problems.length) problems.push('The report has no card payments.');
  return { lines, problems };
}

/** Reads an ICICI POS .xlsx file. */
export async function readCardReport(bytes: Uint8Array) {
  let rows: string[][];
  try { rows = await xlsxRows(bytes); } catch { return { lines: [] as CardLine[], problems: ['This file could not be opened as an Excel (.xlsx) file.'] }; }
  return parseCardReport(rows);
}
