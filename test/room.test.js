/* Unit test room module (server/room.js = game.js + room.part.js) chạy headless.
   Chạy: npm test   (node --test test/*.test.js) */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoom } = require('./host');

function enemies(g) { return g.tanks.filter((t) => t.kind === 'enemy' && !t.dead); }
function playerTank(g, slot) { return g.tanks.find((t) => t.kind === 'player' && t.slot === slot && !t.dead); }
/** Dọn sạch mọi xe địch đang có + hàng đợi -> tick kế tiếp là stageclear. */
function clearStage(r) { const g = r.game; g.enemyQueue.length = 0; for (const e of enemies(g)) e.dead = true; r.tick(1); }

test('config: 30Hz, tối đa 4 người', () => {
  const r = createRoom();
  assert.equal(r.mod.config.tickRate, 30);
  assert.equal(r.mod.config.maxPlayers, 4);
  assert.equal(r.room.state.status, 'lobby');
  assert.equal(JSON.stringify(r.room.state.dims), JSON.stringify({ tile: 16, cols: 26, rows: 26 }));
});

test('join: gửi slot riêng, người đầu chờ ở waiting', () => {
  const r = createRoom();
  const a = r.join('An');
  const you = r.out.find((o) => o[0] === 'snd' && o[1] === a.id && o[2] === 'you');
  assert.ok(you, 'phải gửi event you');
  assert.equal(you[3].slot, 0);
  assert.equal(r.room.state.status, 'waiting');
  r.tick(30);
  assert.equal(enemies(r.game).length, 0, 'waiting thì chưa có địch');
});

test('người thứ 2 vào -> tự bắt đầu, mỗi người một xe', () => {
  const r = createRoom();
  r.join('A'); r.join('B');
  assert.equal(r.game.status, 'playing');
  r.tick(1);
  assert.ok(playerTank(r.game, 0) && playerTank(r.game, 1));
  assert.equal(Object.keys(r.room.state.players).length, 2);
});

test('host bấm start khi chơi một mình', () => {
  const r = createRoom();
  const a = r.join('Solo');
  r.msg(a, 'start');
  assert.equal(r.game.status, 'playing');
  assert.equal(r.room.state.stage, 1);
});

test('phòng đầy: người thứ 5 bị engine từ chối, không ném lỗi', () => {
  const r = createRoom();
  for (let i = 0; i < 5; i++) r.join('P' + i);
  assert.equal(r.game.players.size, 4);
  assert.ok(r.out.some((o) => o[0] === 'log'));
});

test('tick: địch xuất hiện và state có tanks keyed-by-id', () => {
  const r = createRoom();
  const a = r.join('A'); r.msg(a, 'start');
  r.tick(40);
  assert.ok(enemies(r.game).length >= 1, 'sau ~1.3s phải có ít nhất 1 xe địch');
  const ids = Object.keys(r.room.state.tanks);
  assert.ok(ids.length >= 2);
  for (const id of ids) assert.equal(String(r.room.state.tanks[id].id), id);
});

test('input rác không làm sập phòng', () => {
  const r = createRoom();
  const a = r.join('A'); r.msg(a, 'start');
  r.msg(a, 'input', { dir: -1, moving: 'x', fire: 1 });
  r.msg(a, 'input', { dir: 2.5 });
  r.msg(a, 'input', null);
  r.msg(a, 'input', { dir: 1, moving: true, fire: true });
  assert.doesNotThrow(() => r.tick(60));
});

test('qua màn: hết địch -> stageclear -> màn 2 sau ~3s, gửi map mới', () => {
  const r = createRoom();
  const a = r.join('A'); r.msg(a, 'start');
  r.tick(5);
  const map1 = r.room.state.map.join('');
  clearStage(r);
  assert.equal(r.game.status, 'stageclear');
  r.tick(95);
  assert.equal(r.game.status, 'playing');
  assert.equal(r.room.state.stage, 2);
  assert.notEqual(r.room.state.map.join(''), map1);
});

