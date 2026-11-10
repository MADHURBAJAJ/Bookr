// Card company charges on the card report (11 Nov 2026): a monthly service fee and a settlement charge come as negative
// lines with GST. They are not refunds and not left to do; settling the day books them with the fee, so the books
// equal the bank. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { at, hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('card company charges', () => {
  it('books the service fee and settlement charge as fees when the day is settled', async () => {
    const h = await hotel();
    const acc = await h.account('HUF A', 'UPI XOXO');
    const o = h.clients.owner;
    const base = `/businesses/${h.bid}`;
    await h.swipe('1 13:00', 1000, 'VISA', { feePaise: 2000, gstPaise: 360 });
    for (const [type, amount, gst] of [['MONTHLY SERVICE FEE', -5000, 900], ['SETTLEMENT CHARGE', -2900, 522]] as const) {
      const id = crypto.randomUUID();
      await sql`INSERT INTO card_settlements (id, business_id, file_name, settled_on, merchant_id, terminal_id, txn_id, paid_at, txn_type, amount_paise, fee_paise, gst_paise,
        net_paise, created_at) VALUES (${id}, ${h.bid}, 'x_ICICI_POS_CD.xlsx', '2026-11-02', 'M1', 'TT000001', ${'TT_' + id}, ${at('1 23:00').ms}, ${type},
        ${amount}, 0, ${gst}, ${amount - gst}, ${Date.now()})`;
    }
    // Net: 1000 − 20 − 3.60 − 59 − 34.22 = ₹883.18
    const net = 100000 - 2000 - 360 - 5900 - 3422;
    // Not a refund, nothing to do on the shift.
    // Unsaved shift (card trial) and saved shift (card picture): no "refund or void" left to do.
    const notPurchase = async () => {
      const r = (await o.get(`${base}/shifts/2026-11-01/reconcile`)).json;
      expect(r.cards, JSON.stringify(Object.keys(r))).toBeTruthy();
      return JSON.stringify(r.cards).match(/not_purchase/g)?.length ?? 0;
    };
    expect(await notPurchase()).toBe(0);
    const v = (await o.get(`${base}/cards?from=2026-11-01&to=2026-11-03`)).json;
    expect(v.settlements[0]).toMatchObject({ amountPaise: 100000, feePaise: 2000 + 5000 + 2900, chargesPaise: 7900, gstPaise: 360 + 900 + 522, netPaise: net });
    expect(v.settlements[0].payments.filter((p: any) => p.charge)).toHaveLength(2);

    await h.software([['2611011', '1 13:00', 'CARD', '1000']], 0 + (await import('../src/time')).istToMs(2026, 11, 2, 8, 0, 0));
    await h.register([{ no: '2611011', amount: '1000', pays: [['card', '1000']], day: '2026-11-01' }]);
    await h.view('2026-11-01');
    await h.confirm('2026-11-01');
    expect(await notPurchase()).toBe(0);

    const fees = (await o.post(`${base}/heads`, { name: 'Card fees', type: 'expense' })).json.id;
    const gst = (await o.post(`${base}/heads`, { name: 'GST on card fees', type: 'expense' })).json.id;
    await h.lines([['2 10:00', (net / 100).toFixed(2), 'CR', 'EZY/ICICIPOS_SET_10XX000000_021126']]);
    expect((await o.put(`${base}/cards/rules/TT000001`, { feeHeadId: fees, gstHeadId: gst })).json).toMatchObject({ autoSettled: 1 });
    const booked = await sql`SELECT head_id, amount_paise FROM transactions WHERE business_id = ${h.bid} AND type = 'expense' ORDER BY amount_paise DESC`;
    expect(booked).toEqual([{ head_id: fees, amount_paise: 9900 }, { head_id: gst, amount_paise: 1782 }]);
    // The books equal the bank: sales 1000 less everything booked is the credit.
    expect(100000 - 9900 - 1782).toBe(net);
    expect(acc).toBeTruthy();
  });
});
