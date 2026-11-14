// src/shotG.js — 镜头 G「扶摇 · 北冥」24.50–30.00：鲲鹏扶摇直上东海朝阳高空，片名「北冥」落笔
// 高潮帧节奏（一拍一）：身体与翅膀皆传连续时间 kt = t - 24.5 + 1.2，与 24 fps 镜头完全同步丝滑；
// 构图：24.5–27.5s 鲲鹏从画中下方（D ≈ 340m）振翅爬升至右上苍穹（D ≈ 650m -> 1100m），镜头缓缓左摇上仰（yaw 8°->20°, pitch 14°->24°->16°）；
// 左侧中部天空（x: 0.08–0.52, y: 0.25–0.70）保持开阔明亮，留给 27.4–30.0s 毛笔片名「北冥」；海鸟群在下方的海面上盘旋。
import * as THREE from 'three';
import { createKun } from './kun_peng.js';
import { setToonGlobals } from './toon.js';
import { drawBirds } from './birds.js';
import { lerp, seg, ss, ss5, DEG } from '../engine/core/math.js';
import { hold } from '../engine/core/clock.js';
import { plateCopy, cropPlate, glowSprite, canvasLayer, cutoutPlane } from '../engine/stage/plates.js';
import { domePlate } from '../engine/stage/dome.js';
import { aimCamera, dirOf, fillScreen } from '../engine/stage/camera.js';
import { headingQuat, integratePath } from '../engine/stage/motion.js';

export const G_START = 24.5;

