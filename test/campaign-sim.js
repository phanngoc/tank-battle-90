#!/usr/bin/env node
/* Bot sim Chiến dịch: tỉ lệ thắng 1 màn theo (màn × cấp đều 5 chỉ số × số người).
   node test/campaign-sim.js [--trials 20] [--stages 1,6,12,18,24] [--levels 1,rec,10] [--players 1,2,4] [--json out.json]
   Bot: ưu tiên địch gần đại bàng nhất, căn thẳng hàng rồi bắn; kẹt thì đổi hướng ngẫu nhiên; luôn bắn để phá gạch. */
'use strict';
const path = require('path');
const E = require(path.join(__dirname, '..', 'game.js'));

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const BX = 13 * 16, BY = 25 * 16;

function botControl(g, p, mem) {
  botDecide(g, p, mem);
  // engine chỉ xoay xe khi đang bấm hướng: muốn ngắm mà đứng yên thì vẫn phải bấm 1 tick
  const t = p.tankId != null ? g.tanks.find(k => k.id === p.tankId) : null;
  if (t && !p.ctrl.moving && t.dir !== p.ctrl.dir) p.ctrl.moving = true;
}
function botDecide(g, p, mem) {
  const t = p.tankId != null ? g.tanks.find(k => k.id === p.tankId) : null;
  if (!t) return;
  const en = g.tanks.filter(k => k.kind === 'enemy' && !k.dead && k.spawnUntil <= g.tick);
  p.ctrl.fire = true;
  const cx = t.x + 16, cy = t.y + 16;
  // kẹt: vị trí không đổi khi đang chạy
  if (mem.lx === t.x && mem.ly === t.y && p.ctrl.moving) mem.stuck++; else mem.stuck = 0;
  mem.lx = t.x; mem.ly = t.y;
  if (mem.wander > 0) { mem.wander--; p.ctrl.moving = true; return; }
  if (mem.stuck > 6) { mem.wander = 12 + (Math.random() * 20 | 0); p.ctrl.dir = (Math.random() * 4) | 0; p.ctrl.moving = true; return; }
  // né / bắn chặn đạn địch đang lao tới trong làn của mình
  for (const b of g.bullets) {
    if (b.dead || b.ownerKind !== 'enemy') continue;
    const bx = b.x + 4, by = b.y + 4;
    const vert = b.dir === 0 || b.dir === 2;
    const inLane = vert ? Math.abs(bx - cx) < 22 : Math.abs(by - cy) < 22;
    const d = vert ? (b.dir === 2 ? cy - by : by - cy) : (b.dir === 1 ? cx - bx : bx - cx);
    if (!inLane || d < 0 || d > 90) continue;
    const face = (b.dir + 2) % 4;
    if (t.cooldown === 0 && safeFire(t, face)) { p.ctrl.dir = face; p.ctrl.moving = false; p.ctrl.fire = true; return; }
    p.ctrl.dir = vert ? (bx > cx ? 3 : 1) : (by > cy ? 0 : 2); p.ctrl.moving = true; return;
  }
  const near = en.filter(e => Math.hypot(e.x + 16 - BX, e.y + 16 - BY) < 170);
  const defender = p.slot === 0 && g.players.size > 1;
  let pool = near.length ? near : (defender ? en.filter(e => alignedShot(t, e)) : en);
  if (!pool.length) return goPost(p, t, mem);
  let best = null, bs = 1e9;
  for (const e of pool) {
    const s = Math.hypot(e.x + 16 - BX, e.y + 16 - BY) + 0.7 * Math.hypot(e.x + 16 - cx, e.y + 16 - cy);
    if (s < bs) { bs = s; best = e; }
  }
  const dx = best.x + 16 - cx, dy = best.y + 16 - cy;
  if (Math.abs(dx) < 10) { p.ctrl.dir = dy > 0 ? 2 : 0; p.ctrl.moving = Math.abs(dy) > 64 && !defender; return; }
  if (Math.abs(dy) < 10) { p.ctrl.dir = dx > 0 ? 1 : 3; p.ctrl.moving = Math.abs(dx) > 64 && !defender; return; }
  const pd = pathDir(g, t, best.x, best.y, mem);
  if (pd != null) p.ctrl.dir = pd;
  else if (Math.abs(dx) < Math.abs(dy)) p.ctrl.dir = dx > 0 ? 1 : 3; else p.ctrl.dir = dy > 0 ? 2 : 0;
  p.ctrl.moving = true;
}
// BFS trên lưới 16px cho xe 2×2 ô: gạch đi được (bot luôn bắn phá), thép/nước/nhà thì không.
function pathDir(g, t, tx, ty, mem) {
  if (mem.pathAt && g.tick - mem.pathAt < 8 && mem.pathDir != null) return mem.pathDir;
  const C = 25, ok = (c, r) => { if (c < 0 || r < 0 || c >= C || r >= C) return false;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const v = g.grid[r + dy][c + dx]; if (v === 2 || v === 3 || v === 6) return false; } return true; };
  const sc = Math.round(t.x / 16), sr = Math.round(t.y / 16);
  const gc = Math.max(0, Math.min(24, Math.round(tx / 16))), gr = Math.max(0, Math.min(24, Math.round(ty / 16)));
  const prev = new Int16Array(C * C).fill(-1), q = [sr * C + sc]; prev[q[0]] = q[0];
  let found = -1;
  for (let i = 0; i < q.length; i++) {
    const cur = q[i], c = cur % C, r = (cur / C) | 0;
    if (Math.abs(c - gc) <= 1 && Math.abs(r - gr) <= 1) { found = cur; break; }
    for (let d = 0; d < 4; d++) {
      const nc = c + [0, 1, 0, -1][d], nr = r + [-1, 0, 1, 0][d], k = nr * C + nc;
      if (nc < 0 || nr < 0 || nc >= C || nr >= C || prev[k] !== -1 || !ok(nc, nr)) continue;
      prev[k] = cur; q.push(k);
    }
  }
  let dir = null;
  if (found >= 0 && found !== q[0]) {
    let k = found; while (prev[k] !== q[0]) k = prev[k];
    const c = k % C, r = (k / C) | 0;
    dir = r < sr ? 0 : c > sc ? 1 : r > sr ? 2 : 3;
  }
  mem.pathAt = g.tick; mem.pathDir = dir;
  return dir;
}
function alignedShot(t, e) { return Math.abs(e.x - t.x) < 10 || Math.abs(e.y - t.y) < 10; }
// trạm gác: người giữ nhà đứng trên nóc đại bàng nhìn lên; người khác ra giữa sân
function goPost(p, t, mem) {
  const post = p.slot === 0 ? { x: 192, y: 320, face: 0 } : [null, { x: 96, y: 224, face: 0 }, { x: 288, y: 224, face: 0 }, { x: 192, y: 160, face: 0 }][p.slot];
  const dx = post.x - t.x, dy = post.y - t.y;
  if (Math.abs(dx) < 4 && Math.abs(dy) < 4) { p.ctrl.dir = post.face; p.ctrl.moving = false; return; }
  p.ctrl.dir = Math.abs(dy) >= 4 && (Math.abs(dy) > Math.abs(dx) || mem.axis) ? (dy > 0 ? 2 : 0) : (dx > 0 ? 1 : 3);
  p.ctrl.moving = true;
}

