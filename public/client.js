'use strict';
/* TANK BATTLE 90 - thin client: render authoritative state + send input. */

// ---- tile constants (mirror server) ----
const EMPTY = 0, BRICK = 1, STEEL = 2, WATER = 3, FOREST = 4, ICE = 5, BASE = 6;
const DIR = [[0, -1], [1, 0], [0, 1], [-1, 0]];

let TILE = 16, COLS = 26, ROWS = 26, FIELD_W = 416, FIELD_H = 416;

const cv = document.getElementById('game');
const ctx = cv.getContext('2d');
ctx.imageSmoothingEnabled = false;

// offscreen layers
const terrain = document.createElement('canvas');
const forest = document.createElement('canvas');
let tctx, fctx;

let grid = null;          // 2D int array
let waterTiles = [];      // {c,r}
let latest = null;        // last state snapshot
let me = null;            // my slot
let joined = false;
let statusText = 'lobby';

let myRoom = null;        // room code once joined

// ---- DOM ----
const netEl = document.getElementById('net');
const overlay = document.getElementById('overlay');
const ovMenu = document.getElementById('ovMenu');
const ovWait = document.getElementById('ovWait');
const ovOver = document.getElementById('ovOver');
const ovSub = document.getElementById('ovSub');
const ovErr = document.getElementById('ovErr');
const overSub = document.getElementById('overSub');
const lobbyStat = document.getElementById('lobbyStat');
const nameInput = document.getElementById('nameInput');
const codeInput = document.getElementById('codeInput');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const invCode = document.getElementById('invCode');
const invLink = document.getElementById('invLink');
const waitCount = document.getElementById('waitCount');
const copyBtn = document.getElementById('copyBtn');
const beginBtn = document.getElementById('beginBtn');
const restartBtn2 = document.getElementById('restartBtn2');
const roomChip = document.getElementById('roomChip');
const hudStage = document.getElementById('hudStage');
const hudEnemies = document.getElementById('hudEnemies');
const hudPlayers = document.getElementById('hudPlayers');
const muteEl = document.getElementById('mute');

const roomParam = new URLSearchParams(location.search).get('room');
function inviteLink(code) { return `${location.origin}${location.pathname}?room=${code}`; }

// =====================================================================
// Networking
// =====================================================================
let ws = null;
function connect() {
  // wss:// when served over HTTPS (e.g. via Cloudflare Tunnel) to avoid mixed-content blocking
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(`${proto}${location.host}`);
  ws.onopen = () => { netEl.textContent = '• online'; netEl.classList.add('on'); };
  ws.onclose = () => { netEl.textContent = '• reconnecting…'; netEl.classList.remove('on'); setTimeout(connect, 1000); };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  };
}

let overlayMode = 'menu';

function handle(m) {
  switch (m.t) {
    case 'hello':
      TILE = m.tile; COLS = m.cols; ROWS = m.rows; FIELD_W = COLS * TILE; FIELD_H = ROWS * TILE;
      setupCanvases();
      break;
    case 'lobby':
      updateLobbyStat(m);
      break;
    case 'map':
      setGrid(m.map); statusText = m.status; break;
    case 'init':
      me = m.you; joined = true; myRoom = m.room;
      setGrid(m.map); statusText = m.status;
      onJoined(m.room);
      break;
    case 'nojoin':
      showErr(m.reason === 'full' ? `Phòng ${m.room} đã đủ 4 người.` : `Không tìm thấy phòng ${m.room}.`);
      break;
    case 'state':
      latest = m; statusText = m.status;
      for (const d of m.mapDelta) applyDelta(d.x, d.y, d.t);
      if (m.events && m.events.length) for (const e of m.events) playSfx(e);
      updateHud(m);
      updateOverlay();
      break;
  }
}

function send(o) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); }

function getName() { return (nameInput.value || '').trim(); }
function showErr(msg) { ovErr.textContent = msg || ''; }

function createRoom() { ensureAudio(); showErr(''); send({ t: 'create', name: getName() }); }
function joinRoom(code) {
  ensureAudio(); showErr('');
  const c = (code || '').toUpperCase().trim();
  if (c.length < 4) { showErr('Nhập mã phòng 4 ký tự.'); return; }
  send({ t: 'join', room: c, name: getName() });
}

function updateLobbyStat(m) {
  let s = `🟢 ${m.rooms} phòng đang hoạt động · ${m.players} người chơi`;
  if (m.waiting > 0) s += ` · ${m.waiting} phòng đang chờ`;
  lobbyStat.textContent = s;
}

