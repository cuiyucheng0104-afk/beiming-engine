// shade.px-lod：屏幕像素覆盖分级淡出（CPU 参考函数 + GLSL 片段 + Three.js 辅助）。
// px = worldSize * viewportHeight / (2 * depth * tan(fovY / 2)) = worldSize / (depth * pxK)
// weight = smoothstep(fadeStartPx, fadeEndPx, px)

export const DEFAULT_PX_LOD_PARAMS = Object.freeze({
  worldSize: 0.25,
  fadeStartPx: 1.2,
  fadeEndPx: 4.5,
  fovYDeg: 45,
  viewportHeight: 1080,
});

export const GLSL_PX_LOD = /* glsl */`
#ifndef SHADE_PX_LOD_GLSL
#define SHADE_PX_LOD_GLSL
uniform float uPxK;          // 2.0 * tan(fovY / 2.0) / viewportHeight
uniform vec3 uPxLodParams;   // x: worldSize, y: fadeStartPx, z: fadeEndPx

float shadeFeaturePx(float worldSize, float viewDepth, float pxK) {
  return worldSize / max(viewDepth * pxK, 1e-6);
}

float shadePxLod(float worldSize, float viewDepth, float pxK, float fadeStartPx, float fadeEndPx) {
  float px = shadeFeaturePx(worldSize, viewDepth, pxK);
  return smoothstep(fadeStartPx, fadeEndPx, px);
}
#endif
`;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (e0, e1, x) => {
  if (e1 <= e0) return x >= e1 ? 1 : 0;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** 单位深度处每像素对应的世界米数：pxK = 2 * tan(fovY / 2) / viewportHeight */
export function computePxK(fovYDeg, viewportHeight) {
  if (!Number.isFinite(fovYDeg) || fovYDeg <= 0 || fovYDeg >= 180) {
    throw Object.assign(new RangeError(`shade.px-lod 非法 fovYDeg: ${fovYDeg}`), { code: 'usage.bad-argument' });
  }
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    throw Object.assign(new RangeError(`shade.px-lod 非法 viewportHeight: ${viewportHeight}`), { code: 'usage.bad-argument' });
  }
  return (2 * Math.tan((fovYDeg * Math.PI) / 360)) / viewportHeight;
}

/** 给定世界特征尺度与视图深度，计算屏幕覆盖像素宽 */
export function screenFeaturePx(worldSize, depth, fovYDeg, viewportHeight) {
  const pxK = computePxK(fovYDeg, viewportHeight);
  return worldSize / Math.max(depth * pxK, 1e-6);
}

/** 纯 CPU 计算屏幕像素覆盖宽与分级淡出保留权重（近处 1.0，亚像素平滑归 0） */
export function evaluatePxLod(worldSize, depth, params = {}) {
  const p = { ...DEFAULT_PX_LOD_PARAMS, ...params };
  const px = screenFeaturePx(worldSize, depth, p.fovYDeg, p.viewportHeight);
  const weight = smoothstep(p.fadeStartPx, p.fadeEndPx, px);
  return {
    px,
    weight,
    bands: {
      base: weight,
      albedo: smoothstep(2.6, 6.5, px),
      specular: smoothstep(3.2, 7.5, px),
      fine: smoothstep(7.0, 24.0, px),
    },
  };
}

export function create(ctx, params = {}) {
  const { THREE, size = [1920, 1080] } = ctx;
  if (!THREE) throw Object.assign(new TypeError('shade.px-lod 需要 ctx.THREE'), { code: 'usage.bad-argument' });
  const p = { ...DEFAULT_PX_LOD_PARAMS, viewportHeight: size[1] ?? DEFAULT_PX_LOD_PARAMS.viewportHeight, ...params };

  const uniforms = {
    uPxK: { value: computePxK(p.fovYDeg, p.viewportHeight) },
    uPxLodParams: { value: new THREE.Vector3(p.worldSize, p.fadeStartPx, p.fadeEndPx) },
  };

  const anchor = new THREE.Group();
  anchor.name = 'shade.px-lod';

  function updateCamera(camera, viewportHeight = p.viewportHeight) {
    const fov = camera?.fov ?? p.fovYDeg;
    p.fovYDeg = fov;
    p.viewportHeight = viewportHeight;
    uniforms.uPxK.value = computePxK(fov, viewportHeight);
    return uniforms.uPxK.value;
  }

  function patchMaterial(material) {
    const prev = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      if (prev) prev(shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vPxLodDepth;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvPxLodDepth = max(-mvPosition.z, 1e-4);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying float vPxLodDepth;\n${GLSL_PX_LOD}`);
    };
    material.needsUpdate = true;
    return material;
  }

  return {
    object: anchor,
    uniforms,
    glsl: GLSL_PX_LOD,
    updateCamera,
    patchMaterial,
    evaluate(worldSize = p.worldSize, depth = 10, overrides = {}) {
      return evaluatePxLod(worldSize, depth, { ...p, ...overrides });
    },
    dispose() {},
  };
}
