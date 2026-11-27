// Cancelling a receipt taken by mistake (27 Nov 2026): managers and owners only, the same open day, with a reason. The
// receipt and its payments are never changed (they are locked): the cancel is its own row, the room or credit bill gets
// entries that undo the receipt's, an advance held for an arrival is marked cancelled, a Djubo payment it was linked to
// goes back to "pick how it was paid", and Bookr is told. Anything that must be undone first is said before the form opens.
import { Hono, type Context } from 'hono';
import { all, newId, now, one, stmt, type DB } from '../../../src/db';
import { body, fail, isUuid, text } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { audit, bizOf, clock } from '../util';
import { sendSoon } from '../sync';
import type { AppEnv } from '../types';

export const receiptCancelRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
receiptCancelRoutes.use(`${B}/*`, requireStaff);

export const CANCEL_REASONS = ['No money was taken', 'Typed twice', 'Wrong guest or room', 'Wrong amount'];
/** SQL: the receipt (settlement) `s` is not cancelled. */
export const notCancelled = (s: string) => `NOT EXISTS (SELECT 1 FROM receipt_cancels rc WHERE rc.settlement_id = ${s})`;

const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const MODE: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card' };

type Receipt = { id: string; receipt_no: string | null; shift_day: string; at: number; kind: string };
async function receiptOf(db: DB, bid: string, id: string) {
  if (!isUuid(id)) fail(404, 'Receipt not found.');
  const s = await one<Receipt>(db, 'SELECT id, receipt_no, shift_day, at, kind FROM settlements WHERE id = ? AND business_id = ?', id, bid);
  if (!s || s.kind !== 'receipt') fail(404, 'Receipt not found.');
  const pays = await all<{ id: string; mode: string; amount_paise: number }>(db, 'SELECT id, mode, amount_paise FROM payments WHERE settlement_id = ? ORDER BY rowid', s.id);
  const entries = await all<{ id: string; account_id: string; kind: string; amount_paise: number; payment_id: string; acc_kind: string; acc_name: string; stay_id: string | null;
    checked_out_at: number | null; guest: string | null; room: string | null }>(db, `SELECT e.id, e.account_id, e.kind, e.amount_paise, e.payment_id, d.kind AS acc_kind, d.name AS acc_name,
      d.stay_id, st.checked_out_at, st.guest_name AS guest, st.room
    FROM debtor_entries e JOIN debtor_accounts d ON d.id = e.account_id LEFT JOIN stays st ON st.id = d.stay_id
    WHERE e.payment_id IN (SELECT id FROM payments WHERE settlement_id = ?) ORDER BY e.at`, s.id);
  const desk = await one<{ id: string; status: string; guest_name: string }>(db, 'SELECT id, status, guest_name FROM desk_advances WHERE settlement_id = ?', s.id);
  const cancelled = await one<{ reason: string; note: string | null; at: number; by_name: string | null }>(db,
    'SELECT c.reason, c.note, c.at, st.name AS by_name FROM receipt_cancels c LEFT JOIN staff st ON st.id = c.by_staff WHERE c.settlement_id = ?', s.id);
  const total = pays.reduce((t, p) => t + p.amount_paise, 0);
  const who = entries[0] ? (entries[0].guest ? `${entries[0].room} · ${entries[0].guest}` : entries[0].acc_name) : desk ? `${desk.guest_name} (advance before arrival)` : 'Receipt';
  return { s, pays, entries, desk, cancelled, total, who };
}

/** What has to be done before the receipt can be cancelled; empty when it can be. */
async function blockers(c: Context<AppEnv>, r: Awaited<ReturnType<typeof receiptOf>>) {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const out: string[] = [];
  const no = r.s.receipt_no ?? 'This receipt';
  if (r.cancelled) return [`${no} was already cancelled${r.cancelled.by_name ? ` by ${r.cancelled.by_name}` : ''}: ${r.cancelled.reason}.`];
  if (await one(db, 'SELECT 1 FROM shift_closes WHERE business_id = ? AND shift_day = ?', bid, r.s.shift_day)) {
    out.push(`${r.s.shift_day} is closed, so its receipts can't be cancelled. If the money went back to the guest, use Refund on their bill.`);
  }
  // The cash went into a drawer that has since been handed over (or closed): its count is done.
  if (r.pays.some((p) => p.mode === 'cash') && await one(db, 'SELECT 1 FROM drawers WHERE business_id = ? AND opened_at <= ? AND closed_at IS NOT NULL AND closed_at > ?', bid, r.s.at + 5000, r.s.at)) {
    out.push('The cash drawer was handed over after this receipt, so it can\'t be cancelled now.');
  }
  if (r.desk && (r.desk.status === 'refunded' || r.desk.status === 'kept')) {
    out.push(`This advance was ${r.desk.status === 'refunded' ? 'given back (refunded)' : 'kept as a no-show charge'} already, so the receipt can't be cancelled.`);
  }
  for (const accId of [...new Set(r.entries.map((e) => e.account_id))]) {
    const e = r.entries.find((x) => x.account_id === accId)!;
    if (e.checked_out_at) out.push(`${e.room ?? ''} · ${e.guest ?? e.acc_name} has checked out, so the receipt is on a closed bill. Give the money back with a refund, or raise a credit note.`);
    const used = await all<{ bill_no: string | null; amount_paise: number }>(db, `SELECT b.bill_no, x.amount_paise FROM debtor_entries x LEFT JOIN bills b ON b.id = x.bill_id
      WHERE x.account_id = ? AND x.kind = 'advance_used' AND x.at >= ?`, accId, r.s.at);
    if (used.length && r.entries.some((x) => x.account_id === accId && (x.kind === 'advance' || x.kind === 'deposit'))) {
      out.push(`${rs(used.reduce((t, u) => t + u.amount_paise, 0))} of this advance paid ${used.map((u) => `bill ${u.bill_no ?? ''}`).join(', ')}. Void ${used.length === 1 ? 'that bill' : 'those bills'} first.`);
    }
    const refunded = await one<{ p: number }>(db, 'SELECT coalesce(sum(amount_paise), 0) AS p FROM drawer_outs WHERE debtor_account_id = ? AND kind = \'refund\' AND at >= ?', accId, r.s.at);
    if (refunded!.p) out.push(`${rs(refunded!.p)} was refunded from ${e.acc_name} after this receipt, so it can't be cancelled.`);
    const moved = await one<{ n: number }>(db, "SELECT count(*) AS n FROM debtor_entries WHERE account_id = ? AND kind = 'transfer' AND at >= ?", accId, r.s.at);
    if (moved!.n) out.push(`The balance of ${e.acc_name} was moved to another bill after this receipt. Undo the transfer first.`);
  }
  return out;
}

