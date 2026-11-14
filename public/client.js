'use strict';
/* TANK BATTLE 90 - thin client: render authoritative state + send input. */

// ---- tile constants (mirror server) ----
const EMPTY = 0, BRICK = 1, STEEL = 2, WATER = 3, FOREST = 4, ICE = 5, BASE = 6;
const DIR = [[0, -1], [1, 0], [0, 1], [-1, 0]];

let TILE = 16, COLS = 26, ROWS = 26, FIELD_W = 416, FIELD_H = 416;

const cv = document.getElementById('game');
let ctx = cv.getContext('2d');   // let: preview cửa hàng mượn tạm các hàm vẽ
ctx.imageSmoothingEnabled = false;

// offscreen layers
const terrain = document.createElement('canvas');
const forest = document.createElement('canvas');
let tctx, fctx;

let grid = null;          // 2D int array
let waterTiles = [];      // {c,r}
let latest = null;        // last state snapshot (for HUD/status/animation phase)
let me = null;            // my slot
let joined = false;
let statusText = 'lobby';

// interpolation buffer: render ~INTERP_DELAY ms in the past and lerp between
// snapshots so 30Hz server state renders as smooth 60fps motion + absorbs jitter
const snaps = [];
const INTERP_DELAY = 100;

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
const ffBtn = document.getElementById('ffBtn');
let friendlyFire = true;  // tuỳ chọn phòng, server là nguồn sự thật
const restartBtn2 = document.getElementById('restartBtn2');
const roomChip = document.getElementById('roomChip');
const hudStage = document.getElementById('hudStage');
const hudEnemies = document.getElementById('hudEnemies');
const hudPlayers = document.getElementById('hudPlayers');
const muteEl = document.getElementById('mute');

const roomParam = new URLSearchParams(location.search).get('room');
function inviteLink(code) { return `${location.origin}${location.pathname}?room=${code}`; }

// =====================================================================
// Networking — chạy trên Arcade SDK.
//
// Trước đây phần này tự mở WebSocket, tự reconnect, tự phân giải 6 loại
// message và tự quản mã phòng. Giờ SDK lo hết; ở đây chỉ còn hai việc:
//   1. gọi rooms.create/join
//   2. đổi state của platform về ĐÚNG hình dạng mà renderer cũ đang dùng
// Renderer, âm thanh, nội suy chuyển động: không đổi một dòng.
// =====================================================================
let arcade = null;      // client SDK
let room = null;        // phòng hiện tại
let pendingEffects = []; // effects sống một tick, tới qua event

function setNet(on, label) {
  netEl.textContent = label;
  netEl.classList.toggle('on', !!on);
}

async function connect() {
  setNet(false, '• đang kết nối…');
  try {
    arcade = await window.Arcade.init({ gameId: 'tank-battle' });
    // token kiểu cũ (không ký) không gắn được entitlement -> xin guest mới một lần
    if (arcade.access && !/^a\./.test(arcade.access)) { arcade.clear(); await arcade.auth.guest(); }
    refreshOwned();
    setNet(false, '• sẵn sàng');
  } catch (e) {
    setNet(false, '• offline');
    setTimeout(connect, 2000);
  }
}

/** Platform dùng object theo id (xoá 1 thực thể = 1 op thay vì dịch cả mảng).
 *  Renderer cũ cần mảng -> đổi lại ở đây, ngay trước khi vẽ. */
function toLegacy(s) {
  if (!s) return null;
  var tanks = [], bullets = [], players = [], k;
  for (k in s.tanks) tanks.push(s.tanks[k]);
  for (k in s.bullets) bullets.push(s.bullets[k]);
  for (k in s.players) players.push(s.players[k]);
  players.sort(function (a, b) { return a.slot - b.slot; });
  return {
    t: 'state', tick: s.tick, stage: s.stage, status: s.status, frozen: s.frozen,
    tanks: tanks, bullets: bullets, powerups: s.powerups || [],
    effects: pendingEffects, players: players,
    enemiesLeft: s.enemiesLeft, base: s.base, events: [], mapDelta: [],
  };
}

let overlayMode = 'menu';
let lastMapKey = '';

function wireRoom(r) {
  room = r;
  myRoom = r.code;
  joined = true;
  setNet(true, '• online');

  r.onStatus(function (st) {
    if (st === 'connected') setNet(true, '• online');
    else if (st === 'reconnecting') setNet(false, '• đang nối lại…');
    else setNet(false, '• đã thoát');
  });

  // Slot của mình do room module gửi riêng cho từng người.
  r.onEvent('you', function (d) { me = d.slot; });
  r.onEvent('fx', function (list) { for (var i = 0; i < list.length; i++) playSfx(list[i]); });
  r.onEvent('mapDelta', function (list) { for (var i = 0; i < list.length; i++) applyDelta(list[i].x, list[i].y, list[i].t); });
  r.onEvent('effects', function (list) { pendingEffects = list || []; });
  r.onError(function (e) {
    showErr(e.code === 'ROOM_FULL' ? 'Phòng đã đủ 4 người.'
      : e.code === 'ROOM_NOT_FOUND' ? 'Không tìm thấy phòng.' : (e.msg || e.code));
  });

  r.onState(function (s) {
    skinsBySlot = (s && s.skins) || {};
    applyCos(s);
    if (s.dims && !canvasReady) {
      canvasReady = true;
      TILE = s.dims.tile; COLS = s.dims.cols; ROWS = s.dims.rows;
      FIELD_W = COLS * TILE; FIELD_H = ROWS * TILE;
      setupCanvases();
    }
    // Bản đồ chỉ đổi khi qua màn -> so khoá thay vì dựng lại lưới mỗi frame.
    var mk = s.stage + ':' + s.status;
    if (s.map && mk !== lastMapKey) { lastMapKey = mk; setGrid(s.map); }

    statusText = s.status;
    if (typeof s.friendlyFire === 'boolean') friendlyFire = s.friendlyFire;
    var legacy = toLegacy(s);
    latest = legacy;
    pendingEffects = [];
    snaps.push({ t: performance.now(), s: legacy });
    while (snaps.length > 12) snaps.shift();
    updateHud(legacy);
    updateOverlay();
    if (!onJoinedDone) { onJoinedDone = true; onJoined(r.code); }
  });
}
let onJoinedDone = false;
let canvasReady = false;

async function createRoom() {
  ensureAudio(); showErr('');
  var fest = festivalToggle && festivalToggle.checked;
  try { wireRoom(await arcade.rooms.create('coop', fest ? { festival: true } : undefined, getName())); if (fest) refreshOwned(); }
  catch (e) { showErr('Không tạo được phòng: ' + e.message); }
}

