// Credit notes: money given back on a bill already paid. The bill itself never changes. A credit note takes back the whole
// bill or chosen items, at the bill's own discount share and GST rate, with a reason, and records how the money went back
// (cash from the drawer, UPI, a reversal on the card machine, credit on a folio or credit account, or none). It is numbered
// in its own series per billing name and financial year, goes on the exceptions report, and goes to Bookr.
import { istDay } from '../../../src/time';
import { Hono } from 'hono';
import { all, newId, one, stmt } from '../../../src/db';
import { body, fail, isUuid, text } from '../../../src/http';
import { approval, isManager, requireAction, requireStaff } from '../auth';
import { creditNote, rs, type LineTax, type TaxRow, type Totals } from '../billing';
import { clock, event, isTrigger, bizOf, loadBusiness } from '../util';
import { sendSoon } from '../sync';
import { billAccounts, billOut } from './orders';
import type { AppEnv } from '../types';
import { cashGuard } from './drawers';

export const creditRoutes = new Hono<AppEnv>();
const B = '/businesses/:businessId';
creditRoutes.use(`${B}/*`, requireStaff);

const ZERO: Totals = { grossPaise: 0, discountPaise: 0, taxablePaise: 0, nonGstPaise: 0, cgstPaise: 0, sgstPaise: 0, roundOffPaise: 0, totalPaise: 0 };

