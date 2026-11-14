/* Progression v2: giá nâng cấp, trần ngày/tuần, ledger idempotent, room mode standard bỏ qua levels.
   D1 giả = node:sqlite (in-memory) + migrations thật. Chạy: npm test */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createRoom } = require('./host');

/** D1 tối thiểu: prepare().bind().first/all/run + batch() là MỘT transaction (lỗi -> rollback). */
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'migrations')).sort()) db.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', f), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) || null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
    _exec: () => db.prepare(sql).run(...args),
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    async batch(list) {
      db.exec('BEGIN');
      try { for (const s of list) s._exec(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return [];
    },
  };
}
const load = () => import('../cf/progression.mjs');
const env = (on = true) => ({ DB: fakeD1(), PROGRESSION_ON: on ? 'true' : 'false', PAYMENTS_LIVE: 'false' });
const NOW = Date.UTC(2026, 10, 14, 5);   // 14/11/2026 12:00 giờ VN

test('PROGRESSION_ON=false: mọi API 404 progression_off', async () => {
  const P = await load(); const e = env(false);
  for (const r of [await P.progress(e, 'g1'), await P.upgrade(e, 'g1', 'move'), await P.convertGems(e, 'g1', 1), await P.sandboxGrant(e, 'g1', 1)]) {
    assert.equal(r.status, 404); assert.equal(r.body.error, 'progression_off');
  }
  assert.equal(await P.awardRun(e, { runId: 'r', stage: 1, win: true, kills: {} }, 'g1'), null);
});

test('giá thưởng lượt: hạ địch, thắng lần đầu/chơi lại, thua', async () => {
  const { runGold, REWARDS: R } = await load();
  assert.equal(runGold({ stage: 3, win: true, kills: 5, firstClear: true }), 5 * R.killGold + 100 + 20 * 3);
  assert.equal(runGold({ stage: 3, win: true, kills: 0, firstClear: false }), 40 + 8 * 3);
  assert.equal(runGold({ stage: 3, win: false, kills: 4 }), 8 + 10);
});

test('awardRun: idempotent, thắng đầu ngày +200, mở màn, trần 1.000/ngày', async () => {
  const P = await load(); const e = env();
  const a = await P.awardRun(e, { runId: 'R1', stage: 1, win: true, kills: 3 }, 'g1', NOW);
  assert.equal(a.gold, 6 + 120 + 200); assert.ok(a.firstClear);
  assert.deepEqual(await P.awardRun(e, { runId: 'R1', stage: 1, win: true, kills: 3 }, 'g1', NOW), { duplicate: true, gold: 0 });
  let pr = (await P.progress(e, 'g1', NOW)).body;
  assert.equal(pr.wallet.gold, 326); assert.equal(pr.maxCleared, 1); assert.equal(pr.unlocked, 2);
  assert.equal(pr.today.gold, 126); assert.ok(pr.today.firstWin);
  assert.equal(pr.stages.length, 24); assert.equal(typeof pr.stages[0].rec, 'number');
  // chơi lại thắng: không +200 nữa
  assert.equal((await P.awardRun(e, { runId: 'R2', stage: 1, win: true, kills: 0 }, 'g1', NOW)).gold, 48);
  // dồn tới trần
  for (let i = 0; i < 30; i++) await P.awardRun(e, { runId: 'X' + i, stage: 1, win: false, kills: 50 }, 'g1', NOW);
  pr = (await P.progress(e, 'g1', NOW)).body;
  assert.equal(pr.today.gold, 1000);
  assert.equal(pr.wallet.gold, 1000 + 200);
  // ngày mới: trần reset
  const tmr = NOW + 86_400_000;
  assert.equal((await P.awardRun(e, { runId: 'D2', stage: 1, win: false, kills: 0 }, 'g1', tmr)).gold, 10);
});

test('upgrade: trừ đúng UPGRADE_COST, thiếu gold không đổi gì, tối đa cấp 10', async () => {
  const P = await load(); const e = env();
  const C = P.ENGINE.UPGRADE_COST;
  assert.equal((await P.upgrade(e, 'g1', 'move', NOW)).body.error, 'NOT_ENOUGH_GOLD');
  assert.equal((await P.upgrade(e, 'g1', 'nope', NOW)).status, 400);
  e.DB.raw.prepare('INSERT INTO wallets (player_id, gold, gems, updated_at) VALUES (?, ?, 0, 0)').run('g1', 20000);
  const r = await P.upgrade(e, 'g1', 'move', NOW);
  assert.equal(r.status, 200); assert.equal(r.body.levels.move, 2); assert.equal(r.body.wallet.gold, 20000 - C[2]);
  for (let i = 3; i <= 10; i++) assert.equal((await P.upgrade(e, 'g1', 'move', NOW)).status, 200);
  assert.equal((await P.upgrade(e, 'g1', 'move', NOW)).body.error, 'MAX_LEVEL');
  const spent = C.slice(2).reduce((a, b) => a + b, 0);
  assert.equal((await P.progress(e, 'g1', NOW)).body.wallet.gold, 20000 - spent);
  const n = e.DB.raw.prepare("SELECT COUNT(*) AS n, SUM(delta) AS s FROM currency_ledger WHERE reason = 'upgrade'").get();
  assert.equal(n.n, 9); assert.equal(n.s, -spent);
});

