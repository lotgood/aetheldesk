// ─── 3D Scene Controller & Three.js Integration ──────────────────────────────
import * as THREE from "three";
import {
  readScene,
  storeScene,
  readDisplayQuality,
  storeDisplayQuality,
  readDisplayFX,
  storeDisplayFX,
} from "./src/storage.js";
import { create3DEngine } from "./src/3d/engine.js";
import { createSkyDome } from "./src/3d/sky-dome.js";
import { createCelestialSystem } from "./src/3d/celestial.js";
import { createSceneManager } from "./src/3d/scenes/scene-manager.js";
import { createAtmosphere } from "./src/3d/atmosphere.js";
import { prefersReducedMotion } from "./src/3d/motion.js";
import { createRewardConstellation, REWARD_CONSTELLATION_CAP } from "./src/3d/reward-constellation.js";

export const SCENES = Object.freeze(["sky", "city", "forest"]);
export const SCENE_LABELS = Object.freeze({ sky: "해변 하늘", city: "도시", forest: "숲" });
export function normalizeSceneName(name) {
  // Migrate the retired standalone beach selection into the unified coast.
  if (name === "beach") return "sky";
  return SCENES.includes(name) ? name : "sky";
}
const storedScene = readScene("sky");
let activeScene = normalizeSceneName(storedScene);
if (storedScene !== activeScene) storeScene(activeScene);
let lastCelestial = null;
let lastState = null;

let engine = null;
let sceneContainer = document.body;
let focusActive = false; // drives the camera push-in
let skyDome = null;
let celestial = null;
let sceneManager = null;
let rewardConstellation = null;
let rewardProgress = 0;
let rewardRestActive = false;
let initFailed = false;
let sceneTransitionToken = 0;
let runtimeFallbackScheduled = false;
let sceneMetricPoll = 0;
const sceneChangeListeners = new Set();
const atmosphere = createAtmosphere();
// A celestial body has two positions by design: a camera-composed sprite that
// stays visible, and a hemispherical key-light position that preserves the
// real solar elevation. Post shafts need the former; scene shading needs the
// latter.
const activeVisualLightPosition = new THREE.Vector3();
const activeSceneLightPosition = new THREE.Vector3();

function disposeRewardConstellation() {
  rewardConstellation?.dispose();
  rewardConstellation = null;
}

function positionRewardConstellation() {
  if (!rewardConstellation || !engine) return;
  const aspect = engine.camera.aspect || 16 / 9;
  const viewportHeight = engine.renderer.domElement.clientHeight || window.innerHeight;
  const compactScale = aspect < 0.8 ? 0.52 : viewportHeight <= 480 ? 0.8 : 0.96;
  const worldX = -Math.min(9.6, Math.max(3.2, aspect * 5.1));
  // Keep the earned instrument in front of scene geometry and at a stable
  // screen-space landmark. The previous far-background placement let city
  // towers swallow the reward and reduced it to an unreadable speck.
  rewardConstellation.group.position.set(worldX, aspect < 0.8 ? 10 : 9, 8);
  rewardConstellation.group.scale.setScalar(compactScale);
  rewardConstellation.group.lookAt(engine.camera.position);
}

function syncRewardVisibility() {
  if (!rewardConstellation || !engine) return;
  const aspect = engine.camera.aspect || 16 / 9;
  const viewportHeight = engine.renderer.domElement.clientHeight || window.innerHeight;
  const compactIdle = aspect < 0.8 || viewportHeight <= 480;
  rewardConstellation.group.visible = rewardProgress > 0 && (rewardRestActive || !compactIdle);
}

function createRuntimeRewardConstellation() {
  if (!engine || rewardConstellation) return;
  try {
    rewardConstellation = createRewardConstellation({
      seed: "aetheldesk-return",
      completedSessions: rewardProgress,
      pixelRatio: engine.renderer.getPixelRatio(),
    });
    positionRewardConstellation();
    engine.scene.add(rewardConstellation.group);
    syncRewardVisibility();
  } catch (error) {
    rewardConstellation = null;
    console.error("[AethelDesk 3D] Reward constellation could not be created.", error);
  }
}

function commitActiveScene(
  resolvedName,
  { requestedName = resolvedName, reason = "selection", forcedFallback = false } = {},
) {
  const resolved = normalizeSceneName(resolvedName);
  activeScene = resolved;
  storeScene(resolved);
  document.body.dataset.scene = resolved === "sky" ? "" : resolved;
  // Stock UnrealBloomPass intermittently presents an empty frame when fed the
  // desktop ocean shader. The unified coast owns that ocean now, so preserve
  // the user's preference but gate only this scene; corona, shafts and grading
  // remain active and city/forest restore bloom automatically.
  engine?.setBloomSuppressed(Boolean(sceneManager?.getActiveSceneProfile().suppressBloom));
  const detail = {
    requested: normalizeSceneName(requestedName),
    active: resolved,
    fallback: forcedFallback || resolved !== normalizeSceneName(requestedName),
    reason,
  };
  for (const listener of sceneChangeListeners) listener(detail);
  return resolved;
}

