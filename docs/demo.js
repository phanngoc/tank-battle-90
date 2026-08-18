'use strict';
/* TANK BATTLE 90 - single-player DEMO. Runs the authoritative engine (game.js)
   entirely in the browser (no server) and renders it. For GitHub Pages.
   Wrapped in an IIFE: game.js is loaded first as a classic script and declares
   TILE/DIR/Game/... in the global lexical scope, so demo.js must keep its own
   declarations function-scoped to avoid redeclaration SyntaxErrors. */

(function () {
const { Game } = window.TankEngine;

const EMPTY = 0, BRICK = 1, STEEL = 2, WATER = 3, FOREST = 4, ICE = 5, BASE = 6;
const DIR = [[0, -1], [1, 0], [0, 1], [-1, 0]];
let TILE = 16, COLS = 26, ROWS = 26, FIELD_W = 416, FIELD_H = 416;

const cv = document.getElementById('game');
const ctx = cv.getContext('2d');
ctx.imageSmoothingEnabled = false;
const terrain = document.createElement('canvas');
const forest = document.createElement('canvas');
let tctx, fctx;

let grid = null, waterTiles = [], latest = null, me = 0, joined = false, statusText = 'lobby';
const snaps = [];          // interpolation buffer for smooth 60fps motion
const INTERP_DELAY = 100;

const netEl = document.getElementById('net');
const overlay = document.getElementById('overlay');
const ovTitle = document.getElementById('ovTitle');
const ovSub = document.getElementById('ovSub');
const ovBtn = document.getElementById('ovBtn');
const hudStage = document.getElementById('hudStage');
const hudEnemies = document.getElementById('hudEnemies');
const hudPlayers = document.getElementById('hudPlayers');
const muteEl = document.getElementById('mute');

// =====================================================================
// Local engine driver (replaces the network layer of the online client)
// =====================================================================
let game = null, curStage = 0, loop = null;

function startDemo() {
  ensureAudio();
  if (!game) {
    game = new Game();
    const p = game.addPlayer('YOU');
    me = p.slot;
    if (game.status === 'waiting') game.startGame(); // demo is single-player: start immediately
  } else {
    game.restart();
  }
  joined = true;
  setGrid(game.fullMap());
  curStage = game.stage;
  statusText = game.status;
  overlay.classList.add('hidden');
  if (!loop) loop = setInterval(step, 1000 / 30);
}

function step() {
  if (!game) return;
  game.update();
  const s = game.snapshot();
  if (s.stage !== curStage) { curStage = s.stage; setGrid(game.fullMap()); }
  else if (s.mapDelta && s.mapDelta.length) for (const d of s.mapDelta) applyDelta(d.x, d.y, d.t);
  latest = s; statusText = s.status;
  if (s.events) for (const e of s.events) playSfx(e);
  snaps.push({ t: performance.now(), s });
  while (snaps.length > 12) snaps.shift();
  updateHud(s);
  updateOverlay();
}

// interpolate tank/bullet positions between two snapshots (matched by id)
function lerpState(sa, sb, al) {
  const at = new Map(); for (const t of sa.tanks) at.set(t.id, t);
  const tanks = sb.tanks.map(t => {
    const p = at.get(t.id);
    return p ? { ...t, x: p.x + (t.x - p.x) * al, y: p.y + (t.y - p.y) * al } : t;
  });
  const ab = new Map(); for (const b of sa.bullets) ab.set(b.id, b);
  const bullets = sb.bullets.map(b => {
    const p = ab.get(b.id);
    return p ? { ...b, x: p.x + (b.x - p.x) * al, y: p.y + (b.y - p.y) * al } : b;
  });
  return { ...sb, tanks, bullets };
}
function viewAt(rt) {
  if (snaps.length === 0) return latest;
  if (snaps.length === 1 || rt >= snaps[snaps.length - 1].t) return snaps[snaps.length - 1].s;
  if (rt <= snaps[0].t) return snaps[0].s;
  for (let i = 0; i < snaps.length - 1; i++) {
    const a = snaps[i], b = snaps[i + 1];
    if (a.t <= rt && rt <= b.t) return lerpState(a.s, b.s, (rt - a.t) / ((b.t - a.t) || 1));
  }
  return snaps[snaps.length - 1].s;
}

function applyLocalCtrl() {
  if (!game) return;
  const p = game.players.get(me);
  if (!p) return;
  const moving = dirStack.some(d => held[d]);
  p.ctrl = { dir: currentDir(), moving, fire: fireHeld };
}

// =====================================================================
// Map / terrain baking (identical to online client)
// =====================================================================
function setupCanvases() {
  cv.width = FIELD_W; cv.height = FIELD_H;
  terrain.width = FIELD_W; terrain.height = FIELD_H;
  forest.width = FIELD_W; forest.height = FIELD_H;
  tctx = terrain.getContext('2d'); tctx.imageSmoothingEnabled = false;
  fctx = forest.getContext('2d'); fctx.imageSmoothingEnabled = false;
  ctx.imageSmoothingEnabled = false;
}
function setGrid(rows) {
  if (!tctx) setupCanvases();
  grid = rows.map(s => s.split('').map(Number));
  ROWS = grid.length; COLS = grid[0].length;
  waterTiles = [];
  tctx.clearRect(0, 0, FIELD_W, FIELD_H);
  fctx.clearRect(0, 0, FIELD_W, FIELD_H);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) bakeTile(c, r, grid[r][c]);
}
function applyDelta(c, r, t) {
  if (!grid) return;
  grid[r][c] = t;
  waterTiles = waterTiles.filter(w => !(w.c === c && w.r === r));
  bakeTile(c, r, t);
}
function bakeTile(c, r, t) {
  const x = c * TILE, y = r * TILE;
  tctx.clearRect(x, y, TILE, TILE);
  fctx.clearRect(x, y, TILE, TILE);
  switch (t) {
    case BRICK: drawBrick(tctx, x, y); break;
    case STEEL: drawSteel(tctx, x, y); break;
    case ICE: drawIce(tctx, x, y); break;
    case WATER: waterTiles.push({ c, r }); break;
    case FOREST: drawForest(fctx, x, y); break;
  }
}
function drawBrick(g, x, y) {
  g.fillStyle = '#7a2f16'; g.fillRect(x, y, TILE, TILE);
  g.fillStyle = '#a5502a';
  const bh = TILE / 4;
  for (let i = 0; i < 4; i++) {
    const off = (i % 2) * (TILE / 4);
    g.fillRect(x + 1, y + i * bh + 1, TILE / 2 - 2, bh - 1);
    g.fillRect(x + (TILE / 2) - off + 1, y + i * bh + 1, TILE / 2 - 2, bh - 1);
  }
}
function drawSteel(g, x, y) {
  g.fillStyle = '#8a8f9c'; g.fillRect(x, y, TILE, TILE);
  g.fillStyle = '#c3c8d4'; g.fillRect(x + 1, y + 1, TILE - 2, TILE - 2);
  g.fillStyle = '#6b7280'; g.fillRect(x + TILE / 2 - 1, y + 1, 2, TILE - 2); g.fillRect(x + 1, y + TILE / 2 - 1, TILE - 2, 2);
  g.fillStyle = '#eef1f6';
  g.fillRect(x + 2, y + 2, 2, 2); g.fillRect(x + TILE - 4, y + 2, 2, 2);
  g.fillRect(x + 2, y + TILE - 4, 2, 2); g.fillRect(x + TILE - 4, y + TILE - 4, 2, 2);
}
function drawIce(g, x, y) {
  g.fillStyle = '#bfe0ef'; g.fillRect(x, y, TILE, TILE);
  g.strokeStyle = '#e9f6ff'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(x + 2, y + 4); g.lineTo(x + 6, y + 8); g.lineTo(x + 3, y + 13); g.stroke();
  g.beginPath(); g.moveTo(x + 10, y + 2); g.lineTo(x + 13, y + 7); g.lineTo(x + 9, y + 12); g.stroke();
}
function drawForest(g, x, y) {
  g.fillStyle = '#1f7a2e'; g.fillRect(x, y, TILE, TILE);
  g.fillStyle = '#33a349';
  for (let i = 0; i < 6; i++) { const bx = x + (i * 5 % TILE), by = y + ((i * 7) % TILE); g.fillRect(bx, by, 4, 4); }
  g.fillStyle = '#146b26'; g.fillRect(x + 3, y + 8, 3, 3); g.fillRect(x + 10, y + 3, 3, 3);
}

// =====================================================================
// Render loop (identical to online client)
// =====================================================================
function render() {
  requestAnimationFrame(render);
  if (!grid) return;
  const tick = latest ? latest.tick : 0;
  const view = viewAt(performance.now() - INTERP_DELAY);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, FIELD_W, FIELD_H);
  ctx.drawImage(terrain, 0, 0);
  drawWater(tick);
  drawBase(view);
  if (view) {
    for (const p of view.powerups) drawPowerup(p, tick);
    for (const t of view.tanks) drawTank(t, tick, view.frozen);
    for (const b of view.bullets) drawBullet(b);
    for (const e of view.effects) drawEffect(e);
  }
  ctx.drawImage(forest, 0, 0);
  if (view && view.frozen) { ctx.fillStyle = 'rgba(120,190,255,.10)'; ctx.fillRect(0, 0, FIELD_W, FIELD_H); }
  if (statusText === 'stageclear') drawBanner('STAGE ' + (latest ? latest.stage : ''), 'CLEAR!');
}
function drawWater(tick) {
  const phase = Math.floor(tick / 8) % 2;
  for (const w of waterTiles) {
    const x = w.c * TILE, y = w.r * TILE;
    ctx.fillStyle = '#1c4fa0'; ctx.fillRect(x, y, TILE, TILE);
    ctx.fillStyle = '#3a76d6';
    const o = phase ? 0 : 4;
    ctx.fillRect(x + o, y + 3, 6, 2); ctx.fillRect(x + ((o + 8) % TILE), y + 9, 6, 2);
  }
}
function drawBase(state) {
  const bx = 12 * TILE, by = (ROWS - 2) * TILE, s = TILE * 2;
  const alive = !state || !state.base ? true : state.base.alive;
  ctx.fillStyle = alive ? '#2a2f45' : '#241b1b'; ctx.fillRect(bx, by, s, s);
  const cx = bx + s / 2;
  if (alive) {
    ctx.fillStyle = '#e9c94a';
    ctx.beginPath();
    ctx.moveTo(cx, by + 6); ctx.lineTo(cx - 11, cy(by, s) + 4); ctx.lineTo(cx - 4, cy(by, s) + 4);
    ctx.lineTo(cx - 6, by + s - 5); ctx.lineTo(cx + 6, by + s - 5); ctx.lineTo(cx + 4, cy(by, s) + 4);
    ctx.lineTo(cx + 11, cy(by, s) + 4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff4c2'; ctx.fillRect(cx - 2, by + 5, 4, 5);
  } else {
    ctx.strokeStyle = '#6e2b2b'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(bx + 6, by + 6); ctx.lineTo(bx + s - 6, by + s - 6);
    ctx.moveTo(bx + s - 6, by + 6); ctx.lineTo(bx + 6, by + s - 6); ctx.stroke();
  }
}
function cy(by, s) { return by + s / 2; }
function enemyColor(t, tick) {
  if (t.bo) return (Math.floor(tick / 8) % 2) ? '#ff5db1' : '#ffffff';
  if (t.et === 'armor') return ['#c9ced8', '#ff8f3f', '#f5c542', '#6fb1ff'][Math.min(t.hp, 4) - 1] || '#c9ced8';
  if (t.et === 'fast') return '#d7e34b';
  if (t.et === 'power') return '#ff7a6c';
  return '#cdd2dc';
}
function drawTank(t, tick, frozen) {
  const x = t.x, y = t.y, s = TILE * 2;
  if (t.sp) { drawSpawnStar(x + s / 2, y + s / 2, tick); return; }
  let col = t.k === 'p' ? t.c : enemyColor(t, tick);
  if (t.k === 'e' && frozen) col = shade(col, -30);
  const dark = shade(col, -60), light = shade(col, 30);
  ctx.fillStyle = dark;
  if (t.d === 0 || t.d === 2) { ctx.fillRect(x + 1, y + 2, 6, s - 4); ctx.fillRect(x + s - 7, y + 2, 6, s - 4); }
  else { ctx.fillRect(x + 2, y + 1, s - 4, 6); ctx.fillRect(x + 2, y + s - 7, s - 4, 6); }
  ctx.fillStyle = shade(col, -80);
  for (let i = 0; i < 4; i++) {
    if (t.d === 0 || t.d === 2) { ctx.fillRect(x + 2, y + 4 + i * 6, 4, 2); ctx.fillRect(x + s - 6, y + 4 + i * 6, 4, 2); }
    else { ctx.fillRect(x + 4 + i * 6, y + 2, 2, 4); ctx.fillRect(x + 4 + i * 6, y + s - 6, 2, 4); }
  }
  ctx.fillStyle = col; ctx.fillRect(x + 7, y + 7, s - 14, s - 14);
  ctx.fillStyle = light; ctx.fillRect(x + 8, y + 8, s - 18, s - 18);
  ctx.fillStyle = dark; ctx.fillRect(x + s / 2 - 5, y + s / 2 - 5, 10, 10);
  ctx.fillStyle = col; ctx.fillRect(x + s / 2 - 3, y + s / 2 - 3, 6, 6);
  ctx.fillStyle = shade(col, -40);
  const bcx = x + s / 2, bcy = y + s / 2, [dx, dy] = DIR[t.d];
  ctx.fillRect(bcx + dx * 4 - 2, bcy + dy * 4 - 2, 4 + Math.abs(dx) * 8, 4 + Math.abs(dy) * 8);
  if (t.sh) { const p = (Math.floor(tick / 3) % 2) ? '#8fdcff' : '#ffffff'; ctx.strokeStyle = p; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, s - 2, s - 2); }
}
function drawSpawnStar(cx, cy, tick) {
  const f = Math.floor(tick / 4) % 4, r = [4, 8, 12, 8][f];
  ctx.strokeStyle = (f % 2) ? '#ffffff' : '#7fe0ff'; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = (Math.PI / 2) * i + (tick % 8) * .1;
    ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a + Math.PI / 4) * (r * .6), cy + Math.sin(a + Math.PI / 4) * (r * .6));
  }
  ctx.stroke();
}
function drawBullet(b) { ctx.fillStyle = '#fff'; ctx.fillRect(b.x, b.y, 8, 8); ctx.fillStyle = '#ffd23f'; ctx.fillRect(b.x + 2, b.y + 2, 4, 4); }
function drawPowerup(p, tick) {
  const x = p.x, y = p.y, s = TILE * 2, blink = Math.floor(tick / 6) % 2;
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x + 2, y + 2, s - 4, s - 4);
  ctx.strokeStyle = blink ? '#ffffff' : '#ffd23f'; ctx.lineWidth = 2; ctx.strokeRect(x + 2, y + 2, s - 4, s - 4);
  const cx = x + s / 2, cyy = y + s / 2;
  ctx.save(); ctx.translate(cx, cyy);
  switch (p.t) {
    case 'star': starPath(0, 0, 10, 5, '#ffd23f'); break;
    case 'clock': ctx.strokeStyle = '#7fe0ff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -6); ctx.moveTo(0, 0); ctx.lineTo(5, 2); ctx.stroke(); break;
    case 'shovel': ctx.fillStyle = '#ff8f3f'; ctx.fillRect(-2, -2, 4, 10); ctx.beginPath(); ctx.moveTo(-6, -2); ctx.lineTo(6, -2); ctx.lineTo(0, -11); ctx.closePath(); ctx.fill(); break;
    case 'grenade': ctx.fillStyle = '#e94f37'; ctx.beginPath(); ctx.arc(0, 2, 8, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(3, -6); ctx.lineTo(7, -10); ctx.stroke(); break;
    case 'tank': ctx.fillStyle = '#57c451'; ctx.fillRect(-9, -2, 18, 7); ctx.fillRect(-4, -7, 8, 6); ctx.fillStyle = '#2f7a2c'; ctx.fillRect(-2, -10, 4, 5); break;
    case 'helmet': ctx.fillStyle = '#9bd6ff'; ctx.beginPath(); ctx.arc(0, 1, 9, Math.PI, Math.PI * 2); ctx.fill(); ctx.fillRect(-9, 1, 18, 3); break;
  }
  ctx.restore();
}
function starPath(cx, cy, R, r, color) {
  ctx.fillStyle = color; ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = (i % 2 === 0) ? R : r, a = -Math.PI / 2 + i * Math.PI / 5;
    const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath(); ctx.fill();
}
function drawEffect(e) {
  const prog = e.a / e.l, big = e.k === 'bigboom', maxR = big ? 30 : 18;
  const R = maxR * Math.sin(Math.min(1, prog) * Math.PI);
  ctx.globalAlpha = 1 - prog * 0.6;
  ctx.fillStyle = prog < 0.4 ? '#fff2b0' : '#ff7a1a';
  ctx.beginPath(); ctx.arc(e.x, e.y, R, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffd23f'; ctx.beginPath(); ctx.arc(e.x, e.y, R * 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#ffce54'; ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3 + prog; ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(e.x + Math.cos(a) * R * 1.3, e.y + Math.sin(a) * R * 1.3); ctx.stroke(); }
  ctx.globalAlpha = 1;
}
function drawBanner(l1, l2) {
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, FIELD_H / 2 - 34, FIELD_W, 68);
  ctx.fillStyle = '#ffd23f'; ctx.textAlign = 'center'; ctx.font = 'bold 22px system-ui'; ctx.fillText(l1, FIELD_W / 2, FIELD_H / 2 - 4);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 26px system-ui'; ctx.fillText(l2, FIELD_W / 2, FIELD_H / 2 + 24);
  ctx.textAlign = 'left';
}
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + amt, g = ((n >> 8) & 255) + amt, b = (n & 255) + amt;
  r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
  return `rgb(${r},${g},${b})`;
}

