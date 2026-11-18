// 量和比：读层文件、求重心、照规格逐像素求交、判颜色层是哪种平均、量辅助层取的是像素里的哪个位置。
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
 * 量辅助层取的是像素里的哪个位置：在四分之一像素的格点上各求交一遍，看哪个位置解释得了这张编号层。
 * 「解释得了」是说编号不同的像素全在那个位置的边缘带里（那个位置周围挪一个子像素精度期望编号就会变，合规的光栅化判到哪边都行）。
 * 正好一个位置解释得了才算量出来，返回它 [x, y]；一个都解释不了、不止一个解释得了（这一帧的边区分不了这几个位置）、
 * 或者场景里没东西时返回 null。只比有东西的那一块。
 */
export function measurePixelOffset(gotId, scene, t, ids) {
  const { widthPx: w, heightPx: h } = scene.camera;
  const region = boundsOf(w, h, (i) => gotId[i] !== 0, 3);
  if (!region) return null;
  const idAt = (px, py) => ids[raycast(scene, [px, py], t)[0]?.objectId] ?? 0;
  const fits = [];
  for (const ox of [0.25, 0.5, 0.75]) {
    for (const oy of [0.25, 0.5, 0.75]) {
      const want = expectedLayers(scene, t, ids, [ox, oy], region).id;
      let miss = 0;
      for (let y = region.y0; y <= region.y1 && !miss; y++) {
        for (let x = region.x0; x <= region.x1 && !miss; x++) {
          const i = y * w + x;
          if (want[i] !== gotId[i] && SHIFTS.every(([dx, dy]) => idAt(x + ox + dx, y + oy + dy) === want[i])) miss++;
        }
      }
      if (!miss) fits.push([ox, oy]);
    }
  }
  return fits.length === 1 ? fits[0] : null;
}

const encode = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
const decode = (y) => (y <= 0.04045 ? y / 12.92 : ((y + 0.055) / 1.055) ** 2.4);

/**
 * 判一张累积出来的颜色层是哪种平均。result 是帧源交回的累积结果，singles 是同一帧各个子帧单独渲出来的颜色层（都是 RGBA 浮点）。
 * 自己算两种：在线性光里取算术平均；先做 sRGB 编码、在编码值上平均、再解码。只在两种算法差得出来的数上比（拖影边缘）。
 * 返回 { average, distinguishing, maxErrLinear, maxErrEncoded }：average 是 linear、encoded，两个都对不上或者没有分得出的数时是 null。
 */
export function classifyAverage(result, singles) {
  const n = singles.length, close = (got, want) => Math.abs(got - want) <= 1e-6 + 1e-5 * Math.abs(want);
  let distinguishing = 0, maxErrLinear = 0, maxErrEncoded = 0, linear = true, encoded = true;
  for (let i = 0; i < result.length; i++) {
    if (i % 4 === 3) continue; // 透明度不是颜色，不做编码
    let sum = 0, sumEncoded = 0;
    for (const s of singles) { sum += s[i]; sumEncoded += encode(s[i]); }
    const lin = sum / n, enc = decode(sumEncoded / n);
    if (Math.abs(lin - enc) <= 1e-3 * Math.abs(lin)) continue;
    distinguishing++;
    maxErrLinear = Math.max(maxErrLinear, Math.abs(result[i] - lin));
    maxErrEncoded = Math.max(maxErrEncoded, Math.abs(result[i] - enc));
    linear &&= close(result[i], lin);
    encoded &&= close(result[i], enc);
  }
  return { average: !distinguishing ? null : linear ? 'linear' : encoded ? 'encoded' : null, distinguishing, maxErrLinear, maxErrEncoded };
}