async function joinRoom(code) {
  ensureAudio(); showErr('');
  var c = (code || '').toUpperCase().trim();
  if (c.length < 4) { showErr('Nhập mã phòng 4 ký tự.'); return; }
  try { wireRoom(await arcade.rooms.join(c, getName())); }
  catch (e) {
    showErr(e.message === 'ROOM_FULL' ? 'Phòng ' + c + ' đã đủ 4 người.'
      : 'Không tìm thấy phòng ' + c + '.');
  }
}

/** Thay cho send() cũ. Mọi input đi qua đây. */
function send(o) {
  if (!room) return;
  if (o.t === 'ctrl') room.send('input', { dir: o.dir, moving: o.moving, fire: o.fire });
  else if (o.t === 'begin' || o.t === 'restart') room.send('start');
  else if (o.t === 'option') room.send('option', o.d);
}

function getName() { return (nameInput.value || '').trim(); }
function showErr(msg) { ovErr.textContent = msg || ''; }

// (joinRoom định nghĩa ở phần Networking phía trên — bản dùng SDK)

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
ffBtn.addEventListener('click', () => send({ t: 'option', d: { friendlyFire: !friendlyFire } }));
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
  g.fillStyle = TH.brick[0]; g.fillRect(x, y, TILE, TILE);
  g.fillStyle = TH.brick[1];
  const bh = TILE / 4;
  for (let i = 0; i < 4; i++) {
    const off = (i % 2) * (TILE / 4);
    g.fillRect(x + 1, y + i * bh + 1, TILE / 2 - 2, bh - 1);
    g.fillRect(x + (TILE / 2) - off + 1, y + i * bh + 1, TILE / 2 - 2, bh - 1);
  }
}
function drawSteel(g, x, y) {
  g.fillStyle = TH.steel[0]; g.fillRect(x, y, TILE, TILE);
  g.fillStyle = TH.steel[1]; g.fillRect(x + 1, y + 1, TILE - 2, TILE - 2);
  g.fillStyle = TH.steel[2];
  g.fillRect(x + TILE / 2 - 1, y + 1, 2, TILE - 2);
  g.fillRect(x + 1, y + TILE / 2 - 1, TILE - 2, 2);
  g.fillStyle = TH.steel[3];
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
  g.fillStyle = TH.forest[0]; g.fillRect(x, y, TILE, TILE);
  g.fillStyle = TH.forest[1];
  for (let i = 0; i < 6; i++) {
    const bx = x + (i * 5 % TILE), by = y + ((i * 7) % TILE);
    g.fillRect(bx, by, 4, 4);
  }
  g.fillStyle = TH.forest[2];
  g.fillRect(x + 3, y + 8, 3, 3); g.fillRect(x + 10, y + 3, 3, 3);
}

// =====================================================================
// Rendering loop
// =====================================================================
// pick the two snapshots bracketing renderTime; sets interp fields on `frame`
const frame = { a: null, b: null, al: 0 };
function pickFrame(rt) {
  frame.a = null; frame.b = null; frame.al = 0;
  const n = snaps.length;
  if (n === 0) { frame.b = latest; return; }
  if (n === 1 || rt >= snaps[n - 1].t) { frame.b = snaps[n - 1].s; return; }
  if (rt <= snaps[0].t) { frame.b = snaps[0].s; return; }
  for (let i = 0; i < n - 1; i++) {
    if (snaps[i].t <= rt && rt <= snaps[i + 1].t) {
      frame.a = snaps[i].s; frame.b = snaps[i + 1].s;
      frame.al = (rt - snaps[i].t) / ((snaps[i + 1].t - snaps[i].t) || 1);
      return;
    }
  }
  frame.b = snaps[n - 1].s;
}
// previous-position lookup by id (linear; entity counts are tiny) — no per-frame allocation
function prevPos(list, id) { if (!list) return null; for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }

function render() {
  requestAnimationFrame(render);
  if (!grid) return;
  const tick = latest ? latest.tick : 0;
  pickFrame(performance.now() - INTERP_DELAY);
  const b = frame.b, a = frame.a, al = frame.al;

  drawGround(0, 0, FIELD_W, FIELD_H, tick);
  ctx.drawImage(terrain, 0, 0);
  drawWater(tick);
  drawBase(b);

  if (b) {
    for (const p of b.powerups) drawPowerup(p, tick);
    for (const t of b.tanks) {
      let ix = t.x, iy = t.y;
      if (a) { const p = prevPos(a.tanks, t.id); if (p) { ix = p.x + (t.x - p.x) * al; iy = p.y + (t.y - p.y) * al; } }
      drawTank(t, tick, b.frozen, ix, iy);
    }
    for (const bl of b.bullets) {
      let ix = bl.x, iy = bl.y;
      if (a) { const p = prevPos(a.bullets, bl.id); if (p) { ix = p.x + (bl.x - p.x) * al; iy = p.y + (bl.y - p.y) * al; } }
      drawBullet(bl, ix, iy);
    }
    for (const e of b.effects) drawEffect(e);
  }

  for (const f of clientFx) drawClientFx(f);
  ctx.drawImage(forest, 0, 0); // bushes conceal tanks underneath
  drawMapOverlay(0, 0, FIELD_W, FIELD_H, tick);

  if (b && b.frozen) { ctx.fillStyle = 'rgba(120,190,255,.10)'; ctx.fillRect(0, 0, FIELD_W, FIELD_H); }
  if (statusText === 'stageclear') drawBanner('STAGE ' + (latest ? latest.stage : ''), 'CLEAR!');
}

function drawWater(tick) {
  const phase = Math.floor(tick / 8) % 2;
  for (const w of waterTiles) {
    const x = w.c * TILE, y = w.r * TILE;
    ctx.fillStyle = TH.water[0]; ctx.fillRect(x, y, TILE, TILE);
    ctx.fillStyle = TH.water[1];
    const o = phase ? 0 : 4;
    ctx.fillRect(x + o, y + 3, 6, 2);
    ctx.fillRect(x + ((o + 8) % TILE), y + 9, 6, 2);
  }
}

