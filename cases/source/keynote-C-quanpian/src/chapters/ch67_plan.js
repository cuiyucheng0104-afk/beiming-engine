// 第六·七章的纯数据：时间表、洽谈室布局、「谈」城布局。不 import three，别的章节（例如第五章想让城从一开始就按「谈」字留街道）可以直接 import 这份。
// 坐标：世界米制，y 向上，x 向右，z 朝镜头（书页中心 = 原点）；PG = 书页表面高。
import { at, fq, KEY } from '../timeline.js';

export const PG = .023;

// ———————————————— 时间（全部量化到整帧；画面与音效共用） ————————————————
const q = t => fq(t);
export const TM = {
  ch5Fold: [at(73, 2), at(73, 4)],                        // 返修：144.5–145.0 三扇门关上（一拍），145.0–145.5 门楼折平（gate.retract r 0→1）
  roomRise: [at(73, 4), at(74)],                          // 洽谈室从纸面立起，146.0 立定
  steps: KEY.ch6.steps,                                   // 146 150 154 158：每步先印朱红方块
  folder: KEY.ch6.folder,                                 // 162.0 文件夹落桌
  folderLift: q(at(81, 4) + .0),                          // 161.5 领头人抬手把文件夹放过去
  folderOpen: at(82, 2),                                  // 162.5 翻开到位
  sign: at(82, 3),                                        // 163.0 立牌弹起
  rows: [at(82, 4), at(83, 2), at(83, 4)],                // 163.5 164.5 165.5 三条纸条立起
  plazaClear: [at(73, 3), at(73, 4)],                     // 返修：广场上的路灯、花坛、行人 145.0–145.5 缩回纸面（原来是一帧消失）
  floorRoll: [at(73, 4), at(74)],                         // 返修：145.5–146.0 地板像地毯一样从门楼的折线处向镜头铺开
  tanStroke0: at(86),                                     // 170.0 起，每八分音符一笔
  cityBack: [KEY.ch7.back, q(KEY.ch7.back + 1.0)],        // 174.0–175.0 城收回书页（第五章 setRetract）
  roomFold: [KEY.ch7.back, q(KEY.ch7.back + .6)],         // 174.0–174.6 洽谈室跟着城一起折平
  close: KEY.ch7.close,                                   // 176.0 合书（共用层）
  coverA: at(89, 2), coverB: at(89, 3),                   // 176.5「选定方向」 177.0「· 开始洽谈」
  footer: KEY.ch7.footer,                                 // 178.0 口径小字
};
export const E8 = .25, E16 = .125;
// 第 k 步：方块 @T，字 @T+0.5j，小字在最后一个字后一拍；小人在第 4（五字为第 4）拍后起步，八分音符一步
export function stepTimes(k, nTok) {
  const T = TM.steps[k];
  const toks = Array.from({ length: nTok }, (_, j) => q(T + .5 * (j + 1)));
  const sub = q(T + .5 * (nTok + 1));
  const walk = k === 0 ? [q(T + 2.0), q(T + 3.75)] : k === 3 ? [q(T + 1.5), q(T + 3.5)] : [q(T + 2.0), q(T + 3.5)];
  return { T, toks, sub, walk };
}

// ———————————————— 洽谈室（世界坐标 = O + 局部） ————————————————
export const O = [.07, PG, .072];                         // 房间中心 = 第五章广场（门楼折平后让出来的地方），x ∈ [−.03, .17]、z ∈ [.0105, .1345]
export const ROOM = { hx: .10, hz: .0625, wallH: .030, lowH: .0062, floorT: .0016, door: [.036, .0625] };
export const FIG_H = .0172;                               // 小人高（1.7 m @ 1:100）
export const BIG = .0142, SMALL = .0066;                  // 地面大字 / 小字字号（米）
export const STATION_X = [.078, .040, .002, -.036];      // 每步大字基线（+x 一侧）的局部 x
export const PHRASE_Z = .028;                             // 每行字的起点（局部 z），向 −z 读
export const LANE_Z = .049;                               // 小人走的路（局部 z）
export const TABLE = { x: [-.097, -.055], z: [-.036, -.013], h: .0075 };
export const BOARD = { x: -.076, z: -.0245, w: .046, h: .034 };      // 立牌：面朝 +z（迎着台灯），宽沿 x
// 小人的站位（局部 x，z）。lead = 领头人（拿文件夹），f1、f2 跟在后面（+x 一侧，间隔 0.8 m）
export const START = [[.093, LANE_Z], [.1015, LANE_Z], [.110, LANE_Z]];
export const STOP = k => [[STATION_X[k] - .004, LANE_Z], [STATION_X[k] + .0045, LANE_Z], [STATION_X[k] + .013, LANE_Z]];
export const FINAL = [[-.073, .029], [-.085, .041], [-.062, .042]];

// ———————————————— 「谈」 ————————————————
// 「谈」字的十条街由第五章的城给出（ctx.use('city').plan.strokes，世界坐标；ch5_plan.js 的 STROKES），本章只按笔顺把它们点亮。
export const N_STROKES = 10;
