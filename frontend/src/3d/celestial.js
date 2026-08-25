import * as THREE from "three";
import { prefersReducedMotion } from "./motion.js";

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeMilkyWayTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const rng = makeRng(0x6d696c6b);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = "lighter";

  // Overlapping feathered dust knots form one restrained, irregular band.
  // Alpha never approaches an opaque veil; the point layer below supplies the
  // readable stars while this texture only provides the galactic haze.
  for (let i = 0; i < 54; i++) {
    const x = 18 + rng() * (canvas.width - 36);
    const center = canvas.height * 0.5 + Math.sin(x * 0.031) * 7 + (rng() - 0.5) * 17;
    const rx = 22 + rng() * 58;
    const ry = 5 + rng() * 15;
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    gradient.addColorStop(0, `rgba(190,211,255,${0.018 + rng() * 0.025})`);
    gradient.addColorStop(0.45, `rgba(132,157,211,${0.009 + rng() * 0.014})`);
    gradient.addColorStop(1, "rgba(70,88,132,0)");
    ctx.save();
    ctx.translate(x, center);
    ctx.scale(rx, ry);
    ctx.fillStyle = gradient;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }

  // A faint broken dust lane keeps the band from reading as a smooth cloud.
  ctx.globalCompositeOperation = "destination-out";
  ctx.strokeStyle = "rgba(0,0,0,0.22)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  for (let x = 0; x <= canvas.width; x += 8) {
    const y = canvas.height * 0.5 + Math.sin(x * 0.031 + 0.8) * 6;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Feather every edge so the camera-facing sprite can never expose a card.
  ctx.globalCompositeOperation = "destination-in";
  const xMask = ctx.createLinearGradient(0, 0, canvas.width, 0);
  xMask.addColorStop(0, "rgba(255,255,255,0)");
  xMask.addColorStop(0.12, "rgba(255,255,255,1)");
  xMask.addColorStop(0.88, "rgba(255,255,255,1)");
  xMask.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = xMask;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const yMask = ctx.createLinearGradient(0, 0, 0, canvas.height);
  yMask.addColorStop(0, "rgba(255,255,255,0)");
  yMask.addColorStop(0.22, "rgba(255,255,255,1)");
  yMask.addColorStop(0.78, "rgba(255,255,255,1)");
  yMask.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = yMask;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createCelestialSystem(scene) {
  const celestialGroup = new THREE.Group();
  scene.add(celestialGroup);

  // ─── 1. SUN ─────────────────────────────────────────────────────────────
  const sunGroup = new THREE.Group();
  celestialGroup.add(sunGroup);

  // Photosphere disc. A camera-facing disc keeps a true circular silhouette
  // at every camera angle, while the restrained radial falloff supplies the
  // edge contrast that a flat white emissive sphere loses against a bright
  // HDR sky.
  const sunDiscCanvas = document.createElement("canvas");
  sunDiscCanvas.width = 256;
  sunDiscCanvas.height = 256;
  const sdctx = sunDiscCanvas.getContext("2d");
  const sdgrad = sdctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  sdgrad.addColorStop(0.0, "rgba(255,250,214,1)");
  sdgrad.addColorStop(0.72, "rgba(255,245,188,1)");
  sdgrad.addColorStop(0.90, "rgba(245,196,92,1)");
  sdgrad.addColorStop(0.985, "rgba(223,155,66,1)");
  sdgrad.addColorStop(1.0, "rgba(223,155,66,0)");
  sdctx.fillStyle = sdgrad;
  sdctx.fillRect(0, 0, 256, 256);
  const sunDiscTex = new THREE.CanvasTexture(sunDiscCanvas);
  sunDiscTex.colorSpace = THREE.SRGBColorSpace;

  // transparent is required or the opacity fade below is silently ignored
  // and the sun disc stays on screen all night as a dark circle.
  const sunMat = new THREE.SpriteMaterial({
    map: sunDiscTex,
    color: 0xfffbe8,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    toneMapped: true,
    fog: false,
  });
  const sunMesh = new THREE.Sprite(sunMat);
  sunMesh.scale.set(36, 36, 1);
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
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const coronaSprite = new THREE.Sprite(coronaMat);
  coronaSprite.scale.set(120, 120, 1);
  // The corona is a halo behind the photosphere, not a white veil painted
  // over it. Both objects are transparent and share a centre, so an explicit
  // render order is required; otherwise the later-created additive sprite
  // erases the sun's circular edge at midday.
  coronaSprite.renderOrder = -1;
  sunGroup.add(coronaSprite);

  // Sun Light
  const keyLight = new THREE.DirectionalLight(0xfff5e6, 2.4);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.width = 2048;
  keyLight.shadow.mapSize.height = 2048;
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = 1000;
  const d = 50;
  keyLight.shadow.camera.left = -d;
  keyLight.shadow.camera.right = d;
  keyLight.shadow.camera.top = d;
  keyLight.shadow.camera.bottom = -d;
  keyLight.shadow.bias = -0.0005;
  keyLight.visible = false;
  // The visible sun is pulled into the camera frustum for composition, so its
  // world position is not a physically meaningful light direction. Keep the
  // key light at the celestial root and position it from the real solar
  // elevation below; otherwise a noon sun only 148 units above a body 420
  // units away casts golden-hour-length shadows across every scene.
  celestialGroup.add(keyLight);

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
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const moonHaloSprite = new THREE.Sprite(mHaloMat);
  moonHaloSprite.scale.set(80, 80, 1);
  // Keep crater detail in front of the additive halo, mirroring the sun's
  // photosphere/corona ordering contract.
  moonHaloSprite.renderOrder = -1;
  moonGroup.add(moonHaloSprite);

  // ─── 2b. SKY AMBIENT (Hemisphere) ────────────────────────────────────
  // Fills the shadowed sides of scene geometry so daytime faces do not
  // fall to black under a zenith sun. Dimmed at night.
  const hemiLight = new THREE.HemisphereLight(0xbdd8ff, 0x0a0e18, 0.5);
  celestialGroup.add(hemiLight);

  // ─── 3. STARFIELD & MILKY WAY ───────────────────────────────────────────
  const starCount = 1500;
  const starPositions = new Float32Array(starCount * 3);
  const starColors = new Float32Array(starCount * 3);
  const starSizes = new Float32Array(starCount);
  const starPhases = new Float32Array(starCount);
  const starRng = makeRng(0x57a27f1e);

  const starPalettes = [
    new THREE.Color("#ffffff"),
    new THREE.Color("#dbeeff"),
    new THREE.Color("#ffe8c4"),
    new THREE.Color("#c8d6ff"),
    new THREE.Color("#ffd4a8"),
  ];

  for (let i = 0; i < starCount; i++) {
    // Author the stars inside the camera's forward upper dome instead of over
    // a complete sphere where nearly ninety percent were permanently outside
    // the room's yaw envelope.
    const azimuth = (starRng() - 0.5) * THREE.MathUtils.degToRad(120);
    const elevation = THREE.MathUtils.degToRad(2 + Math.pow(starRng(), 0.78) * 30);
    const r = 620 + starRng() * 70;
    const cosElevation = Math.cos(elevation);
    starPositions[i * 3 + 0] = r * cosElevation * Math.sin(azimuth);
    starPositions[i * 3 + 1] = 10 + r * Math.sin(elevation);
    starPositions[i * 3 + 2] = -r * cosElevation * Math.cos(azimuth);

    const col = starPalettes[Math.floor(starRng() * starPalettes.length)];
    starColors[i * 3 + 0] = col.r;
    starColors[i * 3 + 1] = col.g;
    starColors[i * 3 + 2] = col.b;

    const hero = starRng() < 0.075;
    starSizes[i] = hero ? 4.4 + starRng() * 2.1 : 1.5 + starRng() * 2.9;
    starPhases[i] = starRng() * Math.PI * 2;
  }

  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
  starGeo.setAttribute("color", new THREE.BufferAttribute(starColors, 3));
  starGeo.setAttribute("aSize", new THREE.BufferAttribute(starSizes, 1));
  starGeo.setAttribute("aPhase", new THREE.BufferAttribute(starPhases, 1));

  const starShaderMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uPixelRatio: { value: 1.0 },
    },
    vertexShader: `
      attribute float aSize;
      attribute float aPhase;
      attribute vec3 color;
      varying vec3 vColor;
      varying float vAlpha;
      uniform float uTime;
      uniform float uOpacity;
      uniform float uPixelRatio;

      void main() {
        vColor = color;
        // Twinkle factor
        float twinkle = 0.91 + 0.09 * sin(uTime * 1.7 + aPhase);
        vAlpha = twinkle * uOpacity;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(
          aSize * uPixelRatio * (640.0 / max(-mvPosition.z, 1.0)) * twinkle,
          1.2 * uPixelRatio,
          5.2 * uPixelRatio
        );
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      varying float vAlpha;

      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        if (d > 0.5) discard;
        float halo = 1.0 - smoothstep(0.08, 0.5, d);
        float core = 1.0 - smoothstep(0.0, 0.2, d);
        float strength = halo * 0.48 + core * 0.78;
        gl_FragColor = vec4(vColor, vAlpha * strength);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const starMesh = new THREE.Points(starGeo, starShaderMat);
  starMesh.visible = false;
  celestialGroup.add(starMesh);

  // ─── 3b. MILKY WAY BAND ───────────────────────────────────────────────
  // A denser band of blue-white stars along a tilted galactic plane,
  // sharing the star shader so it twinkles and fades with the sky.
  const mwCount = 420;
  const mwPositions = new Float32Array(mwCount * 3);
  const mwColors = new Float32Array(mwCount * 3);
  const mwSizes = new Float32Array(mwCount);
  const mwPhases = new Float32Array(mwCount);
  const mwRng = makeRng(0x4d574159);
  for (let i = 0; i < mwCount; i++) {
    const across = mwRng() * 2 - 1;
    const spread = (mwRng() + mwRng() + mwRng() - 1.5) * 28;
    mwPositions[i * 3 + 0] = across * 520;
    mwPositions[i * 3 + 1] = 150 + across * 105 + spread;
    mwPositions[i * 3 + 2] = -610 - mwRng() * 55;

    const lum = 0.58 + mwRng() * 0.42;
    mwColors[i * 3 + 0] = 0.72 * lum;
    mwColors[i * 3 + 1] = 0.82 * lum;
    mwColors[i * 3 + 2] = lum;
    mwSizes[i] = 1.1 + mwRng() * 2.1;
    mwPhases[i] = mwRng() * Math.PI * 2;
  }
  const mwGeo = new THREE.BufferGeometry();
  mwGeo.setAttribute("position", new THREE.BufferAttribute(mwPositions, 3));
  mwGeo.setAttribute("color", new THREE.BufferAttribute(mwColors, 3));
  mwGeo.setAttribute("aSize", new THREE.BufferAttribute(mwSizes, 1));
  mwGeo.setAttribute("aPhase", new THREE.BufferAttribute(mwPhases, 1));
  const milkyWayStarMat = starShaderMat.clone();
  const mwMesh = new THREE.Points(mwGeo, milkyWayStarMat);
  mwMesh.visible = false;
  celestialGroup.add(mwMesh);

  const milkyWayVeilMat = new THREE.SpriteMaterial({
    map: makeMilkyWayTexture(),
    color: 0xa8bce4,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    rotation: -0.34,
  });
  const milkyWayVeil = new THREE.Sprite(milkyWayVeilMat);
  milkyWayVeil.position.set(0, 145, -625);
  milkyWayVeil.scale.set(760, 138, 1);
  milkyWayVeil.visible = false;
  milkyWayVeil.renderOrder = -2;
  celestialGroup.add(milkyWayVeil);

  // ─── 3c. SHOOTING STARS ───────────────────────────────────────────────
  const METEOR_TRAIL = 14;
  const meteorCount = 1;
  const meteorGeo = new THREE.BufferGeometry();
  meteorGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(meteorCount * METEOR_TRAIL * 3), 3));
  meteorGeo.setAttribute("alpha", new THREE.BufferAttribute(new Float32Array(meteorCount * METEOR_TRAIL), 1));
  const meteorMat = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: 1.0 },
    },
    vertexShader: [
      "attribute float alpha;",
      "varying float vAlpha;",
      "uniform float uPixelRatio;",
      "void main() {",
      "  vAlpha = alpha;",
      "  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);",
      "  float authored = alpha > 0.85 ? 7.0 : 3.2;",
      "  gl_PointSize = clamp(authored * uPixelRatio * (500.0 / max(-mvPosition.z, 1.0)), 1.8 * uPixelRatio, 7.0 * uPixelRatio);",
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
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const meteorPoints = new THREE.Points(meteorGeo, meteorMat);
  meteorPoints.visible = false;
  meteorPoints.renderOrder = 7;
  // The inactive buffer lives at y=-1000. If Three computes and caches that
  // first bounding sphere, the later in-cone streak is culled forever even
  // though its dynamic positions have moved. Fourteen vertices are cheaper to
  // draw-test directly than to recompute a sphere on every active frame.
  meteorPoints.frustumCulled = false;
  celestialGroup.add(meteorPoints);
  // Connect the sparse particle history with one restrained pixel-wide line.
  // Points alone read as a handful of twinkling stars at high-DPI/wide
  // viewports; the line supplies the instantly recognizable shooting-star
  // gesture without adding another meteor or a large glow card.
  const meteorLineMat = new THREE.ShaderMaterial({
    vertexShader: [
      "attribute float alpha;",
      "varying float vAlpha;",
      "void main() {",
      "  vAlpha = alpha;",
      "  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
      "}",
    ].join("\n"),
    fragmentShader: [
      "varying float vAlpha;",
      "void main() {",
      "  gl_FragColor = vec4(1.0, 0.96, 0.84, vAlpha * 0.82);",
      "  #include <colorspace_fragment>",
      "}",
    ].join("\n"),
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const meteorLine = new THREE.Line(meteorGeo, meteorLineMat);
  meteorLine.visible = false;
  meteorLine.renderOrder = 6;
  meteorLine.frustumCulled = false;
  meteorGeo.setDrawRange(0, 0);
  celestialGroup.add(meteorLine);
  const meteors = [];
  for (let i = 0; i < meteorCount; i++) {
    meteors.push({
      active: false,
      // One early delight cue proves the sky is alive, then the much longer
      // repeat interval below keeps it from becoming a screensaver.
      timer: 6 + Math.random() * 6,
      head: new THREE.Vector3(),
      dir: new THREE.Vector3(),
      speed: 0,
      age: 0,
      duration: 0,
      history: Array.from({ length: METEOR_TRAIL }, () => new THREE.Vector3()),
      historyLength: 0,
    });
  }
  let meteorLayerWasVisible = false;

  // ─── 4. POMODORO SATELLITE (ASTROLABE) ──────────────────────────────────
  const satOrbitGroup = new THREE.Group();
  satOrbitGroup.visible = false;
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
    uniforms: {
      uPixelRatio: { value: 1.0 },
    },
    vertexShader: `
      attribute float alpha;
      varying float vAlpha;
      uniform float uPixelRatio;
      void main() {
        vAlpha = alpha;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = (1.0 - alpha * 0.5) * 6.0 * uPixelRatio * (200.0 / -mvPosition.z);
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
  trailPoints.visible = false;
  celestialGroup.add(trailPoints);

  const trailHistory = Array.from({ length: trailCount }, () => new THREE.Vector3());
  const trailWorldPos = new THREE.Vector3();
  let trailHistoryLength = 0;

  // State
  let currentProgress = 0;
  let isFocusActive = false;
  let viewportAspect = 16 / 9;
  let renderPixelRatio = 1;
  let lastCelestialState = null;
  let hasCelestialTarget = false;
  const sunPositionTarget = new THREE.Vector3();
  const moonPositionTarget = new THREE.Vector3();
  const sunLightTarget = new THREE.Vector3();
  const moonLightTarget = new THREE.Vector3();
  const activeLightTarget = new THREE.Vector3();
  const activeLightPosition = new THREE.Vector3();

  // Day/night visibility: T holds the targets from the latest celestial
  // state; L holds the eased live values applied in update(). This makes
  // sunrise/sunset fade instead of snapping between elevation bands.
  const T = { sun: 0, moon: 0, sunLight: 0.01, moonLight: 0.01, hemi: 0.8 };
  const L = { ...T };
  const VISIBILITY_KEYS = ["sun", "moon", "sunLight", "moonLight", "hemi"];
  const SMOOTH = 2.2; // per-second approach rate
  const LIGHT_DISTANCE = 500;
  let motionTime = 0;

  function updateCelestialState(c) {
    if (!c) return;
    keyLight.visible = true;
    lastCelestialState = c;
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
    // Preserve the authored 290-unit landscape arc, but compress only its X
    // axis when the viewport narrows. The 180 coefficient reserves the
    // photosphere/moon radius at the narrower focus-session FOV, so even very
    // tall in-app browser panels keep the complete circular body on screen;
    // the larger corona may still feather naturally beyond the edge.
    const horizontalArc = Math.min(290, 180 * viewportAspect);
    sunPositionTarget.set(Math.cos(angle) * horizontalArc, Math.sin(angle) * 148 + 6, SKY_DEPTH);

    // The backend exposes solar data only, so this is not a real lunar
    // ephemeris. The moon walks its own arc across the night using the
    // timestamp the backend already sends, treating 18:00-06:00 as the
    // night span — so it actually travels instead of parking wherever the
    // sun's depth happens to put it. Approximate, but it moves and it
    // rises and sets on the correct sides.
    const rawNightPct = Number(c.night_arc_pct);
    const nightPct = Number.isFinite(rawNightPct) ? Math.max(0, Math.min(1, rawNightPct)) : 0.5;
    const moonAngle = Math.PI - nightPct * Math.PI;
    moonPositionTarget.set(Math.cos(moonAngle) * horizontalArc, Math.sin(moonAngle) * 148 + 6, SKY_DEPTH - 10);

    // Lighting follows a hemispherical direction independently of the
    // screen-composed sprites. Solar elevation is authoritative; arc progress
    // supplies a stable east-to-west heading because the backend deliberately
    // does not expose azimuth. The illustrative moon mirrors the same journey
    // with a restrained 52-degree apex.
    const solarElevation = THREE.MathUtils.degToRad(Math.max(1.5, Math.min(88, elev)));
    const solarHorizontal = Math.cos(solarElevation);
    sunLightTarget.set(
      Math.cos(angle) * solarHorizontal * LIGHT_DISTANCE,
      Math.sin(solarElevation) * LIGHT_DISTANCE,
      -Math.sin(angle) * solarHorizontal * LIGHT_DISTANCE,
    );

    const moonElevation = THREE.MathUtils.degToRad(2.5 + Math.sin(moonAngle) * 49.5);
    const moonHorizontal = Math.cos(moonElevation);
    moonLightTarget.set(
      Math.cos(moonAngle) * moonHorizontal * LIGHT_DISTANCE,
      Math.sin(moonElevation) * LIGHT_DISTANCE,
      -Math.sin(moonAngle) * moonHorizontal * LIGHT_DISTANCE,
    );

    // Visibility / intensity (targets; update() eases toward them so
    // sunrise/sunset fade instead of snapping)
    // A half-arc has different left/right endpoints, so its server value may
    // wrap at midnight in white-night latitudes. Keep the visual sun and its
    // shadow key fully below the horizon until elevation is positive; the
    // shared atmosphere grade still carries twilight color and brightness.
    const sunF = THREE.MathUtils.smoothstep(elev, 0, 6);
    const moonF = Math.max(0, Math.min(1, (6 - elev) / 12));

    T.sun = sunF;
    T.moon = moonF;
    T.sunLight = Math.max(0.01, sunF * 2.4);
    T.moonLight = Math.max(0.01, moonF * 1.1);
    T.hemi = 0.8 + sunF * 3.5;

    // The first authoritative state establishes a complete frame. Subsequent
    // slider or scheduler changes ease from the live state in update().
    if (!hasCelestialTarget) {
      hasCelestialTarget = true;
      sunGroup.position.copy(sunPositionTarget);
      moonGroup.position.copy(moonPositionTarget);
      const initialBlend = sunF / Math.max(sunF + moonF, 1e-4);
      activeLightPosition.copy(moonLightTarget).lerp(sunLightTarget, initialBlend);
      keyLight.position.copy(activeLightPosition);
      satOrbitGroup.position.copy(moonGroup.position).lerp(sunGroup.position, initialBlend);
    }
  }

  function updatePomodoro(state) {
    if (!state) return;
    isFocusActive = !!state.focus;
    if (isFocusActive && state.pomodoro_duration > 0) {
      currentProgress = Math.max(0, Math.min(1, 1 - state.pomodoro_remaining / state.pomodoro_duration));
      satOrbitGroup.visible = true;
    } else if (state.break) {
      const breakDuration = Number.isFinite(state.break_duration) && state.break_duration > 0
        ? state.break_duration
        : 600;
      currentProgress = Math.max(0, Math.min(1, 1 - state.break_remaining / breakDuration));
      satOrbitGroup.visible = true;
    } else {
      currentProgress = 0;
      satOrbitGroup.visible = false;
    }
  }

  function update(delta, elapsed, atmosphere) {
    const reducedMotion = prefersReducedMotion();
    if (!reducedMotion) motionTime += delta;
    starShaderMat.uniforms.uTime.value = motionTime;
    milkyWayStarMat.uniforms.uTime.value = motionTime;

    const f = 1 - Math.exp(-SMOOTH * delta);
    for (const k of VISIBILITY_KEYS) {
      L[k] = delta < 0.5 ? L[k] + (T[k] - L[k]) * f : T[k];
    }

    if (hasCelestialTarget) {
      const positionEase = delta < 0.5 ? f : 1;
      sunGroup.position.lerp(sunPositionTarget, positionEase);
      moonGroup.position.lerp(moonPositionTarget, positionEase);
      const bodyBlend = L.sun / Math.max(L.sun + L.moon, 1e-4);
      activeLightTarget.copy(moonLightTarget).lerp(sunLightTarget, bodyBlend);
      activeLightPosition.lerp(activeLightTarget, positionEase);
      // One continuous directional light follows the eased active body, so
      // neither its direction nor the owning shadow map can swap mid-fade.
      keyLight.position.copy(activeLightPosition);
      satOrbitGroup.position.copy(moonGroup.position).lerp(sunGroup.position, bodyBlend);
    }

    sunMesh.material.opacity = L.sun;
    coronaSprite.material.opacity = L.sun * 0.9;
    moonMesh.material.opacity = L.moon;
    moonHaloSprite.material.opacity = L.moon * 0.75;
    starShaderMat.uniforms.uOpacity.value = L.moon * 0.92;
    milkyWayStarMat.uniforms.uOpacity.value = L.moon * 0.34;
    milkyWayVeilMat.opacity = L.moon * 0.1;
    const nightSkyVisible = L.moon > 0.01;
    starMesh.visible = nightSkyVisible;
    mwMesh.visible = nightSkyVisible;
    milkyWayVeil.visible = nightSkyVisible;

    if (atmosphere) {
      // Light color and strength come from the shared grade so the key light
      // always agrees with the sky it is supposed to be coming from.
      const g = atmosphere.current;
      const keyBlend = L.sun / Math.max(L.sun + L.moon, 1e-4);
      keyLight.color.copy(g.key);
      // One continuous key owns both illumination and the single shadow map.
      // Its strength matches the former 0.5x moon / 1.0x sun endpoints without
      // swapping which portion of the lighting contribution receives shadow.
      keyLight.intensity = g.keyIntensity * (0.5 + keyBlend * 0.5);
      hemiLight.color.copy(g.ambientSky);
      hemiLight.groundColor.copy(g.ambientGround);
      hemiLight.intensity = g.ambientIntensity + L.sun * 1.5;
      sunMesh.material.color.copy(g.sun);
    } else {
      const keyBlend = L.sun / Math.max(L.sun + L.moon, 1e-4);
      keyLight.intensity = L.moonLight + (L.sunLight - L.moonLight) * keyBlend;
      hemiLight.intensity = L.hemi;
    }

    // Corona subtle breathing
    const breath = reducedMotion ? 1 : 1.0 + Math.sin(motionTime * 1.5) * 0.08;
    coronaSprite.scale.set(120 * breath, 120 * breath, 1);
    const moonBreath = reducedMotion ? 1 : 1.0 + Math.cos(motionTime * 1.2) * 0.05;
    moonHaloSprite.scale.set(80 * moonBreath, 80 * moonBreath, 1);

    // Moon self-rotation
    moonMesh.rotation.y = motionTime * 0.03;

    // Shooting stars — sparse, bright, brief
    const meteorLayerVisible = !reducedMotion && L.moon > 0.05;
    meteorPoints.visible = meteorLayerVisible;
    meteorLine.visible = meteorLayerVisible;
    if (!meteorLayerVisible && meteorLayerWasVisible) {
      for (const m of meteors) {
        m.active = false;
        m.historyLength = 0;
      }
      meteorGeo.setDrawRange(0, 0);
    }
    meteorLayerWasVisible = meteorLayerVisible;
    if (meteorLayerVisible) {
      for (const m of meteors) {
        if (!m.active) {
          m.timer -= delta;
          if (m.timer <= 0) {
            // Spawn inside the authored camera cone. The former hemispherical
            // spawn placed every meteor above the vertical FOV, so its timer
            // ran correctly while users could never see it.
            const direction = Math.random() < 0.5 ? 1 : -1;
            m.head.set(
              -direction * (120 + Math.random() * 100),
              92 + Math.random() * 105,
              -430 - Math.random() * 70,
            );
            m.dir.set(
              direction * (0.86 + Math.random() * 0.12),
              -0.27 - Math.random() * 0.16,
              (Math.random() - 0.5) * 0.05,
            ).normalize();
            m.speed = 175 + Math.random() * 55;
            m.duration = 0.62 + Math.random() * 0.28;
            m.age = 0;
            m.historyLength = 0;
            m.active = true;
          }
        } else {
          m.age += delta;
          m.head.addScaledVector(m.dir, m.speed * delta);
          const last = Math.min(m.historyLength, METEOR_TRAIL - 1);
          for (let i = last; i > 0; i--) m.history[i].copy(m.history[i - 1]);
          m.history[0].copy(m.head);
          m.historyLength = Math.min(METEOR_TRAIL, m.historyLength + 1);
          if (m.age > m.duration) {
            m.active = false;
            m.historyLength = 0;
            m.timer = 35 + Math.random() * 50;
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
          if (!m.active || t >= m.historyLength) {
            mPosAttr.setXYZ(o / 3, 0, -1000, 0);
            mAlphaAttr.setX(mi * METEOR_TRAIL + t, 0);
          } else {
            mPosAttr.setXYZ(o / 3, pt.x, pt.y, pt.z);
            mAlphaAttr.setX(mi * METEOR_TRAIL + t, (1 - t / METEOR_TRAIL) * fade * L.moon);
          }
        }
      }
      mPosAttr.needsUpdate = true;
      mAlphaAttr.needsUpdate = true;
      meteorGeo.setDrawRange(0, meteors[0].active ? meteors[0].historyLength : 0);
    }

    // Satellite rotation & orbit
    if (satOrbitGroup.visible) {
      const satAngle = currentProgress * Math.PI * 2;
      const rotAngle = Math.PI / 6; // incline

      const localX = Math.cos(satAngle) * orbitRadius;
      const localY = Math.sin(satAngle) * orbitRadius * Math.sin(rotAngle);
      const localZ = Math.sin(satAngle) * orbitRadius * Math.cos(rotAngle);
      satMeshGroup.position.set(localX, localY, localZ);

      // Astrolabe ring rotation
      ring1.rotation.y = motionTime * 2.0;
      ring2.rotation.z = motionTime * 1.5;
      satCore.rotation.x = motionTime * 3.0;

      // Update the trail with a preallocated ring. A running 25-minute session
      // used to allocate two Vector3 instances on every frame.
      if (!reducedMotion) {
        satMeshGroup.getWorldPosition(trailWorldPos);
        const last = Math.min(trailHistoryLength, trailCount - 1);
        for (let i = last; i > 0; i--) trailHistory[i].copy(trailHistory[i - 1]);
        trailHistory[0].copy(trailWorldPos);
        trailHistoryLength = Math.min(trailCount, trailHistoryLength + 1);
        const posAttr = trailGeo.attributes.position;
        for (let i = 0; i < trailCount; i++) {
          const pt = i < trailHistoryLength ? trailHistory[i] : trailWorldPos;
          posAttr.setXYZ(i, pt.x, pt.y, pt.z);
        }
        posAttr.needsUpdate = true;
        trailPoints.visible = true;
      } else {
        trailPoints.visible = false;
        trailHistoryLength = 0;
      }
    } else {
      trailPoints.visible = false;
      trailHistoryLength = 0;
    }
  }

  return {
    sunGroup,
    moonGroup,
    keyLight,
    // Compatibility aliases for callers written against the original two-key
    // API. Both now intentionally reference the same continuous light.
    sunLight: keyLight,
    moonLight: keyLight,
    starMesh,
    meteorPoints,
    meteorLine,
    satOrbitGroup,
    updateCelestialState,
    updatePomodoro,
    update,
    setViewportAspect(aspect) {
      if (!Number.isFinite(aspect) || aspect <= 0) return;
      const nextAspect = Math.max(0.35, Math.min(3, aspect));
      if (Math.abs(viewportAspect - nextAspect) < 1e-4) return;
      viewportAspect = nextAspect;
      if (lastCelestialState) updateCelestialState(lastCelestialState);
    },
    setPixelRatio(ratio) {
      if (!Number.isFinite(ratio) || ratio <= 0) return;
      if (Math.abs(renderPixelRatio - ratio) < 1e-4) return;
      renderPixelRatio = ratio;
      starShaderMat.uniforms.uPixelRatio.value = renderPixelRatio;
      milkyWayStarMat.uniforms.uPixelRatio.value = renderPixelRatio;
      meteorMat.uniforms.uPixelRatio.value = renderPixelRatio;
      trailMat.uniforms.uPixelRatio.value = renderPixelRatio;
    },
    // Read-only hook for deterministic regression tests. It does no work in
    // the render loop and exposes no mutable Three.js state.
    getNightSkyDiagnostics() {
      const meteor = meteors[0];
      return {
        active: meteor.active,
        timer: meteor.timer,
        historyLength: meteor.historyLength,
        drawCount: meteorGeo.drawRange.count,
        head: { x: meteor.head.x, y: meteor.head.y, z: meteor.head.z },
      };
    },
  };
}
