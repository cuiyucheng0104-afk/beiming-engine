// 夜班火车回家 —— 一个灯盒、一个场景、一条连续的镜头。render(t) 只依赖 t（确定性）。
import * as THREE from 'three';
import { Pipe } from './post.js';
import { stage, aim } from './stage.js';
import { sheet, skyPanel, moon, setMoon, text, paint, tex } from './paper.js';
import { range, carve, pine, grass, trainBody, TRAIN, houseBody, HOUSE, figureBody, armShape, SHOULDER, puff, cut, FONT } from './art.js';
import { lightbox } from './room.js';
import { ss, seg, eio, eo, ei, lerp, clamp, monotone, mulberry, track } from './lib.js';
import * as TL from '../timeline.js';

const Q = new URLSearchParams(location.search), SSAA = +(Q.get('ssaa') || 2);
const H = TL.HIT;
const FW = .598, FH = .338;                 // 满幅纸层（不大于灯腔 0.60 × 0.34）

await document.fonts.load('40px MaShanZheng', '桐溪站回家归');

// —— 舞台 ——
const MN = [-.03, .068, -.14];              // 月亮 = 背光点
const S = stage({ light: MN, lightR: .25, lightCol: '#ffd398', key: 0, keyCol: '#d8deff', keyPos: [0, .36, .32], keyTarget: [0, -.04, -.09], amb: .2, ambCol: '#7d8fc8', fov: 26 });
const { U, scene } = S;
U.uLit.value = 1;

const sky = S.add(skyPanel({ w: FW, h: FH, z: -.145, stops: [[0, '#0b1a30'], [.55, '#19325c'], [1, '#30507e']], stars: 170, starMinY: -.02, gain: 1 }));
const mn = S.add(moon({ x: MN[0], y: MN[1], z: MN[2], r: .03, gain: 2.0, halo: 5, haloGain: .4 }));
const MOON0 = .02, COOL = new THREE.Color(.055, .075, .14);
const moonRim = new THREE.Mesh(new THREE.RingGeometry(.0296, .0312, 96), new THREE.MeshBasicMaterial({ color: new THREE.Color('#9db4ea').multiplyScalar(.5), transparent: true, depthWrite: false }));
moonRim.position.set(MN[0], MN[1], MN[2] + .0002); scene.add(moonRim);
let moonK = MOON0;

const L = {};   // 纸层
const lay = (id, o) => (L[id] = S.add(sheet({ U, w: FW, h: FH, ...o })), L[id].userData.trans0 = o.trans, L[id]);

// L1 最远山：平台 [-.09, .035] 高 .04（第一段轨道）
lay('l1', { z: -.125, trans: .9, warm: 1, ppm: 3600, draw: x => {
  x.fillStyle = '#88a6cf';
  const at = range(x, [[-.3, .085], [-.24, .11], [-.17, .075], [-.12, .05], [-.095, .04], [.04, .04], [.07, .055], [.13, .1], [.2, .078], [.26, .095], [.3, .07]], { seed: 2, flat: [-.095, .04] });
  carve(x, at, -.3, -.12, { n: 3, seed: 4 }); carve(x, at, .09, .3, { n: 3, seed: 6 });
  x.fillStyle = '#6f8bb6'; x.fillRect(-.1, .0392, .145, .0009);                            // 远处的铁轨
} });
// L2：左右两座山把第一段藏住；中间山腰一道平台 y = -.005（第二段轨道）
lay('l2', { z: -.103, trans: .72, warm: .95, ppm: 3600, draw: x => {
  x.fillStyle = '#5d7cb0';
  const at = range(x, [[-.3, .06], [-.2, .085], [-.12, .072], [-.09, .058], [-.07, .03], [-.02, .026], [.02, .028], [.035, .058], [.08, .072], [.16, .05], [.22, .066], [.3, .045]], { seed: 5 });
  carve(x, at, -.3, -.09, { n: 3, seed: 7 }); carve(x, at, .04, .3, { n: 3, seed: 8 });
  x.fillStyle = '#4b6799'; x.fillRect(-.08, -.0058, .23, .0012);
} });
// L3：藏住第二段两端；站屋背后的山；第三段的路基
lay('l3', { z: -.08, trans: .5, warm: .85, ppm: 3800, draw: x => {
  x.fillStyle = '#3c5688';
  const at = range(x, [[-.3, .035], [-.17, .045], [-.09, .03], [-.06, .02], [-.045, -.02], [.12, -.02], [.14, .022], [.19, .034], [.25, .02], [.3, .03]], { seed: 9 });
  carve(x, at, -.3, -.07, { n: 2, seed: 10, dy: .014 }); carve(x, at, .14, .3, { n: 2, seed: 11, dy: .014 });
  x.fillStyle = '#2f4675'; x.fillRect(-.3, -.0665, .6, .0014);
  for (const [px, h] of [[-.25, .05], [-.21, .04], [.27, .045]]) pine(x, px, -.07, h, px * 100 | 0);
} });

