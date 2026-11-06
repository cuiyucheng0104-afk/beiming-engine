// 小岛：六角柱地形 + 低多边形道具（风车、房屋、树、码头、船、鸟、烟）+ 每帧动画
// 所有动画只取决于 t（叶片角度用固定步长从 0 积分，任何一帧都能单独渲染）
import * as THREE from 'three';
import { clamp, seg, ss, eo, lerp, hash, TAU } from '/core/lib.js';
import { T, BEAT, MILL_W, WIN_BEATS, WIN_NOTES, b, AZ0, DUR } from './timeline.js';
import { waveH } from './sea.js';

const SQ3 = Math.sqrt(3), DEG = Math.PI / 180;
export const hex2w = (q, r) => [SQ3 * (q + r / 2), 1.5 * r];
const hdist = (q, r) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));

const MC = new Map();
export function mat(hex, o = {}) {
  const k = hex + JSON.stringify(o);
  if (!MC.has(k)) MC.set(k, new THREE.MeshStandardMaterial({ color: hex, flatShading: true, roughness: .9, metalness: 0, ...o }));
  return MC.get(k);
}
const jit = (hex, a) => { const c = new THREE.Color(hex), h = {}; c.getHSL(h); c.setHSL(h.h, h.s, clamp(h.l * (1 + a))); return '#' + c.getHexString(); };
const M = (g, m, cast = true) => { const x = new THREE.Mesh(g, m); x.castShadow = cast; x.receiveShadow = true; return x; };

// 调色：橄榄绿草地 + 奶油沙 + 赤陶屋顶 + 一抹薄荷/薰衣草墙面（与演示片的珊瑚屋顶岛不同）
export const PAL = {
  sandTop: '#f1e2b8', sandSide: '#dcc394', grass: ['#a8c97a', '#97bf6c', '#b3d084'], earth: '#c49a72', earth2: '#a98058',
  rockTop: '#c3bfb8', rockSide: '#9a958e',
  walls: ['#fbf4e8', '#cfe4d6', '#f3d6c2', '#dcd3ec', '#fbf4e8', '#f6e2a8'],
  roofs: ['#c8583f', '#3f6f8f', '#d27a46', '#5f5a8a', '#b8473c', '#3f7f74'],
  pine: ['#4a8a5c', '#5b9a66'], leaf: ['#86c06c', '#9fcf73', '#76b35f'], trunk: '#8a5c3e',
  glass: '#4a5873', warm: '#ffc676', wood: '#a8764e', woodDark: '#6f4a31', millWall: '#f5efe3', millCap: '#b8473c',
};

// —— 布局：半径 3 的六角岛，去掉几格海岸，东侧伸出一段沙嘴（码头）——
const REMOVE = new Set(['-3,0', '0,3', '3,-3', '-2,3']);
const EXTRA = ['4,-2', '4,-1'];
function layout() {
  const cells = [];
  const add = (q, r, d) => {
    const [x, z] = hex2w(q, r), key = q + ',' + r, ang = ((Math.atan2(z, x) / DEG) + 360) % 360;
    let type = 'grass', h = .8;
    if (d === 0) { h = 1.55; }
    else if (d === 1) { h = [1.18, 1.04, 1.12, 1.0, 1.1, 1.02][Math.round(ang / 60) % 6]; }
    else if (d === 2) { h = .76 + (hash(q * 7 + r * 13) > .5 ? .12 : 0); if (key === '-2,0' || key === '0,-2') { type = 'rock'; h = 1.05; } }
    else { type = 'sand'; h = .36 + hash(q * 3 + r * 5) * .06; if (key === '-1,-2') { type = 'rock'; h = .6; } }
    cells.push({ q, r, d, x, z, ang, key, type, h });
  };
  for (let q = -3; q <= 3; q++) for (let r = -3; r <= 3; r++) { const d = hdist(q, r); if (d <= 3 && !REMOVE.has(q + ',' + r)) add(q, r, d); }
  EXTRA.forEach(k => { const [q, r] = k.split(',').map(Number); add(q, r, 3); });
  return cells;
}
export const CELLS = layout();
const cell = k => CELLS.find(c => c.key === k);

