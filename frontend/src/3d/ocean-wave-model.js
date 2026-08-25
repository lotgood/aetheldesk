// Compact, deterministic gravity-wave spectrum shared by the beach shader and
// focused unit tests.  The wavelengths follow a sparse JONSWAP-like energy
// cascade: most energy lives in the long, shore-bound swell while progressively
// smaller crossed components break up repetition.  This is deliberately an
// analytic model rather than an FFT render-target stack; it keeps the scene
// viable on the WebGL 2 baseline used by three.js and keeps normals analytic.

export const GRAVITY = 9.81;
export const SHORE_SLOPE = 0.055;
export const MIN_WATER_DEPTH = 0.35;
export const BREAKING_AMPLITUDE_RATIO = 0.34;
export const BREAKER_DISSIPATION = 0.22;
// A closed-form blend between the shallow-water and offshore limits. More
// oblique components need a slightly stronger transition because their
// conserved along-shore wave number consumes more of the finite-depth wave
// vector. The angle-aware fit stays analytic in depth (and therefore has an
// exact phase primitive) while keeping the authored spectrum within 8.5% of
// the full finite-depth refraction solve over the rendered depth range.
export const PHASE_BLEND_BASE = 1.47;
export const PHASE_BLEND_LINEAR = 0.35;
export const PHASE_BLEND_QUADRATIC = 1.15;

export const OCEAN_WAVES = Object.freeze([
  // The two long swells no longer carry almost the complete energy budget or
  // arrive head-on. Their opposed headings retain a calm dominant cadence but
  // prevent a still frame from collapsing into full-width horizontal bands.
  Object.freeze({ direction: Object.freeze([0.5, -0.866025]), amplitude: 0.52, wavelength: 156, speed: 1, steepness: 0.7, phase: 0.35, detail: 0 }),
  Object.freeze({ direction: Object.freeze([-0.642788, -0.766044]), amplitude: 0.39, wavelength: 88, speed: 1, steepness: 0.66, phase: 2.05, detail: 0 }),
  // Mid-scale energy supplies local curvature. The last, low-energy component
  // is a real cross-swell rather than another shore-normal stripe.
  Object.freeze({ direction: Object.freeze([0.75471, -0.656059]), amplitude: 0.42, wavelength: 49, speed: 1, steepness: 0.6, phase: 4.1, detail: 1 }),
  Object.freeze({ direction: Object.freeze([-0.694658, -0.71934]), amplitude: 0.29, wavelength: 27, speed: 1, steepness: 0.52, phase: 5.4, detail: 1 }),
  Object.freeze({ direction: Object.freeze([0.707107, -0.707107]), amplitude: 0.058, wavelength: 14.5, speed: 1, steepness: 0.48, phase: 2.35, detail: 2 }),
  Object.freeze({ direction: Object.freeze([-0.819152, -0.573576]), amplitude: 0.024, wavelength: 7.8, speed: 1, steepness: 0.4, phase: 5.55, detail: 2 }),
]);

export const GEOMETRY_WAVES = Object.freeze(OCEAN_WAVES.filter((wave) => wave.detail < 2));
export const GEOMETRY_WAVE_AMPLITUDE = GEOMETRY_WAVES.reduce((sum, wave) => sum + wave.amplitude, 0);

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function smoothstepDerivative(edge0, edge1, value) {
  if (value <= edge0 || value >= edge1) return 0;
  const t = (value - edge0) / (edge1 - edge0);
  return (6 * t * (1 - t)) / (edge1 - edge0);
}

/** Angle-aware coefficient for the analytic shallow/offshore phase blend. */
export function phaseBlend(crossFraction = 1) {
  const obliqueness = 1 - Math.min(1, Math.max(0, Math.abs(crossFraction)));
  return (
    PHASE_BLEND_BASE +
    PHASE_BLEND_LINEAR * obliqueness +
    PHASE_BLEND_QUADRATIC * obliqueness * obliqueness
  );
}

/** Linear gravity-wave dispersion for a finite water depth. */
export function finiteDepthAngularFrequency(wavelength, depth) {
  if (!(wavelength > 0) || !(depth > 0)) return 0;
  const k = (Math.PI * 2) / wavelength;
  return Math.sqrt(GRAVITY * k * Math.tanh(k * depth));
}

/** Offshore temporal frequency; it remains invariant as the swell shoals. */
export function deepWaterAngularFrequency(wavelength) {
  if (!(wavelength > 0)) return 0;
  return Math.sqrt((GRAVITY * Math.PI * 2) / wavelength);
}

/**
 * Guo's explicit finite-depth dispersion approximation (reported by Fenton
 * 2006 at <0.7% maximum error). It is exact in both the deep- and shallow-
 * water limits and avoids an iterative root solve in every shader vertex.
 */
export function finiteDepthWavenumber(wavelength, depth) {
  if (!(wavelength > 0) || !(depth > 0)) return 0;
  const omega = deepWaterAngularFrequency(wavelength);
  const x = Math.max(1e-6, omega * Math.sqrt(depth / GRAVITY));
  const base = Math.max(1e-12, 1 - Math.exp(-Math.pow(x, 2.5)));
  return (x * x * Math.pow(base, -0.4)) / depth;
}

