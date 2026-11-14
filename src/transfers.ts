// Money moved between the business's own accounts (approved 14 Nov 2026). Every account on Accounts is the business's
// own. A bank line is shown as a transfer when:
//  - pair: a line of the opposite direction and the same amount is in another bank account within TRANSFER_DAYS;
//  - leg: a transfer booked earlier from the other side is waiting for this account's line (same amount, within the days);
//  - words: the description names another account (its number, a UPI ID or words written on Accounts).
// A person books it ("Book as transfer"): two transfer rows, out of one account and into the other, neither income nor
// an expense. Nothing is booked by itself. Undo takes both rows off and opens both lines again.
import { all, newId, one, stmt, type DB } from './db';
import type { BankRow } from './bank';

export const TRANSFER_DAYS = 2;
const DAY = 86400e3;

export interface OwnAccount { id: string; name: string; kind: string; account_number: string | null; identifiers: string }
export interface TransferHint { otherAccountId: string; otherAccountName: string; pairRowId: string | null; legId: string | null; why: 'pair' | 'leg' | 'words'; word: string | null }

export const ownAccounts = (db: DB, businessId: string) =>
  all<OwnAccount>(db, 'SELECT id, name, kind, account_number, identifiers FROM accounts WHERE business_id = ?', businessId);

const idsOf = (a: OwnAccount): string[] => { try { return (JSON.parse(a.identifiers) as string[]).filter((x) => typeof x === 'string' && x.trim().length >= 3); } catch { return []; } };

/** The other account a description names: its full number, its last 4 digits after X or *, a UPI ID or a word written for it. */
export function namedAccount(accounts: OwnAccount[], row: Pick<BankRow, 'account_id' | 'description' | 'vpa'>): { account: OwnAccount; word: string } | null {
  const d = row.description.toLowerCase();
  for (const a of accounts) {
    if (a.id === row.account_id || a.kind !== 'bank') continue;
    const num = (a.account_number ?? '').replace(/\D/g, '');
    if (num.length >= 6 && d.replace(/\s/g, '').includes(num)) return { account: a, word: a.account_number! };
    if (num.length >= 4 && new RegExp(`[x*]+${num.slice(-4)}(?!\\d)`, 'i').test(row.description)) return { account: a, word: `••• ${num.slice(-4)}` };
    for (const w of idsOf(a)) {
      const lw = w.toLowerCase().trim();
      if ((row.vpa && row.vpa.toLowerCase() === lw) || d.includes(lw)) return { account: a, word: w };
    }
  }
  return null;
}

/** The transfer each open line could be (by line id). Cash lines are left to the cash deposit / withdrawal step. */
export async function transferHints(db: DB, businessId: string, rows: BankRow[]): Promise<Map<string, TransferHint>> {
  const open = rows.filter((r) => r.status === 'unmatched' && r.kind !== 'card_settlement');
  const out = new Map<string, TransferHint>();
  if (!open.length) return out;
  const accounts = await ownAccounts(db, businessId);
  const bankIds = new Set(accounts.filter((a) => a.kind === 'bank').map((a) => a.id));
  if (bankIds.size < 2) return out;
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
  const lo = Math.min(...open.map((r) => r.posted_at)) - TRANSFER_DAYS * DAY;
  const hi = Math.max(...open.map((r) => r.posted_at)) + TRANSFER_DAYS * DAY;
  const amounts = JSON.stringify([...new Set(open.map((r) => r.amount_paise))]);
  const [others, legs] = await Promise.all([
    all<BankRow>(db, `SELECT * FROM bank_rows WHERE business_id = ? AND status = 'unmatched' AND posted_at BETWEEN ? AND ?
      AND amount_paise IN (SELECT value FROM json_each(?))`, businessId, lo, hi, amounts),
    all<{ id: string; account_id: string; amount_paise: number; created_at: number; at: number; leg: string; partnerAccount: string }>(db, `
      SELECT t.id, t.account_id, t.amount_paise, t.created_at, json_extract(t.ocr_original, '$.at') AS at, json_extract(t.ocr_original, '$.leg') AS leg,
        p.account_id AS partnerAccount
      FROM transactions t JOIN transactions p ON p.id = json_extract(t.ocr_original, '$.partner')
      WHERE t.business_id = ? AND t.type = 'transfer' AND json_extract(t.ocr_original, '$.transfer') = 'own'
        AND json_extract(t.ocr_original, '$.bankRowId') IS NULL AND t.amount_paise IN (SELECT value FROM json_each(?))`, businessId, amounts),
  ]);
  const taken = new Set<string>();
  for (const r of [...open].sort((a, b) => a.posted_at - b.posted_at)) {
    if (!bankIds.has(r.account_id) || taken.has(r.id)) continue;
    const near = (at: number) => Math.abs(at - r.posted_at) <= TRANSFER_DAYS * DAY;
    // A transfer booked from the other side, waiting for this line: money into this account for a CR, out for a DR.
    const leg = legs.find((l) => l.account_id === r.account_id && l.amount_paise === r.amount_paise && l.leg === (r.direction === 'CR' ? 'in' : 'out') && near(l.at) && !taken.has(l.id));
    if (leg) { taken.add(leg.id); out.set(r.id, { otherAccountId: leg.partnerAccount, otherAccountName: nameOf.get(leg.partnerAccount) ?? '', pairRowId: null, legId: leg.id, why: 'leg', word: null }); continue; }
    const pair = others.filter((o) => o.id !== r.id && o.account_id !== r.account_id && bankIds.has(o.account_id) && o.direction !== r.direction
      && o.amount_paise === r.amount_paise && near(o.posted_at) && !taken.has(o.id))
      .sort((a, b) => Math.abs(a.posted_at - r.posted_at) - Math.abs(b.posted_at - r.posted_at))[0];
    const named = namedAccount(accounts, r);
    // A pair whose other account the description names (or any pair when it names none) is the transfer.
    if (pair && (!named || named.account.id === pair.account_id)) {
      taken.add(r.id); taken.add(pair.id);
      const h = { pairRowId: null, legId: null, why: 'pair' as const, word: named?.word ?? null };
      out.set(r.id, { ...h, otherAccountId: pair.account_id, otherAccountName: nameOf.get(pair.account_id) ?? '', pairRowId: pair.id });
      out.set(pair.id, { ...h, otherAccountId: r.account_id, otherAccountName: nameOf.get(r.account_id) ?? '', pairRowId: r.id });
      continue;
    }
    if (named) out.set(r.id, { otherAccountId: named.account.id, otherAccountName: named.account.name, pairRowId: null, legId: null, why: 'words', word: named.word });
  }
  return out;
}

