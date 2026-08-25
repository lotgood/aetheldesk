import test from "node:test";
import assert from "node:assert/strict";

import {
  CITY_DAY_TRAFFIC_LAYOUT,
  advanceCityTrafficTime,
  cityDayTrafficMix,
  resolveCityTrafficX,
} from "../../frontend/src/3d/scenes/city-scene.js";

test("day traffic stays sparse, lane-bound and taxi-accented", () => {
  assert.equal(CITY_DAY_TRAFFIC_LAYOUT.length, 14);
  assert.equal(CITY_DAY_TRAFFIC_LAYOUT.filter(vehicle => vehicle.taxi).length, 4);
  assert.ok(Object.isFrozen(CITY_DAY_TRAFFIC_LAYOUT));

  const validLanes = new Set([-48.6, -51.4, -148.8, -151.2]);
  for (const vehicle of CITY_DAY_TRAFFIC_LAYOUT) {
    assert.ok(Object.isFrozen(vehicle));
    assert.ok(validLanes.has(vehicle.lane));
    assert.ok(vehicle.direction === -1 || vehicle.direction === 1);
    assert.ok(vehicle.speed >= 1.8 && vehicle.speed <= 2.9);
    assert.ok(vehicle.scale >= 0.75 && vehicle.scale <= 1);
  }
});

test("traffic wrapping is stable in both directions over long sessions", () => {
  for (const vehicle of CITY_DAY_TRAFFIC_LAYOUT) {
    for (const elapsed of [-3600, 0, 1, 60, 3600, 36000]) {
      const x = resolveCityTrafficX(vehicle, elapsed);
      assert.ok(Number.isFinite(x));
      assert.ok(x >= -310 && x < 310);
    }
  }
});

test("physical traffic crossfades through dusk and freezes for reduced motion", () => {
  assert.equal(cityDayTrafficMix(-2), 0);
  assert.equal(cityDayTrafficMix(3), 0.5);
  assert.equal(cityDayTrafficMix(8), 1);
  assert.ok(cityDayTrafficMix(0) < cityDayTrafficMix(5));

  assert.equal(advanceCityTrafficTime(12, 0.5, true), 12);
  assert.equal(advanceCityTrafficTime(12, 0.5, false), 12.5);
  assert.equal(advanceCityTrafficTime(12, -0.5, false), 12);
});
