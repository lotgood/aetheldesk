import * as THREE from "three";
import { createPostFX } from "./post.js";
import { prefersReducedMotion } from "./motion.js";

const MAX_EFFECTIVE_DPR = 2;

function disposeSceneResources(scene) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();

  function collectTexture(value) {
    if (value?.isTexture) textures.add(value);
    else if (Array.isArray(value)) {
      for (const item of value) collectTexture(item);
    }
  }

  function collectMaterial(material) {
    if (!material || materials.has(material)) return;
    materials.add(material);
    for (const value of Object.values(material)) collectTexture(value);
    if (material.uniforms) {
      for (const uniform of Object.values(material.uniforms)) collectTexture(uniform?.value);
    }
  }

  collectTexture(scene.background);
  collectTexture(scene.environment);
  collectMaterial(scene.overrideMaterial);
  scene.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) collectMaterial(material);
    collectMaterial(object.customDepthMaterial);
    collectMaterial(object.customDistanceMaterial);
    collectTexture(object.skeleton?.boneTexture);
    if (object.shadow?.map) {
      object.shadow.map.dispose();
      object.shadow.map = null;
    }
  });

  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
  scene.clear();
}

export function create3DEngine(container = document.body, { onFatal, onFirstFrame } = {}) {
  let animationFrameId = null;
  let resizePending = false;
  let fatalReported = false;
  let firstFrameReported = false;
  let firstFramePublishScheduled = false;
  let successfulFrameSerial = 0;
  let contentReadyFrameSerial = null;
  let destroyed = false;
  const frameWaiters = new Set();
  const presentationFrameIds = new Set();

  function afterPresentation(callback) {
    const frameId = requestAnimationFrame(() => {
      presentationFrameIds.delete(frameId);
      if (!destroyed && !fatalReported) callback();
    });
    presentationFrameIds.add(frameId);
  }

  function resolveFrameWaiters(value) {
    for (const waiter of frameWaiters) waiter.resolve(value);
    frameWaiters.clear();
  }

  function reportFatal(reason, phase, event = null) {
    if (fatalReported || destroyed) return;
    fatalReported = true;
    if (animationFrameId !== null) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    for (const frameId of presentationFrameIds) cancelAnimationFrame(frameId);
    presentationFrameIds.clear();
    resolveFrameWaiters(false);

    const error = reason instanceof Error ? reason : new Error(String(reason || "Unknown WebGL failure"));
    console.error(`[AethelDesk 3D] Fatal ${phase} failure.`, error);
    if (typeof onFatal === "function") {
      try {
        onFatal(error, { phase, event });
      } catch (callbackError) {
        console.error("[AethelDesk 3D] The fatal-error callback failed.", callbackError);
      }
    }
  }

  const scene = new THREE.Scene();
  // Aerial perspective: the fog color is re-driven every frame from the
  // atmosphere grade so distant geometry dissolves into the sky it sits
  // against, instead of into a fixed slab of night blue.
  scene.fog = new THREE.FogExp2(0x141d33, 0.0042);

  function getContainerSize() {
    const rect = container.getBoundingClientRect();
    return {
      width: Math.max(1, rect.width || container.clientWidth || window.innerWidth),
      height: Math.max(1, rect.height || container.clientHeight || window.innerHeight),
    };
  }

  const initialSize = getContainerSize();
  const camera = new THREE.PerspectiveCamera(55, initialSize.width / initialSize.height, 0.1, 2000);
  camera.position.set(0, 6.2, 25);

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
  } catch (error) {
    reportFatal(error, "context-creation");
    throw error;
  }

  renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
    const diagnostics = [
      gl.getProgramInfoLog(program),
      gl.getShaderInfoLog(vertexShader),
      gl.getShaderInfoLog(fragmentShader),
    ].filter(Boolean).join("\n");
    reportFatal(
      new Error(diagnostics ? `WebGL shader compilation or linkage failed:\n${diagnostics}` : "WebGL shader compilation or linkage failed."),
      "shader",
    );
  };
  
  // ─── Quality tiers ────────────────────────────────────────────────────
  // Tidewright-style ladder: each tier trades resolution, shadow map size
  // and post passes against GPU budget. "auto" starts at medium on coarse or
  // constrained devices, high elsewhere, and only steps down after startup.
  const QUALITY_TIERS = {
    low: { dprCap: 1.0, renderScale: 1.0, maxPixels: 2073600, shadows: 0, bloom: false, shafts: false, grain: 0.5 },
    medium: { dprCap: 1.5, renderScale: 1.0, maxPixels: 3686400, shadows: 1024, bloom: true, shafts: false, grain: 0.75 },
    high: { dprCap: 2.0, renderScale: 1.0, maxPixels: 5000000, shadows: 2048, bloom: true, shafts: true, grain: 1.0 },
    ultra: { dprCap: 2.0, renderScale: 1.25, maxPixels: 8294400, shadows: 2048, bloom: true, shafts: true, grain: 1.0 },
  };
  const TIER_ORDER = ["low", "medium", "high", "ultra"];
  const coarsePointer = window.matchMedia?.("(pointer: coarse)").matches;
  const constrainedCpu = Number.isFinite(navigator.hardwareConcurrency) && navigator.hardwareConcurrency <= 4;
  const AUTO_START_TIER = coarsePointer || constrainedCpu ? "medium" : "high";
  let qualityMode = "auto";
  let activeTier = AUTO_START_TIER;
  let pendingTier = null;
  let fxPending = false;
  let bloomSuppressed = false;
  // User toggles override the tier per-effect; null means "follow the tier".
  const fxOverrides = { bloom: null, shafts: null, shadows: null, grain: null };
  let shadowSource = null;
  let activeShadowMapSize = 0;

  // Retina optimization: each tier owns both a DPR cap and a total-pixel
  // budget. Low/medium therefore stay affordable on large monitors, while
  // the explicit ultra tier can spend up to a 4K drawing buffer.
  function resolvePixelRatio(width, height) {
    const tier = QUALITY_TIERS[activeTier];
    const base = Math.min(window.devicePixelRatio || 1, tier.dprCap) * tier.renderScale;
    if (!Number.isFinite(width) || !Number.isFinite(height)) ({ width, height } = getContainerSize());
    const areaCapRatio = Math.sqrt(tier.maxPixels / (width * height));
    return Math.min(MAX_EFFECTIVE_DPR, base, areaCapRatio);
  }

  function applyShadows(mapSize) {
    activeShadowMapSize = mapSize;
    // Only the active celestial key light gets a shadow pass. Rendering both
    // 2048px directional maps every frame doubled the largest scene-side GPU
    // cost while one of those lights was visually dormant.
    const enabled = mapSize > 0 && Boolean(shadowSource);
    if (renderer.shadowMap.enabled !== enabled) {
      renderer.shadowMap.enabled = enabled;
      // Toggling the shadow system needs lit materials to recompile.
      scene.traverse((o) => {
        if (o.material) o.material.needsUpdate = true;
      });
    }
    scene.traverse((o) => {
      if (o.isDirectionalLight && o.shadow) {
        const shouldCast = enabled && o === shadowSource;
        o.castShadow = shouldCast;
        if (!shouldCast && o.shadow.map) {
          o.shadow.map.dispose();
          o.shadow.map = null;
        }
        if (shouldCast && o.shadow.mapSize.x !== mapSize) {
          o.shadow.mapSize.set(mapSize, mapSize);
          if (o.shadow.map) {
            o.shadow.map.dispose();
            o.shadow.map = null;
          }
        }
      }
    });
  }

  function setShadowSource(light) {
    const next = light?.isDirectionalLight ? light : null;
    if (shadowSource === next) return;
    shadowSource = next;
    applyShadows(activeShadowMapSize);
  }

  function applyFX() {
    const tier = QUALITY_TIERS[activeTier];
    const effectiveBloom = !bloomSuppressed && (fxOverrides.bloom ?? tier.bloom);
    post.setOptions({
      // UnrealBloomPass intermittently presents an empty frame for the
      // full-screen animated ocean on Chromium/WebKit. The beach keeps its
      // sprite corona, shafts and film grade; only this unstable pass is gated.
      bloom: effectiveBloom,
      shafts: fxOverrides.shafts ?? tier.shafts,
      grain: fxOverrides.grain === false ? 0 : tier.grain,
    });
    const shadowsEnabled = fxOverrides.shadows ?? tier.shadows > 0;
    renderer.domElement.dataset.bloomActive = String(effectiveBloom);
    renderer.domElement.dataset.bloomSuppressed = String(bloomSuppressed);
    // An explicit shadow opt-in at low quality is capped at the medium map
    // size instead of silently restoring a pair of ultra-sized maps.
    applyShadows(shadowsEnabled ? tier.shadows || 1024 : 0);
  }

  function setQuality(name) {
    if (name === "auto") {
      qualityMode = "auto";
      pendingTier = AUTO_START_TIER;
      return;
    }
    if (!QUALITY_TIERS[name]) return;
    qualityMode = "manual";
    pendingTier = name;
  }

  function setFX(next) {
    if (!next) return;
    for (const k of ["bloom", "shafts", "shadows", "grain"]) {
      if (k in next) fxOverrides[k] = next[k];
    }
    fxPending = true;
  }

  function setBloomSuppressed(suppressed) {
    const next = Boolean(suppressed);
    if (bloomSuppressed === next) return;
    bloomSuppressed = next;
    fxPending = true;
  }

  function getPreferredFX() {
    const tier = QUALITY_TIERS[pendingTier || activeTier];
    return {
      bloom: fxOverrides.bloom ?? tier.bloom,
      shafts: fxOverrides.shafts ?? tier.shafts,
      grain: fxOverrides.grain === false ? 0 : tier.grain,
      shadows: fxOverrides.shadows ?? tier.shadows > 0,
    };
  }

  function getEffectiveFX() {
    const preferred = getPreferredFX();
    return { ...preferred, bloom: !bloomSuppressed && preferred.bloom };
  }

  const dpr = resolvePixelRatio(initialSize.width, initialSize.height);
  renderer.setDrawingBufferSize(initialSize.width, initialSize.height, dpr);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // Construct the post stack before publishing the canvas or registering any
  // global input listeners. If a browser/driver rejects a render target here,
  // create3DEngine never returns an owner that scenes.js could destroy, so the
  // setup itself must remain transactional.
  let post;
  try {
    post = createPostFX({ renderer, scene, camera });
  } catch (error) {
    disposeSceneResources(scene);
    renderer.dispose();
    reportFatal(error, "post-initialization");
    throw error;
  }

  const canvas = renderer.domElement;
  canvas.id = "aethel-3d-canvas";
  canvas.style.position = "absolute";
  canvas.style.inset = "0";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.zIndex = "-1";
  canvas.style.pointerEvents = "none";
  canvas.setAttribute("aria-hidden", "true");
  try {
    container.insertBefore(canvas, container.firstChild);
  } catch (error) {
    post.dispose();
    disposeSceneResources(scene);
    renderer.dispose();
    reportFatal(error, "canvas-mount");
    throw error;
  }

  function onContextLost(event) {
    event.preventDefault();
    reportFatal(new Error("WebGL context was lost."), "context-lost", event);
  }

  function onContextCreationError(event) {
    const message = event.statusMessage || "WebGL context creation failed.";
    reportFatal(new Error(message), "context-creation", event);
  }

  canvas.addEventListener("webglcontextlost", onContextLost);
  canvas.addEventListener("webglcontextcreationerror", onContextCreationError);

  // Parallax / Camera damping control
  const mouse = { x: 0, y: 0, targetX: 0, targetY: 0 };
  let isPointerDown = false;
  let startX = 0, startY = 0;
  let cameraAngleX = 0, cameraAngleY = 0;
  let targetAngleX = 0, targetAngleY = 0;

  function onPointerMove(e) {
    if (prefersReducedMotion()) {
      mouse.targetX = 0;
      mouse.targetY = 0;
      isPointerDown = false;
      return;
    }
    const rect = container.getBoundingClientRect();
    const inside =
      e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inside && !isPointerDown) {
      mouse.targetX = 0;
      mouse.targetY = 0;
      return;
    }
    const nx = Math.max(-1, Math.min(1, ((e.clientX - rect.left) / rect.width) * 2 - 1));
    const ny = Math.max(-1, Math.min(1, -((e.clientY - rect.top) / rect.height) * 2 + 1));
    mouse.targetX = nx * 0.5;
    mouse.targetY = ny * 0.3;

    if (isPointerDown) {
      const dx = (e.clientX - startX) * 0.003;
      const dy = (e.clientY - startY) * 0.003;
      // Every authored scene faces the shared -Z horizon. Keep exploration
      // inside that composed view instead of allowing a 180-degree drag into
      // empty backsides, and prevent latent reduced-motion drags from jumping
      // when the preference is later disabled.
      targetAngleX = Math.max(-0.35, Math.min(0.35, targetAngleX + dx));
      targetAngleY = Math.max(-0.4, Math.min(0.6, targetAngleY + dy));
      startX = e.clientX;
      startY = e.clientY;
    }
  }

  function onPointerDown(e) {
    if (!(e.target instanceof Element) || !container.contains(e.target)) return;
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
  window.addEventListener("pointercancel", onPointerUp, { passive: true });
  window.addEventListener("blur", onPointerUp);

  const tickCallbacks = new Set();
  const timer = new THREE.Timer();

  // The grade is driven by the shared atmosphere, which scenes.js owns.
  let atmosphere = null;

  // FPS watchdog for auto quality: a rolling window of real frame times,
  // stepping down one tier at a time and never back up on its own. Frames
  // after a tab switch (delta > 0.25s) are excluded so returning to the tab
  // does not read as a performance collapse.
  let fpsTime = 0;
  let fpsFrames = 0;
  const WATCHDOG_WINDOW = 4;
  const STEP_DOWN_FPS = 45;

  let rendererWidth = initialSize.width;
  let rendererHeight = initialSize.height;
  let rendererPixelRatio = dpr;

  function applyRendererMetrics(width, height) {
    const nextPixelRatio = resolvePixelRatio(width, height);
    const ratioChanged = Math.abs(rendererPixelRatio - nextPixelRatio) >= 1e-4;
    const sizeChanged = rendererWidth !== width || rendererHeight !== height;
    if (!ratioChanged && !sizeChanged) return;

    // Canvas width/height writes clear the default framebuffer. Update logical
    // size and DPR through Three's single allocation API, then resize the
    // physical composer targets once before this same rAF draws a full frame.
    renderer.setDrawingBufferSize(width, height, nextPixelRatio);
    rendererPixelRatio = nextPixelRatio;
    rendererWidth = width;
    rendererHeight = height;
    post.setSize(width, height);
  }

  function applyPendingConfiguration() {
    const requestedTier = pendingTier;
    pendingTier = null;
    const tierChanged = Boolean(requestedTier && requestedTier !== activeTier);
    if (tierChanged) activeTier = requestedTier;

    if (resizePending || tierChanged) {
      resizePending = false;
      const { width, height } = getContainerSize();
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      applyRendererMetrics(width, height);
    }

    if (tierChanged || fxPending) {
      fxPending = false;
      applyFX();
    }
  }

  function afterNextStableRender() {
    if (destroyed || fatalReported) return Promise.resolve(false);
    return new Promise(resolve => {
      frameWaiters.add({ target: successfulFrameSerial + 1, scheduled: false, resolve });
    });
  }

  function renderLoop() {
    if (destroyed || fatalReported) return;
    animationFrameId = requestAnimationFrame(renderLoop);

    timer.update();
    const delta = timer.getDelta();
    const elapsedTime = timer.getElapsed();

    // Browsers throttle hidden tabs, but they may still grant occasional
    // frames. Skip all GPU work on those frames and let the next server state
    // bring the atmosphere current when the page becomes visible again.
    if (document.hidden) return;

    try {
      // Resize, DPR, quality and post-target changes are atomic with the draw:
      // no callback can finish after clearing buffers without rendering them.
      applyPendingConfiguration();

      if (qualityMode === "auto" && delta > 0 && delta < 0.25) {
        fpsTime += delta;
        fpsFrames++;
        if (fpsTime >= WATCHDOG_WINDOW) {
          const avgFps = fpsFrames / fpsTime;
          fpsTime = 0;
          fpsFrames = 0;
          const idx = TIER_ORDER.indexOf(activeTier);
          if (avgFps < STEP_DOWN_FPS && idx > 0) {
            pendingTier = TIER_ORDER[idx - 1];
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
    } catch (error) {
      reportFatal(error, "tick");
      return;
    }

    try {
      post.render(delta, elapsedTime, atmosphere);
      // renderer.debug.onShaderError reports through a callback and does not
      // necessarily throw out of post.render(). Never count that frame as a
      // completed render or resolve a scene-transition waiter from it.
      if (fatalReported || destroyed) return;
      successfulFrameSerial++;

      for (const waiter of frameWaiters) {
        if (waiter.scheduled || waiter.target > successfulFrameSerial) continue;
        waiter.scheduled = true;
        afterPresentation(() => {
          frameWaiters.delete(waiter);
          waiter.resolve(true);
        });
      }

      // Keep the complete DOM sky visible while the driver compiles the
      // first shader set. Require two complete post frames, then publish only
      // on the following display turn (after a third renderLoop registered
      // earlier in the rAF queue). This avoids replacing the DOM fallback with
      // a merely submitted cold GPU frame.
      if (
        contentReadyFrameSerial !== null
        && !firstFrameReported
        && !firstFramePublishScheduled
        && successfulFrameSerial >= contentReadyFrameSerial + 2
      ) {
        firstFramePublishScheduled = true;
        afterPresentation(() => {
          firstFrameReported = true;
          if (typeof onFirstFrame === "function") {
            try {
              onFirstFrame();
            } catch (callbackError) {
              console.error("[AethelDesk 3D] The first-frame callback failed.", callbackError);
            }
          }
        });
      }
    } catch (error) {
      reportFatal(error, "post-render");
    }
  }

  function applyResize() {
    resizePending = true;
  }

  function resize() {
    applyResize();
  }

  window.addEventListener("resize", resize);
  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  resizeObserver?.observe(container);
  // Publish the engine to its owner before any frame can fail. A synchronous
  // first render could report a fatal shader/driver error while scenes.js
  // still had no engine reference to tear down, leaving a frozen blank canvas.
  animationFrameId = requestAnimationFrame(renderLoop);

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
    setShadowSource,
    setQuality,
    getQuality: () => ({ mode: qualityMode, tier: pendingTier || activeTier }),
    setFX,
    setBloomSuppressed,
    getPreferredFX,
    getEffectiveFX,
    afterNextStableRender,
    markContentReady() {
      if (contentReadyFrameSerial === null) contentReadyFrameSerial = successfulFrameSerial;
    },
    isOperational: () => !destroyed && !fatalReported,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
      for (const frameId of presentationFrameIds) cancelAnimationFrame(frameId);
      presentationFrameIds.clear();
      resolveFrameWaiters(false);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("blur", onPointerUp);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextcreationerror", onContextCreationError);
      tickCallbacks.clear();
      post.dispose();
      disposeSceneResources(scene);
      renderer.dispose();
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
    }
  };
}
