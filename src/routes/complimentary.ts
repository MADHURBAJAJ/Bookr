// Complimentary bills (approved 14 Nov 2026): the Complimentary tab of Payments, a bill made complimentary with the
// guest's name, and a complimentary or PREPAID bill changed to Cash, UPI or Card. All undoable and audited.
import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all, isShiftConfirmed, newId, now, one, stmt, type DB } from '../db';
import { body, fail, isUuid, text } from '../http';
import { complimentaryMarks, isPrepaid, NEEDS_DECISION, refreshComparisons } from '../sales';
import { shiftCredits } from '../bankEvidence';
import { isMachineUpi, machineLabel } from '../cards';
import { can } from '../permissions';

export const complimentaryRoutes = new Hono<AppEnv>();
const CONFIRMED = 'This shift is saved. An Owner must reopen it first.';
const MODE_WORD: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card' };
const rs = (p: number) => `₹${Math.trunc(p / 100).toLocaleString('en-IN')}${p % 100 ? `.${String(p % 100).padStart(2, '0')}` : ''}`;

interface Cmp { id: string; shift_day: string; bill_no: string; pos_no: string; difference: string; decision: string | null; software_bill_id: string | null; register_row_id: string | null; sw_amount_paise: number | null; sw_mode: string | null }
async function comparison(db: DB, bid: string, id: string) {
  if (!isUuid(id)) fail(404, 'Bill not found.');
  const c = await one<Cmp>(db, `SELECT id, shift_day, bill_no, pos_no, difference, decision, software_bill_id, register_row_id, sw_amount_paise, sw_mode
    FROM bill_comparisons WHERE id = ? AND business_id = ?`, id, bid);
  if (!c) fail(404, 'Bill not found.');
  const s = await one<{ status: string }>(db, 'SELECT status FROM shifts WHERE business_id = ? AND shift_day = ?', bid, c.shift_day);
  if (s?.status === 'confirmed') fail(409, CONFIRMED);
  return c;
}

