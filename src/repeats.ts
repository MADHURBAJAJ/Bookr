// Repeats on Bank → Money out (approved 23 Nov 2026): open paid-out lines that look alike, offered as one card each so
// a person books them in one go and, if they like, saves a rule so the next ones come with their head. Nothing is
// booked by itself. Cards: UPI card fees; bank charges with GST; the same word in the note (salary, gas, a director's
// name…); the same UPI ID; the same card shop. A card hidden with "Not these" stays hidden for everyone (audit row).
import type { DB } from './db';
import { all } from './db';
import { loadRules, ruleFor, type BankRow } from './bank';
import { byName, headFromItem, loadHistory, loadItemHistory, loadParties, pickHead } from './parties';

export const PLAIN_NOTE = /^(UPI|UPI Pay|NA|NO REMARKS?|Payment from Ph|Sent using Payt|Paid via SuperM|Paid via CRED|Scan and Pay|Paid securely v|Navi UPI|Paid in seconds)$/i;
export const plainNote = (v: string | null) => (v && !PLAIN_NOTE.test(v.trim()) ? v.trim() : '');

/** Words a note may carry, each with the heads it points to (by name, first that exists). */
const WORDS: { word: string; heads: RegExp[]; label?: string }[] = [
  { word: 'salary', heads: [/salar/i] },
  { word: 'rent', heads: [/^rent/i] },
  { word: 'gas', heads: [/\bgas\b/i, /utilit/i] },
  { word: 'liquor', heads: [/alc?hoh?al|liquor|bar/i] },
  { word: 'alcohol', heads: [/alc?hoh?al|liquor|bar/i] },
  { word: 'paint', heads: [/repair|mainten/i] },
  { word: 'plumber', heads: [/repair|mainten/i] },
  { word: 'electrician', heads: [/repair|mainten/i] },
  { word: 'diesel', heads: [/conveyance|transport|fuel/i] },
  { word: 'petrol', heads: [/conveyance|transport|fuel/i] },
  { word: 'laundry', heads: [/laundry/i] },
  { word: 'advance', heads: [/advance|salar/i] },
];
/** Filler in notes that is not a person's name (the hotel's own short name, "exp"…). */
const FILLER = new Set(['xo', 'xoxo', 'exp', 'expense', 'staff', 'new', 'wdl', 'paid', 'pay', 'the', 'for']);

