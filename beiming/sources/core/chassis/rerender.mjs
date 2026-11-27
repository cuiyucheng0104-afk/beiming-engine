#!/usr/bin/env node
// 北冥 · 场景包同帧两遍的逐位检查：同一个场景包、同一帧、同一个内核种子，两个独立的 core-render render-pack 进程各渲一遍，
// 比每个产物的 sha256：--passes 出的每个通道文件（color.f32 是未降噪的颜色）、--hdr 的线性颜色（降噪之后）、PNG。
// 软件求交（THREERT_HWRT=0）与硬件求交（这块显卡开得起来时）各两遍。第一遍的出层再转一次多层 EXR、读回逐位比
// （passes-exr.mjs）。结果写 rerender/<显卡加后端>.json（文件名同回归基线），随提交入库。
//   BEIMING_CORE_TEST_PACKS=<包目录>[:<包目录>…] node beiming/sources/core/chassis/rerender.mjs [--bin core-render]
//       [--frame k] [--spp 256] [--width 1280 --height 720] [--seed 0] [--print]
// 场景包不进仓库：用环境变量 BEIMING_CORE_TEST_PACKS 列目录（同 scenepack.test.mjs，按系统的路径分隔符隔开），记录里只写包的
// id 与内容摘要（包里全部文件按相对路径排序后逐个的路径与内容一起算 sha256），不写目录。--frame 不给时取包的中间一帧
// （帧数的一半向下取整）。程序取值次序同 limits.mjs。
// 退出码：0 每一组两遍逐位相同、EXR 往返逐位相同；4 有不同（记录照样写）；3 缺工具链、拿不到显卡或没给场景包；2 用法错误。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import console from 'node:console';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { COMMIT, PRESETS } from './build.mjs';
import { readLimits, rendererBin } from './limits.mjs';
import { passesToExr, runMain, usage } from './passes-exr.mjs';
import { baselineName } from './regress.mjs';

export const RECORDS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rerender');
const sha256 = data => createHash('sha256').update(data).digest('hex');

/** 包里全部文件（相对路径排序）的路径与内容一起的摘要 */
export function packDigest(dir) {
  const files = [];
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else files.push(r);
    }
  };
  walk('');
  const h = createHash('sha256');
  for (const f of files.sort()) h.update(`${f}\0`).update(sha256(fs.readFileSync(path.join(dir, f)))).update('\n');
  return h.digest('hex');
}

/** 一个目录下每个文件的 sha256（按名字排序） */
function digests(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map(f => [f, sha256(fs.readFileSync(path.join(dir, f)))]));
}

/** 渲一遍，返回 { files: { 名字: sha256 }, traceMs, hwrt } */
function renderOnce(bin, pack, out, { frame, spp, size, seed, mode }) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const env = { ...process.env, THREERT_SEED: String(seed) };
  delete env.THREERT_MERGED;
  if (mode === 'sw') env.THREERT_HWRT = '0';
  else delete env.THREERT_HWRT;
  const args = ['render-pack', pack, '-o', path.join(out, 'out.png'), '--frame', String(frame), '--spp', String(spp), '--width', String(size[0]), '--height', String(size[1]),
    '--hdr', path.join(out, 'hdr.raw'), '--passes', path.join(out, 'passes'), '--presets', PRESETS];
  const r = spawnSync(bin, args, { encoding: 'utf8', env, maxBuffer: 1 << 26 });
  if (r.error || r.status !== 0) throw new Error(`render-pack 失败（${mode}）：${(r.stderr || String(r.error)).trim().split('\n').slice(-3).join(' ')}`);
  const stats = JSON.parse(r.stdout.trim().split('\n').pop());
  const files = { 'out.png': sha256(fs.readFileSync(path.join(out, 'out.png'))), 'hdr.raw': sha256(fs.readFileSync(path.join(out, 'hdr.raw'))) };
  for (const [f, h] of Object.entries(digests(path.join(out, 'passes')))) files[`passes/${f}`] = h;
  return { files, traceMs: stats.timings_ms?.trace_ms ?? null, hwrt: stats.hwrt, denoise: stats.denoise };
}

