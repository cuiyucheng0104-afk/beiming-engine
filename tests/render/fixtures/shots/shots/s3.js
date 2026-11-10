// 镜头 S3：一个随镜头内帧号放大的绿方块。只被 main.js 引用，改它只会让 S3 的缓存失效。
export function draw(g, k, n, w, h) {
  g.fillStyle = '#5ac83c';
  const s = 4 + Math.round((24 * k) / Math.max(1, n - 1));
  g.fillRect(w / 2 - s / 2, h / 2 - s / 2, s, s);
}