// —— 站屋（门、窗、人影）——
const HX = .216, HY = -.068;
const house = S.add(sheet({ U, w: .1, h: .08, x: HX, y: HY + .03, ax: 0, ay: -.03, z: -.079, trans: .3, ppm: 6000, draw: x => { x.translate(0, -.03); houseBody(x); } }));
house.userData.trans0 = .3;
const glowMat = c => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(0), toneMapped: false });
const glowPlane = (w, h, x, y, z, col) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), glowMat(col)); m.position.set(x, y, z); m.userData.col = new THREE.Color(col); scene.add(m); return m; };
const setGlow = (m, k) => m.material.color.copy(m.userData.col).multiplyScalar(k);
const HW = HOUSE.win, HD = HOUSE.door;
const hWin = glowPlane(HW.w + .002, HW.h + .002, HX + HW.x + HW.w / 2, HY + HW.y + HW.h / 2, -.0797, '#ffb45a');
const hDoor = glowPlane(HD.w + .002, HD.h + .001, HX + HD.x + HD.w / 2, HY + HD.h / 2, -.0797, '#ffb45a');
// 等待的人：身体 + 两只手臂（肩点为轴，只转动）
const FS = .03, FX = HX + HD.x + HD.w / 2, FZ = -.0789;
const fig = S.add(sheet({ U, w: .03, h: .04, x: FX, y: HY + .02, ax: 0, ay: -.02, z: FZ, trans: .02, ppm: 9000, shadow: false, draw: x => { x.translate(0, -.02); figureBody(x, FS); } }));
const arms = SHOULDER.map(([sx, sy], i) => S.add(sheet({ U, w: .03, h: .03, x: FX + sx * FS, y: HY + sy * FS, ax: 0, ay: 0, z: FZ + .0001 * (i + 1), trans: .02, ppm: 9000, shadow: false, draw: x => armShape(x, FS) })));
// 门：铰链在左边缘，scale.x 1 → 小（向里转开）
const door = S.add(sheet({ U, w: HD.w + .001, h: HD.h + .001, x: HX + HD.x - .0005 + (HD.w + .001) / 2, y: HY + (HD.h + .001) / 2, ax: -(HD.w + .001) / 2, ay: -(HD.h + .001) / 2, z: -.0785, trans: .2, ppm: 9000, shadow: false, draw: x => {
  x.fillStyle = '#26385f'; x.fillRect(-HD.w / 2, -HD.h / 2, HD.w + .001, HD.h + .001); x.fillStyle = '#1a2747'; x.fillRect(-HD.w / 2 + .002, -HD.h / 2 + .003, HD.w - .003, HD.h * .4); x.fillRect(-HD.w / 2 + .002, .002, HD.w - .003, HD.h * .36); x.fillStyle = '#0d142b'; x.beginPath(); x.arc(HD.w / 2 - .0025, 0, .0008, 0, 7); x.fill();
} }));

