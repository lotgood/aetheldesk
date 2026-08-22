import * as THREE from "three";
import { createPostFX } from "./post.js";

export function create3DEngine(container = document.body) {
  const scene = new THREE.Scene();
  // Aerial perspective: the fog color is re-driven every frame from the
  // atmosphere grade so distant geometry dissolves into the sky it sits
  // against, instead of into a fixed slab of night blue.
  scene.fog = new THREE.FogExp2(0x141d33, 0.0042);

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    2000
  );
  camera.position.set(0, 6.2, 25);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  
  // ─── Quality tiers ────────────────────────────────────────────────────
  // Tidewright-style ladder: each tier trades resolution, shadow map size
  // and post passes against GPU budget. "auto" starts at high and only
  // steps down, so a weak device degrades gracefully instead of stuttering
  // at a tier it cannot hold.
  const QUALITY_TIERS = {
    low: { dprCap: 1.0, renderScale: 1.0, shadows: 0, bloom: false, shafts: false, grain: 0.5 },
    medium: { dprCap: 1.5, renderScale: 1.0, shadows: 1024, bloom: true, shafts: false, grain: 0.75 },
    high: { dprCap: 2.0, renderScale: 1.0, shadows: 2048, bloom: true, shafts: true, grain: 1.0 },
    ultra: { dprCap: 2.0, renderScale: 1.25, shadows: 2048, bloom: true, shafts: true, grain: 1.0 },
  };
  const TIER_ORDER = ["low", "medium", "high", "ultra"];
  let qualityMode = "auto";
  let activeTier = "high";
  // User toggles override the tier per-effect; null means "follow the tier".
  const fxOverrides = { bloom: null, shafts: null, shadows: null, grain: null };

  // 5K Mac & Retina optimization: clamp DPR to the tier cap and cap the
  // drawing-buffer area around 4K so the 5K display does not overload
  // the GPU while staying crisp on Retina laptops.
  function resolvePixelRatio() {
    const tier = QUALITY_TIERS[activeTier];
    const base = Math.min(window.devicePixelRatio || 1, tier.dprCap) * tier.renderScale;
    const area = window.innerWidth * base * window.innerHeight * base;
    if (area > 8294400) { // 3840 × 2160
      return Math.sqrt(8294400 / (window.innerWidth * window.innerHeight));
    }
    return base;
  }

  function applyShadows(mapSize) {
    const enabled = mapSize > 0;
    if (renderer.shadowMap.enabled !== enabled) {
      renderer.shadowMap.enabled = enabled;
      // Toggling the shadow system needs lit materials to recompile.
      scene.traverse((o) => {
        if (o.material) o.material.needsUpdate = true;
      });
    }
    if (!enabled) return;
    scene.traverse((o) => {
      // Directional only: the campfire point light would cost a 6-face
      // cube map for a glow that barely throws a readable shadow.
      if (o.isDirectionalLight && o.shadow) {
        o.castShadow = true;
        if (o.shadow.mapSize.x !== mapSize) {
          o.shadow.mapSize.set(mapSize, mapSize);
          if (o.shadow.map) {
            o.shadow.map.dispose();
            o.shadow.map = null;
          }
        }
      }
    });
  }

  function applyFX() {
    const tier = QUALITY_TIERS[activeTier];
    post.setOptions({
      bloom: fxOverrides.bloom ?? tier.bloom,
      shafts: fxOverrides.shafts ?? tier.shafts,
      grain: fxOverrides.grain === false ? 0 : tier.grain,
    });
    applyShadows((fxOverrides.shadows ?? tier.shadows > 0) ? tier.shadows || 2048 : 0);
  }

  function applyTier(name) {
    if (!QUALITY_TIERS[name]) return;
    activeTier = name;
    renderer.setPixelRatio(resolvePixelRatio());
    post.setSize(window.innerWidth, window.innerHeight);
    applyFX();
  }

  function setQuality(name) {
    if (name === "auto") {
      qualityMode = "auto";
      applyTier("high");
      return;
    }
    if (!QUALITY_TIERS[name]) return;
    qualityMode = "manual";
    applyTier(name);
  }

  function setFX(next) {
    if (!next) return;
    for (const k of ["bloom", "shafts", "shadows", "grain"]) {
      if (k in next) fxOverrides[k] = next[k];
    }
    applyFX();
  }

  function getEffectiveFX() {
    const tier = QUALITY_TIERS[activeTier];
    return {
      bloom: fxOverrides.bloom ?? tier.bloom,
      shafts: fxOverrides.shafts ?? tier.shafts,
      grain: fxOverrides.grain === false ? 0 : tier.grain,
      shadows: fxOverrides.shadows ?? tier.shadows > 0,
    };
  }

  const dpr = resolvePixelRatio();
  renderer.setPixelRatio(dpr);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const canvas = renderer.domElement;
  canvas.id = "aethel-3d-canvas";
  canvas.style.position = "fixed";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.zIndex = "-1";
  canvas.style.pointerEvents = "none";
  container.insertBefore(canvas, container.firstChild);

  // Parallax / Camera damping control
  const mouse = { x: 0, y: 0, targetX: 0, targetY: 0 };
  let isPointerDown = false;
  let startX = 0, startY = 0;
  let cameraAngleX = 0, cameraAngleY = 0;
  let targetAngleX = 0, targetAngleY = 0;

  function onPointerMove(e) {
    const nx = (e.clientX / window.innerWidth) * 2 - 1;
    const ny = -(e.clientY / window.innerHeight) * 2 + 1;
    mouse.targetX = nx * 0.5;
    mouse.targetY = ny * 0.3;

    if (isPointerDown) {
      const dx = (e.clientX - startX) * 0.003;
      const dy = (e.clientY - startY) * 0.003;
      targetAngleX += dx;
      targetAngleY = Math.max(-0.4, Math.min(0.6, targetAngleY + dy));
      startX = e.clientX;
      startY = e.clientY;
    }
  }

  function onPointerDown(e) {
    // Only capture drag if not clicking UI buttons
    if (e.target.closest("button, input, [role='dialog'], .interactive, .ctrl-bar, .liquid-glass, #pom-time")) return;
    isPointerDown = true;
    startX = e.clientX;
    startY = e.clientY;
  }

  function onPointerUp() {
    isPointerDown = false;
  }

  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("pointerdown", onPointerDown, { passive: true });
  window.addEventListener("pointerup", onPointerUp, { passive: true });

  const tickCallbacks = new Set();
  const timer = new THREE.Timer();
  let animationFrameId = null;

  // Bloom + grade + grain. Built here so the composer owns the same size and
  // pixel ratio as the renderer from the first frame.
  const post = createPostFX({ renderer, scene, camera });
  // The grade is driven by the shared atmosphere, which scenes.js owns.
  let atmosphere = null;

  function prefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  // FPS watchdog for auto quality: a rolling window of real frame times,
  // stepping down one tier at a time and never back up on its own. Frames
  // after a tab switch (delta > 0.25s) are excluded so returning to the tab
  // does not read as a performance collapse.
  let fpsTime = 0;
  let fpsFrames = 0;
  const WATCHDOG_WINDOW = 4;
  const STEP_DOWN_FPS = 45;

  function renderLoop() {
    animationFrameId = requestAnimationFrame(renderLoop);

    timer.update();
    const delta = timer.getDelta();
    const elapsedTime = timer.getElapsed();

    if (qualityMode === "auto" && delta > 0 && delta < 0.25) {
      fpsTime += delta;
      fpsFrames++;
      if (fpsTime >= WATCHDOG_WINDOW) {
        const avgFps = fpsFrames / fpsTime;
        fpsTime = 0;
        fpsFrames = 0;
        const idx = TIER_ORDER.indexOf(activeTier);
        if (avgFps < STEP_DOWN_FPS && idx > 0) {
          applyTier(TIER_ORDER[idx - 1]);
        }
      }
    }

    if (!prefersReducedMotion()) {
      mouse.x += (mouse.targetX - mouse.x) * 0.05;
      mouse.y += (mouse.targetY - mouse.y) * 0.05;
      cameraAngleX += (targetAngleX - cameraAngleX) * 0.08;
      cameraAngleY += (targetAngleY - cameraAngleY) * 0.08;

      // Base camera position + orbit angle + subtle mouse parallax
      const radius = 25;
      camera.position.x = radius * Math.sin(cameraAngleX) + mouse.x * 1.5;
      camera.position.y = 6.2 + radius * Math.sin(cameraAngleY) + mouse.y * 1.0;
      camera.position.z = radius * Math.cos(cameraAngleX) * Math.cos(cameraAngleY);
      camera.lookAt(0, 4.2 + mouse.y * 0.5, 0);
    }

    // Ticks always run: they carry the atmosphere grade, the sky gradient and
    // the celestial easing, not just decoration. Gating them on motion
    // preference used to freeze reduced-motion users in the startup night
    // palette. Scenes damp their own motion by delta.
    for (const cb of tickCallbacks) {
      cb(delta, elapsedTime);
    }

    post.render(delta, elapsedTime, atmosphere);
  }

  function resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    renderer.setPixelRatio(resolvePixelRatio());
    post.setSize(width, height);
  }

  window.addEventListener("resize", resize);
  renderLoop();

  return {
    scene,
    camera,
    renderer,
    canvas,
    onTick(cb) {
      tickCallbacks.add(cb);
      return () => tickCallbacks.delete(cb);
    },
    resize,
    setAtmosphere(a) {
      atmosphere = a;
    },
    setLightSource(pos) {
      post.setLightWorldPosition(pos);
    },
    setQuality,
    getQuality: () => ({ mode: qualityMode, tier: activeTier }),
    setFX,
    getEffectiveFX,
    destroy() {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      post.dispose();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      tickCallbacks.clear();
      renderer.dispose();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }
  };
}