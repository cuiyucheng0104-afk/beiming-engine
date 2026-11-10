// 北冥引擎 · 原生层 · 视图数学（纯函数）：镜头分段、世界坐标 → 屏幕像素的投影、图片卡四边在屏幕上的位置、矩形重叠。
// 原生 TSX（camera.tsx）与 Node 测试 / 检查共用这一份；约定与原生运行时一致（已用渲染帧核对）：
//   相机 lookingAt(at)，上方向 +Y；透视 fov 是**竖直**视场；图片卡（ImagePlane）默认朝 +Z、不随相机转，
//   宽 = width（场景单位），高 = height 或按图片宽高比；画面坐标原点在左上、y 向下。
//
//   shotAt(t, shots)                 → { eye, at, fov, index, u }   t 秒落在哪一段、段内进度 u（已缓动）与插值后的机位
//     shots = [{ until, eye: [起, 止] | 定点, at: [起, 止] | 定点, fov: [起, 止] | 定值, ease? }, …]
//   project(p, cam, [W, H])          → { x, y, depth }      depth ≤ 0 表示在相机背后
//   cardRect({ position, width, height?, aspect? })   → 世界里卡片的四角（左下、右下、右上、左上）
//   cardOnScreen(card, cam, [W, H])  → { left, right, top, bottom }：四条边各自两个端点投影后的屏幕坐标（像素）
//   edgeVisible(seg, [W, H], margin) → 这条边（两端点连线）是否有任何部分落进画面（外扩 margin 像素）
//   screenBox(points)                → [x0, y0, x1, y1]
//   overlap(a, b)                    → 两个 [x0, y0, x1, y1] 的相交面积
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

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };

export function project(p, cam, [W, H]) {
  const f = norm(sub(cam.at, cam.eye)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
  const d = sub(p, cam.eye), depth = dot(d, f);
  const th = Math.tan((cam.fov * Math.PI) / 360);
  return { x: ((dot(d, r) / (depth * th * (W / H)) + 1) / 2) * W, y: ((1 - dot(d, u) / (depth * th)) / 2) * H, depth };
}

export function cardRect({ position: [x, y, z], width, height, aspect }) {
  const h = height ?? width / aspect, w2 = width / 2, h2 = h / 2;
  return [[x - w2, y - h2, z], [x + w2, y - h2, z], [x + w2, y + h2, z], [x - w2, y + h2, z]];
}

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
