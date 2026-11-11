// 三个镜头共用的底色（改它所有镜头都要重渲）。
export function background(g, w, h) {
  g.fillStyle = '#20242c';
  g.fillRect(0, 0, w, h);
}
