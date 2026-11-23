// O10 · 相邻帧稠密光流与 LDR-FLIP。公式、坐标与汇总口径见 ../DETAILS.md。
import { Buffer } from 'node:buffer';
import { types } from 'node:util';

function need(ok, message) {
  if (!ok) throw Object.assign(new RangeError(message), { code: 'usage.bad-argument' });
}

// 先拒绝 Proxy；只从自有数据描述符取值，连报错也不把入参转成字符串。
function record(value, keys, label) {
  need(value !== null && typeof value === 'object' && !types.isProxy(value), `${label}须为普通对象`);
  const proto = Object.getPrototypeOf(value);
  need(proto === Object.prototype || proto === null, `${label}须为普通对象`);
  const copy = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    need(keys.includes(key) && Object.hasOwn(d, 'value'), `${label}含未知键或访问器`);
    copy[key] = d.value;
  }
  return copy;
}

function sequence(frames) {
  need(!types.isProxy(frames) && Array.isArray(frames) && Object.getPrototypeOf(frames) === Array.prototype &&
    frames.length >= 2 && Reflect.ownKeys(frames).length === frames.length + 1, '光流至少要两帧，序列须为密实数组');
  const images = [];
  for (let i = 0; i < frames.length; i++) {
    const d = Object.getOwnPropertyDescriptor(frames, i);
    need(d && Object.hasOwn(d, 'value'), '序列含空洞或访问器');
    const image = readFrame(d.value, false);
    if (i) need(image.width === images[0].width && image.height === images[0].height &&
      image.bytes === images[0].bytes && image.channels === images[0].channels, '光流各帧的尺寸、通道或编码不一致');
    images.push(image);
  }
  return images;
}

const pixelKeys = ['luma', 'rgb', 'rgba', 'data'];
const typedProto = Object.getPrototypeOf(Uint8Array.prototype);
const typedLength = Object.getOwnPropertyDescriptor(typedProto, 'length').get;
const typedBuffer = Object.getOwnPropertyDescriptor(typedProto, 'buffer').get;
const pixelPrototypes = [Uint8Array.prototype, Uint8ClampedArray.prototype, Float32Array.prototype, Float64Array.prototype, Buffer.prototype];
const viewMembers = [...new Set([...pixelPrototypes, typedProto, Object.prototype].flatMap(proto => Reflect.ownKeys(proto)))];
function readFrame(frame, ldr) {
  const f = record(frame, ['width', 'height', ...pixelKeys], '帧');
  const { width, height } = f;
  need(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0, '宽高须为正整数');
  const keys = pixelKeys.filter(key => Object.hasOwn(f, key));
  need(keys.length === 1, '须恰好给一个像素数组');
  const key = keys[0], data = f[key];
  need(!types.isProxy(data), '像素数组不能是 Proxy');
  const bytes = types.isUint8Array(data) || types.isUint8ClampedArray(data);
  need(bytes || types.isFloat32Array(data) || types.isFloat64Array(data), '不支持的像素数组类型');
  const size = typedLength.call(data), channels = size / (width * height);
  need([1, 3, 4].includes(channels) && (key === 'data' || channels === { luma: 1, rgb: 3, rgba: 4 }[key]), '像素数组与尺寸不符');
  need(!types.isSharedArrayBuffer(typedBuffer.call(data)), '像素缓冲须为非共享内存');
  need(pixelPrototypes.includes(Object.getPrototypeOf(data)), '像素视图须使用标准原型');
  // 把视图当二进制载荷，不枚举它的几千万个样本键（4K RGBA 会超出 V8 的 ownKeys 上限）。
  // 标准成员不得被遮蔽；其余应用自挂的元数据不是帧参数，不读取，也不执行。
  need(viewMembers.every(k => !Object.hasOwn(data, k)) && Object.getOwnPropertySymbols(data).length === 0, '像素数组含遮蔽属性');
  let peak = bytes ? 255 : 0;
  if (!bytes) for (let i = 0; i < size; i++) {
    const v = data[i];
    need(Number.isFinite(v) && (!ldr || (v >= 0 && v <= 1)), '像素值不在量测范围');
    if (channels !== 4 || i % 4 !== 3) peak = Math.max(peak, Math.abs(v));
  }
  return { width, height, data, channels, bytes, peak };
}

