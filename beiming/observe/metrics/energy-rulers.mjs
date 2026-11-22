// 画面能量尺子与小指标（O8）：高光溢出、静止区噪声残差、边缘锯齿与闪烁、色板色差、轮廓重合度。
// 都是同步纯函数，不用随机数，同一输入重复读数逐位一致。公式与参数口径见 ../DETAILS.md。
//
// 帧：{ width, height, <像素数组> }，像素数组的键是 rgba（4 通道）、rgb（3 通道）、luma / mask / ids（单通道）
// 或 data（按 长度 / (宽 × 高) 判 1、3、4 通道），只能给一个。Uint8Array / Uint8ClampedArray 是显示空间 8 位码值，
// Float32Array / Float64Array 是场景线性值（可以大于 1）。阈值一律用输入自己的量纲。
// 坐标原点在左上；roi 是 { x, y, width, height } 整数像素框。
// 入参不对抛 RangeError，code 是冻结错误码 usage.bad-argument。
import { srgbToLab, deltaE00 } from '../../../tools/eval/lib/metrics.mjs';
import { colorPalette } from './image-layout.mjs';

function bad(message) { throw Object.assign(new RangeError(message), { code: 'usage.bad-argument' }); }
function need(ok, message) { if (!ok) bad(message); }
function number(value, name, low = 0, high = Infinity) {
  need(Number.isFinite(value) && value >= low && value <= high, `无效参数 ${name}`);
  return value;
}
function options(opts, allowed) {
  need(opts !== null && typeof opts === 'object' && !Array.isArray(opts), '选项须为对象');
  for (const key of Object.keys(opts)) need(allowed.includes(key), `未知选项 ${key}`);
  return opts;
}

const FIELDS = { rgba: 4, rgb: 3, luma: 1, mask: 1, ids: 1, data: 0 };
const BYTES = [Uint8Array, Uint8ClampedArray], FLOATS = [Float32Array, Float64Array];
const WIDE = [Uint16Array, Uint32Array, Int32Array];
const isA = (value, types) => types.some(type => value instanceof type);

// wide 为真时另收 16、32 位整数数组（编号层用）。
function read(frame, label, wide = false) {
  need(frame !== null && typeof frame === 'object', `${label}须为帧对象`);
  const { width, height } = frame;
  need(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0, `${label}宽高须为正整数`);
  const keys = Object.keys(FIELDS).filter(key => frame[key] !== undefined);
  need(keys.length === 1, `${label}须恰好给一个像素数组（rgba、rgb、luma、mask、ids、data）`);
  const data = frame[keys[0]], float = isA(data, FLOATS);
  need(float || isA(data, BYTES) || (wide && isA(data, WIDE)), `${label}的像素数组类型不支持`);
  const channels = data.length / (width * height);
  need([1, 3, 4].includes(channels) && (!FIELDS[keys[0]] || FIELDS[keys[0]] === channels), `${label}的像素数组长度与宽高不符`);
  if (float) for (let i = 0; i < data.length; i++) need(Number.isFinite(data[i]), `${label}含非有限数`);
  return { width, height, data, channels, float, scale: float ? 1 : 255 };
}

function sequence(frames, min, name) {
  need(Array.isArray(frames) && frames.length >= min, `${name} 至少要 ${min} 帧`);
  const list = frames.map((frame, i) => read(frame, `第 ${i} 帧`));
  for (const f of list) {
    need(f.width === list[0].width && f.height === list[0].height && f.channels === list[0].channels &&
      f.float === list[0].float, '各帧的尺寸、通道数或数值类型不一致');
  }
  return list;
}

function region({ width, height }, roi) {
  if (roi === undefined) return { x: 0, y: 0, width, height };
  need(roi !== null && typeof roi === 'object' && [roi.x, roi.y, roi.width, roi.height].every(Number.isInteger) &&
    roi.x >= 0 && roi.y >= 0 && roi.width > 0 && roi.height > 0 &&
    roi.x + roi.width <= width && roi.y + roi.height <= height, 'roi 须为画面内的整数像素框');
  return roi;
}

// Rec.709 亮度，裁到 roi。8 位输入直接对码值加权。
function lumaPlane({ width, data, channels }, { x, y, width: w, height: h }) {
  const out = new Float64Array(w * h);
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const i = ((y + row) * width + x + col) * channels;
    out[row * w + col] = channels === 1 ? data[i] : 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return out;
}

