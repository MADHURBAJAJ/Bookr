/**
 * Reports → Bank statement (approved 19 Nov 2026): one account's statement lines as the bank wrote them, in the bank's
 * order, each with a tag saying how it was booked. Read-only; the booking itself is done on Bank → Money in / out.
 *
 * Tags: a UPI credit matched to bills; a card settlement (its card payments' days); a transfer between own accounts;
 * a UPI card fee (its credit's bill), booked or not; a head (with the party or the note); a payment and its reversal;
 * left out (with the reason); not booked yet.
 * The balance check: each line's balance should be the line before's plus or minus its amount. Lines posted in the same
 * minute are put in the order that makes their balances follow, as the bank's own order did.
 */
import type { DB } from './db';
import { all, one } from './db';
import { shiftDayOf } from './time';

export type TagKind = 'bill' | 'card' | 'transfer' | 'fee' | 'head' | 'reversed' | 'ignored' | 'open';
export interface StatementLine {
  id: string; tranId: string; day: string; shiftDay: string; postedAt: number; description: string; direction: 'CR' | 'DR'; amountPaise: number; balancePaise: number | null;
  kind: string; status: string; tag: { kind: TagKind; label: string; hint: string | null }; balanceOk: boolean | null;
}

interface Row {
  id: string; tran_id: string; day: string; posted_at: number; description: string; direction: 'CR' | 'DR'; amount_paise: number; balance_paise: number | null;
  kind: string; status: string; note: string | null; remark: string | null; head: string | null; party: string | null; narration: string | null;
  bills: string | null; pair_bills: string | null; pair_tran: string | null; pair_kind: string | null; card: string | null;
}

const short = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const NO_NOTE = /^(UPI|UPI Pay|UPI PAYMENT|NA|NO REMARKS?|Payment from Ph|Sent using Payt|Paid via SuperM|Paid via CRED|Scan and Pay|Paid securely v|Navi UPI|Paid in seconds)$/i;

function tagOf(r: Row): StatementLine['tag'] {
  const note = r.remark && !NO_NOTE.test(r.remark.trim()) ? r.remark.trim() : null;
  if (r.card) {
    const [a, b, n] = r.card.split('|');
    const d1 = shiftDayOf(Number(a)), d2 = shiftDayOf(Number(b));
    return { kind: 'card', label: `Card settlement · ${d1 === d2 ? short(d1) : `${short(d1)} to ${short(d2)}`}`, hint: `${n} card payment${n === '1' ? '' : 's'}` };
  }
  if (r.status === 'matched' && r.bills) return { kind: 'bill', label: `UPI · bill ${r.bills}`, hint: null };
  if (r.kind === 'upi_fee') {
    const of = r.pair_bills ? `bill ${r.pair_bills}` : r.pair_tran ? `credit ${r.pair_tran}` : null;
    if (r.status === 'booked') return { kind: 'fee', label: r.head ? `${r.head} · UPI card fee` : 'UPI card fee', hint: of };
    if (r.status === 'unmatched') return { kind: 'open', label: 'UPI card fee · not booked', hint: of };
  }
  if (r.status === 'booked' && r.note && /^Transfer (to|from) /.test(r.note)) return { kind: 'transfer', label: r.note, hint: null };
  if (r.status === 'booked' || (r.status === 'matched' && r.head)) return { kind: 'head', label: r.head ?? 'Booked', hint: [r.party, r.narration ?? r.note].filter(Boolean).join(' · ') || null };
  if (r.status === 'ignored') {
    if (r.note === 'Payment reversed') return { kind: 'reversed', label: r.kind === 'reversal' ? 'Reversal' : 'Reversed', hint: r.pair_tran ? `with ${r.pair_tran}` : null };
    return { kind: 'ignored', label: 'Left out', hint: r.note };
  }
  if (r.kind === 'reversal') return { kind: 'open', label: 'Not booked', hint: r.pair_tran ? `reversal of ${r.pair_tran}` : 'a reversal' };
  return { kind: 'open', label: 'Not booked', hint: note ? `note: ${note}` : r.direction === 'CR' && r.kind === 'upi_in' ? 'no bill yet' : null };
}

