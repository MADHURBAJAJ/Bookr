-- Offline mode (approved 27 Nov 2026): the counter PC keeps taking orders, printing KOTs and bills, and taking payments
-- when the internet is off, and sends them up when it is back.
-- offline_letter: the counter device's own letter (A, B, ...), given the first time it gets ready for offline. Bills and
-- receipts it makes offline carry it (C261126A001, RCPT/26-27/A001), so their numbers never clash with the server's.
ALTER TABLE devices ADD COLUMN offline_letter TEXT;
CREATE UNIQUE INDEX devices_offline_letter_key ON devices (business_id, offline_letter) WHERE offline_letter IS NOT NULL;
-- What was made offline, and on which device: the bill or receipt kept its offline number; the KOT its printed label (A2).
ALTER TABLE bills ADD COLUMN offline_device TEXT;
ALTER TABLE settlements ADD COLUMN offline_device TEXT;
ALTER TABLE kots ADD COLUMN offline_label TEXT;
-- Each step sent up from a device, saved in the same batch as what it wrote, so a step sent twice is saved once.
-- local_id / server_id: an order made offline has the device's own id until the server gives it one.
CREATE TABLE offline_steps (
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  step_id     TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  local_id    TEXT,
  server_id   TEXT,
  offline_at  INTEGER NOT NULL,
  staff_id    TEXT,
  done_at     INTEGER NOT NULL,
  -- Something for the manager to check, e.g. a bill whose total here is not the one on its paper.
  problem     TEXT,
  PRIMARY KEY (business_id, step_id)
);
CREATE INDEX offline_steps_local_idx ON offline_steps (business_id, local_id) WHERE local_id IS NOT NULL;
