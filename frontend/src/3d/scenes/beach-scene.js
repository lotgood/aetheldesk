import * as THREE from "three";
import { prefersReducedMotion } from "../motion.js";
import {
  BREAKER_DISSIPATION,
  BREAKING_AMPLITUDE_RATIO,
  buildGerstnerShaderCalls,
  GEOMETRY_WAVE_AMPLITUDE,
  GEOMETRY_WAVES,
  MIN_WATER_DEPTH,
  PHASE_BLEND_BASE,
  PHASE_BLEND_LINEAR,
  PHASE_BLEND_QUADRATIC,
  SHORE_SLOPE,
} from "../ocean-wave-model.js";

// ─── Beach: a living shoreline ───────────────────────────────────────────
// Water is not "blue with a shine on it". What makes a sea read as a sea is
// a Fresnel blend: at grazing angles you see the sky reflected, straight
// down you see the water's own body colour. Detail normals and the specular
// lobe both have to fall off with distance or the far water crawls, and the
// foam has to die out at range or it turns into stripes.
//
// Sand takes the other half: a wet band along the waterline that darkens
// the albedo, and a sparse mica sparkle. Dry sand alone reads as cardboard.

const WATER_LEVEL = -8.0;
const SAND_LEVEL = -7.3;
// Slow enough to read as a tide rather than a wave: one full cycle per
// six minutes with a restrained vertical range.
const TIDE_PERIOD = 360;
const TIDE_AMPLITUDE = 0.08;

// A distant sailboat: white in the texture so the grade can haze it into
// the horizon. Hull, mast and two sails — a silhouette, nothing more.
function makeBoatTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(28, 46);
  ctx.lineTo(100, 46);
  ctx.lineTo(88, 56);
  ctx.lineTo(40, 56);
  ctx.closePath();
  ctx.fill();
  ctx.fillRect(60, 8, 3, 38);
  ctx.beginPath();
  ctx.moveTo(65, 10);
  ctx.lineTo(65, 44);
  ctx.lineTo(94, 44);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(57, 16);
  ctx.lineTo(57, 44);
  ctx.lineTo(36, 44);
  ctx.closePath();
  ctx.fill();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
// Sand is an overscanned plane spanning the complete camera yaw envelope.
// The previous circular fan could expose its radial edge under parallax,
// turning the shoreline into a stepped block or a large triangular wedge.
// Water, foam and the wet band still share one curved shader boundary.
const SAND_CENTER_Z = 700;
const SAND_SIZE = 2600;
const SHORE_Z = -28;
const SHORE_CURVE = 0.0024;
const GERSTNER_SHADER_CALLS = buildGerstnerShaderCalls();

