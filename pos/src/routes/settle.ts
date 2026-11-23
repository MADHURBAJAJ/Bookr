// Taking payment. A bill closes only when its payments add up to its total exactly; every payment carries what Bookr
// matches it with (UPI account, card approval code and last 4, folio or credit account, complimentary guest and reason).
// One settle can pay several bills (paid together). Room, credit and advance payments go to the debtor ledger.
// Each settled bill becomes one outbox message for Bookr.
import { Hono, type Context } from 'hono';
import { all, newId, now, one, stmt, type DB } from '../../../src/db';
import { parsePaise } from '../../../src/money';
import { body, fail, isUuid, text } from '../../../src/http';
import { approval, isManager, requireAction, requireStaff } from '../auth';
import { allocateLoose, rs } from '../billing';
import { audit, clock, event, isNcPlace, isTrigger, bizOf, loadBusiness, reasonLabel, tableLayout } from '../util';
import { billOut } from './orders';
import { phoneKey } from './settings';
import { sendSoon } from '../sync';
import { syncStay } from '../rooms';
import { saleMoves } from '../stock';
import type { AppEnv } from '../types';

export const settleRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
settleRoutes.use(`${B}/*`, requireStaff);

type Mode = 'cash' | 'upi' | 'card' | 'room' | 'credit' | 'comp' | 'advance';
interface Pay {
  id: string; mode: Mode; amountPaise: number; tenderedPaise: number | null; payAccountId: string | null; payAccountEntity: string | null;
  cardApproval: string | null; cardLast4: string | null; debtorAccountId: string | null; newCredit: { name: string; phone: string | null } | null;
  compGuest: string | null; compReason: string | null; payAccountName: string | null; bookrAccountId: string | null; debtorName: string | null;
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
    cardApproval: null, cardLast4: null, debtorAccountId: null, newCredit: null, compGuest: null, compReason: null, payAccountName: null, bookrAccountId: null, debtorName: null };
  if (mode === 'cash' && p.tendered !== undefined && p.tendered !== null && p.tendered !== '') {
    out.tenderedPaise = amountOf(p.tendered, `Payment ${n} cash given`);
    if (out.tenderedPaise < out.amountPaise) fail(400, `Payment ${n}: cash given is less than the amount.`);
  }
  if (mode === 'upi') {
    const acc = await one<{ id: string; entity_id: string; name: string; bookr_account_id: string | null }>(db, 'SELECT id, entity_id, name, bookr_account_id FROM pay_accounts WHERE id = ? AND business_id = ? AND active = 1', p.payAccountId ?? null, bid);
    if (!acc) fail(400, `Payment ${n}: choose which account's QR was paid.`);
    out.payAccountId = acc.id;
    out.payAccountEntity = acc.entity_id;
    out.payAccountName = acc.name;
    out.bookrAccountId = acc.bookr_account_id;
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
    const a = await one<{ id: string; name: string }>(db, `SELECT d.id, d.name FROM debtor_accounts d JOIN stays s ON s.id = d.stay_id
      WHERE d.id = ? AND d.business_id = ? AND d.kind = 'room' AND s.checked_out_at IS NULL`, p.debtorAccountId ?? null, bid);
    if (!a) fail(400, `Payment ${n}: choose an in-house room.`);
    out.debtorAccountId = a.id;
    out.debtorName = a.name;
  }
  if (mode === 'credit') {
    if (p.newCredit && typeof p.newCredit === 'object') {
      const nc = p.newCredit as Record<string, unknown>;
      // A new credit account needs a name and a phone (22 Nov 2026).
      const phone = phoneKey(nc.phone);
      if (!phone) fail(400, `Payment ${n}: add the phone number for the new credit account.`);
      const name = text(nc, 'name', `Payment ${n}: new credit account name`, { max: 80 })!;
      // One account per phone (25 Nov 2026): a phone that already has a credit account goes on that account.
      const same = await all<{ id: string; credit_limit_paise: number | null; name: string }>(db,
        "SELECT id, credit_limit_paise, name FROM debtor_accounts WHERE business_id = ? AND kind = 'credit' AND phone = ? ORDER BY created_at LIMIT 2", bid, phone);
      if (same.length === 1) {
        const a = same[0];
        if (a.credit_limit_paise !== null && (await balance(db, a.id)) + out.amountPaise > a.credit_limit_paise) {
          fail(409, `Payment ${n}: ${a.name} would go over its credit limit of ${rs(a.credit_limit_paise)}.`);
        }
        out.debtorAccountId = a.id;
        out.debtorName = a.name;
        return out;
      }
      out.newCredit = { name, phone };
      out.debtorAccountId = newId();
      out.debtorName = out.newCredit.name;
    } else {
      const a = await one<{ id: string; credit_limit_paise: number | null; name: string }>(db,
        "SELECT id, credit_limit_paise, name FROM debtor_accounts WHERE id = ? AND business_id = ? AND kind = 'credit'", p.debtorAccountId ?? null, bid);
      if (!a) fail(400, `Payment ${n}: choose a credit account, or add a new one.`);
      if (a.credit_limit_paise !== null && (await balance(db, a.id)) + out.amountPaise > a.credit_limit_paise) {
        fail(409, `Payment ${n}: ${a.name} would go over its credit limit of ${rs(a.credit_limit_paise)}.`);
      }
      out.debtorAccountId = a.id;
      out.debtorName = a.name;
    }
  }
  if (mode === 'advance') {
    const a = await one<{ id: string; name: string }>(db, 'SELECT id, name FROM debtor_accounts WHERE id = ? AND business_id = ?', p.debtorAccountId ?? null, bid);
    if (!a) fail(400, `Payment ${n}: choose whose advance to use.`);
    const bal = await balance(db, a.id);
    if (-bal < out.amountPaise) fail(409, `Payment ${n}: ${a.name} has ${rs(Math.max(0, -bal))} of advance left.`);
    out.debtorAccountId = a.id;
    out.debtorName = a.name;
  }
  if (mode === 'comp') {
    out.compGuest = text(p, 'compGuest', `Payment ${n}: the guest's name for a complimentary bill`, { max: 80 });
    out.compReason = p.nc === true ? 'NC (non-chargeable)' : await reasonLabel(db, bid, 'comp', p.reasonId, `Payment ${n}: a reason for the complimentary bill`);
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

  // An NC table (non-chargeable, 21 Nov 2026): a manager or owner closes it as complimentary in the person's name.
  if (data.nc === true) {
    if (!isManager(c)) fail(403, 'NC bills are closed by a manager or owner.');
    const places = await all<{ place: string; kind: string }>(db, 'SELECT place, kind FROM orders WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(ordered.map((b) => b.order_id)));
    const layout = tableLayout(bizOf(c));
    if (!places.length || places.some((p) => p.kind !== 'table' || !isNcPlace(layout, p.place))) fail(400, 'Only bills from NC tables close as NC.');
    data.payments = [{ mode: 'comp', amount: `${Math.floor(due / 100)}.${String(due % 100).padStart(2, '0')}`, compGuest: places[0].place, nc: true }];
  }
  if (!Array.isArray(data.payments) || !data.payments.length || data.payments.length > 10) fail(400, 'Add how the bill was paid.');
  // On credit with the guest's details from the table (25 Nov 2026): the phone kept on the bill (or its order) is used
  // when the counter asks for it; the screen only ever sees its last 4 digits.
  const guest = await one<{ name: string | null; phone: string | null }>(db, `SELECT coalesce(b.guest_name, o.guest_name) AS name, coalesce(b.guest_phone, o.guest_phone) AS phone
    FROM bills b JOIN orders o ON o.id = b.order_id WHERE b.id = ?`, ordered[0].id);
  for (const raw of data.payments as Record<string, unknown>[]) {
    const nc = raw?.mode === 'credit' && raw.newCredit && typeof raw.newCredit === 'object' ? raw.newCredit as Record<string, unknown> : null;
    if (nc?.useGuestPhone === true && !(typeof nc.phone === 'string' && nc.phone.trim())) {
      if (!guest?.phone) fail(400, 'This table has no phone number. Type the phone for the credit account.');
      nc.phone = guest.phone;
    }
  }
  const pays: Pay[] = [];
  for (const [i, raw] of data.payments.entries()) pays.push(await readPayment(db, bid, raw, i + 1, ['cash', 'upi', 'card', 'room', 'credit', 'comp', 'advance']));
  const paid = pays.reduce((s, p) => s + p.amountPaise, 0);
  // Paid less: the rest is a discount at payment (with a reason). Paid more: the extra is a tip. Asked for, never assumed.
  const diff = (data.difference ?? null) as Record<string, unknown> | null;
  let discountReason: string | null = null;
  if (paid < due) {
    if (diff?.kind !== 'discount') fail(400, `Payments come to ${rs(paid)}; ${rs(due - paid)} is still to pay, or mark it as a discount.`);
    discountReason = await reasonLabel(db, bid, 'discount', diff.reasonId, 'A reason for the discount');
  } else if (paid > due) {
    if (diff?.kind !== 'tip') fail(400, `Payments come to ${rs(paid)}, ${rs(paid - due)} more than the bill. Mark it as a tip, or enter cash given so change is worked out.`);
  }

  // Steps a cashier may not take alone (21 Nov 2026): a complimentary bill (NC tables are closed by a manager already),
  // a new credit account, or taking less than the bill by more than the discount limit.
  const b0 = bizOf(c);
  const needs = [
    pays.some((p) => p.mode === 'comp') && data.nc !== true ? 'A complimentary bill' : null,
    pays.some((p) => p.newCredit) ? 'A new credit account' : null,
    paid < due && (due - paid) * 10000 > due * b0.disc_limit_bp ? `Taking ${rs(due - paid)} less than the bill` : null,
  ].filter(Boolean) as string[];
  const approver = needs.length && data.nc !== true ? await approval(c, data, needs.join(' and ')) : null;
  const approved = approver && !isManager(c) ? ` · Approved by ${approver.name}` : '';

  // A UPI payment into another billing name's account is asked about first (the bill and the money should agree).
  const entities = new Set(ordered.map((b) => b.entity_id));
  const mismatch = pays.filter((p) => p.mode === 'upi' && !entities.has(p.payAccountEntity!));
  if (mismatch.length && !confirmed(data, 'entity_mismatch')) {
    return c.json({ error: 'The UPI was paid into an account of another billing name. Check, then confirm to settle anyway.', code: 'entity_mismatch' }, 409);
  }

  const b = bizOf(c);
  const { t, shiftDay } = clock(b);
  const staff = c.get('staff');
  const settlementId = newId();
  const { pieces, over, short } = allocateLoose(pays.map((p) => ({ id: p.id, amountPaise: p.amountPaise })), ordered.map((x) => ({ id: x.id, totalPaise: x.total_paise })));
  for (const o of over) {
    const p = pays.find((q) => q.id === o.paymentId)!;
    if (!['cash', 'upi', 'card'].includes(p.mode)) fail(400, 'A tip can only come with a cash, UPI or card payment. Put that payment last.');
  }
  const statements = [
    stmt(db, "INSERT INTO settlements (id, business_id, kind, shift_day, by_staff, at) VALUES (?, ?, 'bills', ?, ?, ?)", settlementId, bid, shiftDay, staff.id, t),
    ...pays.filter((p) => p.newCredit).flatMap((p) => [newCreditAccount(db, bid, p, staff.id, t),
      audit(db, bid, staff.id, 'credit_account.create', 'debtor_accounts', p.debtorAccountId!, null, { name: p.newCredit!.name, phone: p.newCredit!.phone, approvedBy: approver?.name ?? null })]),
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
    // A phone typed for a new credit account is kept on the bill and its order when the table had none.
    ...(!guest?.phone && pays.find((p) => p.newCredit)?.newCredit?.phone ? [
      stmt(db, 'UPDATE bills SET guest_phone = ? WHERE id = ? AND guest_phone IS NULL', pays.find((p) => p.newCredit)!.newCredit!.phone, ordered[0].id),
      stmt(db, 'UPDATE orders SET guest_phone = ? WHERE id = ? AND guest_phone IS NULL', pays.find((p) => p.newCredit)!.newCredit!.phone, ordered[0].order_id)] : []),
    ...pays.filter((p) => p.mode === 'comp').map((p) => event(db, bid, 'comp', ordered.map((x) => x.bill_no).join(', '), p.amountPaise, p.compReason, `Guest: ${p.compGuest}${approved}`, staff.id, shiftDay)),
    ...short.flatMap((x) => [
      stmt(db, "INSERT INTO settle_differences (id, business_id, settlement_id, kind, bill_id, amount_paise, reason, shift_day, by_staff, at) VALUES (?, ?, ?, 'discount', ?, ?, ?, ?, ?, ?)",
        newId(), bid, settlementId, x.billId, x.amountPaise, discountReason, shiftDay, staff.id, t),
      event(db, bid, 'discount', ordered.find((o) => o.id === x.billId)!.bill_no, x.amountPaise, discountReason, `At payment (paid less than the bill)${approved}`, staff.id, shiftDay),
    ]),
    ...over.map((x) => stmt(db, "INSERT INTO settle_differences (id, business_id, settlement_id, kind, payment_id, amount_paise, shift_day, by_staff, at) VALUES (?, ?, ?, 'tip', ?, ?, ?, ?, ?)",
      newId(), bid, settlementId, x.paymentId, x.amountPaise, shiftDay, staff.id, t)),
  ];
  // Stock the bills used (recipes), in the same batch.
  statements.push(...(await saleMoves(db, bid, ordered.map((x) => x.id), staff.id, shiftDay, t)));
  // One message per bill for Bookr, in the same batch, with the bill as printed and its share of each payment.
  for (const x of ordered) {
    const { payments: _none, ...printed } = await billOut(db, bid, x.id);
    delete (printed as Record<string, unknown>).status;
    statements.push(stmt(db, "INSERT INTO outbox (id, business_id, kind, body, created_at) VALUES (?, ?, 'bill_settled', ?, ?)",
      newId(), bid, JSON.stringify({ ...settledMessage(x.id, ordered, pays, pieces, shiftDay, t, staff.name), bill: printed,
        discountAtPaymentPaise: short.find((d) => d.billId === x.id)?.amountPaise ?? 0, discountAtPaymentReason: short.some((d) => d.billId === x.id) ? discountReason : null,
        // Tips go with the last bill of the settle: [{paymentId, mode, amountPaise}].
        tips: x.id === ordered[ordered.length - 1].id ? over.map((o) => ({ paymentId: o.paymentId, mode: pays.find((q) => q.id === o.paymentId)!.mode, amountPaise: o.amountPaise })) : [] }), t));
  }
  try {
    await db.batch(statements);
  } catch (e) {
    if (isTrigger(e, 'shift_closed')) fail(409, 'This shift is closed. Ask an Owner.');
    if (isTrigger(e, 'bill_frozen')) fail(409, 'One of these bills changed meanwhile. Open it again.');
    throw e;
  }
  sendSoon(c, bid);
  const change = pays.reduce((s, p) => s + (p.tenderedPaise ? p.tenderedPaise - p.amountPaise : 0), 0);
  return c.json({ settlementId, changePaise: change, tipPaise: over.reduce((t2, o) => t2 + o.amountPaise, 0), discountPaise: due - paid > 0 ? due - paid : 0, bills: await Promise.all(ordered.map((x) => billOut(db, bid, x.id))) }, 201);
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
        payAccountName: p.payAccountName, bookrAccountId: p.bookrAccountId, cardApproval: p.cardApproval, cardLast4: p.cardLast4,
        debtorAccountId: p.debtorAccountId, debtorName: p.debtorName, compGuest: p.compGuest, compReason: p.compReason };
    }),
  };
}