function hexPrism(r, h, top, side, y0 = -2.4) {
  const g = new THREE.Group(), bt = h - .1;
  const body = M(new THREE.CylinderGeometry(r * .985, r * .985, bt - y0, 6, 1), mat(side)); body.position.y = (bt + y0) / 2; g.add(body);
  const cap = M(new THREE.CylinderGeometry(r, r, .16, 6, 1), mat(top)); cap.position.y = h - .08; g.add(cap);
  return g;
}
function gable(w, d, h, over = .08) {
  const W = w / 2 + over, D = d / 2 + over, g = new THREE.BufferGeometry();
  const v = [-W, 0, -D, W, 0, -D, W, h, 0, -W, 0, -D, W, h, 0, -W, h, 0, -W, 0, D, -W, h, 0, W, h, 0, -W, 0, D, W, h, 0, W, 0, D,
    -W, 0, -D, -W, 0, D, W, 0, D, -W, 0, -D, W, 0, D, W, 0, -D];
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); g.computeVertexNormals(); return g;
}
function gableEnds(w, d, h) {
  const W = w / 2, D = d / 2, g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([W, 0, -D, W, 0, D, W, h, 0, -W, 0, D, -W, 0, -D, -W, h, 0], 3)); g.computeVertexNormals(); return g;
}

