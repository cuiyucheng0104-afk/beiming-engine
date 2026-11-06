// 实物场景：胡桃木圆基座（内嵌月份 = 钟面），十二根等高玻璃量筒站在 12 个钟点上，
// 每颗玻璃珠 = 1 毫米降水，每第 10 颗是铜珠（标尺）。每颗珠的位置都是时间的纯函数：任意一帧都能单独渲染。
import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { clamp, seg, eo, hash, lerp } from '/core/lib.js';
import { MM, MONTH_ZH, LABELS, schedule, WETTEST } from './timeline.js';

// —— 尺寸（世界单位；一颗珠直径 0.1）——
export const BD = .1, BR = .0485;                 // 珠直径、渲染半径（留一道发丝缝）
export const RING_R = .146, PITCH = .0862;        // 每层：中心 1 颗 + 外圈 9 颗；层与层错开 20° 嵌套
export const TUBE_RI = .203, TUBE_RO = .214, TUBE_H = 2.55, FOOT = .03;
export const R = 1.55, BASE_R = 2.06, BASE_H = .12;
export const Y0 = BASE_H + FOOT + BD / 2;         // 第一层珠心高度
export const az = m => (m + 1) * Math.PI / 6;     // 第 m 月（0 起）在钟面上的方位：一月 = 1 点钟，十二月 = 12 点钟
// 俯视时屏幕上方 = 世界 −z：x = r·sinθ，z = −r·cosθ（顺时针）
export const cyl = (a, r, y) => new THREE.Vector3(r * Math.sin(a), y, -r * Math.cos(a));
export const tubeC = m => cyl(az(m), R, 0);
export const outward = m => new THREE.Vector3(Math.sin(az(m)), 0, -Math.cos(az(m)));
export const tangent = m => new THREE.Vector3(Math.cos(az(m)), 0, Math.sin(az(m)));

// 第 m 月第 k 颗的落定位置
export function slot(m, k) {
  const L = Math.floor(k / 10), s = k % 10, c = tubeC(m);
  const jx = (hash(m * 1931 + k * 7.13) - .5) * .006, jz = (hash(m * 733 + k * 3.71) - .5) * .006, jy = (hash(m * 97 + k * 1.37) - .5) * .004;
  const y = Y0 + L * PITCH + jy;
  if (s === 0) return new THREE.Vector3(c.x + jx, y, c.z + jz);
  const phi = (s * 40 + (L % 2 ? -10 : 10)) * Math.PI / 180;   // s = 9 → 朝外（±10°）：铜珠在每层朝外的位置，连成一列标尺
  const o = outward(m), tg = tangent(m);
  return new THREE.Vector3(c.x + (o.x * Math.cos(phi) + tg.x * Math.sin(phi)) * RING_R + jx, y, c.z + (o.z * Math.cos(phi) + tg.z * Math.sin(phi)) * RING_R + jz);
}
export const levelY = (m, n) => n <= 0 ? BASE_H + FOOT : Y0 + Math.floor((n - 1) / 10) * PITCH + BD / 2;   // n 颗时的顶面高度

// —— 落珠时间表 ——
export const LAST_TOP = 11.6;            // 最后一颗从俯视机位（y≈11.2）之上坠落
export const BEADS = schedule();
export const LAST_R = BR * 1.3;          // 最后一颗：更大、更重的抛光钢珠，落在六月最高一层的中心珠之上（冠珠）
for (const d of BEADS) {
  d.p = slot(d.m, d.k);
  if (d.mode === 'last') { const L = Math.floor(d.k / 10), c = tubeC(d.m); d.p = new THREE.Vector3(c.x, Y0 + L * PITCH + BR + LAST_R - .004, c.z); }
  if (d.mode === 'feed') {
    // 雨：从管口上方出画处坠下（重力），在管内收拢到落点
    const top = BASE_H + TUBE_H + .35, h = top - d.p.y, g = 34;
    d.fall = Math.sqrt(2 * h / g); d.g = g; d.h = h;
    d.ox = (hash(d.m * 51 + d.k * 2.3) - .5) * .22; d.oz = (hash(d.m * 17 + d.k * 5.9) - .5) * .22;
  } else if (d.mode === 'unit') {
    d.h = .145; d.g = 2 * d.h / (d.fall * d.fall); d.ox = d.oz = 0;
  } else {               // 最后一颗：在镜头与六月管口之间、比视线略陡的直线上加速坠落（沿透视线缩小着落进管口）
    d.S = d.p.clone().add(new THREE.Vector3(0, Math.sin(76 * Math.PI / 180), Math.cos(76 * Math.PI / 180)).multiplyScalar(5));   // 比视线陡 8° d.h = d.S.y - d.p.y; d.ox = d.oz = 0;
  }
  d.t0 = d.land - d.fall;
}
export const LAST = BEADS.find(d => d.mode === 'last');
// t 时刻第 m 月已落定的珠数；总数
export const LANDS = Array.from({ length: 12 }, (_, m) => BEADS.filter(d => d.m === m).map(d => d.land).sort((a, c) => a - c));
export function landed(m, t) { const a = LANDS[m]; let lo = 0, hi = a.length; while (lo < hi) { const md = (lo + hi) >> 1; if (a[md] <= t) lo = md + 1; else hi = md; } return lo; }
export const landedAll = t => { let s = 0; for (let m = 0; m < 12; m++) s += landed(m, t); return s; };

