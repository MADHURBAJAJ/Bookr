// Taking payment. A bill closes only when its payments add up to its total exactly; every payment carries what Bookr
// matches it with (UPI account, card approval code and last 4, folio or credit account, complimentary guest and reason).
// One settle can pay several bills (paid together). Room, credit and advance payments go to the debtor ledger.
// Each settled bill becomes one outbox message for Bookr.
import { Hono } from 'hono';
import { all, newId, now, one, stmt, type DB } from '../../../src/db';
import { parsePaise } from '../../../src/money';
import { body, fail, isUuid, text } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { allocate, rs } from '../billing';
import { clock, event, isTrigger, loadBusiness, reasonLabel } from '../util';
import { billOut } from './orders';
import type { AppEnv } from '../types';

export const settleRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
settleRoutes.use(`${B}/*`, requireStaff);

type Mode = 'cash' | 'upi' | 'card' | 'room' | 'credit' | 'comp' | 'advance';
interface Pay {
  id: string; mode: Mode; amountPaise: number; tenderedPaise: number | null; payAccountId: string | null; payAccountEntity: string | null;
  cardApproval: string | null; cardLast4: string | null; debtorAccountId: string | null; newCredit: { name: string; phone: string | null } | null;
  compGuest: string | null; compReason: string | null;
}

const amountOf = (v: unknown, label: string): number => {
  const p = typeof v === 'string' ? parsePaise(v) : null;
  if (p === null || p <= 0) fail(400, `${label} must be an amount above zero, in rupees.`);
  return p;
};

async function balance(db: DB, accountId: string): Promise<number> {
  return (await one<{ s: number }>(db, 'SELECT coalesce(sum(amount_paise), 0) AS s FROM debtor_entries WHERE account_id = ?', accountId))!.s;
}

/** Checks one payment as typed at the counter. `allowed` limits the modes (a debtor receipt takes only money). */
async function readPayment(db: DB, bid: string, raw: unknown, n: number, allowed: Mode[]): Promise<Pay> {
  if (!raw || typeof raw !== 'object') fail(400, `Payment ${n} is not valid.`);
  const p = raw as Record<string, unknown>;
  const mode = p.mode as Mode;
  if (!allowed.includes(mode)) fail(400, `Payment ${n}: ${String(p.mode)} cannot be used here.`);
  const out: Pay = { id: newId(), mode, amountPaise: amountOf(p.amount, `Payment ${n} amount`), tenderedPaise: null, payAccountId: null, payAccountEntity: null,
    cardApproval: null, cardLast4: null, debtorAccountId: null, newCredit: null, compGuest: null, compReason: null };
  if (mode === 'cash' && p.tendered !== undefined && p.tendered !== null && p.tendered !== '') {
    out.tenderedPaise = amountOf(p.tendered, `Payment ${n} cash given`);
    if (out.tenderedPaise < out.amountPaise) fail(400, `Payment ${n}: cash given is less than the amount.`);
  }
  if (mode === 'upi') {
    const acc = await one<{ id: string; entity_id: string }>(db, 'SELECT id, entity_id FROM pay_accounts WHERE id = ? AND business_id = ? AND active = 1', p.payAccountId, bid);
    if (!acc) fail(400, `Payment ${n}: choose which account's QR was paid.`);
    out.payAccountId = acc.id;
    out.payAccountEntity = acc.entity_id;
  }
  if (mode === 'card') {
    const code = typeof p.cardApproval === 'string' ? p.cardApproval.trim().toUpperCase() : '';
    const last4 = typeof p.cardLast4 === 'string' ? p.cardLast4.trim() : '';
    if (!/^[A-Z0-9]{6}$/.test(code)) fail(400, `Payment ${n}: type the 6-character approval code from the card slip.`);
    if (!/^\d{4}$/.test(last4)) fail(400, `Payment ${n}: type the card's last 4 digits from the slip.`);
    out.cardApproval = code;
    out.cardLast4 = last4;
  }
  if (mode === 'room') {
    const a = await one<{ id: string }>(db, `SELECT d.id FROM debtor_accounts d JOIN stays s ON s.id = d.stay_id
      WHERE d.id = ? AND d.business_id = ? AND d.kind = 'room' AND s.checked_out_at IS NULL`, p.debtorAccountId, bid);
    if (!a) fail(400, `Payment ${n}: choose an in-house room.`);
    out.debtorAccountId = a.id;
  }
  if (mode === 'credit') {
    if (p.newCredit && typeof p.newCredit === 'object') {
      const nc = p.newCredit as Record<string, unknown>;
      out.newCredit = { name: text(nc, 'name', `Payment ${n}: new credit account name`, { max: 80 })!, phone: text(nc, 'phone', 'Phone', { optional: true, max: 20 }) };
      out.debtorAccountId = newId();
    } else {
      const a = await one<{ id: string; credit_limit_paise: number | null; name: string }>(db,
        "SELECT id, credit_limit_paise, name FROM debtor_accounts WHERE id = ? AND business_id = ? AND kind = 'credit'", p.debtorAccountId, bid);
      if (!a) fail(400, `Payment ${n}: choose a credit account, or add a new one.`);
      if (a.credit_limit_paise !== null && (await balance(db, a.id)) + out.amountPaise > a.credit_limit_paise) {
        fail(409, `Payment ${n}: ${a.name} would go over its credit limit of ${rs(a.credit_limit_paise)}.`);
      }
      out.debtorAccountId = a.id;
    }
  }
  if (mode === 'advance') {
    const a = await one<{ id: string; name: string }>(db, 'SELECT id, name FROM debtor_accounts WHERE id = ? AND business_id = ?', p.debtorAccountId, bid);
    if (!a) fail(400, `Payment ${n}: choose whose advance to use.`);
    const bal = await balance(db, a.id);
    if (-bal < out.amountPaise) fail(409, `Payment ${n}: ${a.name} has ${rs(Math.max(0, -bal))} of advance left.`);
    out.debtorAccountId = a.id;
  }
  if (mode === 'comp') {
    out.compGuest = text(p, 'compGuest', `Payment ${n}: the guest's name for a complimentary bill`, { max: 80 });
    out.compReason = await reasonLabel(db, bid, 'comp', p.reasonId, `Payment ${n}: a reason for the complimentary bill`);
  }
  return out;
}

