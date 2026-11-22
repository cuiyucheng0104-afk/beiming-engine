// 画面比对：对比两张图像缓冲区、PNG 文件或视频帧，输出 <= 500 token 的结构化差值表与容差判定，可选写差异热图。
//   compare(a, b, options?)
//     a、b      { width, height, rgb | data }、PNG 路径字符串或 { path }、PNG Buffer/Uint8Array，或 { video | videoPath, frame?, fps? }；
//               一个输入对象只能给一种来源（path、video、videoPath、rgb、data 之一），多给报错
//     options   { tolerance?, heatmapPath?（别名 heatmapOut，不得指向输入文件）, heatmapGain?, metrics? }；未知容差键或指标名报错
//   复用白名单：tools/baseline/lib/metrics.mjs（PSNR、SSIM、maxDiff、fracAbove1/2、容差 judge、热图 diffHeatmap）
//     与 tools/eval/lib/metrics.mjs（seamDeltaE、paletteDeltaE、lineCoverage、grainEnergy），并补 Rec.709 亮度分位差（p05/p50/p95）。
//   成功返回 { ok: true, size, identical, pass, rows, heatmap?, truncated }；非法参数返回 { ok: false, error: { code, message } }，不抛异常。
//   预算：返回值 JSON 严格满足 withinBudget(json, 500)。

import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { compareImages, diffHeatmap, judge } from '../../tools/baseline/lib/metrics.mjs';
import { blockColors, deltaE00, grainEnergy, lineCoverage, median, paletteDeltaE, seamDeltaE } from '../../tools/eval/lib/metrics.mjs';
import { fail } from './curves.mjs';
import { withinBudget } from './query.mjs';
import { decodePng, encodePng, runFfmpeg } from './sheet.mjs';

export const COMPARE_TOKEN_LIMIT = 500;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const r = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

function parseFps(fps) {
  if (fps === undefined) return null;
  if (typeof fps === 'number' && Number.isFinite(fps) && fps > 0) return String(fps);
  if (typeof fps === 'string' && /^\d+\/\d+$/.test(fps)) {
    const [n, d] = fps.split('/').map(Number);
    if (n > 0 && d > 0) return fps;
  }
  throw new Error('fps 必须是正数或 "分子/分母" 字符串');
}

// 每个输入的来源只在这里解析一次（不做 I/O）：解码与热图防覆盖共用返回的 file，两处不会各选各的
const SOURCE_KEYS = ['path', 'video', 'videoPath', 'rgb', 'data'];
function resolveSource(spec, label) {
  if (typeof spec === 'string') {
    if (!spec) throw new Error(`${label} 路径不能为空`);
    return { file: resolve(spec) };
  }
  if (Buffer.isBuffer(spec) || (spec instanceof Uint8Array && spec.length >= 8 && Buffer.from(spec.buffer, spec.byteOffset, 8).equals(PNG_SIG))) {
    return { png: Buffer.from(spec.buffer, spec.byteOffset, spec.byteLength) };
  }
  if (!isPlain(spec)) throw new Error(`${label} 要是图像对象 { width, height, rgb }、PNG 路径或视频帧对象`);
  const given = SOURCE_KEYS.filter((k) => spec[k] !== undefined);
  if (given.length > 1) throw new Error(`${label} 同时给了 ${given.join('、')}，图像来源只能有一个`);
  const key = given[0];
  if (key === 'path' || key === 'video' || key === 'videoPath') {
    if (typeof spec[key] !== 'string' || !spec[key]) throw new Error(`${label}.${key} 必须是非空路径字符串`);
    if (key === 'path') return { file: resolve(spec.path) };
    const frame = spec.frame ?? 0;
    if (!Number.isInteger(frame) || frame < 0) throw new Error(`${label}.frame 必须是非负整数`);
    return { file: resolve(spec[key]), frame, rate: parseFps(spec.fps) };
  }
  const { width, height } = spec;
  const raw = spec.rgb ?? spec.data;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`${label} 的 width、height 必须是正整数`);
  }
  const expected = width * height * 3;
  if (!(raw instanceof Uint8Array || raw instanceof Uint8ClampedArray) || raw.length !== expected) {
    throw new Error(`${label} 的 rgb 必须是长度为 ${expected} 的 Uint8Array`);
  }
  const rgb = raw instanceof Uint8Array ? raw : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return { image: { width, height, rgb } };
}