function integer(v, lo, hi, name) {
  need(Number.isSafeInteger(v) && v >= lo && v <= hi, `${name} 超出整数范围`);
}
const clamp = (v, hi) => Math.max(0, Math.min(v, hi));
const sum = values => values.reduce((a, b) => a + b, 0);
const quantile = (sorted, p) => sorted[Math.ceil(sorted.length * p) - 1];

function region(width, height, value) {
  if (value === undefined) return { x: 0, y: 0, width, height };
  const roi = record(value, ['x', 'y', 'width', 'height'], 'roi');
  integer(roi.x, 0, width - 1, 'roi.x');
  integer(roi.y, 0, height - 1, 'roi.y');
  integer(roi.width, 1, width - roi.x, 'roi.width');
  integer(roi.height, 1, height - roi.y, 'roi.height');
  return roi;
}

// 边界复制的单轴卷积。分两遍计算可分离核，也用于光流的抗混叠降采样。
function filterAxis(plane, w, h, weights, horizontal) {
  const result = new Float64Array(plane.length), r = (weights.length - 1) / 2;
  const lines = horizontal ? h : w, length = horizontal ? w : h, stride = horizontal ? 1 : w;
  for (let line = 0; line < lines; line++) {
    const start = horizontal ? line * w : line;
    for (let x = 0; x < length; x++) {
      let total = 0;
      for (let k = -r; k <= r; k++) total += weights[k + r] * plane[start + clamp(x + k, length - 1) * stride];
      result[start + x * stride] = total;
    }
  }
  return result;
}
function filtered(plane, w, h, kernel) {
  return filterAxis(filterAxis(plane, w, h, kernel, true), w, h, kernel, false);
}

function pyramid(image, scale, levels, radius) {
  let { width, height } = image;
  const { data, channels } = image;
  let pixels = new Float64Array(width * height);
  for (let p = 0; p < pixels.length; p++) {
    const i = p * channels;
    pixels[p] = channels === 1 ? data[i] / scale :
      0.2126 * (data[i] / scale) + 0.7152 * (data[i + 1] / scale) + 0.0722 * (data[i + 2] / scale);
  }
  const result = [];
  for (;;) {
    const smooth = filtered(pixels, width, height, [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16]);
    result.push({ width, height, pixels, smooth });
    if (result.length >= levels || Math.min(width, height) < 2 * (2 * radius + 1)) return result;
    const stride = width;
    width = Math.ceil(width / 2);
    height = Math.ceil(height / 2);
    pixels = new Float64Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels[y * width + x] = smooth[2 * (y * stride + x)];
  }
}

function sample(a, w, h, x, y) {
  x = clamp(x, w - 1);
  y = clamp(y, h - 1);
  const ix = Math.floor(x), iy = Math.floor(y), tx = x - ix, ty = y - iy;
  const p = iy * w + ix, right = ix + 1 < w ? 1 : 0, down = iy + 1 < h ? w : 0;
  return (1 - ty) * ((1 - tx) * a[p] + tx * a[p + right]) + ty * ((1 - tx) * a[p + down] + tx * a[p + right + down]);
}

// 裁去画面外的观测，从窗口两端成对相加。镜像后各对加数互换，全零窗口精确为零。
function sumWindowAxis(input, output, w, h, radius, horizontal) {
  const length = horizontal ? w : h, stride = horizontal ? 1 : w;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, pos = horizontal ? x : y;
    let lo = i - stride * Math.min(radius, pos), hi = i + stride * Math.min(radius, length - 1 - pos);
    let total = 0;
    for (; lo < hi; lo += stride, hi -= stride) total += input[lo] + input[hi];
    output[i] = lo === hi ? total + input[lo] : total;
  }
}
function boxSum(a, tmp, w, h, radius) {
  sumWindowAxis(a, tmp, w, h, radius, true);
  sumWindowAxis(tmp, a, w, h, radius, false);
}

