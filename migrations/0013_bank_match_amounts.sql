-- One bill can be paid by several UPI credits (e.g. a guest paying in two goes), and one credit can pay several
-- bills. Each link now says how much of the credit goes to that bill. Approved 2 Nov 2026.
-- Nothing references bank_matches, so it is rebuilt; existing links keep the whole bill amount.
CREATE TABLE bank_matches_new (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  bank_row_id    TEXT NOT NULL REFERENCES bank_rows(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  amount_paise   INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer' AND amount_paise > 0),
  matched_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  matched_at     INTEGER NOT NULL,
  UNIQUE (bank_row_id, transaction_id)
);
INSERT INTO bank_matches_new (id, business_id, bank_row_id, transaction_id, amount_paise, matched_by, matched_at)
  SELECT m.id, m.business_id, m.bank_row_id, m.transaction_id, t.amount_paise, m.matched_by, m.matched_at
  FROM bank_matches m JOIN transactions t ON t.id = m.transaction_id;
DROP TABLE bank_matches;
ALTER TABLE bank_matches_new RENAME TO bank_matches;
CREATE INDEX bank_matches_row_idx ON bank_matches (bank_row_id);
CREATE INDEX bank_matches_tx_idx ON bank_matches (transaction_id);