// 隧道后壁（暗）——列车在隧道里时的背景
const tunWall = S.add(sheet({ U, w: .2, h: .045, x: -.035, y: -.05, z: -.069, trans: .9, warm: .9, ppm: 4000, shadow: false, recv: false, finish: { rim: 0, under: 0 }, draw: x => { const g = x.createLinearGradient(0, .0225, 0, -.0225); g.addColorStop(0, '#5a4a40'); g.addColorStop(.55, '#46342c'); g.addColorStop(1, '#1c1820'); x.fillStyle = g; x.fillRect(-.1, -.0225, .2, .045); } }));
tunWall.userData.trans0 = .26;

// —— 小火车（一个组，按段换层、换大小）——
const train = new THREE.Group(); scene.add(train);
const OX = .064, OY = -.016;   // 画布内车头前端的位置
let WINS = [];
const tBody = sheet({ U, w: .16, h: .04, ax: OX, ay: OY, z: 0, trans: .12, ppm: 12000, finish: { rim: .95, rimPx: 7, rimCol: 'rgba(255,196,120,.95)' }, draw: x => { x.translate(OX, OY); WINS = trainBody(x); } });
tBody.material.side = THREE.DoubleSide; tBody.position.set(0, 0, 0); train.add(tBody);
const tWins = WINS.map(w => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w.w + .001, w.h + .001), glowMat('#ffb45a')); m.position.set(w.x + w.w / 2, w.y + w.h / 2, -.0004); m.userData.col = new THREE.Color('#ffb45a'); train.add(m); return m; });
const cab = new THREE.Mesh(new THREE.PlaneGeometry(.0095, .0085), glowMat('#ffc070')); cab.position.set(-TRAIN.loco + .0105, .02, -.0004); cab.userData.col = new THREE.Color('#ffc070'); train.add(cab);
const lampC = paint(.03, .03, x => { const g = x.createRadialGradient(0, 0, 0, 0, 0, .015); g.addColorStop(0, 'rgba(255,240,200,1)'); g.addColorStop(.25, 'rgba(255,210,140,.5)'); g.addColorStop(1, 'rgba(255,190,120,0)'); x.fillStyle = g; x.fillRect(-.015, -.015, .03, .03); }, 4000);
const lamp = new THREE.Mesh(new THREE.PlaneGeometry(.0065, .0065), new THREE.MeshBasicMaterial({ map: tex(lampC), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: new THREE.Color(0, 0, 0) }));
lamp.position.set(.002, .017, .0005); train.add(lamp);

// 蒸汽：纸片云，沿时间确定性生成
const puffTex = tex(paint(.03, .03, x => puff(x, .012), 3000));
const PUFFS = [];
for (let i = 0; i < 14; i++) { const m = new THREE.Mesh(new THREE.PlaneGeometry(.03, .03), new THREE.MeshBasicMaterial({ map: puffTex, transparent: true, depthWrite: false, opacity: 0, color: '#c5cfe4' })); scene.add(m); PUFFS.push(m); }

