// The card picture of a shift not saved yet (approved 10 Nov 2026): its card bills as saving would count them, against
// the card machine's payments in the shift. Nothing is written: what Bookr would match on save is shown, and a person
// may choose a match now (kept in shift_choices, made on Save). The rest is told, to fix before or after saving.

import { all, one, type DB } from './db';
import { addDays, shiftWindow } from './time';
import { autoPairs, cardCandidates, isCardCharge, isMachineUpi, machineLabel, upiBillNear, upiWaitingSaved, waitingCard, type CardPayment, type CardSale, type UpiWaiting } from './cards';
import { cardShiftChoices, plannedRows } from './sales';
import { cardHere, settledHere } from './settledHere';
import { cardAdvancePlans, cardAdvances } from './cardAdvance';

/** How near (minutes) a bill of another mode must be to a machine payment to be told as perhaps paid on the machine. */
const NEAR_MIN = 60;
/** A card tip: the payment is more than the bill by at most this share of the bill, within this many minutes. */
const TIP_SHARE = 0.25;
const TIP_MIN = 20;
/** Payments this long either side of the shift may pay its bills (a bill near 8 am). */
const EDGE_MS = 3 * 3600e3;

export type TrialMatch = { paymentId: string; label: string; amountPaise: number; paidAt: number; how: 'auto' | 'chosen'; choiceId: string | null; billNos: string[] };

