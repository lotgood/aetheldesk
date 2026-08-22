import * as THREE from "three";

// ─── Shared atmosphere grade ─────────────────────────────────────────────
// One filmic palette drives the sky dome, the fog, the light rig and every
// scene, so a scene never invents its own colors. Stops are desaturated and
// value-separated on purpose: saturated primaries were what made the old
// scenes read as poster paint. Night keeps real luminance (moonlit indigo)
// instead of collapsing to black.
//
// Each stop is keyed by solar elevation in degrees.

const STOPS = [
  {
    elev: -90, // deep night
    skyTop: "#070b18",
    skyHorizon: "#141d33",
    skyBottom: "#05070f",
    sun: "#8fa6d8",
    sunIntensity: 0.0,
    fog: "#0d1424",
    fogDensity: 0.0042,
    key: "#93a9d6",
    keyIntensity: 0.75,
    ambientSky: "#2b3552",
    ambientGround: "#0a0e18",
    // Measured night frames sat at a mean of 16/255 — technically moonlit,
    // practically a black screen. The floor comes up so silhouettes read.
    ambientIntensity: 0.62,
    exposure: 1.06,
  },
  {
    elev: -12, // nautical twilight
    skyTop: "#101a33",
    skyHorizon: "#3a3358",
    skyBottom: "#0a0f1e",
    sun: "#c98a86",
    // Zero by nautical twilight: any residual sun intensity here paints a
    // halo on the dome at the sun's clamped horizon position, which reads
    // as a sunrise glow sitting there all night long.
    sunIntensity: 0.0,
    fog: "#22243f",
    fogDensity: 0.0038,
    key: "#a9a2c8",
    keyIntensity: 0.7,
    ambientSky: "#4a4a72",
    ambientGround: "#12141f",
    ambientIntensity: 0.5,
    exposure: 1.05,
  },
  {
    elev: -4, // civil twilight / blue hour
    skyTop: "#1d2b4d",
    skyHorizon: "#8a6a72",
    skyBottom: "#141a2c",
    sun: "#e0917a",
    sunIntensity: 0.42,
    fog: "#4a4358",
    fogDensity: 0.0034,
    key: "#d69a86",
    keyIntensity: 1.05,
    ambientSky: "#6d7a9c",
    ambientGround: "#1b1c28",
    ambientIntensity: 0.58,
    exposure: 1.04,
  },
  {
    elev: 2, // golden hour
    skyTop: "#3f5f8c",
    skyHorizon: "#d99a6c",
    skyBottom: "#2a3550",
    sun: "#ffbb7a",
    sunIntensity: 0.9,
    // Fog is aerial perspective, not a white-out. At these scene depths a
    // near-white fog at 0.003 density converges the whole frame onto one
    // bright value and the image loses its dark end entirely.
    fog: "#6b5f5e",
    fogDensity: 0.0014,
    key: "#ffb277",
    keyIntensity: 1.7,
    ambientSky: "#93a3c0",
    ambientGround: "#3a3a42",
    ambientIntensity: 0.66,
    exposure: 1.02,
  },
  {
    elev: 12, // warm morning / late afternoon
    skyTop: "#355e91",
    skyHorizon: "#8e7a66",
    skyBottom: "#3a5273",
    sun: "#ffdcae",
    sunIntensity: 1.0,
    fog: "#74808f",
    fogDensity: 0.0012,
    key: "#ffe2bb",
    keyIntensity: 2.0,
    ambientSky: "#a9c0dc",
    ambientGround: "#55555c",
    ambientIntensity: 0.72,
    exposure: 1.0,
  },
  {
    elev: 45, // midday
    // A sky with no geometry in it carries the frame on its own gradient, so
    // the zenith has to sit well under the horizon or the whole dome reads
    // as one flat bright field.
    skyTop: "#2f5d8c",
    // The camera sits on the horizon line, so this stop covers most of the
    // frame — it was the brightest value in the palette, which is why every
    // daylight frame measured as a flat bright field.
    skyHorizon: "#6c8299",
    skyBottom: "#3d6187",
    sun: "#fff4e0",
    sunIntensity: 1.0,
    fog: "#7d8b9b",
    fogDensity: 0.0011,
    key: "#fff3df",
    keyIntensity: 2.15,
    ambientSky: "#bcd2e8",
    ambientGround: "#5f6067",
    ambientIntensity: 0.78,
    exposure: 0.98,
  },
];

const COLOR_KEYS = ["skyTop", "skyHorizon", "skyBottom", "sun", "fog", "key", "ambientSky", "ambientGround"];
const SCALAR_KEYS = ["sunIntensity", "fogDensity", "keyIntensity", "ambientIntensity", "exposure"];

function blankGrade() {
  const grade = {};
  for (const k of COLOR_KEYS) grade[k] = new THREE.Color("#000000");
  for (const k of SCALAR_KEYS) grade[k] = 0;
  return grade;
}

const scratchA = new THREE.Color();
const scratchB = new THREE.Color();

/**
 * Resolve the graded atmosphere for a solar elevation, writing into `out`
 * so the render loop never allocates.
 */
export function gradeForElevation(elev, out) {
  const grade = out || blankGrade();
  let lo = STOPS[0];
  let hi = STOPS[STOPS.length - 1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (elev >= STOPS[i].elev && elev <= STOPS[i + 1].elev) {
      lo = STOPS[i];
      hi = STOPS[i + 1];
      break;
    }
  }
  if (elev <= STOPS[0].elev) hi = lo;
  if (elev >= STOPS[STOPS.length - 1].elev) lo = hi;

  const span = hi.elev - lo.elev;
  const t = span > 0 ? Math.min(1, Math.max(0, (elev - lo.elev) / span)) : 0;
  // Smoothstep so dawn/dusk transitions ease rather than ramp linearly.
  const s = t * t * (3 - 2 * t);

  for (const k of COLOR_KEYS) {
    scratchA.set(lo[k]);
    scratchB.set(hi[k]);
    grade[k].copy(scratchA).lerp(scratchB, s);
  }
  for (const k of SCALAR_KEYS) {
    grade[k] = lo[k] + (hi[k] - lo[k]) * s;
  }
  return grade;
}

/**
 * Live atmosphere: holds the graded target plus the eased current value.
 * Consumers read `current` every frame; nothing else recomputes the grade.
 */
export function createAtmosphere({ smoothing = 1.5 } = {}) {
  const target = gradeForElevation(-90);
  const current = gradeForElevation(-90);
  let elevation = -90;

  function setElevation(elev) {
    if (typeof elev !== "number" || Number.isNaN(elev)) return;
    elevation = elev;
    gradeForElevation(elev, target);
  }

  function update(delta) {
    // Tab-switch guard: a huge delta snaps instead of easing through a blur.
    const f = delta > 0.5 ? 1 : 1 - Math.exp(-smoothing * delta);
    for (const k of COLOR_KEYS) current[k].lerp(target[k], f);
    for (const k of SCALAR_KEYS) current[k] += (target[k] - current[k]) * f;
  }

  return {
    current,
    target,
    setElevation,
    update,
    get elevation() {
      return elevation;
    },
    /** True once the sun is below the horizon; scenes use it for lamps/fire. */
    get isNight() {
      return elevation <= 0;
    },
    /** 0 at night, 1 in full day — scenes fade night details with this. */
    get daylight() {
      return Math.min(1, Math.max(0, (elevation + 6) / 18));
    },
  };
}
