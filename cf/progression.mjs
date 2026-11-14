/* Progression v2 (mode Chiến dịch) trên CF Worker: ví gold/💎, nâng 5 chỉ số, thưởng lượt.
   Mọi API sau cờ env PROGRESSION_ON (mặc định "false" -> 404 {error:'progression_off'}).
   Hằng số engine (giá nâng cấp, bảng màn) lấy từ game.js qua room module — một nguồn duy nhất.
   Bảng: migrations/0004_progression.sql. Mọi ghi tiền = 1 env.DB.batch (transaction):
   - idempotent qua UNIQUE(reason, ref) của currency_ledger (trùng -> lỗi -> cả batch rollback)
   - không âm qua CHECK(gold >= 0, gems >= 0) của wallets. */
import { makeRoomModule } from './room-factory.mjs';

export const ENGINE = makeRoomModule().progression;
const { UPGRADE_STATS, UPGRADE_MAX, UPGRADE_COST, CAMPAIGN_STAGES, campaignStage, cleanLevels } = ENGINE;

// ── bomclaw2 chỉnh ở đây ──────────────────────────────────────────────────────
export const REWARDS = {
  killGold: 2,               // mỗi xe địch hạ được
  firstClearBase: 100,       // thắng màn N LẦN ĐẦU: 100 + 20N
  firstClearPerStage: 20,
  replayBase: 40,            // thắng lại màn đã qua: 40 + 8N
  replayPerStage: 8,
  lossGold: 10,              // thua (base vỡ / hết mạng)
  firstWinDaily: 200,        // thắng đầu tiên trong ngày — NGOÀI trần
  dailyMatchCap: 1000,       // trần gold từ trận / ngày (giờ VN), gồm hạ địch + thắng/thua
  gemToGold: 100,            // 1💎 = 100 gold
  weeklyConvertCap: 15000,   // trần gold đổi từ 💎 / tuần ISO
  sandboxGrantMax: 1000,     // 💎 tối đa mỗi lần sandbox-grant (chỉ khi PAYMENTS_LIVE != true)
};

export const isOn = (env) => String(env.PROGRESSION_ON || 'false') === 'true';
const isLive = (env) => String(env.PAYMENTS_LIVE || '') === 'true';
const OFF = { status: 404, body: { error: 'progression_off' } };
const VN = 7 * 3600_000;

