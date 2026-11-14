/* Mode Chuẩn = game hiện tại y nguyên.
   Chạy engine với Math.random có seed + điều khiển kịch bản cố định, băm toàn bộ snapshot mỗi tick,
   so với băm đã ghi từ main 6cbdbba (trước khi thêm progression). Đổi engine làm lệch 1 tick là fail.
   Ghi lại băm (chỉ khi CỐ Ý đổi luật Chuẩn): UPDATE_SNAPSHOT=1 npm test */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FIX = path.join(__dirname, 'fixtures', 'standard-trace.json');

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function trace(seed, nPlayers, ticks) {
  const orig = Math.random; Math.random = mulberry32(seed);
  try {
    delete require.cache[require.resolve('../game.js')];
    const { Game } = require('../game.js');
    const g = new Game();
    for (let i = 0; i < nPlayers; i++) g.addPlayer('P' + i);
    if (g.status === 'waiting') g.startGame();
    const h = crypto.createHash('sha256');
    for (let t = 0; t < ticks; t++) {
      for (const p of g.players.values()) {
        const k = (t + p.slot * 37) % 120;
        p.ctrl.moving = k < 90; p.ctrl.dir = ((t / 120 | 0) + p.slot) % 4; p.ctrl.fire = k % 3 === 0;
      }
      g.update();
      const s = g.snapshot();
      h.update(JSON.stringify(s));
      if (g.status === 'gameover') { g.restart(); h.update('restart'); }
    }
    return h.digest('hex');
  } finally { Math.random = orig; }
}

const CASES = [[1, 1, 4000], [7, 2, 4000], [42, 4, 4000]];

test('mode Chuẩn: snapshot từng tick khớp engine gốc (main 6cbdbba)', () => {
  const got = Object.fromEntries(CASES.map(([s, n, k]) => [`seed${s}-p${n}-t${k}`, trace(s, n, k)]));
  if (process.env.UPDATE_SNAPSHOT || !fs.existsSync(FIX)) { fs.writeFileSync(FIX, JSON.stringify(got, null, 2) + '\n'); return; }
  assert.deepEqual(got, JSON.parse(fs.readFileSync(FIX, 'utf8')));
});
