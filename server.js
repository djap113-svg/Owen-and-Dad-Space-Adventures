/* ===========================================================================
   Owen and Dad Space Adventures - authoritative game server
   ---------------------------------------------------------------------------
   Two players, two devices, one shared vertically-scrolling battlefield.

   The server owns the truth: it runs the whole simulation (ships, enemies,
   bullets, waves, bosses, pickups) at a fixed tick and broadcasts compact
   snapshots. Clients only send which keys/touches are held, and draw what
   they're told. That keeps the two screens showing the same game even when
   one player is on wifi and the other is on a phone.
   =========================================================================== */

const path = require('path');
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname), { extensions: ['html'] }));
app.get('/healthz', (_req, res) => res.send('ok'));

/* --------------------------------------------------------------------------
   World constants. The playfield is portrait (taller than wide) so it works
   on a phone held upright and still looks right on a laptop.
   -------------------------------------------------------------------------- */
const W = 480, H = 720;
const TICK = 1 / 60;                 // simulation step
const SNAP_HZ = 20;                  // snapshots per second
const PLAYER_SPEED = 275;
const PLAYER_R = 15;                 // forgiving hitbox - smaller than the sprite
const START_LIVES = 3;
const MAX_HP = 100;
const RESPAWN_DELAY = 2.0;
const INVUL_TIME = 2.5;

let nextEntityId = 1;
const eid = () => nextEntityId++;
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* --------------------------------------------------------------------------
   Enemy catalogue. `r` is the collision radius, `w`/`h` are only used by the
   client for drawing. Keeping them here means one place to rebalance.
   -------------------------------------------------------------------------- */
const ENEMY = {
  grunt:  { hp: 1,  speed: 95,  r: 15, score: 100, fire: 0,    drop: 0.07 },
  scout:  { hp: 1,  speed: 185, r: 15, score: 150, fire: 2.4,  drop: 0.08 },
  drone:  { hp: 2,  speed: 75,  r: 15, score: 200, fire: 1.9,  drop: 0.10 },
  mine:   { hp: 2,  speed: 165, r: 15, score: 250, fire: 0,    drop: 0.09 },
  bomber: { hp: 9,  speed: 58,  r: 25, score: 500, fire: 1.6,  drop: 0.35 },
};

/* --------------------------------------------------------------------------
   Bosses. `halfW` is how far the sprite reaches sideways, so the boss is kept
   that far from the wall and never slides half off screen. `title` is what the
   WARNING banner announces.

   Each boss gets its own `move` and `fire` below in BOSS_AI, because a boss
   that only differs by artwork isn't really a new boss - the fight has to feel
   different.
   -------------------------------------------------------------------------- */
const BOSS = {
  hive:    { hp: 150, r: 58, score: 5000,  halfW: 96, title: 'HIVE MOTHER' },
  mech:    { hp: 220, r: 60, score: 7500,  halfW: 58, title: 'CENTURIAN MECH' },
  brain:   { hp: 300, r: 62, score: 10000, halfW: 80, title: 'MEGA BRAIN' },
  dread:   { hp: 330, r: 66, score: 12000, halfW: 99, title: 'DREADNOUGHT', homeY: 104 },
  kraken:  { hp: 360, r: 64, score: 14000, halfW: 72, title: 'THE KRAKEN' },
  walker:  { hp: 390, r: 66, score: 16000, halfW: 84, title: 'CORTEX WALKER', homeY: 116 },
  crystal: { hp: 400, r: 60, score: 18000, halfW: 82, title: 'CRYSTAL WARDEN', homeY: 132 },
  cthulhu: { hp: 420, r: 64, score: 22000, halfW: 78, title: 'VOID CTHULHU' },
};
const BOSS_ORDER = ['hive', 'mech', 'brain', 'dread', 'kraken', 'walker', 'crystal', 'cthulhu'];

const POWERUPS = ['double', 'rapid', 'shield'];

/* ==========================================================================
   Room
   ========================================================================== */
const rooms = new Map();

