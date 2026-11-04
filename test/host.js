/* host.js — nạp server/room.js giống roomd/src/sandbox.ts (vm context hẹp, không
   require) và giả lập object `room` mà platform đưa vào các hook.
   Dùng chung cho test/room.test.js và server giả trong test/playtest.js. */
'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOM_JS = path.join(__dirname, '..', 'server', 'room.js');

function loadModule() {
  const sandbox = {
    Math, JSON, Number, String, Boolean, Array, Object, Date: Object.freeze({ now: Date.now }),
    isNaN, isFinite, parseInt, parseFloat, structuredClone,
    console: { log() {}, warn() {}, error() {} },
    module: { exports: {} }, exports: {},
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(fs.readFileSync(ROOM_JS, 'utf8'), { filename: 'room.js' }).runInContext(ctx, { timeout: 1000 });
  return { mod: ctx.module.exports, ctx };
}

/** Một phòng chạy headless. out = mọi lệnh room.* mà module phát ra. */
function createRoom(opts) {
  const { mod, ctx } = loadModule();
  const out = [];
  const room = {
    code: 'TEST', tick: 0, players: [],
    state: mod.initialState ? mod.initialState() : {},
    broadcast(n, d) { out.push(['bc', n, d]); },
    send(id, n, d) { out.push(['snd', id, n, d]); },
    log() { out.push(['log', Array.prototype.join.call(arguments, ' ')]); },
    lock() {}, unlock() {}, dispose() {}, save() {},
    leaderboard(board) { return { submit(pid, score) { out.push(['score', board, pid, score]); } }; },
  };
  if (mod.onCreate) mod.onCreate(room, opts);
  let n = 0;
  const api = {
    mod, room, out, ctx,
    /** biến `game` của phòng (nằm trong vm context) — test đọc/chỉnh trực tiếp */
    get game() { return vm.runInContext('game', ctx); },
    join(name, isHost) {
      const p = { id: 'p' + (++n), name: name || ('P' + n), isHost: isHost == null ? n === 1 : isHost };
      mod.onJoin(room, p);
      return p;
    },
    leave(p) { mod.onLeave(room, p, 'left'); },
    msg(p, type, d) { mod.onMessage(room, p, type, d); },
    tick(k) { for (let i = 0; i < (k || 1); i++) { room.tick++; mod.onTick(room, 1 / 30); } },
  };
  return api;
}

module.exports = { loadModule, createRoom, ROOM_JS };
