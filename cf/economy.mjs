/* Kinh tế Tank Battle 90 trên CF Worker: guest token có chữ ký, cửa hàng, đơn hàng,
   webhook SePay (header Authorization: Apikey), entitlement trong D1 (binding DB).
   CHỈ mỹ phẩm — không có SKU nào đổi chỉ số xe (xem test/cosmetics.test.js).
   Hợp đồng: runs/ctx_201257eb…/CONTRACT.md §Tank. Mọi hàm nhận `env` (DB, biến). */

// Danh mục (docs/tank-cosmetics-shop.md, owner chốt 13/11/2026). slot: tank|bullet|eagle|map (null = không trang bị được).
// rarity: common 9k · rare 19k · epic 29k · legendary 39-49k. season: [tháng-ngày bắt đầu, kết thúc] giờ VN.
const C = (slot, price, rarity, label, desc, extra) => Object.assign({ price, kind: 'cosmetic', slot, rarity, label, desc, limit: 'once' }, extra);
export const SKUS = {
  'tank.skin.camo':     C('tank', 19000, 'rare', 'Rằn Ri Rừng', 'Thân xanh rêu, vằn nâu–đen, nòng đen'),
  'tank.skin.desert':   C('tank', 19000, 'rare', 'Bão Cát', 'Be cát, sọc chéo nâu nhạt, xích màu đất'),
  'tank.skin.jade':     C('tank', 19000, 'rare', 'Ngọc Bích', 'Xanh ngọc, chấm sáng trên thân'),
  'tank.skin.carbon':   C('tank', 29000, 'epic', 'Carbon Đêm', 'Đen than vân chéo, viền đỏ, đèn trước nhấp nháy'),
  'tank.skin.gold':     C('tank', 29000, 'epic', 'Hoàng Kim', 'Vàng ánh kim, tia lấp lánh chạy dọc thân'),
  'tank.skin.neon':     C('tank', 39000, 'legendary', 'Cyber Neon', 'Thân tối, viền neon cyan/hồng phát sáng nhịp'),
  'tank.skin.dragon':   C('tank', 49000, 'legendary', 'Rồng Lửa', 'Đỏ thẫm vảy rồng, khói than bay sau xích'),
  'tank.bullet.laser':    C('bullet', 9000, 'common', 'Tia Laser', 'Lõi cyan, vệt đuôi mờ dần'),
  'tank.bullet.plasma':   C('bullet', 19000, 'rare', 'Plasma', 'Cầu tím phát sáng, nổ vòng tím khi trúng'),
  'tank.bullet.fire':     C('bullet', 19000, 'rare', 'Hoả Tiễn', 'Lõi cam, đuôi lửa, tàn lửa khi trúng'),
  'tank.bullet.firework': C('bullet', 29000, 'epic', 'Pháo Hoa', 'Trúng là nổ bông pháo hoa nhiều màu'),
  'tank.bullet.meteor':   C('bullet', 29000, 'epic', 'Sao Băng', 'Đuôi sao dài trắng–xanh'),
  'tank.bullet.dragon':   C('bullet', 39000, 'legendary', 'Hơi Thở Rồng', 'Cầu lửa đỏ–vàng, đuôi khói'),
  'tank.eagle.golden':  C('eagle', 19000, 'rare', 'Đại Bàng Vàng', 'Lông vàng viền nâu, lấp lánh'),
  'tank.eagle.ice':     C('eagle', 19000, 'rare', 'Đại Bàng Băng', 'Trắng–xanh băng, tinh thể quanh chân'),
  'tank.eagle.lac':     C('eagle', 29000, 'epic', 'Chim Lạc', 'Hoạ tiết trống đồng Đông Sơn, màu đồng xanh'),
  'tank.eagle.phoenix': C('eagle', 39000, 'legendary', 'Phượng Hoàng Lửa', 'Cánh lửa vỗ, tàn lửa bay lên'),
  'tank.map.jungle':  C('map', 19000, 'rare', 'Rừng Nhiệt Đới', 'Nền đất xanh thẫm, gạch đá rêu, nước xanh lục'),
  'tank.map.desert':  C('map', 19000, 'rare', 'Sa Mạc', 'Nền cát, gạch sa thạch, thép gỉ'),
  'tank.map.snow':    C('map', 19000, 'rare', 'Bão Tuyết', 'Nền tuyết, gạch băng, tuyết rơi nhẹ'),
  'tank.map.neon':    C('map', 29000, 'epic', 'Đêm Neon', 'Nền lưới tối, gạch viền hồng, thép viền cyan'),
  'tank.map.tet':     C('map', 29000, 'epic', 'Tết Việt', 'Nền đỏ thẫm, thép vàng đồng, cây là cành mai', { season: ['01-01', '02-28'] }),
  'tank.pass.coop':     { price: 39000, kind: 'cosmetic', slot: 'tank', rarity: 'pass', label: 'Pass Co-op (28 ngày)', desc: 'Skin Tím Đồng Đội trong 28 ngày', limit: 'extend', days: 28 },
  'tank.room.festival': { price: 29000, kind: 'cosmetic', slot: null, rarity: 'room', label: 'Phòng Lễ Hội (1 phòng, cả 4 người)', desc: 'Tạo 1 phòng: cả 4 xe đổi màu cầu vồng', limit: 'consumable' },
  // combo: giá = 70% tổng giá lẻ của món CHƯA có (làm tròn nghìn); fixedPrice = giá cố định
  'tank.bundle.rookie': { kind: 'bundle', rarity: 'bundle', label: 'Tân Binh', desc: 'Rằn Ri Rừng + Tia Laser — 1 lần/tài khoản', limit: 'once', fixedPrice: 15000, items: ['tank.skin.camo', 'tank.bullet.laser'] },
  'tank.bundle.dragon': { kind: 'bundle', rarity: 'bundle', label: 'Bộ Rồng Lửa', desc: 'Xe Rồng Lửa + đạn Hơi Thở Rồng + Phượng Hoàng Lửa', limit: 'once', items: ['tank.skin.dragon', 'tank.bullet.dragon', 'tank.eagle.phoenix'] },
  'tank.bundle.neon':   { kind: 'bundle', rarity: 'bundle', label: 'Bộ Cyber Neon', desc: 'Xe Cyber Neon + đạn Plasma + map Đêm Neon', limit: 'once', items: ['tank.skin.neon', 'tank.bullet.plasma', 'tank.map.neon'] },
  'tank.bundle.tet':    { kind: 'bundle', rarity: 'bundle', label: 'Bộ Tết', desc: 'Xe Hoàng Kim + đạn Pháo Hoa + Chim Lạc + map Tết Việt', limit: 'once', season: ['01-01', '02-28'], items: ['tank.skin.gold', 'tank.bullet.firework', 'tank.eagle.lac', 'tank.map.tet'] },
};
export const SLOTS = ['tank', 'bullet', 'eagle', 'map'];
const BUNDLE_RATE = 0.7;
// skin hiển thị khi người chơi chưa từng chọn trong Tủ đồ: thứ đắt/hiếm hơn thắng (hành vi cũ)
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

