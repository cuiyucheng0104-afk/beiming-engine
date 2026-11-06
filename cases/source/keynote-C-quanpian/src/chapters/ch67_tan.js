// 第七章「谈」：第五章的城本来就把街道排成「谈」字十笔（city.plan.strokes，世界坐标，米）。
// 本章在正俯镜头里按笔顺把十条街"点亮"成朱红：每条街一条贴地的色带（街宽的 0.76），带圆头；色带按弧长生长（drawRange），八分音符一笔。
// 近半页（z > 书脊）的色带挂在跨页 7 的 root 上；远半页（第 6 页背面，有 4.7° 坡）的挂在 spread(7).back 上，和第五章 farG 同一套坐标，合书时跟着书页一起合上。
import * as THREE from 'three';
import { clamp, seg } from '/core/lib.js';
import { TM, E8 } from './ch67_plan.js';

const COS_FAR = Math.cos(4.7 * Math.PI / 180), STEP = .0015, LIFT = .00045;
export const strokeT = i => +(Math.round((TM.tanStroke0 + i * E8) * 30) / 30).toFixed(4);
export const STROKE_D = .22;

export function buildTan(ctx, plan) {
  const sp = ctx.book.spread(7), ZH = plan.ZH, W = plan.streetW * .76;
  const nearG = new THREE.Group(); nearG.name = 'ch67.tan.near'; sp.root.add(nearG);
  const farG = new THREE.Group(); farG.name = 'ch67.tan.far'; farG.rotation.x = Math.PI / 2; sp.back.add(farG);
  const mat = new THREE.MeshStandardMaterial({ color: '#BE3A2E', roughness: .78, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  // 世界 (x, z) → 某一半页的本地坐标（近半页：root 本地 ≈ 世界；远半页：farG 本地 = (x, 法线, 沿坡距离)）
  const loc = (x, z, far) => far ? [x, LIFT, (z - ZH) / COS_FAR] : [x, LIFT, z];
  const strokes = plan.strokes.map(S => {
    const P = S.p; const samples = [];   // [x, z, s]
    let s = 0;
    for (let i = 1; i < P.length; i++) { const [ax, az] = P[i - 1], [bx, bz] = P[i], L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / STEP));
      for (let k = i === 1 ? 0 : 1; k <= n; k++) { const u = k / n; samples.push([ax + (bx - ax) * u, az + (bz - az) * u, s + L * u]); } s += L; }
    const total = s;
    // 两半页各一条带：四边形按弧长顺序排，drawRange 截到当前进度
    const parts = [false, true].map(far => {
      const pos = [], sEnd = [];
      for (let i = 1; i < samples.length; i++) {
        const [ax, az, as] = samples[i - 1], [bx, bz, bs] = samples[i], mz = (az + bz) / 2;
        if ((mz < ZH - .0025) !== far || Math.abs(mz - ZH) < .0025) continue;      // 书脊折缝两侧各让 2.5 mm
        const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1, nx = -dz / L * W / 2, nz = dx / L * W / 2;
        const A1 = loc(ax + nx, az + nz, far), A2 = loc(ax - nx, az - nz, far), B1 = loc(bx + nx, bz + nz, far), B2 = loc(bx - nx, bz - nz, far);
        pos.push(...A1, ...B1, ...A2, ...B1, ...B2, ...A2); sEnd.push(bs);
      }
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); geo.computeVertexNormals();
      const me = new THREE.Mesh(geo, mat); me.receiveShadow = true; me.frustumCulled = false; (far ? farG : nearG).add(me);
      return { me, sEnd };
    });
    // 圆头：每个折点一个圆盘（起点、拐点、终点），走到了才出现
    const caps = []; let acc = 0;
    P.forEach((p, i) => { if (i) acc += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); const far = p[1] < ZH;
      const c = new THREE.Mesh(new THREE.CircleGeometry(W / 2, 28), mat); c.rotation.x = -Math.PI / 2; c.position.set(...loc(p[0], p[1], far)); c.position.y -= .00005; c.receiveShadow = true;
      (far ? farG : nearG).add(c); caps.push({ c, s: acc }); });
    return { parts, caps, total };
  });
  const box = plan.tanBox;
  return { nearG, farG, strokes, box, ZH };
}

export function updateTan(T, t) {
  const on = t >= strokeT(0) - .02;
  T.nearG.visible = T.farG.visible = on;
  if (!on) return;
  T.strokes.forEach((S, i) => {
    const p = clamp((t - strokeT(i)) / STROKE_D), e = 1 - Math.pow(1 - p, 2), s = S.total * e;
    for (const P of S.parts) { let n = 0; while (n < P.sEnd.length && P.sEnd[n] <= s + 1e-9) n++; P.me.geometry.setDrawRange(0, n * 6); P.me.visible = n > 0; }
    for (const c of S.caps) c.c.visible = p > 0 && s >= c.s - 1e-9;
  });
}
