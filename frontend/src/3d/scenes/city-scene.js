import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

// ─── City: a skyline seen from a quiet rooftop ───────────────────────────
// Reference principles (Blade Runner 2049 / Deakins + proven three.js
// night-city technique):
//   • Walls stay dark; the windows do the talking at night. Cool city
//     shell against warm interior light is THE night-city contrast.
//   • Haze is a building material: far towers dissolve into it, so the
//     city reads as endless instead of ending at a drawn edge.
//   • Massing makes the silhouette: podiums, setbacks, crowns, spires and
//     rooftop clutter — never bare boxes.
//   • Light moves: traffic draws long-exposure trails, searchlights sweep,
//     individual windows change state.
//
// Geometry strategy: the whole skyline (towers + clutter) is ONE merged
// vertex-colored mesh, and every lit window is ONE merged vertex-colored
// quad mesh. Two draw calls for the entire static city.

const GROUND_Y = -7.5;
const CAMERA_SAFE_RADIUS = 46;

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function makeGlowTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, "rgba(255,255,255,1.0)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.32)");
  grad.addColorStop(1.0, "rgba(255,255,255,0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ─── Merged-geometry helpers ─────────────────────────────────────────────

const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 6);

// One tile = 4 window bays × 3 floors of curtain wall: glass panels with
// per-panel value jitter, spandrel bands, mullion lines. Neutral grays so
// the atmosphere grade keeps full control of hue. This texture is what
// stops the towers reading as smooth CG boxes.
function makeFacadeTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#8b8b8b";
  ctx.fillRect(0, 0, size, size);
  let s = 12345;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const cols = 4;
  const rows = 3;
  const cw = size / cols;
  const ch = size / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = 128 + Math.floor(rnd() * 36) - 18;
      ctx.fillStyle = `rgb(${v},${v},${v + 4})`;
      ctx.fillRect(c * cw + 2, r * ch + 2, cw - 4, ch - 10);
      ctx.fillStyle = "#6e6e6e";
      ctx.fillRect(c * cw + 2, r * ch + ch - 8, cw - 4, 6);
    }
  }
  ctx.fillStyle = "#585858";
  for (let c = 0; c <= cols; c++) ctx.fillRect(c * cw - 1, 0, 2, size);
  for (let r = 0; r <= rows; r++) ctx.fillRect(0, r * ch - 1, size, 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Box UVs are 0..1 per face; rescale them so the facade texture repeats
// every ~2.4 units across and ~3.2 per floor, whatever the part's size.
function scaleUV(geo, w, h, d) {
  const uv = geo.attributes.uv;
  const n = geo.attributes.normal;
  for (let i = 0; i < uv.count; i++) {
    let su;
    let sv;
    if (Math.abs(n.getY(i)) > 0.5) {
      su = w / 7;
      sv = d / 7;
    } else if (Math.abs(n.getX(i)) > 0.5) {
      su = d / 2.4;
      sv = h / 3.2;
    } else {
      su = w / 2.4;
      sv = h / 3.2;
    }
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  return geo;
}

// Vertical gradient in WORLD y, painted after transforms: rooftops sink
// toward the sky, street level carries the city's warm bounce. Face
// orientation is baked in too — side and rear faces sit lower in value so
// the volume reads even when the graded light is flat.
function paintRange(geo, y0, y1, cBottom, cTop) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  const range = Math.max(1e-5, y1 - y0);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - y0) / range));
    c.copy(cBottom).lerp(cTop, t);
    const ny = nrm.getY(i);
    if (ny > 0.5) c.multiplyScalar(1.07);
    else if (ny < -0.5) c.multiplyScalar(0.4);
    else if (Math.abs(nrm.getX(i)) > 0.5) c.multiplyScalar(0.84);
    else if (nrm.getZ(i) < -0.5) c.multiplyScalar(0.74);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}

function paintSolid(geo, color) {
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geo;
}

function boxPart(list, w, h, d, x, yBottom, z, y0, y1, cBottom, cTop) {
  const g = BOX.clone();
  g.scale(w, h, d);
  scaleUV(g, w, h, d);
  g.translate(x, yBottom + h / 2, z);
  list.push(paintRange(g, y0, y1, cBottom, cTop));
}

