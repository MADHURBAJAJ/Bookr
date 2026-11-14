-- Money going out (14 Nov 2026): cash paid out of the drawer (vegetables, a delivery) and an unused advance refunded at
-- check-out. Both reduce the cash expected at shift close, and both go to Bookr. Rows are only added.
CREATE TABLE drawer_outs (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('paid_out', 'refund')),
  mode              TEXT NOT NULL CHECK (mode IN ('cash', 'upi')),
  amount_paise      INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer' AND amount_paise > 0),
  debtor_account_id TEXT REFERENCES debtor_accounts(id),
  note              TEXT NOT NULL CHECK (length(trim(note)) > 0),
  shift_day         TEXT NOT NULL,
  by_staff          TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at                INTEGER NOT NULL,
  CHECK ((kind = 'refund') = (debtor_account_id IS NOT NULL))
);
CREATE INDEX drawer_outs_shift_idx ON drawer_outs (business_id, shift_day);
CREATE TRIGGER drawer_outs_frozen
BEFORE UPDATE ON drawer_outs
BEGIN
  SELECT RAISE(ABORT, 'drawer_out_frozen');
END;
CREATE TRIGGER drawer_outs_shift_closed
BEFORE INSERT ON drawer_outs
WHEN EXISTS (SELECT 1 FROM shift_closes WHERE business_id = NEW.business_id AND shift_day = NEW.shift_day)
BEGIN
  SELECT RAISE(ABORT, 'shift_closed');
END;

-- A refunded advance is a debtor entry too, so the folio comes back to zero. SQLite cannot change a CHECK in place:
-- the ledger is rebuilt with 'refund' added, keeping every row and its no-update rule.
CREATE TABLE debtor_entries_new (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES debtor_accounts(id),
  kind         TEXT NOT NULL CHECK (kind IN ('charge', 'receipt', 'advance', 'advance_used', 'refund')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise <> 0),
  bill_id      TEXT REFERENCES bills(id),
  payment_id   TEXT REFERENCES payments(id),
  by_staff     TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at           INTEGER NOT NULL
);
INSERT INTO debtor_entries_new SELECT id, business_id, account_id, kind, amount_paise, bill_id, payment_id, by_staff, at FROM debtor_entries;
DROP TABLE debtor_entries;
ALTER TABLE debtor_entries_new RENAME TO debtor_entries;
CREATE INDEX debtor_entries_account_idx ON debtor_entries (account_id);
CREATE TRIGGER debtor_entries_frozen
BEFORE UPDATE ON debtor_entries
BEGIN
  SELECT RAISE(ABORT, 'entry_frozen');
END;

-- The outbox gains 'drawer_out' the same way.
CREATE TABLE outbox_new (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('bill_settled', 'bill_void', 'receipt', 'shift_closed', 'drawer_out')),
  body        TEXT NOT NULL CHECK (json_valid(body)),
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);
INSERT INTO outbox_new SELECT id, business_id, kind, body, created_at, sent_at, attempts, last_error FROM outbox;
DROP TABLE outbox;
ALTER TABLE outbox_new RENAME TO outbox;
CREATE INDEX outbox_pending_idx ON outbox (business_id, sent_at);
