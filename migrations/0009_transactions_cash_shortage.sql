-- Allows source = 'cash_shortage': an approved Cash expense booked by an Owner when the cash counted
-- for a shift is less than it should be. Same columns as before; every row is copied across.
-- (SQLite cannot change a CHECK in place. Nothing references transactions, so the swap is safe.)
CREATE TABLE transactions_new (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id       TEXT REFERENCES accounts(id),
  day              TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount_paise     INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer'),
  type             TEXT NOT NULL CHECK (type IN ('income', 'expense', 'transfer')),
  head_id          TEXT REFERENCES heads(id),
  narration        TEXT,
  source           TEXT NOT NULL CHECK (source IN ('software_report', 'cash_photo', 'bank_sheet', 'cash_shortage')),
  status           TEXT NOT NULL CHECK (status IN ('draft', 'reviewed', 'approved')),
  payment_mode     TEXT CHECK (payment_mode IS NULL OR payment_mode IN ('cash', 'upi', 'card')),
  upload_id        TEXT REFERENCES uploads(id) ON DELETE SET NULL,
  line_no          INTEGER,
  ocr_original     TEXT CHECK (ocr_original IS NULL OR json_valid(ocr_original)),
  bill_no          TEXT,
  pos_no           TEXT,
  confirmed_source TEXT CHECK (confirmed_source IS NULL OR confirmed_source IN ('software', 'register', 'both_matched')),
  comparison_id    TEXT REFERENCES bill_comparisons(id) ON DELETE SET NULL,
  shift_day        TEXT,
  match_status     TEXT CHECK (match_status IS NULL OR match_status IN ('awaiting_bank_match', 'awaiting_card_settlement')),
  party_id         TEXT,
  transfer_pair_id TEXT,
  matched_bank_row TEXT,
  created_at       INTEGER NOT NULL
);
INSERT INTO transactions_new SELECT id, business_id, account_id, day, amount_paise, type, head_id, narration, source, status,
  payment_mode, upload_id, line_no, ocr_original, bill_no, pos_no, confirmed_source, comparison_id, shift_day, match_status,
  party_id, transfer_pair_id, matched_bank_row, created_at FROM transactions;
DROP TABLE transactions;
ALTER TABLE transactions_new RENAME TO transactions;
CREATE INDEX transactions_day_idx ON transactions (business_id, day);
CREATE INDEX transactions_shift_idx ON transactions (business_id, shift_day, source);
CREATE INDEX transactions_upload_idx ON transactions (upload_id, line_no);
