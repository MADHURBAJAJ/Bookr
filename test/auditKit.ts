// Shared by the matching audits (9 Nov 2026): a hotel with heads, register pages, a software report, bank accounts with
// UPI credits, card payments, and the views. Invented data only.
import { expect } from 'vitest';
import { businessWithAllRoles, sql } from './helpers';
import { buildSalesCsv, type SampleBill } from '../demo/sample-data';
import { istToMs } from '../src/time';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const pad = (n: number) => String(n).padStart(2, '0');
/** 'D HH:MM': D is 30 or 31 (October) or 1, 2 (November). */
export const at = (s: string) => {
  const [d, hm] = s.split(' ');
  const [hh, mm] = hm.split(':').map(Number);
  const dd = Number(d);
  const mo = dd >= 30 ? 10 : 11;
  return {
    csv: `${pad(dd)}-${pad(mo)}-2026.${pad(hh)}:${pad(mm)}:00`,
    bank: `${pad(dd)}/${pad(mo)}/2026 ${hh % 12 === 0 ? 12 : hh % 12}:${pad(mm)}:00 ${hh < 12 ? 'AM' : 'PM'}`,
    ms: istToMs(2026, mo, dd, hh, mm, 0),
  };
};
export const log = (name: string, what: unknown) => console.log(`[audit] ${name}: ${JSON.stringify(what)}`);

const HEAD = ['No.', 'Transaction ID', 'Value Date', 'Txn Posted Date', 'ChequeNo.', 'Description', 'Cr/Dr', 'Transaction Amount(INR)', 'Available Balance(INR)'].join('\t');
let tran = 0;

type Pay = [mode: 'cash' | 'upi' | 'card', amount: string, label?: string];
interface Reg { no: string; amount: string; pays: Pay[]; discount?: string; paidWith?: string; day?: string }

