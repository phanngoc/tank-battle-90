'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { Game, TILE, COLS, ROWS, TICK_HZ } = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.gif': 'image/gif', '.ico': 'image/x-icon' };
const EMPTY_ROOM_TTL = TICK_HZ * 60; // delete a room after ~60s with no clients

// ---- static file server ----
const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- rooms ----
const rooms = new Map(); // code -> Game (augmented with .code, ._stageKey, .emptyTicks)

function genCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += A[(Math.random() * A.length) | 0]; } while (rooms.has(c));
  return c;
}
function createRoom() {
  const g = new Game();
  g.code = genCode();
  g._stageKey = '';
  g.emptyTicks = 0;
  rooms.set(g.code, g);
  return g;
}

const wss = new WebSocketServer({ server: httpServer });
function send(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function roomClients(code) {
  const arr = [];
  for (const ws of wss.clients) if (ws.room === code && ws.readyState === ws.OPEN) arr.push(ws);
  return arr;
}
function sendInit(ws, g) {
  send(ws, {
    t: 'init', room: g.code, you: ws.slot,
    cols: COLS, rows: ROWS, tile: TILE,
    stage: g.stage, status: g.status, map: g.fullMap(),
  });
}

function lobbyStats() {
  let players = 0, waiting = 0, active = 0;
  for (const [code, g] of rooms) {
    if (roomClients(code).length === 0) continue;
    active++;
    players += g.players.size;
    if (g.status === 'waiting') waiting++;
  }
  return { t: 'lobby', rooms: active, waiting, players };
}
function broadcastLobby() {
  const msg = JSON.stringify(lobbyStats());
  for (const ws of wss.clients) if (ws.room == null && ws.readyState === ws.OPEN) ws.send(msg);
}

wss.on('connection', (ws) => {
  ws.slot = null;
  ws.room = null;
  send(ws, { t: 'hello', cols: COLS, rows: ROWS, tile: TILE });
  send(ws, lobbyStats()); // initial active-rooms count for the menu

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.t) {
      case 'create': {
        if (ws.room != null) return;
        const g = createRoom();
        const p = g.addPlayer((msg.name || '').toString().slice(0, 12));
        ws.room = g.code; ws.slot = p.slot;
        sendInit(ws, g);
        break;
      }
      case 'join': {
        if (ws.room != null) return;
        const code = (msg.room || '').toString().toUpperCase().slice(0, 4);
        const g = rooms.get(code);
        if (!g) { send(ws, { t: 'nojoin', reason: 'notfound', room: code }); return; }
        const p = g.addPlayer((msg.name || '').toString().slice(0, 12));
        if (!p) { send(ws, { t: 'nojoin', reason: 'full', room: code }); return; }
        ws.room = code; ws.slot = p.slot;
        sendInit(ws, g);
        break;
      }
      case 'ctrl': {
        const g = rooms.get(ws.room);
        if (!g || ws.slot == null) return;
        const p = g.players.get(ws.slot);
        if (!p) return;
        const dir = [0, 1, 2, 3].includes(msg.dir) ? msg.dir : p.ctrl.dir;
        p.ctrl = { dir, moving: !!msg.moving, fire: !!msg.fire };
        break;
      }
      case 'begin': {
        const g = rooms.get(ws.room);
        if (!g) return;
        if (g.status === 'waiting') g.startGame(); // creator starts without waiting for others
        break;
      }
      case 'restart': {
        const g = rooms.get(ws.room);
        if (!g) return;
        if (g.status === 'gameover' || g.status === 'lobby') {
          g.restart();
          const mm = JSON.stringify({ t: 'map', map: g.fullMap(), stage: g.stage, status: g.status });
          for (const c of roomClients(g.code)) c.send(mm);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const g = rooms.get(ws.room);
    if (g && ws.slot != null) g.removePlayer(ws.slot);
    ws.slot = null; ws.room = null;
  });
});

// ---- game loop (all rooms) ----
const STEP = 1000 / TICK_HZ;
let statTick = 0;
setInterval(() => {
  if (++statTick % 15 === 0) broadcastLobby(); // ~2x/sec update menu room counter
  for (const [code, g] of rooms) {
    const clients = roomClients(code);
    if (clients.length === 0) {
      g.emptyTicks = (g.emptyTicks || 0) + 1;
      if (g.emptyTicks > EMPTY_ROOM_TTL) rooms.delete(code);
      continue; // freeze empty rooms
    }
    g.emptyTicks = 0;
    g.update();
    // per-room stage change -> push fresh full map
    const key = `${g.stage}:${g.status}`;
    if (key !== g._stageKey) {
      if (g.status === 'playing') {
        const mm = JSON.stringify({ t: 'map', map: g.fullMap(), stage: g.stage, status: g.status });
        for (const c of clients) c.send(mm);
      }
      g._stageKey = key;
    }
    const snap = JSON.stringify(g.snapshot());
    for (const c of clients) c.send(snap);
  }
}, STEP);

// ---- boot ----
function lanIPs() {
  const nets = os.networkInterfaces();
  const primary = [], other = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.address.endsWith('.0')) continue;
      if (/^en\d+$/.test(name)) primary.push(ni.address); else other.push(ni.address);
    }
  }
  return primary.length ? primary : other;
}

httpServer.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log('======================================================');
  console.log('  TANK BATTLE 90  -  co-op realtime server (rooms)');
  console.log('======================================================');
  console.log(`  On this Mac:      http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  On your phone:    http://${ip}:${PORT}   (same Wi-Fi)`);
  console.log('------------------------------------------------------');
  console.log('  Create a room -> share the invite link -> play co-op.');
  console.log('  Ctrl+C to stop.');
});
