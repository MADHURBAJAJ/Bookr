-- Waiting means "needs a look" (Stage 2, approved 10 Nov 2026). A bill found on one side only is watched for 7 days;
-- after that a person closes it with a reason, or keeps it waiting 7 more days with a note. watch_until is the last day
-- of the watch so kept (YYYY-MM-DD); NULL means the usual 7 days from its shift. Cleared when the bill changes.
ALTER TABLE bill_comparisons ADD COLUMN watch_until TEXT CHECK (watch_until IS NULL OR watch_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
ALTER TABLE bill_comparisons ADD COLUMN watch_note TEXT;
