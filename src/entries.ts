// Reconcile's three tabs (approved 9 Nov 2026): every bill of a shift under the mode it was paid by (Cash, UPI, Card),
// with what the register and the software say, what backs it (a bank credit, a machine payment, the cash count), what is
// left to do, and every change made to it shown as before → after: the register as read against as corrected, the side
// chosen when the two differ, and a mode changed later ("paid another way"). Read only: it changes nothing.

import { all, type DB } from './db';
import { repaidFor } from './repay';
import { machineLabel } from './cards';
import { shiftView } from './sales';

type Mode = 'cash' | 'upi' | 'card';
export interface Entry {
  key: string; comparisonId: string; billNo: string; paidAt: number | null; mode: Mode; amountPaise: number;
  register: { amountPaise: number | null; mode: string | null } | null; software: { amountPaise: number | null; mode: string | null } | null;
  /** decide: a difference waiting for a person; waiting: no bank credit or machine payment yet; done: backed, counted or closed. */
  state: 'decide' | 'waiting' | 'done';
  evidence: string | null;
  edits: { text: string; by: string | null; at: number | null }[];
  rowId: string | null; uploadId: string | null; transactionId: string | null; part: string | null;
}

const rs = (p: number | null | undefined) => (p == null ? '—' : `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 })}`);
const hm = (ms: number) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(ms));
const MODE: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', mixed: 'Mixed', unknown: 'No mode' };
const modeName = (m: string | null | undefined) => (m ? MODE[m] ?? m : 'No mode');
const paise = (s: unknown) => {
  if (typeof s === 'number') return Math.round(s * 100);
  if (typeof s !== 'string') return null;
  const n = Number(s.replace(/[,₹\s]/g, ''));
  return Number.isFinite(n) && s.trim() !== '' ? Math.round(n * 100) : null;
};

const DIFF: Record<string, string> = {
  missing_in_register: 'Missing in the register', missing_in_software: 'Missing in the software', amount: 'Amount differs', mode: 'Mode differs',
  amount_and_mode: 'Amount and mode differ', complimentary: 'Complimentary in the software',
};
const DECISION: Record<string, string> = { use_register: 'used the register', use_software: 'used the software', leave_out: 'left out', carry_forward: 'carried forward' };

