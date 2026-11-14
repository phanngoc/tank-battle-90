#!/usr/bin/env node
/* Playtest súng Laser (phòng Thường) — dựa trên harness của shop-playtest.
   Chạy: node test/laser-playtest.js [http://127.0.0.1:8787]  (cần npm run dev:cf)
   Gốc: Playtest cửa hàng cosmetic trên Worker thật (wrangler dev hoặc prod, PAYMENTS_LIVE=false).
   Chạy: node test/shop-playtest.js [http://127.0.0.1:8787]   (prod: https://tank.bomclaw.org)
   Cổng: boot sạch · 6 tab · xem trước có hình · mua sandbox → cấp 1 lần · trang bị · tải lại vẫn còn ·
   người thứ 2 trong phòng thấy skin/đạn · đổi đồ giữa trận phòng cập nhật · client không tự đặt cos. */
'use strict';
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const URL = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '') + '/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let CDP_PORT = 0, fails = 0;
const gate = (n, ok, d) => { if (!ok) fails++; console.log((ok ? '  ✅ ' : '  ❌ ') + n + (d ? ' — ' + d : '')); };
const getJSON = (p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); }).on('error', rej));

class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.waits = new Map(); this.events = []; }
  open() { return new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); this.ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && this.waits.has(m.id)) { this.waits.get(m.id)(m); this.waits.delete(m.id); } else if (m.method) this.events.push(m); }); }); }
  send(method, params) { const id = ++this.id; return new Promise((res, rej) => { const to = setTimeout(() => { this.waits.delete(id); rej(new Error(method + ' timeout')); }, 15000); this.waits.set(id, (m) => { clearTimeout(to); m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result); }); this.ws.send(JSON.stringify({ id, method, params: params || {} })); }); }
  async ev(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; }
  jsErrors() { return this.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && e.params.entry.source !== 'network')); }
}
async function waitFor(cdp, expr, ms = 6000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await cdp.ev(expr)) return true; } catch (e) { /* chưa */ } await sleep(150); } return false; }
const click = (cdp, sel) => cdp.ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);

function bot(code, token) {
  const base = URL.replace(/^http/, 'ws');
  const ws = new WebSocket(base + 'ws?room=' + code);
  const b = { ws, state: null };
  b.ready = new Promise((res, rej) => {
    ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', v: 1, token })); ws.send(JSON.stringify({ t: 'join', code, name: 'Bot' })); });
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.t === 'snap') b.state = m.s; else (b.msgs = b.msgs || []).push(m); if (m.t === 'welcome') res(b); if (m.t === 'err') rej(new Error(m.code)); });
    ws.on('error', rej);
  });
  return b;
}


