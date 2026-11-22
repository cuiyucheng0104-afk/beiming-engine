// 每个时刻只量测一帧。亮度与时间遥测使用同样的最近秩百分位。
const missing = message => Object.assign(new Error(message), { code: 'contract.missing-metric' });

function scaleOf(buffer, length) {
  if (buffer?.length !== length || !(buffer instanceof Uint8Array || buffer instanceof Float32Array)) {
    throw missing('像素须为与画幅和通道数匹配的 Uint8Array 或 Float32Array');
  }
  if (buffer instanceof Uint8Array) return 1 / 255;
  if (!buffer.every(Number.isFinite)) throw missing('像素含非有限分量');
  return 1;
}

function pixels({ rgb, referenceRgb, width, height, channels = 3 }, requested) {
  if (![width, height].every(v => Number.isSafeInteger(v) && v > 0) || ![3, 4].includes(channels)) {
    throw missing('像素量测需要正整数画幅和 3 或 4 个通道');
  }
  const count = width * height, length = count * channels;
  const scale = scaleOf(rgb, length);
  const refScale = referenceRgb === undefined ? undefined : scaleOf(referenceRgb, length);
  const compare = refScale !== undefined && requested.some(m => ['psnr', 'ssim', 'maxDiff'].includes(m));
  const luma = new Float64Array(count);
  let sum = 0, high = 0, low = 0, maxDiff = 0, squares = 0;
  // 整帧亮度 SSIM，在线累积协方差以避免近平坦帧相减消去有效位。
  let mean = 0, refMean = 0, variance = 0, refVariance = 0, covariance = 0;
  for (let i = 0, p = 0; i < count; i++, p += channels) {
    const r = rgb[p] * scale, g = rgb[p + 1] * scale, b = rgb[p + 2] * scale;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luma[i] = y;
    sum += y;
    if (Math.max(r, g, b) >= 1) high++;
    if (Math.max(r, g, b) <= 0) low++;
    if (compare) {
      for (let c = 0; c < 3; c++) {
        const diff = Math.abs(rgb[p + c] * scale - referenceRgb[p + c] * refScale);
        squares += diff * diff;
        maxDiff = Math.max(maxDiff, diff);
      }
      const refY = (0.2126 * referenceRgb[p] + 0.7152 * referenceRgb[p + 1] + 0.0722 * referenceRgb[p + 2]) * refScale;
      const dy = y - mean, dr = refY - refMean;
      mean += dy / (i + 1);
      refMean += dr / (i + 1);
      variance += dy * (y - mean);
      refVariance += dr * (refY - refMean);
      covariance += dy * (refY - refMean);
    }
  }
  luma.sort();
  const at = q => luma[Math.ceil(count * q) - 1];
  const stats = { lumaMean: sum / count, lumaMin: luma[0], lumaMax: luma.at(-1),
    lumaP05: at(0.05), lumaP50: at(0.5), lumaP95: at(0.95), lumaP99: at(0.99), contrast: at(0.95) - at(0.05),
    highlightClipRatio: high / count, shadowCrushRatio: low / count };
  if (compare) {
    stats.maxDiff = maxDiff;
    stats.psnr = squares === 0 ? 99 : -10 * Math.log10(squares / (3 * count));
    stats.ssim = (2 * mean * refMean + 0.0001) / (mean * mean + refMean * refMean + 0.0001)
      * (2 * covariance + count * 0.0009) / (variance + refVariance + count * 0.0009);
  }
  return stats;
}

const own = (obj, key) => obj != null && Object.hasOwn(obj, key) ? obj[key] : undefined;

export function measure(output, metrics) {
  const readings = Object.create(null), pending = [];
  for (const metric of metrics) {
    let value = own(output?.readings, metric);
    if (!Number.isFinite(value)) value = own(output, metric);
    if (!Number.isFinite(value)) value = metric.split('.').reduce(own, output);
    if (Number.isFinite(value)) readings[metric] = value;
    else pending.push(metric);
  }
  if (pending.length) {
    const stats = output?.rgb === undefined ? {} : pixels(output, pending);
    for (const metric of pending) {
      if (!Number.isFinite(own(stats, metric))) throw missing(`缺少有限量测值 ${metric}`);
      readings[metric] = stats[metric];
    }
  }
  return readings;
}
