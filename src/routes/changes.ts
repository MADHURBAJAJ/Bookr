import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, one } from '../db';
import { fail } from '../http';
import { shiftWindow } from '../time';

export const changesRoutes = new Hono<AppEnv>();

/**
 * Changes tab (approved 21 Nov 2026): every change made to a shift, newest first, with who and when, and how to undo it.
 * Read only: an undo goes through the route that already undoes that kind of change (its own role check), and only the
 * latest change to a bill, line or credit can be undone, so nothing is put back over a later change.
 */
type Audit = { id: number; action: string; rowTable: string; rowId: string; before: string | null; after: string | null; at: number; userId: string | null; user: string | null };
type Undo = { method: 'PUT' | 'POST' | 'DELETE'; path: string; body?: Record<string, unknown> };
type Item = {
  id: number; at: number; userId: string | null; user: string | null; action: string; kind: string; bill: string | null; text: string;
  sub?: string; auto: boolean; state: 'undo' | 'later' | 'gone' | 'none' | 'saved' | 'folded'; stale?: boolean; times?: number; undo?: Undo; key?: string;
};

const AUTO = new Set(['register.auto_check', 'register.number_completed', 'comparison.decision_cleared', 'register.auto_discount', 'shift.choices_skipped', 'transaction.remove_on_reopen']);
const DEC: Record<string, string> = { use_register: 'Use register', use_software: 'Use software', leave_out: 'Leave out', carry_forward: 'Carry forward' };
const MODE: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', mixed: 'Part cash, part UPI' };
const LABEL: Record<string, string> = {
  'comparison.decision_cleared': 'Decision cleared by Bookr: the register or software report changed',
  'comparison.keep_waiting': 'Kept waiting for the money', 'comparison.close': 'Closed',
  'register.auto_discount': 'Group discount filled in by Bookr', 'register.auto_check': 'Ticked by Bookr: register, software and money agree', 'register.number_completed': 'Bill number completed by Bookr from the software report', 'register.move_column': 'A payment column moved back one line', 'register.move_column_undone': 'Column move undone', 'register.split': 'Register line split', 'register.insert_below': 'Line added below',
  'register.paid_later': 'Paid later by card or UPI', 'register.paid_later_undone': 'Paid later undone', 'register.fill_discounts': 'Discounts filled in',
  'register.column_changed': 'Register column changed', 'register.shift_payments': 'Payments moved to another column',
  'bill.paid_by_undone': 'Paid-by undone', 'bill.complimentary_undone': 'No longer complimentary',
  'shift.confirm': 'Shift saved', 'shift.reopen': 'Shift reopened', 'shift.choices_skipped': 'Picks left out on save by Bookr',
  'bank.match': 'Matched to a bank credit', 'bank.unmatch': 'Unmatched', 'bank.match_adjust_bills': 'Matched; register corrected to the bank amount',
  'bank.same_sale': 'Joined as the same sale', 'bank.same_sale_undone': 'Same sale undone', 'bank.source': 'Source set',
  'cash.shortage_booked': 'Cash shortage booked', 'cash.excess_booked': 'Extra cash booked as income', 'cash.excess_undone': 'Extra cash undone',
  'cash.shortage_reduced': 'Cash shortage reduced (bill paid on a later day)', 'cash.shortage_restored': 'Cash shortage put back',
  'cash.shortage_reversed': 'Cash shortage reversed', 'cash.writeoff': 'Written off', 'cash.paid_late': 'Paid late', 'cash.paid_late_undone': 'Paid late undone',
  'cash.difference_accepted': 'Cash difference accepted', 'transaction.remove_on_reopen': 'Sale taken off (shift reopened)',
};
const kindOf = (a: string) => (a.startsWith('bill.complimentary') ? 'comp' : a.startsWith('comparison.') || a.startsWith('bill.') ? 'decision'
  : a.startsWith('register.') ? 'register' : a.startsWith('bank.') || a.startsWith('shift.choice') ? 'money' : a.startsWith('cash.') ? 'cash' : 'shift');
