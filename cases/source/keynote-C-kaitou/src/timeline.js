// 唯一时间源：120 BPM，4/4，拍长 0.5 s，小节 2 s，10 小节 = 20.000 s，30 fps。
// 画面（main/stage/cover）、混音（mix.py 经 events.json）、校验（tools/cuecheck.py）都读这里。
export const BPM = 120, BEAT = 60 / BPM, BAR = BEAT * 4, BARS = 10, DUR = BARS * BAR, FPS = 30;
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

// 声音事件表（window.EV → events.json → mix.py / cuecheck）
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
