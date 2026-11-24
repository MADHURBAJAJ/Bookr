// Payment proof list (24 Nov 2026): reading how a bill was paid from its WhatsApp caption. Captions are from the Guest
// payment group's export, 15-24 Nov 2026.
import { describe, expect, it } from 'vitest';
import { readCaption } from '../src/waCaption';

const r = (c: string) => readCaption(c);

describe('readCaption', () => {
  it('cash alone, and cash with its amount however it is written', () => {
    expect(r('cash')).toEqual({ tenders: [{ mode: 'cash', amountPaise: null }], discountPaise: null, refs: [] });
    expect(r('Cash').tenders).toEqual([{ mode: 'cash', amountPaise: null }]);
    expect(r('cash pey950').tenders).toEqual([{ mode: 'cash', amountPaise: 95000 }]);
    expect(r('(3000 cash paid)').tenders).toEqual([{ mode: 'cash', amountPaise: 300000 }]);
    expect(r('cash rs. 1,250').tenders).toEqual([{ mode: 'cash', amountPaise: 125000 }]);
  });

  it('a bill number in the caption is a reference, not an amount', () => {
    expect(r('Cash payment / 26112443')).toEqual({ tenders: [{ mode: 'cash', amountPaise: null }], discountPaise: null, refs: ['26112443'] });
    expect(r('26112443 cash 500')).toEqual({ tenders: [{ mode: 'cash', amountPaise: 50000 }], discountPaise: null, refs: ['26112443'] });
    expect(r('C-2627-00043 cash').refs).toEqual(['C-2627-00043']);
    expect(r('2611241').refs).toEqual(['2611241']);
  });

  it('split payments: each mode with its own amount, in either order', () => {
    expect(r('Pay cash 6k upi 973').tenders).toEqual([{ mode: 'cash', amountPaise: 600000 }, { mode: 'upi', amountPaise: 97300 }]);
    expect(r('6000 cash 973 upi').tenders).toEqual([{ mode: 'cash', amountPaise: 600000 }, { mode: 'upi', amountPaise: 97300 }]);
    expect(r('cash 2000 + gpay 1500').tenders).toEqual([{ mode: 'cash', amountPaise: 200000 }, { mode: 'upi', amountPaise: 150000 }]);
  });

  it('a discount is kept apart from the amount paid', () => {
    expect(r('pay cash 9500(discount 90)')).toEqual({ tenders: [{ mode: 'cash', amountPaise: 950000 }], discountPaise: 9000, refs: [] });
    expect(r('disc 200 cash 1800').tenders).toEqual([{ mode: 'cash', amountPaise: 180000 }]);
  });

  it('card: "Cc", "c/c", "card"', () => {
    expect(r('Cc').tenders).toEqual([{ mode: 'card', amountPaise: null }]);
    expect(r('c/c 2400').tenders).toEqual([{ mode: 'card', amountPaise: 240000 }]);
    expect(r('card 26112450').tenders).toEqual([{ mode: 'card', amountPaise: null }]);
  });

  it('nothing about payment: no tenders', () => {
    expect(r('')).toEqual({ tenders: [], discountPaise: null, refs: [] });
    expect(r('table 6 bill')).toEqual({ tenders: [], discountPaise: null, refs: [] });
  });
});
