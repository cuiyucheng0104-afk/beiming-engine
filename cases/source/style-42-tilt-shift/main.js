// 港口一日 · 移轴微缩  — render(t) 确定性：无 Math.random / Date.now，任何帧可单独渲染
import * as THREE from 'three';
import { makePost } from './post.js';
import { clamp, seg, lerp, ss, eio, eo, hash, monotone } from '/core/lib.js';
import { buildWorld, U, BOX, CBOX } from './world.js';
import { FPS, fr, DUR, T, GRID, SHOTS, shotAt, WINDOWS, windowAt, simAt, clockAt, rateAt, stepT, CYCLE, SLOT, BEAT_A, BEAT_C, fmtClock, NIGHT_RATE } from './timeline.js';

const W = 1920, H = 1080, QS = new URLSearchParams(location.search);
await Promise.all([document.fonts.load('900 100px "Noto Sans SC"'), document.fonts.load('700 40px "Noto Sans SC"'), document.fonts.load('700 60px "Overpass Mono"'), document.fonts.load('800 40px Overpass')]);

const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1); renderer.setSize(W, H);
renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('stage').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, W / H, 1, 9000);
const post = makePost(renderer, scene, camera, W, H, { ssaa: 2, ao: !QS.has('noao'), aoRadius: 2.2, aoThickness: 2.5, aoScale: 1.4, aoAmt: .7 });
post.bloom.strength = .2; post.bloom.threshold = 1.05; post.bloom.radius = .45;
const V = (x, y, z) => new THREE.Vector3(x, y, z);

const Wd = buildWorld(scene);

// —— 天空（只用于环境反射；俯角大，画面里看不到天）、太阳、半球光 ——
const sun = new THREE.DirectionalLight('#fff', 3); sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -.0004; sun.shadow.normalBias = .5; sun.shadow.radius = 2;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight('#b8cae0', '#8d7d66', .7); scene.add(hemi);
// 夜：高杆钠灯的整体暖色补光（无阴影，从高处罩下来），让集装箱顶面和码头边线在夜里读得出颜色
const flood = new THREE.DirectionalLight('#ffb466', 0); flood.position.set(60, 400, 160); flood.target.position.set(0, 0, 100); scene.add(flood, flood.target);
scene.fog = new THREE.FogExp2('#c8d4e2', .00018);
const skyMat = new THREE.ShaderMaterial({ uniforms: { zen: { value: new THREE.Color() }, hor: { value: new THREE.Color() } }, side: THREE.BackSide, depthWrite: false,
  vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
  fragmentShader: `varying vec3 vD; uniform vec3 zen, hor; void main(){ float t = max(vD.y, 0.); gl_FragColor = vec4(mix(hor, zen, pow(t, .5)) * (vD.y < 0. ? .6 : 1.), 1.); }` });
const envScene = new THREE.Scene(); envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat));
const pm = new THREE.PMREMGenerator(renderer);
const mkEnv = (z, h) => { skyMat.uniforms.zen.value.set(z); skyMat.uniforms.hor.value.set(h); return pm.fromScene(envScene, 0, .1, 200).texture; };
const ENV = { day: mkEnv('#3f86dc', '#dfe8ee'), dusk: mkEnv('#2b4a8a', '#f2a46c'), night: mkEnv('#0a1430', '#28304a') };

// 太阳高度（度）由时钟决定；方位每个镜头作弊（迎光）
const sunElev = clock => 52 * Math.sin(Math.PI * (clock / 3600 - 6.75) / 12);
const SK = [   // 按太阳高度的光照关键帧
  { e: -14, sun: '#ff7a3c', sunI: 0, hemS: '#2e4078', hemG: '#4a3621', hemI: .8, fog: '#1a2440', expo: 1.3, env: 'night', envI: .38 },   // 夜：暖色地面补光，暗部可读
  { e: -4, sun: '#ff8a50', sunI: 0, hemS: '#6474ac', hemG: '#4a3a30', hemI: .9, fog: '#4a5584', expo: 1.22, env: 'dusk', envI: .4 },
  { e: 2, sun: '#ff9a52', sunI: 2.0, hemS: '#8a92c0', hemG: '#5a4a3c', hemI: .7, fog: '#b49a96', expo: 1.08, env: 'dusk', envI: .45 },
  { e: 8, sun: '#ffc283', sunI: 3.6, hemS: '#a7b6d8', hemG: '#7a6a54', hemI: .65, fog: '#c9c4c4', expo: 1.02, env: 'dusk', envI: .5 },
  { e: 25, sun: '#fff0d8', sunI: 4.3, hemS: '#b8cae0', hemG: '#8d7d66', hemI: .62, fog: '#cfdbe8', expo: 1.0, env: 'day', envI: .55 },
];
const cA = new THREE.Color(), cB = new THREE.Color();
function lightState(e) {
  let i = 0; while (i < SK.length - 2 && e > SK[i + 1].e) i++;
  const a = SK[i], b = SK[i + 1], u = clamp((e - a.e) / (b.e - a.e));
  const col = f => cA.set(a[f]).lerp(cB.set(b[f]), u).clone();
  return { sun: col('sun'), hemS: col('hemS'), hemG: col('hemG'), fog: col('fog'), sunI: lerp(a.sunI, b.sunI, u), hemI: lerp(a.hemI, b.hemI, u), expo: lerp(a.expo, b.expo, u), env: u < .5 ? a.env : b.env, envI: lerp(a.envI, b.envI, u) };
}

