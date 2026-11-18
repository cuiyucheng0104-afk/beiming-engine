// 北冥引擎 · 湿叠水彩晕散、毛细水渍暗边与矢量场山石皴擦（Canvas 2D 底板与国风山石机理层）。
// 算法思路参考 Tyler Hobbs 多边形递归湿边扩散、开源项目 acamposuribe/p5.brush 与定格水墨纹理中的披麻皴 / 斧劈皴流线场，
// 本模块全部基于 engine/core 确定性伪随机与单纯形噪声纯自研实现，同一种子跨机器与分段重渲完全一致。
//
//   deformPolygon(poly, opts)                 单层多边形递归法向湿边扩散（支持按边设渗水权重 weights）
//   wetPolygonLayers(poly, opts)              生成多层由浓到淡的湿叠水彩轮廓序列（纯数据，可在 Node 单测）
//   fillWatercolor(g, poly, opts)             在 2D 画布上叠画半透明湿水彩块，并附带颜料积聚的「水渍暗边」（edgeDarken）
//   ridgeField(opts)                          生成山石走向矢量场：(x, y) => [ux, uy]（支持 'pima' 披麻皴与 'fupi' 斧劈皴）
//   flowHatch(poly, field, opts)              在多边形内部按均匀间距追踪不重叠流线，输出带笔压折线 [[x, y, p], ...]
//   drawFlowHatch(g, poly, field, brush, o)   把矢量场皴擦流线直接交给 brushwork.js 的毛笔绘入画布
import { clamp, mulberry, TAU } from '../core/math.js';
import { createNoise2D } from '../core/noise.js';

// 射线法判断点 (x, y) 是否在闭合多边形 poly 内
export function pointInPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const hit = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

function polygonSignedArea(poly) {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s * 0.5;
}

/**
 * 单层湿边扩散：沿每条边递归取扰动中点并沿外法向推开，weights[i] 可单独控制第 i 条边是干笔硬边（0.1）还是湿笔洇开（1.2）。
 */
export function deformPolygon(poly, { depth = 4, bleed = 12, weights = null, seed = 1 } = {}) {
  if (!Array.isArray(poly) || poly.length < 3) return [];
  const rnd = mulberry(seed);
  const n2 = createNoise2D(mulberry((seed ^ 0x9e3779b9) | 0));
  const ccw = polygonSignedArea(poly) >= 0 ? 1 : -1;

  let pts = poly.map(([x, y]) => [x, y]);
  let edgeW = poly.map((_, i) => (weights && weights[i] !== undefined ? weights[i] : 1));

  for (let lv = 0; lv < depth; lv++) {
    const falloff = bleed * Math.pow(0.56, lv);
    const nextPts = [];
    const nextW = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], w = edgeW[i];
      const t = 0.38 + 0.24 * rnd();
      const mx = a[0] + (b[0] - a[0]) * t;
      const my = a[1] + (b[1] - a[1]) * t;
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const segLen = Math.hypot(dx, dy) || 1;
      // 朝向多边形外侧的单位法向（屏幕坐标系：顺时针面积为负，统一由 ccw 修正朝外）
      const nx = (dy / segLen) * ccw;
      const ny = (-dx / segLen) * ccw;
      const gauss = (rnd() + rnd() + rnd() - 1.5) * 0.9;
      const spatial = 0.65 + 0.55 * n2(mx * 0.015 + lv * 1.7, my * 0.015 - lv * 1.3);
      const amp = Math.min(segLen * 0.42, falloff) * w * spatial;
      const disp = gauss * amp + 0.18 * amp; // 微弱向外偏置，模拟水渍向外毛细扩散
      nextPts.push(a, [mx + nx * disp, my + ny * disp]);
      const jitterW = clamp(w * (0.85 + 0.3 * rnd()), 0.05, 2.2);
      nextW.push(jitterW, jitterW);
    }
    pts = nextPts;
    edgeW = nextW;
  }
  return pts;
}

/**
 * 生成多层湿叠水彩轮廓：内层紧实、外层洇散，供多层极低不透明度叠涂出自然水彩浓淡过渡。
 */
