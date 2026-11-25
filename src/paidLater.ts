// Paid later by card or UPI (approved 18 Nov 2026): a bill counted on its day from the software (often as cash) whose
// register line turned up on a later day written as card or UPI. The money never reached that day's drawer: it came on
// the later day, on the card machine or into the bank, sometimes together with a neighbouring bill on the same page.
// Told on the bill's own day with the payment that fits; a person chooses "Paid later by card (or UPI)", which writes
// the bill on that day's "Added from software report" page in the late line's mode. The day then counts it as a card
// (or UPI) sale, and the later day's payment pays it once the day is saved (settled here). Nothing is done by itself.

import { all, type DB } from './db';
import { shiftWindow } from './time';
import { heldCredit } from './plans';

// As cards.ts isMachineUpi; kept here so cash.ts does not import cards.ts (which imports cash.ts).
const machineUpi = (p: { pay_mode: string | null; scheme: string | null }) => (p.pay_mode ? /^upi/i.test(p.pay_mode.trim()) : (p.scheme ?? '').toUpperCase() === 'UPI');

/** Lines either side of the late line that may have been paid together with it. */
export const NEIGHBOUR_LINES = 3;

export interface LateEvidence {
  kind: 'card' | 'upi'; id: string; amountPaise: number; at: number; label: string;
  /** Neighbouring register lines paid with it, besides the bill itself. */
  with: { billNo: string; amountPaise: number }[];
}
export interface LateLine {
  comparisonId: string; billNo: string; swPaise: number; swMode: string | null;
  lineId: string; day: string; amountPaise: number | null; mode: 'card' | 'upi'; rowId: string | null; uploadId: string | null;
  /** Already written on the bill's day (paid later chosen). */
  done: boolean;
  evidence: LateEvidence | null;
}

/** This day's software bills written late, as card or UPI, in a later day's register. */
export async function paidLaterLines(db: DB, businessId: string, day: string): Promise<LateLine[]> {
  const rows = await all<{ cid: string; bill_no: string; sw: number; sw_mode: string | null; line: string; d: string; rg: number | null; mode: 'card' | 'upi';
    row_id: string | null; upload_id: string | null; line_no: number | null; done: number }>(db, `
    SELECT c.id AS cid, c.bill_no, c.sw_amount_paise AS sw, c.sw_mode, x.id AS line, x.shift_day AS d, x.rg_amount_paise AS rg, x.rg_mode AS mode,
      x.register_row_id AS row_id, r.upload_id, r.line_no,
      EXISTS (SELECT 1 FROM register_rows o WHERE o.id = c.register_row_id AND json_extract(o.ocr_original, '$.typed') = 'paid_later') AS done
    FROM bill_comparisons c
    JOIN bill_comparisons x ON x.linked_to_id = c.id AND x.business_id = c.business_id AND x.shift_day > c.shift_day
    LEFT JOIN register_rows r ON r.id = x.register_row_id
    WHERE c.business_id = ? AND c.shift_day = ? AND c.software_bill_id IS NOT NULL AND c.sw_amount_paise IS NOT NULL
      AND x.difference = 'missing_in_software' AND x.rg_mode IN ('card', 'upi')
      AND (c.difference = 'missing_in_register' OR EXISTS (SELECT 1 FROM register_rows o WHERE o.id = c.register_row_id AND json_extract(o.ocr_original, '$.typed') = 'paid_later'))
    ORDER BY c.bill_no`, businessId, day);
  const out: LateLine[] = [];
  for (const r of rows) {
    if (out.some((o) => o.comparisonId === r.cid)) continue;
    const line: LateLine = { comparisonId: r.cid, billNo: r.bill_no, swPaise: r.sw, swMode: r.sw_mode, lineId: r.line, day: r.d, amountPaise: r.rg, mode: r.mode,
      rowId: r.row_id, uploadId: r.upload_id, done: !!r.done, evidence: null };
    if (!line.done && r.mode !== r.sw_mode && r.rg === r.sw) line.evidence = await evidenceFor(db, businessId, { mode: r.mode, day: r.d, amountPaise: r.sw, uploadId: r.upload_id, rowId: r.row_id }, r.line_no);
    out.push(line);
  }
  return out;
}

