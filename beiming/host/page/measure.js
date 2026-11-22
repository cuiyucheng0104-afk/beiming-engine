// 宿主量元数据用的算式：投影到屏幕、实体的包围盒和平面深度、画面统计。
// 纯函数，只收数组，不碰渲染库；页面里用，node 里测。矩阵是 16 个数、列主序。

// 点按下标取，不解构：解构走迭代器
const mulPoint = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
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
 * 三个有限的数抄成普通数组，不是就交 null：数组，正好下标 0、1、2 三个自有的、可枚举的数据属性。只看属性描述符：带空位的（every 会跳过空位）、
 * 索引上是取值器的（一次都不执行）、继承来的、多出键的都不算。抄的就是判过的那三个描述符的值，不展开、不解构、不调数组的方法：
 * Array 子类可以把迭代器改成只交前两项，展开会丢 Z。每个下标只读一次描述符，判的和抄的是同一个值。
 */
function xyzOf(v) {
  try {
    if (!Array.isArray(v) || v.length !== 3 || Reflect.ownKeys(v).length !== 4) return null;
    const d = [0, 1, 2].map((i) => Object.getOwnPropertyDescriptor(v, i));
    return d.every((x) => x !== undefined && 'value' in x && x.enumerable && Number.isFinite(x.value)) ? [d[0].value, d[1].value, d[2].value] : null;
  } catch { return null; } // Proxy 的陷阱抛了（或者代理已经撤销）：当成不是
}

/** 是不是三个有限的数（判法见 xyzOf） */
export const isXyz = (v) => xyzOf(v) !== null;

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
    const at = xyzOf(world);
    if (!at) throw new Error(`锚点 ${key} 的世界坐标必须是三个有限的数`);
    if (seen.has(key)) throw new Error(`锚点 ${key} 交了两次`);
    seen.add(key);
    const { screen, w } = toScreen(view, proj, size, at);
    if (Math.abs(w) <= 1e-12 || !screen.every(Number.isFinite)) throw new Error(`锚点 ${key} 落在相机平面上（透视除法的除数是 ${w}），投不到有限的屏幕坐标`);
    byEntity.set(entity, [...(byEntity.get(entity) ?? []), [name, { world: at, screen }]]);
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

// 一次场景查询最多交回几项（帧源接口契约 F9）
const QUERY_MAX = 50;
// 按码点比，和 UTF-8 字节序是同一个次序。JS 的 < 按 UTF-16 码元比，会把 U+10000 起的字符（代理对，0xD800 打头）排到 U+E000 前面
const byCodePoint = (x, y) => {
  const a = [...x], b = [...y];
  for (let i = 0; i < a.length && i < b.length; i++) if (a[i] !== b[i]) return a[i].codePointAt(0) - b[i].codePointAt(0);
  return a.length - b.length;
};

/**
 * 锚点查询要答的那几个锚点。pairs 同 placeAnchors；of 是问到的实体名。只收挂在 of 里的实体上的，交回 [['实体名#锚点名', [x, y, z]]]。
 * 世界坐标原样交，不过屏幕投影：落在相机平面上的锚点照交；没问到的实体上的锚点写得对不对不管，不牵连这一次查询。
 * 问到的实体上的锚点写法不对、交了两次、坐标不是三个有限的数（xyzOf：缺一项、带空位的也算），报 contract.bad-value：是镜头或卡交错了，不是查询写错了。
 */
export function pickAnchors(pairs, of) {
  const bad = (message) => Object.assign(new Error(message), { code: 'contract.bad-value' });
  const seen = new Set(), picked = [];
  for (const [key, world] of pairs) {
    const [entity, name, ...rest] = String(key).split('#');
    if (!of.includes(entity)) continue;
    if (!name || rest.length) throw bad(`锚点 ${key} 要写成「实体名#锚点名」`);
    const at = xyzOf(world);
    if (!at) throw bad(`锚点 ${key} 的世界坐标必须是三个有限的数`);
    if (seen.has(key)) throw bad(`锚点 ${key} 交了两次`);
    seen.add(key);
    picked.push([key, at]);
  }
  return picked;
}

/**
 * 场景查询的结果（帧源接口契约 3.7 的 QueryResult），坐标都是世界坐标、米，Y 向上、地面是 y = 0。subjects 按种类：
 *   bbox3d       [[实体名, 顶点]]：at 是包围盒 [minX, minY, minZ, maxX, maxY, maxZ]，value 是它的对角线长度
 *   belowGround  [[实体名, 顶点]]：只交最低顶点低于 −tol 的实体，at 是那个顶点，value 是它陷在地面以下多深
 *   anchor       [['实体名#锚点名', [x, y, z]]]：at 是锚点的位置，value 是它到世界原点的距离
 * 「最严重」（契约 5.7 还没定排法，定在这里）：value 大的在前，一样大的按 a 的 UTF-8 字节序（就是码点序）；超过 50 项只留前 50 项，truncated 写截掉几项。
 */
export function answerQuery(kind, subjects, tol = 0) {
  const items = [];
  for (const [a, data] of subjects) {
    // 锚点的三个数按下标取，不展开（展开走迭代器）
    if (kind === 'anchor') { items.push({ a, value: Math.hypot(data[0], data[1], data[2]), at: [data[0], data[1], data[2]] }); continue; }
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let low = data[0];
    for (const p of data) {
      for (let i = 0; i < 3; i++) { b[i] = Math.min(b[i], p[i]); b[i + 3] = Math.max(b[i + 3], p[i]); }
      if (p[1] < low[1]) low = p;
    }
    if (kind === 'bbox3d') items.push({ a, value: Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]), at: b });
    else if (low[1] < -tol) items.push({ a, value: -low[1], at: low });
  }
  // 非数和无穷进了 JSON 会变成 null
  const broken = items.find((i) => ![i.value, ...i.at].every(Number.isFinite));
  if (broken) throw new Error(`${kind} 查询里 ${broken.a} 的坐标不是有限的数`);
  items.sort((x, y) => y.value - x.value || byCodePoint(x.a, y.a));
  const cut = items.length - QUERY_MAX;
  // + 0 把 −0 归成 0
  return { kind, items: items.slice(0, QUERY_MAX).map((i) => ({ a: i.a, value: i.value + 0, unit: 'm', at: i.at.map((v) => v + 0) })), ...(cut > 0 ? { truncated: cut } : {}) };
}
