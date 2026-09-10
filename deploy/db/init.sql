-- ElasticVue Pro — shared state that must outlive one browser.
CREATE TABLE IF NOT EXISTS users (
  name        text PRIMARY KEY,
  role        text NOT NULL DEFAULT 'operator',   -- viewer | operator | admin (phase 2)
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Acknowledgements and notes, keyed by the alert's stable key (<cluster>:<kind>[:detail]).
CREATE TABLE IF NOT EXISTS acks (
  key         text PRIMARY KEY,
  acked       boolean NOT NULL DEFAULT false,
  acked_by    text,
  acked_at    timestamptz
);
CREATE TABLE IF NOT EXISTS notes (
  id          bigserial PRIMARY KEY,
  key         text NOT NULL REFERENCES acks(key) ON DELETE CASCADE,
  author      text NOT NULL,
  text        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_key ON notes(key);

-- Every write the core performed, by whom. Mirrors the core's audit log line.
CREATE TABLE IF NOT EXISTS audit (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  "user"      text NOT NULL,
  msg_type    text NOT NULL,
  cluster     text,
  method      text,
  path        text,
  ok          boolean,
  kind        text
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at DESC);
