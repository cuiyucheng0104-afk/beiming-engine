// 节奏猜动物 · 唯一时间源。画面 (index.html)、配乐与拟音 (mix.py)、拍点核对 (tools/cuecheck.py) 都读这里。
// 120 BPM：一拍 = 0.5 s = 24 fps 下 12 帧，十六分 = 3 帧，所有拍点都落在整帧上。
export const BPM = 120, BEAT = 60 / BPM, BAR = 4 * BEAT, FPS = 24;
export const DUR = 19.75;
export const bt = (beats) => beats * BEAT;              // 拍号 → 秒
export const at = (bar, beat = 0) => (bar * 4 + beat) * BEAT;

// 场景（硬切都在小节线上）
export const SCENES = [
  { id: 'card', t0: 0, t1: at(2) },      // 0–4 回合卡
  { id: 'play', t0: at(2), t1: at(5) },  // 4–10 问答
  { id: 'next', t0: at(5), t1: at(8) },  // 10–16 下一关 / 最难一题 / 完美
  { id: 'report', t0: at(8), t1: DUR },  // 16–19.75 成绩单
];
export const CUTS = [at(2), at(5), at(8)];

// 问答：[提示拍, 应答拍, 动物]。四分 → 八分 = 加速
export const QA = [
  [8, 9, 'cat'], [10, 11, 'dog'], [12, 13, 'dog'], [14, 15, 'cat'],
  [16, 16.5, 'cat'], [17, 17.5, 'dog'], [18, 18.5, 'cat'], [19, 19.5, 'dog'],
];

// 关键时刻（拍号）
export const K = {
  cardLand: 1, roundGlyphs: [1, 1.25, 1.5, 1.75], titleGlyphs: [2, 2.5, 3],
  hostDrop: 5, clap: [6, 7], cardShrink: 7,
  nextLetters: [0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => 20 + i * 0.25),   // NEXT LEVEL 九个字母，十六分，20.0–22.0
  hardSticker: 22, rattle: [21, 22, 23, 23.5],
  unlock: 24, sweat: 25, snapIn: 25, shout: [26, 26.5, 27], snapOut: 26,
  fill: [27.5, 27.75], collapse: 27.5, perfect: 28, celebrate: [29, 30, 31],
  report: 32, rows: [[[32.5], 33], [[33.5], 34], [[34.25, 34.5, 34.75], 35]],   // [[逐字打字拍], 打钩拍]
  reportFill: 35.5, grade: 36, yay: 37, button: 38,
};

export const SILENCE = [at(6, 0.5), at(6, 2)];   // 12.25–13.0 近静默

// 每小节的编曲状态与和弦（mix.py 读）
export const ARR = [
  { bar: 0, mode: 'jingle', chord: ['F'] },
  { bar: 1, mode: 'groove', chord: ['Bb'] },
  { bar: 2, mode: 'groove', chord: ['F'] },
  { bar: 3, mode: 'groove', chord: ['Bb'] },
  { bar: 4, mode: 'groove8', chord: ['Gm7', 'Gm7', 'C7', 'C7'] },
  { bar: 5, mode: 'tease', chord: ['Dm', 'Dm', 'Bb', 'C'] },
  { bar: 6, mode: 'silence', chord: [] },
  { bar: 7, mode: 'finale', chord: ['G'] },
  { bar: 8, mode: 'report', chord: ['C'] },
  { bar: 9, mode: 'end', chord: ['G'] },
];

// 文字（id → 内容），画面和 readcheck 共用
export const TXT = {
  round: '第1回合', title: '猜动物', banner1: '第1回合 · 猜动物',
  cat: '猫！', dog: '狗！', next: 'NEXT LEVEL', hard: '最难一题！', platy: '鸭嘴兽！',
  perfect: '完美！', report: '成绩单', rows: ['猫', '狗', '鸭嘴兽'], score: '3/3', full: '满分',
};

// 声音/画面事件：每个可见动作 = 一个事件（t 秒）
export function events() {
  const E = [], ev = (beat, type, o = {}) => E.push({ t: +bt(beat).toFixed(6), beat, type, ...o });
  // —— 回合卡
  ev(0, 'whoosh', { g: .7 });
  ev(K.cardLand, 'land', { big: 1 });
  K.roundGlyphs.forEach((b, i) => ev(b, 'pip', { m: [77, 79, 81, 84][i] }));
  K.titleGlyphs.forEach((b, i) => ev(b, 'stamp', { m: [69, 72, 77][i] }));
  ev(K.hostDrop - 0.5, 'whoosh', { g: .4 });
  ev(K.hostDrop, 'land', {});
  K.clap.forEach(b => ev(b, 'clap', {}));
  ev(K.cardShrink, 'whoosh', { g: .5 });
  // —— 硬切白闪
  [8, 20, 32].forEach(b => ev(b, 'flash', {}));
  // —— 问答
  QA.forEach(([c, r, a], i) => { ev(c, 'call', { a, i }); ev(r, 'resp', { a, i }); ev(r, 'star', { i }); });
  // —— 下一关
  K.nextLetters.forEach((b, i) => ev(b, 'pip', { m: [72, 74, 76, 77, 79, 81, 83, 84, 86][i] }));
  ev(K.hardSticker, 'stamp', { m: 84 });
  K.rattle.forEach((b, i) => ev(b, 'rattle', { i }));
  ev(K.unlock, 'lock', {}); ev(K.unlock, 'lid', {}); ev(K.unlock, 'servo', {});
  ev(K.sweat, 'sweat', {});
  ev(K.shout[0], 'shout', { word: 'platypus' });
  ev(K.shout[0], 'reveal', {});
  K.fill.forEach(b => ev(b, 'fillhit', {}));
  ev(K.collapse, 'squish', {});   // 礼盒压扁，鸭嘴兽坐着它落到地面，落地 = 判词
  ev(K.perfect, 'judge', {}); ev(K.perfect, 'confetti', {});
  K.celebrate.forEach(b => ev(b, 'land', { soft: 1 }));
  // —— 成绩单
  ev(K.report, 'land', { big: 1 });
  K.rows.forEach(([ty, ck], i) => {
    ty.forEach(b => ev(b, 'type', {}));   // 每个字一个十六分
    ev(ck, 'check', { i });
  });
  ev(K.grade, 'grade', {});
  ev(K.yay, 'yay', {});
  ev(K.button, 'button', {});
  return E.sort((a, b) => a.t - b.t);
}
