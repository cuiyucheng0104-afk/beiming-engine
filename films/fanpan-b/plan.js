// 《沉水擂台》B 版 · 调度表：只有数和纯函数（不碰画布、不碰 three），film.tsx、ruin.js、bake.mjs 都从这里取。
// 场面：一座沉在水里的遗迹擂台。左边是本方的霜祠（青），右边是敌方的焰祠（红），后面是带兽面水口的残墙。
// 坐标：x 向右（本方 → 敌方），z 朝镜头，y 向上，单位米；水面 y = 0。
export const FPS = 24, FRAMES = 144, PPM = 48;
export const ROWS = 5, LANES = 4, CX = 1.26, CZ = 1.08, TOP = .5;         // 5 格进深 × 4 路；TOP 是盘面高度
export const BX = ROWS * CX / 2, BZ = LANES * CZ / 2;                       // 盘面半宽、半深
export const TILE = { w: 60, h: 52, rim: 18 };                              // 盘面贴图：每格 60×52 像素，外加 18 像素石沿
export const DAIS = { x: BX + TILE.rim / TILE.w * CX, z: BZ + TILE.rim / TILE.h * CZ };
export const SKIRT = { x: DAIS.x + .42, z: DAIS.z + .42, y: .16 };          // 泡在水里的一圈矮台
export const GATE = 4.9, SHW = .72;                                                   // 两座祠离中心多远；SHW 是祠门两根柱子离祠心多远
export const colX = r => (r - (ROWS - 1) / 2) * CX, laneZ = l => (l - (LANES - 1) / 2) * CZ;
export const FRONT = 2;                                                     // 前线在第 2、3 格之间
export const HP = { own: 8, foe: 5 };
export const PICK = { row: 2, lane: 2 };                                    // 当前选中的空格
export const TEAM = { own: '#19d8c0', foe: '#ff4a3c' };

// 棋子：atlas 是 units/ 里的序列帧；cell / frames / feet / scale 照游戏仓库 chess-gfx.js 的登记
export const UNITS = [
  { id: 'dryad', team: 'own', atlas: 'f6_icedryad', cell: 80, frames: 14, feet: 64, scale: 1.15, row: 0, lane: 0, str: 2 },
  { id: 'snowman', team: 'own', atlas: 'f6_snowman', cell: 80, frames: 12, feet: 64, scale: 1.3, row: 0, lane: 3, str: 1 },
  { id: 'rhyno', team: 'own', atlas: 'f6_arcticrhyno', cell: 100, frames: 10, feet: 85, scale: 1.45, row: 1, lane: 2, str: 3 },
  { id: 'north', team: 'own', atlas: 'f6_greatwhitenorth', cell: 120, frames: 14, feet: 105, scale: 1.0, row: 2, lane: 1, str: 5 },
  { id: 'drake', team: 'own', atlas: 'f6_frostdrake', cell: 80, frames: 18, feet: 64, scale: 1.35, row: 2, lane: 3, str: 4 },
  { id: 'panda', team: 'foe', atlas: 'f2_pandabear', cell: 80, frames: 10, feet: 64, scale: 1.45, row: 1, lane: 0, str: 2 },
  { id: 'oni', team: 'foe', atlas: 'f2_demononi', cell: 120, frames: 14, feet: 104, scale: 1.15, row: 3, lane: 1, str: 6 },
  { id: 'kindling', team: 'foe', atlas: 'f2_kindling', cell: 120, frames: 15, feet: 104, scale: 1.1, row: 3, lane: 3, str: 4 },
  { id: 'bugeisha', team: 'foe', atlas: 'f2_onnabugeisha', cell: 130, frames: 32, feet: 114, scale: 1.25, row: 4, lane: 2, str: 3 },
  { id: 'geomancer', team: 'foe', atlas: 'f2_geomancer', cell: 100, frames: 14, feet: 85, scale: 1.1, row: 4, lane: 0, str: 2 },
];
export const DUELS = [['north', 'oni'], ['drake', 'kindling'], ['dryad', 'panda']];   // 正在交手的三对
const UPM = .0178;                                                           // 棋子：一个像素多少米
export const unitBox = u => ({ size: u.cell * u.scale * UPM, lift: (u.feet - u.cell / 2) * u.scale * UPM });
export const unitFrame = (u, f) => Math.floor(f / FPS * 10 + u.row * 3 + u.lane * 5) % u.frames;
export const unitAt = id => { const u = UNITS.find(v => v.id === id); return { x: colX(u.row), z: laneZ(u.lane), u }; };

