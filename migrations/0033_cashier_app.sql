-- Cashier phone app (approved 21 Nov 2026). Only new columns; no existing row changes.
--
-- 1. Why a count is short or extra.
ALTER TABLE cash_counts ADD COLUMN note TEXT;

-- 2. Expense review: the accountant sets the head (head_id, already kept), the owner approves or rejects with a note.
--    NULL = waiting. A rejected expense stays rejected; the cash still left the book.
ALTER TABLE cash_entries ADD COLUMN review_status TEXT CHECK (review_status IS NULL OR review_status IN ('approved', 'rejected'));
ALTER TABLE cash_entries ADD COLUMN reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE cash_entries ADD COLUMN reviewed_at INTEGER;
ALTER TABLE cash_entries ADD COLUMN review_note TEXT;

-- 3. The cashier's fee cash total for a day (a typed 'fee' line): how many receipts, first and last receipt no., and how
--    a difference with the fee day sheet was sorted out: 'kept' (the cashier keeps their amount until a later sheet has
--    the receipts) or 'sheet' (the sheet is right). Once the sheet is in, the book uses the sheet.
ALTER TABLE cash_entries ADD COLUMN fee_receipts INTEGER CHECK (fee_receipts IS NULL OR (typeof(fee_receipts) = 'integer' AND fee_receipts > 0));
ALTER TABLE cash_entries ADD COLUMN fee_first TEXT;
ALTER TABLE cash_entries ADD COLUMN fee_last TEXT;
ALTER TABLE cash_entries ADD COLUMN fee_settle TEXT CHECK (fee_settle IS NULL OR fee_settle IN ('kept', 'sheet'));