function scheduleRuntime2DFallback() {
  if (runtimeFallbackScheduled || !engine) return;
  runtimeFallbackScheduled = true;
  // Do not dispose the composer from inside its own render callback. The next
  // animation frame safely tears the failed 3D path down and reveals the
  // existing DOM sky fallback.
  requestAnimationFrame(() => {
    runtimeFallbackScheduled = false;
    const requestedScene = activeScene;
    disposeRewardConstellation();
    engine?.destroy();
    engine = null;
    skyDome = null;
    celestial = null;
    sceneManager = null;
    initFailed = true;
    document.body.classList.remove("is-3d");
    commitActiveScene("sky", {
      requestedName: requestedScene,
      reason: "engine-fallback",
      forcedFallback: true,
    });
  });
}

function reconcileManagedScene(reason = "runtime-fallback") {
  if (!sceneManager) return activeScene;
  const resolved = normalizeSceneName(sceneManager.getActiveSceneName());
  if (resolved === activeScene) return resolved;
  return commitActiveScene(resolved, { requestedName: activeScene, reason });
}

function syncSceneMetrics() {
  if (!engine || !sceneManager || !celestial) return;
  const aspect = engine.camera.aspect || 16 / 9;
  const pixelRatio = engine.renderer.getPixelRatio();
  celestial.setViewportAspect(aspect);
  celestial.setPixelRatio(pixelRatio);
  sceneManager.setViewportAspect(aspect);
  sceneManager.setPixelRatio(pixelRatio);
  sceneManager.setShaftsEnabled(engine.getEffectiveFX().shafts);
  rewardConstellation?.setPixelRatio(pixelRatio);
  positionRewardConstellation();
  syncRewardVisibility();
}

function init3D() {
  if (engine || initFailed) return;
  let nextEngine = null;
  try {
    nextEngine = create3DEngine(sceneContainer, {
      onFatal: () => scheduleRuntime2DFallback(),
      // Do not remove the complete 2D sky until WebGL has produced a real
      // composited frame. Scene construction can finish long before a cold
      // driver has compiled the first shader set.
      onFirstFrame: () => {
        if (!initFailed && engine === nextEngine) document.body.classList.add("is-3d");
      },
    });
    nextEngine.setAtmosphere(atmosphere);
    const nextSkyDome = createSkyDome(nextEngine.scene);
    const nextCelestial = createCelestialSystem(nextEngine.scene);
    const nextSceneManager = createSceneManager(nextEngine.scene);
    if (!nextSceneManager.isAvailable()) throw new Error("No renderable 3D fallback scene is available");
    // Persisted display settings apply before the first frame so a
    // low-tier device never renders a frame it cannot afford.
    nextEngine.setQuality(readDisplayQuality());

    engine = nextEngine;
    skyDome = nextSkyDome;
    celestial = nextCelestial;
    sceneManager = nextSceneManager;
    const savedFX = readDisplayFX();
    if (savedFX) applyFX(savedFX);
    createRuntimeRewardConstellation();
    syncSceneMetrics();

    const requestedScene = activeScene;
    const resolvedScene = sceneManager.switchScene(requestedScene);
    commitActiveScene(resolvedScene, {
      requestedName: requestedScene,
      reason: resolvedScene === requestedScene ? "initialization" : "construction-fallback",
    });

    engine.onTick((delta, elapsed) => {
      atmosphere.update(delta);
      sceneMetricPoll += delta;
      if (sceneMetricPoll >= 0.5) {
        sceneMetricPoll = 0;
        syncSceneMetrics();
      }
      const grade = atmosphere.current;

      // Aerial perspective + filmic exposure follow the same grade as the sky.
      engine.scene.fog.color.copy(grade.fog);
      engine.scene.fog.density = grade.fogDensity;
      engine.renderer.toneMappingExposure = grade.exposure;

      skyDome.update(delta, elapsed, atmosphere);
      celestial.update(delta, elapsed, atmosphere);
      sceneManager.update(delta, elapsed, atmosphere);
      rewardConstellation?.update(delta, elapsed);

      if (!sceneManager.isAvailable()) {
        scheduleRuntime2DFallback();
        return;
      }

      if (celestial.sunGroup) {
        skyDome.setSunPosition(celestial.sunGroup.position);
        // Palette, props and celestial opacity all ease between time states;
        // the active light direction must follow the same curve. Selecting a
        // raw sun/moon endpoint at elevation 0 made shadows, water glitter and
        // shafts jump across the entire sky during a time-slider change.
        activeVisualLightPosition
          .copy(celestial.moonGroup.position)
          .lerp(celestial.sunGroup.position, atmosphere.daylight);
        activeSceneLightPosition
          .copy(celestial.moonLight.position)
          .lerp(celestial.sunLight.position, atmosphere.daylight);
        // Scenes that do their own specular (water glitter, sand mica) need
        // the physical light direction, not the perspective-compressed sprite
        // location used to keep the celestial body inside the frame.
        sceneManager.setLightDirection(activeSceneLightPosition);
        // The shafts pass needs the same body in screen space.
        engine.setLightSource(activeVisualLightPosition);
        engine.setShadowSource(celestial.keyLight);
      }
      if (!sceneManager.isAvailable()) {
        scheduleRuntime2DFallback();
        return;
      }
      reconcileManagedScene();

      // Cinematic push-in while a focus/break session is running
      const reducedMotion = prefersReducedMotion();
      const targetFov = focusActive && !reducedMotion ? 52.5 : 55;
      if (Math.abs(engine.camera.fov - targetFov) > 0.02) {
        engine.camera.fov = reducedMotion
          ? targetFov
          : engine.camera.fov + (targetFov - engine.camera.fov) * (1 - Math.exp(-2.6 * delta));
        engine.camera.updateProjectionMatrix();
      }
    });
  } catch (err) {
    initFailed = true;
    disposeRewardConstellation();
    nextEngine?.destroy();
    engine = null;
    skyDome = null;
    celestial = null;
    sceneManager = null;
    commitActiveScene("sky", {
      requestedName: activeScene,
      reason: "engine-fallback",
    });
    document.body.classList.remove("is-3d");
    console.error("Failed to initialize 3D Engine:", err);
  }
}

