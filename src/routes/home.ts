import { Hono } from 'hono';
import { requireRole } from '../auth';
import type { AppEnv, Env } from '../types';
import { all, type DB } from '../db';
import { can, type Role } from '../permissions';
import { addDays, istDay, shiftDayOf } from '../time';
import { NEEDS_DECISION, waitingBills, WATCH_DAYS } from '../sales';
import { shiftCards, unsettledDays } from '../cards';
import { cashCheck } from '../cash';
import { cardReportsStatus } from '../cardDrive';

export const homeRoutes = new Hono<AppEnv>();

/**
 * The dashboard (approved 9 Nov 2026): the jobs waiting, most urgent first, as counts read from what is stored.
 * Nothing is written and nothing is recomputed. Same people as the dashboard ('reports.view': Owner, Accountant,
 * Viewer); every part that reads the bank or card reports is only for people who can match the bank ('bank.link'),
 * the cash check only for people who decide sales, expense photos only for people who approve them.
 */

// The shift of a bank line's posted time: India time less 8 hours (19 800 000 − 28 800 000 ms), as in Money out.
const SHIFT_OF = "date((posted_at - 9000000) / 1000, 'unixepoch')";
/** Shifts looked at for "Shifts to finish" and the cash check. Older leftovers show on the UPI and card cards. */
const SHIFT_DAYS = 30;
const CASH_DAYS = 7;
const MAX_SHIFTS = 10;

type Count = { day: string; n: number };