function median(values) {
  const v = values.sort(), n = v.length;
  return n % 2 ? v[n >> 1] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

// 任一色分量达到 threshold 的像素占比。默认阈值：8 位 254，线性浮点 1（显示白）。
// alphaMask 为 true 时只数本帧 alpha 大于 0 的像素，也可以给与画面等大的单通道数组（大于 0 计入）。
// 平顶斑块：最大分量等于全区峰值、且有四邻域同伴的像素；峰值不到阈值一半时不算。
export function clipHighlightRatio(frame, opts = {}) {
  const { threshold, roi, alphaMask } = options(opts, ['threshold', 'roi', 'alphaMask']);
  const img = read(frame, '帧'), { width, data, channels, float } = img;
  const limit = threshold === undefined ? (float ? 1 : 254)
    : number(threshold, 'threshold', float ? -Infinity : 0, float ? Infinity : 255);
  const own = alphaMask === true, external = !own && alphaMask !== undefined && alphaMask !== false;
  need(!own || channels === 4, 'alphaMask 为 true 时帧须带 alpha 通道');
  need(!external || (isA(alphaMask, [...BYTES, ...FLOATS]) && alphaMask.length === width * img.height),
    'alphaMask 须为 true 或与画面等大的单通道数组');
  const { x, y, width: w, height: h } = region(img, roi), colors = Math.min(channels, 3);
  const top = new Float64Array(w * h).fill(-Infinity), hits = [0, 0, 0];
  let total = 0, clipped = 0, peak = -Infinity;
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const p = (y + row) * width + x + col;
    if (own ? !(data[p * 4 + 3] > 0) : external && !(alphaMask[p] > 0)) continue;
    total++;
    let most = -Infinity;
    for (let c = 0; c < colors; c++) {
      const v = data[p * channels + c];
      if (v > most) most = v;
      if (v >= limit) hits[c]++;
    }
    top[row * w + col] = most;
    if (most > peak) peak = most;
    if (most >= limit) clipped++;
  }
  let plateau = 0;
  if (total && peak >= limit / 2) {
    for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
      const i = row * w + col;
      if (top[i] === peak && ((col > 0 && top[i - 1] === peak) || (col < w - 1 && top[i + 1] === peak) ||
        (row > 0 && top[i - w] === peak) || (row < h - 1 && top[i + w] === peak))) plateau++;
    }
  }
  const share = n => total ? n / total : 0, ratio = share(clipped);
  return { metric: 'metric:clip.highlight-ratio', value: ratio, unit: 'ratio', ratio, clippedPixels: clipped,
    totalPixels: total, peakMax: total ? peak : null,
    channelRatios: colors === 1 ? [ratio, ratio, ratio] : hits.map(share),
    threshold: limit, plateauPixels: plateau, plateauRatio: share(plateau) };
}

// 相邻帧亮度差 d 的四邻域拉普拉斯在静止块上的均方根，除以 √40 折算成等效的单帧白噪声标准差。
// 静止块：本块 max|d| 不超过 max(motionThreshold, 6σ)，且外圈八块也都满足；σ 取本块连同外圈一块范围内
// |拉普拉斯| 的中位数 × 1.4826 / √20（只看高频，成片的亮度变化抬不高它）。
// shortcut: 细于 2 像素的纹理整体位移和噪声在两帧里分不开，会读成噪声；要分开得另给运动真值掩码。
export function noiseResidual(frames, opts = {}) {
  const { roi, block = 8, motionThreshold } = options(opts, ['roi', 'block', 'motionThreshold']);
  const list = sequence(frames, 2, 'noiseResidual');
  const r = region(list[0], roi), w = r.width, h = r.height;
  need(Number.isInteger(block) && block >= 4 && block <= Math.min(w, h), 'block 须为 4 到量测区域短边之间的整数');
  const floor = motionThreshold === undefined ? 2 / 255 * list[0].scale : number(motionThreshold, 'motionThreshold');
  const planes = list.map(f => lumaPlane(f, r));
  const cols = Math.floor(w / block), rows = Math.floor(h / block);
  // 末行末列不足一块的余数并进最后一块。
  const extent = (bx, by) => [bx * block, bx === cols - 1 ? w : (bx + 1) * block, by * block, by === rows - 1 ? h : (by + 1) * block];
  const d = new Float64Array(w * h), lap = new Float64Array(w * h), moving = new Uint8Array(cols * rows);
  const scratch = new Float64Array((4 * block) ** 2);
  let sum = 0, count = 0, staticPixels = 0;
  for (let t = 1; t < planes.length; t++) {
    for (let i = 0; i < d.length; i++) d[i] = planes[t][i] - planes[t - 1][i];
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      lap[i] = 4 * d[i] - d[i - 1] - d[i + 1] - d[i - w] - d[i + w];
    }
    for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
      const [x0, x1, y0, y1] = extent(bx, by);
      let peak = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) peak = Math.max(peak, Math.abs(d[y * w + x]));
      for (let y = Math.max(1, y0 - block); y < Math.min(h - 1, y1 + block); y++) {
        for (let x = Math.max(1, x0 - block); x < Math.min(w - 1, x1 + block); x++) scratch[n++] = Math.abs(lap[y * w + x]);
      }
      const sigma = 1.4826 * median(scratch.subarray(0, n)) / Math.sqrt(20);
      moving[by * cols + bx] = peak > Math.max(floor, 6 * sigma) ? 1 : 0;
    }
    for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
      let still = true;
      for (let j = Math.max(0, by - 1); j <= Math.min(rows - 1, by + 1); j++) {
        for (let i = Math.max(0, bx - 1); i <= Math.min(cols - 1, bx + 1); i++) if (moving[j * cols + i]) still = false;
      }
      if (!still) continue;
      const [x0, x1, y0, y1] = extent(bx, by);
      staticPixels += (x1 - x0) * (y1 - y0);
      for (let y = Math.max(1, y0); y < Math.min(h - 1, y1); y++) {
        for (let x = Math.max(1, x0); x < Math.min(w - 1, x1); x++) { sum += lap[y * w + x] ** 2; count++; }
      }
    }
  }
  const totalPixels = w * h * (planes.length - 1);
  return { metric: 'metric:noise.residual', value: count ? Math.sqrt(sum / count / 40) : null,
    unit: list[0].float ? 'linear' : 'code8', status: count ? 'ok' : 'no-static-region',
    staticRatio: staticPixels / totalPixels, staticPixels, totalPixels, pairs: planes.length - 1,
    block, motionThreshold: floor };
}

