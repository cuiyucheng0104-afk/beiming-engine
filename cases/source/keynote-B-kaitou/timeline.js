// 方案 B《片库之夜》20 秒开头：唯一时间与版面来源。画面 main.js、事件表 events.json、配乐 mix.py、对拍自检都读这里的数。
// 108 BPM，4/4，一拍 B = 0.5556 s；g(n) = 第 n 拍（全片从 0 数）。画面事件落在帧 round(t·30)。
export const W = 1920, H = 1080, FPS = 30, DUR = 20;
export const BPM = 108, B = 60 / BPM, BAR = 4 * B;
export const g = n => n * B;
export const frameOf = t => Math.round(t * FPS);
export const fq = t => frameOf(t) / FPS;                  // 一次性事件：声音放在画面帧时刻（0 ms）

// ───────── 世界：看片台（世界坐标 = 缩放 1 时的像素） ─────────
export const TABLE = { x0: -1300, x1: 3700, y0: 0, y1: 1500, rim: 34 };
export const NT = 8;
export const tubeY = i => TABLE.y0 + (i + .5) * (TABLE.y1 - TABLE.y0) / NT;
export const LAMP_ORDER = [3, 4, 2, 5, 1, 6, 0, 7];        // 第 k 拍亮第几根：从中间向两边铺开
export const LAMP_T = LAMP_ORDER.map((_, k) => fq(g(k)));
// 每根灯管启辉后的逐帧亮度（第 0 帧 = 拍上第一闪），之后稳定为 1。各根不同，真实的荧光灯不会同步。
export const FLICK = [
  [1, .18, .85, .3, .95, .7, 1],
  [.9, .25, 1, .12, .8, 1],
  [1, .1, .7, .45, 1, .85, 1],
  [.95, .3, 1, .2, .9, 1],
  [1, .15, .9, .5, 1],
  [.85, .2, 1, .35, .95, .75, 1],
  [1, .12, .8, .25, 1, .9, 1],
  [.9, .3, 1, .15, .85, 1],
];
export const PREHEAT = .13;                                // 拍前灯丝预热（两端微橙）

// ───────── 物件 ─────────
export const SLIDE = { cx: 1550, cy: 820, iw: 760, ih: 760 * 1256 / 2232, bx: 50, by: 56,
  t0: g(6.65), t1: fq(g(8)), from: [260, 1560, -7.5] };    // 幻灯片：g6.65 从左下滑入，g8 落定
export const IMG = { x0: SLIDE.cx - SLIDE.iw / 2, y0: SLIDE.cy - SLIDE.ih / 2 };
export const DEER_HEAD = [IMG.x0 + .655 * SLIDE.iw, IMG.y0 + .15 * SLIDE.ih];
export const LOUPE = { r: 150, mag: 1.6, park: [2360, 560], t0: fq(g(10)), t1: fq(g(12)) };
export const CARDS = [{ cx: 640, cy: 175, w: 430, h: 255, rot: 3.5 }, { cx: 700, cy: 205, w: 430, h: 255, rot: -2 }];
export const PENCIL_LYING = { x: 780, y: 1330, rot: -18, len: 560 };
export const STACK = { cx: 2430, cy: 1255, w: 450, h: 150, n: 4 };   // 返修：移到放大镜停放处下方，S1 的光里就能看见；第 9 小节底片套从这一叠的方向滑出
export const TITLE = { t: fq(g(9)), sub: fq(g(9.5)), x: 1080, y: 700, anchor: [SLIDE.cx - 430 + 8, 650] };
export const TAG = { t: fq(g(11)), x: SLIDE.cx + 430, y: SLIDE.cy + 270 + 16 };

// ───────── 数据纸 ─────────
export const PAPER = { x0: -1300 + 40, x1: 380, y0: 300, y1: 1340 };
export const NUM = { x: -1235, y: 610, size: 200 };
export const FIELD = { x0: -790, x1: 340, y0: 370, y1: 1290 };
// 铅笔点：四分 → 八分 → 三连音 → 十六分；每下落几个点（累计 477）
const TAPS_SPEC = [
  ...[16, 17, 18, 19].map(b => [b, 1]),
  ...[[20, 2], [20.5, 3], [21, 4], [21.5, 5]],
  ...[[22, 7], [22 + 1 / 3, 9], [22 + 2 / 3, 12], [23, 15], [23 + 1 / 3, 19], [23 + 2 / 3, 24]],
  ...[[24, 28], [24.25, 33], [24.5, 38], [24.75, 44], [25, 50], [25.25, 56], [25.5, 60], [25.75, 64]],
];
export const TAPS = TAPS_SPEC.map(([b, n], i) => ({ i, beat: b, t: g(b), frame: frameOf(g(b)), n }));
export const NDOTS = TAPS.reduce((s, x) => s + x.n, 0);    // = 477
export const T477 = fq(g(26)), TCLU = fq(g(28)), TREST = g(27.5);
export const TNAMES = g(28), NAME_GAP = .02, NAME_DUR = .22;      // 返修：25 个名字在 16.26 s 前写完
export const NOTE = { ring: fq(g(28.5)), t0: g(28.75), t1: g(29.3) };
export const TMERGE = fq(g(29));
export const OUTLINE = [0, 1, 2, 3].map(k => ({ t: fq(g(29.25 + .25 * k)), dur: .42 }));   // 返修：四个组名在 17.0 s 前写完
export const GNAME = { d0: .04, d1: .32 };                        // 组名擦写：轮廓起笔后 0.04–0.32 s
// 计数：铅笔正字划记（每 5 条记录一个「正」），不出现中间数字；g26 时「477」整体落下
export const TALLY = { x0: -1238, y0: 862, cw: 37.5, ch: 41, cols: 11, size: 29 };

