/**
 * Days (approved 25 Nov 2026): is each day's money finished? Read only; nothing is written and nothing is locked.
 *
 * A day is a shift (8 am to 8 am). It is:
 *  - unsaved: its shift is not saved yet. Its UPI credits cannot be matched until it is, so they are not counted as
 *    problems: "Save this shift first".
 *  - open:    saved, and a bank credit of the shift is still open, or a bill of the shift still waits for its money
 *    (any mode, any age; past 7 days it is overdue).
 *  - waiting: saved, nothing open, but a bill waits for a file (bank sync, the card report) before it can be matched.
 *  - closed:  saved, every credit matched, booked, settled or left out, and no bill waiting.
 * Each open credit is put under one cause, so the page can show what is left by cause, biggest first, with the screen
 * that deals with it. Nothing here books anything: those screens (and the booking gate) still do.
 */
import { all, type DB } from './db';
import type { BankRow } from './bank';
import { booksStart } from './bank';
import { cashMoveOf } from './cash';
import { transferHints } from './transfers';
import { SETTLEMENT_REMARK } from './bookingGate';
import { WATCH_DAYS } from './sales';
import { waitingPicture, type WaitItem } from './waiting';
import { addDays, shiftDayOf } from './time';

const SHIFT_OF = "date((r.posted_at - 9000000) / 1000, 'unixepoch')";
/** Booking sites whose payouts come by NEFT. Only their names: "MMT/IMPS" in a bank line is a mobile transfer, not MakeMyTrip. */
const BOOKING_SITE = /MAKE\s*MY\s*TRIP|MAKEMYTRIP|GOIBIBO|AGODA|BOOKING\.COM|EXPEDIA|CLEARTRIP|YATRA/i;

export type DayStatus = 'unsaved' | 'open' | 'waiting' | 'closed';
export type CreditCause = 'chosen' | 'unsaved' | 'card' | 'settlement' | 'transfer' | 'cash' | 'site' | 'upi' | 'other';
export const CAUSE_WORDS: Record<CreditCause, string> = {
  unsaved: 'UPI credits of shifts not saved',
  chosen: 'Chosen on Reconcile, matched when the shift is saved',
  transfer: 'Money between own accounts',
  site: 'Booking site payouts',
  settlement: 'Yes Bank UPI settlements',
  card: 'Card machine money not settled',
  cash: 'Cash paid into the bank',
  upi: 'UPI credits, saved shift, no bill',
  other: 'Other money in',
};

export interface OpenCredit { id: string; day: string; amountPaise: number; at: number; cause: CreditCause; description: string; accountName: string }
export interface DayLine { label: string; n: number; paise: number; state: 'done' | 'open' }
export interface DayRow {
  day: string; status: DayStatus; inPaise: number; credits: number; creditsOpen: number; billsWaiting: number; billsOverdue: number;
  /** Bills of the day that wait for a file, not for a person. */
  billsGrey: number;
}

type Row = BankRow & { shift: string; account_name: string; head_name: string | null; tx_type: string | null; held: number };

