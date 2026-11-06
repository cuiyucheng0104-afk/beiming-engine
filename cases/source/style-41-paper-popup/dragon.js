// 纸龙：一串双面卡纸（头 + 9 节身体 + 尾 + 一对纸翼），沿头部轨迹的弧长排布（"跟着头走"），全部是 t 的纯函数。
import * as THREE from 'three';
import * as A from './art.js';
import { cv } from './paper.js';
import { texOf } from './book.js';
import { track, seg, eio, ss, clamp, lerp } from './lib.js';

export function card(c, h, ax, ay, opt = {}) {
  const t = opt.tex || texOf(c), w = h * c.width / c.height;
  const g = new THREE.PlaneGeometry(w, h); g.translate(w / 2 - ax * w, ay * h - h / 2, 0);
  const m = new THREE.MeshStandardMaterial({ map: t, alphaTest: .5, alphaToCoverage: true, roughness: .85, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, m); mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: t, alphaTest: .5, side: THREE.DoubleSide });
  return { mesh, t, w, h };
}
const itemCard = (it, opt) => card(it.c, it.h, it.ax, it.ay, opt);

export function makeDragon(HEAD_H = .04, NSEG = 9) {
  const root = new THREE.Group();
  // 头：姿态变化时才重画
  const hc = cv(A.DH_W, A.DH_H); A.drawDragonHead(hc.getContext('2d'), {});
  const head = card(hc, HEAD_H, 310 / A.DH_W, 1 - 470 / A.DH_H); const headG = new THREE.Group(); headG.add(head.mesh); root.add(headG);
  let key = '';
  const segs = [], SP = .0185;
  for (let i = 0; i < NSEG; i++) {
    const k = i / (NSEG - 1), it = A.dragonSeg(.022, .02, k, i === 1 || i === 6, 40 + i), cd = itemCard(it);
    const g = new THREE.Group(); g.add(cd.mesh); root.add(g); segs.push({ g, d: .03 + i * SP, h: it.h });
  }
  const tail = itemCard(A.dragonTail(.03, .014)); const tailG = new THREE.Group(); tailG.add(tail.mesh); root.add(tailG);
  const TAIL_D = .03 + NSEG * SP + .004;
  // 纸翼挂在第 1 节
  const wit = A.dragonWing(.026, .02), wingN = itemCard(wit), wingF = itemCard(wit);
  const wingNG = new THREE.Group(), wingFG = new THREE.Group(); wingNG.add(wingN.mesh); wingFG.add(wingF.mesh);
  wingNG.position.set(0, .004, .0015); wingFG.position.set(.002, .004, -.0015); segs[1].g.add(wingNG, wingFG);
  return { root, headG, segs, tailG, TAIL_D, wingNG, wingFG,
    pose(p) { const k = JSON.stringify(p, (kk, v) => typeof v === 'number' ? Math.round(v * 20) / 20 : v); if (k === key) return; key = k; A.drawDragonHead(hc.getContext('2d'), p); head.t.needsUpdate = true; },
    headPoint(v = new THREE.Vector3()) { return v.set(.036, 0, 0).applyMatrix4(headG.matrixWorld); },
    mouth(v = new THREE.Vector3()) { return v.set(.04, -.002, 0).applyMatrix4(headG.matrixWorld); },
  };
}

// 头部轨迹（stage 坐标），预采样成弧长表
export function makePath(keys, t0, t1, dt = 1 / 240) {
  const f = track(keys), n = Math.ceil((t1 - t0) / dt) + 1, P = new Float64Array(n * 3), S = new Float64Array(n);
  // 轨迹前面接一段垂直向下的"地下"直线，保证身体在页面下也有历史位置
  for (let i = 0; i < n; i++) { const v = f(t0 + i * dt); P[i * 3] = v[0]; P[i * 3 + 1] = v[1]; P[i * 3 + 2] = v[2]; if (i) S[i] = S[i - 1] + Math.hypot(P[i * 3] - P[i * 3 - 3], P[i * 3 + 1] - P[i * 3 - 2], P[i * 3 + 2] - P[i * 3 - 1]); }
  const sAt = t => { const u = clamp((t - t0) / dt, 0, n - 1), i = Math.floor(u), fr = u - i; return i >= n - 1 ? S[n - 1] : lerp(S[i], S[i + 1], fr); };
  const at = (s, out = new THREE.Vector3()) => {
    if (s <= 0) { out.set(P[0], P[1] + s, P[2]); return out; }      // 再往前：沿 −y 延伸
    let lo = 0, hi = n - 1; if (s >= S[hi]) return out.set(P[hi * 3], P[hi * 3 + 1], P[hi * 3 + 2]);
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= s) lo = m; else hi = m; }
    const fr = (s - S[lo]) / Math.max(1e-9, S[hi] - S[lo]);
    return out.set(lerp(P[lo * 3], P[hi * 3], fr), lerp(P[lo * 3 + 1], P[hi * 3 + 1], fr), lerp(P[lo * 3 + 2], P[hi * 3 + 2], fr));
  };
  return { sAt, at, len: S[n - 1] };
}

const UP = new THREE.Vector3(0, 1, 0), tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), M = new THREE.Matrix4();
// 卡片朝向：x = 前进方向；法线在"物理朝向"(T×up) 与"朝向镜头"之间混合；保证画面不倒置
export function orient(obj, pos, T, camLocal, wCam = .7, roll = 0) {
  T = T.clone().normalize();
  const c = camLocal.clone().sub(pos).normalize(); const nc = c.sub(T.clone().multiplyScalar(c.dot(T)));
  let np = tmpA.copy(T).cross(UP);
  if (np.length() < .25) np.lerp(nc.clone().normalize(), 1 - np.length() / .25);
  np.normalize(); if (nc.lengthSq() > 1e-6) { nc.normalize(); if (np.dot(nc) < 0) np.negate(); np.lerp(nc, wCam).normalize(); }
  let y = tmpB.copy(np).cross(T).normalize();
  if (y.dot(UP) < -.05) { np.negate(); y.negate(); }
  if (roll) { const q = new THREE.Quaternion().setFromAxisAngle(T, roll); y.applyQuaternion(q); np.applyQuaternion(q); }
  M.makeBasis(T, y, np); obj.position.copy(pos); obj.quaternion.setFromRotationMatrix(M);
}
