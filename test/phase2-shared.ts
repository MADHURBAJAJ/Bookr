// Shared by the phase2-*.test.ts files: a hotel with every role, the 31 Oct sample shift typed in, and decisions.
// Phase 2 was one file of 112 tests; it ran one test after another and took most of the full suite's time, so it is
// split into parts that run side by side (11 Nov 2026). Invented data only (demo/sample-data.ts).
import { expect } from 'vitest';
import { businessWithAllRoles, Client } from './helpers';
import { buildSalesCsv, REGISTER_31_OCT, REPORT_1_NOV_EARLY, REPORT_31_OCT, type SampleBill } from '../demo/sample-data';
import { istToMs } from '../src/time';

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
export const png = (n: number) => { const b = new Uint8Array(PNG); b[10] = n; return b; };
export const DAY_START = (y: number, m: number, d: number) => istToMs(y, m, d, 0, 0, 0);
export const DAY_END = (y: number, m: number, d: number) => istToMs(y, m, d, 23, 59, 59);

/** A hotel with every role, F&B and Room income heads mapped to their bill types. */
/** Today in India: for checks inside the watch, which the 31 Oct sample shift is no longer. */
export const todayIst = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

export async function hotel() {
  const h = await businessWithAllRoles('Hotel');
  const o = h.clients.owner;
  const fnb = (await o.post(`/businesses/${h.bid}/heads`, { name: 'F&B', type: 'income' })).json.id;
  const room = (await o.post(`/businesses/${h.bid}/heads`, { name: 'Room', type: 'income' })).json.id;
  expect((await h.clients.accountant.put(`/businesses/${h.bid}/bill-type-heads/fnb`, { headId: fnb })).status).toBe(200);
  expect((await o.put(`/businesses/${h.bid}/bill-type-heads/room`, { headId: room })).status).toBe(200);
  const importCsv = (c: Client, bills: SampleBill[], extra: Record<string, unknown> = {}) =>
    c.post(`/businesses/${h.bid}/sales-reports`, { day: '2026-10-31', csv: buildSalesCsv(bills), ...extra });
  return { ...h, fnb, room, importCsv };
}

/** Imports both sample reports covering whole days, and types in the 31 Oct register. */
export async function fullShift(h: Awaited<ReturnType<typeof hotel>>, register = REGISTER_31_OCT) {
  const o = h.clients.owner;
  expect((await h.importCsv(o, REPORT_31_OCT, { coversFrom: DAY_START(2026, 10, 31), coversTo: DAY_END(2026, 10, 31) })).status).toBe(201);
  expect((await h.importCsv(o, REPORT_1_NOV_EARLY, { coversFrom: DAY_START(2026, 11, 1), coversTo: istToMs(2026, 11, 1, 7, 59, 59) })).status).toBe(201);
  const page = await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=2026-10-31`, png(1), 'image/png');
  expect(page.status).toBe(201);
  for (const r of register) {
    const res = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${page.json.id}/register-rows`, {
      billNo: r.billNo, billType: r.billType, amount: r.amount, discount: (r as { discount?: string }).discount ?? '0', remarks: r.remarks ?? null, status: 'checked',
      payments: r.payments.map((p) => ({ mode: p.mode, columnLabel: p.columnLabel, amount: p.amount })),
    });
    expect(res.status).toBe(201);
  }
  return page.json.id as string;
}

export const view = (h: { bid: string; clients: Record<string, Client> }, day = '2026-10-31') => h.clients.owner.get(`/businesses/${h.bid}/shifts/${day}`);
export const byBill = (v: { json: { comparisons: { billNo: string }[] } }, bill: string) => v.json.comparisons.find((c) => c.billNo === bill) as any;

export async function decideAll(h: Awaited<ReturnType<typeof hotel>>) {
  const v = await view(h);
  const decide = (bill: string, decision: string) => h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${byBill(v, bill).id}`,
    decision === 'leave_out' ? { decision, note: 'Cancelled in POS' } : { decision });
  expect((await decide('26103115', 'use_register')).status).toBe(200);   // cash 403
  expect((await decide('2610317', 'use_software')).status).toBe(200);    // UPI 4410
  expect((await decide('2610318', 'use_register')).status).toBe(200);    // UPI 650
  expect((await decide('2610319', 'leave_out')).status).toBe(200);
  expect((await decide('26103120', 'use_register')).status).toBe(200);   // cash 1000 + UPI 1560
  expect((await decide('26103125', 'use_register')).status).toBe(200);   // cash 500
}