export function wetPolygonLayers(poly, { layers = 14, bleed = 14, depth = 4, weights = null, seed = 1 } = {}) {
  const count = Math.max(1, layers | 0);
  const out = [];
  const baseRnd = mulberry(seed);
  // 预先生成一组纸面干湿度方向权重，让多层水渍在相同湿区一起洇开，而不是各层杂乱抵消
  const sharedWeights = poly.map((_, i) => {
    const base = weights && weights[i] !== undefined ? weights[i] : 1;
    return base * (0.55 + 0.9 * baseRnd());
  });
  for (let i = 0; i < count; i++) {
    const u = count === 1 ? 0.5 : i / (count - 1);
    const layerBleed = bleed * (0.35 + 0.95 * u);
    out.push(deformPolygon(poly, {
      depth,
      bleed: layerBleed,
      weights: sharedWeights,
      seed: (seed * 131 + i * 977 + 17) | 0,
    }));
  }
  return out;
}

function tracePolyPath(g, pts) {
  if (!pts.length) return;
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
}

/**
 * 在 Canvas 2D 上绘制湿叠水彩块，并在外圈形成毛细颜料积聚的「水渍暗边」（edgeDarken > 0）。
 */
export function fillWatercolor(g, poly, {
  color = '#33485c',
  alpha = 0.42,
  layers = 16,
  bleed = 14,
  depth = 4,
  edgeDarken = 0.26,
  edgeWidth = 1.6,
  weights = null,
  seed = 1,
} = {}) {
  const stack = wetPolygonLayers(poly, { layers, bleed, depth, weights, seed });
  if (!stack.length) return stack;
  // 每层按互补透射率换算单层 alpha：1 - (1 - alpha)^(1 / layers)
  const perLayerAlpha = 1 - Math.pow(clamp(1 - alpha, 0.001, 1), 1 / stack.length);

  g.save();
  g.fillStyle = color;
  for (let i = 0; i < stack.length; i++) {
    const taper = 0.75 + 0.5 * (1 - i / Math.max(1, stack.length - 1));
    g.globalAlpha = clamp(perLayerAlpha * taper, 0.004, 1);
    tracePolyPath(g, stack[i]);
    g.fill();
  }
  // 毛细水渍暗边（Coffee-Ring Edge Darkening）：水彩干涸前颜料颗粒向湿区边缘聚集留下的细暗圈
  if (edgeDarken > 0) {
    const rim = stack[Math.floor(stack.length * 0.78)];
    g.strokeStyle = color;
    g.lineJoin = 'round';
    g.lineWidth = edgeWidth;
    g.globalAlpha = clamp(alpha * edgeDarken, 0, 0.65);
    tracePolyPath(g, rim);
    g.stroke();
  }
  g.restore();
  return stack;
}

/**
 * 构造山石皴法矢量场：(x, y) => [ux, uy]（单位切向量）。
 *   mode = 'pima'（披麻皴：连绵柔韧的纤维状山脉肌理）
 *   mode = 'fupi'（斧劈皴：硬朗折面、带岩层劈理角阶跃的刚劲刀斧肌理）
 */
export function ridgeField({
  angle = -Math.PI * 0.35,
  curl = 0.42,
  scale = 0.0075,
  mode = 'pima',
  facets = 7,
  seed = 1,
} = {}) {
  const n2 = createNoise2D(mulberry(seed));
  const nWarp = createNoise2D(mulberry((seed ^ 0x5bf03635) | 0));
  return (x, y) => {
    let a;
    if (mode === 'fupi') {
      const cell = nWarp(x * scale * 0.7, y * scale * 0.7);
      const q = Math.round(cell * facets) / Math.max(1, facets);
      a = angle + q * curl * 1.15 + n2(x * scale * 2.2, y * scale * 2.2) * 0.06;
    } else {
      const wx = x + nWarp(x * scale * 0.6, y * scale * 0.6) * 28;
      const wy = y + nWarp(x * scale * 0.6 + 19.3, y * scale * 0.6 - 11.7) * 28;
      a = angle + n2(wx * scale, wy * scale) * curl * (TAU * 0.25);
    }
    return [Math.cos(a), Math.sin(a)];
  };
}

/**
 * 在闭合多边形 poly 内沿矢量场 field 生成均匀间距、互不挤叠的皴擦流线。
 * 每条流线格式为 [[x, y, pressure], ...]，可直接喂给 engine/paint/brushwork.js 的 brush.stroke 或 engine/core/stroke.js。
 */