function getRoom(code) {
  code = String(code || 'OWEN').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'OWEN';
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      players: new Map(),
      enemies: [], bullets: [], ebullets: [], pickups: [], fx: [],
      state: 'lobby',          // lobby | playing | over
      wave: 0,
      waveKills: 0,
      spawnQueue: [],
      spawnTimer: 0,
      betweenWaves: 0,
      boss: null,
      starOffset: 0,
      snapAcc: 0,
      events: [],
      lastMsg: '',
      msgUntil: 0,
    });
  }
  return rooms.get(code);
}

function freeSlot(room) {
  const used = new Set([...room.players.values()].map(p => p.n));
  return used.has(1) ? (used.has(2) ? 1 + (room.players.size % 2) : 2) : 1;
}

function makePlayer(socket, room, name) {
  const n = freeSlot(room);
  return {
    id: socket.id, n, name: (name || `Player ${n}`).slice(0, 12),
    x: n === 1 ? W * 0.35 : W * 0.65, y: H - 110,
    hp: MAX_HP, lives: START_LIVES, score: 0, kills: 0,
    alive: true, respawnAt: 0, invulUntil: INVUL_TIME,
    weapon: 'basic', weaponUntil: 0, cooldown: 0,
    input: { ax: 0, ay: 0, f: 0 },
    ready: false, ping: 0,
  };
}

// Sound events. The server decides what happened, so both players hear the
// same things at the same moment. Capped so a chaotic frame can't bloat the
// snapshot; the queue is emptied every time a snapshot goes out.
function ev(room, ...a) {
  if (room.events.length < 28) room.events.push(a);
}

function say(room, text, secs = 2.5) {
  room.lastMsg = text;
  room.msgUntil = secs;
}

/* --------------------------------------------------------------------------
   Wave construction. Difficulty is a smooth ramp: more enemies, faster, and
   nastier mixes. Every 5th wave is a boss instead.
   -------------------------------------------------------------------------- */
function buildWave(room) {
  room.wave += 1;
  const w = room.wave;
  room.spawnQueue = [];
  room.spawnTimer = 0.6;
  room.boss = null;

  if (w % 5 === 0) {
    const kind = BOSS_ORDER[(Math.floor(w / 5) - 1) % BOSS_ORDER.length];
    // One full lap through every boss before anyone repeats; each lap after
    // that is meaningfully tougher.
    const loop = Math.floor((w - 1) / (5 * BOSS_ORDER.length));
    const def = BOSS[kind];
    const hp = Math.round(def.hp * (1 + loop * 0.6) * (1 + (room.players.size - 1) * 0.28));
    room.boss = {
      id: eid(), kind, x: W / 2, y: -160, vx: 70 + loop * 18, vy: 0,
      homeY: def.homeY || 120,
      hp, maxHp: hp, r: def.r, halfW: def.halfW, dir: 1, phase: 0, fireT: 1.8, frame: 0, hurt: 0,
      entering: true, score: def.score * (1 + loop), careDrops: 0,
      mode: 'stalk', modeT: 2.2, side: false, volley: 0, sweep: 0, spin: 0, lance: 0, summon: 0,
    };
    ev(room, 'W');
    say(room, `WAVE ${w} - WARNING: ${def.title}`, 3.2);
    return;
  }

  const count = Math.min(30, 6 + w * 2);
  const pool = ['grunt'];
  if (w >= 2) pool.push('scout');
  if (w >= 3) pool.push('drone');
  if (w >= 4) pool.push('mine');
  if (w >= 6) pool.push('bomber');

  for (let i = 0; i < count; i++) {
    let type = pool[Math.floor(Math.random() * pool.length)];
    // Bombers are the heavy hitters - keep them rare so waves stay readable.
    if (type === 'bomber' && Math.random() > 0.25) type = 'grunt';
    room.spawnQueue.push(type);
  }
  ev(room, 'w', w);
  say(room, `WAVE ${w}`, 2.0);
}

function spawnEnemy(room, type) {
  const d = ENEMY[type];
  const speedScale = 1 + (room.wave - 1) * 0.045;
  const x = rnd(40, W - 40);
  const e = {
    id: eid(), type, x, y: -30,
    vx: 0, vy: d.speed * speedScale,
    hp: d.hp + (type === 'bomber' ? Math.floor(room.wave / 4) : 0),
    r: d.r, score: d.score, frame: 0, hurt: 0,
    fireT: d.fire ? rnd(0.6, d.fire) : 0,
    t: rnd(0, 6.28), baseX: x, amp: rnd(40, 110),
  };
  room.enemies.push(e);
}

