// 《林间寨擂》· 场面调度：棋盘尺寸、谁站在哪一格、镜头、光的方向。只有数字，没有 three、没有 DOM。C 版自己的一份，不和 B 版共用。
// 坐标：x 沿兵线（左 = 我方寨门，右 = 敌方寨门），z 是四条线（负 = 远，正 = 靠近镜头），y 向上；单位米。
export const FPS = 24, FRAMES = 144;                 // 6 秒的循环小样
export const ROWS = 5, LANES = 4;                     // 4 路 × 5 格，和游戏一致
export const LX = 1.2, LZ = 1.1, TOP = .56;           // 一格的长、宽（贴图上是 48 × 44 像素），棋盘石面离地的高度
export const HX = ROWS * LX / 2, HZ = LANES * LZ / 2;
export const GATE_X = 4.2;                            // 寨门楼中线离棋盘中心
export const tileX = row => (row - (ROWS - 1) / 2) * LX;    // 第 0 排挨着我方寨门
export const tileZ = lane => (lane - (LANES - 1) / 2) * LZ; // 第 0 路最远，最后一路最靠镜头
export const FRONT_ROW = 2;                           // 前线画在第 2 排和第 3 排之间
export const HP = { own: 10, foe: 6 };
export const SELECT = { lane: 2, row: 2 };            // 金色选中框落在哪一格（下一步要走的空格）

// 棋子：游戏仓库 assets/units 的 CC0 待机序列帧（敌方已整条左右翻转）。cell 一帧的边长、feet 脚底在帧里的 y、frames 帧数、scale 游戏里的放大倍率。
// 摆法：每一排最多两个棋子、而且不在相邻的两条线上，前面的棋子就不会挡住后面的
export const UNITS = [
  { id: 'ranged', str: 2, atlas: 'f1_ranged', team: 'own', lane: 0, row: 0, cell: 80, feet: 64, frames: 10, scale: 1.35 },
  { id: 'squire', str: 1, atlas: 'f1_silverguardsquire', team: 'own', lane: 3, row: 0, cell: 80, feet: 64, frames: 10, scale: 1.6 },
  { id: 'tank', str: 3, atlas: 'f1_tank', team: 'own', lane: 2, row: 1, cell: 80, feet: 64, frames: 11, scale: 1.55 },
  { id: 'guardian', str: 5, atlas: 'f1_ironcliffeguardian', team: 'own', lane: 1, row: 2, cell: 80, feet: 64, frames: 18, scale: 1.25 },
  { id: 'lion', str: 4, atlas: 'f1_azuritelion', team: 'own', lane: 3, row: 2, cell: 80, feet: 65, frames: 14, scale: 1.6 },
  { id: 'crawler', str: 2, atlas: 'f4_crawler', team: 'foe', lane: 0, row: 1, cell: 80, feet: 64, frames: 12, scale: 1.6 },
  { id: 'juggernaut', str: 6, atlas: 'f4_juggernaut', team: 'foe', lane: 1, row: 3, cell: 80, feet: 65, frames: 12, scale: 1.3 },
  { id: 'spine', str: 4, atlas: 'f4_darkspine', team: 'foe', lane: 3, row: 3, cell: 80, feet: 64, frames: 12, scale: 1.55 },
  { id: 'sorrow', str: 3, atlas: 'f4_nightsorrow', team: 'foe', lane: 0, row: 4, cell: 80, feet: 64, frames: 12, scale: 1.6 },
  { id: 'chaser', str: 2, atlas: 'f4_gloomchaser', team: 'foe', lane: 2, row: 4, cell: 80, feet: 64, frames: 12, scale: 1.6 },
];
// 正在交手的两对（中间画斩击和火花）：[我方, 敌方]
export const CLASHES = [['guardian', 'juggernaut'], ['lion', 'spine'], ['ranged', 'crawler']];
export const SPRITE_FPS = 10;                         // 角色比镜头的 24 帧慢，像素动画才有顿挫
const PXM = .0172;                                    // 棋子一个像素多少米（× scale）：比场景的每米 40 像素略粗一点，棋子在画面里更大
export function spriteBox(u) { const px = u.scale * PXM, size = u.cell * px; return { size, px, lift: size / 2 - (u.cell - u.feet) * px }; }
export const spriteFrame = (u, frame) => Math.floor(frame * SPRITE_FPS / FPS + u.lane * 3 + u.row * 5) % u.frames;

export const TEAM = { own: '#00c8a8', foe: '#f04048' };
// 光的方案（从参考图量出来的）：暗而偏青的环境光，一束从左后上方穿过树冠的金色斜阳，只在擂台上留一个完整的光池，四周是碎光斑；
// 火盆和灯笼是暖橙色的小光源，两座寨门各一颗阵营色的晶石
export const SUN = { from: [-9.5, 15, -6.5], to: [0, 0, 0], color: '#ffd28c' };
export const AMBIENT = { sky: '#5a9ab4', ground: '#16302a' };
export const BACKDROP = '#061a1c';
export const FIRE = '#ff8a3a', WARM = '#ffbe6a';
export function flicker(i, t) { return 1 + .1 * Math.sin(t * 9.1 + i * 2.3) + .06 * Math.sin(t * 15.7 + i * 5.1) + .04 * Math.sin(t * 23.3 + i * 1.7); }

// 镜头：长焦、高位俯拍（俯角约 31°），6 秒里慢慢推近一点并向右挪一点；焦点一直落在棋盘中心
export const CAMERA = { fov: 22, near: 2, far: 60, from: { pos: [-.5, 10.4, 15.9], look: [-.05, .6, -.25] }, to: { pos: [.4, 10.1, 15.4], look: [.05, .6, -.25] } };
const ease = k => k * k * (3 - 2 * k);
export function cameraAt(frame) {
  const k = ease(Math.max(0, Math.min(1, frame / (FRAMES - 1)))), mix = (a, b) => a.map((v, i) => v + (b[i] - v) * k);
  return { pos: mix(CAMERA.from.pos, CAMERA.to.pos), look: mix(CAMERA.from.look, CAMERA.to.look), fov: CAMERA.fov };
}
// 由编号算出来的伪随机数（0–1）：飘浮物的位置都靠它，不用随机数发生器
export const rnd = (i, n) => { const s = Math.sin(i * 127.1 + n * 311.7) * 43758.5453; return s - Math.floor(s); };