export async function buildSet(scene, renderer) {
  const pm = new THREE.PMREMGenerator(renderer), roomEnv = pm.fromScene(new RoomEnvironment(), .04).texture;
  const hdr = await new RGBELoader().loadAsync('/core/assets/polyhaven/photo_studio_loft_hall_2k.hdr');
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = hdr; scene.environmentIntensity = .7; scene.environmentRotation = new THREE.Euler(0, 2.1, 0);

  // 暖色低角度主光（长影）+ 两道冷轮廓光（把玻璃和铜从胡桃木上分出来）+ 一点顶光
  const key = new THREE.DirectionalLight('#fff0d8', 3.2);
  key.position.set(-4.6, 2.9, 3.4); key.castShadow = true; key.shadow.mapSize.set(4096, 4096);
  Object.assign(key.shadow.camera, { left: -3.2, right: 3.2, top: 3.2, bottom: -3.2, near: .5, far: 16 });
  key.shadow.bias = -.0002; key.shadow.normalBias = .01; key.shadow.radius = 4;
  const rim = new THREE.DirectionalLight('#b9d2ff', 2.0); rim.position.set(4.2, 3.0, -4.4);
  const rim2 = new THREE.DirectionalLight('#c8dcff', 1.0); rim2.position.set(4.8, 2.2, 4.0);
  const topL = new THREE.DirectionalLight('#eef2f8', .45); topL.position.set(.6, 8, .4);
  scene.add(key, key.target, rim, rim2, topL);

  const TL = new THREE.TextureLoader();
  const tex = async (u, srgb) => { const t = await TL.loadAsync(u); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 16; if (srgb) t.colorSpace = THREE.SRGBColorSpace; return t; };
  const [wD, wN, wR] = await Promise.all([tex('/core/assets/polyhaven/walnut_diff.jpg', true), tex('/core/assets/polyhaven/walnut_nor.jpg'), tex('/core/assets/polyhaven/walnut_rough.jpg')]);
  for (const t of [wD, wN, wR]) t.repeat.set(1.3, 1.3);

  // 无缝灰米色背景：大地面 + 雾
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: '#bdb6ab', roughness: .95 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; scene.add(floor);
  const walnut = new THREE.MeshStandardMaterial({ map: wD, normalMap: wN, roughnessMap: wR, roughness: 1, color: '#9a7f6a', normalScale: new THREE.Vector2(.6, .6) });
  const walnutSide = walnut.clone(); walnutSide.map = wD.clone(); walnutSide.map.repeat.set(7, .2); walnutSide.map.needsUpdate = true;
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(BASE_R, BASE_R, BASE_H, 220, 1), [walnutSide, walnut, walnut]);
  disc.position.y = BASE_H / 2; disc.castShadow = disc.receiveShadow = true; scene.add(disc);
  const brassM = new THREE.MeshStandardMaterial({ color: '#d2b07a', metalness: 1, roughness: .24 });
  const rimRing = new THREE.Mesh(new THREE.TorusGeometry(BASE_R, .007, 8, 256), brassM);
  rimRing.rotation.x = Math.PI / 2; rimRing.position.y = BASE_H; scene.add(rimRing);

  // 内嵌（白蜡木色）：外圈刻度、十二个月份 + 毫米数，中心站名。俯视时就是钟面
  {
    const C = 4096, c = document.createElement('canvas'); c.width = c.height = C;
    const x = c.getContext('2d'), P = v => (v / BASE_R + 1) / 2 * C, S = v => v / BASE_R * C / 2;
    x.strokeStyle = x.fillStyle = '#fff'; x.lineCap = 'round';
    for (let a = 0; a < 120; a++) {
      const ang = a / 120 * Math.PI * 2, big = a % 10 === 0, r0 = BASE_R - .05, r1 = BASE_R - (big ? .15 : .09);
      x.lineWidth = big ? 6 : 3; x.beginPath(); x.moveTo(P(r0 * Math.sin(ang)), P(-r0 * Math.cos(ang))); x.lineTo(P(r1 * Math.sin(ang)), P(-r1 * Math.cos(ang))); x.stroke();
    }
    x.lineWidth = 3; x.beginPath(); x.arc(C / 2, C / 2, S(BASE_R - .2), 0, Math.PI * 2); x.stroke();
    x.lineWidth = 2.5; x.beginPath(); x.arc(C / 2, C / 2, S(R), 0, Math.PI * 2); x.stroke();   // 量筒站立的圆
    x.textAlign = 'center'; x.textBaseline = 'middle';
    for (let m = 0; m < 12; m++) {
      const a = az(m), rr = R + .23 + .1;
      const cx = P(rr * Math.sin(a)), cz = P(-rr * Math.cos(a));
      x.font = `600 ${Math.round(S(.105))}px NotoSerifSC`; x.fillText(MONTH_ZH[m], cx, cz - S(.055));
      x.font = `500 ${Math.round(S(.075))}px JBMono`; x.fillText(String(MM[m]), cx, cz + S(.065));
      // 量筒脚下一圈细环
      x.lineWidth = 2; x.beginPath(); x.arc(P(R * Math.sin(a)), P(-R * Math.cos(a)), S(TUBE_RO + .03), 0, Math.PI * 2); x.stroke();
    }
    x.font = `500 ${Math.round(S(.1))}px NotoSC`; x.fillText(LABELS.inlayC1, C / 2, C / 2 - S(.14));
    x.font = `400 ${Math.round(S(.062))}px JBMono`; x.fillText(LABELS.inlayC2, C / 2, C / 2 + S(.0));
    x.font = `400 ${Math.round(S(.066))}px NotoSC`; x.fillText(LABELS.inlayC3, C / 2, C / 2 + S(.13));
    x.lineWidth = 2; x.beginPath(); x.moveTo(C / 2 - S(.5), C / 2 - S(.065)); x.lineTo(C / 2 + S(.5), C / 2 - S(.065)); x.stroke();
    const t = new THREE.CanvasTexture(c); t.anisotropy = 16;
    const inlay = new THREE.Mesh(new THREE.CircleGeometry(BASE_R, 220), new THREE.MeshStandardMaterial({ color: '#efe4cf', alphaMap: t, transparent: true, roughness: .5, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false }));
    inlay.rotation.x = -Math.PI / 2; inlay.position.y = BASE_H + .0005; inlay.receiveShadow = true; scene.add(inlay);
  }

  // —— 十二根玻璃量筒：透明的筒身（不进透射通道，才能看见里面的珠）+ 只叠加反射的一层 ——
  const glassBody = new THREE.MeshPhysicalMaterial({ color: '#eef5f3', roughness: .06, metalness: 0, transparent: true, opacity: .045, depthWrite: false, side: THREE.DoubleSide });
  const glassSpec = new THREE.MeshPhysicalMaterial({ color: '#000000', roughness: .035, metalness: 0, ior: 1.5, specularIntensity: .8, envMap: roomEnv, envMapIntensity: 1.5, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const footM = new THREE.MeshPhysicalMaterial({ color: '#dfeeea', roughness: .1, metalness: 0, transparent: true, opacity: .35, depthWrite: false });
  const wallG = new THREE.CylinderGeometry(TUBE_RO, TUBE_RO, TUBE_H - FOOT, 72, 1, true);
  const wallGi = new THREE.CylinderGeometry(TUBE_RI, TUBE_RI, TUBE_H - FOOT, 72, 1, true);
  const lipG = new THREE.TorusGeometry((TUBE_RI + TUBE_RO) / 2, (TUBE_RO - TUBE_RI) * .9, 10, 72);
  const footG = new THREE.CylinderGeometry(TUBE_RO + .012, TUBE_RO + .02, FOOT, 72);
  for (let m = 0; m < 12; m++) {
    const c = tubeC(m), yc = BASE_H + FOOT + (TUBE_H - FOOT) / 2;
    for (const [geo, mat, ro] of [[wallG, glassBody, 2], [wallGi, glassSpec, 3], [wallG, glassSpec, 4]]) {
      const w = new THREE.Mesh(geo, mat); w.position.set(c.x, yc, c.z); w.renderOrder = ro; scene.add(w);
    }
    const lip = new THREE.Mesh(lipG, [glassSpec][0]); lip.rotation.x = Math.PI / 2; lip.position.set(c.x, BASE_H + TUBE_H, c.z); lip.renderOrder = 5; scene.add(lip);
    const lip2 = new THREE.Mesh(lipG, glassBody); lip2.rotation.x = Math.PI / 2; lip2.position.copy(lip.position); lip2.renderOrder = 4; scene.add(lip2);
    for (const [mat, ro] of [[footM, 2], [glassSpec, 3]]) { const foot = new THREE.Mesh(footG, mat); foot.position.set(c.x, BASE_H + FOOT / 2, c.z); foot.renderOrder = ro; scene.add(foot); }
  }

  // —— 珠子：玻璃（透射，淡水色）与铜（金属），各一个实例化网格 ——
  const geo = new THREE.SphereGeometry(BR, 28, 18);
  // 透射只"看见"不透明的背景：管底珠背后是阴影里的胡桃木（发墨绿），管顶珠背后是浅色背景（发浅青）。
  // 把透射降到 0.72、补一点本色、清漆层与环境反射，让整根管里的玻璃珠是同一种材质
  const glass = new THREE.MeshPhysicalMaterial({ color: '#b9e0d9', roughness: .04, metalness: 0, transmission: .72, thickness: .07, ior: 1.52,
    attenuationColor: new THREE.Color('#6fb3aa'), attenuationDistance: .12, specularIntensity: 1, envMapIntensity: 1.7, clearcoat: 1, clearcoatRoughness: .03 });
  const brass = new THREE.MeshStandardMaterial({ color: '#d2b07a', metalness: 1, roughness: .2, envMapIntensity: 1.2 });
  const groups = { glass: [], brass: [] };
  for (const d of BEADS) { if (d.mode === 'last') continue; const g = d.brass ? 'brass' : 'glass'; d.g_ = g; d.idx = groups[g].length; groups[g].push(d); }
  const steel = new THREE.MeshStandardMaterial({ color: '#d6dadf', metalness: 1, roughness: .18, envMapIntensity: 1.8 });
  const lastMesh = new THREE.Mesh(new THREE.SphereGeometry(LAST_R, 48, 32), steel); lastMesh.castShadow = lastMesh.receiveShadow = true; scene.add(lastMesh);
  const meshes = {};
  for (const [g, mat] of [['glass', glass], ['brass', brass]]) {
    const m = new THREE.InstancedMesh(geo, mat, groups[g].length); m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
    for (const d of groups[g]) { const v = .93 + hash(d.m * 311 + d.k * 1.7) * .14; m.setColorAt(d.idx, new THREE.Color(v, v, v)); }
    m.instanceColor.needsUpdate = true; scene.add(m); meshes[g] = m;
  }

  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1), ZERO = new THREE.Vector3(0, 0, 0);
  // 一颗珠在 t 时刻的位置：t0 前不存在；下落 = 自由落体；落定后一次很小的阻尼回弹
  function beadPos(d, t, out) {
    if (t < d.t0) return null;
    const p = d.p;
    if (t < d.land && d.S) { const s = ((t - d.t0) / d.fall) ** 2; return out.copy(d.S).lerp(p, s); }
    if (t < d.land) {
      const u = t - d.t0, y = p.y + d.h - .5 * d.g * u * u, k = 1 - eo(seg(t, d.t0, d.land));
      return out.set(p.x + d.ox * k, y, p.z + d.oz * k);
    }
    const a = t - d.land, amp = d.mode === 'last' ? .022 : d.mode === 'unit' ? .012 : .004;
    return out.set(p.x, p.y + amp * Math.exp(-a * 11) * Math.abs(Math.sin(a * 22)), p.z);
  }
  const LASTD = BEADS.find(d => d.mode === 'last');
  function update(t) {
    { const v = beadPos(LASTD, t, P); lastMesh.visible = !!v; if (v) lastMesh.position.copy(v); }
    const dl = t - LASTD.land;
    for (const d of BEADS) {
      if (d.mode === 'last') continue;
      const v = beadPos(d, t, P);
      // 冠珠砸下：六月最上面几层被震得跳一下（由近及远，0.25 s 内平息）
      if (v && d.m === LASTD.m && dl > 0 && dl < .3 && d.k >= 220) { const a = dl - (LASTD.k - d.k) * .0012; if (a > 0) v.y += .016 * Math.exp(-a * 16) * Math.abs(Math.sin(a * 34)); }
      if (!v) M4.compose(P.set(0, -5, 0), Q, ZERO); else M4.compose(v, Q, ONE);
      meshes[d.g_].setMatrixAt(d.idx, M4);
    }
    for (const g in meshes) meshes[g].instanceMatrix.needsUpdate = true;
  }
  return { update, beadPos, key };
}
