// 时间线：唯一真值（镜头、字幕、灯、动作、音效卡点都从这里来）
export const DUR = 93.0;
export const T = {
  clap: .4, match: 1.0, lampOn: 1.25, titleIn: 2.2, titleSet: 3.4, titleOut: 7.4,
  // 白虎岭
  wkTurn: 10.9, wkBow: 11.3, wkCrouch: 12.6, wkLeap: 13.3, wkGone: 14.9,
  // 村姑
  cold1: 16.4, girlIn: 17.4, girlWalk: [18.1, 21.3], tsGreet: 20.4,
  // 悟空回来、火眼金睛、X 光、掏棒
  wkBack: 22.3, wkLand: 22.9, eye1: 23.45, xray1: 24.7, xray1Off: 26.5, ear1: 26.4, staffOut1: 26.9,
  // 第一打
  wind1: 27.6, hit1: 28.55,
  // 斥责
  tsStep: 31.0, wkKneel1: 31.9, wkRise1: 35.0, corpse1Off: 35.1,
  // 老妇
  cold2: 35.8, croneIn: 36.4, croneWalk: [37.0, 39.4], wail: [38.4, 40.2], eye2: 40.3, xray2: 40.5, dash2: 40.75, hit2: 41.3,
  // 紧箍咒
  spell: [42.8, 47.8], staffIn2: 42.7, roll: [44.0, 46.6], corpse2Off: 47.9, wkUp2: 48.1,
  // 老翁
  cold3: 48.6, elderIn: 49.2, elderWalk: [49.8, 52.4], staffOut3: 50.3, eye3: 53.1, xray3: 53.3,
  // 静场与第三打
  silence: 54.0, look: [54.25, 55.3], raise: [55.8, 57.2], dash3: 57.55, hit3: 58.1,
  // 白骨
  pile: 58.35, warm3: 59.2, wkPoint: [62.4, 64.4], staffIn3: 61.6,
  // 贬书
  letter: [65.6, 66.4], paperFall: [66.6, 67.9], tsTurn: 68.3,
  // 拜别
  wkKneel2: 71.3, bows: [72.4, 73.8, 75.2], wkRise2: 76.5, wkLook: 77.0, wkTurn2: 77.5, wkLeap2: 78.35, wkGone2: 79.4,
  tsBack: 79.8,
  // 幕后
  truck0: 80.6, cutBack: 81.6, truck1: 81.9, dive: [87.6, 88.35],
  // 片尾
  clap2: 88.5, endIn: 88.6, end: 93.0
};
// 字幕（起点；时长 = max(1.8, 字数 ÷ 4.5 + 1.5)，并截到下一句前 0.3 s）
export const SUB = [
  { t: 8.3, text: '唐僧师徒行至白虎岭，腹中饥饿。' },
  { t: 13.4, text: '悟空驾起筋斗云，化斋去了。' },
  { t: 17.9, text: '白骨精想吃唐僧肉，摇身变作村姑。' },
  { t: 23.2, text: '悟空赶回，火眼金睛一眼识破。' },
  { t: 31.2, text: '唐僧只见他打死了人，怒斥悟空行凶。' },
  { t: 36.6, text: '妖精又变作老妇人，哭寻女儿。' },
  { t: 42.9, text: '唐僧念起紧箍咒，悟空头痛打滚。' },
  { t: 49.0, text: '第三回，妖精变作白发老翁。' },
  { t: 53.4, text: '明知要受罚，悟空还是举起了棒。' },
  { t: 60.3, text: '妖精现了原形——原来是一堆白骨。' },
  { t: 65.4, text: '唐僧不信，写下贬书，赶走悟空。' },
  { t: 71.8, text: '悟空含泪拜别师父，回了花果山。' },
  { t: 82.6, text: '台前看是人，幕后原是骨。' }
];
const hanzi = s => (s.match(/[一-鿿]/g) || []).length;
export const SUBS = SUB.map((s, i) => {
  let t1 = s.t + Math.max(1.8, hanzi(s.text) / 4.5 + 1.5);
  const nx = SUB[i + 1]; if (nx) t1 = Math.min(t1, nx.t - .3); else t1 = Math.min(t1, T.dive[0] - .1);
  return { t0: s.t, t1: +t1.toFixed(2), text: s.text };
});
// 镜头表：[t0, t1, name]
export const SHOTS = [
  [0, 7.8, 'house'], [7.8, 13.2, 'ridge'], [13.2, 16.4, 'cloud'], [16.4, 22.0, 'girl'], [22.0, 23.35, 'land'], [23.35, 24.6, 'eye'],
  [24.6, 27.55, 'xray'], [27.55, 31.0, 'strike1'], [31.0, 35.8, 'scold'], [35.8, 42.6, 'crone'], [42.6, 48.6, 'spell'],
  [48.6, 53.0, 'elder'], [53.0, 58.05, 'choice'], [58.05, 60.0, 'kill'], [60.0, 65.0, 'bones'], [65.0, 71.2, 'expel'],
  [71.2, 80.6, 'farewell'], [80.6, 81.9, 'truck'], [81.9, 88.35, 'back'], [88.35, 93.0, 'end']
];
export const shotAt = t => SHOTS.find(s => t >= s[0] && t < s[1]) || SHOTS[SHOTS.length - 1];