function onJoined(room) {
  history.replaceState(null, '', inviteLink(room));
  roomChip.textContent = `Phòng ${room} · 📋`;
  roomChip.classList.remove('hidden');
  if (statusText === 'waiting') showOverlay('waiting');
  else { overlayMode = null; overlay.classList.add('hidden'); }
}

function copyInvite() {
  if (!myRoom) return;
  const link = inviteLink(myRoom);
  const done = () => toast('Đã copy link mời!');
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(link).then(done).catch(() => fallbackCopy(link, done));
  else fallbackCopy(link, done);
}
function fallbackCopy(text, cb) {
  const t = document.createElement('textarea'); t.value = text;
  t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t);
  t.select(); try { document.execCommand('copy'); } catch {} t.remove(); if (cb) cb();
}
let toastTimer = null;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

// wire menu / invite / restart controls
createBtn.addEventListener('click', createRoom);
joinBtn.addEventListener('click', () => joinRoom(codeInput.value));
codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(codeInput.value); });
nameInput.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (codeInput.value.trim() || roomParam) joinRoom(codeInput.value || roomParam); else createRoom();
});
copyBtn.addEventListener('click', copyInvite);
beginBtn.addEventListener('click', () => send({ t: 'begin' }));
restartBtn2.addEventListener('click', () => send({ t: 'restart' }));
roomChip.addEventListener('click', copyInvite);
document.getElementById('startBtn').addEventListener('click', () => {
  ensureAudio();
  if (!joined) { if (codeInput.value.trim() || roomParam) joinRoom(codeInput.value || roomParam); else createRoom(); }
  else if (statusText === 'waiting') send({ t: 'begin' });
  else if (statusText === 'gameover') send({ t: 'restart' });
  else copyInvite();
});

// if arriving via an invite link, prefill the code and nudge the user to join
if (roomParam) {
  codeInput.value = roomParam.toUpperCase().slice(0, 4);
  ovSub.textContent = `Bạn được mời vào phòng ${codeInput.value} — nhập tên rồi bấm VÀO`;
}

// =====================================================================
// Map / terrain baking
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
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++)
      bakeTile(c, r, grid[r][c]);
}

function applyDelta(c, r, t) {
  if (!grid) return;
  grid[r][c] = t;
  // remove any existing water record for this cell
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
    // EMPTY, BASE: nothing baked (base drawn dynamically)
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
  g.fillStyle = '#6b7280';
  g.fillRect(x + TILE / 2 - 1, y + 1, 2, TILE - 2);
  g.fillRect(x + 1, y + TILE / 2 - 1, TILE - 2, 2);
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
  for (let i = 0; i < 6; i++) {
    const bx = x + (i * 5 % TILE), by = y + ((i * 7) % TILE);
    g.fillRect(bx, by, 4, 4);
  }
  g.fillStyle = '#146b26';
  g.fillRect(x + 3, y + 8, 3, 3); g.fillRect(x + 10, y + 3, 3, 3);
}

// =====================================================================
// Rendering loop
// =====================================================================
function render() {
  requestAnimationFrame(render);
  if (!grid) return;
  const tick = latest ? latest.tick : 0;

  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, FIELD_W, FIELD_H);
  ctx.drawImage(terrain, 0, 0);
  drawWater(tick);
  drawBase(latest);

  if (latest) {
    for (const p of latest.powerups) drawPowerup(p, tick);
    for (const t of latest.tanks) drawTank(t, tick, latest.frozen);
    for (const b of latest.bullets) drawBullet(b);
    for (const e of latest.effects) drawEffect(e);
  }

  ctx.drawImage(forest, 0, 0); // bushes conceal tanks underneath

  if (latest && latest.frozen) { ctx.fillStyle = 'rgba(120,190,255,.10)'; ctx.fillRect(0, 0, FIELD_W, FIELD_H); }
  if (statusText === 'stageclear') drawBanner('STAGE ' + (latest ? latest.stage : ''), 'CLEAR!');
}

function drawWater(tick) {
  const phase = Math.floor(tick / 8) % 2;
  for (const w of waterTiles) {
    const x = w.c * TILE, y = w.r * TILE;
    ctx.fillStyle = '#1c4fa0'; ctx.fillRect(x, y, TILE, TILE);
    ctx.fillStyle = '#3a76d6';
    const o = phase ? 0 : 4;
    ctx.fillRect(x + o, y + 3, 6, 2);
    ctx.fillRect(x + ((o + 8) % TILE), y + 9, 6, 2);
  }
}

