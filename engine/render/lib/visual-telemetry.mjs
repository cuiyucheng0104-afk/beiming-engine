// 渲染期与 QA 解码共用一个按放映顺序接收灰度帧的分析器。
import { analysisSize } from './analysis-size.mjs';
import { loadProfiles, resolveProfile } from './qa-profiles.mjs';

export const telemetrySize = (width, height, frames) => analysisSize(width, height, frames > 3000 ? 320 : 480);

// 取编码输出 0（master）而非截图：有损压缩也会改变临界黑场、静帧和切点。
export function telemetryOutputArgs({ width, height, frames }, file) {
  const { w, h } = telemetrySize(width, height, frames);
  return ['-dec', '0:0', '-filter_complex', `[dec:0]scale=${w}:${h}:flags=area,format=gray[qa_gray]`,
    '-map', '[qa_gray]', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', file];
}

function boxBlur(src, dst, tmp, w, h) {
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      const a = src[o + (x > 0 ? x - 1 : x)], b = src[o + x], c = src[o + (x < w - 1 ? x + 1 : x)];
      tmp[o + x] = (a + b + c) / 3;
    }
  }
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : y) * w, me = y * w, dn = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) dst[me + x] = (tmp[up + x] + tmp[me + x] + tmp[dn + x]) / 3;
  }
}

export function createAnalyzer({ w, h, visual, clearLuma = 0 }) {
  const N = w * h;
  const gx = 16, gy = Math.max(4, Math.round(16 * h / w));
  const bw = Math.ceil(w / gx), bh = Math.ceil(h / gy);
  const blur1 = new Float32Array(N), blur2 = new Float32Array(N), tmp = new Float32Array(N);
  let prev = null, ref = null, refIndex = 0;
  const noise = 10 ** (visual.freezeNoiseDb / 20) * 255;
  const blackThr = visual.blackPixel * 255;
  const S = { yavg: [], mafd: [], blackRatio: [], blockLum: [], freezeRuns: [], bands: [], lines: [], n: 0, gx, gy, w, h };
  const blockDiffMax = (a, b) => {
    const sums = new Float64Array(gx * gy), cnt = new Uint32Array(gx * gy);
    for (let y = 0; y < h; y++) {
      const row = Math.min(gy - 1, (y / bh) | 0) * gx;
      for (let x = 0; x < w; x++) { const k = row + Math.min(gx - 1, (x / bw) | 0); sums[k] += Math.abs(a[y * w + x] - b[y * w + x]); cnt[k]++; }
    }
    let m = 0, tot = 0;
    for (let k = 0; k < sums.length; k++) { if (cnt[k]) { const v = sums[k] / cnt[k]; if (v > m) m = v; } tot += sums[k]; }
    return { max: m, mean: tot / N };
  };
  const clearLine = (lum, idxs, ref0) => {
    let n = 0;
    for (const i of idxs) if (Math.abs(lum[i] - ref0) <= 8) n++;
    return n >= 0.95 * idxs.length;
  };
  const lineIdx = (side, k, seg, segs) => {
    const out = [];
    if (side === 'left' || side === 'right') {
      const x = side === 'left' ? k : w - 1 - k, y0 = Math.floor(seg * h / segs), y1 = Math.floor((seg + 1) * h / segs);
      for (let y = y0; y < y1; y++) out.push(y * w + x);
    } else {
      const y = side === 'top' ? k : h - 1 - k, x0 = Math.floor(seg * w / segs), x1 = Math.floor((seg + 1) * w / segs);
      for (let x = x0; x < x1; x++) out.push(y * w + x);
    }
    return out;
  };
  const meanOf = (lum, idxs) => { let s = 0; for (const i of idxs) s += lum[i]; return idxs.length ? s / idxs.length : 0; };

  return {
    S,
    push(lum, i) {
      let sum = 0, dark = 0;
      for (let k = 0; k < N; k++) sum += lum[k];
      boxBlur(lum, blur1, tmp, w, h);
      boxBlur(blur1, blur2, tmp, w, h);
      for (let k = 0; k < N; k++) if (blur2[k] <= blackThr) dark++;
      const yavg = sum / N;
      S.yavg.push(yavg);
      S.blackRatio.push(dark / N);
      // 帧差与静帧
      let mafd = 0;
      if (prev) mafd = blockDiffMax(blur2, prev).mean;
      S.mafd.push(mafd);
      if (!ref) { ref = Float32Array.from(blur2); refIndex = i; }
      else {
        const d = blockDiffMax(blur2, ref).max;
        if (d >= noise) {
          if (i - refIndex >= 2) S.freezeRuns.push([refIndex, i]);
          ref.set(blur2); refIndex = i;
        }
      }
      prev = prev || new Float32Array(N);
      prev.set(blur2);
      // 分块亮度（大面积闪烁筛查用）
      const bl = new Float32Array(gx * gy), bc = new Uint32Array(gx * gy);
      for (let y = 0; y < h; y++) {
        const row = Math.min(gy - 1, (y / bh) | 0) * gx;
        for (let x = 0; x < w; x++) { const k = row + Math.min(gx - 1, (x / bw) | 0); bl[k] += lum[y * w + x]; bc[k]++; }
      }
      for (let k = 0; k < bl.length; k++) bl[k] = bc[k] ? bl[k] / bc[k] : 0;
      S.blockLum.push(bl);
      // 边缘：清屏色暗带（每边分 4 段）
      if (yavg > 10) {
        const maxBand = Math.max(2, Math.round(Math.min(w, h) * 0.04));
        for (const side of ['top', 'right', 'bottom', 'left']) {
          for (let seg = 0; seg < 4; seg++) {
            let k = 0;
            while (k < maxBand && clearLine(lum, lineIdx(side, k, seg, 4), clearLuma)) k++;
            if (k > 0 && k < maxBand) {
              const inner = meanOf(lum, lineIdx(side, Math.min(maxBand - 1, k + 1), seg, 4));
              if (inner >= clearLuma + 12) S.bands.push({ frame: i, side, seg, px: k });
            }
          }
        }
      }
      // 笔直竖边：每行取横向梯度的局部极大点，再看同一列（±1）连续多少行都有
      const g = 10, minRun = Math.round(visual.edgeLineMinFrac * h);
      const colRun = new Uint16Array(w), best = new Uint16Array(w), bestEnd = new Uint16Array(w);
      const edge = new Uint8Array(w);
      for (let y = 0; y < h; y++) {
        const o = y * w;
        edge.fill(0);
        for (let x = 2; x < w - 2; x++) {
          const d = Math.abs(blur1[o + x + 1] - blur1[o + x - 1]);
          if (d >= g && d >= Math.abs(blur1[o + x] - blur1[o + x - 2]) && d >= Math.abs(blur1[o + x + 2] - blur1[o + x])) edge[x] = 1;
        }
        for (let x = 3; x < w - 3; x++) {
          if (edge[x - 1] || edge[x] || edge[x + 1]) { colRun[x]++; if (colRun[x] > best[x]) { best[x] = colRun[x]; bestEnd[x] = y; } }
          else colRun[x] = 0;
        }
      }
      for (let x = 3; x < w - 3; x++) {
        if (best[x] >= minRun && best[x] >= best[x - 1] && best[x] > best[x + 1]) S.lines.push({ frame: i, x, run: best[x], y1: bestEnd[x] + 1, y0: bestEnd[x] + 1 - best[x] });
      }
      S.n = i + 1;
    },
    end() { if (ref && S.n - refIndex >= 2) S.freezeRuns.push([refIndex, S.n]); return S; },
  };
}

