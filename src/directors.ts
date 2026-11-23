/**
 * Directors' accounts (approved 23 Nov 2026). Each family (Bajaj: Bajaj, Mohak, Deepansh; Kharbanda: Vikas, Vikram)
 * has one ledger with a person on each line and a balance per person:
 * - taken: cash a director took from the drawer (the cash line stays; the ledger says whose it was);
 * - stock taken: goods from the hotel's stock (a gas cylinder): no cash left, so the cash line goes;
 * - NC: a complimentary bill eaten by the family, at 50% of the bill; the other side is income under "Director NC";
 * - repaid: the hotel paying a director back for stock or bills they paid for it earlier: cash to them, so it adds;
 * - given ("Paid for the hotel"): money a director brings in, or a hotel bill they pay themselves: the only kind that lowers;
 * - opening: each person's balance on the day the ledger starts, typed in.
 * Balance = taken + stock + NC + repaid − paid for the hotel; above zero the person owes the hotel (fixed 23 Nov 2026).
 * Names on complimentary bills are sorted once (director's family member, staff, someone else); a director's NC lines
 * follow their bills by themselves (a bill no longer complimentary loses its line).
 */
import type { DB } from './db';
import { all, newId, one, stmt } from './db';
import { complimentaryBills } from './sales';
import { istDay } from './time';

export const KINDS = ['opening', 'taken', 'stock_taken', 'nc', 'given', 'repaid'] as const;
export type Kind = (typeof KINDS)[number];
export const TAKES: Kind[] = ['taken', 'stock_taken', 'nc', 'repaid'];
export const KIND_WORD: Record<Kind, string> = { opening: 'Opening balance', taken: 'Taken', stock_taken: 'Stock taken', nc: 'NC', given: 'Paid for the hotel', repaid: 'Repaid' };
export const NC_HEAD = 'Director NC';

/** A name as a key: lower case, letters only, "sir", "madam", "ji" and "mr" dropped. */
export const nameKey = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\b(sir|madam|mam|ji|mr|mrs)\b/g, ' ').replace(/[^a-z]/g, '');
const skeleton = (k: string) => k.replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');
function distance(a: string, b: string) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** Which director a name probably is (DIPANSHU SIR → Deepansh; "Vikas Sir (Vikram Sir)" → Vikram, the last named). */
export function guessDirector<T extends { id: string; name: string }>(name: string | null | undefined, people: T[]): T | null {
  const key = nameKey(name);
  if (!key) return null;
  const inside = people.map((p) => ({ p, at: key.lastIndexOf(nameKey(p.name)) })).filter((x) => nameKey(x.p.name) && x.at >= 0).sort((a, b) => b.at - a.at);
  if (inside.length) return inside[0].p;
  const near = people.filter((p) => { const k = nameKey(p.name); return k.length >= 4 && (distance(k, key) <= 2 || skeleton(k) === skeleton(key)); });
  return near.length === 1 ? near[0] : null;
}

export interface Person { id: string; family: string; name: string }
export const people = (db: DB, bid: string) => all<Person>(db, 'SELECT id, family, name FROM directors WHERE business_id = ? ORDER BY family, created_at', bid);
export async function ledgerStart(db: DB, bid: string) {
  return (await one<{ d: string | null }>(db, 'SELECT directors_from AS d FROM businesses WHERE id = ?', bid))?.d ?? null;
}

/** The income head NC lines are booked under, made the first time it is needed. */
async function ncHead(db: DB, bid: string) {
  const h = await one<{ id: string }>(db, "SELECT id FROM heads WHERE business_id = ? AND type = 'income' AND lower(name) = lower(?)", bid, NC_HEAD);
  if (h) return h.id;
  const id = newId();
  await db.prepare("INSERT INTO heads (id, business_id, name, type, tally_ledger, is_custom, created_at) VALUES (?, ?, ?, 'income', ?, 0, ?)").bind(id, bid, NC_HEAD, NC_HEAD, Date.now()).run();
  return id;
}

/** Half the bill, to the paisa (half a paisa rounds up). */
export const half = (p: number) => Math.round(p / 2);

/**
 * Keeps each director's NC lines in step with the complimentary bills from the ledger's start: a bill whose name is
 * a director's gets a line at 50% and its income; one that no longer is (name changed, paid after all) loses both.
 */