/** The later day's open payment of the bill's amount, or of the bill and up to two neighbouring lines paid the same way.
 *  Also used on the later day itself, for a bill of a saved earlier shift settled there (18 Nov 2026). */
export async function evidenceFor(db: DB, businessId: string, line: { mode: 'card' | 'upi'; day: string; amountPaise: number; uploadId: string | null; rowId: string | null },
  lineNo: number | null): Promise<LateEvidence | null> {
  const l = { ...line, swPaise: line.amountPaise };
  const w = shiftWindow(l.day);
  const pays = l.mode === 'card'
    ? (await all<{ id: string; amount_paise: number; paid_at: number; txn_type: string; pay_mode: string | null; scheme: string | null; card_last4: string | null }>(db, `
        SELECT s.id, s.amount_paise, s.paid_at, s.txn_type, s.pay_mode, s.scheme, s.card_last4 FROM card_settlements s
        WHERE s.business_id = ? AND s.paid_at >= ? AND s.paid_at < ? AND s.txn_type = 'PURCHASE'
          AND NOT EXISTS (SELECT 1 FROM card_matches m WHERE m.settlement_id = s.id) ORDER BY s.paid_at`, businessId, w.from, w.to))
      .filter((p) => !machineUpi(p)).map((p) => ({ id: p.id, amount: p.amount_paise, at: p.paid_at, label: `Card machine${p.scheme ? ` · ${p.scheme}` : ''}${p.card_last4 ? ` ··${p.card_last4}` : ''}` }))
    : (await all<{ id: string; amount_paise: number; posted_at: number; account: string | null }>(db, `
        SELECT r.id, r.amount_paise, r.posted_at, a.name AS account FROM bank_rows r LEFT JOIN accounts a ON a.id = r.account_id
        WHERE r.business_id = ? AND r.kind = 'upi_in' AND r.direction = 'CR' AND r.status = 'unmatched' AND r.posted_at >= ? AND r.posted_at < ?
          AND NOT ${heldCredit('r.id')} ORDER BY r.posted_at`, businessId, w.from, w.to))
      .map((p) => ({ id: p.id, amount: p.amount_paise, at: p.posted_at, label: `Bank UPI${p.account ? ` · ${p.account}` : ''}` }));
  if (!pays.length) return null;
  const pick = (want: number) => pays.filter((p) => p.amount === want);
  const one = pick(l.swPaise);
  if (one.length === 1) return { kind: l.mode, id: one[0].id, amountPaise: one[0].amount, at: one[0].at, label: one[0].label, with: [] };
  if (one.length > 1 || !l.uploadId || lineNo == null) return null;
  // Paid together with the lines around it on the same page, written the same way.
  const near = await all<{ bill_no: string; paid: number }>(db, `SELECT r.bill_no, (SELECT coalesce(sum(p.amount_paise), 0) FROM register_payments p
      WHERE p.register_row_id = r.id AND p.mode = ?) AS paid
    FROM register_rows r WHERE r.business_id = ? AND r.upload_id = ? AND r.id <> ? AND r.line_no BETWEEN ? AND ? AND r.paid_with_row_id IS NULL`,
    l.mode, businessId, l.uploadId, l.rowId ?? '', lineNo - NEIGHBOUR_LINES, lineNo + NEIGHBOUR_LINES);
  const cands = near.filter((n) => n.paid > 0);
  const sets: { billNo: string; amountPaise: number }[][] = [];
  for (let i = 0; i < cands.length; i++) {
    sets.push([{ billNo: cands[i].bill_no, amountPaise: cands[i].paid }]);
    for (let j = i + 1; j < cands.length; j++) sets.push([{ billNo: cands[i].bill_no, amountPaise: cands[i].paid }, { billNo: cands[j].bill_no, amountPaise: cands[j].paid }]);
  }
  const fits = sets.flatMap((s) => pick(l.swPaise + s.reduce((t, x) => t + x.amountPaise, 0)).map((p) => ({ p, s })));
  // Only one payment and one set of lines: two that fit are left to a person.
  if (fits.length !== 1) return null;
  const { p, s } = fits[0];
  return { kind: l.mode, id: p.id, amountPaise: p.amount, at: p.at, label: p.label, with: s };
}
