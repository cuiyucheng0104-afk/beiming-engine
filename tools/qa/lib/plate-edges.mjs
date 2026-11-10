// 北冥 QA · 底板边缘的静态分析：透明底板四边有没有「直线淡出」或「硬切边」。
// 原图在画幅处被截断、后期只沿一条竖线（或横线）做了线性淡出的底板，淡出带的 alpha = 0.5 等值线是一条直线；
// 放进画面里就是一道笔直的截断边（docs/raea/experiment.md 的云片截断竖边、plates.json 的 skyline_bund 注意事项）。
// 判据（加固计划 P07「plates」）：逐行（左右两边）或逐列（上下两边）找从透明一侧进来第一次越过 alpha 0.5 的位置，
// 这些位置连续一段的标准差 < maxStdPx（默认 15 px），且这段覆盖 ≥ minCoverage（默认 30%）的图高 / 图宽，就是直线淡出；
// 覆盖率按主体（alpha > 2%）的外框算。淡出带（alpha 0.1 → 0.9）≥ 8 px 宽的是直线淡出；不到 8 px 宽、又贴着图边（2% 以内）的是硬切边
// （原图在画幅处被截断、没做淡出）；离图边远的锐利直边（楼的侧墙、杆子）是画里本来的直线，不报。自然的云边起伏远大于 15 px，不会命中。
//
//   readAlpha(file)                 → { width, height, alpha: Uint8Array | null }（用 FFmpeg 解出 alpha 平面；没有 alpha 通道返回 alpha=null）
//   analyzeAlpha({ width, height, alpha }, opts) → { hasAlpha, contentBox: [x0,y0,x1,y1] | null, edges: [{ side, pos, posPx, span: [a,b], coverage, stdPx, fadePx, kind }] }
//   analyzePlate(file, opts)        → readAlpha + analyzeAlpha（同一文件按 sha256 缓存）
import fs from 'node:fs';
import crypto from 'node:crypto';
import { run, tool, tail } from './proc.mjs';
import { QaError, EXIT } from './cli-kit.mjs';