/** The tab: every complimentary bill of the shift, and PREPAID or ₹0 bills that need a look. */
complimentaryRoutes.get('/businesses/:businessId/shifts/:day/complimentary', requireRole('sales.view'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const day = c.req.param('day');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(404, 'Shift not found.');
  const [rows, marks] = await Promise.all([all<{ id: string; bill_no: string; difference: string; decision: string | null; sw_amount_paise: number | null; sw_mode: string | null; paid_at: number | null; mode_text: string | null; name: string | null;
    row_id: string | null; upload_id: string | null; rg_amount: number | null; rg_discount: number | null; remarks: string | null; paid_with: string | null; paid: number; modes: string | null }>(db, `
    SELECT c.id, c.bill_no, c.difference, c.decision, c.sw_amount_paise, c.sw_mode, s.paid_at, s.mode_text, s.customer_name AS name, r.id AS row_id, r.upload_id, r.amount_paise AS rg_amount,
      r.discount_paise - r.tip_paise AS rg_discount, r.remarks, r.paid_with_row_id AS paid_with,
      coalesce((SELECT sum(p.amount_paise) FROM register_payments p WHERE p.register_row_id = r.id), 0) AS paid,
      (SELECT group_concat(DISTINCT p.mode) FROM register_payments p WHERE p.register_row_id = r.id) AS modes
    FROM bill_comparisons c LEFT JOIN software_bills s ON s.id = c.software_bill_id LEFT JOIN register_rows r ON r.id = c.register_row_id
    WHERE c.business_id = ? AND c.shift_day = ? ORDER BY c.bill_no`, bid, day), complimentaryMarks(db, bid, day)]);
  const lines = rows.flatMap((r) => {
    const prepaid = isPrepaid(r.mode_text);
    const mark = marks.get(r.bill_no);
    const comp = r.difference === 'complimentary';
    // U/N in the software and not in the register (approved 14 Nov 2026): nobody knows how it was paid, so a person says:
    // paid by Cash, UPI or Card, complimentary, or left out.
    if (r.difference === 'missing_in_register' && r.sw_mode === 'unknown' && !r.decision && !prepaid && !mark) {
      return [{
        comparisonId: r.id, billNo: r.bill_no, why: 'unknown', status: 'look', paidAt: r.paid_at,
        look: 'The software report does not say how it was paid, and the register does not have it: say how it was paid, make it complimentary, or leave it out',
        valuePaise: r.sw_amount_paise, modeText: r.mode_text, name: r.name, remarks: null, guestName: null, markedBy: null, markedAt: null,
        registerPaidPaise: null, rowId: null, uploadId: null, decision: r.decision, hint: null as null | { mode: string; text: string },
      }];
    }
    if (!comp && !prepaid) return [];
    // Paid with another row whose group is over ₹0: paid with its group, not complimentary.
    if (comp && !prepaid && !mark && r.paid_with) return [];
    const why = mark ? 'marked' : prepaid ? 'prepaid' : 'zero';
    const look = !comp ? `PREPAID in the software, but the register shows ${r.modes ? r.modes.split(',').map((m) => MODE_WORD[m] ?? m).join(' + ') : ''} ${rs(r.paid)} paid`
      : r.paid > 0 ? `Complimentary, but the register shows ${rs(r.paid)} paid on its row`
      : !r.row_id && prepaid && !mark ? 'PREPAID in the software, not in the register: confirm it with the guest\'s name' : null;
    return [{
      comparisonId: r.id, billNo: r.bill_no, why, status: look ? 'look' : 'ok', look,
      valuePaise: r.sw_amount_paise || (r.rg_amount ?? 0) || null, modeText: r.mode_text, name: r.name, remarks: r.remarks,
      guestName: mark?.guest_name ?? null, markedBy: mark?.user ?? null, markedAt: mark?.marked_at ?? null,
      registerPaidPaise: r.row_id ? r.paid : null, rowId: r.row_id, uploadId: r.upload_id, decision: r.decision, paidAt: r.paid_at, hint: null as null | { mode: string; text: string },
    }];
  });
  // A payment of the same amount near the bill's time, each used once, closest first: shown as a hint, never applied by
  // itself. The bank and the card machine are shown only to people who can match them.
  const unknown = lines.filter((l): l is typeof l & { paidAt: number; valuePaise: number } => l.why === 'unknown' && !!l.valuePaise && l.paidAt != null);
  if (unknown.length && can(c.get('role'), 'bank.link')) {
    const near = 60 * 60000;
    const [credits, cards] = await Promise.all([shiftCredits(db, bid, day), all<{ id: string; amount_paise: number; paid_at: number; scheme: string | null; card_type: string | null; card_last4: string | null; pay_mode: string | null }>(db, `
      SELECT s.id, s.amount_paise, s.paid_at, s.scheme, s.card_type, s.card_last4, s.pay_mode FROM card_settlements s WHERE s.business_id = ? AND s.txn_type = 'PURCHASE'
        AND s.paid_at >= ? AND s.paid_at < ? AND NOT EXISTS (SELECT 1 FROM card_matches m WHERE m.settlement_id = s.id)`,
      bid, Math.min(...unknown.map((l) => l.paidAt)) - near, Math.max(...unknown.map((l) => l.paidAt)) + near)]);
    const time = (ms: number) => new Date(ms + 5.5 * 3600e3).toISOString().slice(11, 16);
    const options = unknown.flatMap((l) => [
      ...credits.filter((x) => x.amount === l.valuePaise && Math.abs(x.postedAt - l.paidAt) <= near)
        .map((x) => ({ l, id: `b${x.id}`, gap: Math.abs(x.postedAt - l.paidAt), mode: 'upi', text: `UPI credit of ${rs(x.amount)} in the bank at ${time(x.postedAt)}${x.label ? ` (${x.label})` : ''}` })),
      ...cards.filter((p) => p.amount_paise === l.valuePaise && Math.abs(p.paid_at - l.paidAt) <= near)
        .map((p) => ({ l, id: `c${p.id}`, gap: Math.abs(p.paid_at - l.paidAt), mode: isMachineUpi(p) ? 'upi' : 'card', text: `${machineLabel(p)} payment of ${rs(p.amount_paise)} on the card machine at ${time(p.paid_at)}` })),
    ]).sort((a, b) => a.gap - b.gap);
    const used = new Set<string>();
    for (const o of options) {
      if (used.has(o.id) || o.l.hint) continue;
      used.add(o.id);
      o.l.hint = { mode: o.mode, text: `${o.text}, ${Math.round(o.gap / 60000)} min from the bill` };
    }
  }
  return c.json({ day, lines, valuePaise: lines.filter((l) => l.status === 'ok').reduce((t, l) => t + (l.valuePaise ?? 0), 0) });
});

