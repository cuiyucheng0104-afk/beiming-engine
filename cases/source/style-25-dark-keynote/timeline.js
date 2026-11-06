// timeline.js — 全片唯一时间源（画面 / 配乐 / 拟音 / 核对 共用）
// 90 BPM，4/4。b = 拍序（从 0 开始），t = b × BEAT。24 fps 下 1 拍 = 16 帧，十六分 = 4 帧，三十二分 = 2 帧。
export const BPM = 90;
export const BEAT = 60 / BPM;            // 0.6667 s
export const BAR = BEAT * 4;             // 2.6667 s
export const S16 = BEAT / 4;
export const DUR = 19.75;                // 474 帧
export const bt = b => Math.round(b * BEAT * 1e6) / 1e6;

// 关键拍（拍序）
export const KB = {
  pulse0: 0,        // 开场低频脉冲
  traceGo: 0,       // 光头出发（第一帧就是钩子）
  traceEnd: 4,      // 圆闭合（pad 进）
  pullEnd: 6,       // 拉远结束 / 光带开始
  revealEnd: 7.95,  // 光带扫完
  lit: 8,           // Lumen 全亮，第一次呼吸
  gridGo: 14,       // 网格从中心延展
  split: 14.5,      // 一拍甩出起点，灯分身
  snap: 15,         // 三视图落格
  crt: 17.5,        // 三窗 CRT 压扁
  burst: 18,        // 汇成一点，字形噪声炸开
  lockW: 19, lock0: 19.25, lockDot: 19.5,
  freeze: 20,       // 定格，数字归零
  hit: 22,          // "3" 落定：全片最重一拍
  put1: 25, put2: 25.25, put3: 25.5, put4: 25.75,   // 收起 W / 3 / . / 0
  name: 26,         // 小灯展开 + 字标
  label: 26.5,      // "流明"
  glk1: 27, glk2: 28,
};
export const K = Object.fromEntries(Object.entries(KB).map(([k, b]) => [k, bt(b)]));

// 定格：画面里所有"动画时间"在 freeze..hit 之间停住
export const animT = t => (t < K.freeze ? t : t < K.hit ? K.freeze : t);

// ── 点阵累积的音符表（每个音符点亮一批点；拍子细分加速：四分→八分→十六分→三十二分）──
export const NDOTS = 720;
const LYD = [62, 64, 66, 68, 69, 71, 73];          // D 利底亚 D E F# G# A B C#
const deg = (k, base = 74) => { const o = Math.floor(k / 7); return base + 12 * o + (LYD[((k % 7) + 7) % 7] - 62); };
export function dotNotes() {
  const segs = [ // [起拍, 止拍, 步长, 乐器]
    [8, 10, 1, 'vibraphone'],
    [10, 12, 0.5, 'vibraphone'],
    [12, 13.5, 0.25, 'marimba'],
    [13.5, 14.5, 0.125, 'glockenspiel'],
  ];
  const beats = [];
  for (const [a, b, s, inst] of segs) for (let x = a; x < b - 1e-9; x += s) beats.push([Math.round(x * 1000) / 1000, inst, s]);
  const n = beats.length, out = [];
  // 加法旋律：音型逐步上行（每段多一个音级），同一调式 → 汇成一个和弦的 shimmer
  const shape = [0, 4, 1, 5, 2, 6, 3, 7, 4, 8, 5, 9];
  let prev = 0;
  beats.forEach(([b, inst, s], k) => {
    const cum = Math.round(NDOTS * 0.86 * Math.pow((k + 1) / n, 2.1));    // 累积到 86%，落格那一拍补满
    const add = Math.max(1, cum - prev); prev = Math.max(prev + 1, cum);
    const lift = Math.floor(k / 6);
    let m = deg(shape[k % shape.length] + lift - 2, inst === 'glockenspiel' ? 86 : inst === 'marimba' ? 74 : 74);
    if (inst === 'vibraphone') m = Math.min(m, 88);
    out.push({ b, t: bt(b), inst, midi: m, n: add, upto: Math.min(prev, NDOTS), div: s });
  });
  return out;
}
// 网格嘀嗒（十六分）
export const gridTicks = () => [0, 1, 2, 3].map(i => bt(KB.gridGo + i * 0.25));
// 三视图
export const VIEWS = [
  { id: 'desk', label: '桌面', x: -1392, y: -432, w: 1344, h: 864, r: 26 },
  { id: 'phone', label: '手机', x: 144, y: -432, w: 432, h: 864, r: 64 },
  { id: 'watch', label: '手表', x: 768, y: -192, w: 384, h: 432, r: 110 },
];