export async function readAlpha(file, { timeoutMs = 120000 } = {}) {
  const pr = await run(tool('ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'json', file], { timeoutMs });
  let s;
  try { s = JSON.parse(pr.stdout.toString('utf8')).streams[0]; } catch { s = null; }
  if (pr.code !== 0 || !s) throw new QaError('input.plate', `读不了底板 ${file}：${tail(pr.stderr)}`, { exitCode: EXIT.USAGE });
  const { width, height } = s;
  if (!/a|pal8/.test(s.pix_fmt || '')) return { width, height, alpha: null, pixFmt: s.pix_fmt };
  const size = width * height, chunks = [];
  let n = 0;
  const r = await run(tool('ffmpeg'), ['-v', 'error', '-nostdin', '-i', file, '-vf', 'format=rgba,alphaextract', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    { timeoutMs, onStdout: c => { chunks.push(c); n += c.length; } });
  if (r.code !== 0 || n < size) throw new QaError('input.plate', `解不出底板 ${file} 的 alpha：${tail(r.stderr)}`, { exitCode: EXIT.RUNTIME });
  return { width, height, alpha: new Uint8Array(Buffer.concat(chunks).subarray(0, size)), pixFmt: s.pix_fmt };
}

function stats(xs) {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean: m, std: Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) };
}

// 一条边：沿 n 条扫描线（行或列），每条线从透明一侧往里走，记第一次 alpha ≥ 128 的位置与淡出带宽度
function scanSide(get, lines, depth, { maxStdPx, minCoverage, extent }) {
  const cross = new Array(lines).fill(null), fade = new Array(lines).fill(null);
  const step = Math.max(1, Math.floor(lines / 1200));          // 大图隔几条线取一条，够用且快
  for (let i = 0; i < lines; i += step) {
    let k = 0;
    while (k < depth && get(i, k) < 128) k++;
    if (k >= depth) continue;
    // 这条线上真有不透明的主体（不是只擦过一点雾）才算
    // （淡出带可能有几百像素宽，往里看到图深的 12%）
    let solid = false;
    for (let j = k; j < Math.min(depth, k + Math.max(64, Math.round(0.12 * depth))); j++) if (get(i, j) >= 230) { solid = true; break; }
    if (!solid) continue;
    let a = k, b = k;
    while (a > 0 && get(i, a - 1) > 26) a--;
    while (b < depth - 1 && get(i, b + 1) < 230) b++;
    cross[i] = k; fade[i] = b - a + 1;
  }
  // 找最长的一段：段内每个交叉位置离段中位数 ≤ 2×maxStdPx，再要求段内标准差 < maxStdPx
  let best = null;
  const idx = [];
  for (let i = 0; i < lines; i += step) if (cross[i] !== null) idx.push(i);
  let s = 0;
  while (s < idx.length) {
    let e = s;
    const seg = [cross[idx[s]]];
    while (e + 1 < idx.length && idx[e + 1] - idx[e] <= 3 * step) {
      const sorted = [...seg, cross[idx[e + 1]]].sort((p, q) => p - q);
      const med = sorted[sorted.length >> 1];
      if (Math.abs(cross[idx[e + 1]] - med) > 2 * maxStdPx) break;
      seg.push(cross[idx[e + 1]]);
      e++;
    }
    const span = idx[e] - idx[s] + step;
    if (!best || span > best.span[1] - best.span[0]) best = { span: [idx[s], Math.min(lines, idx[e] + step)], seg, fades: idx.slice(s, e + 1).map(i => fade[i]) };
    s = e + 1;
  }
  if (!best) return null;
  const st = stats(best.seg);
  const coverage = (best.span[1] - best.span[0]) / Math.max(1, extent);
  if (st.std >= maxStdPx || coverage < minCoverage) return null;
  const fadePx = [...best.fades].sort((p, q) => p - q)[best.fades.length >> 1];
  const nearBorder = st.mean <= 0.02 * depth;
  if (fadePx < 8 && !nearBorder) return null;   // 离图边远的锐利直边：画里本来的直线
  return { posPx: Math.round(st.mean), span: best.span, coverage: +Math.min(1, coverage).toFixed(3), stdPx: +st.std.toFixed(1), fadePx, kind: fadePx < 8 ? 'hard-cut' : 'straight-fade' };
}

export function analyzeAlpha({ width: W, height: H, alpha }, { maxStdPx = 15, minCoverage = 0.3 } = {}) {
  if (!alpha) return { hasAlpha: false, contentBox: null, edges: [] };
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (alpha[y * W + x] > 5) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  let transparent = false;
  for (let i = 0; i < alpha.length; i += 97) if (alpha[i] < 250) { transparent = true; break; }
  if (x1 < 0) return { hasAlpha: true, contentBox: null, edges: [] };
  // 整张不透明（天空、江面）：边框就是矩形本身，露不露边归 visual.edge-clear 管，这里不查
  if (!transparent) return { hasAlpha: false, contentBox: [x0, y0, x1 + 1, y1 + 1], edges: [] };
  const ch = y1 + 1 - y0, cw = x1 + 1 - x0;
  const sides = {
    left: scanSide((i, k) => alpha[i * W + k], H, W, { maxStdPx, minCoverage, extent: ch }),
    right: scanSide((i, k) => alpha[i * W + (W - 1 - k)], H, W, { maxStdPx, minCoverage, extent: ch }),
    top: scanSide((i, k) => alpha[k * W + i], W, H, { maxStdPx, minCoverage, extent: cw }),
    bottom: scanSide((i, k) => alpha[(H - 1 - k) * W + i], W, H, { maxStdPx, minCoverage, extent: cw }),
  };
  const edges = [];
  for (const [side, e] of Object.entries(sides)) {
    if (!e) continue;
    const along = side === 'left' || side === 'right' ? W : H;
    const posPx = side === 'right' ? W - 1 - e.posPx : side === 'bottom' ? H - 1 - e.posPx : e.posPx;
    edges.push({ side, posPx, pos: +(posPx / along).toFixed(4), span: e.span, coverage: e.coverage, stdPx: e.stdPx, fadePx: e.fadePx, kind: e.kind });
  }
  return { hasAlpha: transparent, contentBox: [x0, y0, x1 + 1, y1 + 1], edges };
}

const cache = new Map();
export async function analyzePlate(file, opts = {}) {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const key = `${sha}:${opts.maxStdPx ?? 15}:${opts.minCoverage ?? 0.3}`;
  if (!cache.has(key)) {
    const a = await readAlpha(file, opts);
    cache.set(key, { width: a.width, height: a.height, sha256: sha, ...analyzeAlpha(a, opts) });
  }
  return cache.get(key);
}
