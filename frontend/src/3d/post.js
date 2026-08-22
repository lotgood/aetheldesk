import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { createSunShaftsPass } from "./sun-shafts.js";

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
        float k = uCA * 0.0026 * (0.25 + r2 * 3.0);
        c.r = texture2D(tDiffuse, vUv + ctr * k).r;
        c.g = texture2D(tDiffuse, vUv).g;
        c.b = texture2D(tDiffuse, vUv - ctr * k).b;
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

      // Saturation just past neutral.
      c = mix(vec3(luma(c)), c, uSaturation);

      // Vignette.
      c *= 1.0 - uVignette * smoothstep(0.18, 0.86, r2 * 1.35);

      // Grain: coarser and stronger at night, and pulled back in highlights
      // so daylight skies stay clean.
      float n = hash12(gl_FragCoord.xy + fract(uTime) * vec2(311.7, 127.1));
      float amt = uGrain * (0.008 + 0.018 * uNight) * (1.15 - luma(c) * 0.55);
      c += (n - 0.5) * amt;

      gl_FragColor = vec4(max(c, 0.0), 1.0);
    }
  `,
};

export function createPostFX({ renderer, scene, camera }) {
  const size = renderer.getSize(new THREE.Vector2());

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.setSize(size.x, size.y);

  composer.addPass(new RenderPass(scene, camera));

  // Bloom is atmosphere, not a glow filter: low strength, high threshold, so
  // only the sun, the moon and the fire actually bleed.
  // Threshold sits high on purpose: a daylight sky is already near 1.0, so a
  // low threshold makes the whole dome bloom into itself and the frame goes
  // white. Only emissive bodies and the fire should clear this bar.
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.22, 0.6, 1.05);
  composer.addPass(bloom);

  // Sun shafts sit after bloom so the disc/corona bleed feeds the rays, and
  // before the grade so the added light is split-toned and vignetted like
  // everything else.
  const shafts = createSunShaftsPass(size.x, size.y);
  composer.addPass(shafts.pass);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  // Applies the renderer's ACES tone mapping and sRGB conversion once, after
  // grading, instead of the render pass doing it before.
  composer.addPass(new OutputPass());

  const scratch = new THREE.Color();
  const lightWorld = new THREE.Vector3();
  const lightView = new THREE.Vector3();
  let lightWorldSet = false;

  // User/quality-tier overrides. Base values still come from the atmosphere
  // grade every frame; these multiply or gate them.
  const options = { bloom: true, grain: 1, shafts: true, ca: 1 };

  function setOptions(next) {
    if (!next) return;
    if (typeof next.bloom === "boolean") options.bloom = next.bloom;
    if (typeof next.shafts === "boolean") options.shafts = next.shafts;
    if (typeof next.grain === "number") options.grain = next.grain;
    if (typeof next.ca === "number") options.ca = next.ca;
    bloom.enabled = options.bloom;
  }

  /** scenes.js feeds the active celestial body (sun by day, moon at night). */
  function setLightWorldPosition(pos) {
    lightWorld.copy(pos);
    lightWorldSet = true;
  }

  function prefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  }

  function setSize(width, height) {
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(width, height);
    bloom.setSize(width, height);
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
    u.uBlack.value = 0.006 + day * 0.032;

    u.uVignette.value = 0.3 + night * 0.28;
    u.uSaturation.value = 1.1 + night * 0.1;
    u.uGrain.value = (0.85 + night * 0.35) * options.grain;
    u.uCA.value = 0.55 * options.ca;

    // Bloom is inverted against daylight: at night a few small emissive
    // bodies can afford to bleed, at noon the whole sky is a light source
    // and any strength at all turns the frame to milk.
    bloom.strength = 0.16 + night * 0.34;
  }

  // Shafts are a low-sun effect: strong through the golden band, a subtle
  // silver under the moon, and off at midday where overhead light has no
  // direction to read. Off-screen lights fade out over a generous margin so
  // rays can still lean in from just beyond the frame edge.
  function updateShafts(atmosphere, reducedMotion) {
    if (!atmosphere || !lightWorldSet || !options.shafts || reducedMotion) {
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
    const intensity = (day * lowSun * 0.95 + (1 - day) * 0.32) * edgeFade;

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
    composer.dispose();
    bloom.dispose();
    shafts.pass.dispose();
  }

  return { composer, setSize, setOptions, setLightWorldPosition, render, dispose };
}

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