// 确定性随机
export function rnd(i, k = 0) {
  let n = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(k + 7, 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d); n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
  return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
}

// 光：斜阳从左后上方穿过树冠缝（暖金），环境是偏紫的冷暗
export const SUN = { from: [-7.5, 16, -8.5], to: [0, 0, 0], color: '#ffc870' };
export const sunDir = (() => { const l = Math.hypot(...SUN.from); return SUN.from.map(v => v / l); })();
export const BACKDROP = '#0a0418';
// 镜头：略偏右的俯拍，6 秒里慢慢平移一点
export const CAM = { fov: 25.5, from: { pos: [1.3, 10.6, 16.8], look: [.02, .8, -.5] }, to: { pos: [2.0, 10.35, 16.4], look: [.1, .8, -.5] } };
export function camAt(f) {
  const t = f / (FRAMES - 1), e = t * t * (3 - 2 * t), m = (a, b) => a.map((v, i) => v + (b[i] - v) * e);
  return { pos: m(CAM.from.pos, CAM.to.pos), look: m(CAM.from.look, CAM.to.look), fov: CAM.fov };
}
// 镜头坐标 → 世界：(nx, ny) 是画面里的位置（-1…1），dist 是离镜头多远。用来把前景的虚影摆在画面四角
export function inView(cam, nx, ny, dist) {
  const f = cam.look.map((v, i) => v - cam.pos[i]), fl = Math.hypot(...f), F = f.map(v => v / fl);
  const R = [-F[2], 0, F[0]], rl = Math.hypot(...R), Rn = R.map(v => v / rl);
  const U = [Rn[1] * F[2] - Rn[2] * F[1], Rn[2] * F[0] - Rn[0] * F[2], Rn[0] * F[1] - Rn[1] * F[0]];
  const th = Math.tan(cam.fov * Math.PI / 360), tw = th * 16 / 9;
  return cam.pos.map((v, i) => v + (F[i] + Rn[i] * nx * tw + U[i] * ny * th) * dist);
}

