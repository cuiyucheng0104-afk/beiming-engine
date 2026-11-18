// 《林间擂台》· 微缩场景：林间空地里的一座石擂台（4 路 × 5 格），左右各一座城门，周围是高脚屋、树、灯。
// 全部是盒子、圆柱、多面体加像素贴图（px.js），没有外部模型。B、C 两版共用：
//   C 版在页面里直接用这一组网格；B 版由资产桥把同一组网格导出成 GLB（所以这里只用标准材质和基础材质，
//   不用透明贴图、不用自定义着色器；发光的件用 MeshBasicMaterial，导出时变成自发光）。
// 做法参考 cases/vendor/lemo-opuscar/styles/hd-2d/STYLE.md（MIT，LemoLab）：三维微缩景 + 固定像素密度的贴图 + 最近邻采样。代码是自己写的。
//   createDiorama({ part }?) → { group, length }     group 里的网格都起了名字，材质名见 M(...) 的第一个参数
//     part 不给 = 全部；'cast' 只留会投影的件，'soft' 只留不投影的件（B 版的原生运行时按整个模型开关投影，所以分两个模型导出）
// 角色、光、镜头、后期不在这里：两条路线各自做。
import * as THREE from 'three';
import * as PX from './px.js';
import { ROWS, LANES, LX, LZ, TOP, HX, HZ, GATE_X, FRONT_ROW, HP, TEAM, LAMPS, SUN, tileX, tileZ } from './layout.js';

const D = PX.D;

