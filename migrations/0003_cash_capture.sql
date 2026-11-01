-- Phase 2: cash capture. See docs/phase2-context.md, "Phase 2 design".
-- Money is integer paise. Times are integer milliseconds (UTC). Days are 'YYYY-MM-DD' text,
-- worked out in India time. Shift of day D = D 08:00 up to D+1 08:00 (India time).

CREATE TABLE uploads (
  id                       TEXT PRIMARY KEY,
  business_id              TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind                     TEXT NOT NULL CHECK (kind IN ('software_sales_csv', 'bill_register', 'expense_list', 'cash_summary', 'single_bill')),
  business_day             TEXT NOT NULL CHECK (business_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  storage_key              TEXT NOT NULL,              -- R2 key; a CSV is kept only with its NAME column blanked
  content_sha256           TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status IN ('uploaded', 'reading', 'ready', 'retake', 'approved', 'failed')),
  page_written_total_paise INTEGER CHECK (page_written_total_paise IS NULL OR typeof(page_written_total_paise) = 'integer'),
  ocr_engine               TEXT CHECK (ocr_engine IS NULL OR ocr_engine IN ('document_ai', 'claude_vision', 'manual', 'sample')),
  uploaded_by              TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at               INTEGER NOT NULL
);
CREATE UNIQUE INDEX uploads_business_sha_key ON uploads (business_id, content_sha256);
CREATE INDEX uploads_business_day_idx ON uploads (business_id, business_day);

CREATE TABLE sales_reports (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  upload_id          TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  covers_from        INTEGER NOT NULL,
  covers_to          INTEGER NOT NULL,
  first_paid_at      INTEGER NOT NULL,
  last_paid_at       INTEGER NOT NULL,
  bill_count         INTEGER NOT NULL,
  footer_bills       INTEGER NOT NULL,
  footer_upi_paise   INTEGER NOT NULL,
  footer_card_paise  INTEGER NOT NULL,
  footer_cash_paise  INTEGER NOT NULL,
  footer_total_paise INTEGER NOT NULL,
  bills_added        INTEGER NOT NULL DEFAULT 0,
  bills_skipped      INTEGER NOT NULL DEFAULT 0,
  bills_flagged      INTEGER NOT NULL DEFAULT 0,
  replaced_by        TEXT REFERENCES sales_reports(id) ON DELETE SET NULL,
  created_at         INTEGER NOT NULL,
  CHECK (covers_from <= covers_to)
);
CREATE INDEX sales_reports_business_idx ON sales_reports (business_id, covers_from);

CREATE TABLE shifts (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shift_day     TEXT NOT NULL CHECK (shift_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'comparing', 'confirmed')),
  confirmed_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at  INTEGER,
  reopened_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  reopened_at   INTEGER,
  reopen_reason TEXT,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX shifts_business_day_key ON shifts (business_id, shift_day);

-- A shift is confirmed once. A second confirm in a race rolls its whole batch back.
CREATE TRIGGER shifts_confirm_once
BEFORE UPDATE OF status ON shifts
WHEN OLD.status = 'confirmed' AND NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'shift_confirmed');
END;