// —— 场地上的固定点（ruin.js 搭实体、film.tsx 放灯和卡片，用同一份）——
export const STATUES = [                                                     // 擂台四角的兽首石座，头顶一盆火
  { x: -DAIS.x - .1, z: DAIS.z + .1, h: .62, team: 'own' }, { x: DAIS.x + .1, z: DAIS.z + .1, h: .62, team: 'foe' },
  { x: -DAIS.x - .1, z: -DAIS.z - .1, h: 1.5, team: 'own' }, { x: DAIS.x + .1, z: -DAIS.z - .1, h: 1.5, team: 'foe' },
];
export const POSTS = [                                                       // 骨白色的灯杆，顶上一颗亮灯泡
  { x: -3.0, z: 3.72, h: 1.5 }, { x: 3.35, z: 3.6, h: 1.25 }, { x: -6.3, z: -1.9, h: 1.9 }, { x: 6.25, z: -2.3, h: 1.7 }, { x: -1.9, z: -3.75, h: 1.3 }, { x: 2.0, z: -3.75, h: 1.1 },
];
export const FLOATS = Array.from({ length: 13 }, (_, i) => {                 // 漂在水上的纸灯
  const a = rnd(i, 31) * Math.PI * 2, front = i < 8;
  return front ? { x: -5.6 + rnd(i, 32) * 11.2, z: 3.25 + rnd(i, 33) * 1.25, a } : { x: (i % 2 ? 1 : -1) * (4.2 + rnd(i, 34) * 1.6), z: -3.5 + rnd(i, 35) * .5 + (i > 10 ? 6.2 : 0), a };
});
export const PILLARS = [                                                     // 后墙前的一排残柱
  { x: -5.6, z: -3.5, h: 3.5, r: .34 }, { x: -3.6, z: -3.55, h: 2.1, r: .32, broken: true }, { x: 3.6, z: -3.55, h: 3.1, r: .32 }, { x: 5.7, z: -3.5, h: 1.5, r: .34, broken: true },
];
export const FALL = { x: 0, top: 1.3, z: -3.6, w: .58 };                     // 兽面水口的瀑布
// 点光：位置、颜色、相对强度；flick 的会随时间抖
export const LAMPS = [
  ...STATUES.map((s, i) => ({ id: `bowl${i}`, x: s.x, y: s.h + .5, z: s.z, color: s.team === 'own' ? '#48f0e0' : '#ff8a30', power: i < 2 ? 1.1 : 1.3, flick: true })),
  ...POSTS.map((p, i) => ({ id: `post${i}`, x: p.x, y: p.h + .22, z: p.z, color: '#ffd98a', power: i < 2 ? .8 : 1 })),
  { id: 'ice', x: -GATE, y: 1.9, z: .7, color: '#52f4ff', power: .8 },
  { id: 'ember', x: GATE, y: 1.7, z: .8, color: '#ff6a2c', power: .7, flick: true },
  { id: 'fall', x: FALL.x, y: .5, z: -3.3, color: '#58e8d8', power: .9 },
  { id: 'boat', x: -1.25, y: .95, z: 4.05, color: '#ffb050', power: .8, flick: true },
];
export const flick = (i, t) => 1 + .14 * Math.sin(t * 9.1 + i * 2.3) + .08 * Math.sin(t * 23.7 + i * 5.1);

// —— 卡片（平的像素片）——
// 每条：n 图名 · p 锚点（立着的是底边中点，躺着的是中心）· s 缩放 · k 立 up / 躺 flat · tilt 后仰 · yaw 转向 · flip 左右翻
// 层：cast 受光且投影 · lit 受光不投影 · fg 贴着镜头的前景（受光不投影）· hi / mid / lo 自发光三档
// 立着的卡片锚在底边中点，躺着的和朝镜头的（face）锚在中心
const up = (layer, n, x, y, z, s = 1, o = {}) => ({ layer, n, p: [x, y, z], s, k: 'up', ...o });
const flat = (layer, n, x, y, z, s = 1, o = {}) => ({ layer, n, p: [x, y, z], s, k: 'flat', ...o });
const onDais = (x, z, m = .25) => Math.abs(x) < SKIRT.x + m && Math.abs(z) < SKIRT.z + m;
const onShrine = (x, z) => Math.abs(Math.abs(x) - GATE) < 1.1 && Math.abs(z) < 2.3;
const BANK = 6.05;                                                           // 两侧草岸从这里开始
export const isWater = (x, z) => !onDais(x, z, 0) && !onShrine(x, z) && Math.abs(x) < BANK && z > -3.45;

