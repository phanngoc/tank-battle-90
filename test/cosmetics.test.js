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
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '0001_entitlements.sql'), 'utf8'));
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
  assert.deepEqual(c.body, { ok: true, granted: 'tank.skin.gold' });
  assert.equal((await e.orderStatus(env, playerId, o.body.orderId)).body.status, 'paid');
  assert.deepEqual(await e.entitlements(env, playerId), ['tank.skin.gold']);
  const again = await e.sandboxConfirm(env, playerId, o.body.orderId);
  assert.equal(again.body.duplicate, true);
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS n FROM entitlements').all();
  assert.equal(results[0].n, 1);
  assert.equal((await e.createOrder(env, playerId, 'tank.skin.gold')).status, 409, 'skin chỉ mua một lần');
});

test('webhook: chữ ký sai 401, sai số tiền không cấp, txn khác cho đơn đã trả không cấp lại', async () => {
  const e = await eco(); const env = envOf({ PAYMENT_CHECKSUM_KEY: 'k1' });
  const { playerId } = await e.newGuest(env);
  const o = (await e.createOrder(env, playerId, 'tank.skin.jade')).body;
  const data = { orderCode: 123, amount: 19000, description: 'CK ' + o.code, reference: 'T1' };
  assert.equal((await e.handleWebhook(env, { data, signature: await e.signData('wrong', data) })).status, 401);
  const bad = { ...data, amount: 1000, reference: 'T0' };
  assert.equal((await e.handleWebhook(env, { data: bad, signature: await e.signData('k1', bad) })).body.error, 'AMOUNT_MISMATCH');
  assert.deepEqual(await e.entitlements(env, playerId), []);
  assert.equal((await e.handleWebhook(env, { data, signature: await e.signData('k1', data) })).body.granted, 'tank.skin.jade');
  const d2 = { ...data, reference: 'T2' };
  assert.equal((await e.handleWebhook(env, { data: d2, signature: await e.signData('k1', d2) })).body.duplicate, true);
});

test('PAYMENTS_LIVE=true: không có sandbox confirm, thiếu key thì không nhận webhook', async () => {
  const e = await eco(); const env = envOf({ PAYMENTS_LIVE: 'true', AUTH_SECRET: 's' });
  const { playerId } = await e.newGuest(env);
  const o = (await e.createOrder(env, playerId, 'tank.skin.jade')).body;
  assert.equal(o.sandbox, false);
  assert.equal((await e.sandboxConfirm(env, playerId, o.orderId)).status, 404);
  assert.equal((await e.handleWebhook(env, { data: {}, signature: '' })).status, 500);
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
  for (const d of Object.values(e.SKUS)) assert.equal(d.kind, 'cosmetic');
});

/** Chơi cùng một kịch bản có định trước; trả về toàn bộ chỉ số xe + điểm theo thời gian. */
function playScript(skins) {
  const r = createRoom();
  let seed = 42;   // Math.random có định trong vm context của phòng (Math của test không bị đụng)
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  require('node:vm').runInContext('Math = Object.assign(Object.create(Math), { random: __r })', Object.assign(r.ctx, { __r: rnd }));
  const ps = [];
  for (let i = 0; i < 4; i++) { const p = { id: 'p' + i, name: 'P' + i, isHost: i === 0, skin: skins[i] }; r.mod.onJoin(r.room, p); ps.push(p); }
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
  const strip = (s) => { const c = JSON.parse(JSON.stringify(s)); delete c.skins; return c; };
  assert.deepEqual(strip(dressed.state), strip(plain.state), 'state ngoài skins giống hệt');
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
