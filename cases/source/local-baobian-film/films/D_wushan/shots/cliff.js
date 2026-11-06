// 《豹变》D 雾山 · 南山雾崖（CLIFF）：T1 后半（俯冲穿云落到南山）、#03 卦象远景、#04 洞内看出·七日、#12 雾散·满身文采
// 远 → 近：天穹 → 七日 → 远山底板（2800 m，九五）→ 云海 / 雾 F3 → 九四雾带 → 雾 F2 + 草坡 + 鹿群 → 六二雾带（断）→ 雾 F1
//          → 崖面 + 平台 + 洞口 + 松（3D 卡通）→ 一人一豹（2D 精灵）→ 前景暗岩（初九）/ 洞口暗拱 → 雨（后期）
import * as THREE from 'three';
import { toon, bind, retint, setToonGlobals } from '../lib/toond.js';
import { makeSprite, standAt, contactShadow, rimOffset } from '../lib/sprite.js';
import { fogSheet, ribbon, cloudLayer, panoPlate, skyDome, sunDisc, glow, onScreen } from '../lib/env.js';
import { cliffFace, platform, rock, hillField, hillHeight, pineTree, archMesh, xFace, CAVE, ridgeField } from './geo.js';
import { DEG, clamp, lerp, seg, ss, ss5, eo, track, aim, s2w, w2s, hitPlaneY, pxPerM, lin3, mixHex } from '../lib/util.js';
import { GLSL as GLSL_V } from '../lib/glsl.js';
import { card, cardCol } from '../lib/card.js';

