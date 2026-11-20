// School cash book data model (migration 0030, approved 20 Nov 2026): branches, a cashier's book, typed lines,
// handovers to a book / person / bank, cash counted. Amounts from the Khatabook example of 15 Sep 2026.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addMember, db, makeBusiness, makeUser, resetDb, sql } from './helpers';

afterAll(() => sql.end());
beforeEach(resetDb);
vi.setConfig({ testTimeout: 60_000 });

const id = () => crypto.randomUUID();
const T = Date.now();
const run = (q: string, ...v: unknown[]) => db.prepare(q).bind(...v).run();

async function school() {
  const owner = await makeUser('owner');
  const cashier = await makeUser('cashier');
  const other = await makeUser('cashier2');
  const bid = await makeBusiness(owner.id, 'School');
  await addMember(bid, cashier.id, 'entry_staff');
  await addMember(bid, other.id, 'entry_staff');
  const branch = id();
  await run('INSERT INTO branches (id, business_id, name, created_at) VALUES (?, ?, ?, ?)', branch, bid, 'Chilkana Road', T);
  const book = async (name: string, user: string | null, kind = 'cash', br: string | null = branch) => {
    const a = id();
    await run(`INSERT INTO accounts (id, business_id, name, kind, opening_balance_paise, opening_date, created_at, branch_id, cashier_user_id)
      VALUES (?, ?, ?, ?, ?, '2026-09-15', ?, ?, ?)`, a, bid, name, kind, 8462800, T, br, user);
    return a;
  };
  const line = async (account: string, kind: string, paise: number, narration = '') => {
    const e = id();
    await run(`INSERT INTO cash_entries (id, business_id, account_id, day, kind, amount_paise, narration, entered_by, entered_at, created_at)
      VALUES (?, ?, ?, '2026-09-15', ?, ?, ?, ?, ?, ?)`, e, bid, account, kind, paise, narration, cashier.id, T, T);
    return e;
  };
  return { bid, owner, cashier, other, branch, book, line };
}

