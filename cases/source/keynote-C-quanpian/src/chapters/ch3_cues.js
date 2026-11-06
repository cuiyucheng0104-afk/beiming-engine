// 第三章时间表（纯数据，不依赖浏览器）：ch3.js 用它摆画面，scratch 里的生成脚本用它写 sfx/ch3.json。
// 落点一律 at()（量化到整帧），音画 0 ms。规范点名的四个档位直接用 KEY.ch3.*。
import { at, KEY } from '../timeline.js';
import { TEXT } from '../shared/texts.js';
const LEN = s => [...s].length, F3 = TEXT.ch3;

const typeTimes = (bar, beat, n, s0 = 1) => Array.from({ length: n }, (_, i) => at(bar, beat, s0 + i));   // 每个十六分音符一个字

export const MATS = ['blank', 'ink', 'mural', 'paper', 'puppet'];
// 四次拉片：预备（拉头往回顶）→ 开拉 → 落档（= 翻板开始）
export const PULLS = [
  { nudge: at(32, 3), pull: at(32, 4), notch: KEY.ch3.ink },
  { nudge: at(36, 3), pull: at(36, 4), notch: KEY.ch3.mural },
  { nudge: at(40, 3), pull: at(40, 4), notch: KEY.ch3.paper },
  { nudge: at(44, 3), pull: at(44, 4), notch: KEY.ch3.puppet },
];
export const C = {
  rail: at(31, 2),
  title: [0, 1, 2, 3].map(i => at(31, 3, i)),          // 美术语言（每个十六分一个字）
  sq: at(31, 4),                                        // 句首朱红方块
  ink: {
    title: [at(33, 2), at(33, 2, 1)], seal: at(33, 3), far: at(33, 4), near: at(35, 3),
    cards: [
      { key: 'p04_kedou', film: 0, up: at(34, 1), lab: at(34, 2), types: typeTimes(34, 2, LEN(F3.ink.films[0])) },
      { key: 'p10_mudi', film: 1, up: at(35, 1), lab: at(35, 2), types: typeTimes(35, 2, LEN(F3.ink.films[1])) },
    ],
  },
  mural: {
    title: [at(37, 2), at(37, 2, 1)], sub: typeTimes(37, 3, LEN(F3.mural.sub), 0), vine: at(37, 4), vineDur: 2.5,
    clouds: [at(39, 3), at(39, 4), at(40, 1), at(40, 2)],
    cards: [
      { key: 'p09_jiuselu', film: 0, up: at(38, 1), lab: at(38, 1, 2), types: typeTimes(38, 1, LEN(F3.mural.films[0]), 3) },
      { key: 'p09_tianshu', film: 1, up: at(38, 3), lab: at(38, 4), types: typeTimes(38, 4, LEN(F3.mural.films[1])) },
    ],
  },
  paper: {
    title: [at(41, 2), at(41, 2, 1)],
    cuts: Array.from({ length: 8 }, (_, k) => at(41, 3, 2 * k)),          // 81.0 起每个八分音符一刀
    corners: [at(43, 3), at(43, 3, 2), at(43, 4), at(43, 4, 2)],
    cards: [{ key: 'p11_hailuo', film: 0, up: at(42, 3), lab: at(42, 4), types: typeTimes(42, 4, LEN(F3.paper.films[0])), stand: true }],
  },
  puppet: {
    title: [at(45, 2), at(45, 2, 1)], stage: at(45, 3), dim: at(45, 4), spot: at(46, 1), open: at(46, 1), openEnd: at(46, 2, 2),
    restore: at(48, 3),
    cards: [{ key: 'p11_afanti_puppet', film: 0, up: at(45, 3), lab: at(46, 2, 2), types: typeTimes(46, 2, LEN(F3.puppet.films[0]), 3), stand: true, silent: true }],
  },
};
export const FLIP = { D: .3, STEP: .035, N: 12 };       // 每片翻 0.3 s，相邻片晚 35 ms，12 片 → 0.685 s
export const SINK = 10 / 30;                             // 卡片沉回切口（拉片开始 → 10 帧）

