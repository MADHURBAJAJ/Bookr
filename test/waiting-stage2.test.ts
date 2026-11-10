// Waiting = needs a look (Stage 2, approved 10 Nov 2026): bills where something should have turned up are counted;
// bills waiting only for a file or a save are grey; a bill left out is not waiting; after the watch a person may keep a
// bill waiting 7 more days with a note. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('waiting: needs a look against grey', () => {
  it('sorts bills, leaves out Leave out, offers credits, and keeps a bill waiting with a note', async () => {
    const h = await hotel();
    await h.account('HUF A', 'UPI XOXO');
    await h.software([['2610311', '31 19:18', 'UPI', '104'], ['2610312', '31 20:00', 'CASH', '50'], ['2610313', '31 21:00', 'CASH', '30'],
      ['2611011', '1 10:00', 'UPI', '200']]);
    await h.register([{ no: '2610313', amount: '30', pays: [['cash', '30']] }, { no: '2610319', amount: '75', pays: [['cash', '75']] },
      { no: '2610318', amount: '40', pays: [['cash', '40']] }]);
    const [c110] = await h.credits([['31 19:16', 110], ['1 09:30', 999]]);
    await h.decideRest('2026-10-31', (c) => (c.billNo === '2610318' ? 'leave_out' : undefined));
    await h.view('2026-11-01');
    await h.decideRest('2026-11-01');

    const acc = h.clients.accountant;
    const w = (await acc.get(`/businesses/${h.bid}/waiting`)).json;
    const look = Object.fromEntries(w.look.map((x: any) => [x.billNo, x]));
    const grey = Object.fromEntries(w.grey.map((x: any) => [x.billNo, x]));
    // UPI, not in the register, bank synced: needs a look, with the ₹110 credit offered.
    expect(look['2610311']).toMatchObject({ side: 'software', unresolved: true });
    expect(look['2610311'].offers.map((o: any) => o.id)).toEqual([c110]);
    // In the register only, software report covers the shift: needs a look.
    expect(look['2610319']).toMatchObject({ side: 'register' });
    // Cash, shift not saved: grey until saved. No register on 1 Nov: grey.
    expect(grey['2610312']).toMatchObject({ waitFor: 'save' });
    expect(grey['2611011']).toMatchObject({ waitFor: 'register' });
    // Left out: not waiting at all.
    expect([...w.look, ...w.grey].map((x: any) => x.billNo)).not.toContain('2610318');

    // Entry staff see it without the bank offers.
    const staff = (await h.clients.entry_staff.get(`/businesses/${h.bid}/waiting`)).json;
    expect(staff.look.find((x: any) => x.billNo === '2610311').offers).toEqual([]);

    // The dashboard counts only the bills that need a look; grey ones are grouped.
    const home = (await acc.get(`/businesses/${h.bid}/home`)).json;
    expect(home.waitingBills.count).toBe(w.look.length);
    expect(home.waitingBills.grey).toContainEqual({ waitFor: 'register', day: '2026-11-01', n: 1 });

    // Keep waiting: Owner or Accountant, only after the watch, and it starts a new 7-day watch.
    const id = look['2610311'].comparisonId;
    expect((await h.clients.entry_staff.post(`/businesses/${h.bid}/comparisons/${id}/keep-waiting`, { note: 'Guest to pay' })).status).toBe(403);
    const kept = await acc.post(`/businesses/${h.bid}/comparisons/${id}/keep-waiting`, { note: 'Guest to pay' });
    expect(kept.status, JSON.stringify(kept.json)).toBe(200);
    const again = (await acc.get(`/businesses/${h.bid}/waiting`)).json.look.find((x: any) => x.billNo === '2610311');
    expect(again).toMatchObject({ unresolved: false, watchNote: 'Guest to pay', watchEnd: kept.json.watchUntil });
    expect((await acc.post(`/businesses/${h.bid}/comparisons/${id}/keep-waiting`, { note: 'again' })).status).toBe(400);
    expect((await sql`SELECT count(*) AS n FROM audit_log WHERE action = 'comparison.keep_waiting'`)[0].n).toBe(1);
  });
});