// —— 拖船：航迹距离 d(S)，3 m/s，6 s 匀减速停在 T.stop ——
const DAY = WINDOWS[0];
const S_STOP = simAt(T.stop, DAY), S_DEC = S_STOP - 6, VT = 3, TUG = Wd.tug;
const tugD = S => S >= S_STOP ? TUG.L : S > S_DEC ? TUG.L - 9 + VT * ((S - S_DEC) - (S - S_DEC) ** 2 / 12) : TUG.L - 9 - VT * (S_DEC - S);
const tugSpeed = S => S >= S_STOP ? 0 : S > S_DEC ? VT * (1 - (S - S_DEC) / 6) : VT;
function tugPose(d) {
  const L = TUG.L;
  if (d >= 0) { const u = clamp(d / L, 0, 1), p = TUG.curve.getPointAt(u), tg = TUG.curve.getTangentAt(Math.min(u, .999)); return { p, yaw: Math.atan2(-tg.z, tg.x) }; }
  const p0 = TUG.curve.getPointAt(0), tg = TUG.curve.getTangentAt(0); return { p: p0.clone().addScaledVector(tg, d), yaw: Math.atan2(-tg.z, tg.x) };
}
const dayS = t => t < T.cut4 ? simAt(t, DAY) : simAt(T.cut4 - 1e-4, DAY) + (t - T.cut4) * 0;   // 拖船只在白天窗口里动

// —— 云：6 块，沿风向漂移；速度随镜头升高按指数加快（近景慢、全景快，屏幕上每块都要 1–2 s 才扫过）——
// 0 号前沿在 C2 正好越过停住的拖船，1 号前沿在 C4 正好越过堆场；其余几块让升到全景时整片港口上都有云影在走
const WIND = V(1, 0, -.22).normalize();
const CL_A = 52, CL_B = 3;
const cloudOff = ts => CL_A * (Math.exp(CL_B * seg(ts, T.horn, T.cut4)) - 1);
const BLOBS = [];
const CLOUD_P = [V(116 * 1, 0, -64), V(-20, 0, 75)];
{
  const mk = (P, rx, rz, tHit) => { const s = .849 / Math.hypot(WIND.x / rx, WIND.z / rz); const c = P.clone().addScaledVector(WIND, -s - cloudOff(tHit)); BLOBS.push({ c0: c, rx, rz }); };   // 前沿（归一化半径 .85）恰在 tHit 到达 P
  CLOUD_P[0] = tugPose(TUG.L).p.clone().setY(0);
  mk(CLOUD_P[0], 100, 80, T.cloud1);        // 前沿 10.833 s 越过拖船
  mk(CLOUD_P[1], 260, 180, T.cloud2);       // 前沿 12.5 s 越过堆场
  mk(V(200, 0, -150), 220, 160, fr(290)); mk(V(-260, 0, 150), 300, 200, fr(320)); mk(V(-160, 0, -260), 240, 170, fr(310)); mk(V(320, 0, 240), 280, 190, fr(330));
}
function setClouds(ts) {
  const off = cloudOff(ts);
  BLOBS.forEach((b, i) => { const c = b.c0.clone().addScaledVector(WIND, off); U.blobs.value[i].set(c.x, c.z, b.rx, b.rz); });
}
// 云影前沿到达某点的帧（用于事件核对）：数值求根，跟 shader 的 r=1 边界一致（不含噪声）
function cloudArrive(i, P) {
  for (let f = Math.round(T.horn * FPS); f < Math.round(T.cut4 * FPS); f++) {
    const ts = stepT(f / FPS), b = BLOBS[i], c = b.c0.clone().addScaledVector(WIND, cloudOff(ts));
    const d = Math.hypot((P.x - c.x) / b.rx, (P.z - c.z) / b.rz); if (d <= .85) return f / FPS;
  }
  return null;
}

// —— 岸桥状态 ——
const NBAY = 33;
function craneState(i, S) {
  const c = S / SLOT + 1e-6, k = (c - i) / 3, n = Math.floor(k + 1e-7), ph = Math.max(0, k - n);
  const cx = Wd.CR[i], bay = Wd.shipBay[cx];
  const picked = Math.max(0, n + (ph >= .5 ? 1 : 0));
  const tgt = bay[Math.min(picked, NBAY - 1)], prev = bay[Math.min(Math.max(picked - 1, 0), NBAY - 1)];
  const zT = 15, yT = 4.5, yTop = 38;
  const pk = ph < .5 ? tgt : prev, zP = pk[2], yP = pk[1] + 1.3 + .45;
  let z, y, carry = ph >= .5;
  if (ph < .15) { z = zT; y = lerp(yT, yTop, ss(ph / .15)); }
  else if (ph < .4) { y = yTop; z = lerp(zT, zP, ss((ph - .15) / .25)); }
  else if (ph < .5) { z = zP; y = lerp(yTop, yP, ss((ph - .4) / .1)); }
  else if (ph < .62) { z = zP; y = lerp(yP, yTop, ss((ph - .5) / .12)); }
  else if (ph < .88) { y = yTop; z = lerp(zP, zT, ss((ph - .62) / .26)); }
  else { z = zT; y = lerp(yTop, yT, ss((ph - .88) / .12)); }
  return { cx, z, y, carry, picked, col: prev ? prev[3] : 0, n, ph };
}
// 卡车：停走式前进，每 SLOT 世界秒前进一个车位（20 m）
const S_I = [10, 13, 16], DROP = 33;
function truckProg(S) { const p = S / SLOT + 1e-6, k = Math.floor(p), u = p - k; return k + ss(seg(u, .25, 1)); }
function truckCarry(j, prog) {
  const rel = prog - j, lap = Math.floor(rel / 59), kk = rel - lap * 59;
  for (let i = 0; i < 3; i++) {
    const b = j + S_I[i] + 59 * lap;
    if ((((b - i) % 3) + 3) % 3 === 0) {
      if (kk + 1e-6 >= S_I[i] && kk < DROP) { const m = Math.round((b - i) / 3), bay = Wd.shipBay[Wd.CR[i]]; return bay[((m - 1) % NBAY + NBAY) % NBAY][3]; }
      return -1;
    }
  }
  return -1;
}

