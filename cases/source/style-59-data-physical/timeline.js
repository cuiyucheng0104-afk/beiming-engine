// 《一年的雨》— 唯一时间源：节拍网格、数据、每颗珠的落定时间、画面内文字
// 100 BPM，4/4：1 拍 0.6 s，1 小节 2.4 s。所有剪辑点、关键动作、文字落定都在这张网格上。
export const BPM = 100, BEAT = 60 / BPM, BAR = BEAT * 4;
export const b = n => +(n * BEAT).toFixed(4);          // 拍 → 秒
export const DUR = b(33);                              // 19.8 s

// NOAA NCEI 美国气候正常值 1991–2020，迈阿密国际机场站 USW00012839，MLY-PRCP-NORMAL（英寸）→ 毫米，四舍五入到整颗
export const INCH = [1.83, 2.15, 2.46, 3.36, 6.32, 10.51, 7.36, 9.58, 10.22, 7.65, 3.53, 2.44];
export const MM = INCH.map(v => Math.round(v * 25.4));   // [46,55,62,85,161,267,187,243,260,194,90,62]
export const TOTAL = MM.reduce((a, c) => a + c, 0);      // 1712
export const MONTH_ZH = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
export const WETTEST = MM.indexOf(Math.max(...MM));      // 5 = 六月
export const BRASS_EVERY = 10;

// —— 各段 ——
export const SEC = [
  { id: 'unit', b0: 0, b1: 8 },        // 微距：1 颗 = 1 毫米，第 10 颗铜珠
  { id: 'feed', b0: 8, b1: 20 },       // 十二个月逐拍进料
  { id: 'reveal', b0: 20, b1: 22 },    // 拉开：一排管 → 一座钟
  { id: 'silence', b0: 22, b1: 24 },   // 抽空静默，最后一颗下落
  { id: 'last', b0: 24, b1: 28 },      // 最后一颗落定，读数与标题
  { id: 'coda', b0: 28, b1: 33 },
];

// —— 落珠时间表（拍）——
// 单位段：一月的前 10 颗。第 1 颗在 b1，第 2–9 颗按八分音符 b2…b5.5，第 10 颗（铜珠）在 b6
export const UNIT_BEATS = [1, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6];
export const UNIT_FALL = BEAT;                 // 慢镜头：每颗下落 0.6 s
// 进料段：第 m 月（0 起）首颗在 b(8+m) 落定，本月剩余的珠在一拍内均匀落完（雨越大，珠越密）
export const FEED_ON = m => 8 + m;
export const POUR_BEATS = 1;
// 最后一颗：六月的第 267 颗，静默中从镜头上方坠落，b24 落定
export const LAST_BEAT = 24, LAST_FALL_FROM = 22;

export const T = {
  r1: [b(1), b(9)],          // 读数「玻璃珠 · 1 颗 = 1 毫米」：b1 起，b1.5 落定
  r2: [b(6), b(11)],         // 读数「铜珠 = 10 毫米」
  src: b(1.5),               // 来源行
  counter: b(8),             // 计数器
  crane: b(8),               // 起升离开微距
  reveal: b(20),             // 拉开升起
  top: b(22),                // 到达俯视
  suck: b(22),               // 抽空开始（−30 dB）
  lastTag: b(22.5),          // 「最后一颗 #1712」钉在下落的珠上（八分音符上出现）
  last: b(LAST_BEAT),        // 最后一颗落定 = 静默后的第一声
  bounce: b(LAST_BEAT) + b(.5) * .5,   // 回弹的第二下（b24.25）
  june: b(27.5),             // 六月读数（接过「最后一颗」的读数）
  title: b(26),              // 标题
  sub: b(26.5),              // 副题
  recap: b(26),              // 钢片琴回顾 12 个月（十六分音符）
  final: b(30),              // 结尾和弦
};
export const IN = BEAT / 2;  // 文字淡入时长：从起点到落定 = 一个八分音符

// 每一张珠：{m 月, k 本月第几颗(0 起), land 落定秒, fall 下落秒, mode}
export function schedule() {
  const out = [];
  for (let m = 0; m < 12; m++) {
    const n = MM[m];
    for (let k = 0; k < n; k++) {
      let land, fall, mode;
      if (m === 0 && k < UNIT_BEATS.length) { land = b(UNIT_BEATS[k]); fall = UNIT_FALL; mode = 'unit'; }
      else if (m === WETTEST && k === n - 1) { land = b(LAST_BEAT); fall = b(LAST_BEAT - LAST_FALL_FROM); mode = 'last'; }
      else {
        const k0 = m === 0 ? UNIT_BEATS.length : 0, np = (m === WETTEST ? n - 1 : n) - k0;
        land = b(FEED_ON(m)) + b(POUR_BEATS) * (k - k0) / np; fall = 0; mode = 'feed';
      }
      out.push({ m, k, land: +land.toFixed(5), fall, mode, brass: (k + 1) % BRASS_EVERY === 0 });
    }
  }
  return out;
}

// 数据 → 音高：D 大调换成 F 大调五声，10 个音级（F5 G5 A5 C6 D6 F6 G6 A6 C7 D7）；月降水线性映射
export const PENTA = ['F5', 'G5', 'A5', 'C6', 'D6', 'F6', 'G6', 'A6', 'C7', 'D7'];
export const deg = mm => Math.round((mm - 40) / (Math.max(...MM) - 40) * (PENTA.length - 1));
export const MONTH_NOTE = MM.map(v => PENTA[deg(v)]);

// 画面内全部文字（字体子集也从这里取字）
export const LABELS = {
  r1cat: '玻璃珠', r1val: '1 颗 = 1 毫米',
  r2cat: '铜珠', r2val: '= 10 毫米',
  cnt: '迈阿密 · 累计降水', cntEnd: '迈阿密 · 全年降水', mm: '毫米',
  lastCat: '最后一颗', lastVal: '#1712',
  junCat: '6 月 · 最多', junVal: '267',
  title: '一年的雨', sub: '1991–2020 气候平均',
  source: '数据：NOAA NCEI 美国气候正常值 1991–2020 · 迈阿密国际机场站 · 美国政府作品，公有领域',
  inlayC1: '迈阿密国际机场站', inlayC2: '1991–2020 · 月平均降水 · 毫米', inlayC3: '1 颗 = 1 毫米',
};