CREATE TABLE software_bills (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  report_id        TEXT NOT NULL REFERENCES sales_reports(id) ON DELETE CASCADE,
  pos_no           TEXT NOT NULL,
  bill_no          TEXT NOT NULL,
  si_no            TEXT,
  paid_at          INTEGER NOT NULL,
  shift_day        TEXT NOT NULL,
  mode             TEXT NOT NULL CHECK (mode IN ('upi', 'card', 'cash', 'unknown')),
  amount_paise     INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer'),
  discount_paise   INTEGER NOT NULL DEFAULT 0 CHECK (typeof(discount_paise) = 'integer'),
  is_complimentary INTEGER NOT NULL CHECK (is_complimentary IN (0, 1)),
  created_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX software_bills_key ON software_bills (business_id, pos_no, bill_no);
CREATE INDEX software_bills_shift_idx ON software_bills (business_id, shift_day);

CREATE TABLE software_bill_conflicts (
  id                      TEXT PRIMARY KEY,
  business_id             TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  report_id               TEXT NOT NULL REFERENCES sales_reports(id) ON DELETE CASCADE,
  existing_bill_id        TEXT NOT NULL REFERENCES software_bills(id) ON DELETE CASCADE,
  incoming_paid_at        INTEGER NOT NULL,
  incoming_mode           TEXT NOT NULL CHECK (incoming_mode IN ('upi', 'card', 'cash', 'unknown')),
  incoming_amount_paise   INTEGER NOT NULL CHECK (typeof(incoming_amount_paise) = 'integer'),
  incoming_discount_paise INTEGER NOT NULL CHECK (typeof(incoming_discount_paise) = 'integer'),
  decision                TEXT CHECK (decision IS NULL OR decision IN ('keep_existing', 'use_incoming')),
  decided_by              TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at              INTEGER,
  created_at              INTEGER NOT NULL
);
CREATE INDEX software_bill_conflicts_bill_idx ON software_bill_conflicts (existing_bill_id);

CREATE TABLE register_rows (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  upload_id    TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  line_no      INTEGER NOT NULL,
  shift_day    TEXT NOT NULL,
  bill_no      TEXT NOT NULL,
  bill_type    TEXT CHECK (bill_type IS NULL OR bill_type IN ('fnb', 'room')),
  amount_paise INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer'),
  remarks      TEXT,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'checked')),
  ocr_original TEXT CHECK (ocr_original IS NULL OR json_valid(ocr_original)),
  edited_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  edited_at    INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX register_rows_shift_idx ON register_rows (business_id, shift_day);
CREATE INDEX register_rows_upload_idx ON register_rows (upload_id, line_no);

CREATE TABLE register_payments (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  register_row_id TEXT NOT NULL REFERENCES register_rows(id) ON DELETE CASCADE,
  mode            TEXT NOT NULL CHECK (mode IN ('cash', 'upi', 'card')),
  column_label    TEXT,
  amount_paise    INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer'),
  created_at      INTEGER NOT NULL
);
CREATE INDEX register_payments_row_idx ON register_payments (register_row_id);

-- Register rows of a confirmed shift cannot change. An Owner must reopen the shift first.
CREATE TRIGGER register_rows_locked_update
BEFORE UPDATE ON register_rows
WHEN EXISTS (SELECT 1 FROM shifts WHERE business_id = OLD.business_id AND status = 'confirmed' AND shift_day IN (OLD.shift_day, NEW.shift_day))
BEGIN
  SELECT RAISE(ABORT, 'shift_confirmed');
END;
CREATE TRIGGER register_rows_locked_insert
BEFORE INSERT ON register_rows
WHEN EXISTS (SELECT 1 FROM shifts WHERE business_id = NEW.business_id AND shift_day = NEW.shift_day AND status = 'confirmed')
BEGIN
  SELECT RAISE(ABORT, 'shift_confirmed');
END;
CREATE TRIGGER register_rows_locked_delete
BEFORE DELETE ON register_rows
WHEN EXISTS (SELECT 1 FROM shifts WHERE business_id = OLD.business_id AND shift_day = OLD.shift_day AND status = 'confirmed')
  AND EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
BEGIN
  SELECT RAISE(ABORT, 'shift_confirmed');
END;
CREATE TRIGGER software_bills_locked_insert
BEFORE INSERT ON software_bills
WHEN EXISTS (SELECT 1 FROM shifts WHERE business_id = NEW.business_id AND shift_day = NEW.shift_day AND status = 'confirmed')
BEGIN
  SELECT RAISE(ABORT, 'shift_confirmed');
END;
CREATE TRIGGER software_bills_locked_update
BEFORE UPDATE ON software_bills
WHEN EXISTS (SELECT 1 FROM shifts WHERE business_id = OLD.business_id AND status = 'confirmed' AND shift_day IN (OLD.shift_day, NEW.shift_day))
BEGIN
  SELECT RAISE(ABORT, 'shift_confirmed');
