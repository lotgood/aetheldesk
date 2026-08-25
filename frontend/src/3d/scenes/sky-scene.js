import * as THREE from "three";
import { prefersReducedMotion } from "../motion.js";

// ─── Sky: a sea of cloud seen from altitude ──────────────────────────────
// Art direction: no props, no primaries. Three parallax bands of soft cloud
// resting below the eye line, a clean horizon, and a single quiet stratum
// drifting through the lower third. Every color is pulled from the shared
// atmosphere grade so the scene is warm at golden hour and silver at night
// without ever inventing a hue of its own.
//
// The cloud field is three instanced strata. Each atlas tile stores density
// plus a pseudo-normal baked once on the CPU, allowing the GPU to reproduce
// self-shadow, Beer-Lambert depth and a directional silver lining without a
// raymarch or the rectangular sprite cards that used to wash out the frame.

const CLOUD_TEX_SIZE = 256;
// Four 128×64 tiles form one 512×64 power-of-two atlas. At the largest
// authored cloud size this is still close to one source texel per display
// pixel, while doing about one seventh of the old synchronous CPU work.
const CLOUD_TILE_WIDTH = 128;
const CLOUD_TILE_HEIGHT = 64;
const CLOUD_TILE_COUNT = 4;
const CLOUD_TILE_PADDING = 4;
// Four shallow planes share each instance. This keeps the authored budget at
// twelve cloud instances and three draw calls, but gives every formation a
// real 14-32 world-unit volume for camera parallax and internal extinction.
const CLOUD_SHELL_SLICES = 4;

// Four deliberately different weather silhouettes. Keeping these authored
// profiles separate matters more than adding more sprites: random circles
// converge on the same marshmallow outline, while a shelf, a tower, a broken
// bank and a wind-sheared roll stay recognisably different at 128x64.
const CLOUD_PROFILES = Object.freeze([
  Object.freeze({
    baseY: 0.135,
    baseCenter: 0.245,
    baseWidth: 0.88,
    baseHeight: 0.13,
    shear: 0.3,
    cells: Object.freeze([
      [-0.68, 0.28, 0.29, 0.15],
      [-0.43, 0.39, 0.27, 0.24],
      [-0.18, 0.64, 0.2, 0.38],
      [0.06, 0.46, 0.28, 0.26],
      [0.39, 0.35, 0.34, 0.19],
      [0.72, 0.27, 0.2, 0.12],
    ]),
    cuts: Object.freeze([
      [-0.48, 0.59, 0.18, 0.2, 0.3],
      [0.42, 0.54, 0.23, 0.19, 0.34],
    ]),
  }),
  Object.freeze({
    baseY: 0.12,
    baseCenter: 0.225,
    baseWidth: 0.9,
    baseHeight: 0.115,
    shear: 0.43,
    cells: Object.freeze([
      [-0.72, 0.25, 0.27, 0.12],
      [-0.48, 0.36, 0.3, 0.22],
      [-0.3, 0.66, 0.19, 0.43],
      [-0.02, 0.5, 0.25, 0.26],
      [0.29, 0.38, 0.34, 0.2],
      [0.65, 0.28, 0.28, 0.13],
    ]),
    cuts: Object.freeze([
      [-0.04, 0.72, 0.16, 0.2, 0.33],
      [0.5, 0.48, 0.21, 0.16, 0.26],
    ]),
  }),
  Object.freeze({
    baseY: 0.145,
    baseCenter: 0.235,
    baseWidth: 0.84,
    baseHeight: 0.12,
    shear: -0.29,
    cells: Object.freeze([
      [-0.7, 0.29, 0.25, 0.14],
      [-0.48, 0.51, 0.23, 0.32],
      [-0.1, 0.34, 0.32, 0.17],
      [0.25, 0.59, 0.24, 0.36],
      [0.53, 0.4, 0.3, 0.21],
      [0.75, 0.28, 0.18, 0.11],
    ]),
    cuts: Object.freeze([
      [-0.1, 0.56, 0.21, 0.2, 0.43],
      [0.56, 0.67, 0.18, 0.17, 0.3],
    ]),
  }),
  Object.freeze({
    baseY: 0.115,
    baseCenter: 0.215,
    baseWidth: 0.91,
    baseHeight: 0.105,
    shear: 0.55,
    cells: Object.freeze([
      [-0.76, 0.24, 0.25, 0.11],
      [-0.51, 0.35, 0.32, 0.2],
      [-0.17, 0.48, 0.3, 0.27],
      [0.18, 0.39, 0.36, 0.2],
      [0.51, 0.31, 0.31, 0.15],
      [0.78, 0.23, 0.17, 0.09],
    ]),
    cuts: Object.freeze([
      [-0.3, 0.58, 0.19, 0.17, 0.28],
      [0.29, 0.51, 0.24, 0.16, 0.38],
    ]),
  }),
]);