function insertPayment(db: DB, bid: string, settlementId: string, p: Pay, shiftDay: string, staffId: string, t: number) {
  return stmt(db, `INSERT INTO payments (id, business_id, settlement_id, mode, amount_paise, tendered_paise, pay_account_id, card_approval, card_last4,
      debtor_account_id, comp_guest, comp_reason, shift_day, by_staff, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    p.id, bid, settlementId, p.mode, p.amountPaise, p.tenderedPaise, p.payAccountId, p.cardApproval, p.cardLast4, p.debtorAccountId,
    p.compGuest, p.compReason, shiftDay, staffId, t);
}

function newCreditAccount(db: DB, bid: string, p: Pay, staffId: string, t: number) {
  return stmt(db, "INSERT INTO debtor_accounts (id, business_id, kind, name, phone, created_by, created_at) VALUES (?, ?, 'credit', ?, ?, ?, ?)",
    p.debtorAccountId, bid, p.newCredit!.name, p.newCredit!.phone, staffId, t);
}

const confirmed = (data: Record<string, unknown>, what: string) => Array.isArray(data.confirm) && data.confirm.includes(what);

settleRoutes.post(`${B}/settlements`, requireAction('bills.settle'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const data = await body(c);
  const ids = data.billIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > 10 || new Set(ids).size !== ids.length || !ids.every((x) => typeof x === 'string' && isUuid(x))) {
    fail(400, 'Choose the bills being paid (up to 10).');
  }
  const bills = await all<{ id: string; bill_no: string; total_paise: number; status: string; entity_id: string; order_id: string }>(db,
    `SELECT id, bill_no, total_paise, status, entity_id, order_id FROM bills WHERE business_id = ? AND id IN (${ids.map(() => '?').join(',')})`, bid, ...ids);
  if (bills.length !== ids.length) fail(404, 'Bill not found.');
  const ordered = (ids as string[]).map((id) => bills.find((b) => b.id === id)!);
  for (const b of ordered) if (b.status !== 'printed') fail(409, `Bill ${b.bill_no} is ${b.status === 'void' ? 'void' : 'already paid'}.`);
  const due = ordered.reduce((s, b) => s + b.total_paise, 0);

  if (!Array.isArray(data.payments) || !data.payments.length || data.payments.length > 10) fail(400, 'Add how the bill was paid.');
  const pays: Pay[] = [];
  for (const [i, raw] of data.payments.entries()) pays.push(await readPayment(db, bid, raw, i + 1, ['cash', 'upi', 'card', 'room', 'credit', 'comp', 'advance']));
  const paid = pays.reduce((s, p) => s + p.amountPaise, 0);
  if (paid !== due) fail(400, paid < due ? `Payments come to ${rs(paid)}; ${rs(due - paid)} is still to pay.` : `Payments come to ${rs(paid)}, ${rs(paid - due)} more than the bill. Enter cash given as "cash given" so change is worked out.`);

  // A UPI payment into another billing name's account is asked about first (the bill and the money should agree).
  const entities = new Set(ordered.map((b) => b.entity_id));
  const mismatch = pays.filter((p) => p.mode === 'upi' && !entities.has(p.payAccountEntity!));
  if (mismatch.length && !confirmed(data, 'entity_mismatch')) {
    return c.json({ error: 'The UPI was paid into an account of another billing name. Check, then confirm to settle anyway.', code: 'entity_mismatch' }, 409);
  }

  const b = await loadBusiness(db, bid);
  const { t, shiftDay } = clock(b);
  const staff = c.get('staff');
  const settlementId = newId();
  const pieces = allocate(pays.map((p) => ({ id: p.id, amountPaise: p.amountPaise })), ordered.map((x) => ({ id: x.id, totalPaise: x.total_paise })));
  const statements = [
    stmt(db, "INSERT INTO settlements (id, business_id, kind, shift_day, by_staff, at) VALUES (?, ?, 'bills', ?, ?, ?)", settlementId, bid, shiftDay, staff.id, t),
    ...pays.filter((p) => p.newCredit).map((p) => newCreditAccount(db, bid, p, staff.id, t)),
    ...pays.map((p) => insertPayment(db, bid, settlementId, p, shiftDay, staff.id, t)),
    ...pieces.map((x) => stmt(db, 'INSERT INTO allocations (payment_id, bill_id, business_id, amount_paise) VALUES (?, ?, ?, ?)', x.paymentId, x.billId, bid, x.amountPaise)),
    // Room, credit and advance: what the guest or company owes moves to (or is taken from) their account.
    ...pieces.flatMap((x) => {
      const p = pays.find((q) => q.id === x.paymentId)!;
      if (p.mode !== 'room' && p.mode !== 'credit' && p.mode !== 'advance') return [];
      return [stmt(db, 'INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, bill_id, payment_id, by_staff, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        newId(), bid, p.debtorAccountId, p.mode === 'advance' ? 'advance_used' : 'charge', x.amountPaise, x.billId, p.id, staff.id, t)];
    }),
    ...ordered.map((x) => stmt(db, "UPDATE bills SET status = 'settled', settlement_id = ?, settled_at = ? WHERE id = ? AND status = 'printed'", settlementId, t, x.id)),
    ...ordered.map((x) => stmt(db, "UPDATE orders SET status = 'closed' WHERE id = ?", x.order_id)),
    ...pays.filter((p) => p.mode === 'comp').map((p) => event(db, bid, 'comp', ordered.map((x) => x.bill_no).join(', '), p.amountPaise, p.compReason, `Guest: ${p.compGuest}`, staff.id, shiftDay)),
  ];
  // One message per bill for Bookr, in the same batch, with the bill as printed and its share of each payment.
  for (const x of ordered) {
    const { payments: _none, ...printed } = await billOut(db, bid, x.id);
    delete (printed as Record<string, unknown>).status;
    statements.push(stmt(db, "INSERT INTO outbox (id, business_id, kind, body, created_at) VALUES (?, ?, 'bill_settled', ?, ?)",
      newId(), bid, JSON.stringify({ ...settledMessage(x.id, ordered, pays, pieces, shiftDay, t, staff.name), bill: printed }), t));
  }
  try {
    await db.batch(statements);
  } catch (e) {
    if (isTrigger(e, 'shift_closed')) fail(409, 'This shift is closed. Ask an Owner.');
    if (isTrigger(e, 'bill_frozen')) fail(409, 'One of these bills changed meanwhile. Open it again.');
    throw e;
  }
  const change = pays.reduce((s, p) => s + (p.tenderedPaise ? p.tenderedPaise - p.amountPaise : 0), 0);
  return c.json({ settlementId, changePaise: change, bills: await Promise.all(ordered.map((x) => billOut(db, bid, x.id))) }, 201);
});

function settledMessage(billId: string, bills: { id: string; bill_no: string }[], pays: Pay[], pieces: { paymentId: string; billId: string; amountPaise: number }[], shiftDay: string, t: number, by: string) {
  return {
    billId,
    settledShiftDay: shiftDay,
    settledAt: t,
    settledBy: by,
    paidTogetherWith: bills.filter((b) => b.id !== billId).map((b) => b.bill_no),
    payments: pieces.filter((x) => x.billId === billId).map((x) => {
      const p = pays.find((q) => q.id === x.paymentId)!;
      return { paymentId: p.id, mode: p.mode, amountPaise: x.amountPaise, paymentTotalPaise: p.amountPaise, payAccountId: p.payAccountId,
        cardApproval: p.cardApproval, cardLast4: p.cardLast4, debtorAccountId: p.debtorAccountId, compGuest: p.compGuest, compReason: p.compReason };
    }),
  };
}

// Money received against a folio or credit account (kind 'receipt'), or paid in before any bill (kind 'advance').
settleRoutes.post(`${B}/debtors/:id/receipts`, requireAction('debtors.receive'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const acc = await one<{ id: string; kind: string; name: string }>(db, 'SELECT id, kind, name FROM debtor_accounts WHERE id = ? AND business_id = ?', c.req.param('id'), bid);
  if (!acc) fail(404, 'Account not found.');
  const data = await body(c);
  const kind = data.kind;
  if (kind !== 'receipt' && kind !== 'advance') fail(400, 'Kind must be receipt or advance.');
  if (!Array.isArray(data.payments) || !data.payments.length || data.payments.length > 5) fail(400, 'Add how it was paid.');
  const pays: Pay[] = [];
  for (const [i, raw] of data.payments.entries()) pays.push(await readPayment(db, bid, raw, i + 1, ['cash', 'upi', 'card']));
  const total = pays.reduce((s, p) => s + p.amountPaise, 0);
  const owed = await balance(db, acc.id);
  if (kind === 'receipt' && total > owed) fail(400, owed > 0 ? `${acc.name} owes ${rs(owed)}. Take the rest as an advance.` : `${acc.name} owes nothing. Take it as an advance.`);
  const b = await loadBusiness(db, bid);
  const { t, shiftDay } = clock(b);
  const staff = c.get('staff');
  const settlementId = newId();
  try {
    await db.batch([
      stmt(db, "INSERT INTO settlements (id, business_id, kind, shift_day, by_staff, at) VALUES (?, ?, 'receipt', ?, ?, ?)", settlementId, bid, shiftDay, staff.id, t),
      ...pays.map((p) => insertPayment(db, bid, settlementId, { ...p, debtorAccountId: null }, shiftDay, staff.id, t)),
      ...pays.map((p) => stmt(db, 'INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, payment_id, by_staff, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        newId(), bid, acc.id, kind, -p.amountPaise, p.id, staff.id, t)),
      stmt(db, "INSERT INTO outbox (id, business_id, kind, body, created_at) VALUES (?, ?, 'receipt', ?, ?)", newId(), bid, JSON.stringify({
        settlementId, kind, account: { id: acc.id, kind: acc.kind, name: acc.name }, shiftDay, at: t, by: staff.name,
        payments: pays.map((p) => ({ paymentId: p.id, mode: p.mode, amountPaise: p.amountPaise, payAccountId: p.payAccountId, cardApproval: p.cardApproval, cardLast4: p.cardLast4 })),
      }), t),
    ]);
  } catch (e) {
    if (isTrigger(e, 'shift_closed')) fail(409, 'This shift is closed. Ask an Owner.');
    throw e;
  }
  return c.json({ settlementId, balancePaise: await balance(db, acc.id) }, 201);
});

settleRoutes.get(`${B}/debtors/:id`, requireAction('pos.view'), async (c) => {
  const bid = c.get('businessId');
  const acc = await one(c.env.DB, 'SELECT id, kind, name, phone, credit_limit_paise AS creditLimitPaise FROM debtor_accounts WHERE id = ? AND business_id = ?', c.req.param('id'), bid);
  if (!acc) fail(404, 'Account not found.');
  const entries = await all(c.env.DB, `SELECT e.kind, e.amount_paise AS amountPaise, e.at, b.bill_no AS billNo, p.mode
    FROM debtor_entries e LEFT JOIN bills b ON b.id = e.bill_id LEFT JOIN payments p ON p.id = e.payment_id
    WHERE e.account_id = ? ORDER BY e.at, e.id`, c.req.param('id'));
  return c.json({ account: acc, entries, balancePaise: await balance(c.env.DB, c.req.param('id')) });
});
