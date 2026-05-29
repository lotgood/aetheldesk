// ─── Room ID from URL path /room/XXXX ────────────────────────────────────────
const ROOM_ID = location.pathname.split("/").pop().toUpperCase();
document.getElementById("room-label").textContent = `# ${ROOM_ID}`;

// Playlist: persisted in localStorage, falls back to built-in IDs
const DEFAULT_IDS = ["jfKfPfyJRdk", "5qap5aO4i9A", "DWcJFNfaw9c"];

function readPlaylist() {
  try {
    const v = JSON.parse(localStorage.getItem("playlist") || "null");
    return Array.isArray(v) && v.length ? v : null;
  } catch {
    localStorage.removeItem("playlist");
    return null;
  }
}

const savedPlaylist = readPlaylist();
const SKIP_IDS = savedPlaylist || [...DEFAULT_IDS];
let skipIdx = 0;

let currentState = null;
let ytPlayer = null, ytReady = false, pendingVideoId = null;
let celestialPos = null; // current sun/moon screen position, for the session satellite

const isTouch = navigator.maxTouchPoints > 1;
if (isTouch) document.body.classList.add("touch");

// ─── WebSocket ────────────────────────────────────────────────────────────────
const connDot = document.getElementById("conn-dot");
const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${ROOM_ID}`;
let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;

function connect() {
  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    reconnectAttempt = 0;
    connDot.style.opacity = "0.35";
    // If location permission is already granted, apply it silently — no prompt
    navigator.permissions?.query({ name: "geolocation" }).then(r => {
      if (r.state === "granted") {
        navigator.geolocation.getCurrentPosition(
          pos => send({ type: "location", lat: pos.coords.latitude, lon: pos.coords.longitude }),
          () => {}
        );
      }
    }).catch(() => {});
  });

  ws.onmessage = e => {
    try {
      const payload = JSON.parse(e.data);
      if (payload?.data) applyState(payload.data);
    } catch (err) {
      console.warn("ws message parse failed", err);
    }
  };

  ws.onclose = () => {
    connDot.style.opacity = "0";
    // Exponential backoff: 1s, 2s, 4s, 8s, capped at 30s. Beats reloading the
    // whole page (and looping forever when the server is down).
    const delay = Math.min(30000, 1000 * 2 ** reconnectAttempt++);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  };

  ws.onerror = () => { try { ws.close(); } catch {} };
}
connect();

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ─── State ────────────────────────────────────────────────────────────────────
function applyState(s) {
  const prevBreak = currentState?.break;
  currentState = s;

  if (!prevBreak && s.break) playChime(); // focus completed → break began
  if (prevBreak && !s.break) playChime(); // break ended

  const idx = SKIP_IDS.indexOf(s.music.video_id);
  if (idx !== -1) skipIdx = idx;

  renderCelestial(s.celestial);
  renderFocus(s.focus, s.pomodoro_remaining, s.break, s.break_remaining, s.paused);
  renderSatellite(s);
  renderSessions(s.sessions_done);
  updateDurChips(Math.round(s.pomodoro_duration / 60));
  syncYT(s.music);
  syncSlider(s);
  tickClock();
  tickDate();
}

// ─── Celestial ────────────────────────────────────────────────────────────────
function renderCelestial(c) {
  document.body.style.setProperty("--sky-top", c.gradient[0]);
  document.body.style.setProperty("--sky-bot", c.gradient[1]);

  const W = window.innerWidth, H = window.innerHeight;
  const rx = W * 0.42, ry = H * 0.55, cx = W / 2, cy = H * 0.88;

  document.getElementById("arc-path").setAttribute("d",
    `M ${cx - rx} ${cy} A ${rx} ${ry} 0 0 1 ${cx + rx} ${cy}`);

  const angle = Math.PI - c.arc_pct * Math.PI;
  const x = cx + rx * Math.cos(angle);
  const y = cy - ry * Math.sin(angle);

  const sg = document.getElementById("sun-group");
  const mg = document.getElementById("moon-group");
  sg.style.transform = `translate(${x}px,${y}px)`;
  mg.style.transform = `translate(${x}px,${y}px)`;

  celestialPos = { x, y };
  document.getElementById("sat-group").style.transform = `translate(${x}px,${y}px)`;

  // Smooth crossfade: sun fades in from elev -6° → +2°, moon fades out inversely
  const elev = c.elevation;
  sg.style.opacity = String(Math.max(0, Math.min(1, (elev + 6) / 8)));
  mg.style.opacity = String(Math.max(0, Math.min(1, (2 - elev) / 8)));

  document.body.classList.toggle("day", c.phase === "day");

  const stars = document.getElementById("stars");
  stars.style.opacity = c.phase === "night" ? "1" : "0";
  if (c.phase === "night" && !stars.dataset.drawn) drawStars(stars);

  const sunF = Math.max(0, Math.min(1, (elev + 6) / 8));
  document.getElementById("clouds").style.opacity = String(sunF * 0.75);
  initClouds();
  renderScene(c);
}

function drawStars(canvas) {
  canvas.dataset.drawn = "1";
  canvas.width = window.innerWidth; canvas.height = window.innerHeight;
  const ctx = canvas.getContext("2d");
  for (let i = 0; i < 180; i++) {
    ctx.beginPath();
    ctx.arc(Math.random() * canvas.width, Math.random() * canvas.height * 0.75,
            Math.random() * 1.2 + 0.3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.6 + 0.2})`;
    ctx.fill();
  }
}

