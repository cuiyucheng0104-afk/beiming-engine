// 渡 · 唯一的镜头场景：A 路线页面（shots/s1.js，three r170 + WebGL）与离屏出片（offscreen.mjs，three r187 + WebGPU）共用这一份。
// 不 import three，也不 import 顶层 import 了 three 的模块（engine/form、engine/shade、engine/stage）：THREE 由调用方注入，两边建出同一个场景。
// 只用两边都有、离屏已对拍过的东西：MeshToonMaterial（彩色色阶贴图）、MeshBasicMaterial（顶点色、贴图）、一盏平行光；
// 不用自写着色器、实例化、半透明、精灵、雾（离屏 M2 不支持，见 docs/offscreen/README.md 7.6–7.7）。
//
//   buildScene({ THREE, W, H, sky }) → { scene, camera, update(f) }
//     sky   天空底板 sky_dawn 的贴图（sRGB、线性过滤、不建 mip；行序按 three 的约定，v = 1 是图片上沿），由调用方读好交进来
//     update(f)  按帧号摆好镜头与舟（确定：只取决于 f）
// 单位：米。构图（1920×1080）：地平线在下三分线 y ≈ 720，孤峰在右三分线；舟从左入画，划向孤峰左边的伴礁，停桨，静止。
// 时间（帧，24 fps，共 96 帧）：起 0–24 静水；承 24–60 入画划桨；转 60–78 停桨滑行；合 78–96 静止，只剩墨线沸腾。
// 镜头缓推（一拍一）；舟的起伏与桨一拍二。确定性：没有随机数，形状的起伏全是固定的三角函数。
const F_IN = 24, F_STOP = 60, F_SETTLE = 78, N = 96;
export const FRAMES = { in: F_IN, stop: F_STOP, settle: F_SETTLE, count: N };

// 色指定：只用画风 beiming-original@v1 的色板（engine/style/beiming-original.v1.json 与模版 world.js 的 PAL）。
// 每样东西三档：亮 / 一影 / 二影，阴影换色相（往天空的蓝紫走）而不压黑。色阶贴图按 sRGB 存、GPU 解码，三档颜色是绝对给定的。
const PAL = {
  rock: ['#2C2F58', '#454A80', '#7D78B8'],
  rockFar: ['#454A80', '#6F6AAB', '#A79AD6'],          // 伴礁：比主峰浅一档（远浅近深）
  reef: ['#2C2F58', '#454A80', '#5F5394'],
  hull: ['#25223D', '#3A3556', '#6E7BA8'],
  canopy: ['#1F2748', '#2E2B4A', '#4B5A88'],
  rower: ['#25223D', '#343D69', '#9A8FA8'],
  oar: ['#25223D', '#3A2F4E', '#9A8FA8'],
  waterNear: '#353866', waterMid: '#6F6AAB', waterFar: '#DDB0C4',
};

const ss = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const seg = (f, a, b) => Math.min(1, Math.max(0, (f - a) / (b - a)));
const hold2 = f => Math.floor(f / 2) * 2;

