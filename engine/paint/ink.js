// 北冥引擎 · 手绘墨线：折线 → 有粗细起伏、按拍换形抖动的墨线，填到 Canvas 2D 上（轮廓由 engine/core/stroke.js 生成）。
// const brush = createInk(noise)    noise 是 createNoise2D(...)：决定抖动和笔压起伏，同一个种子每次重渲都一样
//   brush.line(g, poly, o)          画一条折线（画面像素坐标，少于 3 个点不画）
//   brush.path(g, cmds, o)          路径命令数组（engine/paint/path.js）先每 o.sample 像素（默认 2.5）采样，再逐条 line
// o：
//   px(v)     设计尺寸 → 画面像素（例如 v => v * h / 1040 * zoom），size 与 jit 都按它换算
//   step      抖动换形的拍号（整数；同一拍里形状不变，例如一拍二就是 floor(t * 12)）
//   seed      每条线自己的噪声偏移；color、alpha
//   size 笔宽（2.6）  jit 抖动幅度（0.7）  thin 笔压对粗细的影响（0.62）  t0 / t1 起笔、收笔出锋长度，单位笔宽（7）

import { inkStroke } from '../core/stroke.js';
import { clamp } from '../core/math.js';
import { samplePath, smoothClosed } from './path.js';

const SPACING = 3;   // 等距重采样的点距（像素）

export function createInk(noise) {
  function line(g, poly, o) {
    if (!poly || poly.length < 3) return;
    const pts = [poly[0]]; let acc = 0;
    for (let i = 1; i < poly.length; i++) {
      const a = poly[i - 1], b = poly[i]; acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (acc >= SPACING || i === poly.length - 1) { pts.push(b); acc = 0; }
    }
    const n = pts.length; if (n < 3) return;
    const st = o.step || 0, sd = o.seed || 0, jit = o.px(o.jit ?? 0.7);
    const pp = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      const j = jit * noise(i * 0.05 + sd * 3.7, st * 1.37 + sd);
      const pr = clamp(0.52 + 0.36 * noise(i * 0.022 + sd * 5.1, 9.3 + sd) + 0.1 * noise(i * 0.09, st * 0.71 + sd * 2), 0.06, 1);
      pp.push([pts[i][0] - ty * j, pts[i][1] + tx * j, pr]);
    }
    const size = o.px(o.size || 2.6);
    const ol = inkStroke(pp, {
      size, thinning: o.thin ?? 0.62, streamline: 0.16,
      start: { taper: (o.t0 ?? 7) * size }, end: { taper: (o.t1 ?? 7) * size },
    });
    g.globalAlpha = o.alpha ?? 1; g.fillStyle = o.color || '#000'; g.fill(smoothClosed(ol)); g.globalAlpha = 1;
  }
  const path = (g, cmds, o) => { for (const pl of samplePath(cmds, o.sample ?? 2.5)) line(g, pl, o); };
  return { line, path };
}
