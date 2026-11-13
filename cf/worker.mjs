/* Tank Battle 90 trên Cloudflare Workers.
   - Static: public/ qua Workers Static Assets (binding ASSETS).
   - /v1/*: phần tối thiểu của Arcade platform mà public/vendor/arcade.js cần
     (guest auth, rooms/pick, rooms/join; events/leaderboard chấp nhận rồi bỏ).
   - /ws?room=CODE: mỗi phòng = một Durable Object (idFromName(CODE)), chạy
     server/room.js ở 30Hz bằng setInterval. Không dùng WebSocket Hibernation:
     tick liên tục nên DO không bao giờ ngủ được.
   Giao thức WS giống roomd (hello/create/join/rejoin/msg/leave → welcome/snap/ev/err). */
import { makeRoomModule } from './room-factory.mjs';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TICK_HZ = 30;
const MAX_PLAYERS = 4;
const EMPTY_ROOM_TTL_MS = 60_000;   // giống server.js cũ: phòng trống ~60s thì xoá
const REJOIN_GRACE_MS = 15_000;     // giữ slot khi rớt mạng để SDK "rejoin" lại

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const rid = (p) => p + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
function genCode() {
  const b = crypto.getRandomValues(new Uint8Array(4));
  let c = ''; for (const x of b) c += CODE_ALPHABET[x % CODE_ALPHABET.length];
  return c;
}
const roomStub = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));
async function roomActive(env, code) {
  const r = await roomStub(env, code).fetch('https://room/info?room=' + code);
  return (await r.json()).active;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === '/ws') {
      const code = String(url.searchParams.get('room') || '').toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) return new Response('room?', { status: 400 });
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      return roomStub(env, code).fetch(req);
    }

    if (p.startsWith('/v1/')) {
      const wsBase = (url.protocol === 'https:' ? 'wss://' : 'ws://') + url.host + '/ws?room=';
      let body = {};
      if (req.method === 'POST') { try { body = await req.json(); } catch { body = {}; } }
      if (p === '/v1/auth/guest') return json({ accessToken: rid('a'), refreshToken: rid('r'), playerId: rid('g'), isGuest: true });
      if (p === '/v1/auth/refresh') return json({ accessToken: rid('a') });
      if (p === '/v1/rooms/pick') {
        for (let i = 0; i < 6; i++) {
          const code = genCode();
          if (!(await roomActive(env, code))) return json({ wsUrl: wsBase + code });
        }
        return json({ error: 'NO_ROOM_CODE' }, 503);
      }
      if (p === '/v1/rooms/join') {
        const code = String(body.code || '').toUpperCase();
        if (!/^[A-Z0-9]{4}$/.test(code) || !(await roomActive(env, code))) return json({ error: 'ROOM_NOT_FOUND' }, 404);
        return json({ wsUrl: wsBase + code });
      }
      if (p === '/v1/events') return json({ ok: true });
      if (p.startsWith('/v1/leaderboard/')) return req.method === 'GET' ? json({ entries: [] }) : json({ ok: true, verified: false });
      if (p === '/v1/health') return json({ ok: true, runtime: 'cloudflare' });
      return json({ error: 'NOT_FOUND' }, 404);
    }

    const res = await env.ASSETS.fetch(req);
    // giống server.js cũ: tránh client.js/index.html cũ nằm lại trong cache
    const h = new Headers(res.headers); h.set('cache-control', 'no-store');
    return new Response(res.body, { status: res.status, headers: h });
  },
};

