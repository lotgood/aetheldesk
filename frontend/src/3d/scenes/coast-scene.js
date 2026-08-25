import * as THREE from "three";
import { createSkyScene } from "./sky-scene.js";
import { createBeachScene } from "./beach-scene.js";

// One coherent coast replaces the former choice between an empty cloud deck
// and the shoreline. Each layer keeps its own focused implementation, while
// this adapter presents one scene contract to the manager and guarantees that
// atmosphere, motion and light updates reach both in the same frame.
export function createCoastScene() {
  const group = new THREE.Group();
  group.name = "scene-coast";

  const sky = createSkyScene({ horizonHaze: false });
  const beach = createBeachScene();
  group.add(sky.group, beach.group);

  return {
    group,
    profile: Object.freeze({ suppressBloom: true }),
    updateCelestial(celestial, atmosphere) {
      sky.updateCelestial?.(celestial, atmosphere);
      beach.updateCelestial?.(celestial, atmosphere);
    },
    update(delta, elapsed, atmosphere) {
      sky.update?.(delta, elapsed, atmosphere);
      beach.update?.(delta, elapsed, atmosphere);
    },
    setLightDirection(direction) {
      sky.setLightDirection?.(direction);
      beach.setLightDirection?.(direction);
    },
    setMicaEnabled(enabled) {
      beach.setMicaEnabled?.(enabled);
    },
  };
}
