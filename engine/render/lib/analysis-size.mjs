// 渲染期和离线解码用相同的偶数画幅采样灰度帧。
export function analysisSize(w, h, maxW = 480) {
  const s = Math.min(1, maxW / w);
  const ow = Math.max(2, Math.round((w * s) / 2) * 2);
  const oh = Math.max(2, Math.round((h * s) / 2) * 2);
  return { w: ow, h: oh };
}
