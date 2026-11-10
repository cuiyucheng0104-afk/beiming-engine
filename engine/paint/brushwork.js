// 北冥引擎 · 毛笔笔法（Canvas 2D）：书法的起收笔（藏锋 / 露锋，回锋 / 出锋 / 顿笔）、行笔提按、飞白（枯笔露白）、
// 洇墨（湿笔在生宣上晕开的一圈淡墨）、墨色由浓到淡。轮廓来自 engine/core/stroke.js 的 brushOutline。
// 与 engine/paint/ink.js 的区别：ink.js 是等速描线（屏幕上的手绘线条），这里是"一笔字"——笔画有头有尾、墨会枯。
//
//   const brush = createBrush(noise)       noise = createNoise2D(mulberry(种子))：抖动、笔压起伏、飞白的笔毛走向都从它取，
//                                          同一个种子每次重渲都一样；不读时钟、不留上一帧的状态
//   brush.stroke(g, pts, o) → { length, spine }   pts = [[x, y, 笔压?], ...]（g 当前变换下的坐标，至少 2 个点）。o：
//     size 8           笔宽（直径）                  thin 0.55        笔压对粗细的影响     streamline 0.2  中心线跟手的迟滞
//     color '#1d1b1a'  墨色（CSS 颜色）              alpha 1          整笔不透明度（乘在 g 当前的 globalAlpha 上）
//     entry 'hidden'   起笔：hidden 藏锋 | exposed 露锋 | round     exit 'exposed'  收笔：exposed 出锋 | return 回锋 | press 顿笔 | round
//     entryLen / exitLen / bulge   起收笔造型的长度与鼓起比例（见 brushOutline）
//     press 0.15       行笔提按：笔压按噪声缓慢起伏的幅度（0 = 只用 pts 里的笔压）
//     jit 0            中心线抖动幅度；step 0：抖动、提按换形的拍号（一拍二写 holdAt(t, 2)，同一拍里形状不变）
//     seed 0           这一笔自己的噪声偏移（同一支笔画多笔时每笔给不同的 seed）
//     fade 0.2         墨色由浓到淡：笔画末端的不透明度比开头低多少（0 = 不变）
//     dry 0            飞白强度 0..1（0 = 不露白）；dryFrom 0.35：从弧长的哪一段开始枯（0..1）；bristles 24：笔毛数
//     bleed 0          洇墨 0..1：笔画外一圈淡墨，边缘随纤维起伏；bleedPx：外扩的宽度（默认 size × 0.22）
//   brush.outline(pts, o) → brushOutline 的结果（同样的抖动与提按），给只要形状的场合（遮罩、碰撞、TEXTS 方框）
//   飞白只挖这一笔自己的墨（先画进离屏层再合成），露出的是底下已经画好的东西，所以先铺纸、再写字。
//
// 做法：飞白按"笔毛"建模——横跨笔宽排 bristles 条平行轨迹，越靠笔肚两侧、越到笔画后段越容易枯；某条笔毛在某一段
// 干了，就沿笔势挖掉一道细白。笔毛的干湿用噪声沿弧长取，所以露白是一道道断续的长丝，而不是随机的点。
// 方法参照：Strassmann 1986《Hairy Brushes》（SIGGRAPH）的笔毛模型；写法是本文件自己的。

import { brushOutline } from '../core/stroke.js';
import { clamp, hashi } from '../core/math.js';
import { canvasFor } from './canvas.js';
import { smoothClosed } from './path.js';

const ss01 = x => { x = clamp(x); return x * x * (3 - 2 * x); };

