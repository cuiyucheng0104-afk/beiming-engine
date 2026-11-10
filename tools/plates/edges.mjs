// 底板四条边的 alpha 分析：哪条边是硬截断（贴着图边仍不透明）、哪条边是「直线淡出」（被画幅截断后做的竖直或水平渐隐，
// 合成到深色底上看得见一条笔直的软边——审计 CRAFT-03 里 clouds_front_a/b、clouds_back 的问题）。
//   analyzeEdges(img, opts) → { opaque, sides: { left|right|top|bottom: { outerMax, hardRows, crossings, cover, std, median, straight, hard } } }
//     img      decodePng 的结果 { width, height, data: RGBA }
//     outerMax 最外一圈像素的最大 alpha（0..1）
//     hard     outerMax > alphaHard（默认 0.02）：这条边贴着图边就不透明，是截断边，必须留在画外或被盖住
//     crossings / cover / std / median    逐行（左右边）或逐列（上下边）从边往里找 alpha 第一次 ≥ 0.5 的位置：
//              有交点的行数、占全高（全宽）的比例、交点位置的标准差与中位数（像素）
//     line     交点落在中位数 ± band 以内的行占全高的比例（band = max(3, 扫描深度 × 0.012) 像素：3548 宽的原图左右边约 ±21 px；
//              按「往里量的方向」的尺寸缩放，小图、大图判据一致）
//     straight line ≥ fadeCover（默认 0.3）且 median > 0：至少三成的行在同一条直线附近淡出
// 判据出自审计复核（register.json CRAFT-03 的 verify_note：alpha = 0.5 交叉列近乎一条竖线、覆盖 > 30% 行高）。
// 用「落在中位线附近的比例」而不是整体标准差：云片上下两端的轮廓是弯的，会把整体标准差拉大，掩盖中段那条直边。
// 纯函数。
export function analyzeEdges(img, { alphaHard = 0.02, fadeCover = 0.3 } = {}) {
  const { width: W, height: H, data } = img;
  const A = (x, y) => data[(y * W + x) * 4 + 3];
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { opaque = false; break; }
  const side = (n, len, at) => {   // n 条扫描线，每条从边往里最多 len 像素；at(i, k) = 第 i 条线往里第 k 个像素的 alpha
    let outerMax = 0, hardRows = 0;
    const xs = [];
    for (let i = 0; i < n; i++) {
      const a0 = at(i, 0);
      if (a0 > outerMax) outerMax = a0;
      for (let k = 0; k < len; k++) {
        if (at(i, k) >= 128) { if (k === 0) hardRows++; else xs.push(k); break; }
      }
    }
    const cover = xs.length / n;
    const mean = xs.reduce((s, v) => s + v, 0) / (xs.length || 1);
    const std = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (xs.length || 1));
    const sorted = [...xs].sort((a, b) => a - b), median = sorted.length ? sorted[sorted.length >> 1] : null;
    const band = Math.max(3, Math.round(len * 0.012));
    const line = median === null ? 0 : xs.filter(v => Math.abs(v - median) <= band).length / n;
    const om = outerMax / 255;
    return {
      outerMax: +om.toFixed(4), hardRows, crossings: xs.length, cover: +cover.toFixed(4), std: +std.toFixed(2), median, band, line: +line.toFixed(4),
      hard: om > alphaHard, straight: line >= fadeCover && median > 0,
    };
  };
  return {
    opaque,
    sides: {
      left: side(H, W >> 1, (y, k) => A(k, y)),
      right: side(H, W >> 1, (y, k) => A(W - 1 - k, y)),
      top: side(W, H >> 1, (x, k) => A(x, k)),
      bottom: side(W, H >> 1, (x, k) => A(x, H - 1 - k)),
    },
  };
}