export async function syncNc(db: DB, bid: string, userId: string | null) {
  const from = await ledgerStart(db, bid);
  if (!from) return { added: 0, removed: 0 };
  const [names, existing, ppl] = await Promise.all([
    all<{ name_key: string; director_id: string }>(db, "SELECT name_key, director_id FROM nc_names WHERE business_id = ? AND kind = 'director'", bid),
    all<{ id: string; director_id: string; shift_day: string; bill_no: string; amount_paise: number; income_id: string | null }>(db,
      "SELECT id, director_id, shift_day, bill_no, amount_paise, income_id FROM director_entries WHERE business_id = ? AND kind = 'nc'", bid),
    people(db, bid),
  ]);
  const who = new Map(names.map((n) => [n.name_key, n.director_id]));
  const nameOf = new Map(ppl.map((p) => [p.id, p.name]));
  const bills = names.length ? (await complimentaryBills(db, bid, from, istDay(Date.now()))).lines : [];
  const want = new Map<string, { director: string; day: string; billNo: string; amount: number; value: number }>();
  for (const b of bills) {
    const d = who.get(nameKey(b.name));
    if (!d || !b.valuePaise) continue;
    want.set(`${b.day}|${b.billNo}`, { director: d, day: b.day, billNo: b.billNo, amount: half(b.valuePaise), value: b.valuePaise });
  }
  const s: D1PreparedStatement[] = [];
  const have = new Map(existing.map((e) => [`${e.shift_day}|${e.bill_no}`, e]));
  let removed = 0;
  for (const [k, e] of have) {
    const w = want.get(k);
    if (w && w.director === e.director_id && w.amount === e.amount_paise) continue;
    s.push(stmt(db, 'DELETE FROM director_entries WHERE id = ?', e.id));
    if (e.income_id) s.push(stmt(db, "DELETE FROM transactions WHERE id = ? AND business_id = ? AND type = 'income' AND shift_day IS NULL", e.income_id, bid));
    have.delete(k);
    removed += 1;
  }
  const add = [...want].filter(([k]) => !have.has(k));
  const head = add.length ? await ncHead(db, bid) : null;
  const t = Date.now();
  for (const [, w] of add) {
    const income = newId();
    s.push(stmt(db, `INSERT INTO transactions (id, business_id, account_id, day, amount_paise, type, head_id, narration, source, status, payment_mode, bill_no, created_at)
      VALUES (?, ?, NULL, ?, ?, 'income', ?, ?, 'software_report', 'approved', NULL, ?, ?)`, income, bid, w.day, w.amount, head,
      `${NC_HEAD}: ${nameOf.get(w.director) ?? ''} · bill ${w.billNo} ₹${(w.value / 100).toFixed(2)} × 50%`, w.billNo, t),
    stmt(db, `INSERT INTO director_entries (id, business_id, director_id, day, kind, amount_paise, note, shift_day, bill_no, income_id, created_by, created_at)
      VALUES (?, ?, ?, ?, 'nc', ?, ?, ?, ?, ?, ?, ?)`, newId(), bid, w.director, w.day, w.amount, `NC ${w.billNo} ₹${(w.value / 100).toFixed(2)} × 50%`, w.day, w.billNo, income, userId, t));
  }
  if (s.length) await db.batch(s);
  return { added: add.length, removed };
}

/** Names on complimentary bills from the ledger's start not sorted yet, with how often and a guess. */
export async function newNames(db: DB, bid: string, from: string, to = istDay(Date.now())) {
  const [bills, known, ppl] = await Promise.all([complimentaryBills(db, bid, from, to), all<{ name_key: string }>(db, 'SELECT name_key FROM nc_names WHERE business_id = ?', bid), people(db, bid)]);
  const seen = new Set(known.map((k) => k.name_key));
  const out = new Map<string, { key: string; name: string; bills: number; valuePaise: number; last: string; guess: Person | null }>();
  for (const b of bills.lines) {
    const key = nameKey(b.name);
    if (!key || seen.has(key)) continue;
    const x = out.get(key) ?? { key, name: b.name!, bills: 0, valuePaise: 0, last: b.day, guess: guessDirector(b.name, ppl) };
    x.bills += 1; x.valuePaise += b.valuePaise ?? 0; x.last = b.day > x.last ? b.day : x.last;
    out.set(key, x);
  }
  return [...out.values()].sort((a, b) => b.last.localeCompare(a.last));
}

