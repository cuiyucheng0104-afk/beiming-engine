// 茶杯翻倒 + 水：水全部由半透明蓝色圆板砖拼成，按 12 fps 每张"画"重摆一次（不是粒子、不是渐变）
import * as THREE from 'three';
import { PLATE, roundGeo, brickGeo } from './bricks.js';
import { B, HIT, q, qa } from './timeline.js';
import { CUP } from './set.js';
import { clamp, seg, ei, eo, hash, mulberry } from '/core/lib.js';

export const WATER_Y = .15;     // 水面以下的"浮"高度（零件半浸在水里）
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(1, 1, 1), _p = new THREE.Vector3(), _e = new THREE.Euler();

export function makeWater(scene, cup) {
  // —— 茶杯 ——
  const dir = new THREE.Vector3(-CUP.x, 0, -CUP.z).normalize();          // 朝小屋翻倒（-x, +z）
  const axis = new THREE.Vector3(dir.z, 0, -dir.x);                      // 绕这个轴 +θ = 杯口朝 dir 倒下
  const pivot = new THREE.Group(); pivot.position.set(CUP.x + dir.x * cup.rb, 0, CUP.z + dir.z * cup.rb); scene.add(pivot);
  const inner = new THREE.Group(); inner.position.set(-dir.x * cup.rb, 0, -dir.z * cup.rb); pivot.add(inner);
  cup.mesh.position.y = cup.y0; cup.mesh.rotation.y = Math.atan2(dir.x, dir.z) + Math.PI / 2; inner.add(cup.mesh);   // 杯把朝侧面
  const alpha = Math.atan2(cup.rr - cup.rb, cup.h), TH_LIE = Math.PI / 2 - alpha;
  const waterMat = new THREE.MeshPhysicalMaterial({ color: '#9ad6ff', transmission: .9, thickness: 1.2, roughness: .05, ior: 1.33, clearcoat: 1, clearcoatRoughness: .05, transparent: true, opacity: .9, envMapIntensity: 1.2, attenuationColor: '#3d8fd6', attenuationDistance: 6 });
  const surf = new THREE.Mesh(new THREE.CylinderGeometry(cup.rr * .9, cup.rr * .88, .3, 40), waterMat); surf.position.y = cup.h * .78; inner.add(surf);
  const tB = B(HIT.bump), tW = B(HIT.wobble), tT = B(HIT.tip), tL = B(HIT.cupLand);
  const ANC = [B(HIT.bump), B(HIT.wobble), B(HIT.tip), B(HIT.cupLand)];
  function cupAngle(t) {   // 杯子倾角（12 fps 锚定步进，翻倒按重力加速）
    t = qa(t, ANC);
    if (t < tB) return 0;
    if (t < tT) {   // 两下晃：先向前、回来、再大一点
      const u = (t - tB) / (tT - tB);
      return .11 * Math.sin(u * Math.PI * 2) * Math.exp(-u * .3) * (u < .5 ? 1 : 1.4) + seg(t, tW, tT) * .06;
    }
    if (t < tL) { const u = (t - tT) / (tL - tT); return .06 + ei(u) * (TH_LIE - .06); }
    const d = t - tL; return TH_LIE - .09 * Math.exp(-d * 7) * Math.abs(Math.sin(d * 18));   // 落桌后小弹一下
  }
  // 杯口中心（倒下后）—— 水从这里涌出
  const mouth = new THREE.Vector3(CUP.x, 0, CUP.z).addScaledVector(dir, cup.rb + Math.sin(TH_LIE) * cup.h * .9); mouth.y = 1;

  // —— 水洼形状：符号距离场（几个圆 + 一条胶囊 + 噪声边） ——
  const blobs = [[mouth.x, mouth.z, 7.5], [2, 0, 13], [-12, 4, 12], [-24, 3, 10], [-32, 6, 7], [6, -6, 9], [-4, 12, 8]];
  const sdf = (x, z) => {
    let d = Infinity; for (const [bx, bz, r] of blobs) d = Math.min(d, Math.hypot(x - bx, z - bz) - r);
    return d + (hash(Math.floor(x * .5) * 13.1 + Math.floor(z * .5) * 7.7) - .5) * 1.4 + Math.sin(x * .31 + z * .17) * 1.1;
  };
  const tFront = B(HIT.wave), vel = mouth.distanceTo(new THREE.Vector3(0, 1, -2)) / (tFront - tL);   // 前锋恰好在 b12 撞到后墙
  const arrive = (x, z) => tL + Math.hypot(x - mouth.x, z - mouth.z) / vel * (1 + Math.max(0, Math.hypot(x - mouth.x, z - mouth.z) - 14) * .02);
  // 网格摆放：2×2 圆板为主，边缘补 1×1；少量第二层（水面起伏）
  const R = mulberry(5), big = [], small = [];
  for (let x = -44; x <= 24; x += 1.75) for (let z = -18; z <= 24; z += 1.6) {
    const jx = x + (R() - .5) * .5 + ((Math.round(z / 1.6) & 1) ? .87 : 0), jz = z + (R() - .5) * .4, d = sdf(jx, jz);
    if (d < -1.2) big.push({ x: jx, z: jz, a: arrive(jx, jz), s: R(), up: R() < .14 });
    else if (d < .4) for (let k = 0; k < 3; k++) { const sx = jx + (R() - .5) * 1.6, sz = jz + (R() - .5) * 1.6; if (sdf(sx, sz) < .2) small.push({ x: sx, z: sz, a: arrive(sx, sz), s: R(), up: false }); }
  }
  const mkInst = (geo, n) => { const m = new THREE.InstancedMesh(geo, waterMat, n); m.castShadow = false; m.receiveShadow = true; m.frustumCulled = false; scene.add(m); return m; };
  const bigM = mkInst(roundGeo(1, PLATE), big.length + 8), smallM = mkInst(roundGeo(.5, PLATE), small.length + 120);
  // 倒出的水流：沿抛物线飞出的半透明圆板
  const pour = [...Array(110)].map((_, i) => ({ t0: tL - .12 + hash(i * 3.3) * 1.25, sp: 9 + hash(i * 5.1) * 9, side: (hash(i * 7.9) - .5) * 1.4, up: 2 + hash(i * 2.2) * 5 }));
  const G = 260;
  // 一滴水：从杯沿落下（b17 落到水面）
  const tDrip = B(HIT.drip), dripFrom = mouth.clone().add(new THREE.Vector3(0, 4.6, 0)).addScaledVector(dir, -1.2);

  function placeSet(M, list, t, bob) {
    let n = 0; const st = Math.floor(q(t) * 12);
    for (const p of list) {
      if (t < p.a) continue;
      const u = clamp((t - p.a) / .17);   // 前锋两帧滑进来
      const k = st * 31 + (p.s * 1000 | 0), wob = (hash(k) - .5) * .12, wob2 = (hash(k + 7) - .5) * .12;
      const back = (1 - u) * 1.6;
      _p.set(p.x + wob - dir.x * back, (p.up ? PLATE * .8 : 0) - .02 + (hash(k + 3) - .5) * .03 * bob, p.z + wob2 - dir.z * back);
      _e.set((hash(k + 1) - .5) * .05, p.s * 6, (hash(k + 2) - .5) * .05); _q.setFromEuler(_e);
      M.setMatrixAt(n++, _m.compose(_p, _q, _s));
    }
    return n;
  }

  function update(t) {
    const a = cupAngle(t); pivot.quaternion.setFromAxisAngle(axis, a);
    surf.visible = t < tL - .05; surf.scale.setScalar(1 - seg(q(t), tT, tL) * .5);
    const tq = q(t);
    let nb = placeSet(bigM, big, tq, 1), ns = placeSet(smallM, small, tq, 1);
    // 水流
    for (const p of pour) {
      const lt = tq - p.t0; if (lt < 0 || lt > .5) continue;
      const pos = mouth.clone().addScaledVector(dir, p.sp * lt).add(new THREE.Vector3(axis.x * p.side * lt * 6, p.up * lt - .5 * G * lt * lt + 1.2, axis.z * p.side * lt * 6));
      if (pos.y < .05) continue;
      _e.set(lt * 9, p.side * 5, lt * 7); _q.setFromEuler(_e);
      smallM.setMatrixAt(ns++, _m.compose(pos, _q, _s));
    }
    // 水滴（锚定在 b17 那一帧落水）
    { const tq = qa(t, [tDrip]);
    if (tq >= tDrip - .5 && tq < tDrip) { const u = (tDrip - tq) / .5; _p.copy(dripFrom); _p.y = .3 + (dripFrom.y - .3) * u * u; _e.set(0, 0, 0); _q.setFromEuler(_e); smallM.setMatrixAt(ns++, _m.compose(_p, _q, new THREE.Vector3(.55, .7, .55))); }
    if (tq >= tDrip && tq < tDrip + .34) {   // 溅起的小圈：四块小圆板向外弹
      const u = (tq - tDrip) / .34;
      for (let k = 0; k < 4; k++) { const an = k * Math.PI / 2 + .4; _p.set(dripFrom.x + Math.cos(an) * u * 1.6, .3 + Math.sin(u * Math.PI) * .9, dripFrom.z + Math.sin(an) * u * 1.6); _e.set(0, 0, 0); _q.setFromEuler(_e); smallM.setMatrixAt(ns++, _m.compose(_p, _q, new THREE.Vector3(.4, .5, .4))); }
    } }
    bigM.count = nb; smallM.count = ns; bigM.instanceMatrix.needsUpdate = smallM.instanceMatrix.needsUpdate = true;
  }
  return { update, mouth, dir, sdf, arrive, cupAngle, smallM, bigM, splashMat: waterMat, dripAt: dripFrom };
}