function drawBase(state, bx0, by0, eagleSku) {
  // eagle sits on tiles cols12-13 rows24-25 (px 192..224 , 384..416) for 26x26
  const bx = bx0 !== undefined ? bx0 : 12 * TILE, by = by0 !== undefined ? by0 : (ROWS - 2) * TILE, s = TILE * 2;
  const alive = !state || !state.base ? true : state.base.alive;
  const tick = latest ? latest.tick : Math.floor(performance.now() / 33);
  const sku = eagleSku !== undefined ? eagleSku : roomCos.eagle;
  // pedestal
  ctx.fillStyle = alive ? '#2a2f45' : '#241b1b';
  ctx.fillRect(bx, by, s, s);
  const cx = bx + s / 2, cy = by + s / 2;
  if (sku && EAGLES[sku]) { EAGLES[sku](bx, by, s, alive, tick); return; }
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

function drawTank(t, tick, frozen, px, py) {
  const x = px, y = py, s = TILE * 2;
  // spawn materialise animation
  if (t.sp) { drawSpawnStar(x + s / 2, y + s / 2, tick); return; }
  const skin = t.k === 'p' ? (t.pv !== undefined ? t.pv : (cosBySlot[t.slot] && cosBySlot[t.slot].tank) || skinsBySlot[t.slot]) : null;
  let col = t.k === 'p' ? skinColor(skin, tick) || t.c : enemyColor(t, tick);
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

  if (skin) drawSkinMark(skin, x, y, s, tick);

  if (t.st) { // stunned by a teammate: blinking dim + orbiting stars
    if (Math.floor(tick / 4) % 2) { ctx.fillStyle = 'rgba(20,24,40,0.45)'; ctx.fillRect(x, y, s, s); }
    ctx.fillStyle = '#ffe14d';
    for (let i = 0; i < 3; i++) {
      const a = tick * 0.25 + i * 2.094;
      ctx.fillRect(Math.round(x + s / 2 + Math.cos(a) * 11) - 2, Math.round(y + 4 + Math.sin(a) * 3) - 2, 4, 4);
    }
  }
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

function drawBullet(b, x, y) {
  const sku = b.pv !== undefined ? b.pv : (b.s !== undefined && cosBySlot[b.s] ? cosBySlot[b.s].bullet : null);
  if (sku && BULLETS[sku]) { BULLETS[sku].draw(x, y, b.d, performance.now() / 33); return; }
  ctx.fillStyle = '#fff';
  ctx.fillRect(x, y, 8, 8);
  ctx.fillStyle = '#ffd23f';
  ctx.fillRect(x + 2, y + 2, 4, 4);
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
  // drive via inline display so exactly one card shows regardless of cached CSS
  ovMenu.style.display = mode === 'menu' ? 'flex' : 'none';
  ovWait.style.display = mode === 'waiting' ? 'flex' : 'none';
  ovOver.style.display = mode === 'gameover' ? 'flex' : 'none';
  if (mode === 'waiting') {
    invCode.textContent = myRoom;
    invLink.textContent = inviteLink(myRoom);
    waitCount.textContent = latest ? latest.players.length : 1;
    // chỉ chủ phòng (slot nhỏ nhất) đổi được; server cũng chặn
    const host = latest && latest.players.length ? latest.players[0].slot === me : true;
    ffBtn.textContent = '🎯 Bắn đồng đội: ' + (friendlyFire ? 'BẬT (choáng 2s)' : 'TẮT');
    ffBtn.classList.toggle('off', !friendlyFire);
    ffBtn.disabled = !host;
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
    case 'stun': tone(300, 0.12, 'triangle', 0.05); setTimeout(() => tone(240, 0.12, 'triangle', 0.05), 90); break;
    case 'revive': tone(523, 0.08, 'square', 0.05); setTimeout(() => tone(784, 0.08, 'square', 0.05), 80); setTimeout(() => tone(1046, 0.12, 'square', 0.05), 160); break;
  }
}

// =====================================================================
// Boot
// =====================================================================
setupCanvases();
connect();
render();


// ═══ Mỹ phẩm (docs/tank-cosmetics-shop.md): CHỈ vẽ — server/engine không đổi chỉ số nào ═══
// tank/bullet: theo slot người chơi (state.cos) · eagle/map: của phòng, theo chủ phòng (state.roomCos)
let skinsBySlot = {};
let cosBySlot = {};
let roomCos = { eagle: null, map: null };
let lastMapSku = null;
const clientFx = [];                 // hiệu ứng chỉ ở client (đạn cosmetic trúng mục tiêu)
let lastBullets = new Map();         // id -> {x,y,sku}

function applyCos(s) {
  cosBySlot = (s && s.cos) || {};
  // phòng cũ chỉ có skins -> coi như skin xe
  if (s && !s.cos && s.skins) { cosBySlot = {}; for (const k in s.skins) cosBySlot[k] = { tank: s.skins[k] }; }
  roomCos = (s && s.roomCos) || { eagle: null, map: null };
  if ((roomCos.map || null) !== lastMapSku) {
    lastMapSku = roomCos.map || null;
    TH = THEMES[lastMapSku] || THEMES.classic;
    if (grid && tctx) { tctx.clearRect(0, 0, FIELD_W, FIELD_H); fctx.clearRect(0, 0, FIELD_W, FIELD_H); waterTiles = []; for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) bakeTile(c, r, grid[r][c]); }
  }
  // đạn biến mất -> hiệu ứng trúng của kiểu đạn (client only)
  const cur = new Map();
  const bl = s && s.bullets ? Object.values(s.bullets) : [];
  for (const b of bl) { const sku = b.s !== undefined && cosBySlot[b.s] ? cosBySlot[b.s].bullet : null; cur.set(b.id, { x: b.x, y: b.y, sku }); }
  for (const [id, o] of lastBullets) if (!cur.has(id) && o.sku && BULLETS[o.sku] && BULLETS[o.sku].hit) clientFx.push({ sku: o.sku, x: o.x + 4, y: o.y + 4, a: 0 });
  lastBullets = cur;
  for (let i = clientFx.length - 1; i >= 0; i--) if (++clientFx[i].a > 14) clientFx.splice(i, 1);
}

// ---- Bản đồ: chỉ bảng màu/hoạ tiết; layout, va chạm, ô phá được giữ nguyên ----
const THEMES = {
  classic: { bg: '#000000', brick: ['#7a2f16', '#a5502a'], steel: ['#8a8f9c', '#c3c8d4', '#6b7280', '#eef1f6'], water: ['#1c4fa0', '#3a76d6'], forest: ['#1f7a2e', '#33a349', '#146b26'] },
  'tank.map.jungle': { bg: '#0f2a17', brick: ['#3e4a2a', '#6f7d4a'], steel: ['#5d6b66', '#a9b8b1', '#46524d', '#dbe7e1'], water: ['#0e5b4f', '#2fa38a'], forest: ['#0d5a1f', '#2b9c3f', '#08401a'] },
  'tank.map.desert': { bg: '#c9a46a', brick: ['#8a5a2b', '#c08848'], steel: ['#6e4a35', '#a27357', '#5a3a28', '#e0b28f'], water: ['#1f7f8f', '#4cc3cf'], forest: ['#6d7f2a', '#a3b443', '#4e5c1b'] },
  'tank.map.snow': { bg: '#d9e6f2', brick: ['#5f86b5', '#9cc3ea'], steel: ['#2f3747', '#59657d', '#1c222d', '#9aa6bd'], water: ['#2a5fa8', '#7fb2ee'], forest: ['#2d5a4a', '#e8f2f8', '#1e4537'], snow: true },
  'tank.map.neon': { bg: '#0a0618', brick: ['#3a0c3c', '#ff3fae'], steel: ['#073042', '#0b5d78', '#041c28', '#4ff0ff'], water: ['#2a0f5c', '#8a5cff'], forest: ['#0d3b2a', '#1fe08a', '#062618'], grid: '#1b1240' },
  'tank.map.tet': { bg: '#4a0d0d', brick: ['#8c1f1f', '#d9443a'], steel: ['#7a5a12', '#d4a52a', '#5a420c', '#ffe58a'], water: ['#123f7a', '#3f86d6'], forest: ['#6b3a12', '#ffd23f', '#a85a1a'] },
};
let TH = THEMES.classic;
function drawGround(x0, y0, w, h, tick) {
  ctx.fillStyle = TH.bg; ctx.fillRect(x0, y0, w, h);
  if (TH.grid) { ctx.fillStyle = TH.grid; for (let x = 0; x < w; x += TILE) ctx.fillRect(x0 + x, y0, 1, h); for (let y = 0; y < h; y += TILE) ctx.fillRect(x0, y0 + y, w, 1); }
}
function drawMapOverlay(x0, y0, w, h, tick) {
  if (!TH.snow) return;
  ctx.fillStyle = 'rgba(255,255,255,0.45)';          // tuyết rơi mờ, không che xe
  for (let i = 0; i < 40; i++) {
    const x = (i * 97 + tick * (1 + i % 3)) % w, y = (i * 53 + tick * 2) % h;
    ctx.fillRect(x0 + x, y0 + y, 2, 2);
  }
}

// ---- Xe tăng: màu nền + hoạ tiết ----
const SKIN_COLORS = { 'tank.skin.jade': '#36c79a', 'tank.skin.gold': '#f2c230', 'tank.pass.coop': '#8a7dff',
  'tank.skin.camo': '#5b6b3a', 'tank.skin.desert': '#d4b98a', 'tank.skin.carbon': '#34343c', 'tank.skin.neon': '#1c2240', 'tank.skin.dragon': '#9b1c1c' };
function skinColor(skin, tick) {
  if (!skin) return null;
  if (skin === 'tank.room.festival') return hslHex((tick * 4) % 360, 0.8, 0.6);
  return SKIN_COLORS[skin] || null;
}
function hslHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(255 * c).toString(16).padStart(2, '0'); };
  return '#' + f(0) + f(8) + f(4);
}
function drawSkinMark(skin, x, y, s, tick) {
  if (skin === 'tank.skin.gold') {
    ctx.fillStyle = '#fff6c2'; ctx.fillRect(x + s / 2 - 1, y + 9, 2, 2);
    const k = (tick % 60); if (k < 18) { ctx.fillStyle = 'rgba(255,255,230,0.8)'; ctx.fillRect(x + 7 + k, y + 7, 2, s - 14); }
  } else if (skin === 'tank.skin.jade') { ctx.fillStyle = '#c9ffe9'; ctx.fillRect(x + 9, y + s - 11, 2, 2); }
  else if (skin === 'tank.pass.coop') { ctx.fillStyle = '#ffffff'; ctx.fillRect(x + 9, y + 9, 3, 1); ctx.fillRect(x + s - 12, y + s - 10, 3, 1); }
  else if (skin === 'tank.room.festival' && Math.floor(tick / 6) % 2) { ctx.fillStyle = '#ffe14d'; ctx.fillRect(x + 3, y + 3, 2, 2); ctx.fillRect(x + s - 5, y + s - 5, 2, 2); }
  else if (skin === 'tank.skin.camo') {
    ctx.fillStyle = '#3a2a1a'; ctx.fillRect(x + 8, y + 9, 5, 3); ctx.fillRect(x + s - 13, y + s - 13, 5, 4);
    ctx.fillStyle = '#1a1f12'; ctx.fillRect(x + s - 12, y + 9, 3, 3); ctx.fillRect(x + 9, y + s - 12, 4, 2);
  } else if (skin === 'tank.skin.desert') {
    ctx.fillStyle = '#a8865a'; for (let i = 0; i < 4; i++) ctx.fillRect(x + 8 + i * 4, y + s - 10 - i * 4, 3, 2);
  } else if (skin === 'tank.skin.carbon') {
    ctx.strokeStyle = '#d63a3a'; ctx.lineWidth = 1; ctx.strokeRect(x + 7.5, y + 7.5, s - 15, s - 15);
    ctx.fillStyle = '#4a4a55'; for (let i = 0; i < 3; i++) ctx.fillRect(x + 9 + i * 5, y + 9 + i * 5, 2, 2);
    if (Math.floor(tick / 10) % 3 === 0) { ctx.fillStyle = '#ff6b6b'; ctx.fillRect(x + s / 2 - 1, y + s / 2 - 1, 2, 2); }
  } else if (skin === 'tank.skin.neon') {
    const p = (Math.sin(tick / 6) + 1) / 2;
    ctx.strokeStyle = 'rgba(79,240,255,' + (0.5 + p * 0.5) + ')'; ctx.lineWidth = 2; ctx.strokeRect(x + 7, y + 7, s - 14, s - 14);
    ctx.fillStyle = 'rgba(255,63,174,' + (0.4 + (1 - p) * 0.6) + ')'; ctx.fillRect(x + s / 2 - 2, y + s / 2 - 2, 4, 4);
  } else if (skin === 'tank.skin.dragon') {
    ctx.fillStyle = '#d9a22a'; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if ((i + j) % 2 === 0) ctx.fillRect(x + 9 + i * 5, y + 9 + j * 5, 3, 2);
    ctx.fillStyle = 'rgba(80,80,80,0.5)'; const k = tick % 20; ctx.fillRect(x + 2 + (k % 5), y + s - 2 + (k >> 2) % 3, 3, 3);
    ctx.fillStyle = '#ffb43a'; ctx.fillRect(x + s / 2 - 1, y + s / 2 - 1, 2, 2);
  }
}