describe('school cash book tables', () => {
  it('a cashier book holds the day: fees, expenses, and the cash counted', async () => {
    const s = await school();
    const book = await s.book('SMS CR EXP', s.cashier.id);
    await s.line(book, 'fee', 11418000, 'chilkana road fee received');
    await s.line(book, 'expense', 550000, 'stationery exam');
    await s.line(book, 'expense', 200000, 'rk tact');
    await s.line(book, 'expense', 100000, 'hardware');
    await run('INSERT INTO cash_counts (id, business_id, account_id, day, counted_paise, counted_by, counted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id(), s.bid, book, '2026-09-15', 19030800, s.cashier.id, T);
    const [r] = await sql`SELECT a.opening_balance_paise
      + COALESCE(SUM(CASE WHEN e.kind IN ('fee','other_in','handover_in') THEN e.amount_paise ELSE -e.amount_paise END), 0) AS in_hand
      FROM accounts a LEFT JOIN cash_entries e ON e.account_id = a.id WHERE a.id = ${book} GROUP BY a.id`;
    expect(r.in_hand).toBe(19030800);
    await expect(run('INSERT INTO cash_counts (id, business_id, account_id, day, counted_paise, counted_at) VALUES (?, ?, ?, ?, ?, ?)',
      id(), s.bid, book, '2026-09-15', 1, T)).rejects.toThrow(/UNIQUE/);
  });

  it('a book must be a cash account, of a branch of this business, kept by a member', async () => {
    const s = await school();
    await expect(s.book('Bank', s.cashier.id, 'bank')).rejects.toThrow(/book_not_cash/);
    const outsider = await makeUser('outsider');
    await expect(s.book('Theirs', outsider.id)).rejects.toThrow(/cashier_not_member/);
    const other = await makeBusiness((await makeUser('o2')).id, 'Other');
    const foreign = id();
    await run('INSERT INTO branches (id, business_id, name, created_at) VALUES (?, ?, ?, ?)', foreign, other, 'Elsewhere', T);
    await expect(s.book('Wrong branch', s.cashier.id, 'cash', foreign)).rejects.toThrow(/branch_other_business/);
    const book = await s.book('Fine', null);
    await expect(run('UPDATE accounts SET cashier_user_id = ? WHERE id = ?', outsider.id, book)).rejects.toThrow(/cashier_not_member/);
    await run('UPDATE accounts SET cashier_user_id = ? WHERE id = ?', s.cashier.id, book);
    await expect(run(`INSERT INTO branches (id, business_id, name, created_at) VALUES (?, ?, 'chilkana road', ?)`, id(), s.bid, T)).rejects.toThrow(/UNIQUE/);
  });

  it('lines go only into a cash book, with a positive amount and a known kind', async () => {
    const s = await school();
    const bank = await s.book('ICICI', null, 'bank', null);
    const book = await s.book('SMS CR EXP', s.cashier.id);
    await expect(s.line(bank, 'fee', 100)).rejects.toThrow(/not_a_book/);
    await expect(s.line(book, 'fee', 0)).rejects.toThrow(/CHECK/);
    await expect(s.line(book, 'loan', 100)).rejects.toThrow(/CHECK/);
  });

  it('a handover to another book waits as sent, then is received by that book\'s matching line', async () => {
    const s = await school();
    const anoop = await s.book('Anoop', s.cashier.id);
    const haji = await s.book('Haji ji', s.other.id);
    const out = await s.line(anoop, 'handover_out', 45000000, 'Transfer entry haji ji');
    const h = id();
    await run(`INSERT INTO cash_handovers (id, business_id, from_entry_id, to_kind, to_account_id, created_at) VALUES (?, ?, ?, 'book', ?, ?)`,
      h, s.bid, out, haji, T);
    expect((await sql`SELECT status FROM cash_handovers WHERE id = ${h}`)[0].status).toBe('sent');
    const wrong = await s.line(haji, 'handover_in', 40000000);
    await expect(run('UPDATE cash_handovers SET to_entry_id = ?, status = ? WHERE id = ?', wrong, 'received', h)).rejects.toThrow(/receive_line_mismatch/);
    const right = await s.line(haji, 'handover_in', 45000000, 'from Anoop');
    await run('UPDATE cash_handovers SET to_entry_id = ?, status = ?, settled_by = ?, settled_at = ? WHERE id = ?', right, 'received', s.other.id, T, h);
    await expect(run('UPDATE cash_handovers SET status = ? WHERE id = ?', 'deposited', h)).rejects.toThrow(/CHECK/);
  });

  it('a handover goes to a person or the bank, never to its own book, and only from a handover line', async () => {
    const s = await school();
    const book = await s.book('SMS CR EXP', s.cashier.id);
    const bank = await s.book('ICICI', null, 'bank', null);
    const owner = id();
    await run('INSERT INTO parties (id, business_id, name, created_at) VALUES (?, ?, ?, ?)', owner, s.bid, 'Owner', T);
    const ins = (from: string, kind: string, acc: string | null, party: string | null) =>
      run('INSERT INTO cash_handovers (id, business_id, from_entry_id, to_kind, to_account_id, to_party_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id(), s.bid, from, kind, acc, party, T);
    await ins(await s.line(book, 'handover_out', 10000000), 'person', null, owner);
    await ins(await s.line(book, 'handover_out', 5000000), 'bank', bank, null);
    await expect(ins(await s.line(book, 'handover_out', 100), 'book', book, null)).rejects.toThrow(/handover_to_own_book/);
    await expect(ins(await s.line(book, 'handover_out', 100), 'bank', book, null)).rejects.toThrow(/handover_to_wrong_account/);
    await expect(ins(await s.line(book, 'handover_out', 100), 'person', bank, owner)).rejects.toThrow(/CHECK|handover_to_wrong_account/);
    await expect(ins(await s.line(book, 'fee', 100), 'person', null, owner)).rejects.toThrow(/handover_not_out/);
  });

  it('deleting the whole business takes its branches, books, lines and handovers with it', async () => {
    const s = await school();
    const a = await s.book('A', s.cashier.id);
    const b = await s.book('B', s.other.id);
    await run(`INSERT INTO cash_handovers (id, business_id, from_entry_id, to_kind, to_account_id, to_entry_id, status, created_at)
      VALUES (?, ?, ?, 'book', ?, ?, 'received', ?)`, id(), s.bid, await s.line(a, 'handover_out', 500), b, await s.line(b, 'handover_in', 500), T);
    await run('DELETE FROM businesses WHERE id = ?', s.bid);
    for (const t of ['branches', 'cash_entries', 'cash_handovers', 'cash_counts']) {
      expect((await db.prepare(`SELECT count(*) AS n FROM ${t}`).first<{ n: number }>())!.n).toBe(0);
    }
  });
});
