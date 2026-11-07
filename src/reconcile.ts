// Reconcile (approved 5 Nov 2026): one screen per confirmed shift in place of UPI matching and Bank sync's money in.
// A balance strip says what is left to explain; four lanes say how: Clear (ticked, one click), Fix and match (the
// explainer's cards), Needs you (likely matches, unticked, and matching by hand), Missing (bills with no credit,
// credits with no bill). Every action is an existing, recorded and reversible one; nothing happens by itself.

import { all, type DB } from './db';
import { bankIn } from './bankEvidence';
import { suggestionsFor } from './bank';
import { cashCheck } from './cash';
import { explainShift, tableSets, type Card } from './explain';
import { bookedSalesAround, dayName, pairBooked, plansFor, sameSaleCard, sameSaleCards, type WaitingBill } from './sameSale';
import { billDistance, creditsForShift, sameBillNo, shiftView, WATCH_DAYS } from './sales';
import { addDays, istDay, shiftDayOf, shiftWindow } from './time';

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
        AND t.id NOT IN (SELECT transaction_id FROM closed_bills WHERE business_id = ?)
      ORDER BY coalesce(sb.paid_at, 0), t.bill_no`, businessId, day, businessId),
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

  // A credit booked directly whose bill came later. Bills that have a free credit to try are left to that.
  const same = await sameSaleCards(db, businessId, day, new Set([...clear, ...likely].flatMap((x) => x.transactionIds)));

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
    fixes: [...same, ...ex.cards.filter((c) => c.kind !== 'clear_matches' && c.kind !== 'no_upi_credit')],
    likely,
    noCredit: ex.cards.filter((c) => c.kind === 'no_upi_credit' && !c.uses.some((u) => same.some((x) => x.uses.includes(u)))),
    noBill,
    unbilledHeads: typeHeads,
    done: [...matched.values()].sort((a, b) => (a.postedAt ?? 0) - (b.postedAt ?? 0)),
    booked,
  };
}

const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hm = (ms: number) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));

/**
 * Trial reconcile (approved 6 Nov 2026): the same picture for a shift not confirmed yet, worked out fresh each time
 * and never saved, so an edit just changes the picture. Its income does not exist until confirming, so it reads the
 * shift's bills. Confirming still matches the clear pairs. It is optional: it warns, and never stops a confirm.
 */
export async function trialReconcile(db: DB, businessId: string, day: string) {
  const w = shiftWindow(day);
  const base = `/businesses/${businessId}`;
  const [view, credits, cov, cash, details, rows, pays, typeHeads] = await Promise.all([
    shiftView(db, businessId, day),
    creditsForShift(db, businessId, day),
    bankIn(db, businessId, day),
    cashCheck(db, businessId, day),
    all<{ id: string; tranId: string; accountName: string | null; vpa: string | null; remark: string | null }>(db, `
      SELECT r.id, r.tran_id AS tranId, a.name AS accountName, r.vpa, r.remark FROM bank_rows r LEFT JOIN accounts a ON a.id = r.account_id
      WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.status = 'unmatched' AND r.posted_at >= ? AND r.posted_at < ?`, businessId, w.from - 3600e3, w.to + 3 * 3600e3),
    all<{ id: string; paidWith: string | null }>(db, 'SELECT id, paid_with_row_id AS paidWith FROM register_rows WHERE business_id = ? AND shift_day = ?', businessId, day),
    all<{ rowId: string; mode: string; amountPaise: number }>(db, `SELECT p.register_row_id AS rowId, p.mode, p.amount_paise AS amountPaise FROM register_payments p
      JOIN register_rows r ON r.id = p.register_row_id WHERE r.business_id = ? AND r.shift_day = ?`, businessId, day),
    all<{ billType: string; headId: string; headName: string }>(db, `SELECT b.bill_type AS billType, b.head_id AS headId, h.name AS headName
      FROM bill_type_heads b JOIN heads h ON h.id = b.head_id WHERE b.business_id = ?`, businessId),
  ]);
  const detail = new Map(details.map((d) => [d.id, d]));
  const heads = new Set(rows.map((r) => r.paidWith).filter(Boolean));
  const inGroup = (id: string | null | undefined) => !!id && (heads.has(id) || !!rows.find((r) => r.id === id)?.paidWith);
  const paysOf = (id: string) => pays.filter((p) => p.rowId === id);

  // The UPI bills as they stand: the side that counts when decided, otherwise whichever side says UPI.
  const bills = view.comparisons.flatMap((c) => {
    if (c.decision === 'leave_out' || c.decision === 'carry_forward') return [];
    const side = c.decision === 'use_software' ? c.software : c.decision === 'use_register' || c.difference === 'match' ? c.register
      : c.register?.mode === 'upi' ? c.register : c.software?.mode === 'upi' ? c.software : null;
    if (!side || side.mode !== 'upi' || !side.amountPaise) return [];
    return [{ c, amount: side.amountPaise as number, grouped: inGroup(c.register?.rowId) }];
  });
  // A bill paid in several goes has one line per credit.
  const clear = bills.filter((b) => b.c.bank).flatMap((b) => (b.c.bank!.parts ?? [{ creditId: b.c.bank!.creditId, amountPaise: b.c.bank!.amountPaise, postedAt: b.c.bank!.postedAt }]).map((p, i, all) => {
    const d = detail.get(p.creditId);
    return { creditId: p.creditId, tranId: d?.tranId ?? null, accountName: d?.accountName ?? null, postedAt: p.postedAt, amountPaise: p.amountPaise,
      vpa: d?.vpa ?? null, remark: d?.remark ?? null, transactionIds: [] as string[], billNos: [b.c.billNo], minutes: b.c.bank!.minutes,
      part: all.length > 1 ? `part ${i + 1} of ${all.length} UPI payments` : null };
  }));
  const used = new Set(clear.map((x) => x.creditId));
  const free = () => credits.filter((c) => !used.has(c.id));
  const nearAt = (postedAt: number, at: number | null, limit: number) => (at == null ? postedAt >= w.from && postedAt < w.to + 3600e3 : Math.abs(postedAt - at) <= limit * 60000);

  // Bills paid together have one credit for the whole group, which Bookr looks for after confirming.
  const groupTotals = new Map<string, number>();
  for (const r of rows.filter((x) => heads.has(x.id))) groupTotals.set(r.id, paysOf(r.id).filter((p) => p.mode === 'upi').reduce((t, p) => t + p.amountPaise, 0));
  const groupsFit = new Set<string>();
  for (const [head, total] of groupTotals) {
    const m = free().find((c) => c.amount === total);
    if (m) { used.add(m.id); groupsFit.add(head); }
  }
  const settled = new Set(used);
  const headOf = (id: string | null | undefined) => rows.find((r) => r.id === id)?.paidWith ?? id ?? null;
  const left = bills.filter((b) => !b.c.bank && !(b.grouped && groupsFit.has(headOf(b.c.register?.rowId) as string)));
  const billOf = new Set<string>();
  const cards: Card[] = [];

  // A number one slip from a software bill, with a credit that fits: correct the row now, while edits are free.
  const softwareOnly = view.comparisons.filter((c) => c.difference === 'missing_in_register' && c.software && c.decision !== 'leave_out');
  for (const b of left.filter((x) => x.c.difference === 'missing_in_software' && x.c.register?.rowId && !x.grouped)) {
    for (const s of softwareOnly) {
      if (billOf.has(s.id) || !(sameBillNo(b.c.billNo, s.billNo) || billDistance(b.c.billNo, s.billNo) <= 2)) continue;
      const m = free().find((c) => c.amount === b.amount && nearAt(c.postedAt, s.paidAt, 60));
      if (!m) continue;
      used.add(m.id); billOf.add(s.id); billOf.add(b.c.id);
      cards.push({ key: `trial-typo:${b.c.id}:${s.id}`, kind: 'number_typo', billNos: [s.billNo, b.c.billNo], title: `Register bill ${b.c.billNo} is probably ${s.billNo}`,
        evidence: [`The register has ${b.c.billNo}, not in the software report; the software has ${s.billNo}, not in the register.`, `A UPI credit of ${rs(m.amount)} came in at ${hm(m.postedAt)}.`, 'Check the number against the photo before correcting it.'],
        score: 85, uses: [`cmp:${b.c.id}`, `cmp:${s.id}`, `cr:${m.id}`],
        witnesses: { software: `Bill ${s.billNo} · ${rs(s.software!.amountPaise as number)}`, register: `Bill ${b.c.billNo} · ${rs(b.amount)}`, bank: `${rs(m.amount)} at ${hm(m.postedAt)}`, odd: 'register' },
        actions: [{ label: `Correct to ${s.billNo}`, primary: true, op: 'fixNumber', rowId: b.c.register!.rowId as string, uploadId: b.c.register!.uploadId as string, billNo: s.billNo }] });
      break;
    }
  }

  // The bank settles a difference between the software and the register.
  for (const b of bills.filter((x) => x.c.bank?.suggest && !x.c.decision)) {
    const useSoftware = b.c.bank!.suggest === 'use_software';
    cards.push({ key: `trial-bank:${b.c.id}`, kind: 'bank_backs', billNos: [b.c.billNo], title: `Bill ${b.c.billNo}: the bank agrees with the ${useSoftware ? 'software' : 'register'}`,
      evidence: [`A UPI credit of ${rs(b.c.bank!.amountPaise)} came in at ${hm(b.c.bank!.postedAt)}.`], score: 80, uses: [`cmp:${b.c.id}`, `cr:${b.c.bank!.creditId}`],
      witnesses: { software: b.c.software ? `${rs(b.c.software.amountPaise as number)} · ${b.c.software.mode}` : null, register: b.c.register ? `${rs(b.c.register.amountPaise as number)} · ${b.c.register.mode}` : null,
        bank: `${rs(b.c.bank!.amountPaise)} at ${hm(b.c.bank!.postedAt)}`, odd: useSoftware ? 'register' : 'software' },
      actions: [{ label: `Use ${useSoftware ? 'software' : 'register'}`, primary: true, method: 'PUT', path: `${base}/comparisons/${b.c.id}`, body: { decision: b.c.bank!.suggest, note: 'Bank credit agrees (trial reconcile)' } }] });
  }

  // One credit for a table. Nothing needs editing, so the card only tells: the match is made after confirming.
  const singleLeft = (amount: number, at: number) => left.some((b) => b.amount === amount && nearAt(at, b.c.paidAt, 60));
  for (const m of free().filter((c) => c.postedAt >= w.from && c.postedAt < w.to && !singleLeft(c.amount, c.postedAt))) {
    const pool = left.filter((b) => !b.grouped && !billOf.has(b.c.id) && b.c.paidAt != null && b.amount < m.amount && nearAt(m.postedAt, b.c.paidAt, 60))
      .sort((a, b) => b.amount - a.amount).slice(0, 24).map((b) => ({ net: b.amount, paidAt: b.c.paidAt, b }));
    const sets = tableSets(pool, m.amount);
    if (sets.length !== 1) continue;
    used.add(m.id);
    sets[0].forEach((x) => billOf.add(x.b.c.id));
    cards.push({ key: `trial-table:${m.id}`, kind: 'one_credit_many_bills', billNos: sets[0].map((x) => x.b.c.billNo), title: `${rs(m.amount)} at ${hm(m.postedAt)} looks like one table: ${sets[0].length} bills`,
      evidence: [`Bills ${sets[0].map((x) => `${x.b.c.billNo} (${rs(x.net)})`).join(', ')} add up to exactly ${rs(m.amount)}, and no other set fits.`, 'Nothing needs editing. Match them after confirming.'],
      score: 75, uses: [`cr:${m.id}`], witnesses: { software: null, register: `${sets[0].length} bills · ${rs(m.amount)}`, bank: `One credit ${rs(m.amount)} at ${hm(m.postedAt)}`, odd: null }, actions: [] });
  }

  // A credit booked directly whose bill came later: chosen before confirming, done by the confirm.
  const [booked, plans] = await Promise.all([bookedSalesAround(db, businessId, day), plansFor(db, businessId, day)]);
  const planned = new Set(plans.map((x) => x.comparisonId));
  const headOfType = new Map(typeHeads.map((h) => [h.billType, h.headName]));
  for (const plan of plans) {
    const b = bills.find((x) => x.c.id === plan.comparisonId);
    const m = booked.find((x) => x.id === plan.rowId);
    if (!b || !m) { planned.delete(plan.comparisonId); continue; }
    billOf.add(b.c.id);
    cards.push({ key: `same-sale-plan:${m.id}`, kind: 'same_sale', billNos: [b.c.billNo], title: `Bill ${b.c.billNo} will join the ${rs(m.amountPaise)} booked on ${dayName(m.txDay)}`,
      evidence: ['You marked them as one sale. Confirming the shift does it, and the sale stays on the booked day.'], score: 90, uses: [`cmp:${b.c.id}`],
      actions: [{ label: 'Keep them apart', method: 'DELETE', path: `${base}/comparisons/${b.c.id}/same-sale`, body: { rowId: m.id } }] });
  }
  const single = left.filter((x) => !x.grouped && !billOf.has(x.c.id) && !x.c.bank && !(paysOf(x.c.register?.rowId ?? '').length > 1));
  const waiting: WaitingBill[] = single.map((x) => ({ billNo: x.c.billNo, amountPaise: x.amount, day, comparisonId: x.c.id, swPaise: (x.c.software?.amountPaise as number | null) ?? null, rgPaise: (x.c.register?.amountPaise as number | null) ?? null,
    headName: headOfType.get((x.c.register?.billType ?? '') as string) ?? null }));
  const fromPlans = new Set(plans.map((x) => x.rowId));
  for (const p of pairBooked(waiting, booked.filter((x) => !fromPlans.has(x.id)), day)) {
    const b = single.find((x) => x.c.id === p.bill.comparisonId)!;
    billOf.add(b.c.id);
    cards.push(sameSaleCard(base, p, b.c.difference.startsWith('missing') === false));
  }

  // Only with the bank in: a UPI bill with no credit of its amount near it, and money with no bill.
  const noCredit: Card[] = [];
  if (cov.covered) {
    for (const b of left.filter((x) => !x.grouped && !billOf.has(x.c.id))) {
      if (credits.some((c) => c.amount === b.amount && nearAt(c.postedAt, b.c.paidAt, 180))) continue;
      const cashFits = cash.differencePaise != null && cash.differencePaise === b.amount;
      const rowId = b.c.register?.rowId as string | undefined;
      const onePay = rowId && paysOf(rowId).length === 1 && b.c.register?.mode === 'upi';
      const open = rowId ? `#/b/${businessId}/review/${b.c.register!.uploadId}/${rowId}` : `#/b/${businessId}/compare/${day}`;
      noCredit.push({ key: `trial-mode:${b.c.id}`, kind: 'no_upi_credit', billNos: [b.c.billNo], title: `Bill ${b.c.billNo} (${rs(b.amount)}): no UPI payment of this amount in the bank`,
        evidence: [`No credit of ${rs(b.amount)} in any account around ${b.c.paidAt ? hm(b.c.paidAt) : 'this shift'}.`,
          cashFits ? `The shift's cash is ${rs(b.amount)} more than expected: exactly this bill. It was probably paid in cash.` : 'If it was paid by cash or card, change it. The credit may also still be on its way.'],
        score: cashFits ? 70 : 30, uses: [`cmp:${b.c.id}`],
        actions: onePay ? [{ label: 'Was cash', primary: cashFits, op: 'setMode', rowId, uploadId: b.c.register!.uploadId as string, mode: 'cash' }, { label: 'Was card', op: 'setMode', rowId, uploadId: b.c.register!.uploadId as string, mode: 'card' }]
          : [{ label: 'Open the bill', href: open }] });
    }
    for (const n of view.bank?.noBill ?? []) {
      if (used.has(n.id)) continue;
      const d = detail.get(n.id);
      noCredit.push({ key: `trial-nobill:${n.id}`, kind: 'no_bill', billNos: [], title: `${rs(n.amountPaise)} came in at ${hm(n.postedAt)} with no bill`,
        evidence: ['No bill or group in this shift has this amount: a sale not written down, or money that is not a sale.', 'Book it to a head after confirming, if it needs no bill.'],
        score: 20, uses: [`cr:${n.id}`], witnesses: { software: null, register: null, bank: `${rs(n.amountPaise)} at ${hm(n.postedAt)}${d?.accountName ? ` · ${d.accountName}` : ''}`, odd: null },
        actions: [{ label: 'Add a bill on Review', href: `#/b/${businessId}/review` }] });
    }
  }
  cards.sort((a, b) => b.score - a.score);
  noCredit.sort((a, b) => b.score - a.score);

  const openBills = left.filter((b) => !planned.has(b.c.id)).map((b) => ({ id: b.c.id, billNo: b.c.billNo, amountPaise: b.amount, paidAt: b.c.paidAt, grouped: b.grouped, rowId: b.c.register?.rowId ?? null, uploadId: b.c.register?.uploadId ?? null }));
  const openCredits = credits.filter((c) => !settled.has(c.id) && c.postedAt >= w.from && c.postedAt < w.to).map((c) => ({ id: c.id, amountPaise: c.amount, postedAt: c.postedAt, accountName: detail.get(c.id)?.accountName ?? null, remark: detail.get(c.id)?.remark ?? null }));
  const sum = (xs: { amountPaise: number }[]) => xs.reduce((t, x) => t + x.amountPaise, 0);
  return {
    trial: true as const, day, note: null,
    coverage: { covered: cov.covered, lastBankAt: cov.lastBankAt, shiftEnd: w.to },
    strip: { upiSalesPaise: bills.reduce((t, b) => t + b.amount, 0), bills: bills.length, matchedPaise: sum(clear),
      billsLeft: openBills.length, billsLeftPaise: sum(openBills), creditsLeft: openCredits.length, creditsLeftPaise: sum(openCredits) },
    clear, groupsFit: groupsFit.size, fixes: cards, likely: [], noCredit, noBill: [], unbilledHeads: typeHeads, done: [], booked: [], open: { bills: openBills, credits: openCredits },
  };
}

