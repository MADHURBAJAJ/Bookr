-- Room billing (24 Nov 2026, approved: "Yes, build it"). Djubo keeps rooms, dates, rates and any advance taken before
-- arrival; the POS reads them from Djubo's mails, takes only the money received at the hotel (each payment gets a
-- numbered receipt), and at check-out prints one tax invoice for the stay's room rent. Djubo issues no room invoice.

-- 1. More of what a booking mail carries, for the booking card at check-in.
ALTER TABLE bookings ADD COLUMN booked_at TEXT;     -- when the booking was made, as the mail says it (India time, 'YYYY-MM-DD HH:MM')
ALTER TABLE bookings ADD COLUMN changed_at TEXT;    -- when it was last changed, as the mail says it
ALTER TABLE bookings ADD COLUMN meal_plan TEXT;     -- e.g. Room Only, Breakfast
ALTER TABLE bookings ADD COLUMN requests TEXT;      -- the guest's special requests

-- 2. The room's folio gains room rent (from the booking, or added by hand: an extra bed, a late check-out), what was
-- paid before arrival (to the OTA or the booking team: not money in this POS), and a refundable deposit (money taken
-- at the hotel, kept apart from rent and refunded at check-out). SQLite cannot change a CHECK in place, so the ledger is
-- rebuilt with every row and its no-change rule kept.
CREATE TABLE debtor_entries_new (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id   TEXT NOT NULL REFERENCES debtor_accounts(id),
  kind         TEXT NOT NULL CHECK (kind IN ('charge', 'receipt', 'advance', 'advance_used', 'refund', 'credit_note', 'room_rent', 'prepaid', 'deposit')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise <> 0),
  bill_id      TEXT REFERENCES bills(id),
  payment_id   TEXT REFERENCES payments(id),
  by_staff     TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at           INTEGER NOT NULL,
  booking_id   TEXT REFERENCES bookings(id),       -- room rent and prepaid read from this booking
  note         TEXT,                               -- what a charge by hand is for; who was paid before arrival
  CHECK (kind NOT IN ('room_rent', 'prepaid') OR booking_id IS NOT NULL OR note IS NOT NULL)
);
INSERT INTO debtor_entries_new (id, business_id, account_id, kind, amount_paise, bill_id, payment_id, by_staff, at)
  SELECT id, business_id, account_id, kind, amount_paise, bill_id, payment_id, by_staff, at FROM debtor_entries;
DROP TABLE debtor_entries;
ALTER TABLE debtor_entries_new RENAME TO debtor_entries;
CREATE INDEX debtor_entries_account_idx ON debtor_entries (account_id);
CREATE TRIGGER debtor_entries_frozen
BEFORE UPDATE ON debtor_entries
BEGIN
  SELECT RAISE(ABORT, 'entry_frozen');
END;

-- 3. Every payment taken on a folio or credit account gets a receipt number, running per business and financial year
-- (RCPT/26-27/0001).
ALTER TABLE settlements ADD COLUMN receipt_no TEXT;
CREATE UNIQUE INDEX settlements_receipt_no_key ON settlements (business_id, receipt_no) WHERE receipt_no IS NOT NULL;
CREATE TABLE receipt_series (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  fy          TEXT NOT NULL,
  next_no     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (business_id, fy)
);

-- 4. The stay's tax invoice for room rent, made once at check-out, in its own series per billing name and financial
-- year (e.g. XR2627-0001). Food has its own bills already; the invoice lists them only as paid separately.
CREATE TABLE room_invoices (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  stay_id        TEXT NOT NULL UNIQUE REFERENCES stays(id),
  entity_id      TEXT NOT NULL REFERENCES billing_entities(id),
  fy             TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  invoice_no     TEXT NOT NULL CHECK (length(invoice_no) <= 16),
  shift_day      TEXT NOT NULL,
  guest_name     TEXT NOT NULL,
  phone          TEXT,
  room           TEXT NOT NULL,
  check_in       TEXT NOT NULL,
  check_out      TEXT NOT NULL,
  nights         INTEGER NOT NULL CHECK (nights > 0),
  lines          TEXT NOT NULL CHECK (json_valid(lines)),   -- [{name, amountPaise}] as printed, GST included
  gst_rate_bp    INTEGER NOT NULL,
  taxable_paise  INTEGER NOT NULL,
  cgst_paise     INTEGER NOT NULL,
  sgst_paise     INTEGER NOT NULL,
  total_paise    INTEGER NOT NULL CHECK (total_paise > 0),
  by_staff       TEXT REFERENCES staff(id) ON DELETE SET NULL,
  at             INTEGER NOT NULL,
  UNIQUE (entity_id, fy, seq),
  UNIQUE (business_id, invoice_no),
  CHECK (taxable_paise + cgst_paise + sgst_paise = total_paise)
);
CREATE INDEX room_invoices_shift_idx ON room_invoices (business_id, shift_day);
CREATE TRIGGER room_invoices_frozen BEFORE UPDATE ON room_invoices
BEGIN
  SELECT RAISE(ABORT, 'invoice_frozen');
END;
CREATE TRIGGER room_invoices_no_delete
BEFORE DELETE ON room_invoices
WHEN EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id)
BEGIN
  SELECT RAISE(ABORT, 'invoice_frozen');
END;
CREATE TABLE room_invoice_series (
  entity_id TEXT NOT NULL REFERENCES billing_entities(id) ON DELETE CASCADE,
  fy        TEXT NOT NULL,
  next_no   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (entity_id, fy)
);