// L4：左边藏住第三段的出口；中间是带拱廊的隧道山
const TUN = [-.13, .06];
lay('l4', { z: -.052, trans: .24, warm: .4, ppm: 4000, draw: x => {
  x.fillStyle = '#22335f';
  range(x, [[-.3, -.005], [-.24, .0], [-.205, -.03], [-.2, -.078], [-.14, -.078], [-.13, -.04], [-.11, -.012], [-.06, .012], [-.02, .005], [.03, -.012], [.06, -.04], [.07, -.078], [.3, -.078]], { seed: 13, rough: .001 });
  // 拱廊：一排拱形开口，列车在山里时从这里看见车窗
  x.save(); x.globalCompositeOperation = 'source-atop'; x.fillStyle = '#18264c'; x.fillRect(TUN[0], -.075, TUN[1] - TUN[0], .043); x.restore();   // 拱廊立面压暗一档（只压在山体上）
  cut(x, () => {
    for (let px = TUN[0] + .006; px < TUN[1] - .014; px += .021) { x.beginPath(); x.moveTo(px, -.0705); x.lineTo(px, -.0435); x.arc(px + .0085, -.0435, .0085, Math.PI, 0, true); x.lineTo(px + .017, -.0705); x.closePath(); x.fill(); }
  });
  // 隧道口拱圈
  x.lineWidth = .0022; x.strokeStyle = '#2e4377';
  for (const px of TUN) { x.beginPath(); x.arc(px, -.06, .02, 0, Math.PI); x.stroke(); }
  for (let i = 0; i < 9; i++) { x.fillStyle = '#1a2850'; x.fillRect(TUN[0] + i * .021 + .0, -.073, .022, .004); }
} });
// L5：站台、站灯、站牌
const SIGN = { x: .128, y: -.012, w: .046, h: .016 };
lay('l5', { z: -.035, trans: .1, ppm: 4200, glowCol: '#ffcf8a', draw: x => {
  x.fillStyle = '#141f40';
  x.fillRect(.065, -.17, .24, .1); x.fillStyle = '#1e2c55'; x.fillRect(.065, -.0715, .24, .0025);   // 站台
  x.fillStyle = '#141f40';
  x.fillRect(.098, -.07, .0022, .06); x.fillRect(.155, -.07, .0022, .06); x.fillRect(.098, -.0115, .06, .0018);  // 站牌架
  x.fillRect(.278, -.07, .002, .072); x.beginPath(); x.moveTo(.272, .004); x.lineTo(.288, .004); x.lineTo(.284, .011); x.lineTo(.276, .011); x.fill();   // 站灯
  x.fillRect(SIGN.x - SIGN.w / 2, SIGN.y - SIGN.h / 2 - .008, SIGN.w, SIGN.h);
  cut(x, () => text(x, '桐溪站', SIGN.x, SIGN.y - .008, .0115, FONT.brush, { fill: '#000' }));
  range(x, [[-.3, -.11], [-.2, -.1], [-.1, -.115], [.065, -.105], [.07, -.17]], { seed: 15, rough: .0015 });
} });
const signGlow = glowPlane(SIGN.w - .002, SIGN.h - .002, SIGN.x, SIGN.y - .008, -.0355, '#ffd79a');
const lampGlow = glowPlane(.008, .004, .28, .0035, -.0345, '#ffcf8a');
// L6 最前：草、树
lay('l6', { z: -.012, trans: .04, ppm: 3200, draw: x => {
  x.fillStyle = '#0a1024';
  range(x, [[-.3, -.12], [-.15, -.135], [0, -.14], [.15, -.15], [.3, -.135]], { seed: 17 });
  grass(x, -.3, .3, -.14, .03, 260, 4);
  grass(x, -.3, -.12, -.125, .045, 70, 6); grass(x, .17, .3, -.13, .042, 60, 8);
  const poles = [[-.235, -.052], [-.1, -.08], [.05, -.086]];
  for (const [px, top] of poles) { x.fillRect(px - .0014, -.15, .0028, top + .15); x.fillRect(px - .009, top - .004, .018, .0018); x.fillRect(px - .006, top - .011, .012, .0014); }
  x.lineWidth = .0007; x.strokeStyle = '#0a1024';
  for (let k = 0; k < poles.length - 1; k++) for (const dy of [-.0041, -.0111]) { const [a, ta] = poles[k], [b, tb] = poles[k + 1]; x.beginPath(); x.moveTo(a + .007, ta + dy); x.quadraticCurveTo((a + b) / 2, (ta + tb) / 2 + dy - .012, b - .007, tb + dy); x.stroke(); }
  pine(x, -.275, -.15, .12, 21); x.fillRect(-.3, -.17, .02, .04);
} });

