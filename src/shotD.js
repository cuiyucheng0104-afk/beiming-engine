// src/shotD.js — 镜头 D「离航 · 引渡」10.00–15.00：渡船偏离既定航线驶向吴淞口开阔水道，鲲在云雾间平行引渡
// 银蓝冷色调，镜头沿 -Z 缓推 75 m 并从 yaw -4° 平滑左摇至 +8°（俯仰 -0.8°）；
// 浦东天际线与倒影移到画面左侧（cx ≈ 340）向后隐退，渡船以 ~5.8 m/s 转出横渡航道，鲲在中景一拍二伴游。
// 每帧将鲲眼（kun.eyeWorld）与海道导航贝塞尔线（NAV）投影到设计尺寸 W×H 的 hudState。
import * as THREE from 'three';
import { createKun } from './kun.js';
import { setToonGlobals } from './toon.js';
import { createFerry, createWake, lightStreak } from './ferry.js';
import { clamp, lerp, seg, ss, ss5, DEG } from '../engine/core/math.js';
import { hold, heldTime, hashi } from '../engine/core/clock.js';
import { plate, plateCopy, tileRepeat } from '../engine/stage/plates.js';
import { aimCamera, placeOnScreen, placeStrip, screenToPlane, project, projectAll } from '../engine/stage/camera.js';
import { headingQuat, integratePath, bezierPoints } from '../engine/stage/motion.js';
import { wireOutlines } from '../engine/stage/outline.js';

export const D_START = 10.0;
export const D_DUR = 5.0;

