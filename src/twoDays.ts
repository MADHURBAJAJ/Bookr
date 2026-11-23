import { all, type DB } from './db';
import { addDays, shiftWindow } from './time';

/**
 * One bill number on two days' registers (approved 23 Nov 2026). The software never prints a number twice, so the two
 * lines are one bill: paid in two parts, an advance, written twice, paid later in cash, or one of them is another bill
 * written with the wrong number. The bill's home is the shift whose software report has it; the other line is the copy.
 */
export type TwoDayKind = 'part_paid' | 'advance' | 'written_twice' | 'wrong_number' | 'paid_later_cash';

export interface Pay { mode: string; amountPaise: number }
export interface TwoDayLine { rowId: string; uploadId: string; lineNo: number; amountPaise: number; discountPaise: number; pays: Pay[]; status: string }
export interface TwoDayHome {
  day: string; comparisonId: string; decision: string | null; confirmed: boolean;
  swAmountPaise: number; swMode: string; paidAt: number | null; line: TwoDayLine;
}
export interface Credit { id: string; postedAt: number; amountPaise: number }
export interface Candidate { billNo: string; amountPaise: number; paidAt: number | null }
export interface TwoDays {
  kind: TwoDayKind;
  home: { day: string; uploadId: string; rowId: string; lineNo: number; pageNo: number; amountPaise: number; paidPaise: number; mode: string | null; status: string;
    swAmountPaise: number; swMode: string; paidAt: number | null; confirmed: boolean;
    /** The UPI credit of the bill's amount closest to its software time, within an hour either side. */
    creditAt: number | null };
  herePaidPaise: number; hereMode: string | null;
  /** This line's day is after the bill's own day (a balance paid later), not before it (an advance). */
  later: boolean;
  /** Money on this line's shift no software bill explains (UPI credits of this line's amount). */
  leftover: Credit[];
  candidates: Candidate[];
  /** A person already said what it is here (advance / settle / close), with Undo. */
  done: 'advance' | 'settle' | 'close' | null;
  /** This line's own comparison: its decision, whether it is closed, and whether its shift is saved. */
  here: { decision: string | null; closed: boolean; confirmed: boolean } | null;
}

/** Rupees either way the two days' payments may differ from the bill: a round-off or a small discount. */
export const TWO_DAY_NEAR = 1000;
const paid = (p: Pay[]) => p.reduce((t, x) => t + x.amountPaise, 0);
const modeOf = (p: Pay[]) => (!p.length ? null : new Set(p.map((x) => x.mode)).size === 1 ? p[0].mode : 'mixed');

/** Which of the five it is. Pure, for tests. */
export function twoDayKind(here: { day: string; pays: Pay[] }, home: TwoDayHome, leftover: Credit[]): TwoDayKind {
  const hp = paid(here.pays);
  const tp = paid(home.line.pays);
  const sw = home.swAmountPaise;
  const near = (a: number, b: number) => Math.abs(a - b) <= TWO_DAY_NEAR;
  if (!hp) return 'written_twice';
  // Each day paid a part, and the parts make the bill.
  if (tp && hp < sw - TWO_DAY_NEAR && tp < sw - TWO_DAY_NEAR && near(hp + tp, sw)) return 'part_paid';
  // The whole bill paid ahead, on an earlier day; the bill's own day has nothing more.
  if (here.day < home.day && !tp && near(hp, sw)) return 'advance';
  // Written as UPI (or card) on the bill's day, the software says cash, and the cash came on a later day.
  const homeMode = modeOf(home.line.pays);
  if (here.day > home.day && home.swMode === 'cash' && homeMode && homeMode !== 'cash' && modeOf(here.pays) === 'cash' && near(hp, sw)) return 'paid_later_cash';
  // Both lines carry the whole bill: one payment written twice, unless this shift has money of its own for it.
  if (leftover.length && modeOf(here.pays) === 'upi') return 'wrong_number';
  return 'written_twice';
}

/**
 * UPI credits on a shift that no software bill explains, of one amount: each software UPI bill of that amount takes the
 * closest free credit from 3 hours before to 1 hour after it was paid, closest pairs first (one payer paying several
 * bills of the same amount, 23 Nov 2026). What is left is money of its own.
 */