/* --------------------------------------------------------------------------
   Helpers used by the simulation
   -------------------------------------------------------------------------- */
function livePlayers(room) {
  return [...room.players.values()].filter(p => p.alive);
}
function nearestPlayer(room, x, y) {
  let best = null, bd = Infinity;
  for (const p of livePlayers(room)) {
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
function enemyShot(room, x, y, tx, ty, speed, kind = 'shot') {
  const dx = tx - x, dy = ty - y;
  const m = Math.hypot(dx, dy) || 1;
  room.ebullets.push({ id: eid(), x, y, vx: (dx / m) * speed, vy: (dy / m) * speed, kind, r: kind === 'missile' ? 9 : 6 });
}
function boom(room, x, y, size = 1) {
  room.fx.push({ id: eid(), x, y, t: 0, life: 0.45, size });
  ev(room, 'x', Math.round(size * 10) / 10);
}
function maybeDrop(room, x, y, chance) {
  if (Math.random() < chance) {
    room.pickups.push({ id: eid(), x, y, vy: 95, kind: POWERUPS[Math.floor(Math.random() * POWERUPS.length)], r: 16 });
  }
}
function damagePlayer(room, p, dmg) {
  if (!p.alive || p.invulUntil > 0) return;
  p.hp -= dmg;
  ev(room, 'h', p.n);
  if (p.hp <= 0) {
    p.hp = 0;
    p.lives -= 1;
    p.alive = false;
    ev(room, 'd', p.n);
    boom(room, p.x, p.y, 1.4);
    if (p.lives > 0) {
      p.respawnAt = RESPAWN_DELAY;
    } else {
      say(room, `${p.name} IS DOWN`, 2.2);
    }
  }
}

/* ==========================================================================
   Boss behaviour
   --------------------------------------------------------------------------
   Every boss has a `move` (how it flies) and a `fire` (what it shoots). `fire`
   returns how many seconds until it should fire again, which lets each boss
   set its own rhythm.
   ========================================================================== */
function clampBoss(bs) {
  const lim = bs.halfW + 4;
  if (bs.x < lim) { bs.x = lim; bs.dir = 1; }
  if (bs.x > W - lim) { bs.x = W - lim; bs.dir = -1; }
  bs.y = clamp(bs.y, 70, H * 0.5);
}
// fire a bullet at an absolute angle
function shotAt(room, x, y, ang, speed, kind = 'shot') {
  room.ebullets.push({ id: eid(), x, y, vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
                       kind, r: kind === 'missile' ? 9 : 6 });
}
// the classic sideways patrol with a gentle bob
function sway(room, bs, dt, bobSpeed = 0.9, bob = 26) {
  bs.x += bs.vx * bs.dir * dt;
  bs.y = bs.homeY + Math.sin(bs.phase * bobSpeed) * bob;
}

const BOSS_AI = {
  // Swarm queen: walls of downward fire, and she keeps calling in grunts.
  hive: {
    move: (r, b, dt) => sway(r, b, dt),
    fire: (r, b) => {
      for (let a = -2; a <= 2; a++) enemyShot(r, b.x, b.y + 40, b.x + a * 70, b.y + 300, 230);
      if (Math.random() < 0.5 && r.enemies.length < 24) spawnEnemy(r, 'grunt');
      return 1.5;
    },
  },

  // Gunship: one aimed shot down the middle, two wide - there's a gap to fly through.
  mech: {
    move: (r, b, dt) => sway(r, b, dt),
    fire: (r, b, tgt) => {
      if (tgt) {
        const ang = Math.atan2(tgt.y - b.y, tgt.x - b.x);
        shotAt(r, b.x, b.y + 40, ang, 245);
        shotAt(r, b.x, b.y + 40, ang - 0.42, 225);
        shotAt(r, b.x, b.y + 40, ang + 0.42, 225);
      }
      return 1.55;
    },
  },

  // Psychic: expanding rings you have to weave out of.
  brain: {
    move: (r, b, dt) => sway(r, b, dt, 0.7, 30),
    fire: (r, b) => {
      for (let a = 0; a < 10; a++) shotAt(r, b.x, b.y, (a / 10) * Math.PI * 2 + b.phase, 160);
      return 2.0;
    },
  },

  // Capital ship: alternating broadsides from the port and starboard gun pods,
  // with a missile volley every few passes. Slow and heavy.
  dread: {
    move: (r, b, dt) => sway(r, b, dt, 0.5, 14),
    fire: (r, b, tgt) => {
      b.side = !b.side;
      const px = b.x + (b.side ? -62 : 62);
      for (let i = 0; i < 4; i++) shotAt(r, px, b.y + 26, Math.PI / 2 + (i - 1.5) * 0.14, 265);
      b.volley = (b.volley || 0) + 1;
      if (b.volley % 4 === 0 && tgt) {
        enemyShot(r, b.x - 62, b.y + 26, tgt.x, tgt.y, 175, 'missile');
        enemyShot(r, b.x + 62, b.y + 26, tgt.x, tgt.y, 175, 'missile');
      }
      return 1.05;
    },
  },

  // Sea monster: drifts in a figure-eight and lashes a sweeping fan of shots
  // back and forth, like tentacles whipping across the screen.
  kraken: {
    move: (r, b, dt) => {
      b.x += Math.cos(b.phase * 0.8) * 92 * dt;
      b.y = b.homeY + Math.sin(b.phase * 1.6) * 46;
    },
    fire: (r, b) => {
      b.sweep = (b.sweep || 0) + 0.28;
      const centre = Math.PI / 2 + Math.sin(b.sweep) * 0.85;
      for (let i = -2; i <= 2; i++) shotAt(r, b.x, b.y + 30, centre + i * 0.2, 215);
      return 0.5;
    },
  },

  // Brain on legs: charges at whoever is closest, then slams down a shockwave
  // ring. Stay away from it while it's moving fast.
  walker: {
    move: (r, b, dt) => {
      b.mode = b.mode || 'stalk';
      b.modeT = (b.modeT || 0) - dt;
      if (b.mode === 'stalk') {
        const tgt = nearestPlayer(r, b.x, b.y);
        if (tgt) b.x += Math.sign(tgt.x - b.x) * 70 * dt;
        b.y = b.homeY + Math.sin(b.phase * 1.1) * 12;
        if (b.modeT <= 0) { b.mode = 'charge'; b.modeT = 1.1; b.chargeDir = Math.sign(Math.random() - 0.5) || 1; }
      } else {
        b.x += b.chargeDir * 340 * dt;
        b.y = b.homeY + 26;
        if (b.x <= b.halfW + 6 || b.x >= W - b.halfW - 6) b.chargeDir *= -1;
        if (b.modeT <= 0) {
          b.mode = 'stalk'; b.modeT = 2.6;
          for (let a = 0; a < 14; a++) shotAt(r, b.x, b.y, (a / 14) * Math.PI * 2, 135);  // shockwave
          boom(r, b.x, b.y + 40, 1.2);
        }
      }
    },
    fire: (r, b, tgt) => {
      if (b.mode === 'charge') return 0.4;
      if (tgt) { shotAt(r, b.x - 30, b.y + 30, Math.atan2(tgt.y - b.y, tgt.x - b.x), 250);
                 shotAt(r, b.x + 30, b.y + 30, Math.atan2(tgt.y - b.y, tgt.x - b.x), 250); }
      return 1.1;
    },
  },

  // Crystal: nearly stationary, but pours out a slow rotating spiral that
  // fills the screen. Positioning puzzle rather than a dodge-fest.
  crystal: {
    move: (r, b, dt) => {
      b.x += Math.cos(b.phase * 0.35) * 42 * dt;
      b.y = b.homeY + Math.sin(b.phase * 0.55) * 18;
    },
    fire: (r, b) => {
      b.spin = (b.spin || 0) + 0.41;
      for (let arm = 0; arm < 3; arm++) shotAt(r, b.x, b.y, b.spin + arm * (Math.PI * 2 / 3), 150);
      b.lance = (b.lance || 0) + 1;
      if (b.lance % 12 === 0) {
        const tgt = nearestPlayer(r, b.x, b.y);
        if (tgt) for (let i = 0; i < 3; i++)
          enemyShot(r, b.x + (i - 1) * 26, b.y + 20, tgt.x, tgt.y, 330);
      }
      return 0.24;
    },
  },

  // Eldritch: fires at BOTH players at once so you can't hide behind each
  // other, and keeps summoning mines to crowd you.
  cthulhu: {
    move: (r, b, dt) => {
      sway(r, b, dt, 1.2, 34);
      b.x += Math.sin(b.phase * 2.3) * 26 * dt;
    },
    fire: (r, b) => {
      const live = livePlayers(r);
      for (const p of live) {
        const ang = Math.atan2(p.y - b.y, p.x - b.x);
        shotAt(r, b.x, b.y + 30, ang, 240);
        shotAt(r, b.x, b.y + 30, ang - 0.3, 205);
        shotAt(r, b.x, b.y + 30, ang + 0.3, 205);
      }
      b.summon = (b.summon || 0) + 1;
      if (b.summon % 3 === 0 && r.enemies.length < 14) spawnEnemy(r, 'mine');
      return 1.35;
    },
  },
};

/* ==========================================================================
   Simulation step
   ========================================================================== */
function step(room, dt) {
  room.starOffset += 60 * dt;
  if (room.msgUntil > 0) room.msgUntil -= dt;

  /* ---- players ---- */
  for (const p of room.players.values()) {
    if (p.weaponUntil > 0) {
      p.weaponUntil -= dt;
      if (p.weaponUntil <= 0) p.weapon = 'basic';
    }
    if (p.invulUntil > 0) p.invulUntil -= dt;
    if (p.cooldown > 0) p.cooldown -= dt;

    if (!p.alive) {
      if (p.lives > 0 && room.state === 'playing') {
        p.respawnAt -= dt;
        if (p.respawnAt <= 0) {
          p.alive = true; p.hp = MAX_HP; p.invulUntil = INVUL_TIME;
          p.x = p.n === 1 ? W * 0.35 : W * 0.65; p.y = H - 110;
          p.weapon = 'basic'; p.weaponUntil = 0;
          ev(room, 'r', p.n);
        }
      }
      continue;
    }
    if (room.state !== 'playing') continue;

    // Analog axes: keyboards send -1/0/+1, touch sends a smooth drag delta.
    const i = p.input;
    let dx = i.ax, dy = i.ay;
    const mag = Math.hypot(dx, dy);
    if (mag > 1) { dx /= mag; dy /= mag; }
    p.x = clamp(p.x + dx * PLAYER_SPEED * dt, 18, W - 18);
    p.y = clamp(p.y + dy * PLAYER_SPEED * dt, H * 0.22, H - 24);

    if (i.f && p.cooldown <= 0) {
      const rate = p.weapon === 'rapid' ? 0.095 : 0.20;
      p.cooldown = rate;
      const mk = (ox, vx) => room.bullets.push({
        id: eid(), owner: p.id, n: p.n, x: p.x + ox, y: p.y - 22,
        vx, vy: -640, r: 6, dmg: 1,
      });
      if (p.weapon === 'double') { mk(-11, -70); mk(11, 70); mk(0, 0); }
      else mk(0, 0);
      ev(room, 's', p.n, p.weapon === 'double' ? 1 : 0);
    }
  }

  if (room.state !== 'playing') return;

  /* ---- player bullets ---- */
  for (let k = room.bullets.length - 1; k >= 0; k--) {
    const b = room.bullets[k];
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (b.y < -30 || b.x < -30 || b.x > W + 30) { room.bullets.splice(k, 1); continue; }

    let hit = false;
    for (let j = room.enemies.length - 1; j >= 0; j--) {
      const e = room.enemies[j];
      if ((e.x - b.x) ** 2 + (e.y - b.y) ** 2 > (e.r + b.r) ** 2) continue;
      e.hp -= b.dmg; e.hurt = 0.12; hit = true;
      if (e.hp > 0) ev(room, 't');
      if (e.hp <= 0) {
        boom(room, e.x, e.y, e.type === 'bomber' ? 1.3 : 1);
        maybeDrop(room, e.x, e.y, ENEMY[e.type].drop);
        const owner = room.players.get(b.owner);
        if (owner) { owner.score += e.score; owner.kills += 1; }
        room.enemies.splice(j, 1);
        room.waveKills++;
      }
      break;
    }
    if (!hit && room.boss) {
      const bs = room.boss;
      if ((bs.x - b.x) ** 2 + (bs.y - b.y) ** 2 <= (bs.r + b.r) ** 2) {
        bs.hp -= b.dmg; bs.hurt = 0.1; hit = true;
        if (bs.hp > 0 && bs.hp % 4 === 0) ev(room, 'bt');
        // Care packages at 60% and 30% so a long boss fight stays winnable.
        const frac = bs.hp / bs.maxHp;
        if ((bs.careDrops === 0 && frac <= 0.6) || (bs.careDrops === 1 && frac <= 0.3)) {
          bs.careDrops++;
          room.pickups.push({ id: eid(), x: bs.x, y: bs.y + 30, vy: 85, kind: 'shield', r: 16 });
          room.pickups.push({ id: eid(), x: clamp(bs.x + rnd(-70, 70), 30, W - 30), y: bs.y + 30, vy: 85, kind: Math.random() < 0.5 ? 'double' : 'rapid', r: 16 });
        }
        if (bs.hp <= 0) {
          for (let n = 0; n < 10; n++) boom(room, bs.x + rnd(-50, 50), bs.y + rnd(-40, 40), rnd(1.2, 2.2));
          const owner = room.players.get(b.owner);
          if (owner) { owner.score += bs.score; owner.kills += 1; }
          // Everyone shares the glory - the other player gets half.
          for (const p of room.players.values()) if (p.id !== b.owner) p.score += Math.round(bs.score / 2);
          room.boss = null;
          ev(room, 'bd');
          say(room, 'BOSS DESTROYED!', 2.5);
        }
      }
    }
    if (hit) room.bullets.splice(k, 1);
  }

  /* ---- enemies ---- */
  for (let j = room.enemies.length - 1; j >= 0; j--) {
    const e = room.enemies[j];
    e.t += dt;
    if (e.hurt > 0) e.hurt -= dt;
    e.frame = (e.frame + dt * 6) % 2;

    if (e.type === 'scout') {
      e.x = e.baseX + Math.sin(e.t * 2.4) * e.amp;
      e.vx = Math.cos(e.t * 2.4) * e.amp * 2.4;
    } else if (e.type === 'drone') {
      e.x += Math.sin(e.t * 1.2) * 45 * dt;
      e.vx = Math.cos(e.t * 1.2) * 45;
    } else if (e.type === 'mine') {
      const tgt = nearestPlayer(room, e.x, e.y);
      if (tgt) {
        const dir = Math.sign(tgt.x - e.x);
        e.vx = dir * 120;
        e.x += e.vx * dt;
      }
    }
    e.y += e.vy * dt;
    e.x = clamp(e.x, 16, W - 16);

    if (e.fireT > 0) {
      e.fireT -= dt;
      if (e.fireT <= 0 && e.y > 0 && e.y < H * 0.8) {
        const tgt = nearestPlayer(room, e.x, e.y);
        if (tgt) {
          if (e.type === 'bomber') enemyShot(room, e.x, e.y + 20, tgt.x, tgt.y, 190, 'missile');
          else enemyShot(room, e.x, e.y + 16, tgt.x, tgt.y, e.type === 'scout' ? 300 : 240);
        }
        e.fireT = ENEMY[e.type].fire * rnd(0.7, 1.4);
      }
    }

    // contact with a player
    let removed = false;
    for (const p of livePlayers(room)) {
      if ((p.x - e.x) ** 2 + (p.y - e.y) ** 2 <= (PLAYER_R + e.r) ** 2) {
        damagePlayer(room, p, e.type === 'mine' ? 40 : 28);
        boom(room, e.x, e.y, 1.1);
        room.enemies.splice(j, 1);
        removed = true;
        break;
      }
    }
    if (removed) continue;

    if (e.y > H + 40) { room.enemies.splice(j, 1); }
  }

  /* ---- boss ---- */
  if (room.boss) {
    const bs = room.boss;
    if (bs.hurt > 0) bs.hurt -= dt;
    bs.phase += dt;
    bs.frame = (bs.frame + dt * 3) % 2;
    if (bs.entering) {
      bs.y += 70 * dt;
      if (bs.y >= bs.homeY) { bs.y = bs.homeY; bs.entering = false; }
    } else {
      const ai = BOSS_AI[bs.kind] || BOSS_AI.hive;
      ai.move(room, bs, dt);
      clampBoss(bs);

      bs.fireT -= dt;
      if (bs.fireT <= 0) {
        // Below 40% health every boss speeds up - the fight gets frantic at
        // the end instead of grinding on at the same pace.
        const rage = bs.hp / bs.maxHp < 0.4 ? 0.65 : 1;
        bs.fireT = ai.fire(room, bs, nearestPlayer(room, bs.x, bs.y)) * rage;
        // Boss waves have no regular enemies to farm, so trickle a few in -
        // they're the only source of power-ups during a long fight.
        if (room.enemies.length < 4 && Math.random() < 0.35) spawnEnemy(room, Math.random() < 0.5 ? 'grunt' : 'scout');
      }
    }
    for (const p of livePlayers(room)) {
      if ((p.x - bs.x) ** 2 + (p.y - bs.y) ** 2 <= (PLAYER_R + bs.r) ** 2) damagePlayer(room, p, 40);
    }
  }

  /* ---- enemy bullets ---- */
  for (let k = room.ebullets.length - 1; k >= 0; k--) {
    const b = room.ebullets[k];
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (b.y > H + 30 || b.y < -60 || b.x < -40 || b.x > W + 40) { room.ebullets.splice(k, 1); continue; }
    let gone = false;
    for (const p of livePlayers(room)) {
      if ((p.x - b.x) ** 2 + (p.y - b.y) ** 2 <= (PLAYER_R + b.r) ** 2) {
        damagePlayer(room, p, b.kind === 'missile' ? 20 : 10);
        gone = true; break;
      }
    }
    if (gone) room.ebullets.splice(k, 1);
  }

  /* ---- pickups ---- */
  for (let k = room.pickups.length - 1; k >= 0; k--) {
    const u = room.pickups[k];
    u.y += u.vy * dt;
    if (u.y > H + 30) { room.pickups.splice(k, 1); continue; }
    for (const p of livePlayers(room)) {
      if ((p.x - u.x) ** 2 + (p.y - u.y) ** 2 <= (PLAYER_R + u.r + 6) ** 2) {
        if (u.kind === 'shield') p.hp = MAX_HP;
        else { p.weapon = u.kind; p.weaponUntil = 12; }
        ev(room, 'u', u.kind);
        room.pickups.splice(k, 1);
        break;
      }
    }
  }

  /* ---- effects ---- */
  for (let k = room.fx.length - 1; k >= 0; k--) {
    room.fx[k].t += dt;
    if (room.fx[k].t >= room.fx[k].life) room.fx.splice(k, 1);
  }

  /* ---- wave flow ---- */
  if (room.spawnQueue.length) {
    room.spawnTimer -= dt;
    if (room.spawnTimer <= 0) {
      spawnEnemy(room, room.spawnQueue.shift());
      room.spawnTimer = Math.max(0.16, 0.85 - room.wave * 0.03);
    }
  } else if (!room.boss && room.enemies.length === 0) {
    room.betweenWaves -= dt;
    if (room.betweenWaves <= 0) {
      buildWave(room);
      room.betweenWaves = 2.2;
    }
  }

  /* ---- game over when nobody has lives left ---- */
  const anyAlive = [...room.players.values()].some(p => p.lives > 0);
  if (!anyAlive && room.players.size > 0) {
    room.state = 'over';
    ev(room, 'g');
    say(room, 'GAME OVER', 99);
  }
}

/* ==========================================================================
   Snapshots - compact arrays keep the payload small enough for phones
   ========================================================================== */
function snapshot(room) {
  return {
    t: Date.now(),
    st: room.state,
    wv: room.wave,
    bw: room.boss ? 1 : 0,
    so: Math.round(room.starOffset),
    msg: room.msgUntil > 0 ? room.lastMsg : '',
    ps: [...room.players.values()].map(p => [
      p.id, p.n, Math.round(p.x), Math.round(p.y), p.hp, p.lives, p.score,
      p.alive ? 1 : 0, p.invulUntil > 0 ? 1 : 0,
      p.weapon === 'double' ? 1 : p.weapon === 'rapid' ? 2 : 0,
      (Math.abs(p.input.ax) + Math.abs(p.input.ay)) > 0.15 ? 1 : 0,
      p.name, p.ready ? 1 : 0, p.ping,
    ]),
    es: room.enemies.map(e => [e.id, e.type, Math.round(e.x), Math.round(e.y), Math.round(e.vx), Math.round(e.vy), e.frame < 1 ? 0 : 1, e.hurt > 0 ? 1 : 0]),
    bs: room.bullets.map(b => [b.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), b.n]),
    eb: room.ebullets.map(b => [b.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), b.kind === 'missile' ? 1 : 0]),
    pu: room.pickups.map(u => [u.id, Math.round(u.x), Math.round(u.y), u.kind]),
    fx: room.fx.map(f => [f.id, Math.round(f.x), Math.round(f.y), +(f.t / f.life).toFixed(2), f.size]),
    ev: room.events,
    bo: room.boss ? [room.boss.id, room.boss.kind, Math.round(room.boss.x), Math.round(room.boss.y),
      Math.round(room.boss.vx * room.boss.dir), 0, room.boss.frame < 1 ? 0 : 1,
      room.boss.hurt > 0 ? 1 : 0, +(room.boss.hp / room.boss.maxHp).toFixed(3)] : null,
  };
}

