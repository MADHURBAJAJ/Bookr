-- A UPI sale whose bank credit will never come can be closed with a reason (approved 6 Nov 2026). The sale stays in
-- income; closing only stops the chase. While closed its match_status is NULL, and reopening puts it back.
CREATE TABLE closed_bills (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  note           TEXT NOT NULL,
  closed_by      TEXT REFERENCES users(id),
  closed_at      INTEGER NOT NULL
);
CREATE INDEX closed_bills_business_idx ON closed_bills (business_id, closed_at);
