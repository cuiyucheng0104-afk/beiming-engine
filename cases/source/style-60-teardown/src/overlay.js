// 标注层：落在零件上的引线标签、画在零件上的尺寸线、缝内标签、"代码模型"注。所有锚点每帧从 3D 投影。
import * as THREE from 'three';
import { clamp, seg, ss, eo } from '/core/lib.js';
import * as TL from './timeline.js';
import { DIMS } from './pen.js';

const { T, LABELS } = TL;
const cv = document.getElementById('ov'), g = cv.getContext('2d');
const SANS = '"NotoSC", sans-serif', MONO = '"JBMono", "NotoSC", monospace';
const INK = '#f1efe9', DIM = 'rgba(241,239,233,.62)', ACC = '#ff7a3d', LINE = 'rgba(241,239,233,.78)';
let texts = [];
export const overlayTexts = () => texts;

const v3 = new THREE.Vector3();
let CAM, Wd, Hd;
const proj = v => { v3.copy(v).project(CAM); return [(v3.x + 1) / 2 * Wd, (1 - v3.y) / 2 * Hd, v3.z]; };
const fade = (t, a, d = .3) => ss(seg(t, a, a + d));

// 标签：锚点 + 引线（斜线后水平）+ 编号 / 名称 / 规格
function label(t, o) {
  const { t0, t1, a, lx, ly, idx, name, spec, id, align = 'left', fo = .25 } = o;
  const dl = eo(seg(t, t0, t0 + .36)), tx = fade(t, t0 + .16, .3), out = 1 - fade(t, t1 - fo, fo);
  if (dl <= 0 || out <= 0) return;
  const [ax, ay] = a, dir = align === 'left' ? 1 : -1, ex = lx - dir * 34;
  g.globalAlpha = out;
  const fl = t >= T.stab ? 1 - seg(t, T.stab, T.stab + .3) : 0;   // 12.5 合奏刺：所有锚点同时亮一下
  g.fillStyle = fl > 0 ? ACC : INK; g.beginPath(); g.arc(ax, ay, 3.4 + 2.5 * fl, 0, 7); g.fill();
  g.strokeStyle = fl > 0 ? `rgba(255,122,61,${.35 + .6 * fl})` : 'rgba(241,239,233,.38)'; g.lineWidth = 1 + fl; g.beginPath(); g.arc(ax, ay, 3.4 + 7 * dl + 16 * (1 - fl) * (fl > 0 ? 1 : 0), 0, 7); g.stroke();
  // 锚点在标签列右侧时：先竖直走到规格行下方，再水平回到列（不穿过文字）
  const under = align === 'left' && ax > lx - 40;
  const bx = under ? ax : ex, by = under ? ly + 48 : ly, fx = under ? lx : lx - dir * 12;
  const s1 = Math.hypot(bx - ax, by - ay), s2 = Math.abs(fx - bx), len = (s1 + s2) * dl;
  g.strokeStyle = LINE; g.lineWidth = 1.4; g.beginPath(); g.moveTo(ax, ay);
  if (len <= s1) g.lineTo(ax + (bx - ax) * len / s1, ay + (by - ay) * len / s1);
  else { g.lineTo(bx, by); g.lineTo(bx + Math.sign(fx - bx) * (len - s1), by); }
  g.stroke();
  if (tx <= 0) return;
  g.globalAlpha = out * tx; const dx = (1 - tx) * 10 * dir;
  g.textAlign = align; g.textBaseline = 'alphabetic';
  g.font = `500 30px ${SANS}`; const wn = g.measureText(name).width;
  g.font = `500 16px ${MONO}`; const wi = idx ? g.measureText(idx).width + 12 : 0;
  const nx = align === 'left' ? lx + wi : lx;
  if (idx) { g.fillStyle = ACC; g.fillText(idx, (align === 'left' ? lx : lx - wn - 12) + dx, ly - 2); }
  g.fillStyle = INK; g.font = `500 30px ${SANS}`; g.fillText(name, nx + dx, ly + 4);
  let ws = 0;
  if (spec) { g.fillStyle = DIM; g.font = `400 18px ${MONO}`; g.fillText(spec, nx + dx, ly + 32); ws = g.measureText(spec).width; }
  g.textAlign = 'left';
  if (tx > .99 && out > .99) {
    const L = align === 'left';
    texts.push({ id: id + 'n', text: (idx ? idx + ' ' : '') + name, x0: L ? lx : lx - wn - wi, y0: ly - 26, x1: L ? nx + wn : lx, y1: ly + 10 });
    if (spec) texts.push({ id: id + 's', text: spec, x0: L ? nx : lx - ws, y0: ly + 14, x1: L ? nx + ws : lx, y1: ly + 38 });
  }
}