export function buildScene({ THREE, W, H, sky }) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(20, W / H, 1, 40000);
  const C0 = new THREE.Vector3(-30, 9, 420), C1 = new THREE.Vector3(-27, 9.2, 400);   // 缓推 20 m、右移 3 m

  // 机位朝向：孤峰（轴线 40% 高处）落在右三分线，地平线落在下三分线。先定屏幕位置，再反算偏航与俯仰；朝向全片不变，只推
  const tanV = Math.tan(10 * Math.PI / 180), tanH = tanV * W / H;
  const peak = new THREE.Vector3(0, 28, 0).sub(C0);
  const yaw = Math.atan2(peak.x, -peak.z) - Math.atan(tanH / 3);   // 右三分线：视线往左偏 atan(tanH/3)
  const pitch = Math.atan(tanV / 3);                               // 地平线在中线下方 1/6 画高处：视线上仰
  camera.rotation.set(pitch, -yaw, 0, 'YXZ');

  // 卡通材质：three 的卡通着色只读色阶贴图的 R 通道，所以三档颜色这样给——自发光 = 二影，基色 = 亮 − 二影，色阶 = (0, g, 1)，
  // 平行光强度 π 抵掉 Lambert 的 1/π：二影与亮两档逐通道等于色板，一影按三通道的平均比例取中间档（换色相保留，误差见 TREATMENT.md）
  const ramps = [];
  const toon = cols => {
    const [c0, c1, c2] = cols.map(h => new THREE.Color(h));
    const g = ['r', 'g', 'b'].reduce((a, k) => a + (c1[k] - c0[k]) / (c2[k] - c0[k]), 0) / 3;
    const ramp = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255, Math.round(g * 255), 0, 0, 255, 255, 0, 0, 255]), 3, 1, THREE.RGBAFormat);
    ramp.minFilter = ramp.magFilter = THREE.NearestFilter; ramp.needsUpdate = true;
    ramps.push(ramp);
    return new THREE.MeshToonMaterial({ color: c2.clone().sub(c0), emissive: c0, gradientMap: ramp });
  };
  const sun = new THREE.DirectionalLight(0xffffff, Math.PI);       // 晨光从右后方低低地来：右侧受光、正面一影、左侧二影
  sun.position.set(0.8, 0.35, -0.45).multiplyScalar(1000);
  scene.add(sun, sun.target);

  // 峰：车削出下宽上窄、顶部圆钝的轮廓，一级级往里收成台阶；再按角度与高度起伏出竖向褶皱（卡通分档切出皴面，深度折痕出内部墨线）
  const peakGeo = (prof, folds, amp, lean) => {
    const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 48, Math.PI);   // 接缝放在背面
    const p = g.attributes.position, top = prof[prof.length - 1][1];
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), a = Math.atan2(x, z), h = y / top;
      const k = 1 + amp * (Math.sin(folds * a + 3 * h) * 0.7 + Math.sin(2.3 * folds * a - 5 * h) * 0.3);
      p.setXYZ(i, x * k + lean * h * h * top, y, z * k);
    }
    g.computeVertexNormals();
    return g;
  };
  const geos = [];
  const mesh = (geo, mat, pos, rot = [0, 0, 0], userData = {}) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos); m.rotation.set(...rot); Object.assign(m.userData, userData);
    geos.push(geo);
    return m;
  };
  const main = peakGeo([[22, -2], [21, 9], [18, 13], [17, 26], [13, 30], [12, 43], [9, 48], [7, 58], [4, 66], [1.5, 70], [0, 70.5]], 7, 0.09, -0.08);
  scene.add(mesh(main, toon(PAL.rock), [0, 0, 0], [0, 0.4, 0], { outline: true }));
  const side = peakGeo([[11, -2], [10, 6], [8.5, 9], [8, 17], [5.5, 21], [4, 26], [1.5, 29], [0, 29.5]], 6, 0.11, 0.12);
  scene.add(mesh(side, toon(PAL.rockFar), [-44, 0, 10], [0, 1.1, 0], { outline: true }));
  const reef = peakGeo([[9, -1.5], [8.5, 2], [6, 4.5], [3, 6.5], [0, 7]], 5, 0.14, 0.3);
  scene.add(mesh(reef, toon(PAL.reef), [26, 0, 24], [0, 2.0, 0], { outline: true }));

  // 水：一块真的水平面，顶点色从近处的暗到远处倒映地平线的粉（不描边、实心挡线）。行距越远越疏，近处的渐变不起台阶
  const zs = [450, 430, 400, 360, 300, 220, 120, 0, -200, -500, -1000, -2000, -4000, -8000, -14000];
  const cNear = new THREE.Color(PAL.waterNear), cMid = new THREE.Color(PAL.waterMid), cFar = new THREE.Color(PAL.waterFar), tmp = new THREE.Color();
  const wPos = [], wCol = [], wIdx = [];
  zs.forEach((z, r) => {
    const u = Math.min(1, Math.max(0, (420 - z) / 6000)) ** 0.45;
    tmp.copy(cNear).lerp(cMid, Math.min(1, u * 2)).lerp(cFar, Math.max(0, u * 2 - 1));
    for (const x of [-16000, 16000]) { wPos.push(x, 0, z); wCol.push(tmp.r, tmp.g, tmp.b); }
    if (r) wIdx.push(2 * r - 2, 2 * r - 1, 2 * r, 2 * r - 1, 2 * r + 1, 2 * r);   // 从上方看是逆时针（正面朝上）
  });
  const waterGeo = new THREE.BufferGeometry();
  waterGeo.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3));
  waterGeo.setAttribute('color', new THREE.Float32BufferAttribute(wCol, 3));
  waterGeo.setIndex(wIdx);
  const water = mesh(waterGeo, new THREE.MeshBasicMaterial({ vertexColors: true }), [0, 0, 0]);
  scene.add(water);

  // 天空底板：离相机 15000 m 的竖直面片，正对起始视线；底边（画好的地平线）压在真地平线下、被水面挡住。翻转后地平线辉光在右，和光向一致
  const skyGeo = new THREE.PlaneGeometry(1, 1), uvs = skyGeo.attributes.uv;
  for (let i = 0; i < uvs.count; i++) uvs.setX(i, 1 - uvs.getX(i));
  const skyMesh = mesh(skyGeo, new THREE.MeshBasicMaterial({ map: sky }), [0, 0, 0], [0, -yaw, 0]);
  const fwd = new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw)), D = 15000, sw = 2 * D * tanH * 1.35, sh = sw / 2;
  skyMesh.position.copy(C0).addScaledVector(fwd, D).setY(sh / 2 - 260);
  skyMesh.scale.set(sw, sh, 1);
  scene.add(skyMesh);

  // 舟：乌篷小舟（离相机约 170 m），船身、篷、艄公同组（相接处不出内线，只留外轮廓与折痕）；桨单独描边，划过船身时线照常出
  const boat = new THREE.Group();
  const hull = new THREE.BoxGeometry(10, 1.3, 2.6, 10, 1, 2), hp = hull.attributes.position;
  for (let i = 0; i < hp.count; i++) {   // 两头收窄、上翘
    const x = hp.getX(i), e = (Math.abs(x) / 5) ** 2;
    hp.setZ(i, hp.getZ(i) * (1 - 0.75 * e)); hp.setY(i, hp.getY(i) + (hp.getY(i) < 0 ? 0.9 * e : 0.35 * e));
  }
  hull.computeVertexNormals();
  boat.add(mesh(hull, toon(PAL.hull), [0, 0.35, 0], [0, 0, 0], { outline: true, outlineGroup: 'boat' }));
  boat.add(mesh(new THREE.CylinderGeometry(1.25, 1.25, 3.8, 20, 1, false, 0, Math.PI), toon(PAL.canopy), [0.6, 1.0, 0], [0, 0, Math.PI / 2], { outline: true, outlineGroup: 'boat' }));
  const rower = new THREE.Group(); rower.position.set(-3.4, 1.0, 0);
  rower.add(mesh(new THREE.CylinderGeometry(0.32, 0.55, 1.7, 14), toon(PAL.rower), [0, 0.85, 0], [0, 0, 0], { outline: true, outlineGroup: 'boat' }));
  rower.add(mesh(new THREE.SphereGeometry(0.36, 16, 10), toon(PAL.rower), [0, 1.95, 0], [0, 0, 0], { outline: true, outlineGroup: 'boat' }));
  rower.add(mesh(new THREE.ConeGeometry(0.75, 0.45, 18), toon(PAL.canopy), [0, 2.3, 0], [0, 0, 0], { outline: true, outlineGroup: 'boat' }));   // 斗笠
  boat.add(rower);
  const oar = new THREE.Group(); oar.position.set(-4.6, 1.4, 0.6);
  oar.add(mesh(new THREE.BoxGeometry(0.16, 0.16, 5.2), toon(PAL.oar), [0, 0, 1.6], [0, 0, 0], { outline: true }));
  boat.add(oar);
  scene.add(boat);

  // 舟的路径：在离相机约 170 m 的 z = 250 线上走。入画前停在画左边外；停下时船头压在伴礁脚前（从起始机位看过去，两者在屏幕上叠住）。
  // 两端都由起始机位的视线反算（改构图不用手调数字）
  const Z = 250, ray = (ndcX, ndcY) => {
    camera.position.copy(C0); camera.updateMatrixWorld();
    const d = new THREE.Vector3(ndcX, ndcY, 0.5).unproject(camera).sub(C0);
    return C0.x + d.x * (Z - C0.z) / d.z;
  };
  const side0 = new THREE.Vector3(-44 + 4, 0, 10).project((camera.position.copy(C0), camera.updateMatrixWorld(), camera));
  const X0 = ray(-1, -0.36) - 5,   // 船头贴着画框左边（舟长 10 m）；从 F_IN - 1 起步，第 24 帧船头刚露出来，和第一桨的水声同帧
    X2 = ray(side0.x, side0.y) - 2, X1 = X2 - 7;
  const boatX = f => {
    if (f <= F_IN - 1) return X0;
    if (f <= F_STOP) return X0 + (X1 - X0) * seg(f, F_IN - 1, F_STOP);
    const u = seg(f, F_STOP, F_SETTLE); return X1 + (X2 - X1) * (1 - (1 - u) * (1 - u));   // 滑行：二次减到 0
  };

  function update(f) {
    const u = ss(f / (N - 1));
    camera.position.lerpVectors(C0, C1, u);
    camera.updateMatrixWorld();
    const h = hold2(f), calm = 1 - 0.8 * ss(seg(f, F_STOP, F_SETTLE + 10));   // 停桨后起伏渐小，静止段仍有一点点呼吸
    boat.position.set(boatX(f), 0.12 * Math.sin(h * 0.33) * calm, Z);
    boat.rotation.set(0.025 * Math.sin(h * 0.27 + 1) * calm, 0, 0.012 * Math.sin(h * 0.21) * calm);
    // 桨：承段每 16 帧一桨（一拍二）；停桨时抬起收在船舷，之后不动
    const stroke = Math.sin(h * Math.PI * 2 / 16), rest = ss(seg(f, F_STOP, F_STOP + 8));
    oar.rotation.set(-0.45 + 0.25 * stroke * (1 - rest) + 0.25 * rest, 0.35 * stroke * (1 - rest) - 0.2 * rest, 0);
    rower.rotation.set(0, 0, 0.12 * stroke * (1 - rest) - 0.05 * rest);
    scene.updateMatrixWorld();
  }
  update(0);

  return { scene, camera, update, dispose() { for (const g of geos) g.dispose(); for (const r of ramps) r.dispose(); scene.traverse(o => o.material?.dispose?.()); } };
}