// tia chỉ sống 200ms, ảnh chụp headless chậm hơn ⇒ giữ khung tia đang có cho ảnh (chỉ harness)
const shot = async (cdp, file) => { await cdp.ev('beams.forEach((b) => { b.t = performance.now() + 400; })'); await sleep(60); const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')); };
const OUT = process.env.SHOT_DIR || '/tmp';
async function fireUntilBeam(cdp) {
  // quay trái (hàng hồi sinh trống tới mép trái) để tia dài, thấy rõ trong ảnh
  await cdp.ev(`send({ t: 'ctrl', dir: 3, moving: true, fire: false })`); await sleep(120);
  await cdp.ev(`send({ t: 'ctrl', dir: 3, moving: false, fire: false })`); await sleep(100);
  for (let i = 0; i < 40; i++) {
    await cdp.ev(`(() => { beams.length = 0; send({ t: 'ctrl', dir: 3, moving: false, fire: true }); })()`);
    if (await waitFor(cdp, 'beams.length > 0', 400)) { await sleep(40); return true; }
    await cdp.ev(`send({ t: 'ctrl', dir: 0, moving: false, fire: false })`); await sleep(250);
  }
  return false;
}
(async () => {
  console.log('  URL: ' + URL);
  const profile = fs.mkdtempSync('/tmp/tank-laser-chrome-');
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--disable-gpu', '--mute-audio', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
  let cdp, b;
  try {
    for (let i = 0; i < 75 && !CDP_PORT; i++) { try { CDP_PORT = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || 0; } catch (e) { /* */ } if (!CDP_PORT) await sleep(200); }
    for (let i = 0; i < 60; i++) { try { await getJSON('/json/version'); break; } catch (e) { await sleep(200); } }
    cdp = new CDP((await getJSON('/json/list')).find((t) => t.type === 'page').webSocketDebuggerUrl);
    await cdp.open(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await cdp.send('Page.navigate', { url: URL });
    gate('trang tải + đăng nhập guest', await waitFor(cdp, 'typeof arcade !== "undefined" && arcade && !!arcade.playerId', 10000));
    const o = await cdp.ev('api("POST", "/v1/orders", { sku: "tank.bullet.laser" })');
    await cdp.ev(`api("POST", "/v1/pay/sandbox/confirm", { orderId: ${JSON.stringify(o.orderId)} })`);
    await cdp.ev('loadShop().then(() => quickEquip("tank.bullet.laser"))'); await sleep(500);
    gate('sở hữu + trang bị Laser', await cdp.ev('myLook.bullet === "tank.bullet.laser"'));
    gate('menu có lựa chọn Phòng Thường', await cdp.ev('!!document.getElementById("casualToggle")'));
    await cdp.ev(`document.getElementById('nameInput').value = 'Laser'; document.getElementById('casualToggle').checked = true;`);
    await click(cdp, '#createBtn');
    await waitFor(cdp, 'typeof myRoom === "string" && myRoom.length === 4', 10000);
    const code = await cdp.ev('myRoom');
    gate('phòng mode casual', await waitFor(cdp, 'roomMode === "casual"', 5000), code);
    b = bot(code); await b.ready;
    gate('2 người → vào trận', await waitFor(cdp, 'statusText === "playing"', 8000));
    await sleep(1500);   // khiên hồi sinh hết
    gate('bắn → có tia (event beam)', await fireUntilBeam(cdp));
    const bm = await cdp.ev('JSON.stringify(beams[0])');
    await shot(cdp, OUT + '/tank-laser-390x844.png');
    gate('vòng hồi chiêu trên nút Laser', await cdp.ev('!!document.querySelector(".ib-btn.cd[data-sku=\\"tank.bullet.laser\\"]")'), bm);
    gate('nút Laser ghi "⚡ súng"', await cdp.ev('/súng/.test(document.querySelector(".ib-btn[data-sku=\\"tank.bullet.laser\\"]").textContent)'));
    await sleep(300);
    gate('đồng đội nhận tia của mình', (b.msgs || []).some((m) => JSON.stringify(m).includes('"ownerSlot":0')), JSON.stringify((b.msgs || []).find((m) => JSON.stringify(m).includes('ownerSlot')) || null).slice(0, 160));
    // về đạn thường bằng thanh 6 nút
    await cdp.ev(`send({ t: 'ctrl', dir: 0, moving: false, fire: false })`); await sleep(1100);
    await click(cdp, '.ib-btn[data-sku="tank.bullet.laser"]');
    await waitFor(cdp, 'myLook.bullet == null', 4000); await sleep(800);
    let sawBeam = false, sawBullet = false;
    for (let i = 0; i < 12; i++) {
      await cdp.ev(`(() => { beams.length = 0; send({ t: 'ctrl', dir: 0, moving: false, fire: true }); })()`); await sleep(150);
      if (await cdp.ev('beams.length > 0')) sawBeam = true;
      if (await cdp.ev('!!(latest && latest.bullets && latest.bullets.some((x) => x.s === me))')) sawBullet = true;
      await cdp.ev(`send({ t: 'ctrl', dir: 0, moving: false, fire: false })`); await sleep(150);
    }
    gate('chạm lại nút → đạn thường, không còn tia', !sawBeam && sawBullet, JSON.stringify({ sawBeam, sawBullet }));
    // bật lại Laser, chụp desktop
    await click(cdp, '.ib-btn[data-sku="tank.bullet.laser"]');
    await waitFor(cdp, 'myLook.bullet === "tank.bullet.laser"', 4000); await sleep(800);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await sleep(500);
    gate('desktop: bắn lại Laser có tia', await fireUntilBeam(cdp));
    const len = await cdp.ev('beams[0] ? Math.abs(beams[0].x2 - beams[0].x1) + Math.abs(beams[0].y2 - beams[0].y1) : 0');
    gate('tia dài tới vật cản (> 40px)', len > 40, len + 'px');
    await shot(cdp, OUT + '/tank-laser-desktop.png');
    const js = cdp.jsErrors();
    gate('0 lỗi JS', js.length === 0, js.length ? JSON.stringify(js[0]).slice(0, 300) : 'sạch');
  } catch (e) { gate('không lỗi harness', false, e.message); }
  finally { try { b && b.ws.close(); } catch (e) { /* */ } chrome.kill(); }
  console.log(fails ? '❌ ' + fails + ' cổng fail' : '✅ laser playtest pass');
  process.exit(fails ? 1 : 0);
})();
