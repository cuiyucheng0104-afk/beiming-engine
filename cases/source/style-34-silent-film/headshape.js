// 头部局部形状：按朝向在正面 / 侧面 / 背面点集之间混合（点数相同，头部单位）。
import { catmull } from './engine/ink.js';
const lerp = (a, b, t) => a + (b - a) * t;
const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function headShape(H, frontPts, profPts, backPts) {
  const w = ss(.35, .95, H.p);
  const base = H.front >= 0 ? frontPts : (backPts || frontPts);
  const fm = H.front >= 0 ? H.f : -H.f;
  return base.map((q, i) => { const r = profPts[i]; return [lerp(q[0] * fm, r[0] * H.f, w) * H.sc, lerp(q[1], r[1], w) * H.sc]; });
}
export { catmull };
