import assert from "node:assert/strict";
import test from "node:test";

import { createAtmosphere, gradeForElevation } from "../../frontend/src/3d/atmosphere.js";

test("eases live elevation with the palette after a large time change", () => {
  const atmosphere = createAtmosphere({ smoothing: 1.5 });

  atmosphere.setElevation(45);
  atmosphere.update(1 / 60);

  assert.ok(atmosphere.elevation > -90 && atmosphere.elevation < -80);
  assert.ok(atmosphere.daylight > 0 && atmosphere.daylight < 0.1);
  assert.equal(atmosphere.targetElevation, 45);

  // The existing tab-switch guard deliberately snaps every live channel.
  atmosphere.update(0.75);
  assert.equal(atmosphere.elevation, 45);
  assert.equal(atmosphere.daylight, 1);
});

test("physical sky and cloud channels stay bounded across the day", () => {
  const night = gradeForElevation(-90);
  const twilight = gradeForElevation(-4);
  const noon = gradeForElevation(45);

  for (const grade of [night, twilight, noon]) {
    for (const key of [
      "rayleighStrength",
      "mieStrength",
      "mieG",
      "twilightStrength",
      "nightStrength",
      "cloudLight",
      "cloudOpacity",
    ]) {
      assert.ok(Number.isFinite(grade[key]), `${key} must be finite`);
      assert.ok(grade[key] >= 0 && grade[key] <= 1, `${key} must be normalized`);
    }
  }

  assert.ok(night.nightStrength > twilight.nightStrength);
  assert.equal(noon.nightStrength, 0);
  assert.ok(twilight.twilightStrength > night.twilightStrength);
  assert.ok(twilight.twilightStrength > noon.twilightStrength);
  assert.ok(noon.rayleighStrength > twilight.rayleighStrength);
  assert.ok(noon.cloudLight > night.cloudLight);
  assert.ok(noon.cloudOpacity > night.cloudOpacity);
});

test("new atmosphere channels interpolate instead of switching at stops", () => {
  const before = gradeForElevation(-12);
  const middle = gradeForElevation(-8);
  const after = gradeForElevation(-4);

  for (const key of ["rayleighStrength", "mieStrength", "twilightStrength", "cloudLight", "cloudOpacity"]) {
    assert.ok(middle[key] > Math.min(before[key], after[key]));
    assert.ok(middle[key] < Math.max(before[key], after[key]));
  }
});
