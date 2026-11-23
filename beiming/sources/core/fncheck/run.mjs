#!/usr/bin/env node
// 北冥 · 函数级比对外壳：同一批随机输入，一边交给 Cycles 内核函数编成的本机程序（标准答案），一边交给我方 WGSL
// 函数在真显卡上算（被测），逐个比，报出不合格的函数、输入和差值。报告写到 out/report.json。
//   node beiming/sources/core/fncheck/run.mjs [函数名…] [--n 1000000] [--seed 1]
// 退出码：0 全部合格；4 有函数不合格；3 缺工具链（git、C++ 编译器、网络、硬件 WebGPU）。
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli, usageError } from '../../../../tools/lib/cli.mjs';
import { COMMIT, OUT, TAG, buildRef, runRef } from './cycles/build.mjs';
import { compare } from './compare.mjs';
import { kernel, runGpu } from './gpu.mjs';
import { FUNCTIONS, SHADERS, outWidth, size, width } from './registry.mjs';

export const CORE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 把 SHADERS 里的 WGSL 文件拼成一个模块；overrides 按文件名代替原文（测试用来故意改错一项） */
export const shaderSource = (overrides = {}) => SHADERS.map(file => overrides[file] ?? fs.readFileSync(path.join(CORE, file), 'utf8')).join('\n');

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

/** 跑一遍比对，返回报告。wgsl 是 { 文件名: 原文 }，代替那几个 WGSL 文件（测试用来故意改错一项） */
export async function check({ names = FUNCTIONS.map(f => f.name), n = 1_000_000, seed = 1, wgsl, allowFetch = true } = {}) {
  const fns = names.map(name => FUNCTIONS.find(f => f.name === name) ?? (() => { throw usageError('unknown-function', `登记表里没有函数 ${name}`, `可用：${FUNCTIONS.map(f => f.name).join(' ')}`); })());
  const bin = buildRef({ allowFetch });
  const source = shaderSource(wgsl);
  const jobs = fns.map(f => ({ f, input: makeInputs(f, n, seed) }));
  const gpu = await runGpu(jobs.map(j => ({ name: j.f.name, code: kernel(source, j.f), input: j.input, n, nOut: outWidth(j.f) })));
  const results = jobs.map((j, k) => ({
    name: j.f.name,
    rel: j.f.rel,
    abs: j.f.abs,
    inputSha256: createHash('sha256').update(j.input).digest('hex'),
    ...(j.f.branch && { branches: branchCounts(j.f, j.input, n) }),
    ...compare({ input: j.input, nIn: width(j.f), ref: runRef(bin, j.f.ref, j.input, n * outWidth(j.f)), test: gpu.outputs[k], nOut: outWidth(j.f), rel: j.f.rel, abs: j.f.abs, skip: j.f.skip }),
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