/** Every day from the books start to the last shift that has ended, with what is left on each. */
export async function daysPicture(db: DB, businessId: string, today: string, waiting?: Awaited<ReturnType<typeof waitingPicture>>) {
  const start = await booksStart(db, businessId);
  const last = addDays(shiftDayOf(Date.now()), -1);
  const lastDay = last < today ? last : addDays(today, -1);
  const [rows, shifts, w] = await Promise.all([
    all<Row>(db, `SELECT r.*, ${SHIFT_OF} AS shift, a.name AS account_name, h.name AS head_name, t.type AS tx_type,
        EXISTS (SELECT 1 FROM shift_plan_items i WHERE i.business_id = r.business_id AND i.bank_row_id = r.id) AS held
      FROM bank_rows r JOIN accounts a ON a.id = r.account_id LEFT JOIN transactions t ON t.id = r.transaction_id LEFT JOIN heads h ON h.id = t.head_id
      WHERE r.business_id = ? AND r.direction = 'CR' AND ${SHIFT_OF} BETWEEN ? AND ?`, businessId, start, lastDay),
    all<{ day: string; status: string }>(db, 'SELECT shift_day AS day, status FROM shifts WHERE business_id = ? AND shift_day BETWEEN ? AND ?', businessId, start, lastDay),
    waiting ? Promise.resolve(waiting) : waitingPicture(db, businessId, today),
  ]);
  const saved = new Set(shifts.filter((s) => s.status === 'confirmed').map((s) => s.day));
  const open = rows.filter((r) => r.status === 'unmatched');
  const hints = await transferHints(db, businessId, open);
  const credits: OpenCredit[] = open.map((r) => ({
    id: r.id, day: r.shift, amountPaise: r.amount_paise, at: r.posted_at, description: r.description, accountName: r.account_name,
    cause: r.held ? 'chosen' : r.kind === 'card_settlement' ? 'card' : r.remark === SETTLEMENT_REMARK ? 'settlement' : hints.has(r.id) ? 'transfer'
      : cashMoveOf(r) === 'deposit' ? 'cash' : r.kind === 'upi_in' ? (saved.has(r.shift) ? 'upi' : 'unsaved') : BOOKING_SITE.test(r.description) ? 'site' : 'other',
  }));
  const inRange = (d: string) => d >= start && d <= lastDay;
  const bills = w.look.filter((b) => inRange(b.day));
  const grey = w.grey.filter((g) => inRange(g.day) && g.waitFor !== 'unsaved' && g.waitFor !== 'chosen');

  const days: DayRow[] = [];
  for (let d = start; d <= lastDay; d = addDays(d, 1)) {
    const mine = rows.filter((r) => r.shift === d);
    const left = credits.filter((c) => c.day === d).length;
    const waitingN = bills.filter((b) => b.day === d);
    const greyN = grey.filter((g) => g.day === d).length;
    const status: DayStatus = !saved.has(d) ? 'unsaved' : left || waitingN.length ? 'open' : greyN ? 'waiting' : 'closed';
    days.push({ day: d, status, inPaise: mine.reduce((t, r) => t + r.amount_paise, 0), credits: mine.length, creditsOpen: left,
      billsWaiting: waitingN.length, billsOverdue: waitingN.filter((b) => b.unresolved).length, billsGrey: greyN });
  }

  // What is left, by cause, biggest first. Bills: by mode, overdue first.
  const groups = (Object.keys(CAUSE_WORDS) as CreditCause[]).map((cause) => {
    const xs = credits.filter((c) => c.cause === cause);
    return { cause, label: CAUSE_WORDS[cause], n: xs.length, paise: xs.reduce((t, c) => t + c.amountPaise, 0), days: [...new Set(xs.map((c) => c.day))].sort(),
      sample: xs.slice().sort((a, b) => b.amountPaise - a.amountPaise).slice(0, 4).map((c) => ({ day: c.day, amountPaise: c.amountPaise, description: c.description })) };
  }).filter((g) => g.n).sort((a, b) => b.paise - a.paise);
  const modeOf = (b: WaitItem) => (b.mode === 'upi' || b.mode === 'card' || b.mode === 'cash' ? b.mode : 'other');
  const billGroups = (['upi', 'card', 'cash', 'other'] as const).map((mode) => {
    const xs = bills.filter((b) => modeOf(b) === mode);
    return { mode, n: xs.length, overdue: xs.filter((b) => b.unresolved).length, paise: xs.reduce((t, b) => t + b.amountPaise, 0), days: [...new Set(xs.map((b) => b.day))].sort(),
      bills: xs.slice(0, 8).map((b) => ({ billNo: b.billNo, day: b.day, amountPaise: b.amountPaise, overdue: b.unresolved })) };
  }).filter((g) => g.n);

  return {
    start, lastDay, watchDays: WATCH_DAYS, days,
    closed: days.filter((d) => d.status === 'closed').length,
    open: days.filter((d) => d.status !== 'closed').length,
    oldestOpen: days.find((d) => d.status !== 'closed')?.day ?? null,
    left: { credits: credits.length, creditsPaise: credits.reduce((t, c) => t + c.amountPaise, 0), bills: bills.length },
    groups, billGroups,
    /** For the day opened: its credits by state (they add up to money in), and its open credits and waiting bills. */
    detail: (day: string) => {
      const mine = rows.filter((r) => r.shift === day);
      const lines = new Map<string, DayLine>();
      const add = (label: string, state: DayLine['state'], p: number) => { const k = `${state}|${label}`; const x = lines.get(k) ?? { label, n: 0, paise: 0, state }; x.n += 1; x.paise += p; lines.set(k, x); };
      for (const r of mine) {
        if (r.status === 'matched') add(r.kind === 'card_settlement' ? 'Card settlement' : 'Matched to bills', 'done', r.amount_paise);
        else if (r.status === 'booked') add(r.kind === 'card_settlement' ? 'Card settlement' : r.tx_type === 'transfer' ? 'Transfer between own accounts' : `Booked · ${r.head_name ?? 'no head'}`, 'done', r.amount_paise);
        else if (r.status === 'ignored') add(`Left out · ${r.note ?? 'no reason'}`, 'done', r.amount_paise);
      }
      const mineOpen = credits.filter((c) => c.day === day);
      for (const c of mineOpen) add(CAUSE_WORDS[c.cause], 'open', c.amountPaise);
      return {
        day, row: days.find((d) => d.day === day) ?? null,
        inPaise: mine.reduce((t, r) => t + r.amount_paise, 0),
        lines: [...lines.values()].sort((a, b) => (a.state === b.state ? b.paise - a.paise : a.state === 'done' ? -1 : 1)),
        credits: mineOpen.sort((a, b) => a.at - b.at),
        bills: bills.filter((b) => b.day === day).map((b) => ({ billNo: b.billNo, amountPaise: b.amountPaise, mode: b.mode, kind: b.kind ?? null, reason: b.reason, overdue: b.unresolved })),
        grey: grey.filter((g) => g.day === day).map((g) => ({ billNo: g.billNo, amountPaise: g.amountPaise, waitFor: g.waitFor, reason: g.reason })),
      };
    },
  };
}
