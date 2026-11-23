// On credit with the guest typed on the table (25 Nov 2026): their phone finds their credit account; with none, a new
// account takes the table's name and phone (seen on screen only as the last 4 digits); a phone typed for a table that had
// none is kept on the bill. All names and numbers are invented.
import { afterAll, describe, expect, it } from 'vitest';
import { dispose, q, setupBusiness } from './helpers';

afterAll(dispose);

describe('credit from the table', () => {
  it('finds the account by the table phone, or makes one from the table guest', async () => {
    const s = await setupBusiness();
    const { B, counter, ok, mgr } = s;
    const billFor = async (place: string, guest?: { guestName?: string; guestPhone?: string }) => {
      const o = (await ok(counter.post(`${B}/orders`, { kind: 'table', place, ...guest }))).id;
      await ok(counter.post(`${B}/orders/${o}/items`, { itemId: s.items['Masala Chai'], delta: 1 }));
      await ok(counter.post(`${B}/orders/${o}/kot`));
      return (await ok(counter.post(`${B}/orders/${o}/bill`, { entityId: s.company }))).bill;
    };
    const amt = (b: { totalPaise: number }) => (b.totalPaise / 100).toFixed(2);

    // No account yet: the table's name and phone make the new one (a manager approves a new credit account, as before).
    const b1 = await billFor('T1', { guestName: 'Sample Guest', guestPhone: '9800012121' });
    let cm = await ok(counter.get(`${B}/bills/${b1.id}/credit-match`));
    expect(cm).toEqual({ guestName: 'Sample Guest', hasPhone: true, phoneEnd: '2121', matches: [] });
    expect(JSON.stringify(cm)).not.toContain('9800012121');
    await ok(counter.post(`${B}/settlements`, { billIds: [b1.id], ...mgr, payments: [{ mode: 'credit', amount: amt(b1), newCredit: { name: 'Sample Guest', phone: '', useGuestPhone: true } }] }));
    expect(await q("SELECT name, phone FROM debtor_accounts WHERE business_id = ? AND kind = 'credit'", s.businessId)).toEqual([{ name: 'Sample Guest', phone: '9800012121' }]);

    // Next time the same phone finds that account; even "new account" goes on it, with no second account and no approval.
    const b2 = await billFor('T2', { guestPhone: '9800012121' });
    cm = await ok(counter.get(`${B}/bills/${b2.id}/credit-match`));
    expect(cm.matches).toMatchObject([{ name: 'Sample Guest', balancePaise: b1.totalPaise }]);
    await ok(counter.post(`${B}/settlements`, { billIds: [b2.id], payments: [{ mode: 'credit', amount: amt(b2), newCredit: { name: 'S. Guest', phone: '', useGuestPhone: true } }] }));
    expect(await q("SELECT count(*) AS n FROM debtor_accounts WHERE business_id = ? AND kind = 'credit'", s.businessId)).toEqual([{ n: 1 }]);

    // Name only on the table: the phone is typed, and kept on the bill and its order.
    const b3 = await billFor('T3', { guestName: 'Third Guest' });
    expect((await counter.post(`${B}/settlements`, { billIds: [b3.id], ...mgr, payments: [{ mode: 'credit', amount: amt(b3), newCredit: { name: 'Third Guest', phone: '', useGuestPhone: true } }] })).status).toBe(400);
    await ok(counter.post(`${B}/settlements`, { billIds: [b3.id], ...mgr, payments: [{ mode: 'credit', amount: amt(b3), newCredit: { name: 'Third Guest', phone: '9800034343' } }] }));
    expect((await q('SELECT guest_phone FROM bills WHERE id = ?', b3.id))[0].guest_phone).toBe('9800034343');
  });
});
