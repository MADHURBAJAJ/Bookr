-- Money reception marks in Djubo (26 Nov 2026): counted in the POS on the day it was marked. Each increase in a booking's
-- paid amount, from a Djubo mail made or changed by anyone but the booking team and the OTAs, gets a POS receipt once
-- someone picks how it was paid (cash, UPI or card); this links that mail's increase to its receipt.
ALTER TABLE booking_paid_log ADD COLUMN settlement_id TEXT REFERENCES settlements(id);
