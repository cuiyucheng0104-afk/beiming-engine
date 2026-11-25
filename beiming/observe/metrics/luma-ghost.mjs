// O9：显示亮度分位数与跨切点前镜渗透。内存输入同步返回；视频逐帧消费，不留整片像素。
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

function need(ok, message) {
  if (!ok) throw Object.assign(new RangeError(message), { code: 'usage.bad-argument' });
}
const frameId = n => Number.isSafeInteger(n) && n >= 0;
const clamp = n => Math.max(0, Math.min(1, n));
function options(opts, allowed) {
  need(opts !== null && typeof opts === 'object' && !Array.isArray(opts), '选项须为对象');
  for (const key of Object.keys(opts)) need(allowed.includes(key), `未知选项 ${key}`);
  for (const key of allowed.filter(k => k !== 'cuts')) {
    const v = opts[key];
    need(v === undefined || Number.isFinite(v) && v >= 0 && v <= 1, `${key} 须在 [0,1] 内`);
  }
  if (opts.cuts === undefined) return null;
  need(Array.isArray(opts.cuts), 'cuts 须为帧号数组');
  for (let i = 0; i < opts.cuts.length; i++) need(Object.hasOwn(opts.cuts, i) && frameId(opts.cuts[i]), '切点帧号无效');
  return new Set([...opts.cuts].sort((a, b) => a - b));
}

// 灰度字节不转浮点：视频直方图只有 256 桶，切点只留下两个相邻帧。
function plane(f, i) {
  need(f !== null && typeof f === 'object', '须给帧对象');
  const { width, height, data, frame = i } = f, size = width * height;
  const bytes = data instanceof Uint8Array || data instanceof Uint8ClampedArray;
  need(frameId(frame) && Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0, '帧号或宽高无效');
  need(bytes || data instanceof Float32Array, 'data 须为 8 位码值或 Float32 归一化样本');
  const { channels = data.length / size } = f;
  need([1, 3, 4].includes(channels) && data.length === channels * size, '通道数或像素数与尺寸不符');
  if (!bytes) for (let k = 0; k < data.length; k++) need(data[k] >= 0 && data[k] <= 1, '浮点像素须在 [0,1] 内');
  if (channels === 1) return { frame, width, height, data, scale: bytes ? 255 : 1 };
  const luma = new Float64Array(size), scale = bytes ? 255 : 1;
  for (let p = 0, k = 0; p < size; p++, k += channels) {
    const r = data[k], g = data[k + 1], b = data[k + 2];
    luma[p] = (r === g && g === b ? r : 0.2126 * r + 0.7152 * g + 0.0722 * b) / scale;
  }
  return { frame, width, height, data: luma, scale: 1 };
}

