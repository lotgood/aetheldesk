import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BREAKING_AMPLITUDE_RATIO,
  buildGerstnerShaderCalls,
  crossShorePhaseIntegral,
  crossShoreWavenumber,
  deepWaterAngularFrequency,
  finiteDepthAngularFrequency,
  finiteDepthWavenumber,
  GEOMETRY_WAVE_AMPLITUDE,
  GEOMETRY_WAVES,
  GRAVITY,
  MIN_WATER_DEPTH,
  OCEAN_WAVES,
  sampleGerstnerSurface,
  SHORE_SLOPE,
  shoreHydrodynamics,
} from "../../frontend/src/3d/ocean-wave-model.js";

const BEACH_SHADER_SOURCE = readFileSync(
  new URL("../../frontend/src/3d/scenes/beach-scene.js", import.meta.url),
  "utf8",
);

test("ocean spectrum is directional, normalized, and stable", () => {
  assert.equal(OCEAN_WAVES.length, 6);
  const headings = new Set();
  let steepnessBudget = 0;

  for (const wave of OCEAN_WAVES) {
    const length = Math.hypot(...wave.direction);
    assert.ok(Math.abs(length - 1) < 0.0001, `direction length ${length}`);
    assert.ok(wave.wavelength > 0);
    assert.ok(wave.amplitude > 0);
    headings.add(wave.direction.join(","));
    steepnessBudget += wave.steepness / OCEAN_WAVES.length;
  }

  assert.equal(headings.size, OCEAN_WAVES.length);
  assert.ok(steepnessBudget < 0.65, `fold-safe steepness budget ${steepnessBudget}`);
});

test("geometry energy is redistributed into a calm bidirectional cross-swell", () => {
  const longWaveAmplitude = GEOMETRY_WAVES.filter((wave) => wave.detail === 0).reduce(
    (sum, wave) => sum + wave.amplitude,
    0,
  );
  const weightedLateralEnergy = GEOMETRY_WAVES.reduce(
    (sum, wave) => sum + wave.amplitude * Math.abs(wave.direction[0]),
    0,
  ) / GEOMETRY_WAVE_AMPLITUDE;

  // Keep the existing total displacement and temporal cadence: only its
  // direction/scale distribution changes, so the 50+10 scene stays calm.
  assert.ok(Math.abs(GEOMETRY_WAVE_AMPLITUDE - 1.62) < 1e-12);
  assert.ok(longWaveAmplitude / GEOMETRY_WAVE_AMPLITUDE < 0.7);
  assert.ok(weightedLateralEnergy > 0.6, `lateral energy=${weightedLateralEnergy}`);
  assert.ok(GEOMETRY_WAVES.some((wave) => wave.direction[0] > 0.7));
  assert.ok(GEOMETRY_WAVES.some((wave) => wave.direction[0] < -0.65));
  assert.ok(GEOMETRY_WAVES.every((wave) => wave.speed === 1));
});

test("finite-depth dispersion slows waves toward shore", () => {
  const wavelength = 80;
  const shallow = finiteDepthAngularFrequency(wavelength, 0.7);
  const shelf = finiteDepthAngularFrequency(wavelength, 8);
  const deep = finiteDepthAngularFrequency(wavelength, 1000);
  const deepLimit = Math.sqrt((GRAVITY * Math.PI * 2) / wavelength);

  assert.ok(shallow > 0);
  assert.ok(shallow < shelf);
  assert.ok(shelf < deep);
  assert.ok(Math.abs(deep - deepLimit) < 1e-8);
  assert.equal(finiteDepthAngularFrequency(0, 10), 0);
  assert.equal(finiteDepthAngularFrequency(10, 0), 0);
});

test("shoaling preserves offshore period while shortening local wavelength", () => {
  const wavelength = 80;
  const omega = deepWaterAngularFrequency(wavelength);
  const shallowK = finiteDepthWavenumber(wavelength, 0.7);
  const shelfK = finiteDepthWavenumber(wavelength, 8);
  const deepK = finiteDepthWavenumber(wavelength, 1000);
  const expectedDeepK = (Math.PI * 2) / wavelength;

  assert.ok(omega > 0);
  assert.ok(shallowK > shelfK);
  assert.ok(shelfK > deepK);
  assert.ok(Math.abs(deepK - expectedDeepK) < 1e-8);
  assert.equal(finiteDepthWavenumber(0, 10), 0);
  assert.equal(finiteDepthWavenumber(10, 0), 0);
});

