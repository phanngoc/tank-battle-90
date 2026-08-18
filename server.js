'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const { Game, TILE, COLS, ROWS, TICK_HZ } = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon' };

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

// ---- game + websocket ----
const game = new Game();
const wss = new WebSocketServer({ server: httpServer });

function send(ws, obj) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(obj) { const s = JSON.stringify(obj); for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(s); }

function sendInit(ws) {
  send(ws, {
    t: 'init',
    you: ws.slot,
    cols: COLS, rows: ROWS, tile: TILE,
    stage: game.stage, status: game.status,
    map: game.fullMap(),
  });
}

wss.on('connection', (ws) => {
  ws.slot = null;
  send(ws, { t: 'hello', cols: COLS, rows: ROWS, tile: TILE });
  // send current map so even non-joined spectators can render terrain
  send(ws, { t: 'map', map: game.fullMap(), stage: game.stage, status: game.status });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.t) {
      case 'join': {
        if (ws.slot != null) return;
        const p = game.addPlayer((msg.name || '').toString().slice(0, 12));
        if (!p) { send(ws, { t: 'full' }); return; }
        ws.slot = p.slot;
        sendInit(ws);
        break;
      }
      case 'ctrl': {
        if (ws.slot == null) return;
        const p = game.players.get(ws.slot);
        if (!p) return;
        const dir = [0, 1, 2, 3].includes(msg.dir) ? msg.dir : p.ctrl.dir;
        p.ctrl = { dir, moving: !!msg.moving, fire: !!msg.fire };
        break;
      }
      case 'restart': {
        if (game.status === 'gameover' || game.status === 'lobby') { game.restart(); broadcastMapRefresh(); }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws.slot != null) { game.removePlayer(ws.slot); ws.slot = null; }
  });
});

function broadcastMapRefresh() {
  broadcast({ t: 'map', map: game.fullMap(), stage: game.stage, status: game.status });
}

// re-send full map when a stage (re)loads
let lastStageKey = `${game.stage}:${game.status}`;
function watchStageChange() {
  const key = `${game.stage}:${game.status}`;
  if (key !== lastStageKey) {
    // when entering 'playing' with a fresh map, push it
    if (game.status === 'playing') broadcastMapRefresh();
    lastStageKey = key;
  }
}

// ---- game loop ----
const STEP = 1000 / TICK_HZ;
setInterval(() => {
  game.update();
  watchStageChange();
  if (wss.clients.size > 0) broadcast(game.snapshot());
}, STEP);

// ---- boot ----
function lanIPs() {
  const nets = os.networkInterfaces();
  const primary = [];  // physical Wi-Fi / Ethernet (en*)
  const other = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.address.endsWith('.0')) continue;            // skip odd bridge nets
      if (/^en\d+$/.test(name)) primary.push(ni.address); // real LAN interfaces
      else other.push(ni.address);
    }
  }
  return primary.length ? primary : other;
}

httpServer.listen(PORT, '0.0.0.0', () => {
  const ips = lanIPs();
  console.log('======================================================');
  console.log('  TANK BATTLE 90  -  co-op realtime server is running');
  console.log('======================================================');
  console.log(`  On this Mac:      http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  On your phone:    http://${ip}:${PORT}   (same Wi-Fi)`);
  console.log('------------------------------------------------------');
  console.log('  Open the URL on 2+ devices to play co-op together.');
  console.log('  Ctrl+C to stop.');
});
