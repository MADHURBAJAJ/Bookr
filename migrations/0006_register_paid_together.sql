-- Bills paid together: several register bills settled by one payment written on one row.
-- paid_with_row_id points from each other bill to the row that holds the payment ("head").
-- Rules kept by the Worker: same shift, no chains (a head is never itself paid with another row),
-- and a bill paid with another row has no payments of its own.
ALTER TABLE register_rows ADD COLUMN paid_with_row_id TEXT REFERENCES register_rows(id) ON DELETE SET NULL;
CREATE INDEX register_rows_paid_with_idx ON register_rows (paid_with_row_id);
