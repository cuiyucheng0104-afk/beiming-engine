#!/usr/bin/env node
// 北冥 · 渲染程序的显卡上限记录：`core-render info --limits` 的全文（适配器的信息、上限与特性，加上设备实际申请到的
// 上限与特性），存成 limits/<显卡加后端>.json（文件名同回归基线的 baselineName），随提交入库，一台机器一份。
//   node beiming/sources/core/chassis/limits.mjs [--bin core-render] [--print]
// 程序取值次序：--bin → 环境变量 BEIMING_CORE_RENDER → build.mjs 现编。子进程不带 THREERT_HWRT、THREERT_MERGED
// （记的是默认的设备）。退出码：0 写好了（--print 只打印不写）；3 缺工具链或拿不到显卡。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CliError, defineCommand, isMain, runCli } from '../../../../tools/lib/cli.mjs';
import { COMMIT, buildRenderer, sourceKey } from './build.mjs';
import { baselineName } from './regress.mjs';

export const LIMITS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'limits');

/** 程序：给了就用，否则环境变量，再否则现编 */
export function rendererBin(bin) {
  if (bin) return { bin, key: null };
  if (process.env.BEIMING_CORE_RENDER) return { bin: process.env.BEIMING_CORE_RENDER, key: null };
  return buildRenderer();
}

/** 跑一次 info --limits，返回它打的对象 */
export function readLimits(bin) {
  const env = { ...process.env };
  delete env.THREERT_HWRT;
  delete env.THREERT_MERGED;
  const r = spawnSync(bin, ['info', '--limits'], { encoding: 'utf8', env });
  if (r.error || r.status !== 0) throw new CliError('env.chassis-gpu', `core-render info --limits 没跑起来：${(r.stderr || String(r.error)).trim().split('\n').slice(-3).join(' ')}`, '要能跑 wgpu 的显卡；程序要是带 --limits 的版本');
  return JSON.parse(r.stdout);
}

export const command = defineCommand({
  name: 'chassis-limits',
  summary: '记下这台机器上渲染程序拿到的显卡上限与特性全文（limits/<显卡加后端>.json）',
  usage: ['node beiming/sources/core/chassis/limits.mjs', 'node beiming/sources/core/chassis/limits.mjs --print'],
  options: {
    bin: { type: 'string', arg: '<程序>', describe: '用这个 core-render，不现编' },
    print: { type: 'boolean', describe: '只打印，不写文件' },
  },
  exitCodes: { 0: '写好了', 2: '用法错误', 3: '缺工具链或拿不到显卡' },
  async run(ctx) {
    const { bin, key } = rendererBin(ctx.opts.bin);
    const report = readLimits(bin);
    const record = { ...report, kernel: key ?? sourceKey(), upstreamCommit: COMMIT };
    const name = baselineName({ adapter: report.adapter.name, backend: report.adapter.backend });
    const d = report.deviceLimits;
    ctx.out(`${report.adapter.name}（${report.adapter.backend}）：单个存储缓冲绑定 ${d.max_storage_buffer_binding_size}，单个缓冲 ${d.max_buffer_size}，二维纹理 ${d.max_texture_dimension_2d}，顶层实例 ${d.max_tlas_instance_count}，硬件求交 ${report.hwrt}`);
    if (ctx.opts.print) {
      ctx.out(JSON.stringify(record, null, 1));
      return { data: record };
    }
    const file = path.join(LIMITS, name);
    fs.mkdirSync(LIMITS, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(record, null, 1)}\n`);
    ctx.out(`写到 ${file}`);
    return { data: { file, adapter: report.adapter.name }, outputs: [{ path: file, kind: 'report' }] };
  },
});

if (isMain(import.meta.url)) await runCli(command);