export function buildShotG({ W, H, tex, q }) {
  const P = (k, d) => (q && q.has(k) ? parseFloat(q.get(k)) : d);
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2('#DFA8B8', P('fog', 0.00026));
  const cam = new THREE.PerspectiveCamera(52, W / H, 1, 60000);
  const BOW = new THREE.Vector3(0, 6, 0);

  // ── 机位：yaw 8° -> 20°，pitch 14° -> 24° -> 16°，平缓舒展 ──
  function camPose(t) {
    const u = t - G_START;
    const p1 = ss5(seg(t, 24.5, 27.5));
    const p2 = ss5(seg(t, 27.5, 30.0));
    const yaw = lerp(P('gy0', 8), P('gy1', 20), ss5(seg(t, 24.5, 29.2)));
    const pitch = lerp(P('gp0', 14), P('gp1', 24), p1) + lerp(0, P('gp2', 16) - P('gp1', 24), p2);
    const sy = 0.20 * Math.sin(t * 0.89 + 0.3) + 0.07 * Math.sin(t * 1.71);
    const sp = 0.16 * Math.sin(t * 0.73 + 1.1) + 0.05 * Math.sin(t * 1.53);
    const sr = 0.12 * Math.sin(t * 0.49 + 0.7);
    const pos = BOW.clone().add(new THREE.Vector3(-3.0 * u, 0.22 * Math.sin(t * 1.2) + 0.06 * Math.sin(t * 2.05), -3.5 * u));
    return { yaw: (yaw + sy) * DEG, pitch: (pitch + sp) * DEG, roll: sr * DEG, pos };
  }

  // ── 东海朝阳高空穹顶底板 ──
  const domes = new THREE.Group();
  scene.add(domes);
  const sky = domePlate(tex.sky_tall, 0, 30000, 6 * DEG, 156 * DEG, -6 * DEG, 68 * DEG);
  domes.add(sky);
  // 极高空（>65°）以 sky_zenith 衔接兜底
  const skyTop = domePlate(tex.sky_zenith, 0, 30000, 6 * DEG, 156 * DEG, 67 * DEG, 89 * DEG);
  domes.add(skyTop);

  const world = new THREE.Group();
  scene.add(world);
  world.position.copy(BOW);
  const cloudsBack = domePlate(tex.clouds_back, 1, 5500, 6 * DEG, 156 * DEG, -2 * DEG, 22 * DEG);
  world.add(cloudsBack);
  const river = domePlate(tex.river, 1.5, 3200, 10 * DEG, 160 * DEG, -26 * DEG, 0.45 * DEG);
  world.add(river);
  const mistTex = plateCopy(tex.mist_low, { wrap: true });
  mistTex.repeat.x = 2.6;
  const mist = domePlate(mistTex, 2.5, 2900, 10 * DEG, 165 * DEG, -2.0 * DEG, 6.5 * DEG, { opacity: 0.48 });
  world.add(mist);

  // ── 旭日金色辉光（海平线升腾，映亮天海，不遮左中文字区） ──
  const DAWN_YAW = 24 * DEG, DAWN_PITCH = 2.8 * DEG;
  const sun = glowSprite('#FFD29E', { order: 2.6, amt: 1.2, core: 1.75, squash: 1.35 });
  domes.add(sun);
  {
    const d = dirOf(DAWN_YAW, DAWN_PITCH).multiplyScalar(20000);
    sun.position.copy(d);
    sun.lookAt(0, 0, 0);
    sun.scale.set(9200, 9200, 1);
  }

  // ── 鲲鹏将化（高潮一拍一：身体与翅膀用同一连续时钟 kt = t - 24.5 + 1.2；绝不调用 wireOutlines） ──
  const kun = createKun({ lod: 1, flapPeriod: 2.4, flapPhase: 0.2 });
  scene.add(kun.group);

  // 轨迹：24.5s 在画中下方（D ≈ 340m）振翅爬升，27.5s 跃升至 D ≈ 650m，28.8–30.0s 展翼斜掠入右上苍穹（D ≈ 860–1060m），始终保持 3/4 侧仰翼姿不背对镜头
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
  const H0 = V3(0.68, 0.34, -0.65);
  const H1 = V3(0.06, 0.76, -0.65);
  const H2 = V3(0.73, 0.16, -0.66);
  const heading = ts => {
    const s1 = ss(seg(ts, 24.6, 26.8));
    const s2 = ss(seg(ts, 27.0, 29.7));
    return H0.clone().lerp(H1, s1).lerp(H2, s2).normalize();
  };
  const rollAt = ts => lerp(0.45, 0.85, ss(seg(ts, 24.6, 28.8)));
  const speed = ts => lerp(115, 165, ss(seg(ts, 24.5, 27.5))) + 46 * ss(seg(ts, 27.5, 30.0));
  const c0 = camPose(G_START);
  const P0 = dirOf(21 * DEG, 5 * DEG).multiplyScalar(340).add(c0.pos);
  const posAt = integratePath(P0, heading, speed, { t0: G_START, steps: 140, fps: 24 });
  const kq = new THREE.Quaternion();
  const _kp = new THREE.Vector3();
  function kunPose(t) {
    headingQuat(heading(t), rollAt(t), kq);
    kun.group.quaternion.copy(kq);
    kun.group.position.copy(posAt(t, _kp));
  }

  // ── 主光：旭日金色低角逆光 ──
  const key = new THREE.DirectionalLight('#ffd3b0', 1);
  const KEY_DIR = dirOf(DAWN_YAW, 12 * DEG);
  scene.add(key, key.target);

  // ── 漂浮云片：背景云放在 1500–2100m（远于鲲鹏 1100m），前景低云放下方边角，保持左中天空（x:0.08–0.52, y:0.25–0.70）清朗 ──
  const puffs = [
    [tex.clouds_back, [0.60, 0.16, 0.35, 0.65], 1650, -8, 14, 720, -24, 0.85, true, [1.06, 0.98, 0.94]],
    [tex.clouds_back, [0.02, 0.16, 0.32, 0.65], 1850, 28, 3, 860, -22, 0.82, false, [1.08, 0.99, 0.94]],
    [tex.clouds_front_b, [0.42, 0.06, 0.48, 0.56], 1500, -22, 24, 680, -20, 0.78, false, [1.05, 0.97, 0.95]],
    [tex.clouds_front_a, [0.08, 0.36, 0.46, 0.54], 125, -24, 1, 56, -11, 0.70, true, [1.06, 0.97, 0.94]],
  ].map(([m, rect, D, yaw, pit, w, v, op, fl, tint]) => {
    const p = cropPlate(m, rect, { order: D < 250 ? 5.5 : 3, opacity: op, soft: 0.5, flip: fl, tint });
    scene.add(p);
    return { p, w, v, base: dirOf(yaw * DEG, pit * DEG).multiplyScalar(D).add(c0.pos) };
  });

  // ── 海鸟群：2D 画布（drawBirds），在下方海面上盘旋，避开左中片名区 ──
  const { ctx: bctx, tex: btex } = canvasLayer(W, H);
  const birds = cutoutPlane(btex, { order: 9, cut: 0.45 });
  scene.add(birds);

  const _v = new THREE.Vector3();
  function update(t, f) {
    const c = camPose(t);
    aimCamera(cam, c.pos, c.yaw, c.pitch, c.roll);
    domes.position.copy(c.pos);

    mistTex.offset.x = (0.35 - (t - G_START) * 0.01) % 1;

    // 高潮 24 fps 一拍一：未量化的连续时间同时驱动位置、身体与羽翼
    const kt = t - 24.5 + 1.2;
    kunPose(t);
    kun.group.updateMatrixWorld(true);
    kun.setPose(kt, { wingT: kt });

    key.position.copy(KEY_DIR);
    key.target.position.set(0, 0, 0);
    kun.fitShadow(key, { size: 4096 });

    for (const pf of puffs) {
      _v.copy(pf.base);
      _v.x += pf.v * (t - G_START);
      pf.p.position.copy(_v);
      pf.p.quaternion.copy(cam.quaternion);
      pf.p.scale.set(pf.w, pf.w / pf.p.userData.aspect, 1);
    }

    // 海鸟在下方的海面上盘旋（y >= 0.72 H），不遮挡「北冥」片名（x: 0.08–0.52, y: 0.25–0.70）
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, W, H);
    bctx.save();
    bctx.translate(W * 0.36, H * 0.60);
    bctx.scale(0.46, 0.46);
    const nb = drawBirds(bctx, (t - 24.5) * 0.6 + 0.5, W, H);
    bctx.restore();
    birds.visible = nb > 0;
    btex.needsUpdate = true;
    fillScreen(birds, cam, W, H, 90);

    const u = ss(seg(t, G_START, 30.0));
    sun.material.uniforms.amt.value = lerp(1.15, 1.95, ss(seg(t, G_START, 29.0)));

    setToonGlobals({
      inkTime: hold(f, 2),
      fillGain: 0.85,
      exposure: lerp(1.06, 1.14, u),
      fillDir: [0.08, -1, 0.1],
      keyDir: KEY_DIR.toArray(),
      skyGain: 1.05,
    });
  }

  const look = t => {
    const u = ss(seg(t, G_START, 30.0));
    return {
      t,
      outline: { width: 2.5, near: 100, far: 1400, farScale: 0.5, wobble: 1.1, tint: 0.15 },
      kuwahara: { radius: 3.5, farRadius: 6.5, farStart: 1200, farEnd: 3200, strength: 1 },
      bloom: { strength: lerp(0.75, 1.10, u), threshold: 0.62, radius: 0.8, knee: 0.25 },
      grade: {
        exposure: lerp(1.08, 1.22, u),
        warmth: lerp(0.16, 0.24, u),
        lift: [lerp(0.035, 0.055, u), lerp(0.025, 0.042, u), lerp(0.045, 0.042, u)],
        gamma: 0.96,
        gain: 1.03,
        saturation: 1.14,
        shoulder: 0.9,
      },
      paper: { strength: 0.12 },
      vignette: lerp(0.22, 0.14, u),
      grain: 0.65,
      fog: null,
    };
  };

  return { scene, camera: cam, update, look, kun };
}