export function flowHatch(poly, field, {
  spacing = 9,
  stepLen = 3.5,
  maxSteps = 26,
  minSteps = 4,
  pressureTaper = true,
  seed = 1,
} = {}) {
  if (!Array.isArray(poly) || poly.length < 3) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (!(x1 > x0 && y1 > y0)) return [];

  const cell = Math.max(1.5, spacing * 0.75);
  const gw = Math.max(1, Math.ceil((x1 - x0) / cell) + 2);
  const gh = Math.max(1, Math.ceil((y1 - y0) / cell) + 2);
  const grid = [];
  for (let i = 0; i < gw * gh; i++) grid.push([]);
  const minDist2 = (spacing * 0.72) ** 2;

  const cellIndex = (x, y) => {
    const cx = clamp(Math.floor((x - x0) / cell), 0, gw - 1);
    const cy = clamp(Math.floor((y - y0) / cell), 0, gh - 1);
    return [cx, cy];
  };

  const tooClose = (x, y) => {
    const [cx, cy] = cellIndex(x, y);
    for (let dy = -1; dy <= 1; dy++) {
      const ny = cy + dy;
      if (ny < 0 || ny >= gh) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        if (nx < 0 || nx >= gw) continue;
        const bucket = grid[ny * gw + nx];
        for (let k = 0; k < bucket.length; k += 2) {
          if ((bucket[k] - x) ** 2 + (bucket[k + 1] - y) ** 2 < minDist2) return true;
        }
      }
    }
    return false;
  };

  const occupy = (x, y) => {
    const [cx, cy] = cellIndex(x, y);
    grid[cy * gw + cx].push(x, y);
  };

  const rnd = mulberry(seed);
  const candidates = [];
  for (let y = y0 + spacing * 0.5; y < y1; y += spacing) {
    for (let x = x0 + spacing * 0.5; x < x1; x += spacing) {
      const jx = x + (rnd() - 0.5) * spacing * 0.8;
      const jy = y + (rnd() - 0.5) * spacing * 0.8;
      if (pointInPolygon(poly, jx, jy)) candidates.push([jx, jy]);
    }
  }
  // Fisher–Yates 确定性打乱起笔顺序，避免网格扫描痕迹
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = candidates[i]; candidates[i] = candidates[j]; candidates[j] = tmp;
  }

  const stepDir = (sx, sy, sign, limit) => {
    const pts = [];
    let x = sx, y = sy;
    for (let s = 0; s < limit; s++) {
      const v = field(x, y);
      const m = Math.hypot(v[0], v[1]) || 1;
      const k1x = (v[0] / m) * sign, k1y = (v[1] / m) * sign;
      const mx = x + k1x * stepLen * 0.5, my = y + k1y * stepLen * 0.5;
      const v2 = field(mx, my);
      const m2 = Math.hypot(v2[0], v2[1]) || 1;
      const nx = x + (v2[0] / m2) * sign * stepLen;
      const ny = y + (v2[1] / m2) * sign * stepLen;
      if (!pointInPolygon(poly, nx, ny) || tooClose(nx, ny)) break;
      pts.push([nx, ny]);
      x = nx; y = ny;
    }
    return pts;
  };

  const strokes = [];
  const halfSteps = Math.max(2, Math.floor(maxSteps / 2));
  for (const [sx, sy] of candidates) {
    if (tooClose(sx, sy)) continue;
    const back = stepDir(sx, sy, -1, halfSteps).reverse();
    const fwd = stepDir(sx, sy, 1, maxSteps - back.length);
    const raw = [...back, [sx, sy], ...fwd];
    if (raw.length < minSteps) continue;
    const n = raw.length;
    const withPressure = raw.map(([x, y], i) => {
      occupy(x, y);
      const u = i / Math.max(1, n - 1);
      // 起笔顿入、行笔稳健、收笔轻提锋颖
      const p = pressureTaper ? clamp(Math.sin(Math.pow(u, 0.78) * Math.PI) * 1.05, 0.12, 1) : 1;
      return [x, y, +p.toFixed(4)];
    });
    strokes.push(withPressure);
  }
  return strokes;
}

/**
 * 在 Canvas 2D 上直接用 brushwork.js 的毛笔对象把矢量场皴擦流线画进多边形。
 */
export function drawFlowHatch(g, poly, field, brush, {
  strokeOpts = {},
  ...hatchOpts
} = {}) {
  const lines = flowHatch(poly, field, hatchOpts);
  for (let i = 0; i < lines.length; i++) {
    brush.stroke(g, lines[i], {
      seed: ((hatchOpts.seed ?? 1) * 73 + i * 37) | 0,
      ...strokeOpts,
    });
  }
  return lines;
}