// không bắn nếu đại bàng nằm trên đường đạn (bắn trúng nhà = thua)
function safeFire(t, dir) {
  const cx = t.x + 16, cy = t.y + 16;
  if (dir === 2 && Math.abs(cx - BX) < 26 && cy < BY) return false;
  if ((dir === 1 && cx < BX || dir === 3 && cx > BX) && Math.abs(cy - BY) < 26) return false;
  return true;
}
// SIM_HANDICAP: bot phản xạ kém người thật, nên trong sim mọi địch bắn ít đi theo hệ số này
// (cả mode Chuẩn lẫn Chiến dịch => so sánh tương đối vẫn đúng). Chỉnh sao cho bot thắng
// mode Chuẩn màn 1 solo ≈ 65–75% (= "người chơi trung bình"). Không có trong game thật.
let SIM_HANDICAP = +(process.env.SIM_HANDICAP || 0.3);
function setHandicap(k) { SIM_HANDICAP = k; }
function runOne(stage, lvl, nPlayers, seed) {
  const orig = Math.random; Math.random = mulberry32(seed);
  try {
    const g = new E.Game();
    if (stage > 0) { g.mode = 'campaign'; g.campaignN = stage; }
    const levels = {}; for (const k of E.UPGRADE_STATS) levels[k] = lvl;
    for (let i = 0; i < nPlayers; i++) { const p = g.addPlayer('B' + i); p.levels = levels; }
    g.startGame();
    const mem = new Map();
    let kills = 0;
    for (let i = 0; i < 30 * 60 * 8; i++) { // trần 8 phút
      for (const p of g.players.values()) { if (!mem.has(p.slot)) mem.set(p.slot, { stuck: 0, wander: 0 }); botControl(g, p, mem.get(p.slot)); }
      for (const p of g.players.values()) { const t = p.tankId != null && g.tanks.find(k => k.id === p.tankId); if (t && !safeFire(t, p.ctrl.moving ? p.ctrl.dir : t.dir)) p.ctrl.fire = false; }
      g.update();
      for (const e of g.tanks) if (e.kind === 'enemy' && !e.simH) { e.simH = 1; e.fireProb *= SIM_HANDICAP; }
      if (g.status === 'campaignclear' || g.status === 'stageclear') return { win: true, ticks: i, lostLives: [...g.players.values()].reduce((a, p) => a + (3 - p.lives), 0) };
      if (g.status === 'gameover') return { win: false, ticks: i, base: !g.baseAlive };
    }
    return { win: false, ticks: -1 };
  } finally { Math.random = orig; }
}

function arg(name, def) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : def; }
if (require.main === module) {
  const trials = +arg('trials', 20);
  const stages = arg('stages', '1,4,8,12,16,20,24').split(',').map(Number);
  const levelsArg = arg('levels', '1,rec,10').split(',');
  const players = arg('players', '1,2,4').split(',').map(Number);
  const rows = [];
  const t0 = Date.now();
  for (const n of stages) {
    const cs = E.campaignStage(n);
    for (const la of levelsArg) {
      const lvl = la === 'rec' ? cs.rec : +la;
      for (const np of players) {
        let w = 0, base = 0;
        for (let s = 0; s < trials; s++) { const r = runOne(n, lvl, np, 1000 + s * 7919 + n * 31 + np); if (r.win) w++; else if (r.base) base++; }
        rows.push({ stage: n, rec: cs.rec, level: lvl, players: np, winPct: Math.round(100 * w / trials), basePct: Math.round(100 * base / trials) });
        console.log(`màn ${String(n).padStart(2)} rec ${String(cs.rec).padStart(2)} | cấp ${String(lvl).padStart(2)} | ${np}P | thắng ${String(Math.round(100 * w / trials)).padStart(3)}% (mất nhà ${Math.round(100 * base / trials)}%)`);
      }
    }
  }
  console.log(`(${trials} lượt/ô, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  const out = arg('json', null); if (out) require('fs').writeFileSync(out, JSON.stringify(rows, null, 2));
}
module.exports = { runOne, botControl, setHandicap };
