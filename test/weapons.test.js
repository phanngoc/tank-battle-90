/* Súng thật — bước 1: Laser (docs/tank-weapons-design.md §7).
   Engine game.js chạy trực tiếp; mỗi test dựng một sân trống rồi đặt vật cản/xe bằng tay. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, TILE, COLS, ROWS } = require('../game.js');
const { createRoom } = require('./host');

const LASER = 'tank.bullet.laser';
const EMPTY = 0, BRICK = 1, STEEL = 2, WATER = 3, FOREST = 4, ICE = 5, BASE = 6;
const UP = 0, RIGHT = 1, DOWN = 2;

/** Sân trống, 1 người (slot 0) ở (x,y) hướng dir, mode casual + Laser. */
function arena({ x = 192, y = 320, dir = UP, mode = 'casual', weapon = LASER } = {}) {
  const g = new Game();
  g.mode = mode;
  const p = g.addPlayer('A');
  g.startGame();
  g.grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(EMPTY));
  g.tanks = []; g.bullets = []; g.enemyQueue = []; g.spawnCooldown = 1e9;
  g.spawnPlayer(p, false);
  const t = g.tanks[0];
  t.x = x; t.y = y; t.dir = dir;
  g.setWeapon(p.slot, weapon);
  return { g, p, t };
}
function enemy(g, x, y, hp = 1) {
  const e = { id: g.nextId(), kind: 'enemy', x, y, w: 32, h: 32, dir: DOWN, hp, maxHp: hp, score: 100, spawnUntil: 0, shieldUntil: 0, dead: false, speed: 0, cooldown: 99 };
  g.tanks.push(e); return e;
}
function shoot(g, t) { g.beams = []; g.events = []; g.fire(t); return g.beams; }

test('Laser: tia tức thì cùng tick, hạ địch ở xa trên đường, không tạo viên đạn', () => {
  const { g, t } = arena();
  const e = enemy(g, 192, 16);              // cách ~270px — đạn thường cần ~45 tick
  const beams = shoot(g, t);
  assert.equal(beams.length, 1);
  assert.equal(g.bullets.length, 0, 'không có đạn bay');
  assert.ok(e.dead, 'địch chết ngay trong tick bắn');
  assert.equal(beams[0].ownerSlot, 0);
  assert.equal(beams[0].x1, beams[0].x2, 'tia dọc');
  assert.ok(beams[0].y2 <= e.y + e.h && beams[0].y2 >= e.y, 'tia dừng ở địch');
  assert.ok(g.events.includes('zap'));
});

test('Laser cấp 1: chỉ 1 mục tiêu, −1 máu (địch giáp 4 máu còn 3)', () => {
  const { g, t } = arena();
  const near = enemy(g, 192, 200, 4), far = enemy(g, 192, 40);
  shoot(g, t);
  assert.equal(near.hp, 3); assert.ok(!near.dead);
  assert.ok(!far.dead, 'mục tiêu thứ 2 không bị trúng');
});

test('Laser hồi chiêu 30 tick', () => {
  const { g, t } = arena();
  shoot(g, t);
  assert.equal(t.cooldown, 30);
  assert.equal(shoot(g, t).length, 0, 'đang hồi thì không bắn');
});

test('Laser KHÔNG phá gạch: dừng trước ô gạch, gạch còn nguyên, địch sau gạch sống', () => {
  const { g, t } = arena();
  for (let c = 0; c < COLS; c++) g.grid[10][c] = BRICK;
  const e = enemy(g, 192, 32);
  const [b] = shoot(g, t);
  assert.ok(g.grid[10].every((v) => v === BRICK), 'gạch không bị phá');
  assert.ok(!e.dead);
  assert.ok(b.y2 >= 11 * TILE, 'tia dừng ngay dưới hàng gạch');
});

test('Laser dừng ở thép (kể cả khi xe đã có sao cấp 3) và ở mép sân', () => {
  const { g, p, t } = arena();
  p.level = 3; g.refreshPlayerTankStats(p);
  for (let c = 0; c < COLS; c++) g.grid[8][c] = STEEL;
  const [b] = shoot(g, t);
  assert.ok(g.grid[8].every((v) => v === STEEL), 'thép còn nguyên');
  assert.ok(b.y2 >= 9 * TILE);
  const r2 = arena({ x: 192, y: 200, dir: RIGHT });
  const [b2] = shoot(r2.g, r2.t);
  assert.ok(b2.x2 <= 26 * TILE && b2.x2 >= 26 * TILE - 8, 'dừng ở mép phải');
});