export async function trialCards(db: DB, businessId: string, day: string) {
  const w = shiftWindow(day);
  const [rows, payments, last, rivals, chosen] = await Promise.all([
    plannedRows(db, businessId, day),
    all<CardPayment>(db, `SELECT * FROM card_settlements s WHERE s.business_id = ? AND s.paid_at >= ? AND s.paid_at < ?
      AND NOT EXISTS (SELECT 1 FROM card_matches m WHERE m.settlement_id = s.id) ORDER BY s.paid_at`, businessId, w.from - EDGE_MS, w.to + EDGE_MS),
    one<{ paid: number | null; settled: string | null }>(db, 'SELECT max(paid_at) AS paid, max(settled_on) AS settled FROM card_settlements WHERE business_id = ?', businessId),
    // Saved card bills of the shifts either side still waiting: a payment they want is not Bookr's to match here.
    waitingCard(db, businessId, addDays(day, -1), addDays(day, 1)),
    cardShiftChoices(db, businessId, day),
  ]);
  // Machine payments with no bill booked as a sale (or to a head) before saving (11 Nov 2026): matched already, told
  // with their Undo, and still part of what the machine got.
  const booked = await all<CardPayment & { txId: string; narration: string | null; headName: string | null }>(db, `SELECT s.*, t.id AS txId, t.narration, h.name AS headName
    FROM card_settlements s JOIN card_matches m ON m.settlement_id = s.id JOIN transactions t ON t.id = m.transaction_id LEFT JOIN heads h ON h.id = t.head_id
    WHERE s.business_id = ? AND s.paid_at >= ? AND s.paid_at < ? AND t.source = 'bank_sheet' AND json_extract(t.ocr_original, '$.card') = 'booked'
    ORDER BY s.paid_at`, businessId, w.from, w.to);
  const covered = (last?.paid ?? 0) >= w.to || (last?.settled ?? '') >= addDays(day, 2);
  const inShift = (p: CardPayment) => p.paid_at >= w.from && p.paid_at < w.to;
  // Payments chosen on another shift's Reconcile are held there.
  const heldElsewhere = new Set((await all<{ card_payment_id: string }>(db, `SELECT card_payment_id FROM shift_choices WHERE business_id = ? AND kind = 'card_match'
    AND shift_day <> ?`, businessId, day)).map((x) => x.card_payment_id));

  // This shift's card sales as saving would make them: one per bill (its card parts added up).
  const ids = [...new Set(rows.map((r) => r.c.id))];
  const [times, heads] = ids.length ? await Promise.all([
    all<{ id: string; paid_at: number | null }>(db, `SELECT c.id, sb.paid_at FROM bill_comparisons c LEFT JOIN software_bills sb ON sb.id = c.software_bill_id
      WHERE c.business_id = ? AND c.shift_day = ?`, businessId, day),
    all<{ id: string; head: string; upload: string | null }>(db, 'SELECT id, coalesce(paid_with_row_id, id) AS head, upload_id AS upload FROM register_rows WHERE business_id = ? AND shift_day = ?', businessId, day),
  ]) : [[], []];
  const timeOf = new Map(times.map((x) => [x.id, x.paid_at]));
  const headOf = new Map(heads.map((x) => [x.id, x.head]));
  const uploadOf = new Map(heads.map((x) => [x.id, x.upload]));
  const own = new Map<string, CardSale>();
  for (const r of rows.filter((x) => x.mode === 'card')) {
    const s = own.get(r.c.id);
    if (s) s.amount_paise += r.amount;
    else own.set(r.c.id, { id: r.c.id, amount_paise: r.amount, bill_no: r.c.bill_no, shift_day: day, paid_at: timeOf.get(r.c.id) ?? null,
      group_head: r.c.register_row_id ? headOf.get(r.c.register_row_id) ?? null : null });
  }
  // Card bills of an earlier saved shift whose register line is here (settled the next day, approved 11 Nov 2026): this
  // shift's payments pay them like its own bills. Chosen by the sale's id; the bill has no time here.
  const later = cardHere(await settledHere(db, businessId, day));
  for (const x of later) own.set(x.txId, { id: x.txId, amount_paise: x.amountPaise, bill_no: x.billNo, shift_day: day, paid_at: null, group_head: null });
  const laterIds = new Set(later.map((x) => x.txId));
  const sales = [...own.values()];
  // UPI bills of this shift (and saved ones either side) still waiting: UPI on the machine pays them first (11 Nov 2026).
  // Not one a person matched to a credit, nor one a bank credit of its amount near its time can pay.
  const [upiCredits, upiChosen, savedUpi] = await Promise.all([
    all<{ amount_paise: number; posted_at: number }>(db, `SELECT amount_paise, posted_at FROM bank_rows WHERE business_id = ? AND kind = 'upi_in' AND status = 'unmatched'
      AND posted_at >= ? AND posted_at < ?`, businessId, w.from - EDGE_MS, w.to + EDGE_MS),
    all<{ comparison_ids: string }>(db, "SELECT comparison_ids FROM shift_choices WHERE business_id = ? AND shift_day = ? AND kind = 'bank_match'", businessId, day),
    upiWaitingSaved(db, businessId, addDays(day, -1), addDays(day, 1)),
  ]);
  const upiChosenIds = new Set(upiChosen.flatMap((k) => JSON.parse(k.comparison_ids) as string[]));
  const upiOpen = rows.filter((r) => r.mode === 'upi' && !upiChosenIds.has(r.c.id) && !rows.some((o) => o !== r && o.c.id === r.c.id))
    .map((r) => ({ id: r.c.id, billNo: r.c.bill_no, amountPaise: r.amount, paidAt: timeOf.get(r.c.id) ?? null, grouped: !!(r.c.register_row_id && headOf.get(r.c.register_row_id) !== r.c.register_row_id),
      rowId: r.c.register_row_id ?? null, uploadId: r.c.register_row_id ? uploadOf.get(r.c.register_row_id) ?? null : null, swMode: r.c.sw_mode ?? null }))
    .filter((b) => !upiCredits.some((c) => c.amount_paise === b.amountPaise && (b.paidAt == null || Math.abs(c.posted_at - b.paidAt) <= NEAR_MIN * 60000)));
  const paidByCredit = (b: { amountPaise: number; paidAt: number | null }) => upiCredits.some((c) => c.amount_paise === b.amountPaise && (b.paidAt == null || Math.abs(c.posted_at - b.paidAt) <= NEAR_MIN * 60000));
  const upiWaiting: UpiWaiting = [...rows.filter((r) => r.mode === 'upi' && !upiChosenIds.has(r.c.id)).map((r) => ({ amountPaise: r.amount, paidAt: timeOf.get(r.c.id) ?? null }))
    .filter((b) => !paidByCredit(b)), ...savedUpi];
  const billNo = new Map(sales.map((s) => [s.id, s.bill_no ?? '']));

  // Chosen matches first; then what Bookr would match on save, among the payments and bills left.
  const matchOf = new Map<string, TrialMatch>();
  const label = (p: Pick<CardPayment, 'scheme' | 'card_type' | 'card_last4' | 'pay_mode'>) => machineLabel(p);
  for (const k of chosen) {
    if (!k.open) continue;
    const m: TrialMatch = { paymentId: k.paymentId, label: k.label, amountPaise: k.amountPaise, paidAt: k.paidAt, how: 'chosen', choiceId: k.id, billNos: k.billNos };
    k.comparisonIds.forEach((id) => matchOf.set(id, m));
  }
  const usedPay = new Set(chosen.filter((k) => k.open).map((k) => k.paymentId));
  const free = payments.filter((p) => !usedPay.has(p.id) && !heldElsewhere.has(p.id));
  const freeSales = sales.filter((s) => !matchOf.has(s.id));
  const otherRivals = rivals.filter((x) => !laterIds.has(x.id));
  const pool = [...freeSales, ...otherRivals];
  for (const pr of autoPairs(free, pool, upiWaiting)) {
    if (!pr.k.transactionIds.every((id) => own.has(id))) continue;
    const p = payments.find((x) => x.id === pr.paymentId)!;
    const m: TrialMatch = { paymentId: p.id, label: label(p), amountPaise: p.amount_paise, paidAt: p.paid_at, how: 'auto', choiceId: null, billNos: pr.k.billNos };
    pr.k.transactionIds.forEach((id) => matchOf.set(id, m));
    usedPay.add(p.id);
  }

  // What needs a person: this shift's machine payments not matched above.
  const left = free.filter((p) => !usedPay.has(p.id) && inShift(p));
  const leftSales = sales.filter((s) => !matchOf.has(s.id));
  const { candidates } = cardCandidates(left, [...leftSales, ...otherRivals], upiWaiting);
  // A payment that is exactly one bill of this shift plus one settled here from an earlier shift (approved 11 Nov 2026):
  // offered when it is the only such pair, the bill of this shift near the payment. A person chooses it.
  for (const p of left) {
    if ((candidates.get(p.id) ?? []).length || p.txn_type !== 'PURCHASE') continue;
    const fits = leftSales.filter((s) => !laterIds.has(s.id) && s.paid_at != null && Math.abs(s.paid_at - p.paid_at) <= TIP_MIN * 60000).flatMap((s) =>
      leftSales.filter((e) => laterIds.has(e.id) && s.amount_paise + e.amount_paise === p.amount_paise).map((e) => ({ s, e })));
    if (fits.length !== 1) continue;
    const { s: a, e: b } = fits[0];
    candidates.set(p.id, [{ transactionIds: [a.id, b.id], billNos: [a.bill_no ?? '', b.bill_no ?? ''], amountPaise: p.amount_paise,
      minutes: Math.round(Math.abs(a.paid_at! - p.paid_at) / 60000), strong: false, shiftDay: day }]);
  }
  // Bills of this shift written as cash or UPI, on their own, near a payment of their amount: perhaps paid on the machine.
  const groupedRows = new Set(heads.filter((h) => h.head !== h.id).flatMap((h) => [h.id, h.head]));
  const otherWay = rows.filter((r) => r.mode !== 'card' && !rows.some((o) => o !== r && o.c.id === r.c.id) && !(r.c.register_row_id && groupedRows.has(r.c.register_row_id)))
    .map((r) => ({ id: r.c.id, billNo: r.c.bill_no, mode: r.mode, amountPaise: r.amount, paidAt: timeOf.get(r.c.id) ?? null,
      rowId: r.c.register_row_id ?? null, uploadId: r.c.register_row_id ? uploadOf.get(r.c.register_row_id) ?? null : null, swMode: r.c.sw_mode ?? null }))
    .filter((x): x is typeof x & { paidAt: number } => x.paidAt != null);
  const usedOther = new Set<string>();
  const pay = (p: CardPayment) => ({ id: p.id, paidAt: p.paid_at, amountPaise: p.amount_paise, txnType: p.txn_type, terminalId: p.terminal_id, upi: isMachineUpi(p), label: label(p) });
  const needs = left.flatMap((p) => {
    const mine = (candidates.get(p.id) ?? []).filter((k) => k.transactionIds.every((id) => own.has(id))).slice(0, 5);
    const theirs = (candidates.get(p.id) ?? []).filter((k) => !k.transactionIds.every((id) => own.has(id)));
    // Wanted only by a saved bill of the shift before or after: told on that shift.
    if (!mine.length && theirs.length) return [];
    // A card company charge is settled with its day, not a sale or a refund (11 Nov 2026).
    if (isCardCharge(p)) return [];
    const purchase = p.txn_type === 'PURCHASE';
    const tip = !mine.length && purchase && !isMachineUpi(p) ? leftSales.filter((s) => s.paid_at != null && p.amount_paise > s.amount_paise
      && p.amount_paise - s.amount_paise <= s.amount_paise * TIP_SHARE && Math.abs(p.paid_at - s.paid_at) <= TIP_MIN * 60000)
      .sort((a, b) => Math.abs(p.paid_at - a.paid_at!) - Math.abs(p.paid_at - b.paid_at!))[0] ?? null : null;
    const written = !mine.length && !tip && purchase ? otherWay.filter((b) => !usedOther.has(b.id) && b.amountPaise === p.amount_paise
      && Math.abs(b.paidAt - p.paid_at) <= NEAR_MIN * 60000)
      .sort((a, b) => Math.abs(a.paidAt - p.paid_at) - Math.abs(b.paidAt - p.paid_at))[0] ?? null : null;
    if (written) usedOther.add(written.id);
    // UPI on the machine pays UPI bills: Save matches it to the bill's UPI sale when the bank evidence shows it. One a
    // card bill may take (no UPI bill of its amount waiting near) is told like a swipe.
    // UPI on the machine with no UPI bill of its amount waiting near it (12 Nov 2026) is money with no bill, listed with
    // Book like a swipe; one a UPI bill may be is told on the UPI tab.
    if (purchase && isMachineUpi(p) && !written && !mine.length && upiBillNear(p, upiWaiting)) return [];
    return [{ payment: pay(p), why: !purchase ? 'not_purchase' : mine.length ? (mine.length > 1 ? 'several' : 'one') : tip ? 'tip' : written ? 'written' : 'no_bill',
      candidates: mine.map((k) => ({ comparisonIds: k.transactionIds, billNos: k.billNos, amountPaise: k.amountPaise, minutes: k.minutes,
        earlier: k.transactionIds.flatMap((id) => later.filter((x) => x.txId === id).map((x) => ({ billNo: x.billNo, fromDay: x.fromDay, amountPaise: x.amountPaise }))) })),
      tip: tip ? { comparisonId: tip.id, billNo: tip.bill_no, amountPaise: tip.amount_paise, paidAt: tip.paid_at, tipPaise: p.amount_paise - tip.amount_paise } : null,
      written: written ? { comparisonId: written.id, billNo: written.billNo, mode: written.mode, amountPaise: written.amountPaise, paidAt: written.paidAt,
        minutes: Math.round(Math.abs(written.paidAt - p.paid_at) / 60000), rowId: written.rowId, uploadId: written.uploadId, swMode: written.swMode, upiNear: false } : null }];
  });
  // A UPI credit of the bill's amount near it too (Reconcile fix, 11 Nov 2026): it may have been paid twice, so the
  // bill is not changed to card in one click.
  for (const n of needs) {
    const wr = n.written;
    if (!wr) continue;
    wr.upiNear = !!(await one<{ x: number }>(db, `SELECT 1 AS x FROM bank_rows WHERE business_id = ? AND kind = 'upi_in' AND status IN ('unmatched', 'matched')
      AND amount_paise = ? AND abs(posted_at - ?) <= ? LIMIT 1`, businessId, wr.amountPaise, wr.paidAt, NEAR_MIN * 60000));
  }
  // UPI bills paid by UPI on the card machine (11 Nov 2026), offered before saving on the UPI tab: one free UPI payment on
  // the machine of the bill's amount within NEAR_MIN, the only bill of that amount it could be. Save matches it to the
  // machine's report; the bank evidence may already, in which case the bill is not left on the UPI tab.
  const machineFree = left.filter((p) => p.txn_type === 'PURCHASE' && isMachineUpi(p)
    && needs.every((n) => n.payment.id !== p.id || (n.why === 'written' && n.written?.mode === 'upi')));
  const near = (a: number | null, b: number) => a != null && Math.abs(a - b) <= NEAR_MIN * 60000;
  const upiOnMachine = upiOpen.filter((b) => !b.grouped && !chosen.some((k) => k.open && k.comparisonIds.includes(b.id))).flatMap((b) => {
    const fits = machineFree.filter((p) => p.amount_paise === b.amountPaise && near(b.paidAt, p.paid_at));
    if (fits.length !== 1) return [];
    if (upiOpen.filter((o) => o.amountPaise === b.amountPaise && near(o.paidAt, fits[0].paid_at)).length !== 1) return [];
    const p = fits[0];
    return [{ comparisonId: b.id, billNo: b.billNo, amountPaise: b.amountPaise, paidAt: b.paidAt, paymentId: p.id, payAt: p.paid_at, label: label(p), minutes: Math.round(Math.abs(p.paid_at - b.paidAt!) / 60000),
      rowId: b.rowId, uploadId: b.uploadId, swMode: b.swMode }];
  });

  // Card bills no machine payment can be, once the card report is in for the shift.
  const offered = new Set(needs.flatMap((n) => [...n.candidates.flatMap((k) => k.comparisonIds), ...(n.tip ? [n.tip.comparisonId] : [])]));
  const wanted = new Set([...cardCandidates(payments.filter((p) => !usedPay.has(p.id) && !heldElsewhere.has(p.id)), leftSales, upiWaiting).candidates.values()]
    .flatMap((l) => l.flatMap((k) => k.transactionIds)));
  // Card advances (approved 12 Nov 2026): a bill chosen to use one is matched on save; a bill with no swipe is offered the
  // advances of its amount.
  const [advances, advPlans] = await Promise.all([cardAdvances(db, businessId, day), cardAdvancePlans(db, businessId, day)]);
  const advPlanned = advPlans.filter((x) => advances.some((a) => a.paymentId === x.paymentId) && own.has(x.comparisonId) && !matchOf.has(x.comparisonId));
  const advBill = new Set(advPlanned.map((x) => x.comparisonId));
  const advFree = advances.filter((a) => !advPlanned.some((x) => x.paymentId === a.paymentId));
  const advOut = (a: (typeof advances)[number]) => ({ paymentId: a.paymentId, amountPaise: a.amountPaise, paidAt: a.paidAt, txDay: a.txDay, label: label(a),
    what: a.what.replace(/ — card payment$/, '').replace(/^Sale not billed \(Room\): /, '') });
  const noSwipe = covered ? leftSales.filter((s) => !offered.has(s.id) && !wanted.has(s.id) && !advBill.has(s.id))
    .map((s) => {
      // The nearest free machine payment of another amount (11 Nov 2026): a misread amount or a tip, for a person to check.
      const nearPay = s.paid_at == null ? null : left.filter((p) => p.txn_type === 'PURCHASE' && p.amount_paise !== s.amount_paise && Math.abs(p.paid_at - s.paid_at!) <= TIP_MIN * 60000
        && Math.abs(p.amount_paise - s.amount_paise) <= s.amount_paise * TIP_SHARE && !(isMachineUpi(p) && upiBillNear(p, upiWaiting)))
        .sort((a, b) => Math.abs(a.paid_at - s.paid_at!) - Math.abs(b.paid_at - s.paid_at!))[0] ?? null;
      return { comparisonId: s.id, billNo: s.bill_no, amountPaise: s.amount_paise, paidAt: s.paid_at,
        advances: own.has(s.id) ? advFree.filter((a) => a.amountPaise === s.amount_paise).map(advOut) : [],
        near: nearPay ? { paymentId: nearPay.id, amountPaise: nearPay.amount_paise, paidAt: nearPay.paid_at, label: label(nearPay), minutes: Math.round(Math.abs(nearPay.paid_at - s.paid_at!) / 60000) } : null };
    }) : [];

  // The open entries to tick on the Card tab's tray (approved 10 Nov 2026): card payments a person may pair, and the
  // card bills not matched yet, with the register row a tip, discount or fixed amount is written on.
  const regOf = new Map(rows.filter((r) => r.c.register_row_id).map((r) => [r.c.id, r.c.register_row_id as string]));
  const trayPays = [...needs.filter((n) => n.payment.txnType === 'PURCHASE' && (!n.payment.upi || n.why !== 'written' || n.written?.mode !== 'upi')).map((n) => n.payment),
    ...machineFree.filter((p) => !upiBillNear(p, upiWaiting) && !needs.some((n) => n.payment.id === p.id)).map(pay)];
  // A payment a Check line names ("tick both below") is always there to tick (11 Nov 2026).
  for (const x of noSwipe) {
    const p = x.near && !trayPays.some((t) => t.id === x.near!.paymentId) ? left.find((y) => y.id === x.near!.paymentId) : undefined;
    if (p) trayPays.push(pay(p));
  }
  trayPays.sort((a, b) => a.paidAt - b.paidAt);
  // UPI on the machine left for the UPI tab (11 Nov 2026): said on the Card tab too, so every machine payment is found there.
  const onUpiTab = left.filter((p) => p.txn_type === 'PURCHASE' && isMachineUpi(p) && !isCardCharge(p) && !trayPays.some((t) => t.id === p.id)
    && !needs.some((n) => n.payment.id === p.id && n.why === 'written' && n.written?.mode !== 'upi')).map((p) => {
    const offer = upiOnMachine.find((o) => o.paymentId === p.id);
    const wr = needs.find((n) => n.payment.id === p.id)?.written;
    return { ...pay(p), billNo: offer?.billNo ?? wr?.billNo ?? null, offered: !!offer };
  });
  const open = {
    payments: trayPays,
    bills: leftSales.map((s) => {
      const rowId = regOf.get(s.id) ?? null;
      const grouped = !!rowId && groupedRows.has(rowId);
      const e = later.find((x) => x.txId === s.id);
      if (e) return { id: s.id, billNo: s.bill_no, amountPaise: s.amount_paise, paidAt: null, grouped: false, group: null, rowId: e.rowId, uploadId: e.uploadId, fromDay: e.fromDay };
      return { id: s.id, billNo: s.bill_no, amountPaise: s.amount_paise, paidAt: s.paid_at, grouped, group: grouped ? s.group_head : null, rowId, uploadId: rowId ? uploadOf.get(rowId) ?? null : null };
    }),
  };
  const shiftPays = payments.filter((p) => inShift(p) && p.txn_type === 'PURCHASE');
  const sum = (xs: { amount_paise?: number; amountPaise?: number }[]) => xs.reduce((a, x) => a + (x.amount_paise ?? x.amountPaise ?? 0), 0);
  const matchedSales = sales.filter((s) => matchOf.has(s.id));
  const noBill = needs.filter((n) => n.why === 'no_bill' || n.why === 'written');
  // A bill on its own register row with one UPI payment: what changing it to card needs.
  const billRow = (id: string) => {
    const rs = rows.filter((r) => r.c.id === id);
    const r = rs[0];
    if (rs.length !== 1 || r.mode !== 'upi' || !r.c.register_row_id) return null;
    return { comparisonId: id, billNo: r.c.bill_no, mode: r.mode, amountPaise: r.amount, rowId: r.c.register_row_id, uploadId: uploadOf.get(r.c.register_row_id) ?? null, swMode: r.c.sw_mode ?? null };
  };
  // Where the shift's machine money goes (11 Nov 2026): to card bills, to UPI bills (chosen, or left for the UPI tab), or
  // not matched yet. The three add up to what the machine got.
  const toCard = new Set([...matchOf].filter(([id]) => own.has(id)).map(([, m]) => m.paymentId));
  const upiBillChoice = (k: (typeof chosen)[number]) => k.open && k.comparisonIds.every((id) => !own.has(id));
  const toUpi = new Set([...chosen.filter(upiBillChoice).map((k) => k.paymentId), ...onUpiTab.map((p) => p.id)]);
  const unmatched = shiftPays.filter((p) => !toCard.has(p.id) && !toUpi.has(p.id) && !isCardCharge(p));
  return {
    day, trial: true as const, covered,
    strip: { billsPaise: sum(sales), bills: sales.length, wouldPaise: sum(matchedSales) + sum(sales.filter((x) => advBill.has(x.id))), would: matchedSales.length + advBill.size,
      chosen: matchedSales.filter((s) => matchOf.get(s.id)!.how === 'chosen').length,
      machineCardPaise: [...shiftPays, ...booked].filter((p) => !isMachineUpi(p)).reduce((a, p) => a + p.amount_paise, 0),
      machineUpiPaise: [...shiftPays, ...booked].filter((p) => isMachineUpi(p)).reduce((a, p) => a + p.amount_paise, 0),
      noSwipePaise: sum(noSwipe), noSwipe: noSwipe.length, noBillPaise: sum(unmatched), noBill: unmatched.length,
      machine: { cardPaise: sum(shiftPays.filter((p) => toCard.has(p.id))), upiPaise: sum(shiftPays.filter((p) => toUpi.has(p.id))), leftPaise: sum(unmatched), bookedPaise: sum(booked) } },
    matches: Object.fromEntries([...matchOf].map(([id, m]) => [id, { ...m, billNo: billNo.get(id) ?? '' }])) as Record<string, TrialMatch & { billNo: string }>,
    choices: chosen.map((k) => ({ id: k.id, paymentId: k.paymentId, billNos: k.billNos, amountPaise: k.amountPaise, paidAt: k.paidAt, label: k.label, open: k.open, by: k.by, upiBill: upiBillChoice(k),
      bill: upiBillChoice(k) && k.comparisonIds.length === 1 ? billRow(k.comparisonIds[0]) : null })),
    needs, noSwipe, open, upiOnMachine, onUpiTab,
    advancePlans: advPlanned.map((x) => ({ ...advOut(advances.find((a) => a.paymentId === x.paymentId)!), comparisonId: x.comparisonId, billNo: billNo.get(x.comparisonId) ?? '' })),
    booked: booked.map((p) => ({ paymentId: p.id, amountPaise: p.amount_paise, paidAt: p.paid_at, label: machineLabel(p), headName: p.headName,
      what: (p.narration ?? '').replace(/ — card payment$/, '') })),
    // Card bills with no payment yet while the card report is not in: left too, waiting for the report (approved 10 Nov 2026).
    waitingReport: covered ? 0 : leftSales.filter((s) => !offered.has(s.id) && !advBill.has(s.id)).length,
    left: needs.length + noSwipe.length + (covered ? 0 : leftSales.filter((s) => !offered.has(s.id) && !advBill.has(s.id)).length),
  };
}
