import { byId } from "./dom.js";


const SAT_RADIUS = 58;


export function createCelestialRenderer({ sceneController }) {
  let celestialPos = null;
  let cloudState = null;
  let cloudRAF = null;

  function prefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  function renderCelestial(c) {
    document.body.style.setProperty("--sky-top", c.gradient[0]);
    document.body.style.setProperty("--sky-bot", c.gradient[1]);

    const width = window.innerWidth;
    const height = window.innerHeight;
    const rx = width * 0.42;
    const ry = height * 0.55;
    const cx = width / 2;
    const cy = height * 0.88;
    byId("arc-path").setAttribute("d", `M ${cx - rx} ${cy} A ${rx} ${ry} 0 0 1 ${cx + rx} ${cy}`);

    const angle = Math.PI - c.arc_pct * Math.PI;
    const x = cx + rx * Math.cos(angle);
    const y = cy - ry * Math.sin(angle);
    const sg = byId("sun-group");
    const mg = byId("moon-group");
    sg.style.transform = `translate(${x}px,${y}px)`;
    mg.style.transform = `translate(${x}px,${y}px)`;

    celestialPos = { x, y };
    byId("sat-group").style.transform = `translate(${x}px,${y}px)`;

    const elev = c.elevation;
    sg.style.opacity = String(Math.max(0, Math.min(1, (elev + 6) / 8)));
    mg.style.opacity = String(Math.max(0, Math.min(1, (2 - elev) / 8)));
    document.body.classList.toggle("day", c.phase === "day");

    const stars = byId("stars");
    stars.style.opacity = c.phase === "night" ? "1" : "0";
    if (c.phase === "night" && !stars.dataset.drawn) drawStars(stars);

    const sunF = Math.max(0, Math.min(1, (elev + 6) / 8));
    byId("clouds").style.opacity = String(sunF * 0.75);
    initClouds();
    sceneController.render(c);
  }

  function drawStars(canvas) {
    canvas.dataset.drawn = "1";
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext("2d");
    for (let i = 0; i < 180; i++) {
      ctx.beginPath();
      ctx.arc(Math.random() * canvas.width, Math.random() * canvas.height * 0.75, Math.random() * 1.2 + 0.3, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.6 + 0.2})`;
      ctx.fill();
    }
  }

  function initClouds() {
    if (cloudState) return;
    const canvas = byId("clouds");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    cloudState = Array.from({ length: 5 }, (_, i) => ({
      x: Math.random() * canvas.width,
      y: canvas.height * (0.06 + i * 0.055 + Math.random() * 0.03),
      w: 110 + Math.random() * 90,
      h: 28 + Math.random() * 18,
      speed: 0.07 + Math.random() * 0.11,
    }));
    animateClouds();
  }

  function animateClouds() {
    const canvas = byId("clouds");
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const cloud of cloudState) {
      if (!prefersReducedMotion()) cloud.x += cloud.speed;
      if (cloud.x - cloud.w > canvas.width) cloud.x = -cloud.w;
      drawCloud(ctx, cloud.x, cloud.y, cloud.w, cloud.h);
    }
    if (prefersReducedMotion()) return;
    cloudRAF = requestAnimationFrame(animateClouds);
  }

  function drawCloud(ctx, x, y, w, h) {
    ctx.save();
    ctx.fillStyle = "rgba(255,255,255,0.68)";
    ctx.beginPath(); ctx.ellipse(x, y, w * 0.50, h * 0.50, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x - w * 0.28, y + h * 0.10, w * 0.28, h * 0.38, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x + w * 0.28, y + h * 0.10, w * 0.32, h * 0.42, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(x, y - h * 0.30, w * 0.30, h * 0.40, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function renderSatellite(state) {
    const sat = byId("sat-group");
    const rot = byId("sat-rot");
    if (!state.focus || !celestialPos || state.pomodoro_duration <= 0) {
      sat.style.opacity = "0";
      return;
    }
    const progress = Math.max(0, Math.min(1, 1 - state.pomodoro_remaining / state.pomodoro_duration));
    const angle = progress * 2 * Math.PI;
    rot.style.transform = `translate(${SAT_RADIUS * Math.sin(angle)}px, ${-SAT_RADIUS * Math.cos(angle)}px)`;
    sat.style.opacity = "1";
  }

  function resetForResize(currentState) {
    if (!currentState) return;
    delete byId("stars").dataset.drawn;
    cloudState = null;
    if (cloudRAF) {
      cancelAnimationFrame(cloudRAF);
      cloudRAF = null;
    }
    sceneController.resetForResize();
    renderCelestial(currentState.celestial);
  }

  return { renderCelestial, renderSatellite, resetForResize };
}
