// src/shotC.js — 镜头 C「鲲现」5.00–10.00：第一视角（透过 AI 眼镜），从渡船甲板仰望云海和天际线
// 天空 / 云堤 / 天际线 / 低雾是以相机为心的穹顶面片（摇镜时不变形）；前景两堵云墙是相机前 110 m 的平面，5.0–5.6 拉开露出鲲眼；
// 鲲（近景 LOD 1）一拍三，从右向左、向上游过头顶，镜头 24 fps 平滑上摇、左摇，头部微晃 < 1°；
// 云片在鲲前后穿过；9.0–10.0 地平线第一缕日光整体提亮。
// 每帧把鲲眼和导航线投影成屏幕坐标交给 hud.js（hudState）。
import * as THREE from 'three';
import { createKun } from './kun.js';
import { setToonGlobals } from './toon.js';
import { plate, domePlate, cloudPuff, placeOnScreen, glowSprite, aimCamera, dirOf, project, wireOutlines, DEG, lerp, seg, ss, ss5, eo, clamp, hashi } from './scene.js';

export const C_START = 5.0;

export function buildShotC({ W, H, tex, q }) {
  const P = (k, d) => (q && q.has(k) ? parseFloat(q.get(k)) : d);   // 调试：URL 参数覆盖
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2('#B8A6DD', P('fog', 0.00085));
  const cam = new THREE.PerspectiveCamera(31, W / H, 1, 60000);
  const DECK = new THREE.Vector3(0, 6, 0);

  // 镜头时间表（yaw 左正、pitch 上正，度）
  const Y0 = P('y0', -3), P0 = P('p0', 23);           // 5.0–6.4 揭眼
  const Y1 = P('y1', 9), P1 = P('p1', 31);          // 8.6：上摇 + 左摇到位
  const Y2 = P('y2', 21), P2 = P('p2', 31);          // 10.0：继续轻轻左摇，略回落
  function camPose(t) {
    const a = ss5(seg(t, 6.35, 8.7));
    let yaw = lerp(Y0, Y1, a), pitch = lerp(P0, P1, a);
    // 5.0–6.4：几乎不动，只有很慢的漂移（盯着眼睛）
    yaw += 0.6 * seg(t, 5.0, 6.4); pitch += 0.4 * seg(t, 5.0, 6.4);
    // 头部微晃（< 1°，低频，不做手持抖动）
    const sy = 0.32 * Math.sin(t * 1.13 + 0.4) + 0.12 * Math.sin(t * 2.31 + 1.7);
    const sp = 0.22 * Math.sin(t * 0.87 + 1.1) + 0.08 * Math.sin(t * 1.93);
    const sr = 0.18 * Math.sin(t * 0.61 + 2.0);
    const pos = DECK.clone().add(new THREE.Vector3(-2.6 * (t - C_START), 0.18 * Math.sin(t * 1.4), -1.2 * (t - C_START)));   // 渡船缓缓前行 + 起伏
    return { yaw: (yaw + sy) * DEG, pitch: (pitch + sp) * DEG, roll: sr * DEG, pos, swayYaw: sy * DEG, swayPitch: sp * DEG };
  }

  // ── 穹顶底板（跟着相机位置，远处没有视差） ──
  const domes = new THREE.Group(); scene.add(domes);
  const sky = domePlate(tex.sky_tall, 0, 30000, 4 * DEG, 118 * DEG, -3 * DEG, 76 * DEG); domes.add(sky);
  const world = new THREE.Group(); scene.add(world);                 // 不跟相机：近一点的云堤 / 天际线有一点视差
  world.position.copy(DECK);
  const cloudsBack = domePlate(tex.clouds_back, 1, 5000, -6 * DEG, 126 * DEG, -7.5 * DEG, 34.5 * DEG); world.add(cloudsBack);
  const pudong = domePlate(tex.skyline_pudong, 2, 3000, -4 * DEG, 30 * DEG, -3 * DEG, 12 * DEG); world.add(pudong);
  const river = domePlate(tex.river, 1.5, 2600, 22 * DEG, 130 * DEG, -16 * DEG, 0.25 * DEG); world.add(river);
  const mistTex = tex.mist_low.clone(); mistTex.wrapS = THREE.RepeatWrapping; mistTex.repeat.x = 2.2; mistTex.needsUpdate = true;
  const mist = domePlate(mistTex, 2.5, 2400, 0, 150 * DEG, -2.2 * DEG, 8.5 * DEG, { opacity: 0.8 }); world.add(mist);

  // ── 晨光：地平线辉光（左下远处），片尾 9.0–10.0 涨起来 ──
  const DAWN_YAW = 30 * DEG, DAWN_PITCH = 1.5 * DEG;
  const sun = glowSprite('#FFC08A', { order: 2.6, amt: 0.0, core: 1.2, squash: 1.6 });   // 加色叠在云堤、低雾之上：光从云后透出来
  domes.add(sun);
  { const d = dirOf(DAWN_YAW, DAWN_PITCH).multiplyScalar(20000); sun.position.copy(d); sun.lookAt(0, 0, 0); sun.scale.set(9000, 9000, 1); }

  // ── 前景云墙（相机前 110 m 的平面，按 t=5.0 机位摆）──
  const c0 = camPose(C_START);
  const cam0 = cam.clone(); aimCamera(cam0, c0.pos, Y0 * DEG, P0 * DEG);
  const wallA = plate(tex.clouds_front_a, 6), wallB = plate(tex.clouds_front_b, 7);
  scene.add(wallA, wallB);
  const WALL_D = P('walld', 60);
  function placeWalls(t) {
    const open = eo(seg(t, 5.0, 5.62)), drift = 60 * Math.max(0, t - 5.62) + 140 * Math.max(0, t - 6.4) ** 1.5;
    const fade = 1 - ss(seg(t, 6.6, 7.8));                 // 拉开后的云墙慢慢散开
    wallA.material.opacity = fade; wallB.material.opacity = fade;
    wallA.visible = wallB.visible = fade > 0.01;
    // 合拢：a 的内侧实边（宽 0.523 处）在 x≈1100，b 的内侧实边（宽 0.363 处）在 x≈820，中间重叠
    const aIn = 1100 - 760 * open - drift, bIn = 820 + 800 * open + drift;
    placeOnScreen(wallA, cam0, W, H, aIn - 0.523 * 2700 + 1350, 430, 2700, WALL_D);
    placeOnScreen(wallB, cam0, W, H, bIn - 0.363 * 3000 + 1500, 440, 3000, WALL_D + 6);
  }

  // ── 鲲 ──
  const kun = createKun({ lod: 1, wisps: false, blinkPeriod: 4, blinkOffset: 2.375 });
  // 腹部城市暖光：仰拍时腹部法线只有约 0.8 朝下，把两档阈值放低，让腹沟一带被映成暖橙（只改本镜头的鲲）
  kun.group.traverse(o => { const u = o.material?.userData?.toon; if (!u || !o.name.match(/kun-(body|fin|flukes)/)) return;
    u.uCityStep.value = P('cs1', 0.38); u.uCityStep2.value = P('cs2', 0.72); u.uCityW1.value = 0.5; u.uCityAmt.value = P('ca', 1.0); });
  wireOutlines(kun.group, { alpha: 1, group: null });
  scene.add(kun.group);
  const eyeL = kun.eyes.find(e => e.side === -1).group.position.clone();   // -Z 侧的眼（朝镜头那侧）
  // 姿态随时间变化（一拍三取样）：揭眼时侧身滚转、用朝镜头一侧的眼睛看人；6.3 秒后滚回、抬头，向左上方游走，
  // 腹部转向镜头（腹沟、胸鳍、城市暖光），身体从头顶上空滑过。眼睛轨迹按速度 × 航向逐帧积分（确定性）。
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
  const H0 = V3(P('hx', -1), P('hy', 0.02), P('hz', 0.12)), H1 = V3(P('h1x', -0.85), P('h1y', 0.32), P('h1z', -0.42));
  const R0 = P('roll', -0.45), R1 = P('roll1', 0.5);
  const T_TURN0 = 6.3, T_TURN1 = P('tturn', 8.4);
  const V0 = P('v0', 4), V1 = P('v1', 80);
  const heading = ts => { const s = ss(seg(ts, T_TURN0, T_TURN1)); return H0.clone().lerp(H1, s).normalize(); };
  const rollAt = ts => lerp(R0, R1, ss(seg(ts, T_TURN0, T_TURN1 - 0.6)));
  const speed = ts => lerp(V0, V1, ss(seg(ts, 6.2, 8.0))) + P('vend', 70) * ss(seg(ts, 8.4, 10.0));   // 片尾加速远去
  const quatOf = (h, r, out = new THREE.Quaternion()) => {
    const x = h.clone(), y = new THREE.Vector3(0, 1, 0).addScaledVector(x, -x.y).normalize(), z = new THREE.Vector3().crossVectors(x, y);
    out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    return out.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), r));
  };
  // t=5.0 时眼睛在视线中央略偏右上、离相机 EYE_D 米
  const EYE_D = P('eyed', 130), EYE_YAW = P('eyeyaw', -4) * DEG, EYE_PITCH = P('eyepitch', 24) * DEG;
  const E0 = dirOf(EYE_YAW, EYE_PITCH).multiplyScalar(EYE_D).add(c0.pos);
  // 转身以身体后段为支点（PIV），这样头扭向远处时尾巴不会甩到镜头跟前；之后整条鲲沿新航向游走。
  const PIV = new THREE.Vector3(P('piv', -150), 0, 0);
  const kq = new THREE.Quaternion();
  quatOf(heading(C_START), rollAt(C_START), kq);
  const pivPath = [E0.clone().sub(eyeL.clone().sub(PIV).applyQuaternion(kq))];   // 每帧积分支点位置
  for (let k = 1; k <= 130; k++) { const ts = C_START + (k - 0.5) / 24; pivPath.push(pivPath[k - 1].clone().addScaledVector(heading(ts), speed(ts) / 24)); }
  const pivAt = (t, out = new THREE.Vector3()) => { const k = clamp((t - C_START) * 24, 0, 130), k0 = Math.floor(k), k1 = Math.min(130, k0 + 1); return out.copy(pivPath[k0]).lerp(pivPath[k1], k - k0); };
  const _pp = new THREE.Vector3();
  function kunPose(ts) {
    quatOf(heading(ts), rollAt(ts), kq);
    kun.group.quaternion.copy(kq);
    kun.group.position.copy(pivAt(ts, _pp)).sub(PIV.clone().applyQuaternion(kq));
  }

  // ── 主光：破晓地平线低角度逆光（画左下远处，在鲲身后） ──
  const key = new THREE.DirectionalLight('#ffd3b0', 1);
  const KEY_DIR = dirOf(DAWN_YAW, 7 * DEG);
  scene.add(key, key.target);

  // ── 云片：在鲲前后穿过（24 fps 平滑漂移） ──
  const puffs = [
    // [贴图, uv 矩形, 距离, yaw°, pitch°, 宽(米), 漂移(米/秒), 透明度, 翻转]
    [tex.clouds_back, [0.02, 0.18, 0.3, 0.62], 70, 24, 33, 34, -6, 0.95, false],
    [tex.clouds_front_b, [0.5, 0.05, 0.45, 0.5], 60, -22, 40, 30, -7, 0.9, true],
    [tex.clouds_back, [0.62, 0.2, 0.33, 0.6], 520, 18, 46, 260, -14, 0.92, false],
    [tex.clouds_front_a, [0.05, 0.45, 0.42, 0.5], 460, -8, 50, 220, -12, 0.85, true],
    [tex.clouds_back, [0.3, 0.25, 0.3, 0.55], 80, 6, 47, 30, -8, 0.9, true],
  ].map(([m, rect, D, yaw, pit, w, v, op, fl], i) => {
    const p = cloudPuff(m, rect, { order: D < 200 ? 5.5 : 3, opacity: op, soft: 0.5, flip: fl });
    scene.add(p);
    return { p, D, yaw: yaw * DEG, pit: pit * DEG, w, v, base: dirOf(yaw * DEG, pit * DEG).multiplyScalar(D).add(c0.pos) };
  });

  // ── 导航线（世界坐标）：前方江面 → 弧线升上天空 → 沿鲲游去的方向通向海平线的曙光 ──
  const NAV = (() => {
    const S = new THREE.Vector3(-6, 0, -42), C1 = new THREE.Vector3(-70, 150, -175), C2 = new THREE.Vector3(-420, 160, -640);
    const T = dirOf(DAWN_YAW + 2 * DEG, 2.5 * DEG).multiplyScalar(2600).add(DECK);
    const pts = [];
    for (let i = 0; i <= 40; i++) {
      const u = i / 40, a = (1 - u) ** 3, b = 3 * (1 - u) ** 2 * u, c = 3 * (1 - u) * u * u, d = u ** 3;
      pts.push(new THREE.Vector3().addScaledVector(S, a).addScaledVector(C1, b).addScaledVector(C2, c).addScaledVector(T, d));
    }
    return pts;
  })();

  const hudState = { eye: null, nav: [], head: { yaw: 0, pitch: 0 } };
  const _fq = new THREE.Quaternion(), _fx = new THREE.Vector3(1, 0, 0);
  const _e = new THREE.Vector3(), _r = new THREE.Vector3(), _v = new THREE.Vector3();

  // 跟拍：瞄准鲲身上一个沿身体往后滑的点（用连续、未量化的姿态 → 镜头 24 fps 平滑；鲲本身一拍三）
  const _aq = new THREE.Quaternion(), _ap = new THREE.Vector3(), _ad = new THREE.Vector3();
  function trackAim(t, pos) {
    quatOf(heading(t), rollAt(t), _aq);
    const g = pivAt(t, new THREE.Vector3()).sub(PIV.clone().applyQuaternion(_aq));
    const u = ss(seg(t, 6.3, 8.8)), u2 = ss(seg(t, 8.6, 10.2));
    const ax = lerp(lerp(214, P('ax1', 20), u), P('ax2', -90), u2), ay = lerp(-3, P('ay1', -20), u), az = lerp(-50, P('az1', 0), u);
    _ap.set(ax, ay, az).applyQuaternion(_aq).add(g);
    _ad.copy(_ap).sub(pos).normalize();
    return { yaw: Math.atan2(-_ad.x, -_ad.z), pitch: Math.asin(clamp(_ad.y, -1, 1)) };
  }
  function update(t, f) {
    const c = camPose(t);
    const w = ss(seg(t, 6.25, 7.1));
    if (w > 0) {
      const a = trackAim(t, c.pos);
      let dy = a.yaw - c.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const tk = P('tk', 0);
      c.yaw += dy * w * tk; c.pitch += (Math.min(a.pitch + P('poff', -2) * DEG, 52 * DEG) - c.pitch) * w * tk;
    }
    // 片尾：不再跟着鲲往上看，顺着它游去的方向缓缓下摇、左摇，看向海平线的曙光（鲲从画面上方离开，导航线的终点落在曙光里）
    const e = ss5(seg(t, P('e0', 8.35), 10.0));
    if (e > 0) { c.yaw = lerp(c.yaw, P('yend', 18) * DEG + c.swayYaw, e); c.pitch = lerp(c.pitch, P('pend', 10) * DEG + c.swayPitch, e); }
    aimCamera(cam, c.pos, c.yaw, c.pitch, c.roll);
    domes.position.copy(c.pos);

    placeWalls(t);
    mistTex.offset.x = (0.2 - t * 0.008) % 1;

    // 鲲：一拍三
    const ts = Math.floor(f / 3) * 3 / 24;
    kunPose(ts);
    kun.group.updateMatrixWorld(true);
    const lookAt = t < 7.2 ? cam.position : null;           // 揭眼阶段眼珠看镜头
    kun.setPose(ts, lookAt ? { look: lookAt } : {});
    // 鲲转身滚转后，远侧胸鳍会竖到背上像一块板：在它转到背后的过程中收进身体（只影响本镜头，那时它几乎不在画面里）
    { const fr = kun.fins.find(f => f.side === -1), k = ss(seg(ts, P('fin0', 7.1), P('fin1', 7.9)));
      if (fr) { const sc = 1 - 0.9 * k; fr.pivot.scale.setScalar(sc); fr.pivot.visible = sc > 0.12; } }
    key.position.copy(KEY_DIR); key.target.position.set(0, 0, 0);
    kun.fitShadow(key, { size: 4096 });

    // 云片漂移
    for (const pf of puffs) {
      _v.copy(pf.base); _v.x += pf.v * (t - C_START);
      pf.p.position.copy(_v);
      pf.p.quaternion.copy(cam.quaternion);
      pf.p.scale.set(pf.w, pf.w / pf.p.userData.aspect, 1);
    }

    // 片尾：地平线第一缕日光
    const sunUp = ss(seg(t, 8.9, 10.0));
    sun.material.uniforms.amt.value = 0.22 + 1.5 * sunUp;

    // HUD：鲲眼、导航线投影到屏幕
    kun.eyeWorld(_e, cam.position);
    const pe = project(cam, W, H, _e);
    _r.set(1, 0, 0).applyQuaternion(cam.quaternion).multiplyScalar(kun.eyeRadius * P('eyer', 0.85)).add(_e);
    const pr = project(cam, W, H, _r);
    hudState.eye = pe.z > 1 && pe.x > -200 && pe.x < W + 200 && pe.y > -200 && pe.y < H + 200 ? { x: pe.x, y: pe.y, r: Math.hypot(pr.x - pe.x, pr.y - pe.y) } : null;
    hudState.nav = [];
    for (const p of NAV) { const s = project(cam, W, H, p); if (s.z > 2) hudState.nav.push({ x: s.x, y: s.y }); }
    hudState.head = { yaw: c.swayYaw, pitch: c.swayPitch };

    const end = ss(seg(t, 9.0, 10.0));
    setToonGlobals({ inkTime: Math.floor(f / 2), cityGain: lerp(1.0, 0.62, end), exposure: lerp(1.0, 1.12, end), cityDir: [0.08, -1, 0.1], keyDir: KEY_DIR.toArray(), skyGain: 1 });
  }

  const look = t => {
    const end = ss(seg(t, 9.0, 10.0));
    return {
      t,
      outline: { width: 2.6, near: 90, far: 700, farScale: 0.55, wobble: 1.2, tint: 0.15 },
      kuwahara: { radius: 4, farRadius: 7, farStart: 900, farEnd: 3000, strength: 1 },
      bloom: { strength: lerp(0.6, 1.05, end), threshold: lerp(0.72, 0.6, end), radius: lerp(0.7, 0.8, end), knee: 0.25 },
      grade: { exposure: lerp(1.0, 1.2, end), warmth: lerp(0.12, 0.2, end), lift: [lerp(0.02, 0.05, end), lerp(0.012, 0.04, end), lerp(0.04, 0.05, end)], gamma: 0.96, gain: 1.02, saturation: 1.1, shoulder: 0.9 },
      paper: { strength: 0.13 }, vignette: lerp(0.24, 0.16, end), grain: 0.65, fog: null,
    };
  };

  // 调试：把鲲的关键部位投影到屏幕（?markers=1），看朝向和构图
  const MARKS = [['吻', 300, 0, 0], ['眼', 214, -3, -50], ['背', 40, 58, 0], ['腹', 40, -62, 0], ['侧-', 40, 0, -55], ['侧+', 40, 0, 55], ['鳍', 150, -40, -60], ['尾', -290, 0, 0]];
  function markers(ctx, log) {
    if (log) {
      const out = MARKS.map(([n, x, y, z]) => { const w = new THREE.Vector3(x, y, z).applyMatrix4(kun.group.matrixWorld), s = project(cam, W, H, w);
        return `${n}(${s.x.toFixed(0)},${s.y.toFixed(0)},${cam.position.distanceTo(w).toFixed(0)}m)`; });
      // 腹部朝向：腹部法线与「指向相机」的夹角余弦
      const bn = new THREE.Vector3(0, -1, 0).applyQuaternion(kun.group.quaternion), sn = new THREE.Vector3(0, 0, -1).applyQuaternion(kun.group.quaternion);
      const mid = new THREE.Vector3(40, 0, 0).applyMatrix4(kun.group.matrixWorld), tc = cam.position.clone().sub(mid).normalize();
      console.warn(`[mk] yaw=${(cam.rotation.y / DEG).toFixed(1)} pitch=${(cam.rotation.x / DEG).toFixed(1)} ` + out.join(" ") + ` 腹·镜=${bn.dot(tc).toFixed(2)}`);
      return;
    }
    ctx.save(); ctx.font = '22px sans-serif'; ctx.lineWidth = 3;
    for (const [n, x, y, z] of MARKS) {
      const w = new THREE.Vector3(x, y, z).applyMatrix4(kun.group.matrixWorld), s = project(cam, W, H, w);
      const d = cam.position.distanceTo(w);
      ctx.fillStyle = s.z > 0 ? '#ff2d55' : '#888'; ctx.beginPath(); ctx.arc(s.x, s.y, 7, 0, 7); ctx.fill();
      ctx.fillText(`${n} ${d.toFixed(0)}m`, s.x + 10, s.y - 8);
    }
    ctx.restore();
  }
  return { scene, camera: cam, update, look, hudState, kun, markers };
}