END;
CREATE TRIGGER software_bills_locked_delete
BEFORE DELETE ON software_bills
WHEN EXISTS (SELECT 1 FROM shifts WHERE business_id = OLD.business_id AND shift_day = OLD.shift_day AND status = 'confirmed')
  AND EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
BEGIN
  SELECT RAISE(ABORT, 'shift_confirmed');
END;

CREATE TABLE bill_comparisons (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shift_day        TEXT NOT NULL,
  pos_no           TEXT NOT NULL,            -- '' when the bill is only in the register
  bill_no          TEXT NOT NULL,
  software_bill_id TEXT REFERENCES software_bills(id) ON DELETE SET NULL,
  register_row_id  TEXT REFERENCES register_rows(id) ON DELETE SET NULL,
  sw_amount_paise  INTEGER,
  sw_mode          TEXT,
  rg_amount_paise  INTEGER,
  rg_mode          TEXT,                     -- 'mixed' when the register shows more than one mode
  difference       TEXT NOT NULL CHECK (difference IN ('match', 'amount', 'mode', 'amount_and_mode', 'missing_in_register', 'missing_in_software', 'complimentary')),
  decision         TEXT CHECK (decision IS NULL OR decision IN ('use_software', 'use_register', 'leave_out')),
  decided_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at       INTEGER,
  note             TEXT,
  created_at       INTEGER NOT NULL,
  CHECK (decision IS NULL OR difference NOT IN ('match', 'complimentary'))
);
CREATE UNIQUE INDEX bill_comparisons_key ON bill_comparisons (business_id, shift_day, pos_no, bill_no);

CREATE TRIGGER bill_comparisons_locked
BEFORE UPDATE OF decision ON bill_comparisons
WHEN EXISTS (SELECT 1 FROM shifts WHERE business_id = OLD.business_id AND shift_day = OLD.shift_day AND status = 'confirmed')
BEGIN
  SELECT RAISE(ABORT, 'shift_confirmed');
END;

CREATE TABLE bill_type_heads (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bill_type   TEXT NOT NULL CHECK (bill_type IN ('fnb', 'room')),
  head_id     TEXT NOT NULL REFERENCES heads(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (business_id, bill_type)
);

CREATE TABLE cash_summaries (
  id                   TEXT PRIMARY KEY,
  business_id          TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  upload_id            TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  shift_day            TEXT NOT NULL,
  opening_paise        INTEGER CHECK (opening_paise IS NULL OR typeof(opening_paise) = 'integer'),
  received_paise       INTEGER CHECK (received_paise IS NULL OR typeof(received_paise) = 'integer'),
  balance_paise        INTEGER CHECK (balance_paise IS NULL OR typeof(balance_paise) = 'integer'),
  expenses_paise       INTEGER CHECK (expenses_paise IS NULL OR typeof(expenses_paise) = 'integer'),
  cash_in_hand_paise   INTEGER CHECK (cash_in_hand_paise IS NULL OR typeof(cash_in_hand_paise) = 'integer'),
  ocr_original         TEXT CHECK (ocr_original IS NULL OR json_valid(ocr_original)),
  status               TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'checked', 'approved')),
  mismatch_note        TEXT,
  mismatch_accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  mismatch_accepted_at INTEGER,
  created_at           INTEGER NOT NULL
);
CREATE UNIQUE INDEX cash_summaries_upload_key ON cash_summaries (upload_id);
CREATE INDEX cash_summaries_day_idx ON cash_summaries (business_id, shift_day);

CREATE TABLE transactions (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id       TEXT REFERENCES accounts(id),
  day              TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  amount_paise     INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer'),
  type             TEXT NOT NULL CHECK (type IN ('income', 'expense', 'transfer')),
  head_id          TEXT REFERENCES heads(id),
  narration        TEXT,
  source           TEXT NOT NULL CHECK (source IN ('software_report', 'cash_photo', 'bank_sheet')),
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
CREATE INDEX transactions_day_idx ON transactions (business_id, day);
CREATE INDEX transactions_shift_idx ON transactions (business_id, shift_day, source);
CREATE INDEX transactions_upload_idx ON transactions (upload_id, line_no);
