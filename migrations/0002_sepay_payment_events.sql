-- SePay: payment_events ghi MỌI giao dịch (kể cả không có mã / không khớp đơn) kèm outcome.
-- order_id thành nullable (NULL khi không tìm được đơn) -> phải dựng lại bảng (SQLite không ALTER được NOT NULL).
-- outcome: granted|already_paid|amount_mismatch|unknown_order|no_code|ignored_out|legacy (bản ghi PayOS cũ)
CREATE TABLE payment_events_v2 (
  provider_txn TEXT PRIMARY KEY,        -- 'sepay:<id>' — idempotency
  order_id TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  raw TEXT,
  outcome TEXT
);
INSERT INTO payment_events_v2 (provider_txn, order_id, amount, created_at, raw, outcome)
  SELECT provider_txn, order_id, amount, created_at, raw, 'legacy' FROM payment_events;
DROP TABLE payment_events;
ALTER TABLE payment_events_v2 RENAME TO payment_events;
CREATE INDEX IF NOT EXISTS payment_events_order ON payment_events(order_id);
