// 港口集市：一座桌面大小的港镇立体模型。暴雨 → 云过 → 黄昏点灯 → 灯塔点燃、红帆出港。
// 坐标：x 向东（右），z 向南（朝镜头），y 向上；码头面 y=0，海面 SEA_Y。
import * as THREE from 'three';
import { PX, ramp, hex, h2, fbm, texOf, cobbles, rock, woodPlanks, billboard, glow, blob, mulberry } from './px.js';
import { mats, mat, mesh, box, house, crate, barrel, windowMat, ridge } from './kit.js';
import { sky, stars, sea, particles, beamCard, flick } from './fx.js';
import { makePerson, SPX, FH } from './people.js';
import { T, POP_T, bt } from '../timeline.js';
import { clamp, seg, ss, eio, eo, lerp, track } from '/core/lib.js';

export const SEA_Y = -1.1;
export const STALL_X = [...Array(11)].map((_, i) => -11 + i * 1.95);
export const STALL_Z = .6;
export const LH = new THREE.Vector3(-34, SEA_Y, -9);      // 灯塔岛基点
export const LAMP_Y = 10.6;                                // 灯室中心高度（世界）
const C3 = (c) => new THREE.Color(c);
const mixC = (a, b, k) => a.clone().lerp(b, clamp(k));

// 云的后缘（地面上的阴影线）随时间从西向东扫过整个模型
export function cloudEdge(t) {
  const k = [[0, -70], [T.cloudGo, -66], [T.sunLH, -36], [T.rainHalf, 1], [T.cut1, 30], [bt(30), 60]];
  for (let i = 0; i < k.length - 1; i++) if (t < k[i + 1][0]) { const u = (t - k[i][0]) / (k[i + 1][0] - k[i][0]); return lerp(k[i][1], k[i + 1][1], u); }
  return 60;
}
// 闪电曲线：劈 — 暗 — 再劈 — 衰减
export function flash(t) {
  const d = t - T.lightning; if (d < 0) return 0;
  if (d < .12) return 1; if (d < .2) return .18; if (d < .27) return .85;
  return .85 * Math.exp(-(d - .27) / .22);
}
// 摊灯亮度：在点亮拍上弹起（过冲后回落），之后呼吸
export function popLevel(t, tp, seed = 0) {
  if (t < tp - 1e-6) return 0;              // 在点亮拍的那一帧就亮（不晚一帧）
  const d = Math.max(0, t - tp);
  return (1 + .9 * Math.exp(-d / .11)) * (d > .25 ? flick(t, seed) : 1);
}

function paperLanternTex(col) {   // 纸灯笼：竹篾横纹 + 上下木箍
  const P = new PX(16, 12), E = new PX(16, 12), G = ramp(col, .45), D = ramp(['#2a1a12', '#4a3020', '#6a4a30'], .45);
  P.fill((x, y) => {
    if (y === 0 || y === 11) return D(.5, x, y);
    const v = .55 + Math.cos((x / 16) * Math.PI * 2) * .25 - (y % 3 === 0 ? .25 : 0) + (h2(x, y, 4) - .5) * .1;
    const c = G(v, x, y); E.set(x, y, c); return c;
  });
  return { map: texOf(P.done(), { repeat: [1, 1] }), em: texOf(E.done(), { repeat: [1, 1] }) };
}
function stripeTex(a, b, seed) {   // 摊位遮阳篷：条纹帆布 + 褶
  const P = new PX(48, 24), A = ramp(a, .45), B = ramp(b, .45);
  P.fill((x, y) => { const s = Math.floor(x / 6) % 2, v = .55 + (y % 8 === 7 ? -.25 : 0) + (fbm(x * .2, y * .2, seed) - .5) * .3 - (y > 20 ? .2 : 0); return (s ? A : B)(v, x, y); });
  return mat(P.done(), { rough: 1 });
}
function goodsTex(kind, seed) {   // 柜台上的货：一堆像素水果 / 鱼 / 陶罐
  const P = new PX(32, 14), R = mulberry(seed);
  const pal = { fruit: [['#5a1a10', '#a8341c', '#e06a2a', '#ffb050'], ['#3a4a10', '#6a8a1c', '#a8c040'], ['#5a3a08', '#a8781c', '#f0c040']], fish: [['#1a2a3a', '#4a6a8a', '#8aaac8', '#d0e0f0']], pot: [['#2a1810', '#6a3a20', '#a86a3a', '#d09a60']] }[kind];
  for (let i = 0; i < 26; i++) {
    const c = ramp(pal[Math.floor(R() * pal.length)], .3), x = 3 + R() * 26, y = 13 - R() * R() * 9, r = kind === 'pot' ? 2.6 : 1.8 + R() * .8;
    if (kind === 'fish') { for (let k = -3; k <= 3; k++) P.set(x + k, y, c(.5 + k * .06, x + k, y)); P.set(x + 4, y - 1, c(.3, 0, 0)); P.set(x + 4, y + 1, c(.3, 0, 0)); P.set(x - 2, y, [20, 20, 30]); }
    else P.ellipse(x, y, r, r * .9, (xx, yy, dx, dy) => c(.75 - dx * .3 - dy * .35, xx, yy));
  }
  P.outline(.35);
  return texOf(P.done());
}

