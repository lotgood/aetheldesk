// ─── 3D Scene Controller & Three.js Integration ──────────────────────────────
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
import { createSpatialAudio } from "./src/3d/spatial-audio.js";
import { createAtmosphere } from "./src/3d/atmosphere.js";

export const SCENES = ["sky", "city", "beach", "forest"];
const SCENE_LABELS = { sky: "하늘", city: "도시", beach: "해변", forest: "숲" };
let activeScene = readScene("sky");
let lastCelestial = null;
let lastState = null;

let engine = null;
let focusActive = false; // drives the camera push-in
let skyDome = null;
let celestial = null;
let sceneManager = null;
let spatialAudio = null;
const atmosphere = createAtmosphere();
function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function init3D() {
  if (engine) return;
  try {
    engine = create3DEngine(document.body);
    engine.setAtmosphere(atmosphere);
    skyDome = createSkyDome(engine.scene);
    celestial = createCelestialSystem(engine.scene);
    sceneManager = createSceneManager(engine.scene);
    // Persisted display settings apply before the first frame so a
    // low-tier device never renders a frame it cannot afford.
    engine.setQuality(readDisplayQuality());
    const savedFX = readDisplayFX();
    if (savedFX) applyFX(savedFX);
    spatialAudio = createSpatialAudio();

    sceneManager.switchScene(activeScene);

    // Every 3D layer built successfully: only now hide the legacy 2D
    // sun/moon/stars/clouds overlays. Flipping this before construction
    // would leave a blank void whenever a scene throws.
    document.body.classList.add("is-3d");

    engine.onTick((delta, elapsed) => {
      atmosphere.update(delta);
      const grade = atmosphere.current;

      // Aerial perspective + filmic exposure follow the same grade as the sky.
      engine.scene.fog.color.copy(grade.fog);
      engine.scene.fog.density = grade.fogDensity;
      engine.renderer.toneMappingExposure = grade.exposure;

      skyDome.update(delta, elapsed, atmosphere);
      celestial.update(delta, elapsed, atmosphere);
      sceneManager.update(delta, elapsed, atmosphere);

    if (celestial.sunGroup) {
      skyDome.setSunPosition(celestial.sunGroup.position);
      const lightPos = atmosphere.isNight ? celestial.moonGroup.position : celestial.sunGroup.position;
      // Scenes that do their own specular (water glitter, sand mica) need
      // the live light direction, not just the graded colours.
      sceneManager.setLightDirection(lightPos);
      // The shafts pass needs the same body in screen space.
      engine.setLightSource(lightPos);
    }

      // Cinematic push-in while a focus/break session is running
      const targetFov = focusActive ? 52.5 : 55;
      if (Math.abs(engine.camera.fov - targetFov) > 0.02) {
        engine.camera.fov += (targetFov - engine.camera.fov) * (1 - Math.exp(-2.6 * delta));
        engine.camera.updateProjectionMatrix();
      }
    });
  } catch (err) {
    console.error("Failed to initialize 3D Engine:", err);
  }
}

(function initSceneBtn() {
  const btn = document.getElementById("btn-scene");
  if (btn) {
    btn.textContent = `◈ ${SCENE_LABELS[activeScene]}`;
    btn.setAttribute("aria-label", `장면 바꾸기: ${SCENE_LABELS[activeScene]}`);
  }
  document.body.dataset.scene = activeScene === "sky" ? "" : activeScene;
})();

function switchScene(name) {
  if (!SCENES.includes(name)) return;

  const apply = () => {
    activeScene = name;
    storeScene(name);
    document.body.dataset.scene = name === "sky" ? "" : name;

    const btn = document.getElementById("btn-scene");
    if (btn) {
      btn.textContent = `◈ ${SCENE_LABELS[name]}`;
      btn.setAttribute("aria-label", `장면 바꾸기: ${SCENE_LABELS[name]}`);
    }
    const status = document.getElementById("room-status");
    if (status) status.textContent = `${SCENE_LABELS[name]} 장면으로 바꿨습니다.`;

    if (sceneManager) {
      sceneManager.switchScene(name);
    }
    if (spatialAudio) {
      spatialAudio.startSceneAmbience(name);
    }
    if (lastCelestial) {
      renderScene(lastCelestial, lastState);
    }
  };

  // Quick dim-and-reveal so scene swaps read as a crossfade instead of a cut.
  if (!engine || prefersReducedMotion()) {
    apply();
    return;
  }
  const canvas = engine.canvas;
  canvas.style.transition = "opacity 0.25s ease";
  canvas.style.opacity = "0.3";
  setTimeout(() => {
    apply();
    canvas.style.opacity = "1";
  }, 170);
}

function bindSceneButton() {
  document.getElementById("btn-scene")?.addEventListener("click", () => {
    switchScene(SCENES[(SCENES.indexOf(activeScene) + 1) % SCENES.length]);
  });
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
  }
}

function resetForResize() {
  if (engine) engine.resize();
}

// FX toggles split by owner: the engine/post own bloom, shafts, shadows and
// grain; mica lives in the beach scene and goes through the scene manager.
function applyFX(fx) {
  if (!fx) return;
  const { mica, ...engineFX } = fx;
  if (engine) engine.setFX(engineFX);
  if (typeof mica === "boolean" && sceneManager) sceneManager.setMicaEnabled(mica);
}

export function createSceneController() {
  init3D();
  bindSceneButton();

  return {
    render: renderScene,
    updatePomodoro: (state) => {
      lastState = state;
      focusActive = !!(state.focus || state.break);
      if (celestial) celestial.updatePomodoro(state);
    },
    resetForResize,
    switchScene,
    getActiveScene: () => activeScene,
    getEngine: () => engine,
    getSpatialAudio: () => spatialAudio,
    setQuality: (name) => {
      storeDisplayQuality(name);
      if (engine) engine.setQuality(name);
    },
    getQuality: () => (engine ? engine.getQuality() : { mode: readDisplayQuality(), tier: null }),
    setFXOptions: (fx) => {
      storeDisplayFX(fx);
      applyFX(fx);
    },
    getFXOptions: () => readDisplayFX() || {},
    // Effective state for the settings UI: user override where present,
    // the active tier's default otherwise. Mica is scene-side, default on.
    getEffectiveFX: () => {
      const stored = readDisplayFX() || {};
      const base = engine
        ? engine.getEffectiveFX()
        : { bloom: true, shafts: true, grain: 1, shadows: true };
      return { ...base, mica: stored.mica ?? true };
    },
  };
}









