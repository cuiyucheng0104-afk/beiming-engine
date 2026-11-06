// 按动圆珠笔的代码模型。全部尺寸在 DIMS 里（mm），是画面上所有数字的唯一来源（见 FACTS.md）。
// 坐标：x 为笔轴（0 = 前杆笔尖口，+x 指向按钮），几何体以笔轴为中心（y = z = 0）；装配后整支笔躺在地面上，轴高 AXIS_Y。
import * as THREE from 'three';

import { DIMS, AXIS_Y } from './dims.js';
export { DIMS, AXIS_Y };

// —— 车削体：profile = [[x, r], …]（闭合环，逆时针：从左端内侧开始）。每段独立法线，角度 < 35° 的相邻段平滑 ——
export function lathe(profile, seg = 96, closed = true) {
  const P = profile.slice(); if (closed) P.push(P[0]);
  const N = [];
  for (let i = 0; i < P.length - 1; i++) {
    const dx = P[i + 1][0] - P[i][0], dr = P[i + 1][1] - P[i][1], l = Math.hypot(dx, dr);
    N.push(l < 1e-6 ? null : [-dr / l, dx / l]);
  }
  const pos = [], nor = [];
  const smooth = (a, b) => (a && b && a[0] * b[0] + a[1] * b[1] > Math.cos(35 * Math.PI / 180)) ? (() => { const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y); return [x / l, y / l]; })() : null;
  for (let i = 0; i < N.length; i++) {
    const n = N[i]; if (!n) continue;
    const p = P[i], q = P[i + 1];
    if (p[1] < .02 && q[1] < .02) continue;
    const prev = closed ? N[(i - 1 + N.length) % N.length] : N[i - 1], next = closed ? N[(i + 1) % N.length] : N[i + 1];
    const n0 = smooth(prev, n) || n, n1 = smooth(n, next) || n;
    for (let j = 0; j < seg; j++) {
      const f0 = j / seg * Math.PI * 2, f1 = (j + 1) / seg * Math.PI * 2;
      const V = (pt, f) => [pt[0], pt[1] * Math.cos(f), pt[1] * Math.sin(f)];
      const Nn = (nn, f) => [nn[0], nn[1] * Math.cos(f), nn[1] * Math.sin(f)];
      const a = V(p, f0), bq = V(q, f0), c = V(q, f1), d = V(p, f1);
      const na = Nn(n0, f0), nb = Nn(n1, f0), nc = Nn(n1, f1), nd = Nn(n0, f1);
      pos.push(...a, ...c, ...bq, ...a, ...d, ...c); nor.push(...na, ...nc, ...nb, ...na, ...nd, ...nc);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
// 圆角：在 profile 里用若干点近似一段圆弧（中心 cx, cr，半径 rad，角度 a0→a1，度）
export function arc(cx, cr, rad, a0, a1, n = 10) {
  const out = []; for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; out.push([cx + rad * Math.cos(a), cr + rad * Math.sin(a)]); } return out;
}

// —— 端面齿（锯齿冠）：环 rIn..rOut，基面 x = xb，齿朝 s（+1 朝 +x，−1 朝 −x），phase 为角度偏移 ——
// 法线解析给出（斜面平滑、陡面与侧壁锐利），每个三角形按法线校正绕序，正面渲染
export function crown(xb, rIn, rOut, teeth, H, s = 1, phase = 0, per = 24, nr = 4) {
  const pos = [], nor = [];
  const U = .8, hu = u => H * Math.min(u / U, 1), du = u => (u < U ? H / U : 0);
  const step = Math.PI * 2 / teeth;
  const P = (r, f, h) => [xb + s * h, r * Math.cos(f), r * Math.sin(f)];
  const norm3 = v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); };
  const rampN = (r, f, u) => {   // ∂P/∂r × ∂P/∂f，指向齿尖方向
    const dr = [0, Math.cos(f), Math.sin(f)], df = [s * du(u) / step, -r * Math.sin(f), r * Math.cos(f)];
    let n = [dr[1] * df[2] - dr[2] * df[1], dr[2] * df[0] - dr[0] * df[2], dr[0] * df[1] - dr[1] * df[0]];
    if (n[0] * s < 0) n = n.map(x => -x); return norm3(n);
  };
  const tri = (a, b, c, na, nb, nc) => {
    const e1 = b.map((x, i) => x - a[i]), e2 = c.map((x, i) => x - a[i]);
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const m = [0, 1, 2].map(i => na[i] + nb[i] + nc[i]);
    if (Math.hypot(...cr) < 1e-9) return;
    if (cr[0] * m[0] + cr[1] * m[1] + cr[2] * m[2] < 0) { pos.push(...a, ...c, ...b); nor.push(...na, ...nc, ...nb); }
    else { pos.push(...a, ...b, ...c); nor.push(...na, ...nb, ...nc); }
  };
  const quad = (a, b, c, d, na, nb, nc, nd) => { tri(a, b, c, na, nb, nc); tri(a, c, d, na, nc, nd); };
  for (let k = 0; k < teeth; k++) {
    const fa = phase + k * step;
    for (let i = 0; i < per; i++) {
      const u0 = i / per, u1 = (i + 1) / per, f0 = fa + u0 * step, f1 = fa + u1 * step, h0 = hu(u0), h1 = hu(u1);
      for (let j = 0; j < nr; j++) {
        const r0 = rIn + (rOut - rIn) * j / nr, r1 = rIn + (rOut - rIn) * (j + 1) / nr;
        quad(P(r0, f0, h0), P(r1, f0, h0), P(r1, f1, h1), P(r0, f1, h1), rampN(r0, f0, u0), rampN(r1, f0, u0), rampN(r1, f1, u1), rampN(r0, f1, u1));
      }
      const o0 = [0, Math.cos(f0), Math.sin(f0)], o1 = [0, Math.cos(f1), Math.sin(f1)], i0 = o0.map(x => -x), i1 = o1.map(x => -x);
      quad(P(rOut, f0, 0), P(rOut, f1, 0), P(rOut, f1, h1), P(rOut, f0, h0), o0, o1, o1, o0);
      quad(P(rIn, f0, 0), P(rIn, f1, 0), P(rIn, f1, h1), P(rIn, f0, h0), i0, i1, i1, i0);
    }
    const fe = fa + step, nd = [0, -Math.sin(fe), Math.cos(fe)];
    quad(P(rIn, fe, 0), P(rOut, fe, 0), P(rOut, fe, H), P(rIn, fe, H), nd, nd, nd, nd);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
// 零长边 → 零法线 → 着色器里 NaN → 泛光后变黑方块：把坏法线换成轴向
export function fixNormals(g) {
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) { const l = Math.hypot(n.getX(i), n.getY(i), n.getZ(i)); if (!(l > .5)) n.setXYZ(i, 1, 0, 0); }
  return g;
}

