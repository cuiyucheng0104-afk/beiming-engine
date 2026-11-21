// 《林间寨擂》· 场景本体：擂台、两座寨门、竹栅、茅屋、树、灯和满地的小物件。全部是代码搭的立体形体和立着的像素卡片，贴图来自 tex.js。
// buildScene() 返回 { group, flames, lamps, sway, crystals, smoke }：后面几项是要在 film.js 里逐帧动起来的东西。
import * as THREE from 'three';
import * as TX from './tex.js';
import { D, RAMP as R, fbm } from './pix.js';
import { LX, TOP, HX, HZ, GATE_X, HP, FRONT_ROW, FIRE, WARM, TEAM, SUN, FRAMES, cameraAt, rnd } from './stage.js';

const ids = new WeakMap(); let nid = 0;
const idOf = c => { if (!ids.has(c)) ids.set(c, ++nid); return ids.get(c); };
const texes = new Map(), mats = new Map(), geos = new Map();
export function tex(c, rx = 1, ry = 1) {
  const k = `${idOf(c)}:${rx.toFixed(3)}:${ry.toFixed(3)}`;
  if (!texes.has(k)) { const t = new THREE.CanvasTexture(c); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx, ry); texes.set(k, t); }
  return texes.get(k);
}
const lam = (c, rx = 1, ry = 1, flat = false) => { const k = `${idOf(c)}:${rx.toFixed(3)}:${ry.toFixed(3)}:${flat}`; if (!mats.has(k)) mats.set(k, new THREE.MeshLambertMaterial({ map: tex(c, rx, ry), flatShading: flat })); return mats.get(k); };
const shade = o => { o.castShadow = o.receiveShadow = true; return o; };
// 方块：侧面和顶面各用一张贴图，按每米 D 个像素平铺
export function box(w, h, d, side, top = side) {
  const m = (c, a, b) => lam(c, a * D / c.width, b * D / c.height), sx = m(side, d, h), sz = m(side, w, h), ty = m(top, w, d);
  return shade(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), [sx, sx, ty, ty, sz, sz]));
}
export function cyl(r0, r1, h, c, seg = 8) {
  return shade(new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, h, seg), lam(c, Math.max(1, Math.round(2 * Math.PI * Math.max(r0, r1) * D / c.width)), h * D / c.height, true)));
}
// 立着的像素卡片：底边落在 (x, y, z)，朝镜头；法线朝上偏前，背后来的阳光也照得到。glow > 0 时不吃光、自己发亮（> 1 会进泛光）
const UP = new THREE.Vector3(0, .8, .6).normalize();
function plane(w, h, up) {
  const k = `${w.toFixed(3)}:${h.toFixed(3)}:${up}`;
  if (!geos.has(k)) { const g = new THREE.PlaneGeometry(w, h).translate(0, h / 2, 0); if (up) { const n = g.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, UP.x, UP.y, UP.z); } geos.set(k, g); }
  return geos.get(k);
}
export function card(c, x, y, z, { s = 1, tilt = -.2, glow = 0, cast = true, tint = null } = {}) {
  const k = `card:${idOf(c)}:${glow}:${tint}`;
  if (!mats.has(k)) mats.set(k, glow ? new THREE.MeshBasicMaterial({ map: tex(c), alphaTest: .5, color: new THREE.Color(tint ?? '#ffffff').multiplyScalar(glow) }) : new THREE.MeshLambertMaterial({ map: tex(c), alphaTest: .5, shadowSide: THREE.DoubleSide }));
  const m = new THREE.Mesh(plane(c.width / D * s, c.height / D * s, true), mats.get(k)); m.position.set(x, y, z); m.rotation.x = tilt; m.castShadow = cast && !glow; m.receiveShadow = !glow; return m;
}
// 贴在形体上的一块板（真实法线，可以转向任何方向）
function panel(c, s = 1, lift = .3) {
  const m = new THREE.Mesh(plane(c.width / D * s, c.height / D * s, false), new THREE.MeshLambertMaterial({ map: tex(c), alphaTest: .5, side: THREE.DoubleSide, emissive: 0xffffff, emissiveMap: tex(c), emissiveIntensity: lift }));
  m.castShadow = true; return m;
}
// 四坡顶：底是 w × d 的长方形，屋脊顺着 z、长 ridge、高 h；贴图顺着坡面铺（一层压一层的草帘是横的）
export function roof(w, d, h, ridge, c) {
  const A = [-w / 2, 0, -d / 2], B = [w / 2, 0, -d / 2], Cc = [w / 2, 0, d / 2], E = [-w / 2, 0, d / 2], R0 = [0, h, -ridge / 2], R1 = [0, h, ridge / 2];
  const pos = [], uv = [], sl = Math.hypot(w / 2, h), se = Math.hypot((d - ridge) / 2, h), ku = D / c.width, kv = D / c.height;
  const tri = (pts, uvs) => { pts.forEach(p => pos.push(...p)); uvs.forEach(q => uv.push(q[0] * ku, q[1] * kv)); };
  const lo = (d - ridge) / 2, hi = (d + ridge) / 2;
  tri([Cc, B, R0], [[0, 0], [d, 0], [hi, sl]]); tri([Cc, R0, R1], [[0, 0], [hi, sl], [lo, sl]]);
  tri([A, E, R1], [[0, 0], [d, 0], [hi, sl]]); tri([A, R1, R0], [[0, 0], [hi, sl], [lo, sl]]);
  tri([E, Cc, R1], [[0, 0], [w, 0], [w / 2, se]]); tri([B, A, R0], [[0, 0], [w, 0], [w / 2, se]]);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex(c), side: THREE.DoubleSide })); m.castShadow = m.receiveShadow = true; return m;
}
let haloTex;
export function glowSprite(color, size, opacity = .4) {
  haloTex ??= Object.assign(new THREE.CanvasTexture(TX.halo(64)), { colorSpace: THREE.SRGBColorSpace });
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color, blending: THREE.AdditiveBlending, depthWrite: false, opacity })); s.scale.set(size, size, 1); s.userData.size = size; return s;
}