creditRoutes.post(`${B}/bills/:id/credit-note`, requireAction('bills.refund'), async (c) => {
  const bid = c.get('businessId');
  const db = c.env.DB;
  const billId = c.req.param('id');
  if (!isUuid(billId)) fail(404, 'Bill not found.');
  const bill = await one<{ bill_no: string; entity_id: string; status: string; gross_paise: number; discount_paise: number; taxable_paise: number; cgst_paise: number;
    sgst_paise: number; round_off_paise: number; total_paise: number; gst_rate_bp: number; series_prefix: string; nongst_paise: number; service_charge_bp: number;
    service_charge_paise: number }>(db, `SELECT b.bill_no, b.entity_id, b.status, b.service_charge_bp, b.service_charge_paise,
      b.gross_paise, b.discount_paise, b.taxable_paise, b.nongst_paise, b.cgst_paise, b.sgst_paise, b.round_off_paise, b.total_paise, b.gst_rate_bp, e.series_prefix
    FROM bills b JOIN billing_entities e ON e.id = b.entity_id WHERE b.id = ? AND b.business_id = ?`, billId, bid);
  if (!bill) fail(404, 'Bill not found.');
  if (bill.status !== 'settled') fail(409, bill.status === 'printed' ? 'This bill is not paid yet. Void it instead.' : 'A void bill has nothing to give back.');
  const data = await body(c);
  const reason = text(data, 'reason', 'A reason for the credit note', { max: 120 })!;

  // What is credited: every line still left on the bill, or chosen quantities.
  const lines = await all<{ id: string; name: string; qty: number; rate_paise: number; taxed: number; tax_kind: string | null; gst_bp: number | null; discount_paise: number;
    service_charge: number; price_incl: number }>(db,
    'SELECT id, name, qty, rate_paise, taxed, tax_kind, gst_bp, discount_paise, service_charge, price_incl FROM bill_lines WHERE bill_id = ? ORDER BY rowid', billId);
  // Items made free or given a share off: each credited quantity takes its share of its own line's discount, and the
  // bill's own discount is shared over what is left (so a free item gives nothing back).
  const lineDisc = lines.reduce((t, l) => t + l.discount_paise, 0);
  const lineNet = (l: (typeof lines)[number], qty: number) => qty * l.rate_paise - (qty === l.qty ? l.discount_paise : Math.floor((l.discount_paise * qty + Math.floor(l.qty / 2)) / l.qty));
  // Each line's tax as billed (older lines: GST at the bill's rate, or liquor).
  const taxOfLine = (l: (typeof lines)[number]): LineTax => {
    const kind = l.tax_kind ?? (l.taxed ? 'gst' : 'liquor');
    return kind === 'gst' ? { kind: 'gst', bp: l.gst_bp ?? bill.gst_rate_bp } : { kind: kind as 'liquor' | 'exempt' };
  };
  const [billRows, priorRows] = await Promise.all([
    all<TaxRow>(db, 'SELECT kind, gst_bp AS bp, value_paise AS valuePaise, cgst_paise AS cgstPaise, sgst_paise AS sgstPaise FROM bill_taxes WHERE bill_id = ?', billId),
    all<TaxRow>(db, `SELECT t.kind, t.gst_bp AS bp, t.value_paise AS valuePaise, t.cgst_paise AS cgstPaise, t.sgst_paise AS sgstPaise FROM credit_note_taxes t
      JOIN credit_notes n ON n.id = t.credit_note_id WHERE n.bill_id = ?`, billId),
  ]);
  const prior = await all<{ lines: string; gross_paise: number; discount_paise: number; taxable_paise: number; nongst_paise: number; cgst_paise: number; sgst_paise: number; round_off_paise: number;
    total_paise: number; service_charge_paise: number }>(db,
    'SELECT lines, gross_paise, discount_paise, taxable_paise, nongst_paise, cgst_paise, sgst_paise, round_off_paise, total_paise, service_charge_paise FROM credit_notes WHERE bill_id = ?', billId);
  const creditedQty = new Map<string, number>();
  for (const p of prior) for (const l of JSON.parse(p.lines) as { lineId: string; qty: number }[]) creditedQty.set(l.lineId, (creditedQty.get(l.lineId) ?? 0) + l.qty);
  const left = lines.map((l) => ({ ...l, left: l.qty - (creditedQty.get(l.id) ?? 0) }));
  let chosen: { lineId: string; name: string; qty: number; amountPaise: number }[];
  if (data.full === true) {
    chosen = left.filter((l) => l.left > 0).map((l) => ({ lineId: l.id, name: l.name, qty: l.left, amountPaise: l.left * l.rate_paise }));
  } else {
    if (!Array.isArray(data.lines) || !data.lines.length) fail(400, 'Choose what is given back, or the whole bill.');
    chosen = [];
    for (const raw of data.lines) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const l = left.find((x) => x.id === r.lineId);
      if (!l || typeof r.qty !== 'number' || !Number.isInteger(r.qty) || r.qty < 0 || r.qty > l.left) fail(400, 'A quantity is more than is left on the bill.');
      if (r.qty > 0) chosen.push({ lineId: l.id, name: l.name, qty: r.qty, amountPaise: r.qty * l.rate_paise });
    }
  }
  if (!chosen.length) fail(409, 'Everything on this bill has already been given back.');
  const lastOne = left.every((l) => l.left === (chosen.find((x) => x.lineId === l.id)?.qty ?? 0));
  const already = prior.reduce<Totals>((t, p) => ({ grossPaise: t.grossPaise + p.gross_paise, discountPaise: t.discountPaise + p.discount_paise, taxablePaise: t.taxablePaise + p.taxable_paise, nonGstPaise: t.nonGstPaise + p.nongst_paise,
    cgstPaise: t.cgstPaise + p.cgst_paise, sgstPaise: t.sgstPaise + p.sgst_paise, roundOffPaise: t.roundOffPaise + p.round_off_paise, totalPaise: t.totalPaise + p.total_paise,
    serviceChargePaise: (t.serviceChargePaise ?? 0) + p.service_charge_paise }), ZERO);
  // Earlier notes from before tax rows were kept count as GST at the bill's rate and liquor.
  const alreadyRows = priorRows.length || !prior.length ? priorRows : [
    { kind: 'gst' as const, bp: bill.gst_rate_bp, valuePaise: already.taxablePaise, cgstPaise: already.cgstPaise, sgstPaise: already.sgstPaise },
    { kind: 'liquor' as const, bp: 0, valuePaise: already.nonGstPaise, cgstPaise: 0, sgstPaise: 0 }];
  const { taxes: noteRows, ...totals } = creditNote({ grossPaise: bill.gross_paise - lineDisc, discountPaise: bill.discount_paise - lineDisc, taxablePaise: bill.taxable_paise, nonGstPaise: bill.nongst_paise,
    cgstPaise: bill.cgst_paise, sgstPaise: bill.sgst_paise, roundOffPaise: bill.round_off_paise, totalPaise: bill.total_paise, gstRateBp: bill.gst_rate_bp, taxes: billRows,
    serviceChargeBp: bill.service_charge_bp, serviceChargePaise: bill.service_charge_paise },
    already, alreadyRows, chosen.map((l) => { const x = lines.find((y) => y.id === l.lineId)!; return { gross: lineNet(x, l.qty), tax: taxOfLine(x), sc: !!x.service_charge, incl: !!x.price_incl }; }), lastOne);
  if (totals.totalPaise <= 0) fail(409, 'Nothing is left to give back on this bill.');

  // How the money goes back.
  const mode = data.refundMode;
  if (!['cash', 'upi', 'card', 'account', 'none'].includes(mode as string)) fail(400, 'Say how the money goes back: cash, UPI, card, to an account, or none.');
  let payAccount: string | null = null;
  let debtor: { id: string; name: string } | null = null;
  if (mode === 'upi') {
    payAccount = (await one<{ id: string }>(db, 'SELECT id FROM pay_accounts WHERE id = ? AND business_id = ?', data.payAccountId, bid))?.id ?? null;
    if (!payAccount) fail(400, 'Choose the account the UPI refund was sent from.');
  }
  // Money put on a room or credit account goes back only to that same one, while it is open (27 Nov 2026): credit on
  // another room leaves this bill due where it was put, and a different guest's folio shows money it never had.
  const [accounts, modes] = await Promise.all([billAccounts(db, billId),
    all<{ mode: string }>(db, 'SELECT DISTINCT p.mode FROM allocations a JOIN payments p ON p.id = a.payment_id WHERE a.bill_id = ?', billId)]);
  const open = accounts.filter((a) => a.open && a.leftPaise > 0);
  if (mode === 'account') {
    if (!open.length) fail(409, accounts.length ? 'The room this bill was put on is closed. Give the money back by cash, UPI or card.'
      : 'This bill was not put on a room or credit account. Give the money back by cash, UPI or card.');
    const a = open.find((x) => x.accountId === data.debtorAccountId);
    if (!a) fail(400, `This bill was put on ${open.map((x) => x.name).join(' and ')}. Credit goes back there only.`);
    if (totals.totalPaise > a.leftPaise) fail(409, `Only ${rs(a.leftPaise)} of this bill is on ${a.name}. Give the rest back by cash, UPI or card.`);
    debtor = { id: a.accountId, name: a.name };
  }
  if (['cash', 'upi', 'card'].includes(mode as string) && open.length && modes.every((m) => m.mode === 'room' || m.mode === 'credit'))
    fail(409, `This bill is on ${open.map((x) => x.name).join(' and ')}, not paid in money. Take it off that bill instead.`);

  // Money given back: a manager approves (21 Nov 2026).
  const approver = await approval(c, data, 'Giving money back');
  const b = bizOf(c);
  const { t, shiftDay, fy } = clock(b);
  // Its number: the billing name's letter, CN, the date (YYMMDD, India time) and the next number of that day (CCN261119001).
  const printDay = istDay(t);
  const yymmdd = printDay.slice(2).replace(/-/g, '');
  const id = newId();
  const staff = c.get('staff');
  const pa = payAccount ? await one<{ name: string; bookr_account_id: string | null }>(db, 'SELECT name, bookr_account_id FROM pay_accounts WHERE id = ?', payAccount) : null;
  // The message for Bookr, written in the same batch; its number is filled from the row just written.
  const message = JSON.stringify({ creditNoteId: id, cnNo: null, billId, billNo: bill.bill_no, reason, lines: chosen, ...totals, refundMode: mode,
    payAccountName: pa?.name ?? null, bookrAccountId: pa?.bookr_account_id ?? null, debtorName: debtor?.name ?? null, shiftDay, at: t, by: staff.name });
  await cashGuard(c, mode === 'cash');
  try {
    await db.batch([
      stmt(db, 'INSERT OR IGNORE INTO credit_note_series (entity_id, fy, next_no) VALUES (?, ?, 1)', bill.entity_id, fy),
      stmt(db, `INSERT INTO credit_notes (id, business_id, bill_id, entity_id, fy, seq, cn_no, shift_day, reason, lines, gross_paise, discount_paise, taxable_paise,
          nongst_paise, cgst_paise, sgst_paise, round_off_paise, total_paise, refund_mode, pay_account_id, debtor_account_id, by_staff, at, print_day, day_seq, service_charge_paise)
        SELECT ?, ?, ?, ?, ?, s.next_no, ? || 'CN' || ? || printf('%03d', d.n), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, d.n, ?
        FROM credit_note_series s, (SELECT coalesce(max(day_seq), 0) + 1 AS n FROM credit_notes WHERE entity_id = ? AND print_day = ?) d WHERE s.entity_id = ? AND s.fy = ?`,
        id, bid, billId, bill.entity_id, fy, bill.series_prefix, yymmdd, shiftDay, reason, JSON.stringify(chosen), totals.grossPaise, totals.discountPaise,
        totals.taxablePaise, totals.nonGstPaise, totals.cgstPaise, totals.sgstPaise, totals.roundOffPaise, totals.totalPaise, mode, payAccount, debtor?.id ?? null, staff.id, t,
        printDay, totals.serviceChargePaise ?? 0, bill.entity_id, printDay, bill.entity_id, fy),
      stmt(db, 'UPDATE credit_note_series SET next_no = next_no + 1 WHERE entity_id = ? AND fy = ?', bill.entity_id, fy),
      ...noteRows.map((x) => stmt(db, 'INSERT INTO credit_note_taxes (credit_note_id, business_id, kind, gst_bp, value_paise, cgst_paise, sgst_paise) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, bid, x.kind, x.bp, x.valuePaise, x.cgstPaise, x.sgstPaise)),
      ...(debtor ? [stmt(db, "INSERT INTO debtor_entries (id, business_id, account_id, kind, amount_paise, bill_id, by_staff, at) VALUES (?, ?, ?, 'credit_note', ?, ?, ?, ?)",
        newId(), bid, debtor.id, -totals.totalPaise, billId, staff.id, t)] : []),
      event(db, bid, 'credit_note', bill.bill_no, totals.totalPaise, reason, `${chosen.map((l) => `${l.qty} × ${l.name}`).join(', ')} · refund ${mode}${isManager(c) ? '' : ` · Approved by ${approver.name}`}`, staff.id, shiftDay),
      stmt(db, "INSERT INTO outbox (id, business_id, kind, body, created_at) SELECT ?, ?, 'credit_note', json_set(?, '$.cnNo', cn_no), ? FROM credit_notes WHERE id = ?",
        newId(), bid, message, t, id),
    ]);
  } catch (e) {
    if (isTrigger(e, 'shift_closed')) fail(409, 'This shift is closed.');
    throw e;
  }
  const cn = (await one<{ cn_no: string }>(db, 'SELECT cn_no FROM credit_notes WHERE id = ?', id))!.cn_no;
  sendSoon(c, bid);
  return c.json({ creditNote: { id, cnNo: cn, ...totals, refundMode: mode, message: `${cn}: ${rs(totals.totalPaise)} given back` }, bill: await billOut(db, bid, billId) }, 201);
});
