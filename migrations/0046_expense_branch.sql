-- Which school an expense is for (approved 28 Nov 2026). An expense paid from one school's cash can be for another
-- school, or for the group (a school added with no cashier, e.g. "Bajaj Group"). Empty on older lines: the book's school.
ALTER TABLE cash_entries ADD COLUMN for_branch_id TEXT REFERENCES branches(id) ON DELETE SET NULL;