/** Make a bill complimentary: the guest's name is asked (approved 14 Nov 2026). Also records the guest on a PREPAID or ₹0 bill. */
complimentaryRoutes.post('/businesses/:businessId/comparisons/:id/complimentary', requireRole('sales.decide'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const cmp = await comparison(db, bid, c.req.param('id'));
  const guest = text(await body(c), 'guestName', 'Guest name', { max: 120 })!;
  const user = c.get('user').id;
  const t = now();
  const old = await one<{ guest_name: string }>(db, 'SELECT guest_name FROM complimentary_marks WHERE business_id = ? AND shift_day = ? AND bill_no = ?', bid, cmp.shift_day, cmp.bill_no);
  try {
    await db.batch([
      stmt(db, `INSERT INTO complimentary_marks (id, business_id, shift_day, bill_no, guest_name, marked_by, marked_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (business_id, shift_day, bill_no) DO UPDATE SET guest_name = excluded.guest_name, marked_by = excluded.marked_by, marked_at = excluded.marked_at`,
        newId(), bid, cmp.shift_day, cmp.bill_no, guest, user, t),
      stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'bill.complimentary', 'bill_comparisons', ?, ?, ?, ?)`,
        bid, user, cmp.id, JSON.stringify({ difference: cmp.difference, decision: cmp.decision, guestName: old?.guest_name ?? null }),
        JSON.stringify({ guestName: guest, changes: `Made complimentary: ${guest}` }), t),
    ]);
  } catch (e) { if (isShiftConfirmed(e)) fail(409, CONFIRMED); throw e; }
  await refreshComparisons(db, bid, cmp.shift_day, user);
  return c.json({ ok: true });
});

complimentaryRoutes.delete('/businesses/:businessId/comparisons/:id/complimentary', requireRole('sales.decide'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const cmp = await comparison(db, bid, c.req.param('id'));
  const old = await one<{ guest_name: string }>(db, 'SELECT guest_name FROM complimentary_marks WHERE business_id = ? AND shift_day = ? AND bill_no = ?', bid, cmp.shift_day, cmp.bill_no);
  if (!old) fail(400, `Bill ${cmp.bill_no} was not made complimentary by a person.`);
  const user = c.get('user').id;
  await db.batch([
    stmt(db, 'DELETE FROM complimentary_marks WHERE business_id = ? AND shift_day = ? AND bill_no = ?', bid, cmp.shift_day, cmp.bill_no),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'bill.complimentary_undone', 'bill_comparisons', ?, ?, ?, ?)`,
      bid, user, cmp.id, JSON.stringify({ guestName: old.guest_name }), JSON.stringify({ changes: `No longer complimentary (was ${old.guest_name})` }), now()),
  ]);
  await refreshComparisons(db, bid, cmp.shift_day, user);
  return c.json({ ok: true });
});

/**
 * A complimentary or PREPAID bill that was paid after all: Cash, UPI or Card. The register line takes one payment of that
 * mode for the bill (a line is added on "Added from software report" when the register has none), the person's
 * complimentary mark goes, and the bill is counted from the register. Undo puts everything back.
 */
