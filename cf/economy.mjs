/* Kinh tế Tank Battle 90 trên CF Worker: guest token có chữ ký, cửa hàng, đơn hàng,
   webhook kiểu PayOS (HMAC-SHA256), entitlement trong D1 (binding DB).
   CHỈ mỹ phẩm — không có SKU nào đổi chỉ số xe (xem test/cosmetics.test.js).
   Hợp đồng: runs/ctx_201257eb…/CONTRACT.md §Tank. Mọi hàm nhận `env` (DB, biến). */

export const SKUS = {
  'tank.skin.jade':     { price: 19000, kind: 'cosmetic', label: 'Skin Ngọc Bích', limit: 'once' },
  'tank.skin.gold':     { price: 29000, kind: 'cosmetic', label: 'Skin Hoàng Kim', limit: 'once' },
  'tank.pass.coop':     { price: 39000, kind: 'cosmetic', label: 'Pass Co-op (28 ngày)', limit: 'extend', days: 28 },
  'tank.room.festival': { price: 29000, kind: 'cosmetic', label: 'Phòng Lễ Hội (1 phòng, cả 4 người)', limit: 'consumable' },
};
// skin hiển thị khi người chơi có nhiều thứ: thứ đắt/hiếm hơn thắng
const SKIN_RANK = ['tank.skin.gold', 'tank.pass.coop', 'tank.skin.jade'];
export const FESTIVAL_SKIN = 'tank.room.festival';
const ORDER_TTL_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const rnd = (n) => { const b = crypto.getRandomValues(new Uint8Array(n)); let s = ''; for (const x of b) s += CODE_ALPHABET[x % CODE_ALPHABET.length]; return s; };
const isLive = (env) => String(env.PAYMENTS_LIVE || '') === 'true';
const authSecret = (env) => env.AUTH_SECRET || (isLive(env) ? null : 'tank-dev-auth-secret');

/* ---------- guest token: "<a|r>.<playerId>.<sig>" — không cần bảng session ---------- */
export async function issueToken(env, playerId, typ) {
  const sec = authSecret(env); if (!sec) throw new Error('AUTH_SECRET missing');
  return `${typ}.${playerId}.${b64url(await hmac(sec, typ + '.' + playerId))}`;
}
export async function verifyToken(env, token, typ = 'a') {
  const m = /^([ar])\.(g[0-9a-f]{16})\.([A-Za-z0-9_-]+)$/.exec(String(token || ''));
  if (!m || m[1] !== typ) return null;
  const sec = authSecret(env); if (!sec) return null;
  return safeEqual(b64url(await hmac(sec, typ + '.' + m[2])), m[3]) ? m[2] : null;
}
export async function newGuest(env) {
  const playerId = 'g' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  if (env.DB) await env.DB.prepare('INSERT OR IGNORE INTO players (id, created_at) VALUES (?, ?)').bind(playerId, Date.now()).run();
  return { playerId, accessToken: await issueToken(env, playerId, 'a'), refreshToken: await issueToken(env, playerId, 'r'), isGuest: true };
}
export async function bearer(env, req) {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? verifyToken(env, h.slice(7), 'a') : null;
}

/* ---------- entitlements ---------- */
export async function entitlements(env, playerId, now = Date.now()) {
  if (!env.DB || !playerId) return [];
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT sku FROM entitlements WHERE player_id = ?
       AND (expires_at IS NULL OR expires_at > ?) AND (uses_left IS NULL OR uses_left > 0)`).bind(playerId, now).all();
  return (results || []).map((r) => r.sku);
}
export function pickSkin(owned, festivalRoom) {
  if (festivalRoom) return FESTIVAL_SKIN;
  for (const s of SKIN_RANK) if (owned.includes(s)) return s;
  return null;
}
/** Host tạo Phòng Lễ Hội: tiêu 1 lượt festival. true nếu còn lượt. */
export async function consumeFestival(env, playerId, now = Date.now()) {
  if (!env.DB || !playerId) return false;
  const row = await env.DB.prepare(
    `SELECT id FROM entitlements WHERE player_id = ? AND sku = ? AND uses_left > 0 ORDER BY id LIMIT 1`).bind(playerId, FESTIVAL_SKIN).first();
  if (!row) return false;
  const r = await env.DB.prepare('UPDATE entitlements SET uses_left = uses_left - 1, used_at = ? WHERE id = ? AND uses_left > 0').bind(now, row.id).run();
  return (r.meta && r.meta.changes) > 0;
}

async function limitLeft(env, playerId, sku, now) {
  const def = SKUS[sku];
  if (def.limit !== 'once') return null;               // null = không giới hạn
  return (await entitlements(env, playerId, now)).includes(sku) ? 0 : 1;
}
export async function shop(env, playerId, now = Date.now()) {
  const out = [];
  for (const [sku, d] of Object.entries(SKUS)) out.push({ sku, price: d.price, kind: d.kind, label: d.label, limitLeft: playerId ? await limitLeft(env, playerId, sku, now) : null });
  return out;
}

/* ---------- orders ---------- */
function qrFor(env, amount, code) {
  const bank = env.PAY_BANK || 'MB', account = env.PAY_ACCOUNT || '0000000000', name = env.PAY_ACCOUNT_NAME || 'ARCADE SANDBOX';
  const imageUrl = `https://img.vietqr.io/image/${encodeURIComponent(bank)}-${encodeURIComponent(account)}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(code)}&accountName=${encodeURIComponent(name)}`;
  return { bank, account, amount, content: code, imageUrl };
}
export async function createOrder(env, playerId, sku, now = Date.now()) {
  const def = SKUS[sku];
  if (!def) return { status: 400, body: { error: 'UNKNOWN_SKU' } };
  if ((await limitLeft(env, playerId, sku, now)) === 0) return { status: 409, body: { error: 'LIMIT_REACHED' } };
  const orderId = 'o' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const code = 'ARC' + rnd(8);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO players (id, created_at) VALUES (?, ?)').bind(playerId, now),
    env.DB.prepare('INSERT INTO orders (id, player_id, sku, amount, code, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(orderId, playerId, sku, def.price, code, 'pending', now),
  ]);
  return { status: 200, body: { orderId, amount: def.price, code, qr: qrFor(env, def.price, code), sandbox: !isLive(env) } };
}
export async function orderStatus(env, playerId, orderId, now = Date.now()) {
  const o = await env.DB.prepare('SELECT status, created_at FROM orders WHERE id = ? AND player_id = ?').bind(orderId, playerId).first();
  if (!o) return { status: 404, body: { error: 'NOT_FOUND' } };
  const status = o.status === 'pending' && now - o.created_at > ORDER_TTL_MS ? 'expired' : o.status;
  return { status: 200, body: { status } };
}