export function buildScene() {
  const G = new THREE.Group(), H = { group: G, flames: [], lamps: [], sway: [], crystals: [], smoke: [] };
  const put = (o, x, y, z, g = G) => { o.position.set(x, y, z); g.add(o); return o; };
  const C = (c, x, y, z, o) => { const m = card(c, x, y, z, o); G.add(m); return m; };
  const T = {
    rock: TX.masonry({ seed: 1 }), dry: TX.masonry({ seed: 7, moss: .12, bh: 8 }), slab: TX.masonry({ seed: 3, rp: R.slab, moss: .1, base: 3 }), frieze: TX.frieze(),
    bark: TX.bark(), bamboo: TX.bamboo(), planks: TX.planks({ w: 96 }), planksV: TX.planks({ w: 64, h: 48, vertical: true }), dark: TX.planks({ w: 64, h: 48, vertical: true, base: 1.2 }),
    thatch: TX.thatch(), rope: TX.rope(), hide: TX.hide(), barrel: TX.barrelSide(), crate: TX.crateFace(), rings: TX.rings(), log: TX.logSide(),
    totem: { teal: [0, 1].map(kind => TX.totem({ team: 'teal', kind })), red: [0, 1].map(kind => TX.totem({ team: 'red', kind, seed: 8 })) },
    banner: { teal: TX.banner({ team: 'teal' }), red: TX.banner({ team: 'red', seed: 5 }) }, weave: { teal: TX.weave({ team: 'teal' }), red: TX.weave({ team: 'red' }) },
    pennant: ['teal', 'gold', 'red', 'bone'].map(team => TX.pennant({ team })), window: { teal: TX.windowGlow({ team: 'teal' }), red: TX.windowGlow({ team: 'red' }) },
    lantern: [TX.lantern(), TX.lantern({ rp: R.red }), TX.lantern({ rp: R.teal })], flames: TX.flames(), flamesTeal: TX.flames({ hot: R.bone, cool: R.teal }), flamesRed: TX.flames({ hot: R.gold, cool: R.red }),
    pots: [0, 1, 2].map(kind => TX.pot({ kind })), shrooms: [1, 2].map(seed => TX.mushrooms({ seed })), flowers: [TX.flowers({ seed: 1 }), TX.flowers({ seed: 2, rp: R.violet }), TX.flowers({ seed: 3, rp: R.gold }), TX.flowers({ seed: 4, rp: R.bone })],
    ferns: [1, 2, 3].map(seed => TX.fern({ seed })), tufts: [1, 2, 3, 4].map(seed => TX.tuft({ seed })), dryTufts: [5, 6].map(seed => TX.tuft({ seed, rp: R.thatch })),
    bush: [TX.foliage({ seed: 1 }), TX.foliage({ seed: 2, rp: R.grass, lift: -.6 }), TX.foliage({ seed: 3, w: 96, h: 60, blobs: 12 }), TX.foliage({ seed: 4, w: 56, h: 40, rp: R.grass, lift: -.3, blobs: 7 })],
    canopy: [TX.foliage({ seed: 11, w: 150, h: 100, blobs: 16 }), TX.foliage({ seed: 12, w: 150, h: 100, blobs: 16 })],
    boulders: [TX.boulder({ seed: 1 }), TX.boulder({ w: 20, h: 14, seed: 2 }), TX.boulder({ w: 40, h: 26, seed: 3 })], vines: [1, 2, 3].map(seed => TX.vine({ seed })),
    sack: TX.sack(), gong: TX.gong(), drum: TX.drum(), rack: { teal: TX.rack({ team: 'teal' }), red: TX.rack({ team: 'red' }) }, stoneLamp: TX.stoneLamp(),
    crystal: { teal: TX.crystal(), red: TX.crystal({ rp: R.red }) }, plaque: { teal: TX.plaque({ hp: HP.own, team: 'teal' }), red: TX.plaque({ hp: HP.foe, team: 'red' }) },
  };

  // —— 空地 ——
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(26, 20).rotateX(-Math.PI / 2), lam(TX.ground())); ground.receiveShadow = true; put(ground, 0, 0, -1);

  // —— 一盏火：火苗（序列帧）+ 光晕 + 点光 ——
  function flame(x, y, z, { s = 1, sheet = T.flames, color = FIRE, power = 1, reach = 7, light = true, g = G } = {}) {
    const t = new THREE.CanvasTexture(sheet); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace; t.repeat.set(.25, 1);
    const m = new THREE.Mesh(plane(.4 * s, .6 * s, false), new THREE.MeshBasicMaterial({ map: t, alphaTest: .5, color: new THREE.Color(1.7, 1.7, 1.7) })); m.rotation.x = -.25; put(m, x, y, z, g);
    H.flames.push({ tex: t, phase: H.flames.length * 3 });
    const glow = put(glowSprite(color, 1.9 * s, .34), x, y + .28 * s, z + .05, g);
    let l = null; if (light) { l = put(new THREE.PointLight(color, 0, reach, 2), x, y + .35 * s, z + .1, g); }
    H.lamps.push({ light: l, glow, base: 5.5 * power, i: H.lamps.length, steady: false });
  }
  const lampGlow = (x, y, z, color, size, power = 0, reach = 5, steady = true) => { const glow = put(glowSprite(color, size, .36), x, y, z); const l = power ? put(new THREE.PointLight(color, 0, reach, 2), x, y, z) : null; H.lamps.push({ light: l, glow, base: power, i: H.lamps.length, steady }); };

  // —— 擂台：两层石阶，上层石沿刻回纹，四角是火盆石柱 ——
  put(box(2 * HX + 1.5, .26, 2 * HZ + 1.4, T.rock, T.slab), 0, .13, 0);
  put(box(2 * HX + .56, .3, 2 * HZ + .56, T.frieze, T.slab), 0, .41, 0);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(2 * HX, 2 * HZ).rotateX(-Math.PI / 2), lam(TX.boardTop({ front: FRONT_ROW }))); board.receiveShadow = true; put(board, 0, TOP + .004, 0);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (HX + .5), z = sz * (HZ + .45), h = sz < 0 ? 1.05 : .5;
    put(box(.42, h, .42, T.dry), x, .26 + h / 2, z); put(box(.56, .1, .56, T.slab), x, .26 + h + .05, z); put(cyl(.25, .13, .2, T.dry), x, .26 + h + .2, z);
    flame(x, .26 + h + .28, z, { s: 1.15, power: sz < 0 ? 1.1 : .8 });
    C(T.vines[(sx + sz + 2) % 3], x + .1, .26 + h - .9 * .55, z + .23, { s: .55, tilt: 0 });
  }
  for (const s of [-1, 1]) put(box(1.5, .1, 1.9, T.planks), s * (HX + .98), TOP - .07, 0);          // 寨门到擂台的木栈桥
  for (const s of [-1, 1]) for (const z of [-.95, .95]) put(cyl(.07, .08, TOP, T.bamboo, 6), s * (HX + 1.6), TOP / 2, z);

  // —— 寨门：两根刻着脸的图腾柱、横梁、茅草顶，门洞里挂两条幡、悬一颗阵营色的晶石；整座朝镜头转了一点 ——
  function gate(sign, team) {
    const g = new THREE.Group(), f = -sign, add = (o, x, y, z) => put(o, x, y, z, g);
    for (const z of [-1.35, 1.35]) {
      add(cyl(.2, .25, 2.7, T.bark), 0, 1.35, z);
      add(box(.6, .78, .6, T.totem[team][0], T.planks), 0, 1.12, z); add(box(.56, .78, .56, T.totem[team][1], T.planks), 0, 1.92, z);
      add(cyl(.28, .28, .1, T.rope), 0, .66, z); add(cyl(.26, .26, .1, T.rope), 0, 2.4, z);
    }
    add(box(.46, .28, 3.5, T.planks), 0, 2.62, 0);
    add(roof(1.7, 3.9, .85, 2.4, T.thatch), 0, 2.74, 0); add(box(.12, .1, 2.6, T.bamboo), 0, 3.6, 0);
    add(box(.1, 2.4, 2.3, T.dark), -f * .24, 1.2, 0);
    for (const z of [-.74, .74]) { const b = panel(T.banner[team], 1, .35); b.rotation.y = f * Math.PI / 2; add(b, f * .3, .86, z); H.sway.push({ o: b, axis: 'x', amp: .05, speed: 1.5, phase: z + sign }); }
    const cr = new THREE.Mesh(new THREE.OctahedronGeometry(.25), new THREE.MeshBasicMaterial({ map: tex(T.crystal[team]), color: new THREE.Color(1.5, 1.5, 1.5) })); cr.scale.y = 1.6; add(cr, f * .62, 1.5, 0);
    const glow = add(glowSprite(TEAM[team === 'teal' ? 'own' : 'foe'], 2.4, .5), f * .62, 1.5, 0), l = add(new THREE.PointLight(TEAM[team === 'teal' ? 'own' : 'foe'], 0, 6, 2), f * .9, 1.5, 0);
    H.crystals.push({ mesh: cr, glow, light: l, y: 1.5, phase: sign });
    flame(f * .7, .52, -1.75, { s: .8, sheet: team === 'teal' ? T.flamesTeal : T.flamesRed, color: TEAM[team === 'teal' ? 'own' : 'foe'], power: .5, reach: 4, g });
    add(cyl(.2, .12, .5, T.dry), f * .7, .25, -1.75);
    g.position.set(sign * GATE_X, 0, 0); g.rotation.y = sign * .4; G.add(g);
    put(box(.08, .08, .9, T.bamboo), sign * (GATE_X + .62), 2.6, 1.75); C(T.plaque[team], sign * (GATE_X + .62), 1.88, 2.1, { s: .95, glow: 1.25, tilt: -.25 });   // 城门血量牌：挂在横梁伸出来的一头
  }
  gate(-1, 'teal'); gate(1, 'red');

  // —— 竹栅：一根根削尖的竹桩 + 一道绳 ——
  const stakeGeo = new THREE.CylinderGeometry(.09, .1, 1, 6).translate(0, .5, 0), tipGeo = new THREE.ConeGeometry(.09, .22, 6), stakeMat = lam(T.bamboo, 2, 2, true), tipMat = lam(T.bamboo, 2, .2, true);
  function palisade(x0, z0, x1, z1, h, seed) {
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.round(len / .21);
    for (let i = 0; i <= n; i++) { const k = i / n, hh = h * (.82 + .32 * rnd(i + seed * 50, 1)), x = x0 + (x1 - x0) * k, z = z0 + (z1 - z0) * k; const s = shade(new THREE.Mesh(stakeGeo, stakeMat)); s.scale.y = hh; put(s, x, 0, z); put(shade(new THREE.Mesh(tipGeo, tipMat)), x, hh + .11, z); }
    const rail = box(len, .07, .05, T.rope); rail.rotation.y = -Math.atan2(z1 - z0, x1 - x0); put(rail, (x0 + x1) / 2, h * .62, (z0 + z1) / 2 + .1);
  }
  palisade(-8.2, -3.0, -4.6, -6.4, 1.25, 1); palisade(-4.6, -6.4, -1.3, -7.0, 1.2, 2); palisade(1.3, -7.0, 4.6, -6.4, 1.2, 3); palisade(4.6, -6.4, 8.2, -3.0, 1.25, 4);
  palisade(-7.0, 2.3, -5.7, 3.9, .8, 5); palisade(5.9, 3.7, 7.1, 2.2, .8, 6);

  // —— 茅屋：竖板墙、四坡茅草顶、一扇亮着的窗、门口一块兽皮棚 ——
  function hut(x, z, ry, team) {
    const g = new THREE.Group(), add = (o, a, b, c) => put(o, a, b, c, g);
    add(box(2, 1, 1.6, T.planksV, T.planks), 0, .5, 0);
    const rf = roof(2.0, 2.6, .95, 1.3, T.thatch); rf.rotation.y = Math.PI / 2; add(rf, 0, 1.0, 0);
    const w = new THREE.Mesh(plane(.35 * 1.3, .45 * 1.3, false), new THREE.MeshBasicMaterial({ map: tex(T.window[team]), color: new THREE.Color(1.6, 1.6, 1.6) })); add(w, -.45, .22, .81);
    add(box(.5, .8, .06, T.dark), .5, .4, .8);
    const awn = box(1.0, .05, .7, T.hide); awn.rotation.x = .45; add(awn, .5, .98, 1.08); for (const dx of [-.42, .42]) add(cyl(.03, .03, .86, T.bamboo, 5), .5 + dx, .43, 1.38);
    g.position.set(x, 0, z); g.rotation.y = ry; G.add(g);
    lampGlow(x - .45 * Math.cos(ry) + .9 * Math.sin(ry), .55, z + .9 * Math.cos(ry) + .45 * Math.sin(ry), WARM, 1.5, 3, 4);
    H.smoke.push([x, 2.0, z]);
  }
  hut(-5.7, -4.3, .38, 'teal'); hut(5.8, -4.4, -.38, 'red');

  // —— 擂台后面：木台上的锣和鼓，两根幡竿之间一串灯笼 ——
  put(box(2.8, .14, 1.3, T.planks), .2, .07, -4.95);
  C(T.gong, -.3, .14, -4.95, { s: 1.5 }); C(T.drum, 1.0, .14, -4.8, { s: 1.4 }); C(T.pots[2], -1.5, 0, -4.6, { s: 1.2 });
  const tops = [];
  for (const s of [-1, 1]) {
    const x = s * 2.55, z = -4.45; put(cyl(.05, .06, 2.15, T.bamboo, 6), x, 1.07, z); tops.push(new THREE.Vector3(x, 2.1, z));
    const b = C(T.banner[s < 0 ? 'teal' : 'red'], x - s * .42, .42, z + .04, { s: 1, tilt: -.1 }); H.sway.push({ o: b, axis: 'z', amp: .04, speed: 1.3, phase: s });
    put(box(.9, .05, .05, T.bamboo), x - s * .38, 2.05, z);
  }
  // 绳：一条下垂的细管；跟着一路挂东西
  function rope(a, b, sag, n, each) {
    const pts = []; for (let i = 0; i <= n; i++) { const k = i / n, p = a.clone().lerp(b, k); p.y -= sag * 4 * k * (1 - k); pts.push(p); }
    G.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n * 2, .014, 4), new THREE.MeshBasicMaterial({ color: '#2c1a14' })));
    pts.forEach((p, i) => { if (i > 0 && i < n) each(p, i); });
  }
  rope(tops[0], tops[1], .5, 8, (p, i) => { C(T.lantern[i % 3 === 0 ? 1 : i % 3 === 1 ? 0 : 2], p.x, p.y - .5, p.z, { s: .8, glow: 1.5, tilt: -.15 }); lampGlow(p.x, p.y - .26, p.z + .05, i % 3 === 0 ? '#ff6a4a' : i % 3 === 1 ? WARM : '#5cf0d0', 1.0, i === 4 ? 2.2 : 0, 4, false); });
  const flag = (p, i) => { const m = C(T.pennant[i % 4], p.x, p.y - .4, p.z, { tilt: 0 }); m.geometry = plane(.3, .4, true); H.sway.push({ o: m, axis: 'z', amp: .12, speed: 2.2, phase: i * .9 }); };
  rope(new THREE.Vector3(-GATE_X + .5, 2.76, -1.25), tops[0], .35, 9, flag); rope(new THREE.Vector3(GATE_X - .5, 2.76, -1.25), tops[1], .35, 9, flag);
  rope(new THREE.Vector3(-GATE_X - .5, 2.76, 1.25), new THREE.Vector3(-(HX + .5), .95, HZ + .45), .25, 8, flag); rope(new THREE.Vector3(GATE_X + .5, 2.76, 1.25), new THREE.Vector3(HX + .5, .95, HZ + .45), .25, 8, flag);

  // —— 树：只看得到树干的下半截和树根，树冠在画面外（它的影子由下面的「树冠漏光板」来落）——
  for (const [x, z, r] of [[-7.0, -7.2, .5], [-2.5, -8.8, .55], [2.9, -8.5, .5], [7.1, -7.0, .55], [-7.2, -1.2, .6], [7.3, -.6, .6], [-0.2, -10.2, .6]]) {
    put(cyl(r * .8, r * 1.1, 9, T.bark, 9), x, 4.5, z); put(cyl(r * 1.1, r * 1.75, .55, T.bark, 9), x, .27, z);
    for (let k = 0; k < 4; k++) { const a = k * 1.7 + x; C(k & 1 ? T.shrooms[k >> 1] : T.ferns[k % 3], x + Math.cos(a) * r * 2, 0, z + Math.abs(Math.sin(a)) * r * 1.6 + .3, { s: k & 1 ? .9 : 1 }); }
    C(T.vines[(x > 0) + 1], x - r * .4, 1.4, z + r * 1.05, { tilt: 0 });
  }
  // 树冠漏光板：一张水平的大镂空板，高高架在画面外。镂空 = 阳光能漏下来的地方：擂台上方一整块，四周是碎斑
  {
    const N = 512, SIZE = 34, c = document.createElement('canvas'); c.width = c.height = N; const g2 = c.getContext('2d'), img = g2.createImageData(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const X = (x / N - .5) * SIZE, Z = (y / N - .5) * SIZE, n = fbm(X * .55 + 9, Z * .55 + 4, 21, 4), n2 = fbm(X * 1.7, Z * 1.7, 5, 3);
      const pool = Math.hypot(X / 4.5, (Z + .15) / 3.25) + (n - .5) * .7 < 1, dapple = n2 > .64 || (n > .6 && n2 > .5), open = pool || dapple, i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 0; img.data[i + 3] = open ? 0 : 255;
    }
    g2.putImageData(img, 0, 0); const t = new THREE.CanvasTexture(c);
    const HG = 12, to = new THREE.Vector3(...SUN.to), dir = new THREE.Vector3(...SUN.from).sub(to).normalize(), off = dir.clone().multiplyScalar(HG / dir.y);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: t, alphaTest: .5, transparent: false, colorWrite: false, depthWrite: false, side: THREE.DoubleSide }));
    m.castShadow = true; put(m, off.x, HG, off.z);
  }

  // —— 手摆的物件：罐、箱、桶、麻袋、兵器架、树桩、石灯、篝火 ——
  const crate = (x, y, z, s = .6, ry = 0) => { const b = box(s, s, s, T.crate); b.rotation.y = ry; put(b, x, y + s / 2, z); };
  const barrel = (x, z, s = 1) => { put(cyl(.27 * s, .25 * s, .7 * s, T.barrel, 10), x, .35 * s, z); const top = new THREE.Mesh(new THREE.CircleGeometry(.25 * s, 10).rotateX(-Math.PI / 2), lam(T.rings)); put(top, x, .7 * s + .003, z); };
  const stump = (x, z, r = .32) => { put(cyl(r, r * 1.2, .38, T.bark, 9), x, .19, z); put(new THREE.Mesh(new THREE.CircleGeometry(r, 9).rotateX(-Math.PI / 2), lam(T.rings)), x, .383, z).receiveShadow = true; };
  [[-4.0, -3.5, 0], [-4.5, -3.2, 1], [-3.5, -3.9, 2], [3.4, -3.3, 1], [-6.4, 1.2, 0], [-6.0, 1.6, 2], [6.3, .9, 1], [-3.0, 3.9, 1], [4.3, -4.6, 0], [-2.0, -5.4, 0]].forEach(([x, z, k]) => C(T.pots[k], x, 0, z, { s: 1.15 }));
  crate(3.9, 0, -3.7, .62, .3); crate(4.55, 0, -3.5, .55, -.2); crate(4.1, .62, -3.65, .46, .6); barrel(3.2, -4.1); barrel(-4.9, -2.9, .9);
  crate(-5.2, 0, 3.4, .66, .4); crate(-4.5, 0, 3.7, .5, -.3); barrel(-5.9, 3.0); C(T.sack, -4.4, 0, 3.15, { s: 1.2 }); C(T.sack, 4.9, 0, -2.9, { s: 1.2 }); C(T.sack, 5.3, 0, -3.1, { s: 1 });
  C(T.rack.teal, -5.9, 0, -2.2, { s: 1.3 }); C(T.rack.red, 6.0, 0, -2.0, { s: 1.3 });
  stump(-5.7, 2.2); stump(6.1, 2.0, .36); stump(-1.6, 4.3, .28); stump(3.2, -5.6, .3);
  for (const [x, z] of [[-2.3, 3.55], [2.3, 3.6], [-3.6, -4.0], [3.7, -4.8]]) { C(T.stoneLamp, x, 0, z, { s: 1.25 }); lampGlow(x, .52, z + .05, WARM, 1.2, 2.2, 3.5, false); }
  {                                                                           // 右前方的篝火：一圈石头、几根柴、一团大火，旁边一截原木当凳子
    const fx = 4.6, fz = 3.7;
    for (let k = 0; k < 7; k++) { const a = k / 7 * 6.283; C(T.boulders[1], fx + Math.cos(a) * .52 - .25, 0, fz + Math.sin(a) * .34, { s: .7, tilt: -.1 }); }
    for (const a of [.5, 2.1, 3.9]) { const l = cyl(.07, .07, .75, T.bark, 6); l.rotation.set(0, a, 1.2); put(l, fx, .16, fz); }
    flame(fx, .1, fz, { s: 1.8, power: 1.5, reach: 8 }); H.smoke.push([fx, .9, fz]);
    const seat = cyl(.2, .2, 1.3, T.log, 8); seat.rotation.set(0, .5, Math.PI / 2); put(seat, 3.3, .2, 4.1); C(T.pots[1], 5.5, 0, 3.4, { s: 1.1 });
  }
  [[-3.3, 4.4, 2], [5.4, -1.9, 0], [-5.2, -1.2, 1], [1.4, 4.5, 1], [-6.6, -3.0, 2], [6.9, -2.8, 0], [0.9, -6.2, 1], [-1.9, -3.7, 1], [2.4, 3.2, 1], [-4.2, 2.6, 1]].forEach(([x, z, k]) => C(T.boulders[k], x, 0, z, { s: 1.1 }));

  // —— 撒的：灌木、蕨、草丛、花、蘑菇。位置由编号算出来；擂台、寨门、茅屋和小路上不长 ——
  const blocked = (x, z) => (Math.abs(x) < HX + 1.0 && Math.abs(z) < HZ + .95) || (Math.abs(Math.abs(x) - GATE_X) < 1.5 && Math.abs(z) < 2.3) || (Math.abs(Math.abs(x) - 5.75) < 1.5 && Math.abs(z + 4.35) < 1.3) || (Math.abs(x - .2) < 1.7 && Math.abs(z + 4.9) < .9) || (Math.abs(x - 4.6) < 1 && Math.abs(z - 3.7) < .8);
  for (let i = 0; i < 520; i++) {
    const x = (rnd(i, 1) - .5) * 17.5, z = -10.6 + rnd(i, 2) * 16.2, k = rnd(i, 3), grass = Math.hypot(x / 8.2, (z - .3) / 5.2) > .95;
    if (blocked(x, z)) continue;
    if (grass) {
      if (k < .14) C(T.bush[i % 4], x, 0, z, { s: 1 + rnd(i, 4) * .5 });
      else if (k < .3) C(T.ferns[i % 3], x, 0, z, { s: .9 + rnd(i, 4) * .5 });
      else if (k < .44) C(T.flowers[i % 4], x, 0, z, { s: 1 });
      else if (k < .5) C(T.shrooms[i % 2], x, 0, z, { s: .9 });
      else C(T.tufts[i % 4], x, 0, z, { s: 1 + rnd(i, 4) * .4, cast: false });
    } else if (k < .2) C(T.dryTufts[i % 2], x, 0, z, { s: .9, cast: false });
    else if (k < .26) C(T.tufts[i % 4], x, 0, z, { s: .8, cast: false });
    else if (k < .29) C(T.flowers[i % 4], x, 0, z, { s: .8 });
    else if (k < .31) C(T.boulders[1], x, 0, z, { s: .6 });
  }
  // 擂台石阶脚下长出来的一圈草和蕨
  for (let i = 0; i < 46; i++) { const k = i / 46, side = i % 4, x = side < 2 ? (rnd(i, 7) - .5) * (2 * HX + 1.5) : (side === 2 ? -1 : 1) * (HX + .82), z = side < 2 ? (side ? HZ + .78 : -(HZ + .76)) : (rnd(i, 8) - .5) * (2 * HZ + 1.3); if (Math.abs(x) > HX + .3 && Math.abs(z) < 1.1) continue; C(k * 7 % 1 < .3 ? T.ferns[i % 3] : i % 5 === 0 ? T.flowers[i % 4] : T.tufts[i % 4], x, 0, z + (side === 0 ? 0 : .04), { s: .8, cast: false }); }

  // —— 贴着镜头的枝叶：只压在画面四角（会被景深虚掉），左上角垂一盏灯笼。位置按画面坐标摆：(横, 纵) 各 -1…1，离镜头几米 ——
  {
    const cam = cameraAt(FRAMES / 2), pc = new THREE.PerspectiveCamera(cam.fov, 16 / 9, 2, 60); pc.position.set(...cam.pos); pc.lookAt(...cam.look); pc.updateMatrixWorld(); pc.updateProjectionMatrix();
    const at = (nx, ny, dist) => { const p = new THREE.Vector3(nx, ny, .5).unproject(pc).sub(pc.position).normalize(); return pc.position.clone().addScaledVector(p, dist); }, pitch = pc.rotation.x;
    for (const [nx, ny, dist, k, s, d] of [[-1.02, .62, 5.2, 0, .3, .3], [-.62, .93, 5.6, 1, .26, .26], [1.0, .7, 5.4, 1, .28, .26], [.6, .98, 6, 0, .24, .24], [-1.08, -1.34, 4.6, 1, .26, .4], [1.1, -1.36, 4.8, 0, .26, .4], [-.44, -1.5, 4.2, 0, .18, .36], [.5, -1.52, 4.4, 1, .18, .36]]) {
      const p = at(nx, ny, dist), w = T.canopy[k].width / D * s, m = C(T.canopy[k], p.x, p.y, p.z, { s, tilt: pitch, glow: d, tint: '#a8ecc4', cast: false }); H.sway.push({ o: m, axis: 'z', amp: .012, speed: .7, phase: nx * 3 });
    }
    const p = at(-.7, .5, 5.4); C(T.lantern[0], p.x, p.y, p.z, { s: .3, glow: 1.6, tilt: pitch, cast: false }); lampGlow(p.x, p.y + .1, p.z, WARM, .5, 0, 0, false);
    const q = at(.8, .42, 5.6); C(T.lantern[1], q.x, q.y, q.z, { s: .28, glow: 1.5, tilt: pitch, cast: false }); lampGlow(q.x, q.y + .1, q.z, '#ff6a4a', .45, 0, 0, false);
  }
  return H;
}
