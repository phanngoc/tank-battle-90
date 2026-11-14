
// ═══════════════════════════════════════════════════════════════════════════
// Arcade room module — nối engine game.js ở trên vào platform.
//
// Tất cả những gì server.js từng tự làm (HTTP tĩnh, WebSocket, sổ phòng, sinh
// mã phòng, thu hồi phòng trống, vòng lặp setInterval, broadcast) đều do
// platform lo. File này chỉ còn ánh xạ engine <-> hợp đồng room module.
//
// Ba quyết định khi port, đáng ghi lại:
//
// 1. TANKS/BULLETS THÀNH OBJECT THEO ID, KHÔNG PHẢI ARRAY.
//    Platform diff mảng theo CHỈ SỐ (không LCS, vì LCS mỗi tick ở 30Hz quá đắt).
//    Đạn bị xoá ở GIỮA mảng làm mọi phần tử sau nó dịch chỗ -> patch to bằng cả
//    mảng. Đổi sang object keyed-by-id thì xoá một viên đạn = một op `delete`.
//    Đây chính là điều tài liệu dặn: "giữ thứ tự mảng ổn định, hoặc dùng object".
//
// 2. events/mapDelta/effects KHÔNG nằm trong state.
//    Chúng chỉ tồn tại một tick. Nhét vào state thì mỗi tick sinh 2 op (thêm rồi
//    xoá) cho thứ không phải state. Gửi bằng room.broadcast() đúng bản chất hơn.
//
// 3. Bản đồ đầy đủ gửi khi đổi màn, không nằm trong state mỗi tick.
// ═══════════════════════════════════════════════════════════════════════════

var game = new Game();            // mỗi phòng một sandbox -> biến này là của riêng phòng
var slotOf = {};                  // playerId -> slot
var lastStageKey = '';
// Mỹ phẩm chỉ là TRÌNH BÀY. Không bao giờ chạm vào `game` (engine), nên chỉ số
// xe (tốc độ, đạn, máu, hitbox) giống hệt dù có hay không có cosmetic.
// Host (DO trên CF) đọc entitlement + Tủ đồ rồi đưa vào player.cos khi join.
//   tank/bullet: của từng người (đồng đội thấy)   eagle/map: của phòng, theo chủ phòng
var COS_RE = {
  tank: /^tank\.(skin\.[a-z]+|pass\.coop|room\.festival)$/,
  bullet: /^tank\.bullet\.[a-z]+$/,
  eagle: /^tank\.eagle\.[a-z]+$/,
  map: /^tank\.map\.[a-z]+$/,
};
var cosOf = {};                   // slot -> { tank, bullet, eagle, map }

// ── Progression (mode Chiến dịch) ─────────────────────────────────────────────
// levelsOf: cấp 5 chỉ số do HOST (DO, đọc D1) đưa vào lúc join — không bao giờ lấy từ client.
// Mode Chuẩn: p.levels luôn bị xoá -> engine chạy y như game gốc.
var levelsOf = {};                // slot -> {move,rof,bspeed,power,armor}
var killsOf = {};                 // slot -> số địch hạ trong lượt hiện tại
var runSeq = 0, runStatus = '';   // để phát kết quả lượt đúng 1 lần mỗi lần vào campaignclear/gameover
// Đếm hạ địch theo slot mà không sửa game.js: bọc damageEnemy của RIÊNG instance này.
var _damageEnemy = game.damageEnemy;
game.damageEnemy = function (t, b) {
  var was = t.dead;
  _damageEnemy.call(this, t, b);
  if (!was && t.dead && b) {
    var ot = this.tanks.find(function (k) { return k.id === b.ownerId; });
    if (ot && ot.kind === 'player' && ot.slot !== undefined) killsOf[ot.slot] = (killsOf[ot.slot] || 0) + 1;
  }
};
function applyLevels() {
  game.players.forEach(function (p) {
    if (game.mode === 'campaign' && levelsOf[p.slot]) p.levels = cleanLevels(levelsOf[p.slot]);
    else delete p.levels;
  });
}
function setMode(mode, n) {
  if (mode === 'standard' || mode === 'campaign') game.mode = mode;
  if (typeof n === 'number' && isFinite(n)) game.campaignN = Math.max(1, Math.min(CAMPAIGN_STAGES, n | 0));
  applyLevels();
}

function cleanCos(c) {
  var out = {};
  if (!c || typeof c !== 'object') return out;
  for (var k in COS_RE) if (typeof c[k] === 'string' && COS_RE[k].test(c[k])) out[k] = c[k];
  return out;
}
function hostSlot() {
  var m = 99;
  game.players.forEach(function (q) { if (q.slot < m) m = q.slot; });
  return m;
}