export function staticCards() {
  const L = [];
  // 水面：莲叶、莲花、锦鲤、石头边的苔
  for (let i = 0, n = 0; n < 74 && i < 900; i++) {
    const x = -5.9 + rnd(i, 1) * 11.8, z = -3.3 + rnd(i, 2) * 8.2;
    if (!isWater(x, z) || onDais(x, z, .12) || Math.abs(x - FALL.x) < .9 && z < -2.9) continue;
    const kind = ['pad0', 'pad1', 'pad2'][Math.floor(rnd(i, 3) * 3)], s = .8 + rnd(i, 4) * .5;
    L.push(flat('lit', kind, x, .012 + n * .0004, z, s, { yaw: rnd(i, 5) * 6.28 }));
    if (rnd(i, 6) > .7) L.push(up('lit', 'lotus', x + .04, .02, z + .05, .9 + rnd(i, 7) * .4));
    n++;
  }
  for (let i = 0; i < 7; i++) { const x = -5 + rnd(i, 11) * 10, z = 3.15 + rnd(i, 12) * 1.3; if (isWater(x, z)) L.push(flat('lo', 'koi', x, .006, z, 1.1, { yaw: rnd(i, 13) * 6.28 })); }
  // 矮台边上的芦苇、蕨、发光小蘑菇
  for (let i = 0; i < 46; i++) {
    const side = i % 4, t = rnd(i, 21) * 2 - 1;
    const x = side < 2 ? t * SKIRT.x : (side === 2 ? -1 : 1) * (SKIRT.x - .1 + rnd(i, 22) * .25);
    const z = side < 2 ? (side === 0 ? 1 : -1) * (SKIRT.z - .08 + rnd(i, 23) * .25) : t * SKIRT.z;
    if (Math.abs(z) < 1.5 && Math.abs(x) > SKIRT.x - .4) continue;         // 让开通往两座祠的桥
    const pick = rnd(i, 24), n = pick < .34 ? 'reed' : pick < .62 ? 'fern' : pick < .82 ? 'tuft' : 'shroom';
    L.push(up(n === 'shroom' ? 'lo' : 'cast', n, x, SKIRT.y - .02 - (rnd(i, 25) > .5 ? SKIRT.y : 0), z, .75 + rnd(i, 26) * .5, { flip: rnd(i, 27) > .5 }));
  }
  // 两侧草岸和后岸：灌木、蕨、花、蘑菇，越靠外越密
  for (let i = 0; i < 230; i++) {
    const back = i % 3 === 0;
    const x = back ? -9 + rnd(i, 41) * 18 : (i % 2 ? 1 : -1) * (BANK + .1 + rnd(i, 42) ** 1.4 * 3.4);
    const z = back ? -4.75 - rnd(i, 43) ** 1.3 * 3.6 : -4.4 + rnd(i, 44) * 9.4;
    const y = back ? 1.2 : .72, pick = rnd(i, 45);
    const n = pick < .3 ? 'bushA' : pick < .55 ? 'bushB' : pick < .75 ? 'fern' : pick < .88 ? 'tuft' : pick < .95 ? 'reed' : 'shroom';
    L.push(up(n === 'shroom' ? 'lo' : 'cast', n, x, y - .03, z, .85 + rnd(i, 46) * .7, { flip: rnd(i, 47) > .5 }));
  }
  // 残墙和残柱上挂下来的根须、藤
  for (let i = 0; i < 22; i++) {
    const x = -7.2 + i * .68 + rnd(i, 51) * .3; if (Math.abs(x) < 1.1) continue;
    const wallH = (Math.abs(x) < 2.2 ? 3.6 : x < 0 ? 2.5 : 2.0);
    L.push(up('cast', i % 3 ? 'vine' : 'root0', x, wallH - (i % 3 ? 1.45 : 2.6) + .1, -3.98 + .05, .9 + rnd(i, 52) * .3, { flip: rnd(i, 53) > .5, tilt: 0 }));
  }
  for (const p of PILLARS) { L.push(up('cast', 'vine', p.x + .1, p.h - 1.5, p.z + p.r + .03, 1, { tilt: 0 })); L.push(up('mid', 'glyph', p.x, p.h * .55, p.z + p.r + .04, 1, { tilt: 0 })); L.push(up('cast', 'fern', p.x - .25, SKIRT.y - .1, p.z + p.r + .1, .9)); }
  // 四角石座：盆里的火是动的（见 liveCards），这里放座前的符文
  for (const s of STATUES) L.push(up('mid', s.team === 'own' ? 'glyph' : 'glyphFoe', s.x, s.h * .2 + .02, s.z + .262, .8, { tilt: 0 }));
  // 两座祠：旗、血量碑、冰晶 / 纸灯笼
  for (const side of ['own', 'foe']) {
    const s = side === 'own' ? -1 : 1, gx = s * GATE, ban = side === 'own' ? 'bannerOwn' : 'bannerFoe';
    L.push(up('cast', ban, gx - SHW, 1.15, 1.32, 1, { tilt: 0 }), up('cast', ban, gx + SHW, 1.15, 1.32, 1, { tilt: 0, flip: true }));
    L.push(up('mid', side === 'own' ? 'steleOwn' : 'steleFoe', gx - s * .1, TOP, 2.0, 1.1, { tilt: -.1 }));
    if (side === 'own') {
      for (const [dx, y, dz, sc, fl] of [[0, 1.12, .22, 1.5, false], [-.72, TOP, .7, .8, false], [.6, TOP, .8, .65, true], [-.4, 3.0, 1.1, .55, true], [-.75, TOP, -.5, .9, true]]) L.push(up('hi', 'crystal', gx + dx, y, dz, sc, { flip: fl, tilt: 0 }));
    } else {
      for (const [dx, y, dz, sc] of [[-.4, 1.98, 1.14, 1], [.4, 1.98, 1.14, 1], [0, 2.14, 1.14, .8], [-.62, 1.3, -.9, .8]]) L.push(up('hi', 'lantern', gx + dx, y, dz, sc, { tilt: 0 }));
    }
    for (let i = 0; i < 5; i++) L.push(up('cast', i % 2 ? 'fern' : 'tuft', gx + (rnd(i, 61 + s) - .5) * 1.9, TOP - .02, 1.5 + rnd(i, 63) * .15, .8, { flip: i % 2 > 0 }));
  }
  // 空着的出生格上的符文、选中格的金框、前线
  for (const side of ['own', 'foe']) for (let l = 0; l < LANES; l++) {
    const r = side === 'own' ? 0 : ROWS - 1; if (UNITS.some(u => u.row === r && u.lane === l)) continue;
    L.push(flat('mid', side === 'own' ? 'runeOwn' : 'runeFoe', colX(r), TOP + .004, laneZ(l), 1));
  }
  L.push(flat('hi', 'pick', colX(PICK.row), TOP + .005, laneZ(PICK.lane), 1));
  // 棋子脚下的圈、战力牌
  for (const u of UNITS) {
    const s = u.team === 'own' ? -1 : 1, x = colX(u.row), z = laneZ(u.lane);
    L.push(flat('mid', u.team === 'own' ? 'ringOwn' : 'ringFoe', x, TOP + .006, z + .14, 1));
    L.push(up('mid', `badge-${u.team}-${u.str}`, x + s * CX * .34, TOP + .03, z + .46, 1.25, { tilt: -.3 }));
  }
  // 小船上的灯、船头的小旗；后岸的树冠
  L.push(up('hi', 'lantern', -1.25, .62, 4.07, .75, { tilt: 0 }));
  for (let i = 0; i < 26; i++) L.push(up('lit', 'canopy', -10 + i * .8 + rnd(i, 71) * .5, 2.2 + rnd(i, 72) * 3.2, -6.2 - rnd(i, 73) * 3, 1.5 + rnd(i, 74) * 1.2, { tilt: 0, flip: i % 2 > 0 }));
  for (let i = 0; i < 12; i++) L.push(up('lit', 'root1', -8 + i * 1.4 + rnd(i, 75), 2.4 + rnd(i, 76) * 1.5, -5.2 - rnd(i, 77), 1.3, { tilt: 0, flip: i % 2 > 0 }));
  return L;
}