function flowLevel(ref, test, coarse, radius, iterations) {
  const { width: w, height: h, smooth: a } = ref, b = test.smooth, n = a.length;
  const dx = new Float64Array(n), dy = new Float64Array(n);
  const gx = filterAxis(b, w, h, [-0.5, 0, 0.5], true), gy = filterAxis(b, w, h, [-0.5, 0, 0.5], false);
  const terms = Array.from({ length: 5 }, () => new Float64Array(n));
  const [xx, xy, yy, xt, yt] = terms, tmp = new Float64Array(n);
  // 用本层低通前的亮度标记支持域，防止滤波或粗层位移把物体边缘扩散进静止平背景。
  const raw = test.pixels;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, v = raw[i];
    xx[i] = Number(ref.pixels[i] !== v || (x > 0 && raw[i - 1] !== v) || (x + 1 < w && raw[i + 1] !== v) ||
      (y > 0 && raw[i - w] !== v) || (y + 1 < h && raw[i + w] !== v));
  }
  boxSum(xx, tmp, w, h, radius);
  const active = Uint8Array.from(xx, count => Number(count > 0));
  if (coarse) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!active[i]) continue;
    dx[i] = 2 * sample(coarse.dx, coarse.width, coarse.height, x / 2, y / 2);
    dy[i] = 2 * sample(coarse.dy, coarse.width, coarse.height, x / 2, y / 2);
  }
  const ridgeFloor = 1e-6 * (2 * radius + 1) ** 2;
  for (let step = 0; step < iterations; step++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, sx = x + dx[i], sy = y + dy[i];
      if (sx < 0 || sx > w - 1 || sy < 0 || sy > h - 1) {
        xx[i] = xy[i] = yy[i] = xt[i] = yt[i] = 0;
        continue;
      }
      const ix = sample(gx, w, h, sx, sy), iy = sample(gy, w, h, sx, sy);
      // 在各自的位移处线性化，再对窗口内同一未知向量 v 求解 ∇I·v ≈ t。
      const t = a[i] - sample(b, w, h, sx, sy) + ix * dx[i] + iy * dy[i];
      xx[i] = ix * ix; xy[i] = ix * iy; yy[i] = iy * iy;
      xt[i] = ix * t; yt[i] = iy * t;
    }
    for (const term of terms) boxSum(term, tmp, w, h, radius);
    let largest = 0;
    for (let i = 0; i < n; i++) {
      const trace = xx[i] + yy[i];
      if (!active[i] || trace <= 1e-14) {
        dx[i] = dy[i] = 0;
        continue;
      }
      // 弱特征方向至少有 trace/32 的约束，抑制孔径问题，同时保留双向纹理的亚像素精度。
      const weak = (trace - Math.hypot(xx[i] - yy[i], 2 * xy[i])) / 2;
      const ridge = Math.max(ridgeFloor, 1e-3 * trace, trace / 32 - weak);
      const a11 = xx[i] + ridge, a22 = yy[i] + ridge;
      const det = a11 * a22 - xy[i] * xy[i];
      const u = (a22 * xt[i] - xy[i] * yt[i]) / det - dx[i];
      const v = (a11 * yt[i] - xy[i] * xt[i]) / det - dy[i];
      const length = Math.hypot(u, v), damping = 1 / Math.max(1, length);
      dx[i] += u * damping; dy[i] += v * damping;
      largest = Math.max(largest, length);
    }
    if (largest < 1e-4) break;
  }
  return { width: w, height: h, dx, dy };
}

function spectrum(curve, fps) {
  const n = curve.length, bins = [];
  const weights = curve.map((_, i) => n < 3 ? 1 : (1 - Math.cos(2 * Math.PI * i / n)) / 2);
  const weight = sum(weights), base = curve[0].meanMag;
  // 先减首项，再求均值。常量序列严格为零，即使原值不能精确累加。
  const delta = curve.map(pair => pair.meanMag - base), dc = sum(delta) / n;
  const signal = delta.map((d, i) => (d - dc) * weights[i]);
  let peak = 0, dominantIndex = null, spectralEnergy = 0;
  for (let k = 0; k <= Math.floor(n / 2); k++) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const angle = 2 * Math.PI * k * i / n;
      re += signal[i] * Math.cos(angle); im -= signal[i] * Math.sin(angle);
    }
    const side = k === 0 || 2 * k === n ? 1 : 2, amplitude = side * Math.hypot(re, im) / weight;
    bins.push({ index: k, freqHz: fps === undefined ? null : k / n * fps, amplitude });
    spectralEnergy += amplitude ** 2 / side;
    if (k > 0 && amplitude > peak) { peak = amplitude; dominantIndex = k; }
  }
  return { bins, dominantIndex, dominantFreqHz: dominantIndex === null ? null : bins[dominantIndex].freqHz, spectralEnergy };
}

