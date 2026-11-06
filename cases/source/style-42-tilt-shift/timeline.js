// 港口一日 · 唯一时间源
// 144 BPM（每拍正好 10 帧）→ 磁带刹停 → 静默 → 72 BPM（每拍 20 帧）。所有剪切、动作落定、灯亮、音符都从这里取时间。
import { clamp, seg, ss } from '/core/lib.js';

export const FPS = 24;
export const fr = n => n / FPS;                 // 帧 → 秒
export const BEAT_A = fr(10), BAR_A = fr(40);    // 144 BPM
export const BEAT_C = fr(20);                    // 72 BPM
export const DUR = fr(474);                      // 19.75 s

// 拍点网格：[名称, 帧]。A 段 16 拍（144），B 段 4 拍（144），S 段半拍，C/D 段 72 拍
export const GRID = [];
for (let b = 0; b < 20; b++) GRID.push(['A' + b, b * 10]);              // 0..190
for (let b = 0; b <= 12; b++) GRID.push(['C' + b, 220 + b * 20]);       // 220..460
export const gridT = name => fr(GRID.find(g => g[0] === name)[1]);

export const T = {
  cut2: fr(80), cut3: fr(160),      // 剪切：S1→S2（第 3 小节下拍）、S2→S3（第 5 小节下拍 = 速度骤降开始）
  pointer: fr(140),                 // 焦带滑向港口入口（第 4 小节第 3 拍）
  engineIn: fr(150),                // J-cut：拖船引擎声提前进入
  real: fr(170),                    // ×1 到达（B 段第 2 拍）
  stop: fr(200),                    // 拖船停住、静默开始
  horn: fr(220),                    // 汽笛（全片最重要的声音）
  rise: fr(240),                    // 镜头开始升起
  cloud1: fr(260), cloud2: fr(300), // 云影前沿扫过集装箱船、扫过堆场
  cut4: fr(340),                    // 剪切到黄昏长曝光
  lamps: fr(360), boom: fr(380), sign: fr(400), windows: fr(420), lighthouse: fr(440), final: fr(460),
};

export const SHOTS = [
  { id: 'S1', t0: 0, t1: T.cut2, name: 'slide' },
  { id: 'S2', t0: T.cut2, t1: T.cut3, name: 'top' },
  { id: 'S3', t0: T.cut3, t1: T.cut4, name: 'tug' },
  { id: 'S4', t0: T.cut4, t1: DUR, name: 'night' },
];
export const shotAt = t => SHOTS.find(s => t < s.t1) || SHOTS[SHOTS.length - 1];

// —— 延时倍率曲线（时间窗口：白天一窗、黄昏一窗；窗口之间是剪切处的时间跳跃）——
export const RISE_MAX = 600, NIGHT_RATE = 2400;
const dayRate = t => {
  if (t < T.cut3) return 40;
  if (t < T.real) return 1 + 39 * (1 - ss(seg(t, T.cut3, T.real)));           // ×40 → ×1，一拍内
  if (t < T.horn + .25) return 1;
  return Math.exp(Math.log(RISE_MAX) * Math.pow(seg(t, T.horn + .25, T.cut4), 1.7));   // 汽笛后重新加速
};
export const WINDOWS = [
  { name: 'day', t0: 0, t1: T.cut4, clock0: 9 * 3600 + 12 * 60, rate: dayRate },
  { name: 'dusk', t0: T.cut4, t1: DUR + .5, clock0: 18 * 3600 + 18 * 60, rate: () => NIGHT_RATE },
];
for (const W of WINDOWS) {   // 1 ms 预积分（确定性）
  const n = Math.ceil((W.t1 - W.t0) * 1000) + 2, tab = new Float64Array(n); let acc = 0;
  for (let i = 0; i < n; i++) { tab[i] = acc; const t = W.t0 + i / 1000; acc += (W.rate(t) + W.rate(t + .001)) / 2 / 1000; }
  W.tab = tab;
}
export const windowAt = t => WINDOWS.find(w => t < w.t1) || WINDOWS[WINDOWS.length - 1];
// 世界时间（秒，自窗口起点）
export function simAt(t, W = windowAt(t)) {
  const f = clamp((t - W.t0) * 1000, 0, W.tab.length - 1), i = Math.floor(f), u = f - i;
  const a = W.tab[i], b = W.tab[Math.min(i + 1, W.tab.length - 1)];
  return a + (b - a) * u;
}
export const clockAt = (t, W = windowAt(t)) => W.clock0 + simAt(t, W);
export const rateAt = t => windowAt(t).rate(t);

// —— 延时跳帧：倍率 ≥6 时世界每 5 帧（144 的八分音符）更新一次；2–6 倍每 2 帧；<2 倍丝滑。相机永远逐帧平滑 ——
// 以帧号为锚，跳点永远落在 0,5,10… 帧上，而拍点是 10 帧的倍数，所以每个拍点都是一个跳点
export function stepT(t) {
  const r = rateAt(t), f = Math.round(t * FPS * 1000) / 1000;
  const n = r >= 6 ? 5 : r >= 2 ? 2 : 0;
  if (!n) return t;
  return Math.floor(f / n + 1e-6) * n / FPS;
}

// —— 岸桥节奏：×40 时每拍一台吊车落箱（三台轮流），一个循环 = 3 拍 ——
export const CYCLE = 40 * BEAT_A * 3;   // 50 s 世界时间
export const SLOT = 40 * BEAT_A;        // 卡车每 16.67 s 前进一个车位

export const fmtClock = c => { const s = Math.floor(c) % 86400, h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'); };
