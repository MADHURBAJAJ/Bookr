// The shift's Changes list (approved 21 Nov 2026): who changed what, newest first, edits put straight back shown once,
// and Undo only on the latest change to a bill, through the route that already undoes it. Invented data only.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql, resetDb } from './helpers';
import { hotel, bill } from './auditKit';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 300_000 });

describe('Shift changes', () => {
  it('lists decisions and register edits with undo for the latest only', async () => {
    const h = await hotel();
    await h.software([['2610311', '31 15:00', 'UPI', '550'], ['2610312', '31 16:00', 'CASH', '300']]);
    await h.register([{ no: '2610311', amount: '500', pays: [['upi', '500']] }, { no: '2610312', amount: '300', pays: [['cash', '300']] }]);
    const cid = bill(await h.view(), '2610311').id;
    const put = (body: Record<string, unknown>) => h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${cid}`, body);
    expect((await put({ decision: 'use_software', note: 'first' })).status).toBe(200);
    expect((await put({ decision: 'use_register', note: 'second' })).status).toBe(200);
    const row = { billNo: '2610312', billType: 'fnb', amount: '300', discount: '0', status: 'checked', payments: [{ mode: 'cash', amount: '300', columnLabel: 'Cash' }] };
    const edit = (remarks: string | null) => h.clients.entry_staff.put(`/businesses/${h.bid}/register-rows/${h.rows['2610312']}`, { ...row, remarks });
    for (let i = 0; i < 2; i++) { expect((await edit('typo')).status).toBe(200); expect((await edit(null)).status).toBe(200); }
    expect((await edit('kept')).status).toBe(200);

    const list = async () => {
      const r = await h.clients.owner.get(`/businesses/${h.bid}/shifts/2026-10-31/changes`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json.items as any[];
    };
    let items = await list();
    const decs = items.filter((x) => x.action === 'comparison.decide' && x.bill === '2610311' && !x.auto);
    expect(decs.map((x) => [x.text.split(' (')[0], x.state])).toEqual([['Use register', 'undo'], ['Use software', 'later']]);
    expect(decs[0]).toMatchObject({ user: expect.any(String), kind: 'decision', sub: 'second' });
    const edits = items.filter((x) => x.bill === '2610312' && x.action === 'register.edit');
    expect(edits.map((x) => [x.state, x.times ?? 1])).toEqual([['undo', 1], ['none', 2]]);
    expect(edits[1].text).toMatch(/then put back$/);

    // Undo the latest decision: back to Use software, with its note.
    const u = decs[0].undo;
    expect((await h.clients.accountant.put(`/businesses/${h.bid}${u.path}`, u.body)).status).toBe(200);
    expect(bill(await h.view(), '2610311').decision).toBe('use_software');
    // Undo the register edit: the remark goes.
    const e = edits[0].undo;
    expect((await h.clients.entry_staff.put(`/businesses/${h.bid}${e.path}`, e.body)).status).toBe(200);
    expect((await sql`SELECT remarks FROM register_rows WHERE id = ${h.rows['2610312']}`)[0].remarks).toBeNull();
    items = await list();
    expect(items.find((x) => !x.auto)).toMatchObject({ action: 'register.edit', state: 'none', text: 'Remarks "" → "kept", then put back' });
    expect((await h.clients.entry_staff.get(`/businesses/${h.bid}/shifts/2026-10-31/changes`)).status).toBe(403);
  });
});