function drawBase(state) {
  // eagle sits on tiles cols12-13 rows24-25 (px 192..224 , 384..416) for 26x26
  const bx = 12 * TILE, by = (ROWS - 2) * TILE, s = TILE * 2;
  const alive = !state || !state.base ? true : state.base.alive;
  // pedestal
  ctx.fillStyle = alive ? '#2a2f45' : '#241b1b';
  ctx.fillRect(bx, by, s, s);
  const cx = bx + s / 2, cy = by + s / 2;
  if (alive) {
    // stylised eagle emblem
    ctx.fillStyle = '#e9c94a';
    ctx.beginPath();
    ctx.moveTo(cx, by + 6);
    ctx.lineTo(cx - 11, cy + 4);
    ctx.lineTo(cx - 4, cy + 4);
    ctx.lineTo(cx - 6, by + s - 5);
    ctx.lineTo(cx + 6, by + s - 5);
    ctx.lineTo(cx + 4, cy + 4);
    ctx.lineTo(cx + 11, cy + 4);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#fff4c2'; ctx.fillRect(cx - 2, by + 5, 4, 5); // head
  } else {
    ctx.strokeStyle = '#6e2b2b'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(bx + 6, by + 6); ctx.lineTo(bx + s - 6, by + s - 6);
    ctx.moveTo(bx + s - 6, by + 6); ctx.lineTo(bx + 6, by + s - 6); ctx.stroke();
  }
}

function enemyColor(t, tick) {
  if (t.bo) { return (Math.floor(tick / 8) % 2) ? '#ff5db1' : '#ffffff'; }
  if (t.et === 'armor') return ['#c9ced8', '#ff8f3f', '#f5c542', '#6fb1ff'][Math.min(t.hp, 4) - 1] || '#c9ced8';
  if (t.et === 'fast') return '#d7e34b';
  if (t.et === 'power') return '#ff7a6c';
  return '#cdd2dc';
}

function drawTank(t, tick, frozen) {
  const x = t.x, y = t.y, s = TILE * 2;
  // spawn materialise animation
  if (t.sp) { drawSpawnStar(x + s / 2, y + s / 2, tick); return; }
  let col = t.k === 'p' ? t.c : enemyColor(t, tick);
  if (t.k === 'e' && frozen) col = shade(col, -30);
  const dark = shade(col, -60);
  const light = shade(col, 30);

  // treads
  ctx.fillStyle = dark;
  if (t.d === 0 || t.d === 2) { ctx.fillRect(x + 1, y + 2, 6, s - 4); ctx.fillRect(x + s - 7, y + 2, 6, s - 4); }
  else { ctx.fillRect(x + 2, y + 1, s - 4, 6); ctx.fillRect(x + 2, y + s - 7, s - 4, 6); }
  // tread notches
  ctx.fillStyle = shade(col, -80);
  for (let i = 0; i < 4; i++) {
    if (t.d === 0 || t.d === 2) { ctx.fillRect(x + 2, y + 4 + i * 6, 4, 2); ctx.fillRect(x + s - 6, y + 4 + i * 6, 4, 2); }
    else { ctx.fillRect(x + 4 + i * 6, y + 2, 2, 4); ctx.fillRect(x + 4 + i * 6, y + s - 6, 2, 4); }
  }
  // body
  ctx.fillStyle = col; ctx.fillRect(x + 7, y + 7, s - 14, s - 14);
  ctx.fillStyle = light; ctx.fillRect(x + 8, y + 8, s - 18, s - 18);
  // turret
  ctx.fillStyle = dark; ctx.fillRect(x + s / 2 - 5, y + s / 2 - 5, 10, 10);
  ctx.fillStyle = col; ctx.fillRect(x + s / 2 - 3, y + s / 2 - 3, 6, 6);
  // barrel
  ctx.fillStyle = shade(col, -40);
  const cx = x + s / 2, cy = y + s / 2;
  const [dx, dy] = DIR[t.d];
  ctx.fillRect(cx + dx * 4 - 2, cy + dy * 4 - 2, 4 + Math.abs(dx) * 8, 4 + Math.abs(dy) * 8);

  if (t.sh) { // shield
    const p = (Math.floor(tick / 3) % 2) ? '#8fdcff' : '#ffffff';
    ctx.strokeStyle = p; ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, s - 2, s - 2);
  }
}

function drawSpawnStar(cx, cy, tick) {
  const f = Math.floor(tick / 4) % 4;
  const sizes = [4, 8, 12, 8];
  const r = sizes[f];
  ctx.strokeStyle = (f % 2) ? '#ffffff' : '#7fe0ff'; ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = (Math.PI / 2) * i + (tick % 8) * .1;
    ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a + Math.PI / 4) * (r * .6), cy + Math.sin(a + Math.PI / 4) * (r * .6));
  }
  ctx.stroke();
}