test('Laser đi qua nước / rừng / băng', () => {
  const { g, t } = arena();
  g.grid[16][12] = WATER; g.grid[16][13] = WATER;
  g.grid[12][12] = FOREST; g.grid[12][13] = FOREST;
  g.grid[8][12] = ICE; g.grid[8][13] = ICE;
  const e = enemy(g, 192, 16);
  shoot(g, t);
  assert.ok(e.dead);
});

test('Laser không giết đại bàng của mình: dừng trước ô BASE', () => {
  const { g, t } = arena({ x: 192, y: 300, dir: DOWN });
  g.grid[24][12] = BASE; g.grid[24][13] = BASE; g.grid[25][12] = BASE; g.grid[25][13] = BASE;
  const [b] = shoot(g, t);
  assert.ok(g.baseAlive, 'đại bàng còn sống');
  assert.notEqual(g.status, 'gameover');
  assert.ok(b.y2 <= 24 * TILE);
});

test('Laser đi qua đồng đội mà không làm choáng (friendlyFire bật), vẫn hạ địch phía sau', () => {
  const { g, t } = arena();
  const q = g.addPlayer('B');
  g.spawnPlayer(q, false);
  const mate = g.tanks.find((k) => k.kind === 'player' && k.slot === q.slot);
  mate.x = 192; mate.y = 200;
  assert.equal(g.friendlyFire, true);
  const e = enemy(g, 192, 40);
  shoot(g, t);
  assert.equal(mate.stunUntil, 0, 'đồng đội không bị choáng');
  assert.ok(!mate.dead);
  assert.ok(e.dead, 'tia xuyên đồng đội tới địch');
});

test('Mode Chuẩn: trang bị Laser vẫn bắn đạn thường', () => {
  const { g, t } = arena({ mode: 'standard' });
  const beams = shoot(g, t);
  assert.equal(beams.length, 0);
  assert.equal(g.bullets.length, 1, 'đạn thường');
});

test('Không trang bị Laser (hoặc SKU khác) ở casual: đạn thường', () => {
  for (const w of [null, 'tank.bullet.plasma']) {
    const { g, t } = arena({ weapon: w });
    assert.equal(shoot(g, t).length, 0);
    assert.equal(g.bullets.length, 1);
  }
});

test('Room: opts.mode casual + cos Laser ⇒ broadcast beam; đổi về đạn thường giữa trận; casual không nộp BXH', () => {
  const r = createRoom({ mode: 'casual' });
  assert.equal(r.room.state.mode, 'casual');
  const a = { id: 'p1', name: 'A', cos: { bullet: LASER } };
  r.mod.onJoin(r.room, a);
  r.msg(a, 'start');
  r.tick(40);
  const g = r.game;
  const t = g.tanks.find((k) => k.kind === 'player');
  t.dir = UP; t.spawnUntil = 0;
  r.msg(a, 'input', { fire: true });
  r.tick(1);
  assert.ok(r.out.some((o) => o[0] === 'bc' && o[1] === 'beam' && o[2][0].ownerSlot === 0), 'có event beam');
  // host đổi về đạn thường (quickEquip null)
  a.trusted = true;
  r.msg(a, 'cos', { cos: {} });
  r.msg(a, 'input', { fire: false }); r.tick(31);
  r.out.length = 0;
  r.msg(a, 'input', { fire: true }); r.tick(1);
  assert.ok(!r.out.some((o) => o[1] === 'beam'), 'về đạn thường thì không còn tia');
  g.players.get(0).score = 500;
  r.mod.onDispose(r.room);
  assert.ok(!r.out.some((o) => o[0] === 'score'), 'phòng Thường không nộp điểm');
});

test('Room: mặc định là Chuẩn — cos Laser không tạo tia, vẫn nộp BXH', () => {
  const r = createRoom();
  assert.equal(r.room.state.mode, 'standard');
  const a = { id: 'p1', name: 'A', cos: { bullet: LASER } };
  r.mod.onJoin(r.room, a);
  r.msg(a, 'start'); r.tick(40);
  r.msg(a, 'input', { fire: true }); r.tick(5);
  assert.ok(!r.out.some((o) => o[1] === 'beam'));
  r.game.players.get(0).score = 500;
  r.mod.onDispose(r.room);
  assert.ok(r.out.some((o) => o[0] === 'score'));
});
