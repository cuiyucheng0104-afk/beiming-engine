// 片段一「开卷」—— 唯一时间源。画面（index.html）、事件表（window.EV → events.json）、
// 配乐与音效（mix.py 读 events.json）、自检（tools/cuecheck.py）都只从这里取数。
// 72 BPM，4/4。第 1 小节第一拍 = 6.6667 s = 朱印落下。

export const W = 1920, H = 1080, FPS = 30;
export const BPM = 72;
export const B = 60 / BPM;              // 一拍 0.8333 s
export const BAR = 4 * B;               // 一小节 3.3333 s
export const T0 = 8 * B;                // 第 1 小节第一拍 6.6667 s
export const DUR = T0 + 8 * BAR;        // 33.3333 s
export const bar = (n, beat = 1) => T0 + (n - 1) * BAR + (beat - 1) * B;   // n 从 1 起，beat 可为小数（1.5 = 第一拍后半）
export const pre = k => T0 + k * B;     // 序里的隐藏拍：pre(-5) = 2.5 s

// ───────── A0 序 ─────────
export const A0 = {
  silenceEnd: 2.0,          // 0–2 s 近黑转宣纸微距，全静
  dropStart: 2.0,           // 墨滴入画
  dropHit: pre(-5),         // 2.5000 落纸：水滴
  harm1: pre(-5) + B / 2,   // 2.9167 古琴泛音 D5
  bloomEnd: pre(-3) - 0.25, // 3.9167 墨晕扩到扇缘
  harm2: pre(-3),           // 4.1667 泛音 A4
  devStart: 3.9,            // 画芯墨晕显影：镜头已拉到 ≤1.1×（扇面直径 ≤ 画面高 55%）之后才开始；微距阶段扇面里只有墨，没有画
  devEnd: pre(-2),          // 5.0000 显影结束，沙沙声止于此拍
  zoomStart: 2.85, zoomEnd: 4.1,   // 4.2× → 1×：3.9 s 时已 ≤1.05×
  titleStart: pre(-2) + 0.02,     // 「展卷」笔顺写出
  titleEnd: pre(-1) - 0.05,       // 5.7833
  smallStart: pre(-1) - 0.02,     // 「上美影 IP 全景」
  smallEnd: pre(-1) + 0.55,
  sealHit: T0,              // 6.6667 朱印「内容资源概念发布」= 72 BPM 第一拍
};

// ───────── A1 三幅立轴 ─────────
// 每幅：轴杆墨线在落定前 2.5 拍生长，卷轴自前 1.5 拍开始滑开，正好在小节第一拍落定（木击 + 低鼓），
// 随后画芯从上到下墨晕显影，沙沙声止于第三拍。
export const SCROLLS = [
  { id: 'sun',  img: 'material/p02_sunwukong.png', land: bar(2) },
  { id: 'mao',  img: 'material/p02_heimao.png',    land: bar(3) },
  { id: 'hulu', img: 'material/p02_hulu.png',      land: bar(4) },
].map(s => ({ ...s, rod0: s.land - 2.5 * B, rod1: s.land - 2.0 * B, roll0: s.land - 1.5 * B,
  dev0: s.land + 0.08, dev1: s.land + 2 * B }));
export const MOTTO = { text: '角色，是进入内容的入口', t0: bar(4, 2), t1: bar(4, 3.6) };

// ───────── A2 印谱 ─────────
export const FLICK = bar(5);            // 20.0 毛笔甩出墨点
// 25 方印的落点：四分 → 八分 → 八分三连 → 十六分，越落越密；第 7 小节最后一个十六分留空（收住），第 25 方落在第 8 小节第一拍 + 锣
const SEAL_T = [];
for (const b of [2, 3, 4]) SEAL_T.push(bar(5, b));                       // 3
for (let i = 0; i < 8; i++) SEAL_T.push(bar(5, 4.5) + i * B / 2);        // 8 → 11（含第 5 小节第四拍后半）
for (let i = 0; i < 6; i++) SEAL_T.push(bar(7, 1) + i * B / 3);          // 6 → 17
for (let i = 0; i < 7; i++) SEAL_T.push(bar(7, 3) + i * B / 4);          // 7 → 24
SEAL_T.push(bar(8));                                                      // 25
export { SEAL_T };
export const GONG = bar(8);             // 30.0
export const COUNT = { t0: bar(5, 1.6), t1: bar(8) };    // 477 个墨点随印雨点数，与最后一方同时完成
export const CAPTION = { t0: bar(7, 1) + 0.05, t1: bar(7, 1) + 0.9 };     // 「资料底稿 ___ 条作品…」先写好，数字留空
export const NUM477 = [bar(8), bar(8) + B / 4, bar(8) + B / 2];           // 细笔点出 4、7、7（十六分）
export const BIG25 = { t0: bar(8) + 0.02, t1: bar(8) + 0.36 };
export const CAT = { t0: bar(8) + 0.24, t1: bar(8) + 0.5 };              // 「官网动画分类」

