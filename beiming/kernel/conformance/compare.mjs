// 量和比：读层文件、求重心、照规格逐像素求交、量累积颜色层对线性平均的预言图差多少、从编号层反算包围盒去对元数据里的。
// 都是纯函数（除了读文件），不碰渲染器。
import { readFileSync } from 'node:fs';
import { raycast } from '../../calib/check.mjs';

/** 读一个层文件（小端的原始数组）。type 是 f32 或 u32 */
export function readLayer(path, type) {
  const bytes = new Uint8Array(readFileSync(path));
  return type === 'u32' ? new Uint32Array(bytes.buffer) : new Float32Array(bytes.buffer);
}

/**
 * 画面上像素的加权重心，按像素中心算（第 x 列的中心在 x + 0.5）。weight(i) 是第 i 个像素的权重，0 表示不算。
 * 返回 { px, count }：count 是权重不为 0 的像素数，一个都没有时 px 是 null。
 */
export function centroid(width, height, weight) {
  let sx = 0, sy = 0, sw = 0, count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = Number(weight(y * width + x));
      if (!w) continue;
      sx += w * (x + 0.5); sy += w * (y + 0.5); sw += w; count++;
    }
  }
  return { px: count ? [sx / sw, sy / sw] : null, count };
}

export const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : null);

/** 画面上 inside(i) 为真的像素的外接矩形，四边各放宽 pad 个像素；一个都没有时是 null */
export function boundsOf(width, height, inside, pad = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < width * height; i++) {
    if (!inside(i)) continue;
    const x = i % width, y = (i - x) / width;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return x1 < 0 ? null : { x0: Math.max(0, x0 - pad), y0: Math.max(0, y0 - pad), x1: Math.min(width - 1, x1 + pad), y1: Math.min(height - 1, y1 + pad) };
}

/**
 * 从编号层反算一个实体的屏幕包围盒 [x0, y0, x1, y1]（像素，原点在左上角，取像素的外沿：最右一列占到 x + 1）。
 * ids 是这个实体占的编号：它自己的，加上名字以它的名字加点号开头的实体的。一个像素都不占时是 null。
 */
export function boxOfIds(width, height, layer, ids) {
  const b = boundsOf(width, height, (i) => ids.includes(layer[i]));
  return b && [b.x0, b.y0, b.x1 + 1, b.y1 + 1];
}

/** 两个矩形 [x0, y0, x1, y1] 的交并比；有一个是 null、或者并起来面积是 0 时是 null */
export function iou(a, b) {
  if (!a || !b) return null;
  const area = (r) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const inter = area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : null;
}

/**
 * 照规格求交：每个像素里 offset 那个位置（[0.5, 0.5] 是像素中心）最先打到谁。
 * ids 是 { 规格里的物体名: 编号 }；t 是帧号加子帧相位；region 给了就只算那一块，别处留 0。
 * 返回 { id, depth }：没打到是 0；depth 是平面深度（米）。
 */
export function expectedLayers(scene, t, ids, offset = [0.5, 0.5], region = null) {
  const { widthPx: w, heightPx: h } = scene.camera;
  const { x0, y0, x1, y1 } = region ?? { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
  const id = new Uint32Array(w * h), depth = new Float32Array(w * h);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const hit = raycast(scene, [x + offset[0], y + offset[1]], t)[0];
      if (hit) { id[y * w + x] = ids[hit.objectId]; depth[y * w + x] = hit.planeDepthM; }
    }
  }
  return { id, depth };
}

// 光栅化的子像素精度：OpenGL ES 3.0 只保证至少 4 位（SUBPIXEL_BITS ≥ 4），也就是十六分之一像素。
// 实际读数：在一台苹果芯片的开发机上（WebGL 2，ANGLE 的 Metal 后端）读 SUBPIXEL_BITS 得 4，和规范的下限相同；别的后端没读
export const SUBPIXEL = 1 / 16;
// 边缘带挪的 8 个位置：沿 x、沿 y 各挪负一格、零、正一格，除去不挪
const SHIFTS = [-SUBPIXEL, 0, SUBPIXEL].flatMap((dx) => [-SUBPIXEL, 0, SUBPIXEL].map((dy) => [dx, dy])).filter(([dx, dy]) => dx || dy);

/**
 * 渲出来的编号层、深度层对照规格在像素中心求交的结果。
 * idMismatch：编号不同的像素数。edgeLimit：上限，采样位置在像素中心周围挪动一个子像素精度时期望编号会变的像素数，
 * 也就是边压在像素中心上、合规的光栅化也可以判到任意一边的那些像素。offEdge：编号不同、却不在这些像素里的个数，必须是 0。
 * depthMaxDiff、depthMaxRatio：两边编号相同且打到东西的像素上，深度的最大差（米）和最大相对差。
 */
