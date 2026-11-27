-- Remarks on the KOT (26 Nov 2026, approved by the owner): a remark on an order line ("no onion", "extra sugar"),
-- which keeps it a line of its own, and a note for the whole order ("extra tissues"). Both print on the KOT, and each
-- KOT keeps the note it printed with, so a reprint shows it too. Neither prints on the bill.
ALTER TABLE order_lines ADD COLUMN remark TEXT CHECK (remark IS NULL OR length(remark) <= 120);
ALTER TABLE orders ADD COLUMN kot_note TEXT CHECK (kot_note IS NULL OR length(kot_note) <= 200);
ALTER TABLE kots ADD COLUMN note TEXT;
