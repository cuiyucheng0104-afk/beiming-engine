// 城市的一天 —— 唯一时间源。所有拍点都是整数帧（24 fps），画面、配乐、拟音、核对脚本都从这里取时间。
// 用法：浏览器 import；node tools/export_timeline.mjs → timeline.json（Python 读取）
export const FPS = 24;
export const W = 1920, H = 1080;

// 每小节每拍的帧数（= 速度）：14→13→12→11 加速，正午刹车，夜里 11，熄灯 12→15 减速，尾声 16
export const BARS = [
  [14, 14, 14, 14],   // 1 黎明 102.9 BPM
  [14, 14, 14, 14],   // 2
  [13, 13, 13, 13],   // 3 早高峰 110.8
  [12, 12, 12, 12],   // 4 120
  [11, 11, 11, 11],   // 5 网格 130.9
  [11, 11, 11, 11],   // 6 刹车 / 正午
  [11, 11, 11, 11],   // 7 入夜重音
  [11, 11, 11, 11],   // 8 光河 + 倒放闪回
  [12, 13, 14, 15],   // 9 熄灯，减速 120→96
  [16, 16, 4],        // 10 硬停 + 尾声（最后一拍只到片尾）
];
export const BEATS = [];   // [{bar, beat, f, len}]
{ let f = 0; BARS.forEach((b, i) => b.forEach((len, k) => { BEATS.push({ bar: i + 1, beat: k + 1, f, len }); f += len; })); }
export const NF = BEATS[BEATS.length - 1].f + BEATS[BEATS.length - 1].len;   // 478
export const DUR = NF / FPS;
// bar（1 起）、beat（1 起）、拍内细分 frac（0..1）→ 整数帧
export function F(bar, beat = 1, frac = 0) {
  const b = BEATS.find(x => x.bar === bar && x.beat === beat);
  if (!b) throw new Error(`no beat ${bar}.${beat}`);
  return Math.round(b.f + frac * b.len);
}
// 一拍内的十六分（n=4）或其它等分
export const sub = (bar, beat, k, n = 4) => F(bar, beat, k / n);

// ── 关键帧号 ──
export const T = {
  hit0: 0, title: F(1, 2), jcut: F(2, 4),
  rush: F(3, 1), grid: F(5, 1), brake: F(6, 1), hush: F(6, 3), night: F(7, 1),
  flash: F(8, 3), dean: F(9, 1), stop: F(10, 1), last: F(10, 2), end: NF,
};

// ── 镜头（src 帧率、裁切 [x,y,w,h]、速度关键帧 [(秒,倍速)]、融合上限）──
// move: 相机运动（页面里做）：s0→s1 缩放，dx/dy 平移（相对画幅），ease
export const SHOTS = [
  { id: 'S1', f0: 0, f1: F(3, 1), src: 'berlin', s0: 3, crop: [384, 0, 1536, 864], speed: [[0, 5], [4.67, 18]], blend: 8, wb: .25, bloom: .12, night: false,
    move: { s0: 1.0, s1: 1.10, dx0: 0, dx1: -.02, dy0: 0, dy1: .03 } },
  { id: 'S2', f0: F(3, 1), f1: F(3, 3), src: 'causeway', s0: 2, crop: [480, 270, 1440, 810], speed: 8, blend: 8, wb: .4, bloom: .09,
    move: { s0: 1.06, s1: 1.06, dx0: .025, dx1: -.025 } },                    // 横摇
  { id: 'S3', f0: F(3, 3), f1: F(4, 1), src: 'dallas', s0: .3, crop: [0, 0, 1920, 1080], speed: 9, blend: 8, wb: .3, bloom: .09,
    move: { s0: 1.0, s1: 1.04 } },
  { id: 'S4', f0: F(4, 1), f1: F(4, 2), src: 'nevsky', s0: 4.6, crop: [0, 0, 1280, 720], speed: 2.5, blend: 6, wb: .3, bloom: .1,
    move: { s0: 1.0, s1: 1.02 } },
  { id: 'S5', f0: F(4, 2), f1: F(4, 3), src: 'shibuya', s0: 2, crop: [500, 646, 772, 434], speed: 8, blend: 8, wb: .2, bloom: .09, levels: true, contrast: .6,
    move: { s0: 1.10, s1: 1.10, dy0: .04, dy1: -.04 } },                     // 下摇：涩谷路口下半（避开广告牌），人成雾、巴士拖线
  { id: 'S6', f0: F(4, 3), f1: F(4, 4), src: 'kolkata', s0: 11.9, crop: [480, 0, 1440, 810], speed: 1.2, blend: 3, wb: .3, bloom: .14,
    move: { s0: 1.0, s1: 1.13, ease: 'out' } },                              // 急推
  { id: 'S7', f0: F(4, 4), f1: F(5, 1) + 7, src: 'frisco', s0: .5, crop: [0, 0, 1920, 1080], speed: 6, blend: 8, wb: .3, bloom: .09,
    move: { s0: 1.0, s1: 1.03 } },                                            // 网格第一级亮起时它还在底下
  { id: 'S9', f0: F(6, 1), f1: F(7, 1), src: 'etela', s0: 31, crop: [0, 220, 2400, 1350], speed: [[0, 6], [.58, .3], [1.83, .22]], mix: true, blend: 6, wb: .35, bloom: .09,
    move: { s0: 1.0, s1: 1.06 } },                                            // 刹车
  { id: 'S10', f0: F(7, 1), f1: F(7, 3), src: 'lujiazui', s0: 1.2, crop: [0, 0, 1920, 1080], speed: 4, blend: 4, wb: 0, bloom: .2, night: true,
    move: { s0: 1.0, s1: 1.14, ease: 'fall', dy1: .02 } },                    // 坠落式急推
  { id: 'S11', f0: F(7, 3), f1: F(8, 1), src: 'mckinney', s0: 4, crop: [0, 0, 1920, 1080], speed: 30, blend: 24, wb: 0, bloom: .18, night: true,
    move: { s0: 1.08, s1: 1.08, dx0: -.03, dx1: .03 } },                      // 横移
  { id: 'S12', f0: F(8, 1), f1: F(8, 2), src: 'cabo', s0: 4.4, crop: [0, 0, 3840, 2160], speed: 4, blend: 4, wb: 0, bloom: .2, night: true,
    move: { s0: 1.0, s1: 1.05 } },
  { id: 'S13', f0: F(8, 2), f1: F(8, 3), src: 'lentos', s0: 3.2, crop: [0, 0, 1920, 1080], speed: 11, blend: 6, wb: 0, bloom: .18, night: true,
    move: { s0: 1.0, s1: 1.03 } },
  { id: 'S15', f0: F(9, 1), f1: NF, src: 'dean', s0: 2, crop: [0, 0, 1728, 972], speed: 2.0, blend: 3, wb: 0, bloom: .24, lift: 1.35, night: true,
    move: { s0: 1.37, s1: 1.31, ease: 'out', dx0: .15, dx1: .15, dy0: -.07, dy1: -.04 } },   // 慢拉；长街放在画面右侧，引文底下全是暗部
];

