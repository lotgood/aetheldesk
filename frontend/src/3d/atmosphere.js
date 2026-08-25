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
    rayleighStrength: 0.08,
    mieStrength: 0.0,
    mieG: 0.72,
    twilightStrength: 0.0,
    nightStrength: 1.0,
    cloudLight: 0.34,
    cloudOpacity: 0.36,
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
    rayleighStrength: 0.16,
    mieStrength: 0.04,
    mieG: 0.74,
    twilightStrength: 0.28,
    nightStrength: 0.86,
    cloudLight: 0.38,
    cloudOpacity: 0.42,
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
    rayleighStrength: 0.46,
    mieStrength: 0.34,
    mieG: 0.78,
    twilightStrength: 0.92,
    nightStrength: 0.38,
    cloudLight: 0.54,
    cloudOpacity: 0.62,
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
    rayleighStrength: 0.78,
    mieStrength: 0.76,
    mieG: 0.82,
    twilightStrength: 1.0,
    nightStrength: 0.04,
    cloudLight: 0.86,
    cloudOpacity: 0.88,
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
    rayleighStrength: 0.94,
    mieStrength: 0.52,
    mieG: 0.8,
    twilightStrength: 0.46,
    nightStrength: 0.0,
    cloudLight: 0.94,
    cloudOpacity: 0.96,
  },
  {
    elev: 45, // midday
    // A sky with no geometry in it carries the frame on its own gradient, so
    // the zenith has to sit well under the horizon or the whole dome reads
    // as one flat bright field.
    skyTop: "#256fa7",
    // The camera sits on the horizon line, so this stop covers most of the
    // frame — it was the brightest value in the palette, which is why every
    // daylight frame measured as a flat bright field.
    skyHorizon: "#789bb7",
    skyBottom: "#386f9d",
    sun: "#fff4e0",
    sunIntensity: 1.0,
    fog: "#70869a",
    // Keep distant silhouettes atmospheric without compressing the entire
    // city, forest and beach into the same pale value at noon.
    fogDensity: 0.00085,
    key: "#fff3df",
    keyIntensity: 2.15,
    ambientSky: "#afc9e0",
    ambientGround: "#62646a",
    ambientIntensity: 0.78,
    exposure: 0.98,
    rayleighStrength: 1.0,
    mieStrength: 0.36,
    mieG: 0.78,
    twilightStrength: 0.0,
    nightStrength: 0.0,
    cloudLight: 1.0,
    cloudOpacity: 1.0,
  },
];

const COLOR_KEYS = ["skyTop", "skyHorizon", "skyBottom", "sun", "fog", "key", "ambientSky", "ambientGround"];
const SCALAR_KEYS = [
  "sunIntensity",
  "fogDensity",
  "keyIntensity",
  "ambientIntensity",
  "exposure",
  // Lightweight radiative controls. The dome consumes these as continuous
  // phase-function weights rather than switching shader modes at twilight.
  "rayleighStrength",
  "mieStrength",
  "mieG",
  "twilightStrength",
  "nightStrength",
  // The sky scene shares the same state so its clouds cannot lag behind the
  // dome when a remote participant scrubs the room time.
  "cloudLight",
  "cloudOpacity",
];

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
  let targetElevation = -90;
  let currentElevation = -90;
  let targetDaylight = 0;
  let currentDaylight = 0;

  function setElevation(elev) {
    if (typeof elev !== "number" || Number.isNaN(elev)) return;
    targetElevation = elev;
    targetDaylight = Math.min(1, Math.max(0, (elev + 6) / 18));
    gradeForElevation(elev, target);
  }

  function update(delta) {
    // Tab-switch guard: a huge delta snaps instead of easing through a blur.
    const f = delta > 0.5 ? 1 : 1 - Math.exp(-smoothing * delta);
    for (const k of COLOR_KEYS) current[k].lerp(target[k], f);
    for (const k of SCALAR_KEYS) current[k] += (target[k] - current[k]) * f;
    currentDaylight += (targetDaylight - currentDaylight) * f;
    // Consumers that derive geometry or effect strength from elevation must
    // see the same temporal state as the palette. Keeping the target value
    // here made a midnight-to-noon jump report 45 degrees while the frame was
    // still 97% night, producing daylight shafts in a night sky.
    currentElevation += (targetElevation - currentElevation) * f;
  }

  return {
    current,
    target,
    setElevation,
    update,
    get elevation() {
      return currentElevation;
    },
    get targetElevation() {
      return targetElevation;
    },
    /** True once the sun is below the horizon; scenes use it for lamps/fire. */
    get isNight() {
      return currentElevation <= 0;
    },
    /** 0 at night, 1 in full day — scenes fade night details with this. */
    get daylight() {
      // This scalar uses the same easing as the palette. A test-time jump
      // from midnight to noon should not pop windows, boats and fireflies to
      // their final state while the sky is still cross-fading.
      return currentDaylight;
    },
  };
}
