
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
  config: { tickRate: TICK_HZ, maxPlayers: 4 },

  initialState: function () {
    return {
      // dims thay cho message 'hello' của server cũ: client cần TILE/COLS/ROWS
      // để dựng canvas. Nằm trong state nên chỉ tốn băng thông đúng một lần.
      dims: { tile: TILE, cols: COLS, rows: ROWS },
      tick: 0, stage: 1, status: 'lobby', frozen: 0, enemiesLeft: 0, friendlyFire: true,
      tanks: {}, bullets: {}, players: {}, powerups: [], skins: {}, cos: {}, roomCos: { eagle: null, map: null },
      base: { x: 0, y: 0, alive: true },
      map: game.fullMap(),
    };
  },

  // opts của rooms.create(mode, opts): cho phép tạo phòng với { friendlyFire: false }
  onCreate: function (room, opts) {
    if (opts && typeof opts.friendlyFire === 'boolean') game.friendlyFire = opts.friendlyFire;
    room.state.friendlyFire = game.friendlyFire;
  },

  onJoin: function (room, player) {
    var p = game.addPlayer(player.name);
    if (!p) { room.log('phòng đầy, engine từ chối ' + player.id); return; }
    slotOf[player.id] = p.slot;
    // player.cos (mới) hoặc player.skin (host cũ): chỉ nhận SKU đúng dạng của từng slot
    var c = cleanCos(player.cos || (player.skin ? { tank: player.skin } : null));
    if (Object.keys(c).length) cosOf[p.slot] = c; else delete cosOf[p.slot];
    room.send(player.id, 'you', { slot: p.slot, color: p.color });
    writeState(room);
  },

  onLeave: function (room, player) {
    var slot = slotOf[player.id];
    if (slot === undefined) return;
    game.removePlayer(slot);
    delete slotOf[player.id];
    delete cosOf[slot];
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
    } else if (type === 'skin' || type === 'cos') {
      // Host đổi cosmetic giữa trận (sau khi mua/trang bị). Chỉ host (DO) gửi được
      // loại này — client gửi 'msg' với n='skin'/'cos' sẽ bị DO chặn trước khi tới đây.
      if (player.trusted && d) {
        var nc = cleanCos(type === 'cos' ? d.cos : (d.skin ? { tank: d.skin } : null));
        if (Object.keys(nc).length) cosOf[slot] = nc; else delete cosOf[slot];
        writeState(room);
      }
    } else if (type === 'start') {
      if (game.status === 'waiting') game.startGame();
      else if (game.status === 'gameover') game.restart();
    }
  },

  onTick: function (room) {
    game.update();

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
