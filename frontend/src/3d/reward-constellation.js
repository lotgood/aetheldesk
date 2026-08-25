import * as THREE from "three";
import { prefersReducedMotion } from "./motion.js";

export const REWARD_CONSTELLATION_CAP = 4;

const TAU = Math.PI * 2;
const CORE_RADIUS = 0.61;
const OUTER_RADIUS = 1.17;
const NODE_RADIUS = 1.105;
const EDGE_ORDER = Object.freeze([
  Object.freeze([0, 1]),
  Object.freeze([1, 2]),
  Object.freeze([2, 3]),
  Object.freeze([3, 0]),
]);
const NODE_LAYOUT = Object.freeze([
  Object.freeze({ x: 0, y: NODE_RADIUS, rotation: 0 }),
  Object.freeze({ x: NODE_RADIUS, y: 0, rotation: -Math.PI / 2 }),
  Object.freeze({ x: 0, y: -NODE_RADIUS, rotation: Math.PI }),
  Object.freeze({ x: -NODE_RADIUS, y: 0, rotation: Math.PI / 2 }),
]);

function hashSeed(seed) {
  const text = String(seed ?? "aethel-return");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function createSeededRandom(seed) {
  let state = hashSeed(seed) || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function clampCompletedSessions(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(REWARD_CONSTELLATION_CAP, Math.trunc(value)));
}

/** Build one stable four-star return mark for a room/session seed. */
export function buildRewardConstellationLayout(seed = "aethel-return") {
  const random = createSeededRandom(seed);
  const baseAngle = random() * TAU;
  const mirror = random() < 0.5 ? -1 : 1;
  const layout = [];

  for (let i = 0; i < REWARD_CONSTELLATION_CAP; i++) {
    const angle = baseAngle + mirror * (i * TAU / REWARD_CONSTELLATION_CAP + (random() - 0.5) * 0.24);
    const radius = 0.72 + random() * 0.2;
    layout.push(Object.freeze({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.78,
      z: 0.018 + i * 0.003,
      strength: 0.78 + random() * 0.22,
      size: 5.4 + random() * 2.2,
    }));
  }

  return Object.freeze(layout);
}

function makeAnnularBandGeometry({ outerRadius, width, depth, segments = 72 }) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outerRadius, 0, TAU, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, outerRadius - width, 0, TAU, true);
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    curveSegments: segments,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: Math.min(width * 0.12, 0.008),
    bevelThickness: Math.min(depth * 0.16, 0.006),
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return geometry;
}

function makeEightPointStarGeometry(radius = 0.083) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 16; i++) {
    const angle = Math.PI / 2 - i * Math.PI / 8;
    const length = i % 2 === 0 ? radius : radius * 0.38;
    const x = Math.cos(angle) * length;
    const y = Math.sin(angle) * length;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.018,
    steps: 1,
    bevelEnabled: true,
    bevelSegments: 1,
    bevelSize: 0.006,
    bevelThickness: 0.005,
  });
  geometry.translate(0, 0, -0.009);
  geometry.computeVertexNormals();
  return geometry;
}

function sphereFrontZ(x, y, offset = 0.012) {
  return Math.sqrt(Math.max(0, CORE_RADIUS * CORE_RADIUS - x * x - y * y)) + offset;
}

