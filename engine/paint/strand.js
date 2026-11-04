// 北冥引擎 · 一缕（发簇、发丝、草叶）：沿方向积分出一条随风摆动的中心线，再按根宽收尖成可填充的轮廓。
// 一缕的参数 s（坐标、长度用调用方自己的单位）：
//   r 根部 [x, y]   a 生长方向（度）   len 长   b 从根到梢的总弯曲（度）   fl 梢部回勾（度，可省）
//   amp 摆幅（度）  f 摆动频率   ph 相位   w 根宽   thin 细丝（不鼓、收得慢）
//   strandSpine(s, t, wind, noise, o) → [[x, y, 方向弧度], ...]  共 o.n + 1 个点。摆动波沿丝传播：
//       noise(ph·wave[0] + u·wave[1] − t·f·wave[2],  ph·drift[0] + (t·drift[1] + drift[2]))，u = 0..1 从根到梢；
//       摆幅 = amp × (o.sway + 0.6·wind) × u；风越大丝越长：len × (1 + o.stretch·wind)
//   strandOutline(spine, s, o) → 闭合多边形。o：bulge 中段鼓起（0.14）、taper [粗丝, 细丝] 收尖指数（[1.45, 0.75]）、
//       side [左, 右] 两侧宽度比（[1.08, 0.92]，略偏一侧更像手画）

import { ss, seg } from '../core/math.js';

const D2R = Math.PI / 180;

export function strandSpine(s, t, wind, noise, { n, stretch, wave, drift, sway }) {
  const segL = s.len * (1 + stretch * wind) / n, C = [];
  let x = s.r[0], y = s.r[1];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const wav = noise(s.ph * wave[0] + u * wave[1] - t * s.f * wave[2], s.ph * drift[0] + (t * drift[1] + drift[2]));
    const ang = (s.a + s.b * u + (s.fl || 0) * ss(seg(u, 0.55, 1)) + s.amp * (sway + 0.6 * wind) * u * wav) * D2R;
    C.push([x, y, ang]); x += Math.cos(ang) * segL; y += Math.sin(ang) * segL;
  }
  return C;
}

export function strandOutline(spine, s, { bulge = 0.14, taper = [1.45, 0.75], side = [1.08, 0.92] } = {}) {
  const N = spine.length - 1, Lp = [], Rp = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N, [px, py, a] = spine[i];
    const bl = s.thin ? 1 : 1 + bulge * Math.sin(Math.min(1, u * 1.8) * Math.PI);
    const wv = s.w * 0.5 * Math.pow(1 - u, s.thin ? taper[1] : taper[0]) * bl;
    const nx = -Math.sin(a), ny = Math.cos(a);
    Lp.push([px + nx * wv * side[0], py + ny * wv * side[0]]); Rp.push([px - nx * wv * side[1], py - ny * wv * side[1]]);
  }
  return Lp.concat(Rp.reverse());
}