complimentaryRoutes.post('/businesses/:businessId/comparisons/:id/paid-by', requireRole('sales.decide'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const cmp = await comparison(db, bid, c.req.param('id'));
  const data = await body(c);
  const mode = data.mode === 'cash' || data.mode === 'upi' || data.mode === 'card' ? data.mode : fail(400, 'Mode must be cash, UPI or card.');
  const user = c.get('user').id;
  const t = now();
  const mark = await one<Record<string, unknown>>(db, 'SELECT * FROM complimentary_marks WHERE business_id = ? AND shift_day = ? AND bill_no = ?', bid, cmp.shift_day, cmp.bill_no);
  const row = cmp.register_row_id ? await one<Record<string, unknown> & { id: string; amount_paise: number; discount_paise: number; tip_paise: number; paid_with_row_id: string | null; bill_type: string | null }>(db,
    'SELECT * FROM register_rows WHERE id = ?', cmp.register_row_id) : null;
  if (row?.paid_with_row_id) fail(400, `Bill ${cmp.bill_no} is paid together with another bill: change the payment on that bill's line.`);
  const pays = row ? await all<Record<string, unknown>>(db, 'SELECT * FROM register_payments WHERE register_row_id = ?', row.id) : [];
  const amount = row && row.amount_paise ? row.amount_paise : cmp.sw_amount_paise ?? 0;
  if (!amount) fail(400, `Bill ${cmp.bill_no} is ₹0 on both sides: correct its amount on the register first.`);
  const net = row ? amount - row.discount_paise + row.tip_paise : amount;
  const word = MODE_WORD[mode];
  const label = mode === 'cash' ? 'CASH' : mode === 'card' ? 'Card' : 'UPI';
  const statements: D1PreparedStatement[] = [];
  let addedRowId: string | null = null;
  if (row) {
    statements.push(stmt(db, 'UPDATE register_rows SET amount_paise = ?, edited_by = ?, edited_at = ? WHERE id = ?', amount, user, t, row.id),
      stmt(db, 'DELETE FROM register_payments WHERE register_row_id = ?', row.id),
      stmt(db, 'INSERT INTO register_payments (id, business_id, register_row_id, mode, column_label, amount_paise, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', newId(), bid, row.id, mode, label, net, t));
  } else {
    const key = `software-added:${cmp.shift_day}`;
    const have = await one<{ id: string }>(db, 'SELECT id FROM uploads WHERE business_id = ? AND content_sha256 = ?', bid, key);
    const pageId = have?.id ?? newId();
    if (!have) statements.push(stmt(db, `INSERT INTO uploads (id, business_id, kind, business_day, storage_key, content_sha256, status, ocr_engine, uploaded_by, created_at)
      VALUES (?, ?, 'bill_register', ?, ?, ?, 'ready', 'manual', ?, ?)`, pageId, bid, cmp.shift_day, `software-added/${cmp.shift_day}`, key, user, t));
    const line = have ? ((await one<{ n: number }>(db, 'SELECT coalesce(max(line_no), 0) + 1 AS n FROM register_rows WHERE upload_id = ?', pageId))?.n ?? 1) : 1;
    addedRowId = newId();
    statements.push(stmt(db, `INSERT INTO register_rows (id, business_id, upload_id, line_no, shift_day, bill_no, bill_type, amount_paise, discount_paise, tip_paise, remarks, status, ocr_original, edited_by, edited_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'fnb', ?, 0, 0, ?, 'checked', ?, ?, ?, ?)`, addedRowId, bid, pageId, line, cmp.shift_day, cmp.bill_no, amount,
        `Added from software report: paid by ${word}`, JSON.stringify({ source: 'software_report', typed: 'paid_by', addedBy: user, comparisonId: cmp.id }), user, t, t),
      stmt(db, 'INSERT INTO register_payments (id, business_id, register_row_id, mode, column_label, amount_paise, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', newId(), bid, addedRowId, mode, label, amount, t));
  }
  if (mark) statements.push(stmt(db, 'DELETE FROM complimentary_marks WHERE id = ?', mark.id));
  statements.push(stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'bill.paid_by', 'bill_comparisons', ?, ?, ?, ?)`,
    bid, user, cmp.id, JSON.stringify({ mark, row: row ? { id: row.id, amount_paise: row.amount_paise } : null, pays }),
    JSON.stringify({ mode, addedRowId, rowId: row?.id ?? addedRowId, changes: `Paid by ${word} ${rs(net)}, not complimentary` }), t));
  try { await db.batch(statements); } catch (e) { if (isShiftConfirmed(e)) fail(409, CONFIRMED); throw e; }
  await refreshComparisons(db, bid, cmp.shift_day, user);
  // The software may say PREPAID or another mode: the register, now written, is counted.
  const after = await one<{ id: string; difference: string; decision: string | null }>(db, 'SELECT id, difference, decision FROM bill_comparisons WHERE business_id = ? AND shift_day = ? AND bill_no = ?', bid, cmp.shift_day, cmp.bill_no);
  if (after && NEEDS_DECISION.includes(after.difference as never) && !after.decision) {
    await db.batch([
      stmt(db, "UPDATE bill_comparisons SET decision = 'use_register', decided_by = ?, decided_at = ?, note = ? WHERE id = ?", user, t, `Paid by ${word}`, after.id),
      stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'comparison.decide', 'bill_comparisons', ?, NULL, ?, ?)`,
        bid, user, after.id, JSON.stringify({ decision: 'use_register', note: `Paid by ${word}` }), t),
    ]);
  }
  return c.json({ ok: true });
});

