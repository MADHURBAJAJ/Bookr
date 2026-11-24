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
  /** MakeMyTrip / Goibibo booking number (NH…, GH…): the booking's own on an OTA mail, the linked one on a Djubo mail. */
  otaRef?: string;
  /** The OTA's PNR (Djubo calls it Reference ID). */
  pnr?: string;
  /** Djubo's room / bed numbers ("II B"), when rooms are allotted. */
  roomLabels?: string[];
  channel?: string;
  /** Djubo could not place this OTA booking on its room chart: a person must create it in Djubo by hand. */
  unplaced?: boolean;
  /** When the booking was made and last changed, as the mail says it (India time, 'YYYY-MM-DD HH:MM'). */
  bookedAt?: string;
  changedAt?: string;
  mealPlan?: string;
  /** The guest's special requests (the OTA's own booking numbers, which Djubo puts there too, left out). */
  requests?: string;
  /** Who made or last changed the booking in Djubo ("Suresh Ramoda"); "System" for an OTA's. */
  enteredBy?: string;
  /** A website booking Djubo holds until it is paid ("Reservation Hold"): not confirmed yet. */
  hold?: boolean;
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

/** "23 Nov, 2026 15:51" → '2026-11-23 15:51' (India time, as the mail says it); a date alone keeps its date. */
export function stampOf(s: string | undefined): string | undefined {
  const d = dateOf(s);
  if (!d) return undefined;
  const t = /(\d{1,2}):(\d{2})/.exec(s!.replace(/^.*?\d{4}/, ''));
  return t ? `${d} ${t[1].padStart(2, '0')}:${t[2]}` : d;
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
  const pnr = after(/^PNR$/i)?.match(/\d{6,}/)?.[0];
  return [{
    extRef: ref,
    otaRef: ref,
    pnr,
    channel: after(/^Booked Via$/i) ?? undefined,
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
  if (/continuous room|unable to generate|unable to (create|modify)/i.test(subject)) return readDjuboUnplaced(mail);
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
  const [cRoom, cAdults, cChildren, cMeal] = [col('rooms'), col('adults'), col('children'), col('meal')];
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
  const all = flat.join(' | ');
  const cLabel = header.findIndex((c) => /^rooms\s*no/.test(c));
  const labels = cLabel >= 0 ? roomRows.map((r) => (r[cLabel] ?? '').trim()).filter((x) => x && !/^x$/i.test(x) && !/^-+$/.test(x)) : [];
  const type = /Type of Reservation:\s*([A-Za-z ]+?)(?:\s*\||$)/i.exec(all)?.[1]?.trim();
  const meals = cMeal >= 0 ? [...new Set(roomRows.map((r) => (r[cMeal] ?? '').trim()).filter(Boolean))] : [];
  const requests = /SPECIAL REQUESTS\s*(.*?)\s*(?:\|\s*)?(?:Modified By|Created By|Type of Reservation|$)/i.exec(all)?.[1]
    ?.replace(/Booking Reference No\.?:?\s*\S*/gi, '').replace(/Vendor Booking Id:?\s*\S*/gi, '').replace(/^[\s|#:-]+|[\s|#:-]+$/g, '').replace(/\s*\|\s*/g, ' ').trim();
  return [{
    enteredBy: (/Modified By:?\s*(.+?)\s*Modified On/i.exec(all)?.[1] ?? /Created By:?\s*(.+?)\s*Created On/i.exec(all)?.[1])?.replace(/\s*\|.*$/, '').trim().slice(0, 60) || undefined,
    hold: /reservation hold/i.test(subject) || undefined,
    bookedAt: stampOf(/Created On:?\s*([^|]+?)(?:\s*\||$)/i.exec(all)?.[1]),
    changedAt: stampOf(/Modified On:?\s*([^|]+?)(?:\s*\||$)/i.exec(all)?.[1]),
    mealPlan: meals.join(', ').slice(0, 60) || undefined,
    requests: requests ? requests.slice(0, 300) : undefined,
    extRef: ref,
    pnr: /Reference ID\s*(\d{6,})/i.exec(head)?.[1],
    otaRef: /Vendor Booking Id:?\s*([A-Z]{2}\d{8,})/i.exec(all)?.[1],
    roomLabels: labels.length ? labels : undefined,
    channel: field(/^Company Name$/i) ?? type,
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

/**
 * Djubo's "ATTENTION - Continuous Room(s) unavailable - System Unable to generate/modify Automated Reservation for <OTA>
 * Booking Ref No <PNR>": an OTA booking Djubo could not place. Read as an alert booking (ALERT-<PNR>) for a person.
 */
function readDjuboUnplaced(mail: Email): ReadBooking[] {
  const rows = mailRows(mail);
  const val = (re: RegExp) => { const r = rows.find((x) => re.test(x[0])); return r ? r.slice(1).join(' ').replace(/^:\s*/, '').trim() || undefined : undefined; };
  const pnr = val(/^Booking Reference Number/i)?.match(/\d{6,}/)?.[0] ?? /Booking Ref No\.?\s*(\d{6,})/i.exec(mail.subject ?? '')?.[1];
  if (!pnr) throw new Error('This Djubo alert did not have a Booking Reference Number where expected; its layout may have changed.');
  const hi = rows.findIndex((r) => /^S\.?\s*No/i.test(r[0]));
  const types: string[] = [];
  let rooms = 0;
  for (let i = hi + 1; hi >= 0 && i < rows.length && /^\d+$/.test(rows[i][0]); i++) { types.push(roomTypeOf(rows[i][1] ?? '')); rooms += Number(rows[i][2]) || 1; }
  return [{
    extRef: `ALERT-${pnr}`,
    pnr,
    unplaced: true,
    channel: val(/^Agency Name/i),
    guestName: val(/^Guest Name/i),
    phone: val(/^Guest Mobile/i),
    checkIn: dateOf(val(/^Arrival Date/i)),
    checkOut: dateOf(val(/^Departure Date/i)),
    amountPaise: paiseOf(val(/^Total Amount/i)),
    guests: Number(val(/^Number of Pax/i)) || undefined,
    roomType: oneType(types.filter(Boolean)),
    rooms: rooms || undefined,
  }];
}

const READERS: Record<'mmt' | 'djubo', (mail: Email) => ReadBooking[]> = {
  mmt: readMmt,
  djubo: readDjubo,
};

export const readerFor = (source: 'mmt' | 'djubo') => READERS[source];
/** Tests only: put a reader in place. */
export const setReader = (source: 'mmt' | 'djubo', fn: (mail: Email) => ReadBooking[]) => { READERS[source] = fn; };

// ---------- Djubo's daily reports (24 Nov 2026) ----------
// "XOXO HOSTEL: Daily Front Office Report - 24 Nov, 2026": sections (Today's Confirm Check-In, Staying Over, Today's
// Check-Out, holds, Yesterday No Show), each with channel rows ("Direct", "MAKE MY TRIP") and one row per booking:
// number (and the OTA's), guest (the channel's name after it), "TYPE X n", pax, "EP X n", check-in, check-out, outstanding.
// "XOXO HOSTEL: Daily Occupied Rooms Report - …": one row per room or bed: room, "guest NUMBER", status, dates, A/C/I, meal.
// Neither has a phone or the total amount.

export interface ReportBooking { section: 'arriving' | 'staying' | 'leaving' | 'noshow' | 'other'; extRef: string; pnr?: string; guestName?: string; channel?: string;
  roomType?: string; rooms?: number; guests?: number; mealPlan?: string; checkIn?: string; checkOut?: string; duePaise?: number }
export interface ReportRoom { room: string; extRef: string; guestName?: string; status: 'arriving' | 'staying' | 'leaving' | 'other'; checkIn?: string; checkOut?: string; adults?: number }
export type DjuboReport = { kind: 'front'; day: string; bookings: ReportBooking[] } | { kind: 'rooms'; day: string; rooms: ReportRoom[] };

const looseDate = (s: string | undefined) => dateOf((s ?? '').replace(/-/g, ' '));
const REF = /^([A-Z]{2,}\d{5,})(?:\s*\(([^)]+)\))?/;

/** A Djubo daily report this POS uses, or null for any other mail. */
export function readDjuboReport(mail: Pick<Email, 'subject' | 'html' | 'text'>): DjuboReport | null {
  const subject = mail.subject ?? '';
  const day = looseDate(/-\s*(\d{1,2}\s+[A-Za-z]{3},?\s+\d{4})\s*$/.exec(subject)?.[1]);
  if (!day) return null;
  const rows = mailRows(mail);
  if (/Daily Front Office Report/i.test(subject)) {
    let section: ReportBooking['section'] = 'other';
    let channel: string | undefined;
    const out: ReportBooking[] = [];
    for (const r of rows) {
      const line = r.join(' ');
      if (/Confirm Check-?In\s*:/i.test(line)) { section = 'arriving'; continue; }
      if (/Staying Over\s*:/i.test(line)) { section = 'staying'; continue; }
      if (/Today'?s Check-?Out\s*:/i.test(line)) { section = 'leaving'; continue; }
      if (/No Show Booking\s*:/i.test(line)) { section = 'noshow'; continue; }
      if (/(Hold|Enquiry)[^:]*:\s*\d+ Bookings/i.test(line)) { section = 'other'; continue; }
      if (r.length === 1 && !REF.test(r[0]) && /^[A-Za-z .&-]{3,40}$/.test(r[0])) { channel = r[0].trim(); continue; }
      const m = REF.exec(r[0] ?? '');
      if (!m || r.length < 7) continue;
      const [, extRef, ota] = m;
      const typeCell = r[2] ?? '';
      const tm = /^(.*?)\s+X\s+(\d+)\s*$/i.exec(typeCell);
      const guest = (r[1] ?? '').replace(new RegExp(`\\s*${(channel ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '').trim();
      out.push({ section, extRef, pnr: ota && /^\d{6,}$/.test(ota.trim()) ? ota.trim() : undefined, guestName: guest || undefined, channel,
        roomType: tm ? roomTypeOf(tm[1]) : typeCell ? roomTypeOf(typeCell) : undefined, rooms: tm ? Number(tm[2]) : undefined,
        guests: Number(r[3]) || undefined, mealPlan: (r[4] ?? '').replace(/\s+X\s+\d+$/i, '').trim() || undefined,
        checkIn: looseDate(r[5]), checkOut: looseDate(r[6]), duePaise: paiseOf(r[7]) });
    }
    return { kind: 'front', day, bookings: out };
  }
  if (/Daily Occupied Rooms Report|Rooms Status Report/i.test(subject)) {
    const out: ReportRoom[] = [];
    for (const r of rows) {
      const m = /^(.*?)\s*([A-Z]{2,}\d{5,})\s*$/.exec(r[1] ?? '');
      if (!m || r.length < 5) continue;
      const st = (r[2] ?? '').toLowerCase();
      out.push({ room: r[0].trim(), extRef: m[2], guestName: m[1].trim() || undefined,
        status: /check-?in/.test(st) ? 'arriving' : /stay/.test(st) ? 'staying' : /check-?out/.test(st) ? 'leaving' : 'other',
        checkIn: looseDate(r[3]), checkOut: looseDate(r[4]), adults: Number(r[5]) || undefined });
    }
    return { kind: 'rooms', day, rooms: out };
  }
  return null;
}
