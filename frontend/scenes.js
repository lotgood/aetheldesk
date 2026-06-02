// ─── Scene system ─────────────────────────────────────────────────────────────
import { readScene, storeScene } from './src/storage.js';

export const SCENES = ['sky', 'city', 'beach', 'forest'];
const SCENE_LABELS = { sky: '하늘', city: '도시', beach: '해변', forest: '숲' };
let activeScene = readScene('sky');
let lastCelestial = null;
const sceneRAFs = {};

(function initSceneBtn() {
  const btn = document.getElementById('btn-scene');
  if (btn) {
    btn.textContent = `◈ ${SCENE_LABELS[activeScene]}`;
    btn.setAttribute('aria-label', `장면 바꾸기: ${SCENE_LABELS[activeScene]}`);
  }
  document.body.dataset.scene = activeScene === 'sky' ? '' : activeScene;
})();

function stopScene(name) {
  if (sceneRAFs[name]) { cancelAnimationFrame(sceneRAFs[name]); delete sceneRAFs[name]; }
}
function stopAllScenes() { SCENES.forEach(s => stopScene(s)); }

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function renderScene(c) {
  lastCelestial = c;
  if (activeScene === 'sky') return;
  const canvas = document.getElementById(activeScene + '-canvas');
  if (!canvas) return;
  if (!canvas._started) {
    canvas._started = true;
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    if      (activeScene === 'city')   cityStart(canvas, c);
    else if (activeScene === 'beach')  beachStart(canvas, c);
    else if (activeScene === 'forest') forestStart(canvas, c);
    canvas.style.opacity = '1';
  } else {
    if      (activeScene === 'city')   cityOnCelestial(c);
    else if (activeScene === 'beach')  beachOnCelestial(c);
    else if (activeScene === 'forest') forestOnCelestial(c);
  }
}

function switchScene(name) {
  stopAllScenes();
  cityBldgs = null; forestTrees = null; forestFireflies = null;
  SCENES.filter(s => s !== 'sky').forEach(s => {
    const el = document.getElementById(s + '-canvas');
    if (el) { el.style.opacity = '0'; el._started = false; }
  });
  activeScene = name;
  storeScene(name);
  document.body.dataset.scene = name === 'sky' ? '' : name;
  const btn = document.getElementById('btn-scene');
  if (btn) {
    btn.textContent = `◈ ${SCENE_LABELS[name]}`;
    btn.setAttribute('aria-label', `장면 바꾸기: ${SCENE_LABELS[name]}`);
  }
  const status = document.getElementById('room-status');
  if (status) status.textContent = `${SCENE_LABELS[name]} 장면으로 바꿨습니다.`;
  if (name !== 'sky' && lastCelestial) renderScene(lastCelestial);
}

function bindSceneButton() {
  document.getElementById('btn-scene')?.addEventListener('click', () => {
    switchScene(SCENES[(SCENES.indexOf(activeScene) + 1) % SCENES.length]);
  });
}

// ─── City scene ───────────────────────────────────────────────────────────────
let cityBldgs = null, cityIsNight = true, cityToggleTimer = null;

function cityStart(canvas, c) {
  cityIsNight = c.phase === 'night';
  cityBldgs = cityMakeBuildings(canvas.width, canvas.height);
  cityScheduleWindowToggle();
  cityLoop(canvas);
}

function cityOnCelestial(c) {
  const wasNight = cityIsNight;
  cityIsNight = c.phase === 'night';
  if (wasNight !== cityIsNight && cityBldgs) {
    for (const b of cityBldgs)
      b.windows.forEach(w => { w.lit = Math.random() < (cityIsNight ? 0.55 : 0.12); });
  }
}

function cityMakeBuildings(W, H) {
  const groundY = H * 0.70;
  const bldgs = [];
  for (let x = -20; x < W + 80;) {
    const w = 35 + Math.random() * 55;
    const h = H * (0.08 + Math.random() * 0.20);
    bldgs.push(makeBldg(x, groundY, w, h, true));
    x += w + 1 + Math.random() * 6;
  }
  for (let x = -10; x < W + 60;) {
    const w = 45 + Math.random() * 75;
    const h = H * (0.15 + Math.random() * 0.38);
    bldgs.push(makeBldg(x, groundY, w, h, false));
    x += w + 2 + Math.random() * 12;
  }
  return bldgs;
}

function makeBldg(x, groundY, w, h, bg) {
  const cols = Math.max(2, Math.floor(w / 13));
  const rows = Math.max(2, Math.floor(h / 16));
  const windows = Array.from({ length: cols * rows }, () => ({
    lit:  Math.random() < (cityIsNight ? 0.55 : 0.12),
    warm: Math.random() > 0.20,
  }));
  return { x, y: groundY - h, w, h, cols, rows, windows, bg };
}

