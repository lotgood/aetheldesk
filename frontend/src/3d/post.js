import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { createSunShaftsPass } from "./sun-shafts.js";
import { prefersReducedMotion } from "./motion.js";

// ─── Post / grade ────────────────────────────────────────────────────────
// A forward render of untextured geometry reads flat no matter how good the
// palette is; the finish lives in the pass after the render. Chain is
// render -> bloom -> grade -> tonemap, so the grade operates on linear HDR
// values and the ACES curve is applied once, at the very end.
//
// The grade is luma-driven rather than a fixed filter: highlights are
// multiplied toward the key light, shadows are lifted toward the ambient
// bounce, midtones get a touch of warmth, then saturation is pushed slightly
// past neutral. Vignette, grain and chromatic aberration follow, with grain
// getting coarser at night the way pushed film does.

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uNight: { value: 1 },
    uVignette: { value: 0.42 },
    uGrain: { value: 1 },
    uSaturation: { value: 1.14 },
    uBlack: { value: 0.035 },
    uShadowTint: { value: new THREE.Color(0.03, 0.052, 0.084) },
    uHighTint: { value: new THREE.Color(1.045, 1.0, 0.938) },
    uCA: { value: 0.55 },
    uTexelSize: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uNight;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uSaturation;
    uniform float uBlack;
    uniform vec3  uShadowTint;
    uniform vec3  uHighTint;
    uniform float uCA;
    uniform vec2  uTexelSize;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    float hash12(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 ctr = vUv - 0.5;
      float r2 = dot(ctr, ctr);

      // Radial chromatic aberration: zero in the centre, a fraction of a
      // pixel at the corners. Enough to read as a lens, not as a defect.
      vec3 c;
      if (uCA > 0.0001) {
        float radius = sqrt(r2);
        vec2 radial = r2 > 1e-8 ? ctr / radius : vec2(0.0);
        float edge = smoothstep(0.0, 0.70710678, radius);
        vec2 offset = radial * uTexelSize * (uCA * 0.5 * edge);
        c.r = texture2D(tDiffuse, vUv + offset).r;
        c.g = texture2D(tDiffuse, vUv).g;
        c.b = texture2D(tDiffuse, vUv - offset).b;
      } else {
        c = texture2D(tDiffuse, vUv).rgb;
      }

      // Split tone, driven by luminance so it separates the frame instead of
      // washing a single hue over everything.
      float l = luma(c);
      c *= mix(vec3(1.0), uHighTint, smoothstep(0.30, 1.0, l));
      // Shadow lift is a shadow operation: fading it out by mid grey keeps it
      // from adding a flat wash across an already-bright daylight sky.
      c += uShadowTint * (1.0 - smoothstep(0.0, 0.42, l)) * 0.30;
      c *= mix(vec3(1.0), vec3(1.022, 1.003, 0.978), smoothstep(0.08, 0.62, l));
      // Roll the top end back down: the highlight multiply above pushes
      // near-white sky past 1.0, where the tonemap can no longer separate it.
      c /= 1.0 + max(l - 0.85, 0.0) * 0.9;

      // Black point. Measured frames had a mean of ~183/255 with a p95 of
      // 222 — the entire image crowded into the top third with no dark end
      // at all, which reads as a bright flat wall rather than a photograph.
      // Anchoring the floor is what gives the frame somewhere to rest.
      c = max(c - uBlack, vec3(0.0)) / max(1.0 - uBlack, 1e-3);

      // Saturation just past neutral. Recompute luminance after the shoulder
      // and black-point operations; using the pre-grade luma biased shadow
      // colors and made long viewing sessions feel artificially tinted.
      float gradedLuma = luma(c);
      c = mix(vec3(gradedLuma), c, uSaturation);

      // Vignette.
      c *= 1.0 - uVignette * smoothstep(0.18, 0.86, r2 * 1.35);

      // Grain: coarser and stronger at night, and pulled back in highlights
      // so daylight skies stay clean.
      float n = hash12(gl_FragCoord.xy + fract(uTime) * vec2(311.7, 127.1));
      // Fine-grain stock: exactly 45% of the previous day/night amplitude.
      float amt = uGrain * (0.0036 + 0.0081 * uNight) * (1.15 - luma(c) * 0.55);
      c += (n - 0.5) * amt;

      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }
  `,
};

/**
 * RGBA16F renderability is optional even on WebGL 2. Query the live renderer
 * instead of assuming the texture type from browser/version strings.
 */
export function resolvePostTargetProfile(renderer) {
  const hasExtension = renderer?.extensions?.has?.bind(renderer.extensions);
  let hdr = false;
  if (hasExtension) {
    try {
      hdr = hasExtension("EXT_color_buffer_float") || hasExtension("EXT_color_buffer_half_float");
    } catch {
      hdr = false;
    }
  }
  return {
    hdr,
    textureType: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
  };
}

export function createPostFX({ renderer, scene, camera }) {
  const size = renderer.getSize(new THREE.Vector2());
  const initialPixelRatio = renderer.getPixelRatio();
  const effectSize = new THREE.Vector2(
    Math.max(1, Math.floor(size.x * initialPixelRatio)),
    Math.max(1, Math.floor(size.y * initialPixelRatio)),
  );
  const targetProfile = resolvePostTargetProfile(renderer);

  // Keep the composer in physical pixels with DPR=1. This lets a renderer
  // size+DPR change resize every target exactly once instead of
  // setPixelRatio() reallocating at the old size before setSize() runs.
  const composerTarget = new THREE.WebGLRenderTarget(effectSize.x, effectSize.y, {
    type: targetProfile.textureType,
    depthBuffer: true,
  });
  const composer = new EffectComposer(renderer, composerTarget);
  composer.setPixelRatio(1);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // Bloom is atmosphere, not a glow filter: low strength, high threshold, so
  // only the sun, the moon and the fire actually bleed.
  // Threshold sits high on purpose: a daylight sky is already near 1.0, so a
  // low threshold makes the whole dome bloom into itself and the frame goes
  // white. Only emissive bodies and the fire should clear this bar.
  const bloom = new UnrealBloomPass(effectSize, 0.22, 0.6, 1.05);
  bloom.enabled = targetProfile.hdr;
  composer.addPass(bloom);

  // Sun shafts sit after bloom so the disc/corona bleed feeds the rays, and
  // before the grade so the added light is split-toned and vignetted like
  // everything else.
  const shafts = createSunShaftsPass(effectSize.x, effectSize.y, {
    textureType: targetProfile.textureType,
  });
  shafts.pass.enabled = targetProfile.hdr;
  composer.addPass(shafts.pass);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  // Applies the renderer's ACES tone mapping and sRGB conversion once, after
  // grading, instead of the render pass doing it before.
  const output = new OutputPass();
  composer.addPass(output);
  grade.uniforms.uTexelSize.value.set(1 / effectSize.x, 1 / effectSize.y);

  const scratch = new THREE.Color();
  const lightWorld = new THREE.Vector3();
  const lightView = new THREE.Vector3();
  let lightWorldSet = false;
  let composerWidth = effectSize.x;
  let composerHeight = effectSize.y;
  let disposed = false;

  // User/quality-tier overrides. Base values still come from the atmosphere
  // grade every frame; these multiply or gate them.
  const options = { bloom: true, grain: 1, shafts: true, ca: 1 };

  function setOptions(next) {
    if (!next) return;
    if (typeof next.bloom === "boolean") options.bloom = next.bloom;
    if (typeof next.shafts === "boolean") options.shafts = next.shafts;
    if (typeof next.grain === "number") options.grain = next.grain;
    if (typeof next.ca === "number") options.ca = next.ca;
    bloom.enabled = targetProfile.hdr && options.bloom;
  }

  /** scenes.js feeds the active celestial body (sun by day, moon at night). */
  function setLightWorldPosition(pos) {
    lightWorld.copy(pos);
    lightWorldSet = true;
  }

  function setSize(width, height) {
    const nextPixelRatio = renderer.getPixelRatio();
    const physicalWidth = Math.max(1, Math.floor(width * nextPixelRatio));
    const physicalHeight = Math.max(1, Math.floor(height * nextPixelRatio));
    if (composerWidth === physicalWidth && composerHeight === physicalHeight) return;

    composer.setSize(physicalWidth, physicalHeight);
    composerWidth = physicalWidth;
    composerHeight = physicalHeight;
    grade.uniforms.uTexelSize.value.set(
      1 / physicalWidth,
      1 / physicalHeight,
    );
  }

  function applyGrade(atmosphere) {
    if (!atmosphere) return;
    const g = atmosphere.current;
    const day = atmosphere.daylight;
    const night = 1 - day;
    const u = grade.uniforms;

    u.uNight.value = night;

    // Shadow lift takes the ambient bounce, scaled down so it tints rather
    // than fogs; highlight tint takes the key light.
    scratch.copy(g.ambientGround).lerp(g.ambientSky, 0.45);
    u.uShadowTint.value.setRGB(scratch.r * 0.16, scratch.g * 0.17, scratch.b * 0.2);
    scratch.copy(g.key);
    u.uHighTint.value.setRGB(0.94 + scratch.r * 0.08, 0.95 + scratch.g * 0.05, 0.95 + scratch.b * 0.04);

    // Black point is a daylight tool. At night the frame is already sitting
    // on the floor, and subtracting from it just crushes the moonlit
    // silhouettes into solid black.
    // Preserve textured forest floor and asphalt detail behind the UI. The
    // former black point looked punchy in a still, but crushed the lower half
    // of the frame during a full focus session.
    u.uBlack.value = 0.004 + day * 0.018;

    u.uVignette.value = 0.22 + night * 0.19;
    u.uSaturation.value = 1.1 + night * 0.075;
    u.uGrain.value = (0.85 + night * 0.35) * options.grain;
    u.uCA.value = 0.55 * options.ca;

    // Bloom is inverted against daylight: at night a few small emissive
    // bodies can afford to bleed, at noon the whole sky is a light source
    // and any strength at all turns the frame to milk.
    bloom.strength = 0.14 + night * 0.27;
    bloom.radius = 0.48 + night * 0.12;
    bloom.threshold = 1.0 + day * 0.08;
  }

  // Shafts are a low-sun effect: strong through the golden band, a subtle
  // silver under the moon, and off at midday where overhead light has no
  // direction to read. Off-screen lights fade out over a generous margin so
  // rays can still lean in from just beyond the frame edge.
  function updateShafts(atmosphere, reducedMotion) {
    if (!targetProfile.hdr || !atmosphere || !lightWorldSet || !options.shafts || reducedMotion) {
      shafts.pass.enabled = false;
      return;
    }

    lightView.copy(lightWorld).applyMatrix4(camera.matrixWorldInverse);
    if (lightView.z > -0.5) {
      // Behind the camera: projecting would mirror the position and drag
      // the frame toward a light that is not on screen.
      shafts.pass.enabled = false;
      return;
    }
    lightView.copy(lightWorld).project(camera);
    const sx = lightView.x * 0.5 + 0.5;
    const sy = lightView.y * 0.5 + 0.5;

    const ox = Math.max(0, -sx, sx - 1);
    const oy = Math.max(0, -sy, sy - 1);
    const offscreen = Math.hypot(ox, oy);
    const edgeFade = 1 - smoothstep(0.08, 0.55, offscreen);

    const elev = atmosphere.elevation;
    const day = atmosphere.daylight;
    const lowSun = 1 - smoothstep(8, 30, elev);
    const intensity = (day * lowSun * 0.7 + (1 - day) * 0.12) * edgeFade;

    if (intensity < 0.004) {
      shafts.pass.enabled = false;
      return;
    }
    shafts.pass.enabled = true;
    shafts.setLight(sx, sy, intensity, atmosphere.current.key);
  }

  function render(delta, elapsed, atmosphere) {
    const reducedMotion = prefersReducedMotion();
    applyGrade(atmosphere);
    updateShafts(atmosphere, reducedMotion);
    // Frozen grain under reduced motion: same texture, no shimmer.
    grade.uniforms.uTime.value = reducedMotion ? 0 : elapsed;
    composer.render(delta);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const pass of [renderPass, bloom, shafts.pass, grade, output]) pass.dispose();
    composer.passes.length = 0;
    composer.dispose();
  }

  return {
    composer,
    capabilities: Object.freeze({ hdr: targetProfile.hdr, textureType: targetProfile.textureType }),
    setSize,
    setOptions,
    setLightWorldPosition,
    render,
    dispose,
  };
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
