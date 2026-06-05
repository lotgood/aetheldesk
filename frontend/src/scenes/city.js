export function createCityScene({ isActive, prefersReducedMotion }) {
  let buildings = null;
  let isNight = true;
  let toggleTimer = null;
  let frameId = null;

  function start(canvas, celestial) {
    isNight = celestial.phase === "night";
    buildings = makeBuildings(canvas.width, canvas.height);
    scheduleWindowToggle();
    loop(canvas);
  }

  function update(celestial) {
    const wasNight = isNight;
    isNight = celestial.phase === "night";
    if (wasNight !== isNight && buildings) {
      for (const building of buildings) {
        building.windows.forEach(windowState => {
          windowState.lit = Math.random() < (isNight ? 0.55 : 0.12);
        });
      }
    }
  }

  function stop() {
    if (frameId) cancelAnimationFrame(frameId);
    if (toggleTimer) clearTimeout(toggleTimer);
    frameId = null;
    toggleTimer = null;
  }

  function reset() {
    buildings = null;
  }

  function makeBuildings(width, height) {
    const groundY = height * 0.70;
    const nextBuildings = [];
    for (let x = -20; x < width + 80;) {
      const w = 35 + Math.random() * 55;
      const h = height * (0.08 + Math.random() * 0.20);
      nextBuildings.push(makeBuilding(x, groundY, w, h, true));
      x += w + 1 + Math.random() * 6;
    }
    for (let x = -10; x < width + 60;) {
      const w = 45 + Math.random() * 75;
      const h = height * (0.15 + Math.random() * 0.38);
      nextBuildings.push(makeBuilding(x, groundY, w, h, false));
      x += w + 2 + Math.random() * 12;
    }
    return nextBuildings;
  }

  function makeBuilding(x, groundY, w, h, bg) {
    const cols = Math.max(2, Math.floor(w / 13));
    const rows = Math.max(2, Math.floor(h / 16));
    const windows = Array.from({ length: cols * rows }, () => ({
      lit: Math.random() < (isNight ? 0.55 : 0.12),
      warm: Math.random() > 0.20,
    }));
    return { x, y: groundY - h, w, h, cols, rows, windows, bg };
  }

  function scheduleWindowToggle() {
    if (prefersReducedMotion()) return;
    if (toggleTimer) clearTimeout(toggleTimer);
    function toggle() {
      if (!buildings || !isActive()) return;
      const building = buildings[Math.floor(Math.random() * buildings.length)];
      const windowState = building.windows[Math.floor(Math.random() * building.windows.length)];
      windowState.lit = !windowState.lit;
      toggleTimer = setTimeout(toggle, 300 + Math.random() * 1400);
    }
    toggleTimer = setTimeout(toggle, 600);
  }

  function loop(canvas) {
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    const groundY = height * 0.70;
    ctx.clearRect(0, 0, width, height);

    const ground = ctx.createLinearGradient(0, groundY, 0, height);
    ground.addColorStop(0, isNight ? "rgba(8,10,22,0.97)" : "rgba(28,32,48,0.92)");
    ground.addColorStop(1, isNight ? "rgba(4,5,12,1)" : "rgba(18,20,35,1)");
    ctx.fillStyle = ground;
    ctx.fillRect(0, groundY, width, height - groundY);

    if (isNight) {
      const streetGlow = ctx.createLinearGradient(0, groundY - 2, 0, groundY + 28);
      streetGlow.addColorStop(0, "rgba(255,160,30,0.10)");
      streetGlow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = streetGlow;
      ctx.fillRect(0, groundY - 2, width, 30);
    }

    for (const pass of [true, false]) {
      for (const building of buildings) {
        if (building.bg !== pass) continue;
        drawBuilding(ctx, building, isNight);
      }
    }

    if (!prefersReducedMotion()) frameId = requestAnimationFrame(() => loop(canvas));
  }

  return { reset, start, stop, update };
}


function drawBuilding(ctx, building, isNight) {
  ctx.save();
  ctx.globalAlpha = building.bg ? 0.55 : 1.0;
  const gradient = ctx.createLinearGradient(0, building.y, 0, building.y + building.h);
  gradient.addColorStop(
    0,
    isNight
      ? (building.bg ? "rgba(18,20,38,0.85)" : "rgba(12,14,28,0.97)")
      : (building.bg ? "rgba(42,46,68,0.80)" : "rgba(28,32,52,0.93)")
  );
  gradient.addColorStop(1, isNight ? "rgba(6,7,16,1)" : "rgba(18,20,38,1)");
  ctx.fillStyle = gradient;
  ctx.fillRect(building.x, building.y, building.w, building.h);

  const cellW = building.w / building.cols;
  const cellH = building.h / building.rows;
  const winW = cellW * 0.52;
  const winH = cellH * 0.50;
  for (let row = 0; row < building.rows; row++) {
    for (let col = 0; col < building.cols; col++) {
      const windowState = building.windows[row * building.cols + col];
      if (!windowState.lit) continue;
      const wx = building.x + col * cellW + (cellW - winW) / 2;
      const wy = building.y + row * cellH + (cellH - winH) / 2;
      if (isNight) {
        ctx.shadowColor = windowState.warm ? "rgba(255,190,60,0.5)" : "rgba(180,220,255,0.4)";
        ctx.shadowBlur = 5;
        ctx.fillStyle = windowState.warm ? "rgba(255,200,80,0.88)" : "rgba(200,230,255,0.75)";
      } else {
        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(200,220,255,0.20)";
      }
      ctx.fillRect(wx, wy, winW, winH);
      ctx.shadowBlur = 0;
    }
  }
  ctx.restore();
}