const REACH = 6;

// 以 i 为心、沿 along 方向取半宽 R 的窗，求 across 方向相邻三行各自的窗内亮度和的二阶差分，再除以窗内极差，单位像素。
// R 从 1 起加到 REACH，取第一个两端平坦的窗（两端各两列在三行上的极差不超过 tol），保证没有边界从窗的侧面穿出；找不到回 NaN。
function wobble(L, i, along, across, tol) {
  for (let R = 1; R <= REACH; R++) {
    let flat = true;
    for (const side of [-1, 1]) {
      let lo = Infinity, hi = -Infinity;
      for (let j = -1; j <= 1; j++) for (let k = R; k <= R + 1; k++) {
        const v = L[i + j * across + side * k * along];
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
      if (hi - lo > tol) flat = false;
    }
    if (!flat) continue;
    const sums = [0, 0, 0];
    let lo = Infinity, hi = -Infinity;
    for (let j = -1; j <= 1; j++) for (let k = -R; k <= R; k++) {
      const v = L[i + j * across + k * along];
      sums[j + 1] += v; lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
    return Math.abs(sums[0] - 2 * sums[1] + sums[2]) / (hi - lo);
  }
  return NaN;
}

// 锯齿度：强边缘像素（Sobel 幅值 / 4 不低于 edgeThreshold）上，逐行（近水平的边逐列）覆盖面积的二阶差分绝对值的平均，单位像素。
// 盒滤波抗锯齿下直边、细杆每行的覆盖面积随行号线性变化，读数接近 0；点采样的阶梯读数约 2·min(s, 1 − s)，s 是每行的横移量。
// 距量测区边缘不到 REACH + 1 像素的边缘不计；数值按输入原样量，不做色彩空间换算。
// 闪烁（至少 3 帧）：任一帧里是强边缘的像素上，相邻两次帧间亮度变化反号时取较小的那次幅度，再取平均。
// shortcut: 正好 0°、45°、90° 的点采样阶梯每行面积等差，读不出锯齿；这类画面看 flicker 或换成比参考图。
export function aliasEdge(input, opts = {}) {
  const { roi, edgeThreshold } = options(opts, ['roi', 'edgeThreshold']);
  const list = Array.isArray(input) ? sequence(input, 1, 'aliasEdge') : [read(input, '帧')];
  const r = region(list[0], roi), w = r.width, h = r.height;
  const limit = edgeThreshold === undefined ? 32 / 255 * list[0].scale : number(edgeThreshold, 'edgeThreshold');
  const planes = list.map(f => lumaPlane(f, r)), detail = new Uint8Array(w * h);
  let sum = 0, edges = 0;
  for (const L of planes) {
    for (let y = REACH + 1; y < h - REACH - 1; y++) for (let x = REACH + 1; x < w - REACH - 1; x++) {
      const i = y * w + x;
      const gx = L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1] - L[i - w - 1] - 2 * L[i - 1] - L[i + w - 1];
      const gy = L[i + w - 1] + 2 * L[i + w] + L[i + w + 1] - L[i - w - 1] - 2 * L[i - w] - L[i - w + 1];
      if (gx === 0 && gy === 0 || Math.hypot(gx, gy) / 4 < limit) continue;
      detail[i] = 1;
      const step = Math.abs(gx) >= Math.abs(gy) ? wobble(L, i, 1, w, limit / 4) : wobble(L, i, w, 1, limit / 4);
      if (Number.isNaN(step)) continue;
      sum += step; edges++;
    }
  }
  let flicker = null, detailPixels = 0;
  if (planes.length >= 3) {
    let energy = 0;
    for (let i = 0; i < detail.length; i++) {
      if (!detail[i]) continue;
      detailPixels++;
      for (let t = 1; t < planes.length - 1; t++) {
        const before = planes[t][i] - planes[t - 1][i], after = planes[t + 1][i] - planes[t][i];
        if (before * after < 0) energy += Math.min(Math.abs(before), Math.abs(after));
      }
    }
    flicker = detailPixels ? energy / (detailPixels * (planes.length - 2)) : 0;
  }
  const jaggedness = edges ? sum / edges : 0;
  return { metric: 'metric:alias.edge', value: jaggedness, unit: 'px', status: edges ? 'ok' : 'no-edges', jaggedness,
    edgePixels: edges, edgeRatio: edges / (w * h * planes.length), flicker,
    flickerUnit: list[0].float ? 'linear' : 'code8', detailPixels, frames: planes.length, edgeThreshold: limit };
}

const encode = v => { const c = Math.min(1, Math.max(0, v)); return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)); };

