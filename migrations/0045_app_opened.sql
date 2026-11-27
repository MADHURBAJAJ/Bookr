-- Opened from the home-screen app (approved 28 Nov 2026): when a person first and last used Bookr from its icon
-- (installed), not a browser tab. The app says so on each request; the Owner sees it on Schools and cashiers.
ALTER TABLE users ADD COLUMN app_first_at INTEGER;
ALTER TABLE users ADD COLUMN app_last_at INTEGER;
