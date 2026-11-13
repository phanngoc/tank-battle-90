/* Kinh tế Tank Battle 90 trên CF Worker: guest token có chữ ký, cửa hàng, đơn hàng,
   webhook SePay (header Authorization: Apikey), entitlement trong D1 (binding DB).
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
// SePay QR (hợp đồng SEPAY_CONTRACT.md). PAY_* là tên cũ, vẫn đọc làm fallback.
function qrFor(env, amount, code) {
  const bank = env.PAYMENT_BANK || env.PAY_BANK || 'MBBank';
  const account = env.PAYMENT_ACCOUNT || env.PAY_ACCOUNT || 'SANDBOX';
  const accountName = env.PAYMENT_ACCOUNT_NAME || env.PAY_ACCOUNT_NAME || 'ARCADE';
  const q = (v) => encodeURIComponent(String(v));
  const imageUrl = `https://qr.sepay.vn/img?acc=${q(account)}&bank=${q(bank)}&amount=${q(amount)}&des=${q(code)}`;
  return { bank, account, accountName, amount, content: code, imageUrl, provider: 'sepay' };
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

/* ---------- webhook (SePay) ---------- */
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

const SANDBOX_SEPAY_KEY = 'tank-sandbox-sepay';
const sepayKey = (env) => env.SEPAY_API_KEY || (isLive(env) ? null : SANDBOX_SEPAY_KEY);
const CODE_EXACT = /^ARC[A-Z0-9]{8}$/i, CODE_IN = /ARC[A-Z0-9]{8}/i;
export function orderCodeOf(body) {
  if (typeof body.code === 'string' && CODE_EXACT.test(body.code.trim())) return body.code.trim().toUpperCase();
  const m = CODE_IN.exec(String(body.content || '') + ' ' + String(body.description || ''));
  return m ? m[0].toUpperCase() : null;
}

/** SePay webhook. auth = giá trị header Authorization ("Apikey <key>").
    Sai key -> 401 (không ghi gì). Lỗi nghiệp vụ -> 200 {success:true, outcome} để SePay không retry;
    mọi giao dịch đều ghi payment_events (provider_txn = 'sepay:'+id, idempotent). */
export async function handleWebhook(env, body, auth, now = Date.now()) {
  const key = sepayKey(env);
  if (!key) return { status: 503, body: { success: false, error: 'PAYMENTS_MISCONFIGURED' } };
  const m = /^Apikey\s+(.+)$/i.exec(String(auth || '').trim());
  if (!m || !safeEqual(m[1].trim(), key)) return { status: 401, body: { success: false, error: 'BAD_API_KEY' } };
  if (!body || typeof body !== 'object') return { status: 400, body: { success: false, error: 'ID_REQUIRED' } };
  const id = body.id;
  if (id === undefined || id === null || !/^\d+$/.test(String(id).trim())) return { status: 400, body: { success: false, error: 'ID_REQUIRED' } };
  const txn = 'sepay:' + String(id).trim();
  const amount = Number(body.transferAmount);
  const code = orderCodeOf(body);
  let outcome, o = null;
  if (body.transferType !== 'in') outcome = 'ignored_out';
  else if (!code) outcome = 'no_code';
  else {
    o = await env.DB.prepare('SELECT * FROM orders WHERE code = ?').bind(code).first();
    if (!o) outcome = 'unknown_order';
    else if (!Number.isFinite(amount) || amount !== o.amount) outcome = 'amount_mismatch';
    else if (o.status === 'paid') outcome = 'already_paid';
    else outcome = 'granted';
  }
  const ev = await env.DB.prepare('INSERT OR IGNORE INTO payment_events (provider_txn, order_id, amount, created_at, raw, outcome) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(txn, o ? o.id : null, Number.isFinite(amount) ? Math.round(amount) : 0, now, JSON.stringify(body).slice(0, 4000), outcome).run();
  if (!(ev.meta && ev.meta.changes)) return { status: 200, body: { success: true, duplicate: true } };
  if (outcome !== 'granted') return { status: 200, body: { success: true, outcome, code } };
  const up = await env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ? AND status != 'paid'").bind(now, o.id).run();
  if (!(up.meta && up.meta.changes)) {
    await env.DB.prepare("UPDATE payment_events SET outcome = 'already_paid' WHERE provider_txn = ?").bind(txn).run();
    return { status: 200, body: { success: true, outcome: 'already_paid', code } };
  }
  await grant(env, o, now);
  return { status: 200, body: { success: true, outcome, code, granted: o.sku } };
}

// id sandbox xác định theo orderId (FNV-1a 32-bit) -> confirm lần hai là duplicate
const sandboxId = (orderId) => { let h = 0x811c9dc5; for (const ch of String(orderId)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return 900000000000 + h; };

/** Chỉ khi PAYMENTS_LIVE != 'true': dựng payload kiểu SePay rồi đi qua CÙNG handler. */
export async function sandboxConfirm(env, playerId, orderId, now = Date.now()) {
  if (isLive(env)) return { status: 404, body: { error: 'NOT_FOUND' } };
  const o = await env.DB.prepare('SELECT * FROM orders WHERE id = ? AND player_id = ?').bind(orderId, playerId).first();
  if (!o) return { status: 404, body: { error: 'NOT_FOUND' } };
  const body = { id: sandboxId(o.id), gateway: 'SANDBOX', transactionDate: new Date(now).toISOString().replace('T', ' ').slice(0, 19),
    accountNumber: env.PAYMENT_ACCOUNT || env.PAY_ACCOUNT || 'SANDBOX', subAccount: null, code: o.code, content: o.code + ' sandbox',
    transferType: 'in', description: o.code + ' sandbox', transferAmount: o.amount, accumulated: 0, referenceCode: 'SBX-' + o.id };
  return handleWebhook(env, body, 'Apikey ' + sepayKey(env), now);
}