// ---- Đạn: lõi giữ đúng ô 8×8; vệt đuôi alpha ≤ 0.5, vẽ phía sau ----
function trail(x, y, d, n, color, gap) {
  const [dx, dy] = DIR[d || 0];
  for (let i = 1; i <= n; i++) { ctx.globalAlpha = 0.5 * (1 - i / (n + 1)); ctx.fillStyle = color; ctx.fillRect(x + 2 - dx * i * gap, y + 2 - dy * i * gap, 4, 4); }
  ctx.globalAlpha = 1;
}
function core(x, y, outer, inner) { ctx.fillStyle = outer; ctx.fillRect(x, y, 8, 8); ctx.fillStyle = inner; ctx.fillRect(x + 2, y + 2, 4, 4); }
const BULLETS = {
  'tank.bullet.laser': { draw: (x, y, d) => { trail(x, y, d, 3, '#4ff0ff', 4); core(x, y, '#bff9ff', '#4ff0ff'); } },
  'tank.bullet.plasma': { draw: (x, y, d, t) => { trail(x, y, d, 2, '#a66bff', 4); core(x, y, '#e1c9ff', (t | 0) % 4 < 2 ? '#a66bff' : '#ffffff'); }, hit: '#a66bff' },
  'tank.bullet.fire': { draw: (x, y, d, t) => { trail(x, y, d, 4, (t | 0) % 2 ? '#ff7a1a' : '#ffd23f', 3); core(x, y, '#ffb347', '#ff4b1a'); }, hit: '#ff7a1a' },
  'tank.bullet.firework': { draw: (x, y, d, t) => { trail(x, y, d, 2, hslHex(((t | 0) * 20) % 360, 0.9, 0.6), 4); core(x, y, '#ffffff', hslHex(((t | 0) * 20) % 360, 0.9, 0.55)); }, hit: 'rainbow' },
  'tank.bullet.meteor': { draw: (x, y, d) => { trail(x, y, d, 6, '#9fd8ff', 3); core(x, y, '#ffffff', '#6fb8ff'); }, hit: '#cfeaff' },
  'tank.bullet.dragon': { draw: (x, y, d, t) => { trail(x, y, d, 5, (t | 0) % 2 ? '#7a7a7a' : '#ff5a1a', 3); core(x, y, '#ffd23f', '#d61f1f'); }, hit: '#ff3a1a' },
};
function drawClientFx(f) {
  const b = BULLETS[f.sku]; if (!b || !b.hit) return;
  const r = 3 + f.a * 1.2; ctx.globalAlpha = Math.max(0, 1 - f.a / 14);
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    ctx.fillStyle = b.hit === 'rainbow' ? hslHex(i * 60, 0.9, 0.6) : b.hit;
    ctx.fillRect(f.x + Math.cos(a) * r - 1, f.y + Math.sin(a) * r - 1, 3, 3);
  }
  ctx.globalAlpha = 1;
}