// —— 相机 ——
const UPY = V(0, 1, 0);
const tugSmooth = t => tugPose(tugD(dayS(t))).p;
const TUGSTOP = tugPose(TUG.L).p;
function band(y, w, amp = 30, mix = .6) { return { y, w, amp, mix, tilt: 0, pow: 1.25 }; }
function cam(t) {
  const st = shotAt(t), u = seg(t, st.t0, st.t1);
  let pos, look, up = UPY, fov = 28, aper = 6000, bd = band(.5, .06), span = 220, az = -40, follow = null;
  switch (st.name) {
    case 'slide': {
      look = V(lerp(-78, -18, u), 0, 14); pos = look.clone().add(V(-10, 192, 170)); bd = band(.5, .058, 30, .62); span = 230; az = -38; follow = V(look.x, 3, 15);
      break;
    }
    case 'top': {
      const r = lerp(-38, -22, eio(u)) * Math.PI / 180;
      look = V(lerp(52, 62, u), 0, lerp(-58, -62, u)); pos = look.clone().add(V(0, lerp(430, 385, eio(u)), 0)); up = V(Math.sin(r), 0, -Math.cos(r));
      span = 300; az = -55; aper = 9000;
      const k = ss(seg(t, T.pointer, T.pointer + BEAT_A * 2));
      const tp = tugPose(tugD(dayS(stepT(t)))).p;
      follow = V(lerp(20, tp.x, k), 3, lerp(15, tp.z, k)); bd = band(.5, lerp(.07, .05, k), 28, .75);
      break;
    }
    case 'tug': {
      const tp = tugSmooth(t), tq = TUGSTOP;
      const tl = t < T.rise ? tp : tq;
      // 推近：230 m → 105 m（停）→ 98 m（静默里极慢地蠕动）
      const dist = t < T.stop ? lerp(240, 108, eio(seg(t, T.cut3, T.stop))) : lerp(108, 100, seg(t, T.stop, T.rise));
      const pitch0 = (t < T.stop ? lerp(54, 44, eio(seg(t, T.cut3, T.stop))) : 44) * Math.PI / 180;
      const yaw0 = (37 + 6 * seg(t, T.cut3, T.rise)) * Math.PI / 180;   // 相机在拖船东北方，看向西南（背景 = 码头）
      if (t < T.rise) {
        look = tl.clone().add(V(0, 3, 0));
        pos = look.clone().add(V(Math.sin(yaw0) * Math.cos(pitch0), Math.sin(pitch0), -Math.cos(yaw0) * Math.cos(pitch0)).multiplyScalar(dist));
      } else {
        // 对数高度升起：高度 70 m → 1050 m，俯角 44° → 70°，注视点从拖船移到港口中心，方位继续转
        const v = seg(t, T.rise, T.cut4), ve = eio(v);
        const h = 70 * Math.pow(1050 / 70, ss(v * .92 + .08 * v * v));
        const pitch = lerp(44, 70, ve) * Math.PI / 180, yaw = (43 + 22 * ve) * Math.PI / 180;
        look = tq.clone().add(V(0, 3, 0)).lerp(V(-40, 0, 40), ss(seg(v, .05, .9)));
        const hd = h / Math.tan(pitch);
        pos = V(look.x + Math.sin(yaw) * hd, h, look.z - Math.cos(yaw) * hd);
      }
      span = clamp(pos.y * 2.2, 200, 1700); az = 125;   // 阴影框要盖住整个画面（否则阴影相机边界在水面上画出一条细黑线）
      follow = t < T.rise ? tp.clone().add(V(0, 3, 0)) : null;
      const nar = seg(t, T.real, T.stop) - seg(t, T.horn, T.rise + .6);
      bd = band(.5, lerp(.06, .026, clamp(nar)), lerp(30, 34, clamp(nar)), lerp(.62, .72, clamp(nar)));
      aper = lerp(5000, 2600, clamp(nar));
      if (t >= T.rise) { const v = seg(t, T.rise, T.cut4); bd = band(.5, lerp(.04, .13, ss(v)), lerp(32, 22, v), lerp(.7, .55, v)); aper = lerp(3000, 12000, v); }
      break;
    }
    case 'night': {
      const ue = eio(u);
      // 慢推 + 微横摇：从整片夜港推向港务楼屋顶招牌，招牌在 16.667 s 通电时已落进焦带
      look = V(lerp(70, 140, ue), lerp(0, 8, ue), lerp(40, 70, ue));
      const dist = lerp(470, 285, ue), pit = lerp(47, 41, ue) * Math.PI / 180, yw = lerp(30, 40, ue) * Math.PI / 180;
      pos = look.clone().add(V(Math.sin(yw) * Math.cos(pit) * dist, Math.sin(pit) * dist, Math.cos(yw) * Math.cos(pit) * dist));
      span = 360; az = -18; aper = 7000; bd = band(.5, lerp(.085, .06, ue), 28, .62);
      const sg = Wd.sign.grp.position; follow = V(lerp(look.x, sg.x, .55), lerp(0, sg.y, .55), lerp(look.z, sg.z, .55));
      break;
    }
  }
  const o = QS.get('cam'); if (o) { const a = o.split(',').map(Number); pos = V(a[0], a[1], a[2]); look = V(a[3], a[4], a[5]); if (a[6]) fov = a[6]; }
  camera.position.copy(pos); camera.up.copy(up); camera.fov = fov; camera.near = pos.y < 120 ? .5 : 2; camera.far = 9000; camera.updateProjectionMatrix(); camera.lookAt(look); camera.updateMatrixWorld();
  let focus = pos.distanceTo(look);
  if (follow) { const p = follow.clone().project(camera); bd.y = clamp((p.y + 1) / 2, .22, .78); focus = pos.distanceTo(follow); }
  const d = post.dof; d.focus = focus; d.aper = +(QS.get('aper') ?? aper); d.maxCoc = 30; Object.assign(d.band, bd);
  if (QS.has('nodof')) d.maxCoc = 0;
  return { pos, look, span, az, name: st.name, follow };
}

