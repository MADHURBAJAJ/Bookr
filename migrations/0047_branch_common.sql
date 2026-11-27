-- Common expenses (approved 28 Nov 2026): an entry in the schools list that is not a school but the group's common
-- spending (e.g. "Bajaj Group"). Expenses can be for it; fees never are; the report shows it apart from the schools.
ALTER TABLE branches ADD COLUMN is_common INTEGER NOT NULL DEFAULT 0 CHECK (is_common IN (0, 1));
