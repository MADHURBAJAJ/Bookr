-- Loans (approved 24 Nov 2026): money lent to or borrowed by the company, and deposits, each an account with a balance.
-- Lines come from Bank money in / out (booked as a transfer row, not income or an expense; an EMI's interest goes under
-- a head) or are typed in. A UPI ID or word can be remembered for a loan, so its next line is suggested, never booked.
CREATE TABLE loans (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('taken', 'given', 'deposit_paid', 'deposit_received')),
  opening_paise INTEGER NOT NULL DEFAULT 0 CHECK (typeof(opening_paise) = 'integer'),
  opening_day   TEXT CHECK (opening_day IS NULL OR opening_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  note          TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX loans_name_key ON loans (business_id, lower(name));

CREATE TABLE loan_entries (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  loan_id        TEXT NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  day            TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  direction      TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  amount_paise   INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer' AND amount_paise > 0),
  interest_paise INTEGER NOT NULL DEFAULT 0 CHECK (typeof(interest_paise) = 'integer' AND interest_paise >= 0),
  note           TEXT,
  bank_row_id    TEXT,
  transaction_id TEXT,
  interest_tx_id TEXT,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL
);
CREATE INDEX loan_entries_loan_idx ON loan_entries (loan_id, day);
CREATE UNIQUE INDEX loan_entries_bank_key ON loan_entries (bank_row_id) WHERE bank_row_id IS NOT NULL;

CREATE TABLE loan_keys (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  loan_id     TEXT NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (business_id, key)
);