/**
 * Local cross-shore wave number with the offshore along-shore component held
 * constant (Snell refraction). The form is analytic in depth, unlike k(h) * x,
 * so its integral below is an actual eikonal phase and its derivative is the
 * same local wave vector used by the surface normal.
 */
export function crossShoreWavenumber(wavelength, depth, crossFraction = 1) {
  if (!(wavelength > 0) || !(depth > 0)) return 0;
  const deepK = (Math.PI * 2) / wavelength;
  const offshoreCrossK = Math.max(1e-6, deepK * Math.abs(crossFraction));
  const shallowK = Math.sqrt(deepK / depth);
  const blend = phaseBlend(crossFraction);
  return (
    offshoreCrossK +
    shallowK -
    (blend * offshoreCrossK * shallowK) / (offshoreCrossK + shallowK)
  );
}

export function crossShoreWavenumberDepthDerivative(wavelength, depth, crossFraction = 1) {
  if (!(wavelength > 0) || !(depth > 0)) return 0;
  const deepK = (Math.PI * 2) / wavelength;
  const offshoreCrossK = Math.max(1e-6, deepK * Math.abs(crossFraction));
  const shallowK = Math.sqrt(deepK / depth);
  const shallowDerivative = (-0.5 * shallowK) / depth;
  const denominator = offshoreCrossK + shallowK;
  const blend = phaseBlend(crossFraction);
  return shallowDerivative * (1 - (blend * offshoreCrossK * offshoreCrossK) / (denominator * denominator));
}

function crossShorePhasePrimitive(wavelength, depth, crossFraction) {
  const deepK = (Math.PI * 2) / wavelength;
  const offshoreCrossK = Math.max(1e-6, deepK * Math.abs(crossFraction));
  const rootK = Math.sqrt(deepK);
  const rootDepth = Math.sqrt(depth);
  const blend = phaseBlend(crossFraction);
  return (
    offshoreCrossK * depth +
    2 * rootK * (1 - blend) * rootDepth +
    ((2 * blend * deepK) / offshoreCrossK) * Math.log(offshoreCrossK * rootDepth + rootK)
  );
}

/** Integral of the local cross-shore wave number from the swash edge. */
export function crossShorePhaseIntegral(wavelength, seawardDistance, crossFraction = 1) {
  if (!(wavelength > 0)) return 0;
  const distance = Math.max(0, seawardDistance);
  const depth = MIN_WATER_DEPTH + distance * SHORE_SLOPE;
  return (
    (crossShorePhasePrimitive(wavelength, depth, crossFraction) -
      crossShorePhasePrimitive(wavelength, MIN_WATER_DEPTH, crossFraction)) /
    SHORE_SLOPE
  );
}

/**
 * Production shader and tests use the same shore envelope.  Energy shoals as
 * group velocity drops, then the breaker limiter takes over and the wave dies
 * smoothly at the swash edge instead of crossing onto dry sand.
 */
export function shoreHydrodynamics(seawardDistance) {
  const distance = Math.max(0, seawardDistance);
  const depth = MIN_WATER_DEPTH + distance * SHORE_SLOPE;
  const shoreFade = smoothstep(1.5, 18, distance);
  const shoreFadeDerivative = smoothstepDerivative(1.5, 18, distance);
  const deepMix = smoothstep(45, 230, distance);
  const deepMixDerivative = smoothstepDerivative(45, 230, distance);
  const shoaling = 1 + (1 - deepMix) * 0.52;
  const shoalingDerivative = -deepMixDerivative * 0.52;
  const breakerRise = smoothstep(12, 34, distance);
  const breakerRiseDerivative = smoothstepDerivative(12, 34, distance);
  const breakerFall = smoothstep(68, 118, distance);
  const breakerFallDerivative = smoothstepDerivative(68, 118, distance);
  const breaker = breakerRise * (1 - breakerFall);
  const breakerDerivative = breakerRiseDerivative * (1 - breakerFall) - breakerRise * breakerFallDerivative;
  const dissipation = 1 - breaker * BREAKER_DISSIPATION;
  const dissipationDerivative = -breakerDerivative * BREAKER_DISSIPATION;
  const unlimitedAmplitudeScale = shoreFade * shoaling * dissipation;
  const unlimitedAmplitudeScaleDerivative =
    shoreFadeDerivative * shoaling * dissipation +
    shoreFade * shoalingDerivative * dissipation +
    shoreFade * shoaling * dissipationDerivative;
  // Irregular breaking waves are bounded by H/h before their component phases
  // are summed. This prevents an analytic crest from becoming taller than the
  // water column it is travelling through.
  const breakingLimit = (BREAKING_AMPLITUDE_RATIO * depth) / GEOMETRY_WAVE_AMPLITUDE;
  const breakingLimitDerivative = (BREAKING_AMPLITUDE_RATIO * SHORE_SLOPE) / GEOMETRY_WAVE_AMPLITUDE;
  const depthLimited = breakingLimit < unlimitedAmplitudeScale;
  const amplitudeScale = depthLimited ? breakingLimit : unlimitedAmplitudeScale;
  const amplitudeScaleDerivative = depthLimited
    ? breakingLimitDerivative
    : unlimitedAmplitudeScaleDerivative;
  return {
    depth,
    shoreFade,
    shoaling,
    breaker,
    dissipation,
    breakingLimit,
    unlimitedAmplitudeScale,
    amplitudeScale,
    amplitudeScaleDerivative,
  };
}

