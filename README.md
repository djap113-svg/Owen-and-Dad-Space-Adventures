# Owen and Dad Space Adventures

A two-player co-op vertical-scrolling space shooter. You and Owen each fly your
own ship on your own device, on the same battlefield, against waves of aliens
and three rotating bosses.

The sprites are cut out of the pixel-art sheets in `assets/sprite-sheets/`,
trimmed, palette-reduced and embedded directly into `index.html`, so the game
loads as a single 157 KB page with nothing else to download.

## Playing it on your own machine right now

The dependencies (`express` and `socket.io`) are already in `node_modules` from
the earlier project, so you can usually skip straight to step 2.

1. `npm install`
2. `npm start`
3. Open `http://localhost:3000` on this computer.
4. On the second device — Owen's laptop, a phone, a tablet — open
   `http://<this-computer's-IP>:3000` (for example `http://192.168.1.42:3000`).
   Run `ipconfig` to find the address; both devices have to be on the same wifi.
5. Type the same room code on both, press READY on both, and the game starts.

## Controls

On a keyboard, move with WASD *or* the arrow keys and shoot with Space *or*
Enter — every device accepts both sets, so neither of you has to remember which
half of the keyboard is yours. Holding six keys at once is handled properly;
the game tracks each physical key independently rather than reading one key at
a time, so nothing locks up when you are both moving and firing.

On a phone or tablet, drag anywhere on the playfield to fly (the ship follows
your thumb, offset slightly so your hand isn't covering it) and auto-fire is on
by default. There's a FIRE button and an AUTO-FIRE toggle below the playfield
if you'd rather control it yourself.

## Putting it on GitHub

From this folder:

```
git init
git add .
git commit -m "Owen and Dad Space Adventures"
git branch -M main
git remote add origin https://github.com/djap113-svg/Owen-and-Dad-Space-Adventures.git
git push -u origin main
```

`.gitignore` keeps `node_modules` and the two 17 MB source sprite sheets out of
the repo — GitHub rejects pushes with very large files, and the game doesn't
need them at runtime since the sprites it uses are already inside `index.html`.

## Getting it online so you can play from anywhere

**GitHub Pages will not work on its own.** Pages only serves static files, and
this game needs a Node server running to keep the two devices in sync. Use a
free host that runs Node instead:

1. Go to https://render.com and sign in with your GitHub account.
2. **New → Web Service**, and pick the `Owen-and-Dad-Space-Adventures` repo.
3. Settings: Environment `Node`, Build Command `npm install`, Start Command
   `npm start`. Leave the instance type on Free.
4. Create the service. After a minute or two you get a URL like
   `https://owen-and-dad-space-adventures.onrender.com`.
5. Both of you open that URL, type the same room code, press READY.

On Render's free tier the server sleeps after about 15 minutes of no traffic, so
the first page load after a quiet spell takes roughly 30–50 seconds to wake up.
After that it's instant. Fly.io and Railway work the same way if you'd rather
use one of those.

### If you specifically want the page itself on GitHub Pages

You can host the page on Pages and point it at the Render server: turn on Pages
for the repo, then open
`https://djap113-svg.github.io/Owen-and-Dad-Space-Adventures/?server=https://your-app.onrender.com`.
The page remembers the server address after the first visit. This is optional —
just using the Render URL directly is simpler.

## What's in here

- `index.html` — the whole client: canvas rendering, starfield, HUD, keyboard
  and touch controls, and every sprite as an embedded image. One file, no build
  step, no bundler.
- `server.js` — the authoritative game server. It runs the entire simulation
  (ships, enemies, bullets, waves, bosses, power-ups) 60 times a second and
  sends both clients a compact snapshot 20 times a second. Clients only send
  which keys are held, which is what keeps the two screens honest.
- `assets/sprites/` — the 25 trimmed sprites, in case you want to swap the art
  later. `python` is not needed; just replace a PNG and re-embed it.
- `assets/sprite-sheets/` — the original full sheets the sprites came from.

## Tuning the difficulty

Everything worth fiddling with is near the top of `server.js`:

`ENEMY` sets each alien's health, speed, points and how often it shoots.
`BOSS` sets boss health and how wide each one is. `PLAYER_SPEED`, `START_LIVES`
and `MAX_HP` are right above them. In `buildWave()`, `count` controls how many
enemies a wave sends and the `w >= n` lines decide when each new enemy type
starts appearing. Every fifth wave is a boss — Hive Mother, then Centurian
Mech, then Mega Brain, then round again with more health.

If Owen finds it too hard, the quickest knobs are raising `START_LIVES`,
lowering the contact damage in the enemy collision block, or slowing the wave
ramp by changing `6 + w * 2` to something gentler.
