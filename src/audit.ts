import { stmt, type DB } from './db';

// SQL that renders an accounts row as the JSON kept in audit_log.
const ACCOUNT_JSON = `json_object('id', id, 'name', name, 'kind', kind, 'accountNumber', account_number,
  'openingBalancePaise', opening_balance_paise, 'openingDate', opening_date)`;

// Statements to put in the same batch as an account change. The "before" image is read inside the
// batch, so it is exactly the row the change replaced.
export function auditAccountBefore(db: DB, e: { businessId: string; userId: string; action: string; accountId: string; at: number }) {
  return stmt(db, `
    INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
    SELECT business_id, ?, ?, 'accounts', id, ${ACCOUNT_JSON}, NULL, ?
    FROM accounts WHERE id = ? AND business_id = ?`,
    e.userId, e.action, e.at, e.accountId, e.businessId);
}

export function auditAccountAfter(db: DB, e: { businessId: string; userId: string; action: string; accountId: string; at: number; isCreate: boolean }) {
  if (e.isCreate) {
    return stmt(db, `
      INSERT INTO audit_log (business_id, user_id, action, row_table, row_id, before, after, created_at)
      SELECT business_id, ?, ?, 'accounts', id, NULL, ${ACCOUNT_JSON}, ?
      FROM accounts WHERE id = ? AND business_id = ?`,
      e.userId, e.action, e.at, e.accountId, e.businessId);
  }
  // Fill "after" on the row written by auditAccountBefore earlier in this batch.
  return stmt(db, `
    UPDATE audit_log SET after = (SELECT ${ACCOUNT_JSON} FROM accounts WHERE id = ?)
    WHERE id = (SELECT max(id) FROM audit_log WHERE row_table = 'accounts' AND row_id = ? AND business_id = ?)`,
    e.accountId, e.accountId, e.businessId);
}
