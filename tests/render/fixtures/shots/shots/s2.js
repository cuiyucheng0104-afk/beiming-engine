// 镜头 S2：一个随镜头内帧号下落的蓝方块。只被 main.js 引用，改它只会让 S2 的缓存失效。
export function draw(g, k, n, w, h) {
  g.fillStyle = '#3c8cc8';
  const y = Math.round(((h - 16) * k) / Math.max(1, n - 1));
  g.fillRect(w / 2 - 8, y, 16, 16);
}