// —— 片尾纸条「回家」+ 朱印「归」——
const TT = { x: .122, y: .036, w: .123, h: .045, z: -.07 };
const stripC = paint(TT.w, TT.h, x => { x.fillStyle = '#efe3c6'; x.fillRect(-TT.w / 2, -TT.h / 2, TT.w, TT.h); text(x, '回家', -.009, 0, .0315, FONT.brush, { fill: '#0e0806' }); }, 7000);
const stripMap = tex(stripC); stripMap.wrapS = THREE.ClampToEdgeWrapping;
const stripG = new THREE.PlaneGeometry(TT.w, TT.h); stripG.translate(TT.w / 2, 0, 0);
const strip = new THREE.Mesh(stripG, new THREE.MeshStandardMaterial({ map: stripMap, roughness: .9, emissive: new THREE.Color('#ffffff'), emissiveMap: stripMap, emissiveIntensity: .32 }));
strip.position.set(TT.x - TT.w / 2, TT.y, TT.z); scene.add(strip);
const sealC = paint(.021, .021, x => { x.fillStyle = '#c8322a'; x.fillRect(-.0105, -.0105, .021, .021); text(x, '归', 0, -.0004, .0158, FONT.brush, { fill: '#f6e9d8' }); }, 7000);
const seal = new THREE.Mesh(new THREE.PlaneGeometry(.021, .021), new THREE.MeshStandardMaterial({ map: tex(sealC), transparent: true, roughness: .8, emissive: new THREE.Color('#c8322a'), emissiveIntensity: .25 }));
seal.position.set(TT.x + TT.w / 2 - .0165, TT.y - .0022, TT.z + .0005); scene.add(seal);

// —— 灯盒外 ——
const room = lightbox(scene);

// —— 时间函数 ——
const flick = t => 1 + .05 * Math.sin(7.3 * t) * Math.sin(3.1 * t);
const onAt = (t, t0, d = .22) => ss(seg(t, t0, t0 + d));
const pop = (t, t0) => t < t0 ? 0 : Math.exp(-(t - t0) * 7);

// 火车：三段，换段瞬间车身都藏在山后
const leg3x = monotone([[7.5, -.2], [8.75, -.13], [10, -.075], [11.25, -.012], [12.5, .06], [13.15, .118], [13.9, .16], [16, .16]]);
function trainAt(t) {
  if (t < H.train1 - .1) return null;
  if (t < H.hop2) return { z: -.121, s: .38, y: .04, dir: 1, xf: -.09 + .14 * (t - H.train1), leg: 1 };
  if (t < H.hop3) return { z: -.099, s: .6, y: -.005, dir: -1, xf: .14 - .225 * (t - H.hop2), leg: 2 };
  return { z: -.066, s: 1, y: -.065, dir: 1, xf: leg3x(t), leg: 3 };
}
// 铁轨颠簸（卡在咔嗒点上）
const bump = t => { let b = 0; for (const c of TL.CLACKS) { if (t >= c && t < c + .12) b = Math.max(b, Math.exp(-(t - c) * 30)); } return b; };

// 镜头：一条连续路径
const P = (a, b, u) => a.map((v, i) => lerp(v, b[i], u));
const KA = [[0, [-.021, .046, .182, -.02, .045, -.1]], [1.25, [-.02, .043, .16, -.02, .043, -.1]], [4.4, [0, .016, .46, 0, .006, -.08]], [5.6, [-.005, .018, .435, -.005, .009, -.08]],
  [7.5, [-.07, -.022, .34, -.07, -.032, -.08]], [8.75, [-.15, -.046, .2, -.15, -.05, -.066]]];
const camA = (() => { const fs = [0, 1, 2, 3, 4, 5].map(j => monotone(KA.map(k => [k[0], k[1][j]]))); return t => fs.map(f => f(t)); })();
const tunCam = t => { const x = Math.max(-.15, leg3x(t) - .062), z = lerp(.2, .1, eio(seg(t, 8.75, 9.8))); return [x, -.046, z, x + .004, -.05, -.066]; };
const STA = [.152, -.036, .185, .152, -.041, -.072];
const PUSH = [.204, -.046, .108, .204, -.048, -.079];
const OUT = [0, .006, 1.06, 0, -.01, -.05];
// 张臂之后：先抬头看夜空（纸条在这里长出来），再一路拉出灯盒
const camEnd = track([[16.25, PUSH], [16.3, PUSH], [16.875, [.14, -.02, .2, .13, .008, -.07]], [17.5, [.06, -.004, .42, .05, 0, -.06]],
  [18.75, [.012, .005, .88, .008, -.008, -.052]], [19.75, OUT]]);