/** Everything still unmatched across all shifts, oldest first, with the closed bills. Credits on open shifts count too. */
export async function unmatchedEntries(db: DB, businessId: string) {
  const today = istDay(Date.now());
  const [credits, bills, closed, last] = await Promise.all([
    all<{ id: string; amountPaise: number; postedAt: number; accountName: string | null; vpa: string | null; remark: string | null }>(db, `
      SELECT r.id, r.amount_paise AS amountPaise, r.posted_at AS postedAt, a.name AS accountName, r.vpa, r.remark
      FROM bank_rows r LEFT JOIN accounts a ON a.id = r.account_id
      WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.status = 'unmatched' ORDER BY r.posted_at LIMIT 500`, businessId),
    all<{ id: string; billNo: string | null; day: string; amountPaise: number; paidAt: number | null; labels: string | null }>(db, `
      SELECT t.id, t.bill_no AS billNo, t.shift_day AS day, t.amount_paise AS amountPaise, sb.paid_at AS paidAt,
        (SELECT group_concat(DISTINCT p.column_label) FROM register_payments p WHERE p.register_row_id = coalesce(rr.paid_with_row_id, rr.id) AND p.mode = 'upi') AS labels
      FROM transactions t LEFT JOIN bill_comparisons c ON c.id = t.comparison_id LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
      LEFT JOIN register_rows rr ON rr.id = c.register_row_id
      WHERE t.business_id = ? AND t.type = 'income' AND t.payment_mode = 'upi' AND t.match_status = 'awaiting_bank_match' AND t.matched_bank_row IS NULL
      ORDER BY t.shift_day, t.bill_no LIMIT 500`, businessId),
    all<{ id: string; billNo: string | null; day: string; amountPaise: number; note: string; closedAt: number; closedBy: string | null }>(db, `
      SELECT t.id, t.bill_no AS billNo, t.shift_day AS day, t.amount_paise AS amountPaise, b.note, b.closed_at AS closedAt, u.name AS closedBy
      FROM closed_bills b JOIN transactions t ON t.id = b.transaction_id LEFT JOIN users u ON u.id = b.closed_by
      WHERE b.business_id = ? ORDER BY b.closed_at DESC LIMIT 100`, businessId),
    all<{ at: number | null }>(db, `SELECT max(r.posted_at) AS at FROM bank_rows r JOIN bank_sources s ON s.account_id = r.account_id
      WHERE r.business_id = ? AND s.receives_upi_label IS NOT NULL`, businessId),
  ]);
  const lastBankAt = last[0]?.at ?? null;
  const age = (day: string) => Math.round((Date.parse(today) - Date.parse(day)) / 86400000);
  return {
    watchDays: WATCH_DAYS, lastBankAt, closed,
    credits: credits.map((c) => { const day = shiftDayOf(c.postedAt); return { ...c, day, age: age(day) }; }),
    bills: bills.map((b) => ({ ...b, age: age(b.day), bankIn: (lastBankAt ?? 0) >= shiftWindow(b.day).to - 30 * 60000, canClose: age(b.day) > WATCH_DAYS })),
  };
}
