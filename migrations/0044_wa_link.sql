-- Linking a WhatsApp number from POS › Settings › WhatsApp (approved 27 Nov 2026). Like wa_listener_status (one row, the
-- one listener), not of any one business. The POS asks (Owner only); the listener picks the request up with its
-- heartbeat, sends the QR to scan while it links, and says how it ended. Only the last 4 digits of the linked number are
-- kept. The QR is kept only while a link is asked for (3 minutes at most) and is cleared when it ends.
ALTER TABLE wa_listener_status ADD COLUMN linked_last4 TEXT CHECK (linked_last4 IS NULL OR (length(linked_last4) = 4 AND linked_last4 GLOB '[0-9][0-9][0-9][0-9]'));
ALTER TABLE wa_listener_status ADD COLUMN linked_at INTEGER;
ALTER TABLE wa_listener_status ADD COLUMN linked_by TEXT;                 -- "POS · Name (owner)"; NULL when linked on the PC itself
ALTER TABLE wa_listener_status ADD COLUMN link_id TEXT;                   -- the request now open, if any
ALTER TABLE wa_listener_status ADD COLUMN link_action TEXT CHECK (link_action IS NULL OR link_action IN ('link', 'unlink'));
ALTER TABLE wa_listener_status ADD COLUMN link_at INTEGER;
ALTER TABLE wa_listener_status ADD COLUMN link_by TEXT;
ALTER TABLE wa_listener_status ADD COLUMN link_business_id TEXT;
ALTER TABLE wa_listener_status ADD COLUMN link_result TEXT;               -- how the last request ended: linked, unlinked, expired, cancelled
ALTER TABLE wa_listener_status ADD COLUMN qr_rows TEXT CHECK (qr_rows IS NULL OR json_valid(qr_rows));   -- the QR as rows of 0 and 1
ALTER TABLE wa_listener_status ADD COLUMN qr_at INTEGER;