// =====================================================================
// HUD + overlay
// =====================================================================
function updateHud(m) {
  hudStage.textContent = m.stage;
  hudEnemies.textContent = m.enemiesLeft;
  hudPlayers.innerHTML = '';
  for (const p of m.players) {
    const el = document.createElement('div');
    el.className = 'pchip' + (p.slot === me ? ' you' : '');
    el.innerHTML = `<span class="pdot" style="background:${p.color}"></span>${escapeHtml(p.name)} ♥${p.lives} <span class="lv">Lv${p.level}</span>`;
    hudPlayers.appendChild(el);
  }
}
function updateOverlay() {
  if (statusText === 'gameover') { showOverlay('gameover'); return; }
  overlay.classList.add('hidden');
}
function showOverlay(mode) {
  overlay.classList.remove('hidden');
  if (mode === 'gameover') {
    const mine = latest && latest.players.find(p => p.slot === me);
    ovTitle.textContent = 'GAME OVER';
    ovSub.textContent = mine ? `Điểm của bạn: ${mine.score}` : 'Căn cứ đã thất thủ';
    ovBtn.textContent = 'CHƠI LẠI';
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// =====================================================================
// Controls
// =====================================================================
const held = [false, false, false, false];
const dirStack = [];
let fireHeld = false, lastDir = 2;

function press(dir) { if (!held[dir]) { held[dir] = true; dirStack.push(dir); } setActive(dir, true); applyLocalCtrl(); }
function release(dir) { held[dir] = false; const i = dirStack.lastIndexOf(dir); if (i >= 0) dirStack.splice(i, 1); setActive(dir, false); applyLocalCtrl(); }
function setActive(dir, on) { const btn = document.querySelector(`.dbtn[data-dir="${dir}"]`); if (btn) btn.classList.toggle('active', on); }
function currentDir() { for (let i = dirStack.length - 1; i >= 0; i--) if (held[dirStack[i]]) { lastDir = dirStack[i]; return lastDir; } return lastDir; }

document.querySelectorAll('.dbtn').forEach(btn => {
  const dir = Number(btn.dataset.dir);
  btn.addEventListener('pointerdown', e => { e.preventDefault(); ensureAudio(); press(dir); });
  btn.addEventListener('pointerup', e => { e.preventDefault(); release(dir); });
  btn.addEventListener('pointerleave', () => { if (held[dir]) release(dir); });
  btn.addEventListener('pointercancel', () => { if (held[dir]) release(dir); });
});
const fireBtn = document.getElementById('fireBtn');
fireBtn.addEventListener('pointerdown', e => { e.preventDefault(); ensureAudio(); fireHeld = true; applyLocalCtrl(); });
fireBtn.addEventListener('pointerup', e => { e.preventDefault(); fireHeld = false; applyLocalCtrl(); });
fireBtn.addEventListener('pointerleave', () => { if (fireHeld) { fireHeld = false; applyLocalCtrl(); } });
fireBtn.addEventListener('pointercancel', () => { if (fireHeld) { fireHeld = false; applyLocalCtrl(); } });

const KEY = { ArrowUp: 0, KeyW: 0, ArrowRight: 1, KeyD: 1, ArrowDown: 2, KeyS: 2, ArrowLeft: 3, KeyA: 3 };
window.addEventListener('keydown', e => {
  if (e.code in KEY) { e.preventDefault(); if (!e.repeat) press(KEY[e.code]); }
  else if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); if (!fireHeld) { ensureAudio(); fireHeld = true; applyLocalCtrl(); } }
});
window.addEventListener('keyup', e => {
  if (e.code in KEY) { e.preventDefault(); release(KEY[e.code]); }
  else if (e.code === 'Space' || e.code === 'Enter') { fireHeld = false; applyLocalCtrl(); }
});
window.addEventListener('blur', () => { held.fill(false); dirStack.length = 0; fireHeld = false; document.querySelectorAll('.dbtn').forEach(b => b.classList.remove('active')); applyLocalCtrl(); });

