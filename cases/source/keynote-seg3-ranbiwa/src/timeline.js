// 唯一时间源：96 BPM，拍长 0.625 s，56 拍 = 35.000 s。画面、混音、校验都读这里（经 events.mjs 导出为 events.json）。
export const BPM = 96, BEAT = 60 / BPM, BEATS = 56, DUR = BEATS * BEAT, FPS = 30;
export const b = n => n * BEAT;

// 画面事件（拍号）
export const K = {
  snuff: 2,                 // 布幕灯熄
  L1: 4, L2: 5, L3: 6, L4: 7, // 远山 / 月 / 祥云 / 前景水浪
  whale: 8,                 // 鲸鱼窗显影
  whaleTitle: [9, 9.5, 10, 10.5],   // 中 国 奇 谭
  win: [12, 13, 14, 15],    // 四个小窗（右→左）
  slip9: 16,                // 9 部｜12 位导演｜2026.1.1
  forest: 17,               // 森林层
  llsTitle: 18,             // 浪浪山小妖怪
  llsSlip: 19,              // 2025.8.2
  llsWin: 20,               // 浪浪山窗
  black: 24,                // 全黑全静
  burst: 25,                // 燃比娃爆亮
  rbwTitle: [26, 26.5, 27], // 燃 比 娃
  rbwSlip: 27,
  pulse: [29, 33],          // 火光脉动
  lamp: 36,                 // 台灯亮，拉远开始
  relight: 38,              // 右页旧灯箱微亮
  theme: 40,                // 古琴主题起
  leafStart: 42, leafLand: 44,
  doors: [45, 46, 47],      // 三道门（后→前）
  cadence: 48,              // 主音落定
  harm: 52,                 // 泛音
};
export const T = Object.fromEntries(Object.entries(K).map(([k, v]) => [k, Array.isArray(v) ? v.map(b) : b(v)]));

// 镜头在手卷世界里的横向位置（世界 px，向左为负）。b4 起约 256 px/s。
export const CAM_KEYS = [[-2, 300], [0, 0], [2.5, -560], [5, -1200], [6.25, -1530], [7.5, -1850], [9.375, -2330], [10, -2490],
  [11.25, -2810], [12.5, -3130], [13.75, -3450], [15, -3770]];
export const CAM_C = -5470;      // 燃比娃灯箱中心：黑拍里镜头移到这里
export const DRIFT = 4;          // A12 的微漂移 px/s

// 声音事件表（给 mix.py 与 cuecheck）：每个画面事件 → 一条或多条声音
export function events() {
  const E = [];
  const add = (t, type, o = {}) => E.push({ t: +t.toFixed(4), type, ...o });
  add(0, 'start');
  add(T.snuff, 'snuff');
  add(T.L1, 'layer', { n: 0, note: 'A4' }); add(T.L1, 'pulse_on');
  add(T.L2, 'layer', { n: 1, note: 'D5' });
  add(T.L3, 'layer', { n: 2, note: 'F#5' });
  add(T.L4, 'layer', { n: 3, note: 'A5' });
  add(T.whale, 'window_big', { notes: ['D5', 'D6'] });
  T.whaleTitle.forEach((t, i) => add(t, 'glyph', { i, note: ['A6', 'F#6', 'E6', 'D6'][i] }));
  T.win.forEach((t, i) => add(t, 'window_small', { i, note: ['D5', 'E5', 'F#5', 'A5'][i] }));
  add(T.slip9, 'slip', { accent: true });
  add(T.forest, 'forest', { note: 'B4' });
  add(T.llsTitle, 'glyph_title', { notes: ['D6', 'A5'] });
  add(T.llsSlip, 'slip');
  add(T.llsWin, 'window_big', { notes: ['B4', 'D5'] });
  add(b(20), 'pulse_8th'); add(b(22), 'pulse_16th');
  add(T.black, 'silence', { until: T.burst });
  add(T.burst, 'burst');
  T.rbwTitle.forEach((t, i) => add(t, 'gong_dot', { i }));
  add(T.rbwSlip, 'slip');
  T.pulse.forEach((t, i) => add(t, 'fire_pulse', { i }));
  add(T.lamp, 'lamp_on');
  add(T.relight, 'relight');
  add(T.leafStart, 'leaf_start'); add(T.leafLand, 'leaf_land');
  T.doors.forEach((t, i) => add(t, 'door', { i }));
  add(T.cadence, 'cadence');
  add(T.harm, 'harmonic');
  return E.sort((a, b) => a.t - b.t);
}
