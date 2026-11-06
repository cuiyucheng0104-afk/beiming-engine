// 唯一时间源：节拍网格、所有事件（以拍为单位）、机位与对焦曲线。画面、拟音、核对脚本都读这里。
// 坐标：米；x 向东，z 向南（-z = 北）；yaw 0 = 朝北，+π/2 = 朝西，−π/2 = 朝东
import { track, monotone, clamp } from '/core/lib.js';

export const BPM = 72, B = 60 / BPM, FPS = 24;          // 1 拍 = 0.8333 s = 20 帧；1/16 = 5 帧
export const bt = b => b * B;
export const BEATS = 23;
export const DUR = bt(BEATS);                           // 19.167 s = 460 帧

// —— 事件（拍） ——
export const CUE = {
  recOn: 0,                // 开机、REC
  afLock0: 1,              // 第一次对焦锁定（插座开关）
  pan: [1, 4],             // 慢摇揭示走廊
  chime: [2, 2.5, 3],      // 吸顶喇叭提示音三音
  flickFar: 3.5,           // 远处一盏灯闪（摇镜快落定时）
  walk: [4.5, 8.5],        // 起步 / 停步
  steps: [5, 6, 7, 8],     // 脚落地
  afSlip: 6, afHunt: [7, 7.5], afLock1: 8,
  turnN: [8, 9],           // 左转到告示
  hold: [9, 12],           // 屏息
  flickNear: 10,           // 头顶灯闪
  turnD: 12,               // 转向门
  doors: [13, 13.5, 14, 14.25],   // 每扇门过画心
  tear: 14.5,              // 跟踪撕裂 + 数字零
  impact: 16,              // 静默后第一声：低频冲击 + 灯管齐打火 + 画面恢复
  lampOff: [16.5, 16.75],  // 红色占用灯最后两次断火
  lampLock: 17,            // 红灯最后一个稳定下来
  zoom: [16, 20],
  afBlur: 17, afOver: 17.5, afLock2: 18,
  reset: 20,               // 时间码归零
  chimeFlat: [20.5, 21, 21.5],
  end: 23,
};
export const T = {};
for (const [k, v] of Object.entries(CUE)) T[k] = Array.isArray(v) ? v.map(bt) : bt(v);

// —— 空间锚点 ——
export const C1 = { xw: -1.2, xe: 1.3, cx: 0.05 };      // 走廊一
export const START = [-0.32, 0.35];                    // 开机机位（面朝西墙开关）
export const SWITCH = { x: C1.xw, y: 1.28, z: 0.35 };
export const ZN = -2.55;                               // 告示所在 z（也是停步处）
export const NOTICE = { x: C1.xw, y: 1.50, z: ZN };
export const DOORS_Z = [-7.05, -5.55, -4.05, -2.55, -1.05, -8.55, -10.05, -11.55];   // 东墙一排门（前 4 扇按甩镜顺序）
export const C2 = { xw: 27.6, xe: 30.1, cx: 28.85, zEnd: -22.5 };                     // 走廊二（撕裂之后）
export const ENDDOOR = { x: C2.cx, z: C2.zEnd };
export const LAMP = { x: C2.cx, y: 2.36, z: C2.zEnd };
export const CAM2 = [C2.cx + 0.04, -14.6];

const PI = Math.PI;
const yawTo = (from, p) => Math.atan2(-(p[0] - from[0]), -(p[1] - from[1]));
const CAMN = [C1.cx, ZN];
export const DOOR_YAW = DOORS_Z.slice(0, 5).map(z => yawTo(CAMN, [C1.xe, z]));

