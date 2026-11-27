// The restaurant POS's messages (approved 14 Nov 2026). The POS sends each settled bill with its payment lines, money
// received on folios and credit accounts, voids and shift closes; Bookr stores each message once (its id is the POS's) and
// files it into pos_bills, pos_payment_lines, pos_voids and pos_shift_closes. Nothing is booked as income here yet.
//
// The POS proves which business it is with a key the Owner made here (shown once; only its hash is kept). The key travels
// server to server as a Worker secret on the POS, never through a browser.
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, newId, now, one, stmt, type DB } from '../db';
import { randomToken, sha256 } from '../crypto';
import { fail, isUuid } from '../http';
import { IST_OFFSET_MS, shiftDayOf } from '../time';
import { addGroup, editGroup, groupsView, InboxError } from '../waInbox';
import { loadProof, matchProof, shiftWindow, type PosMode, type ProofBill } from '../posProof';

export const posRoutes = new Hono<AppEnv>();

// ---------- the Owner connects a POS

posRoutes.post('/businesses/:businessId/pos/link', requireRole('pos.link'), async (c) => {
  const key = `bookr-pos-${randomToken()}`;
  const bid = c.get('businessId');
  await c.env.DB.batch([
    stmt(c.env.DB, 'DELETE FROM pos_links WHERE business_id = ?', bid),
    stmt(c.env.DB, 'INSERT INTO pos_links (business_id, key_hash, created_by, created_at) VALUES (?, ?, ?, ?)', bid, await sha256(key), c.get('user').id, now()),
    stmt(c.env.DB, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'pos.link', 'pos_links', ?, NULL, '{"connected":true}', ?)`,
      bid, c.get('user').id, bid, now()),
  ]);
  // Shown once. A new key replaces the old one, so a lost key is fixed by connecting again.
  return c.json({ key }, 201);
});

posRoutes.post('/businesses/:businessId/pos/unlink', requireRole('pos.link'), async (c) => {
  const bid = c.get('businessId');
  await c.env.DB.batch([
    stmt(c.env.DB, 'DELETE FROM pos_links WHERE business_id = ?', bid),
    stmt(c.env.DB, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'pos.unlink', 'pos_links', ?, '{"connected":true}', NULL, ?)`,
      bid, c.get('user').id, bid, now()),
  ]);
  return c.json({ ok: true });
});

// ---------- receiving

type Obj = Record<string, unknown>;
class Bad extends Error {}
const obj = (v: unknown, what: string): Obj => { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Bad(`${what} is missing.`); return v as Obj; };
const str = (o: Obj, k: string, opt = false): string | null => {
  const v = o[k];
  if (v === undefined || v === null || v === '') { if (opt) return null; throw new Bad(`${k} is missing.`); }
  if (typeof v !== 'string' || v.length > 300) throw new Bad(`${k} must be text.`);
  return v;
};
const int = (o: Obj, k: string, opt = false): number | null => {
  const v = o[k];
  if (v === undefined || v === null) { if (opt) return null; throw new Bad(`${k} is missing.`); }
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new Bad(`${k} must be a whole number.`);
  return v;
};
const rs = (p: number) => `₹${Math.trunc(p / 100).toLocaleString('en-IN')}${p % 100 ? `.${String(p % 100).padStart(2, '0')}` : ''}`;
const MODES = ['cash', 'upi', 'card', 'room', 'credit', 'comp', 'advance'];

async function bookrAccount(db: DB, bid: string, id: string | null): Promise<string | null> {
  if (!id) return null;
  return (await one<{ id: string }>(db, 'SELECT id FROM accounts WHERE id = ? AND business_id = ?', id, bid))?.id ?? null;
}