// ─── Clouds ───────────────────────────────────────────────────────────────────
let cloudState = null, cloudRAF = null;

function initClouds() {
  if (cloudState) return;
  const c = document.getElementById("clouds");
  c.width = window.innerWidth; c.height = window.innerHeight;
  cloudState = Array.from({ length: 5 }, (_, i) => ({
    x: Math.random() * c.width,
    y: c.height * (0.06 + i * 0.055 + Math.random() * 0.03),
    w: 110 + Math.random() * 90,
    h: 28 + Math.random() * 18,
    speed: 0.07 + Math.random() * 0.11,
  }));
  animateClouds();
}

function animateClouds() {
  const canvas = document.getElementById("clouds");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const cl of cloudState) {
    cl.x += cl.speed;
    if (cl.x - cl.w > canvas.width) cl.x = -cl.w;
    drawCloud(ctx, cl.x, cl.y, cl.w, cl.h);
  }
  cloudRAF = requestAnimationFrame(animateClouds);
}

function drawCloud(ctx, x, y, w, h) {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.68)";
  ctx.beginPath(); ctx.ellipse(x,           y,           w * 0.50, h * 0.50, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x - w * 0.28, y + h * 0.10, w * 0.28, h * 0.38, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x + w * 0.28, y + h * 0.10, w * 0.32, h * 0.42, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x,           y - h * 0.30, w * 0.30, h * 0.40, 0, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// Redraw on resize — critical for iPad rotation
window.addEventListener("resize", () => {
  if (!currentState) return;
  delete document.getElementById("stars").dataset.drawn;
  cloudState = null;
  if (cloudRAF) { cancelAnimationFrame(cloudRAF); cloudRAF = null; }
  if (activeScene !== 'sky') {
    stopAllScenes();
    cityBldgs = null; forestTrees = null; forestFireflies = null;
    const el = document.getElementById(activeScene + '-canvas');
    if (el) el._started = false;
  }
  renderCelestial(currentState.celestial);
});

// ─── Focus / Break / Pomodoro ─────────────────────────────────────────────────
function renderFocus(focus, remaining, isBreak, breakRemaining, paused) {
  const btn      = document.getElementById("focus-btn");
  const durChips = document.getElementById("dur-chips");
  const pom      = document.getElementById("pomodoro");
  const pomTime  = document.getElementById("pom-time");
  const breakRow = document.getElementById("break-row");
  const focusRow = document.getElementById("focus-row");
  const pauseBtn = document.getElementById("btn-pause-timer");

  if (focus) {
    btn.style.opacity      = "0";   btn.style.pointerEvents = "none";
    durChips.style.opacity = "0";   durChips.style.pointerEvents = "none";
    pom.style.opacity      = "1";   pom.style.pointerEvents = "auto";
    pomTime.textContent    = fmtTime(remaining);
    pomTime.style.opacity  = paused ? "0.45" : "1"; // dim the frozen timer
    breakRow.style.opacity = "0";   breakRow.style.pointerEvents = "none";
    focusRow.style.opacity = "1";   focusRow.style.pointerEvents = "auto";
    pauseBtn.textContent   = paused ? "재개" : "정지";
  } else if (isBreak) {
    btn.style.opacity      = "0";   btn.style.pointerEvents = "none";
    durChips.style.opacity = "0";   durChips.style.pointerEvents = "none";
    pom.style.opacity      = "1";   pom.style.pointerEvents = "auto";
    pomTime.textContent    = fmtTime(breakRemaining);
    pomTime.style.opacity  = "1";
    breakRow.style.opacity = "1";   breakRow.style.pointerEvents = "auto";
    focusRow.style.opacity = "0";   focusRow.style.pointerEvents = "none";
  } else {
    btn.style.opacity      = "1";   btn.style.pointerEvents = "auto";
    durChips.style.opacity = "1";   durChips.style.pointerEvents = "auto";
    pom.style.opacity      = "0";   pom.style.pointerEvents = "none";
    pomTime.style.opacity  = "1";
    breakRow.style.opacity = "0";   breakRow.style.pointerEvents = "none";
    focusRow.style.opacity = "0";   focusRow.style.pointerEvents = "none";
  }
}

function fmtTime(sec) {
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

// ─── Session satellite ────────────────────────────────────────────────────────
// A small body that orbits the sun/moon once per focus session; its angle shows
// how far the timer has progressed (top = just started, full loop = complete).
const SAT_RADIUS = 58;
function renderSatellite(s) {
  const sat = document.getElementById("sat-group");
  const rot = document.getElementById("sat-rot");
  if (!s.focus || !celestialPos || s.pomodoro_duration <= 0) {
    sat.style.opacity = "0";
    return;
  }
  const progress = Math.max(0, Math.min(1, 1 - s.pomodoro_remaining / s.pomodoro_duration));
  const a = progress * 2 * Math.PI; // 0 = top, increasing clockwise
  rot.style.transform = `translate(${SAT_RADIUS * Math.sin(a)}px, ${-SAT_RADIUS * Math.cos(a)}px)`;
  sat.style.opacity = "1";
}

// ─── Duration chips ───────────────────────────────────────────────────────────
function setDur(m) {
  send({ type: "set_duration", minutes: m });
}

function updateDurChips(activeMin) {
  document.querySelectorAll("#dur-chips button").forEach(btn => {
    btn.classList.toggle("active", parseInt(btn.dataset.min, 10) === activeMin);
  });
}

document.querySelectorAll("#dur-chips button").forEach(btn => {
  btn.addEventListener("click", () => {
    const min = parseInt(btn.dataset.min, 10);
    const activeMin = currentState ? Math.round(currentState.pomodoro_duration / 60) : null;
    // First tap selects the length; tapping the already-selected chip starts it.
    if (min === activeMin) send({ type: "focus_toggle" });
    else setDur(min);
  });
});

// ─── Session counter ──────────────────────────────────────────────────────────
function renderSessions(n) {
  const el = document.getElementById("sessions");
  if (!el || n === 0) { if (el) el.textContent = ""; return; }
  const pos = n % 4 || 4;
  el.textContent = "●".repeat(pos) + "○".repeat(4 - pos);
}

// ─── Completion chime (Web Audio) ─────────────────────────────────────────────
function playChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [[528, 0], [396, 0.3], [528, 0.7]].forEach(([freq, when]) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = "sine"; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.18, ctx.currentTime + when);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + when + 1.2);
      osc.start(ctx.currentTime + when);
      osc.stop(ctx.currentTime + when + 1.2);
    });
  } catch (_) {}
}