export async function leftoverCredits(db: DB, businessId: string, day: string, amountPaise: number): Promise<Credit[]> {
  const w = shiftWindow(day);
  const [credits, bills] = await Promise.all([
    all<{ id: string; posted_at: number }>(db, `SELECT id, posted_at FROM bank_rows WHERE business_id = ? AND kind = 'upi_in' AND direction = 'CR'
      AND status = 'unmatched' AND amount_paise = ? AND posted_at >= ? AND posted_at < ?`, businessId, amountPaise, w.from, w.to),
    all<{ paid_at: number }>(db, "SELECT paid_at FROM software_bills WHERE business_id = ? AND shift_day = ? AND mode = 'upi' AND amount_paise = ?", businessId, day, amountPaise),
  ]);
  const pairs: { c: number; b: number; gap: number }[] = [];
  credits.forEach((c, ci) => bills.forEach((b, bi) => {
    const d = c.posted_at - b.paid_at;
    if (d >= -3 * 3600e3 && d <= 3600e3) pairs.push({ c: ci, b: bi, gap: Math.abs(d) });
  }));
  pairs.sort((x, y) => x.gap - y.gap);
  const usedC = new Set<number>(); const usedB = new Set<number>();
  for (const p of pairs) if (!usedC.has(p.c) && !usedB.has(p.b)) { usedC.add(p.c); usedB.add(p.b); }
  return credits.filter((_, i) => !usedC.has(i)).map((c) => ({ id: c.id, postedAt: c.posted_at, amountPaise }));
}

/**
 * The other day's line for each line of a shift whose bill is in another shift's software report (a week either side)
 * and on that shift's register, with what it is. Lines whose bill is in this shift's own report are not looked at.
 */
