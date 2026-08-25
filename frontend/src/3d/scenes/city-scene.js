import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { prefersReducedMotion } from "../motion.js";

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
// Geometry strategy: towers + clutter are merged into five family meshes,
// while every lit window remains one instanced quad mesh. The small fixed
// draw-call increase buys real architectural/material variety without
// returning to one mesh per building.

const GROUND_Y = -7.5;
const CAMERA_SAFE_RADIUS = 46;

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function sstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const CITY_TRAFFIC_HALF_SPAN = 310;
export const CITY_DAY_TRAFFIC_LAYOUT = Object.freeze([
  { lane: -48.6, direction: 1, speed: 2.35, offset: -284, scale: 0.96, color: "#d1a52f", taxi: true },
  { lane: -51.4, direction: -1, speed: 2.05, offset: -236, scale: 0.91, color: "#a34e47", taxi: false },
  { lane: -48.6, direction: 1, speed: 2.65, offset: -172, scale: 0.9, color: "#596c82", taxi: false },
  { lane: -51.4, direction: -1, speed: 1.85, offset: -112, scale: 0.98, color: "#d1a52f", taxi: true },
  { lane: -48.6, direction: 1, speed: 2.15, offset: -48, scale: 0.88, color: "#bbb5aa", taxi: false },
  { lane: -51.4, direction: -1, speed: 2.75, offset: 28, scale: 0.94, color: "#4e625b", taxi: false },
  { lane: -48.6, direction: 1, speed: 1.95, offset: 104, scale: 1.0, color: "#d1a52f", taxi: true },
  { lane: -51.4, direction: -1, speed: 2.45, offset: 178, scale: 0.9, color: "#777985", taxi: false },
  { lane: -148.8, direction: 1, speed: 2.85, offset: -252, scale: 0.78, color: "#50647d", taxi: false },
  { lane: -151.2, direction: -1, speed: 2.25, offset: -144, scale: 0.82, color: "#d1a52f", taxi: true },
  { lane: -148.8, direction: 1, speed: 2.55, offset: -38, scale: 0.76, color: "#a45b50", taxi: false },
  { lane: -151.2, direction: -1, speed: 1.9, offset: 76, scale: 0.84, color: "#b9b2a6", taxi: false },
  { lane: -148.8, direction: 1, speed: 2.7, offset: 174, scale: 0.8, color: "#56645d", taxi: false },
  { lane: -151.2, direction: -1, speed: 2.1, offset: 268, scale: 0.77, color: "#7b6a58", taxi: false },
].map(Object.freeze));

export function resolveCityTrafficX(vehicle, elapsed) {
  const span = CITY_TRAFFIC_HALF_SPAN * 2;
  const raw = vehicle.offset + elapsed * vehicle.speed * vehicle.direction + CITY_TRAFFIC_HALF_SPAN;
  return ((raw % span) + span) % span - CITY_TRAFFIC_HALF_SPAN;
}

export function cityDayTrafficMix(elevation) {
  return sstep(-2, 8, Number.isFinite(elevation) ? elevation : 8);
}

export function advanceCityTrafficTime(current, delta, reducedMotion) {
  return reducedMotion ? current : current + Math.max(0, delta);
}

function makeConstructionCraneGeometry() {
  const parts = [];
  const mastHeight = 25;

  function addBox(w, h, d, x, y, z, rotationZ = 0) {
    const geometry = new THREE.BoxGeometry(w, h, d);
    if (rotationZ) geometry.rotateZ(rotationZ);
    geometry.translate(x, y, z);
    parts.push(geometry);
  }

  // Four columns plus alternating braces keep the distant silhouette light;
  // all pieces are merged below, so the lattice still costs one draw call.
  for (const x of [-0.62, 0.62]) {
    for (const z of [-0.62, 0.62]) addBox(0.16, mastHeight, 0.16, x, mastHeight / 2, z);
  }
  const braceLength = Math.hypot(1.24, 3.1);
  const braceAngle = Math.atan2(3.1, 1.24);
  for (let y = 1.55, row = 0; y < mastHeight - 1; y += 3.1, row++) {
    for (const z of [-0.64, 0.64]) {
      addBox(braceLength, 0.09, 0.09, 0, y, z, row % 2 ? -braceAngle : braceAngle);
    }
    addBox(0.09, 0.09, 1.42, -0.64, y, 0);
    addBox(0.09, 0.09, 1.42, 0.64, y + 1.45, 0);
  }

  const jibY = mastHeight + 1.1;
  addBox(42, 0.18, 0.42, 11, jibY - 0.62, 0);
  addBox(42, 0.14, 0.26, 11, jibY + 0.62, 0);
  for (let x = -8; x <= 30; x += 4.75) {
    addBox(1.45, 0.1, 0.24, x, jibY, 0, x % 9.5 ? -0.72 : 0.72);
  }
  addBox(3.1, 1.9, 2.3, -2.2, mastHeight + 1.1, 0);
  addBox(4.4, 1.35, 1.7, -8.3, jibY - 0.15, 0);

  const cableLength = 11;
  const cable = new THREE.CylinderGeometry(0.045, 0.045, cableLength, 5);
  cable.translate(21.5, jibY - cableLength / 2, 0);
  parts.push(cable);
  const hook = new THREE.TorusGeometry(0.28, 0.07, 5, 9, Math.PI * 1.55);
  hook.translate(21.5, jibY - cableLength - 0.18, 0);
  parts.push(hook);

  const merged = mergeGeometries(parts);
  for (const part of parts) part.dispose();
  return merged;
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
const OCT = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);

