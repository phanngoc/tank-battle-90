#!/usr/bin/env node
/* Quét tỉ lệ thắng mọi màn × cấp (đều 5 chỉ số) và suy ra cấp khuyến nghị = cấp thấp nhất thắng ≥ 50%.
   node test/campaign-sweep.js [--trials 48] [--players 2] [--json out.json]
   Dùng SIM_HANDICAP của campaign-sim (mốc "người chơi trung bình"). */
'use strict';
const path = require('path');
const E = require(path.join(__dirname, '..', 'game.js'));
const { runOne } = require('./campaign-sim.js');
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }
const trials = +arg('trials', 48), np = +arg('players', 2);
const stages = arg('stages', Array.from({ length: E.CAMPAIGN_STAGES }, (_, i) => i + 1).join(',')).split(',').map(Number);
const rows = [];
console.log(`${np}P, ${trials} lượt/ô — % thắng theo cấp 1..10`);
for (const n of stages) {
  const w = [];
  for (let L = 1; L <= 10; L++) {
    let k = 0;
    for (let s = 0; s < trials; s++) if (runOne(n, L, np, 5000 + s * 7919 + n * 131 + L * 17).win) k++;
    w.push(Math.round(100 * k / trials));
  }
  const rec = w.findIndex(x => x >= 50) + 1 || null;
  rows.push({ stage: n, map: E.campaignStage(n).map, tableRec: E.campaignStage(n).rec, dataRec: rec, win: w });
  console.log(`màn ${String(n).padStart(2)} map${E.campaignStage(n).map} | ${w.map(x => String(x).padStart(3)).join(' ')} | rec bảng ${E.campaignStage(n).rec} · dữ liệu ${rec ?? '—'}`);
}
const out = arg('json', null); if (out) require('fs').writeFileSync(out, JSON.stringify({ players: np, trials, rows }, null, 2));