/** true nếu đang trong mùa bán (giờ VN, UTC+7). Không có season = luôn bán. */
export function inSeason(def, now = Date.now()) {
  if (!def.season) return true;
  const md = new Date(now + 7 * 3600_000).toISOString().slice(5, 10);
  const [from, to] = def.season;
  return from <= to ? md >= from && md <= to : md >= from || md <= to;
}
const round1000 = (v) => Math.round(v / 1000) * 1000;
/** Giá thực của SKU cho người chơi này (combo trừ món đã có). null = không mua được (đã đủ). */
export function priceFor(sku, owned) {
  const def = SKUS[sku];
  if (def.kind !== 'bundle') return def.price;
  if (owned.includes(sku)) return null;
  const missing = def.items.filter((i) => !owned.includes(i));
  if (!missing.length) return null;
  if (def.fixedPrice) return def.fixedPrice;
  return round1000(BUNDLE_RATE * missing.reduce((t, i) => t + SKUS[i].price, 0));
}
function limitLeftOf(sku, owned) {
  const def = SKUS[sku];
  if (def.kind === 'bundle') return priceFor(sku, owned) === null ? 0 : 1;
  if (def.limit !== 'once') return null;               // null = không giới hạn
  return owned.includes(sku) ? 0 : 1;
}
export async function shop(env, playerId, now = Date.now()) {
  const owned = playerId ? await entitlements(env, playerId, now) : [];
  const out = [];
  for (const [sku, d] of Object.entries(SKUS)) {
    const it = { sku, price: d.kind === 'bundle' ? priceFor(sku, owned) : d.price, kind: d.kind, slot: d.slot || null, rarity: d.rarity,
      label: d.label, desc: d.desc, limitLeft: playerId ? limitLeftOf(sku, owned) : null, onSale: inSeason(d, now) };
    if (d.kind === 'bundle') { it.items = d.items; it.fullPrice = d.items.reduce((t, i) => t + SKUS[i].price, 0); }
    if (d.season) it.season = d.season;
    out.push(it);
  }
  return out;
}

