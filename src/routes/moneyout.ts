import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { requireRole } from '../auth';
import { all } from '../db';
import { fail, isUuid } from '../http';
import { addDays, istDay } from '../time';

export const moneyOutRoutes = new Hono<AppEnv>();

/**
 * Money out (read-only): every payment made, from a bank account or from Cash, in one list.
 * - Bank: every debit line on a statement, booked or not. A booked line and the expense booked from it are one
 *   payment, so the line is listed with that expense's head and party, and the expense is not listed again.
 * - Cash: expense rows from expense-list photos (draft or approved), and cash shortages booked by an Owner.
 * Left out: bank_sheet expenses that are not a debit's booking (the difference when a UPI credit is less than its
 * bills: less came in, nothing was paid). No code writes 'transfer' rows yet, so there are none to list.
 * Days are shifts (8 am to 8 am, India time): a bank line counts on the shift of its posted time, as on Bank sync.
 * Bank data, so Owner and Accountant only ('bank.link', the same as Bank sync).
 */
type Line = {
  id: string; source: 'bank' | 'cash_photo' | 'cash_shortage'; day: string; at: number | null;
  accountId: string; accountName: string; accountKind: 'cash' | 'bank';
  partyId: string | null; party: string | null; headId: string | null; head: string | null;
  narration: string; detail: string | null; amountPaise: number;
  status: 'not_booked' | 'booked' | 'matched' | 'left_out' | 'draft' | 'approved'; note: string | null; uploadId: string | null;
};

// The shift of a bank line's posted time: India time less 8 hours (19 800 000 − 28 800 000 ms).
const SHIFT_OF = "date((r.posted_at - 9000000) / 1000, 'unixepoch')";
const WAITING = new Set(['not_booked', 'draft']);

moneyOutRoutes.get('/businesses/:businessId/money-out', requireRole('bank.link'), async (c) => {
  const db = c.env.DB;
  const bid = c.get('businessId');
  const q = c.req.query();
  const today = istDay(Date.now());
  const isDay = (v: string | undefined) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '');
  const to = isDay(q.to) ? q.to! : today;
  const from = isDay(q.from) ? q.from! : `${to.slice(0, 8)}01`;
  if (from > to) fail(400, 'From must be on or before To.');
  if (addDays(from, 400) < to) fail(400, 'Choose at most about a year at a time.');
  const account = q.account && isUuid(q.account) ? q.account : null;
  const head = q.head === 'none' ? 'none' : q.head && isUuid(q.head) ? q.head : null;
  const party = q.party === 'none' ? 'none' : q.party && isUuid(q.party) ? q.party : null;
  const waiting = q.waiting === '1';

  const [bank, cash, accounts, heads, parties] = await Promise.all([
    all<Line>(db, `
      SELECT r.id, 'bank' AS source, ${SHIFT_OF} AS day, r.posted_at AS at, a.id AS accountId, a.name AS accountName, a.kind AS accountKind,
        p.id AS partyId, p.name AS party, h.id AS headId, h.name AS head,
        coalesce(nullif(t.narration, ''), nullif(r.remark, ''), r.description) AS narration, r.description AS detail, r.amount_paise AS amountPaise,
        CASE r.status WHEN 'unmatched' THEN 'not_booked' WHEN 'ignored' THEN 'left_out' ELSE r.status END AS status, r.note, NULL AS uploadId
      FROM bank_rows r JOIN accounts a ON a.id = r.account_id
      LEFT JOIN transactions t ON t.id = r.transaction_id LEFT JOIN heads h ON h.id = t.head_id LEFT JOIN parties p ON p.id = t.party_id
      WHERE r.business_id = ? AND r.direction = 'DR' AND r.day BETWEEN ? AND ? AND ${SHIFT_OF} BETWEEN ? AND ?`,
      bid, from, addDays(to, 1), from, to),
    all<Line>(db, `
      SELECT t.id, t.source, t.day, NULL AS at, a.id AS accountId, a.name AS accountName, a.kind AS accountKind,
        p.id AS partyId, p.name AS party, h.id AS headId, h.name AS head, coalesce(t.narration, '') AS narration, NULL AS detail,
        t.amount_paise AS amountPaise, CASE t.status WHEN 'approved' THEN 'approved' ELSE 'draft' END AS status, NULL AS note, t.upload_id AS uploadId
      FROM transactions t JOIN accounts a ON a.id = t.account_id
      LEFT JOIN heads h ON h.id = t.head_id LEFT JOIN parties p ON p.id = t.party_id
      WHERE t.business_id = ? AND t.type = 'expense' AND t.source IN ('cash_photo', 'cash_shortage') AND t.day BETWEEN ? AND ?`,
      bid, from, to),
    all<{ id: string; name: string; kind: string }>(db, 'SELECT id, name, kind FROM accounts WHERE business_id = ? ORDER BY kind = \'bank\', name', bid),
    all<{ id: string; name: string }>(db, "SELECT id, name FROM heads WHERE business_id = ? AND type = 'expense' ORDER BY name", bid),
    all<{ id: string; name: string }>(db, 'SELECT id, name FROM parties WHERE business_id = ? ORDER BY lower(name)', bid),
  ]);

  const lines = [...bank, ...cash]
    .filter((l) => (!account || l.accountId === account)
      && (!head || (head === 'none' ? !l.headId : l.headId === head))
      && (!party || (party === 'none' ? !l.partyId : l.partyId === party))
      && (!waiting || WAITING.has(l.status)))
    // Newest first; within a shift, bank lines by time, then cash lines.
    .sort((a, b) => b.day.localeCompare(a.day) || (b.at ?? 0) - (a.at ?? 0) || a.narration.localeCompare(b.narration));

  // A bank line left out (e.g. a payment and its reversal) is shown but is not money out.
  const counted = lines.filter((l) => l.status !== 'left_out');
  const sum = (key: (l: Line) => string, label: (l: Line) => string) => {
    const m = new Map<string, { id: string; name: string; count: number; paise: number }>();
    for (const l of counted) {
      const k = key(l);
      const g = m.get(k) ?? { id: k, name: label(l), count: 0, paise: 0 };
      g.count += 1;
      g.paise += l.amountPaise;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.paise - a.paise);
  };
  return c.json({
    from, to,
    filters: { account, head, party, waiting },
    total: { count: counted.length, paise: counted.reduce((s, l) => s + l.amountPaise, 0) },
    waiting: { count: counted.filter((l) => WAITING.has(l.status)).length, paise: counted.filter((l) => WAITING.has(l.status)).reduce((s, l) => s + l.amountPaise, 0) },
    leftOut: { count: lines.length - counted.length, paise: lines.filter((l) => l.status === 'left_out').reduce((s, l) => s + l.amountPaise, 0) },
    byHead: sum((l) => l.headId ?? 'none', (l) => l.head ?? 'No head yet'),
    byAccount: sum((l) => l.accountId, (l) => l.accountName),
    lines,
    options: { accounts, heads, parties },
  });
});
