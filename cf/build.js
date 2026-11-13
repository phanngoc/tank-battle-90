#!/usr/bin/env node
/* Bọc server/room.js (sinh bởi server/build-room.js) thành một ES module factory cho
   Cloudflare Workers: mỗi Durable Object gọi makeRoomModule() một lần để có biến
   `game` riêng. Nhiều DO có thể dùng chung một isolate, nên KHÔNG được để `game`
   ở phạm vi module. Workers cấm eval/new Function nên không dùng vm như roomd.
   Chạy: node server/build-room.js && node cf/build.js */
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'room.js'), 'utf8');
const out = '/* TỰ SINH bởi cf/build.js từ server/room.js — đừng sửa tay. */\n' +
  'export function makeRoomModule() {\n' +
  '  var module = { exports: {} }, exports = module.exports;\n' +
  '  var console = { log() {}, warn() {}, error() {} };\n' +
  src + '\n  return module.exports;\n}\n';
fs.writeFileSync(path.join(__dirname, 'room-factory.mjs'), out);
console.log(`✓ cf/room-factory.mjs  ${(out.length / 1024).toFixed(1)}KB`);
