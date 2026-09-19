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

// `halfW` is how far the sprite reaches sideways - the boss is kept that far
// from the wall so it never slides half off the screen.
const BOSS = {
  hive:  { hp: 150, r: 58, score: 5000, halfW: 96 },
  mech:  { hp: 220, r: 60, score: 7500, halfW: 58 },
  brain: { hp: 320, r: 62, score: 10000, halfW: 80 },
};
const BOSS_ORDER = ['hive', 'mech', 'brain'];

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
    const loop = Math.floor((w - 1) / 15);          // each full boss cycle gets tougher
    const def = BOSS[kind];
    const hp = Math.round(def.hp * (1 + loop * 0.6) * (1 + (room.players.size - 1) * 0.35));
    room.boss = {
      id: eid(), kind, x: W / 2, y: -120, vx: 70 + loop * 18, vy: 0,
      hp, maxHp: hp, r: def.r, halfW: def.halfW, dir: 1, phase: 0, fireT: 1.6, frame: 0, hurt: 0,
      entering: true, score: def.score * (1 + loop), careDrops: 0,
    };
    ev(room, 'W');
    say(room, `WAVE ${w} - WARNING: ${kind === 'hive' ? 'HIVE MOTHER' : kind === 'mech' ? 'CENTURIAN MECH' : 'MEGA BRAIN'}`, 3.2);
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
      if (bs.y >= 120) { bs.y = 120; bs.entering = false; }
    } else {
      bs.x += bs.vx * bs.dir * dt;
      const lim = bs.halfW + 4;
      if (bs.x < lim) { bs.x = lim; bs.dir = 1; }
      if (bs.x > W - lim) { bs.x = W - lim; bs.dir = -1; }
      bs.y = 120 + Math.sin(bs.phase * 0.9) * 26;

      bs.fireT -= dt;
      if (bs.fireT <= 0) {
        const tgt = nearestPlayer(room, bs.x, bs.y);
        const rage = bs.hp / bs.maxHp < 0.4 ? 0.6 : 1;
        if (bs.kind === 'hive') {
          for (let a = -2; a <= 2; a++) enemyShot(room, bs.x, bs.y + 40, bs.x + a * 70, bs.y + 300, 230);
          if (Math.random() < 0.5 && room.enemies.length < 24) spawnEnemy(room, 'grunt');
          bs.fireT = 1.5 * rage;
        } else if (bs.kind === 'mech') {
          // One aimed shot down the middle, two wide - leaves a gap you can fly through.
          if (tgt) {
            enemyShot(room, bs.x, bs.y + 40, tgt.x, tgt.y, 245);
            const ang = Math.atan2(tgt.y - bs.y, tgt.x - bs.x);
            for (const off of [-0.42, 0.42]) {
              room.ebullets.push({ id: eid(), x: bs.x, y: bs.y + 40, vx: Math.cos(ang + off) * 225, vy: Math.sin(ang + off) * 225, kind: 'shot', r: 6 });
            }
          }
          bs.fireT = 1.55 * rage;
        } else {
          const n = 10;
          for (let a = 0; a < n; a++) {
            const ang = (a / n) * Math.PI * 2 + bs.phase;
            room.ebullets.push({ id: eid(), x: bs.x, y: bs.y, vx: Math.cos(ang) * 160, vy: Math.sin(ang) * 160, kind: 'shot', r: 6 });
          }
          bs.fireT = 2.0 * rage;
        }
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
