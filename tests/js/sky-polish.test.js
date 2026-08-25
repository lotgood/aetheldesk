import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const skyDomePath = new URL("../../frontend/src/3d/sky-dome.js", import.meta.url);
const skyScenePath = new URL("../../frontend/src/3d/scenes/sky-scene.js", import.meta.url);

test("sky dome keeps physical angular structure and stable gradient dithering", async () => {
  const source = await readFile(skyDomePath, "utf8");

  assert.match(source, /float rayleighPhase\(/);
  assert.match(source, /float henyeyGreenstein\(/);
  assert.match(source, /8400\.0 \* airMass/);
  assert.match(source, /Belt of Venus/);
  assert.match(source, /interleavedGradientNoise\(gl_FragCoord\.xy\)/);
  assert.doesNotMatch(source, /sin\(dot\(gl_FragCoord/);
  assert.match(source, /pow\(max\(0\.0, sunCos\), 512\.0\) \* 0\.30/);
});

test("cloud field is instanced, compositional, and post-pipeline safe", async () => {
  const source = await readFile(skyScenePath, "utf8");

  assert.match(source, /new THREE\.InstancedMesh/);
  assert.match(source, /new THREE\.InstancedBufferAttribute/);
  assert.match(source, /Beer-Lambert extinction/);
  assert.match(source, /CLOUD_SHELL_SLICES = 4/);
  assert.match(source, /function makeCloudShellGeometry\(\)/);
  assert.match(source, /attribute float aSlice;/);
  assert.match(source, /float shellTransmittance = exp/);
  assert.match(source, /aSliceShear/);
  assert.match(source, /aLayerPhase/);
  assert.match(source, /aLaneFade/);
  assert.match(source, /prefersReducedMotion\(\)/);
  assert.doesNotMatch(source, /#include <tonemapping_fragment>/);

  const updateBody = source.split("function update(delta, _elapsed, atmosphere)", 2)[1];
  assert.ok(updateBody, "sky scene update function must exist");
  assert.doesNotMatch(updateBody, /new THREE\./, "render-loop code must not allocate Three.js objects");
});