function drawBullet(b) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(b.x, b.y, 8, 8);
  ctx.fillStyle = '#ffd23f';
  ctx.fillRect(b.x + 2, b.y + 2, 4, 4);
}

function drawPowerup(p, tick) {
  const x = p.x, y = p.y, s = TILE * 2;
  const blink = Math.floor(tick / 6) % 2;
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(x + 2, y + 2, s - 4, s - 4);
  ctx.strokeStyle = blink ? '#ffffff' : '#ffd23f'; ctx.lineWidth = 2;
  ctx.strokeRect(x + 2, y + 2, s - 4, s - 4);
  const cx = x + s / 2, cy = y + s / 2;
  ctx.save(); ctx.translate(cx, cy);
  switch (p.t) {
    case 'star': starPath(0, 0, 10, 5, '#ffd23f'); break;
    case 'clock':
      ctx.strokeStyle = '#7fe0ff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -6); ctx.moveTo(0, 0); ctx.lineTo(5, 2); ctx.stroke();
      break;
    case 'shovel':
      ctx.fillStyle = '#ff8f3f';
      ctx.fillRect(-2, -2, 4, 10);
      ctx.beginPath(); ctx.moveTo(-6, -2); ctx.lineTo(6, -2); ctx.lineTo(0, -11); ctx.closePath(); ctx.fill();
      break;
    case 'grenade':
      ctx.fillStyle = '#e94f37'; ctx.beginPath(); ctx.arc(0, 2, 8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(3, -6); ctx.lineTo(7, -10); ctx.stroke();
      break;
    case 'tank':
      ctx.fillStyle = '#57c451'; ctx.fillRect(-9, -2, 18, 7); ctx.fillRect(-4, -7, 8, 6);
      ctx.fillStyle = '#2f7a2c'; ctx.fillRect(-2, -10, 4, 5);
      break;
    case 'helmet':
      ctx.fillStyle = '#9bd6ff'; ctx.beginPath(); ctx.arc(0, 1, 9, Math.PI, Math.PI * 2); ctx.fill();
      ctx.fillRect(-9, 1, 18, 3);
      break;
  }
  ctx.restore();
}

function starPath(cx, cy, R, r, color) {
  ctx.fillStyle = color; ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = (i % 2 === 0) ? R : r;
    const a = -Math.PI / 2 + i * Math.PI / 5;
    const px = cx + Math.cos(a) * rad, py = cy + Math.sin(a) * rad;
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath(); ctx.fill();
}

function drawEffect(e) {
  const prog = e.a / e.l; // 0..1
  const big = e.k === 'bigboom';
  const maxR = big ? 30 : 18;
  const R = maxR * Math.sin(Math.min(1, prog) * Math.PI);
  ctx.globalAlpha = 1 - prog * 0.6;
  ctx.fillStyle = prog < 0.4 ? '#fff2b0' : '#ff7a1a';
  ctx.beginPath(); ctx.arc(e.x, e.y, R, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath(); ctx.arc(e.x, e.y, R * 0.5, 0, Math.PI * 2); ctx.fill();
  // sparks
  ctx.strokeStyle = '#ffce54'; ctx.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3 + prog;
    ctx.beginPath(); ctx.moveTo(e.x, e.y);
    ctx.lineTo(e.x + Math.cos(a) * R * 1.3, e.y + Math.sin(a) * R * 1.3); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawBanner(l1, l2) {
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, FIELD_H / 2 - 34, FIELD_W, 68);
  ctx.fillStyle = '#ffd23f'; ctx.textAlign = 'center';
  ctx.font = 'bold 22px system-ui'; ctx.fillText(l1, FIELD_W / 2, FIELD_H / 2 - 4);
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
    el.innerHTML = `<span class="pdot" style="background:${p.color}"></span>` +
      `${escapeHtml(p.name)} ♥${p.lives} <span class="lv">Lv${p.level}</span>`;
    hudPlayers.appendChild(el);
  }
}

function updateOverlay() {
  if (!joined) { showOverlay('menu'); return; }
  if (statusText === 'waiting') { showOverlay('waiting'); return; }
  if (statusText === 'gameover') { showOverlay('gameover'); return; }
  overlayMode = null;
  overlay.classList.add('hidden');
}

function showOverlay(mode) {
  overlayMode = mode;
  overlay.classList.remove('hidden');
  ovMenu.classList.toggle('hidden', mode !== 'menu');
  ovWait.classList.toggle('hidden', mode !== 'waiting');
  ovOver.classList.toggle('hidden', mode !== 'gameover');
  if (mode === 'waiting') {
    invCode.textContent = myRoom;
    invLink.textContent = inviteLink(myRoom);
    waitCount.textContent = latest ? latest.players.length : 1;
  }
  if (mode === 'gameover') {
    const mine = latest && latest.players.find(p => p.slot === me);
    overSub.textContent = mine ? `Điểm của bạn: ${mine.score}` : 'Căn cứ đã thất thủ';
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// =====================================================================
// Controls
// =====================================================================
const held = [false, false, false, false];
const dirStack = [];
let fireHeld = false;
let lastDir = 2;
let lastSent = '';

function press(dir) {
  if (!held[dir]) { held[dir] = true; dirStack.push(dir); }
  setActive(dir, true);
  sendCtrl();
}
function release(dir) {
  held[dir] = false;
  const i = dirStack.lastIndexOf(dir); if (i >= 0) dirStack.splice(i, 1);
  setActive(dir, false);
  sendCtrl();
}
function setActive(dir, on) {
  const btn = document.querySelector(`.dbtn[data-dir="${dir}"]`);
  if (btn) btn.classList.toggle('active', on);
}
function currentDir() {
  for (let i = dirStack.length - 1; i >= 0; i--) if (held[dirStack[i]]) { lastDir = dirStack[i]; return lastDir; }
  return lastDir;
}
function sendCtrl() {
  const moving = dirStack.some(d => held[d]);
  const dir = currentDir();
  const key = `${dir}|${moving ? 1 : 0}|${fireHeld ? 1 : 0}`;
  if (key === lastSent) return;
  lastSent = key;
  send({ t: 'ctrl', dir, moving, fire: fireHeld });
}

// D-pad (pointer)
document.querySelectorAll('.dbtn').forEach(btn => {
  const dir = Number(btn.dataset.dir);
  btn.addEventListener('pointerdown', e => { e.preventDefault(); ensureAudio(); press(dir); });
  btn.addEventListener('pointerup', e => { e.preventDefault(); release(dir); });
  btn.addEventListener('pointerleave', () => { if (held[dir]) release(dir); });
  btn.addEventListener('pointercancel', () => { if (held[dir]) release(dir); });
});

// Fire button
const fireBtn = document.getElementById('fireBtn');
fireBtn.addEventListener('pointerdown', e => { e.preventDefault(); ensureAudio(); fireHeld = true; sendCtrl(); });
fireBtn.addEventListener('pointerup', e => { e.preventDefault(); fireHeld = false; sendCtrl(); });
fireBtn.addEventListener('pointerleave', () => { if (fireHeld) { fireHeld = false; sendCtrl(); } });
fireBtn.addEventListener('pointercancel', () => { if (fireHeld) { fireHeld = false; sendCtrl(); } });

// Keyboard
const KEY = { ArrowUp: 0, KeyW: 0, ArrowRight: 1, KeyD: 1, ArrowDown: 2, KeyS: 2, ArrowLeft: 3, KeyA: 3 };
window.addEventListener('keydown', e => {
  if (e.code in KEY) { e.preventDefault(); if (!e.repeat) press(KEY[e.code]); }
  else if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); if (!fireHeld) { ensureAudio(); fireHeld = true; sendCtrl(); } }
});
window.addEventListener('keyup', e => {
  if (e.code in KEY) { e.preventDefault(); release(KEY[e.code]); }
  else if (e.code === 'Space' || e.code === 'Enter') { fireHeld = false; sendCtrl(); }
});
window.addEventListener('blur', () => { held.fill(false); dirStack.length = 0; fireHeld = false; document.querySelectorAll('.dbtn').forEach(b => b.classList.remove('active')); sendCtrl(); });

// =====================================================================
// Sound (WebAudio)
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
  o.connect(g); g.connect(audio.destination);
  o.start(); o.stop(audio.currentTime + dur);
}
function noise(dur, vol = 0.08) {
  if (!audio || muted) return;
  const n = Math.floor(audio.sampleRate * dur);
  const buf = audio.createBuffer(1, n, audio.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = audio.createBufferSource(); src.buffer = buf;
  const g = audio.createGain(); g.gain.value = vol;
  src.connect(g); g.connect(audio.destination); src.start();
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

// =====================================================================
// Boot
// =====================================================================
setupCanvases();
connect();
render();