export const GROUPS = [
  { name: '神话与传奇',     items: ['孙悟空', '哪吒闹海', '天书奇谭', '九色鹿', '宝莲灯', '西岳奇童'] },
  { name: '冒险与伙伴',     items: ['葫芦兄弟', '黑猫警长', '阿凡提的故事', '邋遢大王奇遇记', '舒克和贝塔', '魔方大厦'] },
  { name: '生活与寓言',     items: ['雪孩子', '三个和尚', '没头脑和不高兴', '我为歌狂', '骄傲的将军', '超级肥皂', '熊猫百货商店', '鹬蚌相争'] },
  { name: '艺术集合与新作', items: ['水墨动画', '剪纸动画', '中国奇谭', '浪浪山小妖怪', '中国奇谭2'] },
];

// ───────── 镜头：一直向左平移（camL = 画面左缘的世界坐标，向左为减小）─────────
// 速度关键帧 px/s：序里不动 → 朱印落下后起步 → A1 巡航 → A2 略快 → 结尾回落到 120（规范里的慢段速度，便于接下一段）
const VK = [[0, 0], [T0 + .45, 0], [T0 + 2.35, 168], [bar(5) - 0.6, 168], [bar(5) + 0.8, 182], [bar(7), 172], [bar(8), 146], [DUR, 122]];
const vAt = t => {
  if (t <= VK[0][0]) return VK[0][1];
  for (let i = 0; i < VK.length - 1; i++) {
    const [a, va] = VK[i], [b, vb] = VK[i + 1];
    if (t <= b) { const u = (t - a) / (b - a), s = u * u * (3 - 2 * u); return va + (vb - va) * s; }
  }
  return VK[VK.length - 1][1];
};
const DT = 1 / 600, NT = Math.ceil((DUR + 1) / DT) + 2, CAM = new Float64Array(NT);
for (let i = 1; i < NT; i++) CAM[i] = CAM[i - 1] - vAt((i - .5) * DT) * DT;
export const camL = t => { const f = Math.max(0, t) / DT, i = Math.min(NT - 2, Math.floor(f)), u = f - i; return CAM[i] * (1 - u) + CAM[i + 1] * u; };
export const camV = vAt;

// 序的推拉：墨滴微距 4× → 1×（以扇心为锚）
export const FAN = { x: 1110, y: 455, r: 262 };
export const ZOOM0 = 4.2;

// ───────── 世界布局 ─────────
export const L = (() => {
  const title = { x: 1640, y: 205, size: 158 };          // 「展卷」竖排
  const small = { x: 1508, y: 236, size: 34 };           // 「上美影 IP 全景」竖排
  const seal0 = { x: 1488, y: 770, w: 150, h: 272 };     // 朱印「内容资源概念发布」（全段第一个重拍，放大到 150 px 宽）
  // 立轴：落定时画芯中心约在屏幕 x≈840
  const sc = SCROLLS.map(s => ({ ...s, x: 860 + camL(s.land) }));
  const rodY = 128;
  const motto = { x: sc[2].x - 330, y: 196, size: 54 };
  // 印谱：最后（t=DUR）「25」块中心在屏幕 x≈1240，四组从左到右依次为 G4 G3 G2 G1
  const S = 116, P = 146, rows = [338, 484, 630];
  const x25 = camL(DUR) + 1060;
  let x = x25 + 250;                                      // G4 左缘
  const cols = [2, 3, 2, 2];                              // G4, G3, G2, G1 的列数（每列 3 方，自上而下、自右而左）
  const order = [3, 2, 1, 0];
  const groups = [];
  for (let k = 0; k < 4; k++) {
    const gi = order[k], n = cols[k];
    const left = x; x += n * P;
    const nameX = x + 30; x += 108;                       // 组名竖排在本组右侧（手卷自右而左，先读到组名）
    groups[gi] = { left, right: left + n * P, nameX, cols: n };
  }
  const specRight = x - 40;
  const seals = [];
  let idx = 0;
  GROUPS.forEach((g, gi) => {
    const G = groups[gi];
    g.items.forEach((name, j) => {
      const col = Math.floor(j / 3), row = j % 3;           // 自右向左排列
      const cx = G.right - P / 2 - col * P, cy = rows[row];
      seals.push({ name, group: gi, idx, x: cx, y: cy, t: SEAL_T[idx] }); idx++;
    });
  });
  const band = { right: specRight - 10, left: 0, y: 752, pitch: 11, rows: 3 };
  band.left = band.right - 158 * band.pitch;
  const caption = { x: band.left, y: 830, size: 25 };
  const big25 = { x: x25 + 20, y: 468, size: 300 };
  const cat = { x: x25 + 20, y: 668, size: 30 };
  return { title, small, seal0, sc, rodY, motto, seals, groups, S, P, band, caption, big25, cat, x25, specRight };
})();