function makeStarMaterial() {
  return new THREE.ShaderMaterial({
    name: "reward-constellation-stars",
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0.9 },
      uPixelRatio: { value: 1 },
      uBrass: { value: new THREE.Color(0xc78a3b) },
      uIvory: { value: new THREE.Color(0xffe7b0) },
    },
    vertexShader: /* glsl */`
      attribute float aStrength;
      attribute float aSize;
      varying float vStrength;
      uniform float uTime;
      uniform float uPixelRatio;

      void main() {
        vStrength = aStrength;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float breath = 1.0 + sin(uTime * 1.35 + aStrength * 7.0) * 0.08;
        gl_PointSize = clamp(aSize * uPixelRatio * breath, 2.0, 18.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: /* glsl */`
      varying float vStrength;
      uniform float uOpacity;
      uniform vec3 uBrass;
      uniform vec3 uIvory;

      void main() {
        float distanceFromCenter = length(gl_PointCoord - vec2(0.5)) * 2.0;
        if (distanceFromCenter > 1.0) discard;
        float halo = pow(max(0.0, 1.0 - distanceFromCenter), 2.2);
        float core = smoothstep(0.34, 0.0, distanceFromCenter);
        vec3 color = mix(uBrass, uIvory, core);
        gl_FragColor = vec4(color, (halo * 0.58 + core) * vStrength * uOpacity);
      }
    `,
  });
}

function makeAstrariumMaterials() {
  const brass = new THREE.MeshPhysicalMaterial({
    name: "aethel-astrarium-antique-brass",
    color: 0xbd7e3a,
    emissive: 0x5a2d0a,
    emissiveIntensity: 0.24,
    metalness: 0.7,
    roughness: 0.3,
    clearcoat: 0.12,
    clearcoatRoughness: 0.26,
    envMapIntensity: 0.82,
  });
  const outerBrass = brass.clone();
  outerBrass.name = "aethel-astrarium-outer-brass";
  const darkBrass = brass.clone();
  darkBrass.name = "aethel-astrarium-dark-brass";
  darkBrass.color.setHex(0x5e3918);
  darkBrass.roughness = 0.4;
  const enamel = new THREE.MeshPhysicalMaterial({
    name: "aethel-astrarium-midnight-enamel",
    color: 0x0a223a,
    emissive: 0x031424,
    emissiveIntensity: 0.26,
    metalness: 0,
    roughness: 0.29,
    clearcoat: 0.72,
    clearcoatRoughness: 0.16,
    envMapIntensity: 0.68,
  });
  return { brass, outerBrass, darkBrass, enamel };
}

function createCoreConstellation() {
  const group = new THREE.Group();
  group.name = "aethel-astrarium-core-relief";
  const points = [
    [-0.37, 0.28], [-0.14, 0.42], [0.1, 0.31], [0.34, 0.4],
    [-0.42, -0.03], [-0.19, 0.09], [0.06, -0.02], [0.31, 0.12],
    [-0.3, -0.31], [-0.02, -0.23], [0.26, -0.34], [0.43, -0.13],
  ];
  const edges = [[0, 1], [1, 2], [2, 3], [0, 4], [4, 5], [5, 6], [6, 7], [5, 8], [8, 9], [9, 10], [7, 11], [10, 11]];
  const linePositions = new Float32Array(edges.length * 6);
  for (let i = 0; i < edges.length; i++) {
    const [fromIndex, toIndex] = edges[i];
    const from = points[fromIndex];
    const to = points[toIndex];
    linePositions.set([
      from[0], from[1], sphereFrontZ(from[0], from[1]),
      to[0], to[1], sphereFrontZ(to[0], to[1]),
    ], i * 6);
  }
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.name = "aethel-astrarium-core-grooves";
  lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
  const lineMaterial = new THREE.LineBasicMaterial({
    name: "aethel-astrarium-core-groove-brass",
    color: 0xb77a31,
    transparent: true,
    opacity: 0.48,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.name = "aethel-astrarium-core-groove-lines";

  const studPositions = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i];
    studPositions.set([x, y, sphereFrontZ(x, y, 0.019)], i * 3);
  }
  const studGeometry = new THREE.BufferGeometry();
  studGeometry.name = "aethel-astrarium-core-studs";
  studGeometry.setAttribute("position", new THREE.BufferAttribute(studPositions, 3));
  const studMaterial = new THREE.PointsMaterial({
    name: "aethel-astrarium-core-stud-brass",
    color: 0xe0aa56,
    size: 0.028,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const studs = new THREE.Points(studGeometry, studMaterial);
  studs.name = "aethel-astrarium-core-star-studs";
  group.add(lines, studs);
  return group;
}

function createRewardNode(index, layout, materials, nodeGeometry, lensGeometry, starGeometry) {
  const group = new THREE.Group();
  group.name = `aethel-astrarium-reward-node-${index + 1}`;
  group.position.set(layout.x, layout.y, 0.07);
  group.rotation.z = layout.rotation;

  const bezel = new THREE.Mesh(nodeGeometry, materials.brass);
  bezel.name = `aethel-astrarium-node-${index + 1}-bezel`;
  const lensMaterial = new THREE.MeshPhysicalMaterial({
    name: `aethel-astrarium-node-${index + 1}-amber`,
    color: 0x5f2708,
    emissive: 0x3d1402,
    emissiveIntensity: 0.12,
    metalness: 0,
    roughness: 0.2,
    clearcoat: 0.7,
    clearcoatRoughness: 0.12,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
  });
  const lens = new THREE.Mesh(lensGeometry, lensMaterial);
  lens.name = `aethel-astrarium-node-${index + 1}-lens`;
  lens.position.z = 0.019;

  const starMaterial = new THREE.MeshBasicMaterial({
    name: `aethel-astrarium-node-${index + 1}-star-ivory`,
    color: 0xffd878,
    transparent: true,
    opacity: 0,
    toneMapped: false,
    depthWrite: false,
  });
  const star = new THREE.Mesh(starGeometry, starMaterial);
  star.name = `aethel-astrarium-node-${index + 1}-star`;
  star.position.z = 0.041;
  star.visible = false;
  group.add(bezel, lens, star);
  return { group, lens, star };
}

function countTriangles(geometry) {
  if (!geometry?.attributes?.position) return 0;
  if (geometry.index) return geometry.index.count / 3;
  return geometry.attributes.position.count / 3;
}

function collectRenderDiagnostics(root) {
  const geometries = new Set();
  let drawCalls = 0;
  root.traverse((object) => {
    if (!object.isMesh && !object.isPoints && !object.isLineSegments) return;
    drawCalls += 1;
    if (object.geometry) geometries.add(object.geometry);
  });
  let triangles = 0;
  for (const geometry of geometries) triangles += countTriangles(geometry);
  return { drawCalls, triangles };
}

/**
 * Create the code-only Aethel Astrarium reward primitive. It owns no camera,
 * renderer, texture, storage, or network state and can live in every scene.
 */
export function createRewardConstellation({
  seed = "aethel-return",
  completedSessions = 0,
  pixelRatio = 1,
} = {}) {
  const layout = buildRewardConstellationLayout(seed);
  const group = new THREE.Group();
  group.name = "reward-constellation-return";

  const astrarium = new THREE.Group();
  astrarium.name = "aethel-astrarium";
  const materials = makeAstrariumMaterials();

  const outerGeometry = makeAnnularBandGeometry({ outerRadius: OUTER_RADIUS, width: 0.072, depth: 0.055, segments: 64 });
  outerGeometry.name = "reward-constellation-brass-ring-geometry";
  const outerRing = new THREE.Mesh(outerGeometry, materials.outerBrass);
  outerRing.name = "reward-constellation-brass-ring";

  const coreGeometry = new THREE.SphereGeometry(CORE_RADIUS, 40, 24);
  coreGeometry.name = "aethel-astrarium-core-geometry";
  const core = new THREE.Mesh(coreGeometry, materials.enamel);
  core.name = "aethel-astrarium-celestial-core";
  core.position.z = -0.015;

  const polarGeometry = makeAnnularBandGeometry({ outerRadius: 0.79, width: 0.052, depth: 0.047, segments: 48 });
  polarGeometry.name = "aethel-astrarium-polar-ring-geometry";
  const equatorialGeometry = makeAnnularBandGeometry({ outerRadius: 0.81, width: 0.055, depth: 0.05, segments: 48 });
  equatorialGeometry.name = "aethel-astrarium-equatorial-ring-geometry";
  const obliqueGeometry = makeAnnularBandGeometry({ outerRadius: 0.76, width: 0.047, depth: 0.043, segments: 48 });
  obliqueGeometry.name = "aethel-astrarium-oblique-ring-geometry";
  const polarRing = new THREE.Mesh(polarGeometry, materials.brass);
  polarRing.name = "aethel-astrarium-polar-ring";
  polarRing.rotation.y = Math.PI / 2 - 0.11;
  const equatorialRing = new THREE.Mesh(equatorialGeometry, materials.brass);
  equatorialRing.name = "aethel-astrarium-equatorial-ring";
  equatorialRing.rotation.x = Math.PI / 2 - 0.09;
  const obliqueRing = new THREE.Mesh(obliqueGeometry, materials.darkBrass);
  obliqueRing.name = "aethel-astrarium-oblique-ring";
  obliqueRing.rotation.set(0.9, 0.42, -0.63);

  const collarGeometry = new THREE.BoxGeometry(0.17, 0.17, 0.105, 2, 2, 2);
  collarGeometry.name = "aethel-astrarium-central-collar-geometry";
  const collar = new THREE.Mesh(collarGeometry, materials.brass);
  collar.name = "aethel-astrarium-central-collar";
  collar.position.z = 0.68;

  const coreRelief = createCoreConstellation();
  astrarium.add(core, coreRelief, polarRing, obliqueRing, equatorialRing, collar, outerRing);

  const nodeGeometry = new THREE.TorusGeometry(0.123, 0.026, 8, 32);
  nodeGeometry.name = "aethel-astrarium-node-bezel-geometry";
  const lensGeometry = new THREE.CircleGeometry(0.091, 32);
  lensGeometry.name = "aethel-astrarium-node-lens-geometry";
  const nodeStarGeometry = makeEightPointStarGeometry();
  nodeStarGeometry.name = "aethel-astrarium-node-star-geometry";
  const nodeRecords = NODE_LAYOUT.map((nodeLayout, index) => {
    const record = createRewardNode(index, nodeLayout, materials, nodeGeometry, lensGeometry, nodeStarGeometry);
    astrarium.add(record.group);
    return record;
  });

  const starPositions = new Float32Array(REWARD_CONSTELLATION_CAP * 3);
  const starStrengths = new Float32Array(REWARD_CONSTELLATION_CAP);
  const starSizes = new Float32Array(REWARD_CONSTELLATION_CAP);
  for (let i = 0; i < REWARD_CONSTELLATION_CAP; i++) {
    const point = layout[i];
    const x = point.x * 0.5;
    const y = point.y * 0.5;
    starPositions.set([x, y, sphereFrontZ(x, y, 0.027)], i * 3);
    starStrengths[i] = point.strength;
    starSizes[i] = point.size;
  }
  const starGeometry = new THREE.BufferGeometry();
  starGeometry.name = "reward-constellation-star-geometry";
  starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
  starGeometry.setAttribute("aStrength", new THREE.BufferAttribute(starStrengths, 1));
  starGeometry.setAttribute("aSize", new THREE.BufferAttribute(starSizes, 1));
  starGeometry.computeBoundingSphere();
  const starMaterial = makeStarMaterial();
  const stars = new THREE.Points(starGeometry, starMaterial);
  stars.name = "reward-constellation-stars";
  stars.renderOrder = 31;

  const linePositions = new Float32Array(EDGE_ORDER.length * 2 * 3);
  for (let edgeIndex = 0; edgeIndex < EDGE_ORDER.length; edgeIndex++) {
    const [fromIndex, toIndex] = EDGE_ORDER[edgeIndex];
    const from = layout[fromIndex];
    const to = layout[toIndex];
    const fromX = from.x * 0.5;
    const fromY = from.y * 0.5;
    const toX = to.x * 0.5;
    const toY = to.y * 0.5;
    linePositions.set([
      fromX, fromY, sphereFrontZ(fromX, fromY, 0.019),
      toX, toY, sphereFrontZ(toX, toY, 0.019),
    ], edgeIndex * 6);
  }
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.name = "reward-constellation-line-geometry";
  lineGeometry.setAttribute("position", new THREE.BufferAttribute(linePositions, 3));
  lineGeometry.computeBoundingSphere();
  const lineMaterial = new THREE.LineBasicMaterial({
    name: "reward-constellation-lines",
    color: 0xd09242,
    transparent: true,
    opacity: 0.32,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.name = "reward-constellation-links";
  lines.renderOrder = 30;

  group.add(astrarium, lines, stars);
  const renderDiagnostics = collectRenderDiagnostics(group);
  let completed = 0;
  let motionTime = 0;
  let revealEnergy = 0;
  let disposed = false;
  let baseLineOpacity = 0;

  function applyProgress(nextCompleted, animate) {
    completed = clampCompletedSessions(nextCompleted);
    group.visible = completed > 0;
    starGeometry.setDrawRange(0, completed);
    const visibleEdges = completed < 2 ? 0 : completed === REWARD_CONSTELLATION_CAP ? 4 : completed - 1;
    lineGeometry.setDrawRange(0, visibleEdges * 2);
    lines.visible = visibleEdges > 0;
    stars.visible = completed > 0;
    baseLineOpacity = completed > 1 ? 0.22 + completed * 0.045 : 0;
    lineMaterial.opacity = baseLineOpacity;
    materials.outerBrass.emissiveIntensity = completed === REWARD_CONSTELLATION_CAP ? 0.46 : 0.22 + completed * 0.04;
    for (let i = 0; i < nodeRecords.length; i++) {
      const active = i < completed;
      const record = nodeRecords[i];
      record.lens.material.color.setHex(active ? 0xb85c09 : 0x4a240d);
      record.lens.material.emissive.setHex(active ? 0xff7b0a : 0x2b1002);
      record.lens.material.emissiveIntensity = active ? 0.72 : 0.08;
      record.lens.material.opacity = active ? 0.92 : 0.42;
      record.star.visible = active;
      record.star.material.opacity = active ? 0.96 : 0;
    }
    revealEnergy = animate && completed > 0 ? 1 : 0;
  }

  function setCompletedSessions(nextCompleted, { reveal = true } = {}) {
    if (disposed) return completed;
    const normalized = clampCompletedSessions(nextCompleted);
    if (normalized !== completed || reveal) applyProgress(normalized, reveal);
    return completed;
  }

  function setPixelRatio(nextPixelRatio) {
    if (disposed) return;
    const normalized = Number.isFinite(nextPixelRatio) ? Math.max(0.5, Math.min(2, nextPixelRatio)) : 1;
    starMaterial.uniforms.uPixelRatio.value = normalized;
  }

  function update(delta, _elapsed = 0, reducedMotion = prefersReducedMotion()) {
    if (disposed) return;
    const step = Number.isFinite(delta) ? Math.max(0, delta) : 0;
    if (reducedMotion) {
      revealEnergy = 0;
    } else {
      motionTime += step;
      revealEnergy *= Math.exp(-2.8 * step);
      polarRing.rotation.y += step * 0.018;
      equatorialRing.rotation.x -= step * 0.014;
      obliqueRing.rotation.z += step * 0.021;
      core.rotation.y += step * 0.012;
    }

    starMaterial.uniforms.uTime.value = motionTime;
    const pulse = reducedMotion ? 0 : Math.sin(motionTime * 0.85) * 0.035;
    starMaterial.uniforms.uOpacity.value = 0.88 + pulse + revealEnergy * 0.1;
    lineMaterial.opacity = baseLineOpacity + (reducedMotion ? 0 : pulse * 0.45) + revealEnergy * 0.08;
    materials.outerBrass.emissiveIntensity += (
      (completed === REWARD_CONSTELLATION_CAP ? 0.46 : 0.22 + completed * 0.04) + revealEnergy * 0.12
      - materials.outerBrass.emissiveIntensity
    ) * Math.min(1, step * 8);
    for (let i = 0; i < completed; i++) {
      const nodePulse = reducedMotion ? 0 : Math.sin(motionTime * 1.15 + i * 1.4) * 0.08;
      nodeRecords[i].lens.material.emissiveIntensity = 0.72 + nodePulse + revealEnergy * 0.18;
      nodeRecords[i].star.scale.setScalar(1 + nodePulse * 0.16 + revealEnergy * 0.05);
    }
    astrarium.rotation.z = reducedMotion ? 0 : Math.sin(motionTime * 0.27) * 0.012;
  }

  function getDiagnostics() {
    return {
      completedSessions: completed,
      activeNodeCount: completed,
      starDrawCount: starGeometry.drawRange.count,
      lineDrawCount: lineGeometry.drawRange.count,
      drawCalls: renderDiagnostics.drawCalls,
      triangles: renderDiagnostics.triangles,
      motionTime,
      revealEnergy,
      pixelRatio: starMaterial.uniforms.uPixelRatio.value,
      disposed,
      layout,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const geometries = new Set();
    const ownedMaterials = new Set();
    group.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      if (Array.isArray(object.material)) {
        for (const material of object.material) ownedMaterials.add(material);
      } else if (object.material) {
        ownedMaterials.add(object.material);
      }
    });
    group.removeFromParent();
    group.clear();
    for (const geometry of geometries) geometry.dispose();
    for (const material of ownedMaterials) material.dispose();
  }

  setPixelRatio(pixelRatio);
  applyProgress(completedSessions, false);

  return {
    group,
    setCompletedSessions,
    setPixelRatio,
    update,
    getDiagnostics,
    dispose,
  };
}
