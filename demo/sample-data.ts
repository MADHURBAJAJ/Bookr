// Invented sample data for tests and the demo site. None of it comes from a real business.
// The CSV follows the hotel software's format described in docs/phase2-context.md.

export interface SampleBill {
  pos: string;
  bill: string;
  when: string;            // DD-MM-YYYY.HH:MM:SS, India time
  name: string;            // invented; must never be stored
  mode: 'UPI' | 'CARD' | 'CASH' | 'U/N';
  amount: string;          // rupees as printed
}

const toPaise = (rupees: string) => {
  const [r, p = ''] = rupees.replace(/,/g, '').split('.');
  return Number(r) * 100 + Number(p.padEnd(2, '0'));
};
const fmt = (paise: number) => (paise % 100 ? `${Math.trunc(paise / 100)}.${String(paise % 100).padStart(2, '0')}` : String(paise / 100));
const q = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** A CSV in the software's layout: header, bill rows, blank lines, then the footer control total. */
export function buildSalesCsv(bills: SampleBill[], opts: { breakFooter?: 'count' | 'upi' } = {}): string {
  const lines = ['SI.NO,POS.NO,DATE/TIME,BILL NO,NAME,SUBSIDY,MODE OF PAYMENT,BILL AMOUNT,DISCOUNT'];
  bills.forEach((b, i) => lines.push([String(i + 1), b.pos, b.when, b.bill, q(b.name), '0', b.mode, b.amount, '0'].join(',')));
  const sum = (mode?: string) => bills.filter((b) => !mode || b.mode === mode).reduce((s, b) => s + toPaise(b.amount), 0);
  lines.push('', '');
  lines.push(`,,TOTAL BILLS,${bills.length + (opts.breakFooter === 'count' ? 1 : 0)}`);
  lines.push(`,,UPI,${fmt(sum('UPI') + (opts.breakFooter === 'upi' ? 100 : 0))}`);
  lines.push(`,,CARD,${fmt(sum('CARD'))}`);
  lines.push(`,,CASH,${fmt(sum('CASH'))}`);
  lines.push(`,,TOTAL SALE,${fmt(sum())}`);
  return lines.join('\r\n') + '\r\n';
}

// Report printed on 31 Oct: 00:00 to 23:59 that day. The first three bills belong to the 30 Oct shift.
export const REPORT_31_OCT: SampleBill[] = [
  { pos: 'POS-1', bill: '2610307', when: '31-10-2026.00:20:11', name: 'U/N', mode: 'CASH', amount: '240' },
  { pos: 'POS-1', bill: '2610308', when: '31-10-2026.01:05:40', name: 'U/N', mode: 'UPI', amount: '860' },
  { pos: 'POS-1', bill: '2610309', when: '31-10-2026.06:55:02', name: 'U/N', mode: 'UPI', amount: '310' },
  { pos: 'POS-1', bill: '26103010', when: '31-10-2026.08:42:15', name: 'U/N', mode: 'UPI', amount: '1250' }, // 30 Oct number, paid 31 Oct
  { pos: 'POS-1', bill: '2610311', when: '31-10-2026.09:17:38', name: 'U/N', mode: 'UPI', amount: '420' },
  { pos: 'POS-1', bill: '2610312', when: '31-10-2026.10:05:12', name: 'U/N', mode: 'CASH', amount: '380' },
  { pos: 'POS-1', bill: '2610313', when: '31-10-2026.11:30:45', name: 'U/N', mode: 'CARD', amount: '942' },
  { pos: 'POS-1', bill: '2610314', when: '31-10-2026.12:10:03', name: 'Asha Rao, Room 4', mode: 'UPI', amount: '1180' },
  { pos: 'POS-1', bill: '26103115', when: '31-10-2026.12:57:20', name: 'U/N', mode: 'UPI', amount: '403' },
  { pos: 'POS-1', bill: '2610316', when: '31-10-2026.13:02:10', name: 'U/N', mode: 'CASH', amount: '0' }, // complimentary
  { pos: 'POS-1', bill: '2610317', when: '31-10-2026.13:07:44', name: 'U/N', mode: 'UPI', amount: '4410' },
  { pos: 'POS-1', bill: '2610318', when: '31-10-2026.15:20:00', name: 'U/N', mode: 'U/N', amount: '650' },
  { pos: 'POS-1', bill: '2610319', when: '31-10-2026.17:35:09', name: 'U/N', mode: 'CASH', amount: '353' },
  { pos: 'POS-1', bill: '26103120', when: '31-10-2026.19:48:30', name: 'Vikram Nair', mode: 'UPI', amount: '2560' },
  { pos: 'POS-1', bill: '26103121', when: '31-10-2026.21:15:00', name: 'U/N', mode: 'CASH', amount: '1240.50' },
  { pos: 'POS-1', bill: '26103122', when: '31-10-2026.23:40:55', name: 'U/N', mode: 'UPI', amount: '780' },
];