export function flowField(frames, opts = {}) {
  const { fps, windowRadius = 3, pyramidLevels = 4, iterations = 6, roi, includeFields = false } =
    record(opts, ['fps', 'windowRadius', 'pyramidLevels', 'iterations', 'roi', 'includeFields'], '光流选项');
  need(fps === undefined || (Number.isFinite(fps) && fps > 0), 'fps 须为正有限数');
  integer(windowRadius, 1, 64, 'windowRadius'); integer(pyramidLevels, 1, 32, 'pyramidLevels'); integer(iterations, 1, 64, 'iterations');
  need(typeof includeFields === 'boolean', 'includeFields 须为布尔值');
  const images = sequence(frames), { width, height } = images[0], r = region(width, height, roi);
  const curve = [], fields = [];
  let prev, previousScale, max = 0;
  for (let t = 1; t < images.length; t++) {
    const scale = Math.max(images[t - 1].peak, images[t].peak) || 1;
    if (scale !== previousScale) prev = pyramid(images[t - 1], scale, pyramidLevels, windowRadius);
    const next = pyramid(images[t], scale, pyramidLevels, windowRadius);
    previousScale = scale;
    let field;
    for (let level = prev.length - 1; level >= 0; level--) field = flowLevel(prev[level], next[level], field, windowRadius, iterations);
    const mag = new Float64Array(r.width * r.height);
    const local = includeFields ? { width: r.width, height: r.height, dx: new Float64Array(mag.length), dy: new Float64Array(mag.length) } : null;
    let sx = 0, sy = 0, total = 0;
    for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
      const i = (y + r.y) * width + x + r.x, p = y * r.width + x, dx = field.dx[i], dy = field.dy[i];
      if (local) { local.dx[p] = dx; local.dy[p] = dy; }
      mag[p] = Math.hypot(dx, dy); total += mag[p]; sx += dx; sy += dy;
    }
    if (local) fields.push(local);
    mag.sort();
    const maxMag = mag[mag.length - 1];
    curve.push({ meanMag: total / mag.length, p95Mag: quantile(mag, 0.95), maxMag, meanDx: sx / mag.length,
      meanDy: sy / mag.length, coherentAngleRad: sx || sy ? Math.atan2(sy, sx) : null });
    max = Math.max(max, maxMag);
    prev = next;
  }
  const means = curve.map(pair => pair.meanMag), mean = sum(means) / means.length;
  return { metric: 'metric:flow.field', value: mean, unit: 'px/frame', curve, mean, p95: quantile(means.sort((a, b) => a - b), 0.95),
    max, spectrum: spectrum(curve, fps), ...(includeFields ? { fields } : {}) };
}

// Andersson 等，FLIP (HPG 2020)。这里用归一化的 XYZ/D65：对手空间的常数偏移与倍率
// 在单位和卷积及其逆变换里抵消，故直接滤 Y、X/Xn−Y、Y−Z/Zn（特征分支也直接用 Y）。
const XN = 0.9504285453771807, ZN = 1.0889003707981277;
const cieX = (r, g, b) => (10135552 * r + 8788810 * g + 4435075 * b) / (24577794 * XN);
const cieY = (r, g, b) => (2613072 * r + 8788810 * g + 887015 * b) / 12288897;
const cieZ = (r, g, b) => (1425312 * r + 8788810 * g + 70074185 * b) / (73733382 * ZN);
const labF = t => t > (6 / 29) ** 3 ? Math.cbrt(t) : t / (3 * (6 / 29) ** 2) + 4 / 29;
function huntLab(r, g, b) {
  const fy = labF(cieY(r, g, b)), light = 116 * fy - 16;
  return [light, 5 * light * (labF(cieX(r, g, b)) - fy), 2 * light * (fy - labF(cieZ(r, g, b)))];
}
const hyab = (l, a, b) => Math.abs(l) + Math.hypot(a, b);
const green = huntLab(0, 1, 0), blue = huntLab(0, 0, 1);
const maxColor = hyab(green[0] - blue[0], green[1] - blue[1], green[2] - blue[2]) ** 0.7;
const srgbToLinear = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const kernel = (radius, f) => Float64Array.from({ length: 2 * radius + 1 }, (_, i) => f(i - radius));
const normalized = (a, divisor = sum(a)) => a.map(x => x / divisor);

