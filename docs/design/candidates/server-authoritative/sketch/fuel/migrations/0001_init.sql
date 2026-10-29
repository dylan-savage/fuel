-- Target schema for every phase in one file so the shape can be reviewed whole.
-- Implementation ships it as one migration per phase (0001 = P0/P1 tables, then 0002...),
-- applied in order by store.Store.open using PRAGMA user_version.
-- Opened with: PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000.
-- Dates are 'YYYY-MM-DD' local days. Instants are ISO 8601 UTC strings.
-- CHECK lists mirror the Literals in fuel/model.py; tests/test_schema.py fails when they drift.

-- Idempotency ledger. One row per command id, written in the same transaction as its effects.
CREATE TABLE command_log (
  id          TEXT PRIMARY KEY,                 -- client UUID
  kind        TEXT NOT NULL,
  at          TEXT NOT NULL,                    -- when Dylan tapped (client clock)
  received_at TEXT NOT NULL,
  outcome     TEXT NOT NULL,                    -- JSON commands.Outcome, returned verbatim on replay
  body        TEXT NOT NULL                     -- JSON of the parsed command, for audit
);

-- Catalog -------------------------------------------------------------------------------------

CREATE TABLE food (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  brand       TEXT,
  basis       TEXT NOT NULL CHECK (basis IN ('g','ml','portion')),
  kcal        REAL NOT NULL CHECK (kcal >= 0),  -- per 100 g, per 100 ml, or per 1 portion
  protein_g   REAL NOT NULL CHECK (protein_g >= 0),
  carbs_g     REAL NOT NULL CHECK (carbs_g >= 0),
  fat_g       REAL NOT NULL CHECK (fat_g >= 0),
  fiber_g     REAL,                             -- NULL = not reported, not zero
  sugar_g     REAL,
  sodium_mg   REAL,
  origin      TEXT NOT NULL CHECK (origin IN ('manual','off','usda','ai_label','recipe')),
  external_id TEXT,                             -- OFF code or USDA fdcId
  default_serving_id INTEGER,                   -- FK added logically; set after servings insert
  archived_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (origin, external_id)                  -- makes external import idempotent
);

CREATE TABLE serving (
  id       INTEGER PRIMARY KEY,
  food_id  INTEGER NOT NULL REFERENCES food(id),
  label    TEXT NOT NULL,                       -- '1 slice', '1 can (330 ml)', '100 g'
  amount   REAL NOT NULL CHECK (amount > 0),    -- in food.basis units
  UNIQUE (food_id, label)
);

CREATE TABLE food_barcode (
  gtin     TEXT PRIMARY KEY,                    -- normalized: UPC-A padded to 13 digits
  food_id  INTEGER NOT NULL REFERENCES food(id)
);

CREATE VIRTUAL TABLE food_fts USING fts5(name, brand, content='food', content_rowid='id');
-- Kept current by triggers on food (insert/update/delete), so no code path can forget it.

CREATE TABLE recipe (                           -- P2
  id              INTEGER PRIMARY KEY,
  food_id         INTEGER NOT NULL UNIQUE REFERENCES food(id),   -- the food it owns
  portions        REAL NOT NULL CHECK (portions > 0),
  cooked_weight_g REAL CHECK (cooked_weight_g > 0)
);

CREATE TABLE recipe_item (                      -- P2
  recipe_id   INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  food_id     INTEGER NOT NULL REFERENCES food(id),
  serving_id  INTEGER REFERENCES serving(id),
  count       REAL NOT NULL CHECK (count > 0),
  PRIMARY KEY (recipe_id, position)
);
CREATE INDEX recipe_item_food ON recipe_item(food_id);   -- "which recipes use this food" on EditFood

CREATE TABLE saved_meal (                       -- P2
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  archived_at TEXT
);