export function diffLayers(got, scene, t, ids) {
  const { widthPx: w, heightPx: h } = scene.camera;
  const want = expectedLayers(scene, t, ids);
  const region = boundsOf(w, h, (i) => want.id[i] !== 0 || got.id[i] !== 0, 2);
  const unstable = new Uint8Array(w * h);
  if (region) {
    for (const [dx, dy] of SHIFTS) {
      const moved = expectedLayers(scene, t, ids, [0.5 + dx, 0.5 + dy], region).id;
      for (let i = 0; i < moved.length; i++) if (moved[i] !== want.id[i]) unstable[i] = 1;
    }
  }
  let idMismatch = 0, offEdge = 0, edgeLimit = 0, depthMaxDiff = 0, depthMaxRatio = 0;
  for (let i = 0; i < want.id.length; i++) {
    edgeLimit += unstable[i];
    if (got.id[i] !== want.id[i]) { idMismatch++; if (!unstable[i]) offEdge++; } else if (want.id[i] !== 0) {
      const d = Math.abs(got.depth[i] - want.depth[i]);
      depthMaxDiff = Math.max(depthMaxDiff, d);
      depthMaxRatio = Math.max(depthMaxRatio, d / want.depth[i]);
    }
  }
  return { want, idMismatch, edgeLimit, offEdge, depthMaxDiff, depthMaxRatio };
}

/**
 * 一帧累积的预言：照规格在每个子帧采样时刻、每个像素中心求交。时刻照「(i + 0.5) ÷ 个数 × (快门角 ÷ 360)」自己算，不取帧源或观测点记的。
 * 返回 { hits, edge }：hits 每个时刻一张图，值是打到的物体在规格里的次序加 1，没打到是 0；
 * edge 是边缘带：只要有一个时刻，采样位置在像素中心周围挪一个子像素精度期望打到的物体会变，这个像素就算在里面。
 */
export function predictAccumulation(scene, f, angleDeg, samples) {
  const { widthPx: w, heightPx: h } = scene.camera, order = Object.fromEntries(scene.objects.map((o, i) => [o.id, i + 1]));
  const edge = new Uint8Array(w * h);
  const hits = Array.from({ length: samples }, (_, i) => {
    const t = f + ((i + 0.5) / samples) * (angleDeg / 360), want = expectedLayers(scene, t, order).id;
    const region = boundsOf(w, h, (k) => want[k] !== 0, 2);
    for (const [dx, dy] of region ? SHIFTS : []) {
      const moved = expectedLayers(scene, t, order, [0.5 + dx, 0.5 + dy], region).id;
      for (let k = 0; k < moved.length; k++) if (moved[k] !== want[k]) edge[k] = 1;
    }
    return want;
  });
  return { hits, edge };
}

/**
 * 帧源交回的累积颜色层（RGBA 浮点，场景线性），对「各时刻的预言图在线性值上取算术平均」逐像素、逐分量的最大绝对差。
 * 预言图：打到物体的像素是它的自发光值、透明度 1；没打到的是 background（[R, G, B, A]：设了背景是背景色加 1，没设是四个 0）。
 * 返回 { linearErr, wholeFrame, moving, edgePixels }：linearErr 只在边缘带之外比（边缘带里光栅化判到哪边都合规，预言图定不下来）；
 * wholeFrame 是连边缘带一起比的读数，只供对照；moving 是边缘带之外、各时刻预言不全相同的像素数，是 0 时两种平均分不出来，linearErr 是 null。
 */
export function linearError(color, scene, prediction, background) {
  const { hits, edge } = prediction, n = hits.length;
  const value = (hit, c) => (hit === 0 ? background[c] : c === 3 ? 1 : scene.objects[hit - 1].emissionLinear[c]);
  let err = 0, wholeFrame = 0, moving = 0, edgePixels = 0;
  for (let k = 0; k < edge.length; k++) {
    edgePixels += edge[k];
    if (!edge[k] && hits.some((x) => x[k] !== hits[0][k])) moving++;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (const x of hits) sum += value(x[k], c);
      const d = Math.abs(color[k * 4 + c] - sum / n);
      wholeFrame = Math.max(wholeFrame, d);
      if (!edge[k]) err = Math.max(err, d);
    }
  }
  return { linearErr: moving ? err : null, wholeFrame, moving, edgePixels };
}