export const GROUPS = [
  { name: '神话与传奇', cats: ['孙悟空', '哪吒闹海', '天书奇谭', '九色鹿', '宝莲灯', '西岳奇童'] },
  { name: '冒险与伙伴', cats: ['葫芦兄弟', '黑猫警长', '阿凡提的故事', '邋遢大王奇遇记', '舒克和贝塔', '魔方大厦'] },
  { name: '生活与寓言', cats: ['雪孩子', '三个和尚', '没头脑和不高兴', '我为歌狂', '骄傲的将军', '超级肥皂', '熊猫百货商店', '鹬蚌相争'] },
  { name: '艺术集合与新作', cats: ['水墨动画', '剪纸动画', '中国奇谭', '浪浪山小妖怪', '中国奇谭2'] },
];
// 2×2 分区：左上、右上、左下、右下
export const REGIONS = (() => {
  const xm = (FIELD.x0 + FIELD.x1) / 2, ym = (FIELD.y0 + FIELD.y1) / 2;
  return [[FIELD.x0, FIELD.y0, xm, ym], [xm, FIELD.y0, FIELD.x1, ym], [FIELD.x0, ym + 10, xm, FIELD.y1], [xm, ym + 10, FIELD.x1, FIELD.y1]];
})();
export const CLUSTERS = (() => {
  const out = [];
  GROUPS.forEach((G, gi) => {
    const [x0, y0, x1, y1] = REGIONS[gi], rows = Math.ceil(G.cats.length / 2), top = y0 + 84, rh = (y1 - 8 - top) / rows;
    G.cats.forEach((name, k) => {
      const col = k % 2, row = Math.floor(k / 2);
      const x = x0 + 42 + col * 292;                                     // 返修：两列间距 272 → 292
      out.push({ gi, name, col, row, x, y: top + rh * (row + .5), x1 });
    });
  });
  return out;
})();
export const GROUP_C = GROUPS.map((_, gi) => {
  const cs = CLUSTERS.filter(c => c.gi === gi);
  return [cs.reduce((s, c) => s + c.x, 0) / cs.length + 70, cs.reduce((s, c) => s + c.y, 0) / cs.length];
});
export const MERGE_K = .13;                                          // 并组时各簇向组心收拢的比例
// 名字最大宽度（返修）：按并组后的最终位置算——不压同一行右侧点簇（点群半径 31 + 留白 14），也不出组框
CLUSTERS.forEach(c => {
  const fx = k => k.x + (GROUP_C[k.gi][0] - k.x) * MERGE_K, nb = CLUSTERS.find(k => k.gi === c.gi && k.row === c.row && k.col === 1 && c.col === 0);
  c.maxW = Math.min(nb ? fx(nb) - 31 - 14 : Infinity, c.x1 - 30 - (c.col ? 0 : 20)) - (fx(c) + 34);
});

// ───────── 回到台面：底片套 ─────────
export const CAPTION = { t: fq(g(32.5)), x: 2950, y: 470 };
export const SLEEVES = [
  { img: 'p02_sunwukong', cx: 2510, land: fq(g(33)), settle: .75 },
  { img: 'p02_heimao', cx: 2950, land: fq(g(34)), settle: .75 },
  { img: 'p02_hulu', cx: 3390, land: fq(g(35)), settle: 2.2 },   // 第三张：片尾时仍在滑
];
export const SLEEVE = { cy: 880, ih: 560, side: 22, top: 58, bot: 24, fly: .32, land: [24, 120] };
// 返修：底片套从左下那一叠的方向（画外下方）抽出，空中掠过那一叠，落在目标下方一点，再顺势向上滑到位（不压相邻海报）
export const sleeveFrom = k => [STACK.cx - 40 + k * 60, STACK.cy + 760];

// ───────── 镜头 { x, y, 缩放, 滚转(度) }：分段 + 缓动 ─────────
export const CAM = [
  { t: 0, c: [1200, 760, .38, 0] },
  { t: SLIDE.t1, c: [1535, 835, .80, 0], ease: 'eio' },          // 升降推近，落片那一拍停住
  { t: fq(g(9.35)), c: [1542, 838, .965, 0], ease: 'eo' },        // 落片的冲击：再推一档
  { t: 8.05, c: [1555, 840, .985, 0], ease: 'lin' },              // 极慢漂移
  { t: 8.95, c: [-445, 820, .90, 0], ease: 'pan', dip: .2 },      // 横摇到图纸
  { t: T477, c: [-330, 835, 1.02, .8], ease: 'ss' },              // 缓推 + 荷兰角
  { t: TCLU, c: [-445, 820, .90, 0], ease: 'eio' },               // 拉回，正落在和弦
  { t: g(32), c: [-438, 822, .915, 0], ease: 'lin' },             // 锁定看形变，带极慢的呼吸推近（返修：推迟到 g32，组名留够读的时间；不再有整段静止帧）
  { t: 18.30, c: [2990, 875, .92, 0], ease: 'pan', dip: .22 },    // 横摇回台面
  { t: 21.5, c: [2990, 862, .985, 0], ease: 'eo' },               // 极慢推近，片尾仍在动
];
export const PANS = [[8.05, 8.95], [g(32), 18.30]];
