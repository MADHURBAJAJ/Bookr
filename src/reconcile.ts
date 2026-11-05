// Reconcile (approved 5 Nov 2026): one screen per confirmed shift in place of UPI matching and Bank sync's money in.
// A balance strip says what is left to explain; four lanes say how: Clear (ticked, one click), Fix and match (the
// explainer's cards), Needs you (likely matches, unticked, and matching by hand), Missing (bills with no credit,
// credits with no bill). Every action is an existing, recorded and reversible one; nothing happens by itself.

import { all, type DB } from './db';
import { suggestionsFor } from './bank';
import { explainShift } from './explain';
import { addDays, shiftWindow } from './time';

/** Likely: a credit and a bill of the same amount up to three hours apart that the clear pairing did not take. */
export async function reconcileShift(db: DB, businessId: string, day: string) {
  const w = shiftWindow(day);
  const [ex, sug, sales, booked, typeHeads] = await Promise.all([
    explainShift(db, businessId, day),
    suggestionsFor(db, businessId, day, addDays(day, 1)),
    all<{ id: string; billNo: string | null; amountPaise: number; bankRowId: string | null; paidAt: number | null; creditAt: number | null;
      creditPaise: number | null; tranId: string | null; accountName: string | null }>(db, `
      SELECT t.id, t.bill_no AS billNo, t.amount_paise AS amountPaise, t.matched_bank_row AS bankRowId, sb.paid_at AS paidAt,
        r.posted_at AS creditAt, r.amount_paise AS creditPaise, r.tran_id AS tranId, a.name AS accountName
      FROM transactions t LEFT JOIN bill_comparisons c ON c.id = t.comparison_id LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
      LEFT JOIN bank_rows r ON r.id = t.matched_bank_row LEFT JOIN accounts a ON a.id = r.account_id
      WHERE t.business_id = ? AND t.shift_day = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.source = 'software_report'
      ORDER BY coalesce(sb.paid_at, 0), t.bill_no`, businessId, day),
    all<{ id: string; tranId: string; postedAt: number; amountPaise: number; headName: string | null; note: string | null }>(db, `
      SELECT r.id, r.tran_id AS tranId, r.posted_at AS postedAt, r.amount_paise AS amountPaise, h.name AS headName, r.note
      FROM bank_rows r LEFT JOIN transactions t ON t.id = r.transaction_id LEFT JOIN heads h ON h.id = t.head_id
      WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.status = 'booked' AND r.posted_at >= ? AND r.posted_at < ? ORDER BY r.posted_at`,
      businessId, w.from, w.to),
    all<{ billType: string; headId: string; headName: string }>(db, `SELECT b.bill_type AS billType, b.head_id AS headId, h.name AS headName
      FROM bill_type_heads b JOIN heads h ON h.id = b.head_id WHERE b.business_id = ?`, businessId),
  ]);
  const creditOf = new Map(sug.credits.map((c) => [c.id, c]));
  const credit = (id: string) => {
    const c = creditOf.get(id)!;
    return { creditId: c.id, tranId: c.tran_id, accountName: c.account_name, postedAt: c.posted_at, amountPaise: c.amount_paise, vpa: c.vpa, remark: c.remark };
  };
  const waiting = new Set(sales.filter((s) => !s.bankRowId).map((s) => s.id));
  const mine = (ids: string[]) => ids.every((x) => waiting.has(x));

  // Clear: the explainer's clear pairs, for this shift's bills.
  const clearCard = ex.cards.find((c) => c.kind === 'clear_matches');
  const clear = (clearCard?.uses ?? []).map((u) => u.slice(3))
    .filter((id) => { const k = sug.clear.get(id); return k && !k.adjust && mine(k.transactionIds) && creditOf.has(id); })
    .map((id) => { const k = sug.clear.get(id)!; return { ...credit(id), transactionIds: k.transactionIds, billNos: k.billNos, minutes: k.minutes, part: k.part }; });

  const used = new Set(ex.cards.flatMap((c) => c.uses));
  clear.forEach((p) => { used.add(`cr:${p.creditId}`); p.transactionIds.forEach((x) => used.add(`tx:${x}`)); });

  // Likely: closest first, each bill once, unticked.
  const options: { creditId: string; k: { transactionIds: string[]; billNos: string[]; minutes: number | null; part: string | null } }[] = [];
  for (const c of sug.credits) {
    if (used.has(`cr:${c.id}`)) continue;
    for (const k of sug.candidates.get(c.id) ?? []) {
      if (k.adjust || !mine(k.transactionIds) || k.transactionIds.some((x) => used.has(`tx:${x}`))) continue;
      options.push({ creditId: c.id, k });
    }
  }
  options.sort((a, b) => (a.k.minutes ?? 999) - (b.k.minutes ?? 999));
  const likely: (ReturnType<typeof credit> & { transactionIds: string[]; billNos: string[]; minutes: number | null; part: string | null; others: number })[] = [];
  for (const o of options) {
    if (used.has(`cr:${o.creditId}`) || o.k.transactionIds.some((x) => used.has(`tx:${x}`))) continue;
    const others = options.filter((p) => p !== o && (p.creditId === o.creditId || p.k.transactionIds.some((x) => o.k.transactionIds.includes(x)))).length;
    likely.push({ ...credit(o.creditId), transactionIds: o.k.transactionIds, billNos: o.k.billNos, minutes: o.k.minutes, part: o.k.part, others });
    used.add(`cr:${o.creditId}`);
    o.k.transactionIds.forEach((x) => used.add(`tx:${x}`));
  }

  // Missing: credits inside the shift that no bill of any shift could be.
  const noBill = sug.credits
    .filter((c) => c.posted_at >= w.from && c.posted_at < w.to && !used.has(`cr:${c.id}`) && !(sug.candidates.get(c.id) ?? []).length)
    .map((c) => credit(c.id));

  const sum = (xs: { amountPaise: number }[]) => xs.reduce((t, x) => t + x.amountPaise, 0);
  const left = sales.filter((s) => !s.bankRowId);
  const creditsLeft = sug.credits.filter((c) => c.posted_at >= w.from && c.posted_at < w.to);
  const matched = new Map<string, { rowId: string; tranId: string | null; accountName: string | null; postedAt: number | null; creditPaise: number | null; bills: string[]; billsPaise: number }>();
  for (const s of sales.filter((x) => x.bankRowId)) {
    const m = matched.get(s.bankRowId!) ?? { rowId: s.bankRowId!, tranId: s.tranId, accountName: s.accountName, postedAt: s.creditAt, creditPaise: s.creditPaise, bills: [], billsPaise: 0 };
    if (s.billNo) m.bills.push(s.billNo);
    m.billsPaise += s.amountPaise;
    matched.set(s.bankRowId!, m);
  }
  return {
    day,
    coverage: ex.coverage,
    note: ex.note,
    strip: {
      upiSalesPaise: sum(sales), bills: sales.length,
      matchedPaise: sum(sales.filter((s) => s.bankRowId)),
      billsLeft: left.length, billsLeftPaise: sum(left),
      creditsLeft: creditsLeft.length, creditsLeftPaise: creditsLeft.reduce((t, c) => t + c.amount_paise, 0),
    },
    clear,
    fixes: ex.cards.filter((c) => c.kind !== 'clear_matches' && c.kind !== 'no_upi_credit'),
    likely,
    noCredit: ex.cards.filter((c) => c.kind === 'no_upi_credit'),
    noBill,
    unbilledHeads: typeHeads,
    done: [...matched.values()].sort((a, b) => (a.postedAt ?? 0) - (b.postedAt ?? 0)),
    booked,
  };
}
