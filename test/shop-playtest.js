#!/usr/bin/env node
/* Playtest cửa hàng cosmetic trên Worker thật (wrangler dev hoặc prod, PAYMENTS_LIVE=false).
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
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.t === 'snap') b.state = m.s; if (m.t === 'welcome') res(b); if (m.t === 'err') rej(new Error(m.code)); });
    ws.on('error', rej);
  });
  return b;
}

(async () => {
  console.log('  URL: ' + URL);
  const profile = fs.mkdtempSync('/tmp/tank-shop-chrome-');
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--disable-gpu', '--mute-audio', '--window-size=420,900', 'about:blank'], { stdio: 'ignore' });
  let cdp, b;
  try {
    for (let i = 0; i < 75 && !CDP_PORT; i++) { try { CDP_PORT = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || 0; } catch (e) { /* */ } if (!CDP_PORT) await sleep(200); }
    for (let i = 0; i < 60; i++) { try { await getJSON('/json/version'); break; } catch (e) { await sleep(200); } }
    cdp = new CDP((await getJSON('/json/list')).find((t) => t.type === 'page').webSocketDebuggerUrl);
    await cdp.open(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Log.enable');
    await cdp.send('Page.navigate', { url: URL });
    gate('trang tải + đăng nhập guest', await waitFor(cdp, 'typeof arcade !== "undefined" && arcade && !!arcade.playerId', 10000));

    await click(cdp, '#shopBtn');
    gate('mở cửa hàng: 6 tab', await waitFor(cdp, 'document.querySelectorAll(".shop-tab").length === 6'));
    const counts = {};
    for (const t of ['tank', 'bullet', 'eagle', 'map', 'bundle']) {
      await click(cdp, `.shop-tab[data-tab="${t}"]`); await sleep(250);
      counts[t] = await cdp.ev('document.querySelectorAll(".shop-tile").length');
    }
    gate('mỗi tab có món', counts.tank >= 8 && counts.bullet === 6 && counts.eagle === 4 && counts.map === 5 && counts.bundle === 4, JSON.stringify(counts));
    await click(cdp, '.shop-tab[data-tab="bundle"]'); await sleep(200);
    gate('combo hiện giá gốc gạch ngang', await cdp.ev('!!document.querySelector(".shop-detail s")'));
    // xem trước: chọn map Neon -> canvas có màu nền neon (#0a0618), không đen tuyền
    await click(cdp, '.shop-tab[data-tab="map"]'); await sleep(150);
    await click(cdp, '.shop-tile[data-sku="tank.map.snow"]'); await sleep(300);
    const pv = await cdp.ev(`(() => { const c = document.getElementById('shopPreview'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let lit = 0, colors = new Set(); for (let i = 0; i < d.length; i += 16) { if (d[i] + d[i+1] + d[i+2] > 60) lit++; colors.add(d[i] >> 4 << 8 | d[i+1] >> 4 << 4 | d[i+2] >> 4); } return { lit, colors: colors.size, w: c.width }; })()`);
    gate('xem trước vẽ được (map Bão Tuyết)', pv.lit > 500 && pv.colors > 8, JSON.stringify(pv));
    await click(cdp, '.shop-tile[data-sku="tank.map.tet"]'); await sleep(150);
    const tet = await cdp.ev('(() => { const b = document.querySelector(".shop-detail .shop-buy"); return b ? { t: b.textContent, d: b.disabled } : null; })()');
    gate('Tết theo mùa: nút khoá "Mở bán"', tet && tet.d === true && /Mở bán/.test(tet.t), JSON.stringify(tet));
    await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync('/tmp/tank-shop-map.png', Buffer.from(r.data, 'base64')));

    // mua Rằn Ri Rừng qua sandbox
    await click(cdp, '.shop-tab[data-tab="tank"]'); await sleep(150);
    await click(cdp, '.shop-tile[data-sku="tank.skin.camo"]'); await sleep(150);
    await click(cdp, '.shop-detail .shop-buy[data-sku="tank.skin.camo"]');
    gate('tạo đơn: QR SePay + nút sandbox', await waitFor(cdp, '!!document.querySelector(".shop-qr") && !!document.getElementById("sbxConfirm") && /qr.sepay.vn/.test(document.querySelector(".shop-qr").src)'));
    await click(cdp, '#sbxConfirm');
    gate('thanh toán sandbox → "Trang bị ngay"', await waitFor(cdp, '!!document.getElementById("equipNow")', 10000));
    const ents1 = await cdp.ev('api("GET", "/v1/entitlements")');
    gate('cấp đồ đúng 1 lần', ents1.filter((x) => x === 'tank.skin.camo').length === 1, JSON.stringify(ents1));
    await click(cdp, '#equipNow');
    gate('Tủ đồ hiện món đang mặc', await waitFor(cdp, '[...document.querySelectorAll(".shop-slotrow")].some((r) => /Rằn Ri Rừng/.test(r.textContent))'));
    // mua thêm đạn Laser + trang bị từ nút Trang bị
    const o = await cdp.ev('api("POST", "/v1/orders", { sku: "tank.bullet.laser" })');
    await cdp.ev(`api("POST", "/v1/pay/sandbox/confirm", { orderId: ${JSON.stringify(o.orderId)} })`);
    await cdp.ev('openShop("bullet", "tank.bullet.laser")');
    await waitFor(cdp, '!!document.querySelector(".shop-equip[data-sku=\\"tank.bullet.laser\\"]")');
    await click(cdp, '.shop-equip[data-sku="tank.bullet.laser"]');
    gate('nút Trang bị → tile "đang dùng"', await waitFor(cdp, '/đang dùng/.test(document.querySelector(".shop-tile[data-sku=\\"tank.bullet.laser\\"]").textContent)'));
    await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync('/tmp/tank-shop-bullet.png', Buffer.from(r.data, 'base64')));

    // tải lại: vẫn sở hữu + vẫn trang bị
    await cdp.send('Page.reload');
    await waitFor(cdp, 'typeof arcade !== "undefined" && arcade && !!arcade.playerId', 10000);
    const lo = await cdp.ev('api("GET", "/v1/loadout")');
    gate('tải lại trang: đồ + trang bị còn nguyên', lo.tank === 'tank.skin.camo' && lo.bullet === 'tank.bullet.laser', JSON.stringify(lo));
    const js = cdp.jsErrors();
    gate('0 lỗi JS', js.length === 0, js.length ? JSON.stringify(js[0]).slice(0, 300) : 'sạch');

    // vào phòng: người thứ 2 thấy skin + đạn
    await cdp.ev(`document.getElementById('nameInput').value = 'Shopper'`);
    await click(cdp, '#createBtn');
    await waitFor(cdp, 'typeof myRoom === "string" && myRoom.length === 4', 10000);
    const code = await cdp.ev('myRoom');
    const jr = await fetch(URL + 'v1/rooms/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) }).then((r) => r.json());
    gate('phòng tồn tại: ' + code, !!jr.wsUrl, JSON.stringify(jr));
    b = bot(code); await b.ready; await sleep(600);
    gate('đồng đội thấy skin + đạn của mình', b.state && b.state.cos && b.state.cos['0'] && b.state.cos['0'].tank === 'tank.skin.camo' && b.state.cos['0'].bullet === 'tank.bullet.laser', JSON.stringify(b.state && b.state.cos));
    // bỏ trang bị đạn giữa phòng -> phòng cập nhật
    await cdp.ev('api("PUT", "/v1/loadout", { slot: "bullet", sku: null, room: myRoom })'); await sleep(600);
    gate('bỏ trang bị giữa phòng → đồng đội thấy ngay', b.state.cos['0'] && !b.state.cos['0'].bullet && b.state.cos['0'].tank === 'tank.skin.camo', JSON.stringify(b.state.cos));
    b.ws.send(JSON.stringify({ t: 'msg', n: 'cos', d: { cos: { tank: 'tank.skin.dragon' } } })); await sleep(400);
    gate('client không tự đặt cosmetic', !b.state.cos['1'], JSON.stringify(b.state.cos));
    gate('trang vẽ theo cos của phòng', await cdp.ev('cosBySlot[0] && cosBySlot[0].tank === "tank.skin.camo"'));
  } catch (e) { gate('không lỗi harness', false, e.message); }
  finally { try { b && b.ws.close(); } catch (e) { /* */ } chrome.kill(); }
  console.log(fails ? `\n❌ ${fails} cổng fail` : '\n✅ shop playtest pass');
  process.exit(fails ? 1 : 0);
})();