// 色板：[r, g, b] 或 { rgb, share? } 或 { lab, share? } 的数组；给帧时用 colorPalette 取前 k 个主色。
// 线性浮点帧先截到 0 到 1 再按 sRGB 编成 8 位。
function palette(input, k, label) {
  if (!Array.isArray(input)) {
    const { width, height, data, channels, float } = read(input, label);
    const rgba = new Uint8Array(width * height * 4).fill(255);
    for (let p = 0; p < width * height; p++) for (let c = 0; c < 3; c++) {
      const v = data[p * channels + (channels === 1 ? 0 : c)];
      rgba[p * 4 + c] = float ? encode(v) : v;
    }
    return colorPalette({ width, height, rgba }, k).details.palette.map(({ rgb, share }) => ({ color: rgb, share, lab: srgbToLab(...rgb) }));
  }
  need(input.length > 0, `${label}色板不能为空`);
  const colors = input.map(entry => {
    const item = Array.isArray(entry) ? { rgb: entry } : entry;
    need(item !== null && typeof item === 'object' && (item.rgb === undefined) !== (item.lab === undefined), `${label}色板的颜色须给 rgb 或 lab 之一`);
    const { rgb, lab, share = 1 } = item, color = rgb ?? lab;
    need(Array.isArray(color) && color.length === 3 && color.every(rgb ? c => Number.isInteger(c) && c >= 0 && c <= 255 : Number.isFinite),
      `${label}色板的色值无效`);
    return { color: [...color], share: number(share, 'share'), lab: lab ? [...lab] : srgbToLab(...rgb) };
  });
  need(colors.some(c => c.share > 0), `${label}色板的 share 不能全为 0`);
  return colors;
}

// 每个颜色到对面色板最近色的 CIEDE2000 色差，按 share 归一加权。
function nearest(from, to) {
  const weightSum = from.reduce((sum, c) => sum + c.share, 0);
  let mean = 0, max = 0, weighted = 0;
  const pairs = from.map(({ color, share, lab }) => {
    let de00 = Infinity, index = 0;
    to.forEach((other, j) => { const e = deltaE00(lab, other.lab); if (e < de00) { de00 = e; index = j; } });
    mean += de00 / from.length; max = Math.max(max, de00); weighted += de00 * share / weightSum;
    return { color, share: share / weightSum, nearest: to[index].color, index, de00 };
  });
  return { meanDe00: mean, maxDe00: max, weightedDe00: weighted, pairs };
}

// 顶层的 meanDe00、maxDe00、weightedDe00、pairs 是候选的每个主色到参考色板最近色；reverse 是参考的每个色到候选。
// value 取两个方向平均色差里大的那个：多出色板外的主色、或缺了参考里的色，都会抬高它。
export function colorPaletteDe00(candidate, reference, opts = {}) {
  const { k = 6 } = options(opts, ['k']);
  need(Number.isInteger(k) && k >= 1, 'k 须为正整数');
  const a = palette(candidate, k, '候选'), b = palette(reference, k, '参考');
  const forward = nearest(a, b), reverse = nearest(b, a);
  return { metric: 'metric:color.palette-de00', value: Math.max(forward.meanDe00, reverse.meanDe00), unit: 'deltaE00',
    ...forward, reverse };
}

