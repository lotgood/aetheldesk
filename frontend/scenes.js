import { readScene, storeScene } from "./src/storage.js";
import { createBeachScene } from "./src/scenes/beach.js";
import { createCityScene } from "./src/scenes/city.js";
import { createForestScene } from "./src/scenes/forest.js";
import { prefersReducedMotion } from "./src/scenes/shared.js";


export const SCENES = ["sky", "city", "beach", "forest"];
const SCENE_LABELS = { sky: "하늘", city: "도시", beach: "해변", forest: "숲" };
const SCENE_OPTION_TEXT = SCENES.map(scene => SCENE_LABELS[scene]).join(", ");

let activeScene = readScene("sky");
let lastCelestial = null;
const sceneRenderers = {
  city: createCityScene({ isActive: () => activeScene === "city", prefersReducedMotion }),
  beach: createBeachScene({ prefersReducedMotion }),
  forest: createForestScene({ prefersReducedMotion }),
};


function initSceneButton() {
  updateSceneControl(activeScene);
}


function updateSceneControl(name) {
  const btn = document.getElementById("btn-scene");
  if (btn) {
    btn.textContent = `◈ ${SCENE_LABELS[name]}`;
    btn.dataset.activeScene = name;
    btn.setAttribute("aria-label", `장면 바꾸기: ${SCENE_LABELS[name]}`);
    btn.setAttribute("aria-describedby", "scene-options");
  }
  const options = document.getElementById("scene-options");
  if (options) {
    options.textContent = `장면: ${SCENE_OPTION_TEXT}. 현재 선택은 ${SCENE_LABELS[name]}입니다.`;
  }
  document.body.dataset.scene = name === "sky" ? "" : name;
}


function stopScene(name) {
  sceneRenderers[name]?.stop();
}


function stopAllScenes() {
  SCENES.forEach(scene => stopScene(scene));
}


function resetSceneState() {
  Object.values(sceneRenderers).forEach(scene => scene.reset());
}


function sceneCanvas(name) {
  return document.getElementById(`${name}-canvas`);
}


function renderScene(c) {
  lastCelestial = c;
  if (activeScene === "sky") return;

  const canvas = sceneCanvas(activeScene);
  const renderer = sceneRenderers[activeScene];
  if (!canvas || !renderer) return;

  if (!canvas._started) {
    canvas._started = true;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    renderer.start(canvas, c);
    canvas.style.opacity = "1";
  } else {
    renderer.update(c);
  }
}


function switchScene(name) {
  stopAllScenes();
  resetSceneState();
  SCENES.filter(scene => scene !== "sky").forEach(scene => {
    const canvas = sceneCanvas(scene);
    if (canvas) {
      canvas.style.opacity = "0";
      canvas._started = false;
    }
  });
  activeScene = name;
  storeScene(name);
  updateSceneControl(name);
  const status = document.getElementById("room-status");
  if (status) status.textContent = `${SCENE_LABELS[name]} 장면으로 바꿨습니다.`;
  if (name !== "sky" && lastCelestial) renderScene(lastCelestial);
}


function bindSceneButton() {
  document.getElementById("btn-scene")?.addEventListener("click", () => {
    switchScene(SCENES[(SCENES.indexOf(activeScene) + 1) % SCENES.length]);
  });
}


function resetForResize() {
  if (activeScene === "sky") return;
  stopAllScenes();
  sceneRenderers[activeScene]?.reset();
  const canvas = sceneCanvas(activeScene);
  if (canvas) canvas._started = false;
}


initSceneButton();


export function createSceneController() {
  bindSceneButton();
  return {
    render: renderScene,
    resetForResize,
    switchScene,
    getActiveScene: () => activeScene,
  };
}