/** 一个包：每种求交两遍比，第一遍的出层转 EXR 往返。返回记录的一项 */
export function checkPack(bin, pack, work, { frame, spp, size, seed, modes }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(pack, 'pack.json'), 'utf8'));
  const k = frame ?? Math.floor(manifest.frames.count / 2);
  const item = { id: manifest.id, contentSha256: packDigest(pack), frame: k, spp, width: size[0], height: size[1], seed, modes: {} };
  for (const mode of modes) {
    const opts = { frame: k, spp, size, seed, mode };
    const [a, b] = ['a', 'b'].map(run => renderOnce(bin, pack, path.join(work, `${mode}-${run}`), opts));
    const differ = Object.keys(a.files).filter(f => a.files[f] !== b.files[f]);
    item.modes[mode] = { same: differ.length === 0, differ, hwrt: a.hwrt, denoise: a.denoise, traceMs: [a.traceMs, b.traceMs], files: a.files, ...(differ.length && { filesB: Object.fromEntries(differ.map(f => [f, b.files[f]])) }) };
    if (!item.exr) {
      const x = passesToExr(path.join(work, `${mode}-a`, 'passes'), size);
      item.exr = { from: mode, sha256: sha256(x.bytes), channels: x.names, roundTrip: x.problems.length === 0, problems: x.problems };
    }
  }
  return item;
}

/** 命令行；返回退出码 */
export function main(argv) {
  const { values: o } = parseArgs({ args: argv, options: Object.fromEntries(['bin', 'frame', 'spp', 'width', 'height', 'seed'].map(k => [k, { type: 'string' }]).concat([['print', { type: 'boolean' }]])) });
  const packs = (process.env.BEIMING_CORE_TEST_PACKS ?? '').split(path.delimiter).filter(Boolean);
  if (!packs.length) throw Object.assign(new Error('没给场景包：把场景包目录列进环境变量 BEIMING_CORE_TEST_PACKS'), { exit: 3 });
  const int = (name, d) => {
    const v = o[name] ?? d;
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) throw usage(`--${name} ${v} 不是非负整数`);
    return n;
  };
  const opts = { frame: int('frame'), spp: int('spp', 256), size: [int('width', 1280), int('height', 720)], seed: int('seed', 0) };
  let built;
  try {
    built = rendererBin(o.bin);
  } catch (e) {
    throw Object.assign(e, { exit: e.missing ? 3 : 1 });
  }
  const limits = readLimits(built.bin);
  const gpu = { adapter: limits.adapter.name, backend: limits.adapter.backend, driver: limits.adapter.driver };
  opts.modes = limits.hwrt ? ['sw', 'hw'] : ['sw'];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'core-rerender-'));
  const record = { format: 'core-rerender/0.1', gpu, kernel: built.key, binSha256: built.sha256, upstreamCommit: COMMIT, packs: [] };
  try {
    for (const pack of packs) {
      const item = checkPack(built.bin, pack, work, opts);
      record.packs.push(item);
      for (const [mode, m] of Object.entries(item.modes)) console.log(`${item.id} 第 ${item.frame} 帧 ${mode}：${m.same ? '两遍逐位相同' : `两遍不同：${m.differ.join('、')}`}（trace_ms ${m.traceMs.join(' / ')}，降噪 ${m.denoise}）`);
      console.log(`${item.id} EXR：${item.exr.roundTrip ? '往返逐位相同' : item.exr.problems.join('；')}，${item.exr.channels.length} 个通道`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const bad = record.packs.filter(p => !p.exr.roundTrip || Object.values(p.modes).some(m => !m.same)).map(p => p.id);
  if (o.print) console.log(JSON.stringify(record, null, 1));
  else {
    const file = path.join(RECORDS, baselineName(gpu));
    fs.mkdirSync(RECORDS, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 1)}\n`);
    console.log(`写到 ${file}`);
  }
  if (bad.length) console.log(`✗ 有不同：${bad.join('、')}`);
  return bad.length ? 4 : 0;
}

runMain(import.meta.url, main);