// 地面上的暖色光斑（窗/灯照到地面）：加法混合的径向渐变
function poolMat() {
  return new THREE.ShaderMaterial({
    uniforms: { amt: { value: 0 }, col: { value: new THREE.Color(PAL.warm) } },
    vertexShader: `varying vec2 vU; void main(){ vU = uv - .5; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
    fragmentShader: `varying vec2 vU; uniform float amt; uniform vec3 col; void main(){ float r = length(vU) * 2.; float a = pow(clamp(1. - r, 0., 1.), 1.8) * amt; gl_FragColor = vec4(col * a, a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

// 房屋：wins = [[面, 层, 偏移]]，面 'x' = +x 墙，'z' = +z 墙（夜景机位 az=40° 正好看见这两面）
function makeHouse(i, floors, wins, roofRot) {
  const g = new THREE.Group(), Wd = .9, FH = .6, wall = mat(PAL.walls[i % 6]);
  const body = M(new THREE.BoxGeometry(Wd, FH * floors, Wd), wall); body.position.y = FH * floors / 2; g.add(body);
  if (floors > 1) { const band = M(new THREE.BoxGeometry(Wd + .03, .04, Wd + .03), mat(jit(PAL.walls[i % 6], -.12))); band.position.y = FH; g.add(band); }
  const roof = new THREE.Group(); roof.add(M(gable(Wd, Wd, .48), mat(PAL.roofs[i % 6]))); roof.add(M(gableEnds(Wd - .01, Wd - .01, .48), wall));
  roof.position.y = FH * floors; roof.rotation.y = roofRot; g.add(roof);
  // 门（+z 面，夜里不亮）
  const door = new THREE.Mesh(new THREE.BoxGeometry(.2, .34, .03), mat(PAL.woodDark)); door.position.set(-.22, .17, Wd / 2 + .012); g.add(door);
  const out = [];
  wins.forEach(([face, fl, off]) => {
    const m = new THREE.MeshStandardMaterial({ color: PAL.glass, emissive: PAL.warm, emissiveIntensity: 0, flatShading: true, roughness: .4 });
    const w = new THREE.Mesh(new THREE.BoxGeometry(.21, .26, .06), m); w.castShadow = false; w.receiveShadow = true;
    const fr = M(new THREE.BoxGeometry(.27, .32, .035), mat('#f8f3ea'), false);
    const y = fl * FH + FH * .55;
    const n = face === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const pos = face === 'x' ? new THREE.Vector3(Wd / 2 + .02, y, off) : new THREE.Vector3(off, y, Wd / 2 + .02);
    w.position.copy(pos); fr.position.copy(pos).addScaledVector(n, -.012); if (face === 'x') { w.rotation.y = Math.PI / 2; fr.rotation.y = Math.PI / 2; }
    g.add(fr, w);
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.4), poolMat()); pool.rotation.x = -Math.PI / 2;
    pool.position.set(pos.x + n.x * .5, .012, pos.z + n.z * .5); pool.visible = false; g.add(pool);
    out.push({ mesh: w, m, pool, local: pos.clone(), n });
  });
  let chimney = null;
  if (i % 2 === 0) { chimney = M(new THREE.BoxGeometry(.13, .34, .13), mat('#b9a596')); chimney.position.set(.22, FH * floors + .36, -.18); g.add(chimney); }
  return { g, wins: out, chimney, top: FH * floors + .48 };
}

function makeTree(kind, s) {
  const g = new THREE.Group();
  if (kind === 'pine') {
    const tr = M(new THREE.CylinderGeometry(.06, .08, .3, 5), mat(PAL.trunk)); tr.position.y = .15; g.add(tr);
    const c1 = M(new THREE.ConeGeometry(.36, .62, 6), mat(PAL.pine[0])); c1.position.y = .55; g.add(c1);
    const c2 = M(new THREE.ConeGeometry(.25, .48, 6), mat(PAL.pine[1])); c2.position.y = .9; c2.rotation.y = .5; g.add(c2);
  } else {
    const tr = M(new THREE.CylinderGeometry(.06, .08, .36, 5), mat(PAL.trunk)); tr.position.y = .18; g.add(tr);
    const c = M(new THREE.IcosahedronGeometry(.36, 0), mat(PAL.leaf[Math.floor(s * 3) % 3])); c.position.y = .62; c.rotation.set(s * 3, s * 5, 0); g.add(c);
  }
  g.scale.setScalar(.85 + s * .35);
  return g;
}

// 风车：八棱锥台塔身 + 石基环 + 红锥顶 + 四片格栅叶片 + 顶上的小灯笼（全片的"最后一块"）
function makeMill() {
  const g = new THREE.Group();
  const base = M(new THREE.CylinderGeometry(.56, .6, .16, 8), mat(PAL.rockTop)); base.position.y = .08; g.add(base);
  const tower = M(new THREE.CylinderGeometry(.34, .5, 1.6, 8), mat(PAL.millWall)); tower.position.y = .16 + .8; g.add(tower);
  const ring = M(new THREE.CylinderGeometry(.42, .42, .06, 8), mat(PAL.woodDark)); ring.position.y = 1.78; g.add(ring);
  const cap = M(new THREE.ConeGeometry(.46, .56, 8), mat(PAL.millCap)); cap.position.y = 1.81 + .28; g.add(cap);
  const door = new THREE.Mesh(new THREE.BoxGeometry(.2, .32, .04), mat(PAL.woodDark)); door.position.set(0, .32, .47); door.rotation.x = -.08; g.add(door);
  const win = new THREE.Mesh(new THREE.BoxGeometry(.13, .17, .04), mat(PAL.glass)); win.position.set(0, 1.12, .405); win.rotation.x = -.08; g.add(win);
  // 灯笼
  const lampG = new THREE.Group(); lampG.position.y = 2.37;
  const post = M(new THREE.CylinderGeometry(.025, .025, .12, 5), mat(PAL.woodDark)); post.position.y = .02; lampG.add(post);
  const lampM = new THREE.MeshStandardMaterial({ color: '#5a5f78', emissive: '#ffcf86', emissiveIntensity: 0, flatShading: true, roughness: .35 });
  const glass = new THREE.Mesh(new THREE.BoxGeometry(.17, .19, .17), lampM); glass.position.y = .17; glass.castShadow = false; lampG.add(glass);
  const lroof = M(new THREE.ConeGeometry(.15, .13, 4), mat(PAL.woodDark)); lroof.position.y = .33; lroof.rotation.y = Math.PI / 4; lampG.add(lroof);
  const lbase = M(new THREE.BoxGeometry(.2, .03, .2), mat(PAL.woodDark)); lbase.position.y = .07; lampG.add(lbase);
  g.add(lampG);
  // 叶片
  const hub = new THREE.Group(); hub.position.set(0, 1.62, .56);
  const hubC = M(new THREE.CylinderGeometry(.07, .07, .14, 6), mat(PAL.woodDark)); hubC.rotation.x = Math.PI / 2; hub.add(hubC);
  const axle = M(new THREE.CylinderGeometry(.03, .03, .3, 5), mat(PAL.woodDark)); axle.rotation.x = Math.PI / 2; axle.position.z = -.14; hub.add(axle);
  for (let k = 0; k < 4; k++) {
    const bl = new THREE.Group(); bl.rotation.z = k * Math.PI / 2 + .3;
    const spar = M(new THREE.BoxGeometry(.05, 1.12, .04), mat(PAL.wood)); spar.position.y = .58; bl.add(spar);
    const sail = M(new THREE.BoxGeometry(.24, .78, .018), mat('#fbf6ea')); sail.position.set(.14, .7, .01); bl.add(sail);
    for (let j = 0; j < 4; j++) { const rib = M(new THREE.BoxGeometry(.27, .022, .03), mat(PAL.wood)); rib.position.set(.14, .36 + j * .22, .02); bl.add(rib); }
    hub.add(bl);
  }
  g.add(hub);
  return { g, hub, lampM, lampG };
}

function makeBoat() {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  const hg = new THREE.BoxGeometry(.9, .22, .4, 2, 1, 1), p = hg.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i); if (x > .3) p.setZ(i, p.getZ(i) * .15); if (p.getY(i) < 0) p.setZ(i, p.getZ(i) * .7); }
  hg.computeVertexNormals();
  const hull = M(hg, mat('#3f6f8f')); hull.position.y = .1; body.add(hull);
  const rim = M(new THREE.BoxGeometry(.66, .04, .34), mat('#f4efe4')); rim.position.set(-.08, .22, 0); body.add(rim);
  return { g, body };
}

function makeBird() {
  const g = new THREE.Group();
  const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -.07, 0, 0, .07, .26, 0, 0], 3)); wg.computeVertexNormals();
  const m = mat('#fbfaf6', { side: THREE.DoubleSide });
  const L = new THREE.Mesh(wg, m), R = new THREE.Mesh(wg, m); R.rotation.y = Math.PI;
  const bd = new THREE.Mesh(new THREE.BoxGeometry(.06, .05, .2), m);
  g.add(L, R, bd); g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { g, L, R };
}

