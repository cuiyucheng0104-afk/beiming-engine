// 北冥引擎 · 显示层的小部件路径与屏幕固定元素的浮动。路径函数只往 ctx 里加子路径，描边、填充由调用方做。
//   roundRect(ctx, x, y, w, h, r)          圆角矩形（r 自动收到不超过半宽、半高）
//   brackets(ctx, H, arm)                  以原点为中心、半边长 H 的四角括号，每个角两条臂长 arm（识别框、取景框）
//   arcGap(ctx, x, y, R, a0, a1, gc, gh)   从 a0 到 a1 的圆弧，在角度 gc ± gh 处断开（给图标让位，不用擦除合成）
//   swayOffset(head, h, { fov, gain })     头部微晃 head = { yaw, pitch }（弧度）时，屏幕固定元素的反向浮动 → { x, y } 像素；
//                                          fov 竖直视场（度，默认 38），gain 浮动增益（默认 0.18）

export function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

export function brackets(ctx, H, arm) {
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    ctx.moveTo(sx * H, sy * (H - arm)); ctx.lineTo(sx * H, sy * H); ctx.lineTo(sx * (H - arm), sy * H);
  }
}

export function arcGap(ctx, x, y, R, s0, s1, gc, gh) {
  const cuts = [[gc - gh, gc + gh], [gc - gh + 2 * Math.PI, gc + gh + 2 * Math.PI], [gc - gh - 2 * Math.PI, gc + gh - 2 * Math.PI]];
  let segs = [[s0, s1]];
  for (const [c0, c1] of cuts) segs = segs.flatMap(([u, v]) => (c1 <= u || c0 >= v) ? [[u, v]] : [[u, Math.max(u, c0)], [Math.min(v, c1), v]].filter(([m, n]) => n - m > 1e-3));
  for (const [u, v] of segs) { ctx.moveTo(x + R * Math.cos(u), y + R * Math.sin(u)); ctx.arc(x, y, R, u, v); }
}

export function swayOffset(head, h, { fov = 38, gain = 0.18 } = {}) {
  const F = (h / 2) / Math.tan(fov / 2 * Math.PI / 180);
  const yaw = head?.yaw || 0, pitch = head?.pitch || 0;
  return { x: yaw * F * gain, y: pitch * F * gain };
}