// ─── Road network ─────────────────────────────────────────────────────────
// The ground is a 1200-unit plane tiled every 200 units. Each tile holds a
// street grid: avenues at 1/4 and 3/4, minor streets on the halves. Two
// maps: an asphalt albedo for day, and a warm emissive for night — the
// streetlamp glow that makes the city floor radiate in the reference.
function makeRoadTextures() {
  const size = 512;
  let s = 777;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  const day = document.createElement("canvas");
  day.width = size;
  day.height = size;
  const dctx = day.getContext("2d");
  dctx.fillStyle = "#41454c";
  dctx.fillRect(0, 0, size, size);
  // City blocks: 4×4 per tile, slight value jitter per lot.
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const v = 62 + Math.floor(rnd() * 14) - 7;
      dctx.fillStyle = `rgb(${v},${v + 2},${v + 6})`;
      dctx.fillRect(c * 128 + 5, r * 128 + 5, 118, 118);
    }
  }
  // Streets cut darker lines through the blocks.
  dctx.fillStyle = "#31343a";
  for (const p of [0, 256]) {
    dctx.fillRect(0, p - 2, size, 5);
    dctx.fillRect(p - 2, 0, 5, size);
  }
  for (const p of [128, 384]) {
    dctx.fillRect(0, p - 5, size, 10);
    dctx.fillRect(p - 5, 0, 10, size);
  }

  const glow = document.createElement("canvas");
  glow.width = size;
  glow.height = size;
  const gctx = glow.getContext("2d");
  gctx.fillStyle = "#000000";
  gctx.fillRect(0, 0, size, size);
  // Blocks keep a faint lot warmth — parking, signage bleed.
  for (let i = 0; i < 10; i++) {
    const gx = rnd() * size;
    const gy = rnd() * size;
    const grad = gctx.createRadialGradient(gx, gy, 0, gx, gy, 34 + rnd() * 30);
    grad.addColorStop(0, "rgba(255,150,70,0.14)");
    grad.addColorStop(1, "rgba(255,150,70,0)");
    gctx.fillStyle = grad;
    gctx.fillRect(0, 0, size, size);
  }
  // Minor streets: thin warm threads. Avenues: wide and hot.
  gctx.fillStyle = "rgba(255,160,80,0.4)";
  for (const p of [0, 256]) {
    gctx.fillRect(0, p - 1, size, 3);
    gctx.fillRect(p - 1, 0, 3, size);
  }
  for (const p of [128, 384]) {
    gctx.fillStyle = "rgba(255,170,90,0.85)";
    gctx.fillRect(0, p - 4, size, 8);
    gctx.fillRect(p - 4, 0, 8, size);
    gctx.fillStyle = "rgba(255,217,160,0.9)";
    gctx.fillRect(0, p - 1, size, 2);
    gctx.fillRect(p - 1, 0, 2, size);
  }

  const dayTex = new THREE.CanvasTexture(day);
  dayTex.wrapS = dayTex.wrapT = THREE.RepeatWrapping;
  dayTex.repeat.set(6, 6);
  dayTex.colorSpace = THREE.SRGBColorSpace;
  dayTex.anisotropy = 4;
  const glowTex2 = new THREE.CanvasTexture(glow);
  glowTex2.wrapS = glowTex2.wrapT = THREE.RepeatWrapping;
  glowTex2.repeat.set(6, 6);
  glowTex2.colorSpace = THREE.SRGBColorSpace;
  return { dayTex, glowTex: glowTex2 };
}

// ─── Window palette ───────────────────────────────────────────────────────
// Tungsten dominates; cool LED, neutral and the odd fluorescent tube fill
// in. Per-window brightness jitter keeps the grid from reading as print.
const WINDOW_TEMPS = [
  { c: new THREE.Color("#ffd9a0"), w: 0.58 },
  { c: new THREE.Color("#cfe4ff"), w: 0.24 },
  { c: new THREE.Color("#fff6e8"), w: 0.12 },
  { c: new THREE.Color("#d9ffd2"), w: 0.06 },
];

function pickWindowColor(rng, out) {
  let roll = rng();
  for (const t of WINDOW_TEMPS) {
    if (roll < t.w) return out.copy(t.c);
    roll -= t.w;
  }
  return out.copy(WINDOW_TEMPS[0].c);
}

// ─── Skyline generation ───────────────────────────────────────────────────

