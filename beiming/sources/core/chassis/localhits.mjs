#!/usr/bin/env node
// 北冥 · 硬件求交下「只查同一个物体」的多命中（shaders/intersect.wgsl 的 trace_local：在 trace 上逐次步进拼出来的）可靠不可靠：
// 同一个场景包、同一个种子、每像素 1 个样本，硬件求交与软件求交（THREERT_HWRT=0；BVH 遍历里按物体号过滤，收齐区间里的全部命中）
// 各渲一遍。两遍取的随机数完全相同，倒角那一步只有局部求交的结果可能不同，所以降噪法线（denoiseNormal，含倒角）在倒角那一圈
// 带状区里夹角超过 DEG 的像素所占的份额，是步进漏命中（或多出命中）的上界；带状区之外的不一致像素另记，作底（相机射线在公共边上
// 两边打中的三角形不同等，与局部求交无关）。没有硬件光追的机器上两遍都是软件求交、读数恒为 0，看报告里的显卡名。
//   node beiming/sources/core/chassis/localhits.mjs --pack <场景包目录> [--seeds 8] [--size 480x270] [--entities 1,2] [--out 报告.json]
// 退出码：0 量完；3 缺工具链或显卡；2 用法错误。只量不判。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { CliError, defineCommand, isMain, runCli } from '../../../../tools/lib/cli.mjs';
import { bevelBand, entityMask, normalMismatch } from '../../../verify/gauges.mjs';
import { OUT, buildRenderer } from './build.mjs';
import { renderPasses } from './level4.mjs';

/** 判不一致的夹角（度）：两条路的命中点只差单精度舍入时法线差不到 1e-4 度 */
export const DEG = 0.05;

function withEnv(key, value, fn) {
  const old = process.env[key];
  process.env[key] = value;
  try { return fn(); } finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
}

export function measureLocalHits({ pack, seeds = 8, size = [480, 270], entities = null }) {
  const { bin } = buildRenderer();
  const override = { energyCompensation: 1, maxBounces: 8 };
  let band = 0, bandDiff = 0, rest = 0, restDiff = 0, adapter = null;
  for (let s = 0; s < seeds; s++) {
    const hw = withEnv('THREERT_HWRT', '1', () => renderPasses(bin, pack, { frame: 0, size, spp: 1, seed: s, override }));
    const sw = withEnv('THREERT_HWRT', '0', () => renderPasses(bin, pack, { frame: 0, size, spp: 1, seed: s, override }));
    adapter = hw.adapter;
    const ids = sw.id, [w, h] = size;
    const region = entityMask(ids, null, entities ?? [...new Set(ids)].filter((x) => x !== 0));
    const b = bevelBand(sw.normal, w, h, region).band;
    const others = region.map((x, i) => (x && !b[i] ? 1 : 0));
    const inBand = normalMismatch(hw.normal, sw.normal, b, DEG), outBand = normalMismatch(hw.normal, sw.normal, others, DEG);
    band += inBand.total; bandDiff += inBand.count; rest += outBand.total; restDiff += outBand.count;
  }
  return { format: 'beiming.core.localhits/1', pack: path.basename(pack), seeds, size, deg: DEG, adapter, band: { pixels: band, mismatched: bandDiff, rate: band ? bandDiff / band : null }, outside: { pixels: rest, mismatched: restDiff, rate: rest ? restDiff / rest : null } };
}

export const command = defineCommand({
  name: 'chassis-localhits',
  summary: '硬件求交下局部多命中的不一致率：同种子每像素 1 样本，硬件与软件求交的降噪法线在倒角带状区里不一致的份额（只量不判）',
  usage: ['node beiming/sources/core/chassis/localhits.mjs --pack <场景包目录> [--seeds 8] [--size 480x270] [--entities 1,2] [--out 报告.json]'],
  options: {
    pack: { type: 'string', arg: '<目录>', describe: '场景包目录' },
    seeds: { type: 'integer', default: 8, arg: '<个数>', describe: '种子个数（每个种子两遍渲染）' },
    size: { type: 'string', default: '480x270', arg: '<宽x高>', describe: '分辨率' },
    entities: { type: 'string', arg: '<号,号>', describe: '只量这些实体（默认画面里的全部实体）' },
    out: { type: 'string', arg: '<文件>', describe: '报告写到哪里（默认 out/chassis/localhits/<包名>.json）' },
  },
  exitCodes: { 0: '量完', 2: '用法错误', 3: '缺工具链或显卡' },
  async run(ctx) {
    if (!ctx.opts.pack) throw new CliError('usage.bad-argument', '要 --pack <场景包目录>');
    const size = ctx.opts.size.split('x').map(Number);
    let report;
    try {
      report = measureLocalHits({ pack: path.resolve(ctx.opts.pack), seeds: ctx.opts.seeds, size, entities: ctx.opts.entities?.split(',').map(Number) ?? null });
    } catch (e) {
      if (e.missing) throw new CliError('env.chassis-toolchain', `缺：${e.missing}`, '要 cargo 与能跑 wgpu 的显卡');
      throw e;
    }
    const file = path.resolve(ctx.opts.out ?? path.join(OUT, 'localhits', `${report.pack}.json`));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    const pct = (x) => (x === null ? '—' : `${(100 * x).toFixed(3)}%`);
    ctx.out(`${report.pack}（${report.adapter}）：倒角带状区 ${report.band.mismatched}/${report.band.pixels}（${pct(report.band.rate)}），带状区外 ${report.outside.mismatched}/${report.outside.pixels}（${pct(report.outside.rate)}）`);
    ctx.out(`报告：${file}`);
    return { data: report, outputs: [{ path: file, kind: 'report' }] };
  },
});

if (isMain(import.meta.url)) await runCli(command);
