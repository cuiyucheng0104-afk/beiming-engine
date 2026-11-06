// 唯一时间源：段落、速度、拍点网格、所有画面事件落在哪一拍。
// 页面（ES module）、tools/dump.mjs（→ out/timeline.json）、配乐与混音都读这里的数字。
// 每一拍都是整帧（24 fps）：120 BPM = 12 帧，96 BPM = 15 帧，渐快段逐拍给帧数。
export const FPS = 24;
export const DUR = 19.75;

// 段落：beats 为每拍帧数列表
const fr = (n, k) => Array(n).fill(k);
export const SECS = [
  { id: 'A', t: 0.0, bpm: 120, frames: fr(8, 12) },                       // 杯
  { id: 'B', t: 4.0, bpm: 120, frames: fr(8, 12) },                       // 热气 → 鸟
  { id: 'C', t: 8.0, bpm: '120→180', frames: [12, 11, 11, 10, 10, 9, 9, 8, 8, 8] },  // 城市渐快
  { id: 'S', t: 12.0, bpm: 120, frames: fr(3, 12), silent: true },        // 停笔静默
  { id: 'D', t: 13.5, bpm: 96, frames: fr(7, 15) },                       // 收拢
  { id: 'E', t: 17.875, bpm: 96, frames: fr(3, 15) },                     // 尾声（余音）
];
// 每段的拍点时刻（含段末），整帧
for (const s of SECS) {
  let f = Math.round(s.t * FPS); s.beatT = [f / FPS];
  for (const k of s.frames) { f += k; s.beatT.push(f / FPS); }
  s.t1 = s.beatT[s.beatT.length - 1];
}
// 段 + 拍（可为小数拍：在相邻两拍之间线性插值）→ 秒
export function B(id, b) {
  const s = SECS.find(x => x.id === id); const i = Math.floor(b), f = b - i;
  if (i >= s.beatT.length - 1) return s.beatT[s.beatT.length - 1];
  return s.beatT[i] + f * (s.beatT[i + 1] - s.beatT[i]);
}

// 画面事件（关键动作 / 拐角 / 停笔）——全部挂在拍上；配乐在同一拍放音符，cuecheck 核对
export const HIT = {
  enter: ['A', 0],        // 笔从左侧入画
  saucer: ['A', 2],       // 碟线收尾 → 杯底右角
  cupBase: ['A', 3],      // 杯底左角
  rimL: ['A', 4],         // 左壁到杯口
  rimR: ['A', 5],         // 杯口前沿到右侧
  handle: ['A', 6],       // 把手最外点
  rimBack: ['A', 7],      // 杯口后沿回到左侧
  steam: ['B', 0],        // 热气升起
  curl1: ['B', 2],        // 第一卷热气
  wingR: ['B', 4],        // 热气顶端张开成右翼尖 = 鸟成形
  body: ['B', 5],         // 鸟身
  wingL: ['B', 6],        // 左翼尖
  c0: ['C', 0],           // 鸟俯冲落到第一栋楼的屋角 = 城市段开始
  c1: ['C', 1], c2: ['C', 2], c3: ['C', 3], c4: ['C', 4],
  c5: ['C', 5], c6: ['C', 6], c7: ['C', 7], c8: ['C', 8], c9: ['C', 9],
  stop: ['S', 0],         // 笔停：静默开始
  resume: ['D', 0],       // 重新落笔：全片最重要的一声
  nape: ['D', 1],
  collar: ['D', 2],
  chin: ['D', 3],
  smile: ['D', 4],        // 嘴角上扬（最慢的一笔）
  nose: ['D', 5],
  eye: ['D', 6],          // 笑眼
  close: ['D', 7],        // 额头与天际线合拢：最后一笔
};
export const HT = Object.fromEntries(Object.entries(HIT).map(([k, [s, b]]) => [k, B(s, b)]));

// 落款「早安」
export const SIGN = { t0: B('E', 0) - 0.125, write: 0.55, text: '早安' };
