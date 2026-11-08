-- Card reports can also come from a Google Drive folder (approved 8 Nov 2026): a script in the Owner's Gmail saves the
-- card company's .xlsx there, and Bookr reads new files when the bank is synced. Each file read is kept as an
-- inbound_mails row (message_id 'drive:<file id>'), so a file is read once.
ALTER TABLE businesses ADD COLUMN card_drive_folder TEXT;
