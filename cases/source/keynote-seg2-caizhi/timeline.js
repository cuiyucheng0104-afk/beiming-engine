// 片段二「材料变奏」唯一时间源：速度、拍网格、镜头速度曲线、画面事件与声音事件。
// 页面（src/*.js）、mix.py（经 events.json）、检查脚本都从这里取数。
export const BPM = 72;
export const BEAT = 60 / BPM;            // 0.8333 s
export const NBEATS = 48;
export const DUR = NBEATS * BEAT;         // 40.000 s
export const FPS = 30;
export const b = n => n * BEAT;           // 拍 → 秒

// 段落（总导演分配 16 / 11 / 11 / 10 拍）
export const SECS = [
  { id: 'A7', name: '水墨', b0: 0, b1: 16 },
  { id: 'A8', name: '壁画', b0: 16, b1: 27 },
  { id: 'A9', name: '纸', b0: 27, b1: 38 },
  { id: 'A10', name: '偶', b0: 38, b1: 48 },
];

// 镜头速度（px/s，向左）。分段常速 + 平滑过渡（smoothstep），数值积分得到位置。
const VKEYS = [
  [0, 115], [12.5, 115], [15.8, 230], [21.5, 230], [23.6, 140], [30.8, 140], [32.5, 115], [DUR + 2, 115],
];
const sstep = u => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
export function vel(t) {
  for (let i = 0; i < VKEYS.length - 1; i++) {
    const [t0, v0] = VKEYS[i], [t1, v1] = VKEYS[i + 1];
    if (t <= t1) return v0 + (v1 - v0) * sstep((t - t0) / (t1 - t0));
  }
  return VKEYS[VKEYS.length - 1][1];
}
// camX(t) = 视口左边缘的世界 x（camX(0)=0，向左平移 → 递减）。查表积分，确定性。
const DT = 1 / 1200, NT = Math.ceil((DUR + 1) / DT) + 2, CAM = new Float64Array(NT);
for (let i = 1; i < NT; i++) { const t = (i - .5) * DT; CAM[i] = CAM[i - 1] - vel(t) * DT; }
export function camX(t) {
  const x = t / DT; if (x <= 0) return -vel(0) * t;
  const i = Math.min(NT - 2, Math.floor(x)), f = x - i; return CAM[i] + (CAM[i + 1] - CAM[i]) * f;
}
// 由"在时刻 t 出现在屏幕 x"反推世界 x
export const W = (t, sx) => sx + camX(t);

// ---------------- 布局（世界坐标；y 与屏幕 y 相同） ----------------
export const L = {
  ripple: { x: W(0, 700), y: 430 },
  // 小蝌蚪找妈妈：横披，画芯 1040×585（原图 2232×1256，等比）
  xkd: { cx: W(6.5, 1150), cy: 468, w: 1040, h: 1040 * 1256 / 2232, border: 26 },
  shuimo: { x: W(6.5, 440), y: 196, size: 118 },          // 竖排「水墨」
  shuimoNote: { x: W(6.5, 352), y: 214, size: 30 },       // 小字
  // 牧笛：立轴，画芯高 590（原图 1480×2200）
  mudi: { cx: W(11, 515), top: 92, h: 590, w: 590 * 1480 / 2200 },
  // 壁画边界：纸 → 土，世界 x 区间（右侧为纸）
  mural: { xPaper: W(13.333, 980), xEarth: W(13.333, 60), soak: [15.2, 18.0] },
  bihua: { x: W(14.5, 585), y: 190, size: 118 },          // 竖排「壁画」
  bihuaNote: { x: W(14.5, 672), y: 208, size: 30 },
  // 九色鹿：画芯高 580（原图 1536×2200）；卷草纹带宽 64
  jsl: { cx: W(16.667, 610), cy: 512, h: 580, w: 580 * 1536 / 2200, band: 64 },
  // 天书奇谭：画芯 1000×563；云纹带宽 56
  tsq: { cx: W(20.0, 470), cy: 512, w: 1000, h: 1000 * 1256 / 2232, band: 56 },
  // 肖形印（团花）→ 红纸
  xseal: { x: W(22.5, 250), y: 560, size: 118 },
  sheet: { x0: W(23.333, -3400), x1: W(23.333, 2300), y0: -70, y1: 1150 },
  // 窗花：窗洞中心；金色的海螺画芯高 590（原图 1504×2200）
  win: { cx: W(23.333, 360), cy: 520, h: 590, w: 590 * 1504 / 2200 },
  zhi: { x: W(29.167, 400), y: 250, size: 130 },           // 竖排「纸」（墨书于红纸）
  // 油灯与布幕；阿凡提的故事 画芯 1000×563
  lamp: { x: W(31.667, 640), y: 400 },
  aft: { cx: W(35.0, 740), cy: 500, w: 1000, h: 1000 * 1256 / 2232 },
  ou: { x: W(35.833, 1500), y: 230, size: 124 },           // 竖排「偶」
  ouNote: { x: W(35.833, 1415), y: 246, size: 30 },
};

