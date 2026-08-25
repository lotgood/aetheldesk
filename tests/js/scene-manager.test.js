import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";

import { createSceneManager } from "../../frontend/src/3d/scenes/scene-manager.js";

function fakeScene(name, overrides = {}) {
  return {
    group: Object.assign(new THREE.Group(), { name: `fake-${name}` }),
    update() {},
    updateCelestial() {},
    ...overrides,
  };
}

test("constructs scene geometry lazily and reuses the first instance", () => {
  const calls = { sky: 0, city: 0, beach: 0, forest: 0 };
  const factories = Object.fromEntries(
    Object.keys(calls).map(name => [name, () => {
      calls[name]++;
      return fakeScene(name);
    }]),
  );
  const manager = createSceneManager(new THREE.Scene(), { factories, reportFailure() {} });

  assert.deepEqual(calls, { sky: 1, city: 0, beach: 0, forest: 0 });
  assert.equal(manager.switchScene("city"), "city");
  assert.equal(manager.switchScene("city"), "city");
  assert.deepEqual(calls, { sky: 1, city: 1, beach: 0, forest: 0 });
  assert.deepEqual(manager.getHealth().ready, ["sky", "city"]);
});

test("prepares a lazy scene without hiding the currently presented scene", () => {
  const manager = createSceneManager(new THREE.Scene(), {
    factories: {
      sky: () => fakeScene("sky"),
      beach: () => fakeScene("beach"),
    },
    reportFailure() {},
  });

  const prepared = manager.prepareScene("beach");
  assert.equal(prepared.resolvedName, "beach");
  assert.equal(manager.getActiveSceneName(), "sky");
  assert.equal(manager.scenes.sky.group.visible, true);
  assert.equal(manager.scenes.beach.group.visible, false);

  assert.equal(manager.activatePreparedScene(prepared), "beach");
  assert.equal(manager.scenes.sky.group.visible, false);
  assert.equal(manager.scenes.beach.group.visible, true);
});

test("compiles with only the prepared scene visible and restores the live scene immediately", () => {
  const manager = createSceneManager(new THREE.Scene(), {
    factories: {
      sky: () => fakeScene("sky"),
      forest: () => fakeScene("forest"),
    },
    reportFailure() {},
  });
  const prepared = manager.prepareScene("forest");

  const readiness = manager.withPreparedSceneVisibleForCompilation(prepared, () => {
    assert.equal(manager.scenes.sky.group.visible, false);
    assert.equal(manager.scenes.forest.group.visible, true);
    return Promise.resolve("ready");
  });

  assert.equal(manager.scenes.sky.group.visible, true);
  assert.equal(manager.scenes.forest.group.visible, false);
  assert.equal(readiness instanceof Promise, true);
});

test("quarantines a scene whose shader preparation fails", () => {
  const reports = [];
  const manager = createSceneManager(new THREE.Scene(), {
    factories: {
      sky: () => fakeScene("sky"),
      forest: () => fakeScene("forest"),
    },
    reportFailure: (...args) => reports.push(args),
  });
  const prepared = manager.prepareScene("forest");

  manager.markPreparationFailed(prepared, new Error("forest shader failed"));

  assert.deepEqual(manager.getHealth().failed, ["forest"]);
  assert.deepEqual(manager.getHealth().failures, [
    { name: "forest", phase: "shader preparation", message: "forest shader failed" },
  ]);
  assert.equal(reports.length, 1);
  assert.equal(manager.prepareScene("forest").resolvedName, "sky");
});

test("construction failure resolves to sky and reports one precise failure", () => {
  const reports = [];
  const manager = createSceneManager(new THREE.Scene(), {
    factories: {
      sky: () => fakeScene("sky"),
      forest: () => { throw new Error("forest factory exploded"); },
    },
    reportFailure: (...args) => reports.push(args),
  });

  assert.equal(manager.switchScene("forest"), "sky");
  assert.equal(manager.switchScene("forest"), "sky");
  assert.equal(reports.length, 1);
  assert.deepEqual(manager.getHealth(), {
    active: "sky",
    requested: "forest",
    ready: ["sky"],
    failed: ["forest"],
    failures: [{ name: "forest", phase: "construction", message: "forest factory exploded" }],
  });
});

