// 全片唯一时间源：120 BPM，4/4，拍长 0.5 s，小节 2 s，90 小节 = 180.000 s，30 fps。
// 上半部分（到 events() 为止）是 20 秒开头原样保留的时间表（T / events），一个数都不许改：开头 0–20 s 的画面与声音靠它逐帧不变。
// 下半部分（"全片"起）是 90 小节的章节表、翻页、灯光、相机衔接窗口和规范点名的关键时刻。
// 画面（main / stage / cover / shared / chapters）、混音（mix.py、music.py 经 events.json）、校验（tools/cuecheck.py）都读这里。
export const BPM = 120, BEAT = 60 / BPM, BAR = BEAT * 4, BARS = 90, DUR = BARS * BAR, FPS = 30;
export const KAITOU_BARS = 10, KAITOU_DUR = KAITOU_BARS * BAR;      // 开头 = 第 1–10 小节 = 0–20 s
export const E8 = BEAT / 2, E16 = BEAT / 4;
// 小节 n（1 起）第 k 拍（1 起）再加 s 个十六分音符
export const bt = (bar, beat = 1, s16 = 0) => (bar - 1) * BAR + (beat - 1) * BEAT + s16 * E16;
// 量化到整帧：画面落点与对应音效共用这个时间 → 音画 0 ms
export const fq = t => Math.round(t * FPS) / FPS;

export const T = {
  // —— 瑞士段（1–3 小节）——
  hLines: [0, 1, 2, 3, 4, 5, 6].map(i => fq(i * E16 / 2)),          // 7 条横线起笔（三十二分错开）
  vLines: Array.from({ length: 13 }, (_, i) => fq(bt(1, 2) + i * E8 / 12)),
  lineDur: E8,                                                        // 每条线线性画完 = 一个八分音符
  nums: [bt(1, 3), bt(1, 4), bt(2, 1), bt(2, 2), bt(2, 3), bt(2, 4)],  // 1960 25 477 8 9 12 落定
  reflow0: bt(3, 1), reflow: bt(3, 2), reflow25: fq(bt(3, 2, 1)),     // 收拢起 / 落位 / 25 晚一个十六分
  title: [bt(3, 3), bt(3, 3, 2), bt(3, 4)].map(fq),                   // 上美影 / IP / 全景
  // —— 揭晓（第 4 小节）——
  humIn: bt(3, 4),                                                    // 台灯嗡声提前进（J-cut）
  lamp: bt(4, 1),
  camSettle: fq(bt(4, 3, 2.4)),
  coverLift: bt(4, 4),                                                // 封面边缘抬起（预备）
  // —— 舞台（5–8 小节）——
  open: bt(5, 1),
  folds: [bt(5, 2), bt(5, 3), bt(5, 4)],                              // 远山 / 云幕 / 前景浪栏
  cards: [bt(6, 1), bt(6, 2), bt(6, 3)],                              // 孙悟空 / 黑猫警长 / 葫芦兄弟
  label: bt(7, 1),
  typing: Array.from({ length: 11 }, (_, i) => fq(bt(7, 1, 2) + i * E16)),
  silence: bt(8, 4),
  // —— 拉片（9–10 小节）——
  pull: bt(9, 1), pullEnd: bt(9, 2),
  clouds: [bt(9, 2), bt(9, 3), bt(9, 4)],
  part: fq(bt(9, 4, 1)), partEnd: bt(10, 1),                         // 三张角色卡向两侧让开一条通道（落在第一齿上）
  rise: bt(10, 1),
  riseTicks: Array.from({ length: 8 }, (_, i) => fq(bt(10, 1) + i * E8)),
  roll: bt(10, 4),
};

export const LABEL = '角色，是进入内容的入口';
export const NUMS = ['1960', '25', '477', '8', '9', '12'];
export const TITLE = ['上美影', 'IP', '全景'];

