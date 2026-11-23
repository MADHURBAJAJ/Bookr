// Readers for booking mails (23 Nov 2026). Each turns one mail into the bookings it carries. They are written from real
// sample mails of each sender, kept out of the code; the tests use invented mails in the same layout.
//
// Both senders send HTML mails built from tables, so a mail is first turned into its table rows (the innermost <tr>s,
// each a list of cell texts) and read row by row.
// - MakeMyTrip / Goibibo (Go-MMT "Host Voucher"): "New Booking Received for <hotel> on MakeMyTrip - NH…" and
//   "Cancellation received for Booking ID : NH…". No guest phone in these mails.
// - Djubo: "Reservation Confirmation / Cancellation - <HOTEL> - XOX…", one table row per room. Its daily reports and
//   "No Show" mails carry no booking and are left alone.
import type { Email } from 'postal-mime';

export interface ReadBooking {
  extRef: string;
  guestName?: string;
  phone?: string;
  roomType?: string;
  rooms?: number;
  guests?: number;
  checkIn?: string;   // YYYY-MM-DD
  checkOut?: string;
  amountPaise?: number;
  paidPaise?: number;
  cancelled?: boolean;
}

/** A phone from a mail: digits only, an Indian 91 or leading 0 dropped; null when it is not a usable number. */
export function phoneKeySoft(v: string | undefined | null): string | null {
  let d = (v ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length >= 6 && d.length <= 15 ? d : null;
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', bull: '•', ndash: '-', mdash: '-', rupee: '₹' };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : all; }
  return ENTITIES[e.toLowerCase()] ?? all;
});
const cellText = (s: string) => decode(s.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** The mail's table rows: each innermost <tr> as its non-empty cell texts. A mail with no HTML gives its text lines, split on "|" or tabs. */
export function mailRows(mail: Pick<Email, 'html' | 'text'>): string[][] {
  if (mail.html) {
    const h = mail.html.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
    return [...h.matchAll(/<tr[^>]*>((?:(?!<tr[\s>])[\s\S])*?)<\/tr>/gi)]
      .map((r) => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => cellText(c[1])).filter(Boolean))
      .filter((r) => r.length);
  }
  return (mail.text ?? '').split(/\r?\n/).map((l) => l.split(/\||\t/).map((c) => c.replace(/\s+/g, ' ').trim()).filter(Boolean)).filter((r) => r.length);
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** "23 Nov '26", "21 Nov, 2026" or "November 23, 2026" → 2026-11-23. */
export function dateOf(s: string | undefined): string | undefined {
  if (!s) return undefined;
  let m = /(\d{1,2})\s+([a-z]{3})[a-z]*,?\s+(?:'|’)?(\d{4}|\d{2})\b/i.exec(s);
  let d: string, mon: string, y: string;
  if (m) [, d, mon, y] = m;
  else { m = /([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})/i.exec(s); if (!m) return undefined; [, mon, d, y] = m; }
  const mi = MONTHS.indexOf(mon.toLowerCase());
  if (mi < 0) return undefined;
  const year = y.length === 2 ? `20${y}` : y;
  return `${year}-${String(mi + 1).padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/** "₹ 1,609.51" or "2,190.48" → paise. */
export function paiseOf(s: string | undefined): number | undefined {
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(s ?? '');
  if (!m) return undefined;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

// The room types at the hostel, as Djubo names them; MakeMyTrip's room names are matched to them by their words.
const ROOM_TYPES: [RegExp, string][] = [
  [/hexa\s*neo/i, 'Hexa Neo'],
  [/hexa/i, 'Hexa'],
  [/quad/i, 'Quad Sharing'],
  [/basic\s*premium/i, 'Basic Premium'],
  [/boutique/i, 'Boutique Rooms'],
  [/suite/i, 'Suite Room'],
  [/luxury/i, 'Luxury'],
  [/deluxe/i, 'Deluxe'],
  [/premium/i, 'Premium Rooms'],
];
/** A room name from a mail as the hostel's room type; an unknown name is kept as it is (the booking then waits for a person). */
export function roomTypeOf(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  return ROOM_TYPES.find(([re]) => re.test(n))?.[1] ?? n;
}
/** One type for the booking: the rooms' type when they are all the same, else the different types joined (a person sorts it out). */
const oneType = (types: string[]) => [...new Set(types)].join(', ') || undefined;

/** Adults and children in "2 Adults", "2 Adults, 1 Child", "1 Adult 2 Children". */
const peopleIn = (s: string) => [...s.matchAll(/(\d+)\s*(?:adults?|child(?:ren)?)\b/gi)].reduce((n, m) => n + Number(m[1]), 0);

// ---------- MakeMyTrip / Goibibo ----------

export function readMmt(mail: Email): ReadBooking[] {
  const subject = mail.subject ?? '';
  const rows = mailRows(mail);
  const flat = rows.map((r) => r.join(' | '));
  /** The row after a heading row ("Booking ID" then "NH…"). */
  const after = (re: RegExp) => { const i = flat.findIndex((l) => re.test(l)); return i >= 0 ? flat[i + 1] : undefined; };
  const ref = after(/^Booking ID$/i)?.match(/[A-Z]{2}\d{8,}/)?.[0] ?? /Booking ID\s*:?\s*([A-Z]{2}\d{8,})/i.exec(subject)?.[1] ?? / - ([A-Z]{2}\d{8,})\s*$/.exec(subject)?.[1];
  const looksLikeBooking = /new booking received|cancellation received|booking (modified|amended)|modification/i.test(subject);
  if (!ref) {
    if (looksLikeBooking) throw new Error('This MakeMyTrip mail did not have a Booking ID where expected; its layout may have changed.');
    return [];
  }
  const ciRow = rows.findIndex((r) => r.length >= 2 && /^check-?in$/i.test(r[0]) && /^check-?out$/i.test(r[1]));
  const dates = ciRow >= 0 ? rows[ciRow + 1] : undefined;
  const guestName = after(/^PRIMARY GUEST DETAILS$/i);
  // Rooms: "2 Room(s)" then a "1 x ROOM NAME" row and its "2 Adults • Room Only" row for each room.
  const roomsLine = flat.find((l) => /^\d+\s*Room\(s\)$/i.test(l));
  const types: string[] = [];
  let guests = 0;
  let roomCount = 0;
  for (let i = 0; i < flat.length; i++) {
    const m = /^(\d+)\s*x\s*(.*)$/i.exec(flat[i]);
    if (!m) continue;
    roomCount += Number(m[1]);
    if (m[2].trim()) types.push(roomTypeOf(m[2]));
    if (flat[i + 1] && /adult|child/i.test(flat[i + 1])) guests += peopleIn(flat[i + 1]) * Number(m[1]);
  }
  if (!guests) guests = peopleIn(after(/^TOTAL NO\. OF GUEST\(S\)$/i) ?? '');
  const status = after(/^Booking Status$/i) ?? '';
  const cancelled = /cancel/i.test(status) || /cancellation received/i.test(subject);
  const amountPaise = cancelled ? undefined : paiseOf(after(/^Property Gross Charges$/i));
  const pay = after(/^Payment Status$/i) ?? '';
  const paidPaise = amountPaise !== undefined && /paid online|prepaid/i.test(pay) && !/part/i.test(pay) ? amountPaise : undefined;
  return [{
    extRef: ref,
    guestName: guestName && !/^check-?in/i.test(guestName) ? guestName : undefined,
    roomType: oneType(types),
    rooms: Number(roomsLine?.match(/\d+/)?.[0]) || roomCount || undefined,
    guests: guests || undefined,
    checkIn: dateOf(dates?.[0]),
    checkOut: dateOf(dates?.[1]),
    amountPaise,
    paidPaise,
    cancelled,
  }];
}

// ---------- Djubo ----------

export function readDjubo(mail: Email): ReadBooking[] {
  const subject = mail.subject ?? '';
  if (/no show/i.test(subject)) return [];
  const rows = mailRows(mail);
  const flat = rows.map((r) => r.join(' | '));
  const head = flat.find((l) => /Reservation ID/i.test(l));
  const ref = head?.match(/Reservation ID\s*(?:##)?\s*([A-Z0-9-]+)/i)?.[1] ?? / - ([A-Z]{2,}\d{4,})\s*$/.exec(subject)?.[1];
  const looksLikeBooking = /^reservation\b/i.test(subject);
  if (!head || !ref) {
    if (looksLikeBooking) throw new Error('This Djubo mail did not have a Reservation ID where expected; its layout may have changed.');
    return [];
  }
  const field = (re: RegExp) => { const r = rows.find((x) => re.test(x[0])); return r ? r.slice(1).join(' ').replace(/^:\s*/, '').trim() || undefined : undefined; };
  const checkIn = dateOf(/Check in\s+(.+?)(?:Check out|$)/i.exec(head)?.[1]);
  const checkOut = dateOf(/Check out\s+(.+)$/i.exec(head)?.[1]);
  // The rooms table: a header row starting "S.No." then one row per room.
  const hi = rows.findIndex((r) => /^S\.?\s*No/i.test(r[0]));
  const header = hi >= 0 ? rows[hi].map((c) => c.toLowerCase()) : [];
  const col = (name: string) => header.findIndex((c) => c.startsWith(name));
  const [cRoom, cAdults, cChildren] = [col('rooms'), col('adults'), col('children')];
  const roomRows: string[][] = [];
  for (let i = hi + 1; hi >= 0 && i < rows.length && /^\d+$/.test(rows[i][0]) && rows[i].length >= header.length - 1; i++) roomRows.push(rows[i]);
  const types = roomRows.map((r) => roomTypeOf(r[cRoom] ?? ''));
  const guests = roomRows.reduce((n, r) => n + (Number(r[cAdults]) || 0) + (Number(r[cChildren]) || 0), 0);
  const money = (re: RegExp) => { const r = rows.find((x) => re.test(x[0])); return r ? paiseOf(r[r.length - 1]) : undefined; };
  const sub = money(/^Sub Total$/i);
  const taxes = money(/^Total Taxes$/i) ?? 0;
  const amountPaise = sub !== undefined ? sub + taxes : undefined;
  const paidPaise = money(/^Advance Amount$/i);
  const cancelled = /cancel/i.test(subject) || flat.some((l) => /CANCELLATION REMARK/i.test(l));
  return [{
    extRef: ref,
    guestName: field(/^Guest Name$/i),
    phone: field(/^Guest Contact No/i),
    roomType: oneType(types.filter(Boolean)),
    rooms: roomRows.length || undefined,
    guests: guests || undefined,
    checkIn,
    checkOut,
    amountPaise,
    paidPaise,
    cancelled,
  }];
}

const READERS: Record<'mmt' | 'djubo', (mail: Email) => ReadBooking[]> = {
  mmt: readMmt,
  djubo: readDjubo,
};

export const readerFor = (source: 'mmt' | 'djubo') => READERS[source];
/** Tests only: put a reader in place. */
export const setReader = (source: 'mmt' | 'djubo', fn: (mail: Email) => ReadBooking[]) => { READERS[source] = fn; };