const rs = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const clock = (ms: number) => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 16).replace(/^(\d\d):(\d\d)$/, (_, h, m) => `${+h % 12 || 12}:${m} ${+h < 12 ? 'am' : 'pm'}`);
const json = (s: string | null) => { try { return s ? JSON.parse(s) as Record<string, any> : null; } catch { return null; } };
const inputAmount = (p: number) => (p / 100).toFixed(2);

type RowState = Record<string, any>;
/** A register line as the edit audit keeps it, in one comparable form (status only when both sides have one). */
const rowKey = (s: RowState | null, withStatus: boolean) => s && JSON.stringify([s.billNo ?? '', s.billType ?? null, s.amountPaise ?? 0, (s.discountPaise ?? 0) - (s.tipPaise ?? 0),
  ((s.payments ?? []) as { mode: string; amount: number; label: string | null }[]).map((p) => [p.mode, p.amount, p.label ?? '']).sort(), s.paidWithRowId ?? null,
  s.remarks ?? null, withStatus ? s.status ?? null : null]);

changesRoutes.get('/businesses/:businessId/shifts/:day/changes', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const day = c.req.param('day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(400, 'Day must be YYYY-MM-DD.');
  const w = shiftWindow(day);
  const CMP = 'SELECT id FROM bill_comparisons WHERE business_id = ? AND shift_day = ?';
  const [audits, cmps, regs, shift, choices] = await Promise.all([
    all<Audit>(db, `
      SELECT a.id, a.action, a.row_table AS rowTable, a.row_id AS rowId, a.before, a.after, a.created_at AS at, a.user_id AS userId, u.name AS user
      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.business_id = ? AND a.action NOT IN ('ocr.read', 'ocr.queue') AND (
        (a.row_table = 'bill_comparisons' AND a.row_id IN (${CMP}))
        OR (a.row_table = 'register_rows' AND (a.row_id IN (SELECT id FROM register_rows WHERE business_id = ? AND shift_day = ?)
          OR (a.action = 'register.delete' AND json_extract(a.before, '$.uploadId') IN (SELECT id FROM uploads WHERE business_id = ? AND business_day = ?))))
        OR (a.row_table = 'bank_rows' AND (json_extract(a.after, '$.shiftDay') = ? OR json_extract(a.before, '$.shiftDay') = ?
          OR json_extract(a.after, '$.comparisonId') IN (${CMP})
          OR (a.action IN ('bank.book', 'bank.reopen', 'bank.ignore') AND a.row_id IN (SELECT id FROM bank_rows WHERE business_id = ? AND posted_at >= ? AND posted_at < ?))))
        OR (a.row_table = 'shifts' AND a.row_id IN (SELECT id FROM shifts WHERE business_id = ? AND shift_day = ?))
        OR (a.row_table = 'transactions' AND a.action LIKE 'cash.%' AND json_extract(a.after, '$.day') = ?)
      ) ORDER BY a.id LIMIT 600`,
      bid, bid, day, bid, day, bid, day, day, day, bid, day, bid, w.from, w.to, bid, day, day),
    all<{ id: string; billNo: string; decision: string | null; rgMode: string | null; rgPaise: number | null; swMode: string | null; swPaise: number | null }>(db,
      `SELECT id, bill_no AS billNo, decision, rg_mode AS rgMode, rg_amount_paise AS rgPaise, sw_mode AS swMode, sw_amount_paise AS swPaise
       FROM bill_comparisons WHERE business_id = ? AND shift_day = ?`, bid, day),
    all<{ id: string; billNo: string; status: string }>(db, 'SELECT id, bill_no AS billNo, status FROM register_rows WHERE business_id = ? AND shift_day = ?', bid, day),
    one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', bid, day),
    all<{ id: string; bankRowId: string | null; cardId: string | null }>(db,
      'SELECT id, bank_row_id AS bankRowId, card_payment_id AS cardId FROM shift_choices WHERE business_id = ? AND shift_day = ?', bid, day),
  ]);
  const cmp = new Map(cmps.map((x) => [x.id, x]));
  const reg = new Map(regs.map((x) => [x.id, x]));
  const choiceOf = new Map(choices.map((k) => [k.bankRowId ?? k.cardId ?? '', k.id]));
  // The bank lines named, a few at a time (D1 takes at most 100 values per query).
  const bankIds = [...new Set(audits.filter((a) => a.rowTable === 'bank_rows').map((a) => a.rowId))];
  const bank = new Map<string, { postedAt: number; amountPaise: number; status: string; headName: string | null }>();
  for (let i = 0; i < bankIds.length; i += 90) {
    const part = bankIds.slice(i, i + 90);
    for (const r of await all<{ id: string; postedAt: number; amountPaise: number; status: string; headName: string | null }>(db, `
      SELECT r.id, r.posted_at AS postedAt, r.amount_paise AS amountPaise, r.status, h.name AS headName
      FROM bank_rows r LEFT JOIN transactions t ON t.id = r.transaction_id LEFT JOIN heads h ON h.id = t.head_id
      WHERE r.business_id = ? AND r.id IN (${part.map(() => '?').join(',')})`, bid, ...part)) bank.set(r.id, r);
  }
  const billsOf = (ids: unknown) => (Array.isArray(ids) ? ids.map((x) => cmp.get(x as string)?.billNo).filter(Boolean).join(' + ') : '') || null;
  const credit = (id: string) => { const b = bank.get(id); return b ? `${rs(b.amountPaise)} at ${clock(b.postedAt)}` : 'A credit'; };
  const addedAt = new Set(audits.filter((a) => a.action === 'register.added_from_software').map((a) => a.at));
  const lastNote = new Map<string, string | null>();

  const items: Item[] = [];
  for (const a of audits) {
    const before = json(a.before);
    const after = json(a.after);
    const it: Item = { id: a.id, at: a.at, userId: a.userId, user: a.user, action: a.action, kind: kindOf(a.action), bill: null, text: LABEL[a.action] ?? a.action,
      auto: !a.userId || AUTO.has(a.action), state: 'none' };
    const cm = a.rowTable === 'bill_comparisons' ? cmp.get(a.rowId) : undefined;
    if (cm) it.bill = cm.billNo;
    if (a.rowTable === 'register_rows') it.bill = (after?.billNo || before?.billNo || reg.get(a.rowId)?.billNo) ?? null;
    switch (a.action) {
      case 'comparison.decide': {
        // Added from the software report: the decision is part of that one change.
        if (!before && addedAt.has(a.at)) continue;
        const d = after?.decision ?? null;
        const amt = d === 'use_register' && cm?.rgPaise != null ? ` (${MODE[cm.rgMode ?? ''] ?? cm.rgMode ?? ''} ${rs(cm.rgPaise)})`
          : d === 'use_software' && cm?.swPaise != null ? ` (${MODE[cm.swMode ?? ''] ?? cm.swMode ?? ''} ${rs(cm.swPaise)})` : '';
        it.text = d ? `${DEC[d] ?? d}${amt}` : 'Decision taken off';
        if (after?.note) it.sub = after.note;
        it.key = `c:${a.rowId}`;
        if (cm) {
          const prevNote = lastNote.get(a.rowId) ?? null;
          it.undo = { method: 'PUT', path: `/comparisons/${a.rowId}`, body: { decision: before?.decision ?? null, linkedToId: before?.linkedToId ?? null, ...(prevNote ? { note: prevNote } : {}) } };
          if ((cm.decision ?? null) !== d) it.stale = true;
        }
        lastNote.set(a.rowId, after?.note ?? null);
        break;
      }
      case 'register.edit': {
        it.text = after?.changes ?? 'Register line changed';
        it.key = `r:${a.rowId}`;
        if (reg.has(a.rowId) && before) {
          const signed = (before.discountPaise ?? 0) - (before.tipPaise ?? 0);
          it.undo = { method: 'PUT', path: `/register-rows/${a.rowId}`, body: {
            billNo: before.billNo ?? '', billType: before.billType ?? null, amount: inputAmount(before.amountPaise ?? 0), discount: inputAmount(signed),
            payments: (before.payments ?? []).map((p: { mode: string; amount: number; label: string | null }) => ({ mode: p.mode, columnLabel: p.label, amount: inputAmount(p.amount) })),
            paidWithRowId: before.paidWithRowId ?? null, remarks: before.remarks ?? null, status: before.status ?? reg.get(a.rowId)!.status } };
        }
        break;
      }
      case 'register.added_from_software': {
        const how = after?.mode && after?.amountPaise != null ? `${MODE[after.mode] ?? after.mode} ${rs(after.amountPaise)}` : '';
        it.text = `Added to the register from the software report${how ? `, paid by ${how}` : ''}`;
        it.key = `r:${a.rowId}`;
        if (reg.has(a.rowId)) it.undo = { method: 'DELETE', path: `/register-rows/${a.rowId}`, body: { reason: 'other', note: 'Undo: added from the software report by mistake' } };
        break;
      }
      case 'register.delete':
        it.text = `Register line removed${before?.amountPaise != null ? ` (${rs(before.amountPaise)})` : ''}`;
        if (after?.note) it.sub = after.note;
        break;
      case 'shift.choice': case 'shift.choice_undone': {
        const x = a.action === 'shift.choice' ? after : before;
        const bills = billsOf(x?.comparisonIds);
        it.bill = bills;
        const what = x?.card ? 'A card machine payment' : credit(a.rowId);
        it.text = a.action === 'shift.choice' ? `${what} picked for the bill · on save` : `${what}: pick taken off`;
        it.key = `b:${a.rowId}`;
        const kid = choiceOf.get(a.rowId);
        if (a.action === 'shift.choice') it.undo = kid ? { method: 'DELETE', path: `/shifts/${day}/choices/${kid}` } : undefined;
        if (a.action === 'shift.choice' && !kid) it.stale = true;
        break;
      }
      case 'bank.same_sale_planned': case 'bank.same_sale_unplanned': {
        it.bill = cmp.get(after?.comparisonId)?.billNo ?? null;
        it.text = a.action === 'bank.same_sale_planned' ? `${credit(a.rowId)} is the same sale as the bill · on save` : `${credit(a.rowId)}: same sale taken off`;
        it.key = `b:${a.rowId}`;
        if (a.action === 'bank.same_sale_planned' && after?.comparisonId) it.undo = { method: 'DELETE', path: `/comparisons/${after.comparisonId}/same-sale`, body: { rowId: a.rowId } };
        break;
      }
      case 'bank.book': case 'bank.ignore': case 'bank.reopen': {
        const b = bank.get(a.rowId);
        it.text = a.action === 'bank.book' ? `${credit(a.rowId)} booked as ${b?.headName ?? 'income'}, no bill`
          : a.action === 'bank.ignore' ? `${credit(a.rowId)} set aside (not a sale)` : `${credit(a.rowId)} opened again`;
        if (after?.note) it.sub = after.note;
        it.key = `b:${a.rowId}`;
        if (a.action !== 'bank.reopen') {
          it.undo = { method: 'POST', path: `/bank-rows/${a.rowId}/reopen` };
          if (b && b.status !== (a.action === 'bank.book' ? 'booked' : 'ignored')) it.stale = true;
        }
        break;
      }
      case 'bill.complimentary':
        it.text = after?.changes ?? `Made complimentary${after?.guestName ? `: ${after.guestName}` : ''}`;
        it.key = `comp:${a.rowId}`;
        it.undo = { method: 'DELETE', path: `/comparisons/${a.rowId}/complimentary` };
        break;
      case 'bill.complimentary_undone':
        it.text = after?.changes ?? LABEL[a.action];
        it.key = `comp:${a.rowId}`;
        break;
      case 'bill.paid_by': case 'bill.paid_by_undone':
        it.text = after?.changes ?? (a.action === 'bill.paid_by' ? `Paid by ${MODE[after?.mode] ?? after?.mode ?? 'another mode'}` : LABEL[a.action]);
        it.key = `pb:${a.rowId}`;
        if (a.action === 'bill.paid_by') it.undo = { method: 'POST', path: `/comparisons/${a.rowId}/paid-by/undo` };
        break;
      default:
        if (after?.changes) it.text = after.changes;
        if (a.rowTable === 'transactions' && after?.amountPaise != null) it.text += ` · ${rs(after.amountPaise)}`;
        if (after?.billNo && !it.bill) it.bill = after.billNo;
        if (a.action === 'comparison.decision_cleared') it.key = `c:${a.rowId}`;
        if (after?.note && typeof after.note === 'string') it.sub = after.note;
    }
    items.push(it);
  }

  // A register edit put straight back (the pair cancels out) is shown once, with nothing to undo.
  const lastEdit = new Map<string, Item>();
  const fold: Item[] = [];
  for (const it of items) {
    if (it.action !== 'register.edit' || it.auto) continue;
    const a = audits.find((x) => x.id === it.id)!;
    const prev = lastEdit.get(it.key!);
    lastEdit.set(it.key!, it);
    if (!prev || prev.state === 'folded' || prev.userId !== it.userId) continue;
    const pa = audits.find((x) => x.id === prev.id)!;
    const pb = json(pa.before); const ca = json(a.after);
    const st = pb?.status != null && ca?.status != null;
    if (rowKey(pb, st) !== rowKey(ca, st)) continue;
    prev.state = 'folded'; it.state = 'folded';
    const twin = fold.at(-1);
    if (twin && twin.key === it.key && twin.text === `${prev.text}, then put back`) { twin.times = (twin.times ?? 1) + 1; twin.at = it.at; }
    else fold.push({ ...prev, id: it.id, at: it.at, text: `${prev.text}, then put back`, state: 'none', times: 1, undo: undefined, sub: 'Each pair cancels out: nothing to undo' });
    lastEdit.delete(it.key!);
  }

  // Only the latest change to a bill, line or credit is undone; the others wait for it. A saved shift is reopened first.
  const saved = shift?.status === 'confirmed';
  const latest = new Map<string, Item>();
  for (const it of items) if (it.key && it.state !== 'folded' && !it.auto) latest.set(it.key, it);
  for (const it of items) {
    if (it.state === 'folded') continue;
    if (!it.undo && !(it.action === 'shift.choice' && it.stale)) { it.undo = undefined; continue; }
    if (it.auto) { it.undo = undefined; continue; }
    if (latest.get(it.key ?? '') !== it) { it.state = 'later'; it.undo = undefined; continue; }
    if (it.stale) { it.state = 'gone'; it.undo = undefined; continue; }
    if (saved) { it.state = 'saved'; it.undo = undefined; continue; }
    it.state = 'undo';
  }
  // A person's decision that Bookr cleared later (the register or the report changed) says so.
  const clearedAfter = new Set<string>();
  for (const it of [...items].reverse()) {
    if (it.action === 'comparison.decision_cleared' && it.key) clearedAfter.add(it.key);
    if (it.action === 'comparison.decide' && it.key) {
      if (it.state === 'gone' && clearedAfter.has(it.key)) it.sub = `Cleared by Bookr later: the register or software report changed${it.sub ? ` · ${it.sub}` : ''}`;
      clearedAfter.delete(it.key);
    }
  }
  const out = [...items.filter((x) => x.state !== 'folded'), ...fold].map(({ stale: _s, ...x }) => x).sort((x, y) => y.at - x.at || y.id - x.id);
  return c.json({ day, saved, items: out.map(({ key: _k, ...x }) => x) });
});