// —— 长曝光光迹 ——
const trails = (() => {
  const MAXR = 420, K = 40, nv = MAXR * K * 2;
  const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = [];
  for (let r = 0; r < MAXR; r++) for (let k = 0; k < K - 1; k++) { const a = (r * K + k) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setIndex(idx);
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  mesh.frustumCulled = false; mesh.renderOrder = 5; scene.add(mesh);
  let n = 0;
  return {
    begin() { n = 0; },
    ribbon(pts, C, I, w = .9, y = 1.1) {
      if (n >= MAXR || pts.length < 2 || I <= 0) return; const m = pts.length;
      for (let k = 0; k < K; k++) {
        const tt = k / (K - 1), fi = tt * (m - 1), i0 = Math.min(Math.floor(fi), m - 2), uu = fi - i0;
        const x = lerp(pts[i0][0], pts[i0 + 1][0], uu), z = lerp(pts[i0][1], pts[i0 + 1][1], uu);
        let dx = pts[i0 + 1][0] - pts[i0][0], dz = pts[i0 + 1][1] - pts[i0][1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
        const a = (n * K + k) * 2, f = (.25 + .75 * Math.pow(tt, 1.3)) * I;
        pos.set([x - dz * w / 2, y, z + dx * w / 2], a * 3); pos.set([x + dz * w / 2, y, z - dx * w / 2], a * 3 + 3);
        col.set([C[0] * f, C[1] * f, C[2] * f], a * 3); col.set([C[0] * f, C[1] * f, C[2] * f], a * 3 + 3);
      }
      n++;
    },
    end() { g.setDrawRange(0, n * (K - 1) * 6); g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = true; mesh.visible = n > 0; },
  };
})();

// —— 夜里的 12 辆卡车：每次跳帧沿环线前进 37 m（光迹像彗星一样追着走），车距 100 m ——
const NSTEP = tq => Math.round((tq - T.cut4) * FPS / 5);
const nightS = (j, tq) => 37 * NSTEP(tq) - j * 20 + 30;
// 光迹长度：每个 72 拍的拍点阶梯式变长（拍内只微微爬升），C12 正好 = 车距 → 12 条首尾相接成闭合光框
const LT_STEPS = [12, 22, 34, 47, 61, 77, 101];
function trailLen(t) {
  const b = clamp(Math.floor((t - T.cut4) / BEAT_C + 1e-6), 0, 6), u = clamp((t - T.cut4) / BEAT_C - b);
  return b >= 6 ? LT_STEPS[6] : LT_STEPS[b] + (LT_STEPS[b + 1] - LT_STEPS[b]) * .18 * u;
}

// —— 城市路小汽车 ——
const CARS = []; for (let i = 0; i < Wd.cars.NCAR; i++) { const dir = i % 2 ? 1 : -1; CARS.push({ dir, s0: hash(i * 3.1) * 3000, v: 12 + hash(i * 7.7) * 4, z: dir > 0 ? 268 : 261.5 }); }
const carX = (c, S) => { const s = (c.s0 + c.v * S) % 3000; return c.dir > 0 ? -1500 + s : 1500 - s; };

// —— HUD：港区时钟牌（左下，位于下方模糊带内）——
const ov = document.getElementById('ov'), g2 = ov.getContext('2d');
const HUD = { x: 72, y: 1080 - 72 - 168, w: 372, h: 168 };
function speedLabel(t) {
  const r = rateAt(t);
  if (r < 1.5) return { n: '×1', w: '实时', real: true };
  const shown = r > 30 && r < 50 ? 40 : r >= 2300 ? 2400 : Math.round(r >= 100 ? r / 10 : r) * (r >= 100 ? 10 : 1);
  return { n: '×' + shown, w: '延时', real: false };
}
function drawHUD(t, clock) {
  g2.clearRect(0, 0, W, H); if (QS.has('nohud')) return;
  const { x, y, w, h } = HUD, sp = speedLabel(t), night = U.night.value;
  g2.save();
  g2.shadowColor = 'rgba(0,0,0,.35)'; g2.shadowBlur = 18; g2.shadowOffsetY = 4;
  g2.fillStyle = '#163a5f'; g2.beginPath(); g2.roundRect(x, y, w, h, 14); g2.fill();
  g2.shadowColor = 'transparent';
  g2.strokeStyle = 'rgba(255,255,255,.85)'; g2.lineWidth = 3; g2.beginPath(); g2.roundRect(x + 8, y + 8, w - 16, h - 16, 9); g2.stroke();
  g2.fillStyle = '#ffffff'; g2.font = '700 26px "Noto Sans SC"'; g2.textBaseline = 'alphabetic'; g2.fillText('港区时钟', x + 28, y + 50);
  g2.font = '700 74px "Overpass Mono"'; g2.fillText(fmtClock(clock), x + 26, y + 128);
  // 速度读数
  g2.fillStyle = sp.real ? '#5fe08a' : '#ffb63a'; g2.beginPath(); g2.roundRect(x + 190, y + 26, 156, 36, 7); g2.fill();
  g2.fillStyle = '#163a5f'; g2.font = '700 25px "Overpass Mono"'; const nw = g2.measureText(sp.n).width;
  g2.font = '700 22px "Noto Sans SC"'; const ww = g2.measureText(sp.w).width;
  const tx = x + 190 + (156 - nw - ww - 6) / 2;
  g2.font = '700 25px "Overpass Mono"'; g2.fillText(sp.n, tx, y + 53); g2.font = '700 22px "Noto Sans SC"'; g2.fillText(sp.w, tx + nw + 6, y + 52);
  // 小锚标（码头告示语言）
  g2.strokeStyle = '#ffffff'; g2.lineWidth = 3; const ax = x + 300, ay = y + 112;
  g2.beginPath(); g2.arc(ax, ay - 20, 5, 0, Math.PI * 2); g2.moveTo(ax, ay - 15); g2.lineTo(ax, ay + 14); g2.moveTo(ax - 12, ay - 6); g2.lineTo(ax + 12, ay - 6);
  g2.moveTo(ax - 18, ay + 2); g2.quadraticCurveTo(ax - 14, ay + 18, ax, ay + 18); g2.quadraticCurveTo(ax + 14, ay + 18, ax + 18, ay + 2); g2.stroke();
  g2.restore();
}
window.TEXTS = t => {
  const out = [{ id: 'hud', text: '港区时钟', x0: HUD.x, y0: HUD.y, x1: HUD.x + HUD.w, y1: HUD.y + HUD.h }];
  const r = rateAt(t), box = { x0: HUD.x + 190, y0: HUD.y + 26, x1: HUD.x + 346, y1: HUD.y + 62 };
  if (r === 40) out.push({ id: 'speed', text: '×40延时', ...box });
  else if (r < 1.5) out.push({ id: 'speed', text: '×1实时', ...box });
  else if (r === NIGHT_RATE) out.push({ id: 'speed', text: '×2400延时', ...box });
  if (t >= T.sign) out.push({ id: 'title', text: '港口一日', x0: 0, y0: 0, x1: 10, y1: 10, ...signBox() });
  return out;
};
function signBox() {
  const g = Wd.sign.grp, pts = [V(-14.5, .9, 0), V(14.5, .9, 0), V(-14.5, 8.3, 0), V(14.5, 8.3, 0)].map(p => g.localToWorld(p.clone()).project(camera));
  const xs = pts.map(p => (p.x + 1) / 2 * W), ys = pts.map(p => (1 - p.y) / 2 * H);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

// —— 灯组开关 ——
const ON = { lamps: T.lamps, boom: T.boom, windows: T.windows, lighthouse: T.lighthouse, mast: T.final };
const onAmt = (grp, t) => { if (t < T.cut4) return 0; const t0 = ON[grp]; if (t < t0) return 0; const k = t - t0; return k < fr(1) ? .65 : k < fr(3) ? .4 + .2 * (k * FPS - 1) : clamp(.75 + k * 1.2, 0, 1); };

// —— 帧 ——
const WHITE = new THREE.Color(1, 1, 1);
const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), SC = new THREE.Vector3(1, 1, 1), C3 = new THREE.Color();
function setInst(mesh, i, x, y, z, yaw = 0, s = 1) { E.set(0, yaw, 0); Q.setFromEuler(E); SC.setScalar(s); M4.compose(V(x, y, z), Q, SC); mesh.setMatrixAt(i, M4); }
function render(t) {
  const st = shotAt(t), Wn = windowAt(t), tq = stepT(t), S = simAt(tq, Wn), clock = Wn.clock0 + S, rate = rateAt(t);
  const isDay = Wn.name === 'day', Sd = isDay ? S : simAt(T.cut4 - 1e-4, DAY) + 400 + S;   // 黄昏窗口里白天的机器继续（只为岸桥/卡车的相位）
  const Sw = isDay ? S : S + 3000;
  // 拖船（先于相机：焦带要跟它）
  const td = tugD(isDay ? S : S_STOP), tp = tugPose(td);
  TUG.g.position.copy(tp.p); TUG.g.rotation.y = tp.yaw; TUG.g.visible = td > -60;
  const C = cam(t);
  // 天光
  const e = sunElev(clock), Ls = lightState(e), azr = C.az * Math.PI / 180, er = Math.max(e, 4) * Math.PI / 180;
  const sd = V(Math.sin(azr) * Math.cos(er), Math.sin(er), Math.cos(azr) * Math.cos(er));
  sun.color.copy(Ls.sun); sun.intensity = Ls.sunI; sun.position.copy(C.look).addScaledVector(sd, 2000); sun.target.position.copy(C.look); sun.target.updateMatrixWorld();
  Object.assign(sun.shadow.camera, { left: -C.span, right: C.span, top: C.span, bottom: -C.span, near: 200, far: 4200 }); sun.shadow.camera.updateProjectionMatrix();
  hemi.color.copy(Ls.hemS); hemi.groundColor.copy(Ls.hemG); hemi.intensity = Ls.hemI;
  scene.fog.color.copy(Ls.fog); scene.fog.density = .00016 * clamp(400 / C.pos.y, .25, 1.2);
  scene.environment = ENV[Ls.env]; scene.environmentIntensity = Ls.envI;
  post.grade.uniforms.expo.value = Ls.expo; const nk = clamp((2 - e) / 14); post.grade.uniforms.sat.value = lerp(1.5, 1.0, nk); post.grade.uniforms.lift.value = lerp(0, .8, nk);   /* 夜：饱和度约为白天的 2/3，暗部抬起 */ post.grade.uniforms.contrast.value = .38; post.grade.uniforms.amt.value = .32; post.grade.uniforms.warm.value = lerp(.25, .6, clamp((10 - e) / 10));
  U.sky.value.copy(Ls.hemS);
  // 水面：延时里波纹被"平均"成镜面
  U.waterT.value = Sw; U.waterAmp.value = 1 / (1 + rate / 3);
  // 云影（只在 C 段）
  U.cloud.value = st.name === 'tug' ? ss(seg(tq, T.horn, T.horn + .2)) : 0; setClouds(tq);
  // 岸桥 + 吊具上的箱子 + 船上作业贝
  const mDyn = Wd.mDyn; let di = 0;
  for (let i = 0; i < 3; i++) {
    const c = craneState(i, Sd), cr = Wd.cranes[i];
    cr.trolley.position.set(c.cx, 45.3, c.z); cr.spreader.position.set(c.cx, c.y, c.z);
    const top = 43.7, len = Math.max(.1, top - (c.y + .45));
    for (const [rp, dx] of [[cr.ropes, -3], [cr.ropes2, 3]]) { rp.position.set(c.cx + dx, top, c.z); rp.scale.set(1, len, 1); }
    if (c.carry) { setInst(mDyn, di, c.cx, c.y - .45 - 1.3, c.z); mDyn.setColorAt(di, C3.set(CBOX[c.col])); di++; }
    const bay = Wd.shipBay[c.cx];
    for (let k = Math.min(c.picked, NBAY); k < NBAY; k++) { const b = bay[k]; setInst(mDyn, di, b[0], b[1], b[2]); mDyn.setColorAt(di, C3.set(CBOX[b[3]])); di++; }
  }
  // 卡车
  const prog = truckProg(Sd), TR = Wd.trucks;
  for (let j = 0; j < TR.NT; j++) {
    const s = isDay ? (prog - j) * 20 : nightS(j, tq), p = Wd.loop.at(s), ya = p.yaw;
    if (!isDay && j % 5) { for (const m of [TR.cab, TR.cwin, TR.chassis, TR.wheels]) setInst(m, j, 0, -50, 0, 0, .001); continue; }   // 夜里只剩 12 辆在跑
    const fx = Math.cos(ya), fz = -Math.sin(ya);
    setInst(TR.cab, j, p.x + fx * 7.5, 0, p.z + fz * 7.5, ya); setInst(TR.cwin, j, p.x + fx * 7.5, 0, p.z + fz * 7.5, ya);
    setInst(TR.chassis, j, p.x, 0, p.z, ya); setInst(TR.wheels, j, p.x, 0, p.z, ya);
    const cc = truckCarry(j, prog);
    if (cc >= 0) { setInst(mDyn, di, p.x, 2.75, p.z, ya); mDyn.setColorAt(di, C3.set(CBOX[cc])); di++; }
  }
  mDyn.count = di; mDyn.instanceMatrix.needsUpdate = true; mDyn.instanceColor.needsUpdate = true;
  for (const m of [TR.cab, TR.cwin, TR.chassis, TR.wheels]) m.instanceMatrix.needsUpdate = true;
  // 小汽车
  for (let i = 0; i < CARS.length; i++) { const c = CARS[i], x = carX(c, Sw); setInst(Wd.cars.cars, i, x, 0, c.z, c.dir > 0 ? 0 : Math.PI); setInst(Wd.cars.carT, i, x, 0, c.z, c.dir > 0 ? 0 : Math.PI); }
  Wd.cars.cars.instanceMatrix.needsUpdate = Wd.cars.carT.instanceMatrix.needsUpdate = true;
  // 码头工人
  { const P = Wd.people; P.ppl.forEach((q, i) => { const x = q.x + q.dir * ((q.v * Sw + q.ph) % 160 - 80) * .5; setInst(P.m, i, x, 0, q.z, 0); }); P.m.instanceMatrix.needsUpdate = true; }
  // 尾迹
  {
    const wk = Wd.wake, sp = tugSpeed(isDay ? S : S_STOP), dNow = td;
    for (let k = 0; k < wk.K; k++) {
      const s = k / (wk.K - 1), back = s * 70, pp = tugPose(dNow - 10 - back), tg = TUG.curve.getTangentAt(clamp((dNow - 10 - back) / TUG.L, 0, .999));
      const w = 3.5 + back * .42, nx = -tg.z, nz = tg.x;
      wk.pos.set([pp.p.x + nx * w, .05, pp.p.z + nz * w], k * 6); wk.pos.set([pp.p.x - nx * w, .05, pp.p.z - nz * w], k * 6 + 3);
      wk.uv.set([s, 0], k * 4); wk.uv.set([s, 1], k * 4 + 2);
    }
    wk.m.geometry.attributes.position.needsUpdate = wk.m.geometry.attributes.uv.needsUpdate = true;
    wk.mat.uniforms.op.value = clamp(sp / 2.2) * (td > 0 ? 1 : 0); wk.mat.uniforms.t.value = Sw;
  }
  // 白汽（汽笛）：0.45 s 内从烟囱口喷出 72 个半透明粒子，初速向上、受阻力减速、顺风漂、随机扩散，约 1.5 拍（1.25 s）内散开
  {
    const P = Wd.steam, k0 = t - T.horn; P.begin();
    if (k0 >= 0 && k0 < 1.8 && st.name === 'tug') {
      const fp = TUG.g.localToWorld(TUG.funnel.clone().divideScalar(1.25)), wx = WIND.x, wz = WIND.z;
      for (let i = 0; i < P.n; i++) {
        const b = .35 * Math.pow(i / P.n, 1.3), a = k0 - b; if (a < 0) continue;
        const life = .8 + .4 * hash(i * 1.7); const u = a / life; if (u > 1) continue;
        const h1 = hash(i * 3.3), h2 = hash(i * 5.9), h3 = hash(i * 9.1);
        const vUp = 11 + 6 * h1, drag = 2.2, up = vUp * (1 - Math.exp(-drag * a)) / drag;           // 初速向上，阻力减速
        const spread = (1.8 + 4.5 * h2) * Math.sqrt(a), th = h3 * 6.283;
        const drift = 7 * a + 3 * a * a;                                                       // 顺风越漂越快
        const p = V(fp.x + wx * drift + Math.cos(th) * spread, fp.y + .3 + up + .6 * a * a, fp.z + wz * drift + Math.sin(th) * spread);
        const size = 1.6 + 10 * Math.pow(u, .6) * (.8 + .4 * h1);
        const alpha = .4 * Math.min(1, (a + 1 / FPS) / .06) * Math.pow(1 - u, 2.2);   // 汽笛那一帧就看得见第一口汽
        P.add(p, size, alpha, h2 * 6.283 + a * (h3 - .5));
      }
    }
    P.end();
    P.mat.uniforms.lit.value.copy(sun.color).lerp(WHITE, .5); P.mat.uniforms.shade.value.copy(hemi.color).multiplyScalar(.85);
  }
  // 灯
  const night = clamp((4 - e) / 10), Lg = Wd.lights;
  const amt = { lamps: onAmt('lamps', t), boom: onAmt('boom', t), windows: onAmt('windows', t), lighthouse: onAmt('lighthouse', t), mast: onAmt('mast', t) };
  U.night.value = amt.windows;
  Lg.list.forEach((l, i) => {
    let p = l.p, a = amt[l.group] * (.35 + .65 * night);
    if (l.group === 'mast') { const off = i - Lg.mastIdx; p = TUG.g.localToWorld(V(1.2 + (off ? -1.5 : 0), 12 + (off ? -2 : 0), off === 1 ? 2.6 : off === 2 ? -2.6 : 0)); }
    if (l.group === 'lighthouse') a *= .7 + .3 * Math.sin(tq * 3.1);
    Lg.glow.set(i, p, l.col.map(c => c * a * 2.2), a > 0 ? l.size * (1 + .4 * a) * (C.pos.y > 500 ? 2 : 1) : 0);
  });
  Lg.glow.up();
  Lg.head.material.emissiveIntensity = amt.lamps * 3;
  flood.intensity = night * (amt.lamps * .2 + amt.boom * .07);
  Lg.pools.forEach((l, i) => { const a = amt[l.group] * night * .34; Lg.pmesh.instanceColor.setXYZ(i, a, a * .82, a * .55); }); Lg.pmesh.instanceColor.needsUpdate = true; Lg.pmesh.material.opacity = 1;
  // 灯塔：画框外；亮起时一道光带贴着水面从东向西扫过画面右上方的港池
  Lg.beam.material.uniforms.op.value = amt.lighthouse * night * .34; Lg.beam.material.uniforms.ang.value = .15 + 1.25 * Math.max(0, t - T.lighthouse);
  // 招牌
  const sOn = t >= T.sign ? (t - T.sign < fr(2) ? .55 : t - T.sign < fr(4) ? .3 : 1) : 0;
  Wd.sign.back.material.emissiveIntensity = sOn * 2.6; Wd.sign.back.material.emissive.set('#ffe9c4');
  // 长曝光光迹：每辆车一条独立光迹——中间暖白（头灯）、两侧红色（尾灯），各带一层宽而淡的辉光；
  // 长度每拍阶梯式增长，C12 那一拍首尾相接成闭合光框并整圈闪亮一下
  trails.begin();
  const trailI = st.name === 'night' ? clamp((7.5 - e) / 6) : 0;
  if (trailI > 0) {
    const LT = trailLen(t), fl = t >= T.final ? 1 + 1.4 * Math.exp(-(t - T.final) / .3) : 1;
    for (let j = 0; j < TR.NT; j += 5) {
      const s1 = nightS(j, tq), n = 36, pH = [], pL = [], pR = [];
      for (let k = 0; k <= n; k++) {
        const s = s1 - LT * (1 - k / n), a = Wd.loop.at(s + 7.5), b = Wd.loop.at(s - 5.5);
        const nx = Math.sin(b.yaw), nz = Math.cos(b.yaw);   // 车身法向（水平）
        pH.push([a.x, a.z]); pL.push([b.x + nx * 1.7, b.z + nz * 1.7]); pR.push([b.x - nx * 1.7, b.z - nz * 1.7]);
      }
      const I = trailI * fl * 1.5;
      trails.ribbon(pH, [1, .86, .62], I * .5, 6.5, 1.3);            // 头灯辉光
      trails.ribbon(pH, [1, .93, .8], I * 3.6, 1.0, 1.35);           // 头灯芯（暖白）
      for (const q of [pL, pR]) { trails.ribbon(q, [1, .1, .04], I * .45, 3.4, 1.05); trails.ribbon(q, [1, .16, .08], I * 3.0, .6, 1.1); }   // 尾灯：辉光 + 芯（红）
    }
  }
  trails.end();
  post.composer.render();
  drawHUD(t, clock);
}

// —— 声音/核对事件：逐帧扫描真实画面状态 ——
const EV = [];
EV.push({ type: 'grid', grid: GRID.map(([n, f]) => [n, f / FPS]) });
for (const s of SHOTS) EV.push({ type: 'vhit', name: 'cut:' + s.id, t: s.t0, grid: s.id === 'S1' ? 'A0' : s.id === 'S2' ? 'A8' : s.id === 'S3' ? 'A16' : 'C6' });
{
  let lastQ = -1, prevC = null, prevProg = null;
  const NF = Math.round(DUR * FPS);
  for (let f = 0; f <= NF; f++) {
    const t = f / FPS; if (t >= T.cut4) break;
    const tq = stepT(t); if (tq === lastQ) continue; lastQ = tq;
    const S = simAt(tq, DAY), r = rateAt(t);
    if (r >= 6 && t < T.cut4) EV.push({ type: 'step', t, rate: r });
    const cs = [0, 1, 2].map(i => craneState(i, S));
    if (prevC) cs.forEach((c, i) => {
      if (c.n > prevC[i].n) EV.push({ type: 'land', t, crane: i, x: c.cx, rate: r });
      if (c.picked > prevC[i].picked) EV.push({ type: 'pick', t, crane: i, x: c.cx, rate: r });
    });
    const pg = truckProg(S); if (prevProg !== null && Math.floor(pg + 1e-6) > Math.floor(prevProg + 1e-6)) EV.push({ type: 'trucks', t, rate: r });
    prevC = cs; prevProg = pg;
  }
}
// A 段的落箱是拍点事件（核对用）
EV.filter(e => e.type === 'land' && e.t < T.cut3 - 1e-6).forEach(e => { const b = Math.round(e.t / BEAT_A); EV.push({ type: 'vhit', name: 'land' + b, t: e.t, grid: 'A' + b }); });
// 拖船
{
  let stopT = null; for (let f = Math.round(T.cut3 * FPS); f < Math.round(T.cut4 * FPS); f++) { const t = f / FPS; if (tugSpeed(simAt(stepT(t), DAY)) <= 0) { stopT = t; break; } }
  EV.push({ type: 'vhit', name: 'tugStop', t: stopT, grid: 'A20' });
  const tR = (() => { for (let f = Math.round(T.cut3 * FPS); f < 300; f++) if (rateAt(f / FPS) <= 1.0001) return f / FPS; })();
  EV.push({ type: 'vhit', name: 'real', t: tR, grid: 'A17' });
}
GRID.push(['A20', 200]); EV[0].grid.push(['A20', T.stop]);
EV.push({ type: 'engine', t: T.engineIn }, { type: 'horn', t: T.horn }, { type: 'vhit', name: 'horn', t: T.horn, grid: 'C0' }, { type: 'steam', t: T.horn });
EV.push({ type: 'rise', t: T.rise }, { type: 'vhit', name: 'rise', t: T.rise, grid: 'C1' });
EV.push({ type: 'gull', t: fr(184) }, { type: 'gull', t: fr(232) }, { type: 'lap', t: fr(204) }, { type: 'lap', t: fr(213) });   // 第二只海鸥在汽笛后被惊起；静默里只留两下水声
{
  const c1 = cloudArrive(0, CLOUD_P[0]), c2 = cloudArrive(1, CLOUD_P[1]);
  EV.push({ type: 'cloud', t: c1 }, { type: 'vhit', name: 'cloud1', t: c1, grid: 'C2' }, { type: 'cloud', t: c2 }, { type: 'vhit', name: 'cloud2', t: c2, grid: 'C4' });
}
EV.push({ type: 'pointer', t: T.pointer }, { type: 'vhit', name: 'pointer', t: T.pointer, grid: 'A14' });
// 夜：灯组（逐帧测开灯的第一帧）
for (const [grp, gname] of [['lamps', 'C7'], ['boom', 'C8'], ['windows', 'C10'], ['lighthouse', 'C11'], ['mast', 'C12']]) {
  let tt = null; for (let f = Math.round(T.cut4 * FPS); f <= Math.round(DUR * FPS); f++) if (onAmt(grp, f / FPS) > 0) { tt = f / FPS; break; }
  EV.push({ type: 'light', t: tt, grp }, { type: 'vhit', name: 'light:' + grp, t: tt, grid: gname });
}
{ let tt = null; for (let f = Math.round(T.cut4 * FPS); f <= Math.round(DUR * FPS); f++) if (f / FPS >= T.sign) { tt = f / FPS; break; } EV.push({ type: 'sign', t: tt }, { type: 'vhit', name: 'sign', t: tt, grid: 'C9' }); }
// 长曝光光迹每拍变长（逐帧扫描 trailLen 的跳变）
{ let prev = trailLen(T.cut4); for (let f = Math.round(T.cut4 * FPS) + 1; f <= Math.round(DUR * FPS); f++) { const L = trailLen(f / FPS); if (L - prev > 2) { const b = Math.round((f / FPS - T.cut4) / BEAT_C) + 6; EV.push({ type: 'trail', t: f / FPS }, { type: 'vhit', name: 'trail:C' + b, t: f / FPS, grid: 'C' + b }); } prev = L; } }
// 夜里的世界跳帧（光迹每次更新）
for (let f = Math.round(T.cut4 * FPS); f <= Math.round(DUR * FPS); f += 5) EV.push({ type: 'nstep', t: f / FPS });

window.DUR = DUR; window.EV = EV; window.render = render;
window.READY = true;
