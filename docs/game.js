'use strict';
/*
 * TANK BATTLE 90 - authoritative game engine (server side)
 * Original implementation. Grid-based tank combat, co-op vs AI, defend the base.
 *
 * Coordinate system:
 *   TILE = 16px terrain block. Field = 26x26 tiles = 416x416 logical px.
 *   Tanks are 32x32 (2x2 tiles). Movement is pixel-stepped with 8px turn-snap.
 */

const TILE = 16;
const COLS = 26;
const ROWS = 26;
const FIELD_W = COLS * TILE; // 416
const FIELD_H = ROWS * TILE;
const TANK = 32;
const TICK_HZ = 30;

// Tile types
const EMPTY = 0, BRICK = 1, STEEL = 2, WATER = 3, FOREST = 4, ICE = 5, BASE = 6, WALL = 9;

// Directions: 0=up 1=right 2=down 3=left
const DIR = [[0, -1], [1, 0], [0, 1], [-1, 0]];
const UP = 0, RIGHT = 1, DOWN = 2, LEFT = 3;

const PLAYER_COLORS = ['#f2d024', '#57c451', '#3fb7d6', '#e07b34']; // p1 yellow, p2 green, p3 cyan, p4 orange
const START_LIVES = 3;
const ENEMIES_PER_STAGE = 20;
const MAX_ACTIVE_ENEMIES = 4;
const BONUS_INDICES = [3, 10, 17]; // spawn order (0-based) that carries a power-up

const ENEMY_TEMPLATE = {
  basic: { speed: 1, hp: 1, bulletSpeed: 4, score: 100, fireProb: 0.020, tclass: 0 },
  fast:  { speed: 2, hp: 1, bulletSpeed: 4, score: 200, fireProb: 0.020, tclass: 1 },
  power: { speed: 1, hp: 1, bulletSpeed: 6, score: 300, fireProb: 0.050, tclass: 2 },
  armor: { speed: 1, hp: 4, bulletSpeed: 4, score: 400, fireProb: 0.030, tclass: 3 },
};

const POWERUP_TYPES = ['star', 'grenade', 'clock', 'shovel', 'tank', 'helmet'];

// --- Stage maps authored at 13x13 "big tile" resolution, each cell -> 2x2 small tiles.
// . empty  B brick  S steel  W water  T forest  I ice  E base(eagle)
const MAPS = [
  [
    '.............',
    '.BB.BBBBB.BB.',
    '.BB.B...B.BB.',
    '.BB.B...B.BB.',
    '....B.W.B....',
    'BB.BB.W.BB.BB',
    'BS.S..W..S.SB',
    'BB.BB...BB.BB',
    '....B...B....',
    '.BB.BBBBB.BB.',
    '.BB.......BB.',
    '....B.B.B....',
    '.....BEB.....',
  ],
  [
    '.............',
    '.SSSS.SSSS...',
    '.S..B.B..S...',
    '.S..B.B..S.WW',
    '....B.B....WW',
    'BBB.....BBB..',
    '..B.SSS.B....',
    'BBB.....BBB..',
    '....B.B....II',
    '.S..B.B..S.II',
    '.S..B.B..S...',
    '.SSSS.SSSS...',
    '.....BEB.....',
  ],
  [
    '.............',
    '.B.B.B.B.B.B.',
    '.B.B.B.B.B.B.',
    '.............',
    'BB.BB.BB.BB.B',
    '..........B..',
    '.TT.SS.SS.TT.',
    '..B..........',
    'B.BB.BB.BB.BB',
    '.............',
    '.B.B.B.B.B.B.',
    '.B.B.B.B.B.B.',
    '.....BEB.....',
  ],
];

const CH2TILE = { '.': EMPTY, 'B': BRICK, 'S': STEEL, 'W': WATER, 'T': FOREST, 'I': ICE, 'E': BASE };

