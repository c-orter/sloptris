// Music and sound effects, synthesised with Web Audio so there are no asset files and it all
// works offline. The game passes in what the audio needs to know about it:
//   store       get/set for saved settings
//   getLevel    current level (music tempo follows it)
//   isPlaying   true while a game is actively running
function createAudio({ store, getLevel, isPlaying }) {
  let ac, master, musicG, sfxG, noiseBuf;
  let timer = null, sleepT = 0, paused = false, started = false;
  let muted = store.get('muted', false), musicOn = store.get('music', true), sfxOn = store.get('sfx', true);
  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  // ---- music: a small playlist so the loop doesn't wear thin ----
  // Tunes are [midi note, beats] lists (0 = rest). Korobeiniki and the Minuet in G are
  // traditional/public domain; "Neon Run" is an original.
  const CHORDS = { E: [64, 68, 71], Am: [69, 72, 76], Dm: [62, 65, 69], C: [60, 64, 67],
                   F: [65, 69, 72], G: [67, 71, 74], D: [62, 66, 69] };
  const TRACKS = [
    { bpm: 150, bar: 4, wave: 'square', drums: true, bass: 'pulse',   // Korobeiniki
      melody: [
        [76,1],[71,.5],[72,.5],[74,1],[72,.5],[71,.5],
        [69,1],[69,.5],[72,.5],[76,1],[74,.5],[72,.5],
        [71,1.5],[72,.5],[74,1],[76,1],
        [72,1],[69,1],[69,2],
        [74,1.5],[77,.5],[81,1],[79,.5],[77,.5],
        [76,1.5],[72,.5],[76,1],[74,.5],[72,.5],
        [71,1],[71,.5],[72,.5],[74,1],[76,1],
        [72,1],[69,1],[69,2]],
      roots: [40, 45, 40, 45, 50, 48, 40, 45], chords: ['E','Am','E','Am','Dm','C','E','Am'] },
    { bpm: 128, bar: 3, wave: 'pulse25', drums: false, bass: 'waltz',  // Minuet in G
      melody: [
        [74,1],[67,.5],[69,.5],[71,.5],[72,.5],  [74,1],[67,1],[67,1],
        [76,1],[72,.5],[74,.5],[76,.5],[78,.5],  [79,1],[67,1],[67,1],
        [72,1],[74,.5],[72,.5],[71,.5],[69,.5],  [71,1],[72,.5],[71,.5],[69,.5],[67,.5],
        [66,1],[67,.5],[69,.5],[71,.5],[67,.5],  [71,1],[69,2],
        [74,1],[67,1],[67,1],                    [72,1.5],[74,.5],[72,.5],[71,.5],
        [71,1],[72,.5],[71,.5],[69,.5],[67,.5],  [66,1],[67,.5],[69,.5],[71,.5],[67,.5],
        [71,1],[69,2],                           [74,1],[71,.5],[72,.5],[74,.5],[71,.5],
        [72,1],[69,.5],[71,.5],[72,.5],[69,.5],  [71,1],[67,2]],
      roots: [43, 43, 48, 43, 48, 43, 50, 50, 43, 48, 43, 50, 50, 43, 48, 43],
      chords: ['G','G','C','G','C','G','D','D','G','C','G','D','D','G','C','G'] },
    { bpm: 158, bar: 4, wave: 'pulse25', drums: true, bass: 'drive',   // Neon Run
      melody: [
        [69,.5],[72,.5],[76,.5],[72,.5],[81,1],[76,1],
        [77,.5],[81,.5],[84,.5],[81,.5],[77,1],[72,1],
        [72,.5],[76,.5],[79,.5],[76,.5],[84,1],[79,1],
        [71,.5],[74,.5],[79,.5],[74,.5],[83,1],[79,.5],[74,.5],
        [76,1],[76,.5],[77,.5],[79,1],[77,.5],[76,.5],
        [77,1],[77,.5],[79,.5],[81,1],[79,.5],[77,.5],
        [74,1],[77,.5],[81,.5],[79,1],[77,.5],[74,.5],
        [76,1.5],[80,.5],[83,1],[80,1]],
      roots: [45, 41, 48, 43, 45, 41, 50, 40], chords: ['Am','F','C','G','Am','F','Dm','E'] },
  ];
  // [track, full arrangement?, passes]. Each tune gets a minute or more; starts on Korobeiniki.
  const PLAYLIST = [[0, false, 2], [0, true, 4], [2, false, 2], [2, true, 4], [1, false, 2], [1, true, 2]];

  // NES-style pulse waves (duty cycles), built from Fourier terms.
  const pulseWaves = {};
  const wave = w => {
    if (w === 'square') return 'square';
    return pulseWaves[w] || (pulseWaves[w] = (() => {
      const duty = w === 'pulse25' ? .25 : .125, N = 32, re = new Float32Array(N), im = new Float32Array(N);
      for (let n = 1; n < N; n++) re[n] = 2 / (n * Math.PI) * Math.sin(n * Math.PI * duty);
      return ac.createPeriodicWave(re, im);
    })());
  };

  // Turn a tune into a time-sorted list of note events. `full` adds the arpeggio layer
  // (and drums on the 4/4 tunes) used on repeat passes.
  const arrangements = {};
  function arrangement(trackIdx, full) {
    const key = trackIdx + (full ? 'f' : 'b');
    if (arrangements[key]) return arrangements[key];
    const tr = TRACKS[trackIdx], ev = [];
    let beat = 0;
    for (const [m, d] of tr.melody) { if (m) ev.push({ beat, m, d, v: 'lead' }); beat += d; }
    const loop = beat, bars = loop / tr.bar;
    for (let b = 0; b < bars; b++) {
      const r = tr.roots[b], t0 = b * tr.bar;
      if (tr.bass === 'waltz') {
        ev.push({ beat: t0, m: r, d: .9, v: 'bass' }, { beat: t0 + 1, m: r + 19, d: .4, v: 'bass' }, { beat: t0 + 2, m: r + 19, d: .4, v: 'bass' });
      } else {
        const step = tr.bass === 'drive' ? .5 : 1;
        for (let i = 0; i < tr.bar / step; i++) ev.push({ beat: t0 + i * step, m: r + (i % 2 ? 12 : 0), d: .45, v: 'bass' });
      }
      if (!full) continue;
      const tones = CHORDS[tr.chords[b]];
      for (let i = 0; i < tr.bar * 2; i++) ev.push({ beat: t0 + i * .5, m: tones[[0, 1, 2, 1][i % 4]] + 12, d: .4, v: 'arp' });
      if (tr.drums) {
        ev.push({ beat: t0, v: 'kick' }, { beat: t0 + 2, v: 'kick' }, { beat: t0 + 1, v: 'snare' }, { beat: t0 + 3, v: 'snare' });
        for (let i = 0; i < 4; i++) ev.push({ beat: t0 + i + .5, v: 'hat' });
      }
    }
    ev.sort((a, b) => a.beat - b.beat);
    return (arrangements[key] = { ev, loop, tr });
  }

  // ---- scheduler: queue notes a little ahead of the audio clock ----
  let cur = null, ei = 0, loopStart = 0, spb = .4, pi = 0, passes = 0;
  const beatLen = tr => 60 / (tr.bpm * (1 + Math.min(getLevel() - 1, 12) * .03));
  function load(i, again) {
    pi = i; passes = again ? passes : 0;
    cur = arrangement(PLAYLIST[pi][0], PLAYLIST[pi][1]);
    ei = 0; spb = beatLen(cur.tr);
  }
  function sched() {
    if (!ac || !cur) return;
    for (;;) {
      const ev = cur.ev[ei], t = loopStart + ev.beat * spb;
      if (t > ac.currentTime + .6) break;
      switch (ev.v) {
        case 'lead': note(mtof(ev.m), t, ev.d * spb * .9, wave(cur.tr.wave), .16, musicG); break;
        case 'bass': note(mtof(ev.m), t, ev.d * spb, 'triangle', .3, musicG); break;
        case 'arp': note(mtof(ev.m), t, ev.d * spb, wave('pulse12'), .05, musicG); break;
        case 'kick': note(160, t, .12, 'sine', .55, musicG, 42); break;
        case 'snare': noise(t, .1, .16, 2500, 1500, 'highpass', musicG); break;
        case 'hat': noise(t, .03, .06, 7000, 7000, 'highpass', musicG); break;
      }
      if (++ei >= cur.ev.length) {                         // end of a pass: repeat, or move to the next tune
        loopStart += cur.loop * spb;
        if (++passes < PLAYLIST[pi][2]) load(pi, true); else load((pi + 1) % PLAYLIST.length);
      }
    }
  }

  // ---- voices ----
  function note(freq, t, dur, type, vol, dest, slideTo) {
    const o = ac.createOscillator(), g = ac.createGain();
    if (typeof type === 'string') o.type = type; else o.setPeriodicWave(type);
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(.0001, t); g.gain.linearRampToValueAtTime(vol, t + .006);
    g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + .03);
  }
  function noise(t, dur, vol, f0, f1, ftype = 'lowpass', dest = sfxG) {
    const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = noiseBuf; f.type = ftype;
    f.frequency.setValueAtTime(f0, t); f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(dest); src.start(t); src.stop(t + dur + .02);
  }

  // ---- lifecycle ----
  function init() {                                        // must run inside a user gesture
    if (ac) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ac = new AC();
    master = ac.createGain(); master.gain.value = muted ? 0 : 1; master.connect(ac.destination);
    musicG = ac.createGain(); musicG.gain.value = .55; musicG.connect(master);
    sfxG = ac.createGain(); sfxG.connect(master);
    noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  function resume() {
    paused = false; clearTimeout(sleepT);
    if (ac && !muted && ac.state !== 'running') ac.resume().catch(() => {});
  }
  // A running AudioContext keeps the audio hardware awake even when silent, so park it
  // shortly after the last sound.
  function sleepSoon() {
    clearTimeout(sleepT);
    if (!timer) sleepT = setTimeout(() => { if (!timer && ac && ac.state === 'running') ac.suspend().catch(() => {}); }, 2500);
  }
  function suspend() {                                     // game paused
    paused = true; clearInterval(timer); timer = null; clearTimeout(sleepT);
    if (ac && ac.state === 'running') ac.suspend().catch(() => {});
  }
  function startMusic() {
    if (!ac || !musicOn || muted) return;
    stopMusic(); resume();
    load(0); loopStart = ac.currentTime + .1; started = true;
    timer = setInterval(sched, 150);
  }
  function ensureMusic() {                                 // restart the scheduler without losing our place
    if (!ac || !musicOn || muted || paused || timer) return;
    if (started) timer = setInterval(sched, 150); else startMusic();
  }
  function stopMusic() { clearInterval(timer); timer = null; started = false; sleepSoon(); }

  // Sound effects go through play(), which wakes a sleeping context first.
  function play(fn) {
    if (!ac || !sfxOn || muted || paused) return;
    const go = () => { fn(ac.currentTime + .005); sleepSoon(); };
    if (ac.state === 'running') go(); else ac.resume().then(go).catch(() => {});
  }

  return {
    init, resume, suspend, startMusic, ensureMusic, stopMusic,
    get muted() { return muted; }, get music() { return musicOn; }, get sfx() { return sfxOn; },
    setMuted(v) {
      muted = v; store.set('muted', v);
      if (!ac) return;
      master.gain.setTargetAtTime(v ? 0 : 1, ac.currentTime, .02);
      if (v) { clearInterval(timer); timer = null; clearTimeout(sleepT); ac.suspend().catch(() => {}); }
      else if (isPlaying()) { resume(); ensureMusic(); }
    },
    setMusic(v) { musicOn = v; store.set('music', v); if (!v) stopMusic(); else if (isPlaying()) startMusic(); },
    setSfx(v) { sfxOn = v; store.set('sfx', v); },

    move: () => play(t => note(300, t, .03, 'square', .04, sfxG)),
    rotate: () => play(t => note(520, t, .06, 'square', .09, sfxG, 800)),
    hold: () => play(t => { note(330, t, .07, 'triangle', .2, sfxG); note(495, t + .06, .09, 'triangle', .2, sfxG); }),
    land: () => play(t => { noise(t, .07, .3, 1400, 250); note(130, t, .09, 'square', .14, sfxG, 60); }),
    slam: () => play(t => {
      noise(t, .2, .7, 3500, 150);
      note(160, t, .22, 'square', .3, sfxG, 38);
      note(70, t, .3, 'triangle', .6, sfxG, 32);
    }),
    clear: n => play(t => {
      const seq = [72, 76, 79, 84, 88, 91];
      if (n >= 4) {                                        // tetris: bigger fanfare
        noise(t, .5, .35, 600, 5000);
        seq.forEach((m, i) => { note(mtof(m), t + i * .055, .16, 'square', .16, sfxG); note(mtof(m - 12), t + i * .055, .16, 'triangle', .22, sfxG); });
        [72, 76, 79, 84].forEach(m => note(mtof(m), t + .4, .5, 'square', .1, sfxG));
      } else {
        seq.slice(0, n + 2).forEach((m, i) => note(mtof(m), t + i * .06, .12, 'square', .15, sfxG));
      }
    }),
    levelUp: () => play(t => [67, 72, 76, 79, 84].forEach((m, i) => note(mtof(m), t + .25 + i * .07, .12, 'square', .13, sfxG))),
    over: () => play(t => {
      [72, 71, 69, 66, 62, 57].forEach((m, i) => note(mtof(m), t + i * .17, .22, 'square', .18, sfxG, mtof(m - 1)));
      note(70, t + .5, .8, 'sawtooth', .22, sfxG, 30);
    }),
  };
}