receiptCancelRoutes.get(`${B}/receipts/:id/cancel`, requireAction('receipts.cancel'), async (c) => {
  const r = await receiptOf(c.env.DB, c.get('businessId'), c.req.param('id'));
  return c.json({ receipt: { id: r.s.id, receiptNo: r.s.receipt_no, at: r.s.at, shiftDay: r.s.shift_day, who: r.who, totalPaise: r.total,
      modes: r.pays.map((p) => `${MODE[p.mode] ?? p.mode} ${rs(p.amount_paise)}`).join(' + ') },
    blockers: await blockers(c, r), reasons: CANCEL_REASONS });
});

receiptCancelRoutes.post(`${B}/receipts/:id/cancel`, requireAction('receipts.cancel'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const r = await receiptOf(db, bid, c.req.param('id'));
  const why = await blockers(c, r);
  if (why.length) fail(409, why.join(' '));
  const data = await body(c);
  const reason = typeof data.reason === 'string' && CANCEL_REASONS.includes(data.reason) ? data.reason : fail(400, 'Pick why the receipt is cancelled.');
  const note = text(data, 'note', 'Note', { optional: true, max: 200 }) ?? null;
  const staff = c.get('staff');
  const t = now();
  const { shiftDay } = clock(bizOf(c));
  const no = r.s.receipt_no ?? 'receipt';
  // Entries that undo the receipt's on each bill (same kind and payment, opposite amount), once.
  const undo = r.entries.filter((e) => e.amount_paise < 0);
  try {
    await db.batch([
      stmt(db, 'INSERT INTO receipt_cancels (settlement_id, business_id, reason, note, by_staff, shift_day, at) VALUES (?, ?, ?, ?, ?, ?, ?)', r.s.id, bid, reason, note, staff.id, shiftDay, t),
      ...undo.map((e) => stmt(db, `INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, payment_id, by_staff, at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), bid, e.account_id, e.kind, -e.amount_paise, e.payment_id, staff.id, t, `Cancelled ${no}: ${reason}`.slice(0, 160))),
      stmt(db, "UPDATE desk_advances SET status = 'cancelled' WHERE settlement_id = ? AND status IN ('held', 'applied')", r.s.id),
      // A Djubo payment this receipt was for, or linked to, is asked about again ("pick how it was paid").
      stmt(db, 'UPDATE booking_paid_log SET settlement_id = NULL WHERE settlement_id = ?', r.s.id),
      stmt(db, "INSERT INTO outbox (id, business_id, kind, body, created_at) VALUES (?, ?, 'receipt', ?, ?)", newId(), bid, JSON.stringify({
        kind: 'cancel', settlementId: r.s.id, receiptNo: r.s.receipt_no, paymentIds: r.pays.map((p) => p.id), totalPaise: r.total, reason, note, at: t, by: staff.name }), t),
      audit(db, bid, staff.id, 'receipt.cancel', 'settlements', r.s.id, { receiptNo: r.s.receipt_no, totalPaise: r.total }, { reason, note }),
    ]);
  } catch (e) {
    if (String((e as Error)?.message ?? e).includes('UNIQUE')) fail(409, `${no} was already cancelled.`);
    throw e;
  }
  sendSoon(c, bid);
  return c.json({ slip: { receiptNo: r.s.receipt_no, who: r.who, totalPaise: r.total, modes: r.pays.map((p) => `${MODE[p.mode] ?? p.mode} ${rs(p.amount_paise)}`).join(' + '),
    takenAt: r.s.at, cancelledAt: t, by: staff.name, reason, note } }, 201);
});

/** The day's cancelled receipts, for the Daily check and Day close. */
export async function cancelledReceipts(db: DB, bid: string, from: string, to = from) {
  return all<{ receiptNo: string | null; totalPaise: number; reason: string; note: string | null; at: number; byName: string | null; who: string | null; shiftDay: string }>(db, `
    SELECT s.receipt_no AS receiptNo, (SELECT sum(p.amount_paise) FROM payments p WHERE p.settlement_id = s.id) AS totalPaise, c.reason, c.note, c.at, st.name AS byName,
      (SELECT d.name FROM payments p JOIN debtor_entries e ON e.payment_id = p.id JOIN debtor_accounts d ON d.id = e.account_id WHERE p.settlement_id = s.id LIMIT 1) AS who, c.shift_day AS shiftDay
    FROM receipt_cancels c JOIN settlements s ON s.id = c.settlement_id LEFT JOIN staff st ON st.id = c.by_staff
    WHERE c.business_id = ? AND c.shift_day BETWEEN ? AND ? ORDER BY c.at`, bid, from, to);
}
