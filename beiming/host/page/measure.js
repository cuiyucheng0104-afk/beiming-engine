// 宿主量元数据用的算式：投影到屏幕、实体的包围盒和平面深度、画面统计。
// 纯函数，只收数组，不碰渲染库；页面里用，node 里测。矩阵是 16 个数、列主序。

const mulPoint = (m, [x, y, z]) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
  m[3] * x + m[7] * y + m[11] * z + m[15],
];

/**
 * 世界坐标里的点投到屏幕。view 是相机到世界的矩阵的逆，proj 是投影矩阵。
 * 返回 { screen: [x, y]（像素，原点在左上角，y 向下）, depth: 平面深度（米）, w: 透视除法的除数 }。
 * 不裁剪：w 是 0（点在过相机、垂直视线的平面上）时 screen 不是有限的数；w 小于 0（点在相机后面，depth 小于 0）时照除，落点是穿过相机镜像过去的。
 */
export function toScreen(view, proj, [width, height], point) {
  const v = mulPoint(view, point);
  const c = mulPoint(proj, v);
  return { screen: [(c[0] / c[3] + 1) / 2 * width, (1 - c[1] / c[3]) / 2 * height], depth: -v[2], w: c[3] };
}

/**
 * 一个实体的屏幕包围盒、三维包围盒、屏占、平面深度范围。points 是它全部顶点的世界坐标。
 * shortcut: 屏幕包围盒逐顶点投影，不做近裁剪面的裁剪；实体跨到相机后面时读数不对，要支持时在这里加裁剪
 */
export function measureEntity(view, proj, size, points) {
  const lo = (a, b) => Math.min(a, b), hi = (a, b) => Math.max(a, b);
  const box2 = [Infinity, Infinity, -Infinity, -Infinity], box3 = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], depth = [Infinity, -Infinity];
  for (const p of points) {
    const { screen, depth: d } = toScreen(view, proj, size, p);
    box2[0] = lo(box2[0], screen[0]); box2[1] = lo(box2[1], screen[1]); box2[2] = hi(box2[2], screen[0]); box2[3] = hi(box2[3], screen[1]);
    for (let i = 0; i < 3; i++) { box3[i] = lo(box3[i], p[i]); box3[i + 3] = hi(box3[i + 3], p[i]); }
    depth[0] = lo(depth[0], d); depth[1] = hi(depth[1], d);
  }
  // 屏占：屏幕包围盒和画面求交之后的面积，除以画面面积
  const w = Math.max(0, lo(box2[2], size[0]) - hi(box2[0], 0)), h = Math.max(0, lo(box2[3], size[1]) - hi(box2[1], 0));
  return { bbox2d: box2, bbox3d: box3, pxArea: (w * h) / (size[0] * size[1]), depth };
}

/**
 * 锚点投到屏幕（每帧元数据契约 3.3、5.2）。pairs 是 [["实体名#锚点名", [x, y, z]], …]，世界坐标，米；names 是这个镜头的实体名。
 * 交回 { 实体名: { 锚点名: { world, screen } } }。写法不对、实体不认识、同一个锚点交了两次、坐标不是三个有限的数都报错，不猜。
 * 锚点落在相机平面上（w 是 0）、或者屏幕坐标算出来不是有限的数也报错：非数和无穷进了 JSON 会变成 null。相机后面的（w 小于 0）照 toScreen 的除法交。
 */
export function placeAnchors(view, proj, size, pairs, names) {
  const seen = new Set(), byEntity = new Map();
  for (const [key, world] of pairs) {
    const [entity, name, ...rest] = String(key).split('#');
    if (!name || rest.length || !names.includes(entity)) throw new Error(`锚点 ${key} 要写成「实体名#锚点名」，实体要是这个镜头的实体`);
    if (!Array.isArray(world) || world.length !== 3 || !world.every(Number.isFinite)) throw new Error(`锚点 ${key} 的世界坐标必须是三个有限的数`);
    if (seen.has(key)) throw new Error(`锚点 ${key} 交了两次`);
    seen.add(key);
    const { screen, w } = toScreen(view, proj, size, world);
    if (Math.abs(w) <= 1e-12 || !screen.every(Number.isFinite)) throw new Error(`锚点 ${key} 落在相机平面上（透视除法的除数是 ${w}），投不到有限的屏幕坐标`);
    byEntity.set(entity, [...(byEntity.get(entity) ?? []), [name, { world: [...world], screen }]]);
  }
  return Object.fromEntries([...byEntity].map(([entity, list]) => [entity, Object.fromEntries(list)]));
}

/** 亮度的第 1、50、99 百分位，在颜色层的线性编码数值上算。rgba 是每像素四个数的浮点数组；亮度用 Rec.709 的权重。 */
export function lumaStats(rgba) {
  const n = rgba.length / 4, luma = new Float32Array(n);
  for (let i = 0; i < n; i++) luma[i] = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];
  luma.sort();
  const at = (q) => luma[Math.max(0, Math.ceil(q * n) - 1)];
  return { p1: at(0.01), p50: at(0.5), p99: at(0.99) };
}

/** 显示参考镜头的溢出和压死占比：任何一个通道的线性编码值不小于 1 算溢出，三个通道都不大于 0 算压死。 */
export function clipStats(rgba) {
  const n = rgba.length / 4;
  let high = 0, low = 0;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    if (r >= 1 || g >= 1 || b >= 1) high++;
    if (r <= 0 && g <= 0 && b <= 0) low++;
  }
  return { clipHigh: high / n, clipLow: low / n };
}
