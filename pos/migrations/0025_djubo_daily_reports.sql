-- Djubo's daily reports (24 Nov 2026, approved by the owner): bookings made before the POS read Djubo's mails are filled
-- in from the Daily Front Office Report, and guests already staying are brought in from the Daily Occupied Rooms Report.
-- The report has no total rent and no phone: reception types the total rent from Djubo once (the rest of what Djubo says
-- is still to collect counts as paid before).
ALTER TABLE bookings ADD COLUMN from_report INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN report_due_paise INTEGER;      -- what Djubo's report said was still to collect, when first read
ALTER TABLE stays ADD COLUMN before_pos INTEGER NOT NULL DEFAULT 0;   -- checked in before the POS, brought in from the report
