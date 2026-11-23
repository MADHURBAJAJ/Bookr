-- Closing a cash book (approved 23 Nov 2026). A book with history is closed, not deleted: it leaves the lists and the
-- hand-over choices, nobody writes in it, and its old days stay readable under "Closed books". It can be reopened.
-- A book never used (no lines, nothing handed to it) is removed outright instead, which needs no column.
-- Only cash books are closed. No existing row changes.

ALTER TABLE accounts ADD COLUMN closed_at INTEGER;
ALTER TABLE accounts ADD COLUMN closed_by TEXT REFERENCES users(id) ON DELETE SET NULL;