// Report printed on 1 Nov, 00:00 to 08:00: completes the 31 Oct shift.
export const REPORT_1_NOV_EARLY: SampleBill[] = [
  { pos: 'POS-1', bill: '26103123', when: '01-11-2026.00:35:10', name: 'U/N', mode: 'CASH', amount: '560' },
  { pos: 'POS-1', bill: '26103124', when: '01-11-2026.02:10:00', name: 'U/N', mode: 'UPI', amount: '990' },
  { pos: 'POS-1', bill: '2611011', when: '01-11-2026.07:58:30', name: 'U/N', mode: 'CASH', amount: '220' },
];

export interface SampleRegisterRow {
  billNo: string;
  billType: 'fnb' | 'room';
  amount: string;
  payments: { mode: 'cash' | 'upi' | 'card'; columnLabel: string; amount: string }[];
  remarks?: string;
}

const pay = (mode: 'cash' | 'upi' | 'card', amount: string, columnLabel = mode === 'cash' ? 'Cash' : mode === 'card' ? 'Card' : 'UPI XOXO') => ({ mode, columnLabel, amount });

// The handwritten register for the 31 Oct shift, as typed in from the page.
// Differences on purpose: 26103115 mode, 2610317 amount, 2610318 unknown mode in software,
// 2610319 missing here, 26103120 part cash part UPI, 26103125 missing in the software.
export const REGISTER_31_OCT: SampleRegisterRow[] = [
  { billNo: '26103010', billType: 'room', amount: '1250', payments: [pay('upi', '1250', 'UPI Bank 2')] },
  { billNo: '2610311', billType: 'fnb', amount: '420', payments: [pay('upi', '420')] },
  { billNo: '2610312', billType: 'fnb', amount: '380', payments: [pay('cash', '380')] },
  { billNo: '2610313', billType: 'room', amount: '942', payments: [pay('card', '942')] },
  { billNo: '2610314', billType: 'fnb', amount: '1180', payments: [pay('upi', '1180')] },
  { billNo: '26103115', billType: 'fnb', amount: '403', payments: [pay('cash', '403')] },
  { billNo: '2610316', billType: 'fnb', amount: '0', payments: [], remarks: 'Complimentary' },
  { billNo: '2610317', billType: 'fnb', amount: '4140', payments: [pay('upi', '4140')] },
  { billNo: '2610318', billType: 'fnb', amount: '650', payments: [pay('upi', '650', 'UPI Bank 2')] },
  { billNo: '26103120', billType: 'room', amount: '2560', payments: [pay('cash', '1000'), pay('upi', '1560')] },
  { billNo: '26103121', billType: 'fnb', amount: '1240.50', payments: [pay('cash', '1240.50')] },
  { billNo: '26103122', billType: 'fnb', amount: '780', payments: [pay('upi', '780')] },
  { billNo: '26103123', billType: 'fnb', amount: '560', payments: [pay('cash', '560')] },
  { billNo: '26103124', billType: 'room', amount: '990', payments: [pay('upi', '990', 'UPI Bank 2')] },
  { billNo: '2611011', billType: 'fnb', amount: '220', payments: [pay('cash', '220')] },
  { billNo: '26103125', billType: 'fnb', amount: '500', payments: [pay('cash', '500')], remarks: 'Late bill' },
];

export const EXPENSES_31_OCT = [
  { narration: 'Vegetables', amount: '1240', head: 'Purchases' },
  { narration: 'Gas cylinder', amount: '1100', head: 'Utilities' },
  { narration: 'Auto fare', amount: '150', head: null },
  { narration: 'Laundry', amount: '420', head: null },
];

export const CASH_SUMMARY_31_OCT = {
  opening: '8400', received: '2400.50', balance: '10800.50', expenses: '2910', cashInHand: '7890.50',
};