function camAt(t) {
  if (t < 8.75) return camA(t);
  if (t < 12.5) return tunCam(t);
  if (t < 13.9) return P(tunCam(12.5), STA, eo(seg(t, 12.5, 13.9)) * .5 + ss(seg(t, 12.5, 13.9)) * .5);
  if (t < 15) return STA;
  if (t < 16.25) return P(STA, PUSH, eio(seg(t, 15, 16.25)));
  return camEnd(t);
}
function focusAt(t) {   // [焦点所在 z, 光圈]
  if (t < 4.4) return [lerp(-.06, -.09, seg(t, 1.25, 4.4)), 10];
  if (t < 8.75) return [lerp(-.11, -.066, ss(seg(t, 5, 8.6))), 12];
  if (t < 13.9) return [-.066, lerp(18, 28, ss(seg(t, 8.75, 9.6)) * (1 - ss(seg(t, 12.3, 13.2))))];
  if (t < 15) return [lerp(-.066, -.0795, eio(seg(t, 14.15, 15))), 26];
  if (t < 16.25) return [-.0795, 22];
  return [lerp(-.0795, -.07, ss(seg(t, 16.3, 16.875))), lerp(22, 5, ss(seg(t, 16.25, 18.6)))];
}

// 每一层透光的时刻（八分音符依次）
const LAYERS = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'];
const layerOn = (t, i) => onAt(t, H.layers[i], .26);

