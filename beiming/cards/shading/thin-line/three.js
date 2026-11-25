// shade.thin-line：细线最小屏幕像素宽护栏与一维能量守恒覆盖率衰减（CPU 参考 + GLSL 片段 + Three.js 材质构造）。
// origPx = worldWidth / (depth * pxK)
// clampedPx = max(origPx, minPx)
// coverage = clamp(origPx / clampedPx, 0, 1)
// 1D 能量守恒：clampedPx * (baseAlpha * coverage) === origPx * baseAlpha

export const DEFAULT_THIN_LINE_PARAMS = Object.freeze({
  worldWidth: 0.03,
  minPx: 1.24,
  baseAlpha: 1.0,
  coveragePower: 1.0,
  color: '#F2E4CE',
  fovYDeg: 45,
  viewportHeight: 1080,
});

export const GLSL_THIN_LINE = /* glsl */`
#ifndef SHADE_THIN_LINE_GLSL
#define SHADE_THIN_LINE_GLSL
void shadeThinLineClamp(
  float worldWidth,
  float viewDepth,
  float pxK,
  float minPx,
  out float clampedWorldWidth,
  out float coverage
) {
  float minWorld = minPx * max(viewDepth, 1e-4) * pxK;
  clampedWorldWidth = max(worldWidth, minWorld);
  coverage = clamp(worldWidth / max(clampedWorldWidth, 1e-8), 0.0, 1.0);
}
#endif
`;

const THIN_LINE_VERTEX = /* glsl */`
attribute vec3 aTangent;
attribute float aSide;
uniform float uWorldWidth;
uniform float uMinPx;
uniform float uPxK;
varying float vCoverage;
varying float vSide;
${GLSL_THIN_LINE}

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec4 mvCenter = viewMatrix * wp;
  float depth = max(-mvCenter.z, 1e-4);

  float clampedWidth;
  float cov;
  shadeThinLineClamp(uWorldWidth, depth, uPxK, uMinPx, clampedWidth, cov);
  vCoverage = cov;
  vSide = aSide;

  vec3 worldTan = normalize(mat3(modelMatrix) * aTangent);
  vec3 viewDir = normalize(cameraPosition - wp.xyz);
  vec3 sideDir = cross(worldTan, viewDir);
  float sl = length(sideDir);
  sideDir = sl > 1e-4 ? sideDir / sl : vec3(1.0, 0.0, 0.0);

  vec3 finalWp = wp.xyz + sideDir * (aSide * clampedWidth * 0.5);
  gl_Position = projectionMatrix * viewMatrix * vec4(finalWp, 1.0);
}
`;

const THIN_LINE_FRAGMENT = /* glsl */`
uniform vec3 uColor;
uniform float uBaseAlpha;
uniform float uCoveragePower;
varying float vCoverage;
varying float vSide;

void main() {
  float edge = 1.0 - smoothstep(0.75, 1.0, abs(vSide));
  float alpha = uBaseAlpha * pow(vCoverage, uCoveragePower) * edge;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(uColor, alpha);
}
`;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function pxScale(fovYDeg, viewportHeight) {
  if (!Number.isFinite(fovYDeg) || fovYDeg <= 0 || fovYDeg >= 180) {
    throw Object.assign(new RangeError(`shade.thin-line 非法 fovYDeg: ${fovYDeg}`), { code: 'usage.bad-argument' });
  }
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    throw Object.assign(new RangeError(`shade.thin-line 非法 viewportHeight: ${viewportHeight}`), { code: 'usage.bad-argument' });
  }
  return (2 * Math.tan((fovYDeg * Math.PI) / 360)) / viewportHeight;
}

/** 纯 CPU 计算细线最小像素宽夹紧与一维覆盖率能量守恒指标 */
export function evaluateThinLine(worldWidth, depth, params = {}) {
  const p = { ...DEFAULT_THIN_LINE_PARAMS, ...params };
  if (!Number.isFinite(worldWidth) || worldWidth < 0 || !Number.isFinite(depth) || depth <= 0) {
    throw Object.assign(new RangeError(`shade.thin-line 非法输入: worldWidth=${worldWidth}, depth=${depth}`), { code: 'usage.bad-argument' });
  }
  const pxK = pxScale(p.fovYDeg, p.viewportHeight);
  const origPx = worldWidth / Math.max(depth * pxK, 1e-8);
  const clampedPx = Math.max(origPx, p.minPx);
  const clampedWorldWidth = Math.max(worldWidth, p.minPx * depth * pxK);
  const coverage = clampedPx > 0 ? clamp01(origPx / clampedPx) : 0;
  const effectiveAlpha = p.baseAlpha * Math.pow(coverage, p.coveragePower);
  return {
    origPx,
    clampedPx,
    clampedWorldWidth,
    coverage,
    effectiveAlpha,
    originalFlux: origPx * p.baseAlpha,
    integratedFlux: clampedPx * effectiveAlpha,
  };
}

/** 构造带最小屏幕像素宽与覆盖率衰减的 Three.js ShaderMaterial */
export function createThinLineMaterial(THREE, params = {}) {
  const p = { ...DEFAULT_THIN_LINE_PARAMS, ...params };
  const uniforms = {
    uWorldWidth: { value: p.worldWidth },
    uMinPx: { value: p.minPx },
    uPxK: { value: pxScale(p.fovYDeg, p.viewportHeight) },
    uColor: { value: new THREE.Color(p.color) },
    uBaseAlpha: { value: p.baseAlpha },
    uCoveragePower: { value: p.coveragePower },
  };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: THIN_LINE_VERTEX,
    fragmentShader: THIN_LINE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

export function create(ctx, params = {}) {
  const { THREE, size = [1920, 1080] } = ctx;
  if (!THREE) throw Object.assign(new TypeError('shade.thin-line 需要 ctx.THREE'), { code: 'usage.bad-argument' });
  const p = { ...DEFAULT_THIN_LINE_PARAMS, viewportHeight: size[1] ?? DEFAULT_THIN_LINE_PARAMS.viewportHeight, ...params };
  const material = createThinLineMaterial(THREE, p);

  function updateCamera(camera, viewportHeight = p.viewportHeight) {
    const fov = camera?.fov ?? p.fovYDeg;
    p.fovYDeg = fov;
    p.viewportHeight = viewportHeight;
    material.uniforms.uPxK.value = pxScale(fov, viewportHeight);
    return material.uniforms.uPxK.value;
  }

  return {
    object: material,
    uniforms: material.uniforms,
    glsl: GLSL_THIN_LINE,
    updateCamera,
    evaluate(worldWidth = p.worldWidth, depth = 10, overrides = {}) {
      return evaluateThinLine(worldWidth, depth, { ...p, ...overrides });
    },
    dispose() {
      material.dispose();
    },
  };
}