export async function homeFor(env: Env, businessId: string, role: Role, today = istDay(Date.now())) {
  const db: DB = env.DB;
  const bank = can(role, 'bank.link');
  const decide = can(role, 'sales.decide');
  const approve = can(role, 'rows.approve');
  const since = addDays(today, -SHIFT_DAYS);
  const byDay = (rows: Count[]) => new Map(rows.map((r) => [r.day, r.n]));

  const [shifts, toCheck, toDecide, upiBills, upiCredits, waiting, uploads] = await Promise.all([
    all<{ day: string; status: string }>(db, 'SELECT shift_day AS day, status FROM shifts WHERE business_id = ? AND shift_day >= ? ORDER BY shift_day', businessId, since),
    all<Count>(db, `SELECT shift_day AS day, count(*) AS n FROM register_rows WHERE business_id = ? AND shift_day >= ? AND status <> 'checked' GROUP BY shift_day`, businessId, since),
    all<Count>(db, `SELECT shift_day AS day, count(*) AS n FROM bill_comparisons WHERE business_id = ? AND shift_day >= ? AND decision IS NULL
      AND difference IN (${NEEDS_DECISION.map(() => '?').join(',')}) GROUP BY shift_day`, businessId, since, ...NEEDS_DECISION),
    bank ? all<Count & { paise: number }>(db, `SELECT shift_day AS day, count(*) AS n, sum(amount_paise) AS paise FROM transactions WHERE business_id = ? AND type = 'income'
      AND payment_mode = 'upi' AND match_status = 'awaiting_bank_match' AND matched_bank_row IS NULL GROUP BY shift_day`, businessId) : [],
    bank ? all<Count & { paise: number }>(db, `SELECT ${SHIFT_OF} AS day, count(*) AS n, sum(amount_paise) AS paise FROM bank_rows
      WHERE business_id = ? AND kind = 'upi_in' AND status = 'unmatched' GROUP BY ${SHIFT_OF}`, businessId) : [],
    waitingBills(db, businessId, today),
    all<{ kind: string; day: string | null }>(db, `SELECT kind, max(business_day) AS day FROM uploads WHERE business_id = ? AND kind IN ('bill_register', 'software_sales_csv') GROUP BY kind`, businessId),
  ]);

  // Shifts to finish: not confirmed yet, or (for the bank's people) confirmed with UPI or card items still open.
  const check = byDay(toCheck);
  const decideN = byDay(toDecide);
  const bills = byDay(upiBills);
  const credits = byDay(upiCredits);
  const list = await Promise.all(shifts.map(async (s) => {
    const cardsLeft = bank && s.status === 'confirmed' ? (await shiftCards(db, businessId, s.day, null)).left : 0;
    return {
      day: s.day, status: s.status, toCheck: check.get(s.day) ?? 0, toDecide: decideN.get(s.day) ?? 0,
      bank: bank ? { billsLeft: bills.get(s.day) ?? 0, creditsLeft: credits.get(s.day) ?? 0, cardsLeft } : null,
    };
  }));
  const open = list.filter((s) => s.status !== 'confirmed' || (s.bank && s.bank.billsLeft + s.bank.creditsLeft + s.bank.cardsLeft > 0));

  const waitingOut = waiting.filter((b) => !b.oddNumber);
  const result = {
    today, watchDays: WATCH_DAYS,
    shifts: { count: open.length, list: open.slice(0, MAX_SHIFTS) },
    waitingBills: { count: waitingOut.length, late: waitingOut.filter((b) => b.unresolved).length, firstDay: waitingOut[0]?.day ?? null },
    fresh: {
      registerDay: uploads.find((u) => u.kind === 'bill_register')?.day ?? null,
      reportDay: uploads.find((u) => u.kind === 'software_sales_csv')?.day ?? null,
      bank: null as null | { id: string; name: string; lastSyncedAt: number | null; lastAt: number | null; note: string | null; linked: boolean }[],
      cards: null as null | { folder: boolean; lastAt: number | null },
    },
    bookExpenses: null as null | { count: number; paise: number; oldestDay: string | null; accounts: { id: string; name: string; count: number; paise: number; oldestDay: string | null; lastAt: number | null }[] },
    upi: null as null | { credits: { count: number; paise: number; oldestDay: string | null; late: number }; bills: { count: number; paise: number; oldestDay: string | null } },
    cards: null as null | { days: number; netPaise: number; oldestDay: string | null },
    cash: null as null | { day: string; differencePaise: number | null; counted: boolean }[],
    photos: null as null | { count: number; paise: number; pages: { uploadId: string; day: string; count: number; paise: number }[] },
  };

  if (bank) {
    const [accounts, unbooked, unsettled, cardStatus] = await Promise.all([
      all<{ id: string; name: string; lastSyncedAt: number | null; note: string | null; linked: number; lastAt: number | null }>(db, `
        SELECT a.id, a.name, s.last_synced_at AS lastSyncedAt, s.last_sync_note AS note, s.account_id IS NOT NULL AS linked,
          (SELECT max(r.posted_at) FROM bank_rows r WHERE r.account_id = a.id) AS lastAt
        FROM accounts a LEFT JOIN bank_sources s ON s.account_id = a.id WHERE a.business_id = ? AND a.kind = 'bank' ORDER BY a.name`, businessId),
      // Bank payments not booked yet: every debit Bookr has, so up to the last bank data synced. Left-out lines are not counted.
      all<{ accountId: string; n: number; paise: number; firstAt: number }>(db, `
        SELECT account_id AS accountId, count(*) AS n, sum(amount_paise) AS paise, min(posted_at) AS firstAt FROM bank_rows
        WHERE business_id = ? AND direction = 'DR' AND status = 'unmatched' GROUP BY account_id`, businessId),
      unsettledDays(db, businessId),
      cardReportsStatus(env, businessId),
    ]);
    const per = accounts.map((a) => {
      const u = unbooked.find((x) => x.accountId === a.id);
      return { id: a.id, name: a.name, count: u?.n ?? 0, paise: u?.paise ?? 0, oldestDay: u ? shiftDayOf(u.firstAt) : null, lastAt: a.lastAt };
    }).filter((a) => a.count > 0);
    const oldest = (days: (string | null)[]) => days.filter((d): d is string => !!d).sort()[0] ?? null;
    result.bookExpenses = { count: per.reduce((t, a) => t + a.count, 0), paise: per.reduce((t, a) => t + a.paise, 0), oldestDay: oldest(per.map((a) => a.oldestDay)), accounts: per };
    const late = addDays(today, -WATCH_DAYS);
    result.upi = {
      credits: { count: upiCredits.reduce((t, x) => t + x.n, 0), paise: upiCredits.reduce((t, x) => t + x.paise, 0), oldestDay: oldest(upiCredits.map((x) => x.day)),
        late: upiCredits.filter((x) => x.day < late).reduce((t, x) => t + x.n, 0) },
      bills: { count: upiBills.reduce((t, x) => t + x.n, 0), paise: upiBills.reduce((t, x) => t + x.paise, 0), oldestDay: oldest(upiBills.map((x) => x.day)) },
    };
    result.cards = { days: unsettled.length, netPaise: unsettled.reduce((t, d) => t + d.netPaise, 0), oldestDay: unsettled[0]?.settledOn ?? null };
    result.fresh.bank = accounts.map((a) => ({ id: a.id, name: a.name, lastSyncedAt: a.lastSyncedAt, lastAt: a.lastAt, note: a.note, linked: !!a.linked }));
    result.fresh.cards = { folder: !!cardStatus.folder, lastAt: cardStatus.lastAt };
  }

  if (decide) {
    // Confirmed shifts of the last week whose cash is not counted yet, or differs and was not accepted.
    const days = shifts.filter((s) => s.status === 'confirmed' && s.day >= addDays(today, -CASH_DAYS));
    const checks = await Promise.all(days.map((s) => cashCheck(db, businessId, s.day)));
    result.cash = checks.filter((k) => !k.settled && (k.countedPaise == null || k.differencePaise != null))
      .map((k) => ({ day: k.day, differencePaise: k.differencePaise, counted: k.countedPaise != null }));
  }

  if (approve) {
    const pages = await all<{ uploadId: string; day: string; count: number; paise: number }>(db, `
      SELECT upload_id AS uploadId, min(day) AS day, count(*) AS count, sum(amount_paise) AS paise FROM transactions
      WHERE business_id = ? AND source = 'cash_photo' AND type = 'expense' AND status <> 'approved' AND upload_id IS NOT NULL
      GROUP BY upload_id ORDER BY min(day)`, businessId);
    result.photos = { count: pages.reduce((t, p) => t + p.count, 0), paise: pages.reduce((t, p) => t + p.paise, 0), pages };
  }
  return result;
}

homeRoutes.get('/businesses/:businessId/home', requireRole('reports.view'), async (c) =>
  c.json(await homeFor(c.env, c.get('businessId'), c.get('role'))));
