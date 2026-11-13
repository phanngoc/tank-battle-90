/* Mỹ phẩm Tank: economy (D1 giả bằng node:sqlite) + skin không đổi chỉ số.
   Chạy: npm test */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createRoom } = require('./host');

/** D1 tối thiểu trên node:sqlite: prepare().bind().first/all/run + batch. */
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = path.join(__dirname, '..', 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async first() { return db.prepare(sql).get(...args) || null; },
    async all() { return { results: db.prepare(sql).all(...args) }; },
    async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return { prepare: (sql) => stmt(sql), async batch(list) { db.exec('BEGIN'); try { const o = []; for (const s of list) o.push(await s.run()); db.exec('COMMIT'); return o; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
}
const eco = () => import('../cf/economy.mjs');
const envOf = (extra) => Object.assign({ DB: fakeD1(), PAYMENTS_LIVE: 'false' }, extra);

test('guest token: ký và xác minh, token giả/sai loại bị từ chối', async () => {
  const e = await eco(); const env = envOf();
  const g = await e.newGuest(env);
  assert.equal(await e.verifyToken(env, g.accessToken, 'a'), g.playerId);
  assert.equal(await e.verifyToken(env, g.refreshToken, 'a'), null, 'refresh token không dùng làm access');
  assert.equal(await e.verifyToken(env, g.accessToken.slice(0, -2) + 'xx', 'a'), null);
  assert.equal(await e.verifyToken(env, 'a0123456789abcdef', 'a'), null, 'token ngẫu nhiên kiểu cũ -> ẩn danh');
  assert.equal(await e.verifyToken(envOf({ AUTH_SECRET: 'other' }), g.accessToken, 'a'), null);
});

test('đơn hàng -> sandbox confirm -> entitlement; webhook lặp lại không cấp hai lần', async () => {
  const e = await eco(); const env = envOf();
  const { playerId } = await e.newGuest(env);
  const o = await e.createOrder(env, playerId, 'tank.skin.gold');
  assert.equal(o.status, 200); assert.equal(o.body.amount, 29000); assert.match(o.body.code, /^ARC[A-Z0-9]{8}$/);
  assert.equal(o.body.sandbox, true); assert.equal(o.body.qr.content, o.body.code);
  assert.equal((await e.orderStatus(env, playerId, o.body.orderId)).body.status, 'pending');
  const c = await e.sandboxConfirm(env, playerId, o.body.orderId);
  assert.equal(c.body.outcome, 'granted'); assert.equal(c.body.granted, 'tank.skin.gold');
  assert.equal((await e.orderStatus(env, playerId, o.body.orderId)).body.status, 'paid');
  assert.deepEqual(await e.entitlements(env, playerId), ['tank.skin.gold']);
  const again = await e.sandboxConfirm(env, playerId, o.body.orderId);
  assert.equal(again.body.duplicate, true);
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM entitlements').all();
  assert.equal(results[0].n, 1);
  assert.equal((await e.createOrder(env, playerId, 'tank.skin.gold')).status, 409, 'skin chỉ mua một lần');
});

const KEY = 'k1', AUTH = 'Apikey ' + KEY;
const sepay = (extra) => Object.assign({ id: 92704, gateway: 'MBBank', transactionDate: '2026-11-13 10:00:00', accountNumber: '0123',
  subAccount: null, code: null, content: '', transferType: 'in', description: '', transferAmount: 19000, accumulated: 0, referenceCode: 'FT1' }, extra);
const events = (env) => env.DB.prepare('SELECT provider_txn, order_id, outcome FROM payment_events ORDER BY created_at, provider_txn').all().then((r) => r.results);
async function setup() {
  const e = await eco(); const env = envOf({ SEPAY_API_KEY: KEY });
  const { playerId } = await e.newGuest(env);
  const o = (await e.createOrder(env, playerId, 'tank.skin.jade')).body;
  return { e, env, playerId, o };
}

test('SePay QR: qr.sepay.vn với acc/bank/amount/des', async () => {
  const { o } = await setup();
  assert.equal(o.qr.provider, 'sepay'); assert.equal(o.qr.content, o.code);
  assert.equal(o.qr.imageUrl, `https://qr.sepay.vn/img?acc=SANDBOX&bank=MBBank&amount=19000&des=${o.code}`);
});

test('SePay webhook: đúng -> granted (mã trong content); trùng id -> cấp một lần', async () => {
  const { e, env, playerId, o } = await setup();
  const r = await e.handleWebhook(env, sepay({ content: 'CK ' + o.code.toLowerCase() + ' thanh toan' }), AUTH);
  assert.equal(r.status, 200); assert.equal(r.body.outcome, 'granted'); assert.equal(r.body.granted, 'tank.skin.jade');
  const dup = await e.handleWebhook(env, sepay({ content: 'CK ' + o.code }), AUTH);
  assert.equal(dup.status, 200); assert.equal(dup.body.duplicate, true);
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM entitlements WHERE player_id = ?').bind(playerId).all();
  assert.equal(results[0].n, 1);
  // giao dịch khác (id mới) cho đơn đã trả: ghi already_paid, không cấp lại
  assert.equal((await e.handleWebhook(env, sepay({ id: 92705, code: o.code }), AUTH)).body.outcome, 'already_paid');
  assert.deepEqual((await events(env)).map((x) => x.outcome), ['granted', 'already_paid']);
});

test('SePay webhook: sai/thiếu key 401 không ghi gì; thiếu id 400', async () => {
  const { e, env, playerId, o } = await setup();
  for (const a of ['Apikey wrong', '', null, 'Bearer k1', 'k1']) assert.equal((await e.handleWebhook(env, sepay({ code: o.code }), a)).status, 401, String(a));
  assert.deepEqual(await e.entitlements(env, playerId), []);
  assert.deepEqual(await events(env), []);
  assert.equal((await e.handleWebhook(env, sepay({ id: undefined, code: o.code }), AUTH)).status, 400);
  assert.equal((await e.handleWebhook(env, sepay({ id: 'abc', code: o.code }), AUTH)).status, 400);
});

test('SePay webhook: sai số tiền / không có mã / mã lạ / chuyển ra -> ghi outcome, không cấp', async () => {
  const { e, env, playerId, o } = await setup();
  const cases = [
    [sepay({ id: 1, code: o.code, transferAmount: 18000 }), 'amount_mismatch'],
    [sepay({ id: 2, code: o.code, transferAmount: 20000 }), 'amount_mismatch'],
    [sepay({ id: 3, content: 'chuyen tien an trua' }), 'no_code'],
    [sepay({ id: 4, code: 'ARCZZZZZZZZ' }), 'unknown_order'],
    [sepay({ id: 5, code: o.code, transferType: 'out' }), 'ignored_out'],
  ];
  for (const [body, want] of cases) {
    const r = await e.handleWebhook(env, body, AUTH);
    assert.equal(r.status, 200); assert.equal(r.body.success, true); assert.equal(r.body.outcome, want, JSON.stringify(body));
  }
  assert.deepEqual(await e.entitlements(env, playerId), []);
  const ev = await events(env);
  assert.deepEqual(ev.map((x) => x.provider_txn + ':' + x.outcome).sort(), ['sepay:1:amount_mismatch', 'sepay:2:amount_mismatch', 'sepay:3:no_code', 'sepay:4:unknown_order', 'sepay:5:ignored_out']);
  assert.equal(ev.find((x) => x.provider_txn === 'sepay:3').order_id, null);
  // sau tất cả, giao dịch đúng vẫn cấp được
  assert.equal((await e.handleWebhook(env, sepay({ id: 6, code: o.code }), AUTH)).body.outcome, 'granted');
});

test('PAYMENTS_LIVE=true: không có sandbox confirm, thiếu SEPAY_API_KEY -> 503', async () => {
  const e = await eco(); const env = envOf({ PAYMENTS_LIVE: 'true', AUTH_SECRET: 's' });
  const { playerId } = await e.newGuest(env);
  const o = (await e.createOrder(env, playerId, 'tank.skin.jade')).body;
  assert.equal(o.sandbox, false);
  assert.equal((await e.sandboxConfirm(env, playerId, o.orderId)).status, 404);
  assert.equal((await e.handleWebhook(env, sepay({ code: o.code }), 'Apikey tank-sandbox-sepay')).status, 503);
});

test('sandbox: không có SEPAY_API_KEY thì dùng key sandbox; key sandbox bị từ chối khi đã đặt key thật', async () => {
  const e = await eco(); const env = envOf();
  const { playerId } = await e.newGuest(env);
  const o = (await e.createOrder(env, playerId, 'tank.skin.gold')).body;
  assert.equal((await e.handleWebhook(envOf({ SEPAY_API_KEY: 'real' }), sepay({ code: o.code }), 'Apikey tank-sandbox-sepay')).status, 401);
  assert.equal((await e.handleWebhook(env, sepay({ code: o.code, transferAmount: 29000 }), 'Apikey tank-sandbox-sepay')).body.outcome, 'granted');
});

test('pass co-op hết hạn sau 28 ngày, mua tiếp thì cộng dồn', async () => {
  const e = await eco(); const env = envOf(); const t0 = Date.now(); const DAY = 86400000;
  const { playerId } = await e.newGuest(env);
  for (let i = 0; i < 2; i++) { const o = (await e.createOrder(env, playerId, 'tank.pass.coop', t0)).body; await e.sandboxConfirm(env, playerId, o.orderId, t0); }
  assert.deepEqual(await e.entitlements(env, playerId, t0 + 50 * DAY), ['tank.pass.coop']);
  assert.deepEqual(await e.entitlements(env, playerId, t0 + 57 * DAY), []);
});

test('phòng lễ hội: một lượt mua = một phòng; skin ưu tiên', async () => {
  const e = await eco(); const env = envOf();
  const { playerId } = await e.newGuest(env);
  assert.equal(await e.consumeFestival(env, playerId), false);
  const o = (await e.createOrder(env, playerId, 'tank.room.festival')).body;
  await e.sandboxConfirm(env, playerId, o.orderId);
  assert.ok((await e.entitlements(env, playerId)).includes('tank.room.festival'));
  assert.equal(await e.consumeFestival(env, playerId), true);
  assert.equal(await e.consumeFestival(env, playerId), false);
  assert.deepEqual(await e.entitlements(env, playerId), []);
  assert.equal(e.pickSkin([], true), 'tank.room.festival');
  assert.equal(e.pickSkin(['tank.skin.jade', 'tank.skin.gold'], false), 'tank.skin.gold');
  assert.equal(e.pickSkin([], false), null);
  // không SKU nào mang chỉ số: chỉ cosmetic hoặc combo của cosmetic
  const STAT = /speed|damage|hp|armor|bullet(Speed|s)|lives|power/i;
  for (const [sku, d] of Object.entries(e.SKUS)) {
    assert.ok(d.kind === 'cosmetic' || d.kind === 'bundle', sku);
    for (const k of Object.keys(d)) assert.ok(!STAT.test(k), sku + ' có trường ' + k);
    for (const i of d.items || []) assert.equal(e.SKUS[i].kind, 'cosmetic', sku + ' gồm ' + i);
  }
});

/** Chơi cùng một kịch bản có định trước; trả về toàn bộ chỉ số xe + điểm theo thời gian. */
function playScript(skins, cos = []) {
  const r = createRoom();
  let seed = 42;   // Math.random có định trong vm context của phòng (Math của test không bị đụng)
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  require('node:vm').runInContext('Math = Object.assign(Object.create(Math), { random: __r })', Object.assign(r.ctx, { __r: rnd }));
  const ps = [];
  for (let i = 0; i < 4; i++) { const p = { id: 'p' + i, name: 'P' + i, isHost: i === 0, skin: skins[i], cos: cos[i] }; r.mod.onJoin(r.room, p); ps.push(p); }
  const trace = [];
  for (let t = 0; t < 600; t++) {
    ps.forEach((p, i) => r.msg(p, 'input', { dir: (t >> 5) % 4, moving: true, fire: (t + i) % 7 === 0 }));
    r.tick(1);
    if (t % 50 === 0) {
      const tanks = r.game.tanks.filter((x) => x.kind === 'player').map((x) => ({ slot: x.slot, speed: x.speed, bulletSpeed: x.bulletSpeed, maxBullets: x.maxBullets, hp: x.hp, steel: x.canDestroySteel, x: x.x, y: x.y }));
      trace.push({ tanks, players: [...r.game.players.values()].map((p) => [p.slot, p.lives, p.level, p.score]), status: r.game.status });
    }
  }
  return { trace: JSON.parse(JSON.stringify(trace)), state: JSON.parse(JSON.stringify(r.room.state)) };
}

test('skin KHÔNG đổi chỉ số: cùng kịch bản, có/không entitlement -> engine giống hệt', () => {
  const plain = playScript([null, null, null, null]);
  const dressed = playScript(['tank.skin.gold', 'tank.skin.jade', 'tank.pass.coop', 'tank.room.festival']);
  assert.deepEqual(dressed.trace, plain.trace);
  assert.deepEqual(plain.state.skins, {});
  assert.deepEqual(dressed.state.skins, { 0: 'tank.skin.gold', 1: 'tank.skin.jade', 2: 'tank.pass.coop', 3: 'tank.room.festival' });
  const strip = (s) => { const c = JSON.parse(JSON.stringify(s)); delete c.skins; delete c.cos; delete c.roomCos; return c; };
  assert.deepEqual(strip(dressed.state), strip(plain.state), 'state ngoài skins giống hệt');
});

const FULL = [
  { tank: 'tank.skin.dragon', bullet: 'tank.bullet.dragon', eagle: 'tank.eagle.phoenix', map: 'tank.map.neon' },
  { tank: 'tank.skin.neon', bullet: 'tank.bullet.plasma', eagle: 'tank.eagle.lac', map: 'tank.map.tet' },
  { tank: 'tank.skin.camo', bullet: 'tank.bullet.laser' },
  { bullet: 'tank.bullet.firework' },
];
test('full cosmetic 4 slot KHÔNG đổi chỉ số; đồng đội thấy xe+đạn, map/đại bàng theo chủ phòng', () => {
  const plain = playScript([null, null, null, null]);
  const dressed = playScript([null, null, null, null], FULL);
  assert.deepEqual(dressed.trace, plain.trace);
  const strip = (s) => { const c = JSON.parse(JSON.stringify(s)); delete c.skins; delete c.cos; delete c.roomCos; return c; };
  assert.deepEqual(strip(dressed.state), strip(plain.state));
  assert.deepEqual(dressed.state.cos, { 0: { tank: 'tank.skin.dragon', bullet: 'tank.bullet.dragon' }, 1: { tank: 'tank.skin.neon', bullet: 'tank.bullet.plasma' },
    2: { tank: 'tank.skin.camo', bullet: 'tank.bullet.laser' }, 3: { bullet: 'tank.bullet.firework' } });
  assert.deepEqual(dressed.state.roomCos, { eagle: 'tank.eagle.phoenix', map: 'tank.map.neon' }, 'map/đại bàng của slot 0 (chủ phòng)');
  assert.deepEqual(plain.state.roomCos, { eagle: null, map: null });
});

test('chủ phòng rời đi -> map/đại bàng theo chủ mới; cos sai slot bị bỏ', () => {
  const r = createRoom();
  const a = { id: 'a', name: 'A', isHost: true, cos: FULL[0] }, b = { id: 'b', name: 'B', cos: FULL[1] };
  r.mod.onJoin(r.room, a); r.mod.onJoin(r.room, b); r.tick(1);
  assert.equal(r.room.state.roomCos.map, 'tank.map.neon');
  r.mod.onLeave(r.room, a); r.tick(1);
  assert.deepEqual({ ...r.room.state.roomCos }, { eagle: 'tank.eagle.lac', map: 'tank.map.tet' });
  const c = { id: 'c', name: 'C', cos: { tank: 'tank.bullet.laser', bullet: 'tank.skin.gold', map: 'hack', eagle: 1 } };
  r.mod.onJoin(r.room, c); r.tick(1);
  assert.equal(r.room.state.cos[0], undefined, 'SKU sai slot không được nhận');
  r.msg(b, 'cos', { cos: { tank: 'tank.skin.gold' } }); r.tick(1);   // không trusted
  assert.equal(r.room.state.cos[1].tank, 'tank.skin.neon');
});

test('combo: giá trừ món đã có, cấp đủ món đúng một lần, Tân Binh 1 lần', async () => {
  const e = await eco(); const env = envOf();
  const { playerId } = await e.newGuest(env);
  const buy = async (sku) => { const o = await e.createOrder(env, playerId, sku); if (o.status !== 200) return o; await e.sandboxConfirm(env, playerId, o.body.orderId); return o; };
  const price = async (sku) => (await e.shop(env, playerId)).find((x) => x.sku === sku).price;
  assert.equal(await price('tank.bundle.dragon'), 89000);
  assert.equal(await price('tank.bundle.neon'), 61000);
  await buy('tank.bullet.plasma');                                     // mua lẻ trước
  assert.equal(await price('tank.bundle.neon'), Math.round(0.7 * (39000 + 29000) / 1000) * 1000);
  const o = await buy('tank.bundle.neon');
  assert.equal(o.body.amount, 48000);
  const own = await e.entitlements(env, playerId);
  for (const i of ['tank.skin.neon', 'tank.bullet.plasma', 'tank.map.neon']) assert.ok(own.includes(i), i);
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM entitlements WHERE sku = 'tank.bullet.plasma'").first()).n;
  assert.equal(n, 1, 'món đã có không cấp lại');
  assert.equal((await e.sandboxConfirm(env, playerId, o.body.orderId)).body.duplicate, true);
  assert.equal(await price('tank.bundle.neon'), null);
  assert.equal((await e.createOrder(env, playerId, 'tank.bundle.neon')).status, 409);
  assert.equal(await price('tank.bundle.rookie'), 15000);
  await buy('tank.bundle.rookie');
  assert.equal((await e.createOrder(env, playerId, 'tank.bundle.rookie')).status, 409, 'Tân Binh chỉ 1 lần');
});

test('theo mùa: Tết chỉ bán 01/01–28/02 (giờ VN)', async () => {
  const e = await eco(); const env = envOf();
  const { playerId } = await e.newGuest(env);
  const nov = Date.UTC(2026, 10, 13), jan = Date.UTC(2027, 0, 10);
  assert.equal((await e.createOrder(env, playerId, 'tank.map.tet', nov)).body.error, 'OUT_OF_SEASON');
  assert.equal((await e.createOrder(env, playerId, 'tank.bundle.tet', nov)).body.error, 'OUT_OF_SEASON');
  assert.equal((await e.createOrder(env, playerId, 'tank.map.tet', jan)).status, 200);
  assert.equal((await e.shop(env, playerId, nov)).find((x) => x.sku === 'tank.map.tet').onSale, false);
  assert.equal(e.inSeason(e.SKUS['tank.map.tet'], Date.UTC(2026, 11, 31, 18)), true, '01/01 01:00 giờ VN');
});

test('Tủ đồ: chỉ trang bị món đã có, bỏ trang bị, còn sau khi đọc lại; người cũ giữ skin tự chọn', async () => {
  const e = await eco(); const env = envOf();
  const { playerId } = await e.newGuest(env);
  assert.equal((await e.setLoadout(env, playerId, 'bullet', 'tank.bullet.fire')).status, 403);
  assert.equal((await e.setLoadout(env, playerId, 'tank', 'tank.bullet.fire')).status, 400);
  assert.equal((await e.setLoadout(env, playerId, 'hat', null)).status, 400);
  for (const sku of ['tank.skin.jade', 'tank.bullet.fire', 'tank.map.snow']) { const o = await e.createOrder(env, playerId, sku); await e.sandboxConfirm(env, playerId, o.body.orderId); }
  assert.equal((await e.loadout(env, playerId)).tank, 'tank.skin.jade', 'chưa chọn -> skin tự chọn như cũ');
  assert.equal((await e.loadout(env, playerId)).bullet, null, 'đạn không tự trang bị');
  await e.setLoadout(env, playerId, 'bullet', 'tank.bullet.fire');
  await e.setLoadout(env, playerId, 'map', 'tank.map.snow');
  await e.setLoadout(env, playerId, 'tank', null);
  assert.deepEqual(await e.loadout(env, playerId), { tank: null, bullet: 'tank.bullet.fire', eagle: null, map: 'tank.map.snow' });
});

test('skin lạ / client tự gửi skin bị bỏ qua', () => {
  const r = createRoom();
  const a = { id: 'a', name: 'A', isHost: true, skin: 'hack.godmode' };
  r.mod.onJoin(r.room, a); r.tick(1);
  assert.deepEqual({ ...r.room.state.skins }, {});
  r.msg(a, 'skin', { skin: 'tank.skin.gold' });            // không trusted
  r.tick(1);
  assert.deepEqual({ ...r.room.state.skins }, {});
  r.mod.onMessage(r.room, Object.assign({ trusted: true }, a), 'skin', { skin: 'tank.skin.gold' });
  assert.deepEqual({ ...r.room.state.skins }, { 0: 'tank.skin.gold' });
});