/**
 * CPU reference sampler for regression tests and tuning.  Runtime animation is
 * evaluated in the vertex shader, so this function never runs per frame.
 */
export function sampleGerstnerSurface(x, z, time, seawardDistance, waves = GEOMETRY_WAVES) {
  const shore = shoreHydrodynamics(seawardDistance);
  let px = x;
  let pz = z;
  let height = 0;
  let compression = 0;
  const tangentX = { x: 1, z: 0, height: 0 };
  const tangentSeaward = { x: 0, z: 1, height: 0 };
  const waveCount = Math.max(1, GEOMETRY_WAVES.length);

  for (const wave of waves) {
    const deepK = (Math.PI * 2) / wave.wavelength;
    const alongK = deepK * wave.direction[0];
    const crossSign = wave.direction[1] < 0 ? -1 : 1;
    const crossFraction = Math.abs(wave.direction[1]);
    const crossK = crossShoreWavenumber(wave.wavelength, shore.depth, crossFraction) * crossSign;
    const crossKDerivative =
      crossShoreWavenumberDepthDerivative(wave.wavelength, shore.depth, crossFraction) *
      SHORE_SLOPE *
      crossSign;
    const waveNumber = Math.hypot(alongK, crossK);
    const dirX = alongK / waveNumber;
    const dirZ = crossK / waveNumber;
    const waveNumberDerivative = dirZ * crossKDerivative;
    const dirXDerivative = (-dirX * waveNumberDerivative) / waveNumber;
    const dirZDerivative = (crossKDerivative - dirZ * waveNumberDerivative) / waveNumber;
    const amplitude = wave.amplitude * shore.amplitudeScale;
    const amplitudeDerivative = wave.amplitude * shore.amplitudeScaleDerivative;
    const omega = deepWaterAngularFrequency(wave.wavelength) * wave.speed;
    const theta =
      alongK * x +
      crossSign * crossShorePhaseIntegral(wave.wavelength, seawardDistance, crossFraction) -
      omega * time +
      wave.phase;
    const amplitudeHorizontal = amplitude * 0.72;
    const steepnessHorizontal = wave.steepness / (waveNumber * waveCount);
    const amplitudeLimited = amplitudeHorizontal <= steepnessHorizontal;
    const horizontal = amplitudeLimited ? amplitudeHorizontal : steepnessHorizontal;
    const horizontalDerivative = amplitudeLimited
      ? amplitudeDerivative * 0.72
      : (-horizontal * waveNumberDerivative) / waveNumber;
    const cosine = Math.cos(theta);
    const sine = Math.sin(theta);
    px += dirX * horizontal * cosine;
    pz += dirZ * horizontal * cosine;
    height += amplitude * sine;
    compression += Math.max(0, horizontal * waveNumber * sine);

    const phaseX = alongK;
    tangentX.x += dirX * -horizontal * sine * phaseX;
    tangentX.z += dirZ * -horizontal * sine * phaseX;
    tangentX.height += amplitude * cosine * phaseX;

    const horizontalSlope = horizontalDerivative * cosine - horizontal * sine * crossK;
    tangentSeaward.x += dirXDerivative * horizontal * cosine + dirX * horizontalSlope;
    tangentSeaward.z += dirZDerivative * horizontal * cosine + dirZ * horizontalSlope;
    tangentSeaward.height += amplitudeDerivative * sine + amplitude * cosine * crossK;
  }

  return { x: px, z: pz, height, compression, shore, tangentX, tangentSeaward };
}

function glslNumber(value) {
  const fixed = Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return fixed.includes(".") ? fixed : `${fixed}.0`;
}

/** Generate constant GLSL calls once at module evaluation, never in update(). */
export function buildGerstnerShaderCalls(waves = OCEAN_WAVES) {
  // Components below the mesh Nyquist limit are evaluated as fragment-normal
  // ripples in beach-scene.js. Displacing sparse vertices with them would
  // alias into crawling triangles instead of adding detail.
  return waves
    .filter((wave) => wave.detail < 2)
    .map((wave) => {
      const filter = wave.detail === 0 ? "1.0" : "midDetail";
      return `addWave(p, tangentX, tangentY, compression, q, vec2(${glslNumber(wave.direction[0])}, ${glslNumber(wave.direction[1])}), ${glslNumber(wave.amplitude)}, ${glslNumber(wave.wavelength)}, ${glslNumber(wave.speed)}, ${glslNumber(wave.steepness)}, ${glslNumber(wave.phase)}, ${filter}, depth, amplitudeScale, amplitudeScaleDerivative, shoreDerivative, uTime);`;
    })
    .join("\n      ");
}
