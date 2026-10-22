(() => {
  'use strict';
  const COLS = 10, ROWS = 20;
  const $ = id => document.getElementById(id);
  const board = $('board'), ctx = board.getContext('2d', { alpha: false });
  const nextC = $('next').getContext('2d'), holdC = $('hold').getContext('2d');
  const stage = $('stage');

  // ---------- saved settings ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('sloptris-' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('sloptris-' + k, JSON.stringify(v)); } catch {} },
  };
  let best = store.get('best', 0);
  let mode = store.get('mode', 'gestures');       // 'gestures' | 'buttons'
  let haptics = store.get('haptics', true);
  let ghostOn = store.get('ghost', true);

  // ---------- pieces ----------
  const SHAPES = {
    I: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
    O: [[1,1],[1,1]],
    T: [[0,1,0],[1,1,1],[0,0,0]],
    S: [[0,1,1],[1,1,0],[0,0,0]],
    Z: [[1,1,0],[0,1,1],[0,0,0]],
    J: [[1,0,0],[1,1,1],[0,0,0]],
    L: [[0,0,1],[1,1,1],[0,0,0]],
  };
  const KEYS = Object.keys(SHAPES);
  const COLORS = { I:'#2fb3e8', O:'#f7c928', T:'#8a4fbf', S:'#2f9e55', Z:'#d3281f', J:'#2a6bc9', L:'#f58a1f' };

  // ---------- state ----------
  let grid, cur, nextType, holdType, canHold, bag;
  let score = 0, lines = 0, level = 1, state = 'menu';      // menu | play | pause | over
  let dropTimer, lockTimer, lockResets, clearing, newBest;
  let cs = 20;                                              // cell size in CSS px

  const audio = createAudio({ store, getLevel: () => level, isPlaying: () => state === 'play' });
  const buzz = ms => { if (haptics && navigator.vibrate) try { navigator.vibrate(ms); } catch {} };

  const emptyGrid = () => Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  const dropInterval = () => Math.max(60, 800 * Math.pow(0.85, level - 1));

  function rotateM(m, dir) {
    const n = m.length, r = m.map(() => Array(n).fill(0));
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++)
      if (dir > 0) r[x][n-1-y] = m[y][x]; else r[n-1-x][y] = m[y][x];
    return r;
  }
  function pullFromBag() {                                  // 7-bag randomiser
    if (!bag.length) {
      bag = KEYS.slice();
      for (let i = bag.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [bag[i], bag[j]] = [bag[j], bag[i]]; }
    }
    return bag.pop();
  }
  function takeNext() { const t = nextType; nextType = pullFromBag(); return t; }
  function collides(m, px, py) {
    for (let y = 0; y < m.length; y++) for (let x = 0; x < m[y].length; x++) {
      if (!m[y][x]) continue;
      const gx = px + x, gy = py + y;
      if (gx < 0 || gx >= COLS || gy >= ROWS) return true;
      if (gy >= 0 && grid[gy][gx]) return true;
    }
    return false;
  }
  const grounded = () => collides(cur.m, cur.x, cur.y + 1);

  function spawn(type) {
    const m = SHAPES[type].map(r => r.slice());
    cur = { type, m, x: Math.floor((COLS - m.length) / 2), y: type === 'I' ? -1 : 0 };
    canHold = true; lockTimer = 0; lockResets = 0; dropTimer = 0;
    if (collides(cur.m, cur.x, cur.y)) endGame();
  }
  function newGame() {
    grid = emptyGrid(); bag = [];
    score = 0; lines = 0; level = 1; newBest = false; holdType = null; clearing = null;
    nextType = pullFromBag();
    spawn(takeNext());
    state = 'play';
    updateHUD(); hideOverlay(); showHint();
    audio.init(); audio.resume(); audio.startMusic();
    lastTick = performance.now(); changed();
  }
  function touchLock() { if (lockResets < 15) { lockTimer = 0; lockResets++; } }

  // ---------- actions ----------
  // playable() first applies any elapsed time, so actions always see up-to-date timers.
  const playable = () => { if (state === 'play') advance(); return state === 'play' && !clearing; };

  function move(dx) {
    if (!playable() || collides(cur.m, cur.x + dx, cur.y)) return false;
    cur.x += dx; touchLock(); audio.move(); changed(); return true;
  }
  function rotate(dir) {
    if (!playable() || cur.type === 'O') return;
    const r = rotateM(cur.m, dir);
    for (const k of [0, -1, 1, -2, 2]) {                    // simple wall/floor kicks
      for (const dy of [0, -1]) {
        if (collides(r, cur.x + k, cur.y + dy)) continue;
        cur.m = r; cur.x += k; cur.y += dy; touchLock(); buzz(6); audio.rotate(); changed();
        return;
      }
    }
  }
  function softDrop() {
    if (!playable() || grounded()) return false;
    cur.y++; score += 1; dropTimer = 0; updateHUD(); changed(); return true;
  }
  function hardDrop() {
    if (!playable()) return;
    let d = 0;
    while (!grounded()) { cur.y++; d++; }
    score += d * 2; lock(true); changed();
  }
  function hold() {
    if (!playable() || !canHold) return;
    const t = cur.type;
    if (holdType) { const h = holdType; holdType = t; spawn(h); }
    else { holdType = t; spawn(takeNext()); }
    canHold = false; buzz(8); audio.hold(); changed();
  }
  function lock(hard) {
    for (let y = 0; y < cur.m.length; y++) for (let x = 0; x < cur.m[y].length; x++) {
      if (!cur.m[y][x]) continue;
      const gy = cur.y + y;
      if (gy < 0) { endGame(); return; }
      grid[gy][cur.x + x] = cur.type;
    }
    const full = [];
    for (let y = 0; y < ROWS; y++) if (grid[y].every(Boolean)) full.push(y);
    if (full.length) {
      clearing = { rows: full, t: 0 };
      if (hard) audio.slam();
      buzz(full.length >= 4 ? [40, 30, 40, 30, 90] : full.length * 20 + (hard ? 15 : 5));
      audio.clear(full.length);
    } else {
      buzz(hard ? 30 : 10);
      if (hard) audio.slam(); else audio.land();
      spawn(takeNext());
    }
    updateHUD();
  }
  function finishClear() {
    const n = clearing.rows.length;
    grid = grid.filter((_, i) => !clearing.rows.includes(i));
    while (grid.length < ROWS) grid.unshift(Array(COLS).fill(null));
    score += [0, 100, 300, 500, 800][n] * level;
    lines += n;
    const prevLevel = level;
    level = 1 + Math.floor(lines / 10);
    if (level > prevLevel) { audio.levelUp(); buzz([20, 40, 20]); }
    clearing = null;
    spawn(takeNext());
    updateHUD();
  }
  function endGame() {
    state = 'over';
    if (score > best) { best = score; newBest = true; store.set('best', best); }
    buzz([60, 40, 120]);
    audio.stopMusic(); audio.over();
    updateHUD(); showOverlay(); changed();
  }
  function setPaused(p) {
    if (p && state === 'play') {
      state = 'pause'; showOverlay(); audio.suspend(); changed();
    } else if (!p && state === 'pause') {
      state = 'play'; hideOverlay(); lastTick = performance.now(); audio.resume(); audio.ensureMusic(); changed();
    }
  }

  function updateHUD() {
    for (const [id, v] of [['score', score], ['lines', lines], ['level', level]]) {
      const el = $(id);
      if (el.dataset.v !== String(v)) { el.dataset.v = v; el.textContent = v; }
    }
  }

  // ---------- drawing: toy bricks on a black baseplate ----------
  // Blocks are pre-rendered into small sprites once per size, and the board is only redrawn
  // when something changed, so an idle game costs almost nothing.
  let dpr = 1, wellImg = null, sprites = {}, ghosts = {}, minis = {}, miniKey = '';
  let rafId = 0, dirty = false;

  const disc = (g, cx, cy, r) => { g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.fill(); };
  function shade(hex, k) {                                  // k > 0 lightens, k < 0 darkens
    const n = parseInt(hex.slice(1), 16), t = k < 0 ? 0 : 255, a = Math.abs(k);
    const ch = sh => Math.round(((n >> sh) & 255) * (1 - a) + t * a);
    return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
  }
  function paintWell(g, W, H) {                             // baseplate with a stud in every cell
    g.fillStyle = '#2a2b2f'; g.fillRect(0, 0, W, H);
    const r = cs * .27;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const cx = x * cs + cs / 2, cy = y * cs + cs / 2;
      g.fillStyle = '#18191b'; disc(g, cx, cy + cs * .06, r);
      g.fillStyle = '#383a40'; disc(g, cx, cy, r);
      g.fillStyle = 'rgba(255,255,255,.1)'; disc(g, cx - r * .3, cy - r * .3, r * .32);
    }
  }
  function paintBrick(g, s, t) {                            // a stud on top, a darker lip underneath
    const c = COLORS[t], p = s * .035, S = s - p * 2, r = s * .13, lip = Math.max(2, s * .1);
    g.fillStyle = shade(c, -.3); g.beginPath(); g.roundRect(p, p, S, S, r); g.fill();
    g.fillStyle = c; g.beginPath(); g.roundRect(p, p, S, S - lip, r); g.fill();
    g.fillStyle = shade(c, .3); g.fillRect(p + r, p, S - r * 2, Math.max(1, s * .045));
    const cx = p + S / 2, cy = p + (S - lip) / 2, sr = S * .28;
    g.fillStyle = shade(c, -.3); disc(g, cx, cy + lip * .4, sr);
    g.fillStyle = shade(c, .1); disc(g, cx, cy, sr);
    g.fillStyle = 'rgba(255,255,255,.45)'; disc(g, cx - sr * .32, cy - sr * .32, sr * .3);
  }
  function paintGhost(g, s, t) {
    g.strokeStyle = COLORS[t]; g.globalAlpha = .7; g.lineWidth = 2; g.setLineDash([4, 3]);
    g.beginPath(); g.roundRect(2, 2, s - 4, s - 4, s * .13); g.stroke();
  }
  function sprite(w, h, scale, paint) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * scale); c.height = Math.ceil(h * scale);
    const g = c.getContext('2d'); g.scale(scale, scale); paint(g);
    return c;
  }
  function buildSprites() {
    for (const t of KEYS) {
      sprites[t] = sprite(cs, cs, dpr, g => paintBrick(g, cs, t));
      ghosts[t] = sprite(cs, cs, dpr, g => paintGhost(g, cs, t));
      minis[t] = sprite(13, 13, 2, g => paintBrick(g, 13, t));
    }
    wellImg = sprite(COLS * cs, ROWS * cs, dpr, g => paintWell(g, COLS * cs, ROWS * cs));
  }

  function drawMini(c, type, dim) {
    c.clearRect(0, 0, 64, 40);
    if (!type) return;
    const m = SHAPES[type], s = 13;
    let x0 = 9, x1 = 0, y0 = 9, y1 = 0;
    m.forEach((r, y) => r.forEach((v, x) => { if (v) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }));
    const ox = (64 - (x1 - x0 + 1) * s) / 2, oy = (40 - (y1 - y0 + 1) * s) / 2;
    c.globalAlpha = dim ? .35 : 1;
    m.forEach((r, y) => r.forEach((v, x) => { if (v) c.drawImage(minis[type], ox + (x - x0) * s, oy + (y - y0) * s, s, s); }));
    c.globalAlpha = 1;
  }
  function draw() {
    const W = COLS * cs, H = ROWS * cs;
    ctx.drawImage(wellImg, 0, 0, W, H);
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++)
      if (grid[y][x]) ctx.drawImage(sprites[grid[y][x]], x * cs, y * cs, cs, cs);

    if (clearing) {
      ctx.fillStyle = `rgba(255,255,255,${.35 + .5 * Math.abs(Math.sin(clearing.t / 40))})`;
      clearing.rows.forEach(y => ctx.fillRect(0, y * cs, W, cs));
    } else if (state === 'play' || state === 'pause') {
      if (ghostOn) {
        let gy = cur.y;
        while (!collides(cur.m, cur.x, gy + 1)) gy++;
        if (gy !== cur.y) cur.m.forEach((r, y) => r.forEach((v, x) => {
          if (v && gy + y >= 0) ctx.drawImage(ghosts[cur.type], (cur.x + x) * cs, (gy + y) * cs, cs, cs);
        }));
      }
      cur.m.forEach((r, y) => r.forEach((v, x) => {
        if (v && cur.y + y >= 0) ctx.drawImage(sprites[cur.type], (cur.x + x) * cs, (cur.y + y) * cs, cs, cs);
      }));
    }
    const k = nextType + '|' + holdType + '|' + canHold;
    if (k !== miniKey) { miniKey = k; drawMini(nextC, nextType, false); drawMini(holdC, holdType, !canHold); }
  }
  function requestDraw() { dirty = true; if (!rafId) rafId = requestAnimationFrame(drawFrame); }
  function drawFrame() {
    rafId = 0;
    if (!dirty) return;
    dirty = false; draw();
    if (clearing) { advance(); schedule(); requestDraw(); }   // the line-clear flash needs frames
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    cs = Math.max(8, Math.floor(Math.min((r.width - 4) / COLS, (r.height - 4) / ROWS)));
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    board.style.width = COLS * cs + 'px'; board.style.height = ROWS * cs + 'px';
    board.width = Math.ceil(COLS * cs * dpr); board.height = Math.ceil(ROWS * cs * dpr);
    ctx.setTransform(board.width / (COLS * cs), 0, 0, board.height / (ROWS * cs), 0, 0);
    buildSprites(); miniKey = ''; requestDraw();
  }

  // ---------- game clock ----------
  // Timer-driven rather than a 60fps loop: sleeps until the next gravity step or lock.
  let tm = 0, lastTick = 0;
  function advance() {
    const now = performance.now(), dt = Math.min(1000, now - lastTick);
    lastTick = now;
    if (state !== 'play') return;
    if (clearing) {
      clearing.t += dt;
      if (clearing.t > 260) finishClear();
    } else if (grounded()) {
      lockTimer += dt;
      if (lockTimer > 500) lock(false);
    } else {
      lockTimer = 0; dropTimer += dt;
      if (dropTimer >= dropInterval()) { dropTimer = 0; cur.y++; }
    }
  }
  function schedule() {
    clearTimeout(tm); tm = 0;
    if (state !== 'play') return;
    const rem = clearing ? 260 - clearing.t : grounded() ? 500 - lockTimer : dropInterval() - dropTimer;
    tm = setTimeout(tick, Math.max(4, rem) + 2);
  }
  function tick() { tm = 0; advance(); changed(); }
  function changed() { requestDraw(); schedule(); }

  // ---------- menu, pause and game-over cards ----------
  let deferredInstall = null;
  const ICON_SOUND_ON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"/></svg>';
  const ICON_SOUND_OFF = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';

  function showOverlay() {
    const on = m => m === mode ? ' class="on"' : '';
    const controls = `
      <div class="sect"><span class="label">Controls</span>
        <div class="seg">
          <button data-m="gestures"${on('gestures')}>Gestures</button>
          <button data-m="buttons"${on('buttons')}>Buttons</button>
        </div>
        <p class="how">${mode === 'gestures'
          ? '<b>Drag</b> sideways to move. <b>Drag down</b> to soft drop, <b>flick down</b> to hard drop. <b>Tap</b> the right or left half to rotate clockwise or back. <b>Press and hold</b> to fall faster. <b>Swipe up</b> or tap Hold to swap.'
          : 'Arrows move (hold to repeat). Then rotate, hold, and hard drop. Tapping the board rotates too.'}</p>
      </div>`;
    const toggles = `
      <div class="sect"><div class="toggles">
        <label><input type="checkbox" id="optMusic" ${audio.music ? 'checked' : ''}> Music</label>
        <label><input type="checkbox" id="optSfx" ${audio.sfx ? 'checked' : ''}> Sounds</label>
        <label><input type="checkbox" id="optHaptic" ${haptics ? 'checked' : ''}> Vibration</label>
        <label><input type="checkbox" id="optGhost" ${ghostOn ? 'checked' : ''}> Ghost piece</label>
      </div></div>`;
    const card = $('card');
    if (state === 'menu') {
      card.innerHTML = `<h1>Sloptris</h1><p>Best score <b>${best}</b></p>
        <button class="btn" data-go="start">Play</button>
        <button class="btn alt" id="installBtn">Install app</button>${controls}${toggles}`;
    } else if (state === 'pause') {
      card.innerHTML = `<h2>Paused</h2>
        <button class="btn" data-go="resume">Resume</button>
        <button class="btn alt" data-go="start">Restart</button>${controls}${toggles}`;
    } else if (state === 'over') {
      card.innerHTML = `<h2>Game over</h2><div class="big">${score}</div>
        <p>${newBest ? 'New best score.' : 'Best <b>' + best + '</b>.'} <b>${lines}</b> lines, level <b>${level}</b>.</p>
        <button class="btn" data-go="start">Play again</button>`;
    }
    const install = $('installBtn');
    if (install) install.style.display = deferredInstall ? 'block' : 'none';
    $('overlay').classList.add('show');
  }
  const hideOverlay = () => $('overlay').classList.remove('show');
  function applyMode() {
    document.body.classList.toggle('buttons', mode === 'buttons');
    resize();                                               // the pad changes how much room the board has
  }
  $('overlay').addEventListener('click', e => {
    const go = e.target.closest('[data-go]'), m = e.target.closest('[data-m]');
    if (go) { if (go.dataset.go === 'resume') setPaused(false); else newGame(); }
    else if (m) { mode = m.dataset.m; store.set('mode', mode); applyMode(); showOverlay(); }
    else if (e.target.id === 'installBtn' && deferredInstall) { deferredInstall.prompt(); deferredInstall = null; showOverlay(); }
  });
  $('overlay').addEventListener('change', e => {
    const { id, checked } = e.target;
    if (id === 'optHaptic') { haptics = checked; store.set('haptics', haptics); buzz(15); }
    else if (id === 'optMusic') audio.setMusic(checked);
    else if (id === 'optSfx') { audio.setSfx(checked); audio.rotate(); }
    else if (id === 'optGhost') { ghostOn = checked; store.set('ghost', ghostOn); requestDraw(); }
  });
  const syncMute = () => {
    $('muteBtn').innerHTML = audio.muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
    $('muteBtn').setAttribute('aria-pressed', audio.muted);
  };
  $('muteBtn').addEventListener('click', () => { audio.init(); audio.setMuted(!audio.muted); syncMute(); });
  $('pauseBtn').addEventListener('click', () => setPaused(true));
  $('holdBox').addEventListener('pointerdown', e => { e.preventDefault(); hold(); });

  let hintTimer;
  function showHint() {
    if (mode !== 'gestures') return;
    const h = $('hint');
    h.textContent = 'Drag to move · tap to rotate · hold to speed up';
    h.classList.add('show'); clearTimeout(hintTimer);
    hintTimer = setTimeout(() => h.classList.remove('show'), 3500);
  }

  // ---------- touch gestures ----------
  let gest = null;
  stage.addEventListener('pointerdown', e => {
    if (state !== 'play') return;
    if (mode === 'buttons') { rotate(1); return; }
    stage.setPointerCapture(e.pointerId);
    const now = performance.now();
    gest = { id: e.pointerId, x0: e.clientX, y0: e.clientY, ax: e.clientX, ay: e.clientY, t0: now,
             lx: e.clientX, ly: e.clientY, lt: now, samples: [[now, e.clientX, e.clientY]], moved: false, axis: null,
             holdT: 0, fastI: 0 };
    // press and hold without dragging = fast fall until release
    gest.holdT = setTimeout(() => {
      if (!gest || gest.moved) return;
      gest.fastI = setInterval(() => { if (state === 'play') softDrop(); }, 35);
      buzz(8);
    }, 220);
  });
  stage.addEventListener('pointermove', e => {
    if (!gest || e.pointerId !== gest.id || state !== 'play') return;
    const now = performance.now();
    gest.lx = e.clientX; gest.ly = e.clientY; gest.lt = now;
    gest.samples.push([now, e.clientX, e.clientY]);
    while (gest.samples.length > 2 && now - gest.samples[0][0] > 90) gest.samples.shift();
    const [ts, xs, ys] = gest.samples[0];                         // finger position ~90ms ago
    const rdx = e.clientX - xs, rdy = e.clientY - ys;             // what the finger is doing right now
    const adx = Math.abs(e.clientX - gest.x0), ady = Math.abs(e.clientY - gest.y0);
    if (adx > 8 || ady > 8) { gest.moved = true; clearTimeout(gest.holdT); }
    // Lock to one axis, so a swipe does only one thing. A downward swipe stays a drop however
    // much the finger arcs sideways, and a sideways swipe stays a slide however much it drifts
    // down. Changing direction mid-swipe needs a quick push that is mostly in the new direction.
    if (!gest.axis && Math.max(adx, ady) > 14) {
      const down = e.clientY > gest.y0;
      gest.axis = down ? (ady > adx ? 'v' : 'h') : (ady > adx * 1.8 ? 'u' : 'h');     // down / up / sideways
    }
    const speed = Math.hypot(rdx, rdy) / Math.max(1, now - ts);                        // px/ms right now
    if (gest.axis === 'v' && Math.abs(rdx) > cs * 1.2 && Math.abs(rdx) > Math.abs(rdy) * 2 && speed > .5) { gest.axis = 'h'; gest.ax = e.clientX; }
    else if (gest.axis === 'h' && rdy > cs * 1.2 && rdy > Math.abs(rdx) * 2 && speed > .5) { gest.axis = 'v'; gest.ay = e.clientY; }
    if (gest.axis === 'h') {
      const stepX = cs * 0.85;
      while (Math.abs(e.clientX - gest.ax) >= stepX) {
        const dir = Math.sign(e.clientX - gest.ax);
        gest.ax += dir * stepX;
        if (move(dir)) buzz(3);
      }
    } else if (gest.axis === 'v') {
      const stepY = cs * 0.7;
      if (e.clientY < gest.ay) gest.ay = e.clientY;
      while (e.clientY - gest.ay >= stepY) { gest.ay += stepY; if (!softDrop()) break; }
    }
  });
  function endGesture(e, cancelled) {
    if (!gest || e.pointerId !== gest.id) return;
    const gs = gest; gest = null;
    clearTimeout(gs.holdT); clearInterval(gs.fastI);
    if (cancelled || state !== 'play' || gs.fastI) return;
    const [ts, xs, ys] = gs.samples[0];                            // the last ~90ms of movement
    const rdx = gs.lx - xs, rdy = gs.ly - ys, vy = rdy / Math.max(1, gs.lt - ts);
    const dx = gs.lx - gs.x0, dy = gs.ly - gs.y0;
    if (!gs.moved && performance.now() - gs.t0 < 350) {            // tap: rotate by which side was hit
      const r = stage.getBoundingClientRect();
      rotate(e.clientX > r.left + r.width / 2 ? 1 : -1);
    } else if (vy > 0.9 && rdy > cs * 1.5 && Math.abs(rdx) < rdy * .5) {
      hardDrop();                                                  // a real downward flick at the end
    } else if (gs.axis === 'u' && dy < -cs * 2 && Math.abs(dx) < Math.abs(dy) * .7) {
      hold();                                                      // swipe up (never from a sideways slide)
    }
  }
  stage.addEventListener('pointerup', e => endGesture(e, false));
  stage.addEventListener('pointercancel', e => endGesture(e, true));

  // ---------- on-screen button pad (with auto-repeat) ----------
  const repeaters = new Map();
  function padAction(a) {
    if (a === 'left') move(-1); else if (a === 'right') move(1);
    else if (a === 'rotate') rotate(1); else if (a === 'hold') hold(); else if (a === 'drop') hardDrop();
  }
  document.querySelectorAll('#pad button').forEach(b => {
    const a = b.dataset.a;
    const stop = () => {
      b.classList.remove('on');
      const r = repeaters.get(b);
      if (r) { clearTimeout(r); clearInterval(r); repeaters.delete(b); }
    };
    b.addEventListener('pointerdown', e => {
      e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('on');
      if (!playable()) return;
      padAction(a); buzz(4);
      if (a === 'left' || a === 'right') {
        repeaters.set(b, setTimeout(() => repeaters.set(b, setInterval(() => padAction(a), 55)), 160));
      }
    });
    b.addEventListener('pointerup', stop); b.addEventListener('pointercancel', stop); b.addEventListener('lostpointercapture', stop);
  });

  // ---------- keyboard (desktop) ----------
  const heldKeys = {};
  const REPEAT = { ArrowLeft: [150, 50], ArrowRight: [150, 50], ArrowDown: [0, 40] };   // [delay, rate] in ms
  function keyAct(k) {
    if (k === 'ArrowLeft') move(-1); else if (k === 'ArrowRight') move(1); else softDrop();
  }
  function releaseKey(k) {
    const h = heldKeys[k];
    if (h) { clearTimeout(h.d); clearInterval(h.i); delete heldKeys[k]; }
  }
  const releaseAllKeys = () => Object.keys(heldKeys).forEach(releaseKey);
  addEventListener('keydown', e => {
    const k = e.key;
    if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', ' '].includes(k)) e.preventDefault();
    if (state === 'menu' || state === 'over') { if (k === 'Enter' || k === ' ') newGame(); return; }
    if (k === 'p' || k === 'P' || k === 'Escape') { setPaused(state === 'play'); return; }
    if (k === 'r' || k === 'R') { newGame(); return; }
    if (e.repeat || !playable()) return;
    if (REPEAT[k]) {
      keyAct(k);
      const [delay, rate] = REPEAT[k], h = heldKeys[k] = { d: 0, i: 0 };
      h.d = setTimeout(() => { h.i = setInterval(() => { if (playable()) keyAct(k); }, rate); }, delay);
    }
    else if (k === 'ArrowUp' || k === 'x' || k === 'X') rotate(1);
    else if (k === 'z' || k === 'Z') rotate(-1);
    else if (k === ' ') hardDrop();
    else if (k === 'c' || k === 'C' || k === 'Shift') hold();
  });
  addEventListener('keyup', e => releaseKey(e.key));

  // ---------- page lifecycle ----------
  const autoPause = () => { releaseAllKeys(); setPaused(true); };
  addEventListener('blur', autoPause);
  document.addEventListener('visibilitychange', () => { if (document.hidden) autoPause(); });
  let resizeT = 0;
  const scheduleResize = () => { clearTimeout(resizeT); resizeT = setTimeout(resize, 100); };
  addEventListener('resize', scheduleResize);
  addEventListener('orientationchange', scheduleResize);
  document.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('gesturestart', e => e.preventDefault());
  // Stop the page from scrolling or rubber-banding while playing, but let the menu card scroll.
  document.addEventListener('touchmove', e => { if (!e.target.closest('#overlay')) e.preventDefault(); }, { passive: false });

  addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; if (state === 'menu') showOverlay(); });
  addEventListener('appinstalled', () => { deferredInstall = null; if (state === 'menu') showOverlay(); });
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // ---------- boot ----------
  grid = emptyGrid(); bag = [];
  cur = { type: 'T', m: SHAPES.T, x: 3, y: -5 };           // parked off-screen until a game starts
  [nextC, holdC].forEach(c => c.setTransform(2, 0, 0, 2, 0, 0));
  syncMute(); updateHUD(); applyMode(); showOverlay();
})();
