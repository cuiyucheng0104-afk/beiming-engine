// 唯一时间源：节拍网格、全部画面事件时刻、红点路径、画面文字。
// 浏览器（film.js）、node（tools/export_timeline.mjs → timeline.json）、python（mix.py / cuecheck.py）读的都是这里的数字。
export const BPM = 120, BEAT = 60 / BPM, E8 = BEAT / 2, E16 = BEAT / 4, BAR = BEAT * 4, FPS = 24;
export const DUR = 19.75;

// —— 版面网格：12 栏 × 6 行 ——
export const G = { W: 1920, H: 1080, MX: 96, MY: 84, COL: 122, GUT: 24, ROW: 132 };
export const colX = k => G.MX + k * (G.COL + G.GUT);
export const rowY = k => G.MY + k * (G.ROW + G.GUT);

// —— 段落（小节号从 1 起）——
export const SECS = [
  { id: 'count', t: 0, bars: 2, note: '数拍：巨型 1 每拍换数，镜头阶梯拉出；第 2 小节 1-2-3-4 跳格' },
  { id: 'tempo', t: 4, bars: 2.5, note: 'TEMPO 分块入场，每两拍硬摇' },
  { id: 'accel', t: 9, bars: 1.5, note: '巨大 4 越数越快，推进两次' },
  { id: 'rest', t: 12, bars: 1, note: '下拍全停，静默一小节' },
  { id: 'except', t: 14, bars: 1.5, note: '红点（例外）滚过一切' },
  { id: 'lock', t: 17, bars: 1.375, note: '重排 → 拉出成四联海报' },
];

// —— 画面事件时刻（全部是十六分网格上的整帧）——
export const T = {
  count: [0, 0.5, 1, 1.5],                       // 第 1 小节：巨型数字 1→2→3→4
  pull: [[0, 2.4], [0.5, 1.9], [1, 1.5], [1.5, 1.2], [2, 1]],   // 阶梯拉出：落点时刻 + 缩放
  hud: 2,                                        // 页边文字落定
  hop: [2, 2.5, 3, 3.5],                         // 第 2 小节：1-2-3-4 跳格（2.0 是 4→1 换数）
  knife: [3.5, 3.75, 4],                         // 划线开始 / 划线到头 / 收缩完（与 T 的第一块同拍）
  letters: [4, 5, 6, 7, 8],                      // 每个字母：上半在 L，下半在 L+0.5，各自再错一个十六分
  pans: [4, 5, 6, 7, 8],                         // 硬摇落点
  rot: [8.625, 9],                               // 旋转 90°
  big: [[9, 1], [9.5, 2], [10, 3], [10.5, 4], [10.75, 1], [11, 2], [11.25, 3], [11.5, 4], [11.625, 1], [11.75, 2], [11.875, 3], [12, 4]],
  push: [[10.5, 10.75, 1.3], [11.5, 11.625, 1.75], [11.875, 12, 1]],   // 推进：开始、落点、缩放
  notes: [9.5, 10, 10.75, 11.625],               // 右栏注释落定
  stop: 12,
  rest: 12,                                      // "休止" 注释
  dotIn: 14, dotPause: [15, 15.5], dotTurn: 16.5, dotLand: 17,
  restCut: [16.875, 17, 17.125],                 // "休止" 被 knife cut
  reflow: [17.125, 17.25, 17.375],               // 由近及远：书脊+红点 / 巨大数字 / 标题与日期
  posters: [17.625, 17.75, 17.875],              // 第 3、2、1 张海报擦入落点
  pullOut: [17.5, 18],
  lock: 18,
  end: DUR,
};

// 红点路径（屏幕坐标，线性、不吸附）：[t, x, y, r]。最后一点由 film.js 换成 C 段 O 的中心。
export const DOT = [
  [14.0, 2110, 700, 190],
  [15.0, 1400, 700, 190],
  [15.5, 1400, 700, 190],
  [16.5, 560, 330, 190],
  [17.0, null, null, null],
];

// 和声与音高（mix.py 用）
export const HARM = {
  am9: ['A3', 'C4', 'E4', 'G4', 'B4'],
  fmaj9: ['F3', 'A3', 'C4', 'E4', 'G4'],
  g69: ['G3', 'B3', 'D4', 'E4', 'A4'],
  e7sus: ['E3', 'A3', 'B3', 'D4', 'E4'],
  final: ['A3', 'E4', 'B4', 'C5', 'E5'],
  glockLetters: ['A5', 'C6', 'E6', 'G6', 'A6'],
};

// —— 画面文字 ——
export const TXT = {
  title: '节拍音乐节',
  bpm: '每分钟 120 拍',
  barLabel: '小节',
  date: '11.08—11.10',
  venue: '旧纺织厂 4 号车间',
  word: 'TEMPO',
  notes: ['四分音符 0.500 秒', '每小节 4 拍', '八分音符 0.250 秒', '十六分音符 0.125 秒'],
  rest: '休止',
  off: '离网格',
  colw: '栏', roww: '行',
  except: '例外',
};
