import * as THREE from "three";

// ─── Beach: a still shoreline ────────────────────────────────────────────
// Water is not "blue with a shine on it". What makes a sea read as a sea is
// a Fresnel blend: at grazing angles you see the sky reflected, straight
// down you see the water's own body colour. Detail normals and the specular
// lobe both have to fall off with distance or the far water crawls, and the
// foam has to die out at range or it turns into stripes.
//
// Sand takes the other half: a wet band along the waterline that darkens
// the albedo, and a sparse mica sparkle. Dry sand alone reads as cardboard.

const WATER_LEVEL = -8.0;
const SAND_LEVEL = -7.4;
// Slow enough to read as a tide rather than a wave: one full cycle per
// six minutes, which is also calm under reduced-motion preferences.
const TIDE_PERIOD = 360;
const TIDE_AMPLITUDE = 0.6;

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
// Sand is a large plate pushed behind the camera; only its far edge enters
// frame, as a shoreline. Both the foam band and the wet band are measured
// against this same circle so they always agree with the visible waterline.
const SAND_CENTER_Z = 250;
const SAND_RADIUS = 430;

const WaterShader = {
  vertexShader: `
    uniform float uTime;
    varying vec3 vWorld;
    varying vec2 vBase;

    // Two long crossed swells. Kept analytic so the normal below is exact
    // rather than sampled, which is what stops the far sea from faceting.
    float swellY(vec2 p, float t) {
      return sin(p.x * 0.010 + t * 0.35) * 0.9
           + sin(p.y * 0.014 - t * 0.22) * 0.6;
    }

    void main() {
      vec3 p = position;
      vBase = p.xy;
      p.z += swellY(p.xy, uTime);
      vec4 world = modelMatrix * vec4(p, 1.0);
      vWorld = world.xyz;
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
    uniform float uSunIntensity;
    uniform float uFoam;
    uniform float uShoreRadius;
    varying vec3 vWorld;
    varying vec2 vBase;

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

    // Cheap sky lookup: the dome is a vertical gradient, so a reflection
    // only needs the ray's height to pick its colour.
    vec3 skySample(vec3 dir) {
      float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
      return mix(uSkyHorizon, uSkyTop, pow(h, 0.6));
    }

    void main() {
      vec3 Vv = cameraPosition - vWorld;
      float dist = length(Vv);
      vec3 V = Vv / max(dist, 1e-4);

      // Everything high-frequency is driven to zero with distance and the
      // specular lobe is widened instead. Without this the horizon crawls.
      float far = smoothstep(120.0, 900.0, dist);
      float dfade = clamp(1.0 - dist / 420.0, 0.0, 1.0);

      // Analytic swell normal plus two octaves of ripple detail.
      float dx = cos(vBase.x * 0.010 + uTime * 0.35) * 0.010 * 0.9;
      float dz = cos(vBase.y * 0.014 - uTime * 0.22) * 0.014 * 0.6;
      float rx = cos(vBase.x * 0.21 + uTime * 0.9) * 0.21 * 0.06 * dfade;
      float rz = cos(vBase.y * 0.27 - uTime * 0.7) * 0.27 * 0.05 * dfade;
      vec3 N = normalize(vec3(-(dx + rx), 1.0, -(dz + rz)));
      N = normalize(mix(N, vec3(0.0, 1.0, 0.0), far * 0.92));

      float NoV = max(dot(N, V), 1e-4);

      // Body colour: near water keeps its own tint, far water deepens.
      float t = pow(clamp(dist / 1500.0, 0.0, 1.0), 0.42);
      vec3 body = mix(uBodyNear, uBodyDeep, t);

      // Fresnel. This single term is what separates water from painted
      // plastic: grazing angles become sky, steep angles stay water.
      vec3 R = reflect(-V, N);
      R.y = abs(R.y) * 0.55 + R.y * 0.45;
      vec3 env = skySample(R);
      float F = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);

      vec3 col = mix(body, env, clamp(F, 0.0, 1.0));

      // Sun/moon glitter, roughened with distance to absorb the detail the
      // normal fade just removed.
      float rough = 0.06 + far * 0.16;
      vec3 H = normalize(V + uSunDir);
      float NoH = max(dot(N, H), 0.0);
      float a2 = max(rough * rough, 5e-4);
      float d = a2 / (3.14159 * pow(NoH * NoH * (a2 - 1.0) + 1.0, 2.0));
      col += uSunColor * d * (0.25 + uSunIntensity) * 0.9;

      // Foam: a lace band along the shoreline circle, plus a little on the
      // swell crests. Killed off at range so it never becomes stripes. The
      // edge breathes in and out on a slow travelling wave — the swash —
      // so the foam line is never the same twice.
      float shoreD = abs(length(vBase - vec2(0.0, ${SAND_CENTER_Z}.0)) - uShoreRadius);
      float swash = sin(uTime * 0.45 - shoreD * 0.08 + fbm(vBase * 0.03) * 5.0) * 7.0;
      float lace = smoothstep(26.0, 0.0, shoreD + swash)
                 * smoothstep(0.45, 0.95, fbm(vBase * 0.09 + vec2(0.0, uTime * 0.35)));
      float crest = smoothstep(0.55, 1.0, fbm(vBase * 0.035 - vec2(uTime * 0.12, 0.0))) * 0.35;
      float foam = clamp(lace + crest * dfade, 0.0, 1.0) * (1.0 - far * 0.97) * uFoam;
      vec3 foamCol = mix(uSkyHorizon, vec3(1.0, 0.99, 0.97), 0.65);
      col = mix(col, foamCol, foam * 0.9);

      gl_FragColor = vec4(col, 1.0);
      #include <colorspace_fragment>
    }
  `,
};

