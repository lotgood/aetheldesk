import * as THREE from "three";

// ─── Forest: a quiet conifer clearing ────────────────────────────────────
// Art direction: depth comes from value, not hue. Three treelines recede
// into the fog color, the ground meets them with no gap, and the palette
// stays desaturated at every hour. The campfire is small, pushed into the
// left-lower third and set back so it never collides with the control bar,
// and its embers are soft round sprites rather than hard quads.

const GROUND_Y = -7.0;

function makeEmberTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const c = size / 2;
  const grad = ctx.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0.0, "rgba(255,236,196,1.0)");
  grad.addColorStop(0.3, "rgba(255,166,84,0.72)");
  grad.addColorStop(0.7, "rgba(255,110,40,0.18)");
  grad.addColorStop(1.0, "rgba(255,90,30,0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeMistTexture() {
  const w = 256;
  const h = 128;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.0, "rgba(255,255,255,0.0)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.55)");
  grad.addColorStop(1.0, "rgba(255,255,255,0.0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function sstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

// Light-shaft cards: alpha lives entirely in the UV falloff so the cards
// have no hard edges to catch against the treeline.
const ShaftShader = {
  uniforms: {
    uColor: { value: new THREE.Color("#ffe2bb") },
    uOpacity: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 uColor;
    uniform float uOpacity;
    varying vec2 vUv;
    void main() {
      float a = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x)
              * smoothstep(0.0, 0.22, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
      gl_FragColor = vec4(uColor, a * uOpacity);
      #include <colorspace_fragment>
    }
  `,
};

export function createForestScene() {
  const group = new THREE.Group();
  group.name = "scene-forest";
  const rng = makeRng(0xf0235117);

  // ─── Ground ───────────────────────────────────────────────────────────
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x4a5148,
    roughness: 1.0,
    metalness: 0.0,
  });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(620, 64), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = GROUND_Y;
  ground.receiveShadow = true;
  group.add(ground);

  // ─── Treelines ────────────────────────────────────────────────────────
  // Cones share one geometry; each belt gets its own material so the fog
  // mix can differ per depth. Every trunk base is planted exactly on the
  // ground plane, which is what the old scene got wrong.
  const coneGeo = new THREE.ConeGeometry(1, 1, 7, 1);
  coneGeo.translate(0, 0.5, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.22, 1, 5);
  trunkGeo.translate(0, 0.5, 0);

  const BELTS = [
    { count: 46, radius: 62, spreadR: 16, hMin: 8, hMax: 15, fogMix: 0.2 },
    { count: 62, radius: 118, spreadR: 30, hMin: 10, hMax: 20, fogMix: 0.52 },
    { count: 78, radius: 210, spreadR: 62, hMin: 13, hMax: 26, fogMix: 0.8 },
  ];

  const belts = [];
  const dummy = new THREE.Object3D();

  for (const cfg of BELTS) {
    const foliageMat = new THREE.MeshStandardMaterial({
      color: 0x3c5545,
      roughness: 0.95,
      metalness: 0.0,
      flatShading: true,
    });
    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0x3a332e,
      roughness: 1.0,
      flatShading: true,
    });

    const foliage = new THREE.InstancedMesh(coneGeo, foliageMat, cfg.count);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, cfg.count);
    foliage.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    trunks.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    // Near-field props cast into the shadow maps the renderer already pays
    // for; far belts fall outside the shadow camera and cost nothing.
    foliage.castShadow = true;
    trunks.castShadow = true;

    for (let i = 0; i < cfg.count; i++) {
      const angle = (i / cfg.count) * Math.PI * 2 + (rng() - 0.5) * 0.12;
      const radius = cfg.radius + (rng() - 0.5) * cfg.spreadR;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const h = cfg.hMin + rng() * (cfg.hMax - cfg.hMin);
      const w = h * (0.26 + rng() * 0.1);
      const trunkH = h * 0.24;

      dummy.position.set(x, GROUND_Y + trunkH, z);
      dummy.rotation.set(0, rng() * Math.PI, 0);
      dummy.scale.set(w, h, w);
      dummy.updateMatrix();
      foliage.setMatrixAt(i, dummy.matrix);

      dummy.position.set(x, GROUND_Y, z);
      dummy.scale.set(w * 0.7, trunkH + 0.2, w * 0.7);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
    }
    foliage.instanceMatrix.needsUpdate = true;
    trunks.instanceMatrix.needsUpdate = true;

    group.add(foliage);
    group.add(trunks);
    belts.push({ cfg, foliageMat, trunkMat });
  }

  // ─── Far hills, seated on the ground ──────────────────────────────────
  const hillMat = new THREE.MeshStandardMaterial({
    color: 0x55605c,
    roughness: 1.0,
    flatShading: true,
  });
  const hillGeo = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  const HILLS = [
    { x: -280, z: -340, w: 190, h: 46 },
    { x: -60, z: -420, w: 240, h: 38 },
    { x: 210, z: -360, w: 205, h: 52 },
    { x: 400, z: -300, w: 160, h: 34 },
  ];
  const hills = new THREE.InstancedMesh(hillGeo, hillMat, HILLS.length);
  HILLS.forEach((h, i) => {
    // Base sits exactly at ground level: no floating mass, no dark gap.
    dummy.position.set(h.x, GROUND_Y, h.z);
    dummy.rotation.set(0, i * 0.9, 0);
    dummy.scale.set(h.w, h.h, h.w * 0.8);
    dummy.updateMatrix();
    hills.setMatrixAt(i, dummy.matrix);
  });
  hills.instanceMatrix.needsUpdate = true;
  group.add(hills);

  // ─── Drifting mist band ───────────────────────────────────────────────
  const mistMat = new THREE.SpriteMaterial({
    map: makeMistTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0.18,
    fog: false,
  });
  const mistSprites = [];
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Sprite(mistMat);
    s.position.set((i - 2) * 150, GROUND_Y + 5.5, -150 - i * 28);
    s.scale.set(320, 34, 1);
    group.add(s);
    mistSprites.push({ sprite: s, baseX: s.position.x, speed: 1.4 + i * 0.35 });
  }

  // ─── Light shafts through the canopy ──────────────────────────────────
  // Additive cards standing between the near-belt trees. They only exist at
  // low sun: overhead light has no direction to read, and night belongs to
  // the fire. The lean follows the live light position in update().
  const shaftMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(ShaftShader.uniforms),
    vertexShader: ShaftShader.vertexShader,
    fragmentShader: ShaftShader.fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const shaftGeo = new THREE.PlaneGeometry(1, 1);
  const SHAFT_SPOTS = [
    { x: -30, z: -42, w: 13, h: 52 },
    { x: 24, z: -55, w: 17, h: 62 },
    { x: -48, z: -18, w: 11, h: 46 },
    { x: 42, z: -30, w: 14, h: 56 },
    { x: 2, z: -72, w: 20, h: 68 },
  ];
  const shafts = [];
  for (const s of SHAFT_SPOTS) {
    const mesh = new THREE.Mesh(shaftGeo, shaftMat);
    mesh.position.set(s.x, GROUND_Y + s.h * 0.42, s.z);
    mesh.scale.set(s.w, s.h, 1);
    group.add(mesh);
    shafts.push({ mesh, phase: rng() * Math.PI * 2 });
  }
  const lightPos = new THREE.Vector3(0.3, 0.4, -0.86);

  // ─── Fireflies ────────────────────────────────────────────────────────
  // Wander and blink live in the vertex shader; the CPU only feeds uTime.
  const FIREFLY_COUNT = 36;
  const fireflyPos = new Float32Array(FIREFLY_COUNT * 3);
  const fireflyPhase = new Float32Array(FIREFLY_COUNT);
  const fireflySize = new Float32Array(FIREFLY_COUNT);
  for (let i = 0; i < FIREFLY_COUNT; i++) {
    fireflyPos[i * 3 + 0] = -34 + rng() * 64;
    fireflyPos[i * 3 + 1] = GROUND_Y + 0.6 + rng() * 5.4;
    fireflyPos[i * 3 + 2] = -34 + rng() * 50;
    fireflyPhase[i] = rng() * Math.PI * 2;
    fireflySize[i] = (0.9 + rng() * 1.2) * (window.devicePixelRatio || 1);
  }
  const fireflyGeo = new THREE.BufferGeometry();
  fireflyGeo.setAttribute("position", new THREE.BufferAttribute(fireflyPos, 3));
  fireflyGeo.setAttribute("aPhase", new THREE.BufferAttribute(fireflyPhase, 1));
  fireflyGeo.setAttribute("aSize", new THREE.BufferAttribute(fireflySize, 1));
  const fireflyMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uMotion: { value: 1 },
    },
    vertexShader: `
      attribute float aPhase;
      attribute float aSize;
      uniform float uTime;
      uniform float uOpacity;
      uniform float uMotion;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.31 + aPhase) * 2.2 * uMotion;
        p.y += sin(uTime * 0.43 + aPhase * 1.7) * 0.9 * uMotion;
        p.z += cos(uTime * 0.27 + aPhase) * 2.2 * uMotion;
        float blink = 0.55 + 0.45 * sin(uTime * 1.4 + aPhase * 3.0);
        vAlpha = blink * uOpacity;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = aSize * (240.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float str = pow(1.0 - d * 2.0, 1.7);
        gl_FragColor = vec4(0.78, 1.0, 0.55, vAlpha * str);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const fireflies = new THREE.Points(fireflyGeo, fireflyMat);
  group.add(fireflies);

  // ─── Dust motes ───────────────────────────────────────────────────────
  // The shafts only read as air when something moves through them. Slow,
  // tiny, warm points sharing the shafts' low-sun window; drift lives in
  // the vertex shader like the fireflies.
  const MOTE_COUNT = 24;
  const motePos = new Float32Array(MOTE_COUNT * 3);
  const motePhase = new Float32Array(MOTE_COUNT);
  const moteSize = new Float32Array(MOTE_COUNT);
  for (let i = 0; i < MOTE_COUNT; i++) {
    motePos[i * 3 + 0] = -50 + rng() * 95;
    motePos[i * 3 + 1] = GROUND_Y + 2 + rng() * 26;
    motePos[i * 3 + 2] = -70 + rng() * 55;
    motePhase[i] = rng() * Math.PI * 2;
    moteSize[i] = (0.5 + rng() * 0.7) * (window.devicePixelRatio || 1);
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  moteGeo.setAttribute("aPhase", new THREE.BufferAttribute(motePhase, 1));
  moteGeo.setAttribute("aSize", new THREE.BufferAttribute(moteSize, 1));
  const moteMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uMotion: { value: 1 },
      uColor: { value: new THREE.Color("#ffe2bb") },
    },
    vertexShader: `
      attribute float aPhase;
      attribute float aSize;
      uniform float uTime;
      uniform float uOpacity;
      uniform float uMotion;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.12 + aPhase) * 1.4 * uMotion;
        p.y += sin(uTime * 0.1 + aPhase * 2.3) * 1.0 * uMotion;
        p.z += cos(uTime * 0.09 + aPhase) * 1.2 * uMotion;
        float shimmer = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * 0.8 + aPhase * 5.0), 2.0);
        vAlpha = shimmer * uOpacity;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = aSize * (240.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float str = pow(1.0 - d * 2.0, 1.7);
        gl_FragColor = vec4(uColor, vAlpha * str);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  group.add(motes);

  // ─── Campfire: small, low, pushed into the left-lower third ───────────
  // Set back on -Z and off-centre on -X so it clears both the centre HUD
  // column and the bottom control bar.
  const fireGroup = new THREE.Group();
  fireGroup.position.set(-13.5, GROUND_Y, -6);
  group.add(fireGroup);

  const stoneMat = new THREE.MeshStandardMaterial({
    color: 0x4c4a47,
    roughness: 0.96,
    flatShading: true,
  });
  const stoneGeo = new THREE.DodecahedronGeometry(1, 0);
  const stones = new THREE.InstancedMesh(stoneGeo, stoneMat, 7);
  stones.castShadow = true;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    dummy.position.set(Math.cos(a) * 1.5, 0.18, Math.sin(a) * 1.5);
    dummy.rotation.set(rng() * 0.7, a, rng() * 0.7);
    const s = 0.4 + rng() * 0.16;
    dummy.scale.set(s, s * 0.7, s);
    dummy.updateMatrix();
    stones.setMatrixAt(i, dummy.matrix);
  }
  stones.instanceMatrix.needsUpdate = true;
  fireGroup.add(stones);

  const fireLight = new THREE.PointLight(0xff8a3d, 2.4, 34, 1.9);
  fireLight.position.set(0, 1.2, 0);
  fireGroup.add(fireLight);

  // Core glow
  const coreMat = new THREE.SpriteMaterial({
    map: makeEmberTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    opacity: 0.9,
    fog: false,
  });
  const core = new THREE.Sprite(coreMat);
  core.position.set(0, 0.85, 0);
  core.scale.set(3.2, 3.2, 1);
  fireGroup.add(core);

  // Embers: soft round sprites, few and small.
  const emberMat = new THREE.SpriteMaterial({
    map: makeEmberTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    opacity: 0.75,
    fog: false,
  });
  const EMBER_COUNT = 16;
  const embers = [];
  for (let i = 0; i < EMBER_COUNT; i++) {
    const s = new THREE.Sprite(emberMat);
    const size = 0.16 + rng() * 0.2;
    s.scale.set(size, size, 1);
    fireGroup.add(s);
    embers.push({
      sprite: s,
      x: (rng() - 0.5) * 1.1,
      z: (rng() - 0.5) * 1.1,
      y: rng() * 6,
      life: 3.5 + rng() * 3,
      drift: (rng() - 0.5) * 0.35,
      size,
    });
  }

  // ─── Smoke: a thin column leaning with the wind ───────────────────────
  // Per-sprite materials because each wisp needs its own opacity as it
  // rises, expands and dissolves.
  const smokeTex = makeMistTexture();
  const smokeWisps = [];
  for (let i = 0; i < 6; i++) {
    const mat = new THREE.SpriteMaterial({
      map: smokeTex,
      transparent: true,
      depthWrite: false,
      opacity: 0,
      fog: false,
      rotation: rng() * Math.PI,
    });
    const sprite = new THREE.Sprite(mat);
    fireGroup.add(sprite);
    smokeWisps.push({
      sprite,
      mat,
      y: rng() * 10,
      speed: 0.5 + rng() * 0.3,
      drift: 0.3 + rng() * 0.3,
      phase: rng() * Math.PI * 2,
    });
  }

  // ─── Grade plumbing ───────────────────────────────────────────────────
  const scratch = new THREE.Color();
  const dayFoliage = new THREE.Color("#5d7a63");
  const nightFoliage = new THREE.Color("#1c2a2a");
  const dayGround = new THREE.Color("#6b6f5c");
  const nightGround = new THREE.Color("#20262a");

  function applyGrade(atmosphere) {
    if (!atmosphere) return;
    const g = atmosphere.current;
    const day = atmosphere.daylight;

    for (const belt of belts) {
      scratch.copy(nightFoliage).lerp(dayFoliage, day);
      scratch.lerp(g.key, 0.2 * day);
      scratch.lerp(g.ambientSky, 0.16);
      scratch.lerp(g.fog, belt.cfg.fogMix);
      belt.foliageMat.color.copy(scratch);

      scratch.copy(g.ambientGround).lerp(g.key, 0.12 * day);
      scratch.lerp(g.fog, belt.cfg.fogMix);
      belt.trunkMat.color.copy(scratch);
    }

    scratch.copy(nightGround).lerp(dayGround, day);
    scratch.lerp(g.ambientGround, 0.34);
    scratch.lerp(g.key, 0.12 * day);
    // Night floor is lifted toward the sky bounce instead of falling to
    // black: an unreadable foreground was the original complaint.
    scratch.lerp(g.ambientSky, 0.18 * (1 - day));
    groundMat.color.copy(scratch);

    // Hills sit almost entirely in fog: that separation is the depth cue.
    scratch.copy(g.fog).lerp(g.ambientSky, 0.2);
    hillMat.color.copy(scratch);

    scratch.copy(g.fog).lerp(g.ambientSky, 0.35);
    mistMat.color.copy(scratch);
    mistMat.opacity = 0.14 + (1 - day) * 0.12;

    scratch.copy(g.ambientGround).lerp(g.ambientSky, 0.3).lerp(g.fog, 0.25);
    stoneMat.color.copy(scratch);

    // The fire is the one warm accent; it strengthens as the day drains.
    const night = 1 - day;
    fireLight.intensity = 0.9 + night * 3.2;
    coreMat.opacity = 0.35 + night * 0.55;
    emberMat.opacity = 0.3 + night * 0.5;

    // Shafts take the key color; fireflies and smoke belong to the night
    // and the fire respectively. Motes share the shafts' light.
    shaftMat.uniforms.uColor.value.copy(g.key);
    moteMat.uniforms.uColor.value.copy(g.key);
    fireflyMat.uniforms.uOpacity.value = night * 0.85;
    scratch.copy(g.fog).lerp(g.ambientSky, 0.4);
    for (const w of smokeWisps) w.mat.color.copy(scratch);
  }

  function updateCelestial(_c, atmosphere) {
    applyGrade(atmosphere);
  }

  function update(delta, elapsed, atmosphere) {
    applyGrade(atmosphere);

    const reducedMotion = prefersReducedMotion();

    // Fire breathing
    const flicker = 1 + Math.sin(elapsed * 7.3) * 0.06 + Math.sin(elapsed * 3.1) * 0.04;
    core.scale.set(3.2 * flicker, 3.2 * flicker, 1);
    fireLight.intensity *= flicker;

    for (const e of embers) {
      e.y += (0.9 + e.size * 2) * delta;
      e.x += e.drift * delta;
      if (e.y > e.life) {
        e.y = 0;
        e.x = (Math.random() - 0.5) * 1.1;
        e.z = (Math.random() - 0.5) * 1.1;
      }
      const fade = Math.max(0, 1 - e.y / e.life);
      e.sprite.position.set(e.x, 0.7 + e.y, e.z);
      const s = e.size * (0.5 + fade * 0.8);
      e.sprite.scale.set(s, s, 1);
    }

    // Mist drift
    for (const m of mistSprites) {
      m.sprite.position.x += m.speed * delta;
      if (m.sprite.position.x > 420) m.sprite.position.x = -420;
    }

    // Shafts: only a low sun throws them, leaning with the light. The sway
    // is the one motion here large enough to need a reduced-motion gate.
    // Motes share the same window — they are what the shafts reveal.
    if (atmosphere) {
      const e = atmosphere.elevation;
      const window_ = sstep(-4, 2, e) * (1 - sstep(12, 24, e));
      shaftMat.uniforms.uOpacity.value = window_ * 0.22 * atmosphere.daylight;
      moteMat.uniforms.uOpacity.value = window_ * 0.55 * atmosphere.daylight;
      const lean = -Math.max(-1, Math.min(1, lightPos.x / 300)) * 0.45;
      for (const s of shafts) {
        const sway = reducedMotion ? 0 : Math.sin(elapsed * 0.25 + s.phase) * 0.015;
        s.mesh.rotation.z = lean + sway;
      }
    }

    // Fireflies: wander in the shader; reduced motion keeps the blink but
    // stills the flight.
    fireflyMat.uniforms.uTime.value = elapsed;
    fireflyMat.uniforms.uMotion.value = reducedMotion ? 0.15 : 1;
    moteMat.uniforms.uTime.value = elapsed;
    moteMat.uniforms.uMotion.value = reducedMotion ? 0.15 : 1;

    // Smoke rise: expand, drift and dissolve, then loop.
    for (const w of smokeWisps) {
      w.y += w.speed * (reducedMotion ? 0.35 : 1) * delta;
      if (w.y > 10) {
        w.y = 0;
        w.phase = Math.random() * Math.PI * 2;
      }
      const life = w.y / 10;
      const s = 1.6 + w.y * 0.5;
      w.sprite.position.set(
        Math.sin(w.phase + w.y * 0.4) * w.drift * w.y * 0.3,
        1.6 + w.y,
        Math.cos(w.phase) * 0.4
      );
      w.sprite.scale.set(s, s * 1.4, 1);
      w.mat.opacity = 0.14 * Math.sin(Math.PI * Math.min(life, 1));
      w.mat.rotation += delta * 0.05;
    }
  }

  return {
    group,
    updateCelestial,
    update,
    /** scenes.js feeds the live sun/moon position so shafts lean correctly. */
    setLightDirection(pos) {
      lightPos.copy(pos);
    },
  };
}
