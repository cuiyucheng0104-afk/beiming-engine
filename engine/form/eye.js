// 北冥引擎 · 眼睛骨架：眼珠 + 上下两片眼睑的眨眼、注视，以及给眼珠着色器的"眼窝坐标"量（高光方向、眼睑边缘平面）。
// 一只眼 e = { side: ±1, group 眼窝（定位、不转）, ball 眼珠, lidU / lidL 上下眼睑（绕局部 X 转）, frame? }
//   frame = { catch1: Vector4, catch2: Vector4, lidU: Vector3, lidL: Vector3 } 是眼珠材质的 uniform 值，poseEyes 直接写进去
//   autoBlink(ts, period, offset) → 闭合度 0 睁 … 1 闭：每个周期开头半秒眨一下（一拍三的四个停帧）
//   poseEyes(eyes, b, look, root, { lidU: [睁, 闭], lidL: [睁, 闭], yaw, pitch, catches })
//       眼睑按闭合度 b 转；look（世界坐标）给了就让眼珠转向它（偏航 / 俯仰限幅）；
//       catches = [[x, y, z, cos 半径], [...]]（眼窝坐标的两个高光方向），或 (e, 看向的局部方向 | null) => 同样的数组
//   pickEye(eyes, target, ref)：ref = 参考点 Vector3（取近的那只）/ 1（+Z 侧）/ -1（-Z 侧，默认）→ 该眼世界坐标写进 target
//   mountEyes({ point, normal, x, ph, inset, gaze: [gx, gy], parent, build(side, socket) → { ball, lidU, lidL, mat, frame? } })
//       在 profileBody 式的体表 (x, ±ph) 两侧各挖一个眼窝：沿法线往里 inset，局部 +Z = 法线偏 gaze，+X 水平；
//       build 往眼窝里装眼珠和眼睑（材质归着色那一层），返回两只眼（+Z 侧在前）
//   lidShells(r, ws, hs) → [上半球壳, 下半球壳]（眼睑，绕局部 X 转开合）
//   eyeFrame(u) → frame：从眼珠材质的 uniform（uCatch1 / uCatch2 / uLidU / uLidL）取值对象
import * as THREE from 'three';
import { clamp, lerp, TAU } from '../core/math.js';

export function autoBlink(ts, period, offset) {
  const l = ((ts - offset) % period + period) % period;
  return l < 0.125 ? 0.6 : l < 0.25 ? 1 : l < 0.375 ? 0.55 : l < 0.5 ? 0.15 : 0;
}

const UP = new THREE.Vector3(0, 1, 0);
const _inv = new THREE.Matrix4(), _tw = new THREE.Vector3(), _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler();

export function poseEyes(eyes, b, look, root, { lidU, lidL, yaw = 0.35, pitch = 0.28, catches = null }) {
  for (const e of eyes) {
    e.lidU.rotation.x = lerp(lidU[0], lidU[1], b);
    e.lidL.rotation.x = lerp(lidL[0], lidL[1], b);
    e.ball.quaternion.identity();
    let dir = null;
    if (look) {
      root.updateWorldMatrix(true, false); e.group.updateWorldMatrix(false, false);
      _tw.copy(look).applyMatrix4(_inv.copy(e.group.matrixWorld).invert()).normalize();
      const ya = clamp(Math.atan2(_tw.x, _tw.z), -yaw, yaw), pa = clamp(Math.asin(clamp(_tw.y, -1, 1)), -pitch, pitch);
      e.ball.quaternion.setFromEuler(_e.set(-pa, ya, 0, 'YXZ'));
      dir = _tw;
    }
    if (!e.frame) continue;
    _q.copy(e.ball.quaternion).invert();
    const cs = typeof catches === 'function' ? catches(e, dir) : catches;
    _v.set(cs[0][0], cs[0][1], cs[0][2]).normalize().applyQuaternion(_q); e.frame.catch1.set(_v.x, _v.y, _v.z, cs[0][3]);
    _v.set(cs[1][0], cs[1][1], cs[1][2]).normalize().applyQuaternion(_q); e.frame.catch2.set(_v.x, _v.y, _v.z, cs[1][3]);
    const aU = e.lidU.rotation.x, aL = e.lidL.rotation.x;
    e.frame.lidU.set(0, Math.cos(aU), Math.sin(aU)).applyQuaternion(_q);
    e.frame.lidL.set(0, -Math.cos(aL), -Math.sin(aL)).applyQuaternion(_q);
  }
}

export function pickEye(eyes, target = new THREE.Vector3(), ref = -1) {
  let e = eyes.find(x => x.side === -1);
  if (ref && ref.isVector3) { const a = eyes[0].group.getWorldPosition(new THREE.Vector3()), b2 = eyes[1].group.getWorldPosition(new THREE.Vector3()); e = a.distanceTo(ref) < b2.distanceTo(ref) ? eyes[0] : eyes[1]; }
  else if (ref === 1) e = eyes.find(x => x.side === 1);
  return e.group.getWorldPosition(target);
}

export function mountEyes({ point, normal, x, ph, inset, gaze, parent, build }) {
  return [1, -1].map(side => {
    const ph0 = side > 0 ? ph : Math.PI - ph;
    const sp = point(x, ph0), n = normal(x, ph0);
    const zA = n.clone().add(new THREE.Vector3(gaze[0], gaze[1], 0)).normalize(), xA = new THREE.Vector3().crossVectors(UP, zA).normalize(), yA = new THREE.Vector3().crossVectors(zA, xA);
    const group = new THREE.Group();
    group.position.copy(sp).addScaledVector(n, -inset);
    group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xA, yA, zA));
    const e = { side, group, surf: sp, n, ...build(side, group) };
    parent.add(group);
    return e;
  });
}

export const lidShells = (r, ws, hs) => [new THREE.SphereGeometry(r, ws, hs, 0, TAU, 0, Math.PI / 2), new THREE.SphereGeometry(r, ws, hs, 0, TAU, Math.PI / 2, Math.PI / 2)];

export const eyeFrame = u => ({ catch1: u.uCatch1.value, catch2: u.uCatch2.value, lidU: u.uLidU.value, lidL: u.uLidL.value });
