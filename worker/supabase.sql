-- MAS Weekly Plan Tracker — Supabase tables.
-- Optional: the Worker creates these by itself on its first request. Run this in Supabase → SQL Editor only if you want to create them by hand.

CREATE TABLE IF NOT EXISTS config (k text PRIMARY KEY, v text NOT NULL);
CREATE TABLE IF NOT EXISTS users (username text PRIMARY KEY, pass_hash text NOT NULL, salt text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','editor','viewer')), plant text, created_at text NOT NULL);
CREATE TABLE IF NOT EXISTS plan (id bigserial PRIMARY KEY, key text NOT NULL, so text NOT NULL, li text NOT NULL, item text NOT NULL,
  date text, qty double precision NOT NULL DEFAULT 0, plant text, remarks text, row_no integer NOT NULL DEFAULT 0, week text, src_user text, src_at text);
CREATE INDEX IF NOT EXISTS plan_week_key ON plan(week, key);
CREATE INDEX IF NOT EXISTS plan_key ON plan(key);
CREATE INDEX IF NOT EXISTS plan_item ON plan(item);
CREATE TABLE IF NOT EXISTS stock (id bigserial PRIMARY KEY, src text NOT NULL, key text NOT NULL, plant text, sloc text, so_plant text, so text, li text,
  material text, batch text, style text, ur double precision DEFAULT 0, qi double precision DEFAULT 0, block double precision DEFAULT 0,
  assigned double precision DEFAULT 0, total double precision DEFAULT 0);
CREATE INDEX IF NOT EXISTS stock_key ON stock(key);
CREATE INDEX IF NOT EXISTS stock_src ON stock(src);
CREATE TABLE IF NOT EXISTS trr (id bigserial PRIMARY KEY, key text NOT NULL, tn text, tn_date text, created_by text, so text, li text, material text,
  from_plant text, from_sloc text, to_plant text, to_sloc text, qty double precision DEFAULT 0, reason text);
CREATE INDEX IF NOT EXISTS trr_key ON trr(key);
CREATE TABLE IF NOT EXISTS line_status (key text PRIMARY KEY, status text, comment text, vehicle text, qi_note text, updated_by text, updated_at text);
CREATE TABLE IF NOT EXISTS uploads (id bigserial PRIMARY KEY, src text NOT NULL, file_name text, sheet_name text, row_count integer NOT NULL DEFAULT 0,
  uploaded_by text NOT NULL, uploaded_at text NOT NULL, mode text);
CREATE TABLE IF NOT EXISTS activity (id bigserial PRIMARY KEY, at text NOT NULL, username text NOT NULL, action text NOT NULL, detail text);
CREATE INDEX IF NOT EXISTS activity_action ON activity(action, id);
CREATE TABLE IF NOT EXISTS dispatch (ident text PRIMARY KEY, week text NOT NULL, item text NOT NULL, qty double precision NOT NULL, raw_qty double precision,
  factor double precision, pallet text, location text, lot text, order_no text, uom text, client_so text, file_name text, sheet_name text,
  uploaded_by text, uploaded_at text, first_at text);
CREATE INDEX IF NOT EXISTS dispatch_week_item ON dispatch(week, item);
CREATE TABLE IF NOT EXISTS plant_info (code text PRIMARY KEY, name text, responsible text, target text, sort integer DEFAULT 0);
CREATE TABLE IF NOT EXISTS stock_release (week text NOT NULL, key text NOT NULL, qi double precision DEFAULT 0, block double precision DEFAULT 0,
  by_user text, at text, PRIMARY KEY (week, key));
CREATE TABLE IF NOT EXISTS plant_received (week text NOT NULL, code text NOT NULL, received text, by_user text, at text, PRIMARY KEY (week, code));
CREATE TABLE IF NOT EXISTS dispatch_assign (id bigserial PRIMARY KEY, week text NOT NULL, item text NOT NULL, line text NOT NULL,
  qty double precision NOT NULL, by_user text, at text);
-- Only the Worker (database owner) reads and writes these tables. Row level security with no policies keeps
-- Supabase's public REST API (anon / authenticated keys) out of them.
ALTER TABLE config ENABLE ROW LEVEL SECURITY; ALTER TABLE users ENABLE ROW LEVEL SECURITY; ALTER TABLE plan ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock ENABLE ROW LEVEL SECURITY; ALTER TABLE trr ENABLE ROW LEVEL SECURITY; ALTER TABLE line_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploads ENABLE ROW LEVEL SECURITY; ALTER TABLE activity ENABLE ROW LEVEL SECURITY; ALTER TABLE dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE plant_info ENABLE ROW LEVEL SECURITY; ALTER TABLE stock_release ENABLE ROW LEVEL SECURITY; ALTER TABLE plant_received ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_assign ENABLE ROW LEVEL SECURITY;
INSERT INTO config (k, v) VALUES ('schema_version', '1') ON CONFLICT (k) DO UPDATE SET v = excluded.v;
