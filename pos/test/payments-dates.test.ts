// Payments with dates (28 Nov 2026): any past shift can be asked for; it lists only its own bills, while today's shift
// also lists bills still unpaid from before (unless asked for From–To, ?open=0). A future shift is refused. Invented data.
import { afterAll, describe, expect, it } from 'vitest';
import { billed, dispose, q, setupBusiness } from './helpers';

afterAll(dispose);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('Payments for any shift', () => {
  it('a past shift lists its own bills; today also lists older unpaid ones; a future shift is refused', async () => {
    const s = await setupBusiness();
    const paid = (await billed(s, [['Masala Dosa', 1]])).bill;
    await s.counter.post(`${s.B}/settlements`, { billIds: [paid.id], payments: [{ mode: 'cash', amount: '189' }] });
    const unpaid = (await billed(s, [['Masala Chai', 2]])).bill;
    const today = paid.shiftDay as string;
    const yesterday = addDays(today, -1);
    // The unpaid bill was printed yesterday and is still not paid.
    await q('UPDATE bills SET shift_day = ? WHERE id = ?', yesterday, unpaid.id);

    const nos = (r: any) => r.json.bills.map((b: any) => b.billNo).sort();
    const t = await s.owner.get(`${s.B}/proof`);
    expect(t.json).toMatchObject({ day: today, today, connected: false });
    expect(nos(t)).toEqual([paid.billNo, unpaid.billNo].sort());
    expect(nos(await s.owner.get(`${s.B}/proof?day=${today}&open=0`))).toEqual([paid.billNo]);
    expect(nos(await s.owner.get(`${s.B}/proof?day=${yesterday}`))).toEqual([unpaid.billNo]);
    expect(nos(await s.owner.get(`${s.B}/proof?day=${addDays(today, -5)}`))).toEqual([]);
    expect((await s.owner.get(`${s.B}/proof?day=${addDays(today, 1)}`))).toMatchObject({ status: 400, json: { error: 'That shift has not started yet.' } });
    expect((await s.owner.get(`${s.B}/proof?day=yesterday`)).status).toBe(400);
  });
});
