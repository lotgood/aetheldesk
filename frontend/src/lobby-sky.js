/* The lobby sky mirrors real local time (like the room's default sky)
   instead of strobing through a fake fast day/night cycle. */
const KF = [
  { t: 0.00, top: "#0A0A14", bot: "#1A0A2E", dayF: 0 },
  { t: 0.18, top: "#1A0A2E", bot: "#2C1654", dayF: 0 },
  { t: 0.28, top: "#2C1654", bot: "#FF6B35", dayF: 0 },
  { t: 0.36, top: "#FFB347", bot: "#FF6B35", dayF: 1 },
  { t: 0.50, top: "#B8DFFF", bot: "#7ABFDC", dayF: 1 },
  { t: 0.64, top: "#FFB347", bot: "#FF6B35", dayF: 1 },
  { t: 0.72, top: "#2C1654", bot: "#FF6B35", dayF: 0 },
  { t: 0.82, top: "#1A0A2E", bot: "#2C1654", dayF: 0 },
  { t: 1.00, top: "#0A0A14", bot: "#1A0A2E", dayF: 0 },
];
const DAY_COLOR = [15, 30, 50];
const NIGHT_COLOR = [255, 255, 255];

function hexRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function lerpN(a, b, t) { return a + (b - a) * t; }
function lerpHex(h1, h2, t) {
  const [r1, g1, b1] = hexRgb(h1);
  const [r2, g2, b2] = hexRgb(h2);
  return `rgb(${Math.round(lerpN(r1, r2, t))},${Math.round(lerpN(g1, g2, t))},${Math.round(lerpN(b1, b2, t))})`;
}

function skyAt(t) {
  for (let i = 0; i < KF.length - 1; i++) {
    const a = KF[i];
    const b = KF[i + 1];
    if (t >= a.t && t <= b.t) {
      const f = (t - a.t) / (b.t - a.t);
      return { top: lerpHex(a.top, b.top, f), bot: lerpHex(a.bot, b.bot, f), dayF: lerpN(a.dayF, b.dayF, f) };
    }
  }
  return { top: "#0A0A14", bot: "#1A0A2E", dayF: 0 };
}

let starsReady = false;
function ensureStars() {
  if (starsReady) return;
  starsReady = true;
  const canvas = document.getElementById("stars");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext("2d");
  for (let i = 0; i < 180; i++) {
    ctx.beginPath();
    ctx.arc(Math.random() * canvas.width, Math.random() * canvas.height * 0.75,
            Math.random() * 1.2 + 0.3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.6 + 0.2})`;
    ctx.fill();
  }
}

function updateArc(arcPct, dayF) {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const rx = width * 0.42;
  const ry = height * 0.55;
  const cx = width / 2;
  const cy = height * 0.88;
  const arcD = `M ${cx - rx} ${cy} A ${rx} ${ry} 0 0 1 ${cx + rx} ${cy}`;
  document.getElementById("arc-path").setAttribute("d", arcD);
  const arcGlow = document.getElementById("arc-glow");
  if (arcGlow) arcGlow.setAttribute("d", arcD);
  const angle = Math.PI - arcPct * Math.PI;
  const x = cx + rx * Math.cos(angle);
  const y = cy - ry * Math.sin(angle);
  const sg = document.getElementById("sun-group");
  const mg = document.getElementById("moon-group");
  sg.style.transform = `translate(${x}px,${y}px)`;
  mg.style.transform = `translate(${x}px,${y}px)`;
  /* Fade the orb near the arc endpoints so it never sits clipped
     against the viewport corner. */
  const edgeFade = Math.max(0, Math.min(1, Math.sin(arcPct * Math.PI) * 2.2));
  const sunOpacity = Math.max(0, Math.min(1, (dayF - 0.15) / 0.35)) * edgeFade;
  const moonOpacity = Math.max(0, Math.min(1, (0.50 - dayF) / 0.35)) * edgeFade;
  sg.style.opacity = String(sunOpacity);
  mg.style.opacity = String(moonOpacity);
  document.getElementById("arc-path").setAttribute("stroke", dayF > 0.5 ? "rgba(15,30,50,0.15)" : "rgba(255,255,255,0.15)");
  document.getElementById("clouds").style.opacity = String(sunOpacity * 0.75);
}

let lobbyCloudState = null;
function initLobbyClouds() {
  const canvas = document.getElementById("clouds");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  lobbyCloudState = Array.from({ length: 5 }, (_, i) => ({
    x: Math.random() * canvas.width,
    y: canvas.height * (0.06 + i * 0.055 + Math.random() * 0.03),
    w: 110 + Math.random() * 90,
    h: 28 + Math.random() * 18,
    speed: 0.07 + Math.random() * 0.11,
  }));
}

function tickClouds(dayF) {
  const canvas = document.getElementById("clouds");
  if (dayF < 0.18) return;
  if (!lobbyCloudState) initLobbyClouds();
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(255,255,255,0.68)";
  for (const cloud of lobbyCloudState) {
    cloud.x += cloud.speed;
    if (cloud.x - cloud.w > canvas.width) cloud.x = -cloud.w;
    ctx.beginPath(); ctx.ellipse(cloud.x, cloud.y, cloud.w * 0.50, cloud.h * 0.50, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cloud.x - cloud.w * 0.28, cloud.y + cloud.h * 0.10, cloud.w * 0.28, cloud.h * 0.38, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cloud.x + cloud.w * 0.28, cloud.y + cloud.h * 0.10, cloud.w * 0.32, cloud.h * 0.42, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cloud.x, cloud.y - cloud.h * 0.30, cloud.w * 0.30, cloud.h * 0.40, 0, 0, Math.PI * 2); ctx.fill();
  }
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function currentPhase() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  return minutes / 1440;
}

export function startLobbySky() {
  function render(t, moveClouds) {
    const sky = skyAt(t);
    document.body.style.background = `linear-gradient(to bottom, ${sky.top}, ${sky.bot})`;
    const color = NIGHT_COLOR.map((n, i) => Math.round(lerpN(n, DAY_COLOR[i], sky.dayF)));
    document.body.style.color = `rgb(${color.join(",")})`;
    document.body.classList.toggle("day", sky.dayF > 0.5);
    const stars = document.getElementById("stars");
    const nightF = Math.max(0, 1 - sky.dayF);
    if (nightF > 0.05) {
      ensureStars();
      stars.style.opacity = String(nightF * 0.85);
    } else {
      stars.style.opacity = "0";
    }
    updateArc(t, sky.dayF);
    if (moveClouds) tickClouds(sky.dayF);
  }

  function frame() {
    render(currentPhase(), true);
    requestAnimationFrame(frame);
  }

  if (prefersReducedMotion()) {
    render(currentPhase(), false);
    return;
  }
  requestAnimationFrame(frame);
}
