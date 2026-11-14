-- The restaurant POS sends Bookr what it records (approved 14 Nov 2026): each settled bill with its payment lines, money
-- received on folios and credit accounts, voids and shift closes. Bookr stores them as they came, once each.
-- Booking them as income and showing them on Compare sales comes next; this is the receiving end.

-- A POS connected to a business. The key is shown once to the Owner and set as a Worker secret on the POS;
-- only its SHA-256 is kept here.
CREATE TABLE pos_links (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  key_hash    TEXT NOT NULL UNIQUE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL
);

-- Every message as it came, keyed by the POS's own message id, so a message sent twice is stored once.
CREATE TABLE pos_messages (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('bill_settled', 'bill_void', 'receipt', 'shift_closed', 'drawer_out', 'credit_note')),
  body        TEXT NOT NULL CHECK (json_valid(body)),
  outcome     TEXT NOT NULL CHECK (outcome IN ('stored', 'rejected')),
  note        TEXT,
  received_at INTEGER NOT NULL
);
CREATE INDEX pos_messages_business_idx ON pos_messages (business_id, received_at);

-- A settled POS bill as printed. shift_day is the Bookr shift (8 am rule) of when it was paid.
CREATE TABLE pos_bills (
  id              TEXT PRIMARY KEY,               -- the POS bill id
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  message_id      TEXT NOT NULL REFERENCES pos_messages(id),
  bill_no         TEXT NOT NULL,
  entity_name     TEXT NOT NULL,                  -- the name on the bill (a company, an HUF ...)
  gst_registered  INTEGER NOT NULL CHECK (gst_registered IN (0, 1)),
  place           TEXT,
  guest_name      TEXT,
  printed_at      INTEGER NOT NULL,
  settled_at      INTEGER NOT NULL,
  shift_day       TEXT NOT NULL,
  gross_paise     INTEGER NOT NULL,
  discount_paise  INTEGER NOT NULL,
  discount_reason TEXT,
  cgst_paise      INTEGER NOT NULL,
  sgst_paise      INTEGER NOT NULL,
  round_off_paise INTEGER NOT NULL,
  total_paise     INTEGER NOT NULL,
  paid_together   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(paid_together)),
  settle_discount_paise INTEGER NOT NULL DEFAULT 0,   -- paid less than the bill, given as a discount at payment
  settle_discount_reason TEXT,
  tip_paise       INTEGER NOT NULL DEFAULT 0,          -- paid more than the bill(s): a tip for staff, not income
  UNIQUE (business_id, bill_no)
);
CREATE INDEX pos_bills_shift_idx ON pos_bills (business_id, shift_day);

-- One payment line: a bill's share of one tender, or money received on a folio or credit account (bill_id NULL).
-- Each carries what Bookr matches it with.
CREATE TABLE pos_payment_lines (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  message_id     TEXT NOT NULL REFERENCES pos_messages(id),
  bill_id        TEXT REFERENCES pos_bills(id),
  payment_id     TEXT NOT NULL,                  -- the POS payment (one tender can be shared over bills paid together)
  kind           TEXT NOT NULL CHECK (kind IN ('bill', 'receipt', 'advance')),
  mode           TEXT NOT NULL CHECK (mode IN ('cash', 'upi', 'card', 'room', 'credit', 'comp', 'advance')),
  amount_paise   INTEGER NOT NULL CHECK (amount_paise > 0),
  payment_total_paise INTEGER NOT NULL,          -- the whole tender (what the bank or card machine shows)
  account_id     TEXT REFERENCES accounts(id) ON DELETE SET NULL,   -- UPI: the Bookr account the QR pays into
  pay_account    TEXT,                           -- UPI: the QR's name in the POS
  card_approval  TEXT,
  card_last4     TEXT,
  debtor_name    TEXT,                           -- room folio or credit account
  comp_guest     TEXT,
  comp_reason    TEXT,
  paid_at        INTEGER NOT NULL,
  shift_day      TEXT NOT NULL
);
CREATE INDEX pos_payment_lines_shift_idx ON pos_payment_lines (business_id, shift_day);
CREATE INDEX pos_payment_lines_bill_idx ON pos_payment_lines (bill_id);

CREATE TABLE pos_voids (
  bill_no     TEXT NOT NULL,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL REFERENCES pos_messages(id),
  total_paise INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  voided_at   INTEGER NOT NULL,
  shift_day   TEXT NOT NULL,
  PRIMARY KEY (business_id, bill_no)
);

CREATE TABLE pos_shift_closes (
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shift_day        TEXT NOT NULL,                -- the POS's shift day as closed
  message_id       TEXT NOT NULL REFERENCES pos_messages(id),
  counted_paise    INTEGER NOT NULL,
  expected_paise   INTEGER NOT NULL,
  difference_paise INTEGER NOT NULL,
  difference_reason TEXT,
  closed_at        INTEGER NOT NULL,
  closed_by        TEXT,
  PRIMARY KEY (business_id, shift_day)
);

-- Cash paid out of the POS drawer, or an unused advance refunded (cash or UPI).
CREATE TABLE pos_drawer_outs (
  id           TEXT PRIMARY KEY,                -- the POS's id
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  message_id   TEXT NOT NULL REFERENCES pos_messages(id),
  kind         TEXT NOT NULL CHECK (kind IN ('paid_out', 'refund')),
  mode         TEXT NOT NULL CHECK (mode IN ('cash', 'upi')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  note         TEXT NOT NULL,
  debtor_name  TEXT,
  at           INTEGER NOT NULL,
  shift_day    TEXT NOT NULL
);
CREATE INDEX pos_drawer_outs_shift_idx ON pos_drawer_outs (business_id, shift_day);

-- Money given back on a POS bill already paid: a credit note against it, with the GST it takes back.
CREATE TABLE pos_credit_notes (
  id             TEXT PRIMARY KEY,               -- the POS's id
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  message_id     TEXT NOT NULL REFERENCES pos_messages(id),
  cn_no          TEXT NOT NULL,
  bill_no        TEXT NOT NULL,
  reason         TEXT NOT NULL,
  taxable_paise  INTEGER NOT NULL,
  cgst_paise     INTEGER NOT NULL,
  sgst_paise     INTEGER NOT NULL,
  total_paise    INTEGER NOT NULL CHECK (total_paise > 0),
  refund_mode    TEXT NOT NULL CHECK (refund_mode IN ('cash', 'upi', 'card', 'account', 'none')),
  account_id     TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  debtor_name    TEXT,
  at             INTEGER NOT NULL,
  shift_day      TEXT NOT NULL,
  UNIQUE (business_id, cn_no)
);
CREATE INDEX pos_credit_notes_shift_idx ON pos_credit_notes (business_id, shift_day);
