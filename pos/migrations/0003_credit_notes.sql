-- Credit notes (14 Nov 2026): a settled bill is never changed; money given back is a credit note against it, with its own
-- consecutive number per billing name and financial year (e.g. C-CN2627-0001, at most 16 characters), the reason, and how the
-- money went back. The credited value and tax are worked out from the bill, so GST is reduced by exactly what was credited.
CREATE TABLE credit_notes (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bill_id         TEXT NOT NULL REFERENCES bills(id),
  entity_id       TEXT NOT NULL REFERENCES billing_entities(id),
  fy              TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  cn_no           TEXT NOT NULL CHECK (length(cn_no) <= 16),
  shift_day       TEXT NOT NULL,
  reason          TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  lines           TEXT NOT NULL CHECK (json_valid(lines)),    -- [{name, qty, amountPaise}] credited
  gross_paise     INTEGER NOT NULL CHECK (gross_paise > 0),
  discount_paise  INTEGER NOT NULL,
  taxable_paise   INTEGER NOT NULL,
  cgst_paise      INTEGER NOT NULL,
  sgst_paise      INTEGER NOT NULL,
  round_off_paise INTEGER NOT NULL,
  total_paise     INTEGER NOT NULL CHECK (total_paise > 0),
  refund_mode     TEXT NOT NULL CHECK (refund_mode IN ('cash', 'upi', 'card', 'account', 'none')),
  pay_account_id  TEXT REFERENCES pay_accounts(id),
  debtor_account_id TEXT REFERENCES debtor_accounts(id),
  by_staff        TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at              INTEGER NOT NULL,
  UNIQUE (entity_id, fy, seq),
  UNIQUE (business_id, cn_no),
  CHECK ((refund_mode = 'account') = (debtor_account_id IS NOT NULL))
);
CREATE INDEX credit_notes_shift_idx ON credit_notes (business_id, shift_day);
CREATE INDEX credit_notes_bill_idx ON credit_notes (bill_id);
CREATE TRIGGER credit_notes_frozen
BEFORE UPDATE ON credit_notes
BEGIN
  SELECT RAISE(ABORT, 'credit_note_frozen');
END;
CREATE TRIGGER credit_notes_shift_closed
BEFORE INSERT ON credit_notes
WHEN EXISTS (SELECT 1 FROM shift_closes WHERE business_id = NEW.business_id AND shift_day = NEW.shift_day)
BEGIN
  SELECT RAISE(ABORT, 'shift_closed');
END;

CREATE TABLE credit_note_series (
  entity_id TEXT NOT NULL REFERENCES billing_entities(id) ON DELETE CASCADE,
  fy        TEXT NOT NULL,
  next_no   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (entity_id, fy)
);

-- The debtor ledger, the exceptions report and the outbox each gain a kind. SQLite cannot change a CHECK in place, so each
-- is rebuilt with every row and its no-change rules kept.
CREATE TABLE debtor_entries_new (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES debtor_accounts(id),
  kind         TEXT NOT NULL CHECK (kind IN ('charge', 'receipt', 'advance', 'advance_used', 'refund', 'credit_note')),
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

CREATE TABLE pos_events_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('void', 'reprint', 'kot_cancel', 'discount', 'comp', 'limit_warning', 'credit_note', 'stock_waste', 'stock_count')),
  ref          TEXT NOT NULL,
  amount_paise INTEGER,
  reason       TEXT,
  detail       TEXT,
  by_staff     TEXT REFERENCES staff(id) ON DELETE SET NULL,
  shift_day    TEXT NOT NULL,
  at           INTEGER NOT NULL
);
INSERT INTO pos_events_new SELECT id, business_id, kind, ref, amount_paise, reason, detail, by_staff, shift_day, at FROM pos_events;
DROP TABLE pos_events;
ALTER TABLE pos_events_new RENAME TO pos_events;
CREATE INDEX pos_events_shift_idx ON pos_events (business_id, shift_day);
CREATE TRIGGER pos_events_frozen
BEFORE UPDATE ON pos_events
BEGIN
  SELECT RAISE(ABORT, 'event_frozen');
END;
CREATE TRIGGER pos_events_no_delete
BEFORE DELETE ON pos_events
WHEN EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
BEGIN
  SELECT RAISE(ABORT, 'event_frozen');
END;

CREATE TABLE outbox_new (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('bill_settled', 'bill_void', 'receipt', 'shift_closed', 'drawer_out', 'credit_note')),
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