test('đại bàng bị phá -> gameover; start -> chơi lại từ màn 1', () => {
  const r = createRoom();
  const a = r.join('A'); r.msg(a, 'start');
  r.tick(2);
  r.game.destroyBase();
  r.tick(1);
  assert.equal(r.room.state.status, 'gameover');
  assert.equal(r.room.state.base.alive, false);
  r.msg(a, 'start');
  r.tick(1);
  assert.equal(r.room.state.status, 'playing');
  assert.equal(r.room.state.stage, 1);
});

test('onDispose nộp điểm > 0 lên alltime + daily', () => {
  const r = createRoom();
  const a = r.join('A'); r.msg(a, 'start');
  r.game.players.get(0).score = 500;
  r.mod.onDispose(r.room);
  const subs = r.out.filter((o) => o[0] === 'score');
  assert.equal(subs.map((s) => s[1]).sort().join(), 'alltime,daily');
  assert.equal(subs[0][3], 500);
});

test('rời phòng: xe bị gỡ, phòng trống về lobby', () => {
  const r = createRoom();
  const a = r.join('A'); r.msg(a, 'start'); r.tick(2);
  r.leave(a); r.tick(1);
  assert.equal(r.game.players.size, 0);
  assert.equal(r.game.status, 'lobby');
});

// ── Luật a: áp lực địch theo số người ───────────────────────────────────────
function startWith(n) {
  const r = createRoom();
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(r.join('P' + i));
  if (r.game.status === 'waiting') r.msg(ps[0], 'start');
  // Người thứ 2 vào là trận tự bắt đầu (n=2) -> người 3, 4 là "vào muộn".
  // Chơi lại để màn 1 được tính với đủ n người.
  if (n > 2) r.game.restart();
  return { r, ps };
}
function peakActive(r, ticks) {
  let peak = 0;
  for (let i = 0; i < ticks; i++) {
    // giữ người chơi sống + không bị địch che chỗ spawn quá lâu: chỉ đo trần
    r.tick(1); peak = Math.max(peak, enemies(r.game).length);
    if (r.game.status !== 'playing') break;
  }
  return peak;
}

for (const [n, total, cap] of [[1, 20, 4], [2, 26, 6], [3, 32, 8], [4, 38, 8]]) {
  test(`a) ${n} người: ${total} địch / màn, tối đa ${cap} cùng lúc`, () => {
    const { r } = startWith(n);
    assert.equal(r.game.enemiesRemaining(), total);
    assert.equal(r.game.maxActive, cap);
    r.tick(1);
    assert.equal(r.room.state.enemiesLeft, total);
    for (const p of r.game.players.values()) p.lives = 99;   // bot không chết giữa chừng
    r.game.baseAlive = true;
    const peak = peakActive(r, 1500);
    assert.ok(peak <= cap, `peak ${peak} > ${cap}`);
    assert.ok(peak >= Math.min(cap, 4), `peak ${peak}: phải đạt gần trần`);
  });
}

test('a) trần tính lúc bắt đầu màn: người vào giữa màn không đổi màn hiện tại, màn sau thì có', () => {
  const { r, ps } = startWith(1);
  assert.equal(r.game.maxActive, 4);
  r.join('Late');
  assert.equal(r.game.maxActive, 4);
  assert.equal(r.game.enemyQueue.length + r.game.activeEnemies(), 20);
  clearStage(r);
  r.tick(95);
  assert.equal(r.game.stage, 2);
  assert.equal(r.game.maxActive, 6);
  assert.equal(r.game.enemiesRemaining(), 26);
  void ps;
});

test('a) vật phẩm rải đều theo số địch: 3 ở 20 địch, 5 ở 38 địch', () => {
  for (const [n, want] of [[1, 3], [4, 5]]) {
    const { r } = startWith(n);
    const total = r.game.enemiesRemaining();
    let bonus = 0;
    for (let i = 0; i < total; i++) if (i % 7 === 3) bonus++;
    // đếm thật qua spawn: ép spawn hết hàng đợi
    r.game.maxActive = 99;
    let seen = 0;
    while (r.game.enemyQueue.length) {
      r.game.spawnCooldown = 0;
      for (const t of r.game.tanks) if (t.kind === 'enemy') { if (t.bonus) seen++; t.dead = true; }
      r.game.tanks = r.game.tanks.filter((t) => !t.dead);
      r.game.trySpawnEnemy();
    }
    for (const t of r.game.tanks) if (t.kind === 'enemy' && t.bonus) seen++;
    assert.equal(seen, want, `${n} người`);
    assert.equal(bonus, want);
  }
});

