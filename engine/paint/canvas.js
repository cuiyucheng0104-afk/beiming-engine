// 北冥引擎 · 离屏画布：按名字复用的中间层，以及几种整层合成的写法。
//   canvasFor(key, w, h)                    取名为 key 的离屏画布；尺寸变了才重建（每帧复用，不反复分配显存）
//   clearLayer(g, T)                        把上下文恢复到默认合成状态并清空整张画布；给了 T 就再设上这个变换。
//                                           T 可以是 ctx.getTransform() 的 DOMMatrix，也可以是 engine/paint/affine.js 的 [a, b, c, d, e, f]
//                                           （直接把数组交给 setTransform 会被当成空字典，静默变成单位矩阵，所以这里先拆开）
//   blit(g, src, op)                        以单位变换把整张 src 合成到 g 上；给了 op 就用它，否则沿用 g 当前的合成方式
//   shadowOnly(ctx, img, x, y, color, blur, far)
//                                           只画 img 的投影不画 img 本身：图挪到画布外 far 处，靠 shadowOffset 把投影送回 (x, y)
//                                           （shadowOffset 不受变换影响，这里按当前缩放换算，只支持缩放 + 平移的 ctx）

const pool = new Map();

export function canvasFor(key, w, h) {
  let c = pool.get(key);
  if (!c || c.width !== w || c.height !== h) { c = document.createElement('canvas'); c.width = w; c.height = h; pool.set(key, c); }
  return c;
}

export function clearLayer(g, T) {
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1; g.filter = 'none';
  g.clearRect(0, 0, g.canvas.width, g.canvas.height);
  if (!T) return;
  if (T.length >= 6) g.setTransform(T[0], T[1], T[2], T[3], T[4], T[5]);
  else g.setTransform(T);
}

export function blit(g, src, op) {
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0); if (op) g.globalCompositeOperation = op; g.drawImage(src, 0, 0); g.restore();
}

export function shadowOnly(ctx, img, x, y, color, blur, far) {
  const m = ctx.getTransform();
  ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = blur * m.a; ctx.shadowOffsetX = far * m.a;
  ctx.drawImage(img, x - far, y); ctx.restore();
}