// —— 本章全部对外事件（画面落点）+ 每个事件的音效（生成 sfx/ch3.json 用）——
// snd 里的条目原样写进 sfx 清单（"ev" 引用这个 id）；pan 按画面左右给一点
const CARD_X = { p04_kedou: -.085, p10_mudi: .115, p09_jiuselu: -.12, p09_tianshu: .085, p11_hailuo: .105, p11_afanti_puppet: 0 };
const PITCH = [1.0, 1.12, 1.26, 1.5, 1.68];
export function EVENTS() {
  const E = [], add = (t, id, type, snd = []) => E.push({ t, id: 'ch3.' + id, type, snd });
  add(C.rail, 'rail', 'pop', [{ type: 'pop', pitch: .9, gain: -1 }]);
  C.title.forEach((t, i) => add(t, `title.${i}`, 'press', [{ type: 'press', size: 2, gain: -2 + i * .5 }]));
  add(C.sq, 'sq', 'tick', [{ type: 'tick', pitch: 1.4, gain: -3 }]);
  const mats = ['ink', 'mural', 'paper', 'puppet'];
  PULLS.forEach((p, k) => {
    add(p.nudge, `nudge.${k}`, 'nudge', [{ type: 'tick', pitch: .7, gain: -8, pan: .3 }]);
    add(p.pull, `pull.${k}`, 'pull', [{ type: 'rasp', dur: p.notch - p.pull, gain: -2, pan: .25 }]);
    add(p.notch, `notch.${mats[k]}`, 'notch', [{ type: 'detent', pitch: 1 + k * .1, pan: .3 }, { type: 'cascade', n: FLIP.N, dur: +((FLIP.N - 1) * FLIP.STEP + FLIP.D * .55).toFixed(3), pitch: 1 + k * .06, gain: -5 }]);
    if (k > 0) add(p.pull + SINK, `sink.${k}`, 'sink', [{ type: 'slide', dur: SINK, gain: -5 }]);
  });
  const cardEv = (m, c, i) => {
    if (!c.silent) add(c.up, `card.${c.key}`, 'card_up', [{ type: 'pop', pitch: PITCH[(i + (m === 'mural' ? 2 : m === 'paper' ? 1 : m === 'puppet' ? 3 : 0)) % 5], pan: CARD_X[c.key] * 3 }]);
    add(c.lab, `lab.${c.key}`, 'label', [{ type: 'paper_tap', k: 1, gain: -3, pan: CARD_X[c.key] * 3 }]);
    c.types.forEach((t, j) => add(t, `type.${c.key}.${j}`, 'type', [{ type: 'type', i: j, gain: -3, pan: CARD_X[c.key] * 3 }]));
  };
  // 水墨
  C.ink.title.forEach((t, i) => add(t, `ink.title.${i}`, 'press', [{ type: 'press', size: 3 - i }]));
  add(C.ink.seal, 'ink.seal', 'stamp', [{ type: 'stamp', pitch: 1.0 }]);
  add(C.ink.far, 'ink.far', 'ink_drop', [{ type: 'brush', dur: .9, gain: 1 }]);
  add(C.ink.near, 'ink.near', 'ink_drop', [{ type: 'brush', dur: .7, gain: 2, pan: .3 }]);
  C.ink.cards.forEach((c, i) => cardEv('ink', c, i));
  // 壁画
  C.mural.title.forEach((t, i) => add(t, `mural.title.${i}`, 'press', [{ type: 'press', size: 3 - i }]));
  C.mural.sub.forEach((t, i) => add(t, `mural.sub.${i}`, 'type', [{ type: 'type', i, gain: -2 }]));
  add(C.mural.vine, 'mural.vine', 'grow', [{ type: 'sand', dur: C.mural.vineDur, gain: 1, pan: -.4 }]);
  C.mural.clouds.forEach((t, i) => add(t, `mural.cloud.${i}`, 'grow', [{ type: 'sand', dur: .45, gain: 0, pan: [-.1, .3, .6, -.5][i] }]));
  C.mural.cards.forEach((c, i) => cardEv('mural', c, i));
  // 剪纸
  C.paper.title.forEach((t, i) => add(t, `paper.title.${i}`, 'cut', [{ type: 'scissors', v: .9, pan: .2 }]));
  C.paper.cuts.forEach((t, i) => add(t, `paper.cut.${i}`, 'cut', [{ type: 'scissors', v: 1 - .03 * (i % 2), pan: -.3 }]));
  C.paper.corners.forEach((t, i) => add(t, `paper.corner.${i}`, 'cut', [{ type: 'scissors', v: .85, pan: [-.7, .7, -.7, .7][i] }]));
  C.paper.cards.forEach((c, i) => cardEv('paper', c, i));
  // 木偶
  C.puppet.title.forEach((t, i) => add(t, `puppet.title.${i}`, 'felt', [{ type: 'felt', v: .6, pan: -.5 }]));
  add(C.puppet.stage, 'puppet.stage', 'stage_up', [{ type: 'pop', pitch: .85 }, { type: 'felt', v: .8 }]);
  add(C.puppet.spot, 'puppet.spot', 'spot', [{ type: 'spot', v: 1 }, { type: 'felt', v: 1, gain: -2 }]);
  add(C.puppet.openEnd, 'puppet.open', 'curtain', [{ type: 'slide', dur: C.puppet.openEnd - C.puppet.open, gain: -6 }]);
  C.puppet.cards.forEach((c, i) => cardEv('puppet', c, i));
  return E.sort((a, b) => a.t - b.t);
}
