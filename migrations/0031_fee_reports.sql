-- Fee check (approved 20 Nov 2026): the fee software's daily report (FeeDaySheet) brought into a school business.
-- One file covers every school of the group (and the other business's schools too): each receipt number carries its
-- school's code (26SMSSMS3872 -> SMSSMS, 26BISPBIST4352 -> BISPBIST). A code is linked once to a branch, or marked as
-- not this business's. Cash fees are filled into each cashier's book from the report ("soft fill"): one line per
-- cashier book per day, replaced when the day's report is brought in again. A bank transfer or cheque receipt is
-- matched to its bank credit.

-- Which branch a receipt code belongs to; branch_id NULL = not this business (its lines are left out).
CREATE TABLE fee_codes (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  code        TEXT NOT NULL CHECK (length(code) > 0),
  branch_id   TEXT REFERENCES branches(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (business_id, code)
);

-- Which cashier book the report's Cashier name fills (account_id NULL = no book, e.g. an online login).
-- Names match on their own when they equal the book's cashier or book name; this keeps the ones a person chose.
CREATE TABLE fee_cashiers (
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name_key     TEXT NOT NULL CHECK (length(name_key) > 0),   -- lower case, single spaces
  account_id   TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (business_id, name_key)
);

-- One day's report as brought in. Bringing in the same day again replaces it.
CREATE TABLE fee_reports (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  day          TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  file_name    TEXT,
  footer       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(footer)),   -- the report's own totals (whole file), as read
  imported_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (business_id, day)
);

-- One fee line of the report (several lines make one receipt).
CREATE TABLE fee_lines (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  report_id       TEXT NOT NULL REFERENCES fee_reports(id) ON DELETE CASCADE,
  line_no         INTEGER NOT NULL,
  day             TEXT NOT NULL,
  receipt_no      TEXT NOT NULL,
  code            TEXT NOT NULL,
  enrollment_code TEXT,
  admission_no    TEXT,
  student         TEXT,
  class_section   TEXT,
  fee_type        TEXT,
  mode            TEXT NOT NULL CHECK (mode IN ('cash', 'upi', 'card', 'bank', 'cheque', 'other')),
  mode_text       TEXT,
  cashier         TEXT,
  amount_paise    INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer'),
  UNIQUE (report_id, line_no)
);
CREATE INDEX fee_lines_receipt_idx ON fee_lines (business_id, receipt_no);
CREATE INDEX fee_lines_day_idx ON fee_lines (business_id, day, mode);

-- A bank transfer or cheque receipt and the bank credit that paid it.
CREATE TABLE fee_receipt_matches (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  receipt_no  TEXT NOT NULL,
  bank_row_id TEXT NOT NULL UNIQUE REFERENCES bank_rows(id) ON DELETE CASCADE,
  matched_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  matched_at  INTEGER NOT NULL,
  UNIQUE (business_id, receipt_no)
);

-- A cash book line filled from a day's report (soft fill): its amount comes from the report, not typed.
ALTER TABLE cash_entries ADD COLUMN fee_report_id TEXT REFERENCES fee_reports(id) ON DELETE CASCADE;
CREATE INDEX cash_entries_fee_report_idx ON cash_entries (fee_report_id);
