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

/**
 * Works out the vendor and head of an expense line.
 * - vendor named and known: use it; unknown: a new vendor is created (its head remembered if one is chosen)
 * - no vendor named: a known vendor in the item text is used
 * - head: the one chosen, else the vendor's remembered head ("learned")
 * - a vendor with no remembered head learns the first head chosen for it
 */
export function resolveVendor(db: DB, businessId: string, parties: Party[], input: { vendor: string | null; narration: string; headId: string | null }) {
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
  const learned = !input.headId && !!party?.default_head_id;
  return { partyId: party?.id ?? null, headId: input.headId ?? party?.default_head_id ?? null, learned, statements };
}

/** Records in ocr_original whether the head was filled in from the vendor (shown as "Learned"). */
export function markLearned(ocrOriginal: string | null, learned: boolean): string | null {
  if (!ocrOriginal && !learned) return ocrOriginal;
  const o = ocrOriginal ? (JSON.parse(ocrOriginal) as { inferred?: string[] }) : {};
  const inferred = new Set((o.inferred ?? []).filter((f) => f !== 'head'));
  if (learned) inferred.add('head');
  return JSON.stringify({ ...o, inferred: [...inferred] });
}
