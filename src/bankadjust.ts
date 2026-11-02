// Hand match with a difference, treated as a change to the bills (approved 2 Nov 2026): what the bank received is
// what the bills were paid. The difference is shared over the bills (as Fill discounts does), then for each bill:
// register discount/tip, the register payment written for it (or its group), and its income row are set to match.
// Each change is recorded in register_bank_adjustments; the register lock allows only these recorded changes.

import { all, newId, stmt, type DB } from './db';
import { fail } from './http';
import { spreadDifference } from './discounts';

interface Bill { txId: string; netPaise: number; regId: string; gross: number; disc: number; tip: number; groupHead: string; billNo: string | null }
interface Pay { id: string; register_row_id: string; mode: string; amount_paise: number }

export async function adjustStatements(db: DB, businessId: string, bankRowId: string, txIds: string[], bankPaise: number, note: string, userId: string, t: number) {
  const bills = await all<Bill>(db, `
    SELECT t.id AS txId, t.amount_paise AS netPaise, t.bill_no AS billNo, r.id AS regId, r.amount_paise AS gross, r.discount_paise AS disc, r.tip_paise AS tip,
      coalesce(r.paid_with_row_id, r.id) AS groupHead,
      (SELECT count(*) FROM transactions o WHERE o.comparison_id = t.comparison_id AND o.type = 'income') AS incomeRows
    FROM transactions t JOIN bill_comparisons c ON c.id = t.comparison_id JOIN register_rows r ON r.id = c.register_row_id
    WHERE t.business_id = ? AND t.id IN (${txIds.map(() => '?').join(',')}) ORDER BY t.bill_no`, businessId, ...txIds);
  if (bills.length !== txIds.length) fail(400, 'A bill chosen is not in the register, so it cannot be changed. Book the difference under a head instead.');
  if ((bills as (Bill & { incomeRows: number })[]).some((b) => b.incomeRows !== 1)) fail(400, 'A bill chosen was paid in more than one way. Book the difference under a head instead.');
  // Bills paid together are changed together: every bill of a group must be chosen.
  const heads = [...new Set(bills.map((b) => b.groupHead))];
  const members = await all<{ id: string; head: string }>(db, `SELECT id, coalesce(paid_with_row_id, id) AS head FROM register_rows
    WHERE id IN (${heads.map(() => '?').join(',')}) OR paid_with_row_id IN (${heads.map(() => '?').join(',')})`, ...heads, ...heads);
  if (members.some((m) => !bills.find((b) => b.regId === m.id))) fail(400, 'Choose every bill paid together with these, or book the difference under a head.');
  const pays = await all<Pay>(db, `SELECT id, register_row_id, mode, amount_paise FROM register_payments WHERE register_row_id IN (${heads.map(() => '?').join(',')})`, ...heads);
  for (const h of heads) {
    const p = pays.filter((x) => x.register_row_id === h);
    if (p.length !== 1 || p[0].mode !== 'upi') fail(400, 'The register shows more than one payment for these bills. Change it on the register page, or book the difference under a head.');
  }

  // Share the difference over the bills by amount (a tip goes on the first bill), then each bill's new net amount.
  const [first, ...rest] = bills;
  const spread = spreadDifference({ id: first.txId, amountPaise: first.netPaise }, rest.map((b) => ({ id: b.txId, amountPaise: b.netPaise })), bankPaise);
  if (!spread) fail(400, 'The difference is larger than the bills. Check the bills chosen.');
  const statements: D1PreparedStatement[] = [];
  const record = (target: string, id: string, field: string, before: number, after: number) => statements.push(stmt(db, `
    INSERT INTO register_bank_adjustments (id, business_id, bank_row_id, target, target_id, field, before_paise, after_paise, note, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId(), businessId, bankRowId, target, id, field, before, after, note, userId, t));
  const change = new Map<string, number>(); // per group head: how much the payment moves
  const changed: { billNo: string | null; beforePaise: number; afterPaise: number }[] = [];
  for (const b of bills) {
    const s = spread.get(b.txId)!;
    const newNet = b.netPaise - s.discountPaise + s.tipPaise;
    const signed = b.gross - newNet; // positive: discount, negative: tip
    const disc = Math.max(signed, 0);
    const tip = Math.max(-signed, 0);
    record('register_row', b.regId, 'discount_paise', b.disc, disc);
    record('register_row', b.regId, 'tip_paise', b.tip, tip);
    statements.push(stmt(db, 'UPDATE register_rows SET discount_paise = ?, tip_paise = ? WHERE id = ?', disc, tip, b.regId));
    record('transaction', b.txId, 'amount_paise', b.netPaise, newNet);
    statements.push(stmt(db, 'UPDATE transactions SET amount_paise = ? WHERE id = ?', newNet, b.txId));
    change.set(b.groupHead, (change.get(b.groupHead) ?? 0) + (newNet - b.netPaise));
    if (newNet !== b.netPaise) changed.push({ billNo: b.billNo, beforePaise: b.netPaise, afterPaise: newNet });
  }
  for (const [h, delta] of change) {
    const p = pays.find((x) => x.register_row_id === h)!;
    if (!delta) continue;
    record('register_payment', p.id, 'amount_paise', p.amount_paise, p.amount_paise + delta);
    statements.push(stmt(db, 'UPDATE register_payments SET amount_paise = ? WHERE id = ?', p.amount_paise + delta, p.id));
  }
  const nets = new Map(bills.map((b) => { const s = spread.get(b.txId)!; return [b.txId, b.netPaise - s.discountPaise + s.tipPaise]; }));
  return { statements, nets, changed };
}

/** Puts back every change made for these credits, recording the reverse of each. Latest first. */
export async function undoAdjustments(db: DB, businessId: string, bankRowIds: string[], userId: string, t: number) {
  if (!bankRowIds.length) return [];
  const open = await all<{ id: string; target: string; target_id: string; field: string; before_paise: number; after_paise: number; bank_row_id: string }>(db, `
    SELECT a.* FROM register_bank_adjustments a WHERE a.business_id = ? AND a.bank_row_id IN (${bankRowIds.map(() => '?').join(',')})
      AND a.reverses_id IS NULL AND NOT EXISTS (SELECT 1 FROM register_bank_adjustments r WHERE r.reverses_id = a.id)
    ORDER BY a.created_at DESC`, businessId, ...bankRowIds);
  const statements: D1PreparedStatement[] = [];
  for (const a of open) {
    statements.push(stmt(db, `INSERT INTO register_bank_adjustments (id, business_id, bank_row_id, target, target_id, field, before_paise, after_paise, note, reverses_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Unmatched', ?, ?, ?)`, newId(), businessId, a.bank_row_id, a.target, a.target_id, a.field, a.after_paise, a.before_paise, a.id, userId, t));
  }
  // Register rows: discount and tip together (the lock checks both against the recorded change).
  const rows = new Map<string, { disc?: number; tip?: number }>();
  for (const a of open) {
    if (a.target === 'register_row') {
      const r = rows.get(a.target_id) ?? {};
      if (a.field === 'discount_paise') r.disc = a.before_paise; else r.tip = a.before_paise;
      rows.set(a.target_id, r);
    } else if (a.target === 'register_payment') statements.push(stmt(db, 'UPDATE register_payments SET amount_paise = ? WHERE id = ?', a.before_paise, a.target_id));
    else statements.push(stmt(db, 'UPDATE transactions SET amount_paise = ? WHERE id = ?', a.before_paise, a.target_id));
  }
  for (const [id, r] of rows) statements.push(stmt(db, 'UPDATE register_rows SET discount_paise = ?, tip_paise = ? WHERE id = ?', r.disc ?? 0, r.tip ?? 0, id));
  return statements;
}