// ─── YouTube ──────────────────────────────────────────────────────────────────
window.onYouTubeIframeAPIReady = () => {
  ytPlayer = new YT.Player("yt-frame", {
    videoId: currentState?.music?.video_id ?? "jfKfPfyJRdk",
    playerVars: { autoplay: 0, controls: 0, playsinline: 1 },
    events: { onReady: () => { ytReady = true; if (currentState) syncYT(currentState.music); } },
  });
};

function loadVideo(id) {
  pendingVideoId = id;
  ytPlayer.loadVideoById(id);
}

function syncYT(music) {
  if (!ytReady || !ytPlayer) return;
  if (music.playing) {
    if (music.video_id === pendingVideoId) {
      // Already loading optimistically — just ensure play, don't restart.
      pendingVideoId = null;
      ytPlayer.playVideo();
    } else if (ytPlayer.getVideoData?.()?.video_id !== music.video_id) {
      loadVideo(music.video_id);
    } else {
      ytPlayer.playVideo();
    }
  } else {
    pendingVideoId = null;
    ytPlayer.pauseVideo();
  }
}

// ─── Clock & Date ─────────────────────────────────────────────────────────────
function tickClock() {
  // Always the real device time — independent of the sky time-slider.
  document.getElementById("clock").textContent =
    new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

function tickDate() {
  document.getElementById("date-label").textContent =
    new Date().toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "short" });
}

