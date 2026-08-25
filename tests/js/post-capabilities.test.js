import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { resolvePostTargetProfile } from "../../frontend/src/3d/post.js";
import { createSunShaftsPass } from "../../frontend/src/3d/sun-shafts.js";

function rendererWithExtensions(names, { throws = false } = {}) {
  return {
    extensions: {
      has(name) {
        if (throws) throw new Error("extension query failed");
        return names.has(name);
      },
    },
  };
}

test("post target selects half float only when the live renderer exposes a color-buffer extension", () => {
  for (const extension of ["EXT_color_buffer_float", "EXT_color_buffer_half_float"]) {
    const profile = resolvePostTargetProfile(rendererWithExtensions(new Set([extension])));
    assert.deepEqual(profile, { hdr: true, textureType: THREE.HalfFloatType });
  }
});
test("post target safely degrades to unsigned byte when half-float renderability is absent", () => {
  for (const renderer of [
    rendererWithExtensions(new Set()),
    rendererWithExtensions(new Set(), { throws: true }),
    {},
    null,
  ]) {
    const profile = resolvePostTargetProfile(renderer);
    assert.deepEqual(profile, { hdr: false, textureType: THREE.UnsignedByteType });
  }
});

test("sun shafts honor the selected render-target type", () => {
  const ldr = createSunShaftsPass(320, 180, { textureType: THREE.UnsignedByteType });
  const hdr = createSunShaftsPass(320, 180, { textureType: THREE.HalfFloatType });
  assert.equal(ldr.textureType, THREE.UnsignedByteType);
  assert.equal(hdr.textureType, THREE.HalfFloatType);
  ldr.pass.dispose();
  hdr.pass.dispose();
});
