// Readers for booking mails (23 Nov 2026). Each turns one mail into the bookings it carries. They are written from real
// sample mails of each sender, kept out of the code; the tests use invented mails in the same layout.
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

const notYet = (who: string) => (): ReadBooking[] => {
  throw new Error(`The reader for ${who} mails is not written yet. The mail is kept; press "Read again" once it is.`);
};

const READERS: Record<'mmt' | 'djubo', (mail: Email) => ReadBooking[]> = {
  mmt: notYet('MakeMyTrip'),
  djubo: notYet('Djubo'),
};

export const readerFor = (source: 'mmt' | 'djubo') => READERS[source];
/** Tests only: put a reader in place. */
export const setReader = (source: 'mmt' | 'djubo', fn: (mail: Email) => ReadBooking[]) => { READERS[source] = fn; };
