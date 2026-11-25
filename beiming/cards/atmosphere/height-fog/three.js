// atmo.height-fog：解析指数高度雾与太阳内散射着色（CPU 参考 + GLSL 片段 + Three.js 材质注入辅助）。
// 沿射线积分：\int_0^L rho0 * exp(-k * (y0 + t * dy)) dt = rho0 * L * exp(-k*y0) * (1 - exp(-delta)) / delta
// 其中 delta = k * (y1 - y0)，在 |delta| < 1e-3 时采用四阶泰勒展开避免 0/0 奇异与大数相消。

export const DEFAULT_FOG_PARAMS = Object.freeze({
  heightScale: 28.0,
  mistDensity: 0.0023,
  airDensity: 0.0006,
  floorY: -10.0,
  sunDir: [0.25, 0.35, -0.9027735],
  sunColor: [1.0, 0.66, 0.38],
  phaseMode: 'power',
  hgG: 0.65,
  sunLit: 1.0,
  dusk: 0.0,
  gloom: 0.0,
  flash: 0.0,
});

export const GLSL_HEIGHT_FOG = /* glsl */`
#ifndef ATMO_HEIGHT_FOG_GLSL
#define ATMO_HEIGHT_FOG_GLSL
uniform vec4 uFogParams;   // x: k=1/H, y: mistDensity, z: airDensity, w: floorY
uniform vec4 uFogEnv;      // x: sunLit, y: dusk, z: gloom, w: flash
uniform vec4 uFogSunDir;   // xyz: normalized sun direction, w: hgG
uniform vec4 uFogSunCol;   // rgb: sun tint, w: phaseMode (0=power, 1=hg)

float atmoExpAvg(float y0, float y1, float k) {
  float e0 = exp(-k * y0);
  float delta = k * (y1 - y0);
  if (abs(delta) < 1e-3) {
    float d2 = delta * delta;
    return e0 * (1.0 - 0.5 * delta + d2 * (1.0 / 6.0) - d2 * delta * (1.0 / 24.0));
  }
  return e0 * (1.0 - exp(-delta)) / delta;
}

float atmoHGPhase(float cosTheta, float g) {
  float g2 = g * g;
  float denom = max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4);
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(denom, 1.5));
}

vec2 atmoHeightFogOpticalDepth(vec3 cam, vec3 wp) {
  float d = length(wp - cam);
  float y0 = max(cam.y, uFogParams.w);
  float y1 = max(wp.y, uFogParams.w);
  float avg = atmoExpAvg(y0, y1, uFogParams.x);
  return vec2(uFogParams.y * d * avg, uFogParams.z * d);
}

vec3 atmoHeightFog(vec3 col, vec3 wp, vec3 cam) {
  vec3 v = wp - cam;
  float d = length(v);
  if (d <= 1e-5) return col;
  v /= d;

  vec2 tau = atmoHeightFogOpticalDepth(cam, wp);
  float tm = tau.x;
  float ta = tau.y;
  float total = tm + ta;

  float cosT = dot(v, normalize(uFogSunDir.xyz));
  float fw = max(cosT, 0.0);
  float phMist;
  float phAir;
  if (uFogSunCol.w > 0.5) {
    float hg = atmoHGPhase(cosT, uFogSunDir.w) * 4.0 * 3.14159265;
    phMist = 0.35 + 0.65 * hg;
    phAir = 0.15 + 0.55 * hg;
  } else {
    float f2 = fw * fw;
    float f6 = f2 * f2 * f2;
    float f14 = f6 * f6 * f2;
    phMist = 0.42 + 0.50 * f2 + 1.3 * f14;
    phAir = 0.10 + 0.55 * f2 + 1.2 * f14;
  }

  vec3 sky = mix(vec3(0.33, 0.38, 0.54), vec3(0.17, 0.22, 0.42), uFogEnv.y);
  sky = mix(sky, vec3(0.150, 0.180, 0.250), uFogEnv.z * 0.85);
  vec3 key = uFogSunCol.rgb;
  float lit = uFogEnv.x;
  float fl = uFogEnv.w;

  vec3 mist = sky * 0.92 + key * (lit * phMist * 0.86) + vec3(0.40, 0.50, 0.85) * fl;
  vec3 air = sky * mix(1.04, 0.90, smoothstep(40.0, 260.0, wp.y))
    + key * (lit * phAir)
    + vec3(0.26, 0.33, 0.55) * fl;
  vec3 fogCol = (mist * tm + air * ta) / max(total, 1e-6);
  float factor = 1.0 - exp(-total);
  return mix(col, fogCol, factor);
}
#endif
`;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;

