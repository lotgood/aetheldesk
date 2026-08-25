import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";

import { createCelestialSystem } from "../../frontend/src/3d/celestial.js";
import { buildAlpineRangeGeometry } from "../../frontend/src/3d/scenes/forest-scene.js";

const CELESTIAL_SOURCE = readFileSync(
  new URL("../../frontend/src/3d/celestial.js", import.meta.url),
  "utf8",
);
const FOREST_SOURCE = readFileSync(
  new URL("../../frontend/src/3d/scenes/forest-scene.js", import.meta.url),
  "utf8",
);

test("alpine range stays far behind the forest and contains rock and snow", () => {
  const geometry = buildAlpineRangeGeometry();
  const position = geometry.attributes.position;
  const color = geometry.attributes.color;
  const snow = geometry.attributes.mountainSnow;

  assert.ok(position.count >= 4500 && position.count <= 5500);
  assert.ok(geometry.boundingBox.max.z <= -450);
  assert.ok(geometry.boundingBox.min.z <= -850);
  assert.ok(geometry.boundingBox.max.x - geometry.boundingBox.min.x >= 1800);
  assert.ok(geometry.boundingBox.max.y >= 195);

  let darkest = Number.POSITIVE_INFINITY;
  let lightest = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < color.count; i++) {
    darkest = Math.min(darkest, color.getX(i), color.getY(i), color.getZ(i));
    lightest = Math.max(lightest, color.getX(i), color.getY(i), color.getZ(i));
  }
  assert.ok(darkest < 0.09, `rock floor value=${darkest}`);
  assert.ok(lightest > 0.78, `snow peak value=${lightest}`);
  assert.ok(Array.from(snow.array).filter(value => value > 0.7).length > 300);
});

test("forest no longer builds intersecting hemisphere hills", () => {
  assert.doesNotMatch(FOREST_SOURCE, /new THREE\.SphereGeometry\(1, 16, 8/);
  assert.match(FOREST_SOURCE, /const zFront = -450;/);
  assert.match(FOREST_SOURCE, /const treeFootprints = \[\];/);
  assert.match(FOREST_SOURCE, /isGroundPropClear/);
});

test("night sky is authored in the camera cone with sparse, accessible motion", () => {
  assert.match(CELESTIAL_SOURCE, /const starCount = 1500;/);
  assert.match(CELESTIAL_SOURCE, /degToRad\(120\)/);
  assert.match(CELESTIAL_SOURCE, /const mwCount = 420;/);
  assert.match(CELESTIAL_SOURCE, /makeMilkyWayTexture\(\)/);
  assert.match(CELESTIAL_SOURCE, /const meteorCount = 1;/);
  assert.match(CELESTIAL_SOURCE, /const meteorLine = new THREE\.Line/);
  assert.match(CELESTIAL_SOURCE, /meteorPoints\.frustumCulled = false/);
  assert.match(CELESTIAL_SOURCE, /meteorLine\.frustumCulled = false/);
  assert.match(CELESTIAL_SOURCE, /meteorGeo\.setDrawRange\(0, 0\)/);
  assert.match(CELESTIAL_SOURCE, /timer: 6 \+ Math\.random\(\) \* 6/);
  assert.match(CELESTIAL_SOURCE, /m\.timer = 35 \+ Math\.random\(\) \* 50/);
  assert.match(CELESTIAL_SOURCE, /const meteorLayerVisible = !reducedMotion/);
  assert.doesNotMatch(CELESTIAL_SOURCE, /y=420|420 \+ Math\.random\(\) \* 180/);
});

test("shooting star becomes a visible in-cone streak, then returns to its sparse timer", () => {
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalRandom = Math.random;
  const gradient = { addColorStop() {} };
  const context = new Proxy({
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
  }, {
    get(target, key) {
      if (key in target) return target[key];
      return () => {};
    },
  });

  try {
    globalThis.document = {
      createElement: () => ({ width: 0, height: 0, getContext: () => context }),
    };
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    Math.random = () => 0;

    const celestial = createCelestialSystem(new THREE.Scene());
    celestial.updateCelestialState({ elevation: -18, arc_pct: 0.5, night_arc_pct: 0.5 });
    for (let frame = 0; frame < 380; frame++) celestial.update(1 / 60, frame / 60, null);

    const live = celestial.getNightSkyDiagnostics();
    assert.equal(live.active, true);
    assert.ok(live.historyLength > 2);
    assert.equal(live.drawCount, live.historyLength);
    assert.ok(live.head.x >= -120 && live.head.x < 0);
    assert.ok(live.head.y > 70 && live.head.y < 110);
    assert.ok(live.head.z < -420 && live.head.z > -510);

    for (let frame = 0; frame < 70; frame++) celestial.update(1 / 60, 7 + frame / 60, null);
    const resting = celestial.getNightSkyDiagnostics();
    assert.equal(resting.active, false);
    assert.equal(resting.drawCount, 0);
    assert.ok(resting.timer > 33 && resting.timer <= 35);
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
    Math.random = originalRandom;
  }
});