export interface RepeatLine { id: string; postedAt: number; day: string; amountPaise: number; vpa: string | null; remark: string | null; accountName: string; party: string | null; maybe?: boolean }
export interface Repeat {
  key: string; kind: 'fee' | 'charges' | 'word' | 'vpa' | 'card'; label: string; contains: string | null; vpa: string | null;
  headId: string | null; headName: string | null; headFrom: 'item' | null; lines: RepeatLine[]; maybe: RepeatLine[];
  count: number; totalPaise: number; from: string; to: string; days: number; payees: number;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** The name left in a note once its word is taken out: "hemantsalary" → Hemant; "salary" → null. */
export function partyFromNote(remark: string | null, word: string): string | null {
  const rest = (remark ?? '').toLowerCase().replace(/[^a-z]/g, '').replace(word, ' ').trim().split(/\s+/).filter((x) => x.length >= 3 && !FILLER.has(x));
  return rest.length === 1 ? cap(rest[0]) : null;
}

export async function repeatsFor(db: DB, bid: string): Promise<Repeat[]> {
  const rows = await all<BankRow & { account_name: string }>(db, `SELECT r.*, a.name AS account_name FROM bank_rows r JOIN accounts a ON a.id = r.account_id
    WHERE r.business_id = ? AND r.status = 'unmatched' AND r.direction = 'DR' AND r.kind NOT IN ('upi_in', 'card_settlement', 'reversal') ORDER BY r.posted_at LIMIT 3000`, bid);
  if (!rows.length) return [];
  const [rules, parties, history, items, heads, people, hidden] = await Promise.all([loadRules(db, bid), loadParties(db, bid), loadHistory(db, bid), loadItemHistory(db, bid),
    all<{ id: string; name: string }>(db, "SELECT id, name FROM heads WHERE business_id = ? AND type = 'expense'", bid),
    all<{ name: string; family: string }>(db, 'SELECT name, family FROM directors WHERE business_id = ?', bid).catch(() => []),
    hiddenKeys(db, bid)]);
  // A line a rule or its known party already gives a head goes to "Head suggested", not here.
  const open = rows.filter((r) => {
    if (ruleFor(rules, r)) return false;
    const p = r.vpa ? byName(parties, r.vpa) : null;
    return !(p && pickHead(p, history, plainNote(r.remark)).headId);
  });
  const headBy = (res: RegExp[]) => { for (const re of res) { const h = heads.find((x) => re.test(x.name)); if (h) return h; } return null; };
  const line = (r: (typeof rows)[number], party: string | null = null): RepeatLine => ({ id: r.id, postedAt: r.posted_at, day: r.day, amountPaise: r.amount_paise, vpa: r.vpa,
    remark: plainNote(r.remark) || null, accountName: r.account_name, party });
  const taken = new Set<string>();
  const out: Repeat[] = [];
  const add = (r: Omit<Repeat, 'count' | 'totalPaise' | 'from' | 'to' | 'days' | 'payees' | 'maybe' | 'headFrom'> & { maybe?: RepeatLine[]; headFrom?: 'item' | null }, min: number, minDays = 1) => {
    const days = new Set(r.lines.map((l) => l.day));
    if (r.lines.length < min || days.size < minDays) return;
    for (const l of r.lines) taken.add(l.id);
    const ds = [...days].sort();
    out.push({ maybe: [], headFrom: null, ...r, count: r.lines.length, totalPaise: r.lines.reduce((t, l) => t + l.amountPaise, 0), from: ds[0], to: ds.at(-1)!,
      days: days.size, payees: new Set(r.lines.map((l) => l.vpa ?? l.remark)).size });
  };
  const fresh = () => open.filter((r) => !taken.has(r.id));
  // UPI card fees, and the bank's own charges with GST: to UPI charges (or Bank charges).
  const feeHead = headBy([/^upi charges?$/i, /^bank charges?$/i, /upi charge|bank charge/i]);
  add({ key: 'fee', kind: 'fee', label: 'UPI card fee', contains: 'EZY/UPICCMDR', vpa: null, headId: feeHead?.id ?? null, headName: feeHead?.name ?? null,
    lines: fresh().filter((r) => r.kind === 'upi_fee').map((r) => line(r)) }, 2);
  add({ key: 'charges', kind: 'charges', label: 'Bank charges + GST', contains: 'chg', vpa: null, headId: feeHead?.id ?? null, headName: feeHead?.name ?? null,
    lines: fresh().filter((r) => /\bchg\b.*\+\s*GST/i.test(r.description)).map((r) => line(r)) }, 2);
  // The same word in the note, from any payee: a director's family or name first, then the word list.
  const notes = () => fresh().filter((r) => r.kind === 'upi_out' && plainNote(r.remark));
  const families = [...new Set(people.map((p) => p.family))];
  const words = [
    ...families.map((f) => ({ word: f.toLowerCase(), head: heads.find((h) => h.name.toLowerCase().includes(f.toLowerCase()) && /withdraw/i.test(h.name)) ?? null })),
    ...people.map((p) => ({ word: p.name.toLowerCase(), head: heads.find((h) => h.name.toLowerCase().includes(p.family.toLowerCase()) && /withdraw/i.test(h.name)) ?? null })),
    // A "<NAME> WITHDRAWL" head names its family even before the Directors page is set up.
    ...heads.flatMap((h) => { const m = /^\s*([a-z]+)\s+withdraw/i.exec(h.name); return m && !families.some((f) => f.toLowerCase() === m[1].toLowerCase()) ? [{ word: m[1].toLowerCase(), head: h }] : []; }),
    ...WORDS.map((w) => ({ word: w.word, head: headBy(w.heads) })),
  ].filter((w) => w.word.length >= 3);
  for (const w of words) {
    const key = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z]/g, '');
    const hits = notes().filter((r) => key(r.remark).includes(w.word));
    // A word cut short by the bank (madhvimaidsalar): shown unticked as "maybe".
    const stem = w.word.slice(0, -1);
    const near = w.word.length >= 5 ? notes().filter((r) => !hits.includes(r) && key(r.remark).endsWith(stem)) : [];
    add({ key: `word:${w.word}`, kind: 'word', label: `"${w.word}" in the note`, contains: w.word, vpa: null, headId: w.head?.id ?? null, headName: w.head?.name ?? null,
      lines: hits.map((r) => line(r, partyFromNote(r.remark, w.word))),
      maybe: near.map((r) => ({ ...line(r, partyFromNote(r.remark, stem)), maybe: true })) }, 3);
  }
  // The same UPI ID, on two days or more.
  const byVpa = new Map<string, (typeof rows)[number][]>();
  for (const r of fresh()) if (r.vpa && r.kind === 'upi_out') byVpa.set(r.vpa, [...(byVpa.get(r.vpa) ?? []), r]);
  for (const [vpa, list] of byVpa) add({ key: `vpa:${vpa}`, kind: 'vpa', label: vpa, contains: null, vpa, headId: null, headName: null, lines: list.map((r) => line(r)) }, 3, 2);
  // The same card shop: a head guessed from the same item booked before is shown, marked to check.
  const byShop = new Map<string, (typeof rows)[number][]>();
  for (const r of fresh()) if (r.kind === 'card_purchase' && plainNote(r.remark)) byShop.set(plainNote(r.remark), [...(byShop.get(plainNote(r.remark)) ?? []), r]);
  for (const [shop, list] of byShop) {
    const h = headFromItem(items, shop);
    const head = h ? heads.find((x) => x.id === h) ?? null : null;
    add({ key: `card:${shop.toLowerCase()}`, kind: 'card', label: `${shop} card`, contains: shop, vpa: null, headId: head?.id ?? null, headName: head?.name ?? null,
      headFrom: head ? 'item' : null, lines: list.map((r) => line(r)) }, 2);
  }
  return out.filter((r) => !hidden.has(r.key)).sort((a, b) => (a.kind === 'fee' ? -1 : b.kind === 'fee' ? 1 : b.totalPaise - a.totalPaise));
}

/** Cards hidden with "Not these" (and not shown again by Undo). */
export async function hiddenKeys(db: DB, bid: string) {
  const log = await all<{ action: string; row_id: string }>(db, "SELECT action, row_id FROM audit_log WHERE business_id = ? AND action IN ('repeats.hide', 'repeats.unhide') ORDER BY id", bid);
  const s = new Set<string>();
  for (const x of log) { if (x.action === 'repeats.hide') s.add(x.row_id); else s.delete(x.row_id); }
  return s;
}

/** Reads a note that runs words together (approved 23 Nov 2026): "hemantsalary" → item salary, party Hemant, the
 * Salaries head. Only a guess, shown with a chip; a person books it. */
export function readNote(remark: string | null, heads: { id: string; name: string }[]) {
  const k = (plainNote(remark) ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!k) return null;
  const w = WORDS.find((x) => k.includes(x.word));
  if (!w || k === w.word) return null;
  let head: { id: string } | null = null;
  for (const re of w.heads) { head = heads.find((h) => re.test(h.name)) ?? null; if (head) break; }
  return { item: w.word, party: partyFromNote(remark, w.word), headId: head?.id ?? null };
}