/** Henyey-Greenstein 散射相位函数 */
export function henyeyGreenstein(cosTheta, g = 0.65) {
  const g2 = g * g;
  const denom = Math.max(1 + g2 - 2 * g * cosTheta, 1e-4);
  return (1 - g2) / (4 * Math.PI * Math.pow(denom, 1.5));
}

/** 沿射线解析光学厚度积分（|k*dy| -> 0 自动切入四阶泰勒展开） */
export function opticalDepth(cameraPos, worldPos, params = {}) {
  const p = { ...DEFAULT_FOG_PARAMS, ...params };
  const dx = worldPos[0] - cameraPos[0];
  const dyRaw = worldPos[1] - cameraPos[1];
  const dz = worldPos[2] - cameraPos[2];
  const dist = Math.hypot(dx, dyRaw, dz);
  if (dist <= 1e-12) {
    return { distance: 0, mist: 0, air: 0, total: 0, transmittance: 1, factor: 0 };
  }
  const k = 1.0 / Math.max(p.heightScale, 1e-4);
  const y0 = Math.max(cameraPos[1], p.floorY);
  const y1 = Math.max(worldPos[1], p.floorY);
  const e0 = Math.exp(-k * y0);
  const delta = k * (y1 - y0);
  let avg;
  if (Math.abs(delta) < 1e-3) {
    const d2 = delta * delta;
    avg = e0 * (1 - 0.5 * delta + d2 / 6 - (d2 * delta) / 24);
  } else {
    avg = (e0 * (1 - Math.exp(-delta))) / delta;
  }
  const mist = p.mistDensity * dist * avg;
  const air = p.airDensity * dist;
  const total = mist + air;
  const transmittance = Math.exp(-total);
  return { distance: dist, mist, air, total, transmittance, factor: 1 - transmittance };
}

/** 纯 CPU 解析指数高度雾求值（含太阳前向内散射与双介质混合） */
export function evaluateHeightFog(col, worldPos, cameraPos, params = {}) {
  const p = { ...DEFAULT_FOG_PARAMS, ...params };
  const tau = opticalDepth(cameraPos, worldPos, p);
  if (tau.distance <= 1e-6 || tau.total <= 0) {
    return { color: [col[0], col[1], col[2]], fogColor: [0, 0, 0], ...tau };
  }

  const vx = (worldPos[0] - cameraPos[0]) / tau.distance;
  const vy = (worldPos[1] - cameraPos[1]) / tau.distance;
  const vz = (worldPos[2] - cameraPos[2]) / tau.distance;
  const sLen = Math.hypot(p.sunDir[0], p.sunDir[1], p.sunDir[2]) || 1;
  const sx = p.sunDir[0] / sLen, sy = p.sunDir[1] / sLen, sz = p.sunDir[2] / sLen;
  const cosT = vx * sx + vy * sy + vz * sz;
  const fw = Math.max(cosT, 0);

  let phMist, phAir;
  if (p.phaseMode === 'hg') {
    const hg = henyeyGreenstein(cosT, p.hgG) * 4 * Math.PI;
    phMist = 0.35 + 0.65 * hg;
    phAir = 0.15 + 0.55 * hg;
  } else {
    const f2 = fw * fw;
    const f6 = f2 * f2 * f2;
    const f14 = f6 * f6 * f2;
    phMist = 0.42 + 0.50 * f2 + 1.3 * f14;
    phAir = 0.10 + 0.55 * f2 + 1.2 * f14;
  }

  const sky0 = [
    mix(0.33, 0.17, p.dusk),
    mix(0.38, 0.22, p.dusk),
    mix(0.54, 0.42, p.dusk),
  ];
  const sky = [
    mix(sky0[0], 0.150, p.gloom * 0.85),
    mix(sky0[1], 0.180, p.gloom * 0.85),
    mix(sky0[2], 0.250, p.gloom * 0.85),
  ];

  const airSkyK = mix(1.04, 0.90, smoothstep(40, 260, worldPos[1]));
  const flColMist = [0.40 * p.flash, 0.50 * p.flash, 0.85 * p.flash];
  const flColAir = [0.26 * p.flash, 0.33 * p.flash, 0.55 * p.flash];

  const denom = Math.max(tau.total, 1e-6);
  const fogColor = [0, 0, 0];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const mistC = sky[c] * 0.92 + p.sunColor[c] * (p.sunLit * phMist * 0.86) + flColMist[c];
    const airC = sky[c] * airSkyK + p.sunColor[c] * (p.sunLit * phAir) + flColAir[c];
    fogColor[c] = (mistC * tau.mist + airC * tau.air) / denom;
    out[c] = mix(col[c], fogColor[c], tau.factor);
  }
  return { color: out, fogColor, ...tau };
}