// ---------------- 画面事件（拍） ----------------
// 每个事件在 cuecheck 里与声音起音点逐一比对。
export const CUE = {
  drop: 0,                 // 水滴落纸
  flute1: 2,               // 一声笛（无画面事件）
  seal1960: 4,             // 朱印落下
  xkdMount: [4, 5.5],      // 横披装裱晕出
  xkdBloom: [4, 10],       // 小蝌蚪显影
  shui: [6, 6.62], mo: [7, 7.62], shuimoNote: 7.5,
  xkdLabel: 10.5,
  mudiUnroll: [10, 11],    // 立轴展开，b11 轴头落定
  mudiBloom: [11, 15],
  mudiLabel: 15.5,
  beatBack: 16,
  bi: [16.5, 17.1], hua: [17.1, 17.7], bihuaNote: 17.5,
  jslGrow: [17, 18, 19], jslColor: [17.5, 18.5, 19.5],
  jslBloom: [20, 21.5], jslLabel: 21.5,
  tsqGrow: [22, 23], tsqColor: [22.5, 23.5],
  tsqBloom: [24, 25.5], tsqLabel: 25.5,
  xseal: 27,
  expand: [27.5, 28],
  snips: Array.from({ length: 20 }, (_, k) => 28 + (k + 1) / 4),   // b28.25 … b33
  loosen: 33,
  open: 34,
  zhi: [35, 35.7], hailuoLabel: 35.5,
  match: 37.5,
  lamp: 38,
  cloth: [38.4, 41.4],
  aftOn: [41.3, 42],
  ou: 43, ouNote: 44, aftLabel: 44,
  last: 47,
};

