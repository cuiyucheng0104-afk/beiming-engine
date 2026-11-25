// light.emit-pool（source:three 落点）：单盏动态合成 PointLight 构建器与帧同步。

import { evaluate as evaluateEmitPool, parseColorRgb } from './index.mjs';

function bad(message) {
  return Object.assign(new TypeError(message), { code: 'usage.bad-argument' });
}

function assertNum(x, name, min = -Infinity, max = Infinity) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) {
    throw bad(`Invalid ${name}`);
  }
  return x;
}

/** 将 poolEmitters 的结果写进 Three.js PointLight 实例 */
export function applyPooledLight(pointLight, pooled, THREE) {
  if (!pointLight || !pooled) throw bad('Invalid pointLight or pooled state');
  if (pooled.intensity > 0) {
    pointLight.position.set(pooled.position[0], pooled.position[1], pooled.position[2]);
    if (typeof pointLight.color?.setRGB === 'function') {
      pointLight.color.setRGB(pooled.color[0], pooled.color[1], pooled.color[2]);
    } else if (THREE?.Color) {
      pointLight.color = new THREE.Color(pooled.color[0], pooled.color[1], pooled.color[2]);
    }
    pointLight.distance = pooled.distance;
    pointLight.intensity = pooled.intensity;
  } else {
    pointLight.intensity = 0;
  }
  return pointLight;
}

export function create(ctx, params = {}) {
  const THREE = ctx?.THREE;
  if (!THREE || typeof THREE.PointLight !== 'function') throw bad('Missing THREE in ctx');
  const defaultRangeM = assertNum(params.defaultRangeM ?? 150, 'defaultRangeM', 1, 5000);
  const decay = assertNum(params.decay ?? 1.7, 'decay', 0, 4);
  const minIntensity = assertNum(params.minIntensity ?? 1e-4, 'minIntensity', 0, 10);
  const intensityScale = assertNum(params.intensityScale ?? 1.0, 'intensityScale', 0, 100);
  const baseRgb = parseColorRgb(params.baseColor ?? '#ff611a', 'baseColor');

  const light = new THREE.PointLight(
    new THREE.Color(baseRgb[0], baseRgb[1], baseRgb[2]),
    0,
    defaultRangeM,
    decay,
  );
  light.name = 'light.emit-pool';

  const normalizedParams = {
    defaultRangeM,
    decay,
    minIntensity,
    intensityScale,
    baseColor: params.baseColor ?? '#ff611a',
  };

  function sync(f, sub = 0) {
    const out = evaluateEmitPool(ctx, normalizedParams, f, sub);
    applyPooledLight(light, out.light, THREE);
    light.decay = decay;
    return out;
  }

  sync(0, 0);

  return {
    object: light,
    entities: { pool: { object: light, root: true } },
    apply(f, sub = 0) {
      sync(f, sub);
    },
    meta(f) {
      const out = evaluateEmitPool(ctx, normalizedParams, f, 0);
      return {
        readings: out.readings,
      };
    },
    dispose() {},
  };
}
