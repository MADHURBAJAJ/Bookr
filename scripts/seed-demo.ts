// Builds the demo businesses with sample data only. Safe to re-run: it replaces the previous demo data.
// Usage: DATABASE_URL=... DEMO_PASSWORD=... npm run db:seed-demo
// The demo password comes from the environment and is never committed.
import postgres from 'postgres';
import { hashPassword } from '../src/crypto';
import { createBusiness } from '../src/defaults';

const PEOPLE = [
  { key: 'owner', name: 'Owner (demo)', email: 'owner@example.com' },
  { key: 'accountant', name: 'Accountant A', email: 'accountant@example.com' },
  { key: 'staff', name: 'Entry staff A', email: 'staff1@example.com' },
  { key: 'viewer', name: 'Viewer A', email: 'viewer@example.com' },
] as const;

export async function seedDemo(url: string, password: string) {
  if (password.length < 10) throw new Error('DEMO_PASSWORD must be at least 10 characters');
  const sql = postgres(url, { max: 1 });
  try {
    await sql`DELETE FROM businesses WHERE is_demo`;
    await sql`DELETE FROM users WHERE lower(email) IN ${sql(PEOPLE.map((p) => p.email))}`;

    const hash = await hashPassword(password);
    const ids: Record<string, string> = {};
    for (const p of PEOPLE) {
      const [u] = await sql<{ id: string }[]>`
        INSERT INTO users (name, email, password_hash) VALUES (${p.name}, ${p.email}, ${hash}) RETURNING id`;
      ids[p.key] = u.id;
    }

    const traders = await createBusiness(sql, { name: 'Sample Traders', fyStart: '2026-04-01', ownerId: ids.owner, isDemo: true });
    await sql`
      INSERT INTO memberships (business_id, user_id, role) VALUES
        (${traders}, ${ids.accountant}, 'accountant'),
        (${traders}, ${ids.staff}, 'entry_staff'),
        (${traders}, ${ids.viewer}, 'viewer')`;
    await sql`UPDATE accounts SET opening_balance = 12500 WHERE business_id = ${traders} AND kind = 'cash'`;
    await sql`
      INSERT INTO accounts (business_id, name, kind, account_number, opening_balance, opening_date) VALUES
        (${traders}, 'HDFC Current', 'bank', 'XXXX4821', 245000, '2026-04-01'),
        (${traders}, 'ICICI Savings', 'bank', 'XXXX9226', 58300.50, '2026-04-01')`;
    await sql`
      INSERT INTO heads (business_id, name, type, tally_ledger, is_custom) VALUES
        (${traders}, 'Commission received', 'income', 'Commission Received', true),
        (${traders}, 'Packing material', 'expense', 'Packing Expenses', true)`;

    const hotel = await createBusiness(sql, { name: 'Sample Hotel', fyStart: '2026-04-01', ownerId: ids.owner, isDemo: true });
    await sql`INSERT INTO memberships (business_id, user_id, role) VALUES (${hotel}, ${ids.accountant}, 'viewer')`;
    await sql`UPDATE accounts SET opening_balance = 8400 WHERE business_id = ${hotel} AND kind = 'cash'`;
    await sql`
      INSERT INTO accounts (business_id, name, kind, account_number, opening_balance, opening_date) VALUES
        (${hotel}, 'UPI XOXO', 'bank', 'XXXX1107', 31250, '2026-04-01'),
        (${hotel}, 'UPI Bank 2', 'bank', 'XXXX3390', 12780, '2026-04-01')`;
    await sql`
      INSERT INTO heads (business_id, name, type, tally_ledger, is_custom) VALUES
        (${hotel}, 'Room', 'income', 'Room Revenue', true),
        (${hotel}, 'F&B', 'income', 'Food and Beverage Sales', true),
        (${hotel}, 'Laundry', 'expense', 'Laundry Expenses', true)`;
    return { traders, hotel, users: ids };
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  const password = process.env.DEMO_PASSWORD;
  if (!url || !password) throw new Error('Set DATABASE_URL and DEMO_PASSWORD');
  await seedDemo(url, password);
  console.log('Demo data ready: Sample Traders and Sample Hotel.');
}
