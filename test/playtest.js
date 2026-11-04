/* playtest.js — cổng verify bằng Chrome headless qua DevTools Protocol.
   Mở game thật, bấm nút thật, kiểm tra state ĐỔI. Bắt lỗi "vẽ đẹp mà không chơi được".

   Client chạy trên Arcade SDK nên cần platform. Mặc định harness tự dựng một
   platform GIẢ tối thiểu (test/host.js nạp server/room.js như roomd) — phục vụ
   public/, /v1/auth/guest, /v1/rooms/{pick,join} và WebSocket gửi snap mỗi tick.
   Không cần Postgres/Redis, không đụng com.ngocp.arcade.

   Chạy: node test/playtest.js            (platform giả, cổng ngẫu nhiên)
         node test/playtest.js <url>      (trỏ vào server có sẵn; bỏ các cổng cần bot)
   Ảnh chụp: /tmp/tank-playtest-*.png
*/
'use strict';
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
// ws: gói cài riêng trước, rồi tới node_modules của platform (khi game nằm trong repo games/).
let WS;
for (const p of ['ws', '../../node_modules/ws']) {
  try { WS = require(p); break; } catch (e) { /* thử tiếp */ }
}
if (!WS) {
  console.error('Thiếu gói "ws".\n  npm i');
  process.exit(2);
}
const WebSocket = WS.WebSocket || WS;
const WebSocketServer = WS.WebSocketServer || WS.Server;
const { createRoom } = require('./host');

const EXT_URL = process.argv[2] || null;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Cổng 0: Chrome tự chọn cổng trống rồi ghi vào <profile>/DevToolsActivePort —
// tránh đụng harness của game khác chạy song song.
let CDP_PORT = 0;
const VW = 390, VH = 844, VDPR = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function gate(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? ' — ' + detail : ''));
}

// ═══ platform giả ═══════════════════════════════════════════════════════════
const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' };

function startFakePlatform() {
  const rooms = new Map();     // code -> { r, conns:Set }
  let pid = 0;

  function makeRoom(opts) {
    let code;
    do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[(Math.random() * 31) | 0]).join(''); } while (rooms.has(code));
    const r = createRoom(opts);
    const entry = { r, conns: new Set(), code };
    rooms.set(code, entry);
    entry.timer = setInterval(() => {
      if (!entry.conns.size) return;
      r.tick(1);
      flush(entry);
    }, 1000 / 30);
    return entry;
  }
  function flush(entry) {
    const out = entry.r.out.splice(0);
    for (const cmd of out) {
      if (cmd[0] === 'bc') for (const c of entry.conns) send(c, { t: 'ev', n: cmd[1], d: cmd[2] });
      else if (cmd[0] === 'snd') for (const c of entry.conns) if (c.player.id === cmd[1]) send(c, { t: 'ev', n: cmd[2], d: cmd[3] });
    }
    const s = JSON.stringify(entry.r.room.state);
    entry.seq = (entry.seq || 0) + 1;
    for (const c of entry.conns) if (c.readyState === 1) c.send('{"t":"snap","seq":' + entry.seq + ',"s":' + s + '}');
  }
  function send(c, m) { if (c.readyState === 1) c.send(JSON.stringify(m)); }

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'POST' && url.startsWith('/v1/')) {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        let j = {}; try { j = JSON.parse(body || '{}'); } catch (e) { /* rỗng */ }
        const wsUrl = 'ws://127.0.0.1:' + server.address().port + '/ws';
        let out = { ok: true }, status = 200;
        if (url === '/v1/auth/guest') out = { accessToken: 'a' + (++pid), refreshToken: 'r', playerId: 'g' + pid, isGuest: true };
        else if (url === '/v1/rooms/pick') out = { wsUrl };
        else if (url === '/v1/rooms/join') {
          if (rooms.has(String(j.code || '').toUpperCase())) out = { wsUrl };
          else { status = 404; out = { error: 'ROOM_NOT_FOUND' }; }
        }
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    const file = path.join(PUBLIC, path.normalize(url === '/' ? '/index.html' : url));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (c) => {
    c.on('message', (raw) => {
      let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
      if (m.t === 'create' || m.t === 'join') {
        const entry = m.t === 'create' ? makeRoom(m.opts) : rooms.get(String(m.code || '').toUpperCase());
        if (!entry) return send(c, { t: 'err', code: 'ROOM_NOT_FOUND' });
        if (entry.conns.size >= 4) return send(c, { t: 'err', code: 'ROOM_FULL' });
        const isHost = entry.conns.size === 0;
        c.player = { id: 'pl' + (++pid), name: m.name || '', isHost };
        c.entry = entry;
        entry.conns.add(c);
        send(c, { t: 'welcome', code: entry.code, url: '', playerId: c.player.id, isHost, session: 's' + pid });
        entry.r.mod.onJoin(entry.r.room, c.player);
        flush(entry);
      } else if (m.t === 'msg' && c.entry) {
        entry_msg(c, m);
      } else if (m.t === 'leave' && c.entry) {
        c.close();
      }
    });
    c.on('close', () => {
      if (!c.entry) return;
      c.entry.conns.delete(c);
      c.entry.r.mod.onLeave(c.entry.r.room, c.player, 'left');
    });
  });
  function entry_msg(c, m) { c.entry.r.mod.onMessage(c.entry.r.room, c.player, m.n, m.d); }

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: 'http://127.0.0.1:' + server.address().port + '/',
    rooms,
    close() { for (const e of rooms.values()) clearInterval(e.timer); wss.close(); server.close(); },
  })));
}

