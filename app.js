// Who Is the Lead?
// - Mac Safari / trackpad 前提
// - assets/drum.wav / assets/synthesizer.wav
// - Stereo Convolver IR (Ableton-ish wide reverb)
// - 操作はビジュアル直触りのみ（スライダー無し）
// - 触ってないと自律ドリフト / 触ってる間は追従
//
// 操作:
// - CUBE ドラッグ上下: ROOM
// - ピンチ (Safari gesture / ctrl+wheel): ROOM
// - 2本指スクロール上下: DISTANCE
// - SHIFT + 2本指スクロール上下: MOTION
// - “役者ノード”ドラッグ: 各ステムの POS(左右) / DIST(上下)
//
// デバッグ:
// - fetch URL / HTTPステータス / decode失敗理由 を #debug に表示

(() => {
  "use strict";

  // ---------------- DOM ----------------
  const $ = (id) => document.getElementById(id);
  const viz = $("viz");
  const g = viz.getContext("2d", { alpha: false });

  const overlay = $("overlay");
  const startBtn = $("start");
  const statusEl = $("status");
  const debugEl = $("debug");

  // ---------------- Debug logger ----------------
  const debug = [];
  function log(msg) {
    const t = new Date();
    const stamp = `${String(t.getHours()).padStart(2,"0")}:${String(t.getMinutes()).padStart(2,"0")}:${String(t.getSeconds()).padStart(2,"0")}`;
    debug.push(`[${stamp}] ${msg}`);
    while (debug.length > 80) debug.shift();
    if (debugEl) debugEl.textContent = debug.join("\n");
  }
  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  // ---------------- Utils ----------------
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const clamp01 = (x) => clamp(x, 0, 1);
  const lerp = (a, b, t) => a + (b - a) * t;
  const curve01 = (x, p = 2.0) => Math.pow(clamp01(x), p);
  const randi = (a, b) => Math.floor(a + Math.random() * (b - a));
  const nowSec = () => (performance.now() || Date.now()) / 1000;

  // ---------------- Canvas sizing ----------------
  let W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const rect = viz.getBoundingClientRect();
    W = rect.width;
    H = rect.height;
    viz.width = Math.floor(W * DPR);
    viz.height = Math.floor(H * DPR);
    g.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  window.addEventListener("resize", resize);
  resize();

  // prevent context menu / page scroll stealing
  viz.addEventListener("contextmenu", (e) => e.preventDefault());
  // (wheel handler uses passive:false)

  // ---------------- Files ----------------
  const FILES = [
    { name: "DRUM", url: "assets/drum.wav", basePos: -0.55 },
    { name: "SYNTH", url: "assets/synthesizer.wav", basePos: 0.55 },
  ];

  // ---------------- Audio state ----------------
  let ctx = null;
  let running = false;

  // analysis for viz
  let analyser = null;
  let freqData = null;
  let timeData = null;

  // master nodes
  let masterGain = null;

  // stereo room bus
  let room = null;

  // stems
  let stems = []; // [{src, pre, focusEQ, lpf, pan, level, dry, send, sideL, sideR, sideDelay, lfo, lfoDepth, params}]

  // ---------------- Visual state (rhizomatiks/aphex-ish) ----------------
  let rafId = null;
  let particles = [];
  let flowT = 0;
  let strobe = 0;
  let prevRMS = 0;

  let waterfall = null;
  let wg = null;

  function initVizCaches() {
    // offscreen waterfall
    waterfall = document.createElement("canvas");
    waterfall.width = Math.floor(W);
    waterfall.height = Math.floor(H);
    wg = waterfall.getContext("2d", { alpha: true });

    // particles
    particles = [];
    const N = Math.floor((W * H) / 13000);
    for (let i = 0; i < N; i++) {
      particles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        vx: 0, vy: 0,
        s: 0.7 + Math.random() * 1.8,
        a: 0.20 + Math.random() * 0.70
      });
    }
  }
  initVizCaches();
  window.addEventListener("resize", () => {
    initVizCaches();
  });

  // ---------------- Control state (no UI elements) ----------------
  const ctrl = {
    room: 0.55,      // cube size / room impression
    distance: 0.35,  // fog / wet bias
    motion: 0.35,    // autopan + viz energy
    focus: 0.50,     // global focus bias (kept for sound+viz)
  };

  // per-stem params controlled by actor nodes
  function defaultStemParams(i) {
    return {
      level: 0.85,
      pos: FILES[i]?.basePos ?? 0,
      dist: 0.30,
      width: 0.55,
      motion: 0.35,
      focus: 0.55,
    };
  }

  // ---------------- Interaction state ----------------
  const interaction = {
    active: false,
    lastTouchT: 0,
    mode: "none", // "cube" | "actor"
    pointerId: null,

    cubeStartY: 0,
    cubeStartRoom: 0,

    actorIndex: -1,
    actorStart: { x: 0, y: 0 },
    actorParamStart: { pos: 0, dist: 0 },

    // gesture pinch baseline
    gestureBaseRoom: 0.55,
  };

  function markActive() {
    interaction.active = true;
    interaction.lastTouchT = nowSec();
  }
  function markInactive() {
    interaction.active = false;
    interaction.mode = "none";
    interaction.pointerId = null;
    interaction.actorIndex = -1;
  }

  // ---------------- Geometry: cube + actor nodes ----------------
  function cubeRect() {
    const size = Math.min(W, H) * 0.22;
    const x = W * 0.5 - size * 0.5;
    const y = H * 0.62 - size * 0.5;
    return { x, y, w: size, h: size };
  }
  function inRect(px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  }
  function actorPosFromParams(p, i) {
    // x = pos, y = dist (up=near)
    const cx = W * 0.5;
    const baseY = H * 0.36;
    const x = cx + p.pos * (W * 0.40);
    const y = baseY + (p.dist - 0.5) * (H * 0.26) + Math.sin(flowT * (0.7 + i * 0.17)) * (2 + ctrl.motion * 8);
    return { x, y };
  }
  function hitActor(px, py) {
    // check nearest actor node
    let best = { i: -1, d2: Infinity };
    for (let i = 0; i < stems.length; i++) {
      const p = stems[i].params;
      const a = actorPosFromParams(p, i);
      const r = 16 + clamp01(p.level) * 10;
      const dx = px - a.x, dy = py - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < r * r && d2 < best.d2) best = { i, d2 };
    }
    return best.i;
  }

  // ---------------- Trackpad / pointer bindings ----------------
  viz.addEventListener("pointerdown", (e) => {
    const rect = viz.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // priority: actor > cube (actors are “interactive”)
    const ai = hitActor(x, y);
    if (ai !== -1) {
      markActive();
      interaction.mode = "actor";
      interaction.pointerId = e.pointerId;
      interaction.actorIndex = ai;
      interaction.actorStart.x = x;
      interaction.actorStart.y = y;
      interaction.actorParamStart.pos = stems[ai].params.pos;
      interaction.actorParamStart.dist = stems[ai].params.dist;
      viz.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    const cr = cubeRect();
    if (inRect(x, y, cr)) {
      markActive();
      interaction.mode = "cube";
      interaction.pointerId = e.pointerId;
      interaction.cubeStartY = y;
      interaction.cubeStartRoom = ctrl.room;
      viz.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
  });

  viz.addEventListener("pointermove", (e) => {
    if (!interaction.active) return;
    if (interaction.pointerId !== e.pointerId) return;

    const rect = viz.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (interaction.mode === "cube") {
      // drag up = bigger room
      const dy = (interaction.cubeStartY - y) / Math.max(1, rect.height);
      ctrl.room = clamp01(interaction.cubeStartRoom + dy * 1.6);
      applyAllParams();
      markActive();
      e.preventDefault();
    } else if (interaction.mode === "actor") {
      const i = interaction.actorIndex;
      if (i < 0 || !stems[i]) return;

      const dx = (x - interaction.actorStart.x) / Math.max(1, rect.width);
      const dy = (y - interaction.actorStart.y) / Math.max(1, rect.height);

      // pos: left/right
      const nextPos = clamp(interaction.actorParamStart.pos + dx * 2.2, -1, 1);
      // dist: up=near => smaller dist
      const nextDist = clamp01(interaction.actorParamStart.dist + dy * 1.6);

      stems[i].params.pos = nextPos;
      stems[i].params.dist = nextDist;

      applyAllParams();
      markActive();
      e.preventDefault();
    }
  });

  const endPointer = (e) => {
    if (interaction.pointerId === e.pointerId) {
      markInactive();
    }
  };
  viz.addEventListener("pointerup", endPointer);
  viz.addEventListener("pointercancel", endPointer);

  // wheel: distance / motion
  viz.addEventListener("wheel", (e) => {
    const dy = clamp(e.deltaY, -160, 160);

    // ctrl+wheel often corresponds to pinch zoom in some configs
    if (e.ctrlKey) {
      ctrl.room = clamp01(ctrl.room + (-dy / 900));
      applyAllParams();
      markActive();
      e.preventDefault();
      return;
    }

    if (e.shiftKey) {
      ctrl.motion = clamp01(ctrl.motion + (-dy / 900));
      applyAllParams();
      markActive();
      e.preventDefault();
      return;
    }

    ctrl.distance = clamp01(ctrl.distance + (dy / 900));
    applyAllParams();
    markActive();
    e.preventDefault();
  }, { passive: false });

  // Safari gesture pinch: room
  window.addEventListener("gesturestart", (e) => {
    interaction.gestureBaseRoom = ctrl.room;
    markActive();
    e.preventDefault();
  }, { passive: false });

  window.addEventListener("gesturechange", (e) => {
    // e.scale ~ 1 baseline
    const scale = clamp(e.scale || 1, 0.4, 2.2);
    const amt = (scale - 1) * 0.65;
    ctrl.room = clamp01(interaction.gestureBaseRoom + amt);
    applyAllParams();
    markActive();
    e.preventDefault();
  }, { passive: false });

  window.addEventListener("gestureend", (e) => {
    markActive();
    e.preventDefault();
  }, { passive: false });

  // ---------------- Audio helpers ----------------
  async function loadBuffer(url) {
    log(`fetch: ${url}`);
    let res;
    try {
      res = await fetch(url, { cache: "no-cache" });
    } catch (err) {
      log(`fetch error: ${url} :: ${String(err)}`);
      throw err;
    }

    log(`HTTP: ${res.status} ${res.statusText} :: ${url}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} :: ${url}`);
    }

    const arr = await res.arrayBuffer();

    try {
      const buf = await ctx.decodeAudioData(arr);
      log(`decode OK: ${url} (ch=${buf.numberOfChannels}, len=${buf.length})`);
      return buf;
    } catch (err) {
      log(`decode FAIL: ${url} :: ${String(err && err.message ? err.message : err)}`);
      throw err;
    }
  }

  function createMaster() {
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.82;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 24;
    comp.ratio.value = 5;
    comp.attack.value = 0.006;
    comp.release.value = 0.14;

    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -7;
    limit.knee.value = 0;
    limit.ratio.value = 20;
    limit.attack.value = 0.003;
    limit.release.value = 0.09;

    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.86;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);

    masterGain.connect(comp);
    comp.connect(limit);
    limit.connect(analyser);
    analyser.connect(ctx.destination);
  }

  // Stereo IR generator (wide, “Ableton-ish” impression)
  function makeStereoIR({
    seconds = 3.0,
    decay = 3.4,
    dampHz = 7800,
    earlyReflections = 18,
    stereoWidth = 0.95
  } = {}) {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * seconds));
    const buffer = ctx.createBuffer(2, length, rate);

    const L = buffer.getChannelData(0);
    const R = buffer.getChannelData(1);
    const rnd = () => (Math.random() * 2 - 1);

    // early reflections (sparse impulses)
    for (let i = 0; i < earlyReflections; i++) {
      const t = 0.008 + Math.random() * 0.12;
      const idx = Math.floor(t * rate);
      if (idx >= length) continue;

      const amp = (0.36 / (1 + i)) * (0.75 + Math.random() * 0.55);
      const pan = rnd() * stereoWidth;
      const lW = clamp01(1 - Math.max(0, pan));
      const rW = clamp01(1 + Math.min(0, pan));
      L[idx] += amp * lW;
      R[idx] += amp * rW;
    }

    // damping LP (one-pole)
    const dt = 1 / rate;
    const RC = 1 / (2 * Math.PI * Math.max(200, dampHz));
    const alpha = dt / (RC + dt);

    let lpL = 0, lpR = 0;
    let walkL = 0, walkR = 0;

    for (let i = 0; i < length; i++) {
      const x = i / length;
      const env = Math.pow(1 - x, decay);

      // slow random walk to avoid “static noise”
      walkL = walkL * 0.98 + rnd() * 0.02;
      walkR = walkR * 0.98 + rnd() * 0.02;

      const nL = rnd() * 0.92 + walkL * 0.60;
      const nR = rnd() * 0.92 + walkR * 0.60;

      lpL = lpL + alpha * (nL - lpL);
      lpR = lpR + alpha * (nR - lpR);

      const w = stereoWidth;
      L[i] += lpL * env * (0.85 + w * 0.25);
      R[i] += lpR * env * (0.85 + w * 0.25);
    }

    return buffer;
  }

  function createStereoRoom() {
    const input = ctx.createGain();
    input.gain.value = 1.0;

    const predelay = ctx.createDelay(0.35);
    predelay.delayTime.value = 0.03;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 160;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 9000;

    const convolver = ctx.createConvolver();
    convolver.normalize = true;
    convolver.buffer = makeStereoIR({
      seconds: 3.0,
      decay: 3.4,
      dampHz: 7800,
      earlyReflections: 18,
      stereoWidth: 0.95
    });

    const postLP = ctx.createBiquadFilter();
    postLP.type = "lowpass";
    postLP.frequency.value = 11000;

    const wetGain = ctx.createGain();
    wetGain.gain.value = 0.25;

    // wet-only decorrelation (tiny L/R delay offset)
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);

    const dL = ctx.createDelay(0.03);
    const dR = ctx.createDelay(0.03);
    dL.delayTime.value = 0.011;
    dR.delayTime.value = 0.017;

    const gL = ctx.createGain();
    const gR = ctx.createGain();
    gL.gain.value = 0.92;
    gR.gain.value = 0.92;

    input.connect(predelay);
    predelay.connect(hp);
    hp.connect(lp);
    lp.connect(convolver);
    convolver.connect(postLP);

    postLP.connect(splitter);
    splitter.connect(dL, 0);
    splitter.connect(dR, 1);
    dL.connect(gL);
    dR.connect(gR);
    gL.connect(merger, 0, 0);
    gR.connect(merger, 0, 1);

    merger.connect(wetGain);

    return { input, predelay, hp, lp, convolver, postLP, wetGain };
  }

  function buildStem(buffer, params) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const pre = ctx.createGain();
    pre.gain.value = 0.70;

    const focusEQ = ctx.createBiquadFilter();
    focusEQ.type = "peaking";
    focusEQ.Q.value = 1.0;
    focusEQ.gain.value = 10.0;
    focusEQ.frequency.value = 1400;

    const lpf = ctx.createBiquadFilter();
    lpf.type = "lowpass";
    lpf.frequency.value = 18000;
    lpf.Q.value = 0.7;

    const pan = ctx.createStereoPanner();
    pan.pan.value = params.pos;

    const level = ctx.createGain();
    level.gain.value = params.level;

    const dry = ctx.createGain();
    dry.gain.value = 1.0;

    const send = ctx.createGain();
    send.gain.value = 0.0;

    // width enhancer (Haas-ish)
    const sideL = ctx.createGain();
    const sideR = ctx.createGain();
    sideL.gain.value = 0.0;
    sideR.gain.value = 0.0;

    const panL = ctx.createStereoPanner();
    const panR = ctx.createStereoPanner();
    panL.pan.value = -1;
    panR.pan.value =  1;

    const sideDelay = ctx.createDelay(0.06);
    sideDelay.delayTime.value = 0.010;

    // motion LFO (autopan)
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    const lfoDepth = ctx.createGain();
    lfo.frequency.value = 0.15;
    lfoDepth.gain.value = 0.0;
    lfo.connect(lfoDepth);
    lfoDepth.connect(pan.pan);
    lfo.start();

    // routing
    src.connect(pre);
    pre.connect(focusEQ);
    focusEQ.connect(lpf);

    lpf.connect(pan);
    pan.connect(level);
    level.connect(dry);
    dry.connect(masterGain);

    lpf.connect(send);
    send.connect(room.input);

    lpf.connect(sideL);
    lpf.connect(sideDelay);
    sideDelay.connect(sideR);

    sideL.connect(panL);
    sideR.connect(panR);

    panL.connect(masterGain);
    panR.connect(masterGain);

    src.start();

    return {
      src, pre, focusEQ, lpf, pan, level, dry, send,
      sideL, sideR, sideDelay, lfo, lfoDepth,
      params
    };
  }

  // ---------------- Apply params (global + per-stem) ----------------
  function applyAllParams() {
    if (!running) return;

    const R  = curve01(ctrl.room, 1.25);
    const GD = curve01(ctrl.distance, 1.60);
    const GM = curve01(ctrl.motion, 1.35);
    const GF = clamp01(ctrl.focus);

    // Stereo convolver shaping
    room.wetGain.gain.value = clamp( lerp(0.10, 0.78, GD) * lerp(0.70, 1.05, R), 0, 1 );
    room.predelay.delayTime.value = lerp(0.012, 0.16, GD) * lerp(0.75, 1.20, R);
    room.lp.frequency.value = lerp(9800, 3200, GD*0.92) * lerp(1.05, 0.80, R);
    room.hp.frequency.value = lerp(130, 280, GD) * lerp(0.90, 1.10, R);

    // headroom
    masterGain.gain.value = 0.84 - GD * 0.16;

    // stems
    stems.forEach((s) => {
      const p = s.params;

      const dist = curve01(p.dist, 1.70);
      const width = curve01(p.width, 1.05);
      const mot = curve01(lerp(p.motion, ctrl.motion, 0.6), 1.35); // global motion influences
      const foc = clamp01(lerp(p.focus, GF, 0.25));

      // level
      s.level.gain.value = clamp(p.level, 0, 1.2);

      // position
      s.pan.pan.value = clamp(p.pos, -1, 1);

      // distance mapping
      const dryAmt  = lerp(1.0, 0.18, dist) * lerp(1.0, 0.78, GD);
      const sendAmt = lerp(0.05, 1.0, dist) * lerp(0.65, 1.0, GD);

      s.dry.gain.value  = clamp(dryAmt, 0.08, 1.0);
      s.send.gain.value = clamp(sendAmt, 0.0, 1.2);

      s.lpf.frequency.value = lerp(18000, 2200, dist);

      // focus EQ
      const focusHz = lerp(180, 7200, clamp01((foc*0.78 + GF*0.22)));
      s.focusEQ.frequency.value = focusHz;
      s.focusEQ.gain.value = lerp(4.0, 15.0, foc);

      // width + haas delay
      const sideAmt = lerp(0.0, 0.85, width);
      s.sideL.gain.value = sideAmt * 0.62;
      s.sideR.gain.value = sideAmt * 0.62;
      s.sideDelay.delayTime.value = lerp(0.002, 0.026, width) + (mot * 0.004) + (GM * 0.002);

      // motion autopan
      const rate = lerp(0.05, 1.8, mot) * lerp(0.8, 1.25, GM);
      s.lfo.frequency.value = rate;
      s.lfoDepth.gain.value = lerp(0.0, 0.95, mot) * lerp(0.85, 1.05, GM);
    });
  }

  // ---------------- Analysis helpers ----------------
  function bandEnergy(start01, end01) {
    const n = freqData.length;
    const a = Math.floor(n * start01);
    const b = Math.max(a + 1, Math.floor(n * end01));
    let sum = 0;
    for (let i = a; i < b; i++) sum += freqData[i];
    return (sum / (b - a)) / 255;
  }
  function waveformRMS() {
    let sum = 0;
    for (let i = 0; i < timeData.length; i++) {
      const v = (timeData[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / timeData.length));
  }

  // ---------------- Draw layers ----------------
  function drawGrid(bass, high) {
    g.save();
    g.globalCompositeOperation = "lighter";

    const lines = 14 + Math.floor(high * 20);
    const spacing = Math.max(18, Math.min(52, (W / lines)));
    const wob = (ctrl.motion * 18 + bass * 22) * (0.12 + strobe * 0.9);

    g.lineWidth = 1;
    g.strokeStyle = `rgba(255,255,255,${0.045 + high * 0.085})`;

    for (let x = 0; x <= W; x += spacing) {
      const xx = x + Math.sin((x * 0.02) + flowT * 2.0) * wob;
      g.beginPath(); g.moveTo(xx, 0); g.lineTo(xx, H); g.stroke();
    }
    for (let y = 0; y <= H; y += spacing) {
      const yy = y + Math.cos((y * 0.02) + flowT * 1.6) * wob;
      g.beginPath(); g.moveTo(0, yy); g.lineTo(W, yy); g.stroke();
    }

    // focus line
    const fx = W * 0.5 + (ctrl.focus - 0.5) * W * 0.75;
    g.lineWidth = 2;
    g.strokeStyle = `rgba(255,255,255,${0.06 + high * 0.16})`;
    g.beginPath(); g.moveTo(fx, 0); g.lineTo(fx, H); g.stroke();

    g.restore();
  }

  function drawWaterfall(high) {
    if (!waterfall || !wg) return;

    // shift down 1px
    const img = wg.getImageData(0, 0, Math.floor(W), Math.floor(H));
    wg.putImageData(img, 0, 1);

    wg.fillStyle = "rgba(0,0,0,0.35)";
    wg.fillRect(0, 0, W, 1);

    const n = freqData.length;
    const step = Math.max(1, Math.floor(n / W));

    for (let x = 0; x < W; x++) {
      const i = x * step;
      const v = freqData[i] / 255;
      const a = (0.09 + v * 0.62) * (0.70 + high * 0.9) * (1.0 - ctrl.distance * 0.28);

      const split = (ctrl.motion > 0.55 && strobe > 0.14 && Math.random() < 0.08);
      if (!split) {
        wg.fillStyle = `rgba(255,255,255,${a})`;
        wg.fillRect(x, 0, 1, 1);
      } else {
        wg.fillStyle = `rgba(255,0,0,${a * 0.8})`; wg.fillRect(x - 1, 0, 1, 1);
        wg.fillStyle = `rgba(0,255,255,${a * 0.8})`; wg.fillRect(x + 1, 0, 1, 1);
      }
    }

    g.save();
    g.globalCompositeOperation = "lighter";
    g.globalAlpha = 0.22 + ctrl.room * 0.20 + strobe * 0.16;

    const blockH = H * (0.26 + ctrl.distance * 0.24);
    const y0 = H * 0.08;
    g.drawImage(waterfall, 0, 0, W, blockH, 0, y0, W, blockH);

    g.restore();
  }

  function drawParticles(bass, mid, high, rms) {
    g.save();
    g.globalCompositeOperation = "lighter";

    const cx = W * 0.5, cy = H * 0.5;
    const fx = cx + (ctrl.focus - 0.5) * W * 0.90;

    const pull = (0.0008 + mid * 0.0027) * (0.35 + ctrl.room * 0.65);
    const speed = (0.44 + ctrl.motion * 2.3 + high * 1.5) * (0.6 + strobe * 1.35);
    const drift = (ctrl.distance * 0.55 + 0.08);

    for (const p of particles) {
      const nx = (p.x / W - 0.5);
      const ny = (p.y / H - 0.5);
      const ang = Math.sin(nx * 6 + flowT * 1.7) + Math.cos(ny * 7 - flowT * 1.25);
      const a = ang + (bass * 2.1 - high * 1.55) + (ctrl.motion * 1.75);

      p.vx += Math.cos(a) * 0.06 * speed;
      p.vy += Math.sin(a) * 0.06 * speed;

      p.vx += (fx - p.x) * pull;
      p.vy += (cy - p.y) * pull * 0.58;

      p.vx *= 0.90;
      p.vy *= 0.90;

      p.x += p.vx + (Math.random() - 0.5) * drift;
      p.y += p.vy + (Math.random() - 0.5) * drift;

      if (p.x < -20) p.x = W + 20;
      if (p.x > W + 20) p.x = -20;
      if (p.y < -20) p.y = H + 20;
      if (p.y > H + 20) p.y = -20;

      const alpha = (0.055 + p.a * 0.16 + high * 0.10) * (0.8 + strobe * 1.1);
      const size = p.s * (0.75 + rms * 2.2 + bass * 1.2);

      g.fillStyle = `rgba(255,255,255,${alpha})`;
      g.fillRect(p.x, p.y, size, size);
    }

    // connective lines
    if (high > 0.20 || strobe > 0.25) {
      const links = 34 + Math.floor(high * 120);
      g.strokeStyle = `rgba(255,255,255,${0.03 + high * 0.08 + strobe * 0.10})`;
      g.lineWidth = 1;
      for (let i = 0; i < links; i++) {
        const a = particles[randi(0, particles.length)];
        const b = particles[randi(0, particles.length)];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        const maxD = (78 + ctrl.room * 220);
        if (d2 < maxD * maxD) {
          g.beginPath();
          g.moveTo(a.x, a.y);
          g.lineTo(b.x, b.y);
          g.stroke();
        }
      }
    }

    g.restore();
  }

  function drawScope(bass, high, rms) {
    g.save();
    g.globalCompositeOperation = "lighter";

    const cx = W * 0.5, cy = H * 0.73;
    const amp = (22 + bass * 120 + rms * 140) * (0.75 + (1 - ctrl.distance) * 0.55);
    const sx = 0.24 + ctrl.room * 0.45;
    const rot = (ctrl.motion * 0.35 + strobe * 0.25) * (Math.sin(flowT * 0.7));
    const phase = Math.floor((ctrl.motion * 0.35 + high * 0.25) * 180);

    g.translate(cx, cy);
    g.rotate(rot);

    g.beginPath();
    const N = timeData.length;
    const step = Math.max(1, Math.floor(N / 900));
    for (let i = 0; i < N; i += step) {
      const v1 = (timeData[i] - 128) / 128;
      const v2 = (timeData[(i + phase) % N] - 128) / 128;
      const x = v1 * (W * sx * 0.5);
      const y = v2 * amp;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = `rgba(255,255,255,${0.08 + high * 0.10 + strobe * 0.16})`;
    g.lineWidth = 1.5 + bass * 2.2;
    g.stroke();

    // ghost traces
    if (strobe > 0.12 || ctrl.motion > 0.5) {
      g.globalAlpha = 0.55;
      for (let k = 0; k < 2; k++) {
        g.beginPath();
        const off = (k === 0 ? -1 : 1) * (6 + ctrl.motion * 14);
        for (let i = 0; i < N; i += step) {
          const v1 = (timeData[i] - 128) / 128;
          const v2 = (timeData[(i + phase + 30) % N] - 128) / 128;
          const x = v1 * (W * sx * 0.5) + off;
          const y = v2 * amp * (0.92 + k * 0.06);
          if (i === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.strokeStyle = `rgba(255,255,255,${0.06 + strobe * 0.10})`;
        g.lineWidth = 1;
        g.stroke();
      }
      g.globalAlpha = 1;
    }

    g.restore();
  }

  function drawScanGlitch(high, bass) {
    // scanlines
    const lines = 6 + Math.floor(high * 16);
    g.save();
    g.globalCompositeOperation = "overlay";
    g.strokeStyle = `rgba(255,255,255,${0.02 + high * 0.05})`;
    g.lineWidth = 1;
    for (let i = 0; i < lines; i++) {
      const y = (i / lines) * H + Math.sin(flowT * 2 + i) * (2 + ctrl.motion * 6);
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
    }
    g.restore();

    // occasional RGB split slice
    const chance = 0.008 + ctrl.motion * 0.02 + strobe * 0.06 + bass * 0.02;
    if (Math.random() < chance) {
      const y = randi(0, Math.floor(H));
      const h = randi(8, 26);
      const dx = randi(-18, 18) * (1 + ctrl.motion);

      const img = g.getImageData(0, y, Math.floor(W), h);

      g.save();
      g.globalCompositeOperation = "lighter";

      g.putImageData(img, dx - 2, y);
      g.fillStyle = "rgba(255,0,0,0.08)";
      g.fillRect(0, y, W, h);

      g.putImageData(img, dx + 2, y);
      g.fillStyle = "rgba(0,255,255,0.08)";
      g.fillRect(0, y, W, h);

      g.restore();
    }
  }

  function drawCube(bass, high, rms) {
    const cr = cubeRect();
    const cx = cr.x + cr.w * 0.5;
    const cy = cr.y + cr.h * 0.5;

    // cube scale responds to ROOM + bass
    const scale = (0.55 + ctrl.room * 0.85) * (1.0 + bass * 0.28);
    const s = cr.w * 0.28 * scale;

    const z = s * (0.55 + ctrl.room * 0.55);
    const wob = (high * 8 + rms * 10) * (0.25 + strobe * 0.9);
    const ox = z + Math.sin(flowT * 1.1) * wob;
    const oy = -z + Math.cos(flowT * 0.9) * wob;

    const A = { x: cx - s, y: cy - s };
    const B = { x: cx + s, y: cy - s };
    const C = { x: cx + s, y: cy + s };
    const D = { x: cx - s, y: cy + s };

    const A2 = { x: A.x + ox, y: A.y + oy };
    const B2 = { x: B.x + ox, y: B.y + oy };
    const C2 = { x: C.x + ox, y: C.y + oy };
    const D2 = { x: D.x + ox, y: D.y + oy };

    g.save();
    g.globalCompositeOperation = "lighter";

    const glow = 0.06 + (1 - ctrl.distance) * 0.08 + strobe * 0.10;
    g.strokeStyle = `rgba(255,255,255,${glow})`;
    g.lineWidth = 1.5;

    // front
    g.beginPath();
    g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.lineTo(C.x, C.y); g.lineTo(D.x, D.y); g.closePath();
    g.stroke();

    // back
    g.beginPath();
    g.moveTo(A2.x, A2.y); g.lineTo(B2.x, B2.y); g.lineTo(C2.x, C2.y); g.lineTo(D2.x, D2.y); g.closePath();
    g.stroke();

    // connectors
    g.beginPath();
    g.moveTo(A.x, A.y); g.lineTo(A2.x, A2.y);
    g.moveTo(B.x, B.y); g.lineTo(B2.x, B2.y);
    g.moveTo(C.x, C.y); g.lineTo(C2.x, C2.y);
    g.moveTo(D.x, D.y); g.lineTo(D2.x, D2.y);
    g.stroke();

    // subtle fill
    g.fillStyle = `rgba(255,255,255,${0.02 + ctrl.room * 0.03 + strobe * 0.04})`;
    g.beginPath();
    g.moveTo(A2.x, A2.y); g.lineTo(B2.x, B2.y); g.lineTo(C2.x, C2.y); g.lineTo(D2.x, D2.y); g.closePath();
    g.fill();

    // label
    g.fillStyle = `rgba(255,255,255,${0.30})`;
    g.font = "11px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
    g.fillText("ROOM (cube)", cr.x, cr.y - 10);

    g.restore();
  }

  function drawActors(bass, high, rms) {
    if (!stems.length) return;

    g.save();
    g.globalCompositeOperation = "lighter";

    stems.forEach((s, i) => {
      const p = s.params;
      const a = actorPosFromParams(p, i);

      const dist = curve01(p.dist, 1.4);
      const lev = clamp01(p.level);
      const mot = curve01(lerp(p.motion, ctrl.motion, 0.6), 1.2);

      const orbit = (mot * (18 + high * 24));
      const ox = Math.cos(flowT * (0.8 + mot * 1.6) + i) * orbit;
      const oy = Math.sin(flowT * (0.7 + mot * 1.4) + i) * orbit;

      const r = 7 + lev * 11 + bass * 10;
      const alpha = 0.10 + (1 - dist) * 0.16 + strobe * 0.12;

      // halo
      g.strokeStyle = `rgba(255,255,255,${alpha})`;
      g.lineWidth = 1;
      g.beginPath();
      g.arc(a.x + ox, a.y + oy, r * (1.9 + dist * 1.6), 0, Math.PI * 2);
      g.stroke();

      // core
      g.fillStyle = `rgba(255,255,255,${alpha * 1.2})`;
      g.beginPath();
      g.arc(a.x + ox, a.y + oy, r, 0, Math.PI * 2);
      g.fill();

      // label
      g.fillStyle = `rgba(255,255,255,${0.22 + alpha * 0.25})`;
      g.font = "10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      g.fillText(FILES[i]?.name || `STEM ${i}`, a.x + ox + 10, a.y + oy - 10);
    });

    g.restore();
  }

  // ---------------- Drift (when not touching) ----------------
  function autoDrift(dt, bass, mid, high, rms) {
    const idle = (nowSec() - interaction.lastTouchT);
    if (interaction.active || idle < 0.35) return;

    // very slow, “alive” drift
    const t = flowT;
    const breathe = 0.5 + 0.5 * Math.sin(t * 0.22);

    // global drift
    ctrl.distance = clamp01(ctrl.distance + (Math.sin(t * 0.18) * 0.00045 + (rms - 0.08) * 0.00025));
    ctrl.motion   = clamp01(ctrl.motion   + (Math.cos(t * 0.14) * 0.00040 + (high - 0.12) * 0.00020));
    ctrl.focus    = clamp01(0.50 + Math.sin(t * 0.12) * 0.10);

    // room breathes subtly with bass + time
    ctrl.room = clamp01(ctrl.room + (Math.sin(t * 0.16) * 0.00055 + (bass - 0.10) * 0.00025) * (0.7 + breathe * 0.6));

    // per-stem drift (tiny)
    stems.forEach((s, i) => {
      const p = s.params;
      const sign = (i === 0 ? -1 : 1);

      p.pos = clamp(p.pos + Math.sin(t * (0.10 + i * 0.03)) * 0.00055 * (0.7 + ctrl.motion), -1, 1);
      p.dist = clamp01(p.dist + Math.cos(t * (0.09 + i * 0.025) + sign) * 0.00045 * (0.8 + ctrl.distance));

      // keep width/motion/focus gently animated for richness
      p.width = clamp01(0.50 + Math.sin(t * (0.11 + i * 0.02)) * 0.10 + ctrl.motion * 0.18);
      p.motion = clamp01(0.30 + ctrl.motion * 0.55);
      p.focus = clamp01(0.45 + Math.sin(t * 0.07 + i) * 0.08);
    });

    applyAllParams();
  }

  // ---------------- Main viz loop ----------------
  function startViz() {
    if (!running) return;
    if (rafId) cancelAnimationFrame(rafId);

    let lastT = nowSec();
    const draw = () => {
      rafId = requestAnimationFrame(draw);

      // analysis
      analyser.getByteFrequencyData(freqData);
      analyser.getByteTimeDomainData(timeData);

      const bass = bandEnergy(0.00, 0.12);
      const mid  = bandEnergy(0.12, 0.45);
      const high = bandEnergy(0.45, 1.00);
      const rms  = waveformRMS();

      const t = nowSec();
      const dt = Math.max(0.001, t - lastT);
      lastT = t;

      flowT += 0.006 + ctrl.motion * 0.02 + high * 0.012;

      // transient -> strobe
      const dRMS = rms - prevRMS;
      prevRMS = rms;
      if (dRMS > 0.030 + bass * 0.028) strobe = Math.min(1, strobe + 0.85);
      strobe *= 0.86;

      // background persistence (distance makes fog)
      const fade = 0.18 + ctrl.distance * 0.34;
      g.fillStyle = `rgba(0,0,0,${fade})`;
      g.fillRect(0, 0, W, H);

      if (strobe > 0.02) {
        g.fillStyle = `rgba(255,255,255,${strobe * 0.12})`;
        g.fillRect(0, 0, W, H);
      }

      drawGrid(bass, high);
      drawWaterfall(high);
      drawParticles(bass, mid, high, rms);
      drawScope(bass, high, rms);
      drawScanGlitch(high, bass);

      // actors + cube overlays (interactive)
      drawActors(bass, high, rms);
      drawCube(bass, high, rms);

      autoDrift(dt, bass, mid, high, rms);
    };

    draw();
  }

  // ---------------- Start ----------------
  startBtn.addEventListener("click", async () => {
    if (running) return;
    running = true;

    try {
      debug.length = 0;
      setStatus("Loading...");
      log("START pressed.");

      ctx = new (window.AudioContext || window.webkitAudioContext)();
      await ctx.resume();
      log(`AudioContext: ${ctx.sampleRate}Hz`);

      createMaster();
      room = createStereoRoom();
      room.wetGain.connect(masterGain);

      // load buffers
      const buffers = await Promise.all(FILES.map(f => loadBuffer(f.url)));

      // build stems
      stems = buffers.map((buf, i) => buildStem(buf, defaultStemParams(i)));

      // initial apply
      applyAllParams();

      // hide overlay
      overlay.classList.add("hidden");

      setStatus("Playing — drag cube(ROOM), scroll(DIST), shift+scroll(MOTION), drag actors(STEMS)");
      log("Running.");

      startViz();
    } catch (e) {
      console.error(e);
      log(`FATAL: ${String(e && e.message ? e.message : e)}`);
      setStatus("Error: assets/drum.wav と assets/synthesizer.wav を確認して");
      running = false;
    }
  });

})();