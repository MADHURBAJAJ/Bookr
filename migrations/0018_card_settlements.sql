-- Phase 3, part 2 (approved 8 Nov 2026): the card machine's settlement reports, by email or dropped in by hand.

-- A mail that reached Bookr's address. The raw mail is kept in R2; Message-ID stops the same mail being read twice.
CREATE TABLE inbound_mails (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL,
  from_addr   TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL,
  r2_key      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('read', 'failed', 'ignored')),
  note        TEXT,                                           -- what was read, or why not; a Gmail confirmation link
  created_at  INTEGER NOT NULL,
  UNIQUE (business_id, message_id)
);
CREATE INDEX inbound_mails_business_idx ON inbound_mails (business_id, received_at);

-- One card payment from the card company's settlement report. Transaction ID is theirs, unique per payment.
-- Matched to the confirmed card sale(s) it pays (card_matches), and, with the other payments settled that day, to the
-- bank credit that brought the money (bank_row_id); the fee and GST are booked as one expense (fee_tx_id).
CREATE TABLE card_settlements (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  mail_id        TEXT REFERENCES inbound_mails(id) ON DELETE SET NULL,
  file_name      TEXT NOT NULL,
  settled_on     TEXT NOT NULL CHECK (settled_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  merchant_id    TEXT NOT NULL,
  terminal_id    TEXT NOT NULL,
  batch_no       TEXT,
  rrn            TEXT,
  txn_id         TEXT NOT NULL,
  paid_at        INTEGER NOT NULL,                            -- ms, the payment's time (India time on the report)
  txn_type       TEXT NOT NULL,                               -- PURCHASE; anything else (a refund, a void) is never matched to a bill
  amount_paise   INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer'),
  fee_paise      INTEGER NOT NULL CHECK (typeof(fee_paise) = 'integer'),   -- what the card company kept, as a positive number
  gst_paise      INTEGER NOT NULL CHECK (typeof(gst_paise) = 'integer'),   -- GST on the fee, positive
  net_paise      INTEGER NOT NULL CHECK (typeof(net_paise) = 'integer'),
  scheme         TEXT,
  card_type      TEXT,
  card_last4     TEXT,
  auth_code      TEXT,
  bank_row_id    TEXT REFERENCES bank_rows(id) ON DELETE SET NULL,
  fee_tx_id      TEXT REFERENCES transactions(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  UNIQUE (business_id, txn_id)
);
CREATE INDEX card_settlements_day_idx ON card_settlements (business_id, settled_on);
CREATE INDEX card_settlements_bank_idx ON card_settlements (bank_row_id);

-- A card payment and the confirmed card sale(s) it pays: one swipe for bills paid together, or one bill paid on two
-- cards. Payments and bills matched in one action are unmatched together.
CREATE TABLE card_matches (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  settlement_id  TEXT NOT NULL REFERENCES card_settlements(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  matched_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  matched_at     INTEGER NOT NULL,
  UNIQUE (settlement_id, transaction_id)
);
CREATE INDEX card_matches_tx_idx ON card_matches (transaction_id);