// 碎纸：每一剪落下一小片，确定性"模拟"（起飞 → 漂移翻转 → 落定），落定时刻也进声音事件
function mul(seed){ return function(){ seed|=0; seed=seed+0x6D2B79F5|0; let t=Math.imul(seed^seed>>>15,1|seed); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
export const SCRAPS = CUE.snips.map((sb, k) => {
  const R = mul(9100 + k * 37);
  const air = .45 + .4 * R();
  return { k, tSnip: b(sb), tLand: b(sb) + air, dx: (R() - .35) * 130, dy: 35 + R() * 90, rot: (R() - .5) * 6, size: 15 + R() * 11, flip: R() < .55, seed: k * 13 + 5 };
});

// ---------------- 声音事件（秒） ----------------
// type 由 mix.py 解释；t 为起音时刻（拍点），dur 为持续型声音的长度。
export function events() {
  const E = [], add = (beat, type, o = {}) => E.push({ t: +(b(beat)).toFixed(6), beat, type, ...o });
  const C = CUE;
  add(C.drop, 'drop');
  add(C.flute1, 'flute_breath');
  add(C.seal1960, 'seal');
  add(C.xkdBloom[0], 'brush_rustle', { end: b(C.xkdBloom[1]) });
  add(C.xkdBloom[1], 'qin_harm', { note: 'A4' });
  add(C.shui[0], 'brush_write'); add(C.mo[0], 'brush_write');
  add(C.shuimoNote, 'dot');
  add(C.xkdLabel, 'dot');
  add(C.mudiUnroll[0], 'scroll_slide', { end: b(C.mudiUnroll[1]) });
  add(C.mudiUnroll[1], 'wood_knock');
  add(C.mudiBloom[0], 'brush_rustle', { end: b(C.mudiBloom[1]) });
  add(C.mudiBloom[1], 'qin_harm', { note: 'D5' });
  add(C.mudiLabel, 'dot');
  add(C.beatBack, 'grind_bed', { end: b(27) });
  add(C.bi[0], 'brush_write'); add(C.hua[0], 'brush_write'); add(C.bihuaNote, 'dot');
  for (const g of C.jslGrow) add(g, 'grind', { end: b(g + .85) });
  for (const g of C.jslColor) add(g, 'dab');
  add(C.jslBloom[0], 'pipa_sweep'); add(C.jslBloom[0], 'grind_sweep', { end: b(C.jslBloom[1]) });
  add(C.jslBloom[1], 'pipa_harm');
  add(C.jslLabel, 'dot');
  for (const g of C.tsqGrow) add(g, 'grind', { end: b(g + .85) });
  for (const g of C.tsqColor) add(g, 'dab');
  add(C.tsqBloom[0], 'pipa_sweep'); add(C.tsqBloom[0], 'cym_brush'); add(C.tsqBloom[0], 'grind_sweep', { end: b(C.tsqBloom[1]) });
  add(C.tsqBloom[1], 'pipa_harm');
  add(C.tsqLabel, 'dot');
  add(C.xseal, 'seal_ban');
  add(C.expand[0], 'paper_rise', { end: b(C.expand[1]) });
  add(C.expand[1], 'paper_slap');
  C.snips.forEach((s, k) => add(s, 'snip', { k }));
  for (const sc of SCRAPS) E.push({ t: +sc.tLand.toFixed(6), beat: sc.tLand / BEAT, type: 'scrap_land', k: sc.k });
  add(C.loosen, 'paper_flop');
  add(C.open, 'unfold_snap'); add(C.open, 'zheng_gliss');
  add(C.zhi[0], 'brush_write'); add(C.hailuoLabel, 'dot');
  add(C.match, 'match');
  add(C.lamp, 'xiaoluo'); add(C.lamp, 'flame_whoomp'); add(C.lamp, 'flame_bed', { end: DUR });
  add(C.aftOn[1], 'aft_hit');
  add(C.ou, 'cloth_thup'); add(C.ouNote, 'dot_cloth');
  add(C.last, 'final');
  return E.sort((a, z) => a.t - z.t);
}

// 用于 cuecheck 的"画面事件"——需要在画面上肉眼可见地从这一帧开始/落定的事件
export const VISCUES = [
  ['水滴落纸', C_(CUE.drop)], ['朱印1960', C_(CUE.seal1960)], ['小蝌蚪显影完成', C_(CUE.xkdBloom[1])],
  ['轴头落定', C_(CUE.mudiUnroll[1])], ['牧笛显影完成', C_(CUE.mudiBloom[1])],
  ['卷草第1笔', C_(17)], ['卷草第2笔', C_(18)], ['卷草第3笔', C_(19)], ['九色鹿显影起', C_(20)],
  ['云纹第1笔', C_(22)], ['云纹第2笔', C_(23)], ['天书奇谭显影起', C_(24)],
  ['肖形印', C_(CUE.xseal)], ['红纸铺满', C_(CUE.expand[1])],
  ...CUE.snips.map((s, k) => [`第${k + 1}剪`, C_(s)]),
  ['窗扇打开', C_(CUE.open)], ['火柴', C_(CUE.match)], ['灯亮', C_(CUE.lamp)], ['阿凡提清晰', C_(CUE.aftOn[1])],
  ['偶', C_(CUE.ou)], ['最后一拍', C_(CUE.last)],
];
function C_(beat) { return { beat, t: +(beat * BEAT).toFixed(6) }; }
