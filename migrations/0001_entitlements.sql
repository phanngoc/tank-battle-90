-- D1 `tank-entitlements` (binding DB). Áp dụng: npx wrangler@4 d1 migrations apply tank-entitlements [--local|--remote]
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL REFERENCES players(id),
  sku TEXT NOT NULL,
  amount INTEGER NOT NULL,
  code TEXT NOT NULL UNIQUE,            -- 'ARC'+8, nằm trong nội dung chuyển khoản
  status TEXT NOT NULL DEFAULT 'pending', -- pending|paid (expired tính khi đọc)
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS orders_player ON orders(player_id);
CREATE TABLE IF NOT EXISTS payment_events (
  provider_txn TEXT PRIMARY KEY,        -- idempotency: một giao dịch provider chỉ xử lý một lần
  order_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  raw TEXT
);
CREATE TABLE IF NOT EXISTS entitlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  source TEXT NOT NULL,                 -- 'order:<id>'
  created_at INTEGER NOT NULL,
  expires_at INTEGER,                   -- pass co-op
  uses_left INTEGER,                    -- phòng lễ hội (consumable)
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS entitlements_player ON entitlements(player_id, sku);
