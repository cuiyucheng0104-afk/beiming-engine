// 《林间寨擂》· C 版擂台，接进对战盘（board3d.js 的「自定义擂台」接口，地址带 ?arena=c 时用）。
// 这个文件夹自成一套：画法在 pix.js，贴图和小物件在 tex.js，全部逐像素算出来，没有外部图片，也不和 arenas/b-shui 共用任何东西。
// 棋盘规则、棋子、格子的点击、城堡血量牌都还是游戏自己的；这里只管「看起来是什么地方」：
//   · 格子：还是游戏那 20 块（点击、抬起都靠它们），只换成自己的石板贴图；棋盘四周垫成一座两层的石台，地面比棋盘低半米多
//   · 寨门：搭在游戏给的两个城堡组里（组本身挨打会抖、被攻破会下沉，寨门跟着动）
//   · 光：偏青的暗环境 + 一束穿过树冠的金色斜阳（一张只投影的镂空板，让阳光只在擂台上留一整块、四周是碎斑）+ 火盆、灯笼、两颗队伍色晶石
//   · 会动的：火苗（按拍跳帧）、灯的明灭、幡和小旗、光柱、浮尘、萤火、火星、落叶、蝴蝶、炊烟
// build(ctx) 只调一次，返回 { tick(t, dt) }：t 是场景自己的钟（秒），游戏每帧调一次（「减少动态效果」时不调）。
import * as TX from './tex.js';
import { D, RAMP as R, fbm } from './pix.js';

// 调画面只改这一组数。游戏不做胶片曲线、棋子不吃光（永远是贴图原色），所以四周压得暗、颜色给得浓，棋子反而更跳
const LOOK = {
  bg: '#061a1c', fog: '#0b3a40',
  amb: ['#8fd0e0', .95], sun: ['#ffd28c', 4.4], fill: ['#8fc6d6', .5], lamp: 3.2,
  bloom: [.42, .7, .88],                                  // 强度、半径、亮过多少才发光
  tilt: { focus: .43, band: .22, amt: 2 },                // 移轴：清楚的一带压在棋盘上，往上往下虚得比原来重
  grade: { sat: 1.22, con: 1.1, knee: .82, gain: [1.04, 1, .95], lift: [0, .008, .014], edge: [0, .02, .035] },
};
const SUN_FROM = [-9.5, 15, -6.5], FIRE = '#ff8a3a', WARM = '#ffbe6a', G0 = -.56;   // G0：地面比棋盘（格子的底）低多少
const rnd = (i, n) => { const v = Math.sin(i * 127.1 + n * 311.7) * 43758.5453; return v - Math.floor(v); };
const flicker = (i, t) => 1 + .1 * Math.sin(9.1 * t + 2.3 * i) + .06 * Math.sin(15.7 * t + 5.1 * i) + .04 * Math.sin(23.3 * t + 1.7 * i);
const frac = v => v - Math.floor(v);
const FACES = [[[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]]];   // 方块的五个面（不要底）：法线、贴图横轴、贴图纵轴