/* ==========================================================================
   Sockets
   ========================================================================== */
io.on('connection', (socket) => {
  let room = null;

  socket.on('join', (data = {}) => {
    room = getRoom(data.code);
    socket.join(room.code);
    const p = makePlayer(socket, room, data.name);
    room.players.set(socket.id, p);
    socket.emit('joined', { you: socket.id, n: p.n, code: room.code, W, H });
    io.to(room.code).emit('lobby', lobbyInfo(room));
  });

  socket.on('input', (i) => {
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.input.ax = clamp(Number(i.ax) || 0, -1, 1);
    p.input.ay = clamp(Number(i.ay) || 0, -1, 1);
    p.input.f = i.f ? 1 : 0;
  });

  socket.on('ready', (v) => {
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.ready = !!v;
    const all = [...room.players.values()];
    if (room.state !== 'playing' && all.length > 0 && all.every(x => x.ready)) startGame(room);
    io.to(room.code).emit('lobby', lobbyInfo(room));
  });

  socket.on('ping2', (t) => socket.emit('pong2', t));
  socket.on('rtt', (ms) => {
    if (!room) return;
    const p = room.players.get(socket.id);
    if (p) p.ping = Math.min(999, Math.round(ms));
  });

  socket.on('disconnect', () => {
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) rooms.delete(room.code);
    else io.to(room.code).emit('lobby', lobbyInfo(room));
  });
});

