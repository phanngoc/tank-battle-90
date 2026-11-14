/* Tank Battle 90 trên Cloudflare Workers.
   - Static: public/ qua Workers Static Assets (binding ASSETS).
   - /v1/*: phần tối thiểu của Arcade platform mà public/vendor/arcade.js cần
     (guest auth, rooms/pick, rooms/join; events/leaderboard chấp nhận rồi bỏ).
   - /ws?room=CODE: mỗi phòng = một Durable Object (idFromName(CODE)), chạy
     server/room.js ở 30Hz bằng setInterval. Không dùng WebSocket Hibernation:
     tick liên tục nên DO không bao giờ ngủ được.
   Giao thức WS giống roomd (hello/create/join/rejoin/msg/leave → welcome/snap/ev/err). */
import { makeRoomModule } from './room-factory.mjs';
import * as eco from './economy.mjs';
import * as prog from './progression.mjs';

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

// Mua xong khi đang trong phòng: client gọi /v1/room-skin (biết mã phòng); ở đây không có
// sổ player->phòng nên không làm gì thêm. Giữ hàm để webhook thật (không có client) vẫn an toàn.
async function notifyRoomsOfPurchase() {}

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
      // token có chữ ký -> playerId ổn định, entitlement gắn được vào người chơi
      if (p === '/v1/auth/guest') return json(await eco.newGuest(env));
      if (p === '/v1/auth/refresh') {
        const pid = await eco.verifyToken(env, body.refreshToken, 'r');
        return pid ? json({ accessToken: await eco.issueToken(env, pid, 'a') }) : json({ error: 'SESSION_EXPIRED' }, 401);
      }
      if (p === '/v1/pay/webhook' && req.method === 'POST') { const r = await eco.handleWebhook(env, body, req.headers.get('authorization')); return json(r.body, r.status); }
      if (p === '/v1/shop' && req.method === 'GET') return json(await eco.shop(env, await eco.bearer(env, req)));
      if (p === '/v1/orders' || p.startsWith('/v1/orders/') || p === '/v1/pay/sandbox/confirm' || p === '/v1/entitlements' || p === '/v1/loadout') {
        const pid = await eco.bearer(env, req);
        if (!pid) return json({ error: 'UNAUTHORIZED' }, 401);
        let r;
        if (p === '/v1/entitlements') return json(await eco.entitlements(env, pid));
        if (p === '/v1/loadout' && req.method === 'GET') return json(await eco.loadout(env, pid));
        if (p === '/v1/loadout' && req.method === 'PUT') {
          let b = {}; try { b = await req.json(); } catch { b = {}; }
          r = await eco.setLoadout(env, pid, String(b.slot || ''), b.sku === null || b.sku === undefined ? null : String(b.sku));
          // đang ở phòng nào thì báo phòng đó vẽ lại (đồng đội thấy ngay)
          const code = String(b.room || '').toUpperCase();
          if (r.status === 200 && /^[A-Z0-9]{4}$/.test(code)) await roomStub(env, code).fetch('https://room/refresh-skin', { method: 'POST', body: JSON.stringify({ playerId: pid }) }).catch(() => {});
          return json(r.body, r.status);
        }
        if (p === '/v1/orders' && req.method === 'POST') r = await eco.createOrder(env, pid, String(body.sku || ''));
        else if (p.startsWith('/v1/orders/') && req.method === 'GET') r = await eco.orderStatus(env, pid, p.slice('/v1/orders/'.length));
        else if (p === '/v1/pay/sandbox/confirm' && req.method === 'POST') r = await eco.sandboxConfirm(env, pid, String(body.orderId || ''));
        else r = { status: 405, body: { error: 'METHOD' } };
        if (r.status === 200 && r.body && r.body.granted) await notifyRoomsOfPurchase(env, pid);
        return json(r.body, r.status);
      }
      if (p === '/v1/progress' || p === '/v1/upgrade' || p.startsWith('/v1/gems/')) {
        if (!prog.isOn(env)) return json({ error: 'progression_off' }, 404);
        const pid = await eco.bearer(env, req);
        if (!pid) return json({ error: 'UNAUTHORIZED' }, 401);
        let r;
        if (p === '/v1/progress' && req.method === 'GET') r = await prog.progress(env, pid);
        else if (p === '/v1/upgrade' && req.method === 'POST') r = await prog.upgrade(env, pid, String(body.stat || ''));
        else if (p === '/v1/gems/convert' && req.method === 'POST') r = await prog.convertGems(env, pid, body.gems);
        else if (p === '/v1/gems/sandbox-grant' && req.method === 'POST') r = await prog.sandboxGrant(env, pid, body.gems);
        else r = { status: 404, body: { error: 'NOT_FOUND' } };
        // nâng cấp xong khi đang ở phòng: báo phòng cập nhật cấp (áp dụng từ lượt sau)
        const code = String(body.room || '').toUpperCase();
        if (p === '/v1/upgrade' && r.status === 200 && /^[A-Z0-9]{4}$/.test(code)) await roomStub(env, code).fetch('https://room/refresh-levels', { method: 'POST', body: JSON.stringify({ playerId: pid }) }).catch(() => {});
        return json(r.body, r.status);
      }
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
      if (p === '/v1/room-skin' && req.method === 'POST') {   // client báo "tôi đang ở phòng X" sau khi mua
        const pid = await eco.bearer(env, req);
        const code = String(body.code || '').toUpperCase();
        if (!pid || !/^[A-Z0-9]{4}$/.test(code)) return json({ error: 'BAD_REQUEST' }, 400);
        await roomStub(env, code).fetch('https://room/refresh-skin', { method: 'POST', body: JSON.stringify({ playerId: pid }) });
        return json({ ok: true });
      }
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
    this.festival = false;
    this.instance = crypto.randomUUID().slice(0, 8);
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/info') return json({ active: !!this.mod, players: this.players.size });
    if (url.pathname === '/refresh-skin') {
      const { playerId } = await req.json();
      for (const p of this.players.values()) if (p.account === playerId && this.mod) {
        p.cos = await this.cosFor(playerId);
        this.mod.onMessage(this.room, { id: p.id, name: p.name, isHost: p.isHost, trusted: true }, 'cos', { cos: p.cos });
      }
      return json({ ok: true });
    }
    if (url.pathname === '/refresh-levels') {
      const { playerId } = await req.json();
      if (prog.isOn(this.env)) for (const p of this.players.values()) if (p.account === playerId && this.mod) {
        const levels = await prog.levels(this.env, playerId);
        this.mod.onMessage(this.room, { id: p.id, name: p.name, isHost: p.isHost, trusted: true }, 'levels', { levels });
      }
      return json({ ok: true });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    const code = String(url.searchParams.get('room') || '').toUpperCase();
    const pair = new WebSocketPair();
    const ws = pair[1];
    ws.accept();
    this.conns.add(ws);
    ws.addEventListener('message', (e) => { Promise.resolve().then(() => this.onWsMessage(ws, code, e.data)).catch((err) => console.error('room', code, err && err.stack || err)); });
    const gone = () => this.onWsClose(ws);
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  send(ws, obj) { try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch { /* đã đóng */ } }

  /** cosmetic của một account trong phòng này (chỉ trình bày, không đổi chỉ số).
      Phòng Lễ Hội: skin xe luôn là cầu vồng; đạn/map/đại bàng vẫn theo Tủ đồ. */
  async cosFor(account) {
    let c = { tank: null, bullet: null, eagle: null, map: null };
    try { if (account) c = await eco.loadout(this.env, account); } catch (err) { console.error('cos', err && err.message); }
    if (this.festival) c.tank = eco.FESTIVAL_SKIN;
    return c;
  }

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
      // Kết quả lượt Chiến dịch (room module gọi đồng bộ trong tick) -> ghi thưởng D1 ngoài tick
      runResult(ev) { self.onRunResult(ev).catch((err) => console.error('runResult', code, err && err.stack || err)); },
    };
    this.mod = mod; this.room = room; this.code = code; this.seq = 0;
    if (mod.onCreate) mod.onCreate(room, opts || {});
    this.timer = setInterval(() => this.tick(), 1000 / TICK_HZ);
  }

  /** ev = {runId, mode, stage, win, kills:{slot:n}, slots:{slot:playerId}}. Thưởng theo account (bỏ khách không token). */
  async onRunResult(ev) {
    if (!prog.isOn(this.env) || !ev || ev.mode !== 'campaign') return;
    const runId = this.instance + ':' + ev.runId;            // instance: DO tạo phòng lại cùng mã không trùng runId
    const players = [];
    for (const slot in ev.slots) { const p = this.players.get(ev.slots[slot]); if (p && p.account) players.push({ p, slot, kills: ev.kills[slot] | 0 }); }
    for (const { p, slot, kills } of players) {
      const r = await prog.awardRun(this.env, { runId, room: this.code, stage: ev.stage, win: ev.win, kills,
        players: players.map((x) => ({ slot: x.slot, account: x.p.account, kills: x.kills })) }, p.account);
      if (r && p.ws) this.send(p.ws, { t: 'ev', n: 'reward', d: Object.assign({ stage: ev.stage, win: ev.win, kills }, r) });
    }
  }

  /** Lọc mode/campaignN của chủ phòng: PROGRESSION_ON=false -> luôn Chuẩn; màn chỉ ≤ max_cleared+1 của chính họ. */
  async gateMode(account, o) {
    const out = Object.assign({}, o);
    delete out.mode; delete out.campaignN;
    if (!o || !prog.isOn(this.env)) return out;
    if (o.mode === 'standard') out.mode = 'standard';
    if (o.mode === 'campaign' && account) out.mode = 'campaign';
    if (typeof o.campaignN === 'number' && account) {
      const n = o.campaignN | 0;
      if (n >= 1 && n <= await prog.unlockedStage(this.env, account)) out.campaignN = n;
    }
    return out;
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

  async onWsMessage(ws, code, raw) {
    let m; try { m = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    switch (m.t) {
      case 'hello':
        // token SDK gửi trong hello -> account (null nếu token cũ/không ký): chỉ để tra entitlement
        ws.accountP = eco.verifyToken(this.env, m.token, 'a').catch(() => null);
        return;
      case 'pong': return;
      case 'create': case 'join': {
        if (ws.playerId || ws.joining) return;
        ws.joining = true;
        // Mọi truy vấn D1 làm TRƯỚC khi đụng vào phòng, để phần dưới chạy liền một mạch.
        let account = null, festival = false, cos = null;
        try {
          account = await (ws.accountP || null);
          // Phòng Lễ Hội: host mua lượt, tạo phòng với opts.festival -> tiêu 1 lượt trước khi tạo
          if (m.t === 'create' && m.opts && m.opts.festival === true && !this.mod) festival = await eco.consumeFestival(this.env, account);
          if (account) cos = await eco.loadout(this.env, account);
          if (prog.isOn(this.env) && account) ws.levels = await prog.levels(this.env, account);
          if (m.t === 'create') ws.opts = await this.gateMode(account, m.opts);
        } catch (err) { console.error('entitlements', err && err.message); }
        finally { ws.joining = false; }
        if (ws.readyState !== undefined && ws.readyState > 1) return;   // đã đóng trong lúc chờ D1
        if (m.t === 'create') {
          if (this.mod) return this.send(ws, { t: 'err', code: 'ROOM_EXISTS' });
          const opts = Object.assign({}, ws.opts || m.opts); delete opts.festival;
          this.createRoom(code, opts);
          this.festival = festival;
          this.room.state.festival = festival;
        }
        else if (!this.mod) return this.send(ws, { t: 'err', code: 'ROOM_NOT_FOUND' });
        if (this.players.size >= MAX_PLAYERS) return this.send(ws, { t: 'err', code: 'ROOM_FULL' });
        if (this.emptyTimer) { clearTimeout(this.emptyTimer); this.emptyTimer = null; }
        const p = { id: rid('pl'), name: String(m.name || '').slice(0, 12), isHost: this.players.size === 0, session: rid('s'), ws, account };
        p.cos = Object.assign({ tank: null, bullet: null, eagle: null, map: null }, cos);
        if (this.festival) p.cos.tank = eco.FESTIVAL_SKIN;
        this.players.set(p.id, p); this.sessions.set(p.session, p.id);
        ws.playerId = p.id;
        this.welcome(ws, p);
        for (const q of this.players.values()) if (q.ws && q !== p) this.send(q.ws, { t: 'join', p: { id: p.id, name: p.name } });
        this.mod.onJoin(this.room, { id: p.id, name: p.name, isHost: p.isHost, cos: p.cos, levels: ws.levels || null });
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
        if (String(m.n) === 'skin' || String(m.n) === 'cos') return;   // cosmetic chỉ do server đặt (từ entitlement + Tủ đồ)
        if (String(m.n) === 'levels') return;                             // cấp chỉ do server đặt (từ D1)
        const p = ws.playerId && this.players.get(ws.playerId);
        let d = m.d;
        if (String(m.n) === 'option' && d && typeof d === 'object') d = await this.gateMode(p && p.account, d);
        if (p && this.mod && this.players.has(p.id)) this.mod.onMessage(this.room, { id: p.id, name: p.name, isHost: p.isHost }, String(m.n), d);
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