export function buildCliff(ctx) {
  const { W, H, K, tex, M } = ctx;
  const E21 = M.env.A21, E24 = M.env.A24, CARD03 = {};
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(30, W / H, .05, 9000);
  const key = new THREE.DirectionalLight('#ffffff', 1); scene.add(key, key.target);
  const sky = skyDome({ low: '#E6EEE6', high: '#D5E2DA' }); scene.add(sky);

  // ── 3D ──
  // 返修 1：竖皴加重（叠一层更宽更长的），苔点只成簇、数量减到三成，藻斑关掉
  const mRock = toon('rock_mist', { moss: .4, mossClust: .35, streak: .38, streakF: [4, .3] }), mPlat = toon('rock_mist', { moss: .35, mossClust: .5, streak: .34, streakF: [4, .3], algaeAmt: .0, step1: .6 });   // 返修 3（style-07）：侧面多落进影档，底下不再贴几块又大又平的浅色补丁
  const mDeep = toon('rock_deep', { streak: .12, edgeNoise: .07, rimColor: '#AFC3B6', rimAmt: .5, rimPower: .45, rimInside: .58 });
  // 洞口暗拱：墨绿黑（不再是海军蓝），竖皴 0.2，内缘吃一线边光
  const mArch = toon('rock_deep', { color: '#1C1F20', shade1: '#0F1614', streak: .2, rimColor: '#3F5957', rimAmt: .65, rimInside: .44, side: THREE.DoubleSide, ink: '#0B100E' });
  // 返修 2：草坡贴南山底板里绿黄的山腰笔触（侧面投影），亮档就是底板原色，影档压暗青；不再是一大片平涂橄榄灰
  const panoS = tex.pano.clone(); panoS.colorSpace = THREE.SRGBColorSpace; panoS.needsUpdate = true;
  const mPine = toon('pine'), mBark = toon('bark'), mMeadow = toon('meadow', { map: panoS, color: '#D8DDD2', shade1: '#6E827C', dabAmt: .1, rimColor: '#C8D6C8', rimAmt: .5, edgeNoise: .03, streak: .25, streakF: [1.6, .12] });
  const cliff = bind(new THREE.Mesh(cliffFace(), mRock), mRock, { group: 'cliff' }); scene.add(cliff);
  const plat = bind(new THREE.Mesh(platform(), mPlat), mPlat, { group: 'plat' }); scene.add(plat);
  const caveBack = bind(new THREE.Mesh(rock(5, 3, .25), mDeep), mDeep); caveBack.scale.set(4, 3, 3.2); caveBack.position.set(xFace(CAVE.z) + 6.5, CAVE.y, CAVE.z); scene.add(caveBack);
  // 前景暗岩沿（初九，#03 与 T1 落地）：按 #03 参考机位摆在画面下缘（y > 920），9 m 远，镜头前移时放大约 1.4 倍
  const ledge = new THREE.Group(); scene.add(ledge);
  const ledgeRocks = [...Array(7)].map((_, i) => { const r = bind(new THREE.Mesh(rock(20 + i, 4, .32, { smooth: .7 }), mDeep), mDeep, { group: 'ledge' }); ledge.add(r); return r; });
  // 松：#03 右上暗框一枝；#04 / #12 拱外探进一枝
  const mkPine = (seed, h, lean, clumps, spread, noLine = false) => {
    const t = pineTree({ seed, h, lean, clumps, spread });
    const g = new THREE.Group();
    const opt = noLine ? { outline: false } : { group: 'pine' + seed };
    g.add(bind(new THREE.Mesh(t.trunk, mBark), mBark, opt));
    for (const l of t.leaves) g.add(bind(new THREE.Mesh(l, mPine), mPine, opt));
    scene.add(g); return g;
  };
  const pine03 = mkPine(3, 6.5, [-.9, 0, -.35], 11, 2.6);
  // 草坡脊上几棵小松（雾里的剪影，脊上点苔）
  // 返修 3（v2-04）：草坡脊上的小松不描线——它们在雾里，填色被雾吃掉而墨线不被吃，就成了只剩一圈细线的"幽灵轮廓"
  const hillPines = [0, 1, 2, 3, 4].map(i => { const g = mkPine(30 + i, 4 + i % 2, [(i % 2 ? .3 : -.3), 0, .1], 6, 1.4, true); g.userData.k = i; return g; });
  const pine04 = mkPine(4, 5.5, [.2, 0, -.6], 8, 2.0);
  const meadow = bind(new THREE.Mesh(hillField({ uvSide: { u0: .05, du: .3, v0: .28, v1: .55 } }), mMeadow), mMeadow, { outline: false }); scene.add(meadow);
  // 九三：中景山脊（3D，400–650 m），脊线是一条暗线（返修 1 加回来：五层横带 = 初九暗岩沿 / 六二雾带 / 九三脊线 / 九四雾带 / 九五天际线）
  const mRidge = toon('ridge_mid', { color: '#4A7E7A', shade1: '#2A4D55', rimAmt: .35, streak: .2, streakF: [.25, .012], moss: .5, mossClust: .03, outline: .8 });
  const ridge93 = bind(new THREE.Mesh(ridgeField({ w: 1500, d: 260, nx: 240, nz: 40, hmax: 70, freq: .0035, seed: 9 }), mRidge), mRidge, { group: 'ridge93' }); scene.add(ridge93); ridge93.visible = false;
  // 返修 2：九三改成从南山底板抠出来的中景山卡（480 m）——和底板同一种画法，没有描线、没有面片直边，山脚交给雾吃掉
  const ridgeCard = panoPlate(tex.pano, { order: 1.25 }); ridgeCard.userData.u.uCrop.value.set(.02, .3, .5, .68); ridgeCard.userData.u.uEdge.value = .14; scene.add(ridgeCard);
  // 近处暗崖（#03 画右 x > 1650 的暗块，全高），松从它上面探出
  const butt = new THREE.Group(); scene.add(butt);
  for (let i = 0; i < 4; i++) { const r = bind(new THREE.Mesh(rock(60 + i, 4, .22, { smooth: .7 }), mDeep), mDeep, { group: 'butt' }); r.scale.set(1.6 + i * .2, 7 + (i % 2) * 2, 1.5); r.position.set(-2.6 + (i % 2) * .5, -6 + i * 7.5, 12.6 - i * .4); r.rotation.set(.05 * i, .6 * i, .04); butt.add(r); }

  // ── 2D / 环境 ──
  const pano = panoPlate(tex.pano, { order: 1 }); scene.add(pano);
  // 云海：山谷里的一整层（俯看是云海，平看是吃掉山脚的雾带）
  const seaA = cloudLayer({ size: 9000, lit: '#EEF2EA', shade: '#C9D5D1', under: '#B9C6C3', thr: .40, scale: 160, seed: 8, order: 1.6, feather: .16 });
  const seaB = cloudLayer({ size: 9000, lit: '#F1F4EE', shade: '#D2DCD8', under: '#C4CFCC', thr: .52, scale: 90, seed: 9, order: 1.62, feather: .14 });
  scene.add(seaA, seaB);
  const suns = [...Array(7)].map((_, i) => { const s = sunDisc({ order: .6 }); s.userData.u.uSeed.value = i * 3.1 + 1; scene.add(s); return s; });
  // 雾面：F1（近薄纱）、F2（吃坡脚）、F3 远、F3 中
  const FOGOP = [.42, .75, .6, .55];
  const fogs = [
    fogSheet({ w: 140, h: 26, col: '#D5E2DA', op: FOGOP[0], seed: 1, top: .7, ns: 9, order: 6, tear: .22 }),
    fogSheet({ w: 520, h: 70, col: '#DCE6DF', op: FOGOP[1], seed: 2, top: .55, ns: 28, order: 4.2, tear: .2 }),
    fogSheet({ w: 3600, h: 300, col: '#E2EBE4', op: FOGOP[2], seed: 3, top: .5, ns: 140, order: 1.4, tear: .16 }),
    fogSheet({ w: 1800, h: 160, col: '#DFE8E2', op: FOGOP[3], seed: 4, top: .55, ns: 80, order: 3.2, tear: .2 }),
  ];
  for (const f of fogs) scene.add(f);
  const tearFogs = [0, 1, 2, 3].map(i => { const f = fogSheet({ w: [24, 50, 120, 360][i], h: [14, 28, 60, 150][i], col: '#D5E2DA', op: .9, seed: 10 + i, top: .88, ns: [5, 10, 22, 60][i], order: 6.5 - i * .6, tear: .1, dens: .12 }); scene.add(f); return f; });
  // 卦爻落成的云带：六二（近谷，断开）、九四（中景）
  const rib62 = [...Array(6)].map((_, i) => { const r = ribbon({ seed: 20 + i, pair: i % 3 === 1, brk: .35, op: .9, order: 4.4 }); scene.add(r); return r; });
  const rib94 = [...Array(3)].map((_, i) => { const r = ribbon({ seed: 30 + i, pair: i === 1, brk: .4, op: .82, order: 3.4 }); scene.add(r); return r; });
  // T1 俯看的谷底：林地 / 草坡 / 雾的斑块（只在俯冲段，镜头抬平前淡出，远景交给底板）
  const VAL_FS = `${GLSL_V}
  uniform float uOp; varying vec2 vUv; varying vec3 vW;
  void main(){
    vec2 q = vW.xz;
    float n = fbm2(q * .006), m = fbm2(q * .02 + 7.), d = vnoise2(q * .15);
    vec3 forest = vec3(.047, .184, .2), forestL = vec3(.1, .3, .3), meadowC = vec3(.156, .2, .11), mist = vec3(.79, .855, .80);
    vec3 c = mix(forestL, forest, smoothstep(.45, .6, n));
    c = mix(c, meadowC, smoothstep(.62, .7, m) * .7);
    c = mix(c, c * .55, smoothstep(.72, .76, d) * .6);                 // 林冠点点
    float mi = smoothstep(.5, .68, fbm2(q * .004 + vec2(3., 0.)) + .25 * fbm2(vec2(q.x * .02, q.y * .004)));
    c = mix(c, mist, mi * .85);
    gl_FragColor = vec4(c, uOp);
  }`;
  const valU = { uOp: { value: 1 } };
  const valley = new THREE.Mesh(new THREE.PlaneGeometry(7000, 7000), new THREE.ShaderMaterial({ uniforms: valU, vertexShader: 'varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }', fragmentShader: VAL_FS, transparent: true, depthWrite: false }));
  valley.rotation.x = -Math.PI / 2; valley.position.set(-200, -70, -800); valley.renderOrder = .9; valley.frustumCulled = false; valley.userData.outline = false; valley.userData.outlineOccluder = false;
  scene.add(valley);
  // T1：纸云层（y = +128 / +108），第一张开一道狭长缺口
  const paperA = cloudLayer({ size: 3000, lit: '#E3D5B8', shade: '#C9C2AE', under: '#8E9C9C', thr: .38, scale: 40, seed: 5, order: 7 });
  const paperB = cloudLayer({ size: 3000, lit: '#DDE4E3', shade: '#BFCBCB', under: '#8E9C9C', thr: .5, scale: 55, seed: 6, order: 7.1, feather: .1 });
  paperA.position.y = 128; paperB.position.y = 108; scene.add(paperA, paperB);

  // ── 角色 ──
  const leo = makeSprite(tex.leoSit, tex.leoSitIn, { mode: 1, order: 12, poses: M.leoSitPoses });
  const lu = makeSprite(tex.luSit, null, { mode: 2, order: 12.2 });
  lu.setRect([0, 0, tex.luSit.image.width, tex.luSit.image.height]); lu.u.uHT.value.set(.68, .50);
  scene.add(leo.group, lu.group);
  const shLeo = contactShadow(11), shLu = contactShadow(11.1); scene.add(shLeo, shLu);
  const deer = M.deer.map(d => { const s = makeSprite(tex.deer, null, { mode: 3, order: 4.3 }); s.setRect(d.rect); scene.add(s.group); return s; });

  // ── 机位 ──
  const C03 = { pos: [-7.1, 2.9, 15.6], yaw: -4, pitch: -7, fov: 30 };
  const camRef = new THREE.PerspectiveCamera(30, W / H, .05, 9000);
  aim(camRef, C03.pos, C03.yaw, C03.pitch); camRef.updateProjectionMatrix(); camRef.updateMatrixWorld(true);
  const fwd03 = new THREE.Vector3(0, 0, -1).applyQuaternion(camRef.quaternion).setY(0).normalize();
  const right03 = new THREE.Vector3(1, 0, 0).applyQuaternion(camRef.quaternion);
  const cam03 = f => {
    const u1 = eo(seg(f, 119, 141)), u2 = seg(f, 141, 179);
    const fw = -1.9 + 1.95 * u1 + .5 * u2, rt = -.45 + .45 * u1 + .15 * u2;
    const p = new THREE.Vector3(...C03.pos).addScaledVector(fwd03, fw).addScaledVector(right03, rt);
    return { pos: p.toArray(), yaw: C03.yaw, pitch: -7.8 + .7 * u1 + .1 * u2, fov: 30 - 1.2 * (u1 * .7 + u2 * .3) };
  };
  const P119 = cam03(119);
  [[-60, 1090, .95], [230, 1110, .8], [520, 1100, .9], [800, 1130, .7], [1350, 1140, .75], [1620, 1100, .85], [1900, 1080, 1.0]].forEach(([x, y, R], i) => {
    const r = ledgeRocks[i]; r.position.copy(s2w(camRef, x, y, 9 + (i % 3) * .8)); r.scale.set(R * 1.5, R * .9, R * 1.1); r.rotation.set(.1 * i, .7 * i, .05 * i); });
  const t1track = track([
    [100, [-64, 150, -26, -84, 0, 44.2]],
    [103, [-60, 112, -18, -80, 0, 44.2]],
    [106, [-52, 78, -6, -52, -1, 44.2]],
    [110, [-36, 38, 6, -24, -2, 42]],
    [114, [-18, 12, 15, -13, -3, 36]],
    [118.999, [P119.pos[0], P119.pos[1], P119.pos[2], P119.pitch, P119.yaw, P119.fov]],
  ]);
  { let fx = 100; for (let f = 100; f < 104; f += .01) { if (t1track(f)[1] <= 128) { fx = f; break; } } const v = t1track(fx); paperA.userData.u.uHole.value.set(v[0], v[2], 9, 30); paperA.userData.u.uHoleOn.value = 1; }
  const C04 = { pos: [-1.2, 1.0, -.3], yaw: 90, pitch: 3, fov: 40 };
  const cam04ref = new THREE.PerspectiveCamera(40, W / H, .05, 9000); aim(cam04ref, C04.pos, C04.yaw, C04.pitch); cam04ref.updateProjectionMatrix(); cam04ref.updateMatrixWorld(true);
  const POS = { lu03: new THREE.Vector3(-5.6, 0, .7), leo03: new THREE.Vector3(-4.7, 0, -.5), lu04: new THREE.Vector3(-5.6, 0, .55), leo04: new THREE.Vector3(-5.5, 0, -.8) };
  const LU_H = .95, LEO_HA = .64, LEO_HB = .78;     // 返修 1：小豹坐着时头顶在陆蔚肩下（亚成年豹的体量）
  // #03 卡片的版式（#03 参考机位下）：A21 平台顶面的"坐区"中心对准一人一豹的脚，卡片和人在同一深度（后挪 0.4 m）
  { camRef.updateMatrixWorld(true);
    const mid = POS.lu03.clone().add(POS.leo03).multiplyScalar(.5), fs = w2s(camRef, mid), D = fs.z + .4;
    const sz = E21.sit_zone_px, scx = (sz[0] + sz[2]) / 2, scy = (sz[1] + sz[3]) / 2 + 18;
    const w21 = 1500, s21 = w21 / 1348;
    CARD03.c21 = { cx: fs.x - (scx - 674) * s21, cy: fs.y - (scy - 461.5) * s21, w: w21, D };
    // A24 草坡（翻转）：脊线 x≈1100（原图）落在屏幕 (470, 640)，96 m
    const w24 = 1700, s24 = w24 / 2172, cx24 = 470 + (1100 - 1086) * s24, cy24 = 640 - (190 - 345.5) * s24;
    CARD03.c24 = { cx: cx24, cy: cy24, w: w24, D: 96 };
    CARD03.crest = E24.crest_px_every16.map(([x, y]) => [cx24 - (x - 1086) * s24, cy24 + (y - 345.5) * s24]).sort((a, b) => a[0] - b[0]);
    // A20 前景暗岩：9 m，宽 2500 px，上沿（原图 y≈30）落在画面 y≈860
    CARD03.c20 = { cx: 980, cy: 860 - 30 * (2500 / 2172) + 2500 / 2172 * 571 / 2, w: 2500, D: 9 };
  }
  const crestY = x => { const C = CARD03.crest; if (x <= C[0][0]) return C[0][1]; for (let i = 1; i < C.length; i++) if (x <= C[i][0]) return lerp(C[i - 1][1], C[i][1], (x - C[i - 1][0]) / (C[i][0] - C[i - 1][0])); return C[C.length - 1][1]; };
  // 洞口暗拱（#04 / #12）
  const arch = bind(new THREE.Mesh(archMesh((x, y, D) => s2w(cam04ref, x, y, D), { open: [955, 540, 745, 745, 405, 395] }), mArch), mArch, { group: 'arch' });
  scene.add(arch);
  // 洞口内缘的两块大岩（左上悬挑、右下巨石），让暗拱有岩块的体积
  const archRocks = [[300, 95, 1.6, .75, .38], [1760, 990, 1.4, .6, .42]].map(([x, y, D, sx, sy], i) => {
    const r = bind(new THREE.Mesh(rock(70 + i, 4, .26, { smooth: .7 }), mArch), mArch, { group: 'arch' });
    r.position.copy(s2w(cam04ref, x, y, D)); r.scale.set(sx * .42, sy * .42, .45); r.rotation.set(.3 * i, .9 + i, .2); scene.add(r); return r; });
  // 返修 2（style-11）：洞口暗拱内缘挂两丛草和藤的剪影（ref_06 / ref_08 的前景）：画在一张透明画布上，当 3D 卡片挂在拱沿（1.3–1.5 m），推镜时跟着拱一起有视差
  const vineTex = (() => {
    const N = 512, cv = document.createElement('canvas'); cv.width = cv.height = N; const g = cv.getContext('2d');
    const h = (k) => { let x = (k * 374761393 + 668265263) | 0; x = Math.imul(x ^ (x >>> 13), 1274126177); x ^= x >>> 16; return (x >>> 0) / 4294967296; };
    g.lineCap = 'round';
    // 草丛：从上沿垂下来的一束细长草叶（尖头、弯）
    for (let i = 0; i < 70; i++) {
      const x0 = 50 + 380 * h(i * 3 + 1) * (.6 + .4 * h(i)), L = 90 + 380 * Math.pow(h(i * 5 + 2), 1.6), bend = (h(i * 7 + 3) - .45) * 140;
      const steps = 14;
      for (let k = 0; k < steps; k++) {
        const u0 = k / steps, u1 = (k + 1) / steps;
        const P = u => [x0 + bend * u * u, -6 + L * u];
        const [ax, ay] = P(u0), [bx, by] = P(u1);
        g.strokeStyle = '#0B1210'; g.lineWidth = 11 * (1 - u0) + 1.5; g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
        if (i % 3 === 0) { g.strokeStyle = 'rgba(70,96,92,.75)'; g.lineWidth = 1.4; g.beginPath(); g.moveTo(ax - 2, ay); g.lineTo(bx - 2, by); g.stroke(); }
      }
    }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; return t;
  })();
  const vines = [[470, 112, 1.38, 330, 1], [1430, 92, 1.42, 300, -1]].map(([x, y, D, wpx, fl]) => {
    // 写深度（alphaTest 0.35）：look 的雾按 1.4 m 的真实距离算，草叶不会被当成天空洗白
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: vineTex, transparent: false, depthWrite: true, alphaTest: .35 }));
    m.renderOrder = 7; m.frustumCulled = false; m.userData.outline = false; m.userData.outlineOccluder = 'soft';
    const wm = wpx / pxPerM(cam04ref, D);
    m.position.copy(s2w(cam04ref, x, y + wpx * .5, D)); m.quaternion.copy(cam04ref.quaternion); m.scale.set(wm * fl, wm, 1);
    scene.add(m); return m;
  });
  // #03：平台下部和崖脚各贴一张雾片（下缘柔、上缘撕边），让它们化进雾里
  const fogPlat = fogSheet({ w: 30, h: 9, col: '#D5E2DA', op: .82, seed: 31, top: .55, ns: 3, order: 6.2, tear: .28, bot: .35, dens: .14 });
  const fogFoot = fogSheet({ w: 40, h: 14, col: '#D9E3DC', op: .75, seed: 33, top: .6, ns: 4, order: 6.1, tear: .25, bot: .3, dens: .05 });
  scene.add(fogPlat, fogFoot);
  // ── 返修 4（style-07 / qa2-18 / v3-01 / qa2-01，PLAN WP-05）：#03 近景整段换成手绘卡片（画出来的东西用画）──
  //   A21 右崖壁 + 平台 + 松（人和豹坐在它的平台顶面上）、A20 前景暗岩条（压画面下缘）、A24 草坡山脊（翻转，鹿沿脊线走）；
  //   都是世界里固定的面片（正对 #03 参考机位），镜头推进时有真实视差；写深度，雨、look 的雾和描线都按真实距离处理；
  //   3D 崖面、平台、前景岩、近处暗崖、草坡、平台雾片在 #03 一律不画（#04 / #12 的洞口地面仍用 3D 平台）
  const cliffC = card(tex.cliffP, { order: 5.5, depth: true }), rockC = card(tex.rocksFg, { order: 13, depth: true }), meadowC = card(tex.meadow, { order: 4.1, depth: true });
  meadowC.userData.u.uFlip.value = 1; scene.add(cliffC, rockC, meadowC);
  const placeRef = (m, ref, cx, cy, wpx, D) => { const k = pxPerM(ref, D); m.position.copy(s2w(ref, cx, cy, D)); m.quaternion.copy(ref.quaternion); m.scale.set(wpx / k, wpx / m.userData.aspect / k, 1); };
  // 松的位置
  pine03.position.set(-2.8, 12.5, 12.2); pine03.rotation.set(.1, .5, -1.1);
  pine04.position.copy(s2w(cam04ref, 1700, 140, 13)); pine04.rotation.set(-.2, -.6, .95);

  // 背景层（按参考机位摆：远层没有视差）
  function placeBackdrop(ref, which) {
    const pu = pano.userData.u;
    if (which === '03') {
      // 九五：远山天际线 y≈300，底板宽 2600 px
      const Wp = 2900, Hp = Wp / 3; onScreen(pano, ref, 900, 300 - 158 / 724 * Hp + Hp / 2, Wp, 2800);
      pu.uCrop.value.set(0, 0, 1, 1);
      seaA.position.set(ref.position.x, -34, ref.position.z - 1500); seaB.position.set(ref.position.x, -27, ref.position.z - 1500);
      { const c = s2w(ref, 520, 652, 96); meadow.position.set(c.x, c.y + 1.2, c.z); meadow.rotation.set(0, ref.rotation.y, 0); }   // 返修 2：坡顶改圆后整体抬 1.2 m，坡脊回到原来的高度
      meadow.updateMatrixWorld(true);
      const inv = meadow.matrixWorld.clone().invert(), onHill = p => { const l = p.clone().applyMatrix4(inv); p.y = meadow.position.y + hillHeight(l.x, l.z) - .3; return p; };
      st.onHill = onHill;
      hillPines.forEach(g => { const k = g.userData.k; const p = onHill(hitPlaneY(ref, [150, 230, 700, 760, 40][k], [640, 652, 655, 648, 660][k], meadow.position.y + .2)); g.position.copy(p); g.scale.setScalar(.9 + .3 * (k % 3) / 2); g.rotation.set(0, k * 1.7, 0); });
      // 九三：中景山卡，山脊（底板天际线中位）落在屏幕 y ≈ 430、x 0–1400，480 m 远；下半交给雾
      { const asp = (.5 * 2172) / (.68 * 724), wpx = 1700, hpx = wpx / asp, rv = (1 - 158 / 724 - .3) / .68;
        onScreen(ridgeCard, ref, 640, 430 + (rv - .5) * hpx, wpx, 480, hpx);
        const ru = ridgeCard.userData.u; ru.uMul.value.set(.8, .87, .9); ru.uSat.value = .92; ru.uHaze.value.copy(lin3('#DCE6DF')); ru.uHazeAmt.value = .12; ru.uHazeLow.value = .75; ru.uHiC.value.set(.86, .91, .91); }
      // 雾面：按上沿的屏幕高度摆（F1 近薄纱、F2 吃草坡脚、F3 吃远山脚）
      placeFog(fogs[0], ref, 40, 700, 760);
      placeFog(fogs[1], ref, 170, 652, 700);
      placeFog(fogs[2], ref, 2300, 470, 900);
      placeFog(fogs[3], ref, 700, 520, 800);
      // 返修 1：云带长短不一、间距不等、略弯，卧在山谷里（六二中间断开：缺口 x 330–690）
      placeRibbonRow(ref, rib62, 145, 548, 34, [[-70, 300, 0, 1], [130, 330, -24, .5], [690, 1180, 8, 1], [770, 1060, -20, .45]], 0, st.ribUp);
      placeRibbonRow(ref, rib94, 600, 378, 20, [[-90, 520, 0, 1], [380, 1100, -15, .5], [930, 1460, 9, .7]], 0, st.ribUp);
    } else {
      // #04 / #12：往西看；V 形缺口对 (1105, 545)
      const Wp = 2000, Hp = Wp / 3;
      onScreen(pano, ref, 1105 - (1278 / 2172 - .5) * Wp, 545 - (252 / 724 - .5) * Hp, Wp, 2800);
      pu.uCrop.value.set(0, 0, 1, 1);
      seaA.position.set(ref.position.x - 1500, -48, ref.position.z); seaB.position.set(ref.position.x - 1500, -40, ref.position.z);
      placeFog(fogs[0], ref, 16, 800, 960);
      placeFog(fogs[1], ref, 160, 690, 960);
      placeFog(fogs[2], ref, 2300, 560, 960);
      placeFog(fogs[3], ref, 700, 610, 960);
    }
  }
  // 雾面：深度 D，上沿落在屏幕 yTop（设计像素），中心对屏幕 x
  function placeFog(fg, ref, D, yTop, x) {
    const u = fg.userData.u, h = fg.geometry.parameters.height;
    const top = s2w(ref, x, yTop, D);
    fg.position.set(top.x, top.y - (u.uTop.value - .5) * h, top.z);
    fg.rotation.set(0, ref.rotation.y, 0);
  }
  // 一排云带：深度 D、屏幕 y、视粗 thick（设计像素）、若干段 [x0, x1]、每段 per 条。
  //   up：0 = 平铺在谷里（俯看是宽带），1 = 立起来正对镜头（平看是一条线）；T1 拉平时 0 → 1，"五画压成纵深里的五条线"
  const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _e = new THREE.Euler();
  function placeRibbonRow(ref, list, D, y, thick, segs, per, up = 1) {
    // segs：每条云带 [x0, x1, dy, 粗细系数]（屏幕设计像素）
    let k = 0; const camP = ref.position;
    for (const [x0, x1, dy, tw] of segs) {
      if (k >= list.length) break;
      const yy = y + dy, DD = D + k * 4;
      const a = s2w(ref, x0, yy, DD), b = s2w(ref, x1, yy, DD);
      const r = list[k], mid = a.clone().add(b).multiplyScalar(.5), len = a.distanceTo(b);
      const elev = Math.atan2(camP.y - mid.y, Math.hypot(mid.x - camP.x, mid.z - camP.z));
      const tk = thick * tw;
      const wFlat = tk / pxPerM(ref, DD) / Math.max(Math.sin(elev), .04), wUp = tk / pxPerM(ref, DD);
      const ang = Math.atan2(-(b.z - a.z), b.x - a.x);
      _qa.setFromEuler(_e.set(-Math.PI / 2, 0, ang, 'XYZ'));
      _qb.setFromEuler(_e.set(0, ang, 0, 'XYZ'));
      r.position.copy(mid);
      r.quaternion.copy(_qa).slerp(_qb, up);
      r.scale.set(len, lerp(wFlat, wUp, up), 1);
      r.userData.u.uBend.value = (8 + 7 * ((k * 37) % 5) / 5) / Math.max(tk, 1);   // 中心线 ±8–15 px 的低频起伏（按粗细换算成面片坐标）
      r.visible = true; k++;
    }
    for (; k < list.length; k++) list[k].visible = false;
  }
  // 七日（#04）
  // 返修 1：每个太阳只活 7 帧（前 2 帧淡入、后 3 帧淡出），天上永远只有一个；两日之间是夜（日夜脉动加大到约 ±30%）；一个比一个淡、晕一个比一个小
  const TK = [184, 191, 200, 215, 222, 231, 237], AK = [1.00, .85, .72, .6, .47, .34, .22];
  const sunArc = s => [lerp(650, 1270, s), 340 - 115 * (1 - Math.pow((s - .5) * 2, 2))];
  const Lday = f => { let m = 0; TK.forEach((t, k) => { m = Math.max(m, (.55 + .45 * AK[k]) * Math.exp(-Math.pow((f - t) / 2.4, 2))); }); return m; };

  const st = { day: 0, sunny: 0, ribUp: 1, yaoScr: null };
  // 返修 3（T1）：五爻横带落位的世界锚点（#03 参考机位下的五层：初九暗岩沿 / 六二雾带 / 九三山脊 / 九四雾带 / 九五天际线）
  const YAO_ANCHOR = [[960, 962, 9.5], [520, 548, 145], [640, 432, 480], [700, 376, 600], [900, 300, 2800]].map(([x, y, D]) => s2w(camRef, x, y, D));
  function update(t, f, shot) {
    const fr = t * 24, f2 = f - (f % 2);
    let camP, yaw, pitch, fov, sunny = 0;
    if (shot === 2) {
      // 返修 1：f110 之后按 eo4 走完最后一段，速度一路降到 #03 开头的慢推（f118 → f119 不再一帧急停）
      const x = seg(fr, 110, 119), v1 = 0;   // 返修 4（story-06⑤）：落定末速度降到 0（最后几帧屏幕位移逐帧递减，f118→f119 ≤ 15 px）             // 三次 Hermite：进入时速度不变（g'(0)=1），离开时只剩 0.1（≈ #03 开头的慢推）
      const q = fr < 110 ? Math.max(100, fr) : 110 + 8.999 * ((v1 - 1) * x * x * x + (1 - v1) * x * x + x);
      const v = t1track(Math.min(118.999, q)); camP = [v[0], v[1], v[2]]; pitch = v[3]; yaw = v[4]; fov = v[5]; }
    else if (shot === 3) { const c = cam03(fr); camP = c.pos; yaw = c.yaw; pitch = c.pitch; fov = c.fov; }
    else if (shot === 4) { const u = ss5(seg(fr, 180, 253)); camP = [C04.pos[0] - .25 * u, C04.pos[1], C04.pos[2]]; yaw = C04.yaw; pitch = C04.pitch; fov = C04.fov; }
    else {
      const u = ss5(seg(fr, 432, 480));
      // 返修 3（v2-05）：#12 起点贴近豹背（1.55 m、略低），豹的上半身占住画面中下部（x 700–1500）；雾也薄一点，雾里透出远山的淡影
      const s0 = [POS.leo04.x + 1.55, .64, POS.leo04.z + .1];
      camP = [lerp(s0[0], C04.pos[0], u), lerp(s0[1], C04.pos[1], u), lerp(s0[2], C04.pos[2], u)];
      yaw = lerp(88, C04.yaw, u); pitch = lerp(2, C04.pitch, u); fov = lerp(36, C04.fov, u);
      sunny = ss(seg(fr, 440, 476));
    }
    cam.fov = fov; cam.updateProjectionMatrix(); aim(cam, camP, yaw, pitch);
    st.ribUp = shot === 2 ? ss(seg(fr, 107, 118)) : 1;
    if (shot === 2) { cam.updateMatrixWorld(true); st.yaoScr = YAO_ANCHOR.map(P => { const q = w2s(cam, P); return q.z > 0 ? q.y : -400; }); } else st.yaoScr = null;
    const ref = shot <= 3 ? camRef : cam04ref;
    placeBackdrop(ref, shot <= 3 ? '03' : '04');
    // 返修 4：#03 和 T1 落定（f110 起）用手绘卡片；3D 的崖面、平台、前景岩、暗崖、松、草坡在这两段不画
    const cardsOn = shot === 3 || (shot === 2 && fr >= 109);
    ledge.visible = false; pine03.visible = false; butt.visible = false; ridge93.visible = false;
    cliff.visible = shot >= 4 || (shot === 2 && fr < 109); plat.visible = shot >= 4 || (shot === 2 && fr < 109); caveBack.visible = shot >= 4;
    cliffC.visible = rockC.visible = meadowC.visible = cardsOn;
    if (cardsOn) {
      const c21 = CARD03.c21, c24 = CARD03.c24, c20 = CARD03.c20;
      placeRef(cliffC, camRef, c21.cx, c21.cy, c21.w, c21.D);
      placeRef(meadowC, camRef, c24.cx, c24.cy, c24.w, c24.D);
      const rise = shot === 2 ? 1 - ss(seg(fr, 111, 118.5)) : 0;            // 前景暗岩在 T1 落定时用 7 帧从画面下缘升上来
      placeRef(rockC, camRef, c20.cx, c20.cy + 340 * rise, c20.w, c20.D);
      const op = shot === 2 ? ss(seg(fr, 109, 113)) : 1;
      // 规则 3：越远越淡、越青；崖脚和平台下沿化进雾里（A21 自带下部雾）
      cardCol(cliffC, { op, mul: [.94, .98, 1], sat: .95, haze: '#D5E2DA', hazeAmt: .04, hazeLow: .45, hazeH: .32 });
      cardCol(meadowC, { op, mul: [.9, .96, .98], sat: .85, haze: '#DCE6DF', hazeAmt: .22, hazeLow: .5, hazeH: .45 });
      cardCol(rockC, { op, mul: [.62, .7, .72], lo: [.8, .85, .88], sat: .9, haze: '#AFC3B6', hazeAmt: 0, hazeLow: 0 });
    }
    ridgeCard.visible = shot === 3 || (shot === 2 && fr >= 109); ridgeCard.userData.u.uOp.value = shot === 2 ? ss(seg(fr, 109, 114)) : 1;
    archRocks.forEach(r => r.visible = shot >= 4); vines.forEach(v => v.visible = shot >= 4); fogPlat.visible = fogFoot.visible = false;   // 返修 4（v3-01 / qa2-01）：插进草坡的雾片去掉（草坡、平台都换成卡片，A21 自带雾脚）
    // 返修 3（style-07④）：平台下部的雾片挪到平台前沿之前（原来 20.5 m 在平台后面，被平台挡住、等于没有）；上沿压在平台侧面中段，平台下半化进雾里
    if (shot <= 3) { placeFog(fogPlat, camRef, 12.2, 805, 1120); placeFog(fogFoot, camRef, 24, 740, 1560); fogPlat.userData.u.uDrift.value.set(t * .3, 0); fogFoot.userData.u.uDrift.value.set(t * .25, 0); }
    { const rc = shot === 12 ? mixHex('#3F5957', '#C8A24A', ss(seg(fr, 470, 490))) : new THREE.Color('#3F5957'); mArch.userData.toon.uRimColor.value.copy(rc); } arch.visible = shot >= 4; pine04.visible = shot === 4 || (shot === 12 && fr >= 462);
    rib62.forEach(r => r.visible = r.visible && shot <= 3); rib94.forEach(r => r.visible = r.visible && shot <= 3);
    paperA.visible = paperB.visible = shot === 2 && fr < 109;
    valley.visible = shot === 2 && fr < 114; valU.uOp.value = 1 - ss(seg(fr, 108, 113.5));
    deer.forEach(d => d.visible(shot <= 3));
    tearFogs.forEach(fg => fg.visible = shot === 12);
    meadow.visible = false; hillPines.forEach(g => g.visible = false);
    // T1：纸云层由纸色冷却；竖雾面在俯看段淡出
    const lvl = shot === 2 ? ss(seg(fr, 106, 116)) : 1;
    if (shot === 2) { paperA.userData.u.uPaper.value = 1 - ss(seg(fr, 100, 106)); paperB.userData.u.uPaper.value = .6 * (1 - ss(seg(fr, 100, 106))); }
    fogs.forEach((fg, i) => { fg.userData.u.uOp.value = FOGOP[i] * lvl * (ctx.DBG.has('nosheet') ? 0 : 1); const D = [38, 160, 2200, 620][i]; fg.userData.u.uDrift.value.set(-t * [18, 10, 5, 5][i] / pxPerM(ref, D), 0); });
    rib62.concat(rib94).forEach((r, i) => { r.userData.u.uOp.value = (i % 3 === 1 ? .78 : .5) * (shot === 2 ? lerp(1.15, 1, lvl) : 1); });

    // ── 人物 ──
    const flip = shot >= 4;
    const luP = shot >= 4 ? POS.lu04 : POS.lu03, leoP = shot >= 4 ? POS.leo04 : POS.leo03;
    // 返修 1：换图键改成偶数帧（f484 换 B），前后用形变夹住：A 的末尾先拉高，B 的开头先压回一点
    leo.setPose(shot === 12 && f2 >= 484 ? 'B' : 'A');
    lu.clearBones(); leo.clearBones();
    const pz = M.leoSitPoses[leo.pose];
    const br = .012 * Math.sin(2 * Math.PI * (f2 / 24) / 2.0);
    leo.bone(0, pz.belly, pz.belly, 0, pz.rect[3] * .55, 0, br);
    if (shot === 4 && f2 >= 244 && f2 <= 250) { const e = [0, -12, -6, 0][Math.min(3, (f2 - 244) / 2)]; leo.bone(1, pz.ear_r, [pz.ear_r[0], pz.ear_r[1] - 25], 30, 55, e, 0); }
    leo.bone(2, pz.tail_root, pz.tail_tip, 80, 300, 3 * Math.sin(f2 / 24 * 1.3), 0);
    let leoH = LEO_HA;
    if (shot === 12) {
      if (f2 >= 470 && f2 < 484) { const k = ss(seg(f2, 470, 482)); leo.bone(3, pz.neck_root, pz.head_center, 90, 230, -lerp(4, 8, k), 0); leo.squash([pz.rect[0] + pz.rect[2] / 2, pz.rect[1] + pz.rect[3]], 1, lerp(1, 1.11, k)); }
      if (f2 >= 484) { const a = { 484: -3, 486: -1 }[f2] ?? 0; leo.bone(3, pz.neck_root, pz.head_center, 90, 230, a, 0); leoH = LEO_HB; leo.squash([pz.rect[0] + pz.rect[2] / 2, pz.rect[1] + pz.rect[3]], 1, lerp(.92, 1, ss(seg(f2, 484, 490)))); }
    }
    standAt(lu, cam, luP, LU_H, { flip }); standAt(leo, cam, leoP, leoH, { flip });
    const lk = M.luKeys;
    lu.bone(0, lk.shoulder_axis_center, lk.shoulder_axis_center, 0, 420, 0, .005 * Math.sin(2 * Math.PI * (f2 / 24) / 3.4));
    for (const [s, p, w] of [[shLu, luP, LU_H * .95], [shLeo, leoP, leoH * 1.1]]) { s.position.set(p.x, p.y + .02, p.z); s.scale.set(w, w * .32, 1); }
    const day = shot === 4 ? Lday(fr) : 0;
    leo.u.uGold.value = shot === 12 ? ss(seg(f2, 440, 476)) : 0;
    leo.u.uSpot.value = 1; leo.u.uDry.value = shot === 12 ? 1 : 0; leo.u.uCell.value = pz.cell;
    // #12 头 8 帧：接着 #11 的波前，环斑从肩到尾一枚枚收紧（每枚约 6 帧）
    if (shot === 12) { leo.u.uWave.value.set(pz.neck_root[0], pz.neck_root[1], lerp(220, 980, ss(seg(fr, 431, 442)))); leo.u.uWaveW.value = 170; } else leo.u.uWaveW.value = 0;
    { const hc = mixHex('#6E6A58', '#9C7438', leo.u.uGold.value); leo.u.uHeartCol.value.copy(lin3('#' + hc.getHexString())); }
    leo.u.uFlow.value = shot === 12 ? ss(seg(fr, 456, 462)) : 0; leo.u.uFlowT.value = ((fr - 456) / 24) % 1.7;
    const rimC = mixHex('#AFC3B6', '#F3D27A', sunny);
    for (const s of [leo, lu]) { s.u.uRimCol.value.set(rimC.r, rimC.g, rimC.b); s.u.uRimAmt.value = .6 + .3 * sunny; }
    const back = shot <= 3 ? [.80, .86, .90] : [lerp(.80, 1, sunny), lerp(.86, 1, sunny), lerp(.90, 1, sunny)];
    leo.u.uTint.value.set(...back);
    const lit = [lerp(.92, 1.05, sunny), lerp(.98, 1.0, sunny), lerp(1.0, .9, sunny)], sh = [lerp(.74, .66, sunny), lerp(.84, .74, sunny), lerp(.90, .80, sunny)];
    lu.u.uLit.value.set(...lit.map((v, i) => v * back[i])); lu.u.uShade.value.set(...sh.map((v, i) => v * back[i]));
    { const hpx = LU_H * pxPerM(cam, Math.max(.5, cam.position.distanceTo(luP))) * K; rimOffset(lu, -.3, .95, 3.5 * K, hpx); lu.u.uInkGrow.value = clamp(1.3 * K * tex.luSit.image.height / Math.max(hpx, 1), 0, 7); }
    { const hpx = leoH * pxPerM(cam, Math.max(.5, cam.position.distanceTo(leoP))) * K; rimOffset(leo, -.3, .95, 3.5 * K, hpx); }
    shLu.material.uniforms.uA.value = shLeo.material.uniforms.uA.value = shot === 4 ? .2 + .25 * day : .4;

    // ── 鹿群（#03）──
    if (shot <= 3) {
      const sc = [.62, .90, .95, 1.0, 1.05];
      M.deer.forEach((d, i) => {
        const s = deer[i];
        const sx = 300 + i * 62 + 38 * (t - 4.96) * (1 + i * .03), sy = 628 - i * 7;
        const foot = s2w(camRef, sx, crestY(sx) + 4, CARD03.c24.D - 1); void sy;   // 返修 4：鹿沿 A24 的脊线走
        standAt(s, cam, foot, 1.75 * sc[i]);   // 返修 2（v1-11）：鹿缩到画面上约 30–36 px 高，和松、人的比例对上
        const ph = f2 + i * 2, dir = Math.floor(ph / 4) % 2 ? 1 : -1;
        s.u.uShear.value.set(Math.tan(10 * DEG) * dir * .9, d.waist);
        s.group.position.y += (Math.floor(ph / 2) % 2) * .05;
        s.u.uSilCol.value.copy(lin3('#2E3A40'));
      });
    }

    // ── 太阳 ──
    suns.forEach(s => s.visible = false);
    if (shot === 4) {
      TK.forEach((tk, k) => {
        const s = (fr - tk + 3.5) / 7;
        if (s < 0 || s > 1) return;
        const fade = Math.min(ss(seg(fr, tk - 3.5, tk - 1.5)), 1 - ss(seg(fr, tk + .5, tk + 3.5)));
        const [x, y] = sunArc(clamp(s));
        const sun = suns[k], u = sun.userData.u; sun.visible = true;
        onScreen(sun, cam04ref, x, y, 280, 3500, 280);
        u.uR.value = 52 / 140; u.uStretch.value = 1.25; u.uA.value = AK[k] * fade * .8;
        u.uDisc.value.copy(lin3('#F3E6BE')); u.uCore.value.copy(lin3('#FFF3D2')); u.uHalo.value.copy(lin3('#F2DDAA')); u.uHaloA.value = .4 * (1 - k / 6);
      });
    }
    if (shot === 12) {
      const sun = suns[6], u = sun.userData.u; sun.visible = true;
      const rise = ss(seg(fr, 436, 452));
      onScreen(sun, cam04ref, 1105, 545 - 40 * ss(seg(fr, 436, 490)), 440, 3500, 440);
      u.uR.value = 64 / 220; u.uStretch.value = 1; u.uA.value = lerp(.21, 1, rise);
      u.uDisc.value.copy(lin3('#F6E9C4')); u.uCore.value.copy(lin3('#FFF3D6')); u.uHalo.value.copy(lin3('#FFD98A')); u.uHaloA.value = .5;
    }
    // ── 雾散（#12）──
    if (shot === 12) {
      const k = eo(seg(fr, 436, 470));
      tearFogs.forEach((fg, i) => {
        const D = [10, 20, 40, 60][i];
        fg.position.copy(s2w(cam04ref, 960, 690 - i * 30, D)); fg.rotation.set(0, cam04ref.rotation.y, 0);
        const u = fg.userData.u;
        u.uOp.value = lerp(.62, .2, k) * (i === 0 ? .8 : 1);
        u.uHole.value.set((1105 - 960) / (fg.geometry.parameters.width * pxPerM(cam04ref, D)) + .5, k * (.18 + i * .1), .4, 0);
        const cc = mixHex('#BFCBCB', '#E9EEE6', k); u.uCol.value.set(cc.r, cc.g, cc.b); u.uColTop.value.set(cc.r, cc.g, cc.b);
      });
    }
    // ── 材质与色：雨崖 → 晴崖 ──
    for (const m of [mRock, mPlat]) retint(m, '#' + mixHex('#5E7F7B', '#3A706C', sunny).getHexString(), '#' + mixHex('#2B4047', '#1B2F38', sunny).getHexString(), '#' + mixHex('#AFC3B6', '#E8C45C', sunny).getHexString());
    const fogC = shot === 4 ? mixHex('#8E9C9C', '#D5E2DA', .35 + .65 * day) : shot === 12 ? mixHex('#D5E2DA', '#E9EEE6', sunny) : new THREE.Color('#D5E2DA');
    for (const fg of fogs) { fg.userData.u.uCol.value.set(fogC.r, fogC.g, fogC.b); fg.userData.u.uColTop.value.set(fogC.r, fogC.g, fogC.b); }
    const sl = seaA.userData.u; sl.uLit.value.copy(lin3('#' + mixHex('#EEF2EA', '#F6EBCB', sunny).getHexString())); sl.uShade.value.copy(lin3('#' + mixHex('#C7D3CF', '#BFD0C8', sunny).getHexString()));
    // 云海只在俯冲段：俯看是云海，拉平时（f110–f117）散开，露出层层远山
    const seaK = shot === 2 ? 1 - ss(seg(fr, 102.5, 106.5)) : 0;
    seaA.visible = seaB.visible = seaK > .001;
    sl.uOp.value = .95 * seaK; sl.uOff.value.set(t * 3, 0);
    { const s2 = seaB.userData.u; s2.uLit.value.copy(sl.uLit.value); s2.uOp.value = sl.uOp.value * .85; s2.uOff.value.set(t * 5, t * 1.2); }
    // 草坡在俯冲段藏在云下，拉平时从云里浮上来
    // 草坡在俯冲段藏在云下，拉平的最后几帧才浮上来（别在画面正中顶成一块圆丘）；坡上的小松跟着一起升降
    // 返修 2：草坡不再从云下往上浮（浮的时候被雾洗成一个半透明的灰盒子）：一直在原位，俯冲段被云海和谷底雾盖着
    // 草坡在俯冲段藏在雾下，拉平的最后 3 帧才从雾里浮上来（不在画面正中顶出一块半透明的大圆丘）；坡上的松、鹿等它浮出来再露
    if (shot === 2) deer.forEach(d => d.visible(fr >= 113));
    const skyLow = shot === 12 ? mixHex('#E6EEE6', '#F3EBD0', sunny) : shot === 4 ? mixHex('#B9C4C2', '#E6EEE6', .4 + .6 * day) : new THREE.Color('#E6EEE6');
    const skyHigh = shot === 12 ? mixHex('#D5E2DA', '#F6E9C4', sunny) : shot === 4 ? mixHex('#A6B3B2', '#D5E2DA', .4 + .6 * day) : new THREE.Color('#D5E2DA');
    sky.userData.u.uLow.value.set(skyLow.r, skyLow.g, skyLow.b); sky.userData.u.uHigh.value.set(skyHigh.r, skyHigh.g, skyHigh.b);
    const pu = pano.userData.u;
    pu.uHaze.value.copy(lin3('#E6EEE6'));
    pu.uHazeAmt.value = shot === 12 ? lerp(.38, .0, sunny) : shot === 4 ? .36 - .12 * day : .08;
    // 远山饱和度：#03 卦象远景要青绿分明（ref_05 / ref_07），#04 雨夜更灰；豹变以后回到原色
    pu.uSat.value = shot === 12 ? lerp(.65, .9, sunny) : shot === 4 ? .65 : .88; pu.uMul.value.set(lerp(.93, 1, sunny), 1, lerp(.92, 1, sunny));
    // 逆光：#03 光从北偏东的高处来（朝西的崖面落进影档，只留硬亮边）；#04 / #12 光从西边天上来
    const kd = shot <= 3 ? new THREE.Vector3(.35, .55, -.8) : new THREE.Vector3(-.85, .45, -.15 + .25 * sunny);
    key.position.copy(kd.normalize()); key.target.position.set(0, 0, 0); key.updateMatrixWorld();
    setToonGlobals({ keyDir: kd.toArray(), skyDir: [0, 1, 0], skyGain: 1, inkTime: Math.floor(f / 2) });
    st.day = day; st.sunny = sunny;
    if (ctx.DBG.has('panoonly')) scene.children.forEach(o => { if (o !== pano && o !== sky && !o.isLight) o.visible = false; });
    // 自检用（门禁不带）：?dbg=hide:ridge93,hide:valley… 逐层关掉
    if (ctx.DBG.size) { const Hd = { ridge93: [ridgeCard], valley: [valley], sea: [seaA, seaB], fogs, rib: rib62.concat(rib94), meadow: [meadow], paper: [paperA, paperB], fogPF: [fogPlat, fogFoot], pano: [pano], cliff: [cliff], plat: [plat], ledge: [ledge], hillPines, cliffC: [cliffC], rockC: [rockC], meadowC: [meadowC] };
      for (const k in Hd) if (ctx.DBG.has('hide:' + k)) Hd[k].forEach(o => o.visible = false); }
  }

  function look(t, f, shot) {
    const fr = t * 24;
    const OL = { width: 2.4, color: '#1C2622', wobble: .7, warp: 70, boilFps: 12, pressure: .35, breakup: .12, inner: .5, farScale: .5, tint: .2, darken: .5, fogFade: .9, near: 5, far: 600 };
    const fog = { color: '#CBD6D0', colorHigh: '#DDE5DF', density: .0028, start: 8, max: .8, baseHeight: -14, falloff: 70, cutoff: 2200, sky: 0 };
    const grade = { exposure: 1, warmth: -.12, lift: [.020, .035, .040], gamma: 1, gain: .98, saturation: .9, shoulder: .9 };
    const bloom = { strength: .25, threshold: .85, radius: .65, tint: '#F4F1E0' };
    const kuw = { radius: 2, farRadius: 4.5, farStart: 40, farEnd: 800, strength: .85, protect: null };
    const paper = { strength: .03 }; let vignette = .18;
    if (shot === 2) {
      const k = seg(fr, 100, 112);
      grade.exposure = lerp(1.2, 1, seg(fr, 100, 118)); grade.warmth = lerp(.28, -.12, k); grade.saturation = lerp(1.06, .9, k);
      bloom.strength = lerp(.6, .25, k); paper.strength = lerp(.08, .03, seg(fr, 100, 112));
    }
    if (shot === 4) {
      const d = st.day;
      grade.exposure = .94 + .10 * d - .06 * ss(seg(fr, 240, 253)); grade.warmth = -.12 + .15 * d;
      fog.color = '#' + mixHex('#8E9C9C', '#D5E2DA', d).getHexString(); fog.colorHigh = '#' + mixHex('#9AA8A7', '#DDE5DF', d).getHexString();
      OL.near = 2;
    }
    if (shot === 12) {
      const s = st.sunny, w = ss5(seg(fr, 440, 470));
      grade.warmth = lerp(-.12, .14, w); grade.saturation = lerp(.9, 1.0, w); grade.exposure = lerp(1, 1.03, s);
      bloom.strength = lerp(.25, .5, s);
      fog.density = lerp(.0028, .0008, seg(fr, 432, 480)); fog.color = '#' + mixHex('#CBD6D0', '#E6EEE6', s).getHexString(); fog.colorHigh = '#' + mixHex('#DDE5DF', '#F1EEDF', s).getHexString();
      OL.near = 2;
    }
    return { outline: OL, fog, grade, bloom, kuwahara: kuw, paper, vignette };
  }
  function post(t, f, shot) {
    const fr = t * 24;
    const p = {};
    if (shot === 2) { p.uRain = ss(seg(fr, 106, 112)); p.uRainT = t; p.uRainD = [2, 6, 15]; }
    if (shot === 3) { p.uRain = 1; p.uRainT = t; p.uRainD = [2, 6, 15]; p.uSplash = .05; p.uSplashT = t; }
    if (shot === 4) {
      p.uRain = 1 + .5 * ss(seg(fr, 230, 253)); p.uRainT = t; p.uRainTilt = lerp(10, 18, ss(seg(fr, 230, 253))) * DEG; p.uRainD = [6, 12, 25];
      p.uWetInk = ss(seg(fr, 248, 253)); p.uGoldOmen = ss(seg(fr, 248, 253)) * (1 - ss(seg(fr, 254, 257))); p.uSplash = .04; p.uSplashT = t; p.uSplashNear = 3;   // 墨甩期间 A 画面关掉金色预兆
    }
    if (shot === 12) {
      p.uRain = 1 - ss(seg(fr, 432, 440)); p.uRainT = t; p.uRainD = [3, 8, 25];
      p.uGod = .35 * ss(seg(fr, 444, 470)) - .08 * ss(seg(fr, 470, 493)); p.uGodPos = [1105, 545 - 40 * ss(seg(fr, 436, 490))]; p.uGodThr = .9;
    }
    return p;
  }
  return { scene, camera: cam, update, look, post, st };
}