function flipFilters(ppd) {
  const radius = Math.ceil(3 * ppd * Math.sqrt(0.04 / 2) / Math.PI);
  const spatial = b => kernel(radius, k => Math.exp(-((Math.PI * k / ppd) ** 2) / b));
  // 蓝黄通道是两个二维高斯之和，不是先把两个一维核相加再卷积（后者会多出交叉项）。
  const zPart = (a, b) => spatial(b).map(v => v * Math.sqrt(a * Math.sqrt(Math.PI / b)));
  const z1 = zPart(34.1, 0.04), z2 = zPart(13.5, 0.025), normZ = Math.hypot(sum(z1), sum(z2));
  const csf = [normalized(spatial(0.0047)), normalized(spatial(0.0053)), normalized(z1, normZ), normalized(z2, normZ)];
  const sigma = 0.041 * ppd, r = Math.max(1, Math.ceil(3 * sigma));
  const g = kernel(r, k => k === 0 ? 1 : Math.exp(-0.5 * (k / sigma) ** 2));
  const lobes = a => {
    const pos = sum(a.filter(x => x > 0)), neg = -sum(a.filter(x => x < 0));
    return a.map(x => x === 0 ? 0 : x / (x > 0 ? pos : neg));
  };
  // r=1 时离散归一的导数与 sigma 无关；接近下溢时不除以舍入为 0 的权重。
  if (r === 1) return { csf, g: normalized(g), dg: [1, 0, -1], ddg: [0.5, -1, 0.5] };
  return { csf, g: normalized(g), dg: lobes(kernel(r, k => -k * g[k + r])),
    ddg: lobes(kernel(r, k => ((k / sigma) ** 2 - 1) * g[k + r])) };
}

function flipPlanes({ width: w, height: h, data, channels, bytes }, { csf, g, dg, ddg }, transfer) {
  const n = w * h, y = new Float64Array(n), cx = new Float64Array(n), cz = new Float64Array(n);
  const read = i => {
    const v = bytes ? data[i] / 255 : data[i];
    return transfer === 'srgb' ? srgbToLinear(v) : v;
  };
  for (let p = 0; p < n; p++) {
    const i = p * channels, red = read(i), grn = channels === 1 ? red : read(i + 1), blu = channels === 1 ? red : read(i + 2);
    y[p] = cieY(red, grn, blu); cx[p] = cieX(red, grn, blu) - y[p]; cz[p] = y[p] - cieZ(red, grn, blu);
  }
  const smoothX = filterAxis(y, w, h, g, true);
  const feature = derivative => {
    const dx = filterAxis(filterAxis(y, w, h, derivative, true), w, h, g, false);
    const dy = filterAxis(smoothX, w, h, derivative, false);
    for (let p = 0; p < n; p++) dx[p] = Math.hypot(dx[p], dy[p]);
    return dx;
  };
  const edge = feature(dg), point = feature(ddg);
  const light = filtered(y, w, h, csf[0]), a = filtered(cx, w, h, csf[1]);
  const b = filtered(cz, w, h, csf[2]), extra = filtered(cz, w, h, csf[3]);
  for (let p = 0; p < n; p++) {
    const Y = light[p], X = (Y + a[p]) * XN, Z = (Y - b[p] - extra[p]) * ZN;
    // 每个对手通道有自己的宽度，滤后可能越出 RGB 色域；先裁线性 RGB，再转 Hunt Lab。
    const lab = huntLab(clamp(3.241003275 * X - 1.537398934 * Y - 0.498615861 * Z, 1),
      clamp(-0.969224334 * X + 1.875930071 * Y + 0.041554224 * Z, 1),
      clamp(0.055639423 * X - 0.204011202 * Y + 1.057148933 * Z, 1));
    light[p] = lab[0]; a[p] = lab[1]; b[p] = lab[2];
  }
  return { light, a, b, edge, point };
}