// The atlas profile establishes silhouette; these restrained transforms make
// the same four variants occupy space differently as well. In particular the
// low roll is wide and wind-sheared while the tower is narrow, tall and deep.
const CLOUD_VARIANT_STYLE = Object.freeze([
  Object.freeze({ aspect: 1.08, height: 0.92, tilt: -0.012, sliceShear: 0.045, depth: 0.82 }),
  Object.freeze({ aspect: 0.88, height: 1.16, tilt: 0.018, sliceShear: -0.07, depth: 1.08 }),
  Object.freeze({ aspect: 1.02, height: 1.02, tilt: -0.024, sliceShear: 0.075, depth: 0.94 }),
  Object.freeze({ aspect: 1.18, height: 0.82, tilt: 0.012, sliceShear: -0.055, depth: 0.76 }),
]);

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

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

function hashGrid(x, y, seed) {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x, y, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hashGrid(ix, iy, seed);
  const b = hashGrid(ix + 1, iy, seed);
  const c = hashGrid(ix, iy + 1, seed);
  const d = hashGrid(ix + 1, iy + 1, seed);
  const top = a + (b - a) * ux;
  const bottom = c + (d - c) * ux;
  return top + (bottom - top) * uy;
}

function fbm(x, y, seed, octaves) {
  let sum = 0;
  let amplitude = 0.5;
  let norm = 0;
  for (let octave = 0; octave < octaves; octave++) {
    sum += valueNoise(x, y, seed + octave * 1013) * amplitude;
    norm += amplitude;
    x = x * 2.03 + 7.1;
    y = y * 2.01 - 5.7;
    amplitude *= 0.5;
  }
  return sum / norm;
}

function ellipseField(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return 1 - Math.sqrt(dx * dx + dy * dy);
}