// The guest on a bill (from the table) and the credit accounts with the same phone, for paying on credit (25 Nov 2026).
// The phone is shown only as its last 4 digits.
settleRoutes.get(`${B}/bills/:id/credit-match`, requireAction('bills.settle'), async (c) => {
  const bid = c.get('businessId');
  const id = c.req.param('id');
  const g = await one<{ name: string | null; phone: string | null }>(c.env.DB, `SELECT coalesce(b.guest_name, o.guest_name) AS name, coalesce(b.guest_phone, o.guest_phone) AS phone
    FROM bills b JOIN orders o ON o.id = b.order_id WHERE b.id = ? AND b.business_id = ?`, isUuid(id) ? id : null, bid);
  if (!g) fail(404, 'Bill not found.');
  const matches = g.phone ? await all<{ id: string; name: string; creditLimitPaise: number | null; balancePaise: number }>(c.env.DB, `SELECT d.id, d.name, d.credit_limit_paise AS creditLimitPaise,
      coalesce((SELECT sum(amount_paise) FROM debtor_entries e WHERE e.account_id = d.id), 0) AS balancePaise
    FROM debtor_accounts d WHERE d.business_id = ? AND d.kind = 'credit' AND d.phone = ? ORDER BY d.name`, bid, g.phone) : [];
  return c.json({ guestName: g.name, hasPhone: !!g.phone, phoneEnd: g.phone ? g.phone.slice(-4) : null, matches });
});

