// Payment proof list (24 Nov 2026): what a WhatsApp caption says about how a bill was paid. Staff caption the bill photo
// "cash", "cash pey950", "(3000 cash paid)", "Pay cash 6k upi 973", "pay cash 9500(discount 90)", "Cc" (card), usually
// with the bill number. Read from the Guest payment group's export, 15-24 Nov 2026. No Claude call: plain text rules.

export type CaptionMode = 'cash' | 'upi' | 'card';
export interface CaptionTender { mode: CaptionMode; amountPaise: number | null }
export interface CaptionReading {
  tenders: CaptionTender[];       // in the order written; amount null when none is written ("cash" alone: the whole bill)
  discountPaise: number | null;
  refs: string[];                 // what may be a bill number: "26112443", "C-2627-00043", "443"
}

const MODE_WORDS: [RegExp, CaptionMode][] = [
  [/^(cash|csh|cassh|kash)$/, 'cash'],
  [/^(upi|gpay|paytm|phonepe|phone ?pe|online|qr|scan)$/, 'upi'],
  [/^(card|cards|cc|c\/c|swipe|swiped|debit|credit ?card)$/, 'card'],
];
const DISCOUNT = /^(disc|discount|dis|less|off)$/;
// Words that sit between a mode and its amount: "cash pey 950", "cash paid 3000", "cash rs. 500", "cash: 500".
const FILLER = /^(pay|paid|pey|payed|payment|rs|inr|of|amt|amount|recd|received|recieved|by|in|=|:|-|₹)$/;
const POS_BILL = /^[a-z]{1,3}-\d{4}-\d{1,6}$/i;

type Tok = { t: string; num?: number; digits?: string };

function tokens(caption: string): Tok[] {
  const out: Tok[] = [];
  // "c/c" before splitting on "/"; Bookr POS bill numbers ("C-2627-00043") kept whole.
  const text = caption.toLowerCase().replace(/\bc\s*\/\s*c\b/g, ' cc ').replace(/₹/g, ' ₹ ');
  for (const m of text.matchAll(/[a-z]{1,3}-\d{4}-\d{1,6}|\d[\d,]*(?:\.\d{1,2})?k?|[a-z]+|[=:₹-]/g)) {
    const w = m[0];
    if (POS_BILL.test(w)) { out.push({ t: w.toUpperCase() }); continue; }
    const n = /^(\d[\d,]*(?:\.\d{1,2})?)(k?)$/.exec(w);
    if (n) {
      const digits = n[1].replace(/,/g, '');
      out.push({ t: w, digits, num: Math.round(Number(digits) * (n[2] ? 1000 : 1) * 100) });
    } else out.push({ t: w });
  }
  return out;
}

const modeOf = (t: string) => MODE_WORDS.find(([re]) => re.test(t))?.[1] ?? null;
/** An amount, not a bill number: up to 6 digits before any decimal point ("6k" counts). */
const isAmount = (k: Tok) => k.num != null && k.num > 0 && (k.digits ?? '').split('.')[0].length <= 6;

export function readCaption(caption: string | null): CaptionReading {
  const toks = tokens(caption ?? '');
  const used = new Set<number>();
  const near = (i: number, dir: 1 | -1): number | null => {
    for (let j = i + dir, skipped = 0; j >= 0 && j < toks.length && skipped <= 2; j += dir) {
      const k = toks[j];
      if (k.num != null) return isAmount(k) && !used.has(j) ? j : null;
      if (!FILLER.test(k.t)) return null;
      skipped++;
    }
    return null;
  };
  // Discounts first, so "9500(discount 90)" gives the 90 to the discount and not to a mode written after it.
  let discountPaise: number | null = null;
  toks.forEach((k, i) => {
    if (!DISCOUNT.test(k.t) || discountPaise != null) return;
    const j = near(i, 1) ?? near(i, -1);
    if (j != null) { used.add(j); discountPaise = toks[j].num!; }
  });
  // Amount before or after its mode word: "3000 cash" or "cash 3000". The caption's own order decides: when an amount
  // comes before the first mode word, amounts are written before their modes ("6000 cash 973 upi").
  const firstMode = toks.findIndex((k) => modeOf(k.t));
  const firstAmount = toks.findIndex((k, i) => isAmount(k) && !used.has(i));
  const before = firstMode >= 0 && firstAmount >= 0 && firstAmount < firstMode;
  const tenders: CaptionTender[] = [];
  toks.forEach((k, i) => {
    const mode = modeOf(k.t);
    if (!mode) return;
    const j = before ? near(i, -1) ?? near(i, 1) : near(i, 1) ?? near(i, -1);
    if (j != null) used.add(j);
    // "cash cash 500" or a mode written twice for one payment: one tender.
    const same = tenders.find((x) => x.mode === mode && (x.amountPaise == null || j == null));
    if (same) { if (same.amountPaise == null && j != null) same.amountPaise = toks[j].num!; return; }
    tenders.push({ mode, amountPaise: j != null ? toks[j].num! : null });
  });
  const refs = toks.filter((k, i) => !used.has(i) && (POS_BILL.test(k.t) || (k.digits && /^\d{3,}$/.test(k.digits)))).map((k) => k.digits ?? k.t);
  return { tenders, discountPaise, refs };
}
