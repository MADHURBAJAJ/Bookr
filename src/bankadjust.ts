// Hand match with a difference, treated as a change to the bills (approved 2 Nov 2026): what the bank received is
// what the bills were paid. The difference is shared over the bills (as Fill discounts does), then for each bill:
// register discount/tip, the register payment written for it (or its group), and its income row are set to match.
// Each change is recorded in register_bank_adjustments; the register lock allows only these recorded changes.

import { all, newId, stmt, type DB } from './db';
import { fail } from './http';
import { spreadDifference } from './discounts';

interface Bill { txId: string; netPaise: number; regId: string; gross: number; disc: number; tip: number; groupHead: string; billNo: string | null }
interface Pay { id: string; register_row_id: string; mode: string; amount_paise: number }

export async function adjustStatements(db: DB, businessId: string, bankRowId: string, txIds: string[], bankPaise: number, note: string, userId: string, t: number, creditPaise: number[] = []) {
  // Bills with a register line (changed there too) and bills only in the software report (just their sale line).
  const rows = await all<Bill & { incomeRows: number; upiRows: number; inRegister: number; inGroup: number; comparisonId: string | null }>(db, `
    SELECT t.id AS txId, t.amount_paise AS netPaise, t.bill_no AS billNo, r.id AS regId, r.amount_paise AS gross, r.discount_paise AS disc, r.tip_paise AS tip,
      coalesce(r.paid_with_row_id, r.id) AS groupHead, r.id IS NOT NULL AS inRegister, t.comparison_id AS comparisonId,
      r.paid_with_row_id IS NOT NULL OR EXISTS (SELECT 1 FROM register_rows m WHERE m.paid_with_row_id = r.id) AS inGroup,
      (SELECT count(*) FROM transactions o WHERE o.comparison_id = t.comparison_id AND o.type = 'income') AS incomeRows,
      (SELECT count(*) FROM transactions o WHERE o.comparison_id = t.comparison_id AND o.type = 'income' AND o.payment_mode = 'upi') AS upiRows
    FROM transactions t LEFT JOIN bill_comparisons c ON c.id = t.comparison_id LEFT JOIN register_rows r ON r.id = c.register_row_id
    WHERE t.business_id = ? AND t.id IN (${txIds.map(() => '?').join(',')}) ORDER BY t.bill_no, t.amount_paise`, businessId, ...txIds);
  if (rows.length !== txIds.length) fail(400, 'A bill chosen was not found.');
  // A bill paid by several UPI payments (several sale lines): all its lines are changed together, each with its own payment.
  const multiRows = rows.filter((b) => b.incomeRows > 1);
  for (const b of multiRows) {
    if (b.upiRows !== b.incomeRows) fail(400, `Bill ${b.billNo} was paid partly in cash or card. Correct it on the register page, or book the difference under a head.`);
    if (!b.inRegister || b.inGroup) fail(400, `Bill ${b.billNo} cannot be changed here (paid together with other bills). Correct it on the register page, or book the difference under a head.`);
    if (rows.filter((x) => x.comparisonId === b.comparisonId).length !== b.incomeRows) fail(400, `Tick every UPI payment of bill ${b.billNo} on the right (it was paid in ${b.incomeRows} goes).`);
  }
  const bills = rows.filter((b) => b.inRegister && b.incomeRows === 1);
  // Bills paid together are changed together: every bill of a group must be chosen.
  const heads = [...new Set(bills.map((b) => b.groupHead))];
  const pays = heads.length ? await all<Pay>(db, `SELECT id, register_row_id, mode, amount_paise FROM register_payments WHERE register_row_id IN (${heads.map(() => '?').join(',')})`, ...heads) : [];
  if (heads.length) {
    const members = await all<{ id: string; head: string }>(db, `SELECT id, coalesce(paid_with_row_id, id) AS head FROM register_rows
      WHERE id IN (${heads.map(() => '?').join(',')}) OR paid_with_row_id IN (${heads.map(() => '?').join(',')})`, ...heads, ...heads);
    if (members.some((m) => !bills.find((b) => b.regId === m.id))) fail(400, 'Choose every bill paid together with these, or book the difference under a head.');
    for (const h of heads) {
      const p = pays.filter((x) => x.register_row_id === h);
      if (p.length !== 1 || p[0].mode !== 'upi') fail(400, 'The register shows more than one payment for these bills. Change it on the register page, or book the difference under a head.');
    }
  }

  // New amount for each sale line. One bill paid in several goes, with as many credits ticked: each payment becomes
  // a credit (equal amounts paired first, the rest in order). Otherwise the difference is shared by amount (a tip on the first).
  const newNet = new Map<string, number>();
  const oneBill = new Set(rows.map((b) => b.comparisonId)).size === 1 && multiRows.length > 0;
  if (oneBill && creditPaise.length === rows.length) {
    const credits = [...creditPaise];
    const left: typeof rows = [];
    for (const b of rows) {
      const i = credits.indexOf(b.netPaise);
      if (i >= 0) { newNet.set(b.txId, credits[i]); credits.splice(i, 1); } else left.push(b);
    }
    left.forEach((b, i) => newNet.set(b.txId, credits[i]));
  } else {
    const [first, ...rest] = rows;
    const spread = spreadDifference({ id: first.txId, amountPaise: first.netPaise }, rest.map((b) => ({ id: b.txId, amountPaise: b.netPaise })), bankPaise);
    if (!spread) fail(400, 'The difference is larger than the bills. Check the bills chosen.');
    for (const b of rows) { const x = spread.get(b.txId)!; newNet.set(b.txId, b.netPaise - x.discountPaise + x.tipPaise); }
  }
  const statements: D1PreparedStatement[] = [];
  const record = (target: string, id: string, field: string, before: number, after: number) => statements.push(stmt(db, `
    INSERT INTO register_bank_adjustments (id, business_id, bank_row_id, target, target_id, field, before_paise, after_paise, note, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, newId(), businessId, bankRowId, target, id, field, before, after, note, userId, t));
  const change = new Map<string, number>(); // per group head: how much the payment moves
  const changed: { billNo: string | null; beforePaise: number; afterPaise: number }[] = [];
  const nets = newNet;
  for (const b of rows) {
    const newNet = nets.get(b.txId)!;
    if (b.inRegister && b.incomeRows === 1) {
      const signed = b.gross - newNet; // positive: discount, negative: tip
      const disc = Math.max(signed, 0);
      const tip = Math.max(-signed, 0);
      record('register_row', b.regId, 'discount_paise', b.disc, disc);
      record('register_row', b.regId, 'tip_paise', b.tip, tip);
      statements.push(stmt(db, 'UPDATE register_rows SET discount_paise = ?, tip_paise = ? WHERE id = ?', disc, tip, b.regId));
      change.set(b.groupHead, (change.get(b.groupHead) ?? 0) + (newNet - b.netPaise));
    }
    record('transaction', b.txId, 'amount_paise', b.netPaise, newNet);
    statements.push(stmt(db, 'UPDATE transactions SET amount_paise = ? WHERE id = ?', newNet, b.txId));
    if (newNet !== b.netPaise) changed.push({ billNo: b.billNo, beforePaise: b.netPaise, afterPaise: newNet });
  }
  // Bills paid in several goes: each register payment becomes its line's new amount; discount/tip from the new total.
  for (const cid of new Set(multiRows.map((b) => b.comparisonId))) {
    const lines = rows.filter((b) => b.comparisonId === cid);
    const b = lines[0];
    const regPays = await all<Pay>(db, "SELECT id, register_row_id, mode, amount_paise FROM register_payments WHERE register_row_id = ? AND mode = 'upi' ORDER BY created_at, id", b.regId);
    if (regPays.length !== lines.length) fail(400, `The register's payments for bill ${b.billNo} do not match its sale lines. Correct it on the register page.`);
    const free = [...regPays];
    const total = lines.reduce((t2, l) => t2 + nets.get(l.txId)!, 0);
    const signed = b.gross - total;
    record('register_row', b.regId, 'discount_paise', b.disc, Math.max(signed, 0));
    record('register_row', b.regId, 'tip_paise', b.tip, Math.max(-signed, 0));
    statements.push(stmt(db, 'UPDATE register_rows SET discount_paise = ?, tip_paise = ? WHERE id = ?', Math.max(signed, 0), Math.max(-signed, 0), b.regId));
    for (const l of lines) {
      const i = Math.max(0, free.findIndex((p) => p.amount_paise === l.netPaise));
      const p = free.splice(i, 1)[0];
      const after = nets.get(l.txId)!;
      if (p.amount_paise !== after) {
        record('register_payment', p.id, 'amount_paise', p.amount_paise, after);
        statements.push(stmt(db, 'UPDATE register_payments SET amount_paise = ? WHERE id = ?', after, p.id));
      }
    }
  }
  for (const [h, delta] of change) {
    const p = pays.find((x) => x.register_row_id === h)!;
    if (!delta) continue;
    record('register_payment', p.id, 'amount_paise', p.amount_paise, p.amount_paise + delta);
    statements.push(stmt(db, 'UPDATE register_payments SET amount_paise = ? WHERE id = ?', p.amount_paise + delta, p.id));
  }
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