document.body.dataset.scene = activeScene === "sky" ? "" : activeScene;

async function switchScene(name) {
  const requestedName = normalizeSceneName(name);
  const token = ++sceneTransitionToken;
  if (requestedName === activeScene && sceneManager) {
    if (engine?.canvas) engine.canvas.style.opacity = "1";
    return activeScene;
  }

  const transitionEngine = engine;
  const transitionManager = sceneManager;
  if (!transitionEngine || !transitionManager) {
    const resolvedName = sceneManager ? sceneManager.switchScene(requestedName) : "sky";
    const reason = !sceneManager
      ? "engine-fallback"
      : resolvedName === requestedName
        ? "selection"
        : "construction-fallback";
    commitActiveScene(resolvedName, { requestedName, reason });
    if (lastCelestial) {
      renderScene(lastCelestial, lastState);
    }
    return resolvedName;
  }

  const isCurrentTransition = () =>
    token === sceneTransitionToken
    && engine === transitionEngine
    && sceneManager === transitionManager
    && transitionEngine.isOperational();

  const canvas = transitionEngine.canvas;
  canvas.style.transition = "opacity 0.25s ease";
  canvas.style.opacity = "1";

  let prepared = transitionManager.prepareScene(requestedName);
  try {
    if (prepared.scene?.group) {
      // Compile materials against the incoming scene's exact local-light
      // signature. The manager swaps group visibility only for Three's
      // synchronous traversal, then immediately restores the live scene while
      // KHR_parallel_shader_compile finishes in the background.
      const compilation = transitionManager.withPreparedSceneVisibleForCompilation(prepared, () =>
        // Compile the complete root while only the incoming scene group is
        // visible. That gives Three the final light counts exactly once,
        // including the forest's local fire light.
        transitionEngine.renderer.compileAsync(transitionEngine.scene, transitionEngine.camera),
      );
      await compilation;
    }
  } catch (error) {
    if (!isCurrentTransition()) return activeScene;
    console.error(`[AethelDesk 3D] ${requestedName} scene failed during shader preparation.`, error);
    transitionManager.markPreparationFailed(prepared, error);
    if (!transitionManager.isAvailable()) {
      scheduleRuntime2DFallback();
      return "sky";
    }
    prepared = transitionManager.prepareScene("sky", true);
  }

  if (!isCurrentTransition()) return activeScene;

  // Dim only after the incoming programs are ready. Commit, render, and wait
  // for the following display turn before restoring full opacity, so a lazy
  // scene can never expose an unrendered canvas.
  if (!prefersReducedMotion()) {
    canvas.style.opacity = "0.78";
    await new Promise(resolve => setTimeout(resolve, 80));
    if (!isCurrentTransition()) return transitionEngine.isOperational() ? activeScene : "sky";
  }

  const stableRender = transitionEngine.afterNextStableRender();
  const resolvedName = transitionManager.activatePreparedScene(prepared);
  const reason = resolvedName === requestedName ? "selection" : "construction-fallback";
  commitActiveScene(resolvedName, { requestedName, reason });
  if (lastCelestial) renderScene(lastCelestial, lastState);
  const frameReady = await stableRender;

  if (!frameReady || !isCurrentTransition()) return transitionEngine.isOperational() ? activeScene : "sky";
  canvas.style.opacity = "1";
  return resolvedName;
}