// 船桨/跳船溅起的水花：一圈半透明小圆板抛起
export function makeSplash(scene, mat) {
  const M = new THREE.InstancedMesh(roundGeo(.5, PLATE), mat, 64); M.frustumCulled = false; scene.add(M);
  function update(t, list) {   // list = [{t0, x, z, n, r}]
    let n = 0;
    for (const s of list) {
      const lt = (t < s.t0 ? t : s.t0 + Math.floor((t - s.t0) * 12 + 1e-6) / 12) - s.t0; if (lt < 0 || lt > .5) continue;
      for (let k = 0; k < s.n; k++) {
        const an = k / s.n * Math.PI * 2 + s.t0, sp = s.r * (1 + hash(k + s.t0) * .6);
        _p.set(s.x + Math.cos(an) * sp * lt * 3, .2 + (5 + hash(k * 3 + s.t0) * 4) * lt - 30 * lt * lt, s.z + Math.sin(an) * sp * lt * 3);
        if (_p.y < 0) continue;
        _e.set(lt * 8 + k, k, lt * 5); _q.setFromEuler(_e); M.setMatrixAt(n++, _m.compose(_p, _q, new THREE.Vector3(.7, .7, .7)));
      }
    }
    M.count = n; M.instanceMatrix.needsUpdate = true;
  }
  return { update };
}
