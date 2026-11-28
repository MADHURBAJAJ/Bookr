// Payment proof list (24 Nov 2026): matching the shift's POS bills to what staff post in the Guest payment group.
import { describe, expect, it } from 'vitest';
import { billsNamed, matchProof, type ProofBill, type ProofItem, type ProofTender } from '../src/posProof';
import { istToMs } from '../src/time';

const at = (h: number, m: number) => istToMs(2026, 11, 24, h, m);
const FROM = at(8, 0), TO = FROM + 86400_000;
let n = 0;
const tender = (mode: ProofTender['mode'], rupees: number, paidAt: number, over: Partial<ProofTender> = {}): ProofTender =>
  ({ paymentId: `pay${++n}`, mode, amountPaise: rupees * 100, totalPaise: rupees * 100, paidAt, ...over });
const bill = (no: string, rupees: number, tenders: ProofTender[], over: Partial<ProofBill> = {}): ProofBill =>
  ({ key: `b-${no}`, billNo: no, kind: 'bill', state: 'settled', totalPaise: rupees * 100, discountPaise: 0, at: tenders[0]?.paidAt ?? at(12, 0), label: null, tenders, ...over });
const item = (id: string, kind: ProofItem['kind'], over: Partial<ProofItem> = {}): ProofItem =>
  ({ id, kind, amountPaise: null, billNo: null, cardApproval: null, caption: null, sentAt: at(12, 0), messageId: `m-${id}`, replyTo: null, sender: 'Reception', ...over });
const run = (bills: ProofBill[], items: ProofItem[], pairs: [string, string][] = []) => matchProof(bills, items, pairs, FROM, TO);

describe('billsNamed', () => {
  const bills = [bill('C261124007', 100, []), bill('C261124012', 100, []), bill('H261124012', 100, [])];
  it('the full number, with or without the letter; the running number when only one bill has it', () => {
    expect(billsNamed('C261124007', bills).map((b) => b.billNo)).toEqual(['C261124007']);
    expect(billsNamed('261124007', bills).map((b) => b.billNo)).toEqual(['C261124007']);
    expect(billsNamed('007', bills).map((b) => b.billNo)).toEqual(['C261124007']);
    expect(billsNamed('012', bills)).toEqual([]); // two billing names have a 12th bill today
    expect(billsNamed('261124099', bills)).toEqual([]);
  });
});

