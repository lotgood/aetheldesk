import * as THREE from "three";
import { createSkyScene } from "./sky-scene.js";
import { createCityScene } from "./city-scene.js";
import { createBeachScene } from "./beach-scene.js";
import { createForestScene } from "./forest-scene.js";

export function createSceneManager(sceneRoot) {
  const sceneGroup = new THREE.Group();
  sceneRoot.add(sceneGroup);

  const scenes = {
    sky: createSkyScene(),
    city: createCityScene(),
    beach: createBeachScene(),
    forest: createForestScene(),
  };

  for (const [name, s] of Object.entries(scenes)) {
    sceneGroup.add(s.group);
    s.group.visible = false;
  }

  let activeSceneName = "sky";
  scenes.sky.group.visible = true;

  let lastCelestial = null;
  let lastAtmosphere = null;

  function switchScene(name) {
    if (!scenes[name]) return;
    activeSceneName = name;

    for (const [k, s] of Object.entries(scenes)) {
      s.group.visible = k === name;
    }

    if (lastCelestial && scenes[name].updateCelestial) {
      scenes[name].updateCelestial(lastCelestial, lastAtmosphere);
    }
  }

  function updateCelestial(c, atmosphere) {
    lastCelestial = c;
    if (atmosphere) lastAtmosphere = atmosphere;
    for (const s of Object.values(scenes)) {
      if (s.updateCelestial) s.updateCelestial(c, lastAtmosphere);
    }
  }

  function update(delta, elapsed, atmosphere) {
    if (atmosphere) lastAtmosphere = atmosphere;
    const active = scenes[activeSceneName];
    if (active && active.update) {
      active.update(delta, elapsed, lastAtmosphere);
    }
  }

  function setLightDirection(dir) {
    for (const s of Object.values(scenes)) {
      if (s.setLightDirection) s.setLightDirection(dir);
    }
  }

  function setMicaEnabled(enabled) {
    for (const s of Object.values(scenes)) {
      if (s.setMicaEnabled) s.setMicaEnabled(enabled);
    }
  }

  return {
    scenes,
    setLightDirection,
    setMicaEnabled,
    switchScene,
    updateCelestial,
    update,
    getActiveSceneName: () => activeSceneName,
  };
}
