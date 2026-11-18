// 《林间擂台》· 场面调度：棋盘尺寸、谁站在哪一格、灯在哪、镜头怎么走。只有数字，没有 three、没有 DOM。
// B 版（films/fanpan-b/layout.js）是这一份的原样拷贝：两条路线摆的是同一个场面，差别只在各自的渲染。
// 坐标：x 沿兵线（左 = 我方城门，右 = 敌方城门），z 是四条线（负 = 远，正 = 靠近镜头），y 向上；单位米。

export const FPS = 24, FRAMES = 144;                 // 6 秒的循环小样
export const ROWS = 5, LANES = 4;                     // 4 路 × 5 格，和游戏一致
export const LX = 1.15, LZ = 1.1, TOP = .34;          // 一格的长、宽，棋盘石面离地的高度
export const HX = ROWS * LX / 2, HZ = LANES * LZ / 2; // 棋盘半长、半宽
export const GATE_X = HX + .73;                       // 城门墙中线离棋盘中心
export const tileX = row => (row - (ROWS - 1) / 2) * LX;   // 第 0 排挨着我方城门
export const tileZ = lane => (lane - (LANES - 1) / 2) * LZ; // 第 0 路最远，最后一路最靠镜头
export const FRONT_ROW = 2;                           // 我方前线推进到第几排（前线那条亮线画在这一排的右边）
export const HP = { own: 10, foe: 6 };

// 棋子：游戏仓库 assets/units 里的 CC0 待机序列帧（来自 OpenDuelyst），敌方已经整条左右翻转。
// cell 一帧的边长（像素）、feet 脚底在帧里的 y、frames 帧数、scale 游戏里的放大倍率（让站高约 58 像素）
export const UNITS = [
  { id: 'ranged', str: 2, atlas: 'f1_ranged', team: 'own', lane: 0, row: 0, cell: 80, feet: 64, frames: 10, scale: 1.35 },
  { id: 'guardian', str: 5, atlas: 'f1_ironcliffeguardian', team: 'own', lane: 1, row: 1, cell: 80, feet: 64, frames: 18, scale: 1.25 },
  { id: 'tank', str: 3, atlas: 'f1_tank', team: 'own', lane: 2, row: 2, cell: 80, feet: 64, frames: 11, scale: 1.55 },
  { id: 'squire', str: 1, atlas: 'f1_silverguardsquire', team: 'own', lane: 2, row: 0, cell: 80, feet: 64, frames: 10, scale: 1.6 },
  { id: 'lion', str: 4, atlas: 'f1_azuritelion', team: 'own', lane: 3, row: 1, cell: 80, feet: 65, frames: 14, scale: 1.6 },
  { id: 'crawler', str: 2, atlas: 'f4_crawler', team: 'foe', lane: 0, row: 2, cell: 80, feet: 64, frames: 12, scale: 1.6 },
  { id: 'sorrow', str: 3, atlas: 'f4_nightsorrow', team: 'foe', lane: 0, row: 4, cell: 80, feet: 64, frames: 12, scale: 1.6 },
  { id: 'juggernaut', str: 6, atlas: 'f4_juggernaut', team: 'foe', lane: 1, row: 3, cell: 80, feet: 65, frames: 12, scale: 1.3 },
  { id: 'chaser', str: 2, atlas: 'f4_gloomchaser', team: 'foe', lane: 2, row: 4, cell: 80, feet: 64, frames: 12, scale: 1.6 },
  { id: 'spine', str: 4, atlas: 'f4_darkspine', team: 'foe', lane: 3, row: 3, cell: 80, feet: 64, frames: 12, scale: 1.55 },
];
export const SPRITE_FPS = 10;                         // 角色一拍二到一拍三：比镜头的 24 帧慢，像素动画才有顿挫
// 一帧画多大（米）、脚底离帧底多高（米）：像素密度和场景贴图（每米 40 像素）对齐
export function spriteBox(u) {
  const px = u.scale / 64 * LX * .8, size = u.cell * px;
  return { size, px, lift: size / 2 - (u.cell - u.feet) * px };   // lift：卡片中心离脚底的高度
}
export const spriteFrame = (u, frame) => Math.floor(frame * SPRITE_FPS / FPS + u.lane * 3 + u.row * 5) % u.frames;

