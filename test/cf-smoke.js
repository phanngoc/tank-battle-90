/* cf-smoke.js — 2 người chơi thật qua mạng vào bản Cloudflare (hoặc bất kỳ server nói
   giao thức Arcade SDK): A tạo phòng, B vào bằng mã mời, cả hai thấy nhau di chuyển/bắn.
   Chạy: node test/cf-smoke.js https://tank-battle-90.lequidon-1993.workers.dev */
'use strict';
const WS = require('ws');
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const gate = (n, ok, d) => { if (!ok) fails++; console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? ' — ' + d : '')); };
const post = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); return { status: r.status, body: await r.json() }; };

function client(wsUrl, intent, name) {
  const ws = new WS(wsUrl);
  const c = { ws, state: null, snaps: 0, slot: null, ev: {}, rtts: [] };
  c.ready = new Promise((res, rej) => {
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', v: 1 })); ws.send(JSON.stringify(Object.assign({ name }, intent))); });
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === 'welcome') { c.code = m.code; c.playerId = m.playerId; }
      else if (m.t === 'snap') { c.state = m.s; c.snaps++; }
      else if (m.t === 'ev') { c.ev[m.n] = (c.ev[m.n] || 0) + 1; if (m.n === 'you') { c.slot = m.d.slot; res(c); } }
      else if (m.t === 'err') rej(new Error(m.code));
    });
    ws.on('error', rej);
  });
  c.send = (n, d) => ws.send(JSON.stringify({ t: 'msg', n, d }));
  return c;
}
const myTank = (c, slot) => Object.values(c.state.tanks || {}).find((t) => t.k === 'p' && t.slot === slot);

(async () => {
  console.log('  URL: ' + BASE);
  const pick = await post('/v1/rooms/pick');
  gate('rooms/pick trả wsUrl', !!pick.body.wsUrl, pick.body.wsUrl);
  const A = client(pick.body.wsUrl, { t: 'create', mode: 'coop' }, 'Alice');
  await A.ready;
  gate('A tạo phòng', !!A.code, A.code);
  const bad = await post('/v1/rooms/join', { code: 'ZZZZ' });
  gate('mã sai → 404 ROOM_NOT_FOUND', bad.status === 404);
  const join = await post('/v1/rooms/join', { code: A.code });
  gate('B tra mã mời', join.status === 200, join.body.wsUrl);
  const B = client(join.body.wsUrl, { t: 'join', code: A.code }, 'Bob');
  await B.ready;
  gate('B vào cùng phòng, khác slot', B.slot != null && B.slot !== A.slot, `A=${A.slot} B=${B.slot}`);
  A.send('start');
  await sleep(1500);
  gate('trận bắt đầu (cả hai thấy playing)', A.state.status === 'playing' && B.state.status === 'playing', A.state.status + '/' + B.state.status);
  const s0 = A.snaps, t0 = Date.now(); await sleep(2000);
  const hz = (A.snaps - s0) / ((Date.now() - t0) / 1000);
  gate('nhịp snapshot ~30Hz', hz > 24, hz.toFixed(1) + ' Hz');
  // độ trễ input→thấy trên máy kia: B đổi hướng, đo tới khi A thấy dir mới
  const lat = [];
  for (let i = 0; i < 5; i++) {
    const want = i % 2 ? 2 : 3;
    const t = Date.now();
    B.send('input', { dir: want, moving: true, fire: false });
    while (Date.now() - t < 2000) { const tk = myTank(A, B.slot); if (tk && tk.d === want) break; await sleep(2); }
    lat.push(Date.now() - t);
    B.send('input', { dir: want, moving: false, fire: false });
  }
  lat.sort((a, b) => a - b);
  gate('độ trễ B→server→A (trung vị) < 250ms', lat[2] < 250, lat.join(',') + ' ms');
  const bBefore = myTank(A, B.slot);
  const aBefore = myTank(B, A.slot);
  B.send('input', { dir: 0, moving: true, fire: true });
  A.send('input', { dir: 1, moving: true, fire: true });
  await sleep(1200);
  B.send('input', { dir: 0, moving: false, fire: false }); A.send('input', { dir: 1, moving: false, fire: false });
  const bAfter = myTank(A, B.slot), aAfter = myTank(B, A.slot);
  gate('A thấy xe B di chuyển', bBefore && bAfter && (bBefore.x !== bAfter.x || bBefore.y !== bAfter.y), bBefore && bAfter ? `y ${bBefore.y}→${bAfter.y}` : 'thiếu xe');
  gate('B thấy xe A di chuyển', aBefore && aAfter && (aBefore.x !== aAfter.x || aBefore.y !== aAfter.y), aBefore && aAfter ? `x ${aBefore.x}→${aAfter.x}` : 'thiếu xe');
  gate('có sự kiện bắn/nổ (fx/effects)', (A.ev.fx || 0) + (A.ev.effects || 0) + (A.ev.mapDelta || 0) > 0, JSON.stringify(A.ev));
  A.ws.close(); B.ws.close();
  console.log(fails ? `  ${fails} cổng FAIL` : '  tất cả pass');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('  ❌ ' + e.message); process.exit(1); });