describe('matchProof', () => {
  it('a UPI screenshot captioned with the bill number, and its bill photo sent as a reply: matched', () => {
    const r = run([bill('C261124007', 2497, [tender('upi', 2497, at(12, 0))])], [
      item('u', 'upi', { amountPaise: 249700, caption: '261124007' }),
      item('p', 'bill', { amountPaise: 249700, billNo: 'C261124007', replyTo: 'm-u', sentAt: at(12, 1) }),
    ]);
    expect(r.rows[0]).toMatchObject({ status: 'matched', differences: [], missing: [] });
    expect(r.rows[0].proof.map((e) => e.itemId).sort()).toEqual(['p', 'u']);
    expect(r.extras).toEqual([]);
  });

  it('cash: the bill photo captioned "cash"; its amount checked when written', () => {
    const b = [bill('C261124001', 950, [tender('cash', 950, at(10, 0))]), bill('C261124002', 3000, [tender('cash', 3000, at(11, 0))])];
    const r = run(b, [
      item('a', 'bill', { billNo: 'C261124001', amountPaise: 95000, caption: 'cash pey950' }),
      item('b', 'bill', { billNo: 'C261124002', amountPaise: 300000, caption: '(2800 cash paid)' }),
    ]);
    expect(r.rows.map((x) => x.status)).toEqual(['matched', 'difference']);
    expect(r.rows[1].differences).toEqual(['Cash ₹2,800 in caption, settled ₹3,000 cash']);
  });

  it('no proof yet: red when settled, amber (waiting) when only printed', () => {
    const r = run([bill('C261124003', 500, [tender('upi', 500, at(12, 0))]), bill('C261124004', 800, [], { state: 'printed', at: at(12, 5) })], []);
    expect(r.rows.map((x) => [x.status, x.missing])).toEqual([['missing', ['No UPI screenshot']], ['waiting', []]]);
  });

  it('a UPI screenshot with no bill number finds its payment by amount and time', () => {
    const r = run([bill('C261124005', 1200, [tender('upi', 1200, at(13, 0))]), bill('C261124006', 1200, [tender('upi', 1200, at(18, 0))])], [
      item('u', 'upi', { amountPaise: 120000, sentAt: at(13, 4) }),
    ]);
    expect(r.rows.map((x) => x.status)).toEqual(['matched', 'missing']);
    expect(r.rows[0].proof[0].how).toBe('same amount and time');
  });

  it('two posts that fit one payment equally well are both left for a person', () => {
    const r = run([bill('C261124005', 1200, [tender('upi', 1200, at(13, 0))])], [
      item('u1', 'upi', { amountPaise: 120000, sentAt: at(13, 5) }),
      item('u2', 'upi', { amountPaise: 120000, sentAt: at(12, 55) }),
    ]);
    expect(r.rows[0].status).toBe('missing');
    expect(r.extras.map((e) => e.what)).toEqual(['UPI ₹1,200, no POS bill', 'UPI ₹1,200, no POS bill']);
  });

  it('differences: paid less by UPI, posted UPI but settled cash, a different discount', () => {
    const r = run([
      bill('C261124010', 1000, [tender('upi', 1000, at(14, 0))]),
      bill('C261124011', 700, [tender('cash', 700, at(14, 30))]),
      bill('C261124012', 9500, [tender('cash', 9500, at(15, 0))], { discountPaise: 5000 }),
    ], [
      item('u', 'upi', { amountPaise: 99900, caption: 'C261124010' }),
      item('v', 'upi', { amountPaise: 70000, caption: '261124011' }),
      item('w', 'bill', { billNo: 'C261124012', amountPaise: 950000, caption: 'pay cash 9500(discount 90)' }),
    ]);
    expect(r.rows.map((x) => x.differences)).toEqual([
      ['UPI ₹999 posted, settled ₹1,000 UPI'],
      ['UPI screenshot ₹700 posted, settled as cash'],
      ['Discount ₹90 in caption, ₹50 on the bill'],
    ]);
    expect(r.rows[1].missing).toEqual(['No cash note']);
  });

  it('a split bill: cash in the caption and a UPI screenshot for the rest', () => {
    const r = run([bill('C261124020', 6973, [tender('cash', 6000, at(20, 0)), tender('upi', 973, at(20, 0))])], [
      item('p', 'bill', { billNo: 'C261124020', amountPaise: 697300, caption: 'Pay cash 6k upi 973' }),
      item('u', 'upi', { amountPaise: 97300, replyTo: 'm-p', sentAt: at(20, 2) }),
    ]);
    expect(r.rows[0]).toMatchObject({ status: 'matched', modes: [{ mode: 'cash', amountPaise: 600000 }, { mode: 'upi', amountPaise: 97300 }] });
  });

  it('a card slip by the approval code the cashier typed', () => {
    const r = run([bill('C261124030', 2400, [tender('card', 2400, at(21, 0), { cardApproval: 'A1B2C3' })])], [
      item('c', 'card', { amountPaise: 240000, cardApproval: 'a1b2c3', sentAt: at(23, 50) }),
    ]);
    expect(r.rows[0]).toMatchObject({ status: 'matched', proof: [{ itemId: 'c', how: 'approval code' }] });
  });

  it('an old screenshot posted again for a new bill is a difference; one paid just before the bill is not', () => {
    const r = run([bill('C261124060', 262, [tender('upi', 262, at(19, 50))], { at: at(19, 48) }), bill('C261124061', 300, [tender('upi', 300, at(19, 50))], { at: at(19, 48) })], [
      item('old', 'upi', { amountPaise: 26200, caption: 'C261124060', sentAt: at(19, 57), docAt: istToMs(2026, 11, 13, 22, 30) }),
      item('new', 'upi', { amountPaise: 30000, caption: 'C261124061', sentAt: at(19, 57), docAt: at(19, 30) }),
    ]);
    expect(r.rows.map((x) => [x.status, x.differences])).toEqual([
      ['difference', ['Screenshot is from 13 Nov, 10:30 pm, before the bill']], ['matched', []]]);
  });

  it('proof posted after 8 am for a bill of the shift before: not an extra, listed under earlier bills (C261128017, 28 Nov)', () => {
    const next = at(8, 0) + 86400_000; // the 25 Nov shift in these tests starts here
    const prev = bill('C261125017', 368, [tender('upi', 368, next - 11 * 60_000)], { at: next - 11 * 60_000, context: true, shiftDay: '2026-11-24' });
    const r = matchProof([prev], [
      item('u', 'upi', { amountPaise: 36000, sentAt: next + 35 * 60_000, replyTo: null }),
      item('p', 'bill', { amountPaise: 36800, billNo: 'C261125017', caption: 'C261125017', replyTo: 'm-u', sentAt: next + 36 * 60_000 }),
    ], [], next, next + 86400_000);
    expect(r.rows).toEqual([]);
    expect(r.extras).toEqual([]);
    expect(r.earlier.map((x) => [x.billNo, x.shiftDay, x.status, x.differences])).toEqual([
      ['C261125017', '2026-11-24', 'difference', ['UPI ₹360 posted, settled ₹368 UPI']]]);
    // On the bill's own shift it is a row as before, and nothing is listed as earlier.
    const own = run([{ ...prev, context: false }], [item('u', 'upi', { amountPaise: 36000, sentAt: next + 35 * 60_000, caption: 'C261125017' })]);
    expect(own.rows[0].status).toBe('difference');
    expect(own.earlier).toEqual([]);
  });

  it('one UPI for two bills settled as two payments is checked against both together (₹946 = ₹902 + ₹44)', () => {
    const r = run([
      bill('C261124024', 902, [tender('upi', 902, at(8, 30))], { context: true, shiftDay: '2026-11-23' }),
      bill('C261124037', 44, [tender('upi', 44, at(8, 37))]),
    ], [
      item('u', 'upi', { amountPaise: 94600, sentAt: at(8, 38) }),
      item('p', 'bill', { amountPaise: 90200, billNo: 'C261124024', caption: 'C261124024 C261124037', replyTo: 'm-u', sentAt: at(8, 39) }),
    ]);
    expect(r.rows.map((x) => [x.billNo, x.status, x.differences])).toEqual([['C261124037', 'matched', []]]);
    expect(r.earlier.map((x) => [x.billNo, x.status])).toEqual([['C261124024', 'matched']]);
    // Paid ₹10 less than both together: said once, naming both bills.
    const less = run([bill('C261124024', 902, [tender('upi', 902, at(8, 30))]), bill('C261124037', 44, [tender('upi', 44, at(8, 37))])], [
      item('u', 'upi', { amountPaise: 93600, caption: 'C261124024 C261124037', sentAt: at(8, 38) })]);
    expect(less.rows[1].differences).toEqual(['UPI ₹936 posted, settled ₹946 UPI for C261124024 + C261124037']);
  });

  it('room and credit bills need no proof', () => {
    const r = run([bill('C261124040', 1500, [tender('room', 1500, at(9, 0))])], []);
    expect(r.rows[0].status).toBe('not_needed');
  });

  it('one UPI payment for two bills paid together proves both', () => {
    const t1 = tender('upi', 600, at(16, 0), { paymentId: 'shared', totalPaise: 100000 });
    const t2 = { ...t1, amountPaise: 40000 };
    const r = run([bill('C261124050', 600, [t1]), bill('C261124051', 400, [t2])], [item('u', 'upi', { amountPaise: 100000, sentAt: at(16, 3) })]);
    expect(r.rows.map((x) => x.status)).toEqual(['matched', 'matched']);
  });

  it('extras: a UPI with no bill, and a cash bill photo the POS does not have; other photos are left out', () => {
    const r = run([], [
      item('u', 'upi', { amountPaise: 50000, sentAt: at(9, 0), caption: 'room 12' }),
      item('p', 'bill', { billNo: '26112443', amountPaise: 120000, caption: 'cash', sentAt: at(10, 0) }),
      item('o', 'other', { sentAt: at(11, 0) }),
      item('y', 'upi', { amountPaise: 10000, sentAt: FROM - 60_000 }), // the shift before
    ]);
    expect(r.extras.map((e) => e.what)).toEqual(['UPI ₹500, no POS bill', 'Cash bill 26112443 ₹1,200, not in the POS']);
  });
});
