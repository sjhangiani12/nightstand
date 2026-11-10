-- Books: where a book came from, and what was asked for.
ALTER TABLE items ADD COLUMN source TEXT;      -- standardebooks | gutenberg | shelfmark | url
ALTER TABLE items ADD COLUMN source_ref TEXT;  -- slug, Gutenberg id, or the Shelfmark query
ALTER TABLE items ADD COLUMN want_title TEXT;  -- what the user asked for (the check compares the file to it)
ALTER TABLE items ADD COLUMN want_author TEXT;
ALTER TABLE items ADD COLUMN isbn TEXT;
ALTER TABLE items ADD COLUMN year INTEGER;
-- Small key/value store (courier heartbeat).
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT, at INTEGER);