function startClock() {
  tickClock(); tickDate();
  const msToNextMin = (60 - new Date().getSeconds()) * 1000;
  setTimeout(() => { tickClock(); setInterval(tickClock, 60000); }, msToNextMin);
}
startClock();

// ─── Auto-hide controls (desktop) ────────────────────────────────────────────
if (!isTouch) {
  const ctrl = document.getElementById("controls");
  ctrl.style.opacity = "0";
  let idleTimer;
  document.addEventListener("mousemove", () => {
    ctrl.style.opacity = "1"; // reveal on mouse move in any state (incl. focus/break)
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { ctrl.style.opacity = "0"; }, 3000);
  });
}

// ─── Music bar ────────────────────────────────────────────────────────────────
function showMusicBar() {
  const bar = document.getElementById("music-bar");
  bar.style.opacity       = "1";
  bar.style.pointerEvents = "auto";
  bar.style.transform     = "translateY(0)";
}
if (savedPlaylist) showMusicBar();

// ─── Time slider ──────────────────────────────────────────────────────────────
const timeSlider = document.getElementById("time-slider");
let sliderTouchedAt = 0; // suppress remote sync while this user is dragging

const sendOverride = debounce(val => {
  const h = Math.floor(val / 60), m = val % 60;
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const offMin = -now.getTimezoneOffset(); // getTimezoneOffset returns (UTC - local), flip for ISO sign
  const sign = offMin >= 0 ? "+" : "-";
  const abs = Math.abs(offMin);
  const offStr = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  send({ type: "time_override", iso: `${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00${offStr}` });
}, 80);

// Reflect the room's shared time on the slider (so everyone's bar moves together).
function syncSlider(s) {
  if (Date.now() - sliderTouchedAt < 1500) return; // don't fight a local drag
  if (s.time_override) {
    const m = s.time_override.match(/T(\d{2}):(\d{2})/);
    if (m) timeSlider.value = String(+m[1] * 60 + +m[2]);
  } else {
    const now = new Date();
    timeSlider.value = String(now.getHours() * 60 + now.getMinutes());
  }
}

function resetTime() {
  sliderTouchedAt = Date.now();
  send({ type: "time_override", iso: null });
  const now = new Date();
  timeSlider.value = String(now.getHours() * 60 + now.getMinutes());
}

timeSlider.addEventListener("input", e => { sliderTouchedAt = Date.now(); sendOverride(Number(e.target.value)); });
timeSlider.addEventListener("dblclick", resetTime);
document.getElementById("btn-reset-time").addEventListener("click", resetTime);