export function hexLuma(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return 0;
  const v = parseInt(m[1], 16);
  return 0.2126 * (v >> 16) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
}

// 只绑定采集时已经应用的阈值；其余（如 freezeMinSec、镜头表）可在 QA 时重新判定。
function captureConfig({ blackPixel, freezeNoiseDb, edgeLineMinFrac }, clearColor) {
  return { blackPixel, freezeNoiseDb, edgeLineMinFrac, clearLuma: hexLuma(clearColor) };
}
const bounded = (x, lo, hi) => Number.isFinite(x) && x >= lo && x <= hi;
const integer = (x, lo, hi) => Number.isSafeInteger(x) && x >= lo && x <= hi;
const positiveInt = x => Number.isSafeInteger(x) && x > 0;
function requireField(ok, name) { if (!ok) throw new Error(`画面遥测 ${name} 不完整或与当前成片 / 采样配置不一致`); }
function checkHashes(hashes, n) {
  requireField(Array.isArray(hashes) && hashes.length === n, 'frameHashes');
  for (const h of hashes) requireField(typeof h === 'string' && /^[0-9a-f]{64}$/.test(h), 'frameHashes');
}

export function createVisualCollector({ width, height, frames, fps, visual = resolveProfile(loadProfiles(), 'web-1080p24').visual, clearColor }) {
  requireField([width, height, frames].every(positiveInt) && Number.isFinite(fps) && fps > 0, 'width/height/frameCount/fps');
  const { w, h } = telemetrySize(width, height, frames);
  const config = captureConfig(visual, clearColor);
  requireField(Object.values(config).every(Number.isFinite), 'config');
  const an = createAnalyzer({ w, h, visual: config, clearLuma: config.clearLuma });
  const frame = Buffer.allocUnsafe(w * h);
  let accepted = 0, finished = false;
  return {
    // 按放映顺序喂块：静帧起点可在任意前块，不能只拼两个块各自的静帧区间。
    async readChunk(readable, expectedFrames) {
      requireField(!finished && an.S.n === accepted && positiveInt(expectedFrames) && accepted + expectedFrames <= frames, '块帧数');
      const end = accepted + expectedFrames;
      let used = 0;
      for await (const bytes of readable) {
        for (let pos = 0; pos < bytes.length;) {
          requireField(an.S.n < end, '块长');
          const take = Math.min(frame.length - used, bytes.length - pos);
          frame.set(bytes.subarray(pos, pos + take), used);
          pos += take; used += take;
          if (used === frame.length) { an.push(frame, an.S.n); used = 0; }
        }
      }
      requireField(!used && an.S.n === end, '块长');
      accepted = end;
    },
    finish(frameHashes) {
      requireField(!finished && accepted === frames, 'frameCount');
      checkHashes(frameHashes, frames);
      finished = true;
      const series = an.end();
      // 分析与旧解码路径一直保留 Float32；仅在生成 JSON 时原位换为数组。
      for (let i = 0; i < series.n; i++) series.blockLum[i] = Array.from(series.blockLum[i]);
      return { schemaVersion: 1, width, height, fps, frameCount: frames, analysisWidth: w, analysisHeight: h, clearLuma: config.clearLuma, frameHashes, config, series };
    },
  };
}

