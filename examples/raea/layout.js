// 《北冥》原生例片 · 机位、站位与版式（纯数据 + 纯函数，不 import 运行时）。
// film.tsx 按它摆东西，片名页面 title/ 按它定片名框，tests/native/example-layout.test.mjs 用 engine/native/view.js 投影逐帧核对：
// 云片的截断边始终在画外（或在 film.json 里烘了有机软边）、天空底板始终盖满画面、片名不压鲲、在安全区里。
// 改这里的数字后在仓库根跑：node --test tests/native
//
//   layout({ W, H, FPS, frames }) → { K, shots, kun(f), ferry(t), sky(index), cards, title, events }
//     K           2D 像素量的缩放 = H / 1040（设计高；分辨率改了 2D 版式跟着缩放，三维量不变）
//     shots       三个镜头（view.js 的 shotAt 格式）：渡船建立尺度 → 鲲眼近景 → 拉开收片名；切点 3.5 / 6 秒
//     kun(f)      鲲的根位置与姿态：位置、昂头都按一拍三（heldTime(f, 3)）走，与 Swim 片段同一个时钟——鲲整个是「一拍三」的
//     ferry(t)    渡船：位置按速度匀速走，偏航由速度算（headingYaw），尾迹在船尾后方、与船同一个偏航
//     sky(i)      第 i 个镜头的天空底板铺法 { x, y, width, height }：再加上 skyShift(t) 就是这一帧的位置。
//                 底板按原图 2:1 等比放大（不拉伸），大小与起点由这一镜里天空要移动的范围算出，保证每一帧都盖满画面
//     cards       绘画卡片（ImagePlane）：{ name, src, image, position, width, aspect, drift, rotation, shots, cut }
//                 shots 是出现在哪几个镜头（0 起算）——近景云按镜头摆（每镜一套，用屏幕框 + 深度换算成世界坐标，
//                 与该镜画面平行，防纸板感）；cut 是这张图被画幅截断的边：竖直的截断边必须一直在画外，
//                 上下的截断边若进画，film.json 的 images[].edge 必须给这条边烘了有机软边
//     title       片名框（画面比例）：{ x, y, size } → 毛笔片名页面 title/ 与安全区检查共用
//     events      film.json 的 events 换算成秒：{ id: 秒 }（声音脚本读同一份 film.json，画面与声音同一个帧号）
import { shotAt, skyShift, headingYaw, behind, cardInView } from '../../engine/native/view.js';

// 底板原图的宽高比（像素宽 / 高，见 assets/plates/plates.json）
export const ASPECT = { sky_dawn: 3548 / 1774, clouds_back: 4344 / 1448, skyline_pudong: 3548 / 1774, clouds_front_a: 3072 / 2048, clouds_front_b: 3548 / 1774 };

export const SHOTS = [
  { until: 3.5, eye: [[-11, 4, 38], [-6, 5, 31]], at: [1, 7.4, -1], fov: 40 },
  { until: 6, eye: [[17, 12.2, 10], [19, 13.1, 7.8]], at: [10.8, 12.3, -1], fov: 34 },
  { until: 10, eye: [[26, 17, 29], [30, 21, 35]], at: [3, 10, -1], fov: 42 },
];

const FERRY = { start: [-3, 0.1, 11], v: [0.5, 0, -0.65], wakeBehind: 4.77, wakeDrop: -0.33 };

// 某一镜起点的机位（按镜摆的卡片按它换算）
const camAtStart = i => shotAt(i ? SHOTS[i - 1].until : 0, SHOTS);

