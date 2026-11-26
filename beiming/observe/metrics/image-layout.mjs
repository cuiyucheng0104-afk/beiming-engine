import { srgbToLab, deltaE00 } from './perceptual.mjs';

// 输入 RGBA8 为显示空间 sRGB，三个色分量按原码值量测。坐标原点在左上。
function check(ok, message) { if (!ok) throw new RangeError(message); }
function image({ width, height, rgba }) {
  check(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0 &&
    rgba instanceof Uint8Array && rgba.length === width * height * 4, '无效 RGBA 帧');
}
function rgb(color) {
  check(color?.length === 3 && color.every(c => Number.isInteger(c) && c >= 0 && c <= 255), '无效 RGB 色值');
}
function tolerance(tol) { check(Number.isFinite(tol) && tol >= 0 && tol <= 255, '无效色值容差'); }
function difference(data, i, color) {
  return Math.max(Math.abs(data[i] - color[0]), Math.abs(data[i + 1] - color[1]), Math.abs(data[i + 2] - color[2]));
}

// regions 的 x/y/width/height 单位为像素。lines 的 axis 为法向轴，start/end 为切向半开区间。
export function layoutEdges(frame, { regions = [], lines = [], tol = 0 } = {}) {
  image(frame);
  tolerance(tol);
  const { width, height, rgba } = frame;
  const failed = new Uint8Array(width * height);
  function rectangle({ x, y, width: w, height: h, color }) {
    rgb(color);
    check([x, y, w, h].every(Number.isInteger) && x >= 0 && y >= 0 && w > 0 && h > 0 &&
      x + w <= width && y + h <= height, '矩形超出画面');
    let mismatch = 0, maxError = 0;
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const pixel = row * width + col;
      const diff = difference(rgba, pixel * 4, color);
      maxError = Math.max(maxError, diff);
      if (diff > tol) { failed[pixel] = 1; mismatch++; }
    }
    return { mismatch, maxError };
  }
  const rectangles = regions.map(rectangle);
  const separators = lines.map(({ axis, position, start = 0, end = axis === 'x' ? height : width, color }) => {
    const vertical = axis === 'x';
    check(vertical || axis === 'y', '分隔线轴无效');
    const expected = rectangle({ color, x: vertical ? position : start, y: vertical ? start : position,
      width: vertical ? 1 : end - start, height: vertical ? end - start : 1 });
    let best = Infinity, observed = position;
    for (let p = 0; p < (vertical ? width : height); p++) {
      let error = 0;
      for (let t = start; t < end; t++) error += difference(rgba, (vertical ? t * width + p : p * width + t) * 4, color);
      if (error < best || (error === best && Math.abs(p - position) < Math.abs(observed - position))) {
        best = error; observed = p;
      }
    }
    return { ...expected, position, observed, offset: observed - position };
  });
  return { metric: 'metric:layoutEdges', value: failed.reduce((sum, n) => sum + n, 0),
    details: { regions: rectangles, lines: separators }, unit: 'px' };
}

export function pixelBbox(frame, bgColor, tol = 0) {
  image(frame); rgb(bgColor); tolerance(tol);
  const { width, height, rgba } = frame;
  let left = width, top = height, right = -1, bottom = -1, pixels = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (difference(rgba, (y * width + x) * 4, bgColor) <= tol) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
    pixels++;
  }
  const box = pixels ? [left, top, right - left + 1, bottom - top + 1] : [0, 0, 0, 0];
  return { metric: 'metric:pixelBbox', value: box, unit: 'px', details: {
    normalized: box.map((v, i) => v / (i % 2 ? height : width)),
    areaFraction: box[2] * box[3] / (width * height), pixelFraction: pixels / (width * height),
  } };
}