export function create(ctx, params = {}) {
  const { THREE } = ctx;
  if (!THREE) throw Object.assign(new TypeError('atmo.height-fog 需要 ctx.THREE'), { code: 'usage.bad-argument' });
  const p = { ...DEFAULT_FOG_PARAMS, ...params };

  const sVec = new THREE.Vector3(p.sunDir[0], p.sunDir[1], p.sunDir[2]).normalize();
  const uniforms = {
    uFogParams: { value: new THREE.Vector4(1 / Math.max(p.heightScale, 1e-4), p.mistDensity, p.airDensity, p.floorY) },
    uFogEnv: { value: new THREE.Vector4(p.sunLit, p.dusk, p.gloom, p.flash) },
    uFogSunDir: { value: new THREE.Vector4(sVec.x, sVec.y, sVec.z, p.hgG) },
    uFogSunCol: { value: new THREE.Vector4(p.sunColor[0], p.sunColor[1], p.sunColor[2], p.phaseMode === 'hg' ? 1 : 0) },
  };

  const anchor = new THREE.Group();
  anchor.name = 'atmo.height-fog';

  function setState(st = {}) {
    if (st.heightScale !== undefined) { p.heightScale = st.heightScale; uniforms.uFogParams.value.x = 1 / Math.max(st.heightScale, 1e-4); }
    if (st.mistDensity !== undefined) { p.mistDensity = st.mistDensity; uniforms.uFogParams.value.y = st.mistDensity; }
    if (st.airDensity !== undefined) { p.airDensity = st.airDensity; uniforms.uFogParams.value.z = st.airDensity; }
    if (st.floorY !== undefined) { p.floorY = st.floorY; uniforms.uFogParams.value.w = st.floorY; }
    if (st.sunLit !== undefined) { p.sunLit = st.sunLit; uniforms.uFogEnv.value.x = st.sunLit; }
    if (st.dusk !== undefined) { p.dusk = st.dusk; uniforms.uFogEnv.value.y = st.dusk; }
    if (st.gloom !== undefined) { p.gloom = st.gloom; uniforms.uFogEnv.value.z = st.gloom; }
    if (st.flash !== undefined) { p.flash = st.flash; uniforms.uFogEnv.value.w = st.flash; }
    if (st.hgG !== undefined) { p.hgG = st.hgG; uniforms.uFogSunDir.value.w = st.hgG; }
    if (st.phaseMode !== undefined) { p.phaseMode = st.phaseMode; uniforms.uFogSunCol.value.w = st.phaseMode === 'hg' ? 1 : 0; }
    if (Array.isArray(st.sunDir)) {
      p.sunDir = [...st.sunDir];
      sVec.set(st.sunDir[0], st.sunDir[1], st.sunDir[2]).normalize();
      uniforms.uFogSunDir.value.set(sVec.x, sVec.y, sVec.z, p.hgG);
    }
    if (Array.isArray(st.sunColor)) {
      p.sunColor = [...st.sunColor];
      uniforms.uFogSunCol.value.set(st.sunColor[0], st.sunColor[1], st.sunColor[2], p.phaseMode === 'hg' ? 1 : 0);
    }
  }

  function patchMaterial(material) {
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      if (prev) prev(shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vAtmoFogWorldPos;')
        .replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\nvec4 atmoWp = vec4(transformed, 1.0);\n#ifdef USE_INSTANCING\n  atmoWp = instanceMatrix * atmoWp;\n#endif\nvAtmoFogWorldPos = (modelMatrix * atmoWp).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vAtmoFogWorldPos;\n${GLSL_HEIGHT_FOG}`)
        .replace('#include <fog_fragment>', 'gl_FragColor.rgb = atmoHeightFog(gl_FragColor.rgb, vAtmoFogWorldPos, cameraPosition);');
    };
    material.needsUpdate = true;
    return material;
  }

  return {
    object: anchor,
    uniforms,
    glsl: GLSL_HEIGHT_FOG,
    setState,
    patchMaterial,
    evaluate(col, worldPos, cameraPos, overrides = {}) {
      return evaluateHeightFog(col, worldPos, cameraPos, { ...p, ...overrides });
    },
    apply(_f, _sub = 0, state = null) {
      if (state) setState(state);
    },
    dispose() {},
  };
}
