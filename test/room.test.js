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

// ── luật hiện tại (baseline, sẽ đổi ở bước sau) ─────────────────────────────
test('baseline: 20 địch / màn, tối đa 4 cùng lúc', () => {
  const r = createRoom();
  const a = r.join('A'); r.msg(a, 'start');
  assert.equal(r.room.state.enemiesLeft || r.game.enemiesRemaining(), 20);
  let peak = 0;
  for (let i = 0; i < 900; i++) { r.tick(1); peak = Math.max(peak, enemies(r.game).length); if (r.game.status !== 'playing') break; }
  assert.ok(peak <= 4, 'peak ' + peak);
});
