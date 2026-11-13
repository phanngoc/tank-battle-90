import WebSocket from 'ws';
const B = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const req = async (m, p, body, tok) => { const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, b: await r.json() }; };
const ok = (n, c, d) => { console.log((c ? '✅ ' : '❌ ') + n + (d ? ' — ' + d : '')); if (!c) process.exitCode = 1; };
const ws = (url, tok, first) => new Promise((res) => { const w = new WebSocket(url); const st = { w, state: null }; w.on('open', () => { w.send(JSON.stringify({ t: 'hello', token: tok, v: 1 })); w.send(JSON.stringify(first)); }); w.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'welcome') { st.code = m.code; res(st); } if (m.t === 'snap') st.state = m.s; }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const host = (await req('POST', '/v1/auth/guest', {})).b, guest = (await req('POST', '/v1/auth/guest', {})).b;
ok('guest token ký', /^a\./.test(host.accessToken));
ok('orders cần auth', (await req('POST', '/v1/orders', { sku: 'tank.skin.gold' })).s === 401);
const shop = (await req('GET', '/v1/shop', null, host.accessToken)).b; ok('shop 4 SKU', shop.length === 4, shop.map((x) => x.sku + ':' + x.price).join(' '));
for (const sku of ['tank.skin.gold', 'tank.room.festival']) {
  const o = (await req('POST', '/v1/orders', { sku }, host.accessToken)).b;
  ok('order ' + sku, /^ARC/.test(o.code) && o.sandbox === true && o.qr.imageUrl.includes('img.vietqr.io'), o.code + ' ' + o.amount);
  ok('pending', (await req('GET', '/v1/orders/' + o.orderId, null, host.accessToken)).b.status === 'pending');
  const c = await req('POST', '/v1/pay/sandbox/confirm', { orderId: o.orderId }, host.accessToken); ok('sandbox confirm', c.b.granted === sku, JSON.stringify(c.b));
  ok('paid', (await req('GET', '/v1/orders/' + o.orderId, null, host.accessToken)).b.status === 'paid');
}
const forged = await req('POST', '/v1/pay/webhook', { data: { orderCode: 'ARCAAAAAAAA', amount: 1 }, signature: 'deadbeef' }); ok('webhook chữ ký giả 401', forged.s === 401);
ok('entitlements', JSON.stringify((await req('GET', '/v1/entitlements', null, host.accessToken)).b.sort()) === JSON.stringify(['tank.room.festival', 'tank.skin.gold']));
// phòng thường: host thấy skin gold, guest không có
let pick = (await req('POST', '/v1/rooms/pick', {})).b.wsUrl;
const A = await ws(pick, host.accessToken, { t: 'create', mode: 'coop', name: 'Host' });
const G = await ws(pick, guest.accessToken, { t: 'join', code: A.code, name: 'Guest' });
await sleep(500); ok('phòng thường: skin host=gold, guest không', JSON.stringify(A.state.skins) === '{"0":"tank.skin.gold"}', JSON.stringify(A.state.skins));
A.w.close(); G.w.close();
// phòng lễ hội: cả hai đều festival, tiêu 1 lượt
pick = (await req('POST', '/v1/rooms/pick', {})).b.wsUrl;
const F = await ws(pick, host.accessToken, { t: 'create', mode: 'coop', opts: { festival: true }, name: 'Host' });
const F2 = await ws(pick, guest.accessToken, { t: 'join', code: F.code, name: 'Guest' });
const F3 = await ws(pick, undefined, { t: 'join', code: F.code, name: 'Anon' });
await sleep(500); ok('phòng lễ hội: cả 3 người festival', Object.values(F.state.skins).filter((s) => s === 'tank.room.festival').length === 3 && F.state.festival === true, JSON.stringify(F.state.skins));
ok('lượt lễ hội đã tiêu', !(await req('GET', '/v1/entitlements', null, host.accessToken)).b.includes('tank.room.festival'));
F.w.send(JSON.stringify({ t: 'msg', n: 'skin', d: { skin: 'tank.skin.gold' } }));
await sleep(300); ok('client không tự đặt skin', F.state.skins['0'] === 'tank.room.festival');
for (const s of [F, F2, F3]) s.w.close();
process.exit();