// 灯：暖色的小光源压在冷而暗的环境光上（两种色温）。power 是相对量，各路线自己换算成本路线的单位
export const TEAM = { own: '#00c098', foe: '#f84850' };
const WARM = '#ffb45e', FIRE = '#ff8a3c';
export const LAMPS = [
  { id: 'brazier-own-far', kind: 'brazier', x: -GATE_X, y: 1.95, z: -(HZ + .78), color: FIRE, power: 1.5, shadow: true },
  { id: 'brazier-own-near', kind: 'brazier', x: -GATE_X, y: 1.3, z: HZ + .78, color: FIRE, power: 1.5 },
  { id: 'brazier-foe-far', kind: 'brazier', x: GATE_X, y: 1.95, z: -(HZ + .78), color: FIRE, power: 1.5, shadow: true },
  { id: 'brazier-foe-near', kind: 'brazier', x: GATE_X, y: 1.3, z: HZ + .78, color: FIRE, power: 1.5 },
  { id: 'post-far-left', kind: 'lantern', x: -1.75, y: 1.62, z: -(HZ + 1.05), color: WARM, power: 1 },
  { id: 'post-far-right', kind: 'lantern', x: 1.75, y: 1.62, z: -(HZ + 1.05), color: WARM, power: 1 },
  { id: 'stone-left', kind: 'lantern', x: -2.5, y: .62, z: HZ + 1.2, color: WARM, power: .55 },
  { id: 'stone-right', kind: 'lantern', x: 2.5, y: .62, z: HZ + 1.2, color: WARM, power: .55 },
  { id: 'hut-left', kind: 'window', x: -4.55, y: 1.12, z: -3.7, color: WARM, power: .9 },
  { id: 'hut-right', kind: 'window', x: 4.75, y: 1.12, z: -3.95, color: WARM, power: .9 },
  { id: 'foreground', kind: 'lantern', x: -3.7, y: 3.3, z: 5.6, color: WARM, power: .8 },
  { id: 'team-own', kind: 'team', x: -(GATE_X - 1), y: 1.3, z: 0, color: TEAM.own, power: .5 },
  { id: 'team-foe', kind: 'team', x: GATE_X - 1, y: 1.3, z: 0, color: TEAM.foe, power: .5 },
];
// 火光的明暗起伏：几个不成比例的正弦叠起来，逐帧可算、不用随机数
export function flicker(i, t) {
  return 1 + .09 * Math.sin(t * 9.1 + i * 2.3) + .06 * Math.sin(t * 15.7 + i * 5.1) + .04 * Math.sin(t * 23.3 + i * 1.7);
}

// 太阳：傍晚的斜光从左后方的树冠缝里漏下来，在空地上落成一块一块的光斑
export const SUN = { from: [-8.5, 15, -9.5], to: [.6, 0, .4], color: '#ffcf8f' };
export const AMBIENT = { sky: '#5f8fa8', ground: '#1f2a22' };
export const BACKDROP = '#070d0c';

// 镜头：长焦、高位俯拍，6 秒里慢慢推近一点并向右挪一点；焦点一直落在棋盘中线
export const CAMERA = {
  fov: 21, near: 2, far: 60,
  from: { pos: [-.55, 11.5, 16.9], look: [-.05, .6, -.5] },
  to: { pos: [.35, 11.1, 16.3], look: [.05, .6, -.5] },
};
const ease = k => k * k * (3 - 2 * k);
export function cameraAt(frame) {
  const k = ease(Math.max(0, Math.min(1, frame / (FRAMES - 1)))), mix = (a, b) => a.map((v, i) => v + (b[i] - v) * k);
  return { pos: mix(CAMERA.from.pos, CAMERA.to.pos), look: mix(CAMERA.from.look, CAMERA.to.look), fov: CAMERA.fov };
}

// 空中的浮尘和萤火：位置由编号算出来，随时间慢慢飘
export const MOTES = 150;
export function moteAt(i, t) {
  const h = n => { const s = Math.sin(i * 127.1 + n * 311.7) * 43758.5453; return s - Math.floor(s); };
  const fire = i % 5 === 0;
  return {
    x: (h(1) - .5) * 15 + Math.sin(t * (.25 + h(4) * .3) + i) * .35,
    y: .5 + h(2) * (fire ? 1.6 : 4.2) + Math.sin(t * (.3 + h(5) * .3) + i * 1.7) * .22,
    z: (h(3) - .5) * 11 - .5 + Math.cos(t * (.2 + h(6) * .3) + i * .7) * .35,
    fire, glow: fire ? .55 + .45 * Math.sin(t * (1.2 + h(7)) + i) : .5 + .3 * Math.sin(t * .8 + i),
  };
}