test('batch rollback: ledger trùng ref -> không trừ tiền', async () => {
  const P = await load(); const e = env();
  e.DB.raw.prepare('INSERT INTO wallets (player_id, gold, gems, updated_at) VALUES (?, 1000, 0, 0)').run('g1');
  e.DB.raw.prepare("INSERT INTO currency_ledger (player_id, currency, delta, reason, ref, created_at) VALUES ('g1','gold',-100,'upgrade','g1:rof:2',0)").run();
  assert.equal((await P.upgrade(e, 'g1', 'rof', NOW)).body.error, 'ALREADY_UPGRADED');
  assert.equal((await P.progress(e, 'g1', NOW)).body.wallet.gold, 1000);
});

test('gems: sandbox-grant, đổi 1💎=100 gold, trần 15.000/tuần ISO, chặn khi PAYMENTS_LIVE', async () => {
  const P = await load(); const e = env();
  assert.equal((await P.sandboxGrant(e, 'g1', 1001, NOW)).status, 400);
  assert.equal((await P.sandboxGrant(e, 'g1', 500, NOW)).body.wallet.gems, 500);
  assert.equal((await P.convertGems(e, 'g1', 0, NOW)).status, 400);
  const r = await P.convertGems(e, 'g1', 100, NOW);
  assert.equal(r.body.wallet.gold, 10000); assert.equal(r.body.wallet.gems, 400);
  const cap = await P.convertGems(e, 'g1', 51, NOW);
  assert.equal(cap.body.error, 'WEEKLY_CAP'); assert.equal(cap.body.maxGems, 50);
  assert.equal((await P.convertGems(e, 'g1', 50, NOW)).body.week.converted, 15000);
  assert.equal((await P.convertGems(e, 'g1', 1, NOW + 7 * 86_400_000)).status, 200, 'tuần sau mở lại');
  assert.equal((await P.convertGems(e, 'g2', 1, NOW)).body.error, 'NOT_ENOUGH_GEMS');
  assert.equal((await P.sandboxGrant(Object.assign({}, e, { PAYMENTS_LIVE: 'true' }), 'g1', 5, NOW)).status, 404);
  assert.equal(P.isoWeek(Date.UTC(2026, 0, 1, 5)), '2026-W01');
  assert.equal(P.isoWeek(Date.UTC(2027, 0, 1, 5)), '2026-W53');
});

test('room: mode standard bỏ qua levels; campaign áp levels; runResult có kills theo slot', () => {
  const r = createRoom();
  const a = { id: 'pa', name: 'A', isHost: true, levels: { move: 10, rof: 10, bspeed: 10, power: 10, armor: 10 } };
  r.mod.onJoin(r.room, a);
  assert.equal(r.room.state.mode, 'standard');
  assert.equal(r.game.players.get(0).levels, undefined, 'standard: không có levels');
  r.msg(a, 'option', { mode: 'campaign', campaignN: 3 });
  assert.equal(r.room.state.mode, 'campaign'); assert.equal(r.room.state.campaignN, 3);
  assert.equal(r.game.players.get(0).levels.move, 10);
  r.msg(a, 'levels', { levels: { move: 1 } });           // không trusted -> bỏ qua
  assert.equal(r.game.players.get(0).levels.move, 10);
  const evs = []; r.room.runResult = (ev) => evs.push(ev);
  r.msg(a, 'start'); r.tick(2);
  const g = r.game, me = g.tanks.find((t) => t.kind === 'player');
  const en = g.tanks.find((t) => t.kind === 'enemy') || (r.tick(120), g.tanks.find((t) => t.kind === 'enemy'));
  en.hp = 1; en.hpUnit = 0; g.damageEnemy(en, { ownerId: me.id });
  g.enemyQueue.length = 0; for (const t of g.tanks) if (t.kind === 'enemy') t.dead = true;
  r.tick(1);
  assert.equal(g.status, 'campaignclear');
  assert.equal(evs.length, 1);
  assert.equal(evs[0].win, true); assert.equal(evs[0].stage, 3); assert.equal(evs[0].kills[0], 1); assert.equal(evs[0].slots[0], 'pa');
  r.tick(5); assert.equal(evs.length, 1, 'chỉ phát 1 lần');
  r.msg(a, 'option', { mode: 'standard' });
  assert.equal(r.game.players.get(0).levels, undefined);
});

test('room: onDispose chỉ nộp BXH ở mode standard', () => {
  const r = createRoom(); const a = r.join('A');
  r.game.players.get(0).score = 500; r.mod.onDispose(r.room);
  assert.ok(r.out.some((o) => o[0] === 'score'));
  const r2 = createRoom({ mode: 'campaign' }); r2.join('A');
  r2.game.players.get(0).score = 500; r2.mod.onDispose(r2.room);
  assert.ok(!r2.out.some((o) => o[0] === 'score'));
});