// Money received against a folio or credit account (kind 'receipt'), paid in before any bill (kind 'advance'), or a
// refundable deposit on a room (kind 'deposit', 24 Nov 2026: kept apart from rent, refunded at check-out). Each gets a
// receipt number (RCPT/26-27/0001), running per business and financial year, for the printed receipt.
settleRoutes.post(`${B}/debtors/:id/receipts`, requireAction('debtors.receive'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const acc = await one<{ id: string; kind: string; name: string }>(db, 'SELECT id, kind, name FROM debtor_accounts WHERE id = ? AND business_id = ?', c.req.param('id'), bid);
  if (!acc) fail(404, 'Account not found.');
  const data = await body(c);
  const kind = data.kind;
  if (kind !== 'receipt' && kind !== 'advance' && kind !== 'deposit') fail(400, 'Kind must be receipt, advance or deposit.');
  if (kind === 'deposit' && acc.kind !== 'room') fail(400, 'A deposit is taken on a room.');
  if (!Array.isArray(data.payments) || !data.payments.length || data.payments.length > 5) fail(400, 'Add how it was paid.');
  const pays: Pay[] = [];
  for (const [i, raw] of data.payments.entries()) pays.push(await readPayment(db, bid, raw, i + 1, ['cash', 'upi', 'card']));
  const total = pays.reduce((s, p) => s + p.amountPaise, 0);
  const owed = await balance(db, acc.id);
  if (kind === 'receipt' && total > owed) fail(400, owed > 0 ? `${acc.name} owes ${rs(owed)}. Take the rest as an advance.` : `${acc.name} owes nothing. Take it as an advance.`);
  const b = bizOf(c);
  const { t, shiftDay, fy } = clock(b);
  const staff = c.get('staff');
  const settlementId = newId();
  try {
    await db.batch([
      ...receiptSettlement(db, bid, settlementId, shiftDay, fy, staff.id, t),
      ...pays.map((p) => insertPayment(db, bid, settlementId, { ...p, debtorAccountId: null }, shiftDay, staff.id, t)),
      ...pays.map((p) => stmt(db, 'INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, payment_id, by_staff, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        newId(), bid, acc.id, kind, -p.amountPaise, p.id, staff.id, t)),
      stmt(db, "INSERT INTO outbox (id, business_id, kind, body, created_at) VALUES (?, ?, 'receipt', ?, ?)", newId(), bid, JSON.stringify({
        // Bookr knows receipts and advances: a deposit is money held, as an advance is.
        settlementId, kind: kind === 'deposit' ? 'advance' : kind, account: { id: acc.id, kind: acc.kind, name: acc.name }, shiftDay, at: t, by: staff.name,
        payments: pays.map((p) => ({ paymentId: p.id, mode: p.mode, amountPaise: p.amountPaise, payAccountId: p.payAccountId, payAccountName: p.payAccountName,
          bookrAccountId: p.bookrAccountId, cardApproval: p.cardApproval, cardLast4: p.cardLast4 })),
      }), t),
    ]);
  } catch (e) {
    if (isTrigger(e, 'shift_closed')) fail(409, 'This shift is closed. Ask an Owner.');
    throw e;
  }
  sendSoon(c, bid);
  const receiptNo = (await one<{ receipt_no: string }>(db, 'SELECT receipt_no FROM settlements WHERE id = ?', settlementId))!.receipt_no;
  const room = acc.kind === 'room' ? await one<{ room: string; guest_name: string }>(db, 'SELECT s.room, s.guest_name FROM stays s JOIN debtor_accounts d ON d.stay_id = s.id WHERE d.id = ?', acc.id) : null;
  const balancePaise = await balance(db, acc.id);
  return c.json({ settlementId, balancePaise, receipt: { receiptNo, kind, at: t, name: room?.guest_name ?? acc.name, room: room?.room ?? null, totalPaise: total, balancePaise,
    payments: pays.map((p) => ({ mode: p.mode, amountPaise: p.amountPaise, payAccountName: p.payAccountName, cardLast4: p.cardLast4 })) } }, 201);
});

/** A numbered receipt (RCPT/26-27/0001): its settlement row, numbered in the same batch. */
function receiptSettlement(db: DB, bid: string, settlementId: string, shiftDay: string, fy: string, staffId: string, t: number) {
  return [
    stmt(db, 'INSERT OR IGNORE INTO receipt_series (business_id, fy, next_no) VALUES (?, ?, 1)', bid, fy),
    stmt(db, `INSERT INTO settlements (id, business_id, kind, shift_day, by_staff, at, receipt_no)
      SELECT ?, ?, 'receipt', ?, ?, ?, 'RCPT/' || substr(?, 3) || '/' || printf('%04d', next_no) FROM receipt_series WHERE business_id = ? AND fy = ?`,
      settlementId, bid, shiftDay, staffId, t, fy, bid, fy),
    stmt(db, 'UPDATE receipt_series SET next_no = next_no + 1 WHERE business_id = ? AND fy = ?', bid, fy),
  ];
}

// ---------- advances taken at the desk before check-in (24 Nov 2026)
// For a booking Djubo has (reception may also enter it in Djubo: the POS then sees it is already taken), or before Djubo has
// the booking (name, phone and check-in day; attached to the booking when its mail arrives). A numbered advance receipt
// prints; the money is in this shift's drawer; at check-in it moves onto the room's bill.
settleRoutes.post(`${B}/desk-advances`, requireAction('debtors.receive'), async (c) => c.json(await deskAdvance(c, await body(c)), 201));

/** Checks the payments typed for a receipt (cash, UPI or card), before anything is saved. */
export async function checkReceiptPayments(c: Context<AppEnv>, payments: unknown) {
  if (!Array.isArray(payments) || !payments.length || payments.length > 5) fail(400, 'Add how it was paid.');
  for (const [i, raw] of payments.entries()) await readPayment(c.env.DB, c.get('businessId'), raw, i + 1, ['cash', 'upi', 'card']);
}

/**
 * An advance taken at the desk, with its numbered receipt: for a Djubo booking, a reservation made here (25 Nov 2026), or
 * before Djubo has the booking (name, phone and check-in day).
 */
export async function deskAdvance(c: Context<AppEnv>, data: Record<string, unknown>, reservation?: { id: string; guest: string; phone: string; checkIn: string; checkOut: string }) {
  const bid = c.get('businessId');
  const db = c.env.DB;
  let booking: { id: string; ext_ref: string; guest_name: string | null; phone: string | null; check_in: string | null; check_out: string | null; status: string } | null = null;
  if (data.bookingId !== undefined && data.bookingId !== null && data.bookingId !== '') {
    booking = await one(db, 'SELECT id, ext_ref, guest_name, phone, check_in, check_out, status FROM bookings WHERE id = ? AND business_id = ?', isUuid(String(data.bookingId)) ? data.bookingId : null, bid);
    if (!booking) fail(404, 'Booking not found.');
    if (booking.status === 'cancelled') fail(409, 'This booking was cancelled.');
    if (booking.status === 'checked_in') fail(409, 'This guest is checked in: take it on the room bill.');
  }
  const guest = booking?.guest_name ?? reservation?.guest ?? text(data, 'guestName', 'Guest name', { max: 80 })!;
  const phone = booking ? booking.phone : reservation?.phone ?? phoneKey(data.phone);
  if (!booking && !phone) fail(400, "Add the guest's phone, so the advance finds its Djubo booking.");
  const checkIn = booking?.check_in ?? reservation?.checkIn ?? (typeof data.checkIn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.checkIn) ? data.checkIn : fail(400, 'Check-in must be a date.'));
  if (!Array.isArray(data.payments) || !data.payments.length || data.payments.length > 5) fail(400, 'Add how it was paid.');
  const pays: Pay[] = [];
  for (const [i, raw] of data.payments.entries()) pays.push(await readPayment(db, bid, raw, i + 1, ['cash', 'upi', 'card']));
  const total = pays.reduce((s0, p) => s0 + p.amountPaise, 0);
  const { t, shiftDay, fy } = clock(bizOf(c));
  const staff = c.get('staff');
  const settlementId = newId();
  const id = newId();
  try {
    await db.batch([
      ...receiptSettlement(db, bid, settlementId, shiftDay, fy, staff.id, t),
      ...pays.map((p) => insertPayment(db, bid, settlementId, { ...p, debtorAccountId: null }, shiftDay, staff.id, t)),
      stmt(db, `INSERT INTO desk_advances (id, business_id, booking_id, guest_name, phone, check_in, amount_paise, settlement_id, by_staff, at, reservation_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, bid, booking?.id ?? null, guest, phone, checkIn, total, settlementId, staff.id, t, reservation?.id ?? null),
      stmt(db, "INSERT INTO outbox (id, business_id, kind, body, created_at) VALUES (?, ?, 'receipt', ?, ?)", newId(), bid, JSON.stringify({
        settlementId, kind: 'advance', account: { id: null, kind: 'booking', name: guest, booking: booking?.ext_ref ?? null }, shiftDay, at: t, by: staff.name,
        payments: pays.map((p) => ({ paymentId: p.id, mode: p.mode, amountPaise: p.amountPaise, payAccountId: p.payAccountId, payAccountName: p.payAccountName,
          bookrAccountId: p.bookrAccountId, cardApproval: p.cardApproval, cardLast4: p.cardLast4 })),
      }), t),
    ]);
  } catch (e) {
    if (isTrigger(e, 'shift_closed')) fail(409, 'This shift is closed. Ask an Owner.');
    throw e;
  }
  sendSoon(c, bid);
  const receiptNo = (await one<{ receipt_no: string }>(db, 'SELECT receipt_no FROM settlements WHERE id = ?', settlementId))!.receipt_no;
  return { id, receipt: { receiptNo, kind: 'advance', at: t, name: guest, room: null, booking: booking?.ext_ref ?? null, checkIn, checkOut: booking?.check_out ?? reservation?.checkOut ?? null,
    totalPaise: total, balancePaise: null, payments: pays.map((p) => ({ mode: p.mode, amountPaise: p.amountPaise, payAccountName: p.payAccountName, cardLast4: p.cardLast4 })) } };
}

async function heldAdvance(c: { req: { param(k: 'id'): string }; get(k: 'businessId'): string; env: { DB: DB } }) {
  const id = c.req.param('id');
  const a = await one<{ id: string; guest_name: string; amount_paise: number; settlement_id: string; booking_id: string | null }>(c.env.DB,
    "SELECT id, guest_name, amount_paise, settlement_id, booking_id FROM desk_advances WHERE id = ? AND business_id = ? AND status = 'held'", isUuid(id) ? id : null, c.get('businessId'));
  if (!a) fail(404, 'No advance waiting with that id.');
  return a;
}

// A person links an advance to its booking when the POS could not tell which it was.
settleRoutes.post(`${B}/desk-advances/:id/attach`, requireAction('debtors.receive'), async (c) => {
  const bid = c.get('businessId');
  const a = await heldAdvance(c);
  const data = await body(c);
  const k = await one<{ id: string; stay_id: string | null; status: string }>(c.env.DB, 'SELECT id, stay_id, status FROM bookings WHERE id = ? AND business_id = ?',
    typeof data.bookingId === 'string' && isUuid(data.bookingId) ? data.bookingId : null, bid);
  if (!k || k.status === 'cancelled') fail(404, 'Choose a booking that is not cancelled.');
  await stmt(c.env.DB, 'UPDATE desk_advances SET booking_id = ? WHERE id = ?', k.id, a.id).run();
  if (k.stay_id) await syncStay(c.env.DB, bid, k.stay_id);
  return c.json({ ok: true });
});

// An advance taken at the desk given back (the booking was cancelled): out of the drawer, by cash or UPI, a manager approves.
settleRoutes.post(`${B}/desk-advances/:id/refund`, requireAction('debtors.receive'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const a = await heldAdvance(c);
  const data = await body(c);
  const mode = data.mode;
  if (mode !== 'cash' && mode !== 'upi') fail(400, 'A refund is paid by cash or UPI.');
  const approver = await approval(c, data, 'A refund');
  const rno = (await one<{ receipt_no: string | null }>(db, 'SELECT receipt_no FROM settlements WHERE id = ?', a.settlement_id))?.receipt_no ?? '';
  const note = `Advance refunded ${rno} · ${a.guest_name}${isManager(c) ? '' : ` · Approved by ${approver.name}`}`.slice(0, 160);
  const { t, shiftDay } = clock(bizOf(c));
  const id = newId();
  const staff = c.get('staff');
  try {
    await db.batch([
      stmt(db, "INSERT INTO drawer_outs (id, business_id, kind, mode, amount_paise, note, shift_day, by_staff, at) VALUES (?, ?, 'paid_out', ?, ?, ?, ?, ?, ?)",
        id, bid, mode, a.amount_paise, note, shiftDay, staff.id, t),
      stmt(db, "UPDATE desk_advances SET status = 'refunded' WHERE id = ? AND status = 'held'", a.id),
      stmt(db, "INSERT INTO outbox (id, business_id, kind, body, created_at) VALUES (?, ?, 'drawer_out', ?, ?)", newId(), bid,
        JSON.stringify({ drawerOutId: id, kind: 'paid_out', mode, amountPaise: a.amount_paise, note, shiftDay, at: t, by: staff.name }), t),
    ]);
  } catch (e) {
    if (isTrigger(e, 'shift_closed')) fail(409, 'This shift is closed.');
    throw e;
  }
  sendSoon(c, bid);
  return c.json({ ok: true }, 201);
});

// An unused advance paid back (at check-out, or a credit account closing): by cash from the drawer or by UPI.
settleRoutes.post(`${B}/debtors/:id/refund`, requireAction('debtors.receive'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const acc = await one<{ id: string; kind: string; name: string }>(db, 'SELECT id, kind, name FROM debtor_accounts WHERE id = ? AND business_id = ?', c.req.param('id'), bid);
  if (!acc) fail(404, 'Account not found.');
  const data = await body(c);
  const mode = data.mode;
  if (mode !== 'cash' && mode !== 'upi') fail(400, 'A refund is paid by cash or UPI.');
  const amount = amountOf(data.amount, 'Refund amount');
  const credit = -(await balance(db, acc.id));
  if (credit <= 0) fail(409, `${acc.name} has no advance or deposit to refund.`);
  if (amount > credit) fail(409, `${acc.name} has only ${rs(credit)} to refund.`);
  const note0 = text(data, 'note', 'Note', { optional: true, max: 120 }) ?? 'Advance refunded';
  // Money out of the drawer: a manager approves (21 Nov 2026).
  const approver = await approval(c, data, 'A refund');
  const note = isManager(c) ? note0 : `${note0} · Approved by ${approver.name}`.slice(0, 160);
  const { t, shiftDay } = clock(bizOf(c));
  const id = newId();
  const staff = c.get('staff');
  try {
    await db.batch([
      stmt(db, "INSERT INTO drawer_outs (id, business_id, kind, mode, amount_paise, debtor_account_id, note, shift_day, by_staff, at) VALUES (?, ?, 'refund', ?, ?, ?, ?, ?, ?, ?)",
        id, bid, mode, amount, acc.id, note, shiftDay, staff.id, t),
      stmt(db, "INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, by_staff, at) VALUES (?, ?, ?, 'refund', ?, ?, ?)", newId(), bid, acc.id, amount, staff.id, t),
      stmt(db, "INSERT INTO outbox (id, business_id, kind, body, created_at) VALUES (?, ?, 'drawer_out', ?, ?)", newId(), bid,
        JSON.stringify({ drawerOutId: id, kind: 'refund', mode, amountPaise: amount, note, account: { id: acc.id, kind: acc.kind, name: acc.name }, shiftDay, at: t, by: staff.name }), t),
    ]);
  } catch (e) {
    if (isTrigger(e, 'shift_closed')) fail(409, 'This shift is closed.');
    throw e;
  }
  sendSoon(c, bid);
  return c.json({ balancePaise: await balance(db, acc.id) }, 201);
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

// Corrects how a payment was taken (cash entered as UPI, the wrong UPI account, a card slip typed wrong) while its shift is
// open (21 Nov 2026). Only cash, UPI and card; the amount, bills and time stay. A manager does it, or approves with a PIN.
// The change is on the Daily check, and a bill message for Bookr not yet sent is corrected too; one already sent is not
// changed here (a credit note and a new bill do that).
settleRoutes.post(`${B}/payments/:id/change`, requireAction('bills.settle'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const id = c.req.param('id');
  if (!isUuid(id)) fail(404, 'Payment not found.');
  const p = await one<{ id: string; mode: string; amount_paise: number; shift_day: string; pay_account_id: string | null; card_last4: string | null; tendered_paise: number | null }>(db,
    'SELECT id, mode, amount_paise, shift_day, pay_account_id, card_last4, tendered_paise FROM payments WHERE id = ? AND business_id = ?', id, bid);
  if (!p) fail(404, 'Payment not found.');
  if (!['cash', 'upi', 'card'].includes(p.mode)) fail(409, 'Only cash, UPI and card payments can be changed.');
  if (await one(db, 'SELECT 1 FROM shift_closes WHERE business_id = ? AND shift_day = ?', bid, p.shift_day)) fail(409, 'That shift is closed, so its payments cannot change now.');
  const data = await body(c);
  const next = await readPayment(db, bid, { ...data, amount: `${Math.floor(p.amount_paise / 100)}.${String(p.amount_paise % 100).padStart(2, '0')}`, tendered: undefined }, 1, ['cash', 'upi', 'card']);
  if (next.mode === p.mode && next.payAccountId === p.pay_account_id && next.mode !== 'card') fail(400, 'That is how it was taken already.');
  const reason = text(data, 'reason', 'A reason for the change', { max: 120 })!;
  const approver = await approval(c, data, 'Changing how a bill was paid');
  const bills = await all<{ bill_no: string }>(db, 'SELECT b.bill_no FROM allocations a JOIN bills b ON b.id = a.bill_id WHERE a.payment_id = ? ORDER BY b.bill_no', id);
  const sentAlready = await one(db, "SELECT 1 FROM outbox WHERE business_id = ? AND kind = 'bill_settled' AND sent_at IS NOT NULL AND body LIKE ?", bid, `%${id}%`);
  if (sentAlready) fail(409, 'This payment has already gone to Bookr. Give the money back with a credit note and bill again.');
  const pending = await all<{ id: string; body: string }>(db, "SELECT id, body FROM outbox WHERE business_id = ? AND kind = 'bill_settled' AND sent_at IS NULL AND body LIKE ?", bid, `%${id}%`);
  const name = (m: string, acc: string | null) => (m === 'upi' ? `UPI${acc ? ` (${acc})` : ''}` : m === 'card' ? 'Card' : 'Cash');
  const fromAcc = p.pay_account_id ? (await one<{ name: string }>(db, 'SELECT name FROM pay_accounts WHERE id = ?', p.pay_account_id))?.name ?? null : null;
  const staff = c.get('staff');
  const { t, shiftDay } = clock(bizOf(c));
  const fixed = pending.map((m) => {
    const msg = JSON.parse(m.body);
    for (const x of msg.payments ?? []) if (x.paymentId === id) Object.assign(x, { mode: next.mode, payAccountId: next.payAccountId, payAccountName: next.payAccountName,
      bookrAccountId: next.bookrAccountId, cardApproval: next.cardApproval, cardLast4: next.cardLast4 });
    for (const x of msg.tips ?? []) if (x.paymentId === id) x.mode = next.mode;
    return stmt(db, 'UPDATE outbox SET body = ? WHERE id = ? AND sent_at IS NULL', JSON.stringify(msg), m.id);
  });
  try {
    await db.batch([
      stmt(db, 'UPDATE payments SET mode = ?, pay_account_id = ?, card_approval = ?, card_last4 = ?, tendered_paise = ? WHERE id = ?',
        next.mode, next.payAccountId, next.cardApproval, next.cardLast4, next.mode === 'cash' ? p.tendered_paise : null, id),
      ...fixed,
      event(db, bid, 'pay_change', bills.map((x) => x.bill_no).join(', '), p.amount_paise, reason,
        `${name(p.mode, fromAcc)} → ${name(next.mode, next.payAccountName)}${isManager(c) ? '' : ` · Approved by ${approver.name}`}`, staff.id, shiftDay),
    ]);
  } catch (e) {
    if (isTrigger(e, 'shift_closed')) fail(409, 'That shift is closed, so its payments cannot change now.');
    throw e;
  }
  return c.json({ ok: true });
});