// 掩码来源按选项与通道数定：给 id 时读单通道编号层里等于 id 的像素；给 background 时取与背景色差超过 tol 的像素；
// 四通道帧取 alpha 大于 threshold（默认半幅）；单通道取大于 threshold（默认 0）。选项对两边同样生效。
function shape(input, label, { id, background, tol, threshold }) {
  const { width, data, channels, scale } = read(input, label, id !== undefined);
  if (id !== undefined) {
    need(channels === 1, `${label}须为单通道编号层`);
    return p => data[p] === id;
  }
  if (background !== undefined) {
    need(channels >= 3, `${label}须为彩色帧`);
    return p => Math.max(...background.map((c, k) => Math.abs(data[p * channels + k] - c))) > tol;
  }
  need(channels !== 3, `${label}是三通道帧，须给 background 才能分出前景`);
  const limit = threshold ?? (channels === 4 ? scale / 2 : 0);
  return p => data[p * channels + channels - 1] > limit;
}

// a 是候选、b 是参考：precision = 交 / a 的面积，recall = 交 / b 的面积，bboxIou 是两个紧包围盒的交并比。
// 两边都空时各比值取 emptyValue（默认 1）并置 emptyBoth；只有一边空时都是 0。
export function shapeIou(a, b, opts = {}) {
  const o = options(opts, ['roi', 'threshold', 'id', 'background', 'tol', 'emptyValue']);
  const { roi, id, background, tol = 0, threshold, emptyValue = 1 } = o;
  need(id === undefined || Number.isInteger(id), 'id 须为整数');
  need(background === undefined || (Array.isArray(background) && background.length === 3 && background.every(Number.isFinite)), 'background 须为三个有限数');
  number(tol, 'tol'); number(emptyValue, 'emptyValue', 0, 1);
  if (threshold !== undefined) number(threshold, 'threshold', -Infinity);
  need(a?.width === b?.width && a?.height === b?.height, '两边尺寸不一致');
  const inA = shape(a, '候选', { id, background, tol, threshold }), inB = shape(b, '参考', { id, background, tol, threshold });
  const { x, y, width: w, height: h } = region(a, roi);
  const boxA = [w, h, -1, -1], boxB = [w, h, -1, -1];
  const grow = (box, col, row) => { box[0] = Math.min(box[0], col); box[1] = Math.min(box[1], row); box[2] = Math.max(box[2], col); box[3] = Math.max(box[3], row); };
  let areaA = 0, areaB = 0, intersection = 0;
  for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
    const p = (y + row) * a.width + x + col, hitA = inA(p), hitB = inB(p);
    if (hitA) { areaA++; grow(boxA, col, row); }
    if (hitB) { areaB++; grow(boxB, col, row); }
    if (hitA && hitB) intersection++;
  }
  const union = areaA + areaB - intersection, emptyBoth = union === 0;
  const ratio = (n, total) => total ? n / total : emptyBoth ? emptyValue : 0;
  const area = box => Math.max(0, box[2] - box[0] + 1) * Math.max(0, box[3] - box[1] + 1);
  const overlap = area([Math.max(boxA[0], boxB[0]), Math.max(boxA[1], boxB[1]), Math.min(boxA[2], boxB[2]), Math.min(boxA[3], boxB[3])]);
  const iou = ratio(intersection, union);
  return { metric: 'metric:shape.iou', value: iou, unit: 'ratio', iou, intersection, union,
    precision: ratio(intersection, areaA), recall: ratio(intersection, areaB),
    bboxIou: areaA && areaB ? overlap / (area(boxA) + area(boxB) - overlap) : ratio(0, 0), areaA, areaB, emptyBoth };
}

// 标准指标名（题目文件 scoring[].metric 的点分小写名）到函数的登记表；带不带 metric: 前缀都认。
export const ENERGY_METRICS = Object.freeze({
  'clip.highlight-ratio': clipHighlightRatio,
  'noise.residual': noiseResidual,
  'alias.edge': aliasEdge,
  'color.palette-de00': colorPaletteDe00,
  'shape.iou': shapeIou,
});

export function runEnergyMetric(name, ...args) {
  const key = typeof name === 'string' ? name.replace(/^metric:/, '') : '';
  need(Object.hasOwn(ENERGY_METRICS, key), `未知指标 ${String(name)}`);
  return ENERGY_METRICS[key](...args);
}
