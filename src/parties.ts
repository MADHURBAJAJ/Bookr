// Vendors ("parties") remembered under a default expense head, e.g. Blinkit -> Kitchen purchases.
// The first time a vendor gets a head, it is remembered; later lines from that vendor get that head
// filled in ("Learned"), which a person can still change. Changing a vendor's remembered head
// afterwards is Owner/Accountant work (heads.edit), like editing heads and rules.

import { all, newId, now, stmt, type DB } from './db';

export interface Party { id: string; name: string; aliases: string; default_head_id: string | null }

const norm = (v: string) => v.toLowerCase().replace(/\s+/g, ' ').trim();
const namesOf = (p: Party) => [p.name, ...(JSON.parse(p.aliases) as string[])].map(norm).filter(Boolean);

export async function loadParties(db: DB, businessId: string): Promise<Party[]> {
  return all<Party>(db, 'SELECT id, name, aliases, default_head_id FROM parties WHERE business_id = ?', businessId);
}

/** The vendor with this name or one of its other spellings. */
export function byName(parties: Party[], name: string): Party | null {
  const n = norm(name);
  return parties.find((p) => namesOf(p).includes(n)) ?? null;
}

/** A known vendor whose name appears as a word in the item text ("Blinkit veg" -> Blinkit). Longest name wins. */
export function inText(parties: Party[], text: string): Party | null {
  const t = ` ${norm(text).replace(/[^a-z0-9 ]/g, ' ')} `;
  let best: { p: Party; len: number } | null = null;
  for (const p of parties) {
    for (const n of namesOf(p)) {
      const w = n.replace(/[^a-z0-9 ]/g, ' ').trim();
      if (w.length >= 3 && t.includes(` ${w} `) && (!best || w.length > best.len)) best = { p, len: w.length };
    }
  }
  return best?.p ?? null;
}

export interface PastLine { party_id: string; head_id: string; narration: string | null }

/** Past expense lines with a vendor and a head: how each vendor has been booked before. */
export async function loadHistory(db: DB, businessId: string): Promise<PastLine[]> {
  return all<PastLine>(db, `SELECT party_id, head_id, narration FROM transactions
    WHERE business_id = ? AND party_id IS NOT NULL AND head_id IS NOT NULL AND type = 'expense'
    ORDER BY created_at DESC LIMIT 5000`, businessId);
}

const words = (v: string | null) => norm(v ?? '').replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w.length >= 3);

/**
 * The head for a vendor's line. One head used so far: that head. Several: the head of an earlier line
 * with the same item (or the same first word, e.g. "Detergent powder" after "Detergent"). Otherwise
 * none, and the vendor's heads are offered as choices.
 */
export function pickHead(party: Party, history: PastLine[], narration: string): { headId: string | null; choices: string[] } {
  const mine = history.filter((h) => h.party_id === party.id);
  const choices = [...new Set([...(party.default_head_id ? [party.default_head_id] : []), ...mine.map((h) => h.head_id)])];
  if (choices.length <= 1) return { headId: choices[0] ?? null, choices };
  const item = words(narration).filter((w) => !namesOf(party).some((n) => n.split(' ').includes(w)));
  if (item.length) {
    const same = mine.find((h) => words(h.narration).join(' ') === item.join(' '));
    const first = same ?? mine.find((h) => words(h.narration).filter((w) => !namesOf(party).some((n) => n.split(' ').includes(w)))[0] === item[0]);
    if (first) return { headId: first.head_id, choices };
  }
  return { headId: null, choices };
}

/**
 * Works out the vendor and head of an expense line.
 * - vendor named and known: use it; unknown: a new vendor is created (its head remembered if one is chosen)
 * - no vendor named: a known vendor in the item text is used
 * - head: the one chosen, else the vendor's remembered head ("learned")
 * - a vendor with no remembered head learns the first head chosen for it
 */