export class TankRoom {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.reset();
  }

  reset() {
    if (this.timer) clearInterval(this.timer);
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.mod = null; this.room = null; this.code = null;
    this.conns = new Set();          // ws đang mở (ws.player gắn sau create/join)
    this.players = new Map();        // playerId -> { id, name, isHost, session, ws, dropTimer }
    this.sessions = new Map();       // session -> playerId
    this.timer = null; this.emptyTimer = null; this.seq = 0;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/info') return json({ active: !!this.mod, players: this.players.size });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const code = String(url.searchParams.get('room') || '').toUpperCase();
    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept();
    this.conns.add(ws);
    ws.addEventListener('message', (e) => { try { this.onWsMessage(ws, code, e.data); } catch (err) { console.error('room', code, err && err.stack || err); } });
    const gone = () => this.onWsClose(ws);
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  send(ws, obj) { try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch { /* đã đóng */ } }

  createRoom(code, opts) {
    const mod = makeRoomModule();
    const self = this;
    const room = {
      code, tick: 0,
      get players() { return [...self.players.values()].map((p) => ({ id: p.id, name: p.name, isHost: p.isHost })); },
      state: mod.initialState ? mod.initialState() : {},
      broadcast(n, d) { const m = JSON.stringify({ t: 'ev', n, d }); for (const p of self.players.values()) if (p.ws) self.send(p.ws, m); },
      send(id, n, d) { const p = self.players.get(id); if (p && p.ws) self.send(p.ws, { t: 'ev', n, d }); },
      log(...a) { console.log('[room ' + code + ']', ...a); },
      lock() {}, unlock() {}, save() {},
      dispose() { self.dispose(); },
      leaderboard() { return { submit() {} }; },   // chưa có leaderboard trên CF (xem cf/README.md)
    };
    this.mod = mod; this.room = room; this.code = code; this.seq = 0;
    if (mod.onCreate) mod.onCreate(room, opts || {});
    this.timer = setInterval(() => this.tick(), 1000 / TICK_HZ);
  }

  dispose() {
    try { if (this.mod && this.mod.onDispose) this.mod.onDispose(this.room); } catch { /* bỏ qua */ }
    for (const ws of this.conns) { try { ws.close(1000, 'room closed'); } catch { /* */ } }
    for (const p of this.players.values()) if (p.dropTimer) clearTimeout(p.dropTimer);
    this.reset();
  }

  attached() { let n = 0; for (const p of this.players.values()) if (p.ws) n++; return n; }

  tick() {
    if (!this.mod) return;
    if (this.attached() === 0) return;          // phòng trống: đóng băng như server.js cũ
    this.room.tick++;
    try { this.mod.onTick(this.room, 1 / TICK_HZ); } catch (err) { console.error('tick', this.code, err && err.stack || err); return; }
    this.broadcastSnap();
  }

  broadcastSnap() {
    this.seq++;
    const msg = '{"t":"snap","seq":' + this.seq + ',"s":' + JSON.stringify(this.room.state) + '}';
    for (const p of this.players.values()) if (p.ws) this.send(p.ws, msg);
  }

  welcome(ws, p) {
    this.send(ws, { t: 'welcome', code: this.code, url: '', playerId: p.id, isHost: p.isHost, session: p.session });
  }

  onWsMessage(ws, code, raw) {
    let m; try { m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    switch (m.t) {
      case 'hello': case 'pong': return;
      case 'create': case 'join': {
        if (ws.playerId) return;
        if (m.t === 'create') { if (this.mod) return this.send(ws, { t: 'err', code: 'ROOM_EXISTS' }); this.createRoom(code, m.opts); }
        else if (!this.mod) return this.send(ws, { t: 'err', code: 'ROOM_NOT_FOUND' });
        if (this.players.size >= MAX_PLAYERS) return this.send(ws, { t: 'err', code: 'ROOM_FULL' });
        if (this.emptyTimer) { clearTimeout(this.emptyTimer); this.emptyTimer = null; }
        const p = { id: rid('pl'), name: String(m.name || '').slice(0, 12), isHost: this.players.size === 0, session: rid('s'), ws };
        this.players.set(p.id, p); this.sessions.set(p.session, p.id);
        ws.playerId = p.id;
        this.welcome(ws, p);
        for (const q of this.players.values()) if (q.ws && q !== p) this.send(q.ws, { t: 'join', p: { id: p.id, name: p.name } });
        this.mod.onJoin(this.room, { id: p.id, name: p.name, isHost: p.isHost });
        this.broadcastSnap();
        return;
      }
      case 'rejoin': {
        const pid = this.sessions.get(m.session);
        const p = pid && this.players.get(pid);
        if (!this.mod || !p) return this.send(ws, { t: 'err', code: 'SESSION_INVALID' });
        if (p.dropTimer) { clearTimeout(p.dropTimer); p.dropTimer = null; }
        if (this.emptyTimer) { clearTimeout(this.emptyTimer); this.emptyTimer = null; }
        if (p.ws && p.ws !== ws) { try { p.ws.close(4000, 'replaced'); } catch { /* */ } }
        p.ws = ws; ws.playerId = p.id;
        this.welcome(ws, p);
        this.send(ws, '{"t":"snap","seq":' + this.seq + ',"s":' + JSON.stringify(this.room.state) + '}');
        return;
      }
      case 'resync':
        if (this.mod) this.send(ws, '{"t":"snap","seq":' + this.seq + ',"s":' + JSON.stringify(this.room.state) + '}');
        return;
      case 'msg': {
        const p = ws.playerId && this.players.get(ws.playerId);
        if (p && this.mod) this.mod.onMessage(this.room, { id: p.id, name: p.name, isHost: p.isHost }, String(m.n), m.d);
        return;
      }
      case 'leave': {
        const p = ws.playerId && this.players.get(ws.playerId);
        if (p) this.removePlayer(p, 'left');
        try { ws.close(1000, 'bye'); } catch { /* */ }
        return;
      }
    }
  }

  removePlayer(p, reason) {
    if (!this.players.has(p.id)) return;
    if (p.dropTimer) clearTimeout(p.dropTimer);
    this.players.delete(p.id); this.sessions.delete(p.session);
    if (p.ws) p.ws.playerId = null;
    if (this.mod) this.mod.onLeave(this.room, { id: p.id, name: p.name, isHost: p.isHost }, reason);
    for (const q of this.players.values()) if (q.ws) this.send(q.ws, { t: 'left', p: p.id, r: reason });
    this.checkEmpty();
  }

  onWsClose(ws) {
    if (!this.conns.delete(ws)) return;
    const p = ws.playerId && this.players.get(ws.playerId);
    if (p && p.ws === ws) {
      p.ws = null;                 // giữ slot một lúc cho SDK rejoin (rớt Wi-Fi, chuyển 4G)
      p.dropTimer = setTimeout(() => this.removePlayer(p, 'timeout'), REJOIN_GRACE_MS);
    }
    this.checkEmpty();
  }

  checkEmpty() {
    if (!this.mod || this.attached() > 0 || this.emptyTimer) return;
    this.emptyTimer = setTimeout(() => { this.emptyTimer = null; if (this.attached() === 0) this.dispose(); }, EMPTY_ROOM_TTL_MS);
  }
}