// —— 机位关键帧（时间以拍写，换算成秒） ——
const K = arr => arr.map(([b, v]) => [bt(b), v]);
// 位置（第一段 0–14.5 拍；撕裂之后跳到走廊二）
const POS1 = track(K([
  [0, START], [1, START], [4, [-0.05, 0.3]], [4.5, [C1.cx, 0.28]], [8.5, CAMN], [14.5, CAMN],
]));
const POS2 = track(K([[16, CAM2], [20, [CAM2[0], CAM2[1] - 0.35]], [23, [CAM2[0], CAM2[1] - 0.38]]]));
export const POS = t => t < T.impact ? POS1(Math.min(t, T.tear)) : POS2(t);
// 步态：脚落地（颠簸最低点）正好在拍上
export function gait(t) {
  const [a, b] = T.walk; if (t <= a || t >= b) return { amp: 0, ph: 0 };
  const amp = clamp((t - a) / (B * .5)) * clamp((b - t) / (B * .5));
  return { amp, ph: PI * (t - bt(5)) / B };
}
const YAW1 = monotone(K([
  [0, PI / 2], [1, PI / 2], [4, 0.04], [8, 0.0], [9, PI / 2], [12, PI / 2],
  [13, DOOR_YAW[0]], [13.5, DOOR_YAW[1]], [14, DOOR_YAW[2]], [14.25, DOOR_YAW[3]], [14.6, DOOR_YAW[3] - 0.95],
]));
export const YAW = t => t < T.impact ? YAW1(Math.min(t, T.tear)) : 0.0;
const PITCH1 = monotone(K([[0, -0.07], [1, -0.07], [4, -0.02], [8, -0.02], [9, 0.0], [12, 0.0], [13, -0.01], [14.6, -0.02]]));
// 走廊二：随变焦推进略微抬头，让门牌与红灯同时在画内（门牌在画心下方，红灯在上方）
const PITCH2 = monotone(K([[16, 0.012], [18, 0.028], [20, 0.037], [23, 0.038]]));
export const PITCH = t => t < T.impact ? PITCH1(Math.min(t, T.tear)) : PITCH2(t);
// 机身高度偏移：读告示时降一点，让镜头与纸面平行居中
const CAMH1 = monotone(K([[0, -0.2], [8, 0], [9, -0.08], [12, -0.08], [13, 0]]));
export const CAMH = t => t < T.impact ? CAMH1(Math.min(t, T.tear)) : 0;
// 水平视角（度）：走廊二变焦推进
// b18 对焦锁定时门牌已占画高 >15%；b20 推到底（约为原终点的 1.5 倍）
export const FOV = monotone(K([[0, 52], [16, 52], [18, 22], [20, 16.5], [23, 16]]));
// 对焦距离（米）：对焦搜寻 = 来回拉
const FOC1 = monotone(K([
  [0, 0.25], [0.6, 1.6], [1, 0.84], [2.2, 1.6], [3.6, 7], [5, 7], [6, 7], [6.4, 0.55], [7, 22], [7.5, 2.6], [8, 7],
  [8.4, 4], [9, 1.2], [12, 1.2], [12.6, 3.4], [13, 4.68], [13.25, 2.6], [13.5, 3.25], [13.75, 1.4], [14, 1.95], [14.25, 1.27], [14.6, 0.8],
]));
const FOC2 = monotone(K([[16, 5.6], [16.6, 6.6], [17, 1.6], [17.5, 15], [18, 7.9], [23, 7.9]]));
export const FOCUS = t => t < T.impact ? FOC1(Math.min(t, T.tear)) : FOC2(t);
export const APER = monotone(K([[0, 3.2], [4, 3.2], [5, 5], [8.5, 5], [9, 3.5], [12, 3.5], [13, 4.5], [16, 4], [20, 13], [23, 13]]));
// 紧张度（手持抖动）
export const FEAR = monotone(K([[0, .12], [5, .2], [9, .3], [12, .4], [13, .7], [14.5, 1], [16, .85], [20, .55], [23, .5]]));
// 屏息：手持全部冻结
export const HOLD = t => 1 - clamp(Math.min((t - (T.hold[0] - .12)) / .12, (T.hold[1] + .25 - t) / .25), 0, 1);

// —— OSD：时间码就是剧情 ——
const tc = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return [h, m, x].map(v => String(v).padStart(2, '0')).join(':'); };
export function clock(t) {
  if (t < T.tear) return tc(t);
  if (t < T.impact) return tc(T.tear);
  if (t < T.reset) return tc(3 * 3600 + 47 * 60 + 15 + (t - T.impact));
  return tc(t - T.reset);
}
export const battery = t => t < T.impact ? 3 : t < T.reset ? 2 : 3;
