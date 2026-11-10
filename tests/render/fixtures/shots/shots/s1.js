// 镜头 S1：一个随镜头内帧号横移的红方块。只被 main.js 引用，改它只会让 S1 的缓存失效。
export function draw(g, k, n, w, h) {
  g.fillStyle = '#c84a3c';
  const x = Math.round(((w - 16) * k) / Math.max(1, n - 1));
  g.fillRect(x, h / 2 - 8, 16, 16);
}