function viewingDensity({ ppd, distanceM, monitorWidthM, resolutionX }) {
  if ([distanceM, monitorWidthM, resolutionX].some(v => v !== undefined)) {
    need(ppd === undefined && Number.isFinite(distanceM) && distanceM > 0 && Number.isFinite(monitorWidthM) && monitorWidthM > 0 &&
      Number.isSafeInteger(resolutionX) && resolutionX > 0, '需完整给出观看距离、屏宽、横向分辨率，不能与 ppd 并用');
    ppd = (distanceM / monitorWidthM) * resolutionX * (Math.PI / 180);
  }
  if (ppd === undefined) ppd = 3840 * (Math.PI / 180);
  need(Number.isFinite(ppd) && ppd > 0 && ppd <= 2048, 'ppd 须在 (0, 2048] 内');
  return ppd;
}

export function imageFlip(reference, test, opts = {}) {
  const options = record(opts, ['ppd', 'distanceM', 'monitorWidthM', 'resolutionX', 'includeMap', 'threshold', 'transfer'], 'FLIP 选项');
  const { includeMap = false, threshold, transfer = 'srgb' } = options, ppd = viewingDensity(options);
  need(typeof includeMap === 'boolean' && (transfer === 'srgb' || transfer === 'linear'), '无效的 includeMap 或 transfer');
  need(threshold === undefined || (Number.isFinite(threshold) && threshold >= 0 && threshold <= 1), 'threshold 须在 [0, 1] 内');
  const ref = readFrame(reference, true), candidate = readFrame(test, true);
  need(ref.width === candidate.width && ref.height === candidate.height, 'FLIP 两帧尺寸不一致');
  const filters = flipFilters(ppd), u = flipPlanes(ref, filters, transfer), v = flipPlanes(candidate, filters, transfer);
  const map = new Float32Array(ref.width * ref.height);
  for (let i = 0; i < map.length; i++) {
    const d = hyab(u.light[i] - v.light[i], u.a[i] - v.a[i], u.b[i] - v.b[i]) ** 0.7 / maxColor;
    const ec = d < 0.4 ? d * (0.95 / 0.4) : Math.min(1, 0.95 + 0.05 * (d - 0.4) / 0.6);
    const ef = Math.sqrt(Math.min(1, Math.max(Math.abs(u.edge[i] - v.edge[i]), Math.abs(u.point[i] - v.point[i])) / Math.SQRT2));
    map[i] = ec ** (1 - ef);
  }
  const total = sum(map), mean = total / map.length, sorted = (includeMap ? map.slice() : map).sort();
  const weighted = fraction => {
    let cumulative = 0;
    for (const value of sorted) { cumulative += value; if (cumulative >= fraction * total) return value; }
    return sorted[sorted.length - 1];
  };
  return { metric: 'metric:image.flip', value: mean, unit: 'FLIP', ppd, mean, weightedMedian: weighted(0.5),
    q1: weighted(0.25), q3: weighted(0.75), p95: quantile(sorted, 0.95), max: sorted[sorted.length - 1],
    ...(threshold === undefined ? {} : { threshold, pass: mean <= threshold }), ...(includeMap ? { map } : {}) };
}

export const FLOW_FLIP_METRICS = Object.freeze({ 'flow.field': flowField, 'image.flip': imageFlip });
export function runFlowFlipMetric(name, ...args) {
  const key = typeof name === 'string' ? name.replace(/^metric:/, '') : '';
  need(Object.hasOwn(FLOW_FLIP_METRICS, key), '未知光流或感知差异指标');
  return FLOW_FLIP_METRICS[key](...args);
}