const signed = (r: { direction: string; amount_paise: number }) => (r.direction === 'CR' ? r.amount_paise : -r.amount_paise);

/** Lines of the same minute in the order that makes each balance follow from the one before. */
function bankOrder(rows: Row[], opening: number | null): Row[] {
  const out: Row[] = [];
  let bal = opening;
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j < rows.length && rows[j].posted_at === rows[i].posted_at) j++;
    const group = rows.slice(i, j);
    while (group.length) {
      const k = bal == null ? -1 : group.findIndex((r) => r.balance_paise != null && bal! + signed(r) === r.balance_paise);
      const [r] = group.splice(k < 0 ? 0 : k, 1);
      out.push(r);
      bal = r.balance_paise ?? (bal == null ? null : bal + signed(r));
    }
    i = j;
  }
  return out;
}

export async function bankStatement(db: DB, businessId: string, accountId: string, from: string, to: string) {
  const account = await one<{ id: string; name: string; account_number: string | null }>(db,
    'SELECT id, name, account_number FROM accounts WHERE business_id = ? AND id = ?', businessId, accountId);
  if (!account) return null;
  const rows = await all<Row>(db, `
    SELECT r.id, r.tran_id, r.day, r.posted_at, r.description, r.direction, r.amount_paise, r.balance_paise, r.kind, r.status, r.note, r.remark,
      h.name AS head, p.name AS party, bt.narration,
      (SELECT group_concat(t.bill_no, ' + ') FROM bank_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.bank_row_id = r.id) AS bills,
      (SELECT group_concat(t.bill_no, ' + ') FROM bank_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.bank_row_id = r.pair_row_id) AS pair_bills,
      pr.tran_id AS pair_tran, pr.kind AS pair_kind,
      (SELECT min(s.paid_at) || '|' || max(s.paid_at) || '|' || count(*) FROM card_settlements s WHERE s.bank_row_id = r.id HAVING count(*) > 0) AS card
    FROM bank_rows r
    LEFT JOIN transactions bt ON bt.id = r.transaction_id LEFT JOIN heads h ON h.id = bt.head_id LEFT JOIN parties p ON p.id = bt.party_id
    LEFT JOIN bank_rows pr ON pr.id = r.pair_row_id
    WHERE r.business_id = ? AND r.account_id = ? AND r.day BETWEEN ? AND ?
    ORDER BY r.posted_at, r.tran_id LIMIT 5000`, businessId, accountId, from, to);
  // Opening: the balance on the last line before the range, else worked back from the first line.
  const before = await one<{ balance_paise: number | null }>(db, `SELECT balance_paise FROM bank_rows WHERE business_id = ? AND account_id = ? AND day < ?
    AND balance_paise IS NOT NULL ORDER BY posted_at DESC, tran_id DESC LIMIT 1`, businessId, accountId, from);
  const first = rows[0];
  const opening = before?.balance_paise ?? (first?.balance_paise != null ? first.balance_paise - signed(first) : null);
  const ordered = bankOrder(rows, opening);
  let bal = opening;
  let breaks = 0;
  const lines: StatementLine[] = ordered.map((r) => {
    const ok = bal == null || r.balance_paise == null ? null : bal + signed(r) === r.balance_paise;
    if (ok === false) breaks++;
    bal = r.balance_paise ?? (bal == null ? null : bal + signed(r));
    return { id: r.id, tranId: r.tran_id, day: r.day, shiftDay: shiftDayOf(r.posted_at), postedAt: r.posted_at, description: r.description, direction: r.direction,
      amountPaise: r.amount_paise, balancePaise: r.balance_paise, kind: r.kind, status: r.status, tag: tagOf(r), balanceOk: ok };
  });
  const sum = (d: string) => lines.filter((l) => l.direction === d).reduce((t, l) => t + l.amountPaise, 0);
  return {
    account: { id: account.id, name: account.name, accountNumber: account.account_number }, from, to, lines,
    openingPaise: opening, inPaise: sum('CR'), outPaise: sum('DR'), closingPaise: lines.length ? bal : opening, breaks,
    truncated: rows.length === 5000,
  };
}
