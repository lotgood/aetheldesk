export function createForestScene({ prefersReducedMotion }) {
  let trees = null;
  let fireflies = null;
  let isNight = false;
  let elevation = 10;
  let frameId = null;

  function start(canvas, celestial) {
    isNight = celestial.phase === "night";
    elevation = celestial.elevation;
    trees = makeTrees(canvas.width, canvas.height);
    fireflies = makeFireflies(canvas.width, canvas.height);
    loop(canvas, 0);
  }

  function update(celestial) {
    isNight = celestial.phase === "night";
    elevation = celestial.elevation;
  }

  function stop() {
    if (frameId) cancelAnimationFrame(frameId);
    frameId = null;
  }

  function reset() {
    trees = null;
    fireflies = null;
  }

  function makeTrees(width, height) {
    const groundY = height * 0.75;
    const nextTrees = [];
    function addTree(x, spread) {
      const h = height * (0.18 + Math.random() * 0.30);
      const type = Math.random() > 0.38 ? "pine" : "round";
      nextTrees.push({
        x: x + (Math.random() - 0.5) * spread,
        groundY,
        h,
        w: h * (type === "pine" ? 0.38 : 0.60),
        type,
      });
    }
    for (let i = 0; i < 8; i++) addTree(Math.random() * width * 0.28, width * 0.10);
    for (let i = 0; i < 8; i++) addTree(width * 0.72 + Math.random() * width * 0.28, width * 0.10);
    return nextTrees.sort((a, b) => a.h - b.h);
  }

  function makeFireflies(width, height) {
    return Array.from({ length: 24 }, () => ({
      x: width * 0.05 + Math.random() * width * 0.90,
      y: height * (0.42 + Math.random() * 0.40),
      vy: -(0.08 + Math.random() * 0.22),
      vx: (Math.random() - 0.5) * 0.18,
      phase: Math.random() * Math.PI * 2,
      speed: 0.8 + Math.random() * 1.4,
      size: 1.4 + Math.random() * 1.6,
    }));
  }

  function loop(canvas, timestamp) {
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    const groundY = height * 0.75;
    const now = timestamp * 0.001;
    ctx.clearRect(0, 0, width, height);
    drawGround(ctx, { width, height, groundY });
    drawTrees(ctx);
    drawMist(ctx, { width, height, groundY });
    drawFireflies(ctx, { width, height, now });
    drawDayHaze(ctx, { width, height, groundY });
    if (!prefersReducedMotion()) frameId = requestAnimationFrame(nextTimestamp => loop(canvas, nextTimestamp));
  }

  function drawGround(ctx, { width, height, groundY }) {
    const ground = ctx.createLinearGradient(0, groundY, 0, height);
    ground.addColorStop(0, isNight ? "rgba(10,18,10,0.97)" : "rgba(32,52,20,0.93)");
    ground.addColorStop(1, isNight ? "rgba(4,8,4,1)" : "rgba(18,36,12,1)");
    ctx.fillStyle = ground;
    ctx.fillRect(0, groundY, width, height - groundY);
  }

  function drawTrees(ctx) {
    for (const tree of trees) {
      const dark = isNight ? 0.18 : Math.max(0.45, Math.min(0.85, (elevation + 10) / 60));
      ctx.fillStyle = isNight
        ? `rgba(${(10 + dark * 12) | 0},${(18 + dark * 22) | 0},${(10 + dark * 10) | 0},0.95)`
        : `rgba(${(22 + dark * 28) | 0},${(50 + dark * 48) | 0},${(18 + dark * 22) | 0},0.92)`;
      if (tree.type === "pine") {
        drawPine(ctx, tree);
      } else {
        drawRoundTree(ctx, tree, isNight);
      }
    }
  }

  function drawMist(ctx, { width, height, groundY }) {
    const mist = ctx.createLinearGradient(0, groundY - height * 0.09, 0, groundY + height * 0.04);
    mist.addColorStop(0, "rgba(0,0,0,0)");
    mist.addColorStop(0.55, isNight ? "rgba(140,165,155,0.07)" : "rgba(210,235,215,0.10)");
    mist.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = mist;
    ctx.fillRect(0, groundY - height * 0.09, width, height * 0.13);
  }

  function drawFireflies(ctx, { width, height, now }) {
    if (!isNight || !fireflies) return;
    for (const firefly of fireflies) {
      firefly.y += firefly.vy * 0.28;
      firefly.x += firefly.vx * 0.28;
      if (firefly.y < height * 0.32 || firefly.y > height * 0.87) firefly.vy *= -1;
      if (firefly.x < width * 0.03 || firefly.x > width * 0.97) firefly.vx *= -1;
      const glow = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(now * firefly.speed + firefly.phase));
      ctx.beginPath();
      ctx.arc(firefly.x, firefly.y, firefly.size, 0, Math.PI * 2);
      ctx.shadowColor = "rgba(170,255,90,0.85)";
      ctx.shadowBlur = 9 * glow;
      ctx.fillStyle = `rgba(195,255,110,${glow * 0.90})`;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  function drawDayHaze(ctx, { width, height, groundY }) {
    if (isNight || elevation <= 5) return;
    const haze = ctx.createLinearGradient(0, height * 0.48, 0, groundY);
    haze.addColorStop(0, "rgba(0,0,0,0)");
    haze.addColorStop(1, `rgba(255,228,140,${Math.min(0.09, elevation / 520)})`);
    ctx.fillStyle = haze;
    ctx.fillRect(0, height * 0.48, width, groundY - height * 0.48);
  }

  return { reset, start, stop, update };
}


function drawPine(ctx, tree) {
  ctx.beginPath();
  ctx.moveTo(tree.x, tree.groundY - tree.h);
  ctx.lineTo(tree.x - tree.w / 2, tree.groundY);
  ctx.lineTo(tree.x + tree.w / 2, tree.groundY);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(tree.x, tree.groundY - tree.h * 0.62);
  ctx.lineTo(tree.x - tree.w * 0.58, tree.groundY - tree.h * 0.20);
  ctx.lineTo(tree.x + tree.w * 0.58, tree.groundY - tree.h * 0.20);
  ctx.closePath();
  ctx.fill();
}


function drawRoundTree(ctx, tree, isNight) {
  ctx.beginPath();
  ctx.arc(tree.x, tree.groundY - tree.h * 0.55, tree.w / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = isNight ? "rgba(6,10,6,0.9)" : "rgba(45,30,16,0.85)";
  ctx.fillRect(tree.x - tree.w * 0.07, tree.groundY - tree.h * 0.20, tree.w * 0.14, tree.h * 0.20);
}