let titleG = 0;
function update(t) {
  const lampOn = t >= H.click ? 1 : 0, fl = flick(t);
  // 光源：咔哒一声先亮月亮（背光点），再按八分音符一层层透光
  moonK = lampOn ? (.32 + .35 * ss(seg(t, H.click, H.layers[0])) + .4 * onAt(t, H.layers[0], .3)) * fl + 1.25 * pop(t, H.click) + (t >= H.house ? .12 * pop(t, H.house) : 0) : MOON0;
  setMoon(mn, moonK);
  if (!lampOn) { mn.userData.disc.material.color.copy(COOL); mn.userData.halo.material.color.setScalar(0); }
  moonRim.visible = !lampOn;
  sky.material.color.setScalar((lampOn ? .3 : .11) + .7 * onAt(t, H.layers[0], .3) * fl + lampOn * (.12 * ss(seg(t, H.click, H.click + .3)) + .35 * pop(t, H.click)));
  LAYERS.forEach((id, i) => { L[id].material.userData.u.uTrans.value = L[id].userData.trans0 * layerOn(t, i) * fl; });
  tunWall.material.userData.u.uTrans.value = tunWall.userData.trans0 * layerOn(t, 3) * fl;
  house.material.userData.u.uTrans.value = .3 * layerOn(t, 2) * fl;
  S.key.intensity = 1.25 * onAt(t, H.layers[4], .4);
  S.amb.intensity = t < H.click ? .13 : .34;
  room.spill.intensity = 6.5 * onAt(t, H.layers[2], .6) * fl;
  setGlow(signGlow, 1.3 * onAt(t, H.layers[4], .3) * fl); setGlow(lampGlow, 2.2 * onAt(t, H.layers[4], .3) * fl);

  // 火车
  const tr = trainAt(t);
  train.visible = !!tr;
  if (tr) {
    const b = tr.leg === 3 ? bump(t) * .00045 : 0;
    train.position.set(tr.xf, tr.y + b, tr.z); train.scale.set(tr.dir * tr.s, tr.s, 1);
    tWins.forEach((m, i) => setGlow(m, (1.6 * onAt(t, H.windows[i], .05) + 1.2 * pop(t, H.windows[i])) * fl));
    setGlow(cab, 1.1 * fl);
    lamp.material.color.setScalar(.6 * fl);
  }
  // 蒸汽：每拍从烟囱冒一朵，停车时一大团
  const emits = [];
  for (const c of TL.BEATS) if (c >= H.train1 && c <= H.stop) emits.push([c, 1]);
  emits.push([H.stop, 2.2]);
  let pi = 0;
  for (const [te, big] of emits) {
    if (t < te || t > te + 1.6 || pi >= PUFFS.length) continue;
    const st = trainAt(te + .001), m = PUFFS[pi++]; if (!st) continue;
    const u = (t - te) / 1.6, sx = st.xf + st.dir * st.s * -.008, sy = st.y + st.s * .029, inTun = st.leg === 3 && sx > TUN[0] && sx < TUN[1];
    m.visible = !inTun;
    m.position.set(sx - st.dir * st.s * .02 * u * (big > 1 ? .3 : 1), sy + st.s * .028 * eo(u) * big * .7, st.z + .0012);
    const sc = st.s * (.35 + .9 * eo(u)) * big * .55; m.scale.set(sc, sc, 1);
    m.material.opacity = .75 * (1 - u) * ss(seg(u, 0, .08)); m.material.color.set('#c5cfe4').multiplyScalar(.45 + .55 * onAt(t, H.layers[2], .3));
  }
  for (; pi < PUFFS.length; pi++) PUFFS[pi].material.opacity = 0;

  // 站屋：窗亮（15.0）、门开（15.625）、张臂（16.25）
  const hk = onAt(t, H.house, .07);
  setGlow(hWin, (1.7 * hk + 1.4 * pop(t, H.house)) * fl); setGlow(hDoor, 1.5 * hk * fl);
  door.scale.x = 1 - .86 * eio(seg(t, H.door, H.door + .42));
  const ant = .14 * Math.sin(Math.PI * seg(t, H.arms - .22, H.arms)), sw = clamp(1.9 * (1 - Math.exp(-6.5 * Math.max(0, t - H.arms))) - .9 * Math.max(0, 1 - Math.exp(-3.2 * Math.max(0, t - H.arms - .18))));
  const ang = (t < H.arms ? -ant : sw * 1.95);
  arms[0].rotation.z = -ang; arms[1].rotation.z = ang;
  // 片尾纸条（从左边长出来）与朱印
  const g = eio(seg(t, H.title0, H.title1)); titleG = g;
  strip.visible = g > 0; strip.scale.x = Math.max(.001, g); stripMap.repeat.x = Math.max(.001, g); stripMap.offset.x = 0;
  strip.material.emissiveIntensity = .32 * fl;
  seal.visible = t >= H.title1; const sp = t >= H.title1 ? 1 + .35 * Math.exp(-(t - H.title1) * 14) : 1; seal.scale.set(sp, sp, 1);

  const c = camAt(t);
  aim(S.cam, c, t, { hand: t < H.click ? .0009 : t > 16.25 ? .0006 : .0005, handF: t < H.click ? .6 : .35 });
}

// —— 渲染 ——
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(SSAA); renderer.setSize(1920, 1080, false);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.VSMShadowMap;
renderer.toneMapping = THREE.NoToneMapping; renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
const pipe = new Pipe(renderer, 1920, 1080, SSAA);

window.DUR = TL.DUR;
window.render = (t) => {
  update(t);
  const [fz, aper] = focusAt(t);
  pipe.shot(scene, S.cam, { focus: Math.max(.03, S.cam.position.z - fz), aper, maxCoc: 16, bloom: { strength: .42, radius: .55, threshold: 1.05 } }, pipe.rtA);
  const dark = 1 - onAt(t, H.layers[0], .5);
  pipe.final({ expo: t < H.click ? .93 : 1.06 + dark * .3, vig: .4, sat: 1.05, contrast: .1 });
};