export async function shiftEntries(db: DB, businessId: string, day: string) {
  const view = await shiftView(db, businessId, day);
  const confirmed = view.status === 'confirmed';
  const [rows, pays, txs, matches, repaid, deciders] = await Promise.all([
    all<{ id: string; bill_no: string; amount_paise: number; ocr_original: string | null; edited_at: number | null; editor: string | null; paid_with_row_id: string | null }>(db, `
      SELECT r.id, r.bill_no, r.amount_paise, r.ocr_original, r.edited_at, u.name AS editor, r.paid_with_row_id FROM register_rows r LEFT JOIN users u ON u.id = r.edited_by
      WHERE r.business_id = ? AND r.shift_day = ?`, businessId, day),
    all<{ register_row_id: string; mode: string; amount_paise: number }>(db, `SELECT p.register_row_id, p.mode, p.amount_paise FROM register_payments p
      JOIN register_rows r ON r.id = p.register_row_id WHERE r.business_id = ? AND r.shift_day = ? ORDER BY p.created_at, p.id`, businessId, day),
    confirmed ? all<{ id: string; comparison_id: string | null; amount_paise: number; payment_mode: Mode; match_status: string | null; matched_bank_row: string | null;
      posted_at: number | null; account: string | null; closed: number }>(db, `
      SELECT t.id, t.comparison_id, t.amount_paise, t.payment_mode, t.match_status, t.matched_bank_row, b.posted_at, a.name AS account,
        EXISTS (SELECT 1 FROM closed_bills k WHERE k.transaction_id = t.id) AS closed
      FROM transactions t LEFT JOIN bank_rows b ON b.id = t.matched_bank_row LEFT JOIN accounts a ON a.id = b.account_id
      WHERE t.business_id = ? AND t.shift_day = ? AND t.type = 'income' AND t.source = 'software_report'`, businessId, day) : Promise.resolve([]),
    confirmed ? all<{ transaction_id: string; paid_at: number; scheme: string | null; card_type: string | null; card_last4: string | null; amount_paise: number }>(db, `
      SELECT m.transaction_id, s.paid_at, s.scheme, s.card_type, s.card_last4, s.amount_paise FROM card_matches m JOIN card_settlements s ON s.id = m.settlement_id
      JOIN transactions t ON t.id = m.transaction_id WHERE m.business_id = ? AND t.shift_day = ?`, businessId, day) : Promise.resolve([]),
    repaidFor(db, businessId, day),
    all<{ row_id: string; name: string | null; created_at: number }>(db, `SELECT a.row_id, u.name, a.created_at FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.business_id = ? AND a.action = 'comparison.decide' AND a.row_table = 'bill_comparisons' ORDER BY a.id`, businessId),
  ]);
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  const paysOf = (id: string) => pays.filter((p) => p.register_row_id === id);
  const decidedBy = new Map(deciders.map((d) => [d.row_id, d]));
  const repaidOf = new Map<string, { from: string; mode: string; note: string | null; at: number }>();
  for (const a of repaid) {
    const x = JSON.parse(a.after) as { from: string; mode: string; note: string | null; transactionIds: string[] };
    for (const id of x.transactionIds ?? []) if (!repaidOf.has(id)) repaidOf.set(id, { from: x.from, mode: x.mode, note: x.note, at: a.created_at });
  }

  // What changed on a bill: the register as read → as it is now, the side chosen, a mode changed later.
  const editsOf = (c: (typeof view.comparisons)[number]) => {
    const out: Entry['edits'] = [];
    const r = c.register?.rowId ? rowOf.get(c.register.rowId as string) : undefined;
    if (r?.ocr_original) {
      try {
        const read = (JSON.parse(r.ocr_original) as { read?: { bill_no?: string | null; amount?: unknown; payments?: { mode: string; amount: unknown }[] } }).read;
        if (read) {
          if (read.bill_no != null && read.bill_no !== r.bill_no) out.push({ text: `Bill no. read ${read.bill_no} → ${r.bill_no}`, by: r.editor, at: r.edited_at });
          const amt = paise(read.amount);
          if (amt != null && amt !== r.amount_paise) out.push({ text: `Amount read ${rs(amt)} → ${rs(r.amount_paise)}`, by: r.editor, at: r.edited_at });
          const readModes = [...new Set((read.payments ?? []).filter((p) => paise(p.amount)).map((p) => p.mode))].sort().join(' + ');
          const nowModes = [...new Set(paysOf(r.id).map((p) => p.mode))].sort().join(' + ');
          if (readModes && nowModes && readModes !== nowModes) out.push({ text: `Paid by read ${readModes.split(' + ').map(modeName).join(' + ')} → ${nowModes.split(' + ').map(modeName).join(' + ')}`, by: r.editor, at: r.edited_at });
        }
      } catch { /* an old reading in another shape: nothing to compare */ }
    }
    if (c.difference !== 'match') {
      const what = c.difference === 'amount' || c.difference === 'amount_and_mode'
        ? `${DIFF[c.difference]} (register ${rs(c.register?.amountPaise as number)} ${modeName(c.register?.mode as string)} · software ${rs(c.software?.amountPaise as number)} ${modeName(c.software?.mode as string)})`
        : c.difference === 'mode' ? `Mode differs (register ${modeName(c.register?.mode as string)} · software ${modeName(c.software?.mode as string)})` : DIFF[c.difference] ?? c.difference;
      const d = decidedBy.get(c.id);
      out.push({ text: c.decision ? `${what} → ${DECISION[c.decision] ?? c.decision}${c.note ? ` (${c.note})` : ''}` : `${what}: to decide`,
        by: c.decision ? (c.auto ? 'Bookr' : d?.name ?? null) : null, at: c.decision ? d?.created_at ?? null : null });
    }
    return out;
  };

  const entries: Entry[] = [];
  for (const c of view.comparisons) {
    if (c.decision === 'leave_out' || c.decision === 'carry_forward') continue;
    const base = { comparisonId: c.id, billNo: c.billNo, paidAt: c.paidAt as number | null, rowId: (c.register?.rowId as string) ?? null, uploadId: (c.register?.uploadId as string) ?? null,
      register: c.register ? { amountPaise: c.register.amountPaise as number | null, mode: c.register.mode as string | null } : null,
      software: c.software ? { amountPaise: c.software.amountPaise as number | null, mode: c.software.mode as string | null } : null };
    const edits = editsOf(c);
    if (confirmed) {
      const mine = txs.filter((t) => t.comparison_id === c.id);
      mine.forEach((t, i) => {
        const card = matches.filter((m) => m.transaction_id === t.id);
        const rp = repaidOf.get(t.id);
        const e = [...edits, ...(rp ? [{ text: `${modeName(rp.from)} → ${modeName(rp.mode)}${rp.note ? ` (${rp.note})` : ''}`, by: null, at: rp.at }] : [])];
        const evidence = t.payment_mode === 'upi' ? (t.matched_bank_row ? `Bank ${rs(t.amount_paise)} at ${t.posted_at ? hm(t.posted_at) : '—'}${t.account ? ` · ${t.account}` : ''}` : t.closed ? 'Closed: no credit came' : null)
          : t.payment_mode === 'card' ? (card.length ? card.map((m) => `${machineLabel(m)} ${rs(m.amount_paise)} at ${hm(m.paid_at)}`).join(' + ') : null)
          : 'In the cash count';
        const waiting = (t.payment_mode === 'upi' && !t.matched_bank_row && !t.closed) || (t.payment_mode === 'card' && t.match_status === 'awaiting_card_settlement');
        entries.push({ ...base, key: t.id, mode: t.payment_mode, amountPaise: t.amount_paise, state: waiting ? 'waiting' : 'done', evidence, edits: e, transactionId: t.id,
          part: mine.length > 1 ? `part ${i + 1} of ${mine.length}` : null });
      });
      continue;
    }
    // Not saved yet: the side that counts (decided, matching, or the one that says how it was paid), its payments by mode.
    const decided = c.decision === 'use_software' ? 'software' : c.decision === 'use_register' || c.difference === 'match' ? 'register' : null;
    const open = !decided && c.difference !== 'match';
    const side = decided ?? (c.register ? 'register' : 'software');
    let parts: { mode: Mode; amount: number }[] = [];
    if (side === 'register' && c.register?.rowId) {
      const r = rowOf.get(c.register.rowId as string);
      const ps = paysOf(r?.paid_with_row_id ? '' : (c.register.rowId as string)).filter((p) => p.amount_paise > 0);
      parts = ps.length ? ps.map((p) => ({ mode: p.mode as Mode, amount: p.amount_paise })) : [];
      if (!parts.length && ['cash', 'upi', 'card'].includes(c.register.mode as string)) parts = [{ mode: c.register.mode as Mode, amount: c.register.amountPaise as number }];
    } else if (c.software && ['cash', 'upi', 'card'].includes(c.software.mode as string)) parts = [{ mode: c.software.mode as Mode, amount: c.software.amountPaise as number }];
    if (!parts.length) parts = [{ mode: 'cash', amount: (c.register?.amountPaise ?? c.software?.amountPaise ?? 0) as number }];
    parts.forEach((p, i) => {
      const evidence = p.mode === 'upi' ? (c.bank ? `Bank ${rs(c.bank.amountPaise)} at ${hm(c.bank.postedAt)}` : null)
        : p.mode === 'card' ? (c.machine ? `${c.machine.label} ${rs(c.machine.amountPaise)} at ${hm(c.machine.paidAt)}` : null) : 'In the cash count';
      entries.push({ ...base, key: `${c.id}:${i}`, mode: p.mode, amountPaise: p.amount, state: open ? 'decide' : p.mode === 'cash' || evidence ? 'done' : 'waiting', evidence, edits,
        transactionId: null, part: parts.length > 1 ? `part ${i + 1} of ${parts.length}` : null });
    });
  }
  entries.sort((a, b) => (a.paidAt ?? Number.MAX_SAFE_INTEGER) - (b.paidAt ?? Number.MAX_SAFE_INTEGER) || a.billNo.localeCompare(b.billNo));
  const tab = (m: Mode) => {
    const list = entries.filter((e) => e.mode === m);
    return { entries: list, left: list.filter((e) => e.state !== 'done').length, totalPaise: list.reduce((t, e) => t + e.amountPaise, 0) };
  };
  return { day, confirmed, cash: tab('cash'), upi: tab('upi'), card: tab('card') };
}