export function buildWorld(scene) {
  const S = new THREE.Group(); scene.add(S);
  // 地形
  CELLS.forEach(c => {
    const j = (hash(c.q * 17 + c.r * 31) - .5) * .08;
    let top = PAL.grass[Math.floor(hash(c.q * 5 - c.r * 11) * 3)], side = c.d <= 1 ? PAL.earth2 : PAL.earth;
    if (c.type === 'sand') { top = PAL.sandTop; side = PAL.sandSide; }
    if (c.type === 'rock') { top = PAL.rockTop; side = PAL.rockSide; }
    const g = hexPrism(1, c.h, jit(top, j), jit(side, j * .7)); g.position.set(c.x, 0, c.z); S.add(g);
  });
  // 海岸浪圈
  const surf = CELLS.filter(c => c.d >= 3 || c.key === '-2,0').map(c => {
    const m = new THREE.Mesh(new THREE.RingGeometry(.99, 1.1, 6, 1), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: .3, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.rotation.z = Math.PI / 6 * 0 + Math.PI / 2; m.position.set(c.x, .04, c.z); S.add(m); return { m, c };
  });
  // 浅水图
  const blobs = CELLS.map(c => [c.x, c.z, c.d >= 3 ? 2.6 : 2.2, 1]);

  // 风车（中心山顶）
  const mill = makeMill(); const mc = cell('0,0'); mill.g.position.set(mc.x, mc.h, mc.z); mill.g.rotation.y = AZ0 * DEG + .1; S.add(mill.g);
  const lampWorld = new THREE.Vector3();
  const lampPool = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 5.5), poolMat()); lampPool.rotation.x = -Math.PI / 2; lampPool.position.set(mc.x, mc.h + .02, mc.z); lampPool.visible = false; S.add(lampPool);
  const lampLight = new THREE.PointLight('#ffc67a', 0, 7, 1.6); S.add(lampLight);
  // 光晕精灵（AO 时会被隐藏）
  const hc = document.createElement('canvas'); hc.width = hc.height = 128; const hg = hc.getContext('2d');
  const gr = hg.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,236,190,1)'); gr.addColorStop(.18, 'rgba(255,205,130,.55)'); gr.addColorStop(.5, 'rgba(255,170,90,.12)'); gr.addColorStop(1, 'rgba(255,160,80,0)');
  hg.fillStyle = gr; hg.fillRect(0, 0, 128, 128);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(hc), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  halo.visible = false; S.add(halo);

  // 房屋：近侧 6 栋（夜景机位能看到它们的 +x / +z 两面）
  const HOUSES = [
    ['2,0', 1, [['z', 0, .2], ['x', 0, 0]], 0],
    ['1,1', 2, [['z', 1, .15], ['x', 0, -.15]], Math.PI / 2],
    ['0,2', 1, [['x', 0, .1]], 0],
    ['-1,2', 2, [['z', 0, .2], ['x', 1, 0]], Math.PI / 2],
    ['2,-2', 1, [['z', 0, .18]], Math.PI / 2],
    ['2,-1', 2, [['z', 1, 0], ['x', 0, .15]], 0],
  ];
  const houses = HOUSES.map(([k, fl, w, rr], i) => { const c = cell(k); const h = makeHouse(i, fl, w, rr); h.g.position.set(c.x + .1, c.h, c.z + .05); S.add(h.g); h.c = c; return h; });
  // 窗：按夜景屏幕从左到右排序 → 依次点亮
  const R = new THREE.Vector3(Math.cos(AZ0 * DEG), 0, -Math.sin(AZ0 * DEG));
  S.updateMatrixWorld(true);
  const wins = [];
  houses.forEach(h => h.wins.forEach(w => { const p = w.mesh.getWorldPosition(new THREE.Vector3()); wins.push({ ...w, wp: p, sx: p.dot(R) }); }));
  wins.sort((a, b) => a.sx - b.sx);
  if (wins.length !== WIN_BEATS.length) console.error('window count mismatch', wins.length);
  wins.forEach((w, i) => { w.t = b(WIN_BEATS[i]); w.note = WIN_NOTES[i]; });

  // 树
  const TREES = [['1,0', 'ico'], ['-1,1', 'pine'], ['0,-1', 'pine'], ['-1,0', 'ico'], ['1,-1', 'ico'], ['-2,1', 'pine'], ['-2,2', 'ico'], ['-1,-1', 'pine'], ['1,-2', 'pine'], ['3,-2', 'ico'], ['-3,2', 'pine'], ['0,1', 'ico'], ['-3,1', 'ico'], ['1,-3', 'pine']];
  const trees = [];
  TREES.forEach(([k, kind], i) => {
    const c = cell(k); if (!c) return;
    const n = c.d <= 1 ? 1 : 2;
    for (let j = 0; j < n; j++) {
      const s = hash(i * 7 + j * 3 + 1), a = hash(i * 11 + j) * TAU, rr = c.d === 0 ? 0 : (c.d <= 1 ? .45 : .5);
      const tr = makeTree(kind, s); tr.position.set(c.x + Math.cos(a) * rr * (j ? 1 : .6), c.h, c.z + Math.sin(a) * rr * (j ? 1 : .6)); S.add(tr); trees.push(tr);
    }
  });
  // 石头
  [['-2,0', 3], ['0,-2', 2], ['-1,-2', 2]].forEach(([k, n], i) => { const c = cell(k); for (let j = 0; j < n; j++) { const s = hash(i * 13 + j * 5); const r = M(new THREE.IcosahedronGeometry(.16 + s * .14, 0), mat(j % 2 ? PAL.rockTop : PAL.rockSide)); const a = s * TAU; r.position.set(c.x + Math.cos(a) * .4, c.h + .05, c.z + Math.sin(a) * .4); r.rotation.set(s * 4, s * 7, s); S.add(r); } });
  // 干草垛（远侧田）
  [['-2,-1'], ['-1,-1']].forEach(([k], i) => { const c = cell(k); if (!c) return; const hy = M(new THREE.CylinderGeometry(.22, .26, .3, 7), mat('#e8c56c')); hy.rotation.z = Math.PI / 2; hy.position.set(c.x + .3 * (i ? -1 : 1), c.h + .22, c.z - .3); S.add(hy); });
  // 码头 + 船（沙嘴外侧）
  const dk = cell('4,-1'), dkDir = new THREE.Vector2(dk.x, dk.z).normalize();
  for (let k = 0; k < 6; k++) { const pl = M(new THREE.BoxGeometry(.5, .05, .16), mat(k % 2 ? PAL.wood : '#b4825a')); const d = .7 + k * .19; pl.position.set(dk.x + dkDir.x * d, .42, dk.z + dkDir.y * d); pl.rotation.y = -Math.atan2(dkDir.y, dkDir.x) + Math.PI / 2; S.add(pl);
    if (k % 2 === 0) [-1, 1].forEach(sd => { const po = M(new THREE.CylinderGeometry(.035, .035, .7, 5), mat(PAL.woodDark)); po.position.set(dk.x + dkDir.x * d - dkDir.y * .24 * sd, .1, dk.z + dkDir.y * d + dkDir.x * .24 * sd); S.add(po); }); }
  const boat = makeBoat(); const bpos = [dk.x + dkDir.x * 1.4 - dkDir.y * .7, dk.z + dkDir.y * 1.4 + dkDir.x * .7]; boat.g.position.set(bpos[0], 0, bpos[1]); boat.g.rotation.y = -Math.atan2(dkDir.y, dkDir.x); S.add(boat.g);
  // 鸟
  const birds = [0, 1, 2].map(i => { const B = makeBird(); S.add(B.g); return { ...B, ph: i * 2.1, rad: 4.6 + i * .8, hgt: 3.6 + i * .5, sp: .55 + i * .08 }; });
  // 烟
  const smoke = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(.07, 0), new THREE.MeshStandardMaterial({ color: '#f4f2ee', flatShading: true, transparent: true, opacity: .85 }), 40);
  smoke.count = 0; smoke.frustumCulled = false; S.add(smoke);
  const chims = houses.filter(h => h.chimney);

  // —— 叶片角度：固定步长积分（确定性）——
  const DT = 1 / 480, NA = Math.ceil((DUR + 1) / DT), ANG = new Float32Array(NA + 1);
  const wAt = t => {
    if (t < T.sunHit) return 0;
    if (t < T.stop - .5) return MILL_W * ss(seg(t, T.sunHit, T.sunHit + .9));
    if (t < T.stop) return MILL_W * Math.pow(1 - seg(t, T.stop - .5, T.stop), 1.6);
    if (t < T.lamp) return 0;
    return MILL_W * .42 * ss(seg(t, T.lamp + .1, T.lamp + 2.2));
  };
  for (let i = 1; i <= NA; i++) ANG[i] = ANG[i - 1] + wAt((i - .5) * DT) * DT;
  const angAt = t => { const x = clamp(t / DT, 0, NA - 1), i = Math.floor(x); return lerp(ANG[i], ANG[i + 1], x - i); };
  // 叶片每过四分之一圈 → 木吱呀（拟音事件，与画面同源）
  // 相位取在转台启动那一拍：白天的吱呀正好落在每一拍上（四分之一圈 = 1 拍）
  const Q = Math.PI / 2, PH = ANG[Math.round(T.turn0 / DT)] % Q, creaks = [];
  for (let i = 1; i <= NA; i++) { const a0 = Math.floor((ANG[i - 1] - PH + 1e-7) / Q), a1 = Math.floor((ANG[i] - PH + 1e-7) / Q); if (a1 > a0 && i * DT < DUR) creaks.push(+(i * DT).toFixed(4)); }

  const _v = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const EPS = 1e-6;   // 事件时刻与帧时刻的浮点比较容差
  const winLevel = (t, tw) => t + EPS < tw ? 0 : 1 + .7 * Math.exp(-Math.max(0, t - tw) * 9);
  const lampLevel = t => t + EPS < T.lamp ? 0 : 1 + 1.4 * Math.exp(-Math.max(0, t - T.lamp) * 5);

  // —— 夜色：所有平面着色材质按 night 压向蓝紫（亮度 −25%、色相偏向 ~245°），只有暖色自发光保持原色 ——
  // 越亮越中性的面（沙、岩、白墙）压得越多，免得夜里像去了色的白模
  const VIO = new THREE.Color('#9a9ce8');   // 月光蓝紫（线性空间里按亮度缩放）
  const NIGHT_MATS = [...MC.values()].map(m => {
    const base = m.color.clone(), h = {}; base.getHSL(h);
    const w = h.l > .55 || h.s < .3 ? .78 : .45;
    const lum = .2126 * base.r + .7152 * base.g + .0722 * base.b;
    const nc = base.clone().lerp(VIO.clone().multiplyScalar(lum / (.2126 * VIO.r + .7152 * VIO.g + .0722 * VIO.b) * .66), w);
    return { m, base, nc };
  });
  function nightTint(night) { NIGHT_MATS.forEach(({ m, base, nc }) => m.color.copy(base).lerp(nc, night)); }

  function update(t, ctx) {
    const { night, amp, camDir } = ctx;
    nightTint(night);
    // 叶片
    const ang = angAt(t);
    let back = 0; if (t >= T.stop && t < T.lamp) { const s = t - T.stop; back = -.07 * Math.sin(s * 11) * Math.exp(-s * 6); }   // 刹停后的回弹
    mill.hub.rotation.z = -(ang + back);
    // 窗
    wins.forEach(w => {
      const L = winLevel(t, w.t);
      w.m.emissiveIntensity = L * 2.3 * (1 + .04 * Math.sin(t * 7.3 + w.sx * 3.1) * ss(seg(t, w.t + .3, w.t + .8))); w.m.color.set(L > 0 ? '#ffe2a8' : PAL.glass);
      const s = Math.max(-1, t - w.t + EPS), pop = s >= 0 ? 1 + .45 * Math.exp(-s * 10) * Math.cos(s * 32) : 1; w.mesh.scale.setScalar(pop);
      w.pool.visible = L > 0; w.pool.material.uniforms.amt.value = Math.min(L, 1.2) * .62;
    });
    // 顶灯
    const LL = lampLevel(t);
    mill.lampM.emissiveIntensity = LL * 4.2; mill.lampM.color.set(LL > 0 ? '#fff0c8' : '#5a5f78');
    mill.lampG.getWorldPosition(lampWorld); lampWorld.y += .17;
    { const s = t - T.lamp, pop = s >= 0 ? 1 + .3 * Math.exp(-s * 8) * Math.cos(s * 26) : 1; mill.lampG.scale.setScalar(pop); }
    halo.visible = LL > 0; halo.position.copy(lampWorld); halo.scale.setScalar(.9 + LL * .55); halo.material.opacity = Math.min(1, LL) * .85;
    lampLight.position.copy(lampWorld); lampLight.intensity = LL * 5.5;
    lampPool.visible = LL > 0; lampPool.material.uniforms.amt.value = Math.min(LL, 1.3) * .32;
    // 鸟（白天）
    birds.forEach(B => { const vis = t < T.dusk + 1.8; B.g.visible = vis; if (!vis) return; const a = B.ph + t * B.sp; B.g.position.set(Math.cos(a) * B.rad, B.hgt + Math.sin(t * 1.3 + B.ph) * .3, Math.sin(a) * B.rad); B.g.rotation.set(0, -a, Math.sin(t * 1.1 + B.ph) * .25); const f = Math.sin(t * 9 + B.ph * 3) * .55; B.L.rotation.z = f; B.R.rotation.z = -f; });
    // 烟（白天，风停后停）
    { let si = 0; const on = clamp((t - .3) * 2) * (1 - seg(t, T.stop - .3, T.stop + .6));
      if (on > 0) chims.forEach((h, ci) => { h.chimney.getWorldPosition(_v); for (let k = 0; k < 6; k++) { const ph = ((t * .45 + k / 6 + ci * .3) % 1); const a = 1 - ph; _s.setScalar((.5 + ph * 1.6) * a * on); _q.identity(); smoke.setMatrixAt(si++, _m.compose(new THREE.Vector3(_v.x + ph * .55 + Math.sin(ph * 5 + k) * .08, _v.y + .2 + ph * 1.2, _v.z - ph * .25), _q, _s)); } });
      smoke.count = si; smoke.instanceMatrix.needsUpdate = true; }
    // 船随浪
    { const h = waveH(bpos[0], bpos[1], t, amp); boat.body.position.y = h; boat.body.rotation.z = (waveH(bpos[0] + .4, bpos[1], t, amp) - waveH(bpos[0] - .4, bpos[1], t, amp)) * 1.2; boat.body.rotation.x = (waveH(bpos[0], bpos[1] + .3, t, amp) - h) * 1.5; }
    // 浪圈
    surf.forEach(({ m, c }, i) => { const h = waveH(c.x, c.z, t, amp); m.position.y = .03 + h * .6; const k = 1 + .025 * Math.sin(t * 2.2 + i); m.scale.set(k, k, 1); m.material.opacity = lerp(.32, .16, night) * (.8 + .2 * Math.sin(t * 1.7 + i * 2)); });
  }
  return { S, update, blobs, mill, wins, creaks, lampWorld, houses, birds, angAt, wAt, LEVEL: { winLevel, lampLevel } };
}