function generateSkyline() {
  const rng = makeRng(20260818);
  const shellGeos = [];
  const windowGeos = [];
  const buildings = [];
  const spireTops = [];
  const flickerSpots = [];

  const cBottom = new THREE.Color();
  const cTop = new THREE.Color();
  const winColor = new THREE.Color();

  function addWindows(x, z, w, d, yBase, height, litRatio, crownBoost, accentFrac = -1) {
    const floors = Math.max(1, Math.floor((height - 3) / 2.8));
    const cols = Math.max(1, Math.floor((w - 1.8) / 2.0));
    const x0 = x - ((cols - 1) * 2.0) / 2;
    const zFace = z + d / 2 + 0.06;
    const accentCol = accentFrac >= 0 ? Math.round((cols - 1) * accentFrac) : -1;
    for (let f = 0; f < floors; f++) {
      const wy = yBase + 1.8 + f * 2.8;
      const isCrown = f >= floors - 1;
      // Whole floors read as occupied or dark — real towers light up
      // per-tenant, not per-window.
      const occupied = rng() < 0.55;
      const floorP = occupied ? litRatio * 1.7 : litRatio * 0.16;
      for (let col = 0; col < cols; col++) {
        const accent = col === accentCol;
        const p = accent ? 0.92 : isCrown ? litRatio * crownBoost : floorP;
        const lit = rng() < p;
        const wx = x0 + col * 2.0 + (rng() - 0.5) * 0.18;
        if (!lit) {
          // A few dark slots are actually late rooms that will change
          // state all night — the flicker layer's candidates.
          if (flickerSpots.length < 26 && rng() < 0.02) {
            flickerSpots.push({ x: wx, y: wy, z: zFace });
          }
          continue;
        }
        const g = new THREE.PlaneGeometry(0.95, 1.3);
        g.translate(wx, wy, zFace);
        const brightness = accent ? 1.3 : isCrown ? 1.4 : 0.68 + rng() * 0.7;
        if (accent) winColor.set("#dceaff").multiplyScalar(brightness);
        else pickWindowColor(rng, winColor).multiplyScalar(brightness);
        windowGeos.push(paintSolid(g, winColor));
      }
    }
  }

  function addBuilding(x, z, w, d, h, { litRatio = 0.42, landmark = false } = {}) {
    const y0 = GROUND_Y;
    const y1 = GROUND_Y + h;
    // Neutral albedo jitter; the atmosphere grade supplies actual color.
    const value = landmark ? 0.78 : 0.6 + rng() * 0.28;
    cBottom.setScalar(value);
    cTop.setScalar(value * (0.5 + rng() * 0.14));
    // Some towers are simply asleep — the dark ones make the lit ones read.
    const lr = !landmark && rng() < 0.12 ? litRatio * 0.15 : litRatio;

    let y = y0;
    let cw = w;
    let cd = d;

    // Podium: wider, short, grounds the tower. Its ground floor is retail —
    // a dense warm row that makes the street level glow like the reference.
    const podiumH = Math.min(3.5 + rng() * 3, h * 0.18);
    boxPart(shellGeos, cw * 1.14, podiumH, cd * 1.14, x, y, z, y0, y1, cBottom, cTop);
    {
      const rCols = Math.max(2, Math.floor((cw * 1.14 - 1.2) / 1.9));
      const rx0 = x - ((rCols - 1) * 1.9) / 2;
      const rz = z + (cd * 1.14) / 2 + 0.06;
      for (let c = 0; c < rCols; c++) {
        if (rng() > 0.72) continue;
        const g = new THREE.PlaneGeometry(1.0, 1.15);
        g.translate(rx0 + c * 1.9, y0 + 1.7, rz);
        winColor.copy(WINDOW_TEMPS[0].c).multiplyScalar(0.9 + rng() * 0.45);
        windowGeos.push(paintSolid(g, winColor));
      }
    }
    y += podiumH;

    // Shaft: the body of the building.
    const shaftH = h * (0.55 + rng() * 0.15);
    boxPart(shellGeos, cw, shaftH, cd, x, y, z, y0, y1, cBottom, cTop);
    addWindows(x, z, cw, cd, y, shaftH, lr, 1, landmark ? 0.5 : -1);
    y += shaftH;

    // Setbacks: the stepped profile that reads as architecture, not boxes.
    if (rng() < 0.68 && y < y1 - 8) {
      cw *= 0.78 + rng() * 0.08;
      cd *= 0.78 + rng() * 0.08;
      const h1 = Math.min(h * (0.12 + rng() * 0.1), y1 - y);
      boxPart(shellGeos, cw, h1, cd, x, y, z, y0, y1, cBottom, cTop);
      addWindows(x, z, cw, cd, y, h1, lr * 0.9, 1);
      y += h1;
    }
    if ((landmark || rng() < 0.35) && y < y1 - 6) {
      cw *= 0.72 + rng() * 0.08;
      cd *= 0.72 + rng() * 0.08;
      const h2 = y1 - y - (landmark ? 3.5 : 1.5);
      if (h2 > 2) {
        boxPart(shellGeos, cw, h2, cd, x, y, z, y0, y1, cBottom, cTop);
        // Crown floor glows brighter — the lit-crown landmark language.
        addWindows(x, z, cw, cd, y, h2, lr, landmark ? 2.2 : 1.4, landmark ? 0.5 : -1);
        y += h2;
      }
    }

    // Crown cap.
    if (y < y1 - 0.5) {
      boxPart(shellGeos, cw * 0.55, y1 - y, cd * 0.55, x, y, z, y0, y1, cBottom, cTop);
    }

    // Rooftop clutter: HVAC boxes, and the occasional water tower.
    const clutter = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < clutter; i++) {
      const bw = 0.8 + rng() * 1.8;
      const bh = 0.6 + rng() * 1.6;
      boxPart(
        shellGeos,
        bw, bh, bw,
        x + (rng() - 0.5) * cw * 0.5,
        y1, z + (rng() - 0.5) * cd * 0.5,
        y0, y1 + 2, cTop, cTop
      );
    }
    if (!landmark && rng() < 0.16) {
      const tx = x + (rng() - 0.5) * cw * 0.4;
      const tz = z + (rng() - 0.5) * cd * 0.4;
      const tank = CYL.clone();
      tank.scale(1.6, 2.2, 1.6);
      scaleUV(tank, 1.6, 2.2, 1.6);
      tank.translate(tx, y1 + 1.1 + 0.8, tz);
      shellGeos.push(paintRange(tank, y0, y1 + 4, cBottom, cTop));
      const legs = CYL.clone();
      legs.scale(0.9, 1.6, 0.9);
      scaleUV(legs, 0.9, 1.6, 0.9);
      legs.translate(tx, y1 + 0.8, tz);
      shellGeos.push(paintRange(legs, y0, y1 + 4, cBottom, cTop));
    }

    // Antenna mast; the tallest ones earn a beacon.
    if (landmark || rng() < 0.4) {
      const mastH = landmark ? 10 + rng() * 6 : 4 + rng() * 8;
      const mast = CYL.clone();
      mast.scale(0.14, mastH, 0.14);
      scaleUV(mast, 0.14, mastH, 0.14);
      mast.translate(x, y1 + mastH / 2, z);
      shellGeos.push(paintRange(mast, y0, y1 + mastH, cTop, cTop));
      if (spireTops.length < 10 && (landmark || h > 55)) {
        spireTops.push({ x, y: y1 + mastH, z });
      }
    }

    buildings.push({ x, z, topY: y1, w, h });
  }

  // Four fabric bands, near → far, packed tight: the reference city is a
  // continuous fabric, not towers in a park. The far band is low and dense
  // so the urban carpet runs unbroken to the horizon.
  const bands = [
    { z0: -95, z1: -62, span: 560, count: 30, hMin: 9, hMax: 28, wMin: 7, wMax: 14, lit: 0.4 },
    { z0: -175, z1: -108, span: 620, count: 38, hMin: 16, hMax: 56, wMin: 8, wMax: 18, lit: 0.48 },
    { z0: -320, z1: -190, span: 700, count: 42, hMin: 24, hMax: 74, wMin: 11, wMax: 22, lit: 0.44 },
    { z0: -420, z1: -330, span: 820, count: 40, hMin: 10, hMax: 34, wMin: 10, wMax: 20, lit: 0.36 },
  ];

  for (const band of bands) {
    const placed = [];
    for (let i = 0; i < band.count; i++) {
      if (rng() < 0.12) continue; // the rare gap
      const slot = band.span / band.count;
      const x = -band.span / 2 + slot * (i + 0.5) + (rng() - 0.5) * slot * 0.7;
      if (Math.abs(x) < CAMERA_SAFE_RADIUS && band.z1 > -80) continue;
      const w = band.wMin + rng() * (band.wMax - band.wMin);
      const half = w * 0.62;
      if (placed.some(p => Math.abs(p - x) < half + 1.2)) continue;
      placed.push(x);
      const z = band.z0 + rng() * (band.z1 - band.z0);
      const h = band.hMin + rng() * (band.hMax - band.hMin);
      addBuilding(x, z, w, w * (0.75 + rng() * 0.4), h, { litRatio: band.lit });
    }
  }

  // Three landmark supertalls, off-center, with lit crowns and masts.
  addBuilding(-95, -215, 24, 20, 108, { litRatio: 0.5, landmark: true });
  addBuilding(38, -245, 28, 22, 122, { litRatio: 0.52, landmark: true });
  addBuilding(148, -200, 22, 18, 96, { litRatio: 0.48, landmark: true });

  return {
    shell: mergeGeometries(shellGeos),
    windows: mergeGeometries(windowGeos),
    buildings,
    spireTops,
    flickerSpots,
  };
}