// ---- Đại bàng: cùng ô 2×2, khi bị phá có sprite đổ nát riêng ----
function eagleShape(cx, by, s, body, head) {
  const cy = by + s / 2;
  ctx.fillStyle = body; ctx.beginPath();
  ctx.moveTo(cx, by + 6); ctx.lineTo(cx - 11, cy + 4); ctx.lineTo(cx - 4, cy + 4); ctx.lineTo(cx - 6, by + s - 5);
  ctx.lineTo(cx + 6, by + s - 5); ctx.lineTo(cx + 4, cy + 4); ctx.lineTo(cx + 11, cy + 4); ctx.closePath(); ctx.fill();
  ctx.fillStyle = head; ctx.fillRect(cx - 2, by + 5, 4, 5);
}
function ruin(bx, by, s, color) { ctx.fillStyle = color; for (let i = 0; i < 6; i++) ctx.fillRect(bx + 4 + (i * 7) % (s - 8), by + s - 8 - (i % 3) * 4, 5, 3); }
const EAGLES = {
  'tank.eagle.golden': (bx, by, s, alive, t) => { if (!alive) return ruin(bx, by, s, '#7a5a12'); eagleShape(bx + s / 2, by, s, '#f2c230', '#fff6c2'); ctx.strokeStyle = '#8a5a12'; ctx.lineWidth = 1; ctx.strokeRect(bx + 3.5, by + 3.5, s - 7, s - 7); if (t % 40 < 8) { ctx.fillStyle = '#fff'; ctx.fillRect(bx + s / 2 + 5, by + 9, 2, 2); } },
  'tank.eagle.ice': (bx, by, s, alive) => { if (!alive) return ruin(bx, by, s, '#7fb2ee'); eagleShape(bx + s / 2, by, s, '#bfe8ff', '#ffffff'); ctx.fillStyle = '#7fd0ff'; ctx.fillRect(bx + 5, by + s - 6, 3, 3); ctx.fillRect(bx + s - 8, by + s - 6, 3, 3); },
  'tank.eagle.lac': (bx, by, s, alive) => {
    if (!alive) return ruin(bx, by, s, '#3d6b5a');
    const cx = bx + s / 2, cy = by + s / 2;
    ctx.strokeStyle = '#6fa58c'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, s / 2 - 3, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#9fd1b8'; for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; ctx.fillRect(cx + Math.cos(a) * 10 - 1, cy + Math.sin(a) * 10 - 1, 2, 2); }
    ctx.fillStyle = '#4f8f75'; ctx.beginPath(); ctx.moveTo(cx - 10, cy + 2); ctx.lineTo(cx + 2, cy - 4); ctx.lineTo(cx + 11, cy - 9); ctx.lineTo(cx + 5, cy + 1); ctx.lineTo(cx - 4, cy + 5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#d9f2e6'; ctx.fillRect(cx + 8, cy - 9, 2, 2);
  },
  'tank.eagle.phoenix': (bx, by, s, alive, t) => {
    if (!alive) { ruin(bx, by, s, '#555'); return; }
    const flap = Math.floor(t / 8) % 2, cx = bx + s / 2, cy = by + s / 2;
    ctx.fillStyle = '#ff5a1a'; ctx.beginPath(); ctx.moveTo(cx, by + 5); ctx.lineTo(cx - 13, cy - (flap ? 6 : -2)); ctx.lineTo(cx - 4, cy + 4); ctx.lineTo(cx - 5, by + s - 4);
    ctx.lineTo(cx + 5, by + s - 4); ctx.lineTo(cx + 4, cy + 4); ctx.lineTo(cx + 13, cy - (flap ? 6 : -2)); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#ffd23f'; ctx.fillRect(cx - 2, by + 5, 4, 5); ctx.fillRect(cx - 1, cy, 2, 8);
    ctx.fillStyle = 'rgba(255,170,40,0.7)'; for (let i = 0; i < 3; i++) ctx.fillRect(bx + 6 + i * 9, by + 4 - ((t + i * 7) % 12) / 2, 2, 2);
  },
};

// ---- Xem trước: mini-scene vẽ bằng ĐÚNG các hàm vẽ trong ván ----
function drawPreview(g, look, tick) {
  const W = g.canvas.width, H = g.canvas.height, saveCtx = ctx, saveTH = TH;
  ctx = g; g.imageSmoothingEnabled = false;
  TH = THEMES[look.map] || THEMES.classic;
  try {
    drawGround(0, 0, W, H, tick);
    for (let c = 0; c < W / TILE; c++) { if (c % 5 < 2) drawBrick(g, c * TILE, 0); else if (c % 5 === 3) drawSteel(g, c * TILE, 0); }
    const wx = W - TILE * 2; g.fillStyle = TH.water[0]; g.fillRect(wx, TILE * 2, TILE * 2, TILE); g.fillStyle = TH.water[1]; g.fillRect(wx + (tick >> 3) % 2 * 4, TILE * 2 + 3, 6, 2);
    drawBase(null, (W - TILE * 2) / 2, H - TILE * 2, look.eagle || null);
    const span = W - TILE * 4, k = (tick * 1.2) % (span * 2), tx = TILE + (k < span ? k : span * 2 - k);
    const tank = { k: 'p', slot: 0, c: '#e9c94a', d: 0, pv: look.tank || '' };
    drawTank(tank, tick, false, tx, TILE * 2.5);
    const by = TILE * 2.5 - ((tick * 3) % (TILE * 1.5)) - 4;
    drawBullet({ d: 0, pv: look.bullet || null }, tx + TILE - 4, by);
    drawForest(g, 0, H - TILE, 0); drawForest(g, TILE, H - TILE);
    drawMapOverlay(0, 0, W, H, tick);
  } finally { ctx = saveCtx; TH = saveTH; }
}

// ═══ Cửa hàng + QR (SePay). Sandbox: nút xác nhận giả lập webhook ═══════════════
let owned = [];
let festivalToggle = null;
async function api(method, path, body) {
  try { return (await arcade.req(method, path, body)).body; }
  catch (e) {
    if (e && (e.status === 401 || e.code === 'SESSION_EXPIRED')) { arcade.clear(); await arcade.auth.guest(); return (await arcade.req(method, path, body)).body; }
    throw e;
  }
}
async function refreshOwned() {
  try { owned = await api('GET', '/v1/entitlements'); } catch (e) { owned = []; }
  if (festivalToggle) festivalToggle.parentNode.style.display = owned.indexOf('tank.room.festival') >= 0 ? '' : 'none';
}
const fmtVnd = (n) => n.toLocaleString('vi-VN') + 'đ';
function el(tag, attrs, html) { const e = document.createElement(tag); Object.assign(e, attrs || {}); if (html != null) e.innerHTML = html; return e; }

let shopEl = null, pollTimer = null, pvRaf = 0;
let shopItems = [], myLook = { tank: null, bullet: null, eagle: null, map: null };
const TABS = [['tank', '🛡️ Xe'], ['bullet', '💥 Đạn'], ['eagle', '🦅 Đại bàng'], ['map', '🗺️ Map'], ['bundle', '🎁 Combo'], ['inv', '🎒 Tủ đồ']];
const RARITY = { common: 'Thường', rare: 'Hiếm', epic: 'Sử thi', legendary: 'Huyền thoại', pass: 'Pass', room: 'Phòng', bundle: 'Combo' };
const ICON = { tank: '🛡️', bullet: '💥', eagle: '🦅', map: '🗺️' };
function closeShop() {
  if (pollTimer) clearInterval(pollTimer); pollTimer = null;
  if (pvRaf) cancelAnimationFrame(pvRaf); pvRaf = 0;
  if (shopEl) shopEl.remove(); shopEl = null;
  document.body.classList.remove('sheet-open');
}
// bottom-sheet: thanh kéo + nút ✕ 44px (id shopClose) — gắn lại mỗi lần vẽ thẻ
function sheetHead(card) {
  card.appendChild(el('div', { className: 'sheet-handle' }));
  const x = el('button', { className: 'sheet-x', id: 'shopClose', type: 'button', title: 'Đóng' }, '✕');
  x.setAttribute('aria-label', 'Đóng'); x.onclick = closeShop; card.appendChild(x);
}
window.addEventListener('keydown', (e) => { if (shopEl && e.key === 'Escape') { e.stopPropagation(); closeShop(); } }, true);
async function loadShop() {
  shopItems = await api('GET', '/v1/shop');
  await refreshOwned();
  try { myLook = await api('GET', '/v1/loadout'); } catch (e) { /* giữ mặc định */ }
}
const isOwned = (sku) => owned.indexOf(sku) >= 0;
const itemOf = (sku) => shopItems.find((x) => x.sku === sku);
function seasonText(it) { const [a] = it.season || ['']; return 'Mở bán ' + a.split('-').reverse().join('/'); }

async function openShop(tab, focusSku) {
  closeShop();
  shopEl = el('div', { id: 'shop', className: 'shop-modal' });
  const card = el('div', { className: 'shop-card shop-sheet' });
  card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true');
  shopEl.appendChild(card);
  shopEl.addEventListener('click', (e) => { if (e.target === shopEl) closeShop(); });
  document.body.appendChild(shopEl);
  document.body.classList.add('sheet-open');
  sheetHead(card);
  card.insertAdjacentHTML('beforeend', '<div class="shop-title">🛒 Cửa hàng</div><div class="shop-list">Đang tải…</div>');
  try { await loadShop(); }
  catch (e) { card.querySelector('.shop-list').textContent = 'Không tải được cửa hàng.'; return; }
  renderShop(card, tab || 'tank', focusSku);
}

function renderShop(card, tab, focusSku) {
  if (pvRaf) cancelAnimationFrame(pvRaf); pvRaf = 0;
  card.innerHTML = '';
  sheetHead(card);
  card.appendChild(el('div', { className: 'shop-title' }, '🛒 Cửa hàng'));
  const tabs = el('div', { className: 'shop-tabs' });
  for (const [k, label] of TABS) {
    const b = el('button', { className: 'shop-tab' + (k === tab ? ' on' : '') }, label);
    b.dataset.tab = k; b.onclick = () => renderShop(card, k);
    tabs.appendChild(b);
  }
  card.appendChild(tabs);
  // xem trước: món đang chọn + các slot khác theo đồ đang mặc
  const pv = el('canvas', { className: 'shop-pv', id: 'shopPreview', width: 160, height: 112 });
  card.appendChild(pv);
  const info = el('div', { className: 'shop-detail' });
  card.appendChild(info);
  const grid = el('div', { className: 'shop-grid' });
  card.appendChild(grid);
  card.appendChild(el('div', { className: 'shop-note' }, 'Chỉ trang trí — không thay đổi sức mạnh xe. Đại bàng + bản đồ: cả phòng thấy theo đồ của chủ phòng.'));

  let list;
  if (tab === 'inv') list = shopItems.filter((it) => it.slot && isOwned(it.sku));
  else if (tab === 'bundle') list = shopItems.filter((it) => it.kind === 'bundle');
  else list = shopItems.filter((it) => it.slot === tab);
  if (tab === 'tank') list = list.concat(shopItems.filter((it) => it.sku === 'tank.room.festival'));
  let look = Object.assign({}, myLook);
  const g = pv.getContext('2d');
  const loop = () => { drawPreview(g, look, Math.floor(performance.now() / 33)); pvRaf = requestAnimationFrame(loop); };
  loop();

  function select(it, tile) {
    grid.querySelectorAll('.shop-tile').forEach((t) => t.classList.remove('sel'));
    if (tile) tile.classList.add('sel');
    look = Object.assign({}, myLook);
    if (it.kind === 'bundle') for (const i of it.items) { const d = itemOf(i); if (d && d.slot) look[d.slot] = i; }
    else if (it.slot) look[it.slot] = it.sku;
    else if (it.sku === 'tank.room.festival') look.tank = it.sku;
    renderDetail(it);
  }
  function renderDetail(it) {
    const have = it.limitLeft === 0 || (it.kind !== 'bundle' && it.slot && isOwned(it.sku) && it.sku !== 'tank.pass.coop');
    const equipped = it.slot && myLook[it.slot] === it.sku;
    let priceHtml = it.price ? fmtVnd(it.price) : '';
    if (it.kind === 'bundle' && it.price) priceHtml = '<s>' + fmtVnd(it.fullPrice) + '</s> <b>' + fmtVnd(it.price) + '</b>';
    info.innerHTML = '<div class="shop-name"><span class="rar rar-' + it.rarity + '">' + (RARITY[it.rarity] || '') + '</span> ' + escapeHtml(it.label) + '</div>' +
      '<div class="shop-desc">' + escapeHtml(it.desc || '') + '</div>' +
      (it.kind === 'bundle' ? '<div class="shop-desc">Gồm: ' + it.items.map((i) => { const d = itemOf(i); return (isOwned(i) ? '✓ ' : '') + (d ? escapeHtml(d.label) : i); }).join(' · ') + '</div>' : '');
    const row = el('div', { className: 'shop-actions' });
    if (it.slot && isOwned(it.sku)) {
      const eq = el('button', { className: 'ov-btn shop-equip' }, equipped ? 'Bỏ trang bị' : 'Trang bị');
      eq.dataset.sku = it.sku;
      eq.onclick = () => equip(it.slot, equipped ? null : it.sku, card, tab, it.sku);
      row.appendChild(eq);
    }
    if (!have) {
      const b = el('button', { className: 'ov-btn shop-buy' }, it.onSale === false ? seasonText(it) : 'Mua ' + priceHtml);
      b.dataset.sku = it.sku; b.disabled = it.onSale === false;
      b.onclick = () => buy(it.sku, card);
      row.appendChild(b);
    } else if (!(it.slot && isOwned(it.sku))) row.appendChild(el('span', { className: 'shop-have' }, '✓ Đã sở hữu'));
    info.appendChild(row);
  }
  if (!list.length) grid.appendChild(el('div', { className: 'shop-empty' }, tab === 'inv' ? 'Chưa có món nào — ghé các tab khác nhé.' : 'Chưa có món.'));
  if (tab === 'inv') {
    // Tủ đồ: mỗi slot một dòng "đang mặc" + nút về mặc định
    for (const slot of ['tank', 'bullet', 'eagle', 'map']) {
      const cur = myLook[slot] ? itemOf(myLook[slot]) : null;
      const r = el('div', { className: 'shop-slotrow' }, ICON[slot] + ' ' + (cur ? escapeHtml(cur.label) : 'Mặc định'));
      if (cur) { const u = el('button', { className: 'ov-btn ghost shop-unequip' }, 'Bỏ'); u.dataset.slot = slot; u.onclick = () => equip(slot, null, card, 'inv'); r.appendChild(u); }
      info.appendChild(r);
    }
  }
  let first = null;
  for (const it of list) {
    const tile = el('button', { className: 'shop-tile rar-b-' + it.rarity + (isOwned(it.sku) || it.limitLeft === 0 ? ' own' : '') + (it.slot && myLook[it.slot] === it.sku ? ' eq' : '') },
      '<span class="ti">' + (ICON[it.slot] || (it.kind === 'bundle' ? '🎁' : '🎉')) + '</span><span class="tn">' + escapeHtml(it.label) + '</span>' +
      '<span class="tp">' + (it.slot && myLook[it.slot] === it.sku ? '● đang dùng' : isOwned(it.sku) || it.limitLeft === 0 ? '✓ đã có' : it.onSale === false ? 'theo mùa' : it.price ? fmtVnd(it.price) : '') + '</span>');
    tile.dataset.sku = it.sku;
    tile.onclick = () => select(it, tile);
    grid.appendChild(tile);
    if (!first || it.sku === focusSku) first = [it, tile];
  }
  if (first && tab !== 'inv') select(first[0], first[1]);
}

async function equip(slot, sku, card, tab, focusSku) {
  try { myLook = await api('PUT', '/v1/loadout', { slot, sku, room: joined && myRoom ? myRoom : undefined }); }
  catch (e) { toast('Không trang bị được: ' + (e.code || e.message)); return; }
  toast(sku ? 'Đã trang bị ✓' : 'Đã bỏ trang bị');
  shopItems = await api('GET', '/v1/shop').catch(() => shopItems);
  renderShop(card, tab, focusSku);
}

function copyText(text) {
  const done = () => toast('Đã sao chép');
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}
// Deeplink VietQR chỉ khi biết BIN ngân hàng và có STK số thật; không thì ẩn nút, hiện gợi ý lưu ảnh QR.
const BANK_BIN = { mbbank: ['970422', 'mb'], mb: ['970422', 'mb'], vietcombank: ['970436', 'vcb'], vcb: ['970436', 'vcb'], vietinbank: ['970415', 'icb'], icb: ['970415', 'icb'],
  bidv: ['970418', 'bidv'], techcombank: ['970407', 'tcb'], tcb: ['970407', 'tcb'], acb: ['970416', 'acb'], tpbank: ['970423', 'tpb'], vpbank: ['970432', 'vpb'] };
function bankDeeplink(q, amount, code) {
  const b = BANK_BIN[String(q.bank || '').toLowerCase().replace(/[^a-z]/g, '')];
  if (!b || !/^\d{6,}$/.test(String(q.account || ''))) return '';
  return 'https://dl.vietqr.io/pay?app=' + b[1] + '&ba=' + encodeURIComponent(q.account + '@' + b[0]) + '&am=' + encodeURIComponent(amount) + '&tn=' + encodeURIComponent(code);
}
async function buy(sku, card) {
  let o;
  try { o = await api('POST', '/v1/orders', { sku }); }
  catch (e) { toast(e.code === 'LIMIT_REACHED' ? 'Bạn đã có món này.' : e.code === 'OUT_OF_SEASON' ? 'Món theo mùa, chưa mở bán.' : 'Không tạo được đơn: ' + (e.code || e.message)); return; }
  if (pvRaf) cancelAnimationFrame(pvRaf); pvRaf = 0;
  const it = itemOf(sku) || { label: sku };
  const q = o.qr || {};
  const dl = bankDeeplink(q, o.amount, o.code);
  const row = (k, label, val, cls) => '<div class="pay-row"><span class="pay-k">' + label + '</span><span class="pay-v' + (cls ? ' ' + cls : '') + '">' + escapeHtml(val) + '</span>' +
    '<button type="button" class="pay-copy" data-copy="' + k + '" aria-label="Sao chép ' + label + '">Sao chép</button></div>';
  const copyVals = { bank: q.bank || '', acc: q.account || '', name: q.accountName || '', amount: String(o.amount), code: o.code };
  card.innerHTML = '';
  sheetHead(card);
  card.insertAdjacentHTML('beforeend', (o.sandbox ? '<div class="shop-sandbox">SANDBOX — chưa nhận tiền thật</div>' : '') +
    '<div class="shop-title">Quét mã để thanh toán</div><div class="shop-desc">' + escapeHtml(it.label) + '</div>' +
    '<div class="pay-amount">' + fmtVnd(o.amount) + '</div>' +
    '<div class="pay-code-big">Mã đơn <b class="shop-code">' + escapeHtml(o.code) + '</b></div>' +
    '<img class="shop-qr" alt="Mã QR chuyển khoản" src="' + escapeHtml(q.imageUrl || '') + '">' +
    '<div class="pay-rows">' + row('bank', 'Ngân hàng', copyVals.bank) + row('acc', 'Số TK', copyVals.acc, 'mono') +
      (copyVals.name ? row('name', 'Chủ TK', copyVals.name) : '') + row('amount', 'Số tiền', fmtVnd(o.amount)) + row('code', 'Nội dung CK', o.code, 'mono') + '</div>' +
    (dl ? '<a class="ov-btn pay-open" id="payOpenApp" href="' + escapeHtml(dl) + '" target="_blank" rel="noopener">🏦 Mở app ngân hàng</a>'
        : '<div class="pay-hint">Lưu ảnh QR (nhấn giữ ảnh) rồi mở app ngân hàng → Quét QR.</div>') +
    '<div class="shop-status" id="shopStatus">⏳ Đang chờ thanh toán…</div>' +
    (o.sandbox ? '<button class="ov-btn" id="sbxConfirm">✅ Xác nhận (sandbox)</button>' : '') +
    '<button class="ov-btn ghost" id="shopBack">← Cửa hàng</button>');
  card.scrollTop = 0;
  card.querySelectorAll('.pay-copy').forEach((b) => { b.onclick = () => copyText(copyVals[b.dataset.copy]); });
  card.querySelector('#shopBack').onclick = () => { if (pollTimer) clearInterval(pollTimer); pollTimer = null; openShop(); };
  const sbx = card.querySelector('#sbxConfirm');
  if (sbx) sbx.onclick = async () => { sbx.disabled = true; try { await api('POST', '/v1/pay/sandbox/confirm', { orderId: o.orderId }); } catch (e) { sbx.disabled = false; } check(); };
  const statusEl = card.querySelector('#shopStatus');
  async function check() {
    let st; try { st = (await api('GET', '/v1/orders/' + o.orderId)).status; } catch (e) { return; }
    if (st === 'paid') {
      clearInterval(pollTimer); pollTimer = null;
      statusEl.textContent = '🎉 Đã thanh toán! Đồ đã vào Tủ đồ.';
      await loadShop().catch(() => {});
      if (joined && myRoom) { try { await api('POST', '/v1/room-skin', { code: myRoom }); } catch (e) { /* lần vào phòng sau sẽ có */ } }
      // Trang bị ngay: món lẻ -> slot của nó; combo -> mọi món trong combo
      const toEquip = it.kind === 'bundle' ? it.items : it.slot ? [sku] : [];
      if (toEquip.length) {
        const b = el('button', { className: 'ov-btn', id: 'equipNow' }, '✨ Trang bị ngay');
        b.onclick = async () => {
          b.disabled = true;
          for (const i of toEquip) { const d = itemOf(i); if (d && d.slot) { try { myLook = await api('PUT', '/v1/loadout', { slot: d.slot, sku: i, room: joined && myRoom ? myRoom : undefined }); } catch (e) { /* bỏ qua */ } } }
          openShop('inv');
        };
        statusEl.after(b);
      }
      if (sbx) sbx.remove();
    } else if (st === 'expired') { clearInterval(pollTimer); pollTimer = null; statusEl.textContent = 'Đơn đã hết hạn.'; }
  }
  pollTimer = setInterval(check, 3000);
}
(function mountShop() {
  const btn = el('button', { className: 'ov-btn ghost', id: 'shopBtn' }, '🛒 Cửa hàng');
  btn.onclick = () => openShop();
  createBtn.parentNode.insertBefore(btn, ovErr);
  const lab = el('label', { className: 'ov-fest' }, '<input type="checkbox" id="festivalToggle"> 🎉 Phòng Lễ Hội (cả phòng dùng skin lễ hội)');
  lab.style.display = 'none';
  createBtn.parentNode.insertBefore(lab, createBtn);
  festivalToggle = lab.querySelector('input');
  const btn2 = el('button', { className: 'ov-btn ghost', id: 'shopBtnWait' }, '🛒 Cửa hàng');
  btn2.onclick = () => openShop();
  beginBtn.parentNode.insertBefore(btn2, ffBtn.nextSibling);
})();
