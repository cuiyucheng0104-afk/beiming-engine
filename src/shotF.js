// src/shotF.js — 镜头 F「破晓 · 鲲鹏将化」19.00–24.50：东海破晓，鲲鹏破云掠过船头
// 穹顶底板（sky_tall、clouds_back、river、mist_low）+ 地平线金色旭日辉光 + 前景云墙（19.0–20.2s）拉开 + 漂浮云片；
// 鲲鹏（kun_peng.js，LOD 1）一拍三身体、一拍二羽翼，从右前方破云俯掠船头（D ≈ 320m -> 210m -> 380m），
// 依次展现石青/石绿/朱砂矿物色、鹤羽长翼、火焰背腹鳍与十六道凤尾翎；不调 wireOutlines（bindPeng 已设好描边）。
import * as THREE from 'three';
import { createKun } from './kun_peng.js';
import { setToonGlobals } from './toon.js';
import { lerp, seg, ss, ss5, eo, DEG } from '../engine/core/math.js';
import { hold, heldTime } from '../engine/core/clock.js';
import { plate, plateCopy, cropPlate, glowSprite } from '../engine/stage/plates.js';
import { domePlate } from '../engine/stage/dome.js';
import { aimCamera, dirOf, placeOnScreen } from '../engine/stage/camera.js';
import { headingQuat, integratePath } from '../engine/stage/motion.js';

export const F_START = 19.0;