// 开头的声音事件表（原样；全片的 window.EV 由 allEvents() 汇总，开头这一份带 ch:'ch1' 标记交给 kaitou_mix.py）
export function events() {
  const E = [];
  const add = (t, type, o = {}) => E.push({ t: +t.toFixed(4), type, ...o });
  T.hLines.forEach((t, i) => add(t, 'rule', { i, dur: T.lineDur, dir: 'h' }));
  T.vLines.forEach((t, i) => add(t, 'rule', { i, dur: T.lineDur, dir: 'v' }));
  T.nums.forEach((t, i) => add(t, 'num', { i, text: NUMS[i], size: [3, 4, 2, 1, 1, 1][i], signal: i === 1 }));
  add(T.reflow0, 'slide', { dur: T.reflow - T.reflow0 });
  add(T.reflow, 'reflow');
  add(T.reflow25, 'reflow25');
  T.title.forEach((t, i) => add(t, 'title', { i }));
  add(T.humIn, 'hum_in');
  add(T.lamp, 'lamp');
  add(T.coverLift, 'cover_lift');
  add(T.open, 'open');
  T.folds.forEach((t, i) => add(t, 'fold', { i }));
  T.cards.forEach((t, i) => add(t, 'card', { i, note: ['E5', 'G5', 'A5'][i] }));
  add(T.label, 'label');
  T.typing.forEach((t, i) => add(t, 'type', { i, ch: LABEL[i] }));
  add(T.silence, 'silence', { until: T.pull });
  add(T.pull, 'pull', { dur: T.pullEnd - T.pull });
  T.clouds.forEach((t, i) => add(t, 'cloud', { i }));
  add(T.partEnd, 'part', { dur: T.partEnd - T.part });
  T.riseTicks.forEach((t, i) => add(t, 'tick', { i }));
  add(T.roll, 'roll');
  return E.sort((a, b) => a.t - b.t);
}

// ═══════════════════════════ 全片（第 1–90 小节） ═══════════════════════════
// 量化版 bt：bar 第 beat 拍再加 s16 个十六分音符，取最近的整帧。画面落点和它的音效都用这个值 → 音画 0 ms。
export const at = (bar, beat = 1, s16 = 0) => fq(bt(bar, beat, s16));
export const barOf = t => Math.floor(t / BAR + 1e-9) + 1;                       // t 所在小节（1 起）
export const beatOf = t => Math.floor((t % BAR) / BEAT + 1e-9) + 1;            // t 所在拍（1 起）

// —— 章节表（规范 §2 总小节表）——
// range = [起, 止) 秒，章节模块只在这个区间里控制相机；live = 该章 update() 被调用、该章图层可见的时间窗（可以比 range 宽，用来提前摆好、延后收尾）
// spreads = 该章用到的跨页（书页编号见 BOOK）；parts = 规范里的小段（小节区间，含两端）
const R = (b0, b1) => [bt(b0), bt(b1 + 1)];
export const CH = {
  ch1: { name: '开场', bars: [1, 10], range: R(1, 10), live: R(1, 10), spreads: [1], locked: true },
  ch2: { name: '角色叙事', bars: [11, 30], range: R(11, 30), live: [bt(11), bt(31) + 1], spreads: [1, 2, 3, 4],
    parts: { a: [11, 13], b: [14, 19], c: [20, 24], d: [25, 30] } },
  ch3: { name: '美术语言', bars: [31, 48], range: R(31, 48), live: [bt(31) - 1, bt(49) + 1], spreads: [5],
    parts: { intro: [31, 32], ink: [33, 36], mural: [37, 40], paper: [41, 44], puppet: [45, 48] } },
  ch4: { name: '新作品', bars: [49, 61], range: R(49, 61), live: [bt(49) - 1, bt(62) + 1], spreads: [6],
    parts: { tower: [49, 50], whale: [51, 52], windows: [53, 55], forest: [56, 58], ranbiwa: [59, 61] } },
  ch5: { name: '合作城', bars: [62, 73], range: R(62, 73), live: [bt(62) - 1, DUR], spreads: [7],      // 城市一直留到合书（第六、七章在城里）
    parts: { grow: [62, 63], fly: [64, 69], doors: [70, 73] } },
  ch67: { name: '洽谈与尾声', bars: [74, 90], range: R(74, 90), live: [bt(74) - 1, DUR], spreads: [7],
    parts: { steps: [74, 81], folder: [82, 84], tan: [85, 87], close: [88, 90] } },
};
export const CHAPTERS = ['ch2', 'ch3', 'ch4', 'ch5', 'ch67'];                   // 有模块文件的章节（ch1 = 开头工程，锁定）
export const partRange = (ch, p) => { const [a, b] = CH[ch].parts[p]; return [bt(a), bt(b + 1)]; };