test("first-frame failure updates the sky fallback in the same frame", () => {
  let skyFrames = 0;
  const reports = [];
  const manager = createSceneManager(new THREE.Scene(), {
    factories: {
      sky: () => fakeScene("sky", { update() { skyFrames++; } }),
      forest: () => fakeScene("forest", { update() { throw new Error("bad frame"); } }),
    },
    reportFailure: (...args) => reports.push(args),
  });

  manager.switchScene("forest");
  manager.update(1 / 60, 1, null);

  assert.equal(manager.getActiveSceneName(), "sky");
  assert.equal(skyFrames, 1);
  assert.equal(reports.length, 1);
  assert.deepEqual(manager.getHealth().failures, [{ name: "forest", phase: "frame update", message: "bad frame" }]);
});

test("seeds viewport, DPR and effect state into a scene created later", () => {
  const received = {};
  const manager = createSceneManager(new THREE.Scene(), {
    factories: {
      sky: () => fakeScene("sky"),
      forest: () => fakeScene("forest", {
        setViewportAspect(value) { received.aspect = value; },
        setPixelRatio(value) { received.pixelRatio = value; },
        setShaftsEnabled(value) { received.shafts = value; },
      }),
    },
    reportFailure() {},
  });

  manager.setViewportAspect(390 / 844);
  manager.setPixelRatio(1.5);
  manager.setShaftsEnabled(false);
  manager.switchScene("forest");

  assert.deepEqual(received, { aspect: 390 / 844, pixelRatio: 1.5, shafts: false });
});

test("reports the active render profile and forwards mica to a unified scene", () => {
  let mica = null;
  const profile = Object.freeze({ suppressBloom: true });
  const manager = createSceneManager(new THREE.Scene(), {
    factories: {
      sky: () => fakeScene("sky", {
        profile,
        setMicaEnabled(value) { mica = value; },
      }),
    },
    reportFailure() {},
  });

  assert.equal(manager.getActiveSceneProfile(), profile);
  manager.setMicaEnabled(false);
  assert.equal(mica, false);
});

test("exposes an unavailable state when even the sky fallback fails", () => {
  const manager = createSceneManager(new THREE.Scene(), {
    factories: { sky: () => { throw new Error("no WebGL scene"); } },
    reportFailure() {},
  });

  assert.equal(manager.isAvailable(), false);
  assert.deepEqual(manager.getHealth().failed, ["sky"]);
});

test("becomes unavailable when the active sky fails during a frame", () => {
  const manager = createSceneManager(new THREE.Scene(), {
    factories: { sky: () => fakeScene("sky", { update() { throw new Error("sky frame failed"); } }) },
    reportFailure() {},
  });

  manager.update(1 / 60, 1, null);

  assert.equal(manager.isAvailable(), false);
  assert.deepEqual(manager.getHealth().failures, [
    { name: "sky", phase: "frame update", message: "sky frame failed" },
  ]);
});

test("configuration hook failure keeps 3D alive by switching the active scene to sky", () => {
  let viewportCalls = 0;
  const reports = [];
  const manager = createSceneManager(new THREE.Scene(), {
    factories: {
      sky: () => fakeScene("sky"),
      forest: () => fakeScene("forest", {
        setViewportAspect() {
          viewportCalls++;
          if (viewportCalls > 1) throw new Error("forest viewport failed");
        },
      }),
    },
    reportFailure: (...args) => reports.push(args),
  });

  assert.equal(manager.switchScene("forest"), "forest");
  assert.equal(manager.isAvailable(), true);

  manager.setViewportAspect(0.5);

  assert.equal(manager.getActiveSceneName(), "sky");
  assert.equal(manager.isAvailable(), true);
  assert.deepEqual(manager.getHealth().failed, ["forest"]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0][1], "viewport update");
});
