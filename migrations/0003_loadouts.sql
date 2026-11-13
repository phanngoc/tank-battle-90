-- Tủ đồ: món đang trang bị theo slot (tank|bullet|eagle|map). sku NULL = người chơi chọn mặc định.
-- Chỉ thêm bảng mới -> bản Worker cũ vẫn chạy được (rollback an toàn).
CREATE TABLE IF NOT EXISTS loadouts (
  player_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  sku TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player_id, slot)
);
