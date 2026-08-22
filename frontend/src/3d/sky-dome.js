import * as THREE from "three";

const SkyShader = {
  uniforms: {
    uTopColor: { value: new THREE.Color("#0a0a14") },
    uHorizonColor: { value: new THREE.Color("#1a0a2e") },
    uBottomColor: { value: new THREE.Color("#05050a") },
    uSunPosition: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color("#ffd080") },
    uSunIntensity: { value: 1.0 },
    uElevation: { value: 0.0 },
    uTime: { value: 0.0 },
  },
  vertexShader: `
    varying vec3 vWorldPosition;
    varying vec3 vNormal;

    void main() {
      vNormal = normalize(normalMatrix * normal);
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPosition.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform vec3 uTopColor;
    uniform vec3 uHorizonColor;
    uniform vec3 uBottomColor;
    uniform vec3 uSunPosition;
    uniform vec3 uSunColor;
    uniform float uSunIntensity;
    uniform float uElevation;
    uniform float uTime;

    varying vec3 vWorldPosition;
    varying vec3 vNormal;

    void main() {
      vec3 dir = normalize(vWorldPosition);
      float h = dir.y; // -1 to 1

      // Atmospheric vertical gradient
      vec3 skyColor;
      if (h > 0.0) {
        float factor = pow(h, 0.45);
        skyColor = mix(uHorizonColor, uTopColor, factor);
      } else {
        float factor = pow(abs(h), 0.7);
        skyColor = mix(uHorizonColor, uBottomColor, factor);
      }

      // Sun halo / Mie scattering glow
      vec3 sunDir = normalize(uSunPosition);
      float sunCos = dot(dir, sunDir);
      if (sunCos > 0.0 && uSunIntensity > 0.01) {
        // Broad atmospheric glow
        float sunGlow = pow(max(0.0, sunCos), 8.0) * 0.45 * uSunIntensity;
        // Inner intense corona
        float sunCore = pow(max(0.0, sunCos), 64.0) * 0.8 * uSunIntensity;
        // Golden hour horizon flare
        float horizonFade = clamp(1.0 - abs(h) * 2.0, 0.0, 1.0);
        float goldenFlare = pow(max(0.0, sunCos), 4.0) * horizonFade * 0.35 * max(0.0, 1.0 - abs(uElevation) / 30.0);

        vec3 solarAddition = uSunColor * (sunGlow + sunCore) + vec3(1.0, 0.5, 0.2) * goldenFlare;
        skyColor += solarAddition;
      }

      // Subtle atmospheric dither to prevent 8-bit banding on dark gradients
      float dither = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * (1.0 / 255.0);
      skyColor += vec3(dither);

      gl_FragColor = vec4(skyColor, 1.0);
      #include <colorspace_fragment>
    }
  `,
};

export function createSkyDome(scene) {
  const geometry = new THREE.SphereGeometry(800, 32, 32);
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.clone(SkyShader.uniforms),
    vertexShader: SkyShader.vertexShader,
    fragmentShader: SkyShader.fragmentShader,
    side: THREE.BackSide,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  // ── Smooth celestial transitions ────────────────────────────────────
  // The backend recomputes celestial state on its tick cadence, which
  // would make the gradient jump between elevation bands. Targets hold
  // the latest state; update() eases the live uniforms toward them so
  // dawn/dusk read as a continuous fade.
  // The dome no longer grades itself: `atmosphere` owns the palette and the
  // easing, so sky, fog, lights and scenes can never drift apart.
  function setSunPosition(pos) {
    material.uniforms.uSunPosition.value.copy(pos);
  }

  function update(delta, elapsed, atmosphere) {
    material.uniforms.uTime.value = elapsed;
    if (!atmosphere) return;
    const g = atmosphere.current;
    const u = material.uniforms;
    u.uTopColor.value.copy(g.skyTop);
    u.uBottomColor.value.copy(g.skyBottom);
    u.uHorizonColor.value.copy(g.skyHorizon);
    u.uSunColor.value.copy(g.sun);
    u.uSunIntensity.value = g.sunIntensity;
    u.uElevation.value = atmosphere.elevation;
  }

  return {
    mesh,
    material,
    setSunPosition,
    update,
  };
}