// —— 弹簧：螺旋管，长度可变（两端各一圈并紧）——
export function springGeometry(len, D = DIMS.spring) {
  const turns = D.turns + 2, w = D.wireR;
  const curve = new (class extends THREE.Curve {
    getPoint(u, out = new THREE.Vector3()) {
      const th = u * turns * Math.PI * 2;
      // 两端各 1 圈节距 = 线径（并紧），中间均分
      const tu = u * turns; const dead = 2 * w, mid = Math.max(0, len - 4 * w - 2 * dead) / D.turns;
      let x;
      if (tu < 1) x = w + tu * dead; else if (tu > turns - 1) x = len - w - (turns - tu) * dead; else x = w + dead + (tu - 1) * mid;
      return out.set(x, D.coilR * Math.cos(th), D.coilR * Math.sin(th));
    }
  })();
  return fixNormals(new THREE.TubeGeometry(curve, turns * 30, w, 8, false));
}

// —— 笔夹（侧面轮廓挤出）——
export function clipGeometry() {
  const s = new THREE.Shape();
  const pts = [[96.2, 5.25], [96.6, 5.95], [97.6, 6.55], [99, 6.75], [131.2, 6.75], [133.4, 6.4], [135.2, 5.2], [135.4, 4.4], [134.2, 4.4], [133.6, 5.4], [131.4, 5.95], [99.4, 5.95], [98.4, 5.7], [97.4, 5.15]];
  s.moveTo(...pts[0]); for (const p of pts.slice(1)) s.lineTo(...p); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: 3.2, bevelEnabled: true, bevelThickness: .25, bevelSize: .18, bevelSegments: 3, curveSegments: 8 });
  g.translate(0, -AXIS_Y, -1.6);   // 轮廓按地面坐标写，移回以笔轴为原点
  const n = g.attributes.normal; for (let i = 0; i < n.count; i++) if (!(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) > .5)) n.setXYZ(i, 0, 1, 0);
  return g;
}

