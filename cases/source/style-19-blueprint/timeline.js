// 唯一时间源。90 BPM，一拍 = 16 帧（24 fps），十六分 = 4 帧：所有细分都落在整帧上。
// b12→b14 写出的渐慢（16→18→21 帧），b14→b15 延长 33 帧（静默），b15 起回到 16 帧一拍。
export const FPS = 24, BPM = 90;
export const BF = [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 210, 231,
  264, 280, 296, 312, 328, 344, 360, 376, 392, 408, 424, 440, 456];
export const END_F = 472;
export const DUR = END_F / FPS;            // 19.667 s（最后一下滴答后留 2/3 秒余音）
// 拍（可带小数）→ 帧（未取整，供平滑动画）
export function BFr(b) {
  const n = BF.length - 1;
  if (b <= 0) return b * 16;
  if (b >= n) return BF[n] + (b - n) * 16;
  const i = Math.floor(b), f = b - i;
  return BF[i] + f * (BF[i + 1] - BF[i]);
}
// 拍 → 秒（取整到帧：画面事件和声音都用它，0 ms 偏差）
export const B = b => Math.round(BFr(b)) / FPS;
export const Bs = b => BFr(b) / FPS;      // 平滑版
export const SPB = 60 / BPM;              // 0.6667 s

// 镜头（每个镜头在拍上硬切）
export const SHOTS = [
  { id: 'S1', b: 0, name: '制图·缓推' },
  { id: 'S2', b: 6, name: '标注·沿摆杆跟移' },
  { id: 'S3', b: 12, name: '图号特写·翻转横移' },
  { id: 'S4', b: 14, name: '静默·固定' },        // b14 不是硬切：S3 的横移在 b14 落定
  { id: 'S5', b: 15, name: '变真·缓推' },
  { id: 'S6', b: 19, name: '叉瓦特写·沿轮缘横移' },
  { id: 'S7', b: 23, name: '升拉·整张图纸' },
];
// 段落
export const SEC = { A: [0, 6], B: [6, 12], C: [12, 14], SIL: [14, 15], E: [15, 23], F: [23, 27] };
