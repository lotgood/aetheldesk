import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";

import {
  REWARD_CONSTELLATION_CAP,
  buildRewardConstellationLayout,
  createRewardConstellation,
} from "../../frontend/src/3d/reward-constellation.js";

const SOURCE = readFileSync(
  new URL("../../frontend/src/3d/reward-constellation.js", import.meta.url),
  "utf8",
);

test("seeded constellation layout is stable, bounded and independent of Math.random", () => {
  const first = buildRewardConstellationLayout("room-a:cycle-7");
  const replay = buildRewardConstellationLayout("room-a:cycle-7");
  const different = buildRewardConstellationLayout("room-a:cycle-8");

  assert.equal(first.length, REWARD_CONSTELLATION_CAP);
  assert.deepEqual(first, replay);
  assert.notDeepEqual(first, different);
  assert.ok(Object.isFrozen(first));
  assert.doesNotMatch(SOURCE, /Math\.random/);
  assert.doesNotMatch(SOURCE, /document\.|localStorage|sessionStorage|WebSocket/);

  for (const point of first) {
    assert.ok(Object.isFrozen(point));
    assert.ok(Math.hypot(point.x, point.y / 0.78) >= 0.7);
    assert.ok(Math.hypot(point.x, point.y / 0.78) <= 0.94);
    assert.ok(point.strength >= 0.78 && point.strength <= 1);
    assert.ok(point.size >= 5.4 && point.size <= 7.6);
  }
});

test("one through four sessions reveal stars, links and astrarium reward nodes", () => {
  const reward = createRewardConstellation({ seed: 42, completedSessions: 1, pixelRatio: 3 });

  assert.ok(reward.group.isGroup);
  assert.equal(reward.group.name, "reward-constellation-return");
  assert.equal(reward.group.children.length, 3);
  assert.ok(reward.group.getObjectByName("reward-constellation-stars").isPoints);
  assert.ok(reward.group.getObjectByName("reward-constellation-links").isLineSegments);
  assert.ok(reward.group.getObjectByName("reward-constellation-brass-ring").isMesh);

  const first = reward.getDiagnostics();
  assert.equal(first.completedSessions, 1);
  assert.equal(first.starDrawCount, 1);
  assert.equal(first.lineDrawCount, 0);
  assert.equal(first.pixelRatio, 2);
  assert.equal(first.activeNodeCount, 1);
  assert.ok(first.drawCalls >= 20 && first.drawCalls <= 24);
  assert.ok(first.triangles > 1_000 && first.triangles <= 12_000);
  assert.ok(reward.group.getObjectByName("aethel-astrarium-celestial-core").isMesh);
  assert.ok(reward.group.getObjectByName("aethel-astrarium-oblique-ring").isMesh);
  assert.equal(reward.group.getObjectByName("aethel-astrarium-node-1-star").visible, true);
  assert.equal(reward.group.getObjectByName("aethel-astrarium-node-2-star").visible, false);

  reward.setCompletedSessions(2);
  assert.deepEqual(
    [reward.getDiagnostics().starDrawCount, reward.getDiagnostics().lineDrawCount],
    [2, 2],
  );

  reward.setCompletedSessions(3);
  assert.deepEqual(
    [reward.getDiagnostics().starDrawCount, reward.getDiagnostics().lineDrawCount],
    [3, 4],
  );

  const partialRingGlow = reward.group.getObjectByName("reward-constellation-brass-ring").material.emissiveIntensity;
  reward.setCompletedSessions(4);
  const complete = reward.getDiagnostics();
  assert.equal(complete.starDrawCount, 4);
  assert.equal(complete.lineDrawCount, 8);
  assert.equal(complete.activeNodeCount, 4);
  assert.ok(reward.group.getObjectByName("reward-constellation-brass-ring").material.emissiveIntensity > partialRingGlow);
  assert.equal(reward.group.getObjectByName("aethel-astrarium-node-4-star").visible, true);
  assert.equal(reward.setCompletedSessions(99), 4);
});

test("restored progress does not replay reveal energy", () => {
  const reward = createRewardConstellation({ completedSessions: 0 });
  assert.equal(reward.group.visible, false);

  reward.setCompletedSessions(2, { reveal: false });
  assert.equal(reward.group.visible, true);
  assert.equal(reward.getDiagnostics().completedSessions, 2);
  assert.equal(reward.getDiagnostics().revealEnergy, 0);

  reward.setCompletedSessions(3, { reveal: true });
  assert.equal(reward.getDiagnostics().completedSessions, 3);
  assert.equal(reward.getDiagnostics().revealEnergy, 1);
});

test("decorative motion freezes under reduced motion without replacing render resources", () => {
  const reward = createRewardConstellation({ seed: "motion", completedSessions: 4 });
  const stars = reward.group.getObjectByName("reward-constellation-stars");
  const links = reward.group.getObjectByName("reward-constellation-links");
  const ring = reward.group.getObjectByName("reward-constellation-brass-ring");
  const polarRing = reward.group.getObjectByName("aethel-astrarium-polar-ring");
  const resources = [stars.geometry, stars.material, links.geometry, links.material, ring.geometry, ring.material, polarRing.geometry, polarRing.material];
  const initialPolarRotation = polarRing.rotation.y;

  reward.update(1, 1, true);
  const reduced = reward.getDiagnostics();
  assert.equal(reduced.motionTime, 0);
  assert.equal(reduced.revealEnergy, 0);
  assert.equal(ring.rotation.z, 0);
  assert.equal(polarRing.rotation.y, initialPolarRotation);

  for (let frame = 0; frame < 120; frame++) reward.update(1 / 60, frame / 60, false);
  const moving = reward.getDiagnostics();
  assert.ok(moving.motionTime > 1.9);
  assert.notEqual(polarRing.rotation.y, initialPolarRotation);
  assert.deepEqual(
    [stars.geometry, stars.material, links.geometry, links.material, ring.geometry, ring.material, polarRing.geometry, polarRing.material],
    resources,
  );

  const frozenTime = moving.motionTime;
  const frozenRotation = polarRing.rotation.y;
  reward.update(2, 4, true);
  assert.equal(reward.getDiagnostics().motionTime, frozenTime);
  assert.equal(polarRing.rotation.y, frozenRotation);

  const updateSource = SOURCE.split("function update(", 2)[1].split("function getDiagnostics", 1)[0];
  assert.doesNotMatch(updateSource, /new THREE\.|new Float32Array|\[\.\.\.|Array\.from/);
});

test("dispose releases every owned GPU resource exactly once", () => {
  const scene = new THREE.Scene();
  const reward = createRewardConstellation({ seed: "dispose", completedSessions: 4 });
  scene.add(reward.group);

  const resources = [];
  const seen = new Set();
  reward.group.traverse(object => {
    for (const resource of [object.geometry, object.material]) {
      if (!resource || seen.has(resource)) continue;
      seen.add(resource);
      resources.push(resource);
    }
  });
  const disposeCounts = new Map(resources.map(resource => [resource, 0]));
  for (const resource of resources) {
    resource.addEventListener("dispose", () => disposeCounts.set(resource, disposeCounts.get(resource) + 1));
  }

  reward.dispose();
  reward.dispose();

  assert.equal(reward.group.parent, null);
  assert.equal(reward.group.children.length, 0);
  assert.equal(reward.getDiagnostics().disposed, true);
  for (const count of disposeCounts.values()) assert.equal(count, 1);

  reward.update(10, 10, false);
  assert.equal(reward.getDiagnostics().motionTime, 0);
});