function writeState(room) {
  var s = game.snapshot();
  var st = room.state;

  st.tick = s.tick;
  st.stage = s.stage;
  st.status = s.status;
  st.frozen = s.frozen;
  st.enemiesLeft = s.enemiesLeft;
  st.base = s.base;
  st.friendlyFire = s.friendlyFire;
  st.mode = game.mode;
  st.campaignN = game.campaignN;

  // keyed-by-id: xoá một thực thể = một op delete, không dịch cả mảng
  var tanks = {}, i;
  for (i = 0; i < s.tanks.length; i++) tanks[s.tanks[i].id] = s.tanks[i];
  st.tanks = tanks;

  var bullets = {};
  for (i = 0; i < s.bullets.length; i++) bullets[s.bullets[i].id] = s.bullets[i];
  st.bullets = bullets;

  var players = {};
  for (i = 0; i < s.players.length; i++) players[s.players[i].slot] = s.players[i];
  st.players = players;

  // skins: chỉ skin xe (client cũ đọc cái này). cos: xe + đạn theo slot. roomCos: map + đại bàng của chủ phòng.
  var skins = {}, cos = {};
  for (var k in cosOf) {
    var c = cosOf[k], e = {};
    if (c.tank) { skins[k] = c.tank; e.tank = c.tank; }
    if (c.bullet) e.bullet = c.bullet;
    if (e.tank || e.bullet) cos[k] = e;
  }
  st.skins = skins;
  st.cos = cos;
  var h = cosOf[hostSlot()] || {};
  st.roomCos = { eagle: h.eagle || null, map: h.map || null };

  st.powerups = s.powerups;       // ít và thay đổi thưa -> để mảng là ổn

  // Thứ chỉ sống một tick thì gửi làm event, không đưa vào state
  if (s.events && s.events.length) room.broadcast('fx', s.events);
  if (s.mapDelta && s.mapDelta.length) room.broadcast('mapDelta', s.mapDelta);
  if (s.effects && s.effects.length) room.broadcast('effects', s.effects);
}

