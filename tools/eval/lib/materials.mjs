// 评审素材与自动参考指标（run.mjs finish 调用；计划书 7.3「AI 评审先看接触印、各切点 ±1 帧、各事件的起止帧」）。
//
// 产物都写进 <运行目录>/review/：
//   contact.jpg        接触印：全片等距 12 帧拼成 4×3
//   frames/fNNNNN.png  切点前后各一帧（c−1、c、c+1）、每个事件的起止帧（frame 与 end/out 字段，有就取）
//   metrics.json       自动参考指标（只写进结果，不计分）：各切点接缝 ΔE00；A 路线与 DF-M 另算对照基线的色板 ΔE00 中位数、
//                      墨线覆盖率、纸纹与颗粒的高频能量（基线在 docs/style-baselines/<名>/，P08 入库前记「基线未入库」）
// 依赖 FFmpeg；不可用或没有成片时返回 { materials: null, metrics: { note } }，不报错（评审素材缺失不影响硬门）。
// 接口：buildMaterials(run, report, { toolsRoot, log }) → { materials, metrics }

import fs from 'node:fs';
import path from 'node:path';
import { runTool } from './exec.mjs';
import { readJsonIfExists, walk, writeJson } from './files.mjs';
import { extractFrames, probeVideo, readFrameRGB, readImageRGB } from './media.mjs';
import { grainEnergy, lineCoverage, median, paletteDeltaE, round, seamDeltaE } from './metrics.mjs';
import { toPosix } from './paths.mjs';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

function framePlan(film, frames) {
  const shots = Array.isArray(film?.shots) ? film.shots.filter(s => Number.isInteger(s?.in) && Number.isInteger(s?.out)) : [];
  const cuts = shots.slice(1).map(s => s.in).filter(c => c > 0 && c < frames);
  const events = (Array.isArray(film?.events) ? film.events : [])
    .filter(e => Number.isInteger(e?.frame))
    .map(e => ({ id: e.id ?? null, start: e.frame, end: Number.isInteger(e.end) ? e.end : Number.isInteger(e.out) ? e.out : null }));
  const set = new Set();
  for (const c of cuts) for (const f of [c - 1, c, c + 1]) if (f >= 0 && f < frames) set.add(f);
  for (const e of events) for (const f of [e.start, e.end]) if (Number.isInteger(f) && f >= 0 && f < frames) set.add(f);
  return { cuts, events, frames: [...set].sort((a, b) => a - b) };
}

async function contactSheet(file, frames, out) {
  const picks = Array.from({ length: 12 }, (_, i) => Math.min(frames - 1, Math.round(((i + 0.5) * frames) / 12)));
  const expr = [...new Set(picks)].map(n => `eq(n\\,${n})`).join('+');
  const res = await runTool(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-vf', `select='${expr}',scale=480:-2:flags=lanczos,tile=4x3`, '-frames:v', '1', '-q:v', '3', '-y', out], { timeoutMs: 10 * 60 * 1000 });
  if (res.error || res.exitCode !== 0) throw new Error(`拼接触印失败：${res.error?.message ?? res.stderr.trim().split('\n')[0]}`);
  return picks;
}

function baselineImages(task, roots) {
  const ref = task.scoring?.visualReference;
  if (!ref) return { ref: null, dir: null, files: [] };
  for (const root of roots) {
    const dir = path.join(root, ref);
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      const files = walk(dir).filter(e => IMAGE_RE.test(e.rel)).map(e => e.abs).sort().slice(0, 12);
      if (files.length) return { ref, dir, files };
    }
  }
  return { ref, dir: null, files: [] };
}