// Player spawn positions (logical px), flanking the base at the bottom.
const PLAYER_SPAWN = [
  { x: 128, y: 384 }, // slot 0
  { x: 256, y: 384 }, // slot 1
  { x: 64,  y: 384 }, // slot 2
  { x: 320, y: 384 }, // slot 3
];
// Enemy spawn points (top row): left, center, right.
const ENEMY_SPAWN = [{ x: 0, y: 0 }, { x: 192, y: 0 }, { x: 384, y: 0 }];

// Base occupies small tiles cols 12-13, rows 24-25. Center px for AI targeting.
const BASE_CX = 13 * TILE;
const BASE_CY = 25 * TILE;

function clone2d(a) { return a.map(r => r.slice()); }

function buildGrid(mapIdx) {
  const big = MAPS[mapIdx % MAPS.length];
  const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(EMPTY));
  for (let br = 0; br < 13; br++) {
    for (let bc = 0; bc < 13; bc++) {
      const t = CH2TILE[big[br][bc]] ?? EMPTY;
      // expand to 2x2
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++)
          grid[br * 2 + dy][bc * 2 + dx] = t;
    }
  }
  return grid;
}

function buildQueue(stage) {
  const q = [];
  for (let i = 0; i < ENEMIES_PER_STAGE; i++) {
    const r = (i * 7 + stage * 3) % 10;
    let t;
    if (stage >= 3 && r < 2) t = 'armor';
    else if (r < 2) t = 'fast';
    else if (r < 4) t = 'power';
    else if (r >= 8) t = 'armor';
    else t = 'basic';
    q.push(t);
  }
  return q;
}

class Game {
  constructor() {
    this.idCounter = 1;
    this.tick = 0;
    this.players = new Map(); // slot -> player object
    this.status = 'lobby';    // lobby | playing | stageclear | gameover
    this.stage = 1;
    this.grid = buildGrid(0);
    this.tanks = [];
    this.bullets = [];
    this.powerups = [];
    this.effects = [];
    this.events = [];
    this.mapDelta = [];
    this.enemyQueue = [];
    this.spawnedCount = 0;
    this.spawnCooldown = 0;
    this.spawnPointIdx = 0;
    this.freezeUntil = 0;
    this.baseAlive = true;
    this.baseWalls = [];       // {c,r} tiles that are part of base defense
    this.baseSteelUntil = 0;
    this.stageClearAt = 0;
  }

  nextId() { return this.idCounter++; }
  emit(name) { this.events.push(name); }
  setTile(c, r, t) {
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return;
    if (this.grid[r][c] === t) return;
    this.grid[r][c] = t;
    this.mapDelta.push({ x: c, y: r, t });
  }

  // ---- lobby / players ----
  addPlayer(name) {
    let slot = -1;
    for (let s = 0; s < 4; s++) if (![...this.players.values()].some(p => p.slot === s)) { slot = s; break; }
    if (slot === -1) return null; // full
    const p = {
      slot, name: name || `P${slot + 1}`, color: PLAYER_COLORS[slot],
      lives: START_LIVES, level: 0, score: 0,
      ctrl: { dir: DOWN, moving: false, fire: false },
      tankId: null, respawnAt: 0, connected: true,
    };
    this.players.set(slot, p);
    if (this.status === 'lobby') {
      this.status = 'waiting';                        // first player waits in the room lobby
    } else if (this.status === 'waiting') {
      if (this.players.size >= 2) this.startGame();   // 2nd player arriving auto-starts the match
    } else if (this.status === 'playing') {
      this.spawnPlayer(p, true);                      // late joiner drops into the running match
    }
    // (stageclear: the player is spawned on the next loadStage)
    return p;
  }

  removePlayer(slot) {
    const p = this.players.get(slot);
    if (!p) return;
    if (p.tankId != null) {
      const t = this.tanks.find(k => k.id === p.tankId);
      if (t) t.dead = true;
    }
    this.players.delete(slot);
    // if nobody left, drop back to lobby
    if (this.players.size === 0) { this.status = 'lobby'; }
  }

