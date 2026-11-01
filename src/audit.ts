import type { Query } from './db';

export async function audit(
  sql: Query,
  entry: { businessId: string; userId: string; action: string; table: string; rowId: string; before: unknown; after: unknown },
): Promise<void> {
  await sql`
    INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after)
    VALUES (${entry.businessId}, ${entry.userId}, ${entry.action}, ${entry.table}, ${entry.rowId},
            ${entry.before === null ? null : sql.json(entry.before as never)},
            ${entry.after === null ? null : sql.json(entry.after as never)})`;
}
