-- Shade Pull Plan Tracker — Cloudflare D1 schema
-- Run once:  npx wrangler d1 execute shade-tracker --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  username    TEXT PRIMARY KEY,
  pass_hash   TEXT NOT NULL,
  salt        TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
  created_at  TEXT NOT NULL
);

-- Pull plan lines (SO / LI / Item Code / Date / QTY / Plant)
CREATE TABLE IF NOT EXISTS plan (
  key      TEXT NOT NULL,
  so       TEXT NOT NULL,
  li       TEXT NOT NULL,
  item     TEXT NOT NULL,
  date     TEXT,
  qty      REAL NOT NULL DEFAULT 0,
  plant    TEXT,
  remarks  TEXT,
  row_no   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_key ON plan(key);

-- Stock lines from ZMMBE, ZMMBE KFC, ZMMBE PFC and PLANT report (src tells which)
CREATE TABLE IF NOT EXISTS stock (
  src       TEXT NOT NULL CHECK (src IN ('zmmbe','kfc','pfc','plant')),
  key       TEXT NOT NULL,
  plant     TEXT,
  sloc      TEXT,
  so_plant  TEXT,
  so        TEXT,
  li        TEXT,
  material  TEXT,
  batch     TEXT,
  style     TEXT,
  ur        REAL DEFAULT 0,
  qi        REAL DEFAULT 0,
  block     REAL DEFAULT 0,
  assigned  REAL DEFAULT 0,
  total     REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS stock_src_key ON stock(src, key);
CREATE INDEX IF NOT EXISTS stock_key ON stock(key);

-- TRR (transfer notes)
CREATE TABLE IF NOT EXISTS trr (
  key       TEXT NOT NULL,
  tn        TEXT,
  tn_date   TEXT,
  created_by TEXT,
  so        TEXT,
  li        TEXT,
  material  TEXT,
  from_plant TEXT,
  from_sloc  TEXT,
  to_plant   TEXT,
  to_sloc    TEXT,
  qty       REAL DEFAULT 0,
  reason    TEXT
);
CREATE INDEX IF NOT EXISTS trr_key ON trr(key);

-- Edits made on the dashboard. Keyed by SO|LI|Item, so they survive a new plan upload.
CREATE TABLE IF NOT EXISTS line_status (
  key         TEXT PRIMARY KEY,
  status      TEXT,
  comment     TEXT,
  vehicle     TEXT,
  qi_note     TEXT,
  updated_by  TEXT,
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS uploads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  src         TEXT NOT NULL,
  file_name   TEXT,
  sheet_name  TEXT,
  row_count   INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  username TEXT NOT NULL,
  action   TEXT NOT NULL,
  detail   TEXT
);