export async function twoDaysFor(db: DB, businessId: string, day: string, rows: { id: string; billNo: string; pays: Pay[] }[]): Promise<Map<string, TwoDays>> {
  const out = new Map<string, TwoDays>();
  const look = rows.filter((r) => r.billNo);
  if (!look.length) return out;
  const homes = await all<{ bill_no: string; day: string; cmp: string; decision: string | null; status: string | null; sw_amount: number; sw_mode: string; paid_at: number | null;
    row_id: string; upload_id: string; line_no: number; amount: number; discount: number; row_status: string; page_no: number }>(db, `
    SELECT sb.bill_no, sb.shift_day AS day, c.id AS cmp, c.decision, s.status, sb.amount_paise AS sw_amount, sb.mode AS sw_mode, sb.paid_at,
      r.id AS row_id, r.upload_id, r.line_no, r.amount_paise AS amount, r.discount_paise - r.tip_paise AS discount, r.status AS row_status,
      (SELECT count(*) FROM uploads u2 JOIN uploads u ON u.id = r.upload_id WHERE u2.business_id = sb.business_id AND u2.kind = 'bill_register'
        AND u2.business_day = sb.shift_day AND (u2.created_at < u.created_at OR (u2.created_at = u.created_at AND u2.id <= u.id))) AS page_no
    FROM software_bills sb
    JOIN register_rows r ON r.business_id = sb.business_id AND r.shift_day = sb.shift_day AND r.bill_no = sb.bill_no
      AND coalesce(json_extract(r.ocr_original, '$.source'), '') <> 'software_report'
    LEFT JOIN bill_comparisons c ON c.business_id = sb.business_id AND c.shift_day = sb.shift_day AND c.software_bill_id = sb.id
    LEFT JOIN shifts s ON s.business_id = sb.business_id AND s.shift_day = sb.shift_day
    WHERE sb.business_id = ? AND sb.shift_day <> ? AND sb.shift_day BETWEEN ? AND ?
      AND sb.bill_no IN (SELECT r2.bill_no FROM register_rows r2 WHERE r2.business_id = ? AND r2.shift_day = ? AND r2.bill_no <> '')
      AND NOT EXISTS (SELECT 1 FROM software_bills s2 WHERE s2.business_id = sb.business_id AND s2.shift_day = ? AND s2.bill_no = sb.bill_no)
    ORDER BY r.line_no`, businessId, day, addDays(day, -7), addDays(day, 7), businessId, day, day);
  if (!homes.length) return out;
  const homeRows = [...new Set(homes.map((h) => h.row_id))];
  const [homePays, swHere, writtenHere] = await Promise.all([
    all<{ row: string; mode: string; amount: number }>(db, `SELECT p.register_row_id AS row, p.mode, p.amount_paise AS amount FROM register_payments p
      WHERE p.register_row_id IN (${homeRows.map(() => '?').join(',')})`, ...homeRows),
    all<{ bill_no: string; amount_paise: number; paid_at: number | null }>(db, 'SELECT bill_no, amount_paise, paid_at FROM software_bills WHERE business_id = ? AND shift_day = ?', businessId, day),
    all<{ bill_no: string }>(db, 'SELECT DISTINCT bill_no FROM register_rows WHERE business_id = ? AND shift_day = ?', businessId, day),
  ]);
  const written = new Set(writtenHere.map((x) => x.bill_no));
  const leftCache = new Map<number, Promise<Credit[]>>();
  for (const r of look) {
    const h = homes.find((x) => x.bill_no === r.billNo);
    if (!h) continue;
    const line: TwoDayLine = { rowId: h.row_id, uploadId: h.upload_id, lineNo: h.line_no, amountPaise: h.amount, discountPaise: h.discount,
      pays: homePays.filter((p) => p.row === h.row_id).map((p) => ({ mode: p.mode, amountPaise: p.amount })), status: h.row_status };
    const home: TwoDayHome = { day: h.day, comparisonId: h.cmp, decision: h.decision, confirmed: h.status === 'confirmed', swAmountPaise: h.sw_amount, swMode: h.sw_mode, paidAt: h.paid_at, line };
    const hereUpi = r.pays.filter((p) => p.mode === 'upi').reduce((t, p) => t + p.amountPaise, 0);
    if (hereUpi && !leftCache.has(hereUpi)) leftCache.set(hereUpi, leftoverCredits(db, businessId, day, hereUpi));
    const leftover = hereUpi ? await leftCache.get(hereUpi)! : [];
    const kind = twoDayKind({ day, pays: r.pays }, home, leftover);
    const target = paid(r.pays) || h.sw_amount;
    const at = leftover[0]?.postedAt ?? null;
    const candidates = kind !== 'wrong_number' ? [] : swHere.filter((b) => !written.has(b.bill_no) && b.amount_paise === target)
      .sort((x, y) => Math.abs((x.paid_at ?? 0) - (at ?? 0)) - Math.abs((y.paid_at ?? 0) - (at ?? 0))).slice(0, 3)
      .map((b) => ({ billNo: b.bill_no, amountPaise: b.amount_paise, paidAt: b.paid_at }));
    out.set(r.id, {
      kind, leftover, candidates, done: null, here: null, later: day > h.day, herePaidPaise: paid(r.pays), hereMode: modeOf(r.pays),
      home: { day: h.day, uploadId: h.upload_id, rowId: h.row_id, lineNo: h.line_no, pageNo: h.page_no || 1, amountPaise: h.amount, paidPaise: paid(line.pays), mode: modeOf(line.pays), status: h.row_status,
        swAmountPaise: h.sw_amount, swMode: h.sw_mode, paidAt: h.paid_at, confirmed: home.confirmed, creditAt: null },
    });
  }
  if (out.size) {
    const ids = [...out.keys()];
    const acts = await all<{ row_id: string; act: string }>(db, `SELECT a.row_id, json_extract(a.after, '$.action') AS act FROM audit_log a
      WHERE a.business_id = ? AND a.action = 'register.two_days' AND a.row_id IN (${ids.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM audit_log x WHERE x.business_id = a.business_id AND x.action = 'register.two_days_undone' AND x.row_id = a.row_id AND x.id > a.id)`,
      businessId, ...ids);
    for (const a of acts) { const t = out.get(a.row_id); if (t) t.done = a.act === 'settle' ? 'settle' : a.act === 'close' ? 'close' : 'advance'; }
    const mine = await all<{ row: string; decision: string | null; closed_at: number | null; status: string | null }>(db, `SELECT c.register_row_id AS row, c.decision, c.closed_at, s.status
      FROM bill_comparisons c LEFT JOIN shifts s ON s.business_id = c.business_id AND s.shift_day = c.shift_day
      WHERE c.business_id = ? AND c.register_row_id IN (${ids.map(() => '?').join(',')})`, businessId, ...ids);
    for (const m of mine) { const t = out.get(m.row); if (t) t.here = { decision: m.decision, closed: m.closed_at != null, confirmed: m.status === 'confirmed' }; }
    // The bill's own credit: written twice is told with the credit that paid it on its own day.
    for (const t of out.values()) {
      if (t.home.swMode !== 'upi' || t.home.paidAt == null) continue;
      const c = await all<{ posted_at: number }>(db, `SELECT posted_at FROM bank_rows WHERE business_id = ? AND kind = 'upi_in' AND direction = 'CR' AND amount_paise = ?
        AND posted_at BETWEEN ? AND ? ORDER BY abs(posted_at - ?) LIMIT 1`, businessId, t.home.swAmountPaise, t.home.paidAt - 3600e3, t.home.paidAt + 3600e3, t.home.paidAt);
      t.home.creditAt = c[0]?.posted_at ?? null;
    }
  }
  return out;
}