const WaterShader = {
  vertexShader: `
    uniform float uTime;
    uniform float uShoreZ;
    varying vec3 vWorld;
    varying vec3 vWaveNormal;
    varying float vCompression;
    varying float vBreaker;
    varying float vSeaDistance;
    varying float vWaveHeight;

    const float PI = 3.14159265359;
    const float GRAVITY = 9.81;

    float phaseBlend(float crossFraction) {
      float obliqueness = 1.0 - clamp(abs(crossFraction), 0.0, 1.0);
      return ${PHASE_BLEND_BASE}
           + ${PHASE_BLEND_LINEAR} * obliqueness
           + ${PHASE_BLEND_QUADRATIC} * obliqueness * obliqueness;
    }

    // Snell-refraction model with a closed-form cross-shore phase integral.
    // Holding the offshore along-shore k constant while cross-shore k rises
    // toward the beach gives real crest compression without evaluating the
    // invalid local expression k(h) * x.
    float crossShoreWavenumber(float deepK, float crossFraction, float depth) {
      float offshoreCrossK = max(1.0e-6, deepK * abs(crossFraction));
      float shallowK = sqrt(deepK / max(depth, 1.0e-5));
      float blend = phaseBlend(crossFraction);
      return offshoreCrossK + shallowK
           - blend * offshoreCrossK * shallowK / (offshoreCrossK + shallowK);
    }

    float crossShoreWavenumberDepthDerivative(float deepK, float crossFraction, float depth) {
      float offshoreCrossK = max(1.0e-6, deepK * abs(crossFraction));
      float shallowK = sqrt(deepK / max(depth, 1.0e-5));
      float shallowDerivative = -0.5 * shallowK / max(depth, 1.0e-5);
      float denominator = offshoreCrossK + shallowK;
      float blend = phaseBlend(crossFraction);
      return shallowDerivative
           * (1.0 - blend * offshoreCrossK * offshoreCrossK / (denominator * denominator));
    }

    float crossShorePhasePrimitive(float deepK, float crossFraction, float depth) {
      float offshoreCrossK = max(1.0e-6, deepK * abs(crossFraction));
      float rootK = sqrt(deepK);
      float rootDepth = sqrt(max(depth, 1.0e-5));
      float blend = phaseBlend(crossFraction);
      return offshoreCrossK * depth
           + 2.0 * rootK * (1.0 - blend) * rootDepth
           + (2.0 * blend * deepK / offshoreCrossK)
           * log(offshoreCrossK * rootDepth + rootK);
    }

    float crossShorePhaseIntegral(float deepK, float crossFraction, float depth) {
      return (
        crossShorePhasePrimitive(deepK, crossFraction, depth)
        - crossShorePhasePrimitive(deepK, crossFraction, ${MIN_WATER_DEPTH})
      ) / ${SHORE_SLOPE};
    }

    // Finite-depth Gerstner component. omega² = g k tanh(k h) slows the
    // crest as it reaches shallow water. The horizontal orbit produces the
    // characteristic trochoidal sharp crest, and the two analytic tangents
    // yield a stable normal without finite differences or texture samples.
    void addWave(
      inout vec3 p,
      inout vec3 tangentX,
      inout vec3 tangentY,
      inout float compression,
      vec2 rest,
      vec2 direction,
      float baseAmplitude,
      float wavelength,
      float speedScale,
      float steepness,
      float phaseOffset,
      float detailFilter,
      float depth,
      float amplitudeScale,
      float amplitudeScaleDerivative,
      float shoreDerivative,
      float time
    ) {
      float deepK = 2.0 * PI / wavelength;
      float omega = sqrt(GRAVITY * deepK) * speedScale;
      float alongK = deepK * direction.x;
      float crossSign = direction.y < 0.0 ? -1.0 : 1.0;
      float crossFraction = abs(direction.y);
      float crossK = crossSign * crossShoreWavenumber(deepK, crossFraction, depth);
      float crossKDistanceDerivative = crossSign
        * crossShoreWavenumberDepthDerivative(deepK, crossFraction, depth)
        * ${SHORE_SLOPE};

      // The curved shoreline makes distance vary slightly along X. Chain that
      // derivative into the same phase vector instead of shading with a normal
      // from a different, locally constant wave.
      vec2 waveVector = vec2(alongK + crossK * shoreDerivative, crossK);
      float waveNumber = max(length(waveVector), 1.0e-5);
      vec2 waveDir = waveVector / waveNumber;
      float phase = alongK * rest.x
                  + crossSign * crossShorePhaseIntegral(deepK, crossFraction, depth)
                  - omega * time + phaseOffset;
      float sine = sin(phase);
      float cosine = cos(phase);
      float amplitude = baseAmplitude * amplitudeScale * detailFilter;
      float amplitudeDistanceDerivative = baseAmplitude * amplitudeScaleDerivative * detailFilter;

      // Dividing the steepness budget between components keeps the summed
      // horizontal Jacobian positive, so crests sharpen without folding.
      float amplitudeHorizontal = amplitude * 0.72;
      float steepnessHorizontal = steepness / (waveNumber * ${GEOMETRY_WAVES.length.toFixed(1)});
      bool amplitudeLimited = amplitudeHorizontal <= steepnessHorizontal;
      float horizontal = min(amplitudeHorizontal, steepnessHorizontal);

      float distanceDx = shoreDerivative;
      vec2 waveVectorDx = vec2(
        crossKDistanceDerivative * shoreDerivative * shoreDerivative + crossK * ${2 * SHORE_CURVE},
        crossKDistanceDerivative * shoreDerivative
      );
      vec2 waveVectorDy = vec2(
        crossKDistanceDerivative * shoreDerivative,
        crossKDistanceDerivative
      );
      float waveNumberDx = dot(waveDir, waveVectorDx);
      float waveNumberDy = dot(waveDir, waveVectorDy);
      vec2 waveDirDx = (waveVectorDx - waveDir * waveNumberDx) / waveNumber;
      vec2 waveDirDy = (waveVectorDy - waveDir * waveNumberDy) / waveNumber;
      float amplitudeDx = amplitudeDistanceDerivative * distanceDx;
      float amplitudeDy = amplitudeDistanceDerivative;
      float horizontalDx = amplitudeLimited
        ? amplitudeDx * 0.72
        : -horizontal * waveNumberDx / waveNumber;
      float horizontalDy = amplitudeLimited
        ? amplitudeDy * 0.72
        : -horizontal * waveNumberDy / waveNumber;

      p.xy += waveDir * horizontal * cosine;
      p.z += amplitude * sine;

      vec2 horizontalTangentX = waveDirDx * horizontal * cosine
        + waveDir * (horizontalDx * cosine - horizontal * sine * waveVector.x);
      vec2 horizontalTangentY = waveDirDy * horizontal * cosine
        + waveDir * (horizontalDy * cosine - horizontal * sine * waveVector.y);
      tangentX += vec3(
        horizontalTangentX,
        amplitudeDx * sine + amplitude * cosine * waveVector.x
      );
      tangentY += vec3(
        horizontalTangentY,
        amplitudeDy * sine + amplitude * cosine * waveVector.y
      );
      compression += max(0.0, horizontal * waveNumber * sine);
    }

    void main() {
      vec2 q = position.xy;
      vec3 p = vec3(q, 0.0);
      vec4 baseWorld = modelMatrix * vec4(p, 1.0);

      float shoreZ = uShoreZ + baseWorld.x * baseWorld.x * ${SHORE_CURVE};
      float seaDistance = max(shoreZ - baseWorld.z, 0.0);
      float depth = ${MIN_WATER_DEPTH} + seaDistance * ${SHORE_SLOPE};
      float shoreDerivative = 2.0 * baseWorld.x * ${SHORE_CURVE};

      // Green's-law-style shoaling raises the wave envelope before a smooth
      // breaker limiter dissipates it into the swash. It is a stable visual
      // approximation of near-shore energy conservation, not a CFD grid.
      float shoreFade = smoothstep(1.5, 18.0, seaDistance);
      float shoreFadeT = clamp((seaDistance - 1.5) / (18.0 - 1.5), 0.0, 1.0);
      float shoreFadeDerivative = (seaDistance > 1.5 && seaDistance < 18.0)
        ? 6.0 * shoreFadeT * (1.0 - shoreFadeT) / (18.0 - 1.5)
        : 0.0;
      float deepMix = smoothstep(45.0, 230.0, seaDistance);
      float deepMixT = clamp((seaDistance - 45.0) / (230.0 - 45.0), 0.0, 1.0);
      float deepMixDerivative = (seaDistance > 45.0 && seaDistance < 230.0)
        ? 6.0 * deepMixT * (1.0 - deepMixT) / (230.0 - 45.0)
        : 0.0;
      float shoaling = 1.0 + (1.0 - deepMix) * 0.52;
      float shoalingDerivative = -deepMixDerivative * 0.52;
      float breakerRise = smoothstep(12.0, 34.0, seaDistance);
      float breakerRiseT = clamp((seaDistance - 12.0) / (34.0 - 12.0), 0.0, 1.0);
      float breakerRiseDerivative = (seaDistance > 12.0 && seaDistance < 34.0)
        ? 6.0 * breakerRiseT * (1.0 - breakerRiseT) / (34.0 - 12.0)
        : 0.0;
      float breakerFall = smoothstep(68.0, 118.0, seaDistance);
      float breakerFallT = clamp((seaDistance - 68.0) / (118.0 - 68.0), 0.0, 1.0);
      float breakerFallDerivative = (seaDistance > 68.0 && seaDistance < 118.0)
        ? 6.0 * breakerFallT * (1.0 - breakerFallT) / (118.0 - 68.0)
        : 0.0;
      float breaker = breakerRise * (1.0 - breakerFall);
      float breakerDerivative = breakerRiseDerivative * (1.0 - breakerFall)
                              - breakerRise * breakerFallDerivative;
      float dissipation = 1.0 - breaker * ${BREAKER_DISSIPATION};
      float dissipationDerivative = -breakerDerivative * ${BREAKER_DISSIPATION};
      float unlimitedAmplitudeScale = shoreFade * shoaling * dissipation;
      float unlimitedAmplitudeScaleDerivative = shoreFadeDerivative * shoaling * dissipation
        + shoreFade * shoalingDerivative * dissipation
        + shoreFade * shoaling * dissipationDerivative;
      float breakingLimit = ${BREAKING_AMPLITUDE_RATIO} * depth / ${GEOMETRY_WAVE_AMPLITUDE};
      float breakingLimitDerivative = ${BREAKING_AMPLITUDE_RATIO * SHORE_SLOPE} / ${GEOMETRY_WAVE_AMPLITUDE};
      bool depthLimited = breakingLimit < unlimitedAmplitudeScale;
      float amplitudeScale = depthLimited ? breakingLimit : unlimitedAmplitudeScale;
      float amplitudeScaleDerivative = depthLimited
        ? breakingLimitDerivative
        : unlimitedAmplitudeScaleDerivative;

      float viewDistance = distance(cameraPosition, baseWorld.xyz);
      float midDetail = 1.0 - smoothstep(260.0, 820.0, viewDistance);
      vec3 tangentX = vec3(1.0, 0.0, 0.0);
      vec3 tangentY = vec3(0.0, 1.0, 0.0);
      float compression = 0.0;

      ${GERSTNER_SHADER_CALLS}

      vec4 world = modelMatrix * vec4(p, 1.0);
      vWorld = world.xyz;
      vWaveNormal = normalize(mat3(modelMatrix) * normalize(cross(tangentX, tangentY)));
      vCompression = compression;
      vBreaker = breaker;
      vSeaDistance = seaDistance;
      vWaveHeight = p.z;
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: `
    uniform float uTime;
    uniform vec3  uBodyNear;
    uniform vec3  uBodyDeep;
    uniform vec3  uSkyTop;
    uniform vec3  uSkyHorizon;
    uniform vec3  uSunColor;
    uniform vec3  uSunDir;
    uniform vec3  uShallowBed;
    uniform vec3  uAbsorption;
    uniform vec3  uFoamColor;
    uniform float uSunIntensity;
    uniform float uNight;
    uniform float uFoam;
    uniform float uShoreZ;
    varying vec3 vWorld;
    varying vec3 vWaveNormal;
    varying float vCompression;
    varying float vBreaker;
    varying float vSeaDistance;
    varying float vWaveHeight;

    float hash12(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
      float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }
    float fbm(vec2 p) {
      return vnoise(p) * 0.6 + vnoise(p * 2.3 + 5.0) * 0.4;
    }

    vec3 safeNormalize(vec3 value, vec3 fallback) {
      float lengthSquared = dot(value, value);
      return lengthSquared > 1.0e-8
        ? value * inversesqrt(lengthSquared)
        : fallback;
    }

    // The dome is primarily vertical, but a small sunward azimuth term stops
    // every equal-height facet reflecting the exact same full-width stripe.
    vec3 skySample(vec3 dir) {
      float h = clamp(dir.y, 0.0, 1.0);
      vec2 rayHorizontal = dir.xz / max(length(dir.xz), 0.001);
      vec2 sunHorizontal = uSunDir.xz / max(length(uSunDir.xz), 0.001);
      float sunward = pow(max(dot(rayHorizontal, sunHorizontal), 0.0), 6.0);
      float grazing = 1.0 - smoothstep(0.08, 0.62, h);
      vec3 horizon = mix(
        uSkyHorizon,
        uSunColor,
        sunward * grazing * (0.035 + 0.085 * clamp(uSunIntensity, 0.0, 1.0))
      );
      return mix(horizon, uSkyTop, pow(h, 0.52));
    }

    void main() {
      vec3 Vv = cameraPosition - vWorld;
      float dist = length(Vv);
      vec3 V = Vv / max(dist, 1e-4);

      // Everything high-frequency is driven to zero with distance and the
      // specular lobe is widened instead. Without this the horizon crawls.
      float far = smoothstep(120.0, 900.0, dist);
      float dfade = clamp(1.0 - dist / 420.0, 0.0, 1.0);

      // Sub-mesh wavelengths belong in the fragment normal, not geometry.
      // Crossed capillary components retain detail near the camera and fade
      // before their screen frequency can shimmer at the horizon.
      float focusCalm = mix(0.72, 1.0, smoothstep(55.0, 220.0, abs(vWorld.x)));
      float rp1 = dot(vWorld.xz, vec2(0.29, 0.18)) + uTime * 0.7;
      float rp2 = dot(vWorld.xz, vec2(-0.23, 0.27)) - uTime * 0.55 + 2.1;
      float rp3 = dot(vWorld.xz, vec2(0.13, -0.41)) + uTime * 0.81 + 4.2;
      float rp4 = dot(vWorld.xz, vec2(0.43, -0.08)) - uTime * 0.76 + 1.35;
      float rp5 = dot(vWorld.xz, vec2(-0.07, -0.54)) + uTime * 0.62 + 5.15;
      float dHdx = cos(rp1) * 0.29 * 0.042
                 + cos(rp2) * -0.23 * 0.033
                 + cos(rp3) * 0.13 * 0.019
                 + cos(rp4) * 0.43 * 0.011
                 + cos(rp5) * -0.07 * 0.006;
      float dHdz = cos(rp1) * 0.18 * 0.042
                 + cos(rp2) * 0.27 * 0.033
                 + cos(rp3) * -0.41 * 0.019
                 + cos(rp4) * -0.08 * 0.011
                 + cos(rp5) * -0.54 * 0.006;
      vec3 N = safeNormalize(vWaveNormal + vec3(-dHdx, 0.0, -dHdz) * dfade * focusCalm, vec3(0.0, 1.0, 0.0));
      N = safeNormalize(mix(vec3(0.0, 1.0, 0.0), N, focusCalm), vec3(0.0, 1.0, 0.0));
      N = safeNormalize(mix(N, vec3(0.0, 1.0, 0.0), far * 0.92), vec3(0.0, 1.0, 0.0));

      float NoV = clamp(dot(N, V), 1e-4, 1.0);

      // Beer-Lambert transmission is evaluated against a shallow sand tint.
      // Red light attenuates fastest, leaving the blue-green body colour as
      // the optical path grows. Far water converges on the deep palette.
      float t = pow(clamp(dist / 1500.0, 0.0, 1.0), 0.42);
      vec3 deepBody = mix(uBodyNear, uBodyDeep, t);
      float waterDepth = ${MIN_WATER_DEPTH} + vSeaDistance * ${SHORE_SLOPE};
      float opticalPath = min(42.0, waterDepth / max(NoV, 0.18));
      vec3 transmittance = exp(-uAbsorption * opticalPath);
      vec3 shallowBody = uShallowBed * transmittance + uBodyNear * (1.0 - transmittance);
      float shallow = 1.0 - smoothstep(38.0, 190.0, vSeaDistance);
      vec3 body = mix(deepBody, shallowBody, shallow);

      // Fresnel. This single term is what separates water from painted
      // plastic: grazing angles become sky, steep angles stay water.
      vec3 R = reflect(-V, N);
      R.y = abs(R.y) * 0.55 + R.y * 0.45;
      vec3 env = skySample(R);
      float F = 0.0204 + 0.9796 * pow(1.0 - NoV, 5.0);

      vec3 col = mix(body, env, clamp(F, 0.0, 1.0));

      // Bounded GGX sun/moon glitter. Roughness widens with distance to
      // absorb frequencies filtered out of the geometry and detail normal.
      vec3 L = safeNormalize(uSunDir, vec3(0.0, 1.0, 0.0));
      vec2 lightHorizontal = L.xz / max(length(L.xz), 0.001);
      float NoL = clamp(dot(N, L), 0.0, 1.0);
      vec2 microSlope = vec2(dHdx, dHdz);
      float slopeAlignment = abs(dot(
        microSlope / max(length(microSlope), 0.001),
        lightHorizontal
      ));
      float rough = 0.102 + far * 0.24
                  + (1.0 - slopeAlignment) * dfade * focusCalm * 0.022;
      // V and L can be exact opposites on a wide water plane. Normalizing that
      // zero half-vector is undefined and can inject NaNs into the HDR bloom
      // chain, where one bad texel contaminates the whole composited frame.
      vec3 H = safeNormalize(V + L, N);
      float NoH = clamp(dot(N, H), 0.0, 1.0);
      float VoH = clamp(dot(V, H), 0.0, 1.0);
      float alpha = rough * rough;
      float a2 = max(alpha * alpha, 5e-5);
      float rawD = a2 / (3.14159 * pow(NoH * NoH * (a2 - 1.0) + 1.0, 2.0));
      float kSmith = (rough + 1.0) * (rough + 1.0) * 0.125;
      float Gv = NoV / (NoV * (1.0 - kSmith) + kSmith);
      float Gl = NoL / (NoL * (1.0 - kSmith) + kSmith);
      float specF = 0.0204 + 0.9796 * pow(1.0 - VoH, 5.0);
      float specular = rawD * Gv * Gl * specF / max(4.0 * NoV * NoL, 1e-3);
      float glitter = 1.0 - exp(-specular * 0.16);
      float light = 0.07 + 0.29 * clamp(uSunIntensity, 0.0, 1.0);
      col += uSunColor * glitter * light * NoL * focusCalm;

      // A broad, low-energy moon path keeps night water dimensional without
      // turning every ripple into a blinking highlight. It uses the same
      // analytic normal as the geometry and therefore stays temporally smooth.
      float lunarWide = pow(NoH, 7.0 + far * 8.0)
                      * (0.2 + NoL * 0.8)
                      * (1.0 - far * 0.4)
                      * uNight;
      float lunarCore = pow(NoH, 28.0 + far * 18.0)
                      * (0.24 + NoL * 0.76)
                      * (1.0 - far * 0.58)
                      * uNight;
      float moonRipple = 0.82 + 0.18
        * (0.5 + 0.5 * sin(rp1 * 1.7 + cos(rp2 * 0.7)));
      col += uSunColor * (lunarWide * 0.036 + lunarCore * 0.085)
           * moonRipple * focusCalm;

      // Rough water stretches a directional source into a quiet ribbon along
      // its azimuth. This broad mask supplies the path the microfacet core
      // alone cannot resolve at the low pixel density of the distant plane.
      vec2 fromCamera = vWorld.xz - cameraPosition.xz;
      float pathDistance = dot(fromCamera, lightHorizontal);
      float pathLateral = abs(fromCamera.x * lightHorizontal.y - fromCamera.y * lightHorizontal.x);
      float pathWidth = 7.0 + max(pathDistance, 0.0) * 0.105;
      float moonRibbon = exp(-pow(pathLateral / pathWidth, 2.0))
                       * smoothstep(-8.0, 28.0, pathDistance)
                       * (0.48 + pow(NoH, 7.0) * 0.52)
                       * (1.0 - far * 0.45)
                       * uNight;
      col += uSunColor * moonRibbon * moonRipple * 0.09 * focusCalm;

      // A restrained projected caustic gives clear shallow water some depth.
      // It is limited to the transmitted, sunlit region so it cannot become a
      // glowing texture on deep water or at night.
      vec2 cp = vWorld.xz * 0.22;
      float caA = sin(cp.x + sin(cp.y * 0.83 + uTime * 0.72));
      float caB = sin(cp.y * 1.13 - sin(cp.x * 0.91 - uTime * 0.58));
      float caustic = pow(max(0.0, 1.0 - abs(caA - caB)), 5.0);
      col += uSunColor * caustic * shallow * NoL * (1.0 - F)
           * uSunIntensity * 0.035;

      // Foam: a lace band along the shared shoreline, plus a little on the
      // swell crests. Killed off at range so it never becomes stripes. The
      // edge breathes in and out on a slow travelling wave — the swash —
      // so the foam line is never the same twice.
      // A broad shore arc is locally almost straight in the camera frustum.
      // Keep a slight x-curve so it still feels organic, and let the tide move
      // this shared boundary instead of relying on depth fights between two
      // kilometre-wide planes.
      float shoreZ = uShoreZ + vWorld.x * vWorld.x * ${SHORE_CURVE};
      float shoreSigned = vWorld.z - shoreZ;
      if (shoreSigned > 12.0) discard;
      float shoreD = max(0.0, -shoreSigned);
      float breakup = fbm(vWorld.xz * 0.055 + vec2(uTime * 0.035, -uTime * 0.08));
      float swashAdvance = (sin(uTime * 0.58 + vWorld.x * 0.019 + breakup * 3.2) * 0.5 + 0.5) * 8.0;
      float edge = 1.0 - smoothstep(0.7, 3.2, abs(shoreSigned - swashAdvance));
      edge *= 0.18 + smoothstep(0.27, 0.82, breakup) * 0.82;
      // A narrow broken lace remains at the actual water boundary even when
      // the animated swash tongue is at full reach. This prevents a hard
      // water/sand seam without restoring the old blurred white stripe.
      float baseEdge = 1.0 - smoothstep(0.25, 2.35, abs(shoreSigned));
      baseEdge *= 0.28 + smoothstep(0.3, 0.76, breakup) * 0.72;
      edge = max(edge, baseEdge * 0.7);

      // Whitecaps are tied to Gerstner horizontal compression (a Jacobian
      // breaking cue) and the shoaling breaker zone, so foam is born on
      // directional crests instead of appearing as unrelated noise stripes.
      float crest = smoothstep(0.08, 0.3, vCompression);
      float crestBreakup = smoothstep(0.31, 0.8, fbm(vWorld.xz * 0.085 - vec2(uTime * 0.11, 0.0)));
      float breakingFoam = vBreaker * crest * (0.28 + crestBreakup * 0.72);
      float wash = (1.0 - smoothstep(2.5, 22.0, shoreD))
                 * smoothstep(0.46, 0.86, breakup + vWaveHeight * 0.09) * 0.24;
      float foam = clamp(edge + breakingFoam * 0.85 + wash, 0.0, 1.0)
                 * (1.0 - far * 0.97) * uFoam * focusCalm;
      col = mix(col, uFoamColor, foam * 0.78);

      // Keep the water contribution finite and within the intended HDR range
      // before post-processing. The sun sprite owns values above this ceiling.
      gl_FragColor = vec4(clamp(col, vec3(0.0), vec3(8.0)), 1.0);
      #include <colorspace_fragment>
    }
  `,
};

const ShoreFoamShader = {
  vertexShader: `
    varying vec2 vUvFoam;
    varying vec3 vWorldFoam;

    void main() {
      vUvFoam = uv;
      vec4 world = modelMatrix * vec4(position, 1.0);
      vWorldFoam = world.xyz;
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: `
    uniform float uTime;
    uniform float uOpacity;
    uniform vec3 uColor;
    varying vec2 vUvFoam;
    varying vec3 vWorldFoam;

    float foamHash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float foamNoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      float a = foamHash(i), b = foamHash(i + vec2(1.0, 0.0));
      float c = foamHash(i + vec2(0.0, 1.0)), d = foamHash(i + vec2(1.0, 1.0));
      return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    void main() {
      float across = sin(clamp(vUvFoam.y, 0.0, 1.0) * 3.14159265);
      float travel = uTime * 0.045;
      float n1 = foamNoise(vec2(vUvFoam.x * 31.0 + travel, vUvFoam.y * 6.0 - travel));
      float n2 = foamNoise(vec2(vUvFoam.x * 67.0 - travel * 0.7, vUvFoam.y * 11.0 + 3.4));
      float filaments = smoothstep(0.38, 0.84, n1 * 0.68 + n2 * 0.42);
      float pulse = 0.72 + sin(uTime * 0.31 + vWorldFoam.x * 0.027 + n1 * 2.4) * 0.12;
      float alpha = pow(across, 1.45) * (0.16 + filaments * 0.84) * pulse * uOpacity;
      if (alpha < 0.012) discard;
      gl_FragColor = vec4(uColor, alpha);
      #include <colorspace_fragment>
    }
  `,
};

export function createBeachScene() {
  const group = new THREE.Group();
  group.name = "scene-beach";

  // ─── Water ────────────────────────────────────────────────────────────
  // The four geometric wave bands bottom out at a 27-unit wavelength. A
  // 168² grid keeps that foreground crest legible while the shorter two
  // spectrum bands stay in the fragment normal where they cannot alias.
  const waterGeo = new THREE.PlaneGeometry(2600, 2600, 168, 168);
  const waterMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uBodyNear: { value: new THREE.Color("#16202e") },
      uBodyDeep: { value: new THREE.Color("#2b3b4d") },
      uSkyTop: { value: new THREE.Color("#5d84b5") },
      uSkyHorizon: { value: new THREE.Color("#c9b39c") },
      uSunColor: { value: new THREE.Color("#ffdcae") },
      uSunDir: { value: new THREE.Vector3(0.3, 0.4, -0.86) },
      uShallowBed: { value: new THREE.Color("#8b998e") },
      // Approximate visible-light absorption coefficients, scaled to scene
      // units. Red attenuates fastest and blue slowest.
      uAbsorption: { value: new THREE.Vector3(0.082, 0.033, 0.017) },
      uFoamColor: { value: new THREE.Color("#f7f4ed") },
      uSunIntensity: { value: 0 },
      uNight: { value: 1 },
      uFoam: { value: 1 },
      uShoreZ: { value: SHORE_Z },
    },
    vertexShader: WaterShader.vertexShader,
    fragmentShader: WaterShader.fragmentShader,
  });
  const water = new THREE.Mesh(waterGeo, waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_LEVEL;
  group.add(water);

  // ─── Sailboat: one slow crossing of the horizon, day only ────────────
  const boatMat = new THREE.SpriteMaterial({
    map: makeBoatTexture(),
    transparent: true,
    depthWrite: false,
    opacity: 0,
    fog: false,
  });
  const boat = new THREE.Sprite(boatMat);
  boat.scale.set(16, 8, 1);
  boat.position.set(-650, WATER_LEVEL + 1.2, -540);
  group.add(boat);
  const BOAT_SPAN = 1300;

  // ─── Sand bank ────────────────────────────────────────────────────────
  const sandMat = new THREE.MeshStandardMaterial({
    color: 0x9c8f7d,
    emissive: 0x000000,
    roughness: 0.98,
    metalness: 0.0,
  });

  const sandGeo = new THREE.PlaneGeometry(SAND_SIZE, SAND_SIZE, 96, 96);
  {
    const pos = sandGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const worldZ = SAND_CENTER_Z - pos.getY(i);
      const landward = Math.max(0, worldZ - SHORE_Z);
      // A shallow rise gives the near beach volume without allowing geometry
      // to climb into the focal controls as the camera yaws.
      pos.setZ(i, Math.min(1.2, landward * 0.003));
    }
    sandGeo.computeVertexNormals();
  }

  // Wet band + mica. Dry uniform sand reads as cardboard; the two things
  // that fix it are a darker damp strip along the waterline and a sparse
  // sparkle, so they are injected into the standard material rather than
  // giving up its lighting for a bespoke shader.
  const sandUniforms = {
    uShoreZ: { value: SHORE_Z },
    uMica: { value: 1 },
    uWetDarken: { value: 0.52 },
    uSparkleDir: { value: new THREE.Vector3(0.3, 0.4, -0.86) },
    uSheenColor: { value: new THREE.Color("#c9b39c") },
    uSheen: { value: 0.2 },
  };
  // User toggle (display settings): 0 silences the sparkle entirely.
  let micaMaster = 1;
  sandMat.onBeforeCompile = (shader) => {
    shader.uniforms.uShoreZ = sandUniforms.uShoreZ;
    shader.uniforms.uMica = sandUniforms.uMica;
    shader.uniforms.uWetDarken = sandUniforms.uWetDarken;
    shader.uniforms.uSparkleDir = sandUniforms.uSparkleDir;
    shader.uniforms.uSheenColor = sandUniforms.uSheenColor;
    shader.uniforms.uSheen = sandUniforms.uSheen;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSandWorld;")
      .replace(
        "#include <worldpos_vertex>",
        "#include <worldpos_vertex>\nvSandWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;"
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vSandWorld;
        uniform float uShoreZ;
        uniform float uMica;
        uniform float uWetDarken;
        uniform vec3 uSparkleDir;
        uniform vec3 uSheenColor;
        uniform float uSheen;
        float sandHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }`
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          float grain = sandHash(floor(vSandWorld.xz * 1.7));
          float dune = sandHash(floor(vSandWorld.xz * 0.12) + 19.3);
          diffuseColor.rgb *= 0.92 + grain * 0.1 + (dune - 0.5) * 0.1;
          // Damp sand: a band inside the waterline, darkening and cooling
          // the albedo the way water bridging the grains actually does.
          float shoreZ = uShoreZ + vSandWorld.x * vSandWorld.x * ${SHORE_CURVE};
          // Begin the sand just landward of the shared edge. The previous
          // eight-unit seaward overlap sat above the water plane and hid the
          // brightest part of the foam ribbon.
          if (vSandWorld.z < shoreZ + 1.5) discard;
          float wet = 1.0 - smoothstep(shoreZ + 4.0, shoreZ + 58.0, vSandWorld.z);
          diffuseColor.rgb = mix(
            diffuseColor.rgb,
            diffuseColor.rgb * vec3(uWetDarken, uWetDarken * 0.98, uWetDarken),
            wet * 0.9
          );
        }`
      )
      .replace(
        "#include <dithering_fragment>",
        `#include <dithering_fragment>
        {
          // Mica: only a small fraction of grains catch the light, and that
          // sparseness is the whole effect — a dense sparkle reads as noise.
          vec2 cell = floor(vSandWorld.xz * 5.5);
          float pick = sandHash(cell);
          float facet = sandHash(cell + 3.7);
          float aim = pow(max(dot(normalize(uSparkleDir), normalize(vec3(facet - 0.5, 0.8, pick - 0.5))), 0.0), 42.0);
          float dfade = clamp(1.0 - length(vSandWorld - cameraPosition) / 160.0, 0.0, 1.0);
          gl_FragColor.rgb += vec3(1.0, 0.96, 0.9) * step(0.965, pick) * aim * uMica * dfade * 1.6;

          // Wet sheen: the damp band mirrors the sky at grazing angles,
          // which is what makes it read as wet rather than merely dark.
          float shoreZSheen = uShoreZ + vSandWorld.x * vSandWorld.x * ${SHORE_CURVE};
          float wetSheen = 1.0 - smoothstep(shoreZSheen + 4.0, shoreZSheen + 58.0, vSandWorld.z);
          vec3 viewDir = normalize(vViewPosition);
          float fres = pow(1.0 - max(dot(normal, viewDir), 0.0), 3.0);
          gl_FragColor.rgb += uSheenColor * wetSheen * fres * uSheen;
        }`
      );
  };

  const sand = new THREE.Mesh(sandGeo, sandMat);
  sand.rotation.x = -Math.PI / 2;
  sand.position.set(0, SAND_LEVEL, SAND_CENTER_Z);
  sand.receiveShadow = true;
  group.add(sand);

  // A separate translucent swash ribbon sits a few centimetres above the wet
  // sand. Keeping it out of the kilometre-wide water mesh avoids depth hiding
  // at the shoreline and lets the lace stay thin instead of becoming a broad
  // opaque stripe. Geometry follows the exact curved boundary used elsewhere.
  const shoreFoamGeo = new THREE.PlaneGeometry(700, 18, 140, 4);
  {
    const pos = shoreFoamGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const across = pos.getY(i);
      pos.setY(i, -(SHORE_Z + x * x * SHORE_CURVE + across));
    }
  }
  const shoreFoamMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOpacity: { value: 0.55 },
      uColor: { value: new THREE.Color("#f3f1eb") },
    },
    vertexShader: ShoreFoamShader.vertexShader,
    fragmentShader: ShoreFoamShader.fragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const shoreFoam = new THREE.Mesh(shoreFoamGeo, shoreFoamMat);
  shoreFoam.name = "shore-foam-lace";
  shoreFoam.rotation.x = -Math.PI / 2;
  shoreFoam.position.y = SAND_LEVEL + 0.055;
  shoreFoam.renderOrder = 4;
  group.add(shoreFoam);

  // Deliberately no rocks or driftwood: at this camera height any prop large
  // enough to read sits against open water with no visible ground contact,
  // so it looks like it is floating. The shoreline carries the frame.

  // ─── Grade plumbing ───────────────────────────────────────────────────
  const scratch = new THREE.Color();
  const dayNearWater = new THREE.Color("#2c4256");
  const nightNearWater = new THREE.Color("#2b3d5b");
  const dayShallowBed = new THREE.Color("#718982");
  const nightShallowBed = new THREE.Color("#52627a");
  const dayFoam = new THREE.Color("#fffaf1");
  const nightFoam = new THREE.Color("#7c8ba5");
  const daySand = new THREE.Color("#c2aa80");
  // Moonlit sand is deliberately a value step above the water body. The room
  // vignette and browser chrome already darken the lower third, so a physically
  // tiny bounce here made the entire foreground collapse into one black slab.
  const nightSand = new THREE.Color("#7d8798");
  let motionTime = 0;

  function applyGrade(atmosphere) {
    if (!atmosphere) return;
    const g = atmosphere.current;
    const day = atmosphere.daylight;
    const u = waterMat.uniforms;

    // Body colour stays clearly under the sky: the Fresnel term supplies the
    // sky, so the body must not also be the sky or the two cancel out.
    scratch.copy(nightNearWater).lerp(dayNearWater, day);
    u.uBodyNear.value.copy(scratch);
    scratch.copy(nightNearWater).lerp(dayNearWater, day).lerp(g.skyHorizon, 0.22).multiplyScalar(0.9);
    u.uBodyDeep.value.copy(scratch);

    u.uSkyTop.value.copy(g.skyTop);
    u.uSkyHorizon.value.copy(g.skyHorizon);
    u.uSunColor.value.copy(g.key);
    scratch.copy(nightShallowBed).lerp(dayShallowBed, day);
    scratch.lerp(g.skyHorizon, 0.12);
    u.uShallowBed.value.copy(scratch);
    // Glitter never fully dies: at night the moon still lays a restrained
    // silver path, while daylight can reach the bounded full-strength lobe.
    u.uSunIntensity.value = 0.2 + day * 0.8;
    u.uNight.value = 1 - day;
    // Foam catches far less light under the moon. Keeping the full daytime
    // value made the entire shoreline a flat white bar at midnight.
    u.uFoam.value = 0.18 + day * 0.82;
    scratch.copy(nightFoam).lerp(dayFoam, day).lerp(g.skyHorizon, 0.12);
    u.uFoamColor.value.copy(scratch);
    scratch.copy(g.skyHorizon).lerp(g.key, 0.28 + day * 0.22);
    shoreFoamMat.uniforms.uColor.value.copy(scratch);
    shoreFoamMat.uniforms.uOpacity.value = 0.22 + day * 0.34;

    scratch.copy(nightSand).lerp(daySand, day);
    scratch.lerp(g.ambientGround, 0.3);
    scratch.lerp(g.key, 0.16 * day);
    scratch.lerp(g.ambientSky, 0.22 * (1 - day));
    sandMat.color.copy(scratch);
    // Preserve the dune/grain separation after the room's lower vignette. This
    // is diffuse sky bounce, not a local lamp: every point receives the same
    // restrained cool lift and the wet band remains darker.
    sandMat.emissive
      .copy(nightSand)
      .lerp(g.ambientSky, 0.5)
      .multiplyScalar(0.42 - day * 0.36);
    sandUniforms.uMica.value = (0.5 + day * 0.7) * micaMaster;
    sandUniforms.uWetDarken.value = 0.78 - day * 0.26;
    // The wet band mirrors the horizon it sits beneath.
    sandUniforms.uSheenColor.value.copy(g.skyHorizon);
    sandUniforms.uSheen.value = 0.22 + day * 0.06;

    // The boat is a day craft, hazed into the horizon like everything far.
    scratch.copy(g.fog).multiplyScalar(0.5).lerp(g.skyHorizon, 0.3);
    boatMat.color.copy(scratch);
    boatMat.opacity = day * 0.8;
  }

  function updateCelestial(_c, atmosphere) {
    applyGrade(atmosphere);
  }

  function update(delta, elapsed, atmosphere) {
    applyGrade(atmosphere);
    const reducedMotion = prefersReducedMotion();
    if (!reducedMotion) motionTime += delta;
    waterMat.uniforms.uTime.value = motionTime;
    shoreFoamMat.uniforms.uTime.value = motionTime;

    // Tide: a six-minute breath. The waterline, foam lace and
    // wet band all shift together so the shore never disagrees with itself.
    const tide = Math.sin(motionTime * (Math.PI * 2 / TIDE_PERIOD)) * TIDE_AMPLITUDE;
    water.position.y = WATER_LEVEL + tide;
    // Move the same boundary used by water, foam and wet sand.
    const shorelineZ = SHORE_Z + tide * 35;
    waterMat.uniforms.uShoreZ.value = shorelineZ;
    sandUniforms.uShoreZ.value = shorelineZ;
    shoreFoam.position.z = shorelineZ - SHORE_Z;

    // The boat rides the same tide and swell it floats on. The phase offset
    // puts it in frame shortly after room load rather than a minute in.
    const bob = reducedMotion ? 0 : Math.sin(motionTime * 0.5) * 0.18;
    boat.position.x = -650 + ((motionTime * 2.2 + 350) % BOAT_SPAN);
    boat.position.y = WATER_LEVEL + tide + 1.2 + bob;
    boatMat.rotation = reducedMotion ? 0 : Math.sin(motionTime * 0.4) * 0.03;
  }

  return {
    group,
    updateCelestial,
    update,
    /** scenes.js feeds the live sun position so glitter and mica aim at it. */
    setLightDirection(dir) {
      waterMat.uniforms.uSunDir.value.copy(dir).normalize();
      sandUniforms.uSparkleDir.value.copy(waterMat.uniforms.uSunDir.value);
    },
    setMicaEnabled(enabled) {
      micaMaster = enabled ? 1 : 0;
    },
  };
}
