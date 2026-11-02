import { newId, now, stmt, type DB } from './db';

// The fixed starting list every new business gets. Users can add custom heads on top.
export const DEFAULT_HEADS: { name: string; type: 'income' | 'expense'; tally: string }[] = [
  { name: 'Sales', type: 'income', tally: 'Sales Account' },
  { name: 'Other income', type: 'income', tally: 'Indirect Incomes' },
  { name: 'Interest received', type: 'income', tally: 'Interest Income' },
  { name: 'Purchases', type: 'expense', tally: 'Purchase Account' },
  { name: 'Salaries', type: 'expense', tally: 'Salary Expenses' },
  { name: 'Rent', type: 'expense', tally: 'Rent Expenses' },
  { name: 'Utilities', type: 'expense', tally: 'Electricity Expenses' },
  { name: 'Transport', type: 'expense', tally: 'Freight and Cartage' },
  { name: 'Food', type: 'expense', tally: 'Staff Welfare' },
  { name: 'UPI charges', type: 'expense', tally: 'Bank Charges' },
  { name: 'Cash shortage', type: 'expense', tally: 'Cash Shortage' },
];

// The statements that create a business with its Owner, standard heads and a Cash account.
// Returned rather than run, so callers can add to the same atomic batch.
export function createBusinessStatements(
  db: DB,
  input: { name: string; fyStart: string; ownerId: string; isDemo?: boolean; id?: string },
): { id: string; statements: D1PreparedStatement[] } {
  const id = input.id ?? newId();
  const t = now();
  const statements = [
    stmt(db, 'INSERT INTO businesses (id, name, fy_start, is_demo, created_at) VALUES (?, ?, ?, ?, ?)',
      id, input.name, input.fyStart, input.isDemo ? 1 : 0, t),
    stmt(db, "INSERT INTO memberships (business_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", id, input.ownerId, t),
    ...DEFAULT_HEADS.map((h) => stmt(db,
      'INSERT INTO heads (id, business_id, name, type, tally_ledger, is_custom, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
      newId(), id, h.name, h.type, h.tally, t)),
    stmt(db, "INSERT INTO accounts (id, business_id, name, kind, opening_balance_paise, opening_date, created_at) VALUES (?, ?, 'Cash', 'cash', 0, ?, ?)",
      newId(), id, input.fyStart, t),
  ];
  return { id, statements };
}

export async function createBusiness(db: DB, input: Parameters<typeof createBusinessStatements>[1]): Promise<string> {
  const { id, statements } = createBusinessStatements(db, input);
  await db.batch(statements);
  return id;
}
