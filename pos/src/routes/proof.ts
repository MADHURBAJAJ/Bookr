// Payment proof list (approved 24 Nov 2026): every cashier sees each bill and receipt of the shift against the proof
// staff post in the Guest payment group (UPI screenshot, card slip, "cash" on the bill photo). Bookr reads WhatsApp and
// matches; the POS sends its own bills of the shift (printed ones too, so they show amber at once) and shows the answer.
// Nothing at the counter waits on this: settling never asks for proof.
import { cancelledReceipts } from './receipt-cancels';
import { Hono } from 'hono';
import { all, type DB } from '../../../src/db';
import { date } from '../../../src/http';
import { requireAction, requireStaff } from '../auth';
import { bookrLink } from '../sync';
import { bizOf, clock } from '../util';
import type { AppEnv, Env } from '../types';

export const proofRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
proofRoutes.use(`${B}/*`, requireStaff);

type Tender = { paymentId: string; mode: string; amountPaise: number; totalPaise: number; cardApproval: string | null; cardLast4: string | null; paidAt: number };
export interface ProofBill { key: string; billNo: string | null; kind: 'bill' | 'receipt'; state: 'printed' | 'settled'; totalPaise: number; discountPaise: number;
  at: number; label: string | null; tenders: Tender[] }

/** The shift's bills (printed or settled in it, and any still unpaid) and receipts, as Bookr's list wants them. */
export async function shiftBills(db: DB, bid: string, day: string): Promise<ProofBill[]> {
  const bills = await all<{ id: string; bill_no: string; status: 'printed' | 'settled'; total_paise: number; discount_paise: number; printed_at: number; place: string; guest_name: string | null }>(db,
    `SELECT b.id, b.bill_no, b.status, b.total_paise, b.discount_paise, b.printed_at, o.place, b.guest_name
     FROM bills b JOIN orders o ON o.id = b.order_id
     WHERE b.business_id = ? AND b.status <> 'void' AND (b.shift_day = ? OR b.status = 'printed'
       OR b.id IN (SELECT a.bill_id FROM allocations a JOIN payments p ON p.id = a.payment_id WHERE p.business_id = ? AND p.shift_day = ?))
     ORDER BY b.printed_at`, bid, day, bid, day);
  const tenders = await all<Tender & { billId: string }>(db,
    `SELECT a.bill_id AS billId, p.id AS paymentId, p.mode, a.amount_paise AS amountPaise, p.amount_paise AS totalPaise, p.card_approval AS cardApproval,
       p.card_last4 AS cardLast4, p.at AS paidAt
     FROM allocations a JOIN payments p ON p.id = a.payment_id
     WHERE a.business_id = ? AND a.bill_id IN (SELECT b.id FROM bills b WHERE b.business_id = ? AND (b.shift_day = ? OR b.status = 'printed')
       UNION SELECT a2.bill_id FROM allocations a2 JOIN payments p2 ON p2.id = a2.payment_id WHERE p2.business_id = ? AND p2.shift_day = ?)
     ORDER BY p.at`, bid, bid, day, bid, day);
  const receipts = await all<Tender & { settlementId: string; debtor: string | null }>(db,
    `SELECT s.id AS settlementId, p.id AS paymentId, p.mode, p.amount_paise AS amountPaise, p.amount_paise AS totalPaise, p.card_approval AS cardApproval,
       p.card_last4 AS cardLast4, p.at AS paidAt, d.name AS debtor
     FROM settlements s JOIN payments p ON p.settlement_id = s.id LEFT JOIN debtor_accounts d ON d.id = p.debtor_account_id
     WHERE s.business_id = ? AND s.kind = 'receipt' AND s.shift_day = ? AND NOT EXISTS (SELECT 1 FROM receipt_cancels rc WHERE rc.settlement_id = s.id) ORDER BY p.at`, bid, day);
  const tender = ({ paymentId, mode, amountPaise, totalPaise, cardApproval, cardLast4, paidAt }: Tender): Tender =>
    ({ paymentId, mode, amountPaise, totalPaise, cardApproval, cardLast4, paidAt });
  const out: ProofBill[] = bills.map((b) => ({ key: b.id, billNo: b.bill_no, kind: 'bill', state: b.status, totalPaise: b.total_paise, discountPaise: b.discount_paise,
    at: b.printed_at, label: b.guest_name ? `${b.place} · ${b.guest_name}` : b.place, tenders: tenders.filter((t) => t.billId === b.id).map(tender) }));
  const bySettlement = new Map<string, ProofBill>();
  for (const r of receipts) {
    const x = bySettlement.get(r.settlementId) ?? { key: r.settlementId, billNo: null, kind: 'receipt' as const, state: 'settled' as const, totalPaise: 0,
      discountPaise: 0, at: r.paidAt, label: r.debtor, tenders: [] };
    if (r.debtor && !x.label) x.label = r.debtor;
    x.totalPaise += r.amountPaise;
    x.tenders.push(tender(r));
    bySettlement.set(r.settlementId, x);
  }
  return [...out, ...bySettlement.values()];
}

/** Asks Bookr. Answers { connected: false } when this POS has no Bookr key, and { error } when Bookr cannot be reached. */
export async function proofList(env: Env, bid: string, day: string, startHour: number, fetcher: typeof fetch = (...a) => fetch(...a)) {
  const bills = await shiftBills(env.DB, bid, day);
  const link = bookrLink(env, bid);
  const local = { day, bills: bills.map((b) => ({ key: b.key, billNo: b.billNo, kind: b.kind, state: b.state, totalPaise: b.totalPaise, at: b.at, label: b.label,
    modes: b.tenders.map((t) => ({ mode: t.mode, amountPaise: t.amountPaise })) })) };
  if (!link) return { connected: false, ...local };
  try {
    const res = await fetcher(`${link.base}/api/pos/proof`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${link.key}` },
      body: JSON.stringify({ businessId: link.bookrId, shiftDay: day, startHour, bills }),
    });
    const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(typeof answer.error === 'string' ? answer.error : `Bookr answered ${res.status}`);
    return { connected: true, ...local, ...answer };
  } catch (e) {
    return { connected: true, ...local, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

proofRoutes.get(`${B}/proof`, requireAction('pos.view'), async (c) => {
  const b = bizOf(c);
  const q = c.req.query('day');
  const day = q ? date({ day: q }, 'day', 'Shift day') : clock(b).shiftDay;
  // Receipts cancelled this day (27 Nov 2026): listed as cancelled; no proof is asked for them.
  return c.json({ ...(await proofList(c.env, c.get('businessId'), day, b.shift_start_hour)), cancelledReceipts: await cancelledReceipts(c.env.DB, c.get('businessId'), day) });
});