// 按像素频数选实际出现的主色，频数相同按 RGB 排序。value 是整帧到最近主色的平均 ΔE00。
export function colorPalette(frame, k = 6) {
  image(frame); check(Number.isInteger(k) && k >= 1, '主色数须为正整数');
  const counts = new Map(), data = frame.rgba;
  for (let i = 0; i < data.length; i += 4) {
    const key = data[i] * 65536 + data[i + 1] * 256 + data[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const colors = [...counts].sort(([a, na], [b, nb]) => nb - na || a - b);
  const unpack = n => [n >> 16, (n >> 8) & 255, n & 255];
  const palette = colors.slice(0, k).map(([key, count]) => ({ rgb: unpack(key), share: count / (data.length / 4) }));
  const labs = palette.map(p => srgbToLab(...p.rgb));
  let total = 0;
  for (let i = k; i < colors.length; i++) {
    const [key, count] = colors[i], lab = srgbToLab(...unpack(key));
    let nearest = Infinity;
    for (const center of labs) nearest = Math.min(nearest, deltaE00(lab, center));
    total += count * nearest;
  }
  return { metric: 'metric:colorPalette', value: total / (data.length / 4), details: { palette }, unit: 'deltaE00' };
}

// 以帧中心作缩放原点，估计 A 到 B 的变换。候选在重叠区按最近邻灰度平均绝对差排名。
export function motionZoomPan(grayA, grayB, width, height, { maxPan = 8,
  scales = Array.from({ length: 17 }, (_, i) => (32 + i) / 40) } = {}) {
  check([width, height].every(v => Number.isInteger(v) && v > 0) &&
    [grayA, grayB].every(g => g instanceof Uint8Array && g.length === width * height), '无效灰度帧');
  check(Number.isInteger(maxPan) && maxPan >= 0 && scales.length && scales.every(v => Number.isFinite(v) && v > 0), '无效搜索范围');
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 48));
  const samples = Math.ceil(width / step) * Math.ceil(height / step);
  let best = Infinity, magnitude = Infinity, value;
  for (const scale of scales) {
    const mx = Math.min(maxPan, width - 1), my = Math.min(maxPan, height - 1);
    for (let dy = -my; dy <= my; dy++) for (let dx = -mx; dx <= mx; dx++) {
      let sum = 0, n = 0;
      for (let y = 0; y < height; y += step) {
        const ay = Math.round((y - cy - dy) / scale + cy);
        if (ay < 0 || ay >= height) continue;
        for (let x = 0; x < width; x += step) {
          const ax = Math.round((x - cx - dx) / scale + cx);
          if (ax < 0 || ax >= width) continue;
          sum += Math.abs(grayA[ay * width + ax] - grayB[y * width + x]); n++;
        }
      }
      if (n < samples / 2) continue;
      const error = sum / n, displacement = Math.hypot(dx, dy, (scale - 1) * Math.max(1, cx, cy));
      if (error < best || (error === best && displacement < magnitude)) {
        value = { scale, dx: dx || 0, dy: dy || 0 }; best = error; magnitude = displacement;
      }
    }
  }
  check(value, '候选变换均缺少足够重叠区');
  return { metric: 'metric:motionZoomPan', value, details: { meanAbsError: best, driftPx: Math.hypot(value.dx, value.dy) }, unit: 'px/frame' };
}

export function loopClosurePsnr(firstFrame, lastFrame, secondFrame) {
  image(firstFrame);
  function psnr(other) {
    image(other);
    check(other.width === firstFrame.width && other.height === firstFrame.height, '帧尺寸不一致');
    let sum = 0;
    for (let i = 0; i < other.rgba.length; i += 4) {
      for (let c = 0; c < 3; c++) sum += (firstFrame.rgba[i + c] - other.rgba[i + c]) ** 2;
    }
    return 10 * Math.log10(255 ** 2 * other.width * other.height * 3 / sum);
  }
  return { metric: 'metric:loopClosurePsnr', value: psnr(lastFrame), details: { adjacentPsnr: psnr(secondFrame) }, unit: 'dB' };
}