/** Người chơi thứ 2: WebSocket thuần, nói đúng giao thức SDK. */
function botJoin(baseUrl, code, name) {
  const ws = new WebSocket(baseUrl.replace(/^http/, 'ws') + 'ws');
  const bot = { ws, state: null, slot: null, ready: null };
  bot.ready = new Promise((res, rej) => {
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', v: 1 })); ws.send(JSON.stringify({ t: 'join', code, name })); });
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === 'snap') bot.state = m.s;
      else if (m.t === 'ev' && m.n === 'you') { bot.slot = m.d.slot; res(bot); }
      else if (m.t === 'err') rej(new Error(m.code));
    });
    ws.on('error', rej);
  });
  bot.send = (n, d) => ws.send(JSON.stringify({ t: 'msg', n, d }));
  return bot;
}

// ═══ CDP ═══════════════════════════════════════════════════════════════════
function getJSON(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.waits = new Map(); this.events = []; }
  open() {
    return new Promise((res, rej) => {
      this.ws.on('open', res); this.ws.on('error', rej);
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        if (m.id && this.waits.has(m.id)) { this.waits.get(m.id)(m); this.waits.delete(m.id); }
        else if (m.method) this.events.push(m);
      });
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const to = setTimeout(() => { this.waits.delete(id); rej(new Error(method + ': CDP không trả lời sau 10s')); }, 10000);
      this.waits.set(id, (m) => { clearTimeout(to); m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result); });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async evaluate(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async tapEl(id) {
    const b = await this.evaluate(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height }; })()`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1 });
    }
    await sleep(80);
    return b;
  }
  async shot(p) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  }
  jsErrors() {
    return this.events.filter((e) =>
      e.method === 'Runtime.exceptionThrown' ||
      (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && e.params.entry.source !== 'network'));
  }
}

async function waitFor(cdp, expr, ms) {
  const end = Date.now() + (ms || 4000);
  while (Date.now() < end) {
    try { if (await cdp.evaluate(expr)) return true; } catch (e) { /* chưa sẵn */ }
    await sleep(100);
  }
  return false;
}

(async function main() {
  const fake = EXT_URL ? null : await startFakePlatform();
  const URL = EXT_URL || fake.url;
  console.log('  URL: ' + URL + (fake ? ' (platform giả)' : ''));
  const profile = fs.mkdtempSync('/tmp/tank-chrome-');
  const chrome = spawn(CHROME, [
    // --no-sandbox: khi harness chạy trong một sandbox khác (seatbelt của agent),
    // renderer không khởi tạo được sandbox của Chrome và trang treo. Chỉ mở trang local.
    '--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
    '--mute-audio', `--window-size=${VW},${VH}`, 'about:blank',
  ], { stdio: 'ignore' });

  let cdp, bot;
  try {
    for (let i = 0; i < 75 && !CDP_PORT; i++) {
      try { CDP_PORT = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || 0; } catch (e) { /* chưa có */ }
      if (!CDP_PORT) await sleep(200);
    }
    if (!CDP_PORT) throw new Error('Chrome không mở DevTools (sandbox chặn? thử chạy ngoài sandbox)');
    for (let i = 0; i < 60; i++) { try { await getJSON('/json/version'); break; } catch (e) { await sleep(200); } }
    const page = (await getJSON('/json/list')).find((t) => t.type === 'page');
    cdp = new CDP(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: VDPR, mobile: true });
    await cdp.send('Page.navigate', { url: URL });
    await sleep(1500);

    console.log('\n── G1: BOOT ' + '─'.repeat(40));
    let js = cdp.jsErrors();
    gate('0 lỗi JS khi tải trang', js.length === 0, js.length ? JSON.stringify(js.slice(0, 2)).slice(0, 400) : 'sạch');
    const boot = await cdp.evaluate(`(() => { const c = document.getElementById('game');
      return { w: c.width, h: c.height, menu: getComputedStyle(document.getElementById('ovMenu')).display,
               net: document.getElementById('net').textContent }; })()`);
    gate('canvas có kích thước', boot.w > 0 && boot.h > 0, `${boot.w}×${boot.h}`);
    gate('menu tạo/vào phòng hiện ra', boot.menu !== 'none', 'display=' + boot.menu);
    if (fake) gate('SDK init được (guest auth)', /sẵn sàng/.test(boot.net), boot.net.trim());
    const fit = await cdp.evaluate('({ sw: document.documentElement.scrollWidth, iw: innerWidth })');
    gate('không tràn ngang ở 390×844', fit.sw <= fit.iw + 1, `scrollWidth ${fit.sw} ≤ ${fit.iw}`);
    await cdp.shot('/tmp/tank-playtest-menu.png');

    if (!fake) {
      console.log('  (URL ngoài: bỏ qua các cổng cần platform giả)');
    } else {
      console.log('\n── G2: PHÒNG CHỜ ' + '─'.repeat(34));
      await cdp.evaluate(`document.getElementById('nameInput').value = 'Bot1'`);
      await cdp.tapEl('createBtn');
      const waiting = await waitFor(cdp, `getComputedStyle(document.getElementById('ovWait')).display !== 'none'`, 5000);
      const code = await cdp.evaluate(`document.getElementById('invCode').textContent`);
      gate('tạo phòng → màn chờ có mã phòng', waiting && /^[A-Z0-9]{4}$/.test(code), 'mã ' + code);
      const ffUi = await cdp.evaluate(`(() => { const b = document.getElementById('ffBtn'); return b ? b.textContent : null; })()`);
      if (ffUi !== null) {
        gate('nút bắn đồng đội trong phòng chờ (mặc định BẬT)', /BẬT/.test(ffUi), ffUi);
        await cdp.tapEl('ffBtn');
        const off = await waitFor(cdp, `latest && /TẮT/.test(document.getElementById('ffBtn').textContent)`, 3000);
        const srvOff = [...fake.rooms.values()][0].r.game.friendlyFire === false;
        gate('bấm nút → server tắt bắn đồng đội, UI cập nhật', off && srvOff, 'server friendlyFire=' + !srvOff);
        await cdp.tapEl('ffBtn');
        await waitFor(cdp, `/BẬT/.test(document.getElementById('ffBtn').textContent)`, 3000);
      }

      bot = botJoin(URL, code, 'Bot2');
      await bot.ready;
      const started = await waitFor(cdp, `latest && latest.status === 'playing' && latest.players.length === 2`, 5000);
      gate('người thứ 2 vào → trận tự bắt đầu', started, 'bot slot ' + bot.slot);
      await sleep(300);
      const ovHidden = await cdp.evaluate(`document.getElementById('overlay').classList.contains('hidden')`);
      gate('overlay ẩn khi đang chơi', ovHidden);

      console.log('\n── G3: CHƠI ĐƯỢC ' + '─'.repeat(34));
      const hud = await cdp.evaluate(`({ st: document.getElementById('hudStage').textContent, en: document.getElementById('hudEnemies').textContent,
        chips: document.querySelectorAll('#hudPlayers .pchip').length })`);
      const room = [...fake.rooms.values()][0];
      const expectEnemies = room.r.game.enemiesRemaining();
      gate('HUD: stage 1, số địch khớp server, 2 người chơi', hud.st === '1' && Number(hud.en) === expectEnemies && hud.chips === 2,
        `stage ${hud.st}, địch ${hud.en} (server ${expectEnemies}), chip ${hud.chips}`);

      // đợi hết khiên xuất hiện rồi lái xe sang trái bằng d-pad thật
      // (slot 0 đứng ở x=128; phía trên là gạch, bên trái trống ở cả 3 bản đồ)
      await sleep(1200);
      const myTank = `(() => { const t = latest.tanks.find(t => t.k === 'p' && t.slot === me); return t ? { x: t.x, y: t.y } : null; })()`;
      const p0 = await cdp.evaluate(myTank);
      const btn = await cdp.evaluate(`(() => { const r = document.querySelector('.dbtn.left').getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
      await sleep(700);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
      await sleep(200);
      const p1 = await cdp.evaluate(myTank);
      gate('giữ ◀ → xe của mình chạy sang trái', p0 && p1 && p1.x < p0.x, p0 && p1 ? `x ${p0.x} → ${p1.x}` : 'không thấy xe');

      await cdp.tapEl('fireBtn');
      const fired = await waitFor(cdp, `latest && latest.bullets.length > 0`, 1500);
      gate('bấm BẮN → có đạn trên màn', fired);

      // luật b: server choáng xe mình -> client nhận cờ st, vẽ không lỗi, ◀ không chạy
      const mine = room.r.game.tanks.find((t) => t.kind === 'player' && t.slot === 0);
      mine.shieldUntil = 0; room.r.game.stunPlayer(mine);
      const stunned = await waitFor(cdp, `latest && latest.tanks.some(t => t.k === 'p' && t.slot === me && t.st === 1)`, 2000);
      const sx0 = await cdp.evaluate(myTank);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
      await sleep(500);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left', clickCount: 1 });
      const sx1 = await cdp.evaluate(myTank);
      gate('bị choáng → client thấy cờ st, ◀ không chạy', stunned && sx0 && sx1 && sx0.x === sx1.x, sx0 && sx1 ? `x ${sx0.x} → ${sx1.x}` : '');
      await cdp.shot('/tmp/tank-playtest-stun.png');

      await sleep(2500);
      const enemiesSeen = await cdp.evaluate(`latest.tanks.filter(t => t.k === 'e').length`);
      gate('địch xuất hiện', enemiesSeen > 0, enemiesSeen + ' xe địch');
      const painted = await cdp.evaluate(`(() => { const cv = document.getElementById('game'); const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        const seen = new Set(); for (let i = 0; i < d.length; i += 4 * 53) seen.add(d[i] + ',' + d[i+1] + ',' + d[i+2]); return seen.size; })()`);
      gate('canvas vẽ ra hình (không phải 1 màu)', painted > 8, painted + ' màu');
      await cdp.shot('/tmp/tank-playtest-play.png');

      // game over -> CHƠI LẠI
      room.r.game.destroyBase();
      const over = await waitFor(cdp, `getComputedStyle(document.getElementById('ovOver')).display !== 'none'`, 3000);
      gate('đại bàng nổ → màn GAME OVER', over);
      await cdp.tapEl('restartBtn2');
      const again = await waitFor(cdp, `latest && latest.status === 'playing' && document.getElementById('overlay').classList.contains('hidden')`, 3000);
      gate('CHƠI LẠI → vào trận mới', again);
    }

    js = cdp.jsErrors();
    gate('0 lỗi JS suốt phiên', js.length === 0, js.length ? JSON.stringify(js.slice(0, 2)).slice(0, 400) : 'sạch');

    console.log('\n── KẾT QUẢ ' + '─'.repeat(41));
    const failed = results.filter((r) => !r.ok);
    console.log(`  ${results.length - failed.length}/${results.length} cổng pass`);
    console.log('  ảnh: /tmp/tank-playtest-{menu,stun,play}.png');
    process.exitCode = failed.length ? 1 : 0;
  } catch (e) {
    console.error('\n❌ harness lỗi:', e.stack || e.message);
    process.exitCode = 2;
  } finally {
    try { if (bot) bot.ws.close(); } catch (e) { /* */ }
    try { if (cdp) cdp.ws.close(); } catch (e) { /* */ }
    chrome.kill('SIGKILL');
    if (fake) fake.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* */ }
    setTimeout(() => process.exit(process.exitCode), 200).unref();
  }
})();
