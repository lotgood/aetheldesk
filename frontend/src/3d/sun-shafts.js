import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";

// ─── Sun shafts (screen-space crepuscular rays) ──────────────────────────
// Classic Mitchell/GPU Gems light scattering: march from each pixel toward
// the light's screen position and accumulate what we see, with illumination
// decaying along the march. Bright sky and the sun/moon disc scatter; dark
// silhouettes (towers, treelines) contribute nothing, which is what turns a
// plain glow into rays with direction.
//
// The scene at this point in the chain is linear HDR (tonemapping happens
// once, in OutputPass), so the luminance gate works on physical-ish values.
// The blur runs into a half-resolution target: shafts are low-frequency by
// nature, and the composite is a single texture read.

const BLUR_SAMPLES = 48;

const ShaftsBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    uLightPos: { value: new THREE.Vector2(0.5, 0.5) },
    uDensity: { value: 0.95 },
    uWeight: { value: 0.026 },
    uDecay: { value: 0.955 },
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
    uniform vec2 uLightPos;
    uniform float uDensity;
    uniform float uWeight;
    uniform float uDecay;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
      vec2 uv = vUv;
      vec2 stepUv = (uLightPos - vUv) * (uDensity / float(${BLUR_SAMPLES}));
      float illum = 1.0;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < ${BLUR_SAMPLES}; i++) {
        uv += stepUv;
        vec3 s = texture2D(tDiffuse, clamp(uv, 0.001, 0.999)).rgb;
        // Luminance gate: only genuinely bright sources scatter. Without it
        // the whole frame smears toward the light instead of forming rays.
        s *= smoothstep(0.28, 0.95, luma(s));
        acc += s * illum;
        illum *= uDecay;
      }
      gl_FragColor = vec4(acc * uWeight, 1.0);
    }
  `,
};

const ShaftsCompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tShafts: { value: null },
    uIntensity: { value: 0 },
    uTint: { value: new THREE.Color(1, 1, 1) },
  },
  vertexShader: ShaftsBlurShader.vertexShader,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tShafts;
    uniform float uIntensity;
    uniform vec3 uTint;
    varying vec2 vUv;

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 shafts = texture2D(tShafts, vUv).rgb * uTint;
      gl_FragColor = vec4(c.rgb + shafts * uIntensity, c.a);
    }
  `,
};

export function createSunShaftsPass(width, height) {
  const pass = new Pass();
  pass.needsSwap = true;

  const rt = new THREE.WebGLRenderTarget(Math.max(1, width >> 1), Math.max(1, height >> 1), {
    type: THREE.HalfFloatType,
    depthBuffer: false,
  });

  const blurMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(ShaftsBlurShader.uniforms),
    vertexShader: ShaftsBlurShader.vertexShader,
    fragmentShader: ShaftsBlurShader.fragmentShader,
    depthTest: false,
    depthWrite: false,
  });
  const compMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(ShaftsCompositeShader.uniforms),
    vertexShader: ShaftsCompositeShader.vertexShader,
    fragmentShader: ShaftsCompositeShader.fragmentShader,
    depthTest: false,
    depthWrite: false,
  });

  const fsQuad = new FullScreenQuad(blurMat);

  pass.render = function (renderer, writeBuffer, readBuffer) {
    blurMat.uniforms.tDiffuse.value = readBuffer.texture;
    fsQuad.material = blurMat;
    renderer.setRenderTarget(rt);
    fsQuad.render(renderer);

    compMat.uniforms.tDiffuse.value = readBuffer.texture;
    compMat.uniforms.tShafts.value = rt.texture;
    fsQuad.material = compMat;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    fsQuad.render(renderer);
  };

  pass.setSize = function (w, h) {
    rt.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
  };

  pass.dispose = function () {
    rt.dispose();
    blurMat.dispose();
    compMat.dispose();
    fsQuad.dispose();
  };

  return {
    pass,
    /** Screen-space light position in UV coords; intensity 0 disables cleanly. */
    setLight(uvX, uvY, intensity, tint) {
      blurMat.uniforms.uLightPos.value.set(uvX, uvY);
      compMat.uniforms.uIntensity.value = intensity;
      if (tint) compMat.uniforms.uTint.value.copy(tint);
    },
    get intensity() {
      return compMat.uniforms.uIntensity.value;
    },
  };
}
