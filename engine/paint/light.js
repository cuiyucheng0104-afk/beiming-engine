// 北冥引擎 · 2D 剪影的光：偏移法硬边轮廓光、内渗光、渐隐遮罩、光包裹、垫底辉光、玻璃表面反光。
// 形状都是 Path2D，坐标在 g 当前的变换里；方向 dir 是画面里光照来的方向（单位向量），d 是光带宽度（同一坐标系）。
//   rimPass(g, path, dir, d, color, o)    形状 − 朝光反方向平移后的形状 = 迎光一侧的一条硬边光带。o：
//       spread  再加左右各偏 spread 度、强度 0.75 的两道（面光源），凸起处的光带自然更宽
//       occ     遮挡物 Path2D：迎光一侧被它挡住的地方不出光
//       mask    a => void，在光带层上做一次 destination-in（例如 fadeAlong 的渐隐）
//       alpha   整体不透明度；blur 整体模糊（画布像素）
//   rimBleed(g, path, dir, d, color, o)   同上，但限制在形状内部：模糊后像逆光从边缘渗进来
//   fadeAlong(m, q0, q1)                  给 mask 用：m 坐标系里从 q0（全留）到 q1（全隐）的线性渐隐
//   lightWrap(g, layer, { amount, radius, stops, foot })
//       光包裹：用整层 layer 的 alpha 做遮罩，外沿 radius（画布像素）一圈渗进竖向渐变 stops = [[位置, 颜色], ...]；
//       foot > 0 时画面最下 foot 像素渐渐不做（被画框裁掉的边不该有包裹光）
//   glowBehind(g, src, passes)            把 src 模糊后垫到 g 已有内容的底下：passes = [[alpha, 模糊画布像素], ...]
//   glassSheen(g, glass, from, to, o)     玻璃表面：边缘菲涅尔提亮（描边后模糊）+ 沿 from→to 的几道条状高光。o：
//       edge 边缘不透明度，edgeColor，width 描边宽，blur 描边模糊（画布像素），
//       streak 高光不透明度，tint 高光 RGB，bands 高光的 [[位置, 不透明度], ...]

import { canvasFor, clearLayer } from './canvas.js';
import { apply } from './affine.js';

const D2R = Math.PI / 180;

export function rimPass(g, path, dir, d, color, o = {}) {
  const W = g.canvas.width, H = g.canvas.height, T = g.getTransform();
  const A = canvasFor('light.rimA', W, H), a = A.getContext('2d');
  const B = canvasFor('light.rimB', W, H), b = B.getContext('2d');
  clearLayer(a);
  const dirs = o.spread ? [[0, 1], [-o.spread, 0.75], [o.spread, 0.75]] : [[0, 1]];
  for (const [ang, f] of dirs) {
    const c = Math.cos(ang * D2R), s = Math.sin(ang * D2R);
    const dx = (dir[0] * c - dir[1] * s) * d * f, dy = (dir[0] * s + dir[1] * c) * d * f;
    clearLayer(b, T); b.fillStyle = color; b.fill(path);
    b.globalCompositeOperation = 'destination-out'; b.translate(-dx, -dy); b.fill(path); if (o.occ) b.fill(o.occ);
    a.setTransform(1, 0, 0, 1, 0, 0); a.drawImage(B, 0, 0);
  }
  if (o.mask) { a.setTransform(T); a.globalCompositeOperation = 'destination-in'; o.mask(a); a.globalCompositeOperation = 'source-over'; }
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = o.alpha ?? 1;
  if (o.blur > 0) g.filter = `blur(${o.blur}px)`;
  g.drawImage(A, 0, 0); g.restore();
}

export function rimBleed(g, path, dir, d, color, o) {
  g.save(); g.clip(path); rimPass(g, path, dir, d, color, o); g.restore();
}

export const fadeAlong = (m, q0, q1) => a => {
  const p0 = apply(m, q0), p1 = apply(m, q1);
  const gr = a.createLinearGradient(p0[0], p0[1], p1[0], p1[1]); gr.addColorStop(0, '#000'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  a.save(); a.setTransform(1, 0, 0, 1, 0, 0); a.fillStyle = gr; a.fillRect(0, 0, a.canvas.width, a.canvas.height); a.restore();
};

export function lightWrap(g, layer, { amount, radius, stops, foot = 0 }) {
  const W = layer.width, H = layer.height, Wc = canvasFor('light.wrap', W, H), q = Wc.getContext('2d');
  clearLayer(q); q.drawImage(layer, 0, 0);
  q.globalCompositeOperation = 'source-in';
  const gr = q.createLinearGradient(0, 0, 0, H);
  stops.forEach(([o, c]) => gr.addColorStop(o, c));
  q.fillStyle = gr; q.fillRect(0, 0, W, H);
  q.globalCompositeOperation = 'destination-out'; q.filter = `blur(${radius}px)`; q.drawImage(layer, 0, 0); q.filter = 'none';
  if (foot > 0) {
    const fb = q.createLinearGradient(0, H - foot, 0, H); fb.addColorStop(0, 'rgba(0,0,0,0)'); fb.addColorStop(0.6, '#000');
    q.fillStyle = fb; q.fillRect(0, 0, W, H);
  }
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-atop'; g.globalAlpha = amount; g.drawImage(Wc, 0, 0); g.restore();
}

export function glowBehind(g, src, passes) {
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'destination-over';
  for (const [alpha, blur] of passes) { g.globalAlpha = alpha; g.filter = `blur(${blur}px)`; g.drawImage(src, 0, 0); }
  g.restore();
}

const SHEEN_BANDS = [[0, 0], [0.3, 0], [0.38, 0.42], [0.47, 0.12], [0.53, 0.3], [0.6, 0], [1, 0]];
export function glassSheen(g, glass, from, to, { edge, edgeColor, width, blur, streak, tint, bands = SHEEN_BANDS }) {
  g.globalAlpha = edge; g.strokeStyle = edgeColor; g.lineWidth = width; g.filter = `blur(${blur}px)`; g.stroke(glass); g.filter = 'none';
  const hg = g.createLinearGradient(from[0], from[1], to[0], to[1]);
  for (const [o, a] of bands) hg.addColorStop(o, `rgba(${tint[0]},${tint[1]},${tint[2]},${a})`);
  g.globalAlpha = streak; g.fillStyle = hg; g.fill(glass);
}