// 会动的卡片：火、瀑布、涟漪、交手的光效、飘着的东西。f 是帧号，cam 用来摆前景和朝向
export function liveCards(f, cam) {
  const L = [], t = f / FPS, step = Math.floor(f / 3);                      // 一拍三：像素动画每 3 帧换一格
  STATUES.forEach((s, i) => L.push(up('hi', `${s.team === 'own' ? 'wisp' : 'flame'}${(step + i) % 4}`, s.x, s.h + .1, s.z + .02, 1.25, { tilt: 0 })));
  L.push(up('hi', `flame${(step + 2) % 4}`, GATE, 1.06, .32, 1.7, { tilt: 0 }), up('hi', `wisp${(step + 1) % 4}`, -GATE + SHW, 2.2, 1.1, .9, { tilt: 0 }));
  // 瀑布：四格循环往下流，落水处两格水花，水面三圈涟漪
  L.push(up('mid', `fall${step % 4}`, FALL.x, 0, FALL.z, 1, { tilt: 0 }), up('mid', `foam${step % 2}`, FALL.x, -.02, FALL.z + .12, 1.1, { tilt: 0 }));
  for (let i = 0; i < 16; i++) {
    const ph = (t * .45 + rnd(i, 81)) % 1, k = Math.min(2, Math.floor(ph * 3));
    const x = i < 3 ? FALL.x + (i - 1) * .5 : -5.6 + rnd(i, 82) * 11.2, z = i < 3 ? -3.25 + i * .12 : (rnd(i, 83) > .25 ? 3.2 + rnd(i, 84) * 1.3 : -3.3 + rnd(i, 84) * .3);
    if (isWater(x, z)) L.push(flat('lo', `ripple${k}`, x, .008, z, .9 + ph * .5));
  }
  for (let i = 0; i < 34; i++) {                                              // 水面的反光点，一明一灭
    const x = -5.8 + rnd(i, 91) * 11.6, z = rnd(i, 92) > .3 ? 3.0 + rnd(i, 93) * 1.6 : -3.3 + rnd(i, 93) * .4;
    if (isWater(x, z) && Math.sin(t * 2.4 + i * 1.9) > .2) L.push(flat('mid', 'glint', x, .01, z, 1));
  }
  // 三对交手：霜花对火环，一拍三，每对错开
  DUELS.forEach(([a, b], i) => {
    const A = unitAt(a), B = unitAt(b), x = (A.x + B.x) / 2, z = A.z, k = (step + i * 2) % 6;
    if (k < 3) L.push(up('hi', `${i % 2 ? 'ember' : 'frostb'}${k}`, x + (i % 2 ? .1 : -.1), TOP + .32, z + .2, .86, { tilt: -.1 }));
    else L.push(up('hi', `${i % 2 ? 'frostb' : 'ember'}${k - 3}`, x + (i % 2 ? -.12 : .12), TOP + .42, z + .21, .7, { tilt: -.1 }));
    for (let j = 0; j < 6; j++) {
      const ph = ((f + j * 5 + i * 7) % 18) / 18, an = rnd(j, 100 + i) * 6.28;
      L.push(up('hi', j % 2 ? 'spark' : 'shard', x + Math.cos(an) * ph * .55, TOP + .38 + Math.sin(an) * ph * .3 + ph * .25, z + .24, 1 - ph * .5, { tilt: 0 }));
    }
  });
  // 冰灵的冰锥：从左下角的冰灵飞向熊猫
  { const A = unitAt('dryad'), B = unitAt('panda'), ph = (f % 20) / 20; for (let j = 0; j < 3; j++) { const p = Math.max(0, ph - j * .08); L.push(up('hi', 'shard', A.x + .3 + (B.x - A.x - .5) * p, TOP + .6 - j * .02, A.z + .16, 1.3 - j * .3, { tilt: 0, roll: -1.57 })); } }
  // 飘落的花瓣、萤火虫（像素片，朝镜头）
  for (let i = 0; i < 30; i++) {
    const ph = (t * (.05 + rnd(i, 111) * .05) + rnd(i, 112)) % 1;
    L.push({ layer: 'lit', n: 'petal', p: [-6.5 + rnd(i, 113) * 13 + Math.sin(t * 1.2 + i) * .3 + ph * 1.2, 5.2 - ph * 5.1, -3 + rnd(i, 114) * 6.5], s: 1.1, k: 'face', roll: t * 2 + i });
  }
  for (let i = 0; i < 54; i++) {
    const a = t * (.25 + rnd(i, 121) * .3) + rnd(i, 122) * 6.28, edge = rnd(i, 126) > .35;
    const bx = edge ? (rnd(i, 123) > .5 ? 1 : -1) * (3.9 + rnd(i, 124) * 2.4) : -3.5 + rnd(i, 124) * 7, bz = edge ? -3.5 + rnd(i, 125) * 7.6 : (rnd(i, 125) > .5 ? 3.1 + rnd(i, 127) * 1.4 : -3.2 - rnd(i, 127) * .6);
    if (Math.sin(t * 1.7 + i * 2.1) > -.5) L.push({ layer: 'hi', n: 'firefly', p: [bx + Math.cos(a) * .35, .35 + rnd(i, 128) * 1.9 + Math.sin(a * 1.3) * .2, bz + Math.sin(a) * .3], s: 1, k: 'face' });
  }
  // 前景：贴着镜头的虚影（木桩、大叶、垂根），落在画面四角，景深会把它们糊掉
  const fg = [['bigleaf', -.95, -.88, 4.6, .48], ['bigleaf', .96, -.9, 4.9, .5, true], ['bigleaf', -1.0, .93, 5.0, .45], ['bigleaf', 1.02, .96, 5.3, .5, true], ['root1', -.52, 1.0, 5.6, .5], ['root0', .42, 1.05, 6.0, .45, true], ['bigleaf', -.38, -1.12, 4.3, .4, true], ['bigleaf', .5, -1.14, 4.5, .4]];
  for (const [n, nx, ny, d, s, flip] of fg) L.push({ layer: 'fg', n, p: inView(cam, nx, ny, d), s, k: 'face', flip });
  return L;
}