// ─── Playlist management ──────────────────────────────────────────────────────
function parseYtId(input) {
  const m = input.match(/(?:v=|youtu\.be\/|embed\/)([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
  return null;
}

const trackInput  = document.getElementById("track-input");
const actionBarEl = document.getElementById("action-bar");
const trackRowEl  = document.getElementById("track-row");

function openTrackRow() {
  actionBarEl.style.display = "none";
  trackRowEl.style.display  = "flex";
  trackInput.value = "";
  trackInput.style.borderBottomColor = "";
  setTimeout(() => trackInput.focus(), 50);
}
function closeTrackRow() {
  trackRowEl.style.display  = "none";
  actionBarEl.style.display = "";
}

function submitTrack() {
  const id = parseYtId(trackInput.value.trim());
  if (!id) { trackInput.style.borderBottomColor = "rgba(255,80,80,0.7)"; return; }
  if (!SKIP_IDS.includes(id)) {
    if (SKIP_IDS.length >= 50) SKIP_IDS.splice(0, 1); // drop oldest when capped
    SKIP_IDS.push(id);
    localStorage.setItem("playlist", JSON.stringify(SKIP_IDS));
  }
  skipIdx = SKIP_IDS.indexOf(id);
  // Start loading immediately — don't wait for WS echo.
  if (ytReady && ytPlayer) loadVideo(id);
  send({ type: "music_skip", video_id: id });
  send({ type: "music_play" });
  closeTrackRow();
  showMusicBar();
}

document.getElementById("btn-add-track").addEventListener("click", openTrackRow);
document.getElementById("track-add").addEventListener("click", submitTrack);
document.getElementById("track-cancel").addEventListener("click", closeTrackRow);
trackInput.addEventListener("keydown", e => {
  if (e.key === "Enter") submitTrack();
  else if (e.key === "Escape") closeTrackRow();
});

// ─── GPS location ─────────────────────────────────────────────────────────────
document.getElementById("btn-locate").addEventListener("click", () => {
  navigator.geolocation?.getCurrentPosition(
    pos => send({ type: "location", lat: pos.coords.latitude, lon: pos.coords.longitude }),
    () => {}
  );
});

// ─── Exit confirmation ────────────────────────────────────────────────────────
document.getElementById("btn-exit").addEventListener("click", () => {
  const active = currentState && (currentState.focus || currentState.break);
  if (active) {
    document.getElementById("action-bar").style.display    = "none";
    document.getElementById("exit-confirm").style.display  = "flex";
  } else {
    location.href = "/";
  }
});
document.getElementById("btn-exit-yes").addEventListener("click", () => { location.href = "/"; });
document.getElementById("btn-exit-no").addEventListener("click", () => {
  document.getElementById("exit-confirm").style.display = "none";
  document.getElementById("action-bar").style.display   = "";
});

// ─── Buttons ──────────────────────────────────────────────────────────────────
document.getElementById("focus-btn").addEventListener("click",      () => send({ type: "focus_toggle" }));
document.getElementById("btn-pause-timer").addEventListener("click",  () => send({ type: "focus_pause" }));
document.getElementById("btn-cancel-timer").addEventListener("click", () => send({ type: "focus_cancel" }));
document.getElementById("btn-skip-break").addEventListener("click", () => send({ type: "skip_break" }));
document.getElementById("btn-play").addEventListener("click",       () => send({ type: "music_play" }));
document.getElementById("btn-pause").addEventListener("click",      () => send({ type: "music_pause" }));
document.getElementById("btn-skip").addEventListener("click", () => {
  skipIdx = (skipIdx + 1) % SKIP_IDS.length;
  const id = SKIP_IDS[skipIdx];
  if (ytReady && ytPlayer) loadVideo(id);
  send({ type: "music_skip", video_id: id });
});

// ─── Scene system ─────────────────────────────────────────────────────────────
const SCENES = ['sky', 'city', 'beach', 'forest'];
const SCENE_LABELS = { sky: '하늘', city: '도시', beach: '해변', forest: '숲' };
let activeScene = localStorage.getItem('scene') || 'sky';
let lastCelestial = null;
const sceneRAFs = {};

(function initSceneBtn() {
  const btn = document.getElementById('btn-scene');
  if (btn) btn.textContent = `◈ ${SCENE_LABELS[activeScene]}`;
  document.body.dataset.scene = activeScene === 'sky' ? '' : activeScene;
})();

function stopScene(name) {
  if (sceneRAFs[name]) { cancelAnimationFrame(sceneRAFs[name]); delete sceneRAFs[name]; }
}
function stopAllScenes() { SCENES.forEach(s => stopScene(s)); }

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
  localStorage.setItem('scene', name);
  document.body.dataset.scene = name === 'sky' ? '' : name;
  const btn = document.getElementById('btn-scene');
  if (btn) btn.textContent = `◈ ${SCENE_LABELS[name]}`;
  if (name !== 'sky' && lastCelestial) renderScene(lastCelestial);
}

document.getElementById('btn-scene')?.addEventListener('click', () => {
  switchScene(SCENES[(SCENES.indexOf(activeScene) + 1) % SCENES.length]);
});

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

  sceneRAFs.city = requestAnimationFrame(() => cityLoop(canvas));
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

  sceneRAFs.beach = requestAnimationFrame(() => beachLoop(canvas));
}

// ─── Forest scene ─────────────────────────────────────────────────────────────
let forestTrees = null, forestFireflies = null, forestIsNight = false, forestElev = 10;

function forestStart(canvas, c) {
  forestIsNight = c.phase === 'night';
  forestElev = c.elevation;
  forestTrees = forestMakeTrees(canvas.width, canvas.height);
  forestFireflies = forestMakeFireflies(canvas.width, canvas.height);
  sceneRAFs.forest = requestAnimationFrame(ts => forestLoop(canvas, ts));
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

  sceneRAFs.forest = requestAnimationFrame(ts2 => forestLoop(canvas, ts2));
}