export function buildShotF({ W, H, tex, q }) {
  const P = (k, d) => (q && q.has(k) ? parseFloat(q.get(k)) : d);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2('#C99EC4', P('fog', 0.00042));
  const cam = new THREE.PerspectiveCamera(54, W / H, 1, 60000);
  const BOW = new THREE.Vector3(0, 6, 0);

  // ── 机位：船头低角度广角仰拍，随鲲鹏从左前方破云掠过向右平滑跟摇，下方始终保留东海金色海平线 ──
  function camPose(t) {
    const u = t - F_START;
    const pan = ss5(seg(t, 19.2, 24.4));
    const yaw = lerp(P('fy0', 14), P('fy1', -16), pan);
    const pitch = lerp(P('fp0', 5.0), P('fp1', 9.5), ss5(seg(t, 19.4, 21.8)))
      - lerp(0, P('fpDrop', 2.5), ss5(seg(t, 22.0, 24.5)));
    const sy = 0.24 * Math.sin(t * 0.97 + 0.6) + 0.09 * Math.sin(t * 1.87);
    const sp = 0.18 * Math.sin(t * 0.79 + 1.3) + 0.06 * Math.sin(t * 1.63);
    const sr = 0.14 * Math.sin(t * 0.55 + 0.9);
    const pos = BOW.clone().add(new THREE.Vector3(1.5 * u, 0.22 * Math.sin(t * 1.35) + 0.07 * Math.sin(t * 2.1), -2.5 * u));
    return { yaw: (yaw + sy) * DEG, pitch: (pitch + sp) * DEG, roll: sr * DEG, pos };
  }

  // ── 东海破晓穹顶底板（无城市天际线） ──
  const domes = new THREE.Group();
  scene.add(domes);
  const sky = domePlate(tex.sky_tall, 0, 30000, -2 * DEG, 156 * DEG, -4 * DEG, 75 * DEG);
  domes.add(sky);

  const world = new THREE.Group();
  scene.add(world);
  world.position.copy(BOW);
  const cloudsBack = domePlate(tex.clouds_back, 1, 5500, -2 * DEG, 156 * DEG, -2 * DEG, 32 * DEG);
  world.add(cloudsBack);
  const river = domePlate(tex.river, 1.5, 3200, 4 * DEG, 160 * DEG, -28 * DEG, 0.45 * DEG);
  world.add(river);
  const mistTex = plateCopy(tex.mist_low, { wrap: true });
  mistTex.repeat.x = 2.6;
  const mist = domePlate(mistTex, 2.5, 2900, 2 * DEG, 165 * DEG, -2.0 * DEG, 6.2 * DEG, { opacity: 0.50 });
  world.add(mist);

  // ── 地平线金色旭日辉光（破晓海天交界处亮起） ──
  const DAWN_YAW = 4 * DEG, DAWN_PITCH = 2.0 * DEG;
  const sun = glowSprite('#FFC08A', { order: 2.6, amt: 0.95, core: 1.75, squash: 1.45 });
  domes.add(sun);
  {
    const d = dirOf(DAWN_YAW, DAWN_PITCH).multiplyScalar(20000);
    sun.position.copy(d);
    sun.lookAt(0, 0, 0);
    sun.scale.set(7600, 7600, 1);
  }

  // ── 前景破云云墙（19.0–20.2s 拉开，随后缓缓散去） ──
  const c0 = camPose(F_START);
  const cam0 = cam.clone();
  aimCamera(cam0, c0.pos, c0.yaw, c0.pitch, 0);
  const wallA = plate(tex.clouds_front_a, 6);
  const wallB = plate(tex.clouds_front_b, 7);
  scene.add(wallA, wallB);
  const WALL_D = P('walld', 65);
  function placeWalls(t) {
    const open = eo(seg(t, 19.0, 20.2));
    const drift = 85 * Math.max(0, t - 20.2) + 125 * Math.max(0, t - 20.5) ** 1.4;
    const fade = 1 - ss(seg(t, 20.2, 21.6));
    wallA.material.opacity = fade;
    wallB.material.opacity = fade;
    wallA.visible = wallB.visible = fade > 0.01;
    const aIn = 1040 - 940 * open - drift;
    const bIn = 880 + 940 * open + drift;
    placeOnScreen(wallA, cam0, W, H, aIn - 0.523 * 2700 + 1350, 440, 2700, WALL_D);
    placeOnScreen(wallB, cam0, W, H, bIn - 0.363 * 3000 + 1500, 450, 3000, WALL_D + 6);
  }

  // ── 鲲鹏将化（bindPeng 已内置描边标记，绝不调用 wireOutlines） ──
  const kun = createKun({ lod: 1, flapPeriod: 2.7, flapPhase: 0.05 });
  scene.add(kun.group);

  // 运动轨迹：19.0s 头眼在云隙后露面（D ≈ 316m）-> 21.5s 倾身掠过船头展示羽翼与背鳞（D ≈ 206m）-> 24.4s 展翼远去入东海破晓天际（D ≈ 385m，头至十六道凤尾翎全入画）
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
  const H0 = V3(0.98, 0.04, 0.08);
  const H1 = V3(0.84, 0.11, -0.53);
  const H2 = V3(0.98, 0.13, -0.15);
  const heading = ts => {
    const s1 = ss(seg(ts, 19.8, 22.0));
    const s2 = ss(seg(ts, 22.0, 24.2));
    return H0.clone().lerp(H1, s1).lerp(H2, s2).normalize();
  };
  const rollAt = ts => lerp(0.45, 0.56, ss(seg(ts, 19.6, 23.6)));
  const speed = ts => lerp(82, 102, ss(seg(ts, 19.5, 22.2))) + 14 * ss(seg(ts, 22.4, 24.5));
  const P0 = new THREE.Vector3(-262, 26, -195);
  const posAt = integratePath(P0, heading, speed, { t0: F_START, steps: 140, fps: 24 });
  const kq = new THREE.Quaternion();
  const _kp = new THREE.Vector3();
  function kunPose(ts) {
    headingQuat(heading(ts), rollAt(ts), kq);
    kun.group.quaternion.copy(kq);
    kun.group.position.copy(posAt(ts, _kp));
  }

  // ── 主光：破晓地平线低角度金暖逆光 ──
  const key = new THREE.DirectionalLight('#ffd3b0', 1);
  const KEY_DIR = dirOf(DAWN_YAW, 12 * DEG);
  scene.add(key, key.target);

  // ── 漂浮云片（前后景分层视差，24 fps 平滑漂移） ──
  const puffs = [
    [tex.clouds_back, [0.02, 0.16, 0.32, 0.65], 620, 22, 22, 340, -14, 0.90, false, [1.04, 0.98, 0.96]],
    [tex.clouds_back, [0.60, 0.16, 0.35, 0.65], 680, -18, 18, 380, -16, 0.88, true, [1.05, 0.97, 0.95]],
    [tex.clouds_front_a, [0.08, 0.36, 0.46, 0.54], 560, 4, 28, 300, -12, 0.85, true, [1.03, 0.99, 0.98]],
    [tex.clouds_front_b, [0.42, 0.06, 0.48, 0.56], 92, -26, 26, 46, -9, 0.82, false, [1.04, 0.96, 0.96]],
    [tex.clouds_back, [0.28, 0.18, 0.36, 0.58], 84, 26, 5, 42, -8, 0.78, true, [1.05, 0.98, 0.94]],
  ].map(([m, rect, D, yaw, pit, w, v, op, fl, tint]) => {
    const p = cropPlate(m, rect, { order: D < 180 ? 5.5 : 3, opacity: op, soft: 0.5, flip: fl, tint });
    scene.add(p);
    return { p, w, v, base: dirOf(yaw * DEG, pit * DEG).multiplyScalar(D).add(c0.pos) };
  });

  const _v = new THREE.Vector3();
  function update(t, f) {
    const c = camPose(t);
    aimCamera(cam, c.pos, c.yaw, c.pitch, c.roll);
    domes.position.copy(c.pos);

    placeWalls(t);
    mistTex.offset.x = (0.15 - (t - F_START) * 0.009) % 1;

    // 鲲鹏节拍：身体一拍三，鹤羽翅膀一拍二
    const ts = heldTime(f, 3);
    const tw = heldTime(f, 2);
    kunPose(ts);
    kun.group.updateMatrixWorld(true);
    kun.setPose(ts, { wingT: tw, look: cam.position });

    key.position.copy(KEY_DIR);
    key.target.position.set(0, 0, 0);
    kun.fitShadow(key, { size: 4096 });

    for (const pf of puffs) {
      _v.copy(pf.base);
      _v.x += pf.v * (t - F_START);
      pf.p.position.copy(_v);
      pf.p.quaternion.copy(cam.quaternion);
      pf.p.scale.set(pf.w, pf.w / pf.p.userData.aspect, 1);
    }

    const u = ss(seg(t, F_START, 24.5));
    sun.material.uniforms.amt.value = lerp(0.90, 1.85, u);

    setToonGlobals({
      inkTime: hold(f, 2),
      fillGain: 0.85,
      exposure: 1.05,
      fillDir: [0.08, -1, 0.1],
      keyDir: KEY_DIR.toArray(),
      skyGain: 1.05,
    });
  }

  const look = t => {
    const u = ss(seg(t, F_START, 24.5));
    return {
      t,
      outline: { width: 2.5, near: 90, far: 900, farScale: 0.55, wobble: 1.15, tint: 0.15 },
      kuwahara: { radius: 3.5, farRadius: 6.5, farStart: 800, farEnd: 2800, strength: 1 },
      bloom: { strength: 0.85, threshold: 0.65, radius: 0.75, knee: 0.25 },
      grade: {
        exposure: lerp(0.95, 1.12, u),
        warmth: 0.18,
        lift: [lerp(0.025, 0.04, u), lerp(0.015, 0.03, u), lerp(0.045, 0.038, u)],
        gamma: 0.96,
        gain: 1.02,
        saturation: 1.12,
        shoulder: 0.9,
      },
      paper: { strength: 0.13 },
      vignette: lerp(0.24, 0.18, u),
      grain: 0.65,
      fog: null,
    };
  };

  return { scene, camera: cam, update, look, kun };
}