// 尺寸线：两个 3D 点之间，带延伸线与斜 tick；数字在深色小底板上，随线角度且不倒置
function dimension(t, o) {
  const { t0, t1, A, B, ext = [], text, id, side = -1 } = o;
  const k = eo(seg(t, t0, t0 + .45)), out = 1 - fade(t, t1 - .25, .25);
  if (k <= 0 || out <= 0) return;
  const a = proj(A), b = proj(B), mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  g.globalAlpha = out; g.strokeStyle = ACC; g.lineWidth = 1.5;
  for (const [p, q] of ext) { const p1 = proj(p), q1 = proj(q); g.beginPath(); g.moveTo(p1[0], p1[1]); g.lineTo(p1[0] + (q1[0] - p1[0]) * k, p1[1] + (q1[1] - p1[1]) * k); g.stroke(); }
  g.beginPath(); g.moveTo(mx + (a[0] - mx) * k, my + (a[1] - my) * k); g.lineTo(mx + (b[0] - mx) * k, my + (b[1] - my) * k); g.stroke();
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  for (const p of [a, b]) { g.save(); g.translate(p[0], p[1]); g.rotate(ang - Math.PI / 4); g.beginPath(); g.moveTo(-7 * k, 0); g.lineTo(7 * k, 0); g.stroke(); g.restore(); }
  const tA = fade(t, t0 + .2, .2); if (tA <= 0) return;
  let ra = ang; if (ra > Math.PI / 2) ra -= Math.PI; if (ra < -Math.PI / 2) ra += Math.PI;
  g.save(); g.translate(mx, my); g.rotate(ra); g.globalAlpha = out * tA; g.textAlign = 'center';
  g.font = `500 22px ${MONO}`; const w = g.measureText(text).width;
  const oy = side < 0 ? -36 : 8;
  g.fillStyle = 'rgba(14,15,17,.74)'; g.fillRect(-w / 2 - 9, oy, w + 18, 30);
  g.fillStyle = INK; g.fillText(text, 0, oy + 22);
  g.restore(); g.textAlign = 'left';
  if (tA > .99 && out > .99) texts.push({ id, text, x0: mx - w / 2 - 40, y0: my - 50, x1: mx + w / 2 + 40, y1: my + 50 });
}

export function drawOverlay(t, cam, ctx) {
  CAM = cam; Wd = ctx.W; Hd = ctx.H; texts = [];
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, Wd, Hd);
  const { worldOf, springLen } = ctx;
  // 1 · 四个零件标签：右侧固定列，行按锚点高度排序后均匀错开
  const t1 = T.hush;
  if (t > T.labels[0] - .05 && t < t1 + .05) {
    const anchors = LABELS.map(o => {
      if (o.part === 'spring') return proj(worldOf('spring', springLen * .5, 0, DIMS.spring.coilR + .2));
      return proj(worldOf(o.part, ...o.a));
    });
    const order = anchors.map((p, i) => [p[1], i]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
    const ys = []; order.forEach((i, r) => { ys[i] = 175 + r * 108; });
    LABELS.forEach((o, i) => label(t, { id: o.id, t0: T.labels[i], t1, a: anchors[i], lx: 1470, ly: ys[i], idx: o.idx, name: o.name, spec: o.spec }));
  }
  // 2 · 尺寸线画在零件上：笔芯全长 98 mm（下方），弹簧自由长 18 mm（上方）
  if (t > T.dims[0] - .05 && t < t1 + .05) {
    const R = DIMS.refill, yo = -4.2;
    dimension(t, { id: 'd1', t0: T.dims[0], t1, A: worldOf('refill', R.x0, yo, 0), B: worldOf('refill', R.x1, yo, 0), side: 1,
      ext: [[worldOf('refill', R.x0, -.6, 0), worldOf('refill', R.x0, yo - 1.2, 0)], [worldOf('refill', R.x1, -1.2, 0), worldOf('refill', R.x1, yo - 1.2, 0)]], text: '98 mm' });
    const sy = 5.2, L = springLen;
    dimension(t, { id: 'd2', t0: T.dims[1], t1, A: worldOf('spring', 0, sy, 0), B: worldOf('spring', L, sy, 0), side: -1,
      ext: [[worldOf('spring', 0, 2.5, 0), worldOf('spring', 0, sy + 1.2, 0)], [worldOf('spring', L, 2.5, 0), worldOf('spring', L, sy + 1.2, 0)]], text: `${DIMS.spring.free} mm` });
  }
  // 3 · "代码模型"注：左下角
  if (t > T.labels[0] && t < t1 + .05) {
    const a = fade(t, T.labels[0], .3) * (1 - fade(t, t1 - .25, .25));
    g.globalAlpha = a; g.fillStyle = DIM; g.font = `400 17px ${SANS}`; g.fillText('代码模型 · 尺寸为模型实测', 96, 1010);
    g.fillStyle = ACC; g.fillRect(96, 984, 22, 2);
    if (a > .99) texts.push({ id: 'note', text: '代码模型 · 尺寸为模型实测', x0: 96, y0: 990, x1: 96 + g.measureText('代码模型 · 尺寸为模型实测').width, y1: 1016 });
  }
  // 4 · 缝内：引线落在一颗齿的齿尖上
  if (t > T.gapNote - .05 && t < T.pull + .05) {
    const C = DIMS.cam, f = Math.PI * 2 * 7.6 / C.teeth;   // 齿尖附近（随凸轮转动，读取当前转角）
    const rot = ctx.ST && ctx.ST.camRot || 0;
    const r = (C.r + C.rIn) / 2 + .4;
    const a = proj(worldOf('cam', C.base + C.toothH * .9, r * Math.cos(f + rot), r * Math.sin(f + rot)));
    label(t, { id: 'g1', t0: T.gapNote, t1: T.pull, a: [clamp(a[0], 200, 1700), clamp(a[1], 150, 950)], lx: 1430, ly: 250, name: '每按一次', spec: '转 45°', fo: .25 });
  }
  g.globalAlpha = 1;
}