/** Cash lines under a WITHDRAWL head from the ledger's start not in a ledger yet, with a person and a kind guessed. */
export async function toMove(db: DB, bid: string, from: string) {
  const [rows, ppl] = await Promise.all([all<{ id: string; day: string; amount_paise: number; narration: string | null; party: string | null; head: string; status: string; source: string }>(db, `
    SELECT t.id, t.day, t.amount_paise, t.narration, p.name AS party, h.name AS head, t.status, t.source FROM transactions t JOIN heads h ON h.id = t.head_id
      LEFT JOIN parties p ON p.id = t.party_id
    WHERE t.business_id = ? AND t.type = 'expense' AND t.day >= ? AND (upper(h.name) LIKE '%WITHDRAWL%' OR upper(h.name) LIKE '%WITHDRAWAL%')
      AND NOT EXISTS (SELECT 1 FROM director_entries e WHERE e.transaction_id = t.id) ORDER BY t.day, t.created_at`, bid, from), people(db, bid)]);
  return rows.map((r) => {
    const family = ppl.filter((p) => r.head.toUpperCase().includes(p.family.toUpperCase()));
    const person = guessDirector(`${r.party ?? ''} ${r.narration ?? ''}`, family.length ? family : ppl) ?? guessDirector(r.party, ppl);
    // "11th Sep bar stock", "1st Oct electricity": paying back what the person paid earlier (approved 23 Nov 2026).
    const repaid = /\b\d{1,2}(st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b\d{1,2}(st|nd|rd|th)\b/i.test(r.narration ?? '');
    return { transactionId: r.id, day: r.day, amountPaise: r.amount_paise, narration: r.narration, party: r.party, head: r.head, status: r.status,
      directorId: person?.id ?? null, kind: (repaid ? 'repaid' : 'taken') as Kind };
  });
}

/** Every family's ledger: its people with balances, and its lines oldest first. */
export async function ledgers(db: DB, bid: string) {
  const [ppl, lines] = await Promise.all([people(db, bid), all<{ id: string; director_id: string; day: string; kind: Kind; amount_paise: number; note: string | null;
    transaction_id: string | null; shift_day: string | null; bill_no: string | null; narration: string | null; tx_day: string | null; upload_id: string | null; by: string | null }>(db, `
    SELECT e.id, e.director_id, e.day, e.kind, e.amount_paise, e.note, e.transaction_id, e.shift_day, e.bill_no, t.narration, t.day AS tx_day, t.upload_id, u.name AS by
    FROM director_entries e LEFT JOIN transactions t ON t.id = e.transaction_id LEFT JOIN users u ON u.id = e.created_by
    WHERE e.business_id = ? ORDER BY e.day, e.kind <> 'opening', e.created_at`, bid)]);
  const signed = (l: { kind: Kind; amount_paise: number }) => (l.kind === 'opening' ? l.amount_paise : TAKES.includes(l.kind) ? l.amount_paise : -l.amount_paise);
  const families = [...new Set(ppl.map((p) => p.family))];
  return families.map((family) => {
    const mine = ppl.filter((p) => p.family === family);
    const ids = new Set(mine.map((p) => p.id));
    const ls = lines.filter((l) => ids.has(l.director_id));
    return {
      family,
      people: mine.map((p) => {
        const own = ls.filter((l) => l.director_id === p.id);
        return { id: p.id, name: p.name, opening: own.find((l) => l.kind === 'opening')?.amount_paise ?? null,
          takenPaise: own.filter((l) => TAKES.includes(l.kind)).reduce((t, l) => t + l.amount_paise, 0),
          givenPaise: own.filter((l) => l.kind === 'given').reduce((t, l) => t + l.amount_paise, 0),
          balancePaise: own.reduce((t, l) => t + signed(l), 0) };
      }),
      balancePaise: ls.reduce((t, l) => t + signed(l), 0),
      lines: ls.map((l) => ({ id: l.id, directorId: l.director_id, person: mine.find((p) => p.id === l.director_id)!.name, day: l.day, kind: l.kind,
        amountPaise: l.amount_paise, note: l.note ?? l.narration, transactionId: l.transaction_id, uploadId: l.upload_id, billNo: l.bill_no, by: l.by, auto: l.kind === 'nc' })),
    };
  });
}
