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
const authPrompt = document.getElementById("room-auth");
const roomPinInput = document.getElementById("room-pin-input");
const roomAuthError = document.getElementById("room-auth-error");
const roomPinSubmit = document.getElementById("room-pin-submit");
let ws = null;
let reconnectAttempt = 0;
let reconnectTimer = null;

function tokenStorageKey(roomId) { return `room_token:${roomId}`; }
function readRoomToken() { return sessionStorage.getItem(tokenStorageKey(ROOM_ID)); }
function storeRoomToken(token) { sessionStorage.setItem(tokenStorageKey(ROOM_ID), token); }
function clearRoomToken() { sessionStorage.removeItem(tokenStorageKey(ROOM_ID)); }

function wsUrl(token) {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws/${ROOM_ID}?token=${encodeURIComponent(token)}`;
}

function showAuthPrompt(message) {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  connDot.style.opacity = "0";
  authPrompt.classList.remove("hidden");
  authPrompt.classList.add("flex");
  roomAuthError.textContent = message || "";
  roomPinInput.value = "";
  setTimeout(() => roomPinInput.focus(), 50);
}

function hideAuthPrompt() {
  authPrompt.classList.add("hidden");
  authPrompt.classList.remove("flex");
  roomAuthError.textContent = "";
  roomPinInput.value = "";
}

async function joinRoomWithPin() {
  const pin = roomPinInput.value.trim();
  if (!pin) { roomPinInput.focus(); return; }
  roomAuthError.textContent = "";
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(ROOM_ID)}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    if (!response.ok) throw new Error("room rejected");
    const data = await response.json();
    storeRoomToken(data.token);
    hideAuthPrompt();
    reconnectAttempt = 0;
    connect();
  } catch (_) {
    clearRoomToken();
    showAuthPrompt("입장할 수 없습니다");
  } finally {
    roomPinInput.value = "";
  }
}

function connect() {
  const token = readRoomToken();
  if (!token) { showAuthPrompt(""); return; }
  hideAuthPrompt();
  ws = new WebSocket(wsUrl(token));

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

  ws.onclose = event => {
    connDot.style.opacity = "0";
    if (event.code === 1008) {
      clearRoomToken();
      showAuthPrompt("입장할 수 없습니다");
      return;
    }
    // Exponential backoff: 1s, 2s, 4s, 8s, capped at 30s. Beats reloading the
    // whole page (and looping forever when the server is down).
    const delay = Math.min(30000, 1000 * 2 ** reconnectAttempt++);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, delay);
  };

  ws.onerror = () => { try { ws.close(); } catch {} };
}

roomPinSubmit.addEventListener("click", joinRoomWithPin);
roomPinInput.addEventListener("keydown", e => {
  if (e.key === "Enter") joinRoomWithPin();
});
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
  window.AethelScenes.render(c);
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
  window.AethelScenes.resetForResize();
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
    const AudioContextCtor = window.AudioContext || window["webkit" + "AudioContext"];
    const ctx = new AudioContextCtor();
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