// One tile = 4 window bays × 3 floors of curtain wall: glass panels with
// per-panel value jitter, spandrel bands, mullion lines. Neutral grays so
// the atmosphere grade keeps full control of hue. This texture is what
// stops the towers reading as smooth CG boxes.
function makeFacadeTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  const bumpCanvas = document.createElement("canvas");
  const roughCanvas = document.createElement("canvas");
  const bounceCanvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  bumpCanvas.width = bumpCanvas.height = size;
  roughCanvas.width = roughCanvas.height = size;
  bounceCanvas.width = bounceCanvas.height = size;
  const ctx = canvas.getContext("2d");
  const bctx = bumpCanvas.getContext("2d");
  const rctx = roughCanvas.getContext("2d");
  const ectx = bounceCanvas.getContext("2d");
  ctx.fillStyle = "#979694";
  ctx.fillRect(0, 0, size, size);
  bctx.fillStyle = "#767676";
  bctx.fillRect(0, 0, size, size);
  rctx.fillStyle = "#d0d0d0";
  rctx.fillRect(0, 0, size, size);
  ectx.fillStyle = "#d4d2cc";
  ectx.fillRect(0, 0, size, size);
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
      const cool = 3 + Math.floor(rnd() * 8);
      const warmPanel = rnd() < 0.42;
      ctx.fillStyle = warmPanel
        ? `rgb(${v + 5},${v + 2},${v - 3})`
        : `rgb(${v - 4},${v},${v + cool})`;
      ctx.fillRect(c * cw + 2, r * ch + 2, cw - 4, ch - 10);
      const bounce = 190 + Math.floor(rnd() * 28);
      ectx.fillStyle = warmPanel
        ? `rgb(${bounce + 4},${bounce + 2},${bounce - 2})`
        : `rgb(${bounce - 3},${bounce},${bounce + 3})`;
      ectx.fillRect(c * cw + 2, r * ch + 2, cw - 4, ch - 10);
      // A soft vertical reflection keeps daylight glass alive as the key
      // light moves without pretending every panel is a mirror.
      const reflection = ctx.createLinearGradient(c * cw + 2, 0, c * cw + cw - 2, 0);
      reflection.addColorStop(0, "rgba(255,255,255,0.02)");
      reflection.addColorStop(0.48, "rgba(255,255,255,0.12)");
      reflection.addColorStop(0.62, "rgba(255,255,255,0.025)");
      reflection.addColorStop(1, "rgba(0,0,0,0.05)");
      ctx.fillStyle = reflection;
      ctx.fillRect(c * cw + 2, r * ch + 2, cw - 4, ch - 10);

      bctx.fillStyle = "#8c8c8c";
      bctx.fillRect(c * cw + 3, r * ch + 3, cw - 6, ch - 12);
      rctx.fillStyle = `rgb(${70 + Math.floor(rnd() * 28)},${70 + Math.floor(rnd() * 28)},${70 + Math.floor(rnd() * 28)})`;
      rctx.fillRect(c * cw + 3, r * ch + 3, cw - 6, ch - 12);

      ctx.fillStyle = "#686866";
      ctx.fillRect(c * cw + 2, r * ch + ch - 8, cw - 4, 6);
      bctx.fillStyle = "#bcbcbc";
      bctx.fillRect(c * cw + 1, r * ch + ch - 9, cw - 2, 8);
      rctx.fillStyle = "#ededed";
      rctx.fillRect(c * cw + 1, r * ch + ch - 9, cw - 2, 8);
      ectx.fillStyle = "#b9b7b0";
      ectx.fillRect(c * cw + 1, r * ch + ch - 9, cw - 2, 8);
    }
  }
  for (const [target, color, width] of [
    [ctx, "#56595d", 3],
    [bctx, "#e4e4e4", 3],
    [rctx, "#f4f4f4", 3],
  ]) {
    target.fillStyle = color;
    for (let c = 0; c <= cols; c++) target.fillRect(c * cw - width / 2, 0, width, size);
    for (let r = 0; r <= rows; r++) target.fillRect(0, r * ch - width / 2, size, width);
  }

  // Sparse weathering is confined to the albedo; repeating it across the
  // bump channel would emboss obviously identical dirt onto every tower.
  ctx.strokeStyle = "rgba(40,45,48,0.08)";
  for (let i = 0; i < 28; i++) {
    const x = rnd() * size;
    ctx.lineWidth = 0.5 + rnd() * 1.2;
    ctx.beginPath();
    ctx.moveTo(x, rnd() * size * 0.3);
    ctx.lineTo(x + (rnd() - 0.5) * 4, size);
    ctx.stroke();
  }

  const map = new THREE.CanvasTexture(canvas);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const bump = new THREE.CanvasTexture(bumpCanvas);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  bump.anisotropy = 2;
  const roughness = new THREE.CanvasTexture(roughCanvas);
  roughness.wrapS = roughness.wrapT = THREE.RepeatWrapping;
  roughness.anisotropy = 2;
  const bounce = new THREE.CanvasTexture(bounceCanvas);
  bounce.wrapS = bounce.wrapT = THREE.RepeatWrapping;
  bounce.colorSpace = THREE.SRGBColorSpace;
  bounce.anisotropy = 2;
  return { map, bump, roughness, bounce };
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
  dctx.fillStyle = "#797a76";
  dctx.fillRect(0, 0, size, size);
  // City blocks: 4×4 per tile, slight value jitter per lot.
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const v = 108 + Math.floor(rnd() * 16) - 8;
      dctx.fillStyle = `rgb(${v + 4},${v + 2},${v})`;
      dctx.fillRect(c * 128 + 5, r * 128 + 5, 118, 118);
    }
  }
  // Streets cut darker lines through the blocks.
  dctx.fillStyle = "#484d55";
  for (const p of [0, 256]) {
    dctx.fillRect(0, p - 2, size, 5);
    dctx.fillRect(p - 2, 0, 5, size);
  }
  for (const p of [128, 384]) {
    dctx.fillRect(0, p - 5, size, 10);
    dctx.fillRect(p - 5, 0, 10, size);
  }
  // Curbs, lane dashes and tiny crosswalk bars keep the day street grid from
  // reading like four thick lines painted on a flat plane.
  dctx.fillStyle = "rgba(205,210,211,0.34)";
  for (const p of [128, 384]) {
    dctx.fillRect(0, p - 6, size, 1);
    dctx.fillRect(0, p + 5, size, 1);
    dctx.fillRect(p - 6, 0, 1, size);
    dctx.fillRect(p + 5, 0, 1, size);
  }
  dctx.fillStyle = "rgba(229,217,165,0.44)";
  for (const p of [128, 384]) {
    for (let n = 14; n < size; n += 34) {
      dctx.fillRect(n, p - 1, 15, 2);
      dctx.fillRect(p - 1, n, 2, 15);
    }
  }
  dctx.fillStyle = "rgba(225,226,220,0.42)";
  for (const x of [116, 140, 372, 396]) {
    for (let n = -2; n < 8; n++) dctx.fillRect(x + n * 2, 246, 1, 20);
  }

  // Quiet maintenance history: patched aggregate, repaired seams and
  // parking ticks keep the broad foreground from reading as an untouched
  // gray render plane. Values are deliberately close so a 50-minute focus
  // session never turns into visual noise.
  for (let i = 0; i < 92; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const w = 4 + rnd() * 24;
    const h = 0.5 + rnd() * 2.2;
    const warm = rnd() > 0.42;
    dctx.fillStyle = warm
      ? `rgba(54,48,43,${0.035 + rnd() * 0.045})`
      : `rgba(202,207,209,${0.025 + rnd() * 0.035})`;
    dctx.fillRect(x, y, w, h);
  }
  dctx.fillStyle = "rgba(225,220,201,0.28)";
  for (const roadY of [119, 137, 375, 393]) {
    for (let x = 18; x < size; x += 44) dctx.fillRect(x, roadY, 20, 1);
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

// Subtle linear-space shell tints break the one-material skyline into
// limestone, weathered concrete, blue glass and warm metal families. The
// range stays narrow enough that the shared atmosphere still owns the hour.
const SHELL_TINTS = [
  [1.08, 1.02, 0.91],
  [0.93, 1.0, 1.08],
  [1.08, 0.96, 0.92],
  [0.95, 1.05, 0.98],
  [1.04, 1.0, 0.99],
];

const ARCHITECTURE_STYLES = ["banded", "vertical", "crowned", "terraced", "industrial"];

const FACADE_FAMILIES = [
  { day: "#b9ae9c", golden: "#8b7058", night: "#394354", uvX: 1.18, uvY: 0.72, offsetX: 0.03, offsetY: 0.08, roughness: 0.94, metalness: 0.02, bump: 0.075 },
  { day: "#90a0aa", golden: "#747b82", night: "#293c56", uvX: 0.72, uvY: 1.34, offsetX: 0.23, offsetY: 0.14, roughness: 0.48, metalness: 0.3, bump: 0.038 },
  { day: "#a58f83", golden: "#795f51", night: "#453743", uvX: 0.92, uvY: 0.92, offsetX: 0.41, offsetY: 0.03, roughness: 0.84, metalness: 0.05, bump: 0.09 },
  { day: "#939b8d", golden: "#706f61", night: "#344641", uvX: 1.04, uvY: 0.8, offsetX: 0.09, offsetY: 0.31, roughness: 0.9, metalness: 0.03, bump: 0.07 },
  { day: "#9999a0", golden: "#6f6b71", night: "#36394d", uvX: 1.34, uvY: 1.08, offsetX: 0.37, offsetY: 0.27, roughness: 0.7, metalness: 0.12, bump: 0.055 },
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
  // Five architectural families remain separate meshes. Five static draw
  // calls are still inexpensive, while one family-wide material/UV language
  // is enough to stop every facade reading as the same repeated gray tile.
  const shellGeosByFamily = ARCHITECTURE_STYLES.map(() => []);
  // Flat packed: x, y, z, rotationY, width, height, r, g, b. Instancing these
  // quads removes thousands of temporary PlaneGeometry allocations and turns
  // city construction from a multi-second merge into a short matrix upload.
  const windowData = [];
  const buildings = [];
  const spireTops = [];
  const flickerSpots = [];

  const cBottom = new THREE.Color();
  const cTop = new THREE.Color();
  const winColor = new THREE.Color();

  function pushWindow(x, y, z, rotationY, width, height, color) {
    windowData.push(x, y, z, rotationY, width, height, color.r, color.g, color.b);
  }

  function addWindows(
    x,
    z,
    w,
    d,
    yBase,
    height,
    litRatio,
    crownBoost,
    accentFrac = -1,
    sideWindows = false,
  ) {
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
        const brightness = accent ? 1.3 : isCrown ? 1.4 : 0.68 + rng() * 0.7;
        if (accent) winColor.set("#dceaff").multiplyScalar(brightness);
        else pickWindowColor(rng, winColor).multiplyScalar(brightness);
        pushWindow(wx, wy, zFace, 0, 0.95, 1.3, winColor);
      }

      // A selected set of taller/landmark towers gets real side-facade
      // occupancy. Parallax then reveals lit depth instead of a bright front
      // card attached to a dark box.
      if (sideWindows && f >= floors - 12 && f % 3 === 0) {
        const sideCols = Math.max(1, Math.floor((d - 1.6) / 2.15));
        const z0 = z - ((sideCols - 1) * 2.15) / 2;
        // Only the camera-facing side needs emissive geometry. Sampling every
        // second bay/floor preserves parallax depth while keeping lazy scene
        // construction comfortably below the lobby navigation budget.
        const side = x >= 0 ? -1 : 1;
        const xFace = x + side * (w / 2 + 0.065);
        for (let col = 0; col < sideCols; col += 3) {
          if (rng() >= floorP * 0.55) continue;
          pickWindowColor(rng, winColor).multiplyScalar(0.6 + rng() * 0.62);
          pushWindow(
            xFace,
            wy,
            z0 + col * 2.15 + (rng() - 0.5) * 0.16,
            side * Math.PI * 0.5,
            0.9,
            1.26,
            winColor,
          );
        }
      }
    }
  }

  function addBuilding(
    x,
    z,
    w,
    d,
    h,
    { litRatio = 0.42, landmark = false, familyIndex: requestedFamily = null } = {},
  ) {
    const y0 = GROUND_Y;
    const y1 = GROUND_Y + h;
    const hashedFamily = Math.abs(Math.floor(x * 0.17 + z * 0.11 + h)) % ARCHITECTURE_STYLES.length;
    const familyIndex = requestedFamily ?? hashedFamily;
    const shellGeos = shellGeosByFamily[familyIndex];
    // Neutral albedo jitter; the atmosphere grade supplies actual color.
    const value = landmark ? 0.78 : 0.6 + rng() * 0.28;
    const tint = SHELL_TINTS[familyIndex];
    cBottom.setRGB(value * tint[0], value * tint[1], value * tint[2]);
    const topValue = value * (0.5 + rng() * 0.14);
    cTop.setRGB(topValue * tint[0] * 0.96, topValue * tint[1], topValue * tint[2] * 1.04);
    // Some towers are simply asleep — the dark ones make the lit ones read.
    const lr = !landmark && rng() < 0.12 ? litRatio * 0.15 : litRatio;
    const styleRoll = rng();
    const style = ARCHITECTURE_STYLES[familyIndex];
    const sideWindows = landmark || (style === "vertical" && h > 58);
    const detailEligible = landmark || h > 56;

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
        winColor.copy(WINDOW_TEMPS[0].c).multiplyScalar(0.9 + rng() * 0.45);
        pushWindow(rx0 + c * 1.9, y0 + 1.7, rz, 0, 1, 1.15, winColor);
      }
    }
    // A thin coping shadow separates podium from shaft even when facade
    // texture detail is sub-pixel.
    if (detailEligible) {
      boxPart(shellGeos, cw * 1.2, 0.24, cd * 1.2, x, y + podiumH - 0.12, z, y0, y1, cBottom, cTop);
    }
    y += podiumH;

    // Shaft: the body of the building.
    const shaftH = h * (0.55 + rng() * 0.15);
    boxPart(shellGeos, cw, shaftH, cd, x, y, z, y0, y1, cBottom, cTop);
    addWindows(x, z, cw, cd, y, shaftH, lr, 1, landmark ? 0.5 : -1, sideWindows);

    if (detailEligible && style === "vertical") {
      const finCount = Math.max(3, Math.min(7, Math.floor(cw / 3.2)));
      for (let i = 0; i < finCount; i++) {
        const fx = x - cw * 0.46 + (i / Math.max(1, finCount - 1)) * cw * 0.92;
        boxPart(shellGeos, 0.16, shaftH, 0.38, fx, y, z + cd / 2 + 0.13, y0, y1, cTop, cTop);
      }
    } else if (detailEligible && style === "banded") {
      const bands = Math.max(2, Math.min(5, Math.floor(shaftH / 12)));
      for (let i = 1; i <= bands; i++) {
        const by = y + (shaftH * i) / (bands + 1);
        boxPart(shellGeos, cw * 1.035, 0.16, cd * 1.035, x, by, z, y0, y1, cBottom, cTop);
      }
    }
    y += shaftH;

    // Setbacks: the stepped profile that reads as architecture, not boxes.
    if ((style === "terraced" || style === "crowned" || styleRoll < 0.52) && y < y1 - 8) {
      cw *= 0.78 + rng() * 0.08;
      cd *= 0.78 + rng() * 0.08;
      const h1 = Math.min(h * (0.12 + rng() * 0.1), y1 - y);
      if (detailEligible) {
        boxPart(shellGeos, cw * 1.32, 0.28, cd * 1.32, x, y - 0.08, z, y0, y1, cBottom, cTop);
      }
      boxPart(shellGeos, cw, h1, cd, x, y, z, y0, y1, cBottom, cTop);
      addWindows(x, z, cw, cd, y, h1, lr * 0.9, 1, -1, sideWindows);
      y += h1;
    }
    if ((landmark || style === "terraced" || style === "crowned" || styleRoll > 0.7) && y < y1 - 6) {
      cw *= 0.72 + rng() * 0.08;
      cd *= 0.72 + rng() * 0.08;
      const h2 = y1 - y - (landmark ? 3.5 : 1.5);
      if (h2 > 2) {
        if (detailEligible) {
          boxPart(shellGeos, cw * 1.28, 0.25, cd * 1.28, x, y - 0.05, z, y0, y1, cBottom, cTop);
        }
        boxPart(shellGeos, cw, h2, cd, x, y, z, y0, y1, cBottom, cTop);
        // Crown floor glows brighter — the lit-crown landmark language.
        addWindows(
          x,
          z,
          cw,
          cd,
          y,
          h2,
          lr,
          landmark ? 2.2 : 1.4,
          landmark ? 0.5 : -1,
          sideWindows,
        );
        y += h2;
      }
    }

    // Crown cap.
    if (y < y1 - 0.5) {
      const capH = y1 - y;
      if (style === "crowned") {
        const cap = OCT.clone();
        cap.scale(cw * 0.72, capH, cd * 0.72);
        cap.rotateY(Math.PI / 8);
        scaleUV(cap, cw * 0.72, capH, cd * 0.72);
        cap.translate(x, y + capH / 2, z);
        shellGeos.push(paintRange(cap, y0, y1, cBottom, cTop));
      } else if (style === "terraced") {
        boxPart(shellGeos, cw * 0.72, capH, cd * 0.72, x + cw * 0.08, y, z, y0, y1, cBottom, cTop);
      } else if (style === "vertical") {
        boxPart(shellGeos, cw * 0.68, capH, cd * 0.62, x, y, z, y0, y1, cBottom, cTop);
      } else {
        boxPart(shellGeos, cw * 0.55, capH, cd * 0.55, x, y, z, y0, y1, cBottom, cTop);
      }
    }

    // Family-specific roof signatures are large enough to survive fog and
    // the timer overlay: cornice, twin glass blades, deco lantern, offset
    // garden pavilion, or an industrial rooftop screen.
    if (detailEligible) {
      if (style === "banded") {
        boxPart(shellGeos, cw * 1.18, 0.42, cd * 1.18, x, y1 - 0.18, z, y0, y1 + 1, cBottom, cTop);
      } else if (style === "vertical") {
        const bladeH = 3.2 + styleRoll * 3.2;
        for (const side of [-1, 1]) {
          boxPart(shellGeos, 0.28, bladeH, cd * 0.58, x + side * cw * 0.24, y1, z, y0, y1 + bladeH, cTop, cTop);
        }
      } else if (style === "crowned") {
        const lanternH = landmark ? 5.8 : 3.2;
        const lantern = OCT.clone();
        lantern.scale(cw * 0.34, lanternH, cd * 0.34);
        lantern.rotateY(Math.PI / 8);
        scaleUV(lantern, cw * 0.34, lanternH, cd * 0.34);
        lantern.translate(x, y1 + lanternH / 2, z);
        shellGeos.push(paintRange(lantern, y0, y1 + lanternH, cTop, cTop));
      } else if (style === "terraced") {
        boxPart(shellGeos, cw * 0.48, 2.8, cd * 0.5, x + cw * 0.16, y1, z - cd * 0.08, y0, y1 + 3, cBottom, cTop);
        boxPart(shellGeos, cw * 0.64, 0.24, cd * 0.66, x + cw * 0.16, y1 + 2.72, z - cd * 0.08, y0, y1 + 3, cTop, cTop);
      } else {
        boxPart(shellGeos, cw * 0.62, 1.8, cd * 0.34, x - cw * 0.12, y1, z, y0, y1 + 2, cBottom, cTop);
        boxPart(shellGeos, cw * 0.3, 0.7, cd * 0.72, x + cw * 0.22, y1, z, y0, y1 + 1, cTop, cTop);
      }
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
    if (style === "crowned" || (!landmark && rng() < 0.26)) {
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

    buildings.push({ x, z, topY: y1, w, h, familyIndex });
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

  // Three landmark supertalls deliberately belong to different families:
  // a deco lantern, a cool glass blade and an offset terraced crown.
  addBuilding(-95, -215, 24, 20, 108, { litRatio: 0.5, landmark: true, familyIndex: 2 });
  addBuilding(38, -245, 28, 22, 122, { litRatio: 0.52, landmark: true, familyIndex: 1 });
  addBuilding(148, -200, 22, 18, 96, { litRatio: 0.48, landmark: true, familyIndex: 3 });

  return {
    shells: shellGeosByFamily.map(parts => parts.length ? mergeGeometries(parts) : null),
    windows: windowData,
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
  const facadeMaps = makeFacadeTexture();

  // Five family materials share the procedural source canvases but offset
  // and rescale their bay rhythm. Texture clones share image storage, so the
  // visual variety costs only four extra static draw calls, not five atlases.
  function familyTexture(source, config) {
    const texture = source.clone();
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(config.uvX, config.uvY);
    texture.offset.set(config.offsetX, config.offsetY);
    texture.needsUpdate = true;
    return texture;
  }

  function installFacadeBounce(material) {
    // MeshStandardMaterial's emissive path normally bypasses vertex color.
    // Partially modulate sky bounce by baked height/face/family tint so the
    // low-cost emissive fill keeps real side-light and silhouette hierarchy.
    material.onBeforeCompile = shader => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
         #ifdef USE_COLOR
           totalEmissiveRadiance *= mix(
             vec3(1.0),
             clamp(vColor.rgb, vec3(0.0), vec3(1.2)),
             0.62
           );
         #endif`,
      );
    };
    material.customProgramCacheKey = () => "aethel-facade-family-bounce-v2";
  }

  const facadeMats = [];
  city.shells.forEach((geometry, familyIndex) => {
    if (!geometry) return;
    const config = FACADE_FAMILIES[familyIndex];
    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: familyTexture(facadeMaps.map, config),
      emissiveMap: familyTexture(facadeMaps.bounce, config),
      bumpMap: familyTexture(facadeMaps.bump, config),
      bumpScale: config.bump,
      roughnessMap: familyTexture(facadeMaps.roughness, config),
      roughness: config.roughness,
      metalness: config.metalness,
    });
    installFacadeBounce(material);
    const shell = new THREE.Mesh(geometry, material);
    shell.castShadow = true;
    group.add(shell);
    facadeMats[familyIndex] = material;
  });

  // Windows: one instanced emissive layer. Opacity is the day/night litRatio;
  // per-instance color keeps the warm/cool occupancy variation intact.
  const windowMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    toneMapped: false,
    fog: true, // distant windows dissolve into the haze like everything else
  });
  const windowStride = 9;
  const windowCount = Math.floor(city.windows.length / windowStride);
  const windows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), windowMat, windowCount);
  const windowDummy = new THREE.Object3D();
  const windowTint = new THREE.Color();
  for (let i = 0; i < windowCount; i++) {
    const offset = i * windowStride;
    windowDummy.position.set(city.windows[offset], city.windows[offset + 1], city.windows[offset + 2]);
    windowDummy.rotation.set(0, city.windows[offset + 3], 0);
    windowDummy.scale.set(city.windows[offset + 4], city.windows[offset + 5], 1);
    windowDummy.updateMatrix();
    windows.setMatrixAt(i, windowDummy.matrix);
    windowTint.setRGB(city.windows[offset + 6], city.windows[offset + 7], city.windows[offset + 8]);
    windows.setColorAt(i, windowTint);
  }
  windows.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  windows.instanceMatrix.needsUpdate = true;
  windows.instanceColor.needsUpdate = true;
  windows.computeBoundingSphere();
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

  // Parked cars make the streets feel inhabited in daylight without adding
  // traffic motion to the focus backdrop. They line the shoulders, never the
  // central timer lane, and collapse to quiet silhouettes after dark.
  const parkedBody = new THREE.BoxGeometry(4.15, 0.72, 1.72);
  parkedBody.translate(0, 0.42, 0);
  const parkedCabin = new THREE.BoxGeometry(2.05, 0.58, 1.52);
  parkedCabin.translate(-0.18, 0.98, 0);
  const parkedCarGeo = mergeGeometries([parkedBody, parkedCabin]);
  const parkedCarMat = new THREE.MeshStandardMaterial({
    color: 0xcfc8bb,
    roughness: 0.66,
    metalness: 0.14,
    flatShading: true,
  });
  const parkedSpots = [];
  for (let i = 0; i < 21; i++) {
    const x = -252 + i * 25.2;
    if (Math.abs(x) < 56) continue;
    parkedSpots.push({ x, z: i % 2 ? -43.2 : -56.8, s: 0.86 + (i % 4) * 0.055 });
  }
  for (let i = 0; i < 11; i++) {
    const x = -245 + i * 49;
    if (Math.abs(x) < 66) continue;
    parkedSpots.push({ x, z: i % 2 ? -143.5 : -156.5, s: 0.82 + (i % 3) * 0.06 });
  }
  const parkedCars = new THREE.InstancedMesh(parkedCarGeo, parkedCarMat, parkedSpots.length);
  const parkedDummy = new THREE.Object3D();
  const parkedTint = new THREE.Color();
  const parkedPalette = ["#a8554d", "#50647c", "#b8b2a7", "#92724c", "#4d625c", "#777984"];
  parkedSpots.forEach((spot, i) => {
    parkedDummy.position.set(spot.x, GROUND_Y + 0.02, spot.z);
    parkedDummy.rotation.set(0, i % 2 ? Math.PI : 0, 0);
    parkedDummy.scale.setScalar(spot.s);
    parkedDummy.updateMatrix();
    parkedCars.setMatrixAt(i, parkedDummy.matrix);
    parkedCars.setColorAt(i, parkedTint.set(parkedPalette[i % parkedPalette.length]));
  });
  parkedCars.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  parkedCars.instanceMatrix.needsUpdate = true;
  parkedCars.instanceColor.needsUpdate = true;
  parkedCars.castShadow = true;
  parkedCars.receiveShadow = true;
  parkedCars.computeBoundingSphere();
  group.add(parkedCars);

  // Day traffic gives the broad avenues a readable human scale while the
  // emissive headlight system is still asleep. Four restrained yellow taxis
  // establish a city identity without turning the focus backdrop into an
  // arcade. One dynamic InstancedMesh is the complete moving fleet.
  const dayTrafficMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x000000,
    roughness: 0.62,
    metalness: 0.12,
    flatShading: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
  });
  const dayTraffic = new THREE.InstancedMesh(
    parkedCarGeo,
    dayTrafficMat,
    CITY_DAY_TRAFFIC_LAYOUT.length,
  );
  dayTraffic.name = "city-day-traffic";
  dayTraffic.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  dayTraffic.frustumCulled = false;
  const dayTrafficDummy = new THREE.Object3D();
  const dayTrafficTint = new THREE.Color();
  let dayTrafficTime = 0;

  function updateDayTrafficMatrices() {
    for (let i = 0; i < CITY_DAY_TRAFFIC_LAYOUT.length; i++) {
      const vehicle = CITY_DAY_TRAFFIC_LAYOUT[i];
      dayTrafficDummy.position.set(
        resolveCityTrafficX(vehicle, dayTrafficTime),
        GROUND_Y + 0.025,
        vehicle.lane,
      );
      dayTrafficDummy.rotation.set(0, vehicle.direction < 0 ? Math.PI : 0, 0);
      dayTrafficDummy.scale.setScalar(vehicle.scale);
      dayTrafficDummy.updateMatrix();
      dayTraffic.setMatrixAt(i, dayTrafficDummy.matrix);
    }
    dayTraffic.instanceMatrix.needsUpdate = true;
  }

  CITY_DAY_TRAFFIC_LAYOUT.forEach((vehicle, i) => {
    dayTraffic.setColorAt(i, dayTrafficTint.set(vehicle.color));
  });
  dayTraffic.instanceColor.needsUpdate = true;
  updateDayTrafficMatrices();
  group.add(dayTraffic);

  // Low street trees and benches add lived-in scale along the avenue edges.
  // All positions stay outside |x| < 38 so the timer owns a quiet central
  // lane. Four static instanced meshes add no per-frame work.
  const streetscapeSpots = [
    { x: -42, z: -38 }, { x: 42, z: -38 }, { x: -62, z: -57 }, { x: 62, z: -57 },
    { x: -78, z: -41 }, { x: 78, z: -41 },
    { x: -230, z: -39 }, { x: -185, z: -61 }, { x: -140, z: -39 }, { x: -95, z: -61 },
    { x: 95, z: -39 }, { x: 140, z: -61 }, { x: 185, z: -39 }, { x: 230, z: -61 },
    { x: -220, z: -139 }, { x: -150, z: -161 }, { x: 150, z: -139 }, { x: 220, z: -161 },
  ];
  const planterMat = new THREE.MeshStandardMaterial({
    color: 0x8c8170,
    roughness: 0.96,
    metalness: 0,
    flatShading: true,
  });
  const streetTrunkMat = new THREE.MeshStandardMaterial({
    color: 0x4e3e32,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });
  const streetTreeMat = new THREE.MeshStandardMaterial({
    color: 0x496a52,
    roughness: 0.94,
    metalness: 0,
    flatShading: true,
  });
  const benchMat = new THREE.MeshStandardMaterial({
    color: 0x493f38,
    roughness: 0.88,
    metalness: 0.08,
    flatShading: true,
  });

  const planterGeo = new THREE.BoxGeometry(2.5, 0.64, 2.5);
  planterGeo.translate(0, 0.32, 0);
  const treeTrunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 2.35, 6);
  treeTrunkGeo.translate(0, 1.48, 0);
  const treeCrownGeo = new THREE.IcosahedronGeometry(1, 1);
  treeCrownGeo.scale(1.25, 1.62, 1.15);
  treeCrownGeo.translate(0, 3.4, 0);
  const planters = new THREE.InstancedMesh(planterGeo, planterMat, streetscapeSpots.length);
  const streetTrunks = new THREE.InstancedMesh(treeTrunkGeo, streetTrunkMat, streetscapeSpots.length);
  const streetTrees = new THREE.InstancedMesh(treeCrownGeo, streetTreeMat, streetscapeSpots.length);
  const streetDummy = new THREE.Object3D();
  streetscapeSpots.forEach((spot, i) => {
    streetDummy.position.set(spot.x, GROUND_Y + 0.03, spot.z);
    streetDummy.rotation.set(0, (i % 4) * Math.PI * 0.17, 0);
    const scale = i < 8 ? 0.92 + (i % 3) * 0.08 : 0.78 + (i % 2) * 0.08;
    streetDummy.scale.setScalar(scale);
    streetDummy.updateMatrix();
    planters.setMatrixAt(i, streetDummy.matrix);
    streetTrunks.setMatrixAt(i, streetDummy.matrix);
    streetTrees.setMatrixAt(i, streetDummy.matrix);
  });
  for (const mesh of [planters, streetTrunks, streetTrees]) {
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }

  const benchParts = [
    new THREE.BoxGeometry(2.8, 0.17, 0.62).translate(0, 0.78, 0),
    new THREE.BoxGeometry(2.8, 0.62, 0.15).translate(0, 1.08, 0.24),
    new THREE.BoxGeometry(0.15, 0.7, 0.46).translate(-1, 0.38, 0),
    new THREE.BoxGeometry(0.15, 0.7, 0.46).translate(1, 0.38, 0),
  ];
  const benchSpots = streetscapeSpots.slice(0, 8).filter((_, i) => i % 2 === 0);
  const benches = new THREE.InstancedMesh(mergeGeometries(benchParts), benchMat, benchSpots.length);
  benchSpots.forEach((spot, i) => {
    streetDummy.position.set(spot.x + (i % 2 ? 4.1 : -4.1), GROUND_Y + 0.04, spot.z);
    streetDummy.rotation.set(0, i % 2 ? Math.PI : 0, 0);
    streetDummy.scale.setScalar(0.9);
    streetDummy.updateMatrix();
    benches.setMatrixAt(i, streetDummy.matrix);
  });
  benches.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  benches.instanceMatrix.needsUpdate = true;
  benches.castShadow = true;
  benches.computeBoundingSphere();
  group.add(benches);

  // One quiet construction crane breaks the finished-box skyline during the
  // day. It sits on an existing edge mid-rise, points away from the timer lane
  // and is fully merged into one static mesh.
  const craneCandidates = city.buildings
    .filter(building => (
      building.h >= 22
      && building.h <= 48
      && building.z <= -108
      && building.z >= -260
      && Math.abs(building.x) >= 90
      && Math.abs(building.x) <= 235
    ))
    .sort((a, b) => (
      Math.abs(Math.abs(a.x) - 150) + Math.abs(a.z + 165) * 0.2
      - Math.abs(Math.abs(b.x) - 150) - Math.abs(b.z + 165) * 0.2
    ));
  const craneHost = craneCandidates[0]
    ?? city.buildings.find(building => Math.abs(building.x) > 70 && building.h < 58)
    ?? city.buildings[0];
  const craneMat = new THREE.MeshStandardMaterial({
    color: 0xa98b4e,
    roughness: 0.82,
    metalness: 0.28,
    flatShading: true,
  });
  const crane = new THREE.Mesh(makeConstructionCraneGeometry(), craneMat);
  crane.name = "city-construction-crane";
  crane.position.set(craneHost.x, craneHost.topY, craneHost.z);
  crane.rotation.y = craneHost.x < 0 ? Math.PI : 0;
  crane.castShadow = false;
  crane.receiveShadow = false;
  group.add(crane);

  // ─── Foreground: the rooftop we stand on ─────────────────────────────
  // Edge props provide foreground depth without a full-width parapet. The
  // old near-camera slab projected as a hard horizontal crop across the
  // lower fifth of 16:9 screens, hiding the street plane instead of framing
  // it. Keeping the floor continuous makes the city reach every viewport
  // edge naturally as the perspective camera changes aspect ratio.
  const fgMat = new THREE.MeshBasicMaterial({ color: 0x05070c, fog: false });
  const tankGroundOffset = -4.9;
  const tankX = -18.5;
  // Water tower, cut off by the left frame edge.
  const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 2.8, 10), fgMat);
  tank.position.set(tankX, 2.2 + tankGroundOffset, -1);
  group.add(tank);
  const tankRoof = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 2.15, 1.2, 10), fgMat);
  tankRoof.position.set(tankX, 4.2 + tankGroundOffset, -1);
  group.add(tankRoof);
  const tankStructureParts = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.CylinderGeometry(0.09, 0.15, 3.8, 5);
      leg.translate(tankX + sx * 0.86, 0.3 + tankGroundOffset, -1 + sz * 0.86);
      tankStructureParts.push(leg);
    }
  }
  for (const brace of [
    { x: tankX, y: -0.15 + tankGroundOffset, z: -0.12, ry: 0.62 },
    { x: tankX, y: -0.15 + tankGroundOffset, z: -1.88, ry: -0.62 },
    { x: tankX + 0.88, y: -0.15 + tankGroundOffset, z: -1, ry: Math.PI / 2 + 0.62 },
    { x: tankX - 0.88, y: -0.15 + tankGroundOffset, z: -1, ry: Math.PI / 2 - 0.62 },
  ]) {
    const g = new THREE.BoxGeometry(0.07, 2.7, 0.07);
    g.rotateZ(0.64);
    g.rotateY(brace.ry);
    g.translate(brace.x, brace.y, brace.z);
    tankStructureParts.push(g);
  }
  const tankStructure = new THREE.Mesh(mergeGeometries(tankStructureParts), fgMat);
  group.add(tankStructure);

  // ─── Street life: warm glows peeking through the gaps ─────────────────
  const streetFixturePositions = [];
  for (let i = 0; i < 14; i++) {
    streetFixturePositions.push({
      x: -272 + i * 42,
      z: i < 10 ? -49 + (i % 2) * 2.2 : -149 + (i % 2) * 2.2,
    });
  }
  const fixturePole = new THREE.CylinderGeometry(0.065, 0.1, 5.4, 5);
  fixturePole.translate(0, 2.7, 0);
  const fixtureArm = new THREE.BoxGeometry(1.05, 0.075, 0.075);
  fixtureArm.translate(0.46, 5.34, 0);
  const fixtureHood = new THREE.ConeGeometry(0.24, 0.28, 6);
  fixtureHood.rotateZ(Math.PI);
  fixtureHood.translate(0.93, 5.15, 0);
  const fixtureGeo = mergeGeometries([fixturePole, fixtureArm, fixtureHood]);
  const fixtureMat = new THREE.MeshStandardMaterial({
    color: 0x151922,
    roughness: 0.72,
    metalness: 0.42,
  });
  const fixtures = new THREE.InstancedMesh(fixtureGeo, fixtureMat, streetFixturePositions.length);
  const fixtureDummy = new THREE.Object3D();
  streetFixturePositions.forEach((position, i) => {
    fixtureDummy.position.set(position.x, GROUND_Y, position.z);
    fixtureDummy.rotation.y = i % 2 ? Math.PI : 0;
    fixtureDummy.updateMatrix();
    fixtures.setMatrixAt(i, fixtureDummy.matrix);
  });
  fixtures.instanceMatrix.needsUpdate = true;
  fixtures.computeBoundingSphere();
  group.add(fixtures);

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
    const fixture = streetFixturePositions[i];
    sprite.position.set(fixture.x + (i % 2 ? -0.9 : 0.9), GROUND_Y + 5.15, fixture.z);
    sprite.scale.set(4.6 + streetRng() * 2.6, 4.1, 1);
    group.add(sprite);
    streetGlows.push({ mat, sprite });
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
    // PlaneGeometry stands vertically by default. Lay the ribbons onto the
    // avenue surface so they read as moving traffic rather than light walls.
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, GROUND_Y + 0.03, lane.z);
    group.add(mesh);
    trails.push({ mat, mesh });
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
      uPixelRatio: { value: 1 },
    },
    vertexShader: `
      attribute float aLane;
      attribute float aDir;
      attribute float aSpeed;
      attribute float aOffset;
      uniform float uTime;
      uniform float uPixelRatio;
      varying vec3 vColor;
      void main() {
        float x = mod(aOffset + uTime * aSpeed * aDir, 560.0) - 280.0;
        vec3 p = vec3(x, ${GROUND_Y + 0.6}, aLane + aDir * 1.1);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = clamp(300.0 / -mv.z, 1.5, 5.0) * uPixelRatio;
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
    neons.push({ mat, sprite, phase: i * 2.1 });
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
    spireBeacons.push({ mat, sprite, phase: Math.random() * Math.PI * 2 });
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
  let motionTime = 0;

  // ─── Aircraft: one slow red pulse crossing the far sky ────────────────
  const aircraftMat = beaconBase.clone();
  const aircraft = new THREE.Sprite(aircraftMat);
  aircraft.scale.set(2.4, 2.4, 1);
  group.add(aircraft);

  const scratch = new THREE.Color();
  const familyDayFacades = FACADE_FAMILIES.map(family => new THREE.Color(family.day));
  const familyGoldenFacades = FACADE_FAMILIES.map(family => new THREE.Color(family.golden));
  const familyNightFacades = FACADE_FAMILIES.map(family => new THREE.Color(family.night));
  const dayFacade = new THREE.Color("#b8ad9c");
  const goldenFacade = new THREE.Color("#8d735d");
  const dayAsphalt = new THREE.Color("#c9c1b2");
  const goldenAsphalt = new THREE.Color("#806b58");
  const nightAsphalt = new THREE.Color("#1b2332");
  const dayVehicle = new THREE.Color("#d5cec1");
  const goldenVehicle = new THREE.Color("#c1a487");
  const nightVehicle = new THREE.Color("#424c60");
  const dayTrafficFinish = new THREE.Color("#fff8ec");
  const goldenTrafficFinish = new THREE.Color("#e7c7a6");
  const nightTrafficFinish = new THREE.Color("#6a7282");
  const dayCrane = new THREE.Color("#b79a58");
  const goldenCrane = new THREE.Color("#9c7446");
  const nightCrane = new THREE.Color("#3c4552");
  const dayPlanter = new THREE.Color("#a99b85");
  const goldenPlanter = new THREE.Color("#7e6751");
  const nightPlanter = new THREE.Color("#333a43");
  const dayStreetTree = new THREE.Color("#52765b");
  const goldenStreetTree = new THREE.Color("#4a6347");
  const nightStreetTree = new THREE.Color("#263c3a");
  const dayStreetWood = new THREE.Color("#5f4938");
  const goldenStreetWood = new THREE.Color("#523a2e");
  const nightStreetWood = new THREE.Color("#282b34");

  function applyGrade(atmosphere) {
    if (!atmosphere) return;
    const g = atmosphere.current;
    const day = atmosphere.daylight;
    const elevation = atmosphere.elevation;
    const darkness = 1 - sstep(-6, 2, elevation);
    const electricNight = 1 - sstep(-4, 10, elevation);
    const golden = sstep(-4, 1, elevation) * (1 - sstep(14, 24, elevation));

    // Each architectural family keeps a distinct albedo, bay rhythm and
    // reflectance under the shared atmosphere. The restrained per-family
    // bounce preserves side/top values instead of flattening all towers into
    // one blue-gray exposure.
    for (let i = 0; i < facadeMats.length; i++) {
      const material = facadeMats[i];
      if (!material) continue;
      scratch.copy(familyNightFacades[i]).lerp(familyDayFacades[i], day);
      scratch.lerp(familyGoldenFacades[i], golden * 0.48);
      scratch.lerp(g.fog, 0.045 + darkness * 0.065);
      material.color.copy(scratch);
      material.emissive
        .copy(familyDayFacades[i])
        .lerp(g.skyHorizon, 0.2)
        .lerp(g.key, golden * 0.12)
        .multiplyScalar(0.44 * day + 0.055 * darkness);
    }

    // Foreground edge props stay near-black so they retain depth without a
    // full-width ledge cutting across the lower viewport.
    fgMat.color.copy(scratch.copy(g.fog).multiplyScalar(0.05 + day * 0.1));
    fixtureMat.color.copy(scratch.copy(g.fog).lerp(goldenFacade, golden * 0.16).multiplyScalar(0.12 + day * 0.42));
    scratch.copy(nightVehicle).lerp(dayVehicle, day).lerp(goldenVehicle, golden * 0.48);
    parkedCarMat.color.copy(scratch);
    parkedCarMat.emissive.copy(scratch).multiplyScalar(day * 0.035 + darkness * 0.008);
    scratch.copy(nightTrafficFinish).lerp(dayTrafficFinish, day).lerp(goldenTrafficFinish, golden * 0.52);
    dayTrafficMat.color.copy(scratch);
    dayTrafficMat.emissive.copy(g.ambientSky).multiplyScalar(day * 0.018 + darkness * 0.025);
    scratch.copy(nightCrane).lerp(dayCrane, day).lerp(goldenCrane, golden * 0.58);
    craneMat.color.copy(scratch).lerp(g.fog, darkness * 0.08);
    craneMat.emissive.copy(g.ambientSky).multiplyScalar(darkness * 0.035);

    scratch.copy(nightPlanter).lerp(dayPlanter, day).lerp(goldenPlanter, golden * 0.52);
    planterMat.color.copy(scratch);
    scratch.copy(nightStreetTree).lerp(dayStreetTree, day).lerp(goldenStreetTree, golden * 0.5);
    streetTreeMat.color.copy(scratch);
    streetTreeMat.emissive.copy(nightStreetTree).lerp(g.ambientSky, 0.35).multiplyScalar(darkness * 0.08);
    scratch.copy(nightStreetWood).lerp(dayStreetWood, day).lerp(goldenStreetWood, golden * 0.48);
    streetTrunkMat.color.copy(scratch);
    benchMat.color.copy(scratch).lerp(g.ambientGround, 0.08);

    // Haze: fog-colored by day, warmed by the city's own glow at night.
    scratch.copy(g.fog).lerp(g.skyHorizon, 0.28).lerp(g.key, darkness * 0.15);
    for (const layer of hazeLayers) {
      layer.mat.color.copy(scratch);
      layer.mat.opacity = layer.base * (0.34 + darkness * 1.02);
    }

    // Sodium haze dome, graded toward the key light. Amber, not red.
    scratch.set(0xffb37a).lerp(g.key, 0.35);
    glowMat.color.copy(scratch);
    glowMat.opacity = electricNight * 0.08;
    glowCoreMat.color.copy(scratch);
    glowCoreMat.opacity = electricNight * 0.11;

    // The ground must stay clearly darker than the sky — but by day the
    // asphalt and blocks still read as a lit city fabric.
    scratch.copy(nightAsphalt).lerp(dayAsphalt, day).lerp(goldenAsphalt, golden * 0.56);
    scratch.lerp(g.fog, 0.055 + darkness * 0.04);
    groundMat.color.copy(scratch);
  }

  function updateCelestial(_c, atmosphere) {
    applyGrade(atmosphere);
  }

  function update(delta, elapsed, atmosphere) {
    applyGrade(atmosphere);

    // Occupancy wakes through dusk, not merely when the daylight scalar
    // starts tapering at +12°. This prevents an orange neon grid from
    // overpowering a still-sunlit 18:30 street while preserving full night.
    const night = atmosphere ? 1 - sstep(-4, 10, atmosphere.elevation) : 1;
    const reducedMotion = prefersReducedMotion();
    const dayTrafficStrength = cityDayTrafficMix(atmosphere?.elevation);
    dayTraffic.visible = dayTrafficStrength > 0.01;
    dayTrafficMat.opacity = dayTrafficStrength;
    dayTrafficTime = advanceCityTrafficTime(dayTrafficTime, delta, reducedMotion);
    if (!reducedMotion && dayTraffic.visible) updateDayTrafficMatrices();

    const nightEffectsVisible = night > 0.01;
    windows.visible = nightEffectsVisible;
    cars.visible = nightEffectsVisible;
    floorGlow.visible = nightEffectsVisible;
    flicker.visible = nightEffectsVisible;
    aircraft.visible = nightEffectsVisible;
    glow.visible = nightEffectsVisible;
    glowCore.visible = nightEffectsVisible;
    for (const { mesh } of trails) mesh.visible = nightEffectsVisible;
    for (const { mesh } of beams) mesh.visible = nightEffectsVisible;
    for (const { sprite } of neons) sprite.visible = nightEffectsVisible;
    for (const { sprite } of spireBeacons) sprite.visible = nightEffectsVisible;
    for (const { sprite } of streetGlows) sprite.visible = nightEffectsVisible;

    if (!nightEffectsVisible) {
      windowMat.opacity = 0;
      groundMat.emissiveIntensity = 0;
      return;
    }

    if (!reducedMotion) motionTime += delta;

    // litRatio: windows crossfade with dusk instead of popping.
    windowMat.opacity = night * 0.95;

    // Traffic trails on the avenues, plus the individual cars riding them.
    for (const { mat } of trails) {
      mat.uniforms.uTime.value = motionTime;
      mat.uniforms.uOpacity.value = night * mat.userData.base;
    }
    carTime += delta * (reducedMotion ? 0 : 1);
    carMat.uniforms.uTime.value = carTime;
    carMat.uniforms.uOpacity.value = night * 0.9;
    groundMat.emissiveIntensity = night * 1.18;

    // Searchlights sweep slowly; reduced motion parks them at a rake.
    beamMat.uniforms.uOpacity.value = night * 0.085;
    for (const b of beams) {
      b.mesh.rotation.z = reducedMotion ? 0.42 : Math.sin(motionTime * 0.09 + b.phase) * 0.55;
    }

    // Neon buzzes gently; reduced motion holds it steady.
    for (const n of neons) {
      const buzz = reducedMotion ? 1 : 0.94 + 0.06 * Math.sin(motionTime * 0.45 + n.phase);
      n.mat.opacity = night * 0.4 * buzz;
    }

    // Street-level warmth in the gaps between towers, and the carpet base.
    for (const { mat } of streetGlows) mat.opacity = night * 0.34;
    floorGlowMat.opacity = night * 0.14;

    // Spire beacons pulse out of phase; steady dim under reduced motion.
    for (const b of spireBeacons) {
      const pulse = reducedMotion
        ? 0.4
        : 0.16 + 0.58 * Math.pow(0.5 + 0.5 * Math.sin(motionTime * 0.92 + b.phase), 7);
      b.mat.opacity = pulse * night * 0.7;
    }

    // Late rooms change state every few seconds, easing not snapping.
    if (!reducedMotion && night > 0.05 && flickerCount > 0) {
      flickerTimer -= delta;
      if (flickerTimer <= 0) {
        flickerTimer = 4.5;
        for (let k = 0; k < 1; k++) {
          const idx = Math.floor(Math.random() * flickerCount);
          flickerTargets[idx] = flickerTargets[idx] > 0.5 ? 0.08 : 0.7 + Math.random() * 0.4;
        }
      }
      const arr = flicker.instanceColor.array;
      const f = 1 - Math.exp(-1.4 * delta);
      for (let i = 0; i < flickerCount; i++) {
        flickerCurrent[i] += (flickerTargets[i] - flickerCurrent[i]) * f;
        arr[i * 3] = arr[i * 3 + 1] = arr[i * 3 + 2] = flickerCurrent[i];
      }
      flicker.instanceColor.needsUpdate = true;
    }
    flickerMat.opacity = night * 0.9;

    // The aircraft crosses on a long loop.
    const t = (motionTime % 90) / 90;
    aircraft.position.set(-320 + t * 640, 74, -280);
    const blink = reducedMotion
      ? 0.35
      : 0.08 + 0.62 * Math.pow(0.5 + 0.5 * Math.sin(motionTime * 1.15), 9);
    aircraftMat.opacity = blink * night * 0.72;
  }

  return {
    group,
    updateCelestial,
    update,
    setPixelRatio(ratio) {
      carMat.uniforms.uPixelRatio.value = ratio;
    },
  };
}
