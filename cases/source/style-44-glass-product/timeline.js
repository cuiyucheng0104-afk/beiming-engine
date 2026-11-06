// 棱光 PRISM · 唯一时间源：96 BPM，1 拍 = 0.625 s = 15 帧，1 小节 = 2.5 s。画面、配乐、拟音、核对脚本都读这里。
export const BPM = 96, BEAT = 60 / BPM, BAR = BEAT * 4, FPS = 24;
export const DUR = 19.75;
// 小节.拍（都从 1 起）→ 秒；beat 可为分数（三连音八分 = 1/3 拍）
export const at = (bar, beat = 1) => ((bar - 1) * 4 + (beat - 1)) * BEAT;

// 镜头：每个剪切都在拍点上
export const SHOTS = [
  ['contour', at(1), at(2)],      // S1 黑场扫光勾轮廓
  ['beam', at(2), at(3)],         // S2 白光射入 + 色散
  ['macro', at(3), at(4)],        // S3 微距焦点转移
  ['caustic', at(4), at(5)],      // S4 俯拍焦散
  ['lensA', at(5), at(5, 3)],     // S5a 透镜横移
  ['lensB', at(5, 3), at(6)],     // S5b 快推瓶盖切面
  ['explode', at(6), DUR],        // S6+S7 停 → 爆炸 → 合盖 → 名字（一个长镜头）
];
export const shotAt = t => SHOTS.find(s => t >= s[1] && t < s[2]) || SHOTS[SHOTS.length - 1];

export const T = {
  sweep1: [at(1), at(2)],                     // 0 → 2.5 灯条扫过，正中 1.25 = 轮廓到肩
  flare: at(1, 3),                              // 1.25 轮廓到肩，棱边彩虹闪
  beam: at(2),                                  // 2.5 光束射入
  rays: Array.from({ length: 7 }, (_, k) => at(2, 1 + k / 3)),   // 2.5 … 3.75 七色依次（三连音八分，正好 5 帧一格）
  focusLand: at(3, 2),                          // 5.625 焦点落到内部吸管
  macroSweep: at(3, 3),                         // 6.25 灯条扫过厚棱边（色散光谱在边上走）
  rings: [at(4, 1), at(4, 2), at(4, 3), at(4, 4)],               // 7.5 8.125 8.75 9.375 焦散环
  lensA: at(5), lensB: at(5, 3),                // 10.0, 11.25
  stop: at(6),                                  // 12.5 停
  apart: at(6, 2),                              // 13.125 部件分离
  hover: at(6, 4),                              // 14.375 悬浮 + 完全静音
  snap: at(7),                                  // 15.0 合盖「叮」
  title: at(7, 2),                              // 15.625 标题落定
  sub: at(7, 3),                                // 16.25 副标题落定 + 字面扫光
  last: at(8),                                  // 17.5 最后一声
};
T.snapIn = T.snap - 4 / FPS;                    // 合拢的极短缓入：4 帧（14.8333 → 15.0）
T.sweep2 = [T.sub - BEAT * .5, T.sub + BEAT * 1.5]; // 结尾灯条：中点 = 16.25

// 爆炸视图的部件（从下到上）：沿轴的位移、出发错开（秒）
export const PARTS = ['body', 'tube', 'collar', 'pump', 'sleeve', 'cap'];
export const PART_DELAY = PARTS.map((p, i) => i === 0 ? 0 : (i - 1) * 2 / FPS);   // 第一件落在 13.125 拍点上，其余每隔 2 帧依次出发

// 拟音 / 音乐提示事件（mix.py 与 cuecheck 读取；type 'vis' 是画面关键动作，带 beat 标签）
export const EV = [
  { t: T.sweep1[0], type: 'sweep', d: T.sweep1[1] - T.sweep1[0], pan: [-.85, .85], v: .55, vis: 'sweep1' },
  { t: T.flare, type: 'flare', v: .5, vis: 'flare' },
  { t: T.beam, type: 'beam', v: 1, vis: 'beam' },
  ...T.rays.map((t, k) => ({ t, type: 'ray', k, v: .55, pan: -.1 + k * .12, vis: 'ray' + k })),
  { t: at(3), type: 'cut', vis: 'cut_macro' },
  { t: at(3), type: 'rack', d: T.focusLand - at(3), v: .45 },
  { t: T.focusLand, type: 'focus', v: .4, vis: 'focusLand' },
  { t: T.macroSweep - BEAT, type: 'sweep', d: BEAT * 2, pan: [-.6, .6], v: .35, vis: 'macroSweep', mid: T.macroSweep },
  { t: at(4), type: 'cut', vis: 'cut_caustic' },
  ...T.rings.map((t, k) => ({ t, type: 'ring', k, v: .5, vis: 'ring' + k })),
  { t: T.lensA, type: 'slide', d: BEAT * 2, v: .45, pan: [-.6, .6], vis: 'cut_lensA' },
  { t: T.lensB, type: 'push', d: BEAT * 2, v: .5, vis: 'cut_lensB' },
  { t: T.lensB + BEAT, type: 'facet', v: .45 },
  { t: T.stop, type: 'stop', vis: 'cut_stop' },
  { t: T.apart, type: 'release', v: .8, vis: 'apart' },
  ...PARTS.slice(1).map((p, i) => ({ t: T.apart + i * 2 / FPS, type: 'puff', v: .3 + i * .03, pan: -.5 + i * .25 })),
  { t: T.apart, type: 'friction', d: T.hover - T.apart, v: .4 },
  { t: T.hover, type: 'revwhoosh', d: T.snap - T.hover, v: .85, vis: 'hover' },
  { t: T.snap, type: 'snap', v: 1, vis: 'snap' },
  { t: T.title, type: 'titlebell', v: .5, vis: 'title' },
  { t: T.sweep2[0], type: 'sweep', d: T.sweep2[1] - T.sweep2[0], pan: [-.7, .7], v: .4 },
  { t: T.sub, type: 'glint', v: .4, vis: 'sub' },
  { t: T.last, type: 'lastbell', v: .4, vis: 'last' },
];
