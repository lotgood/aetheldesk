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
    uRayleighStrength: { value: 1.0 },
    uMieStrength: { value: 0.36 },
    uMieG: { value: 0.78 },
    uTwilightStrength: { value: 0.0 },
    uNightStrength: { value: 1.0 },
  },
  vertexShader: `
    varying vec3 vWorldPosition;

    void main() {
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
    uniform float uRayleighStrength;
    uniform float uMieStrength;
    uniform float uMieG;
    uniform float uTwilightStrength;
    uniform float uNightStrength;

    varying vec3 vWorldPosition;

    const float PI = 3.141592653589793;
    const float THREE_OVER_SIXTEEN_PI = 0.05968310365946075;
    const float ONE_OVER_FOUR_PI = 0.07957747154594767;

    // Preetham-style clear-sky phase terms. The full model is deliberately
    // not evaluated here: this room also has a shared art grade, and these
    // normalized lobes provide the physical angular structure without LUTs
    // or extra texture bandwidth on mobile GPUs.
    float rayleighPhase(float mu) {
      return THREE_OVER_SIXTEEN_PI * (1.0 + mu * mu);
    }

    float henyeyGreenstein(float mu, float g) {
      float g2 = g * g;
      float denom = max(0.001, 1.0 + g2 - 2.0 * g * mu);
      return ONE_OVER_FOUR_PI * (1.0 - g2) / pow(denom, 1.5);
    }

    float gaussianBand(float x, float center, float width) {
      float d = (x - center) / max(width, 0.001);
      return exp(-d * d);
    }

    // Jimenez's interleaved-gradient sequence is deterministic in screen
    // space and moves quantization error out of the low frequencies where
    // dark gradients show banding. It also remains perfectly still when the
    // user requests reduced motion.
    float interleavedGradientNoise(vec2 pixel) {
      return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
    }

    void main() {
      // Both rays must share the camera as their origin. The camera sits at
      // (0, 6.2, 25), not at world zero; mixing origins offset the shader halo
      // from the actual sun disc by almost two degrees at noon.
      vec3 dir = normalize(vWorldPosition - cameraPosition);
      float h = dir.y; // -1 to 1

      // Art-directed vertical distribution. The phase functions below add
      // directional structure; the shared grade still owns the exact hue.
      vec3 skyColor;
      if (h > 0.0) {
        float factor = pow(h, 0.45);
        skyColor = mix(uHorizonColor, uTopColor, factor);
      } else {
        float factor = pow(abs(h), 0.7);
        skyColor = mix(uHorizonColor, uBottomColor, factor);
      }

      // Sun halo / Mie scattering glow
      vec3 sunDir = normalize(uSunPosition - cameraPosition);
      float sunCos = dot(dir, sunDir);

      // Kasten-Young optical air mass approximation, capped close to the
      // horizon. It produces the long, luminous dawn path without the
      // singularity of 1 / cos(theta).
      float upH = max(0.0, h);
      float zenithAngle = acos(clamp(upH, 0.0, 1.0));
      float zenithDegrees = zenithAngle * (180.0 / PI);
      float airMass = 1.0 / max(
        0.045,
        cos(zenithAngle) + 0.15 * pow(max(3.885, 93.885 - zenithDegrees), -1.253)
      );
      float opticalDepth = 1.0 - exp(-0.14 * airMass);
      float aboveHorizon = smoothstep(-0.025, 0.06, h);

      // Rayleigh is broad and nearly symmetric; aerosols use a forward HG
      // lobe. Their energy is restrained because the palette already carries
      // the sky's absolute luminance.
      float rayleigh = rayleighPhase(sunCos) * uRayleighStrength;
      float mie = min(1.35, henyeyGreenstein(sunCos, uMieG) * 0.32) * uMieStrength;
      float solarVisibility = smoothstep(-6.0, 8.0, uElevation);

      // Spectral extinction adapted from the official three.js Preetham sky.
      // We retain the grade's luminance but borrow the physically derived
      // chromaticity, which is what gives a clear zenith its deep blue and a
      // long aerosol path its warm, desaturated horizon.
      vec3 betaR = vec3(5.804543e-6, 1.356291e-5, 3.026590e-5) * (0.45 + uRayleighStrength * 1.25);
      vec3 betaM = vec3(2.0e-5) * (0.12 + uMieStrength * 0.7);
      vec3 extinction = exp(-(betaR * (8400.0 * airMass) + betaM * (1250.0 * airMass)));
      vec3 phaseSpectrum =
        ((betaR * rayleighPhase(sunCos) +
            betaM * min(0.45, henyeyGreenstein(sunCos, uMieG)) * 0.24) /
          max(betaR + betaM, vec3(1.0e-6))) *
        (1.0 - extinction);
      phaseSpectrum = pow(max(phaseSpectrum, vec3(1.0e-5)), vec3(0.68));
      float physicalLuma = dot(phaseSpectrum, vec3(0.2126, 0.7152, 0.0722));
      float artLuma = max(0.001, dot(skyColor, vec3(0.2126, 0.7152, 0.0722)));
      vec3 physicalMatched = phaseSpectrum * (artLuma / max(physicalLuma, 0.001));
      physicalMatched *= clamp(0.78 + physicalLuma * 0.62, 0.78, 1.17);
      skyColor = mix(skyColor, physicalMatched, aboveHorizon * solarVisibility * 0.3);

      vec3 rayleighTint = vec3(0.16, 0.38, 0.92);
      skyColor += rayleighTint * rayleigh * opticalDepth * aboveHorizon * solarVisibility * 0.09;
      skyColor += uSunColor * mie * opticalDepth * aboveHorizon * solarVisibility * 0.075;
      float clearSkySaturation = aboveHorizon * solarVisibility * uRayleighStrength * 0.16;
      skyColor = mix(skyColor, skyColor * vec3(0.86, 0.98, 1.12), clearSkySaturation);

      if (sunCos > 0.0 && uSunIntensity > 0.01) {
        // Broad atmospheric glow
        float sunGlow = pow(max(0.0, sunCos), 24.0) * 0.12 * uSunIntensity;
        // A narrow atmospheric core stops at approximately the photosphere's
        // edge. The previous 64-power lobe was three times wider than the
        // visible disc, leaving almost no edge contrast at midday.
        float sunCore = pow(max(0.0, sunCos), 512.0) * 0.30 * uSunIntensity;
        // Golden hour horizon flare
        float horizonFade = clamp(1.0 - abs(h) * 2.0, 0.0, 1.0);
        float goldenFlare = pow(max(0.0, sunCos), 4.0) * horizonFade * 0.35 * max(0.0, 1.0 - abs(uElevation) / 30.0);

        vec3 solarAddition = uSunColor * (sunGlow + sunCore) + vec3(1.0, 0.5, 0.2) * goldenFlare;
        skyColor += solarAddition;
      }

      // Civil twilight is not merely an orange horizon. A warm sunward band,
      // the pink anti-solar Belt of Venus, and the indigo Earth shadow form a
      // readable three-layer transition while sharing the same eased state.
      float horizonBand = exp(-abs(h) * 10.0);
      float sunward = pow(max(0.0, sunCos), 2.0);
      float antiSolar = pow(max(0.0, -sunCos), 2.0);
      float warmBand = horizonBand * (0.28 + 0.72 * sunward) * uTwilightStrength;
      skyColor += vec3(0.24, 0.065, 0.018) * warmBand * 0.44;

      float beltCenter = 0.11 + clamp(-uElevation, 0.0, 8.0) * 0.006;
      float venusBelt = gaussianBand(h, beltCenter, 0.105) * antiSolar * uTwilightStrength;
      skyColor += vec3(0.17, 0.045, 0.105) * venusBelt * 0.38;

      float earthShadow = gaussianBand(h, 0.015, 0.085) * antiSolar * uTwilightStrength;
      skyColor = mix(skyColor, skyColor * vec3(0.58, 0.68, 0.92), earthShadow * 0.34);

      // A fixed, extremely low-energy horizon airglow keeps moonless night
      // from ending as a black-to-indigo linear ramp. Celestial.js remains
      // the sole owner of stars, moon and Milky Way geometry.
      float airglow = exp(-abs(h) * 7.5) * (0.35 + 0.65 * antiSolar) * uNightStrength;
      skyColor += vec3(0.004, 0.011, 0.022) * airglow;

      // One display-code of stable, high-frequency dither at night; half a
      // code by day. Unlike a sine hash this has no broad diagonal bands.
      float ditherAmplitude = mix(0.5, 1.0, uNightStrength) * (1.0 / 255.0);
      float dither = (interleavedGradientNoise(gl_FragCoord.xy) - 0.5) * ditherAmplitude;
      skyColor += vec3(dither);
      skyColor = max(skyColor, vec3(0.0));

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

  function update(_delta, _elapsed, atmosphere) {
    if (!atmosphere) return;
    const g = atmosphere.current;
    const u = material.uniforms;
    u.uTopColor.value.copy(g.skyTop);
    u.uBottomColor.value.copy(g.skyBottom);
    u.uHorizonColor.value.copy(g.skyHorizon);
    u.uSunColor.value.copy(g.sun);
    u.uSunIntensity.value = g.sunIntensity;
    u.uElevation.value = atmosphere.elevation;
    u.uRayleighStrength.value = g.rayleighStrength;
    u.uMieStrength.value = g.mieStrength;
    u.uMieG.value = g.mieG;
    u.uTwilightStrength.value = g.twilightStrength;
    u.uNightStrength.value = g.nightStrength;
  }

  return {
    mesh,
    material,
    setSunPosition,
    update,
  };
}
