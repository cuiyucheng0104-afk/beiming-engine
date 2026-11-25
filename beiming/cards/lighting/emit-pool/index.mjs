// light.emit-pool（data 落点）：多发光体按辐射能量加权合成单盏点光池。

const HEX_RE = /^#([0-9a-f]{6})$/i;

function bad(message) {
  return Object.assign(new TypeError(message), { code: 'usage.bad-argument' });
}

function assertNum(x, name, min = -Infinity, max = Infinity) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < min || x > max) {
    throw bad(`Invalid ${name}`);
  }
  return x;
}

function assertVec3(v, name, min = -Infinity, max = Infinity) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max)) {
    throw bad(`Invalid ${name}`);
  }
  return v;
}

export function parseColorRgb(color, name = 'color') {
  if (Array.isArray(color)) {
    assertVec3(color, name, 0);
    return [...color];
  }
  if (typeof color === 'string') {
    const m = HEX_RE.exec(color.trim());
    if (!m) throw bad(`Invalid ${name}`);
    const n = Number.parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  throw bad(`Invalid ${name}`);
}

/**
 * 将一组发光体 [{ position: [x,y,z], color: [r,g,b] | '#rrggbb', intensity, distance? }]
 * 按强度加权归并为单盏点光状态 { position, color, intensity, distance, activeCount }。
 */
export function poolEmitters(emitters, options = {}) {
  if (!Array.isArray(emitters)) throw bad('emitters must be an array');
  const defaultRangeM = assertNum(options.defaultRangeM ?? 150, 'defaultRangeM', 1e-3, 100000);
  const minIntensity = assertNum(options.minIntensity ?? 1e-4, 'minIntensity', 0, 1e6);
  const intensityScale = assertNum(options.intensityScale ?? 1.0, 'intensityScale', 0, 1e6);
  const fallbackPosition = options.fallbackPosition ? [...assertVec3(options.fallbackPosition, 'fallbackPosition')] : [0, 0, 0];
  const fallbackColor = options.fallbackColor ? parseColorRgb(options.fallbackColor, 'fallbackColor') : [1.0, 0.38, 0.10];

  let lI = 0;
  let px = 0;
  let py = 0;
  let pz = 0;
  let lR = 0;
  let lG = 0;
  let lB = 0;
  let lD = 0;
  let activeCount = 0;

  for (let i = 0; i < emitters.length; i++) {
    const item = emitters[i];
    if (!item || typeof item !== 'object') throw bad(`Invalid emitter at index ${i}`);
    const pos = assertVec3(item.position, `emitters[${i}].position`);
    const col = parseColorRgb(item.color ?? fallbackColor, `emitters[${i}].color`);
    const rawI = assertNum(item.intensity, `emitters[${i}].intensity`, 0);
    const dist = assertNum(item.distance ?? defaultRangeM, `emitters[${i}].distance`, 1e-3);
    const weight = rawI * intensityScale;
    if (weight <= 0) continue;
    lI += weight;
    px += pos[0] * weight;
    py += pos[1] * weight;
    pz += pos[2] * weight;
    lR += col[0] * weight;
    lG += col[1] * weight;
    lB += col[2] * weight;
    lD += dist * weight;
    activeCount++;
  }

  if (lI > minIntensity) {
    const inv = 1 / lI;
    return {
      position: [px * inv, py * inv, pz * inv],
      color: [lR * inv, lG * inv, lB * inv],
      intensity: lI,
      distance: lD * inv,
      activeCount,
    };
  }

  return {
    position: fallbackPosition,
    color: fallbackColor,
    intensity: 0,
    distance: defaultRangeM,
    activeCount: 0,
  };
}

export function evaluate(ctx, params = {}, frame = ctx?.frame ?? 0, sub = ctx?.sub ?? 0) {
  if (!ctx || typeof ctx !== 'object') throw bad('Invalid ctx');
  assertNum(frame, 'frame');
  assertNum(sub, 'sub', 0, 1);
  const defaultRangeM = assertNum(params.defaultRangeM ?? 150, 'defaultRangeM', 1, 5000);
  const decay = assertNum(params.decay ?? 1.7, 'decay', 0, 4);
  const minIntensity = assertNum(params.minIntensity ?? 1e-4, 'minIntensity', 0, 10);
  const intensityScale = assertNum(params.intensityScale ?? 1.0, 'intensityScale', 0, 100);
  const fallbackColor = parseColorRgb(params.baseColor ?? '#ff611a', 'baseColor');

  const sourceList = typeof ctx.emittersAt === 'function'
    ? ctx.emittersAt(frame, sub)
    : (ctx.emitters ?? params.emitters ?? []);

  const pooled = poolEmitters(sourceList, {
    defaultRangeM,
    minIntensity,
    intensityScale,
    fallbackColor,
  });

  return {
    light: {
      ...pooled,
      decay,
    },
    readings: {
      activeCount: pooled.activeCount,
      intensity: pooled.intensity,
      distance: pooled.distance,
      posX: pooled.position[0],
      posY: pooled.position[1],
      posZ: pooled.position[2],
      colorR: pooled.color[0],
      colorG: pooled.color[1],
      colorB: pooled.color[2],
    },
  };
}
