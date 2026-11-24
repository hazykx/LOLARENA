const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const file = config.dbFile || path.join(__dirname, '..', 'data', 'inhouse.db');
fs.mkdirSync(path.dirname(file), { recursive: true });

const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,            -- Discord ID
  username    TEXT NOT NULL,
  avatar      TEXT,
  elo         INTEGER NOT NULL DEFAULT ${config.elo.start},
  wins        INTEGER NOT NULL DEFAULT 0,
  losses      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS lol_accounts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_name   TEXT NOT NULL,
  tag_line    TEXT NOT NULL,
  region      TEXT NOT NULL,
  puuid       TEXT,
  is_main     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_lol_account ON lol_accounts(lower(game_name), lower(tag_line), region);

CREATE TABLE IF NOT EXISTS matches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  status         TEXT NOT NULL,             -- in_progress | awaiting_confirm | disputed | finished | cancelled
  lobby_name     TEXT,
  lobby_password TEXT,
  captain_role   TEXT,
  blue_captain   TEXT,
  red_captain    TEXT,
  winner         TEXT,                      -- BLUE | RED
  pending_json   TEXT,                      -- výsledek z ROFL čekající na potvrzení
  reported_by    TEXT,
  rofl_hash      TEXT,
  game_duration  INTEGER,
  voice_json     TEXT,
  draft_json     TEXT,
  created_at     INTEGER NOT NULL,
  finished_at    INTEGER
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id    INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  team        TEXT NOT NULL,                -- BLUE | RED
  role        TEXT NOT NULL,
  is_captain  INTEGER NOT NULL DEFAULT 0,
  pick_round  INTEGER,
  picked      INTEGER,                      -- 1 = vybraný kapitánem, 0 = "dostal" zbylého hráče
  champion    TEXT,
  kills       INTEGER, deaths INTEGER, assists INTEGER,
  cs          INTEGER, gold INTEGER, damage INTEGER, vision INTEGER,
  win         INTEGER,
  elo_before  INTEGER,
  elo_after   INTEGER,
  PRIMARY KEY (match_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_mp_user ON match_players(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid      TEXT PRIMARY KEY,
  sess     TEXT NOT NULL,
  expires  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_expires ON sessions(expires);
`);

db.getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
db.setSetting = (key, value) => db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
).run(key, String(value));
db.file = file;

module.exports = db;