export function createDiorama({ part } = {}) {
  const group = new THREE.Group(); group.name = 'arena';
  const mats = new Map();
  const tex = canvas => {
    const t = new THREE.CanvasTexture(canvas);
    t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  // 带贴图的漫反射材质（按名字缓存）
  const M = (name, make, extra = {}) => {
    if (!mats.has(name)) mats.set(name, Object.assign(new THREE.MeshStandardMaterial({ map: tex(make()), roughness: .95, metalness: 0, ...extra }), { name }));
    return mats.get(name);
  };
  // 发光材质：颜色乘上倍数（> 1 的部分留给泛光）
  const G = (name, color, k = 2) => {
    if (!mats.has(name)) mats.set(name, Object.assign(new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) }), { name }));
    return mats.get(name);
  };
  const add = (mesh, name, pos, shadow = 3, parent = group) => {
    mesh.name = name; mesh.position.set(...pos);
    mesh.castShadow = !!(shadow & 1); mesh.receiveShadow = !!(shadow & 2);
    parent.add(mesh); return mesh;
  };
  // 盒子：把每个面的 UV 按面的米数换成像素数，贴图密度处处一样；(ox, oy) 让相邻的件不从同一个像素起铺
  const box = (name, [w, h, d], pos, mat, shadow = 3, [ox, oy] = [0, 0]) => {
    const g = new THREE.BoxGeometry(w, h, d), uv = g.attributes.uv;
    const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) {
      const m = Array.isArray(mat) ? mat[f] : mat, img = m.map?.image;
      if (!img) continue;
      for (let i = 0; i < 4; i++) { const k = f * 4 + i; uv.setXY(k, (uv.getX(k) * dims[f][0] * D + ox) / img.width, (uv.getY(k) * dims[f][1] * D + oy) / img.height); }
    }
    return add(new THREE.Mesh(g, mat), name, pos, shadow);
  };
  // 一整张图正好贴满一个面的盒子（石板、牌子）
  const tile = (name, size, pos, mat, shadow = 3) => add(new THREE.Mesh(new THREE.BoxGeometry(...size), mat), name, pos, shadow);
  const cyl = (name, [r0, r1, h, seg = 8], pos, mat, shadow = 3) => {
    const g = new THREE.CylinderGeometry(r0, r1, h, seg), uv = g.attributes.uv, img = mat.map?.image;
    if (img) for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.PI * (r0 + r1) * D / img.width, uv.getY(i) * h * D / img.height);
    return add(new THREE.Mesh(g, mat), name, pos, shadow);
  };
  // 叶簇、石头：低面数多面体，每个面一个朝向（面数少，受光才有像素画那种成块的明暗）
  const lump = (name, r, pos, mat, shadow = 3, squash = [1, .8, 1], kind = 'ico') => {
    const g = (kind === 'ico' ? new THREE.IcosahedronGeometry(r, 1) : new THREE.DodecahedronGeometry(r, 0)).scale(...squash), uv = g.attributes.uv, img = mat.map.image;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * Math.PI * r * D / img.width, uv.getY(i) * Math.PI * r * D / img.height);
    g.computeVertexNormals();
    return add(new THREE.Mesh(g, mat), name, pos, shadow);
  };
  const rnd = PX.mulberry(20261118);

  // 材质
  const mStone = M('stone', () => PX.brick({ seed: 1, moss: .35 }));
  const mStoneDark = M('stone-dark', () => PX.brick({ seed: 2, moss: .6, base: 1.7 }));
  const mStoneClean = M('stone-clean', () => PX.brick({ seed: 3, moss: .08, base: 2.9, bw: 16, bh: 16 }));
  const mDirt = M('ground', () => PX.ground({}));
  const mPlank = M('plank', () => PX.planks({ seed: 3 }));
  const mPlankDark = M('plank-dark', () => PX.planks({ seed: 4, base: 1.5 }));
  const mBeam = M('beam', () => PX.planks({ seed: 5, vertical: false, pw: 16, base: 2.2 }));
  const mBark = M('bark', () => PX.bark({}));
  const mThatch = M('thatch', () => PX.thatch({}));
  const mLeaf = M('leaf', () => PX.leaves({ seed: 21 }));
  const mLeafDark = M('leaf-dark', () => PX.leaves({ seed: 22, dark: 1.3 }));
  const mLeafWall = M('leaf-wall', () => PX.leaves({ seed: 23, dark: 2.3 }));
  const mCrate = M('crate', () => PX.crate({}));
  const cloth = { own: M('cloth-own', () => PX.fabric({ team: 'teal' })), foe: M('cloth-foe', () => PX.fabric({ team: 'red' })) };
  const ink = Object.assign(new THREE.MeshStandardMaterial({ color: 0x1a1210, roughness: 1 }), { name: 'ink' });
  const gFire = G('glow-fire', '#ff9a3c', 3.2), gFireCore = G('glow-fire-core', '#ffe08a', 4.2), gLamp = G('glow-lamp', '#ffb45e', 3);
  const gLine = G('glow-line', '#ffe6a8', 1.6), gTeam = { own: G('glow-own', TEAM.own, 2.2), foe: G('glow-foe', TEAM.foe, 2.2) };

  // —— 地面：一整张大图 ——
  { const g = new THREE.PlaneGeometry(24, 18).rotateX(-Math.PI / 2); add(new THREE.Mesh(g, mDirt), 'ground', [0, 0, -1], 2); }

  // —— 擂台：一圈矮石阶托着台基，台基上 4 × 5 块石板 ——
  box('arena-step', [2 * HX + .7, .14, 2 * HZ + .7], [0, .07, 0], mStoneDark, 3);
  box('arena-base', [2 * HX + .24, TOP - .06, 2 * HZ + .24], [0, (TOP - .06) / 2, 0], mStone, 3, [7, 3]);
  const sideMat = M('slab-side', () => PX.brick({ seed: 9, moss: .15, base: 2.2, bw: 32, bh: 8 }));
  for (let lane = 0; lane < LANES; lane++) for (let row = 0; row < ROWS; row++) {
    const team = row <= FRONT_ROW ? 'teal' : 'red', mark = row === 0 || row === ROWS - 1, seed = 100 + lane * 10 + row;
    const top = M(`slab-${lane}-${row}`, () => PX.slab({ seed, team, mark, mossy: (lane === 0 || lane === LANES - 1) ? .7 : .25 }));
    tile(`slab-${lane}-${row}`, [LX - .05, .09, LZ - .05], [tileX(row), TOP - .045 + (PX.hash2(lane, row, 4) - .5) * .016, tileZ(lane)], [sideMat, sideMat, top, sideMat, sideMat, sideMat]);
  }
  // 前线：一条嵌在石缝里的亮线，我方推进到哪一排就亮在哪一排的前沿
  box('front-line', [.05, .035, 2 * HZ - .1], [tileX(FRONT_ROW) + LX / 2, TOP + .012, 0], gLine, 0);

  // —— 城门：石墙 + 每条兵线一扇门 + 朝外的布顶棚 + 两根火盆柱 + 一面旗和血量牌 ——
  for (const side of ['own', 'foe']) {
    const s = side === 'own' ? -1 : 1, x = s * GATE_X, n = `gate-${side}`;
    box(`${n}-wall`, [.62, 1.2, 2 * HZ + .5], [x, .6, 0], mStone, 3, [s * 11, 0]);
    for (let i = 0; i < 6; i++) box(`${n}-crenel-${i}`, [.62, .2, .4], [x, 1.3, (i - 2.5) * .86], mStoneClean, 3, [i * 5, 0]);
    for (let lane = 0; lane < LANES; lane++) {
      const z = tileZ(lane);
      box(`${n}-door-${lane}`, [.1, .74, .6], [x - s * .32, TOP + .37, z], mPlankDark, 1);
      box(`${n}-lintel-${lane}`, [.16, .12, .78], [x - s * .33, TOP + .8, z], mStoneClean, 1);
      box(`${n}-gem-${lane}`, [.07, .09, .09], [x - s * .42, TOP + .8, z], gTeam[side], 0);
    }
    const awning = box(`${n}-awning`, [1.25, .05, 2 * HZ + .3], [x + s * .86, .98, 0], cloth[side], 3);
    awning.rotation.z = -s * .42;
    for (const near of [0, 1]) {
      const z = (near ? 1 : -1) * (HZ + .78), h = near ? 1 : 1.65, k = `${n}-${near ? 'near' : 'far'}`;
      box(`${k}-pillar`, [.6, h, .6], [x, h / 2, z], mStone, 3, [near * 9, 5]);
      box(`${k}-cap`, [.74, .1, .74], [x, h + .05, z], mStoneClean, 3);
      cyl(`${k}-bowl`, [.3, .2, .16, 8], [x, h + .18, z], ink, 1);
      box(`${k}-flame-0`, [.3, .16, .3], [x, h + .3, z], gFire, 0).rotation.y = .6;
      box(`${k}-flame-1`, [.18, .2, .18], [x, h + .44, z], gFireCore, 0).rotation.y = .2;
    }
    // 旗杆立在墙外侧正中：旗面朝镜头，燕尾下摆；旗顶上是血量牌
    cyl(`${n}-pole`, [.045, .055, 3.3, 6], [x + s * .08, 1.65, .12], mBeam, 1);
    box(`${n}-yard`, [.9, .06, .06], [x + s * .08, 2.86, .16], mBeam, 1);
    { const w = .72, h = 1.4, notch = .22, v = [[-w / 2, h / 2], [w / 2, h / 2], [w / 2, -h / 2], [0, -h / 2 + notch], [-w / 2, -h / 2]];
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(v.flatMap(([a, b]) => [a, b, 0]), 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(v.flatMap(([a, b]) => [a / w + .5, b / h + .5]), 2));
      g.setIndex([0, 4, 3, 0, 3, 1, 1, 3, 2]); g.computeVertexNormals();
      const banner = M(`banner-${side}`, () => PX.cloth({ team: side === 'own' ? 'teal' : 'red', w: 29, h: 56, cut: false }), { side: THREE.DoubleSide });
      add(new THREE.Mesh(g, banner), `${n}-banner`, [x + s * .08, 2.12, .2], 3); }
    const plate = Object.assign(new THREE.MeshBasicMaterial({ map: tex(PX.plaque({ hp: HP[side], team: side === 'own' ? 'teal' : 'red' })) }), { name: `plaque-${side}` });
    tile(`${n}-plaque`, [1, .5, .05], [x + s * .08, 3.2, .2], [ink, ink, ink, ink, plate, ink], 1).rotation.x = -.3;
  }

  // —— 灯 ——
  for (const l of LAMPS) {
    if (l.kind !== 'lantern' || l.id === 'foreground') continue;
    const n = `lamp-${l.id}`;
    if (l.id.startsWith('stone')) {                       // 石灯笼：矮墩 + 亮芯 + 石帽
      box(`${n}-foot`, [.34, l.y - .16, .34], [l.x, (l.y - .16) / 2, l.z], mStoneClean, 3);
      box(`${n}-core`, [.24, .26, .24], [l.x, l.y, l.z], gLamp, 0);
      box(`${n}-cap`, [.46, .1, .46], [l.x, l.y + .18, l.z], mStoneDark, 1);
    } else {                                              // 木杆挑灯
      cyl(`${n}-pole`, [.05, .07, l.y + .25, 6], [l.x, (l.y + .25) / 2, l.z], mBeam, 1);
      box(`${n}-arm`, [.42, .05, .05], [l.x + .16, l.y + .22, l.z], mBeam, 1);
      box(`${n}-core`, [.2, .26, .2], [l.x + .3, l.y, l.z], gLamp, 0);
      box(`${n}-cap`, [.3, .06, .3], [l.x + .3, l.y + .16, l.z], ink, 1);
      box(`${n}-base`, [.24, .05, .24], [l.x + .3, l.y - .15, l.z], ink, 0);
    }
  }

  // —— 高脚屋：四根桩、木板墙、茅草顶、一扇亮窗、一架梯子 ——
  const hut = (n, [hx, hz], w, d, stilt, wall, turn) => {
    const g = new THREE.Group(); g.name = n; g.position.set(hx, 0, hz); g.rotation.y = turn; group.add(g);
    const put = m => { group.remove(m); g.add(m); return m; };
    for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) put(cyl(`${n}-stilt-${a}${b}`, [.09, .11, stilt, 6], [a * (w / 2 - .12), stilt / 2, b * (d / 2 - .12)], mBark, 3));
    put(box(`${n}-floor`, [w + .3, .1, d + .3], [0, stilt + .05, 0], mBeam, 3));
    put(box(`${n}-wall`, [w, wall, d], [0, stilt + .1 + wall / 2, 0], mPlank, 3));
    const roof = new THREE.ConeGeometry(Math.max(w, d) * .86, 1.15, 4, 1).rotateY(Math.PI / 4), uv = roof.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 6, uv.getY(i) * 1.4);
    roof.scale(w / Math.max(w, d) * 1.02, 1, d / Math.max(w, d) * 1.02);
    put(add(new THREE.Mesh(roof.toNonIndexed(), mThatch), `${n}-roof`, [0, stilt + .1 + wall + .57, 0], 3)).geometry.computeVertexNormals();
    const win = Object.assign(new THREE.MeshBasicMaterial({ map: tex(PX.windowGlow({})), color: new THREE.Color(2.6, 2.2, 1.7) }), { name: `${n}-window` });
    put(tile(`${n}-window`, [.34, .4, .04], [-.25, stilt + .1 + wall * .55, d / 2 + .01], [ink, ink, ink, ink, win, ink], 0));
    put(box(`${n}-door`, [.36, wall * .8, .05], [.38, stilt + .1 + wall * .4, d / 2 + .01], mPlankDark, 0));
    for (let i = 0; i < 4; i++) put(box(`${n}-rung-${i}`, [.4, .05, .1], [.38, (i + .6) * stilt / 4, d / 2 + .5 - i * .1], mBeam, 3));
    return g;
  };
  hut('hut-left', [-4.9, -4.5], 1.8, 1.5, .75, .85, .28);
  hut('hut-right', [5.1, -4.8], 2.0, 1.5, .75, .85, -.3);

  // —— 树：粗树干（伸出画面）、树根、齐腰的灌木；后面一道暗的树墙收住画面 ——
  const trees = [[-7.3, -2.4, .5], [-6.6, -6.4, .6], [-2.6, -7.3, .55], [1.9, -7.9, .65], [6.9, -6.6, .55], [7.6, -1.9, .5], [-7.9, 2.6, .55], [8.1, 3.1, .6], [-.4, -6.2, .35], [3.9, -6.3, .3]];
  trees.forEach(([x, z, r], i) => {
    cyl(`tree-${i}-trunk`, [r * .82, r, 7, 9], [x, 3.5, z], mBark, 3);
    cyl(`tree-${i}-root`, [r, r * 1.7, .5, 9], [x, .25, z], mBark, 3);
    for (let k = 0; k < 3; k++) { const a = rnd() * 6.28, d = r + .5 + rnd() * .7; lump(`tree-${i}-bush-${k}`, .45 + rnd() * .4, [x + Math.cos(a) * d, .3 + rnd() * .2, z + Math.sin(a) * d], rnd() < .5 ? mLeaf : mLeafDark, 3); }
  });
  for (let i = 0; i < 26; i++) {                         // 空地边上的灌木和蕨丛：越靠外越密
    const a = rnd() * 6.28, rr = 1.02 + rnd() * .35, x = Math.cos(a) * 7.6 * rr, z = .4 + Math.sin(a) * 5 * rr;
    if (z > 5.2 || Math.abs(x) > 10) continue;
    lump(`bush-${i}`, .4 + rnd() * .55, [x, .2 + rnd() * .25, z], rnd() < .6 ? mLeaf : mLeafDark, 3);
  }
  for (let i = 0; i < 9; i++) lump(`rock-${i}`, .16 + rnd() * .22, [(rnd() - .5) * 13, .08, 2.6 + (rnd() - .5) * 2.2 - (i % 2) * 6.2], mStoneClean, 3, [1, .7, 1], 'dodeca');
  // 草丛：三片交叉的小三角（不用透明贴图）
  { const pos = [], uvs = [], N = 220;
    for (let i = 0; i < N; i++) {
      const a = rnd() * 6.28, rr = .9 + rnd() * .5, x = Math.cos(a) * 7.2 * rr, z = .4 + Math.sin(a) * 4.7 * rr, h = .14 + rnd() * .2, w = .06 + rnd() * .05;
      if (Math.abs(x) < HX + 1.6 && Math.abs(z) < HZ + .9) continue;
      for (let k = 0; k < 3; k++) { const b = k * 2.1 + rnd(), cx = Math.cos(b) * w, cz = Math.sin(b) * w, lean = (rnd() - .5) * .12;
        pos.push(x - cx, 0, z - cz, x + cx, 0, z + cz, x + lean, h, z + lean); uvs.push(0, 0, .2, 0, .1, .6); } }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.computeVertexNormals();
    add(new THREE.Mesh(g, M('grass', () => PX.leaves({ seed: 31, dark: -1.2 }), { side: THREE.DoubleSide })), 'grass', [0, 0, 0], 2); }
  box('wall-back', [30, 7, .4], [0, 3.2, -9.6], mLeafWall, 2);
  box('wall-left', [.4, 7, 20], [-11.6, 3.2, -1], mLeafWall, 2);
  box('wall-right', [.4, 7, 20], [11.6, 3.2, -1], mLeafWall, 2);

  // —— 杂物：木箱、木桶，堆在城门外侧 ——
  [[-5.3, 2.5, .5], [-5.75, 2.1, .4], [-5.35, 2.52, .34, .5], [5.6, 2.3, .5], [5.2, 2.9, .38], [5.9, -2.4, .46], [-5.8, -2.3, .44]].forEach(([x, z, s, y = 0], i) => {
    const m = box(`crate-${i}`, [s, s, s], [x, y + s / 2, z], mCrate, 3); m.rotation.y = (i * 1.3) % .7 - .3;
    m.geometry.attributes.uv.array.set(new THREE.BoxGeometry(1, 1, 1).attributes.uv.array);
  });
  [[4.75, 2.25], [-4.7, 3.0], [5.75, -3.0]].forEach(([x, z], i) => cyl(`barrel-${i}`, [.2, .2, .46, 8], [x, .23, z], mPlank, 3));

  // —— 前景：虚在镜头前面的一根灯杆和两团叶子，给画面加一层纵深 ——
  { const l = LAMPS.find(v => v.id === 'foreground');
    cyl('fg-pole', [.07, .09, l.y + .5, 6], [l.x - .32, (l.y + .5) / 2, l.z], mBeam, 1);
    box('fg-arm', [.5, .06, .06], [l.x - .12, l.y + .3, l.z], mBeam, 0);
    box('fg-core', [.24, .32, .24], [l.x, l.y, l.z], gLamp, 0);
    box('fg-cap', [.36, .07, .36], [l.x, l.y + .2, l.z], ink, 0);
    lump('fg-leaf-0', 1.25, [4.6, 2.0, 6.5], mLeafDark, 0, [1.3, .8, 1]);
    lump('fg-leaf-1', .9, [3.2, 1.55, 6.9], mLeaf, 0, [1.2, .8, 1]);
    lump('fg-leaf-2', .8, [-5.3, 1.6, 6.6], mLeafDark, 0, [1.2, .8, 1]); }

  // —— 头顶的树冠（画面外）：只用来挡太阳。光从缝里漏下来，在空地上落成一块一块的光斑 ——
  { const dir = new THREE.Vector3(...SUN.from).sub(new THREE.Vector3(...SUN.to)).normalize(), canopy = new THREE.Group(); canopy.name = 'canopy'; group.add(canopy);
    let n = 0;
    for (let gx = -11; gx <= 11; gx += 1.55) for (let gz = -9; gz <= 7; gz += 1.55) {
      const x = gx + (rnd() - .5) * 1.1, z = gz + (rnd() - .5) * 1.1, r = .75 + rnd() * .75, y = 7.4 + rnd() * 1.6;
      const hole = Math.hypot((x + .7) / 3.1, (z - .1) / 1.9) < 1 || Math.hypot((x - 2.7) / 1.3, (z + 1.2) / 1.0) < 1 || Math.hypot((x + 3.6) / 1.0, (z - 2.2) / .9) < 1;   // 留给擂台的三个大光斑
      if (hole || rnd() < .3) continue;
      const m = lump(`canopy-${n++}`, r, [x + dir.x * y / dir.y, y, z + dir.z * y / dir.y], mLeafDark, 1, [1, .45, 1]);
      group.remove(m); canopy.add(m);
    } }

  if (part) { const drop = []; group.traverse(o => { if (o.isMesh && (part === 'cast') !== o.castShadow) drop.push(o); }); drop.forEach(o => o.parent.remove(o)); }
  return { group, length: 24 };
}
