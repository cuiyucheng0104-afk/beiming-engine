#!/usr/bin/env node
// 北冥 · 函数级比对外壳：同一批随机输入，一边交给 Cycles 内核函数编成的本机程序（标准答案），一边交给我方 WGSL
// 函数在真显卡上算（被测），逐个比，报出不合格的函数、输入和差值。报告写到 out/report.json。
// 登记 host 的几项（宿主一侧照 Cycles 移植的 Rust，像素滤波建表）被测的是 core-render fncheck-host，要 cargo 现编。
//   node beiming/sources/core/fncheck/run.mjs [函数名…] [--n 1000000] [--seed 1]
// 退出码：0 全部合格；4 有函数不合格；3 缺工具链（git、C++ 编译器、网络、硬件 WebGPU）。
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli, usageError } from '../../../../tools/lib/cli.mjs';
import { buildRenderer } from '../chassis/build.mjs';
import { COMMIT, OUT, TAG, buildRef, runRef } from './cycles/build.mjs';
import { compare } from './compare.mjs';
import { kernel, runGpu } from './gpu.mjs';
import { FILTER_TABLES, FILTER_TABLE_SIZE, FUNCTIONS, SHADERS, filterTableStub, outWidth, size, width } from './registry.mjs';

export const CORE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 把 SHADERS 里的 WGSL 文件拼成一个模块；overrides 按文件名代替原文（测试用来故意改错一项）。filterTables 是
 *  imaging.wgsl 要读的滤波表（FILTER_TABLES 次序的几张表接在一起），不给时全 0 */
export const shaderSource = (overrides = {}, filterTables = null) => `${SHADERS.map(file => overrides[file] ?? fs.readFileSync(path.join(CORE, file), 'utf8')).join('\n')}\n${filterTableStub(filterTables)}`;

/** 按 FILTER_TABLES 建出的几张表，接在一起：bin 是标准答案程序（Cycles 建的表）或 core-render（宿主一侧 Rust 建的表） */
export function filterTables(bin, run = runRef) {
  return run(bin, 'filter_table', Float32Array.from(FILTER_TABLES.flat()), FILTER_TABLES.length * FILTER_TABLE_SIZE);
}

/** 宿主一侧的被测程序跑一个函数（core-render fncheck-host，协议同标准答案程序） */
export function runHost(bin, id, input, count) {
  const r = spawnSync(bin, ['fncheck-host', id], { input: Buffer.from(input.buffer, input.byteOffset, input.byteLength), maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`core-render fncheck-host ${id} 退出码 ${r.status}：${r.stderr}`);
  if (r.stdout.length !== count * 4) throw new Error(`core-render fncheck-host ${id} 输出 ${r.stdout.length} 字节，应为 ${count * 4}`);
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length));
}

/** 32 位 FNV-1a：把函数名混进种子，单跑一个函数和跑全部时它拿到的输入相同 */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (const c of Buffer.from(s)) h = Math.imul(h ^ c, 0x01000193) >>> 0;
  return h;
}

/** 确定性输入：mulberry32 取 24 位均匀数，按登记的类型与范围逐组生成后存成 float32。标量与向量每个分量用一个均匀数；
 *  dir 用两个：z 在范围里均匀、方位角在 [0, 2π) 里均匀，即在那一圈球带上按面积均匀。对数范围与 dir 用到 Math.pow、cos、sin，
 *  跨机器是否逐字节相同以报告里的 inputSha256 为准。登记了 gen(next) 的项由它给出一组 { 输入名: 值 }，按 inputs 的次序写入 */
export function makeInputs(f, n, seed) {
  let s = (fnv1a(f.name) ^ seed) >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 8) / 16777216;
  };
  const out = new Float32Array(n * width(f));
  let i = 0;
  for (let g = 0; g < n; g++) {
    if (f.gen) {
      const v = f.gen(next);
      for (const [name] of f.inputs) for (const x of [v[name]].flat()) out[i++] = x;
      continue;
    }
    for (const [, type, r] of f.inputs) {
      if (type === 'dir') {
        const z = r[0] + (r[1] - r[0]) * next(), phi = 2 * Math.PI * next(), rho = Math.sqrt(1 - z * z);
        out[i++] = rho * Math.cos(phi); out[i++] = rho * Math.sin(phi); out[i++] = z;
        continue;
      }
      for (let k = 0; k < size(type); k++) {
        const [lo, hi, log] = Array.isArray(r[0]) ? r[k] : r;
        const u = next();
        out[i++] = log ? lo * (hi / lo) ** u : lo + (hi - lo) * u;
      }
    }
  }
  return out;
}

/** 按登记的 branch(一组输入) 数各分支的组数 */
function branchCounts(f, input, n) {
  const w = width(f), counts = {};
  for (let g = 0; g < n; g++) { const b = f.branch(input.subarray(g * w, (g + 1) * w)); counts[b] = (counts[b] ?? 0) + 1; }
  return counts;
}

/** 跑一遍比对，返回报告。wgsl 是 { 文件名: 原文 }，代替那几个 WGSL 文件（测试用来故意改错一项）；inject 是宿主一侧的故意改错
 *  （../chassis/build.mjs 的 buildRenderer 的 inject，在源码的拷贝上改了再编），只影响 host 的几项 */
