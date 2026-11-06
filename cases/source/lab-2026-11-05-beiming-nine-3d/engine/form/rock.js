// 北冥引擎 · 山石：笋状尖峰与台地（山水画里的峰与台）。R 是调用方给的确定性随机函数（mulberry），按固定顺序取数。
//   spire(R, H, Rb, { steps, lean: [x, z], NH, NA, hfScale, hfBase, seed })
//       下宽上窄、顶部圆钝的峰：竖向褶皱（卡通分档切出皴面），每隔 1/steps 往里收一下成台阶。
//       aRock = (高度比例 hf, cos 绕轴角, sin 绕轴角, seed)
//   mesa(R, { cx, cz, rx, rz, yTop(x, z), yBot(x, z), NA, seed, dome })
//       不规则椭圆轮廓的台：崖壁往下收、竖纹，顶面微拱；同样带 aRock。g.userData.rim(θ) 是轮廓的径向倍率
//   mesaEdge(m, x, side)     台的轮廓上 x 处、side 侧（z 的符号）的边缘 z；m = { cx, cz, rx, rz, rim }
import * as THREE from 'three';
import { lerp, ss, seg, TAU } from '../core/math.js';
import { loftRings } from './loft.js';

const sstep = (a, b, x) => ss(seg(x, a, b));
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export function spire(R, H, Rb, { steps = 4, lean = [0, 0], NH = 40, NA = 44, hfScale = 1, hfBase = 0, seed = 0 } = {}) {
  const p1 = R() * TAU, p2 = R() * TAU, p3 = R() * TAU, p4 = R() * TAU, p5 = R() * TAU;
  const rings = [], rock = [];
  for (let i = 0; i <= NH; i++) {
    const h = i / NH;
    let rb = Rb * Math.pow(Math.max(0, 1 - Math.pow(h, 1.85)), 0.6) * (1 + 0.1 * Math.sin(h * Math.PI * 1.7 + p4));
    const st = h * steps, fr = st - Math.floor(st);
    rb *= 1 + 0.17 * (sstep(0, 0.8, fr) - sstep(0.8, 1, fr)) * (1 - h * 0.45);
    const ring = [];
    for (let j = 0; j < NA; j++) {
      const th = j / NA * TAU;
      const ridge = (0.2 * Math.sin(3 * th + p1) + 0.1 * Math.sin(5 * th + p2) + 0.06 * Math.sin(9 * th + p3 + h * 3)) * (0.5 + 0.5 * h);
      const r = rb * (1 + ridge + 0.04 * Math.sin(th * 13 + p5 + h * 9));
      ring.push(V3(r * Math.cos(th) + lean[0] * H * h * h, H * h, r * Math.sin(th) + lean[1] * H * h * h));
      rock.push(hfBase + h * hfScale, Math.cos(th), Math.sin(th), seed);
    }
    rings.push(ring);
  }
  return loftRings(rings, {
    startCap: { p: V3(0, 0, 0), attr: { aRock: [hfBase, 1, 0, seed] } },
    endCap: { p: V3(lean[0] * H, H + Rb * 0.03, lean[1] * H), attr: { aRock: [hfBase + hfScale, 1, 0, seed] } },
    attrs: { aRock: { data: rock, size: 4 } },
  });
}

export function mesa(R, { cx, cz, rx, rz, yTop, yBot, NA = 96, seed = 0, dome = 2.2 }) {
  const p1 = R() * TAU, p2 = R() * TAU, p3 = R() * TAU, p4 = R() * TAU;
  const out = th => 1 + 0.12 * Math.sin(2 * th + p1) + 0.07 * Math.sin(3 * th + p2) + 0.045 * Math.sin(7 * th + p3);
  const rings = [], rock = [];
  const H = [0, 0.3, 0.55, 0.75, 0.88, 0.96, 1.0];               // 崖壁（hf 0→1）
  const T = [0.97, 0.86, 0.62, 0.35, 0.1];                       // 顶面向内收的环
  for (let i = 0; i < H.length + T.length; i++) {
    const ring = [];
    for (let j = 0; j < NA; j++) {
      const th = j / NA * TAU, o = out(th);
      let k, y, hf;
      const bx = cx + rx * o * Math.cos(th), bz = cz + rz * o * Math.sin(th);
      if (i < H.length) {
        const h = H[i];
        k = 0.8 + 0.2 * Math.pow(h, 0.45) + 0.02 * Math.sin(th * 31 + p4 + h * 2) * h + (i === H.length - 1 ? 0.02 : 0);
        const xx = cx + (bx - cx) * k, zz = cz + (bz - cz) * k;
        y = lerp(yBot(xx, zz), yTop(xx, zz), h); hf = h;
      } else {
        const f = T[i - H.length];
        k = 1.02 * f;
        const xx = cx + (bx - cx) * k, zz = cz + (bz - cz) * k;
        y = yTop(xx, zz) + 0.6 + dome * (1 - f * f); hf = 1;
      }
      ring.push(V3(cx + (bx - cx) * k, y, cz + (bz - cz) * k));
      rock.push(hf, Math.cos(th), Math.sin(th), seed);
    }
    rings.push(ring);
  }
  const cyTop = yTop(cx, cz) + 0.6 + dome;
  const g = loftRings(rings, {
    startCap: { p: V3(cx, yBot(cx, cz), cz), attr: { aRock: [0, 1, 0, seed] } },
    endCap: { p: V3(cx, cyTop, cz), attr: { aRock: [1, 1, 0, seed] } },
    attrs: { aRock: { data: rock, size: 4 } },
  });
  g.userData.rim = out;
  return g;
}

export function mesaEdge(m, x, side) {
  let best = null;
  for (let j = 0; j < 720; j++) {
    const th = j / 720 * TAU, o = m.rim(th);
    const bx = m.cx + m.rx * o * Math.cos(th), bz = m.cz + m.rz * o * Math.sin(th);
    if (Math.sign(bz - m.cz) !== side) continue;
    if (!best || Math.abs(bx - x) < Math.abs(best[0] - x)) best = [bx, bz];
  }
  return best[1];
}