// ── Luật b: bắn đồng đội = choáng 2s ────────────────────────────────────────
/** Đặt 2 xe người chơi đối diện nhau trên hàng trống (y=0) rồi cho A bắn B. */
function duel(r) {
  const g = r.game;
  g.enemyQueue.length = 0; for (const e of enemies(g)) e.dead = true;
  g.spawnCooldown = 1e9;
  const a = playerTank(g, 0), b = playerTank(g, 1);
  a.x = 64; a.y = 0; a.dir = 1; a.spawnUntil = 0; a.shieldUntil = 0; a.cooldown = 0;
  b.x = 160; b.y = 0; b.dir = 3; b.spawnUntil = 0; b.shieldUntil = 0;
  g.enemyQueue.push('basic'); // giữ màn chưa clear
  return { g, a, b };
}
function fireOnce(r, p) { r.msg(p, 'input', { dir: 1, moving: false, fire: true }); r.tick(1); r.msg(p, 'input', { dir: 1, moving: false, fire: false }); }

test('b) mặc định bật: đạn đồng đội làm choáng 2s, không mất mạng', () => {
  const { r, ps } = startWith(2);
  assert.equal(r.room.state.friendlyFire, true);
  r.tick(2);
  const { g, b } = duel(r);
  const lives = g.players.get(1).lives;
  fireOnce(r, ps[0]);
  r.tick(20);
  assert.ok(b.stunUntil > g.tick, 'B phải bị choáng');
  assert.equal(g.players.get(1).lives, lives, 'không mất mạng');
  assert.ok(!b.dead);
  const sn = Object.values(r.room.state.tanks).find((t) => t.slot === 1);
  assert.equal(sn.st, 1, 'state có cờ st để client vẽ');
});

test('b) đang choáng: không chạy, không bắn; hết 2s thì điều khiển lại được', () => {
  const { r, ps } = startWith(2);
  r.tick(2);
  const { g, b } = duel(r);
  fireOnce(r, ps[0]);
  r.tick(20);
  assert.ok(b.stunUntil > g.tick);
  const x0 = b.x;
  r.msg(ps[1], 'input', { dir: 3, moving: true, fire: true });
  r.tick(10);
  assert.equal(b.x, x0, 'không được di chuyển khi choáng');
  assert.equal(g.bullets.filter((k) => k.ownerId === b.id).length, 0, 'không được bắn khi choáng');
  r.tick(Math.max(0, b.stunUntil - g.tick) + 1);
  r.tick(5);
  assert.ok(b.x < x0, 'hết choáng thì chạy được');
});

test('b) khiên chặn choáng', () => {
  const { r, ps } = startWith(2);
  r.tick(2);
  const { g, b } = duel(r);
  b.shieldUntil = g.tick + 300;
  fireOnce(r, ps[0]);
  r.tick(20);
  assert.ok(!(b.stunUntil > g.tick));
});

test('b) tắt ở phòng chờ: đạn xuyên qua đồng đội như cũ', () => {
  const r = createRoom();
  const a = r.join('A');
  r.msg(a, 'option', { friendlyFire: false });
  assert.equal(r.room.state.friendlyFire, false);
  const b = r.join('B');                    // người 2 vào -> tự bắt đầu
  assert.equal(r.game.status, 'playing');
  r.tick(2);
  const { g, b: tb } = duel(r);
  fireOnce(r, a);
  r.tick(20);
  assert.ok(!(tb.stunUntil > g.tick));
  assert.equal(g.players.get(1).lives, 3);
  void b;
});