export async function check({ names = FUNCTIONS.map(f => f.name), n = 1_000_000, seed = 1, wgsl, inject = [], allowFetch = true } = {}) {
  const fns = names.map(name => FUNCTIONS.find(f => f.name === name) ?? (() => { throw usageError('unknown-function', `登记表里没有函数 ${name}`, `可用：${FUNCTIONS.map(f => f.name).join(' ')}`); })());
  const bin = buildRef({ allowFetch });
  const source = shaderSource(wgsl, fns.some(f => f.filterTables) ? filterTables(bin) : null);
  const jobs = fns.map(f => ({ f, n: f.n ?? n, input: makeInputs(f, f.n ?? n, seed) }));
  const onGpu = jobs.filter(j => !j.f.host), onHost = jobs.filter(j => j.f.host);
  const gpu = onGpu.length ? await runGpu(onGpu.map(j => ({ name: j.f.name, code: kernel(source, j.f), input: j.input, n: j.n, nOut: outWidth(j.f) }))) : { adapter: null, outputs: [] };
  const host = onHost.length ? buildRenderer({ inject }).bin : null;
  const tested = new Map([...onGpu.map((j, k) => [j, gpu.outputs[k]]), ...onHost.map(j => [j, runHost(host, j.f.ref, j.input, j.n * outWidth(j.f))])]);
  const results = jobs.map(j => ({
    name: j.f.name,
    rel: j.f.rel,
    abs: j.f.abs,
    inputSha256: createHash('sha256').update(j.input).digest('hex'),
    ...(j.f.host && { tested: 'host' }),
    ...(j.f.branch && { branches: branchCounts(j.f, j.input, j.n) }),
    ...compare({ input: j.input, nIn: width(j.f), ref: runRef(bin, j.f.ref, j.input, j.n * outWidth(j.f)), test: tested.get(j), nOut: outWidth(j.f), rel: j.f.rel, abs: j.f.abs, skip: j.f.skip }),
  }));
  return { ok: results.every(r => r.fails === 0), n, seed, cycles: { tag: TAG, commit: COMMIT }, platform: `${process.platform}-${process.arch}`, adapter: gpu.adapter, results };
}

export const command = defineCommand({
  name: 'fncheck',
  summary: '函数级比对：Cycles 内核函数（标准答案）对我方 WGSL 函数（真显卡），同一批随机输入逐个比',
  usage: ['node beiming/sources/core/fncheck/run.mjs [函数名…] [--n 1000000] [--seed 1]'],
  positionals: [{ name: 'fn', label: '[函数名…]', variadic: true, required: false, describe: '登记表 registry.mjs 里的函数名；不写就是全部' }],
  options: {
    n: { type: 'integer', default: 1_000_000, arg: '<组数>', describe: '每个函数的随机输入组数' },
    seed: { type: 'integer', default: 1, arg: '<种子>', describe: '同一种子产生同一串输入字节' },
  },
  exitCodes: { 0: '全部合格', 2: '用法错误', 3: '缺工具链', 4: '有函数不合格' },
  async run(ctx) {
    let report;
    try {
      report = await check({ names: ctx.args.fn.length ? ctx.args.fn : undefined, n: ctx.opts.n, seed: ctx.opts.seed });
    } catch (e) {
      if (e.missing) throw new CliError('env.fncheck-toolchain', `缺工具链：${e.missing}`, '要 git、C++20 编译器（clang++ 或 g++）、第一次取源码时的网络，以及能拿到硬件 WebGPU 的无头 Chrome');
      throw e;
    }
    const file = path.join(OUT, 'report.json');
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    for (const r of report.results) {
      ctx.out(`${r.fails ? '✗' : '✓'} ${r.name.padEnd(38)} 组数 ${r.groups}  最大相对误差 ${r.maxRel.toExponential(2)}（abs 不兜底处 ${r.maxRelNonTiny.toExponential(2)}）  不合格 ${r.fails}  非有限 ${r.nonFinite}  标准全零 ${r.zeroRef}  不比 ${r.skipped}  所需 abs ${r.needAbs.toExponential(2)}`);
      if (r.branches) ctx.out(`    分支：${Object.entries(r.branches).map(([b, c]) => `${b} ${(c / r.groups * 100).toFixed(2)}%`).join('，')}`);
      if (r.fails) ctx.out(`    最差一组：下标 ${r.worst[0].index}  输入 [${r.worst[0].input}]  标准 [${r.worst[0].ref}]  被测 [${r.worst[0].test}]  相对误差 ${r.worst[0].relErr}`);
    }
    ctx.out(`报告：${file}`);
    const bad = report.results.filter(r => r.fails).map(r => r.name);
    return { data: report, outputs: [{ path: file, kind: 'report' }], ...(bad.length && { error: { code: 'contract.fncheck', message: `不合格：${bad.join('、')}`, hint: `逐组明细见 ${file}` } }) };
  },
});

if (isMain(import.meta.url)) await runCli(command);