// 飞白：每条笔毛沿弧长的干段 → [{ off, width, depth, wave, runs: [[i0, i1], ...] }]（i 是 spine 的下标）。纯函数，Node 里能测。
// off 横向位置（−1..1），width 相对笔宽的粗细，depth 挖掉墨的比例（0.65..1：灰丝到白丝），wave 横向摆动的噪声偏移。
// 每条笔毛在弧长比例 u_k 处"墨尽"，之后基本是干的（偶尔有一段又沾上墨）；越靠笔肚两侧、dry 越大，u_k 越早。
// 所以露白是从笔画中后段某处开始、一直拖到收笔的长丝，越往后越多——不是均匀撒开的短划。
export function dryRuns(spine, { size = 8, dry = 0, dryFrom = 0.35, bristles = 24, seed = 0, noise }) {
  const N = Math.max(4, Math.round(bristles)), out = [];
  if (!(dry > 0) || spine.length < 2) return out;
  const total = spine[spine.length - 1].s || 1, from = clamp(dryFrom);
  for (let k = 0; k < N; k++) {
    const h1 = hashi(k * 131 + seed * 977), h2 = hashi(k * 71 + 13 + seed * 31), h3 = hashi(k * 29 + 7 + seed * 53);
    const off = clamp(-1 + (k + 0.5) * 2 / N + (h1 - 0.5) * 1.2 / N, -1, 1);   // 横向位置 −1..1
    const prone = 0.55 * Math.abs(off) + 0.45 * h2;                             // 先枯的倾向：两侧、外加每根笔毛自己的差异
    const uk = from + (1 - from) * (1 - clamp(dry) * prone * 1.15);              // 墨尽的位置（≥ 1 表示这根到底都有墨）
    if (uk >= 1) continue;
    const runs = [];
    let i0 = -1;
    for (let i = 0; i < spine.length; i++) {
      const u = spine[i].s / total, prog = clamp((u - uk) / Math.max(1e-3, 1 - uk));
      const rewet = noise(k * 3.17 + seed * 11.3, spine[i].s / (size * 5)) > 0.35 + 0.5 * prog + 0.3 * h3;   // 偶尔又沾上墨，越往后越少
      const dryHere = u >= uk && !rewet;
      if (dryHere && i0 < 0) i0 = i;
      if (!dryHere && i0 >= 0) { if (i - i0 >= 2) runs.push([i0, i - 1]); i0 = -1; }
    }
    if (i0 >= 0 && spine.length - i0 >= 2) runs.push([i0, spine.length - 1]);
    if (runs.length) out.push({ off, width: (2 / N) * (0.6 + 1.1 * h3 * h3), runs, wave: k * 7.7 + seed * 2.3, depth: 0.65 + 0.35 * hashi(k * 47 + 5 + seed * 19) });
  }
  return out;
}

