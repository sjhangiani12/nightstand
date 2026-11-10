-- Live Shelfmark searches: the server writes one, the courier answers it.
CREATE TABLE IF NOT EXISTS book_searches (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | claimed | done | error
  results TEXT,                             -- JSON {book, releases:[...]}
  error TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS book_searches_status ON book_searches(status, created_at);
-- The exact Shelfmark release picked for a book job (JSON), so the courier downloads that one.
ALTER TABLE items ADD COLUMN release TEXT;
