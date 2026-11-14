-- Speed (approved 15 Nov 2026): history, plans and choices are looked up in the audit log by business and action.
-- Without this index each lookup reads every audit row of the business, which grows with every change.
CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (business_id, action, row_id);
