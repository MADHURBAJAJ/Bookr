-- A booking's rooms or beds not given in the POS because guests share (26 Nov 2026): counted so the "beds missing" flag clears.
ALTER TABLE stays ADD COLUMN sharing_beds INTEGER NOT NULL DEFAULT 0 CHECK (sharing_beds >= 0);