// —— 各零件的车削轮廓 ——
export function profiles() {
  const R = DIMS.barrelR;
  const front = [
    [63, 3.7], [14.5, 3.7], [12, 3.1], [8.2, 2.35], [8, 2.3], [8, 1.6], [3.5, 1.0], [0, 0.9],   // 内孔随锥面收窄（不再穿出锥面）
    [0, 1.2], ...arc(0.35, 1.2, 0.35, 180, 90, 4).slice(1), [16.2, 4.58], [16.8, 4.72], [17.4, 4.84], [18.0, 4.94],   // 锥面到杆身：平滑过渡（无台阶缝）
    [18.5, R], [55.2, R], [55.5, 4.7], [55.5, 4.3], [62.6, 4.3], [63, 3.95],
  ];
  const thread = [];   // 螺纹的暗示：一串细环
  for (let x = 56.2; x < 62.4; x += .9) thread.push([x, 4.3], [x + .2, 4.48], [x + .45, 4.48], [x + .65, 4.3]);
  const grip = [[21.4, 4.95]];
  for (let x = 21.4; x < 49.4; x += 2) grip.push([x + .3, 5.28], [x + 1.5, 5.28], [x + 1.8, 5.16], [x + 2, 5.16]);
  grip.push([49.6, 5.0], [49.6, 4.95]);
  const rear = [
    [133.5, 3.75], [133.5, 4.35], [58.3, 4.35], [58, 4.6], [58, 4.75], [58.25, R], [135.6, R], ...arc(135.6, 4.6, 0.4, 90, 0, 4).slice(1), [136, 3.75],
  ];
  const ring = [[58.0, 4.62], [58.0, 5.03], [59.6, 5.03], [59.6, 4.62]];
  const { x0: rx0, x1: rx1, r: rr } = DIMS.refill;
  const tube = [[6.2, 0.02], [6.2, rr], [rx1 - .4, rr], [rx1, rr - .4], [rx1, 0.02]];
  const tip = [[rx0 + .25, 0.02], [rx0 + .25, 0.34], [rx0 + .5, 0.42], [4.2, 1.0], [6.4, 1.5], [6.4, 0.02]];
  const collar = [[DIMS.refill.collar[0], rr], [DIMS.refill.collar[0], 2.3], [DIMS.refill.collar[0] + .3, 2.45], [DIMS.refill.collar[1] - .3, 2.45], [DIMS.refill.collar[1], 2.3], [DIMS.refill.collar[1], rr]];
  const C = DIMS.cam;
  const cam = [[C.x0, C.rIn], [C.x0, C.r - .3], [C.x0 + .3, C.r], [C.base, C.r], [C.base, C.rIn]];
  const Pl = DIMS.plunger;
  const plunger = [
    [Pl.base, 0.02], [Pl.base, 3.1], [130.6, 3.1], [130.8, 4.0], [131.1, 4.2], [132.3, 4.2], [132.5, 3.5],
    [146.2, 3.5], ...arc(146.2, 0, 3.5, 90, 0, 14).map(([x, r]) => [146.2 + (x - 146.2) * (4.8 / 3.5), r]).slice(1),
  ];
  return { front, thread, grip, rear, ring, tube, tip, collar, cam, plunger };
}