function buildCloudDensity(width, height, variant, seed) {
  const profile = CLOUD_PROFILES[variant % CLOUD_PROFILES.length];
  const density = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    const py = 1 - y / (height - 1);
    for (let x = 0; x < width; x++) {
      const px = (x / (width - 1)) * 2 - 1;
      // Upper levels travel farther with the wind. A low-frequency vertical
      // warp prevents even the authored ellipses from preserving a circular
      // contour after union, especially around the tower and broken bank.
      const shearedX = px - (py - profile.baseY) * profile.shear;
      const contourWarp =
        (valueNoise(px * 2.2 + 13.7, variant * 2.9 + 4.3, seed ^ 0x39d1) - 0.5) *
        0.075 *
        sstep(profile.baseY + 0.015, 0.7, py);
      const warpedY = py + contourWarp;
      let shape = ellipseField(
        shearedX,
        warpedY,
        0,
        profile.baseCenter,
        profile.baseWidth,
        profile.baseHeight,
      );

      for (const cell of profile.cells) {
        shape = Math.max(shape, ellipseField(shearedX, warpedY, cell[0], cell[1], cell[2], cell[3]));
      }

      // Concave notches stop a union of ellipses reading as one solid toy.
      // They only graze the upper contour; the shared base remains continuous.
      for (const cut of profile.cuts) {
        shape -= Math.max(0, ellipseField(shearedX, warpedY, cut[0], cut[1], cut[2], cut[3])) * cut[4];
      }

      // One slanted, narrow dry slot per weather profile fractures the upper
      // mass without punching a cartoon hole through the condensation base.
      const fractureX = -0.42 + variant * 0.27;
      const fractureSlope = (variant % 2 === 0 ? 0.22 : -0.18) + profile.shear * 0.12;
      const fractureDistance = Math.abs(
        shearedX - fractureX - (py - profile.baseY) * fractureSlope,
      );
      const fracture =
        (1 - sstep(0.018, 0.09, fractureDistance)) *
        sstep(profile.baseY + 0.055, profile.baseY + 0.24, py) *
        (1 - sstep(0.76, 0.94, py));
      shape -= fracture * (0.11 + (variant % 2) * 0.035);

      // Real fair-weather cumulus has a comparatively level condensation
      // base. One very-low-frequency wobble keeps it organic without turning
      // the underside into another chain of circles.
      const baseWobble =
        (valueNoise(shearedX * 3.1 + 11.7, variant * 3.1, seed ^ 0x91a7) - 0.5) *
        0.052;
      const flatBase = sstep(profile.baseY + baseWobble - 0.018, profile.baseY + baseWobble + 0.028, py);
      shape = Math.max(0, shape) * flatBase;

      // Macro billow, meso-scale bites and a single fine erosion octave act
      // mostly at the silhouette. This produces a weathered edge without the
      // startup cost of a larger atlas or a runtime raymarch.
      const broad = fbm(shearedX * 2.7 + 17.3, warpedY * 3.2 - 11.9, seed, 2);
      const erosion = fbm(shearedX * 8.1 - 31.0, py * 9.4 + 23.0, seed ^ 0x5a17, 2);
      const fine = valueNoise(shearedX * 19.7 + 8.3, py * 21.3 - 4.7, seed ^ 0xe31b);
      const edgeWeight = 1 - sstep(0.18, 0.58, shape);
      const field =
        shape -
        0.13 +
        (broad - 0.5) * 0.12 +
        (erosion - 0.5) * 0.27 * edgeWeight +
        (fine - 0.5) * 0.12 * edgeWeight;
      const tx = x / (width - 1);
      const edgeFade =
        sstep(0.055, 0.2, tx) *
        sstep(0.055, 0.2, 1 - tx) *
        sstep(0.02, 0.11, py) *
        sstep(0.025, 0.12, 1 - py);
      const silhouette = sstep(-0.035, 0.21, field) * sstep(0.0, 0.075, shape) * flatBase;
      // Keep alpha coverage calm while giving the pseudo-height field enough
      // internal relief for the baked normal to reveal billows and cavities.
      const opticalVariation =
        0.5 + broad * 0.33 + erosion * 0.12 + fine * 0.055 -
        Math.max(0, erosion - 0.66) * 0.18;
      density[y * width + x] = Math.min(1, Math.max(0, silhouette * opticalVariation * edgeFade));
    }
  }
  return density;
}

