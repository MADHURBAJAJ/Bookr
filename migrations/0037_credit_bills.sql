-- Credit bills (approved 23 Nov 2026). A bill the software calls U/N, not in the register, that the guest will pay
-- later: a person makes it credit with the guest's name. It is counted as a sale on its own day with no payment mode
-- (nothing in the cash or the bank yet); when the guest's money comes, a person matches that bank credit to it.
-- Keyed by shift and bill number, like complimentary_marks, so it outlives the comparison rows. No existing row changes.

CREATE TABLE credit_bills (
  id           TEXT PRIMARY KEY,
  business_id  TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  shift_day    TEXT NOT NULL,
  bill_no      TEXT NOT NULL,
  guest_name   TEXT NOT NULL CHECK (length(trim(guest_name)) > 0),
  amount_paise INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer' AND amount_paise > 0),
  made_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  made_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX credit_bills_key ON credit_bills (business_id, shift_day, bill_no);