// Y4M 头可横跨 pipe 的 chunk；payload 按流头的真实显示尺寸分帧（含自动旋转与 VFR）。
async function streamGray(file, visit) {
  const child = spawn('ffmpeg', ['-nostdin', '-hide_banner', '-v', 'error', '-i', resolve(file), '-map', '0:v:0',
    '-fps_mode', 'passthrough', '-strict', '-1', '-f', 'yuv4mpegpipe', '-pix_fmt', 'gray', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', spawnError;
  child.stderr.setEncoding('utf8').on('data', s => { stderr = (stderr + s).slice(-8192); });
  child.once('error', err => { spawnError = err; });
  const closed = new Promise(done => child.once('close', done));
  let line = '', width, height, data, offset = 0, frame = 0;
  try {
    for await (const chunk of child.stdout) {
      let pos = 0;
      while (pos < chunk.length) {
        if (!data) {
          const end = chunk.indexOf(10, pos), stop = end < 0 ? chunk.length : end;
          if (line.length + stop - pos > 4096) throw new Error('Y4M 头行过长');
          line += chunk.toString('ascii', pos, stop);
          if (end < 0) break;
          pos = end + 1;
          if (!width) {
            width = Number(/\bW(\d+)\b/.exec(line)?.[1]); height = Number(/\bH(\d+)\b/.exec(line)?.[1]);
            if (!line.startsWith('YUV4MPEG2 ') || !/\bCmono\b/.test(line) || !(width > 0 && height > 0 && Number.isSafeInteger(width * height))) throw new Error('无效灰度 Y4M 流头');
          } else {
            if (!/^FRAME(?:\s|$)/.test(line)) throw new Error('无效 Y4M 帧头');
            data = new Uint8Array(width * height); offset = 0;
          }
          line = '';
        } else {
          const take = Math.min(data.length - offset, chunk.length - pos);
          data.set(chunk.subarray(pos, pos + take), offset); pos += take; offset += take;
          if (offset === data.length) { visit({ frame: frame++, width, height, data, scale: 255 }); data = null; }
        }
      }
    }
    const code = await closed;
    if (spawnError) throw spawnError;
    if (code !== 0) throw new Error(`ffmpeg: ${stderr}`);
    if (data || line || !frame) throw new Error('灰度视频流缺帧或被截断');
  } finally {
    if (child.exitCode === null && child.pid) child.kill();
    await closed;
  }
}

function measure(input, metric, unit, visit, finish) {
  if (typeof input === 'string') {
    need(input.trim().length && !input.includes('\0'), '文件路径须为非空字符串');
    return streamGray(input, visit).then(finish, error => {
      if (error.code !== 'ENOENT') throw error;
      return { metric, value: null, unit, status: 'tool-missing', details: { code: 'tool-missing', tool: 'ffmpeg' } };
    });
  }
  need(Array.isArray(input) && input.length > 0, '至少需要一帧');
  let last = -1, width, height;
  for (let i = 0; i < input.length; i++) {
    need(Object.hasOwn(input, i), '帧数组有空洞');
    const f = plane(input[i], i);
    need(f.frame > last, '帧号须严格递增');
    need(!i || width === f.width && height === f.height, '帧尺寸不一致');
    last = f.frame; width = f.width; height = f.height; visit(f);
  }
  return finish();
}

// 精确 nearest-rank；字节帧统计固定大小，浮点/RGB 内存输入另外保留未量化亮度的频数。
function distribution() { return { bins: new Float64Array(256), other: new Map(), n: 0 }; }
function countFrame(f, total) {
  const local = distribution();
  if (f.scale === 255) {
    for (const v of f.data) local.bins[v]++;
    for (let v = 0; v < 256; v++) total.bins[v] += local.bins[v];
  } else {
    for (const v of f.data) local.other.set(v, (local.other.get(v) ?? 0) + 1);
    for (const [v, n] of local.other) total.other.set(v, (total.other.get(v) ?? 0) + n);
  }
  local.n = f.data.length; total.n += local.n;
  return local;
}
function percentiles({ bins, other, n }) {
  const pairs = [...other];
  for (let v = 0; v < 256; v++) if (bins[v]) pairs.push([v / 255, bins[v]]);
  if (other.size) pairs.sort((a, b) => a[0] - b[0]);
  const out = {}, code8 = {};
  let running = 0, i = 0;
  for (const q of [1, 50, 99]) {
    while (running < Math.ceil(q * n / 100)) running += pairs[i++][1];
    const key = `p${String(q).padStart(2, '0')}`, v = pairs[i - 1][0];
    out[key] = v; code8[key] = v * 255;
  }
  return { ...out, code8 };
}
const sample = (f, i) => f.data[i] / f.scale;
function meanDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += Math.abs(sample(a, i) - sample(b, i));
  return sum / a.data.length;
}
export function lumaPercentile(input, opts = {}) {
  const cuts = options(opts, ['cuts', 'cutThreshold']), { cutThreshold = 0.15 } = opts;
  const metric = 'metric:luma.percentile', unit = 'normalized', total = distribution(), perFrame = [], crossCutExposureDelta = [];
  let prev, maxCrossCutDeltaP50 = null, maxCrossCutDeltaP99 = null;
  return measure(input, metric, unit, f => {
    const row = { frame: f.frame, ...percentiles(countFrame(f, total)) };
    if (prev && f.frame === prev.frame + 1 && (cuts ? cuts.has(f.frame) : meanDiff(prev, f) > cutThreshold)) {
      const before = perFrame.at(-1), deltaP50 = row.p50 - before.p50, deltaP99 = row.p99 - before.p99;
      crossCutExposureDelta.push({ cutFrame: f.frame, beforeP50: before.p50, afterP50: row.p50, deltaP50, deltaP99 });
      maxCrossCutDeltaP50 = Math.max(maxCrossCutDeltaP50 ?? 0, Math.abs(deltaP50));
      maxCrossCutDeltaP99 = Math.max(maxCrossCutDeltaP99 ?? 0, Math.abs(deltaP99));
    }
    prev = f; perFrame.push(row);
  }, () => {
    const summary = percentiles(total), found = new Set(crossCutExposureDelta.map(row => row.cutFrame));
    return { metric, value: summary.p99, unit, status: 'ok', summary, perFrame, crossCutExposureDelta, maxCrossCutDeltaP50,
      maxCrossCutDeltaP99, missingCutFrames: cuts ? [...cuts].filter(c => !found.has(c)) : [] };
  });
}

// 若后镜两帧只相差一个像素的平移，不把纹理变化误判成混叠。每个位移只比相同的画内像素。
function translates(cur, after, residual) {
  const { width: w, height: h } = cur;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if ((!dx && !dy) || Math.abs(dx) * 2 >= w || Math.abs(dy) * 2 >= h) continue;
    let same = 0, shifted = 0;
    for (let y = Math.max(0, -dy); y < Math.min(h, h - dy) && shifted <= residual; y++) for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x++) {
      const i = y * w + x, v = sample(cur, i);
      same += (v - sample(after, i)) ** 2; shifted += (v - sample(after, i + dy * w + dx)) ** 2;
    }
    if (same > 0 && shifted <= residual && shifted <= 0.01 * same) return true;
  }
  return false;
}
const unknown = (cutFrame, status) => ({ cutFrame, status, hasGhost: null, ghostEnergy: null });
function inspect(before, cur, after, threshold, minCutDiff) {
  const cutFrame = cur.frame, n = cur.data.length;
  // 在公共码值量纲上求和：纯字节帧的内积精确，不因像素数不同把恰好 15% 的混叠读成阈值以下。
  const preScale = 255 / before.scale, curScale = 255 / cur.scale, postScale = 255 / after.scale;
  let mad = 0, xx = 0, xy = 0, yy = 0;
  for (let i = 0; i < n; i++) {
    const base = after.data[i] * postScale, x = before.data[i] * preScale - base, y = cur.data[i] * curScale - base;
    mad += Math.abs(x); xx += x * x; xy += x * y; yy += y * y;
  }
  const meanAbsDiff = mad / (255 * n);
  if (!xx || meanAbsDiff < minCutDiff) return { ...unknown(cutFrame, 'low-contrast'), meanAbsDiff };
  const alpha = clamp(xy / xx);
  let residual = 0, support = 0;
  for (let i = 0; i < n; i++) {
    const base = after.data[i] * postScale, x = before.data[i] * preScale - base, y = cur.data[i] * curScale - base;
    const err = y - alpha * x;
    residual += err * err;
    // 逐像素截断投影与整帧拟合相符的前镜渗透；弱对比像素按 x² 降权，容一个码值的舍入差。
    if (x && y / x > 0 && Math.abs((clamp(y / x) - alpha) * x) <= Math.max(1, 0.35 * alpha * Math.abs(x))) support += x * x;
  }
  const explained = yy ? clamp(1 - residual / yy) : 0, penetration = clamp(support / xx);
  const energy = alpha * explained * penetration;
  const ghostEnergy = energy > 0 && translates(cur, after, residual / (255 * 255)) ? 0 : energy;
  return { cutFrame, status: 'ok', meanAbsDiff, alpha, explained, penetration, ghostEnergy, hasGhost: ghostEnergy > 0 && ghostEnergy >= threshold };
}
export function cutGhost(input, opts = {}) {
  const cuts = options(opts, ['cuts', 'minCutDiff', 'threshold']);
  need(cuts, 'cut.ghost 须给 cuts 切点数组');
  const { minCutDiff = 0.05, threshold = 0.15 } = opts, rows = new Map();
  const metric = 'metric:cut.ghost', unit = 'ratio';
  let before, cur;
  return measure(input, metric, unit, f => {
    if (cur && cuts.has(cur.frame) && before?.frame === cur.frame - 1 && f.frame === cur.frame + 1) {
      rows.set(cur.frame, inspect(before, cur, f, threshold, minCutDiff));
    }
    before = cur; cur = f;
  }, () => {
    const perCut = [...cuts].map(c => rows.get(c) ?? unknown(c, 'missing-frames'));
    const ghostFrames = perCut.filter(row => row.hasGhost).map(row => row.cutFrame);
    const valid = perCut.filter(row => row.status === 'ok');
    const value = valid.length ? valid.reduce((max, row) => Math.max(max, row.ghostEnergy), 0) : null;
    const status = valid.length === perCut.length ? 'ok' : valid.length ? 'partial' : 'unmeasurable';
    return { metric, unit, value, status, threshold, minCutDiff, perCut, ghostFrames,
      hasGhost: ghostFrames.length ? true : status === 'ok' ? false : null };
  });
}

export const LUMA_GHOST_METRICS = Object.freeze({ 'luma.percentile': lumaPercentile, 'cut.ghost': cutGhost });
export function runLumaGhostMetric(name, ...args) {
  const key = typeof name === 'string' ? name.replace(/^metric:/, '') : '';
  need(Object.hasOwn(LUMA_GHOST_METRICS, key), `未知指标 ${String(name)}`);
  return LUMA_GHOST_METRICS[key](...args);
}