export function createBeachScene() {
  const group = new THREE.Group();
  group.name = "scene-beach";

  // ─── Water ────────────────────────────────────────────────────────────
  const waterGeo = new THREE.PlaneGeometry(2600, 2600, 120, 120);
  const waterMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uBodyNear: { value: new THREE.Color("#16202e") },
      uBodyDeep: { value: new THREE.Color("#2b3b4d") },
      uSkyTop: { value: new THREE.Color("#5d84b5") },
      uSkyHorizon: { value: new THREE.Color("#c9b39c") },
      uSunColor: { value: new THREE.Color("#ffdcae") },
      uSunDir: { value: new THREE.Vector3(0.3, 0.4, -0.86) },
      uSunIntensity: { value: 0 },
      uFoam: { value: 1 },
      uShoreRadius: { value: SAND_RADIUS },
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
    roughness: 0.98,
    metalness: 0.0,
  });

  const sandGeo = new THREE.CircleGeometry(SAND_RADIUS, 96);
  {
    const pos = sandGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const r = Math.hypot(pos.getX(i), pos.getY(i)) / SAND_RADIUS;
      pos.setZ(i, -Math.pow(r, 2.6) * 5.0);
    }
    sandGeo.computeVertexNormals();
  }

  const sandFade = document.createElement("canvas");
  sandFade.width = 128;
  sandFade.height = 128;
  {
    const fctx = sandFade.getContext("2d");
    const fg = fctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    fg.addColorStop(0.0, "rgba(255,255,255,1)");
    fg.addColorStop(0.72, "rgba(255,255,255,1)");
    fg.addColorStop(0.92, "rgba(255,255,255,0.35)");
    fg.addColorStop(1.0, "rgba(255,255,255,0)");
    fctx.fillStyle = fg;
    fctx.fillRect(0, 0, 128, 128);
  }
  sandMat.alphaMap = new THREE.CanvasTexture(sandFade);
  sandMat.transparent = true;
  sandMat.depthWrite = false;

  // Wet band + mica. Dry uniform sand reads as cardboard; the two things
  // that fix it are a darker damp strip along the waterline and a sparse
  // sparkle, so they are injected into the standard material rather than
  // giving up its lighting for a bespoke shader.
  const sandUniforms = {
    uWetLine: { value: SAND_RADIUS },
    uMica: { value: 1 },
    uSparkleDir: { value: new THREE.Vector3(0.3, 0.4, -0.86) },
    uSheenColor: { value: new THREE.Color("#c9b39c") },
    uSheen: { value: 0.2 },
  };
  // User toggle (display settings): 0 silences the sparkle entirely.
  let micaMaster = 1;
  sandMat.onBeforeCompile = (shader) => {
    shader.uniforms.uWetLine = sandUniforms.uWetLine;
    shader.uniforms.uMica = sandUniforms.uMica;
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
        uniform float uWetLine;
        uniform float uMica;
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
          // Damp sand: a band inside the waterline, darkening and cooling
          // the albedo the way water bridging the grains actually does.
          float r = length(vSandWorld.xz - vec3(0.0, 0.0, ${SAND_CENTER_Z}.0).xz);
          float wet = smoothstep(uWetLine - 60.0, uWetLine - 4.0, r);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.52, 0.50, 0.50), wet * 0.9);
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
          float rSheen = length(vSandWorld.xz - vec3(0.0, 0.0, ${SAND_CENTER_Z}.0).xz);
          float wetSheen = smoothstep(uWetLine - 60.0, uWetLine - 4.0, rSheen);
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

  // Deliberately no rocks or driftwood: at this camera height any prop large
  // enough to read sits against open water with no visible ground contact,
  // so it looks like it is floating. The shoreline carries the frame.

  // ─── Grade plumbing ───────────────────────────────────────────────────
  const scratch = new THREE.Color();
  const dayNearWater = new THREE.Color("#2c4256");
  const nightNearWater = new THREE.Color("#0e1421");
  const daySand = new THREE.Color("#b3a68c");
  const nightSand = new THREE.Color("#39404f");

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
    // Glitter never fully dies: at night the moon still lays a silver path.
    u.uSunIntensity.value = 0.22 + g.sunIntensity * 0.85;

    scratch.copy(nightSand).lerp(daySand, day);
    scratch.lerp(g.ambientGround, 0.3);
    scratch.lerp(g.key, 0.16 * day);
    scratch.lerp(g.ambientSky, 0.22 * (1 - day));
    sandMat.color.copy(scratch);
    sandUniforms.uMica.value = (0.35 + day * 0.85) * micaMaster;
    // The wet band mirrors the horizon it sits beneath.
    sandUniforms.uSheenColor.value.copy(g.skyHorizon);
    sandUniforms.uSheen.value = 0.1 + day * 0.18;

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
    waterMat.uniforms.uTime.value = elapsed;

    // Tide: a six-minute breath, ±0.6 units. The waterline, foam lace and
    // wet band all shift together so the shore never disagrees with itself.
    const tide = Math.sin(elapsed * (Math.PI * 2 / TIDE_PERIOD)) * TIDE_AMPLITUDE;
    water.position.y = WATER_LEVEL + tide;
    const shoreShift = tide * 30;
    waterMat.uniforms.uShoreRadius.value = SAND_RADIUS - shoreShift;
    sandUniforms.uWetLine.value = SAND_RADIUS - shoreShift;

    // The boat rides the same tide and swell it floats on. The phase offset
    // puts it in frame shortly after room load rather than a minute in.
    const bob = prefersReducedMotion() ? 0 : Math.sin(elapsed * 0.5) * 0.18;
    boat.position.x = -650 + ((elapsed * 2.2 + 350) % BOAT_SPAN);
    boat.position.y = WATER_LEVEL + tide + 1.2 + bob;
    boatMat.rotation = prefersReducedMotion() ? 0 : Math.sin(elapsed * 0.4) * 0.03;
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