/** The statements that file one message. Throws Bad when it does not have what it should. */
async function file(db: DB, bid: string, id: string, kind: string, body: Obj): Promise<D1PreparedStatement[]> {
  if (kind === 'bill_settled') {
    const bill = obj(body.bill, 'bill');
    const billId = str(body, 'billId')!;
    if (str(bill, 'id') !== billId) throw new Bad('billId does not match the bill.');
    const settledAt = int(body, 'settledAt')!;
    const day = shiftDayOf(settledAt);
    const pays = body.payments;
    if (!Array.isArray(pays) || !pays.length) throw new Bad('payments are missing.');
    const lines = [];
    let sum = 0;
    for (const raw of pays) {
      const p = obj(raw, 'payment');
      const mode = str(p, 'mode')!;
      if (!MODES.includes(mode)) throw new Bad(`mode ${mode} is not known.`);
      const amount = int(p, 'amountPaise')!;
      if (amount <= 0) throw new Bad('A payment amount is not above zero.');
      sum += amount;
      lines.push({ p, mode, amount, account: await bookrAccount(db, bid, str(p, 'bookrAccountId', true)) });
    }
    const total = int(bill, 'totalPaise')!;
    const settleDiscount = int(body, 'discountAtPaymentPaise', true) ?? 0;
    if (settleDiscount < 0 || sum + settleDiscount !== total) throw new Bad(`Payments (${sum}) and discount at payment (${settleDiscount}) do not add up to the bill (${total}).`);
    const tips = Array.isArray(body.tips) ? body.tips.map((x) => int(obj(x, 'tip'), 'amountPaise')!) : [];
    if (tips.some((x) => x <= 0)) throw new Bad('A tip is not above zero.');
    const together = Array.isArray(body.paidTogetherWith) ? body.paidTogetherWith.filter((x) => typeof x === 'string') : [];
    return [
      stmt(db, `INSERT INTO pos_bills (id, business_id, message_id, bill_no, entity_name, gst_registered, place, guest_name, printed_at, settled_at, shift_day,
          gross_paise, discount_paise, discount_reason, cgst_paise, sgst_paise, round_off_paise, total_paise, paid_together, settle_discount_paise, settle_discount_reason, tip_paise)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        billId, bid, id, str(bill, 'billNo'), str(bill, 'entityName'), bill.gstRegistered ? 1 : 0, str(bill, 'place', true), str(bill, 'guestName', true),
        int(bill, 'printedAt'), settledAt, day, int(bill, 'grossPaise'), int(bill, 'discountPaise'), str(bill, 'discountReason', true),
        int(bill, 'cgstPaise'), int(bill, 'sgstPaise'), int(bill, 'roundOffPaise'), total, JSON.stringify(together), settleDiscount,
        str(body, 'discountAtPaymentReason', true), tips.reduce((a, b) => a + b, 0)),
      ...lines.map(({ p, mode, amount, account }) => stmt(db, `INSERT INTO pos_payment_lines (id, business_id, message_id, bill_id, payment_id, kind, mode, amount_paise,
          payment_total_paise, account_id, pay_account, card_approval, card_last4, debtor_name, comp_guest, comp_reason, paid_at, shift_day)
        VALUES (?, ?, ?, ?, ?, 'bill', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), bid, id, billId, str(p, 'paymentId'), mode, amount, int(p, 'paymentTotalPaise', true) ?? amount, account, str(p, 'payAccountName', true),
        str(p, 'cardApproval', true), str(p, 'cardLast4', true), str(p, 'debtorName', true), str(p, 'compGuest', true), str(p, 'compReason', true), settledAt, day)),
    ];
  }
  if (kind === 'receipt') {
    const at = int(body, 'at')!;
    const k = str(body, 'kind')!;
    if (k !== 'receipt' && k !== 'advance') throw new Bad('kind must be receipt or advance.');
    const acc = obj(body.account, 'account');
    const pays = body.payments;
    if (!Array.isArray(pays) || !pays.length) throw new Bad('payments are missing.');
    const out = [];
    for (const raw of pays) {
      const p = obj(raw, 'payment');
      const mode = str(p, 'mode')!;
      if (!['cash', 'upi', 'card'].includes(mode)) throw new Bad('A receipt is paid by cash, UPI or card.');
      const amount = int(p, 'amountPaise')!;
      if (amount <= 0) throw new Bad('A payment amount is not above zero.');
      out.push(stmt(db, `INSERT INTO pos_payment_lines (id, business_id, message_id, bill_id, payment_id, kind, mode, amount_paise, payment_total_paise, account_id,
          pay_account, card_approval, card_last4, debtor_name, paid_at, shift_day) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(), bid, id, str(p, 'paymentId'), k, mode, amount, amount, await bookrAccount(db, bid, str(p, 'bookrAccountId', true)), str(p, 'payAccountName', true),
        str(p, 'cardApproval', true), str(p, 'cardLast4', true), str(acc, 'name'), at, shiftDayOf(at)));
    }
    return out;
  }
  if (kind === 'bill_void') {
    const at = int(body, 'voidedAt')!;
    return [stmt(db, 'INSERT INTO pos_voids (bill_no, business_id, message_id, total_paise, reason, voided_at, shift_day) VALUES (?, ?, ?, ?, ?, ?, ?)',
      str(body, 'billNo'), bid, id, int(body, 'totalPaise'), str(body, 'reason'), at, shiftDayOf(at))];
  }
  if (kind === 'shift_closed') {
    const day = str(body, 'shiftDay')!;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Bad('shiftDay must be a date.');
    return [stmt(db, `INSERT INTO pos_shift_closes (business_id, shift_day, message_id, counted_paise, expected_paise, difference_paise, difference_reason, closed_at, closed_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, bid, day, id, int(body, 'countedPaise'), int(body, 'expectedPaise'), int(body, 'differencePaise'),
      str(body, 'differenceReason', true), int(body, 'closedAt'), str(body, 'closedBy', true))];
  }
  if (kind === 'drawer_out') {
    const at = int(body, 'at')!;
    const k = str(body, 'kind')!;
    const mode = str(body, 'mode')!;
    if (k !== 'paid_out' && k !== 'refund') throw new Bad('kind must be paid_out or refund.');
    if (mode !== 'cash' && mode !== 'upi') throw new Bad('mode must be cash or upi.');
    const amount = int(body, 'amountPaise')!;
    if (amount <= 0) throw new Bad('amountPaise must be above zero.');
    const acc = body.account && typeof body.account === 'object' ? (body.account as Obj) : null;
    return [stmt(db, 'INSERT INTO pos_drawer_outs (id, business_id, message_id, kind, mode, amount_paise, note, debtor_name, at, shift_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      str(body, 'drawerOutId'), bid, id, k, mode, amount, str(body, 'note'), acc ? str(acc, 'name', true) : null, at, shiftDayOf(at))];
  }
  if (kind === 'credit_note') {
    const at = int(body, 'at')!;
    const mode = str(body, 'refundMode')!;
    if (!['cash', 'upi', 'card', 'account', 'none'].includes(mode)) throw new Bad('refundMode is not known.');
    return [stmt(db, `INSERT INTO pos_credit_notes (id, business_id, message_id, cn_no, bill_no, reason, taxable_paise, cgst_paise, sgst_paise, total_paise, refund_mode,
        account_id, debtor_name, at, shift_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      str(body, 'creditNoteId'), bid, id, str(body, 'cnNo'), str(body, 'billNo'), str(body, 'reason'), int(body, 'taxablePaise'), int(body, 'cgstPaise'),
      int(body, 'sgstPaise'), int(body, 'totalPaise'), mode, await bookrAccount(db, bid, str(body, 'bookrAccountId', true)), str(body, 'debtorName', true), at, shiftDayOf(at))];
  }
  throw new Bad(`kind ${kind} is not known.`);
}

// POST /api/pos/messages  Authorization: Bearer <key>  { businessId, messages: [{ id, kind, body }] } (up to 50)
// Answers each message: stored, duplicate (already here) or rejected (with why). The POS stops resending all three.
posRoutes.post('/pos/messages', async (c) => {
  const auth = c.req.header('Authorization') ?? '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  let data: Obj;
  try { data = obj(await c.req.json(), 'body'); } catch { fail(400, 'Send JSON.'); }
  const bid = typeof data.businessId === 'string' ? data.businessId : '';
  if (!key || !isUuid(bid) || !(await one(c.env.DB, 'SELECT 1 AS ok FROM pos_links WHERE business_id = ? AND key_hash = ?', bid, await sha256(key)))) {
    fail(401, 'This POS is not connected to that business.');
  }
  const messages = data.messages;
  if (!Array.isArray(messages) || messages.length > 50) fail(400, 'messages must be a list of up to 50.');
  const db = c.env.DB;
  const results: { id: string; result: 'stored' | 'duplicate' | 'rejected'; error?: string }[] = [];
  for (const raw of messages) {
    const m = raw && typeof raw === 'object' ? (raw as Obj) : {};
    const id = typeof m.id === 'string' && isUuid(m.id) ? m.id : null;
    if (!id) { results.push({ id: String(m.id ?? ''), result: 'rejected', error: 'Message id must be a UUID.' }); continue; }
    const have = await one<{ business_id: string }>(db, 'SELECT business_id FROM pos_messages WHERE id = ?', id);
    if (have) { results.push({ id, result: have.business_id === bid ? 'duplicate' : 'rejected', ...(have.business_id === bid ? {} : { error: 'Message id already used.' }) }); continue; }
    const kind = typeof m.kind === 'string' ? m.kind : '';
    const body = m.body && typeof m.body === 'object' ? (m.body as Obj) : null;
    const t = now();
    const save = (outcome: 'stored' | 'rejected', note: string | null) => stmt(db,
      'INSERT INTO pos_messages (id, business_id, kind, body, outcome, note, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, bid, ['bill_settled', 'bill_void', 'receipt', 'shift_closed', 'drawer_out', 'credit_note'].includes(kind) ? kind : 'bill_settled', JSON.stringify(body ?? {}), outcome, note, t);
    try {
      if (!body) throw new Bad('body is missing.');
      await db.batch([save('stored', null), ...(await file(db, bid, id, kind, body))]);
      results.push({ id, result: 'stored' });
    } catch (e) {
      const why = e instanceof Bad ? e.message
        : String((e as Error)?.message ?? '').includes('UNIQUE') ? 'Already have this bill, void or shift close under another message.' : null;
      if (why === null) throw e;
      // Kept, so a person can see what the POS sent and why it was not filed.
      await save('rejected', why).run();
      results.push({ id, result: 'rejected', error: why });
    }
  }
  return c.json({ results });
});

// ---------- one shift's POS bills, with the evidence Bookr already holds for each payment

posRoutes.get('/businesses/:businessId/pos', requireRole('sales.view'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const day = c.req.query('day') ?? shiftDayOf(now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'day must be a date.');
  const link = await one<{ created_at: number }>(db, 'SELECT created_at FROM pos_links WHERE business_id = ?', bid);
  const last = await one<{ at: number | null }>(db, 'SELECT max(received_at) AS at FROM pos_messages WHERE business_id = ?', bid);
  const rejected = await all(db, "SELECT id, kind, note, received_at AS receivedAt FROM pos_messages WHERE business_id = ? AND outcome = 'rejected' ORDER BY received_at DESC LIMIT 20", bid);
  const bills = await all<Record<string, unknown> & { id: string }>(db, `SELECT id, bill_no AS billNo, entity_name AS entityName, gst_registered AS gstRegistered, place,
      guest_name AS guestName, settled_at AS settledAt, gross_paise AS grossPaise, discount_paise AS discountPaise, discount_reason AS discountReason,
      cgst_paise + sgst_paise AS gstPaise, total_paise AS totalPaise, paid_together AS paidTogether,
      settle_discount_paise AS settleDiscountPaise, settle_discount_reason AS settleDiscountReason, tip_paise AS tipPaise
    FROM pos_bills WHERE business_id = ? AND shift_day = ? ORDER BY settled_at, bill_no`, bid, day);
  const lines = await all<{ id: string; bill_id: string | null; payment_id: string; kind: string; mode: string; amount_paise: number; payment_total_paise: number;
    account_id: string | null; account_name: string | null; pay_account: string | null; card_approval: string | null; card_last4: string | null;
    debtor_name: string | null; comp_guest: string | null; comp_reason: string | null; paid_at: number }>(db, `SELECT l.*, a.name AS account_name
    FROM pos_payment_lines l LEFT JOIN accounts a ON a.id = l.account_id WHERE l.business_id = ? AND l.shift_day = ? ORDER BY l.paid_at`, bid, day);

  // Evidence, read only. A card payment: the card machine's payment with the slip's approval code and last 4.
  // A UPI payment: credits of the whole tender's amount into its account within two hours.
  const evidence: Record<string, string> = {};
  for (const l of lines) {
    if (evidence[l.payment_id] !== undefined) continue;
    if (l.mode === 'card' && l.card_approval && l.card_last4) {
      const s = await one<{ settled_on: string; amount_paise: number }>(db, `SELECT settled_on, amount_paise FROM card_settlements
        WHERE business_id = ? AND upper(auth_code) = ? AND card_last4 = ? ORDER BY abs(paid_at - ?) LIMIT 1`, bid, l.card_approval.toUpperCase(), l.card_last4, l.paid_at);
      evidence[l.payment_id] = s ? `Card machine payment of ${rs(s.amount_paise)}, settled ${s.settled_on}` : 'Card report not in yet';
    }
    if (l.mode === 'upi') {
      const n = l.account_id ? (await one<{ n: number }>(db, `SELECT count(*) AS n FROM bank_rows WHERE business_id = ? AND account_id = ? AND kind = 'upi_in'
        AND amount_paise = ? AND posted_at BETWEEN ? AND ?`, bid, l.account_id, l.payment_total_paise, l.paid_at - 7200000, l.paid_at + 7200000))!.n : 0;
      evidence[l.payment_id] = !l.account_id ? 'No Bookr account set for this QR in the POS' : n === 1 ? 'One bank credit of this amount' : n ? `${n} bank credits of this amount` : 'No bank credit yet';
    }
  }
  const lineOut = (l: (typeof lines)[number]) => ({
    kind: l.kind, mode: l.mode, amountPaise: l.amount_paise, paymentTotalPaise: l.payment_total_paise, account: l.account_name ?? l.pay_account,
    cardApproval: l.card_approval, cardLast4: l.card_last4, debtor: l.debtor_name, compGuest: l.comp_guest, compReason: l.comp_reason, paidAt: l.paid_at,
    evidence: evidence[l.payment_id] ?? null,
  });
  const byMode: Record<string, number> = {};
  for (const l of lines.filter((x) => x.kind === 'bill')) byMode[l.mode] = (byMode[l.mode] ?? 0) + l.amount_paise;
  return c.json({
    day,
    link: link ? { connectedAt: link.created_at, lastMessageAt: last?.at ?? null } : null,
    bills: bills.map((b) => ({ ...b, paidTogether: JSON.parse(String(b.paidTogether)), payments: lines.filter((l) => l.bill_id === b.id).map(lineOut) })),
    receipts: lines.filter((l) => l.kind !== 'bill').map(lineOut),
    byMode,
    creditNotes: await all(db, 'SELECT cn_no AS cnNo, bill_no AS billNo, reason, total_paise AS totalPaise, refund_mode AS refundMode, at FROM pos_credit_notes WHERE business_id = ? AND shift_day = ? ORDER BY at', bid, day),
    drawerOuts: await all(db, 'SELECT kind, mode, amount_paise AS amountPaise, note, debtor_name AS debtor, at FROM pos_drawer_outs WHERE business_id = ? AND shift_day = ? ORDER BY at', bid, day),
    voids: await all(db, 'SELECT bill_no AS billNo, total_paise AS totalPaise, reason, voided_at AS voidedAt FROM pos_voids WHERE business_id = ? AND shift_day = ?', bid, day),
    shiftClose: await one(db, `SELECT counted_paise AS countedPaise, expected_paise AS expectedPaise, difference_paise AS differencePaise, difference_reason AS differenceReason,
      closed_at AS closedAt, closed_by AS closedBy FROM pos_shift_closes WHERE business_id = ? AND shift_day = ?`, bid, day),
    rejected,
  });
});

// ---------- the payment proof list (approved 24 Nov 2026)

const PROOF_MODES: PosMode[] = ['cash', 'upi', 'card', 'room', 'credit', 'comp', 'advance'];

/** One bill or receipt as the POS sends it for the list (printed bills too, which Bookr has not been sent). */
function proofBill(raw: unknown): ProofBill {
  const b = obj(raw, 'bill');
  const kind = str(b, 'kind');
  const state = str(b, 'state');
  if (kind !== 'bill' && kind !== 'receipt') throw new Bad('kind must be bill or receipt.');
  if (state !== 'printed' && state !== 'settled') throw new Bad('state must be printed or settled.');
  const tenders = b.tenders ?? [];
  if (!Array.isArray(tenders) || tenders.length > 20) throw new Bad('tenders must be a list.');
  return {
    key: str(b, 'key')!, billNo: str(b, 'billNo', true), kind, state, totalPaise: int(b, 'totalPaise')!, discountPaise: int(b, 'discountPaise', true) ?? 0,
    at: int(b, 'at')!, label: str(b, 'label', true),
    tenders: tenders.map((r) => {
      const t = obj(r, 'tender');
      const mode = str(t, 'mode') as PosMode;
      if (!PROOF_MODES.includes(mode)) throw new Bad(`mode ${mode} is not known.`);
      return { paymentId: str(t, 'paymentId')!, mode, amountPaise: int(t, 'amountPaise')!, totalPaise: int(t, 'totalPaise')!,
        cardApproval: str(t, 'cardApproval', true), cardLast4: str(t, 'cardLast4', true), paidAt: int(t, 'paidAt')! };
    }),
  };
}

async function proofAnswer(db: DB, bid: string, day: string, startHour: number, bills: ProofBill[]) {
  const [from, to] = shiftWindow(day, startHour);
  const { items, pairs, reading } = await loadProof(db, bid, from, to);
  const listener = await one<{ last_heartbeat_at: number | null; state: string | null }>(db, 'SELECT last_heartbeat_at, state FROM wa_listener_status WHERE id = 1');
  return { day, ...matchProof(bills, items, pairs, from, to), reading, listener: { lastSeenAt: listener?.last_heartbeat_at ?? null, state: listener?.state ?? null }, at: now() };
}

// POST /api/pos/proof  Authorization: Bearer <key>  { businessId, shiftDay, startHour, bills: [...] } (up to 600)
// The POS asks every 10-15 s with its own bills of the shift (printed and settled); Bookr answers each bill's proof and
// the extras. Reads only.
posRoutes.post('/pos/proof', async (c) => {
  const auth = c.req.header('Authorization') ?? '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  let data: Obj;
  try { data = obj(await c.req.json(), 'body'); } catch { fail(400, 'Send JSON.'); }
  const bid = typeof data.businessId === 'string' ? data.businessId : '';
  if (!key || !isUuid(bid) || !(await one(c.env.DB, 'SELECT 1 AS ok FROM pos_links WHERE business_id = ? AND key_hash = ?', bid, await sha256(key)))) {
    fail(401, 'This POS is not connected to that business.');
  }
  const day = typeof data.shiftDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.shiftDay) ? data.shiftDay : fail(400, 'shiftDay must be a date.');
  const startHour = data.startHour === undefined ? 8 : Number.isInteger(data.startHour) && (data.startHour as number) >= 0 && (data.startHour as number) <= 23
    ? (data.startHour as number) : fail(400, 'startHour must be 0 to 23.');
  if (!Array.isArray(data.bills) || data.bills.length > 600) fail(400, 'bills must be a list of up to 600.');
  let bills: ProofBill[];
  try { bills = (data.bills as unknown[]).map(proofBill); } catch (e) { if (e instanceof Bad) fail(400, e.message); throw e; }
  return c.json(await proofAnswer(c.env.DB, bid, day, startHour, bills));
});

// GET /api/businesses/:id/pos/proof?day=  The same list from the bills the POS has sent Bookr (settled only), for
// reconciling in Bookr.
posRoutes.get('/businesses/:businessId/pos/proof', requireRole('sales.view'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const day = c.req.query('day') ?? shiftDayOf(now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'day must be a date.');
  const rows = await all<{ id: string; bill_no: string; place: string | null; guest_name: string | null; printed_at: number; total_paise: number; discount_paise: number }>(db,
    `SELECT id, bill_no, place, guest_name, printed_at, total_paise, discount_paise + settle_discount_paise AS discount_paise
     FROM pos_bills WHERE business_id = ? AND shift_day = ? ORDER BY settled_at`, bid, day);
  const lines = await all<{ bill_id: string | null; payment_id: string; mode: PosMode; amount_paise: number; payment_total_paise: number;
    card_approval: string | null; card_last4: string | null; debtor_name: string | null; paid_at: number }>(db,
    `SELECT bill_id, payment_id, mode, amount_paise, payment_total_paise, card_approval, card_last4, debtor_name, paid_at
     FROM pos_payment_lines WHERE business_id = ? AND shift_day = ? ORDER BY paid_at`, bid, day);
  const tender = (l: (typeof lines)[number]) => ({ paymentId: l.payment_id, mode: l.mode, amountPaise: l.amount_paise, totalPaise: l.payment_total_paise,
    cardApproval: l.card_approval, cardLast4: l.card_last4, paidAt: l.paid_at });
  const bills: ProofBill[] = rows.map((b) => ({ key: b.id, billNo: b.bill_no, kind: 'bill', state: 'settled', totalPaise: b.total_paise,
    discountPaise: b.discount_paise, at: b.printed_at, label: b.place ?? b.guest_name, tenders: lines.filter((l) => l.bill_id === b.id).map(tender) }));
  const receipts = new Map<string, ProofBill>();
  for (const l of lines.filter((x) => !x.bill_id)) {
    const r = receipts.get(l.payment_id) ?? { key: l.payment_id, billNo: null, kind: 'receipt' as const, state: 'settled' as const, totalPaise: 0, discountPaise: 0,
      at: l.paid_at, label: l.debtor_name, tenders: [] };
    r.totalPaise += l.amount_paise;
    r.tenders.push(tender(l));
    receipts.set(l.payment_id, r);
  }
  return c.json(await proofAnswer(db, bid, day, 8, [...bills, ...receipts.values()]));
});

// ---------- WhatsApp reading, from the POS's Settings › WhatsApp (approved 27 Nov 2026)
// The POS checks its own staff's role on every request (owner or manager to switch a group, owner only to start a new
// one) and says who it is in `by`; Bookr checks the POS key, keeps the role rule too, and writes the name in the history
// (user_id empty, "by" in the change). Groups read for another business are never shown or changed.

/** The business the POS key proves, or a 401. */
async function posBusiness(c: { req: { header: (n: string) => string | undefined }; env: AppEnv['Bindings'] }, data: Obj): Promise<string> {
  const auth = c.req.header('Authorization') ?? '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const bid = typeof data.businessId === 'string' ? data.businessId : '';
  if (!key || !isUuid(bid) || !(await one(c.env.DB, 'SELECT 1 AS ok FROM pos_links WHERE business_id = ? AND key_hash = ?', bid, await sha256(key)))) {
    fail(401, 'This POS is not connected to that business.');
  }
  return bid;
}
async function posBody(c: { req: { json: () => Promise<unknown> } }): Promise<Obj> {
  try { return obj(await c.req.json(), 'body'); } catch { fail(400, 'Send JSON.'); }
}
const WA_ROLES = ['owner', 'manager'] as const;
/** "POS · Ravi (manager)", from { name, role }. */
function posBy(data: Obj, roles: readonly string[] = WA_ROLES): string {
  const by = data.by && typeof data.by === 'object' ? data.by as Obj : {};
  const name = typeof by.name === 'string' ? by.name.trim().slice(0, 60) : '';
  const role = typeof by.role === 'string' ? by.role : '';
  if (!name) fail(400, 'by.name is missing.');
  if (!roles.includes(role)) fail(403, roles.length === 1 ? 'Only the Owner can start reading a new group.' : 'Only an owner or manager can change WhatsApp reading.');
  return `POS · ${name} (${role})`;
}
const waAct = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e) { if (e instanceof InboxError) fail(e.status, e.message); throw e; }
};

async function waStatus(db: DB, bid: string) {
  const day = 86_400_000;
  const t = now();
  const todayFrom = Math.floor((t + IST_OFFSET_MS) / day) * day - IST_OFFSET_MS;
  const [view, listener, today] = await Promise.all([
    groupsView(db, bid),
    one<{ last_heartbeat_at: number | null; last_message_at: number | null; state: string | null }>(db,
      'SELECT last_heartbeat_at, last_message_at, state FROM wa_listener_status WHERE id = 1'),
    all<{ group_id: string; n: number }>(db, 'SELECT group_id, count(*) AS n FROM wa_items WHERE business_id = ? AND sent_at >= ? GROUP BY group_id', bid, todayFrom),
  ]);
  const byGroup = new Map(today.map((r) => [r.group_id, r.n]));
  return {
    listener: { lastSeenAt: listener?.last_heartbeat_at ?? null, lastMessageAt: listener?.last_message_at ?? null, state: listener?.state ?? null },
    groups: view.groups.map((g) => ({ id: g.id, name: g.name, department: g.department, active: g.active, posProof: g.posProof, lastAt: g.lastAt,
      today: byGroup.get(g.id) ?? 0 })),
    seen: view.seen,
    departments: view.departments,
    at: t,
  };
}

// POST /api/pos/wa  { businessId }  The listener's state and this business's groups.
posRoutes.post('/pos/wa', async (c) => {
  const data = await posBody(c);
  const bid = await posBusiness(c, data);
  return c.json(await waStatus(c.env.DB, bid));
});

// POST /api/pos/wa/edit  { businessId, groupId, active?, posProof?, by: { name, role } }  Owner or manager.
posRoutes.post('/pos/wa/edit', async (c) => {
  const data = await posBody(c);
  const bid = await posBusiness(c, data);
  const by = posBy(data);
  const id = typeof data.groupId === 'string' && isUuid(data.groupId) ? data.groupId : fail(404, 'Group not found.');
  for (const k of ['active', 'posProof']) if (data[k] !== undefined && typeof data[k] !== 'boolean') fail(400, `${k} must be true or false.`);
  if (data.active === undefined && data.posProof === undefined) fail(400, 'Nothing to change.');
  await waAct(() => editGroup(c.env.DB, bid, null, id, { active: data.active as boolean | undefined, posProof: data.posProof as boolean | undefined }, by));
  return c.json(await waStatus(c.env.DB, bid));
});

// POST /api/pos/wa/add  { businessId, waGroupId, department?, posProof?, by: { name, role } }  Owner only.
posRoutes.post('/pos/wa/add', async (c) => {
  const data = await posBody(c);
  const bid = await posBusiness(c, data);
  const by = posBy(data, ['owner']);
  const waGroupId = typeof data.waGroupId === 'string' && /^[0-9-]+@g\.us$/.test(data.waGroupId.trim()) ? data.waGroupId.trim() : fail(400, 'Choose a group the reception phone is in.');
  // Only a group the listener has seen: the POS picks from that list, never types an id.
  if (!await one(c.env.DB, 'SELECT 1 AS ok FROM wa_seen_groups WHERE wa_group_id = ?', waGroupId)) fail(400, 'The reception phone is not in that group.');
  const dep = data.department === undefined || data.department === null ? null : typeof data.department === 'string' && data.department.trim().length <= 80
    ? data.department.trim() || null : fail(400, 'Department must be short text.');
  if (data.posProof !== undefined && typeof data.posProof !== 'boolean') fail(400, 'posProof must be true or false.');
  await waAct(() => addGroup(c.env.DB, bid, null, { waGroupId, department: dep, posProof: data.posProof as boolean | undefined }, by));
  return c.json(await waStatus(c.env.DB, bid), 201);
});