async function styleMetrics(task, file, frames, roots) {
  const base = baselineImages(task, roots);
  if (!base.ref) return null;
  if (!base.files.length) return { reference: base.ref, note: `基线未入库：${base.ref} 下没有关键帧（P08 入库后自动计算）` };
  const picks = Array.from({ length: 6 }, (_, i) => Math.min(frames - 1, Math.round(((i + 0.5) * frames) / 6)));
  const filmSmall = [];
  const filmFull = [];
  for (const n of picks) {
    filmSmall.push(await readFrameRGB(file, n, { width: 320, height: 180 }));
    filmFull.push(await readFrameRGB(file, n, { width: 1280, height: 720 }));
  }
  const baseSmall = [];
  const baseFull = [];
  for (const f of base.files) {
    baseSmall.push(await readImageRGB(f, { width: 320, height: 180 }));
    baseFull.push(await readImageRGB(f, { width: 1280, height: 720 }));
  }
  const pal = paletteDeltaE(filmSmall, baseSmall);
  return {
    reference: base.ref,
    baselineFrames: base.files.length,
    paletteDeltaE00Median: pal.median,
    lineCoverage: { film: round(median(filmFull.map(lineCoverage)), 4), baseline: round(median(baseFull.map(lineCoverage)), 4) },
    grainEnergy: { film: round(median(filmFull.map(img => grainEnergy(img))), 3), baseline: round(median(baseFull.map(img => grainEnergy(img))), 3) },
    palette: { film: pal.film, baseline: pal.baseline },
  };
}

/**
 * 生成评审素材与参考指标。
 * @param {object} run loadRun() 的结果
 * @param {object} report gates.json
 * @param {{ toolsRoot: string, log?: Function }} opts
 */
export async function buildMaterials(run, report, { toolsRoot, log = () => {} }) {
  const rel = report.gates?.H1?.evidence?.deliverable ?? report.observations?.deliverables?.runDir ?? null;
  const reviewDir = path.join(run.dir, 'review');
  let file = null;
  if (report.gates?.H1?.evidence?.deliverable) file = path.join(run.worktree, rel);
  else if (report.observations?.deliverables?.runDir) {
    const dir = path.join(run.worktree, report.observations.deliverables.runDir);
    file = ['web.mp4', 'master.mp4'].map(n => path.join(dir, n)).find(f => fs.existsSync(f)) ?? null;
  }
  if (!file || !fs.existsSync(file)) return { materials: null, metrics: { note: '没有成片，不生成评审素材' } };
  const probe = await probeVideo(file);
  if (probe.error) return { materials: null, metrics: { note: `无法读成片（${probe.error}），不生成评审素材` } };
  fs.mkdirSync(path.join(reviewDir, 'frames'), { recursive: true });
  const filmId = report.run?.filmId;
  const film = filmId ? readJsonIfExists(path.join(run.worktree, 'films', filmId, 'film.json')) : null;
  const frames = probe.frames ?? Math.round((probe.duration ?? 0) * (probe.fps ?? 24));
  const plan = framePlan(film, frames);
  const materials = { video: toPosix(path.relative(run.dir, file)), probe: { width: probe.width, height: probe.height, fps: probe.fps, frames: probe.frames, audio: probe.audio }, contact: null, contactFrames: [], frames: [], cuts: plan.cuts, events: plan.events };
  const metrics = { schemaVersion: 1, note: '自动参考指标只写进结果，不直接计分，供评审校准（计划书 7.3）', seams: [], style: null, errors: [] };
  try {
    materials.contactFrames = await contactSheet(file, frames, path.join(reviewDir, 'contact.jpg'));
    materials.contact = 'review/contact.jpg';
  } catch (e) { metrics.errors.push(e.message); }
  try {
    const got = await extractFrames(file, plan.frames, { width: 960, outDir: path.join(reviewDir, 'frames'), prefix: 'f' });
    materials.frames = got.map(g => ({ frame: g.frame, file: toPosix(path.relative(run.dir, g.file)) }));
  } catch (e) { metrics.errors.push(e.message); }
  for (const c of plan.cuts) {
    try {
      const a = await readFrameRGB(file, c - 1);
      const b = await readFrameRGB(file, c);
      metrics.seams.push({ cut: c, deltaE00Median: seamDeltaE(a, b) });
    } catch (e) { metrics.errors.push(`切点 ${c}：${e.message}`); }
  }
  try { metrics.style = await styleMetrics(run.task, file, frames, [run.worktree, toolsRoot]); } catch (e) { metrics.errors.push(`风格指标：${e.message}`); }
  writeJson(path.join(reviewDir, 'metrics.json'), metrics);
  materials.metrics = 'review/metrics.json';
  log(`评审素材：接触印 ${materials.contact ? '已生成' : '失败'}，取帧 ${materials.frames.length} 张，切点 ${plan.cuts.length} 个`);
  return { materials, metrics };
}
