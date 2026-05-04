-- Run with: wrangler d1 execute ftc-stats --file=schema.sql

CREATE TABLE IF NOT EXISTS match_rows (
  match_id    TEXT PRIMARY KEY,
  season      INTEGER NOT NULL,
  event       TEXT    NOT NULL,
  match       TEXT    NOT NULL,
  rt          TEXT    NOT NULL,
  bt          TEXT    NOT NULL,
  rs          REAL    NOT NULL,
  bs          REAL    NOT NULL,
  ra          REAL    NOT NULL,
  ba          REAL    NOT NULL,
  rtot        INTEGER NOT NULL,
  btot        INTEGER NOT NULL,
  rf          INTEGER NOT NULL,
  bf          INTEGER NOT NULL,
  won         INTEGER NOT NULL,
  mt          TEXT    NOT NULL DEFAULT '',
  level       TEXT    NOT NULL DEFAULT 'qual',
  match_num   INTEGER,
  r_pat_pts   REAL    NOT NULL DEFAULT 0,
  b_pat_pts   REAL    NOT NULL DEFAULT 0,
  r_park_pts  REAL    NOT NULL DEFAULT 0,
  b_park_pts  REAL    NOT NULL DEFAULT 0,
  r_nav_pts   REAL    NOT NULL DEFAULT 0,
  b_nav_pts   REAL    NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_match_rows_event ON match_rows (event);
CREATE INDEX IF NOT EXISTS idx_match_rows_mt    ON match_rows (mt);

CREATE TABLE IF NOT EXISTS events (
  code        TEXT PRIMARY KEY,
  name        TEXT,
  type_name   TEXT,
  city        TEXT,
  stateprov   TEXT,
  country     TEXT,
  date_start  TEXT,
  date_end    TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);