export function build(ctx) {
  const { THREE, scene, camera, amb, sun, tiles, castles, post, low, team, grid } = ctx;
  const { ROWS, COLS, LX, LZ, HALF: HX, DEPTH, tileZ } = grid, HZ = DEPTH / 2;
  // 原来的布局是按 6 × 4.4 米的盘面摆的；棋盘里面的按比例缩，外面的整体挪
  const mx = x => Math.abs(x) <= 3 ? x * HX / 3 : Math.sign(x) * (Math.abs(x) - 3 + HX), mz = z => Math.abs(z) <= 2.2 ? z * HZ / 2.2 : Math.sign(z) * (Math.abs(z) - 2.2 + HZ);

  const ids = new WeakMap(); let nid = 0; const idOf = c => ids.get(c) ?? (ids.set(c, ++nid), nid);
  const texes = new Map(), mats = new Map();
  const tex = c => { let t = texes.get(c); if (!t) { t = new THREE.CanvasTexture(c); t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; texes.set(c, t); } return t; };
  const UP = new THREE.Vector3(0, .8, .6).normalize();            // 立着的卡片的法线：朝上偏前，背后来的斜阳也照得到
  const cardMat = (c, glow = 0, tint = null, fog = true) => { const k = `${idOf(c)}:${glow}:${tint}:${fog}`; if (!mats.has(k)) mats.set(k, glow ? new THREE.MeshBasicMaterial({ map: tex(c), alphaTest: .5, fog, color: new THREE.Color(tint ?? '#ffffff').multiplyScalar(glow) }) : new THREE.MeshLambertMaterial({ map: tex(c), alphaTest: .5, shadowSide: THREE.DoubleSide })); return mats.get(k); };
  // 单独的一张卡片（要动的才用它；不动的走下面的 Builder，拼成一张网格）
  function cardMesh(c, { s = 1, w = c.width / D * s, h = c.height / D * s, glow = 0, tint = null, fog = true, tilt = 0, cast = false } = {}) {
    const g = new THREE.PlaneGeometry(w, h).translate(0, h / 2, 0), n = g.attributes.normal; if (!glow) for (let i = 0; i < n.count; i++) n.setXYZ(i, UP.x, UP.y, UP.z);
    const m = new THREE.Mesh(g, cardMat(c, glow, tint, fog)); m.rotation.x = tilt; m.castShadow = cast && !glow; m.receiveShadow = !glow; return m;
  }
  const haloTex = Object.assign(new THREE.CanvasTexture(TX.halo(64)), { colorSpace: THREE.SRGBColorSpace });
  const glowSprite = (color, size, opacity = .4) => { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color, blending: THREE.AdditiveBlending, depthWrite: false, opacity })); s.scale.set(size, size, 1); s.userData.size = size; return s; };

  // 把不动的形体和卡片按贴图拼起来：一张贴图一张网格，整个场景几十次绘制就画完。贴图一律按每米 D 个像素铺，不拉伸
  function Builder(parent) {
    const B = new Map(), M = new THREE.Matrix4(), L = new THREE.Matrix4(), Tm = new THREE.Matrix4(), v = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Euler();
    const bucket = (c, kind, opt) => { const k = idOf(c) + '|' + kind; let b = B.get(k); if (!b) B.set(k, b = { c, kind, opt, p: [], n: [], u: [], i: [] }); return b; };
    const local = (x, y, z, rot = [0, 0, 0]) => L.copy(M).multiply(Tm.makeRotationFromEuler(e.set(rot[0], rot[1], rot[2])).setPosition(x, y, z));
    const vert = (b, x, y, z, nx, ny, nz, s, t, fixed) => { v.set(x, y, z).applyMatrix4(L); b.p.push(v.x, v.y, v.z); if (fixed) b.n.push(nx, ny, nz); else { n.set(nx, ny, nz).transformDirection(L); b.n.push(n.x, n.y, n.z); } b.u.push(s, t); };
    const api = {
      box: (w, h, d, side, top = side) => ({ box: [w, h, d, side, top] }),
      cyl: (r0, r1, h, c, seg = 8, open = false) => ({ g: new THREE.CylinderGeometry(r0, r1, h, seg, 1, open), c, ku: Math.max(1, Math.round(2 * Math.PI * Math.max(r0, r1) * D / c.width)), kv: h * D / c.height }),
      geo: (g, c, kind = 'lit', ku = 1, kv = 1) => ({ g, c, kind, ku, kv }),
      // 四坡顶：底是 w × d 的长方形，屋脊顺着 z、长 ridge、高 h；贴图顺着坡面铺
      roof(w, d, h, ridge, c) {
        const A = [-w / 2, 0, -d / 2], Bq = [w / 2, 0, -d / 2], Cc = [w / 2, 0, d / 2], E = [-w / 2, 0, d / 2], R0 = [0, h, -ridge / 2], R1 = [0, h, ridge / 2];
        const pos = [], uv = [], sl = Math.hypot(w / 2, h), se = Math.hypot((d - ridge) / 2, h), ku = D / c.width, kv = D / c.height, lo = (d - ridge) / 2, hi = (d + ridge) / 2;
        const tri = (pts, uvs) => { pts.forEach(p => pos.push(...p)); uvs.forEach(q => uv.push(q[0] * ku, q[1] * kv)); };
        tri([Cc, Bq, R0], [[0, 0], [d, 0], [hi, sl]]); tri([Cc, R0, R1], [[0, 0], [hi, sl], [lo, sl]]); tri([A, E, R1], [[0, 0], [d, 0], [hi, sl]]); tri([A, R1, R0], [[0, 0], [hi, sl], [lo, sl]]);
        tri([E, Cc, R1], [[0, 0], [w, 0], [w / 2, se]]); tri([Bq, A, R0], [[0, 0], [w, 0], [w / 2, se]]);
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.computeVertexNormals();
        return { g, c, kind: 'both', ku: 1, kv: 1 };
      },
      put(o, x, y, z, rot) {
        local(x, y, z, rot ?? o.rot);
        if (o.box) {
          const [w, h, d, side, top] = o.box, hs = [w / 2, h / 2, d / 2];
          for (const [nr, a, bb] of FACES) {
            const c = nr[1] ? top : side, b = bucket(c, 'lit'), ha = hs[a.findIndex(Boolean)], hb = hs[bb.findIndex(Boolean)], hn = hs[nr.findIndex(Boolean)], du = 2 * ha * D / c.width, dv = 2 * hb * D / c.height, i0 = b.p.length / 3;
            for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) vert(b, nr[0] * hn + a[0] * ha * sa + bb[0] * hb * sb, nr[1] * hn + a[1] * ha * sa + bb[1] * hb * sb, nr[2] * hn + a[2] * ha * sa + bb[2] * hb * sb, nr[0], nr[1], nr[2], .5 + sa * du / 2, 1 - (1 - sb) / 2 * dv);
            b.i.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
          }
        } else {
          const b = bucket(o.c, o.kind ?? 'lit'), P = o.g.attributes.position, N = o.g.attributes.normal, U = o.g.attributes.uv, i0 = b.p.length / 3;
          for (let i = 0; i < P.count; i++) vert(b, P.getX(i), P.getY(i), P.getZ(i), N.getX(i), N.getY(i), N.getZ(i), U.getX(i) * o.ku, U.getY(i) * o.kv);
          if (o.g.index) for (const k of o.g.index.array) b.i.push(i0 + k); else for (let i = 0; i < P.count; i++) b.i.push(i0 + i);
          o.g.dispose();
        }
      },
      // 立着的像素卡片：底边中点落在 (x, y, z)，朝镜头，往后仰一点。glow > 0 时不吃光、自己发亮（> 1 会进泛光）
      card(c, x, y, z, { s = 1, tilt = -.2, glow = 0, cast = true, tint = null } = {}) {
        const b = bucket(c, `card:${glow}:${tint}:${cast}`, { glow, tint, cast }), w = c.width / D * s / 2, h = c.height / D * s, i0 = b.p.length / 3; local(x, y, z, [tilt, 0, 0]);
        vert(b, -w, 0, 0, UP.x, UP.y, UP.z, 0, 0, true); vert(b, w, 0, 0, UP.x, UP.y, UP.z, 1, 0, true); vert(b, w, h, 0, UP.x, UP.y, UP.z, 1, 1, true); vert(b, -w, h, 0, UP.x, UP.y, UP.z, 0, 1, true);
        b.i.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
      },
      at(x, y, z, ry, fn) { const keep = M.clone(); M.multiply(Tm.makeRotationY(ry).setPosition(x, y, z)); fn(); M.copy(keep); },
      flush() {
        for (const b of B.values()) {
          const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(b.u, 2)); g.setIndex(b.i);
          let m;
          if (b.opt) { m = new THREE.Mesh(g, cardMat(b.c, b.opt.glow, b.opt.tint)); m.castShadow = b.opt.cast && !b.opt.glow; m.receiveShadow = !b.opt.glow; }
          else { m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex(b.c), side: b.kind === 'both' ? THREE.DoubleSide : THREE.FrontSide })); m.castShadow = m.receiveShadow = true; }
          parent.add(m);
        }
        B.clear();
      },
    };
    return api;
  }

  const T = {
    rock: TX.masonry({ seed: 1 }), dry: TX.masonry({ seed: 7, moss: .12, bh: 8 }), slab: TX.masonry({ seed: 3, rp: R.slab, moss: .1, base: 3 }), frieze: TX.frieze(),
    bark: TX.bark(), bamboo: TX.bamboo(), planks: TX.planks({ w: 96 }), planksV: TX.planks({ w: 64, h: 48, vertical: true }), dark: TX.planks({ w: 64, h: 48, vertical: true, base: 1.2 }),
    thatch: TX.thatch(), rope: TX.rope(), hide: TX.hide(), barrel: TX.barrelSide(), crate: TX.crateFace(), rings: TX.rings(), log: TX.logSide(),
    totem: { teal: [0, 1].map(kind => TX.totem({ team: 'teal', kind })), red: [0, 1].map(kind => TX.totem({ team: 'red', kind, seed: 8 })) },
    banner: { teal: TX.banner({ team: 'teal' }), red: TX.banner({ team: 'red', seed: 5 }) }, weave: { teal: TX.weave({ team: 'teal' }), red: TX.weave({ team: 'red' }) },
    pennant: ['teal', 'gold', 'red', 'bone'].map(t => TX.pennant({ team: t })), window: { teal: TX.windowGlow({ team: 'teal' }), red: TX.windowGlow({ team: 'red' }) },
    lantern: [TX.lantern(), TX.lantern({ rp: R.red }), TX.lantern({ rp: R.teal })], flames: TX.flames(),
    pots: [0, 1, 2].map(kind => TX.pot({ kind })), shrooms: [1, 2].map(seed => TX.mushrooms({ seed })), flowers: [TX.flowers({ seed: 1 }), TX.flowers({ seed: 2, rp: R.violet }), TX.flowers({ seed: 3, rp: R.gold }), TX.flowers({ seed: 4, rp: R.bone })],
    ferns: [1, 2, 3].map(seed => TX.fern({ seed })), tufts: [1, 2, 3, 4].map(seed => TX.tuft({ seed })), dryTufts: [5, 6].map(seed => TX.tuft({ seed, rp: R.thatch })),
    bush: [TX.foliage({ seed: 1 }), TX.foliage({ seed: 2, rp: R.grass, lift: -.6 }), TX.foliage({ seed: 3, w: 96, h: 60, blobs: 12 }), TX.foliage({ seed: 4, w: 56, h: 40, rp: R.grass, lift: -.3, blobs: 7 })],
    canopy: [TX.foliage({ seed: 11, w: 150, h: 100, blobs: 16 }), TX.foliage({ seed: 12, w: 150, h: 100, blobs: 16 })],
    boulders: [TX.boulder({ seed: 1 }), TX.boulder({ w: 20, h: 14, seed: 2 }), TX.boulder({ w: 40, h: 26, seed: 3 })], vines: [1, 2, 3].map(seed => TX.vine({ seed })),
    sack: TX.sack(), gong: TX.gong(), drum: TX.drum(), rack: { teal: TX.rack({ team: 'teal' }), red: TX.rack({ team: 'red' }) }, stoneLamp: TX.stoneLamp(),
    crystal: { teal: TX.crystal(), red: TX.crystal({ rp: R.red }) },
  };
  const H = { flames: [], lamps: [], sway: [], crystals: [], smoke: [], fires: [] };
  const W = new THREE.Group(); W.position.y = G0; scene.add(W);                  // 落在地面上的东西都放这个组里：组里的 y = 0 就是地面
  const BW = Builder(W), put = (o, x, y, z, rot) => BW.put(o, x, y, z, rot), C = (c, x, y, z, o) => BW.card(c, x, y, z, o), box = BW.box, cyl = BW.cyl;
  const addTo = (o, x, y, z, g = W) => { o.position.set(x, y, z); g.add(o); return o; };

  // —— 格子：一整张石板贴图按格切开，每块格子一张（格子的四条边取自己贴图左上角那颗墨色像素）——
  { const cw = Math.round(LX * D), ch = Math.round(LZ * D), bt = TX.boardTop({ rows: ROWS, lanes: COLS, cw, ch, front: -1 });
    for (const t of tiles) { const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch; cv.getContext('2d').drawImage(bt, -t.userData.r * cw, -t.userData.c * ch);
      const m = new THREE.CanvasTexture(cv); m.magFilter = m.minFilter = THREE.NearestFilter; m.generateMipmaps = false; m.colorSpace = THREE.SRGBColorSpace; t.material = new THREE.MeshLambertMaterial({ map: m }); } }

  // —— 空地 ——
  { const ground = new THREE.Mesh(new THREE.PlaneGeometry(26, 20).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: tex(TX.ground({ rx: HX + .3, rz: HZ + .3, clx: HX + 5.2, clz: HZ + 3 })) })); ground.receiveShadow = true; addTo(ground, 0, 0, -1); }

  // —— 一盏火：火苗（四帧，按拍跳）+ 光晕 + 可选的点光 ——
  function flame(x, y, z, { s = 1, color = FIRE, power = 1, reach = 7, light = true } = {}) {
    const t = tex(T.flames).clone(); t.needsUpdate = true; t.repeat.set(.25, 1);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(.4 * s, .6 * s).translate(0, .3 * s, 0), new THREE.MeshBasicMaterial({ map: t, alphaTest: .5, color: new THREE.Color(1.7, 1.7, 1.7) })); m.rotation.x = -.25; addTo(m, x, y, z);
    H.flames.push({ tex: t, phase: H.flames.length * 3 });
    const glow = addTo(glowSprite(color, 1.9 * s, .34), x, y + .28 * s, z + .05), l = light ? addTo(new THREE.PointLight(color, 0, reach, 2), x, y + .35 * s, z + .1) : null;
    H.lamps.push({ light: l, glow, base: power, i: H.lamps.length, steady: false }); H.fires.push(glow);
  }
  const lampGlow = (x, y, z, color, size, power = 0, reach = 5, steady = true) => { const glow = addTo(glowSprite(color, size, .36), x, y, z), l = power ? addTo(new THREE.PointLight(color, 0, reach, 2), x, y, z) : null; H.lamps.push({ light: l, glow, base: power, i: H.lamps.length, steady }); };

  // —— 擂台：两层石阶，上层的石沿刻回纹；格子就铺在上层顶上 ——
  put(box(2 * HX + 1.5, .26, 2 * HZ + 1.4, T.rock, T.slab), 0, .13, 0);
  put(box(2 * HX + .56, .295, 2 * HZ + .56, T.frieze, T.slab), 0, .4075, 0);
  { const m = new THREE.Mesh(new THREE.PlaneGeometry(2 * HX + .02, 2 * HZ + .02).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#10121e' })); addTo(m, 0, .557, 0); }   // 格子缝里露出来的底：墨色
  // 四角的火盆石柱（后面两根高、前面两根矮，不挡棋盘）
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x = sx * (HX + .5), z = sz * (HZ + .45), h = sz < 0 ? 1.25 : .62;
    put(box(.42, h, .42, T.dry), x, .26 + h / 2, z); put(box(.56, .1, .56, T.slab), x, .26 + h + .05, z); put(cyl(.25, .13, .2, T.dry), x, .26 + h + .2, z);
    flame(x, .26 + h + .28, z, { s: 1.15, power: sz < 0 ? 1.1 : .8, light: sz < 0 || !low });
    C(T.vines[(sx + sz + 2) % 3], x + .1, .26 + h - .9 * .55, z + .23, { s: .55, tilt: 0 });
  }

  // —— 寨门：搭在游戏给的城堡组里。一座石台、三根刻着脸的图腾柱（把四条路分成左右两个门洞）、横梁、茅草顶，每条路挂一条幡、铺一块队伍色的门毯，门前悬一颗队伍色的晶石 ——
  function gate(i) {
    const side = i ? 1 : -1, f = -side, name = i ? 'red' : 'teal', g = castles[i], B = Builder(g), len = 2 * HZ;
    B.put(B.box(1.97, .555, len + 1, T.rock, T.slab), side * -.035, G0 + .2775, 0);
    for (const z of [-(HZ + .15), 0, HZ + .15]) {
      B.put(B.cyl(.2, .25, 2.3, T.bark), 0, 1.15, z); B.put(B.box(.6, .78, .6, T.totem[name][0], T.planks), 0, .95, z); B.put(B.box(.56, .78, .56, T.totem[name][1], T.planks), 0, 1.72, z);
      B.put(B.cyl(.28, .28, .1, T.rope), 0, .5, z); B.put(B.cyl(.26, .26, .1, T.rope), 0, 2.16, z);
    }
    B.put(B.box(.46, .26, len + .9, T.planks), 0, 2.27, 0);
    B.put(B.roof(1.7, len + 1.3, .72, len - .3, T.thatch), 0, 2.39, 0); B.put(B.box(.12, .1, len, T.bamboo), 0, 3.12, 0);
    B.put(B.box(.1, 2.1, len + .2, T.dark), -f * .27, 1.05, 0);
    for (let c = 0; c < COLS; c++) {
      B.put(B.box(.62, .016, .8, T.weave[name]), f * .6, .004, tileZ(c));
      const b = new THREE.Mesh(new THREE.PlaneGeometry(.65, 1.6).translate(0, .8, 0), new THREE.MeshLambertMaterial({ map: tex(T.banner[name]), alphaTest: .5, side: THREE.DoubleSide, emissive: 0xffffff, emissiveMap: tex(T.banner[name]), emissiveIntensity: .35 }));
      b.rotation.y = f * Math.PI / 2; b.castShadow = true; addTo(b, f * .2, .5, tileZ(c), g); H.sway.push({ o: b, axis: 'x', amp: .05, speed: 1.5, phase: c * 1.3 + side });
    }
    B.flush();
    const cr = new THREE.Mesh(new THREE.OctahedronGeometry(.22), new THREE.MeshBasicMaterial({ map: tex(T.crystal[name]), color: new THREE.Color(1.5, 1.5, 1.5) })); cr.scale.y = 1.6; addTo(cr, f * .72, 1.35, 0, g);
    const glow = addTo(glowSprite(team[i], 2.2, .5), f * .72, 1.35, 0, g), l = addTo(new THREE.PointLight(team[i], 0, 6, 2), f * .98, 1.4, 0, g);
    H.crystals.push({ mesh: cr, glow, light: l, y: 1.35, phase: side });
  }
  gate(0); gate(1);

  // —— 竹栅：一根根削尖的竹桩 + 一道绳 ——
  function palisade(x0, z0, x1, z1, h, seed) {
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.round(len / .21);
    for (let i = 0; i <= n; i++) { const k = i / n, hh = h * (.82 + .32 * rnd(i + seed * 50, 1)), x = x0 + (x1 - x0) * k, z = z0 + (z1 - z0) * k; put(cyl(.09, .1, hh, T.bamboo, 6, true), x, hh / 2, z); put(BW.geo(new THREE.ConeGeometry(.09, .22, 6), T.bamboo, 'lit', 2, .2), x, hh + .11, z); }
    put(box(len, .07, .05, T.rope), (x0 + x1) / 2, h * .62, (z0 + z1) / 2 + .1, [0, -Math.atan2(z1 - z0, x1 - x0), 0]);
  }
  for (const [a, b, c, d, h, s] of [[-8.2, -3.0, -4.6, -6.4, 1.25, 1], [-4.6, -6.4, -1.3, -7.0, 1.2, 2], [1.3, -7.0, 4.6, -6.4, 1.2, 3], [4.6, -6.4, 8.2, -3.0, 1.25, 4], [-7.0, 2.3, -5.7, 3.9, .8, 5], [5.9, 3.7, 7.1, 2.2, .8, 6]]) palisade(mx(a), mz(b), mx(c), mz(d), h, s);

  // —— 茅屋：竖板墙、四坡茅草顶、一扇亮着的窗、门口一块兽皮棚 ——
  function hut(x, z, ry, name) {
    BW.at(x, 0, z, ry, () => {
      put(box(2, 1, 1.6, T.planksV, T.planks), 0, .5, 0); put(BW.roof(2.0, 2.6, .95, 1.3, T.thatch), 0, 1.0, 0, [0, Math.PI / 2, 0]);
      put(box(.5, .8, .06, T.dark), .5, .4, .8); put(box(1.0, .05, .7, T.hide), .5, .98, 1.08, [.45, 0, 0]); for (const dx of [-.42, .42]) put(cyl(.03, .03, .86, T.bamboo, 5), .5 + dx, .43, 1.38);
    });
    const w = new THREE.Mesh(new THREE.PlaneGeometry(.455, .585).translate(0, .29, 0), new THREE.MeshBasicMaterial({ map: tex(T.window[name]), color: new THREE.Color(1.6, 1.6, 1.6) })), c = Math.cos(ry), s = Math.sin(ry);
    w.rotation.y = ry; addTo(w, x - .45 * c + .81 * s, .22, z + .81 * c + .45 * s);
    lampGlow(x - .45 * c + .9 * s, .55, z + .9 * c + .45 * s, WARM, 1.5, low ? 0 : 3, 4); H.smoke.push([x, 2.0, z]);
  }
  hut(mx(-5.7), mz(-4.3), .38, 'teal'); hut(mx(5.8), mz(-4.4), -.38, 'red');

  // —— 擂台后面：木台上的锣和鼓，两根幡竿之间一串灯笼 ——
  const bz = mz(-4.95);
  put(box(2.8, .14, 1.3, T.planks), .2, .07, bz); C(T.gong, -.3, .14, bz, { s: 1.5 }); C(T.drum, 1.0, .14, bz + .15, { s: 1.4 }); C(T.pots[2], -1.5, 0, bz + .35, { s: 1.2 });
  const tops = [];
  for (const s of [-1, 1]) {
    const x = s * 2.55, z = bz + .5; put(cyl(.05, .06, 2.15, T.bamboo, 6), x, 1.07, z); tops.push(new THREE.Vector3(x, 2.1, z));
    const b = addTo(cardMesh(T.banner[s < 0 ? 'teal' : 'red'], { tilt: -.1, cast: true }), x - s * .42, .42, z + .04); H.sway.push({ o: b, axis: 'z', amp: .04, speed: 1.3, phase: s });
    put(box(.9, .05, .05, T.bamboo), x - s * .38, 2.05, z);
  }
  // 绳：一条下垂的细管；跟着一路挂东西
  function rope(a, b, sag, n, each) {
    const pts = []; for (let i = 0; i <= n; i++) { const k = i / n, p = a.clone().lerp(b, k); p.y -= sag * 4 * k * (1 - k); pts.push(p); }
    W.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n * 2, .014, 4), new THREE.MeshBasicMaterial({ color: '#2c1a14' })));
    pts.forEach((p, i) => { if (i > 0 && i < n) each(p, i); });
  }
  rope(tops[0], tops[1], .5, 8, (p, i) => { C(T.lantern[i % 3 === 0 ? 1 : i % 3 === 1 ? 0 : 2], p.x, p.y - .5, p.z, { s: .8, glow: 1.5, tilt: -.15 }); lampGlow(p.x, p.y - .26, p.z + .05, i % 3 === 0 ? '#ff6a4a' : i % 3 === 1 ? WARM : '#5cf0d0', 1.0, i === 4 && !low ? 2.2 : 0, 4, false); });
  const flag = (p, i) => { const m = addTo(cardMesh(T.pennant[i % 4], { w: .3, h: .4 }), p.x, p.y - .4, p.z); H.sway.push({ o: m, axis: 'z', amp: .12, speed: 2.2, phase: i * .9 }); };
  for (const s of [-1, 1]) {
    rope(new THREE.Vector3(s * (HX + .5), 1.95, -(HZ + .45)), tops[s < 0 ? 0 : 1], .3, 8, flag);                          // 后面的火盆柱 → 幡竿
    rope(tops[s < 0 ? 0 : 1].clone().setX(s * 2.9), new THREE.Vector3(mx(s * 5.6), 1.9, mz(-4.2)), .3, 8, flag);        // 幡竿 → 茅屋的屋脊
  }

  // —— 树：只看得到树干的下半截和树根，树冠在画面外（它的影子由下面的「树冠漏光板」来落）——
  for (const [fx, fz, r] of [[-7.0, -7.2, .5], [-2.5, -8.8, .55], [2.9, -8.5, .5], [7.1, -7.0, .55], [-7.2, -1.2, .6], [7.3, -.6, .6], [-0.2, -10.2, .6], [-9.6, -4.6, .6], [9.8, -4.2, .6]]) {
    const x = mx(fx), z = mz(fz); put(cyl(r * .8, r * 1.1, 9, T.bark, 9, true), x, 4.5, z); put(cyl(r * 1.1, r * 1.75, .55, T.bark, 9), x, .27, z);
    for (let k = 0; k < 4; k++) { const a = k * 1.7 + x; C(k & 1 ? T.shrooms[k >> 1] : T.ferns[k % 3], x + Math.cos(a) * r * 2, 0, z + Math.abs(Math.sin(a)) * r * 1.6 + .3, { s: k & 1 ? .9 : 1 }); }
    C(T.vines[(x > 0) + 1], x - r * .4, 1.4, z + r * 1.05, { tilt: 0 });
  }
  // 林子的深处：一排排压暗的枝叶把远处封住（游戏的镜头比较平，看得到很远）
  for (let i = 0; i < 17; i++) {
    const x = -14 + i * 1.75 + rnd(i, 31) * .6;
    C(T.canopy[i % 2], x, 1.3 + rnd(i, 32) * 1.3, mz(-9.9) - rnd(i, 33) * .8, { s: 1.5, tilt: 0, glow: .15 + rnd(i, 34) * .09, tint: '#7fd8b0', cast: false });
    C(T.bush[2], x + .8, 0, mz(-9.3) - rnd(i, 35) * .5, { s: 1.9, tilt: 0, glow: .24 + rnd(i, 36) * .1, tint: '#8fe0b0', cast: false });
  }
  for (const s of [-1, 1]) for (let k = 0; k < 4; k++) C(T.canopy[k % 2], s * (mx(10.6) + k * .5), .6 + rnd(k, 37), mz(-7.5) + k * 2.6, { s: 1.4, tilt: 0, glow: .16, tint: '#7fd8b0', cast: false });

  // 树冠漏光板：一张水平的大镂空板，高高架在画面外，只投影不显示。镂空 = 阳光能漏下来的地方：擂台上方一整块，四周是碎斑
  const sunDir = new THREE.Vector3(...SUN_FROM).normalize();
  { const N = low ? 256 : 512, SIZE = 34, c = document.createElement('canvas'); c.width = c.height = N; const g2 = c.getContext('2d'), img = g2.createImageData(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const X = (x / N - .5) * SIZE, Z = (y / N - .5) * SIZE, n = fbm(X * .55 + 9, Z * .55 + 4, 21, 4), n2 = fbm(X * 1.7, Z * 1.7, 5, 3);
      const pool = Math.hypot(X / (HX + 1.7), (Z + .15) / (HZ + 1.05)) + (n - .5) * .7 < 1, dapple = n2 > .64 || (n > .6 && n2 > .5), i = (y * N + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 0; img.data[i + 3] = pool || dapple ? 0 : 255;
    }
    g2.putImageData(img, 0, 0); const HG = 12, off = sunDir.clone().multiplyScalar((HG - G0) / sunDir.y);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(SIZE, SIZE).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), alphaTest: .5, colorWrite: false, depthWrite: false, side: THREE.DoubleSide }));
    m.castShadow = true; m.position.set(off.x, HG, off.z); scene.add(m); }

  // —— 手摆的物件：罐、箱、桶、麻袋、兵器架、树桩、石灯、篝火 ——
  const crate = (x, y, z, s = .6, ry = 0) => put(box(s, s, s, T.crate), mx(x), y + s / 2, mz(z), [0, ry, 0]);
  const disc = (r, x, y, z) => put(BW.geo(new THREE.CircleGeometry(r, 10).rotateX(-Math.PI / 2), T.rings), x, y, z);
  const barrel = (x, z, s = 1) => { put(cyl(.27 * s, .25 * s, .7 * s, T.barrel, 10), mx(x), .35 * s, mz(z)); disc(.25 * s, mx(x), .7 * s + .003, mz(z)); };
  const stump = (x, z, r = .32) => { put(cyl(r, r * 1.2, .38, T.bark, 9), mx(x), .19, mz(z)); disc(r, mx(x), .383, mz(z)); };
  [[-4.0, -3.5, 0], [-4.5, -3.2, 1], [-3.5, -3.9, 2], [3.4, -3.3, 1], [-6.4, 1.2, 0], [-6.0, 1.6, 2], [6.3, .9, 1], [-3.0, 3.9, 1], [4.3, -4.6, 0], [-2.0, -5.4, 0]].forEach(([x, z, k]) => C(T.pots[k], mx(x), 0, mz(z), { s: 1.15 }));
  crate(3.9, 0, -3.7, .62, .3); crate(4.55, 0, -3.5, .55, -.2); crate(4.1, .62, -3.65, .46, .6); barrel(3.2, -4.1); barrel(-4.9, -2.9, .9);
  crate(-5.2, 0, 3.4, .66, .4); crate(-4.5, 0, 3.7, .5, -.3); barrel(-5.9, 3.0); C(T.sack, mx(-4.4), 0, mz(3.15), { s: 1.2 }); C(T.sack, mx(4.9), 0, mz(-2.9), { s: 1.2 }); C(T.sack, mx(5.3), 0, mz(-3.1), { s: 1 });
  C(T.rack.teal, mx(-5.9), 0, mz(-2.2), { s: 1.3 }); C(T.rack.red, mx(6.0), 0, mz(-2.0), { s: 1.3 });
  stump(-5.7, 2.2); stump(6.1, 2.0, .36); stump(-1.6, 4.3, .28); stump(3.2, -5.6, .3);
  for (const [x, z] of [[-2.3, 3.55], [2.3, 3.6], [-3.6, -4.0], [3.7, -4.8]]) { C(T.stoneLamp, mx(x), 0, mz(z), { s: 1.25 }); lampGlow(mx(x), .52, mz(z) + .05, WARM, 1.2, 0, 3.5, false); }
  const fx0 = mx(4.6), fz0 = mz(3.7);                                         // 右前方的篝火：一圈石头、几根柴、一团大火，旁边一截原木当凳子
  for (let k = 0; k < 7; k++) { const a = k / 7 * 6.283; C(T.boulders[1], fx0 + Math.cos(a) * .52 - .25, 0, fz0 + Math.sin(a) * .34, { s: .7, tilt: -.1 }); }
  for (const a of [.5, 2.1, 3.9]) put(cyl(.07, .07, .75, T.bark, 6), fx0, .16, fz0, [0, a, 1.2]);
  flame(fx0, .1, fz0, { s: 1.8, power: 1.5, reach: 8, light: !low }); H.smoke.push([fx0, .9, fz0]);
  put(cyl(.2, .2, 1.3, T.log, 8), fx0 - 1.3, .2, fz0 + .4, [0, .5, Math.PI / 2]); C(T.pots[1], fx0 + .9, 0, fz0 - .3, { s: 1.1 });
  [[-3.3, 4.4, 2], [5.4, -1.9, 0], [-5.2, -1.2, 1], [1.4, 4.5, 1], [-6.6, -3.0, 2], [6.9, -2.8, 0], [0.9, -6.2, 1], [-1.9, -3.7, 1], [2.4, 3.2, 1], [-4.2, 2.6, 1]].forEach(([x, z, k]) => C(T.boulders[k], mx(x), 0, mz(z), { s: 1.1 }));

  // —— 撒的：灌木、蕨、草丛、花、蘑菇。位置由编号算出来；擂台、寨门、茅屋和篝火上不长 ——
  const hutX = Math.abs(mx(5.75)), hutZ = mz(-4.35);
  const blocked = (x, z) => (Math.abs(x) < HX + 2.4 && Math.abs(z) < HZ + .95) || (Math.abs(Math.abs(x) - hutX) < 1.5 && Math.abs(z - hutZ) < 1.3) || (Math.abs(x - .2) < 1.7 && Math.abs(z - bz) < .9) || (Math.abs(x - fx0) < 1 && Math.abs(z - fz0) < .8);
  for (let i = 0, n = low ? 320 : 560; i < n; i++) {
    const x = (rnd(i, 1) - .5) * 19.5, z = mz(-10.6) + rnd(i, 2) * (mz(5.6) - mz(-10.6)), k = rnd(i, 3), grass = Math.hypot(x / (HX + 5.2), (z - .3) / (HZ + 3)) > .95;
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
  // 擂台石阶前后长出来的一排草和蕨
  for (let i = 0; i < 40; i++) { const back = i % 2, x = (rnd(i, 7) - .5) * (2 * HX + 1.5), z = back ? -(HZ + .76) : HZ + .78; C(i * 7 % 10 < 3 ? T.ferns[i % 3] : i % 5 === 0 ? T.flowers[i % 4] : T.tufts[i % 4], x, 0, z, { s: .8, cast: false }); }
  BW.flush();

  // —— 光 ——
  scene.background.set(LOOK.bg); scene.fog = new THREE.Fog(LOOK.fog, 24, 50);
  amb.color.set(LOOK.amb[0]); amb.intensity = LOOK.amb[1]; sun.color.set(LOOK.sun[0]); sun.intensity = LOOK.sun[1]; sun.position.copy(sunDir).multiplyScalar(30);
  sun.shadow.mapSize.setScalar(low ? 2048 : 4096); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
  Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 2, far: 64 }); sun.shadow.camera.updateProjectionMatrix(); sun.shadow.bias = -.0006; sun.shadow.normalBias = .03; sun.shadow.radius = 3;
  { const fill = new THREE.DirectionalLight(LOOK.fill[0], LOOK.fill[1]); fill.position.set(0, 9, 16); scene.add(fill); }   // 镜头方向来的一点冷补光：朝镜头的面不死黑
  // 光柱：顺着阳光方向的加色薄片，从树冠缝伸到擂台和空地
  const shafts = [];
  { const t = new THREE.CanvasTexture(TX.shaft());
    for (const [x, z, w, k] of [[-.9, .2, 2.6, 1], [1.9, -.9, 1.5, .8], [-3.4, 1.9, 1.1, .6], [3.9, 1.4, 1.0, .55], [-1.8, -3.4, 1.3, .6], [5.4, -2.2, .9, .45], [-5.6, -.4, 1.0, .5]].slice(0, low ? 4 : 7)) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 10), new THREE.MeshBasicMaterial({ map: t, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, side: THREE.DoubleSide, fog: false }));
      m.position.copy(new THREE.Vector3(mx(x), G0, mz(z)).addScaledVector(sunDir, 4.9)); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), sunDir); m.rotateY(.55); m.userData.k = k; scene.add(m); shafts.push(m);
    } }
  const sunCol = new THREE.Color(LOOK.sun[0]);

  // —— 后期（高画质档才有）——
  post.bloom.strength = LOOK.bloom[0]; post.bloom.radius = LOOK.bloom[1]; post.bloom.threshold = LOOK.bloom[2];
  for (const p of [post.tiltH, post.tiltV]) { p.uniforms.focus.value = LOOK.tilt.focus; p.uniforms.band.value = LOOK.tilt.band; p.uniforms.amt.value = LOOK.tilt.amt; }
  { const u = post.grade.uniforms, g = LOOK.grade; u.sat.value = g.sat; u.con.value = g.con; u.knee.value = g.knee; u.gain.value.setRGB(...g.gain); u.lift.value.setRGB(...g.lift); u.edge.value.setRGB(...g.edge); post.grade.enabled = true; }

  // —— 飘浮物：光里的浮尘、草边的萤火、火上的火星、落叶、蝴蝶、炊烟 ——
  const PS = 2 / (2 * Math.tan(camera.fov * Math.PI / 360));       // 点的大小按世界尺寸给（three 的点大小不管视角，这里补上）
  function points(n, size) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({ size: size * PS, map: haloTex, vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, sizeAttenuation: true, fog: false }));
    p.frustumCulled = false; scene.add(p); return p;
  }
  const NDUST = low ? 90 : 260, NFLY = low ? 20 : 46, fx = { dust: points(NDUST, .05), fireflies: points(NFLY, .1), embers: points(H.fires.length * 9, .055) };
  fx.leaves = Array.from({ length: low ? 10 : 22 }, (_, i) => { const m = cardMesh(TX.leaf({ rp: [R.thatch, R.grass, R.red, R.gold][i % 4] }), { s: .8, glow: i % 4 === 1 ? .7 : .95 }); scene.add(m); return m; });
  fx.flies = Array.from({ length: 6 }, (_, i) => { const t = tex(TX.butterfly({ rp: [R.violet, R.gold, R.teal][i % 3] })); t.repeat.set(.5, 1);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(.23, .18), new THREE.MeshBasicMaterial({ map: t, alphaTest: .5, color: new THREE.Color(1.3, 1.3, 1.3) })); m.rotation.x = -.3; scene.add(m); return { m, t }; });
  { const puff = tex(TX.puff()); const n = low ? 3 : 6; fx.smoke = H.smoke.flatMap((p, j) => Array.from({ length: n }, (_, k) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(.6, .6), new THREE.MeshBasicMaterial({ map: puff, transparent: true, depthWrite: false, color: j === 2 ? '#c8a078' : '#8fa8a8', opacity: .5 })); m.rotation.x = -.4; scene.add(m); return { m, p, k, j, n }; })); }

  // —— 贴着镜头的枝叶：只压在画面最上面的两个角（会被移轴虚掉），不挡城堡的血量牌。跟着镜头走，位置按画面坐标算 ——
  const fg = new THREE.Group(); camera.add(fg); if (!camera.parent) scene.add(camera);
  const near = [[-1.06, .76, 6, 0, .3, .3], [-.84, .98, 6.5, 1, .22, .25], [1.05, .8, 6.2, 1, .28, .27], [.8, 1.0, 6.8, 0, .2, .24]].map(([nx, ny, dist, k, s, glow]) => { const m = cardMesh(T.canopy[k], { s, glow, tint: '#a8ecc4', fog: false }); fg.add(m); return { m, nx, ny, dist }; });
  const q = new THREE.Vector3(), look = new THREE.Vector3(0, .95, -.1), wp = new THREE.Vector3();
  function frame() {                                               // 镜头远近会变（窗口大小、手机横竖）：雾和贴镜头的枝叶跟着算
    const d = camera.position.distanceTo(look); scene.fog.near = d + 5; scene.fog.far = d + 32;
    for (const c of near) { q.set(c.nx, c.ny, .5).applyMatrix4(camera.projectionMatrixInverse).normalize(); c.m.position.copy(q).multiplyScalar(c.dist); }
  }
  addEventListener('resize', () => requestAnimationFrame(frame)); requestAnimationFrame(frame);

  function tick(t) {
    const step = Math.floor(t * 10);                               // 每秒 10 拍，像素的东西按拍跳；光和飘的东西连续走
    frame();
    for (const f of H.flames) f.tex.offset.x = ((step + f.phase) % 4) / 4;
    for (const l of H.lamps) { const k = l.steady ? 1 : flicker(l.i, t); if (l.light) l.light.intensity = l.base * LOOK.lamp * k; const s = l.glow.userData.size * (.9 + .1 * k); l.glow.scale.set(s, s, 1); }
    for (const c of H.crystals) { const b = Math.sin(t * 1.6 + c.phase); c.mesh.position.y = c.glow.position.y = c.y + b * .07; c.mesh.rotation.y = t * .8 + c.phase; c.light.intensity = LOOK.lamp * (1.1 + .2 * b); }
    for (const w of H.sway) w.o.rotation[w.axis] = Math.sin(t * w.speed + w.phase) * w.amp;
    shafts.forEach((m, i) => { m.material.color.copy(sunCol).multiplyScalar(.2 * m.userData.k * (1 + .14 * Math.sin(t * .9 + i * 2))); });
    { const p = fx.dust.geometry.attributes.position, c = fx.dust.geometry.attributes.color;
      for (let i = 0; i < NDUST; i++) { const inPool = i % 3 > 0, x = (rnd(i, 1) - .5) * (inPool ? 9 : 17) + Math.sin(t * (.25 + rnd(i, 4) * .3) + i) * .35, y = rnd(i, 2) * 4.6 + Math.sin(t * (.3 + rnd(i, 5) * .3) + i * 1.7) * .22, z = (rnd(i, 3) - .5) * (inPool ? 7 : 12) - .3 + Math.cos(t * (.2 + rnd(i, 6) * .3) + i * .7) * .35, g = (inPool ? .75 : .32) * (.6 + .4 * Math.sin(t * .8 + i));
        p.setXYZ(i, x, y, z); c.setXYZ(i, g, .82 * g, .45 * g); } p.needsUpdate = c.needsUpdate = true; }
    { const p = fx.fireflies.geometry.attributes.position, c = fx.fireflies.geometry.attributes.color;
      for (let i = 0; i < NFLY; i++) { const a = rnd(i, 1) * 6.283, r = HX + 2.4 + rnd(i, 2) * 3.2, g = Math.max(0, Math.sin(t * (1.1 + rnd(i, 7)) + i * 2.1)) ** 2 * 1.6;
        p.setXYZ(i, Math.cos(a) * r * 1.15 + Math.sin(t * .5 + i) * .4, G0 + .3 + rnd(i, 3) * 1.5 + Math.sin(t * .7 + i * 1.3) * .2, Math.sin(a) * r * .72 - .2 + Math.cos(t * .4 + i) * .4); c.setXYZ(i, .75 * g, 1.3 * g, .3 * g); } p.needsUpdate = c.needsUpdate = true; }
    { const p = fx.embers.geometry.attributes.position, c = fx.embers.geometry.attributes.color;
      H.fires.forEach((glow, j) => { glow.getWorldPosition(wp); for (let k = 0; k < 9; k++) { const i = j * 9 + k, life = frac(t * (.4 + rnd(i, 1) * .35) + rnd(i, 2)), g = (1 - life) * 1.8;
        p.setXYZ(i, wp.x + Math.sin(life * 5 + i) * .16 + (rnd(i, 3) - .5) * .2, wp.y + life * 1.5, wp.z + .1 + (rnd(i, 4) - .5) * .2); c.setXYZ(i, 1.5 * g, .6 * g, .15 * g); } });
      p.needsUpdate = c.needsUpdate = true; }
    fx.leaves.forEach((m, i) => { const life = frac(t / 6 * (1 + (i % 2)) + rnd(i, 1)), sw = Math.sin(life * 9 + i);                 // 落叶：6 秒或 3 秒落完一趟
      m.position.set((rnd(i, 2) - .5) * 15 + sw * .35 + life * .8, 5 - life * 5.5, (rnd(i, 3) - .5) * 9 - .5); m.rotation.z = Math.floor(life * 16 + i) * .9; m.visible = m.position.y > G0 + .08; });
    fx.flies.forEach(({ m, t: tx }, i) => { const a = t * (.5 + rnd(i, 1) * .3) + i * 2.4, cx = mx([-5.4, 5.6, -3.2, 3.4, -6.2, 1.2][i]), cz = mz([1.6, -1.6, 3.9, 3.3, -2.4, -5.4][i]);
      m.position.set(cx + Math.cos(a) * .7, G0 + .7 + rnd(i, 2) * .6 + Math.sin(a * 2.3) * .18, cz + Math.sin(a * 1.3) * .5); if (i < 3) tx.offset.x = ((step + i) % 2) * .5; });
    for (const { m, p, k, j, n } of fx.smoke) { const life = frac(t / 3 + k / n), s = .45 + life * 1.1; m.position.set(p[0] + Math.sin(life * 3 + k + j) * .25 + life * .5, G0 + p[1] + life * 2.4, p[2]); m.scale.setScalar(s); m.material.opacity = .42 * Math.sin(life * Math.PI) ** .8; }
  }
  scene.updateMatrixWorld(true); tick(0);                          // 先摆好第 0 秒：开了「减少动态效果」时游戏不再调 tick，画面就停在这一刻
  return { tick };
}
