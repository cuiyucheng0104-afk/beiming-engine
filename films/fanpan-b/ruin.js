// 《沉水擂台》B 版 · 场景实体：用 three.js 搭好，资产桥在无头浏览器里把它导成 GLB，再交给原生运行时渲染。
// 只放有体积的东西（水面、擂台、祠、残墙、柱、岸、树干、船）；平的像素片都在 film.tsx 里按 plan.js 的清单摆。
// createRuin({ part })：'cast' 是受光、会投影的全部实体；'soft' 是发光件（灯泡、兽眼、祠里的光），不投影。
import * as THREE from 'three';
import * as TX from './stone.js';
import { INK } from './ink.js';
import { PPM, TOP, DAIS, SKIRT, GATE, SHW, STATUES, POSTS, PILLARS, FLOATS, rnd } from './plan.js';

export function createRuin({ part = 'cast' } = {}) {
  const group = new THREE.Group(); group.name = 'ruin';
  const mats = new Map();
  // 一张贴图一个材质；名字留着，film.tsx 能按名字单独调（水面要亮滑一点）
  const lit = (name, make) => {
    if (!mats.has(name)) {
      const t = new THREE.CanvasTexture(make()); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.NearestFilter; t.generateMipmaps = false; t.colorSpace = THREE.SRGBColorSpace;
      const m = new THREE.MeshLambertMaterial({ map: t }); m.name = name; mats.set(name, m);
    }
    return mats.get(name);
  };
  const glow = (name, color) => { if (!mats.has(name)) { const m = new THREE.MeshBasicMaterial({ color }); m.name = name; mats.set(name, m); } return mats.get(name); };
  const M = {
    wall: () => lit('wall', () => TX.masonry({ seed: 1, ink: INK.mauve, alt: INK.rust, moss: .16 })), wallDark: () => lit('wall-dark', () => TX.masonry({ seed: 21, ink: INK.night2, alt: INK.mauve, moss: .3, rowH: 12 })),
    frieze: () => lit('frieze', () => TX.frieze({ h: 16 })), beast: () => lit('beast', () => TX.beast()), planks: () => lit('planks', () => TX.planks()),
    water: () => lit('water', () => TX.water()), turf: () => lit('turf', () => TX.turf()), cliff: () => lit('cliff', () => TX.cliff()), bark: () => lit('bark', () => TX.bark()),
    tiles: () => lit('tiles', () => TX.scales({ ink: INK.clay })), tilesIce: () => lit('tiles-ice', () => TX.scales({ ink: INK.slateOwn, seed: 31 })), column: () => lit('column', () => TX.column()),
    ice: () => lit('ice', () => TX.ice()), lacquer: () => lit('lacquer', () => TX.lacquer()), board: () => lit('board', () => TX.board()),
    paper: () => lit('paper', () => TX.paper()), bone: () => lit('bone', () => TX.bone()), hull: () => lit('hull', () => TX.hull()),
  };
  const add = (mesh, x = 0, y = 0, z = 0, emissive = false) => { mesh.position.set(x, y, z); mesh.castShadow = !emissive; group.add(mesh); return mesh; };
  const img = m => m.map.image;
  // 盒子：每个面的贴图按真实尺寸铺（每米 48 像素），不拉伸。side 给四周，top 给顶面
  function box(w, h, d, side, top = side, seed = 0) {
    const g = new THREE.BoxGeometry(w, h, d), uv = g.attributes.uv, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (let f = 0; f < 6; f++) {
      const m = f === 2 ? top : side, im = img(m), ox = Math.floor(rnd(seed, f) * im.width), oy = f === 2 ? 0 : im.height - (Math.round(dims[f][1] * PPM) % im.height);
      for (let i = 0; i < 4; i++) { const k = f * 4 + i; uv.setXY(k, (uv.getX(k) * dims[f][0] * PPM + ox) / im.width, (uv.getY(k) * dims[f][1] * PPM + oy) / im.height); }
    }
    return new THREE.Mesh(g, [side, side, top, side, side, side]);
  }
  function drum(r0, r1, h, m, seg = 12) {
    const g = new THREE.CylinderGeometry(r0, r1, h, seg), uv = g.attributes.uv, im = img(m);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * Math.round(Math.PI * (r0 + r1) * PPM / im.width), uv.getY(i) * h * PPM / im.height);
    return new THREE.Mesh(g, m);
  }
  const rock = (r, m, sq = [1, .6, 1]) => {
    const g = new THREE.DodecahedronGeometry(r, 0).scale(...sq), uv = g.attributes.uv, im = img(m);
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 6.28 * r * PPM / im.width, uv.getY(i) * 3.14 * r * PPM / im.height);
    return new THREE.Mesh(g, m);
  };
  // 人字顶：屋脊顺着 x。贴图按坡面的真实长度铺
  function gable(w, d, h, m, over = .16) {
    const hw = w / 2 + over, hd = d / 2 + over, sl = Math.hypot(hd, h), im = img(m), U = w * PPM / im.width, V = sl * PPM / im.height;
    const P = [-hw, 0, hd, hw, 0, hd, -hw, h, 0, hw, h, 0, hw, 0, -hd, -hw, 0, -hd, hw, h, 0, -hw, h, 0, -hw, 0, hd, -hw, h, 0, -hw, 0, -hd, hw, 0, -hd, hw, h, 0, hw, 0, hd];
    const T = [0, 0, U, 0, 0, V, U, V, 0, 0, U, 0, 0, V, U, V, 0, 0, .5, V * .5, 1, 0, 0, 0, .5, V * .5, 1, 0];
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(T, 2));
    g.setIndex([0, 1, 2, 2, 1, 3, 4, 5, 6, 6, 5, 7, 8, 9, 10, 11, 12, 13]); g.computeVertexNormals();
    const mm = m.clone(); mm.name = m.name; mm.side = THREE.DoubleSide; return new THREE.Mesh(g, mats.get(m.name + '-2s') || (mats.set(m.name + '-2s', Object.assign(mm, { name: m.name + '-2s' })), mm));
  }
  const face = (w, h, m) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);

  if (part === 'soft') {                                                    // —— 发光件 ——
    for (const p of POSTS) add(new THREE.Mesh(new THREE.SphereGeometry(.105, 10, 8), glow('glow-bulb', 0xffd27a)), p.x, p.h + .22, p.z, true);
    for (const s of [-1, 1]) add(new THREE.Mesh(new THREE.SphereGeometry(.085, 8, 6), glow('glow-eye', 0x40ffe0)), s * .33, 2.33, -3.7, true);
    for (const st of STATUES) if (st.h > 1) for (const s of [-1, 1]) add(new THREE.Mesh(new THREE.SphereGeometry(.035, 6, 5), glow(st.team === 'own' ? 'glow-eye' : 'glow-coal', st.team === 'own' ? 0x40ffe0 : 0xff7020)), st.x + s * .09, st.h - .33, st.z + .262, true);
    add(new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.1, .06), glow('glow-ice', 0x38d8f0)), -GATE, 1.3, -.98, true);      // 霜祠深处的冷光
    add(new THREE.Mesh(new THREE.BoxGeometry(1.0, .9, .06), glow('glow-coal', 0xff7020)), GATE, 1.25, -.98, true);     // 焰祠深处的火光
    for (const f of FLOATS) add(new THREE.Mesh(new THREE.BoxGeometry(.13, .13, .13), glow('glow-float', 0xffb85a)), f.x, .09, f.z, true).rotation.y = f.a;
    for (const s of [-1, 1]) for (let i = 0; i < 4; i++) add(new THREE.Mesh(new THREE.BoxGeometry(.05, .05, .05), glow(s < 0 ? 'glow-eye' : 'glow-coal', s < 0 ? 0x40ffe0 : 0xff7020)), s * (SKIRT.x + .32 + i * .42), TOP + .16, (i % 2 ? 1 : -1) * .78, true);
    return group;
  }

  // —— 水面、岸 ——
  { const w = 32, d = 26, m = M.water(), g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w * PPM / 256, uv.getY(i) * d * PPM / 256); add(new THREE.Mesh(g, m), 0, 0, 1); }
  for (const s of [-1, 1]) {
    add(box(5.5, 1.4, 14, M.cliff(), M.turf(), 40 + s), s * 8.8, .02, .6);                        // 两侧草岸
    add(box(1.1, .5, 3.2, M.cliff(), M.turf(), 44 + s), s * 5.9, .0, -2.6 + s * .4);              // 岸边矮一级的石阶
    add(box(.8, .34, 2.2, M.wall(), M.turf(), 46 + s), s * 5.75, 0, 3.4);
  }
  add(box(26, 1.8, 6, M.cliff(), M.turf(), 48), 0, .3, -7.2);                                      // 后岸
  for (let i = 0; i < 16; i++) {                                                                  // 水里的石头、倒下的柱段
    const a = rnd(i, 201), x = (i % 2 ? 1 : -1) * (3.6 + a * 2.2), z = -3.2 + rnd(i, 202) * 7.4;
    if (Math.abs(Math.abs(x) - GATE) < 1.3 && Math.abs(z) < 2.5) continue;
    if (i % 5 === 0) { const c = add(drum(.24, .24, .7, M.column(), 10), x, .12, z); c.rotation.set(0, a * 3, Math.PI / 2 - .12); } else add(rock(.2 + rnd(i, 203) * .22, M.cliff()), x, .02, z).rotation.y = a * 6;
  }
  for (let i = 0; i < 9; i++) add(rock(.3 + rnd(i, 211) * .35, M.cliff(), [1, .7, 1]), -7.5 + i * 1.9 + rnd(i, 212), 1.25, -4.6 - rnd(i, 213) * .5).rotation.y = i;

  // —— 擂台：泡在水里的矮台 + 带饰带的台身 + 盘面 ——
  add(box(SKIRT.x * 2, SKIRT.y + .4, SKIRT.z * 2, M.wallDark(), M.wallDark(), 1), 0, (SKIRT.y - .4) / 2, 0);
  add(box(DAIS.x * 2, TOP - SKIRT.y, DAIS.z * 2, M.frieze(), M.wall(), 2), 0, (TOP + SKIRT.y) / 2, 0);
  { const g = new THREE.PlaneGeometry(DAIS.x * 2, DAIS.z * 2).rotateX(-Math.PI / 2); add(new THREE.Mesh(g, M.board()), 0, TOP + .002, 0); }
  for (const st of STATUES) {                                                                      // 四角石座 + 火盆
    add(box(.5, st.h, .5, M.wall(), M.wall(), 60), st.x, st.h / 2, st.z);
    add(box(.6, .08, .6, M.frieze(), M.wall(), 61), st.x, st.h - .04, st.z);
    if (st.h > 1) add(face(.46, .52, M.beast()), st.x, st.h - .42, st.z + .256);
    add(drum(.21, .13, .13, M.lacquer(), 8), st.x, st.h + .065, st.z);
  }

  // —— 两座祠：石台、栈桥、门（两根柱 + 横梁 + 瓦顶）、里面的祭台和后壁 ——
  for (const s of [-1, 1]) {
    const gx = s * GATE, own = s < 0, roofM = own ? M.tilesIce() : M.tiles(), postM = own ? M.column() : M.lacquer();
    add(box(2.1, TOP + .4, 4.5, own ? M.wallDark() : M.wall(), M.wallDark(), 70 + s), gx, (TOP - .4) / 2, 0);
    const bl = GATE - 1.05 - SKIRT.x + .1; add(box(bl, .09, 1.5, M.planks(), M.planks(), 72 + s), s * (SKIRT.x + bl / 2 - .05), TOP - .06, 0);
    for (let i = 0; i < 4; i++) for (const zz of [-.78, .78]) add(drum(.045, .05, .75, M.bark(), 6), s * (SKIRT.x + .12 + i * .42), TOP - .2, zz);
    for (const dx of [-SHW, SHW]) { add(drum(.13, .15, 2.15, postM, 10), gx + dx, TOP + 1.07, 1.12); add(box(.36, .12, .36, M.wall(), M.wall(), 74), gx + dx, TOP + .06, 1.12); }
    add(box(SHW * 2 + .7, .16, .24, own ? M.column() : M.lacquer(), undefined, 75), gx, TOP + 2.2, 1.12);
    add(box(SHW * 2 + .36, .1, .2, M.frieze(), undefined, 76), gx, TOP + 1.9, 1.12);
    add(gable(SHW * 2 + .5, .7, .36, roofM, .1), gx, TOP + 2.28, 1.12);
    add(box(1.8, 1.9, .3, own ? M.ice() : M.wallDark(), M.wall(), 77 + s), gx, TOP + .95, -1.2);       // 后壁
    add(gable(1.9, .9, .42, roofM, .1), gx, TOP + 1.9, -1.1);
    for (const dx of [-.86, .86]) add(drum(.11, .12, 1.9, postM, 8), gx + dx, TOP + .95, -.55);
    add(box(.86, .58, .86, own ? M.ice() : M.wallDark(), own ? M.ice() : M.frieze(), 79), gx, TOP + .29, .22);  // 祭台
    if (!own) add(drum(.3, .18, .16, M.lacquer(), 10), gx, TOP + .62, .32);
  }

  // —— 后墙：中段高、嵌一张兽面（嘴是水口），两翼残破；前面一排残柱 ——
  add(box(4.4, 3.6, .5, M.wall(), M.wall(), 90), 0, 1.8, -4.05);
  add(box(4.7, .22, .62, M.frieze(), M.wall(), 91), 0, 3.71, -4.05);
  add(face(1.62, 1.82, M.beast()), 0, 2.2, -3.795);
  add(box(.7, .16, .34, M.wall(), M.wall(), 92), 0, 1.36, -3.66);
  for (let i = 0; i < 11; i++) {
    const left = i < 6, x = left ? -2.2 - (i + .5) * .98 : 2.2 + (i - 5.5) * 1.16, h = (left ? 2.5 : 2.0) - (i % 3) * .34 - rnd(i, 221) * .3;
    add(box(left ? .98 : 1.16, h, .46, i % 2 ? M.wall() : M.wallDark(), M.turf(), 93 + i), x, h / 2, -4.07);
  }
  for (const p of PILLARS) {
    add(box(p.r * 2.5, .2, p.r * 2.5, M.wall(), M.wall(), 110), p.x, .1, p.z);
    const c = add(drum(p.r * .88, p.r, p.h, M.column(), 12), p.x, p.h / 2 + .15, p.z);
    if (p.broken) add(rock(p.r * 1.05, M.column(), [1, .5, 1]), p.x + .05, p.h + .12, p.z).rotation.set(.3, 1, .2);
    else { add(box(p.r * 2.6, .2, p.r * 2.6, M.frieze(), M.wall(), 111), p.x, p.h + .25, p.z); add(box(p.r * 3, .1, p.r * 3, M.wall(), M.turf(), 112), p.x, p.h + .4, p.z); }
  }

  // —— 灯杆、漂灯的底、前面的栈台和小船、大树干 ——
  for (const p of POSTS) { add(drum(.035, .045, p.h + .5, M.bone(), 6), p.x, (p.h - .2) / 2, p.z); add(box(.2, .03, .2, M.bone(), undefined, 120), p.x, p.h + .09, p.z); }
  add(box(2.5, .08, .95, M.planks(), M.planks(), 121), -3.6, .22, 4.15);
  for (const [dx, dz] of [[-1.15, -.4], [1.15, -.4], [-1.15, .4], [1.15, .4], [0, -.4]]) add(drum(.055, .06, .7, M.bark(), 6), -3.6 + dx, .0, 4.15 + dz);
  { const hull = add(box(1.15, .2, .46, M.hull(), M.planks(), 122), -1.3, .1, 4.1); hull.rotation.y = .16;
    for (const sx of [-1, 1]) { const prow = new THREE.Mesh(new THREE.ConeGeometry(.23, .42, 4), M.hull()); prow.rotation.set(0, Math.PI / 4, -sx * Math.PI / 2); add(prow, -1.3 + sx * .76, .11, 4.1 - sx * .12); }
    add(drum(.02, .02, .62, M.bone(), 5), -1.25, .4, 4.07); }
  for (const [x, z, r, h] of [[-8.2, -5.6, .55, 9], [-9.6, 1.8, .6, 9], [8.6, -5.4, .5, 9], [9.5, 2.4, .62, 9], [-4.4, -6.6, .4, 8], [4.9, -6.8, .45, 8], [0.6, -7.6, .5, 8]]) {
    add(drum(r * .8, r * 1.15, h, M.bark(), 10), x, h / 2 + .6, z);
    for (let i = 0; i < 4; i++) { const a = i * 1.57 + x; add(rock(r * .7, M.bark(), [1.3, .5, .7]), x + Math.cos(a) * r * 1.2, 1.25, z + Math.sin(a) * r * 1.2).rotation.y = -a; }
  }
  return group;
}
