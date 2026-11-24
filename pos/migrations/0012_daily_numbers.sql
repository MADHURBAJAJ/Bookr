-- Bill and credit note numbers by print date (approved 19 Nov 2026): the billing name's letter, the date printed
-- (India time) as YYMMDD, and a 3-digit number that starts at 001 each day for that billing name: C261119001.
-- print_day = the date printed (YYYY-MM-DD, India time); day_seq = the number within that day. The yearly running
-- number (seq) stays, so the financial year's series stays checked for gaps. Older bills keep their numbers
-- (print_day and day_seq empty).
ALTER TABLE bills ADD COLUMN print_day TEXT;
ALTER TABLE bills ADD COLUMN day_seq INTEGER;
CREATE UNIQUE INDEX bills_day_seq_key ON bills (entity_id, print_day, day_seq) WHERE day_seq IS NOT NULL;
ALTER TABLE credit_notes ADD COLUMN print_day TEXT;
ALTER TABLE credit_notes ADD COLUMN day_seq INTEGER;
CREATE UNIQUE INDEX credit_notes_day_seq_key ON credit_notes (entity_id, print_day, day_seq) WHERE day_seq IS NOT NULL;