// 浮尘（小球）：在光柱里慢慢飘
export const MOTES = 150;
export function moteAt(i, t) {
  const a = t * (.12 + rnd(i, 131) * .16) + rnd(i, 132) * 6.28;
  return { x: -6 + rnd(i, 133) * 12 + Math.cos(a) * .4, y: .5 + rnd(i, 134) * 4.2 + Math.sin(a * 1.4) * .25, z: -3.6 + rnd(i, 135) * 7.6 + Math.sin(a) * .35, r: .008 + rnd(i, 136) * .01 };
}
// 光柱：顺着阳光的软片（落点 x、z，宽度，强度）
export const SHAFTS = [[-1.6, -.2, 2.3, 1], [1.2, .6, 1.7, .8], [3.6, -1.4, 1.3, .6], [-4.2, 1.6, 1.4, .65], [.2, -2.9, 1.5, .7], [-2.9, 3.2, 1.0, .45]];

// 树冠漏光板：一块只投影、不显示的镂空板，挡在太阳和场地之间。擂台上方留一个亮的豁口，四周是碎的光斑。
// 返回一格格小方片（落在地面上是 .42 米见方），film.tsx 拼成一张网格
const gn = (x, z, k) => { const xi = Math.floor(x), zi = Math.floor(z), u = x - xi, v = z - zi, s = t => t * t * (3 - 2 * t), g = (a, b) => rnd(a * 131 + b * 17 + 4000, k); return (g(xi, zi) * (1 - s(u)) + g(xi + 1, zi) * s(u)) * (1 - s(v)) + (g(xi, zi + 1) * (1 - s(u)) + g(xi + 1, zi + 1) * s(u)) * s(v); };
export function goboCells(height = 11, cell = .42) {
  const L = [], lift = sunDir.map(v => v * height / sunDir[1]);
  for (let gz = -9; gz < 8; gz += cell) for (let gx = -12; gx < 12; gx += cell) {
    const x = gx + cell / 2, z = gz + cell / 2, pool = (x / 4.6) ** 2 + ((z - .1) / 2.9) ** 2;
    const leaf = gn(x / 2.6, z / 2.6, 1) * .6 + gn(x / .9, z / .9, 2) * .4;
    if (leaf > (pool < 1 ? .86 : pool < 1.8 ? .56 : .66)) continue;         // 留空的格子：光从这里漏下去
    if (pool < 1 && leaf > .2) continue;
    L.push([gx + lift[0], lift[1], gz + lift[2], cell]);
  }
  return L;
}
