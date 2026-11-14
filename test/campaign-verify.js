#!/usr/bin/env node
/* Kiểm tiêu chí bảng màn bằng bot sim (2 người, mốc SIM_HANDICAP của campaign-sim):
     (a) ở cấp khuyến nghị CAMPAIGN_REC[n] đội thắng ≥ 50%
     (b) ở cấp 1, các màn 19–24 thắng < 15%
   Nếu (a) trượt, thử cấp cao hơn và in cấp đề xuất. Exit 1 nếu có tiêu chí trượt.
   node test/campaign-verify.js [--trials 80] [--players 2] [--json out.json] */
'use strict';
const path = require('path');
const E = require(path.join(__dirname, '..', 'game.js'));
const { runOne } = require('./campaign-sim.js');
function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }
const trials = +arg('trials', 80), np = +arg('players', 2);
const wr = (n, L) => { let k = 0; for (let s = 0; s < trials; s++) if (runOne(n, L, np, 90001 + s * 104729 + n * 613 + L * 37).win) k++; return Math.round(100 * k / trials); };
const rows = []; let fail = 0;
console.log(`${np}P, ${trials} lượt/ô`);
for (let n = 1; n <= E.CAMPAIGN_STAGES; n++) {
  const cs = E.campaignStage(n);
  const w1 = wr(n, 1);
  let rec = cs.rec, wRec = rec === 1 ? w1 : wr(n, rec), suggest = rec;
  while (wRec < 50 && suggest < E.UPGRADE_MAX) { suggest++; wRec = wr(n, suggest); }
  const okA = suggest === rec, okB = n < 19 || w1 < 15;
  if (!okA || !okB) fail++;
  rows.push({ stage: n, map: cs.map, d: cs.d, armorHp: cs.armorHp, hp: cs.hp, armorPct: cs.armorPct, fire: cs.fire, rec, winL1: w1, suggest, winAtSuggest: wRec });
  console.log(`màn ${String(n).padStart(2)} map${cs.map} d${cs.d.toFixed(2)} | rec ${String(rec).padStart(2)} | L1 ${String(w1).padStart(3)}% | ` +
    (okA ? `rec ${wRec}% ✓` : `rec trượt → đề xuất ${suggest} (${wRec}%)`) + (okB ? '' : '  ✗ L1 ≥15%'));
}
const out = arg('json', null); if (out) require('fs').writeFileSync(out, JSON.stringify({ players: np, trials, rows }, null, 2));
console.log(fail ? `${fail} màn trượt` : 'tất cả đạt'); process.exit(fail ? 1 : 0);
