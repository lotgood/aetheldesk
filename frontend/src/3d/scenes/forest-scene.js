import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { prefersReducedMotion } from "../motion.js";

// ─── Forest: a quiet conifer clearing ────────────────────────────────────
// Art direction: depth comes from value, not hue. Three treelines recede
// into the fog color, the ground meets them with no gap, and the palette
// stays desaturated at every hour. The campfire is small, pushed into the
// left-lower third and set back so it never collides with the control bar,
// and its embers are soft round sprites rather than hard quads.

const GROUND_Y = -7.0;
const CAMPFIRE_X = -13.5;
const CAMPFIRE_Z = -6;

function makeEmberTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0.0, "rgba(255,236,196,1.0)");
  grad.addColorStop(0.3, "rgba(255,166,84,0.72)");
  grad.addColorStop(0.7, "rgba(255,110,40,0.18)");
  grad.addColorStop(1.0, "rgba(255,90,30,0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeMistTexture() {
  const w = 256;
  const h = 128;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.0, "rgba(255,255,255,0.0)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.55)");
  grad.addColorStop(1.0, "rgba(255,255,255,0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeForestFloorTextures() {
  const size = 512;
  const rng = makeRng(0x51a7f10);
  const colorCanvas = document.createElement("canvas");
  const bumpCanvas = document.createElement("canvas");
  colorCanvas.width = colorCanvas.height = size;
  bumpCanvas.width = bumpCanvas.height = size;
  const colorCtx = colorCanvas.getContext("2d");
  const bumpCtx = bumpCanvas.getContext("2d");

  colorCtx.fillStyle = "#7a8969";
  colorCtx.fillRect(0, 0, size, size);
  bumpCtx.fillStyle = "#777777";
  bumpCtx.fillRect(0, 0, size, size);

  // Broad moss/soil variation first, then needles and tiny stones. Keeping
  // the texture stochastic but deterministic avoids the visibly tiled checker
  // that a photographed forest-floor texture would create at this scale.
  for (let i = 0; i < 72; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const radius = 18 + rng() * 72;
    const moss = rng() > 0.42;
    const grad = colorCtx.createRadialGradient(x, y, 0, x, y, radius);
    grad.addColorStop(0, moss ? "rgba(78,104,70,0.34)" : "rgba(72,57,43,0.28)");
    grad.addColorStop(1, "rgba(55,63,52,0)");
    colorCtx.fillStyle = grad;
    colorCtx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  colorCtx.lineCap = "round";
  bumpCtx.lineCap = "round";
  for (let i = 0; i < 760; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const a = rng() * Math.PI;
    const len = 2 + rng() * 8;
    const warm = rng() > 0.24;
    colorCtx.strokeStyle = warm
      ? `rgba(69,49,35,${0.18 + rng() * 0.22})`
      : `rgba(124,137,101,${0.1 + rng() * 0.16})`;
    colorCtx.lineWidth = 0.45 + rng() * 1.1;
    colorCtx.beginPath();
    colorCtx.moveTo(x, y);
    colorCtx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    colorCtx.stroke();

    const value = Math.floor(105 + rng() * 62);
    bumpCtx.strokeStyle = `rgb(${value},${value},${value})`;
    bumpCtx.lineWidth = colorCtx.lineWidth;
    bumpCtx.beginPath();
    bumpCtx.moveTo(x, y);
    bumpCtx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    bumpCtx.stroke();
  }
  for (let i = 0; i < 210; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 0.5 + rng() * 2.1;
    const v = 75 + Math.floor(rng() * 70);
    colorCtx.fillStyle = `rgba(${v},${v + 3},${v - 3},${0.12 + rng() * 0.2})`;
    colorCtx.beginPath();
    colorCtx.arc(x, y, r, 0, Math.PI * 2);
    colorCtx.fill();
  }

  const map = new THREE.CanvasTexture(colorCanvas);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(42, 42);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const bump = new THREE.CanvasTexture(bumpCanvas);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  bump.repeat.copy(map.repeat);
  bump.anisotropy = 2;
  return { map, bump };
}

function paintHeightMultiplier(geometry, low = 0.62, high = 1.08) {
  const position = geometry.attributes.position;
  geometry.computeBoundingBox();
  const y0 = geometry.boundingBox.min.y;
  const range = Math.max(1e-5, geometry.boundingBox.max.y - y0);
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const t = Math.min(1, Math.max(0, (position.getY(i) - y0) / range));
    const value = THREE.MathUtils.lerp(low, high, t * t * (3 - 2 * t));
    colors[i * 3] = value * (0.96 + t * 0.04);
    colors[i * 3 + 1] = value;
    colors[i * 3 + 2] = value * (0.94 + t * 0.06);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.boundingBox = null;
  return geometry;
}

// A conifer is a hierarchy, not a single cone. Layered skirts leave small
// negative spaces between branch whorls, which survive both fog and the
// central timer overlay. Near, mid and far belts use progressively cheaper
// versions of the same silhouette so the transition reads as depth, not as a
// change of species.
function makeConiferGeometry(radialSegments, tierCount) {
  const parts = [];
  for (let i = 0; i < tierCount; i++) {
    const t = i / Math.max(1, tierCount - 1);
    const radius = THREE.MathUtils.lerp(1, 0.25, t);
    const height = THREE.MathUtils.lerp(0.34, 0.22, t);
    const yBase = 0.16 + t * 0.62;
    const tier = new THREE.ConeGeometry(radius, height, radialSegments, 1, false);
    tier.rotateY((i % 2) * (Math.PI / radialSegments));
    tier.translate(0, yBase + height * 0.5, 0);
    parts.push(tier);
  }
  const leader = new THREE.ConeGeometry(0.22, 0.3, radialSegments, 1, false);
  leader.translate(0, 0.85, 0);
  parts.push(leader);
  return paintHeightMultiplier(mergeGeometries(parts), 0.54, 1.08);
}

function makeShrubGeometry() {
  const parts = [];
  for (const blob of [
    { x: -0.5, y: 0.48, z: 0.08, s: 0.72 },
    { x: 0.38, y: 0.42, z: -0.16, s: 0.66 },
    { x: -0.02, y: 0.72, z: 0.12, s: 0.82 },
  ]) {
    const g = new THREE.IcosahedronGeometry(1, 0);
    g.scale(blob.s, blob.s * 0.72, blob.s);
    g.translate(blob.x, blob.y, blob.z);
    parts.push(g);
  }
  return paintHeightMultiplier(mergeGeometries(parts), 0.64, 1.05);
}

function makeFernGeometry() {
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const leaf = new THREE.ConeGeometry(0.16, 1, 3, 1, false);
    leaf.scale(1, 0.68 + (i % 3) * 0.11, 0.34);
    leaf.rotateZ(0.62);
    leaf.rotateY(a);
    leaf.translate(Math.cos(a) * 0.26, 0.42, Math.sin(a) * 0.26);
    parts.push(leaf);
  }
  return paintHeightMultiplier(mergeGeometries(parts), 0.58, 1.12);
}