/** YYYY-MM-DD theo giờ VN */
export const vnDay = (now = Date.now()) => new Date(now + VN).toISOString().slice(0, 10);
/** YYYY-Www (ISO 8601) theo giờ VN */
export function isoWeek(now = Date.now()) {
  const d = new Date(now + VN); d.setUTCHours(0, 0, 0, 0);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow);                 // thứ Năm của tuần đó quyết định năm
  const y = d.getUTCFullYear();
  const wk = Math.ceil(((d - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(wk).padStart(2, '0')}`;
}

/** Gold một lượt TRƯỚC trần ngày. firstClear = thắng màn chưa từng qua. */
export function runGold({ stage, win, kills, firstClear }) {
  const R = REWARDS, n = Math.max(1, Math.min(CAMPAIGN_STAGES, stage | 0));
  const k = Math.max(0, kills | 0) * R.killGold;
  if (!win) return k + R.lossGold;
  return k + (firstClear ? R.firstClearBase + R.firstClearPerStage * n : R.replayBase + R.replayPerStage * n);
}

const one = (db, sql, ...a) => db.prepare(sql).bind(...a).first();
const isConflict = (e) => /UNIQUE|constraint/i.test(String(e && e.message || e));
const isCheck = (e) => /CHECK/i.test(String(e && e.message || e));
const ensureWallet = (db, pid, now) => db.prepare('INSERT OR IGNORE INTO wallets (player_id, gold, gems, updated_at) VALUES (?, 0, 0, ?)').bind(pid, now);
const ledger = (db, pid, cur, delta, reason, ref, now) =>
  db.prepare('INSERT INTO currency_ledger (player_id, currency, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(pid, cur, delta, reason, ref, now);

export async function levels(env, pid) {
  const lv = {};
  if (env.DB && pid) {
    const { results } = await env.DB.prepare('SELECT stat, level FROM tank_stats WHERE player_id = ?').bind(pid).all();
    for (const r of results || []) lv[r.stat] = r.level;
  }
  return cleanLevels(lv);
}
export async function maxCleared(env, pid) {
  if (!env.DB || !pid) return 0;
  const r = await one(env.DB, 'SELECT max_cleared FROM campaign_progress WHERE player_id = ?', pid);
  return r ? r.max_cleared : 0;
}
/** Màn cao nhất được vào: max_cleared + 1 (trần CAMPAIGN_STAGES). */
export async function unlockedStage(env, pid) { return Math.min(CAMPAIGN_STAGES, (await maxCleared(env, pid)) + 1); }

export async function progress(env, pid, now = Date.now()) {
  if (!isOn(env)) return OFF;
  const db = env.DB;
  const w = await one(db, 'SELECT gold, gems FROM wallets WHERE player_id = ?', pid);
  const day = await one(db, 'SELECT match_gold, first_win FROM daily_progress WHERE player_id = ? AND day = ?', pid, vnDay(now));
  const wk = await one(db, 'SELECT gold FROM weekly_gem_convert WHERE player_id = ? AND iso_week = ?', pid, isoWeek(now));
  const mc = await maxCleared(env, pid);
  const stages = [];
  for (let n = 1; n <= CAMPAIGN_STAGES; n++) stages.push({ n, rec: campaignStage(n).rec, cleared: n <= mc });
  return { status: 200, body: {
    wallet: { gold: w ? w.gold : 0, gems: w ? w.gems : 0 },
    levels: await levels(env, pid), maxLevel: UPGRADE_MAX, upgradeCost: UPGRADE_COST, stats: UPGRADE_STATS,
    maxCleared: mc, unlocked: Math.min(CAMPAIGN_STAGES, mc + 1), stages,
    today: { day: vnDay(now), gold: day ? day.match_gold : 0, cap: REWARDS.dailyMatchCap, firstWin: !!(day && day.first_win) },
    week: { isoWeek: isoWeek(now), converted: wk ? wk.gold : 0, cap: REWARDS.weeklyConvertCap },
    rewards: REWARDS, sandbox: !isLive(env),
  } };
}

export async function upgrade(env, pid, stat, now = Date.now()) {
  if (!isOn(env)) return OFF;
  if (!UPGRADE_STATS.includes(stat)) return { status: 400, body: { error: 'BAD_STAT' } };
  const db = env.DB;
  const cur = (await levels(env, pid))[stat];
  if (cur >= UPGRADE_MAX) return { status: 409, body: { error: 'MAX_LEVEL' } };
  const to = cur + 1, cost = UPGRADE_COST[to];
  const w = await one(db, 'SELECT gold FROM wallets WHERE player_id = ?', pid);
  if (!w || w.gold < cost) return { status: 409, body: { error: 'NOT_ENOUGH_GOLD', need: cost, gold: w ? w.gold : 0 } };
  try {
    await db.batch([
      ledger(db, pid, 'gold', -cost, 'upgrade', `${pid}:${stat}:${to}`, now),           // bấm 2 lần -> UNIQUE -> rollback
      db.prepare('UPDATE wallets SET gold = gold - ?, updated_at = ? WHERE player_id = ?').bind(cost, now, pid),  // CHECK gold>=0
      db.prepare('INSERT INTO tank_stats (player_id, stat, level) VALUES (?, ?, ?) ON CONFLICT(player_id, stat) DO UPDATE SET level = excluded.level')
        .bind(pid, stat, to),
    ]);
  } catch (e) {
    if (isCheck(e)) return { status: 409, body: { error: 'NOT_ENOUGH_GOLD', need: cost } };
    if (isConflict(e)) return { status: 409, body: { error: 'ALREADY_UPGRADED' } };
    throw e;
  }
  return progress(env, pid, now);
}

export async function convertGems(env, pid, gems, now = Date.now()) {
  if (!isOn(env)) return OFF;
  gems = Number(gems);
  if (!Number.isInteger(gems) || gems <= 0) return { status: 400, body: { error: 'BAD_AMOUNT' } };
  const db = env.DB, gold = gems * REWARDS.gemToGold, wk = isoWeek(now);
  const used = await one(db, 'SELECT gold FROM weekly_gem_convert WHERE player_id = ? AND iso_week = ?', pid, wk);
  const left = REWARDS.weeklyConvertCap - (used ? used.gold : 0);
  if (gold > left) return { status: 409, body: { error: 'WEEKLY_CAP', leftGold: left, maxGems: Math.floor(left / REWARDS.gemToGold) } };
  const w = await one(db, 'SELECT gems FROM wallets WHERE player_id = ?', pid);
  if (!w || w.gems < gems) return { status: 409, body: { error: 'NOT_ENOUGH_GEMS' } };
  const ref = `${pid}:${crypto.randomUUID()}`;
  try {
    await db.batch([
      ledger(db, pid, 'gems', -gems, 'convert', ref + ':gems', now),
      ledger(db, pid, 'gold', gold, 'convert', ref + ':gold', now),
      db.prepare('UPDATE wallets SET gems = gems - ?, gold = gold + ?, updated_at = ? WHERE player_id = ?').bind(gems, gold, now, pid),
      db.prepare('INSERT INTO weekly_gem_convert (player_id, iso_week, gold) VALUES (?, ?, ?) ON CONFLICT(player_id, iso_week) DO UPDATE SET gold = gold + excluded.gold')
        .bind(pid, wk, gold),
    ]);
  } catch (e) { if (isCheck(e)) return { status: 409, body: { error: 'NOT_ENOUGH_GEMS' } }; throw e; }
  return progress(env, pid, now);
}

/** Chỉ để test khi PAYMENTS_LIVE != true. KHÔNG có SKU 💎 bán thật. */
export async function sandboxGrant(env, pid, gems, now = Date.now()) {
  if (!isOn(env) || isLive(env)) return { status: 404, body: { error: isOn(env) ? 'NOT_FOUND' : 'progression_off' } };
  gems = Number(gems);
  if (!Number.isInteger(gems) || gems <= 0 || gems > REWARDS.sandboxGrantMax) return { status: 400, body: { error: 'BAD_AMOUNT' } };
  const db = env.DB;
  await db.batch([
    ensureWallet(db, pid, now),
    ledger(db, pid, 'gems', gems, 'sandbox', `${pid}:${crypto.randomUUID()}`, now),
    db.prepare('UPDATE wallets SET gems = gems + ?, updated_at = ? WHERE player_id = ?').bind(gems, now, pid),
  ]);
  return progress(env, pid, now);
}

/** Thưởng một người cho một lượt. DO gọi khi nhận sự kiện runResult của room module.
    Idempotent: ledger UNIQUE(reason='run', ref=runId:player) — gọi lại trả {duplicate:true}, không cộng lần 2. */
export async function awardRun(env, { runId, room, stage, win, kills, players }, pid, now = Date.now()) {
  if (!isOn(env) || !env.DB || !pid || !runId) return null;
  const db = env.DB, day = vnDay(now), ref = `${runId}:${pid}`;
  if (await one(db, "SELECT 1 AS x FROM currency_ledger WHERE reason = 'run' AND ref = ?", ref)) return { duplicate: true, gold: 0 };
  const mc = await maxCleared(env, pid);
  const d = await one(db, 'SELECT match_gold, first_win FROM daily_progress WHERE player_id = ? AND day = ?', pid, day);
  const firstClear = !!win && stage > mc;
  const raw = runGold({ stage, win, kills, firstClear });
  const match = Math.max(0, Math.min(raw, REWARDS.dailyMatchCap - (d ? d.match_gold : 0)));
  const bonus = win && !(d && d.first_win) ? REWARDS.firstWinDaily : 0;
  const gold = match + bonus;
  const stmts = [
    ledger(db, pid, 'gold', gold, 'run', ref, now),
    ensureWallet(db, pid, now),
    db.prepare('UPDATE wallets SET gold = gold + ?, updated_at = ? WHERE player_id = ?').bind(gold, now, pid),
    db.prepare(`INSERT INTO daily_progress (player_id, day, match_gold, first_win) VALUES (?, ?, ?, ?)
      ON CONFLICT(player_id, day) DO UPDATE SET match_gold = match_gold + excluded.match_gold, first_win = MAX(first_win, excluded.first_win)`)
      .bind(pid, day, match, win ? 1 : 0),
    db.prepare('INSERT OR IGNORE INTO runs (run_id, room, mode, stage, result, players_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(runId, room || null, 'campaign', stage, win ? 'win' : 'loss', JSON.stringify(players || null), now),
  ];
  if (firstClear) stmts.push(db.prepare(`INSERT INTO campaign_progress (player_id, max_cleared, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(player_id) DO UPDATE SET max_cleared = MAX(max_cleared, excluded.max_cleared), updated_at = excluded.updated_at`).bind(pid, stage, now));
  try { await db.batch(stmts); } catch (e) { if (isConflict(e)) return { duplicate: true, gold: 0 }; throw e; }
  return { duplicate: false, gold, match, bonus, raw, firstClear, capped: match < raw };
}
