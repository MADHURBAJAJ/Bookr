// Planned on a later shift (approved 20 Nov 2026): a bill of a saved shift whose money a person has chosen on a later,
// not yet saved, shift (a card swipe or a UPI credit, often paying another bill too). It is matched when that shift is
// saved; until then it is told as planned there, not as money not received.

import { all, type DB } from './db';
import { machineLabel, type CardPayment } from './cards';

export interface PlannedLater {
  choiceId: string; day: string; kind: 'card' | 'upi';
  label: string; amountPaise: number; at: number;
  /** The other bills the same payment is for. */
  withBills: string[]; by: string | null;
}

/** For each sale id (a waiting sale of a saved shift), the later shift's choice that pays it, if any. */
export async function plannedLater(db: DB, businessId: string, txIds: string[]): Promise<Map<string, PlannedLater>> {
  const out = new Map<string, PlannedLater>();
  if (!txIds.length) return out;
  const rows = await all<{ id: string; shift_day: string; kind: string; comparison_ids: string; who: string | null;
    card_amount: number | null; card_at: number | null; scheme: string | null; card_type: string | null; card_last4: string | null; pay_mode: string | null;
    bank_amount: number | null; bank_at: number | null; account: string | null }>(db, `
    SELECT sc.id, sc.shift_day, sc.kind, sc.comparison_ids, u.name AS who,
      cs.amount_paise AS card_amount, cs.paid_at AS card_at, cs.scheme, cs.card_type, cs.card_last4, cs.pay_mode,
      br.amount_paise AS bank_amount, br.posted_at AS bank_at, a.name AS account
    FROM shift_choices sc
    LEFT JOIN users u ON u.id = sc.created_by
    LEFT JOIN card_settlements cs ON cs.id = sc.card_payment_id
    LEFT JOIN bank_rows br ON br.id = sc.bank_row_id
    LEFT JOIN accounts a ON a.id = br.account_id
    WHERE sc.business_id = ? AND EXISTS (SELECT 1 FROM json_each(sc.comparison_ids) j WHERE j.value IN (${txIds.map(() => '?').join(',')}))
      AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.business_id = sc.business_id AND s.shift_day = sc.shift_day AND s.status = 'confirmed')`,
  businessId, ...txIds);
  if (!rows.length) return out;
  // The bill numbers of everything the chosen payments are for: comparisons of that shift, or sales of earlier ones.
  const ids = [...new Set(rows.flatMap((r) => JSON.parse(r.comparison_ids) as string[]))];
  const names = new Map((await all<{ id: string; bill_no: string | null }>(db, `
    SELECT id, bill_no FROM bill_comparisons WHERE business_id = ? AND id IN (${ids.map(() => '?').join(',')})
    UNION ALL SELECT id, bill_no FROM transactions WHERE business_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
  businessId, ...ids, businessId, ...ids)).map((x) => [x.id, x.bill_no ?? '']));
  const want = new Set(txIds);
  for (const r of rows) {
    const list = JSON.parse(r.comparison_ids) as string[];
    const card = r.kind === 'card_match';
    const p: Omit<PlannedLater, 'withBills'> = {
      choiceId: r.id, day: r.shift_day, kind: card ? 'card' : 'upi',
      label: card ? machineLabel({ scheme: r.scheme, card_type: r.card_type, card_last4: r.card_last4, pay_mode: r.pay_mode } as Pick<CardPayment, 'scheme' | 'card_type' | 'card_last4' | 'pay_mode'>) : r.account ?? 'UPI',
      amountPaise: (card ? r.card_amount : r.bank_amount) ?? 0, at: (card ? r.card_at : r.bank_at) ?? 0, by: r.who,
    };
    for (const id of list.filter((x) => want.has(x))) out.set(id, { ...p, withBills: list.filter((x) => x !== id).map((x) => names.get(x) ?? '').filter(Boolean) });
  }
  return out;
}
