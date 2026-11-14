// The Cash tab before saving (approved 14 Nov 2026): the same sum from what Save would book now, the bills that touch
// cash with both sides, and the final figures unchanged for the other screens. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';
import { istToMs } from '../src/time';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

const count = async (bid: string, day: string, rupees: number) => {
  const [u] = await sql`SELECT id FROM uploads WHERE business_id = ${bid} AND id NOT IN (SELECT upload_id FROM cash_summaries) LIMIT 1`;
  await sql`INSERT INTO cash_summaries (id, business_id, upload_id, shift_day, cash_in_hand_paise, status, created_at)
    VALUES (${crypto.randomUUID()}, ${bid}, ${u.id}, ${day}, ${rupees * 100}, 'approved', ${Date.now()})`;
};

describe('cash before saving', () => {
  it('shows a draft sum and difference that follow the decisions, lists the bills that differ, and turns final on Save', async () => {
    const h = await hotel();
    await h.software([['2610311', '31 19:00', 'CASH', '50'], ['2610313', '31 21:00', 'CASH', '100'], ['2610314', '31 22:00', 'CASH', '70']], istToMs(2026, 11, 1, 8, 0, 0));
    await h.register([{ no: '2610313', amount: '100', pays: [['cash', '100']] }, { no: '2610314', amount: '70', pays: [['upi', '70']] }]);
    await count(h.bid, '2026-10-30', 1000);
    await count(h.bid, '2026-10-31', 1220); // ₹70 over: exactly bill 2610314, cash in the software, UPI in the register
    const acc = h.clients.accountant;
    let k = (await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`)).json;
    // Final figures stay empty before Save; the draft counts only the matched ₹100.
    // Final figures stay empty before Save. The draft counts the matched ₹100 and 2610311 (counted from the software
    // while it waits for its register line): ₹1,150 should be in hand, ₹70 over.
    expect(k).toMatchObject({ confirmed: false, cashSalesPaise: null, differencePaise: null, draft: { cashSalesPaise: 15000, shouldBePaise: 115000, differencePaise: 7000 } });
    const by = (no: string) => k.bills.find((b: any) => b.billNo === no);
    expect(by('2610311')).toMatchObject({ swCashPaise: 5000, rgCashPaise: null, state: 'decided', decision: 'use_software', differs: true, countedPaise: 5000 });
    expect(by('2610314')).toMatchObject({ swCashPaise: 7000, rgCashPaise: 0, rgOther: [{ mode: 'upi', amountPaise: 7000 }], state: 'undecided', differs: true, countedPaise: 0 });
    expect(by('2610313')).toMatchObject({ swCashPaise: 10000, rgCashPaise: 10000, state: 'match', differs: false, countedPaise: 10000 });
    expect(k.bills[k.bills.length - 1].billNo).toBe('2610313'); // those that differ first

    // Use software for 2610314 (cash ₹70): ₹1,220 should be in hand, and the cash agrees before saving.
    await h.decideRest('2026-10-31', (c) => (c.billNo === '2610314' ? 'use_software' : undefined));
    k = (await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`)).json;
    expect(k.draft).toEqual({ cashSalesPaise: 22000, shouldBePaise: 122000, differencePaise: 0 });

    await h.confirm();
    k = (await acc.get(`/businesses/${h.bid}/shifts/2026-10-31/cash`)).json;
    expect(k).toMatchObject({ confirmed: true, draft: null, cashSalesPaise: 22000, differencePaise: 0 });
    expect(k.bills.find((b: any) => b.billNo === '2610311')).toMatchObject({ state: 'decided', countedPaise: 5000 });
  });
});
