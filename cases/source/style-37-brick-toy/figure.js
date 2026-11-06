// 积木小人：完全由积木搭成（1×1 砖作腿、2×1 砖作躯干、圆棒作手臂、1×1 圆砖作头、圆板作帽子）
// 腿绕髋、手臂绕肩、头可转可点；姿势用插值混合，不在 if 里跳变
import * as THREE from 'three';
import { COL, BRICK, PLATE, brick, plate, mesh, roundGeo, plastic } from './bricks.js';

export const HIP = PLATE + BRICK;            // 1.6
export const SHOULDER = HIP + PLATE + BRICK;  // 3.2
export const HEAD_Y = SHOULDER + PLATE;       // 3.6
export const TOPY = HEAD_Y + BRICK + .5;      // ≈5.3

export function makeFigure() {
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body);
  const legs = [-.5, .5].map(x => {
    const g = new THREE.Group(); g.position.set(x, HIP, 0); body.add(g);
    const l = brick(1, 1, COL.blue); l.position.y = -HIP + PLATE; g.add(l);
    const f = plate(1, 1, COL.dgray, { tile: true }); f.position.set(0, -HIP, .12); g.add(f);
    return g;
  });
  const hip = plate(2, 1, COL.blue); hip.position.y = HIP; body.add(hip);
  const torso = new THREE.Group(); torso.position.y = HIP + PLATE; body.add(torso);
  const tb = brick(2, 1, COL.orange, { tile: true }); torso.add(tb);
  // 背带：两条深蓝细条 + 一枚小纽扣（只是印刷感的细节）
  for (const dx of [-.55, .55]) { const s = new THREE.Mesh(new THREE.BoxGeometry(.2, 1.15, .04), plastic(COL.blue)); s.position.set(dx, .6, .51); torso.add(s); }
  const sh = plate(2, 1, COL.lgray); sh.position.y = BRICK; torso.add(sh);
  const arms = [-1.28, 1.28].map(x => {
    const g = new THREE.Group(); g.position.set(x, BRICK + .15, 0); torso.add(g);
    const up = new THREE.Mesh(new THREE.CylinderGeometry(.27, .27, 1.05, 24), plastic(COL.orange)); up.position.y = -.5; g.add(up);
    const lo = new THREE.Mesh(new THREE.CylinderGeometry(.27, .27, .8, 24), plastic(COL.orange)); lo.position.y = -1.35; g.add(lo);
    const hand = new THREE.Mesh(new THREE.CylinderGeometry(.3, .3, .32, 24), plastic(COL.yellow)); hand.position.y = -1.9; g.add(hand);
    const tip = new THREE.Group(); tip.position.y = -1.95; g.add(tip);
    return { g, hand: tip };
  });
  const head = new THREE.Group(); head.position.set(0, HEAD_Y - HIP - PLATE, 0); torso.add(head);
  const hb = mesh(roundGeo(.5, BRICK), COL.white); hb.scale.set(1.18, 1, 1.18); head.add(hb);
  const eyeMat = new THREE.MeshStandardMaterial({ color: '#141414', roughness: .3 });
  const eyes = [-.2, .2].map(ex => { const e = new THREE.Mesh(new THREE.SphereGeometry(.085, 16, 12), eyeMat); e.position.set(ex, .68, .57); e.scale.z = .5; head.add(e); return e; });
  const brow = [-.2, .2].map(ex => { const b = new THREE.Mesh(new THREE.BoxGeometry(.2, .05, .04), eyeMat); b.position.set(ex, .9, .58); head.add(b); return b; });
  const mouth = new THREE.Mesh(new THREE.TorusGeometry(.12, .025, 6, 16, Math.PI), eyeMat); mouth.rotation.z = Math.PI; mouth.position.set(0, .45, .585); head.add(mouth);
  const cap = mesh(roundGeo(.55, PLATE * 1.5), COL.green); cap.position.y = BRICK + .02; head.add(cap);
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(.42, .42, .12, 24, 1, false, -Math.PI / 2, Math.PI), plastic(COL.green)); brim.position.set(0, BRICK + .08, .45); head.add(brim);
  root.traverse(o => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });

  // 姿势：armL/armR = [前后 x, 侧举 z]；legs = [左, 右] 前后摆；sit 0..1；brow −1 担心 … +1 开心
  function pose(p) {
    root.position.set(p.x, p.y ?? 0, p.z); root.rotation.set(p.rx ?? 0, p.ry ?? 0, p.rz ?? 0);
    const sit = p.sit ?? 0;
    body.position.y = (p.bob ?? 0) - sit * (HIP - .45);
    body.rotation.x = p.lean ?? 0;
    legs[0].rotation.x = (p.legs?.[0] ?? 0) - sit * 1.5; legs[1].rotation.x = (p.legs?.[1] ?? 0) - sit * 1.5;
    const aL = p.armL ?? [0, .05], aR = p.armR ?? [0, .05];
    arms[0].g.rotation.set(aL[0], 0, -aL[1]); arms[1].g.rotation.set(aR[0], 0, aR[1]);
    head.rotation.set(p.nod ?? 0, p.look ?? 0, p.tilt ?? 0);
    const bl = p.blink ? .15 : 1; eyes.forEach(e => e.scale.set(1, bl, .5));
    const br = p.brow ?? 0; brow[0].rotation.z = br * .4; brow[1].rotation.z = -br * .4; brow.forEach(b => b.position.y = .9 + Math.abs(br) * .04);
    mouth.scale.set(1, Math.max(.35, Math.abs(p.mouth ?? 1)), 1); mouth.rotation.z = (p.mouth ?? 1) < 0 ? 0 : Math.PI;
  }
  return { root, body, arms, head, legs, pose };
}

export function walkPose(phi, amp = .55) {
  const s = Math.sin(phi);
  return { legs: [s * amp, -s * amp], armL: [-s * amp * .7, .06], armR: [s * amp * .7, .06], bob: Math.abs(Math.cos(phi)) * .14 };
}
// 两个姿势按 u 混合（数值字段线性插值，数组逐项）
export function mixPose(a, b, u) {
  const o = { ...a };
  for (const k of Object.keys(b)) {
    const x = a[k], y = b[k];
    if (Array.isArray(y)) o[k] = y.map((v, i) => (x?.[i] ?? 0) + (v - (x?.[i] ?? 0)) * u);
    else if (typeof y === 'number') o[k] = (x ?? 0) + (y - (x ?? 0)) * u;
    else o[k] = u < .5 ? x : y;
  }
  return o;
}