// ─── FX shaders ───────────────────────────────────────────────────────────

// Long-exposure traffic: a dim base line with bright pulses travelling
// along it. uDir flips the direction for the taillight lane.
const TrailShader = {
  uniforms: {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color("#fff3d8") },
    uOpacity: { value: 0 },
    uSpeed: { value: 0.05 },
    uDir: { value: 1 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform float uTime;
    uniform vec3 uColor;
    uniform float uOpacity;
    uniform float uSpeed;
    uniform float uDir;
    varying vec2 vUv;
    void main() {
      float x = uDir > 0.0 ? vUv.x : 1.0 - vUv.x;
      float pulse = pow(fract(x * 9.0 - uTime * uSpeed), 6.0);
      float pulse2 = pow(fract(x * 15.0 - uTime * uSpeed * 1.6 + 0.37), 10.0);
      float edge = smoothstep(0.0, 0.05, vUv.x) * smoothstep(1.0, 0.95, vUv.x)
                 * smoothstep(0.0, 0.45, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
      float a = (0.22 + pulse * 0.8 + pulse2 * 0.6) * edge * uOpacity;
      gl_FragColor = vec4(uColor, a);
      #include <colorspace_fragment>
    }
  `,
};

// Searchlight beam: gradient card, pivot at the base so it sweeps like a
// real beam rather than a rotating billboard.
const BeamShader = {
  uniforms: {
    uColor: { value: new THREE.Color("#bcd6ff") },
    uOpacity: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 uColor;
    uniform float uOpacity;
    varying vec2 vUv;
    void main() {
      float a = smoothstep(0.0, 0.35, vUv.x) * smoothstep(1.0, 0.65, vUv.x)
              * smoothstep(0.0, 0.05, vUv.y) * smoothstep(1.0, 0.45, vUv.y);
      gl_FragColor = vec4(uColor, a * uOpacity);
      #include <colorspace_fragment>
    }
  `,
};

// ─── Scene factory ────────────────────────────────────────────────────────

export function createCityScene() {
  const group = new THREE.Group();
  group.name = "scene-city";

  const glowTex = makeGlowTexture();
  const city = generateSkyline();

  // Shell: one mesh, one material, vertex-colored massing under a
  // curtain-wall texture.
  const facadeMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: makeFacadeTexture(),
    roughness: 0.9,
    metalness: 0.05,
  });
  const shell = new THREE.Mesh(city.shell, facadeMat);
  shell.castShadow = true;
  group.add(shell);

  // Windows: one merged emissive layer. Opacity is the day/night litRatio.
  const windowMat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0,
    toneMapped: false,
    fog: true, // distant windows dissolve into the haze like everything else
  });
  const windows = new THREE.Mesh(city.windows, windowMat);
  group.add(windows);

  // Ground: the street grid. Asphalt albedo by day; at night the emissive
  // map takes over and the road network glows like the reference harbour.
  const roadTex = makeRoadTextures();
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x0a0d14,
    map: roadTex.dayTex,
    emissive: new THREE.Color(0xff9a50),
    emissiveMap: roadTex.glowTex,
    emissiveIntensity: 0,
    roughness: 0.95,
    metalness: 0,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1200, 1200), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GROUND_Y;
  ground.receiveShadow = true;
  group.add(ground);

  // ─── Foreground: the rooftop we stand on ─────────────────────────────
  // A dark ledge plus near props at the frame edges — foreground /
  // midground / background layering is what turns a backdrop into a place.
  const fgMat = new THREE.MeshBasicMaterial({ color: 0x05070c, fog: false });
  const fgCapMat = new THREE.MeshBasicMaterial({ color: 0x0a0e18, fog: false });
  const parapet = new THREE.Mesh(new THREE.BoxGeometry(130, 5, 8), fgMat);
  parapet.position.set(0, -5.6, 6);
  group.add(parapet);
  const parapetCap = new THREE.Mesh(new THREE.BoxGeometry(130, 0.35, 8.6), fgCapMat);
  parapetCap.position.set(0, -2.92, 6);
  group.add(parapetCap);
  // Antenna mast at the right frame edge, with cross arms and a beacon.
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.13, 17, 5), fgMat);
  mast.position.set(10.5, 4.5, 2);
  group.add(mast);
  for (const ay of [8.6, 11.2]) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 0.08), fgMat);
    arm.position.set(10.5, ay, 2);
    group.add(arm);
  }
  const mastBeaconMat = new THREE.SpriteMaterial({
    map: glowTex,
    color: 0xff3b30,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: false,
  });
  const mastBeacon = new THREE.Sprite(mastBeaconMat);
  mastBeacon.position.set(10.5, 13.3, 2);
  mastBeacon.scale.set(1.1, 1.1, 1);
  group.add(mastBeacon);
  // Water tower, cut off by the left frame edge.
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 2.8, 10), fgMat);
  tank.position.set(-13, 2.2, -1);
  group.add(tank);
  const tankRoof = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 2.15, 1.2, 10), fgMat);
  tankRoof.position.set(-13, 4.2, -1);
  group.add(tankRoof);
  const tankLegs = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3.4, 2.6), fgMat);
  tankLegs.position.set(-13, -0.9, -1);
  group.add(tankLegs);

  // ─── Street life: warm glows peeking through the gaps ─────────────────
  const streetGlows = [];
  const streetRng = makeRng(777);
  for (let i = 0; i < 14; i++) {
    const mat = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xffb46a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(-280 + i * 42 + streetRng() * 26, GROUND_Y + 1.2, -40 - streetRng() * 70);
    sprite.scale.set(7 + streetRng() * 6, 3.2, 1);
    group.add(sprite);
    streetGlows.push(mat);
  }
  // The luminous base of the urban carpet itself.
  const floorGlowMat = new THREE.SpriteMaterial({
    map: glowTex,
    color: 0xffa668,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: false,
  });
  const floorGlow = new THREE.Sprite(floorGlowMat);
  floorGlow.position.set(0, -3, -160);
  floorGlow.scale.set(760, 36, 1);
  group.add(floorGlow);

  // ─── Haze layers: fog as a building material ──────────────────────────
  const hazeLayers = [];
  for (const layer of [
    { y: 2, z: -120, w: 620, h: 60, o: 0.13 },
    { y: 8, z: -210, w: 760, h: 90, o: 0.19 },
    { y: 14, z: -300, w: 900, h: 130, o: 0.26 },
  ]) {
    const mat = new THREE.SpriteMaterial({
      map: glowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0,
      fog: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(0, layer.y, layer.z);
    sprite.scale.set(layer.w, layer.h, 1);
    group.add(sprite);
    hazeLayers.push({ mat, base: layer.o });
  }

  // ─── Light pollution: the warm dome + its hotter core ─────────────────
  const glowMat = new THREE.SpriteMaterial({
    map: glowTex,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: false,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.position.set(0, 20, -340);
  glow.scale.set(1400, 110, 1);
  group.add(glow);
  const glowCoreMat = glowMat.clone();
  const glowCore = new THREE.Sprite(glowCoreMat);
  glowCore.position.set(30, 8, -330);
  glowCore.scale.set(460, 55, 1);
  group.add(glowCore);

  // ─── Traffic: light trails on the real avenues (z = -50 near, -150 mid)
  const trailGeo = new THREE.PlaneGeometry(560, 2.0);
  const trails = [];
  for (const lane of [
    { z: -48.9, color: "#fff3d8", speed: 0.12, dir: 1, base: 0.85 },
    { z: -51.1, color: "#ff4a3c", speed: 0.09, dir: -1, base: 0.85 },
    { z: -148.9, color: "#fff3d8", speed: 0.1, dir: 1, base: 0.4 },
    { z: -151.1, color: "#ff4a3c", speed: 0.08, dir: -1, base: 0.4 },
  ]) {
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(TrailShader.uniforms),
      vertexShader: TrailShader.vertexShader,
      fragmentShader: TrailShader.fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    mat.uniforms.uColor.value.set(lane.color);
    mat.uniforms.uSpeed.value = lane.speed;
    mat.uniforms.uDir.value = lane.dir;
    mat.userData.base = lane.base;
    const mesh = new THREE.Mesh(trailGeo, mat);
    mesh.position.set(0, GROUND_Y + 1.2, lane.z);
    group.add(mesh);
    trails.push(mat);
  }

  // ─── Cars: individual headlights riding the avenue lanes ──────────────
  const CAR_COUNT = 56;
  const carGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array(CAR_COUNT * 3);
    const lane = new Float32Array(CAR_COUNT);
    const dir = new Float32Array(CAR_COUNT);
    const speed = new Float32Array(CAR_COUNT);
    const offset = new Float32Array(CAR_COUNT);
    const carRng = makeRng(4242);
    for (let i = 0; i < CAR_COUNT; i++) {
      lane[i] = i < 40 ? -50 : -150;
      dir[i] = carRng() < 0.5 ? 1 : -1;
      speed[i] = 6 + carRng() * 8;
      offset[i] = carRng() * 560;
    }
    carGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    carGeo.setAttribute("aLane", new THREE.BufferAttribute(lane, 1));
    carGeo.setAttribute("aDir", new THREE.BufferAttribute(dir, 1));
    carGeo.setAttribute("aSpeed", new THREE.BufferAttribute(speed, 1));
    carGeo.setAttribute("aOffset", new THREE.BufferAttribute(offset, 1));
  }
  const carMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
    },
    vertexShader: `
      attribute float aLane;
      attribute float aDir;
      attribute float aSpeed;
      attribute float aOffset;
      uniform float uTime;
      varying vec3 vColor;
      void main() {
        float x = mod(aOffset + uTime * aSpeed * aDir, 560.0) - 280.0;
        vec3 p = vec3(x, ${GROUND_Y + 0.6}, aLane + aDir * 1.1);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = clamp(300.0 / -mv.z, 1.5, 5.0);
        vColor = aDir > 0.0 ? vec3(1.0, 0.93, 0.78) : vec3(1.0, 0.22, 0.16);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.1, d) * uOpacity;
        gl_FragColor = vec4(vColor, a);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const cars = new THREE.Points(carGeo, carMat);
  cars.frustumCulled = false;
  group.add(cars);

  // ─── Searchlights on two mid-rise roofs ───────────────────────────────
  const beamGeo = new THREE.PlaneGeometry(1, 1);
  beamGeo.translate(0, 0.5, 0); // pivot at the base
  const beamMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(BeamShader.uniforms),
    vertexShader: BeamShader.vertexShader,
    fragmentShader: BeamShader.fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const beams = [];
  const beamBases = city.buildings.filter(b => b.h > 34 && b.h < 70).slice(0, 2);
  for (const b of beamBases) {
    const mesh = new THREE.Mesh(beamGeo, beamMat);
    mesh.position.set(b.x, b.topY, b.z);
    mesh.scale.set(9, 120, 1);
    group.add(mesh);
    beams.push({ mesh, phase: Math.random() * Math.PI * 2 });
  }

  // ─── Neon: two rooftop accents cutting through the haze ───────────────
  const neons = [];
  const neonHosts = city.buildings.filter(b => b.h > 20 && b.h < 46).slice(3, 5);
  const NEON_COLORS = ["#ff4fd8", "#4fd8ff"];
  neonHosts.forEach((b, i) => {
    const mat = new THREE.SpriteMaterial({
      map: glowTex,
      color: NEON_COLORS[i % NEON_COLORS.length],
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(b.x, b.topY + 1.6, b.z + 1);
    sprite.scale.set(7, 3.2, 1);
    group.add(sprite);
    neons.push({ mat, phase: i * 2.1 });
  });

  // ─── Spire beacons ────────────────────────────────────────────────────
  const beaconBase = new THREE.SpriteMaterial({
    map: glowTex,
    color: 0xff3b30,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    fog: false,
  });
  const spireBeacons = [];
  for (const top of city.spireTops) {
    const mat = beaconBase.clone();
    const sprite = new THREE.Sprite(mat);
    sprite.position.set(top.x, top.y + 0.8, top.z);
    sprite.scale.set(1.7, 1.7, 1);
    group.add(sprite);
    spireBeacons.push({ mat, phase: Math.random() * Math.PI * 2 });
  }

  // ─── Late rooms: the flicker overlay ──────────────────────────────────
  const flickerMat = new THREE.MeshBasicMaterial({
    color: 0xffe2b8,
    transparent: true,
    opacity: 0,
    toneMapped: false,
    fog: true,
  });
  const flickerCount = city.flickerSpots.length;
  const flicker = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.15, 1.5), flickerMat, Math.max(1, flickerCount));
  flicker.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, flickerCount) * 3).fill(1), 3);
  {
    const dummy = new THREE.Object3D();
    city.flickerSpots.forEach((spot, i) => {
      dummy.position.set(spot.x, spot.y, spot.z + 0.02);
      dummy.updateMatrix();
      flicker.setMatrixAt(i, dummy.matrix);
    });
    if (flickerCount === 0) flicker.count = 0;
  }
  group.add(flicker);
  const flickerTargets = new Float32Array(Math.max(1, flickerCount)).fill(1);
  const flickerCurrent = new Float32Array(Math.max(1, flickerCount)).fill(1);
  let flickerTimer = 0;
  let carTime = 0;

  // ─── Aircraft: one slow red pulse crossing the far sky ────────────────
  const aircraftMat = beaconBase.clone();
  const aircraft = new THREE.Sprite(aircraftMat);
  aircraft.scale.set(2.4, 2.4, 1);
  group.add(aircraft);

  const scratch = new THREE.Color();

  function applyGrade(atmosphere) {
    if (!atmosphere) return;
    const g = atmosphere.current;
    const day = atmosphere.daylight;
    const night = 1 - day;

    // Shell: cool and sunk at night; by day the facades take the bright
    // horizon sky. The emissive term stands in for sky ambient bouncing
    // off every surface — without it the camera-facing sides stay black.
    // (The facade texture averages ~0.5 gray, so the multipliers carry
    // that extra factor.)
    scratch.copy(g.fog).lerp(g.skyHorizon, 0.55 * day).multiplyScalar(0.5 + day * 2.2);
    facadeMat.color.copy(scratch);
    facadeMat.emissive.copy(g.skyHorizon).multiplyScalar(0.32 * day + 0.04 * night);

    // Foreground silhouettes: near-black always; the ledge cap catches sky.
    fgMat.color.copy(scratch.copy(g.fog).multiplyScalar(0.05 + day * 0.1));
    fgCapMat.color.copy(scratch.copy(g.skyHorizon).multiplyScalar(0.08 + day * 0.22));

    // Haze: fog-colored by day, warmed by the city's own glow at night.
    scratch.copy(g.fog).lerp(g.skyHorizon, 0.35).lerp(g.key, night * 0.18);
    for (const layer of hazeLayers) {
      layer.mat.color.copy(scratch);
      layer.mat.opacity = layer.base * (0.5 + night * 0.9);
    }

    // Sodium haze dome, graded toward the key light. Amber, not red.
    scratch.set(0xffb37a).lerp(g.key, 0.35);
    glowMat.color.copy(scratch);
    glowMat.opacity = night * 0.08;
    glowCoreMat.color.copy(scratch);
    glowCoreMat.opacity = night * 0.11;

    // The ground must stay clearly darker than the sky — but by day the
    // asphalt and blocks still read as a lit city fabric.
    scratch.copy(g.fog).lerp(g.skyHorizon, 0.4 * day).multiplyScalar(0.5 + day * 2.0);
    groundMat.color.copy(scratch);
  }

  function updateCelestial(_c, atmosphere) {
    applyGrade(atmosphere);
  }

  function update(delta, elapsed, atmosphere) {
    applyGrade(atmosphere);

    const night = atmosphere ? 1 - atmosphere.daylight : 1;
    const reducedMotion = prefersReducedMotion();

    // litRatio: windows crossfade with dusk instead of popping.
    windowMat.opacity = night * 0.95;

    // Traffic trails on the avenues, plus the individual cars riding them.
    for (const mat of trails) {
      mat.uniforms.uTime.value = elapsed;
      mat.uniforms.uOpacity.value = night * mat.userData.base;
    }
    carTime += delta * (reducedMotion ? 0.35 : 1);
    carMat.uniforms.uTime.value = carTime;
    carMat.uniforms.uOpacity.value = night * 0.9;
    groundMat.emissiveIntensity = night * 1.7;

    // Searchlights sweep slowly; reduced motion parks them at a rake.
    beamMat.uniforms.uOpacity.value = night * 0.18;
    for (const b of beams) {
      b.mesh.rotation.z = reducedMotion ? 0.42 : Math.sin(elapsed * 0.09 + b.phase) * 0.55;
    }

    // Neon buzzes gently; reduced motion holds it steady.
    for (const n of neons) {
      const buzz = reducedMotion ? 1 : 0.82 + 0.18 * Math.sin(elapsed * 1.7 + n.phase);
      n.mat.opacity = night * 0.5 * buzz;
    }

    // Street-level warmth in the gaps between towers, and the carpet base.
    for (const m of streetGlows) m.opacity = night * 0.5;
    floorGlowMat.opacity = night * 0.2;

    // The rooftop mast blinks on its own phase.
    mastBeaconMat.opacity =
      (reducedMotion ? 0.45 : Math.sin(elapsed * 2.1 + 1.3) > 0.55 ? 1 : 0.06) * night * 0.8;

    // Spire beacons pulse out of phase; steady dim under reduced motion.
    for (const b of spireBeacons) {
      const pulse = reducedMotion ? 0.45 : Math.sin(elapsed * 2.1 + b.phase) > 0.55 ? 1 : 0.06;
      b.mat.opacity = pulse * night * 0.8;
    }

    // Late rooms change state every few seconds, easing not snapping.
    if (night > 0.05 && flickerCount > 0) {
      flickerTimer -= delta;
      if (flickerTimer <= 0) {
        flickerTimer = reducedMotion ? 3 : 0.5;
        for (let k = 0; k < 3; k++) {
          const idx = Math.floor(Math.random() * flickerCount);
          flickerTargets[idx] = flickerTargets[idx] > 0.5 ? 0.08 : 0.7 + Math.random() * 0.4;
        }
      }
      const arr = flicker.instanceColor.array;
      const f = 1 - Math.exp(-(reducedMotion ? 1.2 : 3) * delta);
      for (let i = 0; i < flickerCount; i++) {
        flickerCurrent[i] += (flickerTargets[i] - flickerCurrent[i]) * f;
        arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = flickerCurrent[i];
      }
      flicker.instanceColor.needsUpdate = true;
    }
    flickerMat.opacity = night * 0.9;

    // The aircraft crosses on a long loop.
    const t = (elapsed % 90) / 90;
    aircraft.position.set(-320 + t * 640, 74, -280);
    const blink = Math.sin(elapsed * 3.1) > 0.72 ? 1 : 0;
    aircraftMat.opacity = blink * night * 0.9;
  }

  return {
    group,
    updateCelestial,
    update,
  };
}
