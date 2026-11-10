// 北冥引擎 · 原生层 · 视图数学（纯函数）：镜头分段、世界坐标 → 屏幕像素的投影、图片卡四边在屏幕上的位置、矩形重叠。
// 原生 TSX（camera.tsx）与 Node 测试 / 检查共用这一份；约定与原生运行时一致（已用渲染帧核对）：
//   相机 lookingAt(at)，上方向 +Y；透视 fov 是**竖直**视场；图片卡（ImagePlane）默认朝 +Z、不随相机转，
//   宽 = width（场景单位），高 = height 或按图片宽高比；画面坐标原点在左上、y 向下。
//
//   shotAt(t, shots)                 → { eye, at, fov, index, u }   t 秒落在哪一段、段内进度 u（已缓动）与插值后的机位
//     shots = [{ until, eye: [起, 止] | 定点, at: [起, 止] | 定点, fov: [起, 止] | 定值, ease? }, …]
//   project(p, cam, [W, H])          → { x, y, depth }      depth ≤ 0 表示在相机背后
//   cardRect({ position, width, height?, aspect?, rotation? })   → 世界里卡片的四角（左下、右下、右上、左上）；rotation 是 XYZ 欧拉角
//   faceYaw(position, eye)           → 让卡片正面朝向机位 eye 的偏航角（rotation = [0, faceYaw, 0]，按镜头摆的绘画卡片用它防「纸板感」）
//   unproject(x, y, depth, cam, [W, H]) → 屏幕像素 (x, y) 在视线深度 depth 处的世界坐标（project 的逆）
//   cardInView({ cam, left, cy, width, depth, aspect }, [W, H]) → { position, width, rotation }
//                                    按屏幕框摆卡片（routes/directing/craft/two-five-d.md §6：先定每层的屏幕矩形和深度 D，再换算成
//                                    世界坐标与宽度）：left / width 是画宽的比例（可以 < 0 或 > 1，让截断边落在画外），cy 是卡片中心
//                                    的高度比例；卡片竖直、与这个机位的画面平行（正面迎着视线），宽高比 = 原图
//   cardOnScreen(card, cam, [W, H])  → { left, right, top, bottom }：四条边各自两个端点投影后的屏幕坐标（像素）
//   edgeVisible(seg, [W, H], margin) → 这条边（两端点连线）是否有任何部分落进画面（外扩 margin 像素）
//   screenBox(points)                → [x0, y0, x1, y1]
//   overlap(a, b)                    → 两个 [x0, y0, x1, y1] 的相交面积
//   skyShift(t, shots, [W, H])       → [dx, dy]：页面层的远景天空要像「在无穷远」一样跟着镜头转——取当前这段镜头起点的视线方向，
//                                      用当前机位把无穷远处的这个方向投影到屏幕，减去画面中心。段内摇 / 仰多少，天空就反向移多少
//                                      像素（只有平移没有转动时为 0）；切到下一段归零（切镜本来就跳）。把它加到 <Backdrop> 的 x / y
//   headingYaw([vx, vy, vz])         → 绕 Y 的偏航角：让前向 +X 的模型（资产桥的约定）朝速度方向。three / 原生 XYZ 欧拉角下
//                                      R_y(θ)·(1,0,0) = (cos θ, 0, −sin θ)，所以 θ = atan2(−vz, vx)
//   behind(p, yaw, d, dy = 0)        → 船尾 / 车尾后方 d 处的点（尾迹、拖痕、烟跟着它摆，与船用同一个 yaw）
import { clamp, lerp, ss, ss5, ei, eo, eio } from '../core/math.js';

const EASES = { linear: t => t, ss, ss5, ei, eo, eio };
const isPair = v => Array.isArray(v) && Array.isArray(v[0]);
const along = (v, u) => (isPair(v) ? v[0].map((a, i) => lerp(a, v[1][i], u)) : v);
const alongN = (v, u) => (Array.isArray(v) ? lerp(v[0], v[1], u) : v);

export function shotAt(t, shots) {
  if (!shots.length) throw new RangeError('shotAt: 至少要有一段镜头');
  let index = shots.findIndex(s => t < s.until);
  if (index < 0) index = shots.length - 1;
  const s = shots[index], start = index ? shots[index - 1].until : 0;
  const ease = EASES[s.ease || 'linear'];
  if (!ease) throw new TypeError(`shotAt: 未知缓动 ${JSON.stringify(s.ease)}，可用 ${Object.keys(EASES).join(' / ')}`);
  const u = ease(clamp((t - start) / (s.until - start)));
  return { eye: along(s.eye, u), at: along(s.at, u), fov: alongN(s.fov, u), index, u };
}