function lobbyInfo(room) {
  return {
    code: room.code,
    state: room.state,
    players: [...room.players.values()].map(p => ({ id: p.id, n: p.n, name: p.name, ready: p.ready, score: p.score })),
  };
}

function startGame(room) {
  room.state = 'playing';
  room.enemies = []; room.bullets = []; room.ebullets = []; room.pickups = []; room.fx = [];
  room.wave = 0; room.boss = null; room.spawnQueue = []; room.betweenWaves = 0.8;
  for (const p of room.players.values()) {
    p.hp = MAX_HP; p.lives = START_LIVES; p.score = 0; p.kills = 0;
    p.alive = true; p.invulUntil = INVUL_TIME; p.weapon = 'basic'; p.weaponUntil = 0;
    p.x = p.n === 1 ? W * 0.35 : W * 0.65; p.y = H - 110;
    p.ready = false;
  }
  ev(room, 'go');
  say(room, 'GET READY', 1.6);
}

/* ==========================================================================
   Main loop - one timer drives every room
   ========================================================================== */
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;                 // don't let a stalled process fast-forward the game

  for (const room of rooms.values()) {
    let acc = dt;
    while (acc > 0) {
      const s = Math.min(TICK, acc);
      step(room, s);
      acc -= s;
    }
    room.snapAcc += dt;
    if (room.snapAcc >= 1 / SNAP_HZ) {
      room.snapAcc = 0;
      io.to(room.code).emit('snap', snapshot(room));
      // A fresh array, not .length = 0 - the snapshot we just handed to
      // socket.io still points at the old one, and emptying it in place would
      // strip the events back out before they were serialised.
      room.events = [];
    }
  }
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Owen and Dad Space Adventures listening on ${PORT}`));