/* ---------- webhook (PayOS-style) ---------- */
export function signPayload(data) {
  return Object.keys(data).sort().map((k) => `${k}=${data[k] === null || data[k] === undefined ? '' : data[k]}`).join('&');
}
export async function signData(key, data) { return toHex(await hmac(key, signPayload(data))); }

async function grant(env, o, now) {
  const def = SKUS[o.sku];
  if (def.limit === 'extend') {
    const cur = await env.DB.prepare('SELECT MAX(expires_at) AS e FROM entitlements WHERE player_id = ? AND sku = ?').bind(o.player_id, o.sku).first();
    const from = Math.max(now, (cur && cur.e) || 0);
    return env.DB.prepare('INSERT INTO entitlements (player_id, sku, source, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .bind(o.player_id, o.sku, 'order:' + o.id, now, from + def.days * DAY_MS).run();
  }
  return env.DB.prepare('INSERT INTO entitlements (player_id, sku, source, created_at, uses_left) VALUES (?, ?, ?, ?, ?)')
    .bind(o.player_id, o.sku, 'order:' + o.id, now, def.limit === 'consumable' ? 1 : null).run();
}

/** body = {data:{orderCode, amount, description, reference?...}, signature}. Luôn trả 200 trừ chữ ký sai
    (provider retry khi non-2xx; lỗi nghiệp vụ như sai số tiền không nên bị retry vô hạn). */
export async function handleWebhook(env, body, now = Date.now()) {
  const key = env.PAYMENT_CHECKSUM_KEY || (isLive(env) ? null : 'tank-sandbox-checksum');
  if (!key) return { status: 500, body: { error: 'NO_CHECKSUM_KEY' } };
  const data = body && body.data, sig = body && body.signature;
  if (!data || typeof data !== 'object' || !safeEqual(await signData(key, data), String(sig || '').toLowerCase())) return { status: 401, body: { error: 'BAD_SIGNATURE' } };
  const m = /ARC[A-Z0-9]{8}/.exec(String(data.orderCode || '') + ' ' + String(data.description || ''));
  if (!m) return { status: 200, body: { ok: false, error: 'NO_ORDER_CODE' } };
  const o = await env.DB.prepare('SELECT * FROM orders WHERE code = ?').bind(m[0]).first();
  if (!o) return { status: 200, body: { ok: false, error: 'ORDER_NOT_FOUND' } };
  const txn = String(data.reference || data.paymentLinkId || ('code:' + m[0]));
  const ev = await env.DB.prepare('INSERT OR IGNORE INTO payment_events (provider_txn, order_id, amount, created_at, raw) VALUES (?, ?, ?, ?, ?)')
    .bind(txn, o.id, Number(data.amount) || 0, now, JSON.stringify(data).slice(0, 2000)).run();
  if (!(ev.meta && ev.meta.changes)) return { status: 200, body: { ok: true, duplicate: true } };
  if (Number(data.amount) !== o.amount) return { status: 200, body: { ok: false, error: 'AMOUNT_MISMATCH' } };
  const up = await env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ? AND status != 'paid'").bind(now, o.id).run();
  if (!(up.meta && up.meta.changes)) return { status: 200, body: { ok: true, duplicate: true } };
  await grant(env, o, now);
  return { status: 200, body: { ok: true, granted: o.sku } };
}

/** Chỉ khi PAYMENTS_LIVE != 'true': dựng webhook có chữ ký đúng rồi đi qua CÙNG handler. */
export async function sandboxConfirm(env, playerId, orderId, now = Date.now()) {
  if (isLive(env)) return { status: 404, body: { error: 'NOT_FOUND' } };
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id = ? AND player_id = ?').bind(orderId, playerId).first();
  if (!o) return { status: 404, body: { error: 'NOT_FOUND' } };
  const data = { orderCode: o.code, amount: o.amount, description: o.code, reference: 'sbx-' + o.id, code: '00', desc: 'success' };
  const key = env.PAYMENT_CHECKSUM_KEY || 'tank-sandbox-checksum';
  return handleWebhook(env, { data, signature: await signData(key, data) }, now);
}