function renderScene(c, state) {
  lastCelestial = c;
  if (state) lastState = state;

  if (!engine) init3D();

  if (c && typeof c.elevation === "number") atmosphere.setElevation(c.elevation);

  if (skyDome && celestial) {
    skyDome.setSunPosition(celestial.sunGroup.position);
  }
  if (celestial) {
    celestial.updateCelestialState(c);
    if (state) celestial.updatePomodoro(state);
  }
  if (sceneManager) {
    sceneManager.updateCelestial(c, atmosphere);
    if (sceneManager.isAvailable()) reconcileManagedScene();
    else scheduleRuntime2DFallback();
  }
  if (c && Number.isFinite(c.elevation)) engine?.markContentReady();
}

function resetForResize() {
  if (engine) {
    engine.resize();
    positionRewardConstellation();
  }
}

function updateReward({ completedSessions = 0, reveal = false, active = false } = {}) {
  rewardProgress = Number.isFinite(completedSessions)
    ? Math.max(0, Math.min(REWARD_CONSTELLATION_CAP, Math.trunc(completedSessions)))
    : 0;
  rewardRestActive = Boolean(active);
  rewardConstellation?.setCompletedSessions(rewardProgress, { reveal: Boolean(reveal) });
  syncRewardVisibility();
}

function destroy() {
  sceneTransitionToken += 1;
  runtimeFallbackScheduled = false;
  disposeRewardConstellation();
  engine?.destroy();
  engine = null;
  skyDome = null;
  celestial = null;
  sceneManager = null;
  initFailed = true;
  document.body.classList.remove("is-3d");
}

// FX toggles split by owner: the engine/post own bloom, shafts, shadows and
// grain; mica lives in the beach scene and goes through the scene manager.
function applyFX(fx) {
  if (!fx) return;
  const { mica, ...engineFX } = fx;
  if (engine) engine.setFX(engineFX);
  if (typeof mica === "boolean" && sceneManager) sceneManager.setMicaEnabled(mica);
  if (engine && sceneManager) sceneManager.setShaftsEnabled(engine.getEffectiveFX().shafts);
}

export function createSceneController({ container = document.body } = {}) {
  sceneContainer = container;
  init3D();

  return {
    render: renderScene,
    updatePomodoro: (state) => {
      lastState = state;
      focusActive = !!(state.focus || state.break);
      if (celestial) celestial.updatePomodoro(state);
    },
    updateReward,
    resetForResize,
    switchScene,
    getActiveScene: () => activeScene,
    onSceneChange: (listener) => {
      sceneChangeListeners.add(listener);
      return () => sceneChangeListeners.delete(listener);
    },
    getEngine: () => engine,
    getRewardDiagnostics: () => rewardConstellation?.getDiagnostics() || {
      completedSessions: rewardProgress,
      disposed: true,
    },
    getSceneHealth: () => sceneManager?.getHealth() || {
      active: activeScene,
      ready: [],
      failed: initFailed ? ["engine"] : [],
    },
    setQuality: (name) => {
      storeDisplayQuality(name);
      if (engine) {
        engine.setQuality(name);
        syncSceneMetrics();
      }
    },
    getQuality: () => (engine ? engine.getQuality() : { mode: readDisplayQuality(), tier: null }),
    setFXOptions: (fx) => {
      storeDisplayFX(fx);
      applyFX(fx);
    },
    getFXOptions: () => readDisplayFX() || {},
    getPreferredFX: () => (engine
      ? engine.getPreferredFX()
      : { bloom: true, shafts: true, grain: 1, shadows: true }),
    // Effective state for the settings UI: user override where present,
    // the active tier's default otherwise. Mica is scene-side, default on.
    getEffectiveFX: () => {
      const stored = readDisplayFX() || {};
      const base = engine
        ? engine.getEffectiveFX()
        : { bloom: true, shafts: true, grain: 1, shadows: true };
      return { ...base, mica: stored.mica ?? true };
    },
    destroy,
  };
}