/* ---------- loadout (Tủ đồ): slot -> sku đang trang bị ---------- */
/** Cosmetic hiệu lực của người chơi: {tank, bullet, eagle, map}. Chỉ trả SKU còn sở hữu. */
export async function loadout(env, playerId, now = Date.now()) {
  const out = { tank: null, bullet: null, eagle: null, map: null };
  if (!env.DB || !playerId) return out;
  const owned = await entitlements(env, playerId, now);
  const { results } = await env.DB.prepare('SELECT slot, sku FROM loadouts WHERE player_id = ?').bind(playerId).all();
  const chosen = new Set();
  for (const r of results || []) {
    if (!SLOTS.includes(r.slot)) continue;
    chosen.add(r.slot);
    if (r.sku && owned.includes(r.sku) && SKUS[r.sku] && SKUS[r.sku].slot === r.slot) out[r.slot] = r.sku;
  }
  if (!chosen.has('tank')) out.tank = pickSkin(owned, false);   // chưa từng chọn: hành vi cũ
  return out;
}
export async function setLoadout(env, playerId, slot, sku, now = Date.now()) {
  if (!SLOTS.includes(slot)) return { status: 400, body: { error: 'BAD_SLOT' } };
  if (sku !== null) {
    const def = SKUS[sku];
    if (!def || def.slot !== slot) return { status: 400, body: { error: 'BAD_SKU' } };
    if (!(await entitlements(env, playerId, now)).includes(sku)) return { status: 403, body: { error: 'NOT_OWNED' } };
  }
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO players (id, created_at) VALUES (?, ?)').bind(playerId, now),
    env.DB.prepare('INSERT INTO loadouts (player_id, slot, sku, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, slot) DO UPDATE SET sku = excluded.sku, updated_at = excluded.updated_at')
      .bind(playerId, slot, sku, now),
  ]);
  return { status: 200, body: await loadout(env, playerId, now) };
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
  if (!inSeason(def, now)) return { status: 409, body: { error: 'OUT_OF_SEASON' } };
  for (const i of def.items || []) if (!inSeason(SKUS[i], now)) return { status: 409, body: { error: 'OUT_OF_SEASON' } };
  const owned = await entitlements(env, playerId, now);
  if (limitLeftOf(sku, owned) === 0) return { status: 409, body: { error: 'LIMIT_REACHED' } };
  const price = priceFor(sku, owned);
  const orderId = 'o' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const code = 'ARC' + rnd(8);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO players (id, created_at) VALUES (?, ?)').bind(playerId, now),
    env.DB.prepare('INSERT INTO orders (id, player_id, sku, amount, code, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(orderId, playerId, sku, price, code, 'pending', now),
  ]);
  return { status: 200, body: { orderId, amount: price, code, qr: qrFor(env, price, code), sandbox: !isLive(env) } };
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
  if (def.kind === 'bundle') {
    // một đơn combo = một batch: món chưa có + dấu combo (để Tân Binh chỉ mua 1 lần)
    const owned = await entitlements(env, o.player_id, now);
    const ins = (sku) => env.DB.prepare('INSERT INTO entitlements (player_id, sku, source, created_at) VALUES (?, ?, ?, ?)').bind(o.player_id, sku, 'order:' + o.id, now);
    return env.DB.batch([...def.items.filter((i) => !owned.includes(i)).map(ins), ins(o.sku)]);
  }
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
