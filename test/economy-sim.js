#!/usr/bin/env node
/* Mô phỏng kinh tế Chiến dịch: người free tới màn N sau bao nhiêu ngày, so với người nạp max.
   node test/economy-sim.js <sweep.json> [--runs 3] [--json out.json]
   - sweep.json: kết quả test/campaign-sweep.js (win[L-1] = % thắng màn ở cấp L, 2 người)
   - Mỗi ngày chơi `runs` lượt. Chiến lược: nâng đều 5 chỉ số khi đủ gold; thử màn kế tiếp khi
     cấp ≥ cấp khuyến nghị của màn đó, ngược lại chơi lại màn cao nhất đã qua để kiếm gold.
   - Thưởng = REWARDS (khớp cf/progression.mjs). Nạp max = +15.000 gold/tuần từ 💎 (trần tuần).
   Kỳ vọng (không random): mỗi lượt cộng gold kỳ vọng, màn kế được qua khi xác suất tích luỹ ≥ 1. */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require(path.join(__dirname, '..', 'game.js'));
const REWARDS = { kill: 2, killsPerRun: 12, firstClear: n => 100 + 20 * n, replay: n => 40 + 8 * n, loss: 10, firstWinDay: 200, dailyCap: 1000 };
const GEM_WEEK_GOLD = 15000;

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; }
const sweep = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const runsPerDay = +arg('runs', 3);
const byStage = Object.fromEntries(sweep.rows.map(r => [r.stage, r]));
const recOf = n => E.campaignStage(n).rec;
// sweep.json (win[]) hoặc campaign-verify.json (winL1 + winAtSuggest ở cấp khuyến nghị; cấp cao hơn coi như bằng — bảo thủ)
const win = (n, L) => { const r = byStage[n]; if (!r) return 0.5;
  if (r.win) return r.win[L - 1] / 100;
  return (L >= r.suggest ? r.winAtSuggest : r.winL1) / 100; };
const levelCost = L => 5 * E.UPGRADE_COST[L];             // nâng đều 5 chỉ số lên cấp L

function simulate(payer, maxDays = 400) {
  let gold = 0, L = 1, cleared = 0, day = 0, progress = 0;
  const reachDay = {};
  while (cleared < E.CAMPAIGN_STAGES && day < maxDays) {
    day++;
    if (payer && day % 7 === 1) gold += GEM_WEEK_GOLD;
    let match = 0, firstWin = false;
    for (let r = 0; r < runsPerDay; r++) {
      const next = cleared + 1;
      const tryNext = L >= recOf(next) || cleared === 0;
      const n = tryNext ? next : cleared;
      const p = win(n, L);
      let g = REWARDS.kill * REWARDS.killsPerRun * (p + 0.5 * (1 - p));
      if (tryNext) {
        progress += p;
        g += p * REWARDS.firstClear(n) + (1 - p) * REWARDS.loss;
        if (progress >= 1) { progress = 0; cleared = next; reachDay[next] = day; }
      } else g += p * REWARDS.replay(n) + (1 - p) * REWARDS.loss;
      if (!firstWin && p > 0) { gold += REWARDS.firstWinDay * Math.min(1, p * runsPerDay); firstWin = true; }
      const add = Math.min(g, REWARDS.dailyCap - match); match += add; gold += add;
      while (L < E.UPGRADE_MAX && gold >= levelCost(L + 1)) { gold -= levelCost(L + 1); L++; }
    }
  }
  return { reachDay, finalLevel: L, days: day };
}
const free = simulate(false), pay = simulate(true);
console.log(`màn | rec | free (${runsPerDay} lượt/ngày) | nạp max`);
const rows = [];
for (let n = 1; n <= E.CAMPAIGN_STAGES; n++) {
  rows.push({ stage: n, rec: recOf(n), freeDay: free.reachDay[n] ?? null, payDay: pay.reachDay[n] ?? null });
  console.log(`${String(n).padStart(3)} | ${String(recOf(n)).padStart(3)} | ${String(free.reachDay[n] ?? '—').padStart(5)} | ${String(pay.reachDay[n] ?? '—').padStart(5)}`);
}
const out = arg('json', null); if (out) fs.writeFileSync(out, JSON.stringify({ runsPerDay, REWARDS: 'see file', rows }, null, 2));