test('b) tuỳ chọn: chỉ chủ phòng (slot nhỏ nhất), không đổi giữa trận; onCreate nhận opts', () => {
  const r = createRoom();
  const a = r.join('A'); const b = r.join('B');
  r.msg(b, 'option', { friendlyFire: false });
  assert.equal(r.game.friendlyFire, true, 'đang chơi: không đổi');
  r.game.destroyBase(); r.tick(1);
  r.msg(b, 'option', { friendlyFire: false });
  assert.equal(r.game.friendlyFire, true, 'không phải chủ phòng');
  r.msg(a, 'option', { friendlyFire: 'no' });
  assert.equal(r.game.friendlyFire, true, 'giá trị rác bị bỏ qua');
  r.msg(a, 'option', { friendlyFire: false });
  assert.equal(r.game.friendlyFire, false);
  r.leave(a);
  r.msg(b, 'option', { friendlyFire: true });
  assert.equal(r.game.friendlyFire, true, 'chủ rời đi -> B thành chủ');

  const r2 = createRoom({ friendlyFire: false });
  assert.equal(r2.room.state.friendlyFire, false);
});

test('b) địch vẫn không bắn nhau', () => {
  const { r } = startWith(1);
  r.tick(2);
  const g = r.game;
  g.enemyQueue.length = 0; g.spawnCooldown = 1e9;
  g.tanks.push({ id: 9001, kind: 'enemy', x: 160, y: 0, w: 32, h: 32, dir: 3, hp: 1, spawnUntil: 0, shieldUntil: 0, dead: false, moving: false, speed: 0, fireProb: 0, cooldown: 0, aiTimer: 999 });
  g.bullets.push({ id: 9002, x: 150, y: 12, w: 8, h: 8, dir: 1, speed: 4, ownerId: 9003, ownerKind: 'enemy', dead: false });
  r.tick(3);
  assert.ok(g.tanks.some((t) => t.id === 9001), 'xe địch không chết vì đạn địch');
});

// ── Luật c: vật phẩm "tank" hồi sinh đồng đội trước ─────────────────────────
/** Bắn hạ xe của slot (bỏ khiên xuất hiện trước). */
function kill(g, slot) { const t = playerTank(g, slot); t.shieldUntil = 0; g.damagePlayer(t); }
function pickTank(r, slot) {
  const g = r.game;
  const t = playerTank(g, slot);
  g.applyPowerup({ type: 'tank' }, t);
}

test('c) có đồng đội bị loại -> hồi sinh đồng đội (1 mạng), người nhặt không +mạng', () => {
  const { r } = startWith(3);
  r.tick(40);
  const g = r.game;
  const out = g.players.get(2);
  out.lives = 1; kill(g, 2); r.tick(1);
  assert.equal(out.lives, 0); assert.equal(out.tankId, null);
  const before = g.players.get(0).lives;
  pickTank(r, 0);
  assert.equal(out.lives, 1);
  assert.ok(playerTank(g, 2), 'đồng đội có xe lại');
  assert.equal(g.players.get(0).lives, before);
  r.tick(1);
  assert.equal(r.room.state.players[2].lives, 1);
});

test('c) không ai bị loại -> +1 mạng như cũ', () => {
  const { r } = startWith(2);
  r.tick(40);
  const before = r.game.players.get(0).lives;
  pickTank(r, 0);
  assert.equal(r.game.players.get(0).lives, before + 1);
});

test('c) người chờ hồi sinh (còn mạng) không tính là bị loại', () => {
  const { r } = startWith(2);
  r.tick(40);
  const g = r.game;
  kill(g, 1);                             // còn 2 mạng, đang đợi respawn
  const b = g.players.get(1).lives;
  pickTank(r, 0);
  assert.equal(g.players.get(1).lives, b);
  assert.equal(g.players.get(0).lives, 4);
});

test('c) nhiều người bị loại -> hồi sinh slot nhỏ nhất, mỗi vật phẩm một người', () => {
  const { r } = startWith(4);
  r.tick(40);
  const g = r.game;
  for (const s of [3, 1]) { g.players.get(s).lives = 1; kill(g, s); }
  pickTank(r, 0);
  assert.equal(g.players.get(1).lives, 1);
  assert.equal(g.players.get(3).lives, 0);
  pickTank(r, 0);
  assert.equal(g.players.get(3).lives, 1);
});