  startGame() {
    this.stage = 1;
    for (const p of this.players.values()) { p.lives = START_LIVES; p.level = 0; p.score = 0; }
    this.loadStage(this.stage);
  }

  restart() {
    this.startGame();
  }

  loadStage(stage) {
    this.grid = buildGrid((stage - 1) % MAPS.length);
    this.mapDelta = [];
    this.tanks = [];
    this.bullets = [];
    this.powerups = [];
    this.effects = [];
    this.enemyQueue = buildQueue(stage);
    this.spawnedCount = 0;
    this.spawnCooldown = TICK_HZ; // 1s before first enemy
    this.spawnPointIdx = 0;
    this.freezeUntil = 0;
    this.baseAlive = true;
    this.baseSteelUntil = 0;
    this.status = 'playing';
    // detect base defensive walls (bricks near the eagle) for the shovel power-up
    this.baseWalls = [];
    for (let r = 22; r <= 25; r++)
      for (let c = 10; c <= 15; c++)
        if (this.grid[r][c] === BRICK) this.baseWalls.push({ c, r });
    // spawn player tanks
    for (const p of this.players.values()) { p.tankId = null; if (p.lives > 0) this.spawnPlayer(p, true); }
  }

  spawnPlayer(p, shield) {
    const pos = PLAYER_SPAWN[p.slot];
    const t = this.makePlayerTank(p, pos.x, pos.y);
    if (shield) { t.spawnUntil = this.tick + Math.round(TICK_HZ * 1.0); t.shieldUntil = this.tick + Math.round(TICK_HZ * 3.0); }
    this.tanks.push(t);
    p.tankId = t.id;
  }

  makePlayerTank(p, x, y) {
    const lvl = p.level;
    return {
      id: this.nextId(), kind: 'player', slot: p.slot, color: p.color,
      x, y, w: TANK, h: TANK, dir: UP, moving: false, speed: 2,
      bulletSpeed: lvl >= 1 ? 8 : 6, maxBullets: lvl >= 2 ? 2 : 1,
      canDestroySteel: lvl >= 3, fireCooldown: 8, cooldown: 0,
      hp: 1, spawnUntil: 0, shieldUntil: 0, dead: false, blocked: false,
    };
  }

  refreshPlayerTankStats(p) {
    const t = p.tankId != null ? this.tanks.find(k => k.id === p.tankId) : null;
    if (!t) return;
    t.bulletSpeed = p.level >= 1 ? 8 : 6;
    t.maxBullets = p.level >= 2 ? 2 : 1;
    t.canDestroySteel = p.level >= 3;
  }

  // ---- geometry ----
  tileAt(c, r) { if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return WALL; return this.grid[r][c]; }
  solidForTank(t) { return t === BRICK || t === STEEL || t === WATER || t === BASE || t === WALL; }

