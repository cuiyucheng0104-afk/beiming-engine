// src/shotA.js — 镜头 A「雾江」0.00–3.00：破晓前蓝调时刻的黄浦江大远景
// 远 → 近：天空 → 云堤（后层云）→【鲲】→ 前层云 → 陆家嘴天际线 → 江面 / 倒影 → 低雾 → 渡船 + 尾迹 → 外滩近岸 → 近雾 → 角上近云 → 鸽群
// 所有 2D 底板是 3D 场景里的面片，按「t=0 机位下的屏幕位置 + 深度」摆放；镜头沿视线缓推（非变焦），视差由真实透视产生。
// 鲲：远景 LOD，夹在前后两层云之间，只露背脊海草与尾鳍（一拍三）；鸽群一拍二；镜头、雾、水 24 fps 平滑。
import * as THREE from 'three';
import { createKun } from './kun.js';
import { setToonGlobals } from './toon.js';
import { createFerry, createWake, lightStreak } from './ferry.js';
import { drawBirds } from './birds.js';
import { clamp, ss } from '../engine/core/math.js';
import { hold, heldTime, hashi } from '../engine/core/clock.js';
import { plate, plateCopy, tileRepeat, canvasLayer, cutoutPlane, glowSprite } from '../engine/stage/plates.js';
import { DEG, aimCamera, placeOnScreen, fillScreen, placeStrip, screenToWorld, screenToPlane } from '../engine/stage/camera.js';
import { wireOutlines } from '../engine/stage/outline.js';

