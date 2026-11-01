-- Who changed what. From the handover's data model (user, action, row, before, after, time),
-- plus business_id like every other business table. Rows are only ever inserted.

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,              -- e.g. account.create, account.update
  row_table   TEXT NOT NULL,              -- e.g. accounts
  row_id      TEXT NOT NULL,
  before      TEXT CHECK (before IS NULL OR json_valid(before)),   -- JSON; null on create
  after       TEXT CHECK (after IS NULL OR json_valid(after)),     -- JSON; null on delete
  created_at  INTEGER NOT NULL
);
CREATE INDEX audit_log_business_idx ON audit_log (business_id, created_at DESC);
CREATE INDEX audit_log_row_idx ON audit_log (row_table, row_id);