function loadImage(src, label) {
  if (src.image) return src.image;
  if (src.png) return decodePng(src.png);
  if (src.frame === undefined) return decodePng(readFileSync(src.file));
  const vf = src.rate ? `fps=fps=${src.rate},select=eq(n\\,${src.frame})` : `select=eq(n\\,${src.frame})`;
  const png = runFfmpeg([
    '-nostdin', '-v', 'error', '-i', src.file, '-map', '0:v:0',
    '-vf', vf, '-fps_mode', 'passthrough', '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', '-',
  ], 128 * 1024 * 1024);
  if (!png.length) throw new Error(`${label} 视频中读不到第 ${src.frame} 帧`);
  return decodePng(png);
}

// 返回 0..255 的整数灰阶：差值先在整数上相减再除以 255，相邻一级恒等于 1/255（归一化后再减会有浮点误差）
function lumaQuantiles({ width, height, rgb }) {
  const n = width * height;
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const y = Math.min(255, Math.max(0, Math.round(0.2126 * rgb[p] + 0.7152 * rgb[p + 1] + 0.0722 * rgb[p + 2])));
    hist[y]++;
  }
  const q = (p) => {
    for (let i = 0, acc = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= n * p) return i;
    }
    return 255;
  };
  return { p05: q(0.05), p50: q(0.5), p95: q(0.95) };
}

// 白名单 SSIM 在 < 8x8 时直接回 1；小图改用整幅单窗口的标准 SSIM（逐通道再取平均）
function globalSsim(a, b) {
  const n = a.width * a.height;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  let total = 0;
  for (let c = 0; c < 3; c++) {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let p = c; p < n * 3; p += 3) {
      const x = a.rgb[p], y = b.rgb[p];
      sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
    }
    const ma = sa / n, mb = sb / n;
    const va = saa / n - ma * ma, vb = sbb / n - mb * mb, cov = sab / n - ma * mb;
    total += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
  }
  return r(total / 3, 6);
}

const TOL_KEYS = new Set([
  'psnrMin', 'ssimMin', 'maxDiff', 'maxFracAbove1', 'maxFracAbove2',
  'maxSeamDeltaE', 'seamDeltaEMax', 'maxPaletteDeltaE', 'paletteDeltaEMax',
  'maxLineCoverageDiff', 'lineCoverageDiffMax', 'maxGrainEnergyDiff', 'grainEnergyDiffMax',
  'maxLumaP05Diff', 'lumaP05DiffMax', 'maxLumaP50Diff', 'lumaP50DiffMax', 'maxLumaP95Diff', 'lumaP95DiffMax',
]);
const METRICS = new Set(['psnr', 'ssim', 'maxDiff', 'fracAbove1', 'fracAbove2', 'seamDeltaE', 'paletteDeltaE', 'lineCoverage', 'grainEnergy', 'lumaP05', 'lumaP50', 'lumaP95']);