// 三维向量的通用写法（逐分量；加法顺序与按分量展开的写法相同，结果逐位一致）
const sub = (a, b) => a.map((x, i) => x - b[i]);
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const cross = ([ax, ay, az], [bx, by, bz]) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
const norm = a => { const l = Math.hypot(...a); return a.map(x => x / l); };

export function project(p, cam, [W, H]) {
  const f = norm(sub(cam.at, cam.eye)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
  const d = sub(p, cam.eye), depth = dot(d, f);
  const th = Math.tan((cam.fov * Math.PI) / 360);
  return { x: ((dot(d, r) / (depth * th * (W / H)) + 1) / 2) * W, y: ((1 - dot(d, u) / (depth * th)) / 2) * H, depth };
}

// 卡片的局部 x / y 轴：XYZ 欧拉角（与 toon.tsx 的 place、原生 Transform 同一约定，R = Rx·Ry·Rz）
export function cardAxes([a = 0, b = 0, c = 0] = []) {
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  return {
    x: [cc * cb, sc * ca + cc * sb * sa, sc * sa - cc * sb * ca],
    y: [-sc * cb, cc * ca - sc * sb * sa, cc * sa + sc * sb * ca],
  };
}

export function cardRect({ position: [x, y, z], width, height, aspect, rotation }) {
  const h = height ?? width / aspect, w2 = width / 2, h2 = h / 2;
  if (!rotation) return [[x - w2, y - h2, z], [x + w2, y - h2, z], [x + w2, y + h2, z], [x - w2, y + h2, z]];
  const { x: ax, y: ay } = cardAxes(rotation);
  const at = (u, v) => [x + u * ax[0] + v * ay[0], y + u * ax[1] + v * ay[1], z + u * ax[2] + v * ay[2]];
  return [at(-w2, -h2), at(w2, -h2), at(w2, h2), at(-w2, h2)];
}

// 让卡片正面（局部 +Z）朝向某个机位：只转偏航，卡片保持竖直
export const faceYaw = (position, eye) => Math.atan2(eye[0] - position[0], eye[2] - position[2]);

export function cardOnScreen(card, cam, size) {
  const [bl, br, tr, tl] = cardRect(card).map(p => project(p, cam, size));
  return { left: [tl, bl], right: [tr, br], top: [tl, tr], bottom: [bl, br] };
}

// 线段（两端在相机前方时）与外扩后的画面矩形是否相交
export function edgeVisible([a, b], [W, H], margin = 0) {
  if (a.depth <= 0 && b.depth <= 0) return false;
  const x0 = -margin, y0 = -margin, x1 = W + margin, y1 = H + margin;
  const inside = p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  if (inside(a) || inside(b)) return true;
  // 端点都在外：按 24 段采样判断是否穿过画面（对卡片边足够）
  for (let i = 1; i < 24; i++) { const u = i / 24, p = { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u) }; if (inside(p)) return true; }
  return false;
}

export const screenBox = pts => [Math.min(...pts.map(p => p.x)), Math.min(...pts.map(p => p.y)), Math.max(...pts.map(p => p.x)), Math.max(...pts.map(p => p.y))];
export const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

export function skyShift(t, shots, [W, H]) {
  const cur = shotAt(t, shots);
  const start = cur.index ? shots[cur.index - 1].until : 0;
  const c0 = shotAt(start, shots);
  const f0 = norm(sub(c0.at, c0.eye)), far = 1e6;
  const p = project([cur.eye[0] + f0[0] * far, cur.eye[1] + f0[1] * far, cur.eye[2] + f0[2] * far], cur, [W, H]);
  return [p.x - W / 2, p.y - H / 2];
}

export const headingYaw = v => Math.atan2(-v[2], v[0]);
export const behind = (p, yaw, d, dy = 0) => [p[0] - d * Math.cos(yaw), p[1] + dy, p[2] + d * Math.sin(yaw)];

function camBasis(cam) {
  const f = norm(sub(cam.at, cam.eye)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
  return { f, r, u };
}

export function unproject(x, y, depth, cam, [W, H]) {
  const { f, r, u } = camBasis(cam), th = Math.tan((cam.fov * Math.PI) / 360);
  const a = (2 * x / W - 1) * th * (W / H) * depth, b = (1 - 2 * y / H) * th * depth;
  return [0, 1, 2].map(i => cam.eye[i] + depth * f[i] + a * r[i] + b * u[i]);
}

export function cardInView({ cam, left, cy, width, depth }, [W, H]) {
  const th = Math.tan((cam.fov * Math.PI) / 360);
  const position = unproject((left + width / 2) * W, cy * H, depth, cam, [W, H]);
  const { f } = camBasis(cam);   // 卡片与画面平行（只取视线的水平分量，卡片保持竖直）：屏幕框是准的，不随离轴位置变形
  return { position, width: width * 2 * depth * th * (W / H), rotation: [0, Math.atan2(-f[0], -f[2]), 0] };
}