export function buildHarbor() {
  const scene = new THREE.Scene(), MM = mats();
  scene.fog = new THREE.FogExp2('#3a4658', .011);
  const SK = sky({ top: '#1a2030', mid: '#2c3648', hor: '#4a5466', moonI: 0 }); scene.add(SK.mesh);
  const ST = stars(700, 5); scene.add(ST);

  // —— 灯光：一盏投影主光（暴雨冷光 → 黄昏暖斜阳 → 夜）+ 半球补光 ——
  const key = new THREE.DirectionalLight('#9aaac8', .8); key.castShadow = true; key.shadow.mapSize.set(4096, 4096);
  Object.assign(key.shadow.camera, { left: -48, right: 48, top: 40, bottom: -40, near: 1, far: 220 }); key.shadow.bias = -.0005; key.shadow.normalBias = .03;
  key.target.position.set(-6, 0, -4); scene.add(key, key.target);
  const hemi = new THREE.HemisphereLight('#6a7a98', '#141018', 1.4); scene.add(hemi);
  const bolt = new THREE.DirectionalLight('#c8d8ff', 0); bolt.position.set(20, 40, -30); scene.add(bolt);

  // —— 地面：码头石板 + 前沿石墙 + 后排台地 ——
  const cob = mat(cobbles(96, 96, { seed: 4, cols: ['#1e1c22', '#36333a', '#4f4a50', '#6a6468', '#868084'] }));
  const stone = mat(rock(96, 96, { seed: 2, cols: ['#16151a', '#27252c', '#393640', '#4c4852', '#635e68'] }));
  scene.add(mesh(new THREE.BoxGeometry(46, .4, 24).translate(5, -.2, -9), cob));
  scene.add(mesh(new THREE.BoxGeometry(46, 2.4, .7).translate(5, -1.2, 3.05), stone));
  scene.add(mesh(new THREE.BoxGeometry(.7, 2.4, 24).translate(-18.05, -1.2, -9), stone));
  scene.add(mesh(new THREE.BoxGeometry(46.4, .22, .8).translate(5, .02, 3.05), stone));
  scene.add(mesh(new THREE.BoxGeometry(.8, .22, 24).translate(-18.05, .02, -9), stone));
  const terr = mesh(new THREE.BoxGeometry(44, 1.6, 9).translate(6, .8, -16.5), stone); scene.add(terr);
  scene.add(mesh(new THREE.BoxGeometry(44, .2, 9).translate(6, 1.7, -16.5), cob));
  // 台阶
  for (let i = 0; i < 4; i++) scene.add(mesh(new THREE.BoxGeometry(2.2, .45 * (i + 1), .5).translate(-3, .225 * (i + 1), -10.25 - i * .5), stone));

  // —— 房屋：前排沿街，后排在台地上（窗都用同一块发光材质，入夜时一齐点亮） ——
  const H1 = [
    [-15, 4.6, 4.6, 'wall', 'roof'], [-10.2, 5, 5.4, 'wall3', 'roof3'], [-5.2, 4.8, 4.4, 'wall2', 'roof2'], [-.4, 4.6, 5.2, 'wall', 'roof'],
    [4.4, 5.2, 4.6, 'wall3', 'roof2'], [9.6, 4.8, 5.6, 'wall2', 'roof3'], [14.6, 5, 4.4, 'wall', 'roof'], [19.6, 4.8, 5, 'wall3', 'roof2'],
  ];
  H1.forEach(([x, w, h, wall, roof], i) => scene.add(house({ x, z: -6.6, w, d: 4.4, h, wall, roof, door: (i % 2 ? -1 : 1) * w * .22, windows: [[(i % 2 ? 1 : -1) * w * .24, h * .45]], upper: [[-w * .25, h * .78], [w * .25, h * .78]], chimney: i % 3 !== 1 })));
  const H2 = [[-14, 5, 5.6, 'wall2', 'roof'], [-8.5, 5.4, 6.4, 'wall', 'roof2'], [-2.6, 5, 5.2, 'wall3', 'roof3'], [3.2, 5.6, 6.8, 'wall2', 'roof'], [9.2, 5, 5.8, 'wall', 'roof3'], [15, 5.4, 6.2, 'wall3', 'roof2'], [20.6, 5, 5.4, 'wall', 'roof']];
  H2.forEach(([x, w, h, wall, roof], i) => scene.add(house({ x, z: -16.8, y: 1.8, w, d: 4.6, h, wall, roof, windows: [[0, h * .45]], upper: [[-w * .25, h * .78], [w * .25, h * .78]], chimney: i % 2 === 0 })));
  const WIN = windowMat();
  const winL = [[-12.5, 2.5, -3.6], [-2, 2.5, -3.6], [8, 2.5, -3.6], [17, 2.5, -3.6]].map(([x, y, z]) => { const L = new THREE.PointLight('#ff9d4a', 0, 8, 2); L.position.set(x, y, z); scene.add(L); return L; });

  // —— 小摊 ×11：柜台、立柱、条纹篷、货、纸灯笼（每盏一盏点光源） ——
  const AWN = [[['#0e2a2a', '#1a4a46', '#2a6a62', '#3e8a7e'], ['#6a6250', '#9a8e72', '#c8ba98', '#e8dcbc']], [['#3a1c10', '#6a3418', '#984e24', '#c06a34'], ['#6a6250', '#9a8e72', '#c8ba98', '#e8dcbc']], [['#3a2e08', '#6a5414', '#9a7c22', '#c8a438'], ['#5a5444', '#8a8064', '#b4a888', '#dcd0b0']], [['#24142a', '#40264a', '#5e3a6a', '#7e548a'], ['#6a6250', '#9a8e72', '#c8ba98', '#e8dcbc']]];
  const LCOL = [['#6a3010', '#c0601e', '#f09a3a', '#ffd070'], ['#6a2a1e', '#c05a3a', '#f0905a', '#ffc49a'], ['#5a3a10', '#b07a20', '#e8b040', '#fff0a0']];
  const LHEX = ['#ffa045', '#ff9468', '#ffc055'];
  const KEEPERS = [
    { coat: 'teal', hat: 'scarf', hatC: 'mustard', apron: 'cream' }, { coat: 'brown', hat: 'cap', hatC: 'slate', beard: 1 }, { coat: 'plum', hat: 'bun', hair: 'hairR', apron: 'cream' },
    { coat: 'olive', hat: 'none', hair: 'hairD' }, { coat: 'slate', hat: 'scarf', hatC: 'cream', skin: 'skin2' },
  ];
  const GOODS = ['fruit', 'fish', 'pot', 'fruit', 'fish', 'fruit', 'pot', 'fish', 'fruit', 'pot', 'fruit'];
  const stalls = STALL_X.map((x, i) => {
    const g = new THREE.Group(); g.position.set(x, 0, STALL_Z);
    const ctr = box(1.55, .9, .7, MM.plank); ctr.position.set(0, 0, .15); g.add(ctr);
    const top = box(1.65, .07, .78, MM.plankDark); top.position.set(0, .9, .15); g.add(top);
    for (const [px, pz] of [[-.78, .5], [.78, .5], [-.78, -.45], [.78, -.45]]) { const p = box(.08, pz > 0 ? 2.05 : 2.35, .08, MM.beam); p.position.set(px, 0, pz); g.add(p); }
    const awn = mesh(new THREE.BoxGeometry(1.9, .05, 1.35), stripeTex(...AWN[i % 4], i + 3)); awn.position.set(0, 2.22, .02); awn.rotation.x = .2; g.add(awn);
    const val = mesh(new THREE.BoxGeometry(1.9, .22, .03), awn.material); val.position.set(0, 2.0, .7); g.add(val);
    const gd = billboard(goodsTex(GOODS[i], i * 7 + 1), 1.3, .57, { shadow: true }); gd.position.set(0, .92, .32); g.add(gd);
    if (i % 3 !== 1) { const c = crate(.5); c.position.set(.95, 0, .75); c.rotation.y = .3; g.add(c); }
    if (i % 4 === 2) { const b = barrel(.25, .6); b.position.set(-1.05, 0, .7); g.add(b); }
    // 纸灯笼：挂在篷檐前
    const T2 = paperLanternTex(LCOL[i % 3]);
    const lm = new THREE.MeshStandardMaterial({ map: T2.map, emissiveMap: T2.em, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0, roughness: .8 });
    const lan = new THREE.Mesh(new THREE.CylinderGeometry(.17, .17, .32, 10), lm); lan.position.set(.35, 1.72, .72); lan.castShadow = false; g.add(lan);
    const cap = box(.18, .05, .18, MM.beam, { cast: false }); cap.position.set(.35, 1.88, .72); g.add(cap);
    const str = box(.015, .2, .015, MM.beam, { cast: false }); str.position.set(.35, 1.92, .72); g.add(str);
    const gl = glow(LHEX[i % 3], 1.3, 1.2); gl.position.set(.35, 1.72, .78); gl.material.opacity = 0; g.add(gl);
    const L = new THREE.PointLight(LHEX[i % 3], 0, 9, 2); L.position.set(.48, 1.67, 1.48); g.add(L);   // 往镜头方向挪 0.45 m（STYLE §9：灯别烧掉持灯的精灵）
    if (i < 4) { L.castShadow = true; L.shadow.mapSize.set(512, 512); L.shadow.bias = -.004; L.shadow.camera.near = .05; L.shadow.camera.far = 12; }
    // 摊主
    const kp = makePerson({ id: 'keeper' + i, ...KEEPERS[i % KEEPERS.length] }); kp.root.position.set(x - .42, 0, STALL_Z - .25); scene.add(kp.root);
    scene.add(g);
    return { g, lm, gl, L, kp, x, seed: i * 2.7 };
  });

  // —— 顾客（站着，换两帧待机） ——
  const CROWD = [[-9.6, 2.1, 'navy', 'none', 'hairR'], [-6.8, 2.4, 'brown', 'scarf', 'hairD', 'cream'], [-2.4, 2.0, 'olive', 'cap', 'hairD', 'brown'], [.6, 2.5, 'plum', 'bun', 'hairD'], [3.8, 2.1, 'slate', 'none', 'hairR'], [6.6, 2.3, 'teal', 'cap', 'hairD', 'navy'], [-4.6, 2.2, 'mustard', 'scarf', 'hairD', 'plum']];
  const crowd = CROWD.map(([x, z, coat, hat, hair, hatC], i) => { const p = makePerson({ id: 'crowd' + i, coat, hat, hair, hatC: hatC || 'slate', skin: i % 3 === 2 ? 'skin2' : 'skin' }, ['idle0', 'idle1', 'look', 'blink']); p.root.position.set(x, 0, z); scene.add(p.root); return p; });

  // —— 彩灯串：沿码头的灯杆之间 + 斜拉到房檐 ——
  const poles = [-13, -6.5, 0, 6.5, 13].map(x => { const p = box(.12, 3.3, .12, MM.plankDark); p.position.set(x, 0, 2.6); scene.add(p); return [x, 3.25, 2.6]; });
  const strings = [];
  for (let i = 0; i < poles.length - 1; i++) strings.push([poles[i], poles[i + 1], .55]);
  for (let i = 0; i < poles.length; i++) strings.push([poles[i], [poles[i][0] + 1.4, 4.4, -4.3], .45]);
  const BCOL = ['#ffb04a', '#ff8a5a', '#ffe08a', '#9ad8c8', '#ffc0d0'];
  const bulbs = [], bulbGeo = new THREE.BoxGeometry(.09, .12, .09);
  const wireM = new THREE.LineBasicMaterial({ color: '#1a1410' });
  strings.forEach(([a, b, sag]) => {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), n = Math.max(4, Math.round(A.distanceTo(B) / .55)), pts = [];
    for (let k = 0; k <= 40; k++) { const u = k / 40, p = A.clone().lerp(B, u); p.y -= sag * 4 * u * (1 - u); pts.push(p); }
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), wireM));
    for (let k = 1; k < n; k++) { const u = k / n, p = A.clone().lerp(B, u); p.y -= sag * 4 * u * (1 - u) + .08;
      const c = BCOL[(bulbs.length * 3) % BCOL.length], m = new THREE.MeshStandardMaterial({ color: '#2a2420', emissive: c, emissiveIntensity: 0 });
      const me = new THREE.Mesh(bulbGeo, m); me.position.copy(p); scene.add(me);
      const gl = glow(c, .55, 1.1); gl.position.copy(p); gl.material.opacity = 0; scene.add(gl);
      bulbs.push({ m, gl, x: p.x }); }
  });
  const festL = [-10, -3, 3.5, 10].map(x => { const L = new THREE.PointLight('#ffc080', 0, 10, 2); L.position.set(x, 3.0, 1.6); scene.add(L); return L; });

  // —— 栈桥 + 主角的小帆船（猩红帆） ——
  const deckM = mat(woodPlanks(96, 96, { pw: 5, len: 96, seed: 8 }));
  scene.add(mesh(new THREE.BoxGeometry(2.2, .2, 9).translate(-14.5, -.1, 7.4), deckM));
  for (let z = 3.6; z <= 11.8; z += 2.05) for (const x of [-15.5, -13.5]) scene.add(mesh(new THREE.CylinderGeometry(.12, .14, 2.6, 8).translate(x, -1.3, z), MM.beam));
  for (const z of [6, 9.5]) { const b = mesh(new THREE.CylinderGeometry(.1, .13, .35, 8).translate(-15.45, .17, z), MM.plankDark); scene.add(b); }
  const boat = new THREE.Group();
  const hullM = mat(woodPlanks(96, 96, { pw: 4, len: 96, seed: 21, cols: ['#150d0a', '#2c1b12', '#4a2d1c', '#6b4228', '#86582f'] }));
  {
    const s = new THREE.Shape(); s.moveTo(-1.7, -.75); s.lineTo(1.2, -.75); s.quadraticCurveTo(2.4, -.35, 2.8, 0); s.quadraticCurveTo(2.4, .35, 1.2, .75); s.lineTo(-1.7, .75); s.quadraticCurveTo(-2, 0, -1.7, -.75);
    const hg = new THREE.ExtrudeGeometry(s, { depth: .95, bevelEnabled: false }); hg.rotateX(-Math.PI / 2); hg.translate(0, -.55, 0);
    boat.add(mesh(hg, hullM));
    boat.add(mesh(new THREE.BoxGeometry(4.3, .1, 1.56).translate(.3, .2, 0), mat(woodPlanks(48, 48, { pw: 48, seed: 3, nails: false, cols: ['#0e1626', '#1a2a44', '#2a4060'] }))));
    boat.add(mesh(new THREE.CylinderGeometry(.06, .08, 5.2, 8).translate(.4, 2.9, 0), MM.beam));
    boat.add(mesh(new THREE.CylinderGeometry(.045, .045, 2.6, 6).rotateZ(Math.PI / 2).translate(-.85, 1.1, 0), MM.beam));
  }
  // 帆：像素猩红三角帆（扬帆时从帆杠往上升）
  const sailC = new PX(30, 44), SR_ = ramp(['#2e0610', '#560e1a', '#861824', '#b42a30', '#d84a42'], .45);
  sailC.poly([[0, 44], [29, 44], [27, 0]], (x, y) => SR_(.55 + (x / 30) * .25 - (y % 11 === 10 ? .25 : 0) + (fbm(x * .2, y * .1, 3) - .5) * .2, x, y));
  const sailTex = texOf(sailC.done());
  const sailM = new THREE.MeshLambertMaterial({ map: sailTex, alphaTest: .5, side: THREE.DoubleSide, emissive: new THREE.Color('#ff6040'), emissiveIntensity: 0 });
  const sail = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 3.9).translate(-1.2, 1.95, 0), sailM); sail.castShadow = true;
  sail.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: sailTex, alphaTest: .5, side: THREE.DoubleSide });
  const sailG = new THREE.Group(); sailG.position.set(.4, 1.15, 0); sailG.rotation.y = -.6; sailG.add(sail); boat.add(sailG);
  const furl = mesh(new THREE.CylinderGeometry(.12, .12, 2.3, 8).rotateZ(Math.PI / 2).translate(-.8, 1.25, 0), new THREE.MeshLambertMaterial({ color: '#7a1a20' })); boat.add(furl);
  const bLan = new THREE.Mesh(new THREE.BoxGeometry(.14, .2, .14), new THREE.MeshStandardMaterial({ color: '#2a2016', emissive: '#ffb45a', emissiveIntensity: 3 })); bLan.position.set(-1.6, .6, 0); boat.add(bLan);
  const bLanG = glow('#ffb25e', .9, 1.1); bLanG.position.copy(bLan.position); boat.add(bLanG);
  const bLanL = new THREE.PointLight('#ffb050', 2.5, 6, 2); bLanL.position.set(-1.6, .9, .4); boat.add(bLanL);
  const rope = new THREE.LineBasicMaterial({ color: '#2a2018' });
  for (const [a, b] of [[[.4, 5.4, 0], [2.7, .3, 0]], [[.4, 5.4, 0], [-1.6, .3, 0]], [[.4, 5.4, 0], [.4, .3, .75]], [[.4, 5.4, 0], [.4, .3, -.75]]]) boat.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]), rope));
  scene.add(boat);
  const BOAT0 = new THREE.Vector3(-17.6, SEA_Y + .1, 7.6);
  const boatPath = track([[T.sail + .15, [-17.6, 7.6]], [T.sail + 1.6, [-20.5, 6.9]], [T.beamHit, [-22.6, 6.3]], [bt(28.5), [-31.5, 3.0]]]);
  const sailor = makePerson({ id: 'hero', coat: 'navy', hat: 'cap', hatC: 'navy', hair: 'hairR', scarf: 1 }); scene.add(sailor.root);
  const boatWake = particles(70, (i, t, o) => { o.a = 0; }, { soft: 1 }); scene.add(boatWake);

  // —— 前景小船（横移时从镜头前虚化掠过的桅杆） ——
  const fgBoats = [[-7, 11, .3], [3, 13.5, -.4], [11, 10.5, .2], [18, 13, -.2]].map(([x, z, ry], i) => {
    const g = new THREE.Group(); g.add(mesh(new THREE.BoxGeometry(3.2, .5, 1.2).translate(0, .1, 0), hullM));
    g.add(mesh(new THREE.CylinderGeometry(.05, .07, 5.5, 6).translate(.2, 3, 0), MM.beam));
    g.add(mesh(new THREE.CylinderGeometry(.1, .1, 2, 6).rotateZ(Math.PI / 2).translate(-.6, 1.1, 0), new THREE.MeshLambertMaterial({ color: ['#c8c0a8', '#9aa4b0', '#c0a878', '#8a9a8a'][i] })));
    g.position.set(x, SEA_Y + .05, z); g.rotation.y = ry; scene.add(g); return g;
  });

  // —— 海、岸边浪花 ——
  const SEA = sea(1400, { ppm: 9, deep: '#0a1420', shallow: '#1a3046', crest: '#4a6a86' }); SEA.mesh.position.y = SEA_Y; scene.add(SEA.mesh);
  const foamC = new PX(64, 8); foamC.fill((x, y) => { const v = fbm(x * .2, y * .6, 31) - y * .06; return v > .5 ? (v > .6 ? [205, 220, 235] : [120, 150, 180]) : null; });
  const foamT = texOf(foamC.done()); foamT.wrapS = foamT.wrapT = THREE.RepeatWrapping;
  const foams = [];
  const foamStrip = (x0, z0, x1, z1, w = .6) => { const L = Math.hypot(x1 - x0, z1 - z0), t2 = foamT.clone(); t2.needsUpdate = true; t2.repeat.set(L / 2.6, 1);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(L, w), new THREE.MeshBasicMaterial({ map: t2, transparent: true, alphaTest: .5, color: '#8fa6c4' })); m.rotation.x = -Math.PI / 2; m.rotation.z = -Math.atan2(z1 - z0, x1 - x0);
    m.position.set((x0 + x1) / 2, SEA_Y + .03, (z0 + z1) / 2); scene.add(m); foams.push(t2); };
  foamStrip(-18.4, 3.7, 28, 3.7); foamStrip(-18.75, 3.4, -18.75, -21);

  // —— 灯塔岛 ——
  {
    const rm = mat(rock(128, 128, { seed: 7, cols: ['#121218', '#22212a', '#33313a', '#46434c', '#5c5862'] }));
    const g = new THREE.CylinderGeometry(4.2, 6.5, 3.6, 9, 3); const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i), k = 1 + (h2(Math.round(x * 3), Math.round(z * 3), 4) - .5) * .3; p.setX(i, x * k); p.setZ(i, z * k); }
    g.translate(0, 1.4, 0); const isl = mesh(g, rm); isl.position.copy(LH); scene.add(isl);
    const g2 = new THREE.CylinderGeometry(2.5, 4, 2.2, 8, 2); g2.translate(5, .6, 3); const i2 = mesh(g2, rm); i2.position.copy(LH); scene.add(i2);
    // 防波堤：从岛到码头西端的一串石块
    for (let k = 0; k < 7; k++) { const s = mesh(new THREE.BoxGeometry(2.4, 1.6, 2.2).translate(0, .3, 0), rm); s.position.set(LH.x + 7 + k * 2.3, SEA_Y, LH.z - 1 + k * .35); s.rotation.y = h2(k, 2, 5) * .6; scene.add(s); }
    foamStrip(LH.x - 6, LH.z + 5.5, LH.x + 6, LH.z + 5.5, .9);
  }
  const tower = new THREE.Group();
  {
    const P = new PX(48, 96), W = ramp(['#5e5a58', '#87827c', '#aaa49a', '#c8c2b4'], .45);
    P.fill((x, y) => { const course = y % 8 === 0, joint = (x + (Math.floor(y / 8) % 2) * 6) % 12 === 0; let v = .55 + (h2(x >> 1, y >> 1, 2) - .5) * .25; if (course || joint) v -= .3; return W(v, x, y); });
    const tm = new THREE.MeshStandardMaterial({ map: texOf(P.done()), roughness: .9 });
    const tw = new THREE.Mesh(new THREE.CylinderGeometry(.95, 1.35, 6.8, 16), tm); tw.position.y = 3.4 + 2.9; tw.castShadow = tw.receiveShadow = true; tower.add(tw);
    const door = box(.5, .9, .1, MM.plankDark); door.position.set(0, 2.9, 1.3); tower.add(door);
    const gal = new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.45, .16, 16), new THREE.MeshStandardMaterial({ color: '#1c1c22', roughness: .7 })); gal.position.y = 9.75; tower.add(gal);
    for (let k = 0; k < 16; k++) { const a = k / 16 * Math.PI * 2, r = box(.04, .45, .04, MM.plankDark, { cast: false }); r.position.set(Math.cos(a) * 1.4, 9.8, Math.sin(a) * 1.4); tower.add(r); }
    const room = new THREE.Mesh(new THREE.CylinderGeometry(.78, .78, 1.3, 12), new THREE.MeshStandardMaterial({ color: '#1a1e22', emissive: '#fff0c0', emissiveIntensity: 0, roughness: .3 })); room.position.y = LAMP_Y - .1; tower.add(room);
    for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2, m = box(.06, 1.3, .06, MM.plankDark, { cast: false }); m.position.set(Math.cos(a) * .8, LAMP_Y - .75, Math.sin(a) * .8); tower.add(m); }
    const capM = new THREE.MeshStandardMaterial({ color: '#1e3a3a', roughness: .6 });
    const cap = new THREE.Mesh(new THREE.ConeGeometry(1.05, 1.1, 12), capM); cap.position.y = LAMP_Y + 1.1; cap.castShadow = true; tower.add(cap);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(.13, 8, 6), capM); ball.position.y = LAMP_Y + 1.75; tower.add(ball);
    tower.userData.room = room;
  }
  tower.position.copy(LH); scene.add(tower);
  const LAMP = new THREE.Vector3(LH.x, LAMP_Y + SEA_Y, LH.z);
  const lhGlow = glow('#fff2c4', 5.5, 1.6); lhGlow.position.copy(LAMP); lhGlow.material.depthTest = false; lhGlow.renderOrder = 6; scene.add(lhGlow);
  const lhL = new THREE.PointLight('#ffe6b0', 0, 60, 1.4); lhL.position.copy(LAMP); scene.add(lhL);
  const beams = [0, 1].map(() => { const b = beamCard(90, .9, 14, '#fff0c8', { k: .5, fall: 1.1 }); scene.add(b); return b; });
  const spot = new THREE.SpotLight('#fff0d0', 0, 70, .2, .5, 1.2); spot.position.copy(LAMP); spot.castShadow = true; spot.shadow.mapSize.set(1024, 1024); spot.shadow.bias = -.002; scene.add(spot, spot.target);
  const sunLH = new THREE.PointLight('#ffb070', 0, 16, 1.5); sunLH.position.set(LH.x + 3, LAMP_Y + 1, LH.z + 4); scene.add(sunLH);

  // —— 远山 ——
  [[-300, -420, 520, 60, '#2a2a40', 3], [160, -460, 700, 50, '#24243a', 7], [-60, -520, 900, 90, '#1e1e34', 11]].forEach(([x, z, w, h, c, s]) => { const r = ridge(w, h, c, s, { ppm: 1.4 }); r.position.set(x, SEA_Y - 2, z); scene.add(r); });

  // —— 雨云：像素云团（看得见）+ 一张只投影不显形的云层（让云影扫过模型） ——
  const cloudTexs = [0, 1, 2].map(s => { const P = new PX(64, 30); P.fill((x, y) => { const dx = (x - 32) / 32, dy = (y - 18) / 14; const v = fbm(x * .07, y * .12, s + 40) + .55 - (dx * dx + dy * dy) * .75 - (y > 24 ? (y - 24) * .12 : 0); if (v < .45) return null; return ramp(['#1e2230', '#2e3444', '#3e4658', '#56607a', '#7a849c'], .45)(Math.min(.99, (v - .45) * 1.5 + (1 - y / 30) * .35), x, y); }); return texOf(P.done()); });
  const RC = mulberry(31), puffs = [];
  for (let i = 0; i < 70; i++) {
    const tex = cloudTexs[i % 3], w = 7 + RC() * 9, m = new THREE.MeshBasicMaterial({ map: tex, alphaTest: .5, transparent: false, fog: false, color: '#8890a0' });
    const me = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 30 / 64), m); scene.add(me);
    puffs.push({ me, xr: RC() * 110 - 4, y: 12 + RC() * 4, z: -34 + RC() * 44, sp: RC() });
  }
  const shTex = (() => { const c = document.createElement('canvas'); c.width = 256; c.height = 128; const g = c.getContext('2d'), d = g.createImageData(256, 128);
    for (let y = 0; y < 128; y++) for (let x = 0; x < 256; x++) { const v = fbm(x * .03, y * .04, 9) + (x < 18 ? -(18 - x) * .03 : 0); d.data[(y * 256 + x) * 4 + 3] = v > .36 ? 255 : 0; d.data[(y * 256 + x) * 4] = 255; }
    g.putImageData(d, 0, 0); const t = new THREE.CanvasTexture(c); t.magFilter = THREE.NearestFilter; return t; })();
  const shPlane = new THREE.Mesh(new THREE.PlaneGeometry(160, 90), new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, transparent: true, opacity: 0 }));
  shPlane.rotation.x = -Math.PI / 2; shPlane.castShadow = true;
  shPlane.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaMap: shTex, alphaTest: .5 });
  shPlane.customDepthMaterial.alphaMap = shTex; shPlane.material.alphaMap = shTex;
  scene.add(shPlane);

  // —— 雨：斜线，只下在云影线以东；地面溅起像素水花 ——
  const NR = 3200, rg = new THREE.BufferGeometry(), rp = new Float32Array(NR * 6), rc = new Float32Array(NR * 6);
  rg.setAttribute('position', new THREE.BufferAttribute(rp, 3)); rg.setAttribute('color', new THREE.BufferAttribute(rc, 3));
  const rainM = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const rainL = new THREE.LineSegments(rg, rainM); rainL.frustumCulled = false; scene.add(rainL);
  const RR = mulberry(9), rs = [...Array(NR)].map(() => [RR() * 90 - 40, RR(), RR() * 50 - 28, .75 + RR() * .5]);
  const splash = particles(500, (i, t, o) => o.a = 0, { soft: 0 }); scene.add(splash);
  // 闪电：远处一道像素折线
  const boltPts = []; { let x = 0, y = 0; const R3 = mulberry(5); boltPts.push([0, 0]); for (let k = 0; k < 14; k++) { x += (R3() - .5) * 2.2; y -= 1; boltPts.push([x, y]); } }
  const boltG = new THREE.Group(); boltPts.slice(1).forEach(([x, y], k) => { const [x0, y0] = boltPts[k]; const L = Math.hypot(x - x0, y - y0); const m = new THREE.Mesh(new THREE.PlaneGeometry(.35, L * 1.02), new THREE.MeshBasicMaterial({ color: new THREE.Color('#e8f0ff').multiplyScalar(6), fog: false })); m.position.set((x + x0) / 2, (y + y0) / 2, 0); m.rotation.z = Math.atan2(x - x0, -(y - y0)) * -1; boltG.add(m); });
  boltG.position.set(14, 12.5, -30); boltG.scale.set(1, .9, 1); scene.add(boltG);

  // —— 灯下浮尘、点燃时的火星 ——
  const R2 = mulberry(77), dust = [...Array(150)].map(() => [R2() * 26 - 13, .4 + R2() * 2.6, R2() * 3 - .4, R2() * 10]);
  const D = particles(dust.length, (i, t, o) => { const d = dust[i]; o.x = d[0] + Math.sin(t * .3 + d[3]) * .4 + t * .05; o.y = d[1] + Math.sin(t * .5 + d[3] * 2) * .15; o.z = d[2]; o.a = 0; o.s = .035; o.r = 1.4; o.g = 1.0; o.b = .6; }, { soft: 1 }); scene.add(D);
  const sparks = particles(60, (i, t, o) => o.a = 0); scene.add(sparks);

  const fill = new THREE.PointLight('#a8b8e8', 0, 7, 2); scene.add(fill);
  const fill2 = new THREE.PointLight('#a8b8e8', 0, 6, 2); scene.add(fill2);

  // ———————————————————— 镜头 ————————————————————
  const S0x = STALL_X[0];
  const cams = {
    storm: { p: track([[0, [6, 31, 47]], [4, [-6, 21, 33]], [8, [12, 13.5, 22]]]), l: track([[0, [-8, 0, -6]], [4, [-10, 0, -4]], [8, [4, .5, -1.5]]]), fov: track([[0, [34]], [8, [32]]]) },
    market: { p: track([[8, [S0x + 1.3, 2.05, 4.9]], [8.9, [S0x + 1.5, 2.6, 6.0]], [10.6, [S0x + 4.2, 6.5, 13]], [12.6, [S0x + 15.5, 14.5, 27]], [13, [S0x + 16, 14.8, 27.6]]]),
      l: track([[8, [S0x + .05, 1.25, .55]], [8.9, [S0x + .2, 1.3, .6]], [10.6, [S0x + 1.5, 1.1, -.5]], [12.6, [-12.5, 1.8, -5]], [13, [-13, 1.9, -5.2]]]), fov: track([[8, [30]], [12.6, [36]]]) },
    light: { th: track([[14, [3.55]], [15.4, [4.75]], [17.3, [5.7]], [19, [6.55]]]), r: track([[14, [11]], [15.4, [21]], [17.3, [37]], [19, [56]]]), h: track([[14, [13.2]], [15.4, [15]], [17.3, [22]], [19, [34]]]),
      l: track([[14, [LAMP.x, LAMP.y - .3, LAMP.z]], [15.1, [-25, 2.4, 0]], [15.6, [-19.5, 1.6, 5.6]], [17.3, [-22, 1.4, 4.5]], [19, [-20, 0, -1]]]), fov: track([[14, [32]], [19, [36]]]) },
  };
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), boatPos = new THREE.Vector3();

  // 光柱角度：在光柱扫过帆船的拍上正好指向船
  const hitP = boatPath(T.beamHit), HIT_ANG = Math.atan2(hitP[1] - LH.z, hitP[0] - LH.x), OMEGA = .95;
  const beamAngle = t => { const t0 = T.beam, a0 = HIT_ANG - OMEGA * ((T.beamHit - t0) - .25); if (t < t0) return a0; const d = t - t0; const ramp_ = d < .5 ? d * d / (2 * .5) : d - .25; return a0 + OMEGA * ramp_; };

  const COL = {
    hemiStorm: C3('#7a88a8'), hemiDusk: C3('#a888b8'), hemiNight: C3('#4c4c86'),
    gStorm: C3('#1a1820'), gDusk: C3('#2a1a22'), gNight: C3('#120e1c'),
    keyStorm: C3('#9aaac8'), keyDusk: C3('#ffa868'), keyNight: C3('#8a9ad8'),
    fogStorm: C3('#3e4a5c'), fogDusk: C3('#5a4668'), fogNight: C3('#221e3a'),
    skyTopS: C3('#1c2232'), skyMidS: C3('#2e384a'), skyHorS: C3('#4c566a'),
    skyTopD: C3('#2a2048'), skyMidD: C3('#5a3a6e'), skyHorD: C3('#e0886a'),
    skyTopN: C3('#0a0a1e'), skyMidN: C3('#1e1a40'), skyHorN: C3('#4a3060'),
  };

  function update(t, shotId, cam, post) {
    scene.updateMatrixWorld();
    // ——— 天气与时段 ———
    const E = cloudEdge(t), fl = flash(t);
    const storm = 1 - ss(seg(t, T.sunLH, T.cut1));               // 雨→黄昏
    const night = ss(seg(t, T.cut1 + .5, T.stop)) * .7 + ss(seg(t, T.stop, T.cut2)) * .3;   // 黄昏→夜
    const read = 1.0;                                               // 可读性补光（暗场也要看得清）
    hemi.color.copy(mixC(mixC(COL.hemiStorm, COL.hemiDusk, 1 - storm), COL.hemiNight, night));
    hemi.groundColor.copy(mixC(mixC(COL.gStorm, COL.gDusk, 1 - storm), COL.gNight, night));
    const closeK = shotId === 'market' ? 1 - ss(seg(t, 9.8, 11.2)) : 0;           // 点灯近景：环境光压低，灯投的影子要一跳就看得见
    hemi.intensity = lerp(lerp(2.7, 1.25, 1 - storm), .9, night) * read * (1 - .45 * closeK) + fl * 2.2;
    // 主光：暴雨时高而冷；云过后西边低斜暖阳；入夜降为冷月
    const el = lerp(1.2, .5, ss(seg(t, T.cloudGo, T.cut1))) , az = lerp(-.4, -.25, night);
    const kd = new THREE.Vector3(-Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(-az) + .25).normalize();
    key.position.copy(key.target.position).addScaledVector(kd, 90);
    key.color.copy(mixC(mixC(COL.keyStorm, COL.keyDusk, 1 - storm), COL.keyNight, night));
    key.intensity = lerp(lerp(1.35, 2.7, 1 - storm), .55, night);
    bolt.intensity = fl * 3.5;
    scene.fog.color.copy(mixC(mixC(COL.fogStorm, COL.fogDusk, 1 - storm), COL.fogNight, night)).multiplyScalar((1 + fl * 1.5) * (1 + .45 * storm));
    scene.fog.density = lerp(lerp(.0125, .0085, 1 - storm), .0075, night);
    SK.u.top.value.copy(mixC(mixC(COL.skyTopS, COL.skyTopD, 1 - storm), COL.skyTopN, night)); SK.u.mid.value.copy(mixC(mixC(COL.skyMidS, COL.skyMidD, 1 - storm), COL.skyMidN, night)); SK.u.hor.value.copy(mixC(mixC(COL.skyHorS, COL.skyHorD, 1 - storm), COL.skyHorN, night));
    SK.u.k.value = 1 + fl * 2.5; ST.material.uniforms.t.value = t; ST.material.uniforms.k.value = night * .8;

    // 云：可见云团 + 投影云层，都跟着后缘 E 走（太阳在西，云层比地面阴影线偏东）
    const sh = 13.5, off = sh * (kd.x / kd.y) * -1;
    shPlane.position.set(E + 80 + off, sh, -8);
    shPlane.visible = E < 40;
    puffs.forEach(p => { const x = E + 6 + off * .6 + p.xr + p.sp * 2 * Math.sin(t * .3 + p.xr); p.me.position.set(x, p.y, p.z); p.me.lookAt(cam.position); p.me.visible = x < 90 && shotId === 'storm';
      const lit = 1 + fl * 2.2 + (1 - storm) * .2; p.me.material.color.setRGB(.44 * lit, .47 * lit, .54 * lit); });
    boltG.visible = (t - T.lightning > 0 && t - T.lightning < .12) || (t - T.lightning > .2 && t - T.lightning < .27);
    boltG.lookAt(cam.position.x, boltG.position.y, cam.position.z);

    // 雨线：东半边下，西边已停；8.000 s 硬停
    const rainOn = t < T.cut1 ? 1 : 0, H = 14, sp = 24, wind = 4;
    for (let i = 0; i < NR; i++) { const s = rs[i], ph = ((s[1] * H - t * sp * s[3]) % H + H) % H, y = SEA_Y + ph, x = s[0] + (H - ph) / (sp * s[3]) * wind * 0 + (y - SEA_Y) * wind / sp, z = s[2];
      const gx = s[0]; const on = rainOn && gx > E + 2 ? 1 : 0; const b = on * (.5 + .25 * s[3]) * (1 + fl * 2);
      rp.set([x, y, z, x - wind / sp * .9, y + .9, z], i * 6); rc.set([b * .62, b * .72, b * .88, b * .1, b * .12, b * .15], i * 6); }
    rg.attributes.position.needsUpdate = rg.attributes.color.needsUpdate = true;
    rainL.visible = rainOn > 0;
    splash.userData.update(t);
    { const pa = splash.geometry.attributes, P = pa.position.array, A = pa.a.array, Sz = pa.sz.array, Cc = pa.col.array;
      for (let i = 0; i < 500; i++) { const cyc = Math.floor(t * 7 + h2(i, 1) * 7), u = (t * 7 + h2(i, 1) * 7) - cyc; const x = -20 + h2(i, cyc, 2) * 44, z = -4 + h2(i, cyc, 3) * 7.5; const on = rainOn && x > E + 2 && u < .35;
        P[i * 3] = x; P[i * 3 + 1] = .05 + u * .25; P[i * 3 + 2] = z; A[i] = on ? (1 - u / .35) * .7 : 0; Sz[i] = .028; Cc[i * 3] = .7; Cc[i * 3 + 1] = .8; Cc[i * 3 + 2] = 1; }
      pa.position.needsUpdate = pa.a.needsUpdate = true; }

    // ——— 灯 ———
    const lights = [];
    stalls.forEach((S, i) => {
      const lv = popLevel(t, POP_T[i], S.seed);
      const dp = t - POP_T[i], pk = dp >= -1e-6 ? Math.exp(-Math.max(0, dp) / .1) : 0, lvS = dp >= -1e-6 ? (dp > .25 ? flick(t, S.seed) : 1) : 0;
      S.lm.emissiveIntensity = Math.min(lv, 1.15) * 2.4; S.L.intensity = Math.pow(Math.min(lv, 1.5), 1.3) * 6.2;
      // 辉光精灵只跟常亮水平走，点亮那一下只多一点点（以前峰值是常亮的 1.8 倍，把摊主盖成白剪影）
      S._lvS = lvS; S._pk = pk;   // 辉光精灵的大小在镜头定好之后再算（见 update 末尾）
      if (i % 3 === 0) lights.push({ p: S.gl.getWorldPosition(new THREE.Vector3()), c: S.L.color, i: lv * .5 });
      // 摊主：点灯前举杆（第一盏有完整的预备—点燃—收手）
      const kp = S.kp; let f = (Math.floor(t * 1.4 + i * .37) % 2) ? 'idle1' : 'idle0'; if (Math.floor(t * 8 + i * 5) % 31 === 0) f = 'blink';
      if (i === 0) { if (t >= T.cut1 + .25 && t < POP_T[0] + .5) f = Math.floor(t * 6) % 2 ? 'reachB' : 'reach'; else if (t >= POP_T[0] + .5 && t < POP_T[0] + 1.2) f = 'look'; }
      else if (t > POP_T[i] - .35 && t < POP_T[i] + .25) f = 'reach';
      kp.frame(f); kp.face(cam);
    });
    crowd.forEach((c, i) => { let f = (Math.floor(t * 1.2 + i * .5) % 2) ? 'idle1' : 'idle0'; if (t > T.festoon && t < T.festoon + .9) f = 'look'; if (Math.floor(t * 8 + i * 3) % 37 === 0) f = 'blink'; c.frame(f); c.face(cam); });
    // 彩灯串 + 全城窗灯：在第 19 拍一齐亮
    const fv = popLevel(t, T.festoon, 4);
    bulbs.forEach((b, k) => { const d = t - T.festoon, w = d < -1e-6 ? 0 : fv * (.85 + .15 * Math.sin(t * 3 + k)); b.m.emissiveIntensity = w * 4; b.gl.material.opacity = Math.min(1, w * .9); b.gl.scale.setScalar(.55 + (d >= -1e-6 ? .9 * Math.exp(-Math.max(0, d) / .1) : 0)); });
    festL.forEach(L => L.intensity = fv * 5);
    WIN.emissiveIntensity = lerp(0.0, .35, ss(seg(t, T.cut1, T.festoon))) + fv * 2.0;
    winL.forEach((L, i) => L.intensity = fv * 6 * (1 + .04 * Math.sin(t * 3 + i)));
    lights.push({ p: new THREE.Vector3(0, 3, 1.6), c: C3('#ffc080'), i: fv * .6 });
    D.userData.update(t); { const A = D.geometry.attributes.a.array; for (let i = 0; i < A.length; i++) A[i] = (t > T.cut1 ? .25 + .2 * Math.sin(t * 1.3 + i) : 0) * (t < T.cut2 ? 1 : .6); D.geometry.attributes.a.needsUpdate = true; }

    // ——— 灯塔 ———
    let lh = 0; const di = Math.abs(t - T.cut2) < 1e-6 ? 0 : t - T.cut2;
    if (di >= 0) lh = di < .06 ? 1.8 : di < .12 ? .5 : di < .2 ? 1.5 : di < .26 ? .7 : 1.2 + .25 * Math.exp(-(di - .26) / .3);
    const burst = di >= 0 ? Math.exp(-di / .22) : 0;
    // 点燃的闪光只占 1 帧；第 2 帧起辉光收小、变淡，灯室和塔身轮廓立刻露出来
    const first = di >= 0 && di < .5 / 60, burstEx = di < 0 ? 0 : first ? 1 : .45 * Math.exp(-di / .12);
    const gsz = clamp(cam.position.distanceTo(LAMP) * .085, .75, 5), fresh = di >= 0 && !first ? lerp(.35, 1, ss(seg(di, .05, .8))) : 1;
    lhGlow.material.opacity = Math.min(1, lh) * clamp(cam.position.distanceTo(LAMP) / 30, .45, 1) * fresh;
    lhGlow.scale.setScalar(gsz * (.5 + .4 * Math.min(lh, 1.2)) + (first ? .22 : .08 * burst) * gsz);
    lhL.intensity = Math.min(lh, 1.25) * 110; tower.userData.room.material.emissiveIntensity = Math.min(lh, 1.3) * 1.5;
    sunLH.intensity = ss(seg(t, T.sunLH - .2, T.sunLH + .6)) * (1 - ss(seg(t, T.cut1, T.stop))) * 30;
    const bOn = di >= 0 ? ss(seg(t, T.cut2 + .1, T.cut2 + .5)) : 0, ba = beamAngle(t);
    let face = 0;
    beams.forEach((bm, i) => { const ang = ba + i * Math.PI, dir = new THREE.Vector3(Math.cos(ang), -.06, Math.sin(ang)); const side = bm.userData.aim(LAMP, dir, cam);
      bm.visible = bOn > .01; bm.material.uniforms.k.value = .6 * bOn * Math.pow(side, 1.4); bm.material.uniforms.t.value = t;
      const toward = dir.dot(cam.position.clone().sub(LAMP).normalize()); face = Math.max(face, Math.pow(Math.max(0, toward), 24)); });
    lhGlow.scale.multiplyScalar(1 + face * .8 * bOn);
    spot.intensity = bOn * 220; spot.target.position.copy(LAMP).add(new THREE.Vector3(Math.cos(ba), -.45, Math.sin(ba)).multiplyScalar(30)); spot.target.updateMatrixWorld();
    lights.unshift({ p: LAMP, c: C3('#fff0c8'), i: lh * 1.3 });
    // 火星（点燃那一下）
    sparks.userData.update(t); { const pa = sparks.geometry.attributes; for (let i = 0; i < 60; i++) { const u = di - h2(i, 3) * .1; const on = di >= 0 && u > 0 && u < 1.2; const a = h2(i, 1) * 6.283, r = u * (1.2 + h2(i, 2) * 2.2);
      pa.position.array.set([LAMP.x + Math.cos(a) * r, LAMP.y + u * 1.2 - u * u * 1.5 + h2(i, 4) * .6, LAMP.z + Math.sin(a) * r], i * 3); pa.a.array[i] = on ? (1 - u / 1.2) * 1.6 : 0; pa.sz.array[i] = .06; pa.col.array.set([3, 2.2, 1.2], i * 3); }
      pa.position.needsUpdate = pa.a.needsUpdate = true; }

    // ——— 帆船 ———
    const bp = t < T.sail + .15 ? [BOAT0.x, BOAT0.z] : boatPath(t);
    const bob = Math.sin(t * 1.6) * .05; boatPos.set(bp[0], BOAT0.y + bob, bp[1]);
    const ahead = t < T.sail + .15 ? [BOAT0.x - 1, BOAT0.z] : boatPath(t + .1);
    const hd = Math.atan2(-(ahead[1] - bp[1]), ahead[0] - bp[0]);
    boat.position.copy(boatPos); boat.rotation.set(Math.sin(t * 1.3) * .03, t < T.sail + .15 ? Math.PI : hd, Math.sin(t * 1.1) * .025); boat.updateMatrixWorld(true);
    // 扬帆：四步拉起（像素物件也"跳帧"），落在扬帆拍上
    const hoist = t < T.sail - .45 ? 0 : t >= T.sail - 1e-6 ? 1 : Math.floor((t - (T.sail - .45)) / .45 * 4 + 1) / 4 * .45;
    sailG.scale.set(1, Math.max(.04, hoist), 1); sail.visible = hoist > .03; furl.visible = hoist < .5;
    const beamHitK = Math.exp(-Math.pow((t - T.beamHit) / .18, 2));
    sailM.emissiveIntensity = beamHitK * .9 + (hoist > 0 ? .06 : 0);
    // 水手
    const sw = new THREE.Vector3(.5, .34, .1).applyEuler(boat.rotation).add(boatPos);
    sailor.root.position.copy(sw);
    let sf = 'idle0';
    if (t < T.sail - .5) sf = Math.floor(t * 1.4) % 2 ? 'idle1' : 'idle0';
    else if (t < T.sail) sf = Math.floor(t * 6) % 2 ? 'haul1' : 'haul0';
    else if (t < T.beamHit) sf = 'hold';
    else sf = Math.floor(t * 3) % 2 ? 'wave1' : 'wave0';
    sailor.frame(sf); sailor.face(cam);
    lights.push({ p: bLanG.getWorldPosition(new THREE.Vector3()), c: C3('#ffb45a'), i: .45 });
    // 船尾的像素尾迹
    boatWake.userData.update(t); { const pa = boatWake.geometry.attributes; for (let i = 0; i < 70; i++) { const age = (i / 70) * 1.6, tb = t - age, ok = t > T.sail + .3 && tb > T.sail + .15;
      const q = ok ? boatPath(tb) : [0, 0], side = (i % 2 ? 1 : -1) * age * .5; pa.position.array.set([q[0] + side * .3, SEA_Y + .04, q[1] + side], i * 3); pa.a.array[i] = ok ? (1 - age / 1.6) * .8 : 0; pa.sz.array[i] = .05; pa.col.array.set([.75, .85, 1], i * 3); }
      pa.position.needsUpdate = pa.a.needsUpdate = true; }

    SEA.u.t.value = t; SEA.u.camPos.value.copy(cam.position); SEA.u.fogColor.value.copy(scene.fog.color); SEA.u.fogDensity.value = scene.fog.density; SEA.u.bright.value = 1;
    SEA.u.calm.value = 1 - storm * .6;
    SEA.u.deep.value.copy(mixC(C3('#0c1622'), C3('#120c22'), 1 - storm)); SEA.u.shallow.value.copy(mixC(C3('#22344a'), C3('#3a2a50'), 1 - storm).lerp(C3('#141432'), night));
    SEA.u.crest.value.copy(mixC(C3('#56708c'), C3('#c08a8a'), (1 - storm) * (1 - night)).lerp(C3('#4a5a8a'), night));
    SEA.setLights(lights);
    foams.forEach((f, i) => f.offset.set(Math.sin(t * .6 + i) * .08, Math.floor(t * 4) % 2 * .12));

    // ——— 镜头 ———
    let focusP;
    fill.intensity = 0; fill2.intensity = 0;
    if (shotId === 'storm') {
      const C = cams.storm; cam.position.set(...C.p(t)); cam.fov = C.fov(t)[0]; cam.updateProjectionMatrix(); cam.lookAt(...C.l(t));
      const mkt = new THREE.Vector3(-1.2, 1.1, STALL_Z);                     // 集市那一排的中点
      focusP = mkt;
      _v.copy(mkt).project(cam);
      post.dof.aper = lerp(520, 420, seg(t, 0, 8)); post.tilt = { c: clamp(_v.y * .5 + .5, .2, .8), w: .042, f: .16, amt: 24 };
    } else if (shotId === 'market') {
      const C = cams.market; cam.position.set(...C.p(t)); cam.fov = C.fov(t)[0]; cam.updateProjectionMatrix(); cam.lookAt(...C.l(t));
      const kp0 = new THREE.Vector3(S0x, 1.1, STALL_Z + .2);
      const u = ss(seg(t, 9.6, 12.6));
      focusP = kp0.clone().lerp(new THREE.Vector3(-3, 1, .5), u);
      // 13.000–14.000：机位锁死，焦点从集市拉到远处暗着的灯塔
      const rk = eio(seg(t, T.stop + .05, T.stop + .75));
      if (rk > 0) focusP.lerp(LAMP, rk);
      fill.position.set(S0x + .6, 1.6, STALL_Z + 2.4); fill.intensity = 1.15 * (1 - u);
      post.dof.aper = lerp(150, 380, u);
      _v.copy(focusP).project(cam); post.tilt = { c: clamp(_v.y * .5 + .5, .2, .8), w: .075 };
    } else {
      const C = cams.light, th = C.th(t)[0], r = C.r(t)[0], hh = C.h(t)[0];
      cam.position.set(LAMP.x + Math.sin(th) * r, hh, LAMP.z + Math.cos(th) * r); cam.fov = C.fov(t)[0]; cam.updateProjectionMatrix();
      // 16.0–17.3 s：镜头压低贴近帆船（光柱扫过红帆时船占画面高 1/4 以上），之后再升起到全景
      const near = ss(seg(t, 15.45, 16.25)) * (1 - eio(seg(t, 17.3, 18.45)));
      const lk = new THREE.Vector3(...C.l(t));
      if (near > 0) {
        const bAim = boatPos.clone().add(new THREE.Vector3(0, .7, 0)), d = cam.position.clone().sub(boatPos).setY(0).normalize();
        const pNear = boatPos.clone().addScaledVector(d, 15.5).add(new THREE.Vector3(.0, 9.2, 0));
        cam.position.lerp(pNear, near); lk.lerp(bAim, near);
      }
      cam.lookAt(lk);
      const toBoat = ss(seg(t, 14.7, 15.4));
      focusP = LAMP.clone().lerp(boatPos.clone().add(new THREE.Vector3(0, 1.6, 0)), toBoat);
      fill2.position.copy(sw).add(new THREE.Vector3(0, 1.4, 0)).addScaledVector(cam.position.clone().sub(sw).setY(0).normalize(), 2); fill2.intensity = 1.4;
      post.dof.aper = lerp(160, 420, seg(t, 14, 19));
      _v.copy(focusP).project(cam); const narrow = ss(seg(t, 18.1, 18.95));
      post.tilt = { c: clamp(_v.y * .5 + .5, .2, .8), w: lerp(.075, .03, narrow), f: lerp(.3, .2, narrow) };
    }
    // 精灵朝向放在镜头定好之后再算（否则剪切后第一帧、以及并行渲染每段的第一帧会朝着上一个机位，侧成一条线看不见）
    cam.updateMatrixWorld(); stalls.forEach(S => S.kp.face(cam));
    stalls.forEach(S => { const near_ = clamp((cam.position.distanceTo(S.gl.getWorldPosition(_w)) - 3) / 9, .25, 1);   // 镜头贴得越近，辉光越收（别盖住身后的摊主）
      S.gl.material.opacity = Math.min(.8, S._lvS * .7) * (1 + .25 * S._pk) * near_; S.gl.scale.setScalar(1.1 * S._lvS * (1 + .3 * S._pk) * (.5 + .5 * near_)); }); crowd.forEach(c => c.face(cam)); sailor.face(cam);
    post.dof.focus = cam.position.distanceTo(focusP); post.dof.maxCoc = 22;
    post.flash = fl; post.burst = burstEx; post.night = night;
    return { E, fl, boatPos };
  }
  return { scene, update, stalls, bulbs, LAMP };
}