  rectHitsSolidTiles(x, y, w, h) {
    const c0 = Math.floor(x / TILE), c1 = Math.floor((x + w - 1) / TILE);
    const r0 = Math.floor(y / TILE), r1 = Math.floor((y + h - 1) / TILE);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++)
        if (this.solidForTank(this.tileAt(c, r))) return true;
    return false;
  }

  hitsOtherTank(self, x, y) {
    for (const t of this.tanks) {
      if (t === self || t.dead) continue;
      if (t.spawnUntil > this.tick) continue; // spawning tanks don't block
      if (x < t.x + t.w && x + self.w > t.x && y < t.y + t.h && y + self.h > t.y) return true;
    }
    return false;
  }

  setDir(tank, dir) {
    if (tank.dir === dir) return;
    const px = tank.x, py = tank.y;
    tank.dir = dir;
    if (dir === UP || dir === DOWN) tank.x = Math.round(tank.x / 8) * 8;
    else tank.y = Math.round(tank.y / 8) * 8;
    // guard: if snap pushes into a wall, revert
    if (this.rectHitsSolidTiles(tank.x, tank.y, tank.w, tank.h) || this.hitsOtherTank(tank, tank.x, tank.y)) {
      tank.x = px; tank.y = py;
    }
  }

  moveTank(tank) {
    if (!tank.moving) return 0;
    const [dx, dy] = DIR[tank.dir];
    let moved = 0;
    for (let s = 0; s < tank.speed; s++) {
      const nx = tank.x + dx, ny = tank.y + dy;
      if (this.rectHitsSolidTiles(nx, ny, tank.w, tank.h)) break;
      if (this.hitsOtherTank(tank, nx, ny)) break;
      tank.x = nx; tank.y = ny; moved++;
    }
    return moved;
  }

  // ---- firing ----
  fire(tank) {
    if (tank.cooldown > 0) return;
    const active = this.bullets.filter(b => b.ownerId === tank.id && !b.dead).length;
    if (active >= (tank.maxBullets || 1)) return;
    tank.cooldown = tank.fireCooldown || 12;
    const bw = 8, bh = 8;
    let bx = tank.x + tank.w / 2 - bw / 2;
    let by = tank.y + tank.h / 2 - bh / 2;
    const [dx, dy] = DIR[tank.dir];
    bx += dx * (tank.w / 2); by += dy * (tank.h / 2);
    this.bullets.push({
      id: this.nextId(), x: Math.round(bx), y: Math.round(by), w: bw, h: bh,
      dir: tank.dir, speed: tank.bulletSpeed, ownerId: tank.id, ownerKind: tank.kind,
      power: !!tank.canDestroySteel, dead: false,
    });
    this.emit('shoot');
  }

  // ---- spawning enemies ----
  activeEnemies() { return this.tanks.filter(t => t.kind === 'enemy' && !t.dead).length; }
  enemiesRemaining() { return this.enemyQueue.length + this.activeEnemies(); }

  trySpawnEnemy() {
    if (this.enemyQueue.length === 0) return;
    if (this.activeEnemies() >= MAX_ACTIVE_ENEMIES) return;
    if (this.spawnCooldown > 0) { this.spawnCooldown--; return; }
    const sp = ENEMY_SPAWN[this.spawnPointIdx % ENEMY_SPAWN.length];
    // don't spawn on top of an existing tank
    const occupied = this.tanks.some(t => !t.dead && Math.abs(t.x - sp.x) < TANK && Math.abs(t.y - sp.y) < TANK);
    if (occupied) { this.spawnCooldown = 8; return; }
    const type = this.enemyQueue.shift();
    const tpl = ENEMY_TEMPLATE[type];
    const isBonus = BONUS_INDICES.includes(this.spawnedCount);
    const speed = tpl.speed + (this.stage >= 4 ? 1 : 0);
    this.tanks.push({
      id: this.nextId(), kind: 'enemy', enemyType: type, tclass: tpl.tclass,
      x: sp.x, y: sp.y, w: TANK, h: TANK, dir: DOWN, moving: true, speed,
      bulletSpeed: tpl.bulletSpeed, fireProb: tpl.fireProb, fireCooldown: 20, cooldown: 0,
      hp: tpl.hp, maxHp: tpl.hp, score: tpl.score, bonus: isBonus,
      spawnUntil: this.tick + Math.round(TICK_HZ * 1.0), shieldUntil: 0,
      dead: false, blocked: false, aiTimer: 0,
    });
    this.spawnedCount++;
    this.spawnPointIdx++;
    this.spawnCooldown = Math.max(20, 70 - this.stage * 4);
    this.emit('spawn');
  }

  chooseEnemyDir(e) {
    if (Math.random() < 0.5) {
      const dx = BASE_CX - e.x, dy = BASE_CY - e.y;
      if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? RIGHT : LEFT;
      return dy > 0 ? DOWN : UP;
    }
    return (Math.random() * 4) | 0;
  }

  updateEnemyAI(e, frozen) {
    if (e.spawnUntil > this.tick) return;
    if (frozen) { e.moving = false; return; }
    e.moving = true;
    if (e.blocked || e.aiTimer <= 0 || Math.random() < 0.02) {
      this.setDir(e, this.chooseEnemyDir(e));
      e.aiTimer = 15 + ((Math.random() * 45) | 0);
    }
    e.aiTimer--;
    const moved = this.moveTank(e);
    e.blocked = moved === 0;
    if (Math.random() < e.fireProb) this.fire(e);
  }

  // ---- bullets ----
  bulletOverlapTiles(b) {
    const c0 = Math.floor(b.x / TILE), c1 = Math.floor((b.x + b.w - 1) / TILE);
    const r0 = Math.floor(b.y / TILE), r1 = Math.floor((b.y + b.h - 1) / TILE);
    const out = [];
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++)
        out.push({ c, r });
    return out;
  }

  updateBullet(b) {
    for (let s = 0; s < b.speed && !b.dead; s++) {
      b.x += DIR[b.dir][0]; b.y += DIR[b.dir][1];
      // out of bounds
      if (b.x < 0 || b.y < 0 || b.x + b.w > FIELD_W || b.y + b.h > FIELD_H) { b.dead = true; this.emit('hitSteel'); break; }
      let stop = false;
      for (const { c, r } of this.bulletOverlapTiles(b)) {
        const t = this.tileAt(c, r);
        if (t === BRICK) { this.setTile(c, r, EMPTY); stop = true; this.emit('hitBrick'); }
        else if (t === STEEL) { if (b.power) { this.setTile(c, r, EMPTY); this.emit('hitBrick'); } else { this.emit('hitSteel'); } stop = true; }
        else if (t === BASE) { this.destroyBase(); stop = true; }
      }
      if (stop) { b.dead = true; break; }
      // tank collisions
      if (this.bulletHitsTank(b)) { b.dead = true; break; }
    }
  }

  bulletHitsTank(b) {
    for (const t of this.tanks) {
      if (t.dead || t.id === b.ownerId) continue;
      if (t.kind === b.ownerKind) continue; // no friendly fire
      if (t.spawnUntil > this.tick) continue; // invulnerable while spawning
      if (b.x < t.x + t.w && b.x + b.w > t.x && b.y < t.y + t.h && b.y + b.h > t.y) {
        if (t.kind === 'player') this.damagePlayer(t);
        else this.damageEnemy(t, b);
        return true;
      }
    }
    return false;
  }

  damageEnemy(t, b) {
    t.hp--;
    if (t.hp > 0) { this.emit('hitSteel'); return; }
    // destroyed
    t.dead = true;
    this.effects.push({ id: this.nextId(), kind: 'boom', x: t.x + t.w / 2, y: t.y + t.h / 2, life: 12, born: this.tick });
    this.emit('explodeTank');
    // credit score
    const owner = this.players.get(this.tanks.find(k => k.id === b.ownerId)?.slot);
    if (owner) owner.score += t.score || 100;
    if (t.bonus) this.spawnPowerup(t.x, t.y);
  }

  damagePlayer(t) {
    if (t.shieldUntil > this.tick) return;
    t.dead = true;
    this.effects.push({ id: this.nextId(), kind: 'boom', x: t.x + t.w / 2, y: t.y + t.h / 2, life: 14, born: this.tick });
    this.emit('explodeTank');
    const p = this.players.get(t.slot);
    if (!p) return;
    p.tankId = null;
    p.lives--;
    if (p.lives > 0) p.respawnAt = this.tick + Math.round(TICK_HZ * 1.2);
  }

  destroyBase() {
    if (!this.baseAlive) return;
    this.baseAlive = false;
    this.effects.push({ id: this.nextId(), kind: 'bigboom', x: BASE_CX, y: BASE_CY, life: 24, born: this.tick });
    this.emit('explodeBase');
    this.status = 'gameover';
  }

  // ---- powerups ----
  spawnPowerup(x, y) {
    const type = POWERUP_TYPES[(Math.random() * POWERUP_TYPES.length) | 0];
    // keep it inside the field
    const px = Math.max(0, Math.min(FIELD_W - TANK, x));
    const py = Math.max(0, Math.min(FIELD_H - TANK, y));
    this.powerups.push({ id: this.nextId(), type, x: px, y: py, w: TANK, h: TANK, until: this.tick + Math.round(TICK_HZ * 18) });
    this.emit('powerup');
  }

  applyPowerup(pu, playerTank) {
    const p = this.players.get(playerTank.slot);
    this.emit('powerupPick');
    switch (pu.type) {
      case 'star':
        if (p && p.level < 3) { p.level++; this.refreshPlayerTankStats(p); this.emit('levelup'); }
        break;
      case 'grenade':
        for (const t of this.tanks) if (t.kind === 'enemy' && !t.dead) {
          t.dead = true;
          this.effects.push({ id: this.nextId(), kind: 'boom', x: t.x + t.w / 2, y: t.y + t.h / 2, life: 12, born: this.tick });
        }
        this.emit('explodeTank');
        break;
      case 'clock':
        this.freezeUntil = this.tick + Math.round(TICK_HZ * 8);
        this.emit('freeze');
        break;
      case 'shovel':
        for (const w of this.baseWalls) this.setTile(w.c, w.r, STEEL);
        this.baseSteelUntil = this.tick + Math.round(TICK_HZ * 15);
        break;
      case 'tank':
        if (p) p.lives++;
        break;
      case 'helmet':
        playerTank.shieldUntil = this.tick + Math.round(TICK_HZ * 10);
        break;
    }
  }

  checkPowerupPickup() {
    for (const pu of this.powerups) {
      if (pu.taken) continue;
      for (const t of this.tanks) {
        if (t.kind !== 'player' || t.dead) continue;
        if (pu.x < t.x + t.w && pu.x + pu.w > t.x && pu.y < t.y + t.h && pu.y + pu.h > t.y) {
          pu.taken = true;
          this.applyPowerup(pu, t);
          break;
        }
      }
    }
    this.powerups = this.powerups.filter(pu => !pu.taken && pu.until > this.tick);
  }

  // ---- main update ----
  update() {
    this.tick++;
    this.events = [];
    this.mapDelta = [];

    if (this.status === 'lobby' || this.status === 'waiting' || this.status === 'gameover') {
      return; // frozen; still broadcast for overlay/animation
    }

    if (this.status === 'stageclear') {
      if (this.tick >= this.stageClearAt) {
        this.stage++;
        this.loadStage(this.stage);
      }
      return;
    }

    const frozen = this.tick < this.freezeUntil;

    // shovel expiry -> revert base walls to brick
    if (this.baseSteelUntil && this.tick >= this.baseSteelUntil) {
      for (const w of this.baseWalls) this.setTile(w.c, w.r, BRICK);
      this.baseSteelUntil = 0;
    }

    // respawn players whose timer elapsed
    for (const p of this.players.values()) {
      if (p.tankId == null && p.lives > 0 && p.respawnAt && this.tick >= p.respawnAt) {
        this.spawnPlayer(p, true);
        p.respawnAt = 0;
      }
    }

    // player control -> tank
    for (const p of this.players.values()) {
      const t = p.tankId != null ? this.tanks.find(k => k.id === p.tankId) : null;
      if (!t || t.dead) continue;
      if (t.spawnUntil > this.tick) { t.moving = false; continue; }
      if (p.ctrl.moving) { this.setDir(t, p.ctrl.dir); t.moving = true; }
      else t.moving = false;
      this.moveTank(t);
      if (p.ctrl.fire) this.fire(t);
    }

    // enemies
    this.trySpawnEnemy();
    for (const e of this.tanks) if (e.kind === 'enemy' && !e.dead) this.updateEnemyAI(e, frozen);

    // cooldowns
    for (const t of this.tanks) if (t.cooldown > 0) t.cooldown--;

    // bullets
    for (const b of this.bullets) if (!b.dead) this.updateBullet(b);
    // bullet vs bullet
    for (let i = 0; i < this.bullets.length; i++) {
      const a = this.bullets[i]; if (a.dead) continue;
      for (let j = i + 1; j < this.bullets.length; j++) {
        const c = this.bullets[j]; if (c.dead) continue;
        if (a.x < c.x + c.w && a.x + a.w > c.x && a.y < c.y + c.h && a.y + a.h > c.y) { a.dead = true; c.dead = true; }
      }
    }
    this.bullets = this.bullets.filter(b => !b.dead);

    // powerups
    this.checkPowerupPickup();

    // effects age
    for (const e of this.effects) e.age = this.tick - e.born;
    this.effects = this.effects.filter(e => this.tick - e.born < e.life);

    // remove dead tanks
    this.tanks = this.tanks.filter(t => !t.dead);

    // win / lose
    if (this.baseAlive && this.enemyQueue.length === 0 && this.activeEnemies() === 0) {
      this.status = 'stageclear';
      this.stageClearAt = this.tick + Math.round(TICK_HZ * 3);
      return;
    }
    // all players out of lives and no active player tanks -> game over
    const anyAlive = this.tanks.some(t => t.kind === 'player');
    const anyLives = [...this.players.values()].some(p => p.lives > 0);
    if (!this.baseAlive) { /* already gameover */ }
    else if (!anyAlive && !anyLives && this.players.size > 0) {
      this.status = 'gameover';
      this.emit('explodeBase');
    }
  }

  // ---- serialization ----
  fullMap() { return this.grid.map(row => row.join('')); }

  snapshot() {
    const tanks = this.tanks.map(t => ({
      id: t.id, k: t.kind === 'player' ? 'p' : 'e', slot: t.slot ?? -1, c: t.color,
      x: t.x, y: t.y, d: t.dir,
      sp: t.spawnUntil > this.tick ? 1 : 0,
      sh: t.shieldUntil > this.tick ? 1 : 0,
      et: t.enemyType || '', tc: t.tclass ?? -1, bo: t.bonus ? 1 : 0,
      hp: t.hp, mh: t.maxHp || 1,
    }));
    const bullets = this.bullets.map(b => ({ id: b.id, x: b.x, y: b.y, d: b.dir }));
    const powerups = this.powerups.map(p => ({ t: p.type, x: p.x, y: p.y }));
    const effects = this.effects.map(e => ({ k: e.kind, x: e.x, y: e.y, a: this.tick - e.born, l: e.life }));
    const players = [...this.players.values()].map(p => ({
      slot: p.slot, name: p.name, color: p.color, lives: p.lives, level: p.level, score: p.score,
    })).sort((a, b) => a.slot - b.slot);
    return {
      t: 'state', tick: this.tick, stage: this.stage, status: this.status,
      frozen: this.tick < this.freezeUntil ? 1 : 0,
      tanks, bullets, powerups, effects, players,
      enemiesLeft: this.enemiesRemaining(),
      base: { x: BASE_CX, y: BASE_CY, alive: this.baseAlive },
      events: this.events, mapDelta: this.mapDelta,
    };
  }
}

// Dual environment: Node (server) via module.exports, browser (Pages demo) via window.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Game, TILE, COLS, ROWS, FIELD_W, FIELD_H, TICK_HZ };
}
if (typeof window !== 'undefined') {
  window.TankEngine = { Game, TILE, COLS, ROWS, FIELD_W, FIELD_H, TICK_HZ };
}