CREATE TABLE saved_meal_item (                  -- P2
  saved_meal_id INTEGER NOT NULL REFERENCES saved_meal(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  food_id       INTEGER NOT NULL REFERENCES food(id),
  serving_id    INTEGER REFERENCES serving(id),
  count         REAL NOT NULL CHECK (count > 0),
  PRIMARY KEY (saved_meal_id, position)
);

-- Diary ---------------------------------------------------------------------------------------

CREATE TABLE entry (
  id          INTEGER PRIMARY KEY,
  day         TEXT NOT NULL,
  meal        TEXT NOT NULL CHECK (meal IN ('breakfast','lunch','dinner','snacks')),
  position    REAL NOT NULL,                    -- order within the meal
  label       TEXT NOT NULL,                    -- snapshot of the food name
  food_id     INTEGER REFERENCES food(id),      -- provenance; NULL for quick add / unmatched AI
  origin      TEXT NOT NULL CHECK (origin IN ('food','quick','ai')),
  basis       TEXT NOT NULL CHECK (basis IN ('g','ml','portion')),
  kcal        REAL NOT NULL,                    -- snapshot of per-basis nutrients at log time
  protein_g   REAL NOT NULL,
  carbs_g     REAL NOT NULL,
  fat_g       REAL NOT NULL,
  fiber_g     REAL,
  sugar_g     REAL,
  sodium_mg   REAL,
  amount      REAL NOT NULL CHECK (amount > 0), -- in basis units; nutrients = snapshot * amount / basis
  serving_label TEXT,
  serving_each  REAL,
  serving_count REAL,
  command_id  TEXT NOT NULL REFERENCES command_log(id),
  logged_at   TEXT NOT NULL,
  CHECK ((serving_label IS NULL) = (serving_each IS NULL) AND (serving_each IS NULL) = (serving_count IS NULL))
);
CREATE INDEX entry_day  ON entry(day, meal, position);
CREATE INDEX entry_food ON entry(food_id, day);        -- recents and frequents

CREATE TABLE draft (                            -- P4
  id          INTEGER PRIMARY KEY,
  text        TEXT,
  day         TEXT NOT NULL,
  meal        TEXT CHECK (meal IN ('breakfast','lunch','dinner','snacks')),
  status      TEXT NOT NULL CHECK (status IN ('unparsed','ready','failed','confirmed','discarded')),
  body        TEXT,                             -- JSON model.DraftBody when ready
  reason      TEXT,                             -- when failed
  created_at  TEXT NOT NULL,
  CHECK ((status = 'ready') = (body IS NOT NULL) OR status IN ('confirmed','discarded'))
);

-- Goals and body ------------------------------------------------------------------------------

CREATE TABLE profile (                          -- singleton
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  sex         TEXT NOT NULL CHECK (sex IN ('male','female')),
  birth_date  TEXT NOT NULL,
  height_cm   REAL NOT NULL,
  display_units TEXT NOT NULL CHECK (display_units IN ('imperial','metric')),
  tz          TEXT NOT NULL,
  water_goal_ml REAL NOT NULL,
  health_tracks_workouts INTEGER NOT NULL
);

CREATE TABLE goal (                             -- effective-dated; goal for D = max(effective_from <= D)
  effective_from      TEXT PRIMARY KEY,
  activity_multiplier REAL NOT NULL CHECK (activity_multiplier BETWEEN 1.2 AND 1.9),
  rate_kg_per_week    REAL NOT NULL CHECK (rate_kg_per_week BETWEEN -1.0 AND 0.5),
  kcal_override       REAL CHECK (kcal_override > 0),
  macro_kind          TEXT NOT NULL CHECK (macro_kind IN ('percent','grams')),
  macro_protein       REAL NOT NULL,
  macro_carbs         REAL NOT NULL,
  macro_fat           REAL NOT NULL,
  burn_credit         REAL NOT NULL CHECK (burn_credit BETWEEN 0 AND 1),
  goal_weight_kg      REAL,
  CHECK (macro_kind = 'grams' OR macro_protein + macro_carbs + macro_fat = 100)
);

CREATE TABLE weigh_in (                         -- P3; two writers, disjoint rows, merged on read
  day         TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('manual','health')),
  kg          REAL NOT NULL CHECK (kg > 0),
  measured_at TEXT NOT NULL,
  PRIMARY KEY (day, source)
);

CREATE TABLE health_day (                       -- P5; written only by /ingest/health
  day         TEXT NOT NULL,
  metric      TEXT NOT NULL CHECK (metric IN ('active_kcal','steps')),
  value       REAL NOT NULL,
  observed_at TEXT NOT NULL,                    -- latest observation wins
  received_at TEXT NOT NULL,
  PRIMARY KEY (day, metric)
);
-- Upsert: INSERT ... ON CONFLICT(day, metric) DO UPDATE SET value=excluded.value,
--   observed_at=excluded.observed_at, received_at=excluded.received_at
--   WHERE excluded.observed_at > health_day.observed_at;

CREATE TABLE activity (                         -- P5; seeded subset of the Compendium of Physical Activities
  key   TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  met   REAL NOT NULL CHECK (met > 0)
);

CREATE TABLE exercise (                         -- P5
  id          INTEGER PRIMARY KEY,
  day         TEXT NOT NULL,
  label       TEXT NOT NULL,
  minutes     REAL,
  kcal        REAL NOT NULL CHECK (kcal >= 0),  -- snapshot of MET x kg x h, or typed
  tracked_by_health INTEGER NOT NULL,
  command_id  TEXT NOT NULL REFERENCES command_log(id),
  logged_at   TEXT NOT NULL
);
CREATE INDEX exercise_day ON exercise(day);

-- Habits --------------------------------------------------------------------------------------

CREATE TABLE water (                            -- P6
  id          INTEGER PRIMARY KEY,
  day         TEXT NOT NULL,
  ml          REAL NOT NULL,
  command_id  TEXT NOT NULL REFERENCES command_log(id),
  logged_at   TEXT NOT NULL
);
CREATE INDEX water_day ON water(day);

CREATE TABLE fast (                             -- P6
  id           INTEGER PRIMARY KEY,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  target_hours REAL NOT NULL CHECK (target_hours > 0),
  CHECK (ended_at IS NULL OR ended_at > started_at)
);
CREATE UNIQUE INDEX one_open_fast ON fast((ended_at IS NULL)) WHERE ended_at IS NULL;