// —— 书：每章翻一页（落定 = 该小节第 1 拍；落定前 0.75 s 预备抬起、0.45 s 主动作；"唰"声止于落定，落定一声纸拍）——
// page = 被翻起的书页（1 = 开头的地面页）；after = 翻完露出的跨页；flat = 翻页同时整摞书页摊平（第 62 小节）
export const BOOK = {
  open: T.open,                                                                   // 8.0 封面翻起（开头）
  turns: [
    { page: 1, after: 2, t: at(14), ch: 'ch2' },
    { page: 2, after: 3, t: at(20), ch: 'ch2' },
    { page: 3, after: 4, t: at(25), ch: 'ch2' },
    { page: 4, after: 5, t: at(31), ch: 'ch3' },
    { page: 5, after: 6, t: at(49), ch: 'ch4' },
    { page: 6, after: 7, t: at(62), ch: 'ch5', flat: true },
  ],
  close: at(89),                                                                  // 第 89 小节第 1 拍合书（"啪"）
  PRE: .75,                                                                       // 落定前 0.75 s 书页先微微抬起 4°（预备，同开头封面 7.5 s 的预备）
  SWING: .45,                                                                     // 翻页主动作 0.45 s：先慢后快，在落定那一帧拍到书页堆上，回弹 7° 再落定
  FLAT_ANGLE: 175.3,                                                              // 摊平角度：封面远边刚好落在桌面上（asin(PG/BD) ≈ 4.7°）
  FLAT_D: .75, CLOSE_D: .9,                                                       // 摊平 / 合书的动作时长（落定在拍上）：整摞（背板）0.75 s 向后摊平
  FLAT_SWING: .5,                                                                 // 摊平时第 6 页（地面页）晚 0.25 s 起翻：121.5–122.0（返修：留出 121.0–121.5 给第四章收折布景，对齐台灯转回）
};
export const SPREADS = 7;                                                         // 跨页 1（开头 + 2a）… 跨页 7（合作城）
// 跨页 n 从"翻进来"开始可见，到"翻出去"完成为止（秒）；共用层据此自动显隐跨页上的物件
export function spreadWindow(n) {
  const tin = n === 1 ? 0 : BOOK.turns.find(x => x.after === n).t - BOOK.PRE - 1 / FPS;   // 上一页开始预备抬起的前一帧
  const out = BOOK.turns.find(x => x.page === n);
  return [tin, out ? out.t + .7 : BOOK.close + 1];
}

// —— 相机衔接窗口：边界 b 处，[b − w0, b + w1] 由共用层做 Hermite 插值，两边章节的机位与速度都连续 ——
// 20 s 处 w0 = 0（开头锁定，原机位走到 20.000 s 为止）
export const CAM_BRIDGE = [
  { t: bt(11), from: 'ch1', to: 'ch2', w0: 0, w1: 1.0 },
  { t: bt(31), from: 'ch2', to: 'ch3', w0: .5, w1: .5 },
  { t: bt(49), from: 'ch3', to: 'ch4', w0: .5, w1: .5 },
  { t: bt(62), from: 'ch4', to: 'ch5', w0: .5, w1: .5 },
  { t: bt(74), from: 'ch5', to: 'ch67', w0: .5, w1: .5 },
];

// —— 规范点名的关键时刻（各章必须落在这些点上；模块里直接引用，别自己再算）——
export const KEY = {
  ch2: { stillStop: at(11), label: at(11, 2), turnB: at(14), turnC: at(20), turnD: at(25) },
  ch3: { turn: at(31), ink: at(33), mural: at(37), paper: at(41), puppet: at(45) },
  ch4: { turn: at(49), whale: at(51), windows: at(53), forest: at(56), silence: at(58, 4), peak: at(59) },
  ch5: { flat: at(62), fly: at(64), doors: at(70) },
  ch6: { steps: [at(74), at(76), at(78), at(80)], folder: at(82) },
  ch7: { tan: at(85), back: at(88), close: at(89), footer: at(90), end: DUR },
};