export function resolveVendor(db: DB, businessId: string, parties: Party[], input: { vendor: string | null; narration: string; headId: string | null }, history: PastLine[] = []) {
  const statements: D1PreparedStatement[] = [];
  let party = input.vendor ? byName(parties, input.vendor) : inText(parties, input.narration);
  if (!party && input.vendor) {
    party = { id: newId(), name: input.vendor.trim(), aliases: '[]', default_head_id: input.headId };
    statements.push(stmt(db, 'INSERT INTO parties (id, business_id, name, aliases, default_head_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      party.id, businessId, party.name, '[]', input.headId, now()));
    parties.push(party);
  } else if (party && !party.default_head_id && input.headId) {
    statements.push(stmt(db, 'UPDATE parties SET default_head_id = ? WHERE id = ? AND default_head_id IS NULL', input.headId, party.id));
    party.default_head_id = input.headId;
  }
  const picked = !input.headId && party ? pickHead(party, history, input.narration) : null;
  const headId = input.headId ?? picked?.headId ?? null;
  return { partyId: party?.id ?? null, headId, learned: !input.headId && !!headId, statements };
}

/** Records in ocr_original whether the head was filled in from the vendor ("Learned") or from the item ("Learned from item"). */
export function markLearned(ocrOriginal: string | null, learned: boolean, from: 'party' | 'item' = 'party'): string | null {
  if (!ocrOriginal && !learned) return ocrOriginal;
  const o = ocrOriginal ? (JSON.parse(ocrOriginal) as { inferred?: string[]; headFrom?: string }) : {};
  const inferred = new Set((o.inferred ?? []).filter((f) => f !== 'head'));
  if (learned) inferred.add('head');
  const { headFrom: _old, ...rest } = o;
  return JSON.stringify({ ...rest, inferred: [...inferred], ...(learned && from === 'item' ? { headFrom: 'item' } : {}) });
}

// ---- Heads from the item when there is no party (approved 14 Nov 2026)

export interface PastItem { head_id: string; narration: string }

/** Past expense lines with a head, party or not: how each item has been booked before. */
export async function loadItemHistory(db: DB, businessId: string): Promise<PastItem[]> {
  return all<PastItem>(db, `SELECT head_id, narration FROM transactions WHERE business_id = ? AND type = 'expense' AND head_id IS NOT NULL
    AND narration IS NOT NULL AND trim(narration) <> '' ORDER BY created_at DESC LIMIT 5000`, businessId);
}

/** The head of the latest earlier line with the same item ("Petrol"), else the same first word ("Petrol bike" after "Petrol"). */
export function headFromItem(history: PastItem[], narration: string): string | null {
  const item = words(narration).filter((w) => !/^\d+$/.test(w));
  if (!item.length) return null;
  const key = item.join(' ');
  const same = history.find((h) => words(h.narration).filter((w) => !/^\d+$/.test(w)).join(' ') === key)
    ?? history.find((h) => words(h.narration).filter((w) => !/^\d+$/.test(w))[0] === item[0]);
  return same?.head_id ?? null;
}

/**
 * Common words and the heads they usually go under, by name: a suggestion a person accepts with one click, never filled
 * in by itself. Only heads the business has are suggested.
 */
const WORD_HEADS: [string[], string[]][] = [
  [['petrol', 'diesel', 'fuel', 'cng', 'auto', 'rickshaw', 'taxi', 'cab', 'uber', 'ola', 'rapido', 'porter', 'freight', 'courier', 'toll', 'parking', 'bus', 'train', 'travel', 'fare'],
    ['Fuel', 'Petrol', 'Transport', 'Travel', 'Conveyance']],
  [['scissors', 'scissor', 'stationery', 'stationary', 'pen', 'pens', 'paper', 'tape', 'xerox', 'photocopy', 'print', 'printing', 'file', 'stapler', 'register', 'notebook', 'battery', 'batteries'],
    ['Stationery', 'Misc. Expenses', 'Miscellaneous', 'Misc']],
  [['electrician', 'plumber', 'repair', 'repairs', 'paint', 'painter', 'carpenter', 'bulb', 'bulbs', 'wire', 'switch', 'tap', 'pipe', 'mistri', 'service', 'servicing', 'welding'],
    ['Repair & Maintenance', 'Repairs', 'Maintenance']],
  [['electricity', 'water', 'gas', 'cylinder', 'lpg', 'internet', 'wifi', 'broadband', 'recharge', 'mobile', 'phone', 'bill'],
    ['Utilities']],
  [['laundry', 'dhobi', 'washing', 'dryclean', 'ironing', 'press'], ['Laundry']],
  [['salary', 'salaries', 'wages', 'wage', 'staff'], ['Salaries', 'Salary', 'Wages']],
  [['beer', 'whisky', 'whiskey', 'vodka', 'rum', 'wine', 'liquor', 'gin'], ['Alcohol Purchase', 'Liquor', 'Bar Purchases']],
  [['packing', 'foil', 'container', 'containers', 'parcel', 'carry', 'bags', 'box', 'boxes', 'tissue', 'napkin', 'napkins'], ['Packing material', 'Packing', 'Packaging']],
  [['vegetables', 'vegetable', 'veg', 'sabzi', 'sabji', 'fruit', 'fruits', 'milk', 'curd', 'paneer', 'chicken', 'mutton', 'fish', 'egg', 'eggs', 'bread', 'oil', 'atta', 'maida', 'rice', 'dal', 'grocery', 'groceries', 'ration', 'masala', 'spices', 'sugar', 'salt', 'butter', 'cheese', 'onion', 'tomato', 'potato', 'coke', 'pepsi', 'soda', 'ice', 'cream'],
    ['Kitchen Purchases', 'Purchases', 'Food', 'Groceries']],
  [['rent'], ['Rent']],
  [['cleaning', 'phenyl', 'detergent', 'soap', 'broom', 'mop', 'harpic', 'sanitiser', 'sanitizer'], ['Housekeeping', 'Cleaning', 'Misc. Expenses']],
];

export function headFromWords(heads: { id: string; name: string }[], narration: string): { headId: string; word: string } | null {
  const ws = norm(narration).replace(/[^a-z ]/g, ' ').split(' ').filter(Boolean);
  for (const w of ws) {
    for (const [keys, names] of WORD_HEADS) {
      if (!keys.includes(w)) continue;
      for (const n of names) {
        const h = heads.find((x) => norm(x.name) === norm(n));
        if (h) return { headId: h.id, word: w };
      }
    }
  }
  return null;
}