// 同一 dev+ino 即同一文件（覆盖软链、硬链与不同写法的路径）
function sameFile(p, q) {
  try {
    const x = statSync(resolve(p));
    const y = statSync(q);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

function safeSeamDeltaE(evalA, evalB) {
  if (evalA.width >= 16 && evalA.height >= 9) return seamDeltaE(evalA, evalB);
  const cols = Math.max(1, Math.min(16, evalA.width));
  const rows = Math.max(1, Math.min(9, evalA.height));
  const a = blockColors(evalA, cols, rows);
  const b = blockColors(evalB, cols, rows);
  return r(median(a.map((lab, i) => deltaE00(lab, b[i]))), 2);
}

function checkTolerance(tol) {
  if (tol === undefined) return {};
  if (!isPlain(tol)) throw new Error('tolerance 必须是对象');
  for (const [k, v] of Object.entries(tol)) {
    if (!TOL_KEYS.has(k)) throw new Error(`tolerance.${k} 不是已知容差键；可用 ${[...TOL_KEYS].join('、')}`);
    if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
      throw new Error(`tolerance.${k} 必须是非负有限数`);
    }
  }
  return tol;
}

const pickTol = (tol, ...keys) => {
  for (const k of keys) if (tol[k] !== undefined) return tol[k];
  return undefined;
};

function fitCompare(payload) {
  if (withinBudget(JSON.stringify(payload), COMPARE_TOKEN_LIMIT)) return payload;
  let cur = { ...payload };
  if (typeof cur.heatmap === 'string') {
    cur = { ...cur, heatmap: basename(cur.heatmap), heatmapTruncated: true, truncated: true };
    if (withinBudget(JSON.stringify(cur), COMPARE_TOKEN_LIMIT)) return cur;
  }
  const failed = cur.rows.filter((row) => row.pass === false);
  const passed = cur.rows.filter((row) => row.pass !== false);
  const ordered = [...failed, ...passed];
  for (let n = ordered.length - 1; n >= 0; n--) {
    const cand = { ...cur, rows: ordered.slice(0, n), truncated: true };
    if (withinBudget(JSON.stringify(cand), COMPARE_TOKEN_LIMIT)) return cand;
  }
  return { ok: true, identical: cur.identical, pass: cur.pass, truncated: true };
}

/** 画面比对入口；非法输入返回结构化错误，不抛异常。 */
export function compare(a, b, options = {}) {
  try {
    if (!isPlain(options)) throw new Error('options 必须是对象');
    const tol = checkTolerance(options.tolerance);
    const gain = options.heatmapGain ?? 8;
    if (!(typeof gain === 'number' && Number.isFinite(gain) && gain > 0)) throw new Error('heatmapGain 必须是正数');
    const heatmapPath = options.heatmapPath ?? options.heatmapOut;
    if (heatmapPath !== undefined && (typeof heatmapPath !== 'string' || !heatmapPath)) {
      throw new Error('heatmapPath 必须是非空文件路径');
    }
    if (options.metrics !== undefined && (!Array.isArray(options.metrics) || !options.metrics.every((m) => typeof m === 'string'))) {
      throw new Error('metrics 必须是指标名字符串数组');
    }
    const unknown = options.metrics?.find((m) => !METRICS.has(m));
    if (unknown !== undefined) throw new Error(`metrics 里的 ${unknown} 不是已知指标；可用 ${[...METRICS].join('、')}`);
    const srcA = resolveSource(a, 'a');
    const srcB = resolveSource(b, 'b');
    if (heatmapPath && [srcA, srcB].some((s) => s.file && sameFile(heatmapPath, s.file))) {
      throw new Error('heatmapPath 指向了输入文件，拒绝覆盖');
    }

    const imgA = loadImage(srcA, 'a');
    const imgB = loadImage(srcB, 'b');
    const base = compareImages(imgA, imgB);
    if (!base.identical && !base.sizeMismatch && (imgA.width < 8 || imgA.height < 8)) base.ssim = globalSsim(imgA, imgB);

    let heatmap;
    if (heatmapPath) {
      const hm = diffHeatmap(imgA, imgB, { gain });
      const outPath = resolve(heatmapPath);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, encodePng(hm));
      heatmap = outPath;
    }

    if (base.sizeMismatch) {
      return fitCompare({
        ok: true,
        identical: false,
        sizeMismatch: true,
        pass: false,
        rows: [{ metric: 'size', a: base.sizeA, b: base.sizeB, pass: false }],
        ...(heatmap ? { heatmap } : {}),
        truncated: false,
      });
    }

    const evalA = { width: imgA.width, height: imgA.height, data: imgA.rgb };
    const evalB = { width: imgB.width, height: imgB.height, data: imgB.rgb };
    const seamDe = base.identical ? 0 : safeSeamDeltaE(evalA, evalB);
    const palDe = base.identical ? 0 : (paletteDeltaE([evalB], [evalA]).median ?? 0);
    const lineA = lineCoverage(evalA);
    const lineB = base.identical ? lineA : lineCoverage(evalB);
    const grainA = grainEnergy(evalA);
    const grainB = base.identical ? grainA : grainEnergy(evalB);
    const lumaA = lumaQuantiles(imgA);
    const lumaB = base.identical ? lumaA : lumaQuantiles(imgB);

    const valRow = (metric, value, tolerance, ok) => ({
      metric,
      value,
      ...(tolerance !== undefined ? { tolerance } : {}),
      pass: ok,
    });
    const pairRow = (metric, va, vb, digits, tolerance, den = 1) => {
      const raw = (vb - va) / den; // 先用未舍入的差判定，再格式化展示；den 让整数量先相减再归一
      return {
        metric,
        a: r(va / den, digits),
        b: r(vb / den, digits),
        diff: r(raw, digits),
        ...(tolerance !== undefined ? { tolerance } : {}),
        pass: tolerance === undefined ? true : Math.abs(raw) <= tolerance,
      };
    };

    const tSeam = pickTol(tol, 'maxSeamDeltaE', 'seamDeltaEMax');
    const tPal = pickTol(tol, 'maxPaletteDeltaE', 'paletteDeltaEMax');
    const tLine = pickTol(tol, 'maxLineCoverageDiff', 'lineCoverageDiffMax');
    const tGrain = pickTol(tol, 'maxGrainEnergyDiff', 'grainEnergyDiffMax');
    const tP05 = pickTol(tol, 'maxLumaP05Diff', 'lumaP05DiffMax');
    const tP50 = pickTol(tol, 'maxLumaP50Diff', 'lumaP50DiffMax');
    const tP95 = pickTol(tol, 'maxLumaP95Diff', 'lumaP95DiffMax');

    const allRows = [
      valRow('psnr', base.psnr, tol.psnrMin, tol.psnrMin === undefined || base.identical || base.psnr >= tol.psnrMin),
      valRow('ssim', base.ssim, tol.ssimMin, tol.ssimMin === undefined || base.ssim >= tol.ssimMin),
      valRow('maxDiff', base.maxDiff, tol.maxDiff, tol.maxDiff === undefined || base.maxDiff <= tol.maxDiff),
      valRow('fracAbove1', r(base.fracAbove1, 5), tol.maxFracAbove1, tol.maxFracAbove1 === undefined || base.fracAbove1 <= tol.maxFracAbove1),
      valRow('fracAbove2', r(base.fracAbove2, 5), tol.maxFracAbove2, tol.maxFracAbove2 === undefined || base.fracAbove2 <= tol.maxFracAbove2),
      valRow('seamDeltaE', seamDe, tSeam, tSeam === undefined || seamDe <= tSeam),
      valRow('paletteDeltaE', palDe, tPal, tPal === undefined || palDe <= tPal),
      pairRow('lineCoverage', lineA, lineB, 4, tLine),
      pairRow('grainEnergy', grainA, grainB, 3, tGrain),
      pairRow('lumaP05', lumaA.p05, lumaB.p05, 4, tP05, 255),
      pairRow('lumaP50', lumaA.p50, lumaB.p50, 4, tP50, 255),
      pairRow('lumaP95', lumaA.p95, lumaB.p95, 4, tP95, 255),
    ];

    const baseJudge = judge(base, tol);
    const pass = baseJudge.ok && allRows.every((row) => row.pass);
    const rows = options.metrics ? allRows.filter((row) => options.metrics.includes(row.metric)) : allRows;

    return fitCompare({
      ok: true,
      size: [imgA.width, imgA.height],
      identical: base.identical,
      pass,
      rows,
      ...(heatmap ? { heatmap } : {}),
      truncated: false,
    });
  } catch (error) {
    return fail(error);
  }
}
