/* Mode Chuẩn (BXH) không được đổi 1 tick nào so với main trước khi có súng.
   Chạy một trận kịch bản cố định (Math.random giả, input theo tick) và băm toàn bộ
   snapshot. EXPECTED lấy từ game.js của main 6cbdbba (trước Laser). Người chơi
   đang trang bị Laser vẫn phải ra đúng hash đó (= bắn đạn thường). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const EXPECTED = '8adc758182b8402accc8f93dbd71503f509c1c4a8cdfd520ade6fad7285f8bf1';

function runScripted(enginePath, setup) {
  const realRandom = Math.random;
  let seed = 12345;
  Math.random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
  try {
    delete require.cache[require.resolve(enginePath)];
    const { Game } = require(enginePath);
    const g = new Game();
    const a = g.addPlayer('A'); const b = g.addPlayer('B');
    if (setup) setup(g, a, b);
    const h = crypto.createHash('sha256');
    for (let i = 0; i < 1800; i++) {
      for (const p of [a, b]) {
        p.ctrl.dir = ((i / 45) | 0 + p.slot) % 4;
        p.ctrl.moving = (i % 90) < 70;
        p.ctrl.fire = (i % 7) === p.slot;
      }
      g.update();
      h.update(JSON.stringify(g.snapshot()));
    }
    return h.digest('hex');
  } finally { Math.random = realRandom; }
}
module.exports = { runScripted };

{
  const ENGINE = path.join(__dirname, '..', 'game.js');
  test('mode Chuẩn: snapshot 1800 tick khớp main', () => {
    assert.equal(runScripted(ENGINE), EXPECTED);
  });
  test('mode Chuẩn: người trang bị Laser vẫn bắn đạn thường (hash khớp main)', () => {
    assert.equal(runScripted(ENGINE, (g, a, b) => { g.setWeapon(a.slot, 'tank.bullet.laser'); g.setWeapon(b.slot, 'tank.bullet.laser'); }), EXPECTED);
  });
}
