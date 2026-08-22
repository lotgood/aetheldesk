import * as THREE from "three";

// ─── Sky: a sea of cloud seen from altitude ──────────────────────────────
// Art direction: no props, no primaries. Three parallax bands of soft cloud
// resting below the eye line, a clean horizon, and a single quiet stratum
// drifting through the lower third. Every color is pulled from the shared
// atmosphere grade so the scene is warm at golden hour and silver at night
// without ever inventing a hue of its own.
//
// Silver lining: puffs carry their own material instance (sprites never
// batch, so the clones are free) and each cloud is brightened toward the
// key light by its angular proximity to the sun/moon — the edge of the
// cloud sea near the light catches, the far side stays calm.

const CLOUD_TEX_SIZE = 256;

function makePuffTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = CLOUD_TEX_SIZE;
  canvas.height = CLOUD_TEX_SIZE;
  const ctx = canvas.getContext("2d");
  const c = CLOUD_TEX_SIZE / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  // Tight falloff: a soft gradient this wide turns overlapping sprites into
  // one flat wash, so the core stays opaque and the edge dies quickly.
  grad.addColorStop(0.0, "rgba(255,255,255,1.0)");
  grad.addColorStop(0.42, "rgba(255,255,255,0.94)");
  grad.addColorStop(0.68, "rgba(255,255,255,0.45)");
  grad.addColorStop(0.86, "rgba(255,255,255,0.10)");
  grad.addColorStop(1.0, "rgba(255,255,255,0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CLOUD_TEX_SIZE, CLOUD_TEX_SIZE);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Cirrus are ice streaks, not puffs: a wide ellipse with soft long edges.
function makeStreakTexture() {
  const w = 256;
  const h = 64;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
  grad.addColorStop(0.0, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.35)");
  grad.addColorStop(1.0, "rgba(255,255,255,0.0)");
  ctx.fillStyle = grad;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.scale(1, h / w);
  ctx.translate(-w / 2, -h / 2);
  ctx.fillRect(0, 0, w, w);
  ctx.restore();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function sstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

// A gull silhouette: two wing arcs, nothing more. White in the texture so
// the material color can grade it into a backlit silhouette.
function makeBirdTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 32;
  const ctx = canvas.getContext("2d");
  ctx.strokeStyle = "rgba(255,255,255,1)";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(6, 26);
  ctx.quadraticCurveTo(20, 4, 32, 20);
  ctx.quadraticCurveTo(44, 4, 58, 26);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createSkyScene() {
  const group = new THREE.Group();
  group.name = "scene-sky";

  const puffTex = makePuffTexture();
  const streakTex = makeStreakTexture();

  // Three depth bands. Nearer bands are larger, faster and slightly darker;
  // far bands sit closer to the fog color, which is what sells the distance.
  const BANDS = [
    // Clouds belong ABOVE the horizon. Sitting them below it put white
    // shapes against the palest part of the dome, where they had no value
    // separation left to read with — the reason they kept disappearing.
    { count: 11, z: -520, y: 110, spread: 1400, scale: 78, speed: 1.6, fogMix: 0.5, opacity: 0.7 },
    { count: 8, z: -330, y: 78, spread: 1050, scale: 62, speed: 2.8, fogMix: 0.22, opacity: 0.88 },
    { count: 5, z: -210, y: 52, spread: 800, scale: 48, speed: 4.4, fogMix: 0.04, opacity: 1.0 },
  ];

  const bands = [];

  for (const cfg of BANDS) {
    // A cloud is a cluster of overlapping puffs. One sprite per cloud reads
    // as a flat lozenge; five staggered puffs give it a silhouette. Each
    // puff owns its material so the silver lining can grade it separately.
    const items = [];
    const PUFFS = 5;
    for (let i = 0; i < cfg.count; i++) {
      const cx = (Math.random() - 0.5) * cfg.spread;
      const cy = cfg.y + (Math.random() - 0.5) * 14;
      const cz = cfg.z + (Math.random() - 0.5) * 50;
      const base = cfg.scale * (0.7 + Math.random() * 0.6);
      const phase = Math.random() * Math.PI * 2;

      for (let p = 0; p < PUFFS; p++) {
        const mat = new THREE.SpriteMaterial({
          map: puffTex,
          transparent: true,
          depthWrite: false,
          opacity: cfg.opacity,
          color: 0xffffff,
          fog: false,
        });
        const sprite = new THREE.Sprite(mat);
        const t = p / (PUFFS - 1) - 0.5;
        const s = base * (0.5 + Math.random() * 0.55) * (1 - Math.abs(t) * 0.45);
        const ox = t * base * 1.15 + (Math.random() - 0.5) * base * 0.2;
        const oy = (Math.random() - 0.25) * base * 0.16 - Math.abs(t) * base * 0.05;
        sprite.position.set(cx + ox, cy + oy, cz + (Math.random() - 0.5) * 8);
        sprite.scale.set(s, s * 0.62, 1);
        group.add(sprite);
        items.push({ sprite, mat, baseY: cy + oy, phase });
      }
    }

    bands.push({ cfg, items });
  }

  // ─── Horizon haze band ────────────────────────────────────────────────
  // A wide, very soft strip sitting exactly on the eye line. It reads as the
  // top of the cloud sea and gives the frame a calm horizontal anchor
  // instead of an empty gradient.
  const hazeMat = new THREE.SpriteMaterial({
    map: puffTex,
    transparent: true,
    depthWrite: false,
    opacity: 0.42,
    fog: false,
  });
  const haze = new THREE.Sprite(hazeMat);
  haze.position.set(0, -26, -640);
  haze.scale.set(1800, 58, 1);
  group.add(haze);

  // ─── Cirrus streaks ───────────────────────────────────────────────────
  // One thin, very high layer. Ice catches the key light long after the
  // cloud sea has gone silver, so these stay warmest at dawn and dusk.
  const cirrus = [];
  for (let i = 0; i < 6; i++) {
    const mat = new THREE.SpriteMaterial({
      map: streakTex,
      transparent: true,
      depthWrite: false,
      opacity: 0,
      fog: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set((i - 2.5) * 320 + (Math.random() - 0.5) * 120, 190 + Math.random() * 55, -620);
    sprite.scale.set(420 + Math.random() * 160, 22 + Math.random() * 10, 1);
    group.add(sprite);
    cirrus.push({ sprite, mat, speed: 0.6 + i * 0.15 });
  }

  // ─── Birds ────────────────────────────────────────────────────────────
  // A loose handful of gulls crossing the mid-distance. They read as pure
  // silhouette against the bright sky, so they grade darker than the fog
  // and roost at night. One shared material: position and flap live on the
  // sprites themselves.
  const birdMat = new THREE.SpriteMaterial({
    map: makeBirdTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0,
    color: 0x1a2030,
    fog: false,
  });
  const birds = [];
  for (let i = 0; i < 4; i++) {
    const sprite = new THREE.Sprite(birdMat);
    const size = 5 + Math.random() * 3;
    sprite.position.set(-500 + i * 260 + Math.random() * 80, 64 + Math.random() * 50, -280 - Math.random() * 90);
    sprite.scale.set(size, size * 0.5, 1);
    group.add(sprite);
    birds.push({
      sprite,
      baseY: sprite.position.y,
      speed: 6 + Math.random() * 4,
      phase: Math.random() * Math.PI * 2,
      size,
    });
  }

  // ─── Working colors (preallocated; update() never allocates) ──────────
  const baseCloud = new THREE.Color("#d8dce6");
  const nightCloud = new THREE.Color("#7c88a8");
  const scratch = new THREE.Color();
  const cirrusScratch = new THREE.Color();
  const lightPos = new THREE.Vector3(0.3, 0.4, -0.86);
  const lightDirN = new THREE.Vector3();
  const itemDir = new THREE.Vector3();

  function applyGrade(atmosphere) {
    if (!atmosphere) return;
    const g = atmosphere.current;
    const day = atmosphere.daylight;
    const elev = atmosphere.elevation;

    // Lining peaks through the golden band and drops to a faint moonlit
    // trace once the sun is well below the horizon.
    const lowSun = elev <= -6 ? 0.35 : 1 - sstep(10, 26, elev);
    lightDirN.copy(lightPos).normalize();

    for (const band of bands) {
      // Lit face takes the sun/key tint; the body sits between a neutral
      // daylight cloud and a moonlit one. Distance then pulls it into fog.
      scratch.copy(nightCloud).lerp(baseCloud, day);
      scratch.lerp(g.key, 0.3 * day);
      scratch.lerp(g.fog, band.cfg.fogMix);
      // Clouds need to sit above the sky in value to read — but only just.
      // Pushing them hard turned the upper half of the frame into a bright
      // sheet and flattened the whole image (measured spread 117/255).
      scratch.multiplyScalar(0.94 + day * 0.12);
      const opacity = band.cfg.opacity * (0.62 + day * 0.18);

      for (const item of band.items) {
        itemDir.copy(item.sprite.position).normalize();
        const lining = Math.pow(Math.max(0, itemDir.dot(lightDirN)), 4) * lowSun;
        item.mat.color.copy(scratch).multiplyScalar(1 + lining * 0.5).lerp(g.key, lining * 0.45);
        item.mat.opacity = opacity;
      }
    }

    // The horizon band is an accent, not a veil: heavy opacity here was
    // what turned the whole lower frame into milk.
    scratch.copy(g.fog).lerp(g.skyHorizon, 0.5);
    hazeMat.color.copy(scratch);
    hazeMat.opacity = 0.1 + day * 0.1;

    // Cirrus: barely there at noon, warmest when the light is low.
    cirrusScratch.copy(g.fog).lerp(g.key, 0.3 + 0.4 * lowSun).lerp(g.skyHorizon, 0.2);
    const cirrusOpacity = 0.05 + day * 0.05 + lowSun * day * 0.08;
    for (const c of cirrus) {
      c.mat.color.copy(cirrusScratch);
      c.mat.opacity = cirrusOpacity;
    }

    // Birds: darker than the fog behind them, and home by night.
    cirrusScratch.copy(g.fog).multiplyScalar(0.4);
    birdMat.color.copy(cirrusScratch);
    birdMat.opacity = day * 0.55;
  }

  function updateCelestial(_c, atmosphere) {
    applyGrade(atmosphere);
  }

  function update(delta, elapsed, atmosphere) {
    applyGrade(atmosphere);

    for (const band of bands) {
      const limit = band.cfg.spread * 0.5;
      for (const item of band.items) {
        const p = item.sprite.position;
        p.x += band.cfg.speed * delta;
        if (p.x > limit) p.x = -limit;
        // Barely-there vertical breathing so the sea is never fully static.
        p.y = item.baseY + Math.sin(elapsed * 0.08 + item.phase) * 1.6;
      }
    }

    for (const c of cirrus) {
      c.sprite.position.x += c.speed * delta;
      if (c.sprite.position.x > 1000) c.sprite.position.x = -1000;
    }

    // Birds glide; the wingbeat is the one motion worth gating.
    const flapOn = !prefersReducedMotion();
    for (const b of birds) {
      b.sprite.position.x += b.speed * delta;
      if (b.sprite.position.x > 620) b.sprite.position.x = -620;
      b.sprite.position.y = b.baseY + Math.sin(elapsed * 0.5 + b.phase) * 2;
      const flap = flapOn ? 0.65 + 0.35 * Math.sin(elapsed * 6 + b.phase) : 1;
      b.sprite.scale.set(b.size, b.size * 0.5 * flap, 1);
    }
  }

  return {
    group,
    updateCelestial,
    update,
    /** scenes.js feeds the live sun/moon position for the silver lining. */
    setLightDirection(pos) {
      lightPos.copy(pos);
    },
  };
}