export function buildShotD({ W, H, tex, q }) {
  const P = (k, d) => (q && q.has(k) ? parseFloat(q.get(k)) : d);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2('#8BA4D0', P('dfog', 0.00022));
  const cam = new THREE.PerspectiveCamera(22, W / H, 5, 40000);

  const CAM0 = new THREE.Vector3(0, 28, 0);
  const PITCH = P('dpitch', -0.8) * DEG;
  const Y0 = P('dy0', -4) * DEG, Y1 = P('dy1', 8) * DEG;
  const PUSH = 75;

  // 参考机位：起始（前景角云、渡船定位）、中点（广角底板防摇镜穿帮）、正前（左移天际线）
  const cam0 = cam.clone(); aimCamera(cam0, CAM0, Y0, PITCH);
  const camRef = cam.clone(); aimCamera(camRef, CAM0, 0, PITCH);
  const camMid = cam.clone(); aimCamera(camMid, CAM0, (Y0 + Y1) * 0.5, PITCH);

  // ── 底板分层（深度递增配 renderOrder 递增） ──
  const L = {};
  const put = (name, mesh, refCam, cx, cy, wpx, D, hpx) => {
    L[name] = mesh;
    scene.add(mesh);
    placeOnScreen(mesh, refCam, W, H, cx, cy, wpx, D, hpx);
    return mesh;
  };
  put('sky', plate(tex.sky_dawn, 0), camMid, W * 0.5, -290, 3400, 20000);
  put('cloudsBack', plate(tex.clouds_back, 1), camMid, W * 0.5, 200, 3400, 6000);
  put('pudong', plate(tex.skyline_pudong, 3, { opacity: 0.9 }), camRef, 340, 320, 1150, 2000);
  put('river', plate(tex.river, 4), camMid, W * 0.5, 482 + 750, 3600, 1450, 1500);

  const reflTex = plateCopy(tex.skyline_pudong_reflect);
  const refl = plate(reflTex, 4.5, { opacity: 0.84 });
  {
    const rh = 1150 / (tex.skyline_pudong_reflect.image.width / tex.skyline_pudong_reflect.image.height);
    put('refl', refl, camRef, 340, 492 + rh / 2, 1150, 1449);
  }

  const mistTex = plateCopy(tex.mist_low, { wrap: true });
  put('mist', plate(mistTex, 5, { opacity: 0.68 }), camMid, W * 0.5, 492, 3600, 1300, 290);
  mistTex.repeat.set(tileRepeat(tex.mist_low, 3600, 290), 1);

  const mist2Tex = plateCopy(tex.mist_low, { wrap: true });
  put('mist2', plate(mist2Tex, 6.5, { opacity: 0.42 }), camMid, W * 0.5, 820, 3400, 460, 260);
  mist2Tex.repeat.set(tileRepeat(tex.mist_low, 3400, 260), 1);

  put('corner', plate(tex.clouds_front_b, 7, { opacity: 0.92 }), cam0, 1620, 45, 1150, 420);

  // ── 主光：晨曦低角冷暖交界逆光 ──
  const key = new THREE.DirectionalLight('#ffd3b0', 1);
  const KEY_DIR = new THREE.Vector3(-0.72, 0.12, -0.68).normalize();
  scene.add(key, key.target);

  // ── 鲲（中景 LOD 0.72，一拍二觉醒节律） ──
  const kun = createKun({ lod: 0.72, wisps: false, blinkPeriod: 4, blinkOffset: 1.2 });
  wireOutlines(kun.group, { alpha: 0.85 });
  kun.group.rotation.order = 'YXZ';
  scene.add(kun.group);

  const kunP0 = new THREE.Vector3(280, 50, -618);
  const kunDir = t => {
    const s = ss(seg(t, D_START, D_START + D_DUR));
    return new THREE.Vector3(lerp(-0.92, -0.75, s), lerp(0.03, 0.05, s), lerp(-0.39, -0.66, s)).normalize();
  };
  const kunSpeed = t => lerp(34, 38, ss(seg(t, D_START, D_START + D_DUR)));
  const kunPosAt = integratePath(kunP0, kunDir, kunSpeed, { t0: D_START, steps: 130, fps: 24 });

  // ── 渡船：从横渡航道转向吴淞口开阔水道，~5.8 m/s，浪涌起伏一拍二 ──
  const ferry = createFerry();
  ferry.group.rotation.order = 'YXZ';
  scene.add(ferry.group);

  const wake = createWake();
  wake.renderOrder = 5.2;
  scene.add(wake);

  const streaks = [
    { m: lightStreak('#FF4A4A', 1.4), lamp: ferry.lights.red, w: 2.2, h: 15 },
    { m: lightStreak('#4AFF95', 1.3), lamp: ferry.lights.green, w: 2.2, h: 15 },
    { m: lightStreak('#FFC46B', 0.9), lamp: ferry.lights.white, w: 3.0, h: 22 },
  ];
  for (const s of streaks) { s.m.renderOrder = 5.3; scene.add(s.m); }

  const FERRY0 = screenToPlane(cam0, W, H, 820, 680);
  const FERRY_V = 5.8;
  const ferryYaw = t => lerp(2.75, 2.02, ss(seg(t, D_START + 0.2, D_START + 4.4)));
  const ferryDir = t => {
    const y = ferryYaw(t);
    return new THREE.Vector3(Math.cos(y), 0, -Math.sin(y));
  };
  const ferryPosAt = integratePath(FERRY0, ferryDir, () => FERRY_V, { t0: D_START, steps: 130, fps: 24 });

  // ── HUD 投影状态：鲲眼 + 船首至海平线导航线 ──
  const hudState = { eye: null, nav: [], head: { yaw: 0, pitch: 0 } };
  const _v = new THREE.Vector3(), _e = new THREE.Vector3(), _r = new THREE.Vector3();
  const _bow = new THREE.Vector3(), _tail = new THREE.Vector3(), _p0 = new THREE.Vector3(), _p1 = new THREE.Vector3();
  const _p2 = new THREE.Vector3(-160, 0, -1100), _p3 = new THREE.Vector3(-320, 0, -2400);
  const _kq = new THREE.Quaternion(), _yAxis = new THREE.Vector3(0, 1, 0);

  function update(t, f) {
    const u = clamp((t - D_START) / D_DUR);
    const push = PUSH * (u * (1.14 - 0.14 * u));
    const yaw = lerp(Y0, Y1, ss5(u));
    aimCamera(cam, _v.set(CAM0.x, CAM0.y, CAM0.z - push), yaw, PITCH);

    // 雾、水：24 fps 连续流动；倒影一拍二微抖
    mistTex.offset.x = (t * 0.012) % 1;
    mist2Tex.offset.x = (0.42 - t * 0.018) % 1;
    reflTex.offset.x = (hashi(hold(f, 2)) - 0.5) * 0.0016;
    L.refl.material.opacity = 0.8 + 0.06 * hashi(hold(f, 2) + 77);

    // 鲲：一拍二（ts = heldTime(f, 2)）
    const ts = heldTime(f, 2);
    const kd = kunDir(ts);
    headingQuat(kd, 0.07 * Math.sin((ts - D_START) * 0.65), _kq);
    kun.group.quaternion.copy(_kq);
    kunPosAt(ts, kun.group.position);
    kun.group.updateMatrixWorld(true);
    kun.setPose(ts);
    key.position.copy(KEY_DIR); key.target.position.set(0, 0, 0);
    kun.fitShadow(key, { size: 2048 });

    // 渡船：24 fps 平滑前进与转向，一拍二随浪起伏
    const fq = heldTime(f, 2);
    const fyaw = ferryYaw(t);
    const fdir = ferryDir(t);
    ferryPosAt(t, ferry.group.position);
    ferry.group.position.y = 0.25 * Math.sin(fq * 2.6);
    ferry.group.rotation.set(0.014 * Math.sin(fq * 2.1 + 1), fyaw, 0.012 * Math.sin(fq * 1.7));
    ferry.group.updateMatrixWorld(true);

    // 尾迹：沿船首到船尾后方摆放，并推到船体最深处后方防止遮挡船身
    _bow.set(ferry.length * 0.5, 0, 0).applyAxisAngle(_yAxis, fyaw).add(ferry.group.position);
    _tail.set(-ferry.length * 4.5, 0, 0).applyAxisAngle(_yAxis, fyaw).add(ferry.group.position);
    const pa = project(cam, W, H, _bow), pb = project(cam, W, H, _tail);
    const d0 = (pa.z + pb.z) / 2, d1 = Math.max(pa.z, pb.z) + 2;
    placeStrip(wake, cam, W, H, _bow, _tail, 28, 1.5);
    if (d0 > 1 && d1 > d0) {
      const s = d1 / d0;
      wake.position.sub(cam.position).multiplyScalar(s).add(cam.position);
      wake.scale.multiplyScalar(s);
    }
    wake.material.uniforms.uT.value = t;

    // 航行灯水面竖向倒影（一拍二抖动）
    for (const s of streaks) {
      s.lamp.getWorldPosition(_v);
      s.m.position.set(_v.x, -s.h * 0.45, _v.z);
      s.m.quaternion.copy(cam.quaternion);
      s.m.scale.set(s.w, s.h, 1);
      s.m.material.uniforms.uSeed.value = hold(f, 2) % 97;
    }

    // HUD：鲲眼与海道导航线投影（设计稿 W×H 像素坐标）
    kun.eyeWorld(_e, cam.position);
    const pe = project(cam, W, H, _e);
    _r.set(1, 0, 0).applyQuaternion(cam.quaternion).multiplyScalar(kun.eyeRadius * 0.85).add(_e);
    const pr = project(cam, W, H, _r);
    hudState.eye = pe.z > 1 && pe.x > -200 && pe.x < W + 200 && pe.y > -200 && pe.y < H + 200
      ? { x: pe.x, y: pe.y, r: Math.hypot(pr.x - pe.x, pr.y - pe.y) }
      : null;

    _p0.copy(_bow).addScaledVector(fdir, 8); _p0.y = 0;
    _p1.copy(_p0).addScaledVector(fdir, 180); _p1.y = 0;
    hudState.nav = projectAll(cam, W, H, bezierPoints(_p0, _p1, _p2, _p3, 36), 2);
    hudState.head = { yaw: 0, pitch: 0 };

    setToonGlobals({ inkTime: hold(f, 2), fillGain: 0.45, exposure: 1.0, fillDir: [0.08, -1, 0.1], keyDir: KEY_DIR.toArray(), skyGain: 1.15 });
  }

  const look = t => ({
    t,
    outline: { width: 2.4, near: 200, far: 1800, farScale: 0.6, wobble: 1.1, tint: 0.18 },
    kuwahara: { radius: 3, farRadius: 6.5, farStart: 500, farEnd: 1600, strength: 1 },
    bloom: { strength: 0.72, threshold: 0.65, radius: 0.7, knee: 0.25 },
    grade: { exposure: 1.0, warmth: 0.02, lift: [0.01, 0.028, 0.065], gamma: 0.96, gain: 1.02, saturation: 1.05, shoulder: 0.9 },
    paper: { strength: 0.13 }, vignette: 0.22, grain: 0.65, fog: null,
  });

  return { scene, camera: cam, update, look, hudState, kun, ferry };
}