function makeCloudAtlas() {
  const canvas = document.createElement("canvas");
  canvas.width = CLOUD_TILE_WIDTH * CLOUD_TILE_COUNT;
  canvas.height = CLOUD_TILE_HEIGHT;
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(canvas.width, canvas.height);

  for (let variant = 0; variant < CLOUD_TILE_COUNT; variant++) {
    const field = buildCloudDensity(CLOUD_TILE_WIDTH, CLOUD_TILE_HEIGHT, variant, 0xc10d0001 + variant);
    const xOffset = variant * CLOUD_TILE_WIDTH;

    for (let y = 0; y < CLOUD_TILE_HEIGHT; y++) {
      for (let x = 0; x < CLOUD_TILE_WIDTH; x++) {
        const p = y * CLOUD_TILE_WIDTH + x;
        const center = field[p];
        const left = field[y * CLOUD_TILE_WIDTH + Math.max(0, x - 1)];
        const right = field[y * CLOUD_TILE_WIDTH + Math.min(CLOUD_TILE_WIDTH - 1, x + 1)];
        const up = field[Math.max(0, y - 1) * CLOUD_TILE_WIDTH + x];
        const down = field[Math.min(CLOUD_TILE_HEIGHT - 1, y + 1) * CLOUD_TILE_WIDTH + x];

        let nx = (left - right) * 8.2;
        let ny = (down - up) * 9.0;
        let nz = 1;
        const invLength = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
        nx *= invLength;
        ny *= invLength;
        nz *= invLength;

        const edge =
          x < CLOUD_TILE_PADDING ||
          x >= CLOUD_TILE_WIDTH - CLOUD_TILE_PADDING ||
          y < CLOUD_TILE_PADDING ||
          y >= CLOUD_TILE_HEIGHT - CLOUD_TILE_PADDING;
        // Keep the raw density in alpha. A second baked smoothstep followed
        // by the shader smoothstep made the silhouette unnaturally hard and
        // hid the small erosion scales we just paid to generate.
        const alpha = edge ? 0 : center;
        const dst = (y * canvas.width + xOffset + x) * 4;
        image.data[dst] = Math.round((nx * 0.5 + 0.5) * 255);
        image.data[dst + 1] = Math.round((ny * 0.5 + 0.5) * 255);
        image.data[dst + 2] = Math.round(center * 255);
        image.data[dst + 3] = Math.round(alpha * 255);
      }
    }
  }

  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  // RGB carries normals and optical density, not display-referred color.
  tex.colorSpace = THREE.NoColorSpace;
  // Atlas tiles must not bleed into one another through the coarsest mip
  // levels; even a 0.5% averaged alpha reads as a rectangular card at night.
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

function makeCloudShellGeometry() {
  const positions = [];
  const uvs = [];
  const slices = [];
  const indices = [];

  // Back-to-front index order gives conventional alpha blending a stable
  // volume traversal. The instance z-scale turns this normalized half-unit
  // shell into a shallow but genuine spatial formation.
  for (let slice = 0; slice < CLOUD_SHELL_SLICES; slice++) {
    const t = slice / (CLOUD_SHELL_SLICES - 1);
    const z = t - 0.5;
    const first = slice * 4;
    positions.push(-0.5, -0.5, z, 0.5, -0.5, z, 0.5, 0.5, z, -0.5, 0.5, z);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    slices.push(t, t, t, t);
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("aSlice", new THREE.Float32BufferAttribute(slices, 1));
  geometry.setIndex(indices);
  return geometry;
}

const CLOUD_VERTEX_SHADER = `
  attribute float aSlice;
  attribute float aVariant;
  attribute float aLaneFade;
  attribute float aSliceShear;
  attribute float aLayerPhase;
  varying vec2 vUv;
  varying float vSlice;
  varying float vVariant;
  varying float vLaneFade;
  varying float vLayerPhase;

  void main() {
    vUv = uv;
    vSlice = aSlice;
    vVariant = aVariant;
    vLaneFade = aLaneFade;
    vLayerPhase = aLayerPhase;

    float centeredDepth = aSlice - 0.5;
    float layerScale = 1.0 - abs(centeredDepth) * 0.11 + sin(aLayerPhase + aSlice * 5.1) * 0.018;
    vec3 shellPosition = position;
    shellPosition.xy *= vec2(layerScale, 1.0 - abs(centeredDepth) * 0.07);
    shellPosition.x += centeredDepth * aSliceShear;
    shellPosition.y += centeredDepth * (0.026 + sin(aLayerPhase) * 0.009);
    vec4 instancePosition = instanceMatrix * vec4(shellPosition, 1.0);
    gl_Position = projectionMatrix * modelViewMatrix * instancePosition;
  }
`;

const CLOUD_FRAGMENT_SHADER = `
  uniform sampler2D uCloudAtlas;
  uniform vec3 uBodyColor;
  uniform vec3 uShadowColor;
  uniform vec3 uLightColor;
  uniform vec3 uLightDirection;
  uniform float uOpacity;
  uniform float uLightStrength;
  uniform float uSilverStrength;

  varying vec2 vUv;
  varying float vSlice;
  varying float vVariant;
  varying float vLaneFade;
  varying float vLayerPhase;

  vec4 sampleCloudTile(float variant, vec2 sourceUv) {
    const float atlasTiles = ${CLOUD_TILE_COUNT.toFixed(1)};
    const float inset = ${CLOUD_TILE_PADDING.toFixed(1)} / ${CLOUD_TILE_WIDTH.toFixed(1)};
    vec2 boundedUv = clamp(sourceUv, vec2(0.0), vec2(1.0));
    vec2 tileUv = vec2(
      mix(inset, 1.0 - inset, boundedUv.x),
      mix(inset, 1.0 - inset, boundedUv.y)
    );
    return texture2D(uCloudAtlas, vec2((variant + tileUv.x) / atlasTiles, tileUv.y));
  }

  void main() {
    const float atlasTiles = ${CLOUD_TILE_COUNT.toFixed(1)};
    float centeredDepth = vSlice - 0.5;
    vec2 warpedUv = vUv;
    // Texture and geometry travel in the same apparent screen direction. The
    // opposite sign is intentional: moving the sampling window left moves the
    // sampled silhouette right, adding to (rather than cancelling) the shell's
    // spatial offset in the vertex stage.
    warpedUv.x -= centeredDepth * (0.024 + sin(vLayerPhase) * 0.012);
    warpedUv.y -= centeredDepth * 0.024;
    warpedUv.x += sin(vUv.y * 8.0 + vLayerPhase) * 0.006 * abs(centeredDepth);

    vec4 primaryField = sampleCloudTile(vVariant, warpedUv);
    float adjacentVariant = mod(vVariant + 1.0 + floor(vSlice * 2.99), atlasTiles);
    vec2 adjacentUv = vec2(
      mix(warpedUv.x, 1.0 - warpedUv.x, step(0.5, fract(vLayerPhase * 0.159))),
      clamp(warpedUv.y - centeredDepth * 0.042, 0.0, 1.0)
    );
    // A trace of an adjacent authored weather profile means the four shells
    // do not expose the exact same alpha contour when the camera sees around
    // an edge. It is compositional variation, not animated texture noise.
    vec4 field = mix(
      primaryField,
      sampleCloudTile(adjacentVariant, adjacentUv),
      0.18 + abs(centeredDepth) * 0.12
    );
    float coreAlpha = smoothstep(0.065, 0.34, field.a);
    float fringeAlpha = smoothstep(0.004, 0.12, field.a) * 0.22;
    float sliceWeight = mix(0.37, 0.43, vSlice);
    float alpha = max(coreAlpha, fringeAlpha) * uOpacity * vLaneFade * sliceWeight;
    if (alpha < 0.004) discard;

    vec2 normalXY = field.rg * 2.0 - 1.0;
    float normalZ = sqrt(max(0.06, 1.0 - dot(normalXY, normalXY)));
    vec3 cloudNormal = normalize(vec3(normalXY, normalZ));
    vec3 lightDirection = normalize(vec3(uLightDirection.xy, abs(uLightDirection.z) + 0.18));
    float direct = clamp(dot(cloudNormal, lightDirection) * 0.63 + 0.43, 0.0, 1.0);

    // Beer-Lambert extinction gives the body depth; the powder term returns
    // a little multiply-scattered light to dense regions instead of letting
    // them collapse into featureless grey.
    float density = field.b;
    float transmittance = exp(-density * (1.18 + 0.62 * uLightStrength));
    float powder = 1.0 - exp(-density * 1.9);
    float verticalLight = smoothstep(0.1, 0.82, vUv.y);
    float diffuse = clamp(0.18 + direct * 0.58 + powder * 0.08, 0.0, 1.0);
    diffuse *= mix(0.68, 1.06, verticalLight);
    diffuse *= mix(0.72, 1.0, uLightStrength);
    vec3 color = mix(uShadowColor, uBodyColor, diffuse);
    color *= mix(0.7, 1.035, transmittance);
    color = mix(color, uLightColor, direct * verticalLight * uLightStrength * 0.105);

    // Front shells receive more skylight; deeper shells retain a cool optical
    // shadow. Combined with their real z separation this is the cue that makes
    // a cloud read as a shallow volume rather than four copied cards.
    float shellTransmittance = exp(-density * mix(0.5, 0.16, vSlice));
    color = mix(uShadowColor, color, mix(0.76, 1.0, vSlice) * shellTransmittance);

    // A silver lining belongs only to the light-facing silhouette. Using the
    // full 3D normal brightened every puff equally and turned the bank into a
    // glowing grey wall; the baked XY gradient gives us the actual rim side.
    vec2 edgeNormal = normalize(normalXY + vec2(0.0001));
    vec2 lightAcrossCloud = normalize(lightDirection.xy + vec2(0.0001));
    float edge = (1.0 - smoothstep(0.16, 0.64, density)) * smoothstep(0.02, 0.22, field.a);
    float facing = pow(max(0.0, dot(edgeNormal, lightAcrossCloud)), 2.0);
    float silver = facing * edge * mix(0.58, 1.0, verticalLight) * uSilverStrength;
    color += uLightColor * silver * 0.46;

    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
  }
`;

function makeCloudMaterial(atlas) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uCloudAtlas: { value: atlas },
      uBodyColor: { value: new THREE.Color("#d8dce6") },
      uShadowColor: { value: new THREE.Color("#50596e") },
      uLightColor: { value: new THREE.Color("#fff1d6") },
      uLightDirection: { value: new THREE.Vector3(0.3, 0.4, 0.86).normalize() },
      uOpacity: { value: 0.8 },
      uLightStrength: { value: 1.0 },
      uSilverStrength: { value: 0.25 },
    },
    vertexShader: CLOUD_VERTEX_SHADER,
    fragmentShader: CLOUD_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    toneMapped: false,
  });
}

