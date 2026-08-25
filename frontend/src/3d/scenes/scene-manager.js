import * as THREE from "three";
import { createCoastScene } from "./coast-scene.js";
import { createCityScene } from "./city-scene.js";
import { createForestScene } from "./forest-scene.js";

const FALLBACK_SCENE = "sky";
const EMPTY_SCENE_PROFILE = Object.freeze({});
const SCENE_FACTORIES = {
  sky: createCoastScene,
  city: createCityScene,
  forest: createForestScene,
};

function defaultFailureReporter(name, phase, error) {
  console.error(`[AethelDesk 3D] ${name} scene failed during ${phase}; using the sky fallback.`, error);
}

export function createSceneManager(
  sceneRoot,
  { factories = SCENE_FACTORIES, reportFailure = defaultFailureReporter } = {},
) {
  const sceneGroup = new THREE.Group();
  sceneRoot.add(sceneGroup);

  // Scene modules stay in the bundle, but their geometry, textures and
  // materials are constructed only when first selected. City alone builds a
  // large merged skyline; deferring it materially lowers mobile startup work.
  const scenes = {};
  const failedScenes = new Set();
  const failureDetails = new Map();
  const reportedFailures = new Set();
  const lightDirection = new THREE.Vector3(0.3, 0.4, -0.86);
  let hasLightDirection = false;
  let micaEnabled = true;
  let shaftsEnabled = true;
  let viewportAspect = 16 / 9;
  let pixelRatio = 1;
  let activeSceneName = FALLBACK_SCENE;
  let requestedSceneName = FALLBACK_SCENE;
  let lastCelestial = null;
  let lastAtmosphere = null;

  function reportOnce(name, phase, error) {
    const key = `${name}:${phase}`;
    if (reportedFailures.has(key)) return;
    reportedFailures.add(key);
    reportFailure(name, phase, error);
  }

  function markFailed(name, phase, error) {
    failedScenes.add(name);
    if (!failureDetails.has(name)) {
      failureDetails.set(name, { name, phase, message: error instanceof Error ? error.message : String(error) });
    }
    if (scenes[name]?.group) scenes[name].group.visible = false;
    reportOnce(name, phase, error);
  }

  function ensureScene(name) {
    if (!factories[name] || failedScenes.has(name)) return null;
    if (scenes[name]) return scenes[name];

    try {
      const next = factories[name]();
      if (!next?.group?.isGroup) throw new TypeError(`${name} scene factory returned no THREE.Group`);
      scenes[name] = next;
      next.group.visible = false;
      sceneGroup.add(next.group);
      if (hasLightDirection && next.setLightDirection) next.setLightDirection(lightDirection);
      if (next.setMicaEnabled) next.setMicaEnabled(micaEnabled);
      if (next.setShaftsEnabled) next.setShaftsEnabled(shaftsEnabled);
      if (next.setViewportAspect) next.setViewportAspect(viewportAspect);
      if (next.setPixelRatio) next.setPixelRatio(pixelRatio);
      return next;
    } catch (error) {
      markFailed(name, "construction", error);
      return null;
    }
  }

  function invoke(name, phase, callback) {
    if (failedScenes.has(name)) return false;
    try {
      callback();
      return true;
    } catch (error) {
      markFailed(name, phase, error);
      return false;
    }
  }

  function recoverActiveScene() {
    if (!failedScenes.has(activeSceneName) || activeSceneName === FALLBACK_SCENE) return activeSceneName;
    return switchScene(FALLBACK_SCENE, true);
  }

  function prepareScene(name, preserveRequested = false) {
    const requestedName = factories[name] ? name : FALLBACK_SCENE;
    if (!preserveRequested) requestedSceneName = requestedName;
    let next = ensureScene(requestedName);
    let resolvedName = requestedName;

    if (!next && requestedName !== FALLBACK_SCENE) {
      resolvedName = FALLBACK_SCENE;
      next = ensureScene(FALLBACK_SCENE);
    }

    return { requestedName, resolvedName, scene: next };
  }

  function activatePreparedScene(prepared) {
    if (!prepared) return activeSceneName;
    const { resolvedName, scene: next } = prepared;

    for (const [sceneName, scene] of Object.entries(scenes)) {
      scene.group.visible = Boolean(next) && sceneName === resolvedName;
    }
    activeSceneName = resolvedName;

    if (next && lastCelestial && next.updateCelestial) {
      const ok = invoke(resolvedName, "celestial update", () => {
        next.updateCelestial(lastCelestial, lastAtmosphere);
      });
      if (!ok && resolvedName !== FALLBACK_SCENE) return switchScene(FALLBACK_SCENE, true);
    }
    return activeSceneName;
  }

  function withPreparedSceneVisibleForCompilation(prepared, compile) {
    if (typeof compile !== "function") throw new TypeError("A scene compilation callback is required");

    const visibility = new Map();
    for (const scene of Object.values(scenes)) {
      visibility.set(scene.group, scene.group.visible);
      scene.group.visible = false;
    }
    if (prepared?.scene?.group) prepared.scene.group.visible = true;

    try {
      // WebGLRenderer.compileAsync() performs its complete scene/light
      // traversal synchronously before returning the readiness Promise. This
      // brief visibility swap therefore gives it the incoming scene's exact
      // local-light signature without exposing that scene to a render frame.
      return compile();
    } finally {
      for (const [group, wasVisible] of visibility) group.visible = wasVisible;
    }
  }

  function markPreparationFailed(prepared, error) {
    const name = prepared?.resolvedName;
    if (!name || !scenes[name]) return;
    markFailed(name, "shader preparation", error);
    recoverActiveScene();
  }

  function switchScene(name, preserveRequested = false) {
    return activatePreparedScene(prepareScene(name, preserveRequested));
  }

  function updateCelestial(c, atmosphere) {
    lastCelestial = c;
    if (atmosphere) lastAtmosphere = atmosphere;

    for (const [name, scene] of Object.entries(scenes)) {
      if (!scene.updateCelestial || failedScenes.has(name)) continue;
      invoke(name, "celestial update", () => scene.updateCelestial(c, lastAtmosphere));
    }
    recoverActiveScene();
  }

  function update(delta, elapsed, atmosphere) {
    if (atmosphere) lastAtmosphere = atmosphere;
    const active = scenes[activeSceneName];
    if (!active?.update || failedScenes.has(activeSceneName)) return;

    const ok = invoke(activeSceneName, "frame update", () => {
      active.update(delta, elapsed, lastAtmosphere);
    });
    if (!ok && activeSceneName !== FALLBACK_SCENE) {
      const fallbackName = switchScene(FALLBACK_SCENE, true);
      const fallback = scenes[fallbackName];
      if (fallback?.update && !failedScenes.has(fallbackName)) {
        invoke(fallbackName, "frame update", () => fallback.update(delta, elapsed, lastAtmosphere));
      }
    }
  }

  function setLightDirection(dir) {
    lightDirection.copy(dir);
    hasLightDirection = true;
    const active = scenes[activeSceneName];
    if (!active?.setLightDirection || failedScenes.has(activeSceneName)) return;
    const ok = invoke(activeSceneName, "light update", () => active.setLightDirection(lightDirection));
    if (!ok && activeSceneName !== FALLBACK_SCENE) switchScene(FALLBACK_SCENE, true);
  }

  function setMicaEnabled(enabled) {
    micaEnabled = Boolean(enabled);
    for (const [name, scene] of Object.entries(scenes)) {
      if (!scene.setMicaEnabled || failedScenes.has(name)) continue;
      invoke(name, "effect update", () => scene.setMicaEnabled(micaEnabled));
    }
    recoverActiveScene();
  }

  function setShaftsEnabled(enabled) {
    const nextValue = Boolean(enabled);
    if (shaftsEnabled === nextValue) return;
    shaftsEnabled = nextValue;
    for (const [name, scene] of Object.entries(scenes)) {
      if (!scene.setShaftsEnabled || failedScenes.has(name)) continue;
      invoke(name, "effect update", () => scene.setShaftsEnabled(shaftsEnabled));
    }
    recoverActiveScene();
  }

  function setViewportAspect(aspect) {
    if (!Number.isFinite(aspect) || aspect <= 0 || Math.abs(viewportAspect - aspect) < 1e-4) return;
    viewportAspect = aspect;
    for (const [name, scene] of Object.entries(scenes)) {
      if (!scene.setViewportAspect || failedScenes.has(name)) continue;
      invoke(name, "viewport update", () => scene.setViewportAspect(viewportAspect));
    }
    recoverActiveScene();
  }

  function setPixelRatio(ratio) {
    if (!Number.isFinite(ratio) || ratio <= 0 || Math.abs(pixelRatio - ratio) < 1e-4) return;
    pixelRatio = ratio;
    for (const [name, scene] of Object.entries(scenes)) {
      if (!scene.setPixelRatio || failedScenes.has(name)) continue;
      invoke(name, "pixel ratio update", () => scene.setPixelRatio(pixelRatio));
    }
    recoverActiveScene();
  }

  ensureScene(FALLBACK_SCENE);
  switchScene(FALLBACK_SCENE);

  return {
    scenes,
    setLightDirection,
    setMicaEnabled,
    setShaftsEnabled,
    setViewportAspect,
    setPixelRatio,
    prepareScene,
    activatePreparedScene,
    withPreparedSceneVisibleForCompilation,
    markPreparationFailed,
    switchScene,
    updateCelestial,
    update,
    getActiveSceneName: () => activeSceneName,
    getActiveSceneProfile: () => scenes[activeSceneName]?.profile || EMPTY_SCENE_PROFILE,
    isAvailable: () => Boolean(scenes[activeSceneName]?.group && !failedScenes.has(activeSceneName)),
    // Read-only diagnostics for browser smoke tests and support reports.
    getHealth: () => ({
      active: activeSceneName,
      requested: requestedSceneName,
      ready: Object.keys(scenes),
      failed: [...failedScenes],
      failures: [...failureDetails.values()],
    }),
  };
}
