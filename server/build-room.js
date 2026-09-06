#!/usr/bin/env node
/* Ghép game.js + server/room.part.js -> server/room.js
   Room module chạy trong sandbox không có require, nên engine phải nằm cùng file.
   Chạy lại mỗi khi sửa game.js: node server/build-room.js */
const fs = require('fs');
const path = require('path');
const dir = __dirname;
const engine = fs.readFileSync(path.join(dir, '..', 'game.js'), 'utf8')
  // Bỏ đoạn dual-environment ở cuối: sandbox không có window, và module.exports
  // của engine sẽ ghi đè export của room module.
  .replace(/\/\/ Dual environment[\s\S]*$/, '');
const wrapper = fs.readFileSync(path.join(dir, 'room.part.js'), 'utf8');
const out = '/* TỰ SINH bởi server/build-room.js — đừng sửa tay. */\n' + engine + wrapper;
fs.writeFileSync(path.join(dir, 'room.js'), out);
console.log(`✓ server/room.js  ${(out.length / 1024).toFixed(1)}KB`);
