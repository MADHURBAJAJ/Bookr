-- Card settlement rule (approved 8 Nov 2026): set once per card machine (terminal), it says where the card company's
-- fee (MDR) and the GST on that fee are booked. No input credit is claimed, so both are plain expense heads. With a
-- rule, a settlement books the fee and the GST as two expense rows without asking.
CREATE TABLE card_rules (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  terminal_id  TEXT NOT NULL,
  fee_head_id  TEXT NOT NULL REFERENCES heads(id),
  gst_head_id  TEXT NOT NULL REFERENCES heads(id),
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (business_id, terminal_id)
);

-- The GST on the fee is its own expense row, next to the fee's (fee_tx_id).
ALTER TABLE card_settlements ADD COLUMN gst_tx_id TEXT REFERENCES transactions(id) ON DELETE SET NULL;
