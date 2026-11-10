-- Download progress of a Shelfmark job, reported by the courier.
ALTER TABLE items ADD COLUMN fetch_pct REAL;
ALTER TABLE items ADD COLUMN fetch_note TEXT;