export function createBrush(noise) {
  if (typeof noise !== 'function') throw new TypeError('createBrush 需要一个噪声函数，例如 createBrush(createNoise2D(mulberry(7)))');

  // 抖动与提按：同一拍（step）里形状不变；返回新的点列，不改调用方的 pts
  function shape(pts, o) {
    const sd = o.seed ?? 0, st = o.step ?? 0, jit = o.jit ?? 0, press = o.press ?? 0.15;
    const n = pts.length, out = [];
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      if (i) acc += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      const j = jit ? jit * noise(acc / 60 + sd * 3.7, st * 1.37 + sd) : 0;
      const p0 = pts[i][2] ?? 0.5;
      const pr = press ? clamp(p0 + press * noise(acc / 320 + sd * 5.1, 9.3 + sd + st * 0.21), 0.05, 1) : p0;
      out.push([pts[i][0] - ty * j, pts[i][1] + tx * j, pr]);
    }
    return out;
  }
  const outline = (pts, o = {}) => brushOutline(shape(pts, o), {
    size: o.size ?? 8, thinning: o.thin ?? 0.55, streamline: o.streamline ?? 0.2,
    entry: o.entry ?? 'hidden', exit: o.exit ?? 'exposed', entryLen: o.entryLen, exitLen: o.exitLen, bulge: o.bulge,
  });

  function stroke(g, pts, o = {}) {
    if (!pts || pts.length < 2) return { length: 0, spine: [] };
    const size = o.size ?? 8, B = outline(pts, o);
    if (B.spine.length < 2) return { length: 0, spine: B.spine };
    const cv = g.canvas, L = canvasFor('engine-brush-layer', cv.width, cv.height), q = L.getContext('2d');
    q.setTransform(1, 0, 0, 1, 0, 0); q.globalCompositeOperation = 'source-over'; q.globalAlpha = 1; q.filter = 'none';
    q.clearRect(0, 0, L.width, L.height);
    q.setTransform(g.getTransform());
    const body = smoothClosed(B.outline), color = o.color || '#1d1b1a';

    // 洇墨：笔画外一圈淡墨，边缘随纸纤维起伏（外扩量按噪声沿弧长变化），画在笔身之下，再轻轻柔一下边
    const bleed = clamp(o.bleed ?? 0);
    if (bleed > 0) {
      const bp = o.bleedPx ?? size * 0.22, sd = o.seed ?? 0, m = q.getTransform(), sc = Math.hypot(m.a, m.b) || 1;
      const grow = (p, side) => bp * (0.45 + 0.55 * (0.5 + 0.5 * noise(p.s / (size * 0.7) + side * 17.1, sd * 3.3 + 40)));
      const sp = B.spine, ring = [];
      for (const p of sp) { const e = p.rl + grow(p, 1); ring.push([p.x + p.nx * e, p.y + p.ny * e]); }
      const z = sp[sp.length - 1], z1 = sp[sp.length - 2], a0 = sp[0], a1 = sp[1];
      const ext = (p, q2, side) => { const dx = p.x - q2.x, dy = p.y - q2.y, l = Math.hypot(dx, dy) || 1, e = grow(p, side) + p.r * 0.5; return [p.x + dx / l * e, p.y + dy / l * e]; };
      ring.push(ext(z, z1, 2));
      for (let i = sp.length - 1; i >= 0; i--) { const p = sp[i], e = p.rr + grow(p, -1); ring.push([p.x - p.nx * e, p.y - p.ny * e]); }
      ring.push(ext(a0, a1, 3));
      q.save(); q.filter = `blur(${Math.max(0.4, bp * sc * 0.18).toFixed(2)}px)`; q.globalAlpha = 0.2 * bleed; q.fillStyle = color;
      q.fill(smoothClosed(ring)); q.restore();
    }
    q.fillStyle = color; q.fill(body);
    // 墨色由浓到淡：沿首尾连线叠一层"透明 → fade"的 destination-out 渐变，只减不透明度、不改墨色
    const fade = clamp(o.fade ?? 0.2), a = B.spine[0], z = B.spine[B.spine.length - 1];
    if (fade > 0 && Math.hypot(z.x - a.x, z.y - a.y) > 1) {
      const gr = q.createLinearGradient(a.x, a.y, z.x, z.y);
      gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, `rgba(0,0,0,${fade.toFixed(4)})`);
      q.save(); q.globalCompositeOperation = 'destination-out'; q.fillStyle = gr; q.fill(body); q.restore();
    }
    // 飞白：沿笔毛挖细白。每段干笔毛画成一条带子：宽度从 0 渐宽（墨是慢慢断开的）、沿弧长按噪声粗细不匀；
    // 有的笔毛只挖掉一部分墨（灰丝），有的挖干净（白丝）；干到收笔的笔毛顺切线多画出半个笔宽，盖住圆头或顿笔的末端
    const runs = dryRuns(B.spine, { size, dry: o.dry ?? 0, dryFrom: o.dryFrom ?? 0.35, bristles: o.bristles ?? 24, seed: o.seed ?? 0, noise });
    if (runs.length) {
      const N = Math.max(4, Math.round(o.bristles ?? 24)), sp = B.spine, last = sp.length - 1;
      const at = (p, off) => { const o2 = clamp(off, -1, 1), rs2 = o2 >= 0 ? p.rl : p.rr; return [p.x + p.nx * rs2 * o2, p.y + p.ny * rs2 * o2]; };
      q.save(); q.globalCompositeOperation = 'destination-out';
      for (const { off, width, runs: rs, wave, depth } of runs) {
        q.fillStyle = `rgba(0,0,0,${depth.toFixed(3)})`;
        for (const [i0, i1] of rs) {
          const pts = [];
          for (let i = i0; i <= i1; i++) { const p = sp[i]; pts.push({ p, xy: at(p, off + (0.6 / N) * noise(wave, p.s / (size * 2.5))) }); }
          if (i1 === last && sp.length > 1) {                            // 顺切线延出，盖住末端的圆头
            const z = sp[last], z1 = sp[last - 1], dx = z.x - z1.x, dy = z.y - z1.y, l = Math.hypot(dx, dy) || 1, e = z.r * 1.1;
            const xy = pts[pts.length - 1].xy;
            pts.push({ p: { ...z, s: z.s + e }, xy: [xy[0] + dx / l * e, xy[1] + dy / l * e] });
          }
          // 一条白丝画成一条变宽的带子、一次填充（逐小段描边在接头处会重复挖墨，出现一格一格的网纹）
          const s0 = pts[0].p.s, ramp = size * 1.2, L2 = [], R2 = [];
          for (let j = 0; j < pts.length; j++) {
            const a = pts[Math.max(0, j - 1)].xy, b = pts[Math.min(pts.length - 1, j + 1)].xy;
            let tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
            const p = pts[j].p, grow = clamp((p.s - s0) / ramp);
            const rag = 0.55 + 0.45 * (0.5 + 0.5 * noise(wave + 31.7, p.s / (size * 0.9)));
            const hw = Math.max(0.15, p.r * width * grow * rag * 0.5), [x, y] = pts[j].xy;
            L2.push([x - ty * hw, y + tx * hw]); R2.push([x + ty * hw, y - tx * hw]);
          }
          const rib = new Path2D(); rib.moveTo(L2[0][0], L2[0][1]);
          for (let j = 1; j < L2.length; j++) rib.lineTo(L2[j][0], L2[j][1]);
          for (let j = R2.length - 1; j >= 0; j--) rib.lineTo(R2[j][0], R2[j][1]);
          rib.closePath(); q.fill(rib);
        }
      }
      q.restore();
    }
    // 合成到 g：层里已按 g 的变换画好，这里按单位变换整张贴回去
    g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha *= clamp(o.alpha ?? 1); g.drawImage(L, 0, 0); g.restore();
    return { length: B.length, spine: B.spine };
  }

  return { stroke, outline };
}