ovBtn.addEventListener('click', () => { if (statusText === 'gameover' || !joined) startDemo(); });
document.getElementById('startBtn').addEventListener('click', () => { if (statusText === 'gameover' || !joined) startDemo(); });

// =====================================================================
// Sound
// =====================================================================
let audio = null, muted = false;
function ensureAudio() { if (!audio) { try { audio = new (window.AudioContext || window.webkitAudioContext)(); } catch {} } if (audio && audio.state === 'suspended') audio.resume(); }
muteEl.addEventListener('click', () => { muted = !muted; muteEl.textContent = muted ? '🔇' : '🔊'; });
function tone(freq, dur, type = 'square', vol = 0.05) {
  if (!audio || muted) return;
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, audio.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + dur);
  o.connect(g); g.connect(audio.destination); o.start(); o.stop(audio.currentTime + dur);
}
function noise(dur, vol = 0.08) {
  if (!audio || muted) return;
  const n = Math.floor(audio.sampleRate * dur), buf = audio.createBuffer(1, n, audio.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = audio.createBufferSource(); src.buffer = buf;
  const g = audio.createGain(); g.gain.value = vol; src.connect(g); g.connect(audio.destination); src.start();
}
let lastShoot = 0;
function playSfx(e) {
  switch (e) {
    case 'shoot': { const now = performance.now(); if (now - lastShoot < 40) break; lastShoot = now; tone(680, 0.06, 'square', 0.04); } break;
    case 'hitBrick': tone(180, 0.05, 'square', 0.04); break;
    case 'hitSteel': tone(1200, 0.04, 'square', 0.03); break;
    case 'explodeTank': noise(0.22, 0.09); break;
    case 'explodeBase': noise(0.6, 0.14); tone(90, 0.5, 'sawtooth', 0.06); break;
    case 'powerup': tone(880, 0.08, 'triangle', 0.05); break;
    case 'powerupPick': tone(660, 0.06, 'triangle', 0.06); setTimeout(() => tone(990, 0.08, 'triangle', 0.06), 70); break;
    case 'levelup': tone(660, 0.06, 'square', 0.05); setTimeout(() => tone(880, 0.06, 'square', 0.05), 60); setTimeout(() => tone(1320, 0.08, 'square', 0.05), 120); break;
    case 'freeze': tone(160, 0.3, 'sine', 0.05); break;
    case 'spawn': tone(1000, 0.03, 'sine', 0.02); break;
  }
}

// boot
setupCanvases();
render();
})();