module.exports = {
  // Hằng số engine cho Worker (cf/progression.mjs) — một nguồn duy nhất là game.js
  progression: { UPGRADE_STATS: UPGRADE_STATS, UPGRADE_MAX: UPGRADE_MAX, UPGRADE_COST: UPGRADE_COST,
    CAMPAIGN_STAGES: CAMPAIGN_STAGES, campaignStage: campaignStage, cleanLevels: cleanLevels },
  config: { tickRate: TICK_HZ, maxPlayers: 4 },

  initialState: function () {
    return {
      // dims thay cho message 'hello' của server cũ: client cần TILE/COLS/ROWS
      // để dựng canvas. Nằm trong state nên chỉ tốn băng thông đúng một lần.
      dims: { tile: TILE, cols: COLS, rows: ROWS },
      tick: 0, stage: 1, status: 'lobby', frozen: 0, enemiesLeft: 0, friendlyFire: true,
      tanks: {}, bullets: {}, players: {}, powerups: [], skins: {}, cos: {}, roomCos: { eagle: null, map: null },
      base: { x: 0, y: 0, alive: true }, mode: 'standard', campaignN: 1,
      map: game.fullMap(),
    };
  },

  // opts của rooms.create(mode, opts): cho phép tạo phòng với { friendlyFire: false }
  onCreate: function (room, opts) {
    if (opts && typeof opts.friendlyFire === 'boolean') game.friendlyFire = opts.friendlyFire;
    room.state.friendlyFire = game.friendlyFire;
    // mode/campaignN: host (DO) đã kiểm cờ PROGRESSION_ON và màn đã mở trước khi đưa vào đây
    if (opts && (opts.mode || opts.campaignN)) setMode(opts.mode, opts.campaignN);
    room.state.mode = game.mode;
    room.state.campaignN = game.campaignN;
  },

  onJoin: function (room, player) {
    var p = game.addPlayer(player.name);
    if (!p) { room.log('phòng đầy, engine từ chối ' + player.id); return; }
    slotOf[player.id] = p.slot;
    // player.cos (mới) hoặc player.skin (host cũ): chỉ nhận SKU đúng dạng của từng slot
    var c = cleanCos(player.cos || (player.skin ? { tank: player.skin } : null));
    if (Object.keys(c).length) cosOf[p.slot] = c; else delete cosOf[p.slot];
    if (player.levels && typeof player.levels === 'object') levelsOf[p.slot] = cleanLevels(player.levels); else delete levelsOf[p.slot];
    killsOf[p.slot] = 0;
    applyLevels();
    room.send(player.id, 'you', { slot: p.slot, color: p.color });
    writeState(room);
  },

  onLeave: function (room, player) {
    var slot = slotOf[player.id];
    if (slot === undefined) return;
    game.removePlayer(slot);
    delete slotOf[player.id];
    delete cosOf[slot];
    delete levelsOf[slot];
    delete killsOf[slot];
  },

  onMessage: function (room, player, type, d) {
    var slot = slotOf[player.id];
    if (slot === undefined) return;
    var p = game.players.get(slot);
    if (!p) return;

    if (type === 'input') {
      // Input của client là DỮ LIỆU KHÔNG TIN ĐƯỢC. Chỉ nhận đúng 0..3;
      // engine dùng dir làm chỉ số vào DIR[] nên một giá trị lạ (âm, thập phân,
      // ngoài khoảng) làm engine ném lỗi và platform thu hồi cả phòng —
      // tức là một client hỏng đá văng cả trận của người khác.
      if (d) {
        if (d.dir === 0 || d.dir === 1 || d.dir === 2 || d.dir === 3) p.ctrl.dir = d.dir;
        if (typeof d.moving === 'boolean') p.ctrl.moving = d.moving;
        if (typeof d.fire === 'boolean') p.ctrl.fire = d.fire;
      }
    } else if (type === 'option') {
      // Tuỳ chọn phòng: chỉ đổi ngoài trận (phòng chờ / game over) và chỉ
      // người giữ slot nhỏ nhất (chủ phòng; tự chuyển khi chủ rời đi).
      if (game.status === 'playing' || game.status === 'stageclear') return;
      var minSlot = 99;
      game.players.forEach(function (q) { if (q.slot < minSlot) minSlot = q.slot; });
      if (slot !== minSlot) return;
      if (d && typeof d.friendlyFire === 'boolean') {
        game.friendlyFire = d.friendlyFire;
        writeState(room);
      }
      // mode/màn: DO lọc trước (cờ PROGRESSION_ON + màn ≤ max_cleared+1) rồi mới chuyển tới đây
      if (d && (d.mode === 'standard' || d.mode === 'campaign' || typeof d.campaignN === 'number')) {
        setMode(d.mode, d.campaignN);
        writeState(room);
      }
    } else if (type === 'skin' || type === 'cos') {
      // Host đổi cosmetic giữa trận (sau khi mua/trang bị). Chỉ host (DO) gửi được
      // loại này — client gửi 'msg' với n='skin'/'cos' sẽ bị DO chặn trước khi tới đây.
      if (player.trusted && d) {
        var nc = cleanCos(type === 'cos' ? d.cos : (d.skin ? { tank: d.skin } : null));
        if (Object.keys(nc).length) cosOf[slot] = nc; else delete cosOf[slot];
        writeState(room);
      }
    } else if (type === 'levels') {
      // Host đổi cấp giữa chừng (sau khi nâng cấp). Chỉ host (DO) gửi được; áp dụng từ lần spawn kế.
      if (player.trusted && d && d.levels && typeof d.levels === 'object') {
        levelsOf[slot] = cleanLevels(d.levels);
        if (game.status !== 'playing' && game.status !== 'stageclear') applyLevels();
      }
    } else if (type === 'start') {
      if (game.status === 'waiting') game.startGame();
      else if (game.status === 'gameover' || game.status === 'campaignclear') { applyLevels(); game.restart(); }
    }
  },

  onTick: function (room) {
    var before = game.status;
    if (before === 'playing' && runStatus !== 'playing') {    // lượt mới bắt đầu
      runStatus = 'playing'; runSeq++;
      for (var ks in killsOf) killsOf[ks] = 0;
    }
    game.update();
    if (game.status !== before && (game.status === 'campaignclear' || game.status === 'gameover')) {
      runStatus = game.status;
      if (game.mode === 'campaign') {
        // Hợp đồng sự kiện kết quả lượt -> host (DO) ghi thưởng (idempotent theo runId:player)
        var kills = {}, slots = {};
        for (var pid in slotOf) { var sl = slotOf[pid]; kills[sl] = killsOf[sl] || 0; slots[sl] = pid; }
        var ev = { runId: (room.code || 'ROOM') + '-' + runSeq + '-' + game.tick, mode: 'campaign', stage: game.campaignN,
          win: game.status === 'campaignclear', kills: kills, slots: slots };
        if (typeof room.runResult === 'function') { try { room.runResult(ev); } catch (e) { room.log('runResult ' + e); } }
        room.broadcast('runResult', ev);
      }
    }

    // Đổi màn -> đẩy bản đồ đầy đủ một lần, không gửi mỗi tick
    var key = game.stage + ':' + game.status;
    if (key !== lastStageKey) {
      lastStageKey = key;
      room.state.map = game.fullMap();
    }
    writeState(room);
  },

  onDispose: function (room) {
    // Nộp điểm cuối trận. Đi qua room server nên platform đánh dấu verified.
    // Chỉ mode Chuẩn lên BXH: Chiến dịch có cấp thật nên điểm không so được.
    if (game.mode !== 'standard') return;
    var vals = [];
    for (var id in slotOf) {
      var p = game.players.get(slotOf[id]);
      if (p && p.score > 0) vals.push([id, p.score]);
    }
    for (var i = 0; i < vals.length; i++) {
      room.leaderboard('alltime').submit(vals[i][0], vals[i][1]);
      room.leaderboard('daily').submit(vals[i][0], vals[i][1]);
    }
  },
};
