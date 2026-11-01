import type { Sql } from './db';

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
];

export async function createBusiness(
  sql: Sql,
  input: { name: string; fyStart: string; ownerId: string; isDemo?: boolean },
): Promise<string> {
  return sql.begin(async (tx) => {
    const [b] = await tx<{ id: string }[]>`
      INSERT INTO businesses (name, fy_start, is_demo)
      VALUES (${input.name}, ${input.fyStart}, ${input.isDemo ?? false}) RETURNING id`;
    await tx`INSERT INTO memberships (business_id, user_id, role) VALUES (${b.id}, ${input.ownerId}, 'owner')`;
    for (const h of DEFAULT_HEADS) {
      await tx`
        INSERT INTO heads (business_id, name, type, tally_ledger, is_custom)
        VALUES (${b.id}, ${h.name}, ${h.type}, ${h.tally}, false)`;
    }
    await tx`
      INSERT INTO accounts (business_id, name, kind, opening_balance, opening_date)
      VALUES (${b.id}, 'Cash', 'cash', 0, ${input.fyStart})`;
    return b.id;
  });
}