/** The two rows of a transfer between own accounts, and the lines booked to them. */
export async function bookTransferStatements(db: DB, businessId: string, row: BankRow, otherAccountId: string, pair: BankRow | null, legId: string | null, userId: string, t: number) {
  const note = (other: string) => `Transfer ${row.direction === 'DR' ? 'to' : 'from'} ${other}`;
  const other = await one<{ id: string; name: string }>(db, 'SELECT id, name FROM accounts WHERE id = ? AND business_id = ?', otherAccountId, businessId);
  if (!other) return null;
  const here = await one<{ name: string }>(db, 'SELECT name FROM accounts WHERE id = ?', row.account_id);
  const AUD = `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, ?, 'bank_rows', ?, ?, ?, ?)`;
  if (legId) {
    return [
      stmt(db, `UPDATE transactions SET ocr_original = json_set(ocr_original, '$.bankRowId', ?) WHERE id = ? AND business_id = ? AND type = 'transfer'`, row.id, legId, businessId),
      stmt(db, "UPDATE bank_rows SET status = 'booked', transaction_id = ?, note = ?, done_by = ?, done_at = ? WHERE id = ? AND status = 'unmatched'", legId, note(other.name), userId, t, row.id),
      stmt(db, AUD, businessId, userId, 'bank.own_transfer', row.id, JSON.stringify({ status: 'unmatched' }), JSON.stringify({ joined: legId, other: other.id }), t),
    ];
  }
  const mine = newId();
  const theirs = newId();
  const out = row.direction === 'DR';
  const meta = (leg: 'in' | 'out', bankRowId: string | null, partner: string) => JSON.stringify({ transfer: 'own', leg, bankRowId, partner, at: row.posted_at });
  const ins = `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, narration, source, status, shift_day, ocr_original, created_at)
    VALUES (?, ?, ?, ?, ?, 'transfer', ?, 'bank_sheet', 'approved', NULL, ?, ?)`;
  return [
    stmt(db, ins, mine, businessId, row.account_id, row.day, row.amount_paise, `${note(other.name)} (${row.description})`, meta(out ? 'out' : 'in', row.id, theirs), t),
    stmt(db, ins, theirs, businessId, other.id, pair?.day ?? row.day, row.amount_paise, `Transfer ${out ? 'from' : 'to'} ${here?.name ?? ''}`, meta(out ? 'in' : 'out', pair?.id ?? null, mine), t),
    stmt(db, "UPDATE bank_rows SET status = 'booked', transaction_id = ?, note = ?, done_by = ?, done_at = ? WHERE id = ? AND status = 'unmatched'", mine, note(other.name), userId, t, row.id),
    ...(pair ? [stmt(db, "UPDATE bank_rows SET status = 'booked', transaction_id = ?, note = ?, done_by = ?, done_at = ? WHERE id = ? AND status = 'unmatched'",
      theirs, `Transfer ${out ? 'from' : 'to'} ${here?.name ?? ''}`, userId, t, pair.id)] : []),
    stmt(db, AUD, businessId, userId, 'bank.own_transfer', row.id, JSON.stringify({ status: 'unmatched' }), JSON.stringify({ transactions: [mine, theirs], pairRowId: pair?.id ?? null, other: other.id }), t),
  ];
}

/** Undo of a transfer from either line: both rows go, and every line booked to them opens again. */
export async function undoTransferStatements(db: DB, businessId: string, txId: string) {
  const tx = await one<{ id: string; partner: string | null }>(db, `SELECT id, json_extract(ocr_original, '$.partner') AS partner FROM transactions
    WHERE id = ? AND business_id = ? AND type = 'transfer' AND json_extract(ocr_original, '$.transfer') = 'own'`, txId, businessId);
  if (!tx) return [];
  const ids = JSON.stringify([tx.id, ...(tx.partner ? [tx.partner] : [])]);
  return [
    stmt(db, `UPDATE bank_rows SET status = 'unmatched', transaction_id = NULL, note = NULL, done_by = NULL, done_at = NULL
      WHERE business_id = ? AND status = 'booked' AND transaction_id IN (SELECT value FROM json_each(?))`, businessId, ids),
    stmt(db, `DELETE FROM transactions WHERE business_id = ? AND type = 'transfer' AND id IN (SELECT value FROM json_each(?))`, businessId, ids),
  ];
}