test("integrated shore-normal phase differentiates to the local refracted wave number", () => {
  for (const wave of GEOMETRY_WAVES) {
    const crossFraction = Math.abs(wave.direction[1]);
    for (const distance of [3, 15, 45, 120, 360]) {
      const epsilon = 1e-3;
      const derivative =
        (crossShorePhaseIntegral(wave.wavelength, distance + epsilon, crossFraction) -
          crossShorePhaseIntegral(wave.wavelength, distance - epsilon, crossFraction)) /
        (epsilon * 2);
      const depth = MIN_WATER_DEPTH + distance * SHORE_SLOPE;
      const expected = crossShoreWavenumber(wave.wavelength, depth, crossFraction);
      assert.ok(Math.abs(derivative - expected) < 1e-7, `${wave.wavelength}m at ${distance}: ${derivative} vs ${expected}`);
    }
  }
});

test("refracted crest spacing shortens monotonically toward shore", () => {
  for (const wave of GEOMETRY_WAVES) {
    const crossFraction = Math.abs(wave.direction[1]);
    const wavelengths = [15, 30, 60, 120, 300].map((distance) => {
      const depth = MIN_WATER_DEPTH + distance * SHORE_SLOPE;
      return (Math.PI * 2) / crossShoreWavenumber(wave.wavelength, depth, crossFraction);
    });
    for (let i = 1; i < wavelengths.length; i++) {
      assert.ok(wavelengths[i] > wavelengths[i - 1], `${wave.wavelength}: ${wavelengths.join(", ")}`);
    }
  }
});

test("closed-form refracted wave number stays close to full finite-depth dispersion", () => {
  for (const wave of GEOMETRY_WAVES) {
    const deepK = (Math.PI * 2) / wave.wavelength;
    for (const depth of [0.35, 0.7, 1.2, 2, 4, 8, 16, 40, 80]) {
      const fullK = finiteDepthWavenumber(wave.wavelength, depth);
      const targetCrossK = Math.sqrt(Math.max(1e-10, fullK * fullK - (deepK * wave.direction[0]) ** 2));
      const crossK = crossShoreWavenumber(wave.wavelength, depth, Math.abs(wave.direction[1]));
      assert.ok(Math.abs(crossK / targetCrossK - 1) < 0.085, `${wave.wavelength}m depth ${depth}`);
    }
  }
});

test("shore envelope shoals, breaks, then returns to deep-water energy", () => {
  const edge = shoreHydrodynamics(0);
  const surf = shoreHydrodynamics(45);
  const deep = shoreHydrodynamics(300);

  assert.equal(edge.shoreFade, 0);
  assert.equal(edge.amplitudeScale, 0);
  assert.ok(surf.breaker > 0.8, `breaker=${surf.breaker}`);
  assert.ok(surf.shoaling > 1.4, `shoaling=${surf.shoaling}`);
  assert.equal(deep.breaker, 0);
  assert.equal(deep.shoaling, 1);
  assert.equal(deep.amplitudeScale, 1);
});

test("reference Gerstner sampler stays finite and cannot fold", () => {
  const dryEdge = sampleGerstnerSurface(17, -12, 25, 0);
  assert.equal(dryEdge.height, 0);
  assert.equal(dryEdge.compression, 0);

  for (let time = 0; time <= 20; time += 0.25) {
    const sample = sampleGerstnerSurface(23, -47, time, 55);
    assert.ok(Number.isFinite(sample.x));
    assert.ok(Number.isFinite(sample.z));
    assert.ok(Number.isFinite(sample.height));
    assert.ok(sample.compression >= 0);
    assert.ok(sample.compression < 0.65, `compression=${sample.compression}`);
  }
});

test("cross-swell surface stays fold-free across the rendered shelf", () => {
  let minimumHorizontalDeterminant = Number.POSITIVE_INFINITY;
  let maximumCompression = 0;
  let maximumSlope = 0;

  for (const x of [-120, -30, 0, 30, 120]) {
    for (const distance of [2, 8, 15, 30, 55, 100, 220, 500]) {
      for (const time of [0, 1.5, 3.5, 8, 15, 24, 40]) {
        const sample = sampleGerstnerSurface(x, distance + 28, time, distance);
        const determinant =
          sample.tangentX.x * sample.tangentSeaward.z -
          sample.tangentX.z * sample.tangentSeaward.x;
        minimumHorizontalDeterminant = Math.min(minimumHorizontalDeterminant, determinant);
        maximumCompression = Math.max(maximumCompression, sample.compression);
        maximumSlope = Math.max(
          maximumSlope,
          Math.hypot(sample.tangentX.height, sample.tangentSeaward.height),
        );
      }
    }
  }

  assert.ok(minimumHorizontalDeterminant > 0.75, `determinant=${minimumHorizontalDeterminant}`);
  assert.ok(maximumCompression < 0.3, `compression=${maximumCompression}`);
  assert.ok(maximumSlope < 0.3, `slope=${maximumSlope}`);
});