function makePathGeometry() {
  const segments = 28;
  const positions = new Float32Array((segments + 1) * 2 * 3);
  const normals = new Float32Array((segments + 1) * 2 * 3);
  const uvs = new Float32Array((segments + 1) * 2 * 2);
  const indices = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const z = THREE.MathUtils.lerp(30, -105, t);
    const center = Math.sin(t * Math.PI * 2.15) * (1.2 + t * 3.4) - t * 4;
    const half = THREE.MathUtils.lerp(5.8, 2.1, t);
    for (let side = 0; side < 2; side++) {
      const vertex = i * 2 + side;
      positions[vertex * 3] = center + (side ? half : -half);
      positions[vertex * 3 + 1] = GROUND_Y + 0.045;
      positions[vertex * 3 + 2] = z;
      normals[vertex * 3 + 1] = 1;
      uvs[vertex * 2] = side;
      uvs[vertex * 2 + 1] = t * 12;
    }
    if (i < segments) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

export function buildAlpineRangeGeometry() {
  const xSegments = 144;
  const zSegments = 32;
  const xMin = -900;
  const xMax = 900;
  const zFront = -450;
  const zBack = -850;
  const row = xSegments + 1;
  const positions = new Float32Array((xSegments + 1) * (zSegments + 1) * 3);
  const indices = [];

  function alpinePeak(x, z, cx, cz, sx, sz, height) {
    const dx = (x - cx) / sx;
    const dz = (z - cz) / sz;
    const radial = Math.sqrt(dx * dx + dz * dz);
    const cone = Math.max(0, 1 - radial);
    // A concave cone gives steep talus at the foot and a narrow summit. The
    // previous summed Gaussians produced the exact opposite: four soft domes.
    const profile = Math.pow(cone, 0.72);
    const faceRidges = 0.9
      + Math.abs(Math.sin(x * 0.034 + z * 0.019)) * 0.07
      + Math.sin(x * 0.071 - z * 0.026) * 0.035;
    return profile * height * faceRidges;
  }

  for (let iz = 0; iz <= zSegments; iz++) {
    const v = iz / zSegments;
    const z = THREE.MathUtils.lerp(zFront, zBack, v);
    for (let ix = 0; ix <= xSegments; ix++) {
      const u = ix / xSegments;
      const x = THREE.MathUtils.lerp(xMin, xMax, u);
      const leftShoulder = alpinePeak(x, z, -680, -745, 290, 170, 116);
      const leftPeak = alpinePeak(x, z, -355, -685, 270, 150, 205);
      const centralPeak = alpinePeak(x, z, 70, -720, 235, 140, 248);
      const rightPeak = alpinePeak(x, z, 430, -690, 275, 155, 218);
      const rightShoulder = alpinePeak(x, z, 755, -755, 285, 175, 132);
      // Max-composition preserves valleys between summits. Adding bell curves
      // here was what merged the old range into one long potato silhouette.
      const ridge = Math.max(leftShoulder, leftPeak, centralPeak, rightPeak, rightShoulder);
      const edgeFade =
        sstep(0, 0.09, u) * sstep(0, 0.09, 1 - u)
        * sstep(0, 0.12, v) * sstep(0, 0.1, 1 - v);
      const rockNoise =
        Math.sin(x * 0.031 + z * 0.017) * 7.5
        + Math.sin(x * 0.073 - z * 0.029 + 1.7) * 4.2
        + Math.sin(x * 0.013 + z * 0.061 - 0.9) * 2.8;
      const y = GROUND_Y - 20 + Math.max(0, ridge + rockNoise * Math.min(1, ridge / 42)) * edgeFade;
      const offset = (iz * row + ix) * 3;
      positions[offset] = x;
      positions[offset + 1] = y;
      positions[offset + 2] = z;

      if (ix < xSegments && iz < zSegments) {
        const a = iz * row + ix;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const colors = new Float32Array((xSegments + 1) * (zSegments + 1) * 3);
  const snowMask = new Float32Array((xSegments + 1) * (zSegments + 1));
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const lowRock = new THREE.Color("#464b50");
  const highRock = new THREE.Color("#747a7f");
  const snow = new THREE.Color("#dce6e8");
  const color = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const height = Math.max(0, (position.getY(i) - (GROUND_Y - 20)) / 248);
    const exposureNoise = Math.sin(position.getX(i) * 0.041 + position.getZ(i) * 0.025) * 0.045;
    const snowLine = 0.42 + exposureNoise + (1 - Math.max(0, normal.getY(i))) * 0.065;
    const snowMix = sstep(snowLine - 0.045, snowLine + 0.065, height);
    color.copy(lowRock).lerp(highRock, sstep(0.08, 0.7, height)).lerp(snow, snowMix);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
    snowMask[i] = snowMix;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("mountainSnow", new THREE.BufferAttribute(snowMask, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function sstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Light-shaft cards: alpha lives entirely in the UV falloff so the cards
// have no hard edges to catch against the treeline.
const ShaftShader = {
  uniforms: {
    uColor: { value: new THREE.Color("#ffe2bb") },
    uOpacity: { value: 0 },
  },
  vertexShader: `
    #include <fog_pars_vertex>
    varying vec2 vUv;
    void main() {
      vUv = uv;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }
  `,
  fragmentShader: `
    #include <fog_pars_fragment>
    uniform vec3 uColor;
    uniform float uOpacity;
    varying vec2 vUv;
    void main() {
      float a = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x)
              * smoothstep(0.0, 0.22, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
      gl_FragColor = vec4(uColor, a * uOpacity);
      #include <fog_fragment>
      #include <colorspace_fragment>
    }
  `,
};

const FlameShader = {
  uniforms: {
    uTime: { value: 0 },
    uStrength: { value: 1 },
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
    uniform float uStrength;
    varying vec2 vUv;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 345.45));
      p += dot(p, p + 34.345);
      return fract(p.x * p.y);
    }

    void main() {
      vec2 p = vec2((vUv.x - 0.5) * 2.0, vUv.y);
      float y = clamp(p.y, 0.0, 1.0);
      float cells = hash21(floor(vec2(p.x * 7.0, y * 12.0 + uTime * 4.0)));
      float sway = sin(y * 10.0 - uTime * 3.4) * (0.035 + y * 0.1)
                 + (cells - 0.5) * 0.07 * y;
      float width = mix(0.64, 0.035, pow(y, 0.72));
      float body = 1.0 - smoothstep(width * 0.58, width, abs(p.x - sway));
      body *= smoothstep(0.0, 0.11, y) * (1.0 - smoothstep(0.88, 1.0, y));
      float split = 1.0 - smoothstep(0.12, 0.3, abs(p.x + sway * 0.4)) * smoothstep(0.48, 0.9, y);
      body *= mix(1.0, split, 0.28);
      float core = 1.0 - smoothstep(width * 0.16, width * 0.48, abs(p.x - sway * 0.35));
      vec3 outer = vec3(1.0, 0.16, 0.015);
      vec3 inner = vec3(1.0, 0.92, 0.5);
      vec3 color = mix(outer, inner, core * (1.0 - y * 0.44));
      float alpha = body * (0.7 + core * 0.3) * uStrength;
      if (alpha < 0.01) discard;
      gl_FragColor = vec4(color, alpha);
      #include <colorspace_fragment>
    }
  `,
};

export function createForestScene() {
  const group = new THREE.Group();
  group.name = "scene-forest";
  const rng = makeRng(0xf0235117);

  // ─── Ground ───────────────────────────────────────────────────────────
  const floorTextures = makeForestFloorTextures();
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x55624b,
    map: floorTextures.map,
    bumpMap: floorTextures.bump,
    bumpScale: 0.16,
    roughness: 1.0,
    metalness: 0.0,
  });
  const groundGeo = new THREE.PlaneGeometry(1200, 1200, 48, 48);
  const groundPosition = groundGeo.attributes.position;
  for (let i = 0; i < groundPosition.count; i++) {
    const x = groundPosition.getX(i);
    const y = groundPosition.getY(i);
    const ripple = Math.sin(x * 0.021) * 0.045 + Math.sin(y * 0.017 + x * 0.006) * 0.035;
    groundPosition.setZ(i, ripple);
  }
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GROUND_Y;
  ground.receiveShadow = true;
  group.add(ground);

  // A quiet trail supplies a mid-frequency shape across the otherwise broad
  // foreground. It bends behind the focus dial instead of drawing a hard
  // centre line through the interface.
  const pathMat = new THREE.MeshStandardMaterial({
    color: 0x756a50,
    roughness: 1,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  const path = new THREE.Mesh(makePathGeometry(), pathMat);
  path.receiveShadow = true;
  group.add(path);

  // ─── Treelines ────────────────────────────────────────────────────────
  // Geometry degrades by range as in Weber/Penn's tree model: layered near
  // crowns, fewer branch skirts in the middle, and a cheap but compatible
  // silhouette at the horizon. Every trunk base remains on the ground plane.
  const trunkGeo = new THREE.CylinderGeometry(0.11, 0.17, 0.28, 7);
  trunkGeo.translate(0, 0.14, 0);

  const BELTS = [
    { count: 58, radius: 60, spreadR: 24, hMin: 9, hMax: 18, fogMix: 0.12, geometry: makeConiferGeometry(8, 6), shadows: true },
    { count: 74, radius: 118, spreadR: 38, hMin: 11, hMax: 22, fogMix: 0.43, geometry: makeConiferGeometry(7, 5), shadows: true },
    { count: 96, radius: 218, spreadR: 76, hMin: 14, hMax: 29, fogMix: 0.76, geometry: makeConiferGeometry(6, 4), shadows: false },
  ];

  // Deliberately asymmetric hero trunks crop into the frame edges. They are
  // close enough for layered crowns to read, but leave the timer and the sun
  // lane open in every aspect ratio.
  const HERO_SPOTS = [
    { x: -34, z: 5, h: 23 }, { x: 35, z: 2, h: 21 },
    { x: -43, z: -14, h: 20 }, { x: 45, z: -18, h: 24 },
    { x: -29, z: -28, h: 17 }, { x: 30, z: -34, h: 18 },
    { x: -50, z: -39, h: 22 }, { x: 52, z: -46, h: 20 },
  ];

  const belts = [];
  const dummy = new THREE.Object3D();
  const instanceTint = new THREE.Color();
  const treeFootprints = [];

  for (let beltIndex = 0; beltIndex < BELTS.length; beltIndex++) {
    const cfg = BELTS[beltIndex];
    const foliageMat = new THREE.MeshStandardMaterial({
      color: 0x426249,
      roughness: 0.92,
      metalness: 0.0,
      flatShading: true,
      vertexColors: true,
    });
    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0x4a3a2f,
      roughness: 1.0,
      flatShading: true,
    });

    const foliage = new THREE.InstancedMesh(cfg.geometry, foliageMat, cfg.count);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, cfg.count);
    foliage.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    trunks.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    foliage.castShadow = cfg.shadows;
    trunks.castShadow = cfg.shadows;

    for (let i = 0; i < cfg.count; i++) {
      const hero = beltIndex === 0 && i < HERO_SPOTS.length ? HERO_SPOTS[i] : null;
      const ringOffset = beltIndex === 0 ? HERO_SPOTS.length : 0;
      const angle = ((i - ringOffset) / Math.max(1, cfg.count - ringOffset)) * Math.PI * 2
        + (rng() - 0.5) * 0.16;
      const radius = cfg.radius + (rng() - 0.5) * cfg.spreadR;
      const x = hero ? hero.x : Math.cos(angle) * radius;
      const z = hero ? hero.z : Math.sin(angle) * radius;
      const h = hero ? hero.h : cfg.hMin + rng() * (cfg.hMax - cfg.hMin);
      const w = h * (0.18 + rng() * 0.055);
      const leanX = (rng() - 0.5) * (beltIndex === 0 ? 0.045 : 0.025);
      const leanZ = (rng() - 0.5) * (beltIndex === 0 ? 0.045 : 0.025);
      treeFootprints.push({ x, z, radius: Math.max(0.65, w * 0.58) });

      dummy.position.set(x, GROUND_Y, z);
      dummy.rotation.set(leanX, rng() * Math.PI, leanZ);
      dummy.scale.set(w, h, w);
      dummy.updateMatrix();
      foliage.setMatrixAt(i, dummy.matrix);
      foliage.setColorAt(i, instanceTint.setScalar(0.82 + rng() * 0.27));

      dummy.position.set(x, GROUND_Y, z);
      dummy.scale.set(w, h, w);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      trunks.setColorAt(i, instanceTint.setScalar(0.78 + rng() * 0.24));
    }
    foliage.instanceMatrix.needsUpdate = true;
    trunks.instanceMatrix.needsUpdate = true;
    foliage.instanceColor.needsUpdate = true;
    trunks.instanceColor.needsUpdate = true;
    foliage.computeBoundingSphere();
    trunks.computeBoundingSphere();

    group.add(foliage);
    group.add(trunks);
    belts.push({ cfg, foliageMat, trunkMat });
  }

  // ─── Alpine range ─────────────────────────────────────────────────────
  // One continuous heightfield replaces four stretched hemispheres whose
  // front faces physically intersected the far tree belt. Rock and snow live
  // in vertex color, preserving one draw call and a naturally broken snowline.
  const mountainMat = new THREE.MeshStandardMaterial({
    color: 0xf0f2f2,
    emissive: 0x000000,
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
    flatShading: true,
  });
  const mountainSnowBounce = { value: new THREE.Color("#9fb9cf") };
  mountainMat.onBeforeCompile = (shader) => {
    shader.uniforms.uMountainSnowBounce = mountainSnowBounce;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nattribute float mountainSnow;\nvarying float vMountainSnow;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvMountainSnow = mountainSnow;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform vec3 uMountainSnowBounce;\nvarying float vMountainSnow;",
      )
      .replace(
        "#include <opaque_fragment>",
        "outgoingLight += uMountainSnowBounce * vMountainSnow;\n#include <opaque_fragment>",
      );
  };
  mountainMat.customProgramCacheKey = () => "aetheldesk-alpine-snow-bounce-v1";
  const mountains = new THREE.Mesh(buildAlpineRangeGeometry(), mountainMat);
  mountains.name = "alpine-range";
  mountains.receiveShadow = false;
  mountains.castShadow = false;
  group.add(mountains);

  // ─── Understory and forest-floor story ──────────────────────────────
  // Four instanced layers replace the empty field without turning the
  // clearing into noise: shrubs establish a waist-high tier, ferns stitch
  // them to the floor, and rocks/logs provide contact-scale landmarks.
  const shrubMat = new THREE.MeshStandardMaterial({
    color: 0x49664a,
    roughness: 0.96,
    metalness: 0,
    flatShading: true,
    vertexColors: true,
  });
  const fernMat = new THREE.MeshStandardMaterial({
    color: 0x526e4c,
    roughness: 0.98,
    metalness: 0,
    flatShading: true,
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x65665d,
    roughness: 0.98,
    metalness: 0,
    flatShading: true,
  });
  const barkMat = new THREE.MeshStandardMaterial({
    color: 0x49382c,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });

  const SHRUB_COUNT = 36;
  const shrubs = new THREE.InstancedMesh(makeShrubGeometry(), shrubMat, SHRUB_COUNT);
  shrubs.castShadow = true;
  for (let i = 0; i < SHRUB_COUNT; i++) {
    const angle = (i / SHRUB_COUNT) * Math.PI * 2 + (rng() - 0.5) * 0.28;
    const radius = 21 + rng() * 46;
    const height = 0.7 + rng() * 1.55;
    const x = Math.cos(angle) * radius;
    const rawZ = Math.sin(angle) * radius - 14;
    const z = rawZ > 7 ? -18 - rng() * 44 : rawZ;
    dummy.position.set(x, GROUND_Y, z);
    dummy.rotation.set((rng() - 0.5) * 0.08, rng() * Math.PI, (rng() - 0.5) * 0.08);
    dummy.scale.set(height * (0.82 + rng() * 0.35), height, height * (0.82 + rng() * 0.35));
    dummy.updateMatrix();
    shrubs.setMatrixAt(i, dummy.matrix);
    shrubs.setColorAt(i, instanceTint.setScalar(0.76 + rng() * 0.3));
  }
  shrubs.instanceMatrix.needsUpdate = true;
  shrubs.instanceColor.needsUpdate = true;
  shrubs.computeBoundingSphere();
  group.add(shrubs);

  const FERN_COUNT = 60;
  const ferns = new THREE.InstancedMesh(makeFernGeometry(), fernMat, FERN_COUNT);
  for (let i = 0; i < FERN_COUNT; i++) {
    const angle = (i / FERN_COUNT) * Math.PI * 2 + (rng() - 0.5) * 0.4;
    const radius = 18 + rng() * 52;
    const size = 0.45 + rng() * 0.9;
    const x = Math.cos(angle) * radius;
    const rawZ = Math.sin(angle) * radius - 11;
    const z = rawZ > 8 ? -16 - rng() * 48 : rawZ;
    dummy.position.set(x, GROUND_Y + 0.02, z);
    dummy.rotation.set(0, rng() * Math.PI, 0);
    dummy.scale.setScalar(size);
    dummy.updateMatrix();
    ferns.setMatrixAt(i, dummy.matrix);
    ferns.setColorAt(i, instanceTint.setScalar(0.74 + rng() * 0.34));
  }
  ferns.instanceMatrix.needsUpdate = true;
  ferns.instanceColor.needsUpdate = true;
  ferns.computeBoundingSphere();
  group.add(ferns);

  const ROCK_COUNT = 24;
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), rockMat, ROCK_COUNT);
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  const propFootprints = [];
  function isGroundPropClear(x, z, radius) {
    if (Math.hypot(x - CAMPFIRE_X, z - CAMPFIRE_Z) < radius + 5.5) return false;
    if (treeFootprints.some(tree => Math.hypot(x - tree.x, z - tree.z) < radius + tree.radius)) return false;
    return !propFootprints.some(prop => Math.hypot(x - prop.x, z - prop.z) < radius + prop.radius);
  }
  for (let i = 0; i < ROCK_COUNT; i++) {
    const size = 0.16 + rng() * 0.46;
    let x = 0;
    let z = -30;
    for (let attempt = 0; attempt < 16; attempt++) {
      const angle = (i / ROCK_COUNT) * Math.PI * 2 + rng() * 0.3;
      const distance = 18 + rng() * 56;
      const candidateX = Math.cos(angle) * distance;
      const rawZ = Math.sin(angle) * distance - 9;
      const candidateZ = rawZ > 6 ? -20 - rng() * 46 : rawZ;
      x = candidateX;
      z = candidateZ;
      if (isGroundPropClear(x, z, size * 1.25 + 0.45)) break;
    }
    propFootprints.push({ x, z, radius: size * 1.25 + 0.45 });
    dummy.position.set(x, GROUND_Y + size * 0.28, z);
    dummy.rotation.set(rng() * 0.9, rng() * Math.PI, rng() * 0.7);
    dummy.scale.set(size * (0.8 + rng() * 0.5), size * (0.45 + rng() * 0.35), size);
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
    rocks.setColorAt(i, instanceTint.setScalar(0.7 + rng() * 0.28));
  }
  rocks.instanceMatrix.needsUpdate = true;
  rocks.instanceColor.needsUpdate = true;
  rocks.computeBoundingSphere();
  group.add(rocks);

  const LOG_COUNT = 9;
  const logGeo = new THREE.CylinderGeometry(0.24, 0.34, 3.6, 7, 1, false);
  const logs = new THREE.InstancedMesh(logGeo, barkMat, LOG_COUNT);
  logs.castShadow = true;
  for (let i = 0; i < LOG_COUNT; i++) {
    const size = 0.72 + rng() * 0.48;
    let x = -36;
    let z = -40;
    for (let attempt = 0; attempt < 16; attempt++) {
      let candidateX = -46 + rng() * 92;
      const candidateZ = -58 + rng() * 66;
      if (Math.abs(candidateX) < 12 && candidateZ > -32) candidateX += candidateX < 0 ? -14 : 14;
      x = candidateX;
      z = candidateZ;
      if (isGroundPropClear(x, z, size * 2.3)) break;
    }
    propFootprints.push({ x, z, radius: size * 2.3 });
    dummy.position.set(x, GROUND_Y + 0.28 * size, z);
    dummy.rotation.set(Math.PI / 2 + (rng() - 0.5) * 0.18, rng() * Math.PI, (rng() - 0.5) * 0.22);
    dummy.scale.set(size, size, size);
    dummy.updateMatrix();
    logs.setMatrixAt(i, dummy.matrix);
  }
  logs.instanceMatrix.needsUpdate = true;
  logs.computeBoundingSphere();
  group.add(logs);

  // ─── Drifting mist band ───────────────────────────────────────────────
  const mistMat = new THREE.SpriteMaterial({
    map: makeMistTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.18,
    fog: false,
  });
  const mistSprites = [];
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Sprite(mistMat);
    s.position.set((i - 2) * 150, GROUND_Y + 5.5, -150 - i * 28);
    s.scale.set(320, 34, 1);
    group.add(s);
    mistSprites.push({ sprite: s, baseX: s.position.x, speed: 1.4 + i * 0.35 });
  }

  // ─── Light shafts through the canopy ──────────────────────────────────
  // Additive cards standing between the near-belt trees. They only exist at
  // low sun: overhead light has no direction to read, and night belongs to
  // the fire. The lean follows the live light position in update().
  const shaftMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, ShaftShader.uniforms]),
    vertexShader: ShaftShader.vertexShader,
    fragmentShader: ShaftShader.fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: true,
  });
  const shaftGeo = new THREE.PlaneGeometry(1, 1);
  const SHAFT_SPOTS = [
    { x: -30, z: -42, w: 8, h: 52 },
    { x: 24, z: -55, w: 10, h: 62 },
    { x: 42, z: -30, w: 9, h: 56 },
  ];
  const shafts = [];
  for (const s of SHAFT_SPOTS) {
    const mesh = new THREE.Mesh(shaftGeo, shaftMat);
    mesh.position.set(s.x, GROUND_Y + s.h * 0.42, s.z);
    mesh.scale.set(s.w, s.h, 1);
    group.add(mesh);
    shafts.push({ mesh, phase: rng() * Math.PI * 2 });
  }
  const lightPos = new THREE.Vector3(0.3, 0.4, -0.86);

  // ─── Fireflies ────────────────────────────────────────────────────────
  // Wander and blink live in the vertex shader; the CPU only feeds uTime.
  const FIREFLY_COUNT = 36;
  const fireflyPos = new Float32Array(FIREFLY_COUNT * 3);
  const fireflyPhase = new Float32Array(FIREFLY_COUNT);
  const fireflySize = new Float32Array(FIREFLY_COUNT);
  for (let i = 0; i < FIREFLY_COUNT; i++) {
    fireflyPos[i * 3 + 0] = -34 + rng() * 64;
    fireflyPos[i * 3 + 1] = GROUND_Y + 0.6 + rng() * 5.4;
    fireflyPos[i * 3 + 2] = -34 + rng() * 50;
    fireflyPhase[i] = rng() * Math.PI * 2;
    fireflySize[i] = 0.9 + rng() * 1.2;
  }
  const fireflyGeo = new THREE.BufferGeometry();
  fireflyGeo.setAttribute("position", new THREE.BufferAttribute(fireflyPos, 3));
  fireflyGeo.setAttribute("aPhase", new THREE.BufferAttribute(fireflyPhase, 1));
  fireflyGeo.setAttribute("aSize", new THREE.BufferAttribute(fireflySize, 1));
  const fireflyMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uMotion: { value: 1 },
      uPixelRatio: { value: 1 },
    },
    vertexShader: `
      attribute float aPhase;
      attribute float aSize;
      uniform float uTime;
      uniform float uOpacity;
      uniform float uMotion;
      uniform float uPixelRatio;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.31 + aPhase) * 2.2 * uMotion;
        p.y += sin(uTime * 0.43 + aPhase * 1.7) * 0.9 * uMotion;
        p.z += cos(uTime * 0.27 + aPhase) * 2.2 * uMotion;
        float blink = 0.72 + 0.28 * sin(uTime * 0.72 + aPhase * 3.0);
        vAlpha = blink * uOpacity;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = aSize * uPixelRatio * (240.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float str = pow(1.0 - d * 2.0, 1.7);
        gl_FragColor = vec4(0.78, 1.0, 0.55, vAlpha * str);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const fireflies = new THREE.Points(fireflyGeo, fireflyMat);
  group.add(fireflies);

  // ─── Dust motes ───────────────────────────────────────────────────────
  // The shafts only read as air when something moves through them. Slow,
  // tiny, warm points sharing the shafts' low-sun window; drift lives in
  // the vertex shader like the fireflies.
  const MOTE_COUNT = 24;
  const motePos = new Float32Array(MOTE_COUNT * 3);
  const motePhase = new Float32Array(MOTE_COUNT);
  const moteSize = new Float32Array(MOTE_COUNT);
  for (let i = 0; i < MOTE_COUNT; i++) {
    motePos[i * 3 + 0] = -50 + rng() * 95;
    motePos[i * 3 + 1] = GROUND_Y + 2 + rng() * 26;
    motePos[i * 3 + 2] = -70 + rng() * 55;
    motePhase[i] = rng() * Math.PI * 2;
    moteSize[i] = 0.5 + rng() * 0.7;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  moteGeo.setAttribute("aPhase", new THREE.BufferAttribute(motePhase, 1));
  moteGeo.setAttribute("aSize", new THREE.BufferAttribute(moteSize, 1));
  const moteMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uMotion: { value: 1 },
      uColor: { value: new THREE.Color("#ffe2bb") },
      uPixelRatio: { value: 1 },
    },
    vertexShader: `
      attribute float aPhase;
      attribute float aSize;
      uniform float uTime;
      uniform float uOpacity;
      uniform float uMotion;
      uniform float uPixelRatio;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.12 + aPhase) * 1.4 * uMotion;
        p.y += sin(uTime * 0.1 + aPhase * 2.3) * 1.0 * uMotion;
        p.z += cos(uTime * 0.09 + aPhase) * 1.2 * uMotion;
        float shimmer = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * 0.8 + aPhase * 5.0), 2.0);
        vAlpha = shimmer * uOpacity;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = aSize * uPixelRatio * (240.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float str = pow(1.0 - d * 2.0, 1.7);
        gl_FragColor = vec4(uColor, vAlpha * str);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  group.add(motes);

  // ─── Campfire: small, low, pushed into the left-lower third ───────────
  // Set back on -Z and off-centre on -X so it clears both the centre HUD
  // column and the bottom control bar.
  const fireGroup = new THREE.Group();
  fireGroup.name = "forest-campfire";
  fireGroup.position.set(CAMPFIRE_X, GROUND_Y, CAMPFIRE_Z);
  group.add(fireGroup);

  const stoneMat = new THREE.MeshStandardMaterial({
    color: 0x4c4a47,
    roughness: 0.96,
    flatShading: true,
  });
  const stoneGeo = new THREE.DodecahedronGeometry(1, 0);
  const stones = new THREE.InstancedMesh(stoneGeo, stoneMat, 7);
  stones.castShadow = true;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    dummy.position.set(Math.cos(a) * 1.5, 0.18, Math.sin(a) * 1.5);
    dummy.rotation.set(rng() * 0.7, a, rng() * 0.7);
    const s = 0.4 + rng() * 0.16;
    dummy.scale.set(s, s * 0.7, s);
    dummy.updateMatrix();
    stones.setMatrixAt(i, dummy.matrix);
  }
  stones.instanceMatrix.needsUpdate = true;
  fireGroup.add(stones);

  const coalMat = new THREE.MeshBasicMaterial({
    color: 0x130d0a,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
  });
  const coalBed = new THREE.Mesh(new THREE.CircleGeometry(1.45, 18), coalMat);
  coalBed.rotation.x = -Math.PI / 2;
  coalBed.position.y = 0.035;
  fireGroup.add(coalBed);

  const campLogGeo = new THREE.CylinderGeometry(0.22, 0.3, 3.2, 7, 1, false);
  const campLogs = new THREE.InstancedMesh(campLogGeo, barkMat, 3);
  campLogs.castShadow = true;
  for (let i = 0; i < 3; i++) {
    dummy.position.set(0, 0.38 + i * 0.07, 0);
    dummy.rotation.set(Math.PI / 2, i * (Math.PI / 3) + 0.2, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    campLogs.setMatrixAt(i, dummy.matrix);
  }
  campLogs.instanceMatrix.needsUpdate = true;
  fireGroup.add(campLogs);

  const fireLight = new THREE.PointLight(0xff8a3d, 2.4, 34, 1.9);
  fireLight.position.set(0, 1.2, 0);
  fireGroup.add(fireLight);

  const flameMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(FlameShader.uniforms),
    vertexShader: FlameShader.vertexShader,
    fragmentShader: FlameShader.fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const flamePlanes = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.45, 3.6), flameMat, 2);
  for (let i = 0; i < 2; i++) {
    dummy.position.set(0, 1.65, 0);
    dummy.rotation.set(0, i * Math.PI * 0.5 + Math.PI * 0.25, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    flamePlanes.setMatrixAt(i, dummy.matrix);
  }
  flamePlanes.instanceMatrix.needsUpdate = true;
  flamePlanes.renderOrder = 2;
  fireGroup.add(flamePlanes);

  // Core glow
  const coreMat = new THREE.SpriteMaterial({
    map: makeEmberTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    opacity: 0.9,
    fog: false,
  });
  const core = new THREE.Sprite(coreMat);
  core.position.set(0, 0.72, 0);
  core.scale.set(2.45, 2.45, 1);
  fireGroup.add(core);

  // Embers: soft round sprites, few and small.
  const emberMat = new THREE.SpriteMaterial({
    map: makeEmberTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    opacity: 0.75,
    fog: false,
  });
  const EMBER_COUNT = 16;
  const embers = [];
  for (let i = 0; i < EMBER_COUNT; i++) {
    const s = new THREE.Sprite(emberMat);
    const size = 0.16 + rng() * 0.2;
    s.scale.set(size, size, 1);
    fireGroup.add(s);
    embers.push({
      sprite: s,
      x: (rng() - 0.5) * 1.1,
      z: (rng() - 0.5) * 1.1,
      y: rng() * 6,
      life: 3.5 + rng() * 3,
      drift: (rng() - 0.5) * 0.35,
      size,
    });
  }

  // ─── Smoke: a thin column leaning with the wind ───────────────────────
  // Per-sprite materials because each wisp needs its own opacity as it
  // rises, expands and dissolves.
  const smokeTex = makeMistTexture();
  const smokeWisps = [];
  for (let i = 0; i < 6; i++) {
    const mat = new THREE.SpriteMaterial({
      map: smokeTex,
      transparent: true,
      depthWrite: false,
      opacity: 0,
      fog: false,
      rotation: rng() * Math.PI,
    });
    const sprite = new THREE.Sprite(mat);
    fireGroup.add(sprite);
    smokeWisps.push({
      sprite,
      mat,
      y: rng() * 10,
      speed: 0.5 + rng() * 0.3,
      drift: 0.3 + rng() * 0.3,
      phase: rng() * Math.PI * 2,
    });
  }

  // ─── Grade plumbing ───────────────────────────────────────────────────
  const scratch = new THREE.Color();
  const dayFoliage = new THREE.Color("#4f7857");
  const goldenFoliage = new THREE.Color("#315a3b");
  const nightFoliage = new THREE.Color("#2c4240");
  // The albedo map multiplies these values, so the ground grade deliberately
  // stays light enough for needle/moss detail to survive at noon.
  const dayGround = new THREE.Color("#bec6a4");
  const goldenGround = new THREE.Color("#78845c");
  const nightGround = new THREE.Color("#596860");
  const dayUnderstory = new THREE.Color("#567a4f");
  const goldenUnderstory = new THREE.Color("#315b3c");
  const nightUnderstory = new THREE.Color("#293f38");
  const dayBark = new THREE.Color("#574235");
  const goldenBark = new THREE.Color("#493329");
  const nightBark = new THREE.Color("#343438");
  const dayPath = new THREE.Color("#a08e69");
  const goldenPath = new THREE.Color("#786643");
  const nightPath = new THREE.Color("#454d48");
  const dayRock = new THREE.Color("#5f655b");
  const goldenRock = new THREE.Color("#4f5447");
  const nightRock = new THREE.Color("#4b5256");
  let motionTime = 0;
  let shaftsMaster = 1;

  function applyGrade(atmosphere) {
    if (!atmosphere) return;
    const g = atmosphere.current;
    const day = atmosphere.daylight;
    const night = 1 - day;
    const elevation = atmosphere.elevation;
    // `daylight` starts falling below twelve degrees so night details can
    // arrive gradually. It must not, however, drive material emissive while
    // the sun is still above the trees: at 18:30 that stacked a moonlit
    // emissive fill on top of a 2x warm key and turned every green surface
    // chalk-white. `darkness` is tied to civil twilight instead, while this
    // golden window supplies a deliberately deeper, chromatic albedo under
    // the strong low sun.
    const darkness = 1 - sstep(-6, 1.5, elevation);
    const golden = sstep(-4, 1, elevation) * (1 - sstep(14, 24, elevation));

    for (const belt of belts) {
      scratch.copy(nightFoliage).lerp(dayFoliage, day);
      scratch.lerp(goldenFoliage, golden * 0.78);
      scratch.lerp(g.key, 0.025 * day * (1 - golden * 0.7));
      scratch.lerp(g.ambientSky, 0.045 + darkness * 0.07);
      scratch.lerp(g.fog, belt.cfg.fogMix * (0.5 + darkness * 0.2) * (1 - golden * 0.24));
      belt.foliageMat.color.copy(scratch);
      belt.foliageMat.emissive
        .copy(nightFoliage)
        .lerp(g.ambientSky, 0.42 + belt.cfg.fogMix * 0.16)
        .multiplyScalar(darkness * (0.57 - belt.cfg.fogMix * 0.14));

      scratch.copy(nightBark).lerp(dayBark, day).lerp(goldenBark, golden * 0.7);
      scratch.lerp(g.key, 0.02 * day * (1 - golden * 0.72));
      scratch.lerp(g.fog, belt.cfg.fogMix * (0.52 + darkness * 0.2) * (1 - golden * 0.2));
      belt.trunkMat.color.copy(scratch);
      belt.trunkMat.emissive
        .copy(g.ambientGround)
        .lerp(g.ambientSky, 0.3)
        .multiplyScalar(darkness * 0.35);
    }

    scratch.copy(nightGround).lerp(dayGround, day);
    scratch.lerp(goldenGround, golden * 0.82);
    scratch.lerp(g.ambientGround, 0.1);
    scratch.lerp(g.key, 0.018 * day * (1 - golden * 0.75));
    scratch.lerp(g.ambientSky, 0.12 * darkness);
    groundMat.color.copy(scratch);
    groundMat.emissive
      .copy(nightGround)
      .lerp(g.ambientSky, 0.56)
      .lerp(g.fog, 0.1)
      .multiplyScalar(0.045 * day + darkness * 0.61);

    scratch.copy(nightPath).lerp(dayPath, day).lerp(goldenPath, golden * 0.76);
    scratch.lerp(g.key, day * 0.018 * (1 - golden * 0.7));
    pathMat.color.copy(scratch);
    pathMat.emissive.copy(nightPath).lerp(g.ambientSky, 0.5).multiplyScalar(darkness * 0.28);

    scratch.copy(nightUnderstory).lerp(dayUnderstory, day).lerp(goldenUnderstory, golden * 0.8);
    scratch.lerp(g.key, day * 0.02 * (1 - golden * 0.72));
    scratch.lerp(g.ambientSky, 0.045 + darkness * 0.065);
    shrubMat.color.copy(scratch);
    fernMat.color.copy(scratch).multiplyScalar(1.04);
    shrubMat.emissive.copy(nightUnderstory).lerp(g.ambientSky, 0.48).multiplyScalar(darkness * 0.48);
    fernMat.emissive.copy(nightUnderstory).lerp(g.ambientSky, 0.54).multiplyScalar(darkness * 0.5);

    scratch.copy(nightRock).lerp(dayRock, day).lerp(goldenRock, golden * 0.66);
    scratch.lerp(g.ambientGround, 0.11);
    rockMat.color.copy(scratch);
    rockMat.emissive.copy(nightRock).lerp(g.ambientSky, 0.5).multiplyScalar(darkness * 0.25);
    scratch.copy(nightBark).lerp(dayBark, day).lerp(goldenBark, golden * 0.7).lerp(g.ambientGround, 0.08);
    barkMat.color.copy(scratch);
    barkMat.emissive.copy(g.ambientGround).multiplyScalar(darkness * 0.05);

    // The distant range keeps cool atmospheric perspective while its vertex
    // colors preserve the rock/snow boundary. A small night emissive lift lets
    // the silhouette survive moonlight without turning the snow luminous.
    scratch.set(0xdfe5e6).lerp(g.fog, 0.2 + darkness * 0.32).lerp(g.key, golden * 0.05);
    mountainMat.color.copy(scratch);
    mountainMat.emissive.copy(g.ambientSky).multiplyScalar(darkness * 0.1);
    mountainSnowBounce.value
      .copy(g.ambientSky)
      .lerp(g.key, 0.65)
      .multiplyScalar(0.08 + day * 0.22);

    scratch.copy(g.fog).lerp(g.ambientSky, 0.22);
    mistMat.color.copy(scratch);
    mistMat.opacity = 0.07 + darkness * 0.11;

    scratch.copy(nightRock).lerp(dayRock, day).lerp(goldenRock, golden * 0.55).lerp(g.ambientSky, 0.08).lerp(g.fog, 0.1);
    stoneMat.color.copy(scratch);

    // The fire is the one warm accent; it strengthens as the day drains.
    fireLight.intensity = 0.65 + night * 3.35;
    flameMat.uniforms.uStrength.value = 0.58 + night * 0.42;
    coreMat.opacity = 0.2 + night * 0.58;
    emberMat.opacity = 0.24 + night * 0.54;

    // Shafts take the key color; fireflies and smoke belong to the night
    // and the fire respectively. Motes share the shafts' light.
    shaftMat.uniforms.uColor.value.copy(g.key);
    moteMat.uniforms.uColor.value.copy(g.key);
    fireflyMat.uniforms.uOpacity.value = darkness * 0.68;
    scratch.copy(g.fog).lerp(g.ambientSky, 0.4);
    for (const w of smokeWisps) w.mat.color.copy(scratch);
  }

  function updateCelestial(_c, atmosphere) {
    applyGrade(atmosphere);
  }

  function update(delta, elapsed, atmosphere) {
    applyGrade(atmosphere);

    const reducedMotion = prefersReducedMotion();
    if (!reducedMotion) motionTime += delta;

    // Fire breathing
    const flicker = reducedMotion
      ? 1
      : 1 + Math.sin(motionTime * 7.3) * 0.06 + Math.sin(motionTime * 3.1) * 0.04;
    core.scale.set(2.45 * flicker, 2.45 * flicker, 1);
    fireLight.intensity *= flicker;
    flameMat.uniforms.uTime.value = motionTime;

    for (const e of embers) {
      e.y += (0.9 + e.size * 2) * (reducedMotion ? 0 : delta);
      e.x += e.drift * (reducedMotion ? 0 : delta);
      if (e.y > e.life) {
        e.y = 0;
        e.x = (Math.random() - 0.5) * 1.1;
        e.z = (Math.random() - 0.5) * 1.1;
      }
      const fade = Math.max(0, 1 - e.y / e.life);
      e.sprite.position.set(e.x, 0.7 + e.y, e.z);
      const s = e.size * (0.5 + fade * 0.8);
      e.sprite.scale.set(s, s, 1);
    }

    // Mist drift
    for (const m of mistSprites) {
      m.sprite.position.x += m.speed * (reducedMotion ? 0 : delta);
      if (m.sprite.position.x > 420) m.sprite.position.x = -420;
    }

    // Shafts: only a low sun throws them, leaning with the light. The sway
    // is the one motion here large enough to need a reduced-motion gate.
    // Motes share the same window — they are what the shafts reveal.
    if (atmosphere) {
      const e = atmosphere.elevation;
      const window_ = sstep(-4, 2, e) * (1 - sstep(12, 24, e));
      // The restrained local canopy accents complement the broad post shaft;
      // the shared display setting gates both paths together.
      shaftMat.uniforms.uOpacity.value = window_ * 0.05 * atmosphere.daylight * shaftsMaster;
      moteMat.uniforms.uOpacity.value = window_ * 0.32 * atmosphere.daylight * shaftsMaster;
      const lean = -Math.max(-1, Math.min(1, lightPos.x / 300)) * 0.45;
      for (const s of shafts) {
        const sway = reducedMotion ? 0 : Math.sin(motionTime * 0.25 + s.phase) * 0.015;
        s.mesh.rotation.z = lean + sway;
      }
    }

    // Reduced motion freezes both wandering and blinking; no decorative
    // particle motion remains behind the focus timer.
    fireflyMat.uniforms.uTime.value = motionTime;
    fireflyMat.uniforms.uMotion.value = reducedMotion ? 0 : 1;
    moteMat.uniforms.uTime.value = motionTime;
    moteMat.uniforms.uMotion.value = reducedMotion ? 0 : 1;

    // Smoke rise: expand, drift and dissolve, then loop.
    for (const w of smokeWisps) {
      w.y += w.speed * (reducedMotion ? 0 : 1) * delta;
      if (w.y > 10) {
        w.y = 0;
        w.phase = Math.random() * Math.PI * 2;
      }
      const life = w.y / 10;
      const s = 1.6 + w.y * 0.5;
      w.sprite.position.set(
        Math.sin(w.phase + w.y * 0.4) * w.drift * w.y * 0.3,
        1.6 + w.y,
        Math.cos(w.phase) * 0.4
      );
      w.sprite.scale.set(s, s * 1.4, 1);
      w.mat.opacity = 0.14 * Math.sin(Math.PI * Math.min(life, 1));
      w.mat.rotation += (reducedMotion ? 0 : delta) * 0.05;
    }
  }

  return {
    group,
    updateCelestial,
    update,
    /** scenes.js feeds the live sun/moon position so shafts lean correctly. */
    setLightDirection(pos) {
      lightPos.copy(pos);
    },
    setShaftsEnabled(enabled) {
      shaftsMaster = enabled ? 1 : 0;
    },
    setPixelRatio(ratio) {
      fireflyMat.uniforms.uPixelRatio.value = ratio;
      moteMat.uniforms.uPixelRatio.value = ratio;
    },
    setViewportAspect(aspect) {
      const safeAspect = Math.max(0.35, Math.min(3, aspect));
      const mobileBlend = 1 - sstep(0.8, 1.0, safeAspect);
      // Portrait's time panel owns the lower-left while the bottom dock and
      // recovery panel occupy the centre. Move the camp toward the open lower-right
      // clearing and slightly back only on narrow screens.
      fireGroup.position.x = THREE.MathUtils.lerp(-13.5, 7, mobileBlend);
      fireGroup.position.z = THREE.MathUtils.lerp(-6, -20, mobileBlend);
      fireGroup.scale.setScalar(1);
    },
  };
}