// ───────── 配乐（古琴主题 + 低鼓 + 板眼）：mix.py 从 events.json 读取 ─────────
// 调式 D 宫五声：D E F# A B。主题动机：| D4(1) E4(½) F#4(½) A4(2,吟揉) | B4(1) A4(½) F#4(½) E4(1) D4(1,泛音收) |
export const MOTIF = [['D', 1], ['E', .5], ['F#', .5], ['A', 2], ['B', 1], ['A', .5], ['F#', .5], ['E', 1], ['D', 1]];
// 印雨的木鱼音高：第 1–9 方 = 动机（4 组），第 10–18 方 = 高八度，第 19–24 方 = 上行，第 25 方 = 锣
export const SEAL_PITCH = [
  'D4', 'E4', 'F#4', 'A4', 'B4', 'A4', 'F#4', 'E4', 'D4',
  'D5', 'E5', 'F#5', 'A5', 'B5', 'A5', 'F#5', 'E5', 'D5',
  'D5', 'E5', 'F#5', 'A5', 'B5', 'D6', null];
export const SCORE = (() => {
  const s = [], n = (t, inst, pitch, dur, vel, o = {}) => s.push({ t: +t.toFixed(5), type: 'mus', inst, pitch, dur, vel, pan: 0, ...o });
  // 序：泛音（与墨滴、显影对应）
  n(A0.harm1, 'guqin', 'D5', 6, .62, { harmonic: true, pan: .12 });
  n(A0.harm2, 'guqin', 'A4', 6, .5, { harmonic: true, pan: -.12 });
  n(A0.devEnd, 'guqin', 'D3', 5, .34);
  // 第 1–2 小节：按音完整呈示主题
  let tt = bar(1); const oct = [4, 4, 4, 4, 4, 4, 4, 4, 4];
  MOTIF.forEach(([p, b], i) => {
    const last = i === MOTIF.length - 1, o = {};
    if (p === 'A' && b === 2) o.vib = [5, .22, .38];
    if (last) o.harmonic = true;
    n(tt, 'guqin', p + oct[i], last ? 4 : b * B + .25, i === 0 ? .74 : .64 + (b >= 1 ? .06 : 0), o);
    tt += b * B;
  });
  // 第 3–4 小节：同一动机高八度用泛音
  tt = bar(3);
  MOTIF.forEach(([p, b], i) => { n(tt, 'guqin', p + 5, i === MOTIF.length - 1 ? 4.2 : b * B + 1.2, .5 + (b >= 1 ? .06 : 0), { harmonic: true, pan: .1 }); tt += b * B; });
  // 低音散音
  [[bar(1), 'D2'], [bar(2), 'A2'], [bar(2, 4), 'D2'], [bar(3), 'D2'], [bar(3, 3), 'A2'], [bar(4), 'D2'], [bar(4, 3), 'A2'],
   [bar(5), 'D2'], [bar(5), 'A2'], [bar(6), 'D2'], [bar(7), 'A2'], [bar(7), 'D3'], [bar(8), 'D2'], [bar(8), 'D3']].forEach(([t, p]) => n(t, 'guqin', p, 5, t >= bar(8) ? .8 : .5, { pan: -.15 }));
  // 结尾的泛音：主音 D，余音拖到片尾
  n(bar(8, 3), 'guqin', 'D5', 5, .5, { harmonic: true, pan: .15 });
  n(bar(8, 4), 'guqin', 'A4', 5, .38, { harmonic: true, pan: -.1 });
  // 低鼓：三幅立轴落定 + 印谱的小节头
  for (const sc of SCROLLS) { n(sc.land, 'timpani', 'D3', 2.5, .72); n(sc.land, 'bass_drum', null, 2, .42); }
  n(bar(5), 'timpani', 'D3', 2.5, .55); n(bar(6), 'timpani', 'A2', 2.5, .5); n(bar(7), 'timpani', 'D3', 2.5, .6);
  n(bar(8), 'timpani', 'D3', 3, .66); n(bar(8), 'bass_drum', null, 3, .5);
  // 板（板眼的"板"）
  for (const t of [T0, bar(5), bar(6), bar(7)]) s.push({ t, type: 'ban' });
  // 梆子：第 6 小节后两拍反拍、第 7 小节每拍反拍
  for (const t of [bar(6, 3.5), bar(6, 4.5), bar(7, 1.5), bar(7, 2.5), bar(7, 3.5), bar(7, 4.5)]) s.push({ t, type: 'bangzi' });
  // 大鼓滚奏渐强，在最后一个十六分前切断
  s.push({ t: bar(7, 3), type: 'roll', t1: bar(8) - B / 4 });
  return s;
})();