export function buildShotA({ W, H, tex }) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2('#A99BD9', 0.000195);   // 只作用于 3D 物体（鲲、渡船）；底板自带空气透视
  const cam = new THREE.PerspectiveCamera(16, W / H, 5, 40000);
  const CAM0 = new THREE.Vector3(0, 33, 0), PITCH = 1.4 * DEG, PUSH = 46;   // 推镜 46 m（外滩近岸放大约 10%）
  aimCamera(cam, CAM0, 0, PITCH);

  // ── 底板（按 t=0 机位摆） ──
  const L = {};
  const put = (name, mesh, cx, cy, wpx, D, hpx) => { L[name] = mesh; scene.add(mesh); placeOnScreen(mesh, cam, W, H, cx, cy, wpx, D, hpx); return mesh; };
  put('sky', plate(tex.sky_dawn, 0), W * 0.5, 150, 2350, 20000);
  put('cloudsBack', plate(tex.clouds_back, 1), 1170, 250, 2050, 6000);
  // 前层云（夹住鲲）：大块积云在左、雾丝拖向右——鲲一头扎进云团，只露背脊海草和翘起的尾鳍
  put('cloudsFront', plate(tex.clouds_front_a, 2, { opacity: 0.98 }), 1235, 575, 1500, 2300);
  // 鲲腹下一条薄雾带（在鲲前面），让它像泡在云海里
  const veilTex = plateCopy(tex.mist_low, { wrap: true });
  put('veil', plate(veilTex, 1.8, { opacity: 0.62 }), 1250, 300, 1500, 2500, 190);
  veilTex.repeat.set(tileRepeat(tex.mist_low, 1500, 190), 1);
  put('pudong', plate(tex.skyline_pudong, 3), 1000, -20 + 400, 1600, 1500);
  // 江面：顶边 = 远处水天线，压在天际线水岸线（y=620）上方一点，用雾盖住接缝
  put('river', plate(tex.river, 4), W * 0.5, 600 + 575, 2400, 1450, 1150);
  const reflTex = plateCopy(tex.skyline_pudong_reflect);
  const refl = plate(reflTex, 4.5, { opacity: 0.92 });
  { const rh = 1600 / (tex.skyline_pudong_reflect.image.width / tex.skyline_pudong_reflect.image.height); put('refl', refl, 1000, 620 + rh / 2, 1600, 1449); }
  const mistTex = plateCopy(tex.mist_low, { wrap: true });
  put('mist', plate(mistTex, 5, { opacity: 0.72 }), W * 0.5, 604, 2700, 1300, 330);
  mistTex.repeat.set(tileRepeat(tex.mist_low, 2700, 330), 1);
  put('bund', plate(tex.skyline_bund, 6), 1500 / 2 - 400, 1078 - 0.85 * 500 + 250, 1500, 520);
  const mist2Tex = plateCopy(tex.mist_low, { wrap: true });
  put('mist2', plate(mist2Tex, 6.5, { opacity: 0.5 }), W * 0.5, 1000, 2600, 480, 260);
  mist2Tex.repeat.set(tileRepeat(tex.mist_low, 2600, 260), 1);
  put('corner', plate(tex.clouds_front_b, 7), 1930, 30, 1150, 420);

  // 地平线上的一点暖光（窗灯和晨光的 bloom 源之外，再给左侧辉光一点体积）
  const dawn = glowSprite('#FFB26B', { order: 0.5, amt: 0.22, core: 0.15, squash: 2.6 });
  scene.add(dawn); placeOnScreen(dawn, cam, W, H, W * 0.27, 600, 1500, 15000, 520);

  // ── 主光：破晓地平线低角度逆光（画左后方） ──
  const key = new THREE.DirectionalLight('#ffd3b0', 1);
  const KEY_DIR = new THREE.Vector3(-0.72, 0.12, -0.68).normalize();
  scene.add(key, key.target);

  // ── 鲲（远景 LOD），夹在两层云之间 ──
  const kun = createKun({ lod: 0.42, wisps: false, blinkPeriod: 4, blinkOffset: 1.5 });
  wireOutlines(kun.group, { alpha: 0.5 });
  kun.group.rotation.order = 'YXZ';
  scene.add(kun.group);
  const KUN_D = 2900;
  const kunP0 = screenToWorld(cam, W, H, 1180, 236, KUN_D);
  const KUN_V = new THREE.Vector3(-34, 10, 0);             // 向画左滑、略上浮（米/秒）

  // ── 渡船 + 尾迹 + 灯的倒影 ──
  const ferry = createFerry();
  scene.add(ferry.group);
  const wake = createWake();
  wake.renderOrder = 5.2;                                   // 透明物体按 renderOrder 画：尾迹要压在低雾（5）之上
  scene.add(wake);
  const streaks = [
    { m: lightStreak('#FF4A4A', 1.4), lamp: ferry.lights.red, w: 2.2, h: 15 },
    { m: lightStreak('#4AFF95', 1.3), lamp: ferry.lights.green, w: 2.2, h: 15 },
    { m: lightStreak('#FFC46B', 0.9), lamp: ferry.lights.white, w: 3.0, h: 22 },
  ];
  for (const s of streaks) { s.m.renderOrder = 5.3; scene.add(s.m); }
  // 渡船的水面位置：画面 (800, 742) 的视线与水面 y=0 的交点；船头朝向镜头左前方（两盏航行灯都看得见）
  const FERRY0 = screenToPlane(cam, W, H, 800, 742);
  const FERRY_YAW = Math.PI + 0.55;                         // 船头朝 -X 并偏向镜头（+Z）：航向 (cosψ, 0, -sinψ)
  const FERRY_V = 4.2;                                      // 米/秒

  // ── 鸽群：2D 画布 → 贴在相机前的面片 ──
  const { ctx: bctx, tex: btex } = canvasLayer(W, H);
  const birds = cutoutPlane(btex, { order: 9, cut: 0.45 });
  scene.add(birds);

  const _v = new THREE.Vector3(), _q = new THREE.Quaternion();
  function update(t, f) {
    const u = clamp(t / 3);
    const push = PUSH * (u * (1.18 - 0.18 * u));            // 几乎匀速的缓推，尾部略收
    aimCamera(cam, _v.set(CAM0.x - 4 * u, CAM0.y + 1.2 * u, CAM0.z - push), 0, PITCH);

    // 雾、水：24 fps 平滑
    mistTex.offset.x = (t * 0.011) % 1;
    mist2Tex.offset.x = (0.37 - t * 0.017) % 1;
    veilTex.offset.x = (0.6 + t * 0.02) % 1;
    reflTex.offset.x = (hashi(hold(f, 2)) - 0.5) * 0.0016;   // 倒影水波：一拍二横向抖 1–2 px
    L.refl.material.opacity = 0.86 + 0.06 * hashi(hold(f, 2) + 77);

    // 鲲：一拍三
    const ts = heldTime(f, 3);
    const k = clamp((ts - 1.1) / 1.9);
    kun.group.position.copy(kunP0).addScaledVector(KUN_V, ts - 1.2);
    kun.group.position.y += -55 + 55 * ss(k);               // 1.2 秒起从云海里慢慢浮上来（先只露背脊）
    kun.group.rotation.set(0.14, Math.PI - 0.05, -0.1 + 0.03 * ss(k));   // 背朝远处（海草成剪影边）、略低头，尾鳍翘出云
    kun.setPose(ts);
    key.position.copy(KEY_DIR); key.target.position.set(0, 0, 0);
    kun.fitShadow(key, { size: 2048 });

    // 渡船：缓慢驶向镜头左前方，船身随浪轻微起伏（一拍二）
    const fq = heldTime(f, 2);
    const fdir = _v.set(Math.cos(FERRY_YAW), 0, -Math.sin(FERRY_YAW));
    ferry.group.position.copy(FERRY0).addScaledVector(fdir, FERRY_V * t);
    ferry.group.position.y = 0.25 * Math.sin(fq * 2.6);
    ferry.group.rotation.set(0.012 * Math.sin(fq * 2.1 + 1), FERRY_YAW, 0.01 * Math.sin(fq * 1.7));
    // 尾迹：面朝镜头的画笔条，左端压在船头，向画右（船尾后方）拖出约 7 个船长
    {
      const bow = new THREE.Vector3(ferry.length / 2, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), FERRY_YAW).add(ferry.group.position);
      const tail = new THREE.Vector3(-ferry.length * 6.5, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), FERRY_YAW).add(ferry.group.position);
      placeStrip(wake, cam, W, H, bow, tail, 34, 1.5);
      wake.material.uniforms.uT.value = t;
    }
    // 灯的倒影：灯正下方水面上的竖条，面朝相机
    for (const s of streaks) {
      s.lamp.getWorldPosition(_v);
      const top = _v.clone(); top.y = 0;
      s.m.position.set(top.x, -s.h * 0.45, top.z);
      s.m.quaternion.copy(cam.quaternion);
      s.m.scale.set(s.w, s.h, 1);
      s.m.material.uniforms.uSeed.value = hold(f, 2) % 97;
    }

    // 鸽群
    bctx.setTransform(1, 0, 0, 1, 0, 0); bctx.clearRect(0, 0, W, H);
    const nb = drawBirds(bctx, t, W, H);
    birds.visible = nb > 0;
    btex.needsUpdate = true;
    fillScreen(birds, cam, W, H, 30);

    setToonGlobals({ inkTime: hold(f, 2), cityGain: 0.55, exposure: 1, cityDir: [0.08, -1, 0.1], keyDir: KEY_DIR.toArray(), skyGain: 1 });
  }

  const look = t => ({
    t,
    outline: { width: 2.3, near: 300, far: 3000, farScale: 0.6, wobble: 1.1, tint: 0.2 },
    kuwahara: { radius: 3, farRadius: 6.5, farStart: 700, farEnd: 2200, strength: 1 },
    bloom: { strength: 0.72, threshold: 0.66, radius: 0.7, knee: 0.25 },
    grade: { exposure: 1.0, warmth: 0.12, lift: [0.02, 0.012, 0.045], gamma: 0.96, gain: 1.02, saturation: 1.1, shoulder: 0.9 },
    paper: { strength: 0.14 }, vignette: 0.24, grain: 0.65, fog: null,
  });

  return { scene, camera: cam, update, look, kun, ferry };
}