export async function hotel() {
  const h = await businessWithAllRoles('Audit Hotel');
  const o = h.clients.owner;
  const fnb = (await o.post(`/businesses/${h.bid}/heads`, { name: 'F&B', type: 'income' })).json.id;
  const room = (await o.post(`/businesses/${h.bid}/heads`, { name: 'Room', type: 'income' })).json.id;
  await o.put(`/businesses/${h.bid}/bill-type-heads/fnb`, { headId: fnb });
  await o.put(`/businesses/${h.bid}/bill-type-heads/room`, { headId: room });
  const accounts: Record<string, string> = {};
  const pages: Record<string, string> = {};
  const rows: Record<string, string> = {};
  const self = {
    ...h, fnb, accounts, rows,
    /** The software report: one file covering 31 Oct 00:00 to 1 Nov 23:59. */
    async software(bills: [no: string, when: string, mode: SampleBill['mode'], amount: string][], coversTo = istToMs(2026, 11, 1, 23, 59, 59)) {
      const list: SampleBill[] = bills.map(([bill, when, mode, amount]) => ({ pos: 'POS-1', bill, when: at(when).csv, name: 'U/N', mode, amount }));
      const res = await o.post(`/businesses/${h.bid}/sales-reports`, { day: '2026-10-31', csv: buildSalesCsv(list),
        coversFrom: istToMs(2026, 10, 31, 0, 0, 0), coversTo });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
    },
    async register(list: Reg[]) {
      for (const r of list) {
        const day = r.day ?? '2026-10-31';
        if (!pages[day]) {
          const page = await h.clients.entry_staff.upload(`/businesses/${h.bid}/uploads?kind=bill_register&day=${day}`, new Uint8Array([...PNG, Object.keys(pages).length + 1]), 'image/png');
          expect(page.status).toBe(201);
          pages[day] = page.json.id;
        }
        const res = await h.clients.entry_staff.post(`/businesses/${h.bid}/uploads/${pages[day]}/register-rows`, {
          billNo: r.no, billType: 'fnb', amount: r.amount, discount: r.discount ?? '0', status: 'checked',
          payments: r.pays.map(([mode, amount, label]) => ({ mode, amount, columnLabel: label ?? (mode === 'upi' ? 'UPI XOXO' : mode === 'card' ? 'Card' : 'Cash') })),
          ...(r.paidWith ? { paidWithRowId: rows[r.paidWith] } : {}),
        });
        expect(res.status, `${r.no}: ${JSON.stringify(res.json)}`).toBe(201);
        rows[r.no] = res.json.id;
      }
    },
    async account(name: string, label: string) {
      const acc = (await o.post(`/businesses/${h.bid}/accounts`, { name, kind: 'bank', openingBalance: '0', openingDate: '2026-04-01' })).json.id;
      expect((await o.put(`/businesses/${h.bid}/bank/${acc}/source`, { receivesUpiLabel: label })).status).toBe(200);
      accounts[name] = acc;
      return acc as string;
    },
    /** UPI credits into an account (default HUF A, label UPI XOXO). Returns their row ids by "when|amount". */
    async credits(list: [when: string, amount: number][], account = 'HUF A') {
      const lines = list.map(([when, amount]) => {
        tran += 1;
        return [tran, `S${String(50000000 + tran)}`, at(when).bank.slice(0, 10), at(when).bank, '-', `UPI/7${String(10000000000 + tran)}/Paid/p${tran}@okaxis/SAMPLE BANK/ICIa`, 'CR', amount, String(amount)].join('\t');
      });
      const res = await o.post(`/businesses/${h.bid}/bank/${accounts[account]}/paste`, { text: [HEAD, ...lines].join('\n') });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const ids: string[] = [];
      for (let i = tran - list.length + 1; i <= tran; i++) ids.push((await sql`SELECT id FROM bank_rows WHERE tran_id = ${`S${String(50000000 + i)}`}`)[0]?.id);
      return ids;
    },
    /** Any bank lines: [when, amount (rupees, may have paise), CR|DR, description]. Pasting the same text again is a
     *  second import of the same lines. Returns the row ids, and the pasted text. */
    async lines(list: [when: string, amount: number | string, dir: 'CR' | 'DR', desc: string][], account = 'HUF A', again?: string) {
      const first = tran + 1;
      const text = again ?? [HEAD, ...list.map(([when, amount, dir, desc]) => {
        tran += 1;
        return [tran, `S${String(50000000 + tran)}`, at(when).bank.slice(0, 10), at(when).bank, '-', desc, dir, String(amount), '1000'].join('\t');
      })].join('\n');
      const res = await o.post(`/businesses/${h.bid}/bank/${accounts[account]}/paste`, { text });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const ids: string[] = [];
      if (!again) for (let i = first; i <= tran; i++) ids.push((await sql`SELECT id FROM bank_rows WHERE tran_id = ${`S${String(50000000 + i)}`}`)[0]?.id);
      return { ids, text, res: res.json };
    },
    async swipe(when: string, amount: number, scheme = 'VISA') {
      const id = crypto.randomUUID();
      await sql`INSERT INTO card_settlements (id, business_id, file_name, settled_on, merchant_id, terminal_id, txn_id, paid_at, txn_type, amount_paise, fee_paise, gst_paise,
        net_paise, scheme, card_last4, created_at) VALUES (${id}, ${h.bid}, 'x_ICICI_POS_CD.xlsx', '2026-11-02', 'M1', 'TT000001', ${'TT_' + id}, ${at(when).ms}, 'PURCHASE',
        ${amount * 100}, 0, 0, ${amount * 100}, ${scheme}, ${scheme === 'UPI' ? null : '4242'}, ${Date.now()})`;
      return id;
    },
    view: (day = '2026-10-31') => o.get(`/businesses/${h.bid}/shifts/${day}`),
    reconcile: async (day = '2026-10-31') => (await o.get(`/businesses/${h.bid}/shifts/${day}/reconcile`)).json,
    entries: async (day = '2026-10-31') => (await o.get(`/businesses/${h.bid}/shifts/${day}/entries`)).json,
    async decideRest(day = '2026-10-31', pick: (c: any) => string | undefined = () => undefined) {
      const v = await self.view(day);
      for (const x of v.json.comparisons) {
        if (x.decision || x.difference === 'match' || x.difference === 'complimentary') continue;
        const decision = pick(x) ?? (x.register ? 'use_register' : 'use_software');
        const res = await h.clients.accountant.put(`/businesses/${h.bid}/comparisons/${x.id}`, { decision, billType: 'fnb', note: 'audit' });
        expect(res.status, `${x.billNo} ${decision}: ${JSON.stringify(res.json)}`).toBe(200);
      }
    },
    async confirm(day = '2026-10-31') {
      const res = await h.clients.accountant.post(`/businesses/${h.bid}/shifts/${day}/confirm`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return res.json;
    },
  };
  return self;
}
export const bill = (v: any, no: string) => v.json.comparisons.find((c: any) => c.billNo === no);
export const statusOf = async (id: string) => (await sql`SELECT status FROM bank_rows WHERE id = ${id}`)[0]?.status;
export const matchedTo = async (id: string) => (await sql`SELECT t.bill_no FROM bank_matches m JOIN transactions t ON t.id = m.transaction_id WHERE m.bank_row_id = ${id} ORDER BY t.bill_no`).map((r: any) => r.bill_no);