// —— 声音与核对事件（全部来自 timeline.js）——
const EV = [];
TL.BEATS.forEach((t, k) => EV.push({ t, type: 'beat', k }));
EV.push({ t: H.click, type: 'click' });
H.layers.forEach((t, i) => EV.push({ t, type: 'layer', i }));
EV.push({ t: H.train1, type: 'whistle_far' });
EV.push({ t: H.hop2, type: 'hop', i: 2 }, { t: H.hop3, type: 'hop', i: 3 });
TL.CLACKS.forEach(t => EV.push({ t, type: 'clack', d: t < H.hop2 ? 0 : t < H.hop3 ? .45 : 1, tun: t >= H.tunnel && t < H.exit ? 1 : 0 }));
EV.push({ t: H.tunnel, type: 'tunnel_in' });
H.windows.forEach((t, i) => EV.push({ t, type: 'win', i }));
EV.push({ t: H.exit, type: 'tunnel_out' }, { t: H.exit, type: 'whistle' }, { t: H.brake, type: 'brake' }, { t: H.stop, type: 'stop' });
EV.push({ t: H.house, type: 'house' }, { t: H.door, type: 'door' }, { t: H.arms, type: 'arms' }, { t: H.title0, type: 'strip' }, { t: H.title1, type: 'seal' }, { t: H.last, type: 'last' });
window.EV = EV;

// —— 画面探针（tools/cuecheck 用）：每个视觉事件的连续时间状态量 ——
window.PROBE = (t) => {
  update(t);
  return {
    moon: moonK - MOON0,
    layers: LAYERS.map(id => L[id].material.userData.u.uTrans.value / L[id].userData.trans0),
    leg: trainAt(t)?.leg || 0,
    wins: tWins.map(m => m.material.color.r),
    house: hWin.material.color.r, door: door.scale.x, arm: arms[1].rotation.z, strip: titleG, seal: seal.visible ? 1 : 0,
    tunnel: (() => { const tr = trainAt(t); return tr && tr.leg === 3 && tr.xf > TUN[0] ? 1 : 0; })(),
    xf: trainAt(t)?.xf ?? -9, spd: (() => { const a = trainAt(t), b = trainAt(t + .001); return a && b && a.leg === b.leg ? Math.abs(b.xf - a.xf) / .001 : 0; })(),
    camv: (() => { const a = camAt(t), b = camAt(t + .02); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / .02; })(),
  };
};

// —— 画面内文字（readcheck）——
const pcam = new THREE.PerspectiveCamera(26, 16 / 9, .01, 30);
const boxOf = (x0, y0, x1, y1, z) => {
  const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => new THREE.Vector3(x, y, z).project(pcam));
  const xs = pts.map(p => (p.x + 1) / 2 * 1920), ys = pts.map(p => (1 - p.y) / 2 * 1080);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};
window.TEXTS = (t) => {
  const c = camAt(t); pcam.position.set(c[0], c[1], c[2]); pcam.lookAt(c[3], c[4], c[5]); pcam.updateMatrixWorld();
  const out = [], vis = b => b.x1 > 0 && b.x0 < 1920 && b.y1 > 0 && b.y0 < 1080;
  if (t >= H.layers[4]) { const b = boxOf(SIGN.x - .02, SIGN.y - .0145, SIGN.x + .02, SIGN.y - .0015, -.035); if (vis(b)) out.push({ id: 'sign', text: '桐溪站', ...b }); }
  if (t >= H.title0) { const b = boxOf(TT.x - TT.w / 2, TT.y - TT.h / 2, TT.x + TT.w / 2 - .03, TT.y + TT.h / 2, TT.z); if (vis(b)) out.push({ id: 'title', text: '回家', ...b }); }
  if (t >= H.title1) { const b = boxOf(TT.x + TT.w / 2 - .027, TT.y - .0127, TT.x + TT.w / 2 - .006, TT.y + .0083, TT.z + .0005); if (vis(b)) out.push({ id: 'seal', text: '归', ...b }); }
  return out;
};

renderer.compile(scene, S.cam);
window.READY = true;