function cardsFor(W, H) {
  const cards = [
    // 远层：鲲身后的云堤（两端原图已柔化淡出）与陆家嘴天际线（等比；水岸线在图高 0.80 处，对齐江面 y = −0.25）——三个镜头共用
    { name: 'cloud-bank', src: 'clouds_back.png', image: 'clouds_back', position: [-28, 32, -140], width: 150, drift: [0.1, 0, 0], shots: [0, 1, 2], cut: [] },
    { name: 'skyline', src: 'skyline_pudong.png', image: 'skyline_pudong', position: [-6, 0, -150], width: 112, shots: [0, 1, 2], cut: [], waterline: 0.8, water: -0.25 },
    // 第一镜：左右两团近景云夹出渡船前方的云隙（世界坐标摆，两团云向两侧拉开）
    { name: 'left-cloud', src: 'clouds_front_a.png', image: 'clouds_front_a', position: [-34, 8, -25], width: 57, drift: [-0.6, 0, 0], shots: [0], cut: ['left', 'top', 'bottom'] },
    { name: 'right-cloud', src: 'clouds_front_b.png', image: 'clouds_front_b', position: [44, 7, -31], width: 63, drift: [0.9, 0, 0], shots: [0], cut: ['right', 'top', 'bottom'] },
    // 第三镜（按屏幕框摆，engine/native/view.js 的 cardInView）：左下一团前景云托住画面一角，截断的左边远在画外；
    // 右边一团低云压住远处江面，截断的右边在画外。两团都随镜头后拉产生视差
    { name: 'wide-cloud-left', src: 'clouds_front_a.png', image: 'clouds_front_a', view: { shot: 2, left: -0.42, cy: 0.98, width: 0.86, depth: 26 }, drift: [-0.4, 0, 0], shots: [2], cut: ['left', 'top', 'bottom'] },
    { name: 'wide-cloud-right', src: 'clouds_front_b.png', image: 'clouds_front_b', view: { shot: 2, left: 0.6, cy: 0.66, width: 0.9, depth: 70 }, drift: [0.5, 0, 0], shots: [2], cut: ['right', 'top', 'bottom'] },
  ];
  for (const c of cards) {
    c.aspect = ASPECT[c.image];
    if (c.view) Object.assign(c, cardInView({ cam: camAtStart(c.view.shot), ...c.view }, [W, H]));
    if (c.waterline !== undefined) c.position = [c.position[0], c.water + (c.waterline - 0.5) * (c.width / c.aspect), c.position[2]];
  }
  return cards;
}

export function layout({ W, H, FPS, frames }) {
  const K = H / 1040;
  const ferry = t => {
    const p = FERRY.start.map((x, i) => x + t * FERRY.v[i]), yaw = headingYaw(FERRY.v);
    return { position: p, yaw, wake: behind(p, yaw, FERRY.wakeBehind, FERRY.wakeDrop) };
  };
  // 鲲：一拍三的时钟 q（与 Swim 片段相同），昂头在第三镜里完成
  const kun = f => {
    const q = Math.floor(f / 3) * 3 / FPS;
    const raise = Math.min(1, Math.max(0, (q - 6) / 4));
    return { q, clip: (q + 2) % 10, position: [-2 + q * 0.8, 13 + Math.sin(q * 0.7) * 0.45, -2], rotation: [-0.08, -0.18, -0.05 + (0.10 + 0.05) * raise] };
  };
  // 天空：每一镜里 skyShift 的范围 → 底板等比放大到能盖住整个范围，起点放在范围中间
  const range = SHOTS.map(() => ({ x: [Infinity, -Infinity], y: [Infinity, -Infinity] }));
  for (let f = 0; f < frames; f++) {
    const t = f / FPS, i = shotAt(t, SHOTS).index, [dx, dy] = skyShift(t, SHOTS, [W, H]);
    const r = range[i];
    r.x = [Math.min(r.x[0], dx), Math.max(r.x[1], dx)];
    r.y = [Math.min(r.y[0], dy), Math.max(r.y[1], dy)];
  }
  const need = range.map(r => ({ w: W + (r.x[1] - r.x[0]), h: H + (r.y[1] - r.y[0]) }));
  const height = Math.ceil(Math.max(...need.map(n => Math.max(n.h, n.w / ASPECT.sky_dawn))) * 1.04);   // 4% 余量
  const width = Math.ceil(height * ASPECT.sky_dawn);
  const sky = i => {
    const r = range[i];
    return { x: (W - width) / 2 - (r.x[0] + r.x[1]) / 2, y: (H - height) / 2 - (r.y[0] + r.y[1]) / 2, width, height };
  };
  return { K, shots: SHOTS, kun, ferry, sky, skyRange: range, cards: cardsFor(W, H), title: { x: 0.06, y: 0.2, size: 0.2 } };
}

// 片名框（像素）：与 title/title.js 的排法一致——两个字的中心在 (x·W + 0.462F, y·H) 与再往右 0.90F，字号 F = size·H
export function titleBox({ W, H }, { x, y, size }) {
  const F = size * H, xB = x * W + 0.462 * F, xM = xB + 0.90 * F, yc = y * H;
  return { F, glyphs: [['北', xB, yc], ['冥', xM, yc]], box: [xB - 0.47 * F, yc - 0.42 * F, xM + 0.38 * F, yc + 0.47 * F] };
}

export const eventSeconds = film => Object.fromEntries((film.events || []).map(e => [e.id, e.frame / film.fps]));