/** 验过才把逐帧数据交给判定器；错误由 QA 根据显式指定 / 自动发现决定报错或回退。 */
export function validateVisualTelemetry(doc, { width, height, frames, fps, visual, clearColor }) {
  requireField(doc?.schemaVersion === 1, 'schemaVersion');
  requireField(positiveInt(frames) && doc.frameCount === frames, 'frameCount');
  requireField(doc.width === width && doc.height === height, 'width/height');
  requireField(Number.isFinite(doc.fps) && doc.fps > 0 && Math.abs(doc.fps - fps) <= 1e-6, 'fps');
  checkHashes(doc.frameHashes, frames);
  const config = captureConfig(visual, clearColor);
  requireField(Object.entries(config).every(([k, v]) => Number.isFinite(v) && doc.config?.[k] === v), 'config');
  const { w, h } = telemetrySize(width, height, frames);
  requireField(doc.analysisWidth === w && doc.analysisHeight === h && doc.clearLuma === config.clearLuma, 'analysisWidth/analysisHeight/clearLuma');
  const S = doc.series, gx = 16, gy = Math.max(4, Math.round(16 * h / w));
  requireField(S?.w === w && S.h === h && S.gx === gx && S.gy === gy && S.n === frames, 'series 尺寸 / 帧数');
  const row = (a, length, max) => Array.isArray(a) && a.length === length && a.every(x => bounded(x, 0, max));
  for (const [key, max] of [['yavg', 255], ['mafd', 255], ['blackRatio', 1]]) requireField(row(S[key], frames, max), key);
  requireField(S.mafd[0] === 0, 'mafd[0]');
  requireField(Array.isArray(S.blockLum) && S.blockLum.length === frames && S.blockLum.every(b => row(b, gx * gy, 255)), 'blockLum');
  requireField(Array.isArray(S.freezeRuns) && S.freezeRuns.every((r, i, arr) => Array.isArray(r) && r.length === 2
    && integer(r[0], i ? arr[i - 1][1] : 0, frames - 2) && integer(r[1], r[0] + 2, frames)), 'freezeRuns');
  const inOrder = (e, i, arr) => e && integer(e.frame, i ? arr[i - 1].frame : 0, frames - 1);
  const maxBand = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  requireField(Array.isArray(S.bands) && S.bands.every((b, i, arr) => inOrder(b, i, arr) && ['top', 'right', 'bottom', 'left'].includes(b.side)
    && integer(b.seg, 0, 3) && integer(b.px, 1, maxBand - 1)), 'bands');
  requireField(Array.isArray(S.lines) && S.lines.every((l, i, arr) => inOrder(l, i, arr) && integer(l.x, 3, w - 4)
    && integer(l.y0, 0, h - 1) && integer(l.y1, l.y0 + 1, h) && l.run === l.y1 - l.y0), 'lines');
  return S;
}