complimentaryRoutes.post('/businesses/:businessId/comparisons/:id/paid-by/undo', requireRole('sales.decide'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const cmp = await comparison(db, bid, c.req.param('id'));
  const a = await one<{ before: string; after: string }>(db, "SELECT before, after FROM audit_log WHERE business_id = ? AND action = 'bill.paid_by' AND row_id = ? ORDER BY id DESC LIMIT 1", bid, cmp.id);
  if (!a) fail(400, 'Nothing to undo.');
  const b = JSON.parse(a.before) as { mark: Record<string, unknown> | null; row: { id: string; amount_paise: number } | null; pays: Record<string, unknown>[] };
  const f = JSON.parse(a.after) as { addedRowId: string | null };
  const user = c.get('user').id;
  const t = now();
  const ins = (table: string, r: Record<string, unknown>) => { const k = Object.keys(r); return stmt(db, `INSERT INTO ${table} (${k.join(', ')}) VALUES (${k.map(() => '?').join(', ')})`, ...k.map((x) => r[x])); };
  const statements: D1PreparedStatement[] = [];
  if (f.addedRowId) statements.push(stmt(db, 'DELETE FROM register_rows WHERE id = ? AND business_id = ?', f.addedRowId, bid));
  if (b.row) {
    statements.push(stmt(db, 'UPDATE register_rows SET amount_paise = ?, edited_by = ?, edited_at = ? WHERE id = ?', b.row.amount_paise, user, t, b.row.id),
      stmt(db, 'DELETE FROM register_payments WHERE register_row_id = ?', b.row.id), ...b.pays.map((p) => ins('register_payments', p)));
  }
  if (b.mark) statements.push(stmt(db, 'DELETE FROM complimentary_marks WHERE business_id = ? AND shift_day = ? AND bill_no = ?', bid, cmp.shift_day, cmp.bill_no), ins('complimentary_marks', b.mark));
  statements.push(stmt(db, "UPDATE bill_comparisons SET decision = NULL, decided_by = NULL, decided_at = NULL, note = NULL WHERE id = ? AND note LIKE 'Paid by %'", cmp.id),
    stmt(db, `INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at) VALUES (?, ?, 'bill.paid_by_undone', 'bill_comparisons', ?, NULL, ?, ?)`,
      bid, user, cmp.id, JSON.stringify({ changes: 'Paid by undone' }), t));
  try { await db.batch(statements); } catch (e) { if (isShiftConfirmed(e)) fail(409, CONFIRMED); throw e; }
  await refreshComparisons(db, bid, cmp.shift_day, user);
  return c.json({ ok: true });
});
