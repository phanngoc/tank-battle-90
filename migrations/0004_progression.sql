-- Progression v2 (mode Chiến dịch): ví gold/💎, cấp 5 chỉ số, sổ cái, tiến độ màn, trần ngày/tuần, lượt chơi.
-- CHỈ THÊM BẢNG -> Worker cũ vẫn chạy (rollback an toàn). Mọi API sau cờ PROGRESSION_ON.
CREATE TABLE IF NOT EXISTS wallets (
  player_id TEXT PRIMARY KEY,
  gold INTEGER NOT NULL DEFAULT 0 CHECK (gold >= 0),     -- CHECK: trừ quá số dư -> lỗi -> cả batch rollback
  gems INTEGER NOT NULL DEFAULT 0 CHECK (gems >= 0),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tank_stats (
  player_id TEXT NOT NULL,
  stat TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (player_id, stat)
);
CREATE TABLE IF NOT EXISTS currency_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  currency TEXT NOT NULL,          -- 'gold' | 'gems'
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,            -- run | upgrade | convert | sandbox
  ref TEXT NOT NULL,               -- run: <runId>:<player>  upgrade: <player>:<stat>:<lv>
  created_at INTEGER NOT NULL,
  UNIQUE (reason, ref)
);
CREATE INDEX IF NOT EXISTS currency_ledger_player ON currency_ledger (player_id, created_at);
CREATE TABLE IF NOT EXISTS campaign_progress (
  player_id TEXT PRIMARY KEY,
  max_cleared INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_progress (
  player_id TEXT NOT NULL,
  day TEXT NOT NULL,               -- YYYY-MM-DD giờ VN
  match_gold INTEGER NOT NULL DEFAULT 0,
  first_win INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, day)
);
CREATE TABLE IF NOT EXISTS weekly_gem_convert (
  player_id TEXT NOT NULL,
  iso_week TEXT NOT NULL,          -- YYYY-Www (ISO, giờ VN)
  gold INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, iso_week)
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  room TEXT,
  mode TEXT NOT NULL,
  stage INTEGER,
  result TEXT NOT NULL,            -- win | loss
  players_json TEXT,
  created_at INTEGER NOT NULL
);
