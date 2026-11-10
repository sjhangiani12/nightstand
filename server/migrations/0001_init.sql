CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'article',      -- article | book
  status TEXT NOT NULL DEFAULT 'queued',     -- queued | processing | ready | error
  source_url TEXT,
  title TEXT, author TEXT, site TEXT, excerpt TEXT,
  words INTEGER, minutes INTEGER, images INTEGER,
  epub_key TEXT, epub_bytes INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  ready_at INTEGER,
  delivered_at INTEGER,
  progress REAL DEFAULT 0,                    -- 0..1, from the Kindle
  location TEXT,
  progress_at INTEGER,
  archived INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS items_ready ON items(status, ready_at);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,                        -- info | warn | error
  msg TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_item ON logs(item_id, at);