// Cirrus are several wind-sheared ice filaments, not a stretched radial blob.
function makeStreakTexture() {
  const w = 512;
  const h = 128;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const rng = makeRng(0xc1a255);
  const gradient = ctx.createLinearGradient(0, 0, w, 0);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.16, "rgba(255,255,255,0.5)");
  gradient.addColorStop(0.62, "rgba(255,255,255,0.72)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");

  for (let i = 0; i < 11; i++) {
    const y = 35 + i * 5 + (rng() - 0.5) * 15;
    const bend = (rng() - 0.5) * 36;
    ctx.strokeStyle = gradient;
    ctx.lineCap = "round";
    ctx.lineWidth = 5 + rng() * 9;
    ctx.globalAlpha = 0.1 + rng() * 0.11;
    ctx.beginPath();
    ctx.moveTo(-18, y);
    ctx.bezierCurveTo(w * 0.28, y - 14 + bend, w * 0.66, y + 18 - bend, w + 18, y - 4);
    ctx.stroke();

    ctx.lineWidth *= 0.2;
    ctx.globalAlpha *= 1.8;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function sstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
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

export function createSkyScene({ horizonHaze = true } = {}) {
  const group = new THREE.Group();
  group.name = "scene-sky";
  // Stable art direction matters more than a different random cloud wall on
  // every reload. Motion still keeps the sky alive after construction.
  const rng = makeRng(0xa37e1d5);

  const puffTex = horizonHaze ? makePuffTexture() : null;
  const cloudAtlas = makeCloudAtlas();
  const streakTex = makeStreakTexture();

  // Three depth bands. Nearer bands are larger, faster and slightly darker;
  // far bands sit closer to the fog color, which is what sells the distance.
  const BANDS = [
    // Clouds belong ABOVE the horizon. Sitting them below it put white
    // shapes against the palest part of the dome, where they had no value
    // separation left to read with — the reason they kept disappearing.
    { count: 6, z: -520, y: 140, ySpread: 58, spread: 1480, scale: 55, speed: 0.12, clear: 160, fogMix: 0.42, opacity: 0.28 },
    { count: 4, z: -330, y: 82, ySpread: 50, spread: 1100, scale: 46, speed: 0.2, clear: 135, fogMix: 0.18, opacity: 0.4 },
    { count: 2, z: -210, y: 34, ySpread: 38, spread: 860, scale: 36, speed: 0.31, clear: 112, fogMix: 0.04, opacity: 0.5 },
  ];

  const bands = [];
  const cloudDummy = new THREE.Object3D();

  for (let bandIndex = 0; bandIndex < BANDS.length; bandIndex++) {
    const cfg = BANDS[bandIndex];
    const geometry = makeCloudShellGeometry();
    const variants = new Float32Array(cfg.count);
    const laneFades = new Float32Array(cfg.count);
    const sliceShears = new Float32Array(cfg.count);
    const layerPhases = new Float32Array(cfg.count);
    geometry.setAttribute("aVariant", new THREE.InstancedBufferAttribute(variants, 1));
    geometry.setAttribute("aLaneFade", new THREE.InstancedBufferAttribute(laneFades, 1));
    geometry.setAttribute("aSliceShear", new THREE.InstancedBufferAttribute(sliceShears, 1));
    geometry.setAttribute("aLayerPhase", new THREE.InstancedBufferAttribute(layerPhases, 1));
    const material = makeCloudMaterial(cloudAtlas);
    const mesh = new THREE.InstancedMesh(geometry, material, cfg.count);
    mesh.name = `sky-cloud-band-${bandIndex}`;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // The authored ranges are bounded but instances wrap independently;
    // disabling one coarse frustum test prevents a whole stratum popping.
    mesh.frustumCulled = false;
    mesh.renderOrder = 2 + bandIndex;

    const items = [];
    for (let i = 0; i < cfg.count; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const halfSpread = cfg.spread * 0.5;
      const x = side * (cfg.clear + 70 + rng() * (halfSpread - cfg.clear - 70));
      const baseY = cfg.y + (rng() - 0.5) * cfg.ySpread;
      const z = cfg.z + (rng() - 0.5) * 50;
      const base = cfg.scale * (0.7 + rng() * 0.6);
      const phase = rng() * Math.PI * 2;
      const variant = (i * 3 + bandIndex * 2) % CLOUD_TILE_COUNT;
      const style = CLOUD_VARIANT_STYLE[variant];
      const item = {
        x,
        baseY,
        z,
        width: base * 2.64 * style.aspect,
        height: base * 1.1 * style.height,
        depth: (14 + base * 0.18) * style.depth,
        phase,
        tilt: style.tilt + (rng() - 0.5) * 0.035,
      };
      variants[i] = variant;
      laneFades[i] = sstep(cfg.clear, cfg.clear + 110, Math.abs(item.x));
      // Derive shell variance from the existing phase so adding volumetric
      // depth does not reshuffle the carefully composed cloud positions.
      sliceShears[i] =
        style.sliceShear * (0.82 + (0.5 + 0.5 * Math.sin(phase * 1.73)) * 0.36);
      layerPhases[i] = phase;
      cloudDummy.position.set(item.x, item.baseY, item.z);
      cloudDummy.rotation.set(0, 0, item.tilt);
      cloudDummy.scale.set(item.width, item.height, item.depth);
      cloudDummy.updateMatrix();
      mesh.setMatrixAt(i, cloudDummy.matrix);
      items.push(item);
    }
    mesh.instanceMatrix.needsUpdate = true;
    geometry.getAttribute("aVariant").needsUpdate = true;
    geometry.getAttribute("aLaneFade").needsUpdate = true;
    geometry.getAttribute("aSliceShear").needsUpdate = true;
    geometry.getAttribute("aLayerPhase").needsUpdate = true;
    group.add(mesh);

    bands.push({ cfg, items, mesh, material, laneFade: geometry.getAttribute("aLaneFade") });
  }

  // ─── Horizon haze band ────────────────────────────────────────────────
  // A wide, very soft strip sitting exactly on the eye line. It reads as the
  // top of the cloud sea and gives the frame a calm horizontal anchor
  // instead of an empty gradient.
  const hazeMat = horizonHaze
    ? new THREE.SpriteMaterial({
      map: puffTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.42,
      fog: false,
    })
    : null;
  if (hazeMat) {
    const haze = new THREE.Sprite(hazeMat);
    haze.position.set(0, -26, -640);
    haze.scale.set(1800, 58, 1);
    group.add(haze);
  }

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
    sprite.position.set((i - 2.5) * 320 + (rng() - 0.5) * 120, 190 + rng() * 55, -620);
    sprite.scale.set(420 + rng() * 160, 22 + rng() * 10, 1);
    group.add(sprite);
    cirrus.push({ sprite, mat, speed: 0.12 + i * 0.035 });
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
    const size = 5 + rng() * 3;
    sprite.position.set(-500 + i * 260 + rng() * 80, 64 + rng() * 50, -280 - rng() * 90);
    sprite.scale.set(size, size * 0.5, 1);
    group.add(sprite);
    birds.push({
      sprite,
      baseY: sprite.position.y,
      speed: 0.38 + rng() * 0.28,
      phase: rng() * Math.PI * 2,
      size,
    });
  }

  // ─── Working colors (preallocated; update() never allocates) ──────────
  const baseCloud = new THREE.Color("#dfe7ed");
  const nightCloud = new THREE.Color("#59657f");
  const scratch = new THREE.Color();
  const shadowScratch = new THREE.Color();
  const cirrusScratch = new THREE.Color();
  const lightPos = new THREE.Vector3(0.3, 0.4, -0.86);
  const lightDirN = new THREE.Vector3();
  let motionTime = 0;
  let wasReducedMotion = prefersReducedMotion();

  function applyGrade(atmosphere) {
    if (!atmosphere) return;
    const g = atmosphere.current;
    const day = atmosphere.daylight;
    const elev = atmosphere.elevation;

    // Lining belongs to the low visible sun. Deep night stays calm and noon
    // stays clean instead of outlining every cloud like an illustration.
    const lowSun = elev <= -6 ? 0.35 : 1 - sstep(10, 26, elev);
    const warmLining = lowSun * sstep(-5, 0, elev) * (0.18 + day * 0.46);
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
      const uniforms = band.material.uniforms;
      uniforms.uBodyColor.value.copy(scratch);
      // Cloud shadow is skylight, not neutral charcoal. Pulling it from the
      // ambient sky keeps noon blue and golden hour lavender rather than grey.
      shadowScratch
        .copy(g.ambientSky)
        .lerp(g.fog, 0.22)
        .lerp(scratch, 0.26)
        .multiplyScalar(0.55 + day * 0.2);
      uniforms.uShadowColor.value.copy(shadowScratch);
      uniforms.uLightColor.value.copy(g.key);
      uniforms.uLightDirection.value.copy(lightDirN);
      uniforms.uOpacity.value = band.cfg.opacity * g.cloudOpacity;
      uniforms.uLightStrength.value = g.cloudLight;
      uniforms.uSilverStrength.value = warmLining;
    }

    // The horizon band is an accent, not a veil: heavy opacity here was
    // what turned the whole lower frame into milk.
    scratch.copy(g.fog).lerp(g.skyHorizon, 0.78);
    if (hazeMat) {
      hazeMat.color.copy(scratch);
      hazeMat.opacity = (0.025 + day * 0.055) * g.cloudOpacity;
    }

    // Cirrus: barely there at noon, warmest when the light is low.
    cirrusScratch.copy(g.fog).lerp(g.key, 0.3 + 0.4 * lowSun).lerp(g.skyHorizon, 0.2);
    const cirrusOpacity = (0.018 + day * 0.038 + lowSun * day * 0.045) * g.cloudOpacity;
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

  function update(delta, _elapsed, atmosphere) {
    applyGrade(atmosphere);
    const reducedMotion = prefersReducedMotion();
    if (!reducedMotion) motionTime += delta;
    const motionPreferenceChanged = reducedMotion !== wasReducedMotion;

    for (const band of bands) {
      const limit = band.cfg.spread * 0.5;
      const matricesChanged = !reducedMotion || motionPreferenceChanged;
      for (let i = 0; i < band.items.length; i++) {
        const item = band.items[i];
        if (!reducedMotion) {
          item.x += band.cfg.speed * delta;
          if (item.x > limit) item.x = -limit;
        }
        if (!matricesChanged) continue;

        // Barely-there vertical breathing keeps the strata alive without
        // deforming their density field or allocating render-loop objects.
        const y = item.baseY + Math.sin(motionTime * 0.025 + item.phase) * (reducedMotion ? 0 : 0.8);
        cloudDummy.position.set(item.x, y, item.z);
        cloudDummy.rotation.set(0, 0, item.tilt);
        cloudDummy.scale.set(item.width, item.height, item.depth);
        cloudDummy.updateMatrix();
        band.mesh.setMatrixAt(i, cloudDummy.matrix);
        band.laneFade.setX(i, sstep(band.cfg.clear, band.cfg.clear + 110, Math.abs(item.x)));
      }
      if (matricesChanged) {
        band.mesh.instanceMatrix.needsUpdate = true;
        band.laneFade.needsUpdate = true;
      }
    }

    for (const c of cirrus) {
      c.sprite.position.x += c.speed * (reducedMotion ? 0 : delta);
      if (c.sprite.position.x > 1000) c.sprite.position.x = -1000;
    }

    // Reduced motion freezes both travel and wingbeat. Keeping only the flap
    // still left large silhouettes drifting across the user's focal area.
    for (const b of birds) {
      b.sprite.position.x += b.speed * (reducedMotion ? 0 : delta);
      if (b.sprite.position.x > 620) b.sprite.position.x = -620;
      b.sprite.position.y = b.baseY + Math.sin(motionTime * 0.12 + b.phase) * (reducedMotion ? 0 : 1.2);
      const flap = reducedMotion ? 1 : 0.78 + 0.22 * Math.sin(motionTime * 0.85 + b.phase);
      b.sprite.scale.set(b.size, b.size * 0.5 * flap, 1);
    }
    wasReducedMotion = reducedMotion;
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