function cityScheduleWindowToggle() {
  if (prefersReducedMotion()) return;
  if (cityToggleTimer) clearTimeout(cityToggleTimer);
  function toggle() {
    if (!cityBldgs || activeScene !== 'city') return;
    const b = cityBldgs[Math.floor(Math.random() * cityBldgs.length)];
    const win = b.windows[Math.floor(Math.random() * b.windows.length)];
    win.lit = !win.lit;
    cityToggleTimer = setTimeout(toggle, 300 + Math.random() * 1400);
  }
  cityToggleTimer = setTimeout(toggle, 600);
}

function cityLoop(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const groundY = H * 0.70;
  const isNight = cityIsNight;

  ctx.clearRect(0, 0, W, H);

  // Ground
  const gg = ctx.createLinearGradient(0, groundY, 0, H);
  gg.addColorStop(0, isNight ? 'rgba(8,10,22,0.97)' : 'rgba(28,32,48,0.92)');
  gg.addColorStop(1, isNight ? 'rgba(4,5,12,1)'     : 'rgba(18,20,35,1)');
  ctx.fillStyle = gg; ctx.fillRect(0, groundY, W, H - groundY);

  // Street glow at night
  if (isNight) {
    const sg = ctx.createLinearGradient(0, groundY - 2, 0, groundY + 28);
    sg.addColorStop(0, 'rgba(255,160,30,0.10)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg; ctx.fillRect(0, groundY - 2, W, 30);
  }

  // Background buildings first, then foreground
  for (const pass of [true, false]) {
    for (const b of cityBldgs) {
      if (b.bg !== pass) continue;
      ctx.save();
      ctx.globalAlpha = b.bg ? 0.55 : 1.0;

      const sg2 = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
      sg2.addColorStop(0, isNight
        ? (b.bg ? 'rgba(18,20,38,0.85)' : 'rgba(12,14,28,0.97)')
        : (b.bg ? 'rgba(42,46,68,0.80)' : 'rgba(28,32,52,0.93)'));
      sg2.addColorStop(1, isNight ? 'rgba(6,7,16,1)' : 'rgba(18,20,38,1)');
      ctx.fillStyle = sg2; ctx.fillRect(b.x, b.y, b.w, b.h);

      const cw = b.w / b.cols, ch = b.h / b.rows;
      const ww = cw * 0.52, wh = ch * 0.50;
      for (let r = 0; r < b.rows; r++) {
        for (let col = 0; col < b.cols; col++) {
          const win = b.windows[r * b.cols + col];
          if (!win.lit) continue;
          const wx = b.x + col * cw + (cw - ww) / 2;
          const wy = b.y + r   * ch + (ch - wh) / 2;
          if (isNight) {
            ctx.shadowColor = win.warm ? 'rgba(255,190,60,0.5)' : 'rgba(180,220,255,0.4)';
            ctx.shadowBlur  = 5;
            ctx.fillStyle   = win.warm ? 'rgba(255,200,80,0.88)' : 'rgba(200,230,255,0.75)';
          } else {
            ctx.shadowBlur = 0;
            ctx.fillStyle  = 'rgba(200,220,255,0.20)';
          }
          ctx.fillRect(wx, wy, ww, wh);
          ctx.shadowBlur = 0;
        }
      }
      ctx.restore();
    }
  }

  if (!prefersReducedMotion()) sceneRAFs.city = requestAnimationFrame(() => cityLoop(canvas));
}

// ─── Beach scene ──────────────────────────────────────────────────────────────
let beachT = 0, beachIsNight = false, beachElev = 10;

function beachStart(canvas, c) {
  beachIsNight = c.phase === 'night';
  beachElev = c.elevation;
  beachT = 0;
  beachLoop(canvas);
}

function beachOnCelestial(c) {
  beachIsNight = c.phase === 'night';
  beachElev = c.elevation;
}

function beachLoop(canvas) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  beachT += 0.008;
  const t = beachT;
  const isNight = beachIsNight;
  const elev = beachElev;

  ctx.clearRect(0, 0, W, H);

  const sandY = H * 0.80;
  const seaY  = H * 0.50;

  // Ocean body
  const og = ctx.createLinearGradient(0, seaY, 0, sandY);
  if (isNight) {
    og.addColorStop(0, 'rgba(8,18,48,0.97)'); og.addColorStop(1, 'rgba(5,12,32,1)');
  } else if (elev > 20) {
    og.addColorStop(0, 'rgba(15,95,140,0.90)'); og.addColorStop(1, 'rgba(8,65,110,1)');
  } else {
    og.addColorStop(0, 'rgba(25,75,120,0.88)'); og.addColorStop(1, 'rgba(12,52,95,1)');
  }
  ctx.fillStyle = og; ctx.fillRect(0, seaY, W, sandY - seaY);

  // 3 wave layers
  const waves = [
    { amp: H * 0.013, freq: 0.010, spd: 1.00, yOff: sandY - H * 0.025, a: isNight ? 0.20 : 0.32 },
    { amp: H * 0.018, freq: 0.008, spd: 0.72, yOff: sandY - H * 0.060, a: isNight ? 0.15 : 0.25 },
    { amp: H * 0.022, freq: 0.006, spd: 0.50, yOff: sandY - H * 0.100, a: isNight ? 0.10 : 0.18 },
  ];

  for (const wv of waves) {
    ctx.beginPath();
    ctx.moveTo(0, wv.yOff);
    for (let x = 0; x <= W; x += 3) {
      const y = wv.yOff
        + Math.sin(x * wv.freq + t * wv.spd) * wv.amp
        + Math.sin(x * wv.freq * 1.8 + t * wv.spd * 0.6) * wv.amp * 0.35;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W, sandY); ctx.lineTo(0, sandY); ctx.closePath();
    ctx.fillStyle = isNight ? `rgba(30,70,130,${wv.a})` : `rgba(80,170,210,${wv.a})`;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(0, wv.yOff);
    for (let x = 0; x <= W; x += 3) {
      const y = wv.yOff
        + Math.sin(x * wv.freq + t * wv.spd) * wv.amp
        + Math.sin(x * wv.freq * 1.8 + t * wv.spd * 0.6) * wv.amp * 0.35;
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = isNight ? `rgba(100,150,220,${wv.a * 1.4})` : `rgba(255,255,255,${wv.a * 1.1})`;
    ctx.lineWidth = 1.2; ctx.stroke();
  }

  // Light reflection on water
  const rx = W * 0.35, rw = W * 0.30;
  const rg = ctx.createLinearGradient(rx, 0, rx + rw, 0);
  rg.addColorStop(0, 'rgba(0,0,0,0)');
  rg.addColorStop(0.5, isNight
    ? 'rgba(160,190,255,0.06)'
    : `rgba(255,225,120,${Math.min(0.13, Math.max(0, elev / 55))})`);
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg; ctx.fillRect(rx, seaY, rw, sandY - seaY);

  // Sand
  const sandG = ctx.createLinearGradient(0, sandY, 0, H);
  if (isNight) {
    sandG.addColorStop(0, 'rgba(52,46,36,0.95)'); sandG.addColorStop(1, 'rgba(38,32,24,1)');
  } else if (elev > 10) {
    sandG.addColorStop(0, 'rgba(215,188,142,0.95)'); sandG.addColorStop(1, 'rgba(192,165,120,1)');
  } else {
    sandG.addColorStop(0, 'rgba(188,162,118,0.95)'); sandG.addColorStop(1, 'rgba(168,142,100,1)');
  }
  ctx.fillStyle = sandG; ctx.fillRect(0, sandY, W, H - sandY);

  // Wet sand at waterline
  const wetG = ctx.createLinearGradient(0, sandY, 0, sandY + H * 0.032);
  wetG.addColorStop(0, isNight ? 'rgba(70,82,115,0.38)' : 'rgba(140,175,200,0.32)');
  wetG.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = wetG; ctx.fillRect(0, sandY, W, H * 0.032);

  if (!prefersReducedMotion()) sceneRAFs.beach = requestAnimationFrame(() => beachLoop(canvas));
}

// ─── Forest scene ─────────────────────────────────────────────────────────────
let forestTrees = null, forestFireflies = null, forestIsNight = false, forestElev = 10;

function forestStart(canvas, c) {
  forestIsNight = c.phase === 'night';
  forestElev = c.elevation;
  forestTrees = forestMakeTrees(canvas.width, canvas.height);
  forestFireflies = forestMakeFireflies(canvas.width, canvas.height);
  forestLoop(canvas, 0);
}

function forestOnCelestial(c) {
  forestIsNight = c.phase === 'night';
  forestElev = c.elevation;
}

function forestMakeTrees(W, H) {
  const gY = H * 0.75;
  const trees = [];
  function addTree(x, spread) {
    const h = H * (0.18 + Math.random() * 0.30);
    const type = Math.random() > 0.38 ? 'pine' : 'round';
    trees.push({ x: x + (Math.random() - 0.5) * spread, gY, h,
                 w: h * (type === 'pine' ? 0.38 : 0.60), type });
  }
  for (let i = 0; i < 8; i++) addTree(Math.random() * W * 0.28, W * 0.10);
  for (let i = 0; i < 8; i++) addTree(W * 0.72 + Math.random() * W * 0.28, W * 0.10);
  return trees.sort((a, b) => a.h - b.h);
}

function forestMakeFireflies(W, H) {
  return Array.from({ length: 24 }, () => ({
    x:     W * 0.05 + Math.random() * W * 0.90,
    y:     H * (0.42 + Math.random() * 0.40),
    vy:   -(0.08 + Math.random() * 0.22),
    vx:    (Math.random() - 0.5) * 0.18,
    phase: Math.random() * Math.PI * 2,
    speed: 0.8 + Math.random() * 1.4,
    size:  1.4 + Math.random() * 1.6,
  }));
}

function forestLoop(canvas, ts) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const isNight = forestIsNight;
  const elev = forestElev;
  const now = ts * 0.001;

  ctx.clearRect(0, 0, W, H);

  const gY = H * 0.75;

  // Ground
  const gg = ctx.createLinearGradient(0, gY, 0, H);
  gg.addColorStop(0, isNight ? 'rgba(10,18,10,0.97)' : 'rgba(32,52,20,0.93)');
  gg.addColorStop(1, isNight ? 'rgba(4,8,4,1)'       : 'rgba(18,36,12,1)');
  ctx.fillStyle = gg; ctx.fillRect(0, gY, W, H - gY);

  // Trees (shorter drawn first for natural layering)
  for (const tr of forestTrees) {
    const dark = isNight ? 0.18 : Math.max(0.45, Math.min(0.85, (elev + 10) / 60));
    ctx.fillStyle = isNight
      ? `rgba(${(10 + dark * 12) | 0},${(18 + dark * 22) | 0},${(10 + dark * 10) | 0},0.95)`
      : `rgba(${(22 + dark * 28) | 0},${(50 + dark * 48) | 0},${(18 + dark * 22) | 0},0.92)`;

    if (tr.type === 'pine') {
      ctx.beginPath();
      ctx.moveTo(tr.x, tr.gY - tr.h);
      ctx.lineTo(tr.x - tr.w / 2, tr.gY);
      ctx.lineTo(tr.x + tr.w / 2, tr.gY);
      ctx.closePath(); ctx.fill();
      // Second tier
      ctx.beginPath();
      ctx.moveTo(tr.x, tr.gY - tr.h * 0.62);
      ctx.lineTo(tr.x - tr.w * 0.58, tr.gY - tr.h * 0.20);
      ctx.lineTo(tr.x + tr.w * 0.58, tr.gY - tr.h * 0.20);
      ctx.closePath(); ctx.fill();
    } else {
      ctx.beginPath();
      ctx.arc(tr.x, tr.gY - tr.h * 0.55, tr.w / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = isNight ? 'rgba(6,10,6,0.9)' : 'rgba(45,30,16,0.85)';
      ctx.fillRect(tr.x - tr.w * 0.07, tr.gY - tr.h * 0.20, tr.w * 0.14, tr.h * 0.20);
    }
  }

  // Ground mist
  const mist = ctx.createLinearGradient(0, gY - H * 0.09, 0, gY + H * 0.04);
  mist.addColorStop(0, 'rgba(0,0,0,0)');
  mist.addColorStop(0.55, isNight ? 'rgba(140,165,155,0.07)' : 'rgba(210,235,215,0.10)');
  mist.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = mist; ctx.fillRect(0, gY - H * 0.09, W, H * 0.13);

  // Fireflies (night only)
  if (isNight && forestFireflies) {
    for (const ff of forestFireflies) {
      ff.y += ff.vy * 0.28;
      ff.x += ff.vx * 0.28;
      if (ff.y < H * 0.32 || ff.y > H * 0.87) ff.vy *= -1;
      if (ff.x < W * 0.03 || ff.x > W * 0.97) ff.vx *= -1;
      const glow = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(now * ff.speed + ff.phase));
      ctx.beginPath();
      ctx.arc(ff.x, ff.y, ff.size, 0, Math.PI * 2);
      ctx.shadowColor = 'rgba(170,255,90,0.85)';
      ctx.shadowBlur  = 9 * glow;
      ctx.fillStyle   = `rgba(195,255,110,${glow * 0.90})`;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // Daytime sun haze near ground
  if (!isNight && elev > 5) {
    const haze = ctx.createLinearGradient(0, H * 0.48, 0, gY);
    haze.addColorStop(0, 'rgba(0,0,0,0)');
    haze.addColorStop(1, `rgba(255,228,140,${Math.min(0.09, elev / 520)})`);
    ctx.fillStyle = haze; ctx.fillRect(0, H * 0.48, W, gY - H * 0.48);
  }

  if (!prefersReducedMotion()) sceneRAFs.forest = requestAnimationFrame(ts2 => forestLoop(canvas, ts2));
}

function resetForResize() {
  if (activeScene === 'sky') return;
  stopAllScenes();
  cityBldgs = null; forestTrees = null; forestFireflies = null;
  const el = document.getElementById(activeScene + '-canvas');
  if (el) el._started = false;
}

export function createSceneController() {
  bindSceneButton();
  return {
    render: renderScene,
    resetForResize,
    switchScene,
    getActiveScene: () => activeScene,
  };
}
