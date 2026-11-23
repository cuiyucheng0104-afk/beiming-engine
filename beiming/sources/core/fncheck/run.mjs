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
import { runGpu } from './gpu.mjs';
import { FUNCTIONS, width } from './registry.mjs';

const CORE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WGSL_FILE = path.join(CORE, 'shaders', 'microfacet.wgsl');

/** 32 位 FNV-1a：把函数名混进种子，单跑一个函数和跑全部时它拿到的输入相同 */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (const c of Buffer.from(s)) h = Math.imul(h ^ c, 0x01000193) >>> 0;
  return h;
}

/** 确定性输入：mulberry32 取 24 位均匀数，映射到登记的范围后存成 float32。对数范围用到 Math.pow，跨机器是否逐字节相同以报告里的 inputSha256 为准 */
export function makeInputs(f, n, seed) {
  const ranges = f.inputs.flatMap(([, type, r]) => (type !== 'vec3f' ? [r] : Array.isArray(r[0]) ? r : [r, r, r]));
  const out = new Float32Array(n * ranges.length);
  let s = (fnv1a(f.name) ^ seed) >>> 0;
  for (let i = 0; i < out.length; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const [lo, hi, log] = ranges[i % ranges.length];
    const u = ((t ^ (t >>> 14)) >>> 8) / 16777216;
    out[i] = log ? lo * (hi / lo) ** u : lo + (hi - lo) * u;
  }
  return out;
}

/** 跑一遍比对，返回报告。wgsl 给了就用它代替登记的 WGSL 文件原文（测试用来故意改错一项） */
export async function check({ names = FUNCTIONS.map(f => f.name), n = 1_000_000, seed = 1, wgsl, allowFetch = true } = {}) {
  const fns = names.map(name => FUNCTIONS.find(f => f.name === name) ?? (() => { throw usageError('unknown-function', `登记表里没有函数 ${name}`, `可用：${FUNCTIONS.map(f => f.name).join(' ')}`); })());
  const bin = buildRef({ allowFetch });
  // shortcut: 登记表目前只有一个 WGSL 文件，wgsl 覆盖对全部函数生效；登记了第二个文件时改成按文件覆盖
  const jobs = fns.map(f => ({ f, input: makeInputs(f, n, seed), source: wgsl ?? fs.readFileSync(path.join(CORE, f.file), 'utf8') }));
  const gpu = await runGpu(jobs);
  const results = jobs.map((j, k) => ({
    name: j.f.name,
    rel: j.f.rel,
    abs: j.f.abs,
    inputSha256: createHash('sha256').update(j.input).digest('hex'),
    ...compare({ input: j.input, nIn: width(j.f), ref: runRef(bin, j.f.ref, j.input, n * j.f.out), test: gpu.outputs[k], nOut: j.f.out, rel: j.f.rel, abs: j.f.abs }),
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
      ctx.out(`${r.fails ? '✗' : '✓'} ${r.name.padEnd(38)} 组数 ${r.groups}  最大相对误差 ${r.maxRel.toExponential(2)}（abs 不兜底处 ${r.maxRelNonTiny.toExponential(2)}）  不合格 ${r.fails}  非有限 ${r.nonFinite}`);
      if (r.fails) ctx.out(`    最差一组：下标 ${r.worst[0].index}  输入 [${r.worst[0].input}]  标准 [${r.worst[0].ref}]  被测 [${r.worst[0].test}]  相对误差 ${r.worst[0].relErr}`);
    }
    ctx.out(`报告：${file}`);
    const bad = report.results.filter(r => r.fails).map(r => r.name);
    return { data: report, outputs: [{ path: file, kind: 'report' }], ...(bad.length && { error: { code: 'contract.fncheck', message: `不合格：${bad.join('、')}`, hint: `逐组明细见 ${file}` } }) };
  },
});

if (isMain(import.meta.url)) await runCli(command);
