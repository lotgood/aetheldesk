import * as THREE from "three";

export function createCelestialSystem(scene) {
  const celestialGroup = new THREE.Group();
  scene.add(celestialGroup);

  // ─── 1. SUN ─────────────────────────────────────────────────────────────
  const sunGroup = new THREE.Group();
  celestialGroup.add(sunGroup);

  // Sun Core Mesh
  const sunGeo = new THREE.SphereGeometry(18, 32, 32);
  // transparent is required or the opacity fade below is silently ignored
  // and the sun disc stays on screen all night as a dark circle.
  const sunMat = new THREE.MeshBasicMaterial({
    color: 0xfffbe8,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const sunMesh = new THREE.Mesh(sunGeo, sunMat);
  sunGroup.add(sunMesh);

  // Sun Corona Glow (Atmospheric Halo Sprite)
  const coronaCanvas = document.createElement("canvas");
  coronaCanvas.width = 256;
  coronaCanvas.height = 256;
  const cctx = coronaCanvas.getContext("2d");
  const cgrad = cctx.createRadialGradient(128, 128, 10, 128, 128, 128);
  cgrad.addColorStop(0, "rgba(255, 250, 220, 1.0)");
  cgrad.addColorStop(0.25, "rgba(255, 200, 90, 0.7)");
  cgrad.addColorStop(0.6, "rgba(255, 140, 40, 0.25)");
  cgrad.addColorStop(1.0, "rgba(255, 100, 20, 0.0)");
  cctx.fillStyle = cgrad;
  cctx.fillRect(0, 0, 256, 256);

  const coronaTex = new THREE.CanvasTexture(coronaCanvas);
  coronaTex.colorSpace = THREE.SRGBColorSpace;
  const coronaMat = new THREE.SpriteMaterial({
    map: coronaTex,
    color: 0xffffff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const coronaSprite = new THREE.Sprite(coronaMat);
  coronaSprite.scale.set(120, 120, 1);
  sunGroup.add(coronaSprite);

  // Sun Light
  const sunLight = new THREE.DirectionalLight(0xfff5e6, 2.4);
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.width = 2048;
  sunLight.shadow.mapSize.height = 2048;
  sunLight.shadow.camera.near = 0.5;
  sunLight.shadow.camera.far = 1000;
  const d = 50;
  sunLight.shadow.camera.left = -d;
  sunLight.shadow.camera.right = d;
  sunLight.shadow.camera.top = d;
  sunLight.shadow.camera.bottom = -d;
  sunLight.shadow.bias = -0.0005;
  sunGroup.add(sunLight);

  // ─── 2. MOON ────────────────────────────────────────────────────────────
  const moonGroup = new THREE.Group();
  celestialGroup.add(moonGroup);

  // Moon Texture Canvas (Procedural Craters)
  const moonCanvas = document.createElement("canvas");
  moonCanvas.width = 512;
  moonCanvas.height = 256;
  const mctx = moonCanvas.getContext("2d");
  mctx.fillStyle = "#d8e0f0";
  mctx.fillRect(0, 0, 512, 256);
  // Draw subtle craters
  mctx.fillStyle = "rgba(100, 115, 145, 0.35)";
  const craters = [
    [120, 80, 24], [180, 140, 32], [280, 70, 18], [340, 160, 28],
    [80, 180, 15], [230, 200, 20], [420, 100, 22], [470, 170, 14],
  ];
  for (const [cx, cy, r] of craters) {
    mctx.beginPath();
    mctx.arc(cx, cy, r, 0, Math.PI * 2);
    mctx.fill();
    // Inner crater shadow
    mctx.fillStyle = "rgba(60, 75, 105, 0.4)";
    mctx.beginPath();
    mctx.arc(cx + r * 0.2, cy + r * 0.2, r * 0.7, 0, Math.PI * 2);
    mctx.fill();
    mctx.fillStyle = "rgba(100, 115, 145, 0.35)";
  }

  const moonTex = new THREE.CanvasTexture(moonCanvas);
  moonTex.colorSpace = THREE.SRGBColorSpace;
  const moonGeo = new THREE.SphereGeometry(15, 32, 32);
  // The moon sits far outside every light's range, so it has to carry its
  // own luminance: a strong emissive plus transparency for the day fade.
  // Without both it renders as a dark disc pasted on the night sky.
  const moonMat = new THREE.MeshStandardMaterial({
    map: moonTex,
    roughness: 0.9,
    metalness: 0.0,
    emissive: 0xcfd9ee,
    emissiveIntensity: 1.25,
    emissiveMap: moonTex,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const moonMesh = new THREE.Mesh(moonGeo, moonMat);
  moonGroup.add(moonMesh);

  // Moon Halo Sprite
  const mHaloCanvas = document.createElement("canvas");
  mHaloCanvas.width = 256;
  mHaloCanvas.height = 256;
  const mhctx = mHaloCanvas.getContext("2d");
  const mhgrad = mhctx.createRadialGradient(128, 128, 10, 128, 128, 128);
  mhgrad.addColorStop(0, "rgba(220, 235, 255, 0.8)");
  mhgrad.addColorStop(0.35, "rgba(160, 195, 255, 0.3)");
  mhgrad.addColorStop(0.7, "rgba(100, 150, 255, 0.08)");
  mhgrad.addColorStop(1.0, "rgba(0, 0, 0, 0.0)");
  mhctx.fillStyle = mhgrad;
  mhctx.fillRect(0, 0, 256, 256);

  const mHaloTex = new THREE.CanvasTexture(mHaloCanvas);
  mHaloTex.colorSpace = THREE.SRGBColorSpace;
  const mHaloMat = new THREE.SpriteMaterial({
    map: mHaloTex,
    color: 0xffffff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const moonHaloSprite = new THREE.Sprite(mHaloMat);
  moonHaloSprite.scale.set(80, 80, 1);
  moonGroup.add(moonHaloSprite);

  // Moon Light
  const moonLight = new THREE.DirectionalLight(0x99bbee, 0.6);
  moonLight.castShadow = true;
  moonGroup.add(moonLight);

  // ─── 2b. SKY AMBIENT (Hemisphere) ────────────────────────────────────
  // Fills the shadowed sides of scene geometry so daytime faces do not
  // fall to black under a zenith sun. Dimmed at night.
  const hemiLight = new THREE.HemisphereLight(0xbdd8ff, 0x0a0e18, 0.5);
  celestialGroup.add(hemiLight);

  // ─── 3. STARFIELD & MILKY WAY ───────────────────────────────────────────
  const starCount = 4500;
  const starPositions = new Float32Array(starCount * 3);
  const starColors = new Float32Array(starCount * 3);
  const starSizes = new Float32Array(starCount);
  const starPhases = new Float32Array(starCount);

  const starPalettes = [
    new THREE.Color("#ffffff"),
    new THREE.Color("#dbeeff"),
    new THREE.Color("#ffe8c4"),
    new THREE.Color("#c8d6ff"),
    new THREE.Color("#ffd4a8"),
  ];

  for (let i = 0; i < starCount; i++) {
    // Distribute on sphere shell
    const u = Math.random();
    const v = Math.random();
    const theta = u * 2.0 * Math.PI;
    const phi = Math.acos(2.0 * v - 1.0);
    const r = 650 + Math.random() * 50;

    starPositions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
    starPositions[i * 3 + 1] = Math.abs(r * Math.cos(phi)) + 10; // Bias upward
    starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);

    const col = starPalettes[Math.floor(Math.random() * starPalettes.length)];
    starColors[i * 3 + 0] = col.r;
    starColors[i * 3 + 1] = col.g;
    starColors[i * 3 + 2] = col.b;

    starSizes[i] = (Math.random() * 2.5 + 1.0) * (window.devicePixelRatio || 1);
    starPhases[i] = Math.random() * Math.PI * 2;
  }

  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
  starGeo.setAttribute("color", new THREE.BufferAttribute(starColors, 3));
  starGeo.setAttribute("aSize", new THREE.BufferAttribute(starSizes, 1));
  starGeo.setAttribute("aPhase", new THREE.BufferAttribute(starPhases, 1));

  const starShaderMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 1.0 },
    },
    vertexShader: `
      attribute float aSize;
      attribute float aPhase;
      attribute vec3 color;
      varying vec3 vColor;
      varying float vAlpha;
      uniform float uTime;
      uniform float uOpacity;

      void main() {
        vColor = color;
        // Twinkle factor
        float twinkle = 0.65 + 0.35 * sin(uTime * 2.5 + aPhase);
        vAlpha = twinkle * uOpacity;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (400.0 / -mvPosition.z) * twinkle;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;

      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float strength = pow(1.0 - (d * 2.0), 1.8);
        gl_FragColor = vec4(vColor, vAlpha * strength);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const starMesh = new THREE.Points(starGeo, starShaderMat);
  celestialGroup.add(starMesh);

  // ─── 3b. MILKY WAY BAND ───────────────────────────────────────────────
  // A denser band of blue-white stars along a tilted galactic plane,
  // sharing the star shader so it twinkles and fades with the sky.
  const mwCount = 1300;
  const mwPositions = new Float32Array(mwCount * 3);
  const mwColors = new Float32Array(mwCount * 3);
  const mwSizes = new Float32Array(mwCount);
  const mwPhases = new Float32Array(mwCount);
  const mwTilt = 0.55; // galactic plane tilt in radians
  const mwCos = Math.cos(mwTilt);
  const mwSin = Math.sin(mwTilt);
  for (let i = 0; i < mwCount; i++) {
    const theta = Math.random() * 2.0 * Math.PI;
    // Tight spread around the plane (sum of uniforms ≈ gaussian)
    const spread = (Math.random() + Math.random() + Math.random() - 1.5) * 0.055;
    const phi = Math.PI / 2 + spread;
    const r = 660 + Math.random() * 40;
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y0 = r * Math.cos(phi);
    const z = r * Math.sin(phi) * Math.sin(theta);
    mwPositions[i * 3 + 0] = x;
    mwPositions[i * 3 + 1] = y0 * mwCos - z * mwSin;
    mwPositions[i * 3 + 2] = y0 * mwSin + z * mwCos;

    const lum = 0.65 + Math.random() * 0.35;
    mwColors[i * 3 + 0] = 0.72 * lum;
    mwColors[i * 3 + 1] = 0.82 * lum;
    mwColors[i * 3 + 2] = lum;
    mwSizes[i] = (0.7 + Math.random() * 1.5) * (window.devicePixelRatio || 1);
    mwPhases[i] = Math.random() * Math.PI * 2;
  }
  const mwGeo = new THREE.BufferGeometry();
  mwGeo.setAttribute("position", new THREE.BufferAttribute(mwPositions, 3));
  mwGeo.setAttribute("color", new THREE.BufferAttribute(mwColors, 3));
  mwGeo.setAttribute("aSize", new THREE.BufferAttribute(mwSizes, 1));
  mwGeo.setAttribute("aPhase", new THREE.BufferAttribute(mwPhases, 1));
  const mwMesh = new THREE.Points(mwGeo, starShaderMat);
  celestialGroup.add(mwMesh);

  // ─── 3c. SHOOTING STARS ───────────────────────────────────────────────
  const METEOR_TRAIL = 9;
  const meteorCount = 3;
  const meteorGeo = new THREE.BufferGeometry();
  meteorGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(meteorCount * METEOR_TRAIL * 3), 3));
  meteorGeo.setAttribute("alpha", new THREE.BufferAttribute(new Float32Array(meteorCount * METEOR_TRAIL), 1));
  const meteorMat = new THREE.ShaderMaterial({
    vertexShader: [
      "attribute float alpha;",
      "varying float vAlpha;",
      "void main() {",
      "  vAlpha = alpha;",
      "  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);",
      "  gl_PointSize = (alpha > 0.85 ? 3.4 : 1.9) * (300.0 / -mvPosition.z);",
      "  gl_Position = projectionMatrix * mvPosition;",
      "}",
    ].join("\n"),
    fragmentShader: [
      "varying float vAlpha;",
      "void main() {",
      "  float d = length(gl_PointCoord - vec2(0.5));",
      "  if (d > 0.5) discard;",
      "  float str = pow(1.0 - d * 2.0, 1.6);",
      "  gl_FragColor = vec4(1.0, 0.97, 0.88, vAlpha * str);",
      "  #include <colorspace_fragment>",
      "}",
    ].join("\n"),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const meteorPoints = new THREE.Points(meteorGeo, meteorMat);
  celestialGroup.add(meteorPoints);
  const meteors = [];
  for (let i = 0; i < meteorCount; i++) {
    meteors.push({
      active: false,
      timer: 4 + i * 6 + Math.random() * 8,
      head: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      speed: 0,
      age: 0,
      duration: 0,
      history: [],
    });
  }

  // ─── 4. POMODORO SATELLITE (ASTROLABE) ──────────────────────────────────
  const satOrbitGroup = new THREE.Group();
  celestialGroup.add(satOrbitGroup);

  const satMeshGroup = new THREE.Group();
  satOrbitGroup.add(satMeshGroup);

  // Satellite Core
  const satCoreGeo = new THREE.OctahedronGeometry(2.2, 1);
  const satCoreMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0x99ccff,
    emissiveIntensity: 1.5,
    roughness: 0.1,
    metalness: 0.9,
  });
  const satCore = new THREE.Mesh(satCoreGeo, satCoreMat);
  satMeshGroup.add(satCore);

  // Satellite Orbital Rings (Astrolabe style)
  const ringGeo = new THREE.TorusGeometry(4.2, 0.15, 16, 64);
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0xffd700,
    emissive: 0x885500,
    emissiveIntensity: 0.6,
    metalness: 0.95,
    roughness: 0.2,
  });
  const ring1 = new THREE.Mesh(ringGeo, ringMat);
  const ring2 = new THREE.Mesh(ringGeo, ringMat);
  ring2.rotation.x = Math.PI / 3;
  satMeshGroup.add(ring1);
  satMeshGroup.add(ring2);

  // Satellite Glow Sprite
  const satGlowCanvas = document.createElement("canvas");
  satGlowCanvas.width = 128;
  satGlowCanvas.height = 128;
  const sgctx = satGlowCanvas.getContext("2d");
  const sggrad = sgctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  sggrad.addColorStop(0, "rgba(255, 255, 255, 1.0)");
  sggrad.addColorStop(0.3, "rgba(120, 200, 255, 0.7)");
  sggrad.addColorStop(0.7, "rgba(70, 140, 255, 0.2)");
  sggrad.addColorStop(1.0, "rgba(0, 0, 0, 0.0)");
  sgctx.fillStyle = sggrad;
  sgctx.fillRect(0, 0, 128, 128);

  const satGlowTex = new THREE.CanvasTexture(satGlowCanvas);
  satGlowTex.colorSpace = THREE.SRGBColorSpace;
  const satGlowMat = new THREE.SpriteMaterial({
    map: satGlowTex,
    color: 0xffffff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const satGlowSprite = new THREE.Sprite(satGlowMat);
  satGlowSprite.scale.set(16, 16, 1);
  satMeshGroup.add(satGlowSprite);

  // Satellite Orbit Path Ring
  const orbitRadius = 45;
  const orbitPathGeo = new THREE.BufferGeometry();
  const orbitPoints = [];
  for (let i = 0; i <= 128; i++) {
    const a = (i / 128) * Math.PI * 2;
    orbitPoints.push(new THREE.Vector3(Math.cos(a) * orbitRadius, 0, Math.sin(a) * orbitRadius));
  }
  orbitPathGeo.setFromPoints(orbitPoints);
  const orbitPathMat = new THREE.LineBasicMaterial({
    color: 0x99ccff,
    transparent: true,
    opacity: 0.25,
  });
  const orbitPathLine = new THREE.Line(orbitPathGeo, orbitPathMat);
  orbitPathLine.rotation.x = Math.PI / 6;
  satOrbitGroup.add(orbitPathLine);

  // Satellite Trail (Ribbon Particles)
  const trailCount = 40;
  const trailPositions = new Float32Array(trailCount * 3);
  const trailAlphas = new Float32Array(trailCount);
  for (let i = 0; i < trailCount; i++) {
    trailAlphas[i] = 1.0 - i / trailCount;
  }
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute("position", new THREE.BufferAttribute(trailPositions, 3));
  trailGeo.setAttribute("alpha", new THREE.BufferAttribute(trailAlphas, 1));

  const trailMat = new THREE.ShaderMaterial({
    vertexShader: `
      attribute float alpha;
      varying float vAlpha;
      void main() {
        vAlpha = alpha;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = (1.0 - alpha * 0.5) * 6.0 * (200.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float str = pow(1.0 - d * 2.0, 1.5);
        gl_FragColor = vec4(0.6, 0.85, 1.0, vAlpha * str * 0.7);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const trailPoints = new THREE.Points(trailGeo, trailMat);
  celestialGroup.add(trailPoints);

  const trailHistory = [];

  // State
  let currentProgress = 0;
  let isFocusActive = false;

  // Day/night visibility: T holds the targets from the latest celestial
  // state; L holds the eased live values applied in update(). This makes
  // sunrise/sunset fade instead of snapping between elevation bands.
  const T = { sun: 0, moon: 1, sunLight: 0.01, moonLight: 0.01, hemi: 0.8 };
  const L = { ...T };
  const SMOOTH = 2.2; // per-second approach rate

  function updateCelestialState(c) {
    if (!c) return;
    const elev = c.elevation;
    const arcPct = c.arc_pct ?? 0.5;

    // The arc has to live inside the camera frustum or the bodies are
    // simply never on screen. At fov 55 and ~440 units of depth the visible
    // half-height is ~230 and half-width ~370, so the sun travels a band
    // well inside that instead of the old 450-unit dome arc, which put it
    // above or beside the frame at every hour of the day.
    const SKY_DEPTH = -420;
    // Map arc_pct (0 to 1) to angle (PI to 0): left horizon -> right horizon
    const angle = Math.PI - arcPct * Math.PI;
    sunGroup.position.set(Math.cos(angle) * 290, Math.sin(angle) * 148 + 6, SKY_DEPTH);

    // The backend exposes solar data only, so this is not a real lunar
    // ephemeris. The moon walks its own arc across the night using the
    // timestamp the backend already sends, treating 18:00-06:00 as the
    // night span — so it actually travels instead of parking wherever the
    // sun's depth happens to put it. Approximate, but it moves and it
    // rises and sets on the correct sides.
    let nightPct = 0.5;
    if (typeof c.iso === "string") {
      const t = new Date(c.iso);
      if (!Number.isNaN(t.getTime())) {
        const hours = t.getHours() + t.getMinutes() / 60;
        nightPct = (((hours - 18 + 24) % 24) / 12) % 1;
      }
    }
    const moonAngle = Math.PI - nightPct * Math.PI;
    moonGroup.position.set(Math.cos(moonAngle) * 290, Math.sin(moonAngle) * 148 + 6, SKY_DEPTH - 10);

    // Visibility / intensity (targets; update() eases toward them so
    // sunrise/sunset fade instead of snapping)
    const sunF = Math.max(0, Math.min(1, (elev + 6) / 12));
    const moonF = Math.max(0, Math.min(1, (6 - elev) / 12));

    T.sun = sunF;
    T.moon = moonF;
    T.sunLight = Math.max(0.01, sunF * 2.4);
    T.moonLight = Math.max(0.01, moonF * 1.1);
    T.hemi = 0.8 + sunF * 3.5;

    // Bind satellite orbit center to active body
    if (c.phase === "day") {
      satOrbitGroup.position.copy(sunGroup.position);
    } else {
      satOrbitGroup.position.copy(moonGroup.position);
    }
  }

  function updatePomodoro(state) {
    if (!state) return;
    isFocusActive = !!state.focus;
    if (isFocusActive && state.pomodoro_duration > 0) {
      currentProgress = Math.max(0, Math.min(1, 1 - state.pomodoro_remaining / state.pomodoro_duration));
      satOrbitGroup.visible = true;
    } else if (state.break && state.break_duration > 0) {
      currentProgress = Math.max(0, Math.min(1, 1 - state.break_remaining / state.break_duration));
      satOrbitGroup.visible = true;
    } else {
      currentProgress = 0;
      satOrbitGroup.visible = false;
    }
  }

  function update(delta, elapsed, atmosphere) {
    starShaderMat.uniforms.uTime.value = elapsed;

    const f = 1 - Math.exp(-SMOOTH * delta);
    for (const k of ["sun", "moon", "sunLight", "moonLight", "hemi"]) {
      L[k] = delta < 0.5 ? L[k] + (T[k] - L[k]) * f : T[k];
    }

    sunMesh.material.opacity = L.sun;
    coronaSprite.material.opacity = L.sun * 0.9;
    moonMesh.material.opacity = L.moon;
    moonHaloSprite.material.opacity = L.moon * 0.75;
    starShaderMat.uniforms.uOpacity.value = L.moon;

    if (atmosphere) {
      // Light color and strength come from the shared grade so the key light
      // always agrees with the sky it is supposed to be coming from.
      const g = atmosphere.current;
      sunLight.color.copy(g.key);
      sunLight.intensity = L.sun * g.keyIntensity;
      moonLight.color.copy(g.key);
      moonLight.intensity = L.moon * g.keyIntensity * 0.5;
      hemiLight.color.copy(g.ambientSky);
      hemiLight.groundColor.copy(g.ambientGround);
      hemiLight.intensity = g.ambientIntensity + L.sun * 1.5;
      sunMesh.material.color.copy(g.sun);
    } else {
      sunLight.intensity = L.sunLight;
      moonLight.intensity = L.moonLight;
      hemiLight.intensity = L.hemi;
    }

    // Corona subtle breathing
    const breath = 1.0 + Math.sin(elapsed * 1.5) * 0.08;
    coronaSprite.scale.set(120 * breath, 120 * breath, 1);
    const moonBreath = 1.0 + Math.cos(elapsed * 1.2) * 0.05;
    moonHaloSprite.scale.set(80 * moonBreath, 80 * moonBreath, 1);

    // Moon self-rotation
    moonMesh.rotation.y = elapsed * 0.03;

    // Shooting stars — sparse, bright, brief
    for (const m of meteors) {
      if (!m.active) {
        m.timer -= delta;
        if (m.timer <= 0) {
          const theta = Math.random() * Math.PI * 2;
          const phi = Math.acos(0.7 + Math.random() * 0.3);
          const r = 600;
          m.head.set(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
          const da = (Math.random() - 0.5) * 0.6;
          m.dir.set(Math.sin(theta + da) - Math.sin(theta), -0.12 - Math.random() * 0.1, Math.cos(theta + da) - Math.cos(theta)).normalize();
          m.speed = 110 + Math.random() * 70;
          m.duration = 0.5 + Math.random() * 0.35;
          m.age = 0;
          m.history = [];
          m.active = true;
        }
      } else {
        m.age += delta;
        m.head.addScaledVector(m.dir, m.speed * delta);
        m.history.unshift(m.head.clone());
        if (m.history.length > METEOR_TRAIL) m.history.pop();
        if (m.age > m.duration) {
          m.active = false;
          m.history = [];
          m.timer = 8 + Math.random() * 14;
        }
      }
    }
    const mPosAttr = meteorGeo.attributes.position;
    const mAlphaAttr = meteorGeo.attributes.alpha;
    for (let mi = 0; mi < meteorCount; mi++) {
      const m = meteors[mi];
      const fade = m.active ? 1 - m.age / m.duration : 0;
      for (let t = 0; t < METEOR_TRAIL; t++) {
        const o = (mi * METEOR_TRAIL + t) * 3;
        const pt = m.history[t];
        if (!m.active || !pt) {
          mPosAttr.setXYZ(o / 3, 0, -1000, 0);
          mAlphaAttr.setX(mi * METEOR_TRAIL + t, 0);
        } else {
          mPosAttr.setXYZ(o / 3, pt.x, pt.y, pt.z);
          mAlphaAttr.setX(mi * METEOR_TRAIL + t, (1 - t / METEOR_TRAIL) * fade);
        }
      }
    }
    mPosAttr.needsUpdate = true;
    mAlphaAttr.needsUpdate = true;

    // Satellite rotation & orbit
    if (satOrbitGroup.visible) {
      const satAngle = currentProgress * Math.PI * 2;
      const rotAngle = Math.PI / 6; // incline

      const localX = Math.cos(satAngle) * orbitRadius;
      const localY = Math.sin(satAngle) * orbitRadius * Math.sin(rotAngle);
      const localZ = Math.sin(satAngle) * orbitRadius * Math.cos(rotAngle);
      satMeshGroup.position.set(localX, localY, localZ);

      // Astrolabe ring rotation
      ring1.rotation.y = elapsed * 2.0;
      ring2.rotation.z = elapsed * 1.5;
      satCore.rotation.x = elapsed * 3.0;

      // Update trail
      const worldPos = new THREE.Vector3();
      satMeshGroup.getWorldPosition(worldPos);
      trailHistory.unshift(worldPos.clone());
      if (trailHistory.length > trailCount) trailHistory.pop();

      const posAttr = trailGeo.attributes.position;
      for (let i = 0; i < trailCount; i++) {
        const pt = trailHistory[i] || worldPos;
        posAttr.setXYZ(i, pt.x, pt.y, pt.z);
      }
      posAttr.needsUpdate = true;
      trailPoints.visible = true;
    } else {
      trailPoints.visible = false;
    }
  }

  return {
    sunGroup,
    moonGroup,
    starMesh,
    satOrbitGroup,
    updateCelestialState,
    updatePomodoro,
    update,
  };
}