test("analytic surface tangents match spatial finite differences", () => {
  const x = 21;
  const distance = 40;
  const z = distance + 28;
  const time = 17.25;
  const epsilon = 1e-4;
  const center = sampleGerstnerSurface(x, z, time, distance);
  const xBefore = sampleGerstnerSurface(x - epsilon, z, time, distance);
  const xAfter = sampleGerstnerSurface(x + epsilon, z, time, distance);
  const dBefore = sampleGerstnerSurface(x, z - epsilon, time, distance - epsilon);
  const dAfter = sampleGerstnerSurface(x, z + epsilon, time, distance + epsilon);

  for (const [actual, expected, label] of [
    [(xAfter.x - xBefore.x) / (2 * epsilon), center.tangentX.x, "dx.x"],
    [(xAfter.z - xBefore.z) / (2 * epsilon), center.tangentX.z, "dx.z"],
    [(xAfter.height - xBefore.height) / (2 * epsilon), center.tangentX.height, "dx.height"],
    [(dAfter.x - dBefore.x) / (2 * epsilon), center.tangentSeaward.x, "dd.x"],
    [(dAfter.z - dBefore.z) / (2 * epsilon), center.tangentSeaward.z, "dd.z"],
    [(dAfter.height - dBefore.height) / (2 * epsilon), center.tangentSeaward.height, "dd.height"],
  ]) {
    assert.ok(Math.abs(actual - expected) < 2e-5, `${label}: ${actual} vs ${expected}`);
  }
});

test("depth-limited breaker keeps the complete geometric surface inside the shallow water column", () => {
  for (const distance of [2, 5, 10, 15, 22, 34, 55, 80]) {
    const depth = MIN_WATER_DEPTH + distance * SHORE_SLOPE;
    for (let time = 0; time <= 40; time += 0.5) {
      const sample = sampleGerstnerSurface(0, distance + 28, time, distance);
      assert.ok(
        Math.abs(sample.height) <= depth * BREAKING_AMPLITUDE_RATIO + 1e-9,
        `distance=${distance}, time=${time}, height=${sample.height}, depth=${depth}`,
      );
    }
  }
});

test("one offshore period repeats at every depth without temporal phase shear", () => {
  const wave = OCEAN_WAVES[0];
  const period = (Math.PI * 2) / deepWaterAngularFrequency(wave.wavelength);

  for (const distance of [8, 45, 160, 500]) {
    const first = sampleGerstnerSurface(21, -34, 17.25, distance, [wave]);
    const repeated = sampleGerstnerSurface(21, -34, 17.25 + period, distance, [wave]);
    assert.ok(Math.abs(first.x - repeated.x) < 1e-10);
    assert.ok(Math.abs(first.z - repeated.z) < 1e-10);
    assert.ok(Math.abs(first.height - repeated.height) < 1e-10);
  }
});

test("mesh shader excludes wavelengths delegated to fragment normals", () => {
  const source = buildGerstnerShaderCalls();
  assert.equal(source.match(/addWave\(/g)?.length, 4);
  assert.match(source, /156\.0/);
  assert.match(source, /27\.0/);
  assert.match(source, /vec2\(0\.75471, -0\.656059\)/);
  assert.match(source, /vec2\(-0\.694658, -0\.71934\)/);
  assert.match(source, /amplitudeScaleDerivative/);
  assert.match(source, /shoreDerivative/);
  assert.doesNotMatch(source, /14\.5/);
  assert.doesNotMatch(source, /7\.8/);
});

test("water shader uses crossed micro normals and bounded anisotropic reflection", () => {
  assert.match(BEACH_SHADER_SOURCE, /float rp4 =/);
  assert.match(BEACH_SHADER_SOURCE, /float rp5 =/);
  assert.match(BEACH_SHADER_SOURCE, /float slopeAlignment =/);
  assert.match(BEACH_SHADER_SOURCE, /float focusCalm = mix\(0\.72, 1\.0,/);
  assert.match(BEACH_SHADER_SOURCE, /float rough = 0\.102 \+ far \* 0\.24/);
  assert.match(BEACH_SHADER_SOURCE, /vec3 safeNormalize\(/);
  assert.match(BEACH_SHADER_SOURCE, /safeNormalize\(V \+ L, N\)/);
  assert.doesNotMatch(BEACH_SHADER_SOURCE, /normalize\(V \+ L\)/);
  assert.match(BEACH_SHADER_SOURCE, /clamp\(col, vec3\(0\.0\), vec3\(8\.0\)\)/);
});