// 网格（第 5 小节）：每拍升一级；新格在 0/1/2 个十六分里散点亮起；最后一拍每个十六分换片
export const GRID_POOL = ['shibuya', 'causeway', 'dallas', 'shibuya2', 'causeway2', 'dallas2', 'frisco', 'etela', 'newcastle'];   // 每格都要认得出形状：不用糊成雾的地铁
export const POOL_N = 44;
export const GRID_STAGES = [
  { f: F(5, 1), cols: 2, rows: 1 },
  { f: F(5, 2), cols: 2, rows: 2 },
  { f: F(5, 3), cols: 3, rows: 3 },
  { f: F(5, 4), cols: 4, rows: 4 },
];
export const GRID_RECUT = [1, 2, 3].map(k => sub(5, 4, k));   // 最后一拍的十六分换片
export const GRID_END = F(6, 1);
const h1 = n => { n = Math.sin(n * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };
// 每格亮起的延迟：0、1、2 个十六分（落在乐谱的十六分上）
export function cellDelay(stage, i) {
  const st = GRID_STAGES[stage], k = Math.floor(h1(stage * 31 + i * 7.3) * 3);
  return sub(5, stage + 1, k) - st.f;
}
export function cellSrc(stage, i, recut = 0) {
  const N = GRID_POOL.length, ORDER = [0, 1, 2, 3, 6, 5, 4, 7, 8];       // 前 4 格先给人群、车流、快速路、地铁
  return GRID_POOL[ORDER[(i * 4 + stage * 2 + recut * 5 + (i >= N ? 3 : 0)) % N]];
}

// 倒放闪回（第 8 小节第 3、4 拍）：先每十六分一刀，再每 2 帧一刀
export const FLASH = [
  { f: sub(8, 3, 0), shot: 'S12' }, { f: sub(8, 3, 1), shot: 'S11' }, { f: sub(8, 3, 2), shot: 'S10' }, { f: sub(8, 3, 3), shot: 'S9' },
  { f: F(8, 4), shot: 'GRID' }, { f: F(8, 4) + 2, shot: 'S6' }, { f: F(8, 4) + 4, shot: 'S5' }, { f: F(8, 4) + 6, shot: 'S4' },
  { f: F(8, 4) + 8, shot: 'S2' }, { f: F(8, 4) + 10, shot: 'S1' },
];
export const FLASH_END = F(9, 1);

// 熄灯：第 9 小节第 2/3/4 拍各熄一组，第 10 小节强拍硬停（只剩最后一盏），第 2 拍最后一盏灭
export const LIGHTS_OFF = [
  { f: F(9, 2), group: 0 }, { f: F(9, 3), group: 1 }, { f: F(9, 4), group: 2 },
  { f: F(10, 1), group: 3 },     // 硬停：除最后一盏外全部
  { f: F(10, 2), group: 4 },     // 最后一盏
];

// 文字（左对齐，左边距 180）
export const TEXT = {
  title: { f0: T.title, f1: T.rush, zh: '城市的一天', en: 'A CITY, ONE DAY' },
  quote: { f0: T.dean, f1: NF, zh: '那颗伟大的心 已静卧', en: 'ALL THAT MIGHTY HEART IS LYING STILL', src: 'W. WORDSWORTH · 1807' },
};

// 日环：片中"一天"的钟点（小时，0–24），按帧
export function ringHour(f) {
  const L = (a, b, f0, f1) => a + (b - a) * Math.min(1, Math.max(0, (f - f0) / (f1 - f0)));
  if (f < T.rush) return L(5.5, 7.2, 0, T.rush);
  if (f < T.brake) return L(7.2, 10.8, T.rush, T.brake);
  if (f < T.night) return 12.0;                                   // 刹车：冻结
  if (f < T.flash) return L(19.0, 21.8, T.night, T.flash);
  if (f < T.dean) return L(21.8, 21.8 - 15, T.flash, T.dean);     // 倒放闪回：倒转
  return L(22.8, 24.0, T.dean, T.stop);
}
