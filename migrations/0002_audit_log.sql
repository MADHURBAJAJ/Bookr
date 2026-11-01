-- Who changed what. From the handover's data model (user, action, row, before, after, time),
-- plus business_id like every other business table. Rows are only ever inserted.

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,              -- e.g. account.create, account.update
  row_table   text NOT NULL,              -- e.g. accounts
  row_id      uuid NOT NULL,
  before      jsonb,                      -- null on create
  after       jsonb,                      -- null on delete
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_business_idx ON audit_log (business_id, created_at DESC);
CREATE INDEX audit_log_row_idx ON audit_log (row_table, row_id);
