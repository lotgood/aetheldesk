export function createBeachScene({ prefersReducedMotion }) {
  let t = 0;
  let isNight = false;
  let elevation = 10;
  let frameId = null;

  function start(canvas, celestial) {
    isNight = celestial.phase === "night";
    elevation = celestial.elevation;
    t = 0;
    loop(canvas);
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
    t = 0;
  }

  function loop(canvas) {
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    t += 0.008;
    ctx.clearRect(0, 0, width, height);

    const sandY = height * 0.80;
    const seaY = height * 0.50;
    drawOcean(ctx, { width, seaY, sandY });
    drawWaves(ctx, { width, height, sandY, t });
    drawReflection(ctx, { width, seaY, sandY });
    drawSand(ctx, { width, height, sandY });

    if (!prefersReducedMotion()) frameId = requestAnimationFrame(() => loop(canvas));
  }

  function drawOcean(ctx, { width, seaY, sandY }) {
    const ocean = ctx.createLinearGradient(0, seaY, 0, sandY);
    if (isNight) {
      ocean.addColorStop(0, "rgba(8,18,48,0.97)");
      ocean.addColorStop(1, "rgba(5,12,32,1)");
    } else if (elevation > 20) {
      ocean.addColorStop(0, "rgba(15,95,140,0.90)");
      ocean.addColorStop(1, "rgba(8,65,110,1)");
    } else {
      ocean.addColorStop(0, "rgba(25,75,120,0.88)");
      ocean.addColorStop(1, "rgba(12,52,95,1)");
    }
    ctx.fillStyle = ocean;
    ctx.fillRect(0, seaY, width, sandY - seaY);
  }

  function drawWaves(ctx, { width, height, sandY, t }) {
    const waves = [
      { amp: height * 0.013, freq: 0.010, spd: 1.00, yOff: sandY - height * 0.025, a: isNight ? 0.20 : 0.32 },
      { amp: height * 0.018, freq: 0.008, spd: 0.72, yOff: sandY - height * 0.060, a: isNight ? 0.15 : 0.25 },
      { amp: height * 0.022, freq: 0.006, spd: 0.50, yOff: sandY - height * 0.100, a: isNight ? 0.10 : 0.18 },
    ];

    for (const wave of waves) {
      drawWaveFill(ctx, { width, sandY, t, wave });
      drawWaveStroke(ctx, { width, t, wave });
    }
  }

  function drawWaveFill(ctx, { width, sandY, t, wave }) {
    ctx.beginPath();
    ctx.moveTo(0, wave.yOff);
    traceWave(ctx, { width, t, wave });
    ctx.lineTo(width, sandY);
    ctx.lineTo(0, sandY);
    ctx.closePath();
    ctx.fillStyle = isNight ? `rgba(30,70,130,${wave.a})` : `rgba(80,170,210,${wave.a})`;
    ctx.fill();
  }

  function drawWaveStroke(ctx, { width, t, wave }) {
    ctx.beginPath();
    ctx.moveTo(0, wave.yOff);
    traceWave(ctx, { width, t, wave });
    ctx.strokeStyle = isNight ? `rgba(100,150,220,${wave.a * 1.4})` : `rgba(255,255,255,${wave.a * 1.1})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  function traceWave(ctx, { width, t, wave }) {
    for (let x = 0; x <= width; x += 3) {
      const y =
        wave.yOff +
        Math.sin(x * wave.freq + t * wave.spd) * wave.amp +
        Math.sin(x * wave.freq * 1.8 + t * wave.spd * 0.6) * wave.amp * 0.35;
      ctx.lineTo(x, y);
    }
  }

  function drawReflection(ctx, { width, seaY, sandY }) {
    const rx = width * 0.35;
    const rw = width * 0.30;
    const reflection = ctx.createLinearGradient(rx, 0, rx + rw, 0);
    reflection.addColorStop(0, "rgba(0,0,0,0)");
    reflection.addColorStop(
      0.5,
      isNight ? "rgba(160,190,255,0.06)" : `rgba(255,225,120,${Math.min(0.13, Math.max(0, elevation / 55))})`
    );
    reflection.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = reflection;
    ctx.fillRect(rx, seaY, rw, sandY - seaY);
  }

  function drawSand(ctx, { width, height, sandY }) {
    const sand = ctx.createLinearGradient(0, sandY, 0, height);
    if (isNight) {
      sand.addColorStop(0, "rgba(52,46,36,0.95)");
      sand.addColorStop(1, "rgba(38,32,24,1)");
    } else if (elevation > 10) {
      sand.addColorStop(0, "rgba(215,188,142,0.95)");
      sand.addColorStop(1, "rgba(192,165,120,1)");
    } else {
      sand.addColorStop(0, "rgba(188,162,118,0.95)");
      sand.addColorStop(1, "rgba(168,142,100,1)");
    }
    ctx.fillStyle = sand;
    ctx.fillRect(0, sandY, width, height - sandY);

    const wetSand = ctx.createLinearGradient(0, sandY, 0, sandY + height * 0.032);
    wetSand.addColorStop(0, isNight ? "rgba(70,82,115,0.38)" : "rgba(140,175,200,0.32)");
    wetSand.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = wetSand;
    ctx.fillRect(0, sandY, width, height * 0.032);
  }

  return { reset, start, stop, update };
}
