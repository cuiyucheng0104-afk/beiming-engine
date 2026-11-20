// camera.spline：相机沿关键位置之间的三次埃尔米特样条走，每个时刻朝向看向点。纯函数，按 f + sub 现算。
// 坐标：世界坐标，米，右手系，Y 向上；相机朝自己的 −Z 看。四元数写成 [x, y, z, w]。

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const mix = (a, b, u) => a + (b - a) * u;

/** 看向点：写的是坐标就用它；写的是实体名就取 inputs.bbox 里这个实体第 f 帧世界包围盒 [x0, y0, z0, x1, y1, z1] 的中心 */
function lookPoint(inputs, look, f) {
  if (Array.isArray(look)) return look;
  const box = inputs.bbox?.[look]?.[f];
  if (!box) throw new Error(`camera.spline 要看向实体 ${look}，inputs.bbox 里没有它第 ${f} 帧的世界包围盒`);
  return [(box[0] + box[3]) / 2, (box[1] + box[4]) / 2, (box[2] + box[5]) / 2];
}

/** 旋转矩阵的三列（相机的 X、Y、Z 轴在世界里的方向）换成四元数 [x, y, z, w] */
function quatOf(x, y, z) {
  const trace = x[0] + y[1] + z[2];
  if (trace > 0) { const s = 2 * Math.sqrt(trace + 1); return [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4]; }
  if (x[0] > y[1] && x[0] > z[2]) { const s = 2 * Math.sqrt(1 + x[0] - y[1] - z[2]); return [s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s]; }
  if (y[1] > z[2]) { const s = 2 * Math.sqrt(1 + y[1] - x[0] - z[2]); return [(y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s, (z[0] - x[2]) / s]; }
  const s = 2 * Math.sqrt(1 + z[2] - x[0] - y[1]);
  return [(z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4, (x[1] - y[0]) / s];
}

/**
 * inputs：look 写实体名时用到 bbox（{ 实体名: 逐帧的世界包围盒 }）。
 * params：keys 关键帧（结构见同目录的 keys.schema.json），按 f 严格递增；fovDeg 关键帧没写视场角时用的竖直视场角（度）。
 * 返回 { camera: { pos, quat, fovDeg } }：pos 米；quat 相机到世界的旋转 [x, y, z, w]；fovDeg 竖直视场角（度）。
 * 第一个关键帧之前、最后一个之后保持在那个关键帧上。看向点和视场角在相邻两个关键帧之间线性过渡。
 */
export function evaluate(inputs, params, f, sub) {
  const { keys } = params, t = f + sub;
  if (!Array.isArray(keys) || !keys.length) throw new RangeError('camera.spline 的 keys 至少要有一个关键帧');
  keys.forEach((k, i) => {
    if (!Number.isInteger(k.f) || k.f < 0 || (i && k.f <= keys[i - 1].f)) throw new RangeError(`camera.spline 的关键帧必须按 f 严格递增，第 ${i} 个的 f 是 ${k.f}`);
    if (!Array.isArray(k.pos) || k.pos.length !== 3 || !k.pos.every(Number.isFinite)) throw new RangeError(`camera.spline 第 ${i} 个关键帧的 pos 必须是三个数（米）`);
  });
  // 这一刻落在第 i 段（第 i 个和第 i + 1 个关键帧之间）的 u 处
  const last = keys.length - 1, i = t <= keys[0].f || !last ? 0 : t >= keys[last].f ? last - 1 : keys.findLastIndex((k) => k.f <= t);
  const a = keys[i], b = keys[Math.min(i + 1, last)], span = b.f - a.f;
  const u = span ? Math.min(1, Math.max(0, (t - a.f) / span)) : 0;
  // 切线（米每帧）：相邻两个关键帧的位置差除以帧数差，两头用单边的
  const tangent = (j) => { const p = keys[Math.max(j - 1, 0)], n = keys[Math.min(j + 1, last)]; return n.f === p.f ? [0, 0, 0] : sub3(n.pos, p.pos).map((d) => d / (n.f - p.f)); };
  const ta = tangent(i), tb = tangent(Math.min(i + 1, last));
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
  const pos = a.pos.map((_, c) => h00 * a.pos[c] + h10 * span * ta[c] + h01 * b.pos[c] + h11 * span * tb[c]);
  const la = lookPoint(inputs, a.look, f), lb = lookPoint(inputs, b.look, f), look = la.map((v, c) => mix(v, lb[c], u));

  // 相机的 Z 轴背向看向点，X 轴是世界的上方向叉 Z，Y 轴是 Z 叉 X
  const back = sub3(pos, look);
  if (!(Math.hypot(...back) > 0)) throw new RangeError(`camera.spline 在第 ${f} 帧相机和看向点重合，朝向定不出来`);
  const z = unit(back), side = cross([0, 1, 0], z);
  if (!(Math.hypot(...side) > 1e-9)) throw new RangeError(`camera.spline 在第 ${f} 帧相机在看向点的正上方或正下方，朝向定不出来`);
  const x = unit(side), y = cross(z, x);
  return { camera: { pos, quat: quatOf(x, y, z), fovDeg: mix(a.fovDeg ?? params.fovDeg, b.fovDeg ?? params.fovDeg, u) } };
}
