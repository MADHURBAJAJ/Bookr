// Reads an ICICI statement: rows pasted from a Google Sheet (tab-separated) or read through the Sheets API.
// Columns: No., Transaction ID, Value Date, Txn Posted Date, ChequeNo., Description, Cr/Dr, Amount, Balance.
// Title, header and blank lines are skipped; "No." restarts every day, so the Transaction ID is the key.

import { parsePaise } from './money';
import { istToMs } from './time';

export type BankKind = 'upi_in' | 'upi_out' | 'upi_fee' | 'reversal' | 'card_settlement' | 'card_purchase' | 'other';

export interface BankLine {
  tranId: string; valueDate: string; postedAt: number; day: string; description: string;
  direction: 'CR' | 'DR'; amountPaise: number; balancePaise: number | null;
  kind: BankKind; upiRef: string | null; vpa: string | null; remark: string | null;
}

export interface ParsedStatement { lines: BankLine[]; problems: string[] }

const COLS = ['tran', 'value', 'posted', 'description', 'crdr', 'amount', 'balance'] as const;
type Col = (typeof COLS)[number];
const DEFAULT_AT: Record<Col, number> = { tran: 1, value: 2, posted: 3, description: 5, crdr: 6, amount: 7, balance: 8 };

/** Which column holds what, from a header row like "No. | Transaction ID | Value Date | …", if there is one. */
function headerMap(cells: string[]): Record<Col, number> | null {
  const at = (re: RegExp) => cells.findIndex((c) => re.test(c.trim()));
  const m = { tran: at(/^transaction id$/i), value: at(/^value date$/i), posted: at(/posted date|transaction date/i), description: at(/^(description|remarks?|narration)/i),
    crdr: at(/^cr\/dr$/i), amount: at(/^transaction amount|^amount/i), balance: at(/balance/i) };
  return Object.values(m).every((i) => i >= 0) ? m : null;
}

/** dd/mm/yyyy → yyyy-mm-dd */
function isoDate(v: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

/** "01/11/2026 7:47:41 AM" (India time) → ms */
function postedMs(v: string): number | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AP]M)?$/i.exec(v.trim());
  if (!m) return null;
  let h = Number(m[4]);
  if (m[7]) { const pm = m[7].toUpperCase() === 'PM'; if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
  if (h > 23 || Number(m[5]) > 59) return null;
  return istToMs(Number(m[3]), Number(m[2]), Number(m[1]), h, Number(m[5]), Number(m[6] ?? 0));
}

/** What a line is, from its description. */
export function classify(description: string, direction: 'CR' | 'DR'): Pick<BankLine, 'kind' | 'upiRef' | 'vpa' | 'remark'> {
  const d = description.trim();
  const fee = /^EZY\/UPICCMDR_~(\w+)~/i.exec(d);
  if (fee) return { kind: 'upi_fee', upiRef: fee[1], vpa: null, remark: null };
  if (/^EZY\/ICICIPOS_SET/i.test(d)) return { kind: 'card_settlement', upiRef: null, vpa: null, remark: null };
  if (/^UPI\//i.test(d)) {
    const p = d.split('/');
    const rev = /^RVSL(\w+)$/i.exec(p[1] ?? '');
    const remark = (p[2] ?? '').trim() || null;
    const vpa = (p[3] ?? '').trim().toLowerCase() || null;
    if (rev) return { kind: 'reversal', upiRef: rev[1], vpa, remark };
    return { kind: direction === 'CR' ? 'upi_in' : 'upi_out', upiRef: (p[1] ?? '').trim() || null, vpa, remark };
  }
  if (/^VPS\//i.test(d) && direction === 'DR') return { kind: 'card_purchase', upiRef: null, vpa: null, remark: d.split('/')[1]?.trim() || null };
  return { kind: 'other', upiRef: null, vpa: null, remark: null };
}

/** Statement rows (each a list of cells) → lines. Rows that are not transactions are skipped; bad ones are reported. */
export function parseStatementRows(rows: string[][]): ParsedStatement {
  const lines: BankLine[] = [];
  const problems: string[] = [];
  let map: Record<Col, number> = DEFAULT_AT;
  const seen = new Set<string>();
  rows.forEach((raw, i) => {
    const cells = raw.map((c) => String(c ?? '').trim());
    if (!cells.some(Boolean)) return;
    const h = headerMap(cells);
    if (h) { map = h; return; }
    const tran = cells[map.tran] ?? '';
    const crdr = (cells[map.crdr] ?? '').toUpperCase();
    if (!/^[A-Z]?\d{3,}$/i.test(tran) || (crdr !== 'CR' && crdr !== 'DR')) return; // title, totals or other text
    const where = `Line ${i + 1} (${tran})`;
    const valueDate = isoDate(cells[map.value] ?? '');
    const posted = postedMs(cells[map.posted] ?? '');
    const amount = parsePaise((cells[map.amount] ?? '').replace(/,/g, ''));
    const balanceText = (cells[map.balance] ?? '').replace(/,/g, '');
    const balance = balanceText ? parsePaise(balanceText) : null;
    if (!valueDate || posted === null) { problems.push(`${where}: the date or time could not be read.`); return; }
    if (amount === null || amount <= 0) { problems.push(`${where}: the amount could not be read.`); return; }
    if (seen.has(tran)) return; // the same line twice in what was pasted
    seen.add(tran);
    const description = cells[map.description] ?? '';
    const day = new Date(posted + 5.5 * 3600e3).toISOString().slice(0, 10);
    lines.push({ tranId: tran, valueDate, postedAt: posted, day, description, direction: crdr as 'CR' | 'DR', amountPaise: amount, balancePaise: balance,
      ...classify(description, crdr as 'CR' | 'DR') });
  });
  return { lines, problems };
}

/** Text pasted from a sheet: one row per line, cells separated by tabs. */
export function parseStatementText(text: string): ParsedStatement {
  return parseStatementRows(text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.split('\t')));
}
