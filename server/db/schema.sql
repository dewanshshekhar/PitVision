-- PitVision telemetry store.
--
-- Timestamps are epoch milliseconds (INTEGER) throughout; SQLite has no date
-- type and a mix of formats in one database is a bug generator. Booleans are
-- 0/1 INTEGER for the same reason.

CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  ended_at          INTEGER,
  last_seen_at      INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active', 'ended', 'abandoned')),
  end_reason        TEXT,

  source_kind       TEXT NOT NULL,
  source_label      TEXT,
  source_signature  TEXT,

  driver            TEXT,
  car_number        TEXT,
  team              TEXT,
  car               TEXT,
  circuit           TEXT,
  session_name      TEXT,
  baseline_lap_s    REAL,

  client_id         TEXT,
  user_agent        TEXT,
  app_version       TEXT,
  notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status  ON sessions (status, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions (created_at DESC);

-- One row per committed reading. The client downsamples before posting: the
-- engine produces up to 25 readings a second and storing every one of them
-- buys nothing a 1 Hz series does not already say about the weather.
CREATE TABLE IF NOT EXISTS readings (
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  t              INTEGER NOT NULL,
  wetness        REAL NOT NULL,
  wetness_raw    REAL NOT NULL,
  line           REAL NOT NULL,
  edge           REAL NOT NULL,
  divergence     REAL NOT NULL,
  condition      TEXT NOT NULL,
  trend          REAL NOT NULL,
  sig_glare      REAL, sig_texture  REAL, sig_darkness REAL, sig_specular REAL,
  nrm_glare      REAL, nrm_texture  REAL, nrm_darkness REAL, nrm_specular REAL,
  analysis_ms    REAL,
  latency_ms     REAL,
  PRIMARY KEY (session_id, t)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_readings_time ON readings (session_id, t DESC);

-- Pit-wall pings and server-raised notices, in one feed so the session replay
-- is a single ordered stream rather than two that have to be interleaved.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  t           INTEGER NOT NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('client', 'monitor')),
  kind        TEXT NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('info', 'warn', 'critical')),
  title       TEXT NOT NULL,
  detail      TEXT,
  payload     TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id, t DESC);

-- Every AI verification attempt, including the failures. The failures are the
-- point: an agreement rate computed only over the calls that succeeded is a
-- survivorship-biased number.
CREATE TABLE IF NOT EXISTS verifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  t             INTEGER NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok', 'refused', 'error', 'timeout')),
  cv_condition  TEXT,
  cv_wetness    REAL,
  cv_line       REAL,
  cv_edge       REAL,
  cv_trend      REAL,
  ai_condition  TEXT,
  confidence    REAL,
  reasoning     TEXT,
  agreement     TEXT CHECK (agreement IN ('match', 'adjacent', 'conflict', 'unknown')),
  model         TEXT,
  latency_ms    REAL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  image_bytes   INTEGER,
  attempts      INTEGER,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_verif_session ON verifications (session_id, t DESC);

-- Pre-race check outcomes and the calibration they produced. Kept because a
-- disputed reading is almost always a disputed calibration, and the anchors
-- are the only way to re-derive what the index meant at the time.
CREATE TABLE IF NOT EXISTS calibrations (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  t                    INTEGER NOT NULL,
  ok                   INTEGER NOT NULL,
  verdict              TEXT,
  anchoring            TEXT,
  divergence_reliable  INTEGER,
  source_signature     TEXT,
  checks               TEXT,
  report               TEXT,
  anchors              TEXT
);

CREATE INDEX IF NOT EXISTS idx_calib_session ON calibrations (session_id, t DESC);

-- Monitor findings with a lifecycle. An incident is open until the condition
-- that raised it clears, so "is anything wrong right now" is one query rather
-- than a scan back through an alert log guessing which warnings still stand.
CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('warn', 'critical')),
  opened_at   INTEGER NOT NULL,
  closed_at   INTEGER,
  summary     TEXT NOT NULL,
  detail      TEXT,
  payload     TEXT
);

CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents (session_id, kind, closed_at);
