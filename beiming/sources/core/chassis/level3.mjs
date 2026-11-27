#!/usr/bin/env node
// 北冥 · 对拍阶梯第 3 级：材质球逐输入扫参，核心对标准答案机（Blender 5.2.3 Cycles，处理器，不降噪）出的参考包。
//   每个场景包核心照参考包的设置出 16 个种子，两道门照 beiming/verify 的「噪声地板乘 k」：
//     floor  核心一个种子对参考包 seed00 的整帧 HDR-FLIP 平均值 ≤ k × 参考包 floor.seedVsSeedFlipMean（量法与标准答案机量地板时相同）
//     welch  核心 16 个种子对参考包 16 个种子，Welch 检验（α、块大小、种子数照阈值文件），门看 pass
//   逐球记平均亮度对收敛图的相对差，只记不判。负对照：关掉多重散射 GGX 的能量补偿，粗糙金属那一包两道门里至少一道必须不过；
//   常量世界强行开回环境的光源采样（在 out/ 下的源码副本里改了另编），白炉底色那一包两道门里至少一道必须不过。
//   node beiming/sources/core/chassis/level3.mjs --root <参考包根目录> [--only <场景包名>] [--out 报告.json]
//   参考包根目录下要有 coverage.json、scene-packs/、refs/（标准答案机的产物，不进仓库）；不给 --root 时读环境变量 BEIMING_CORE_LADDER_ROOT。
// 退出码：0 全部过；4 有一项不过；3 缺工具链或参考包；2 用法错误。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { CliError, defineCommand, isMain, runCli } from '../../../../tools/lib/cli.mjs';
import { readExr } from '../../../verify/exr/exr.mjs';
import { floorGate, welchGate, THRESHOLDS } from '../../../verify/floorgate.mjs';
import { hdrFlip } from '../../../verify/hdrflip.mjs';
import { OUT, PRESETS, buildRenderer, missing } from './build.mjs';

const WORK = path.join(OUT, 'level3');
export const SEEDS = Array.from({ length: THRESHOLDS.welch.seeds }, (_, k) => k);
// 对上 Cycles：原理化 BSDF 默认的分布是多重散射 GGX（能量补偿开）；总弹射与漫反射、光泽、透射的上限照参考包清单的 bounces，
// 四个一律加一：清单里是 Cycles 界面上的值，核心的预设与 Cycles 内核同口径（界面值 G：这一类第 G + 1 次散射之后的顶点只收灯）
export const MATCH = ({ bounces: b }) => ({ energyCompensation: 1, maxBounces: b.max + 1, maxDiffuseBounces: b.diffuse + 1, maxGlossyBounces: b.glossy + 1, maxTransmissionBounces: b.transmission + 1 });
export const NEGATIVE = { name: '关掉多重散射 GGX 的能量补偿', pack: 'l3-furnace-rough-m1', override: { energyCompensation: 0 } };
// 第二条负对照：场景包的常量世界照 Cycles 不做环境的光源采样（render-pack 的 background_light）；在源码副本里强行开回，
// 白炉的底色那一包两道门里至少一道必须不过
export const ENV_NEGATIVE = { name: '常量世界强行开回环境的光源采样', pack: 'l3-furnace-base', inject: [{ file: 'path/src/main.rs', from: '    if !job.background_light {\n        params.counts2[1] = 0;\n    }', to: '    if false && !job.background_light {\n        params.counts2[1] = 0;\n    }' }] };

const lum = (a, i) => 0.2126 * a[3 * i] + 0.7152 * a[3 * i + 1] + 0.0722 * a[3 * i + 2];
const frame = (w, h, data) => ({ width: w, height: h, data, channels: 3 });

/** 参考包根目录里第 3 级的场景包：[{ pack, frame, size, ref, balls: [{ entity, params }] }] */
export function level3Packs(root) {
  const file = path.join(root, 'coverage.json');
  if (!fs.existsSync(file)) throw missing(`参考包根目录 ${root} 里没有 coverage.json`);
  const by = new Map();
  for (const p of JSON.parse(fs.readFileSync(file, 'utf8')).points.filter((x) => x.id.startsWith('l3/'))) {
    const pack = path.basename(p.scenePackDir);
    if (!by.has(pack)) by.set(pack, { pack, frame: p.frame, size: p.size, ref: p.ref, balls: [] });
    const g = by.get(pack);
    if (g.ref !== p.ref || g.frame !== p.frame) throw new Error(`覆盖表里 ${pack} 的取值点指向不同的参考包或帧`);
    g.balls.push({ entity: p.entity, params: p.params });
  }
  return [...by.values()];
}

/** 参考包：清单与每个种子、收敛图的颜色（RGB，行主序）、物体编号与覆盖率 */
export function readRef(root, address) {
  const dir = path.join(root, 'refs', address);
  const ref = JSON.parse(fs.readFileSync(path.join(dir, 'ref.json'), 'utf8'));
  const load = (name) => {
    const e = readExr(fs.readFileSync(path.join(dir, name)));
    const c = e.channels, n = e.width * e.height, rgb = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) { rgb[3 * i] = c['color.R'][i]; rgb[3 * i + 1] = c['color.G'][i]; rgb[3 * i + 2] = c['color.B'][i]; }
    return { w: e.width, h: e.height, rgb, id: c['objectId.id'], coverage: c['objectId.coverage'] };
  };
  const seeds = ref.files.filter((f) => /^seed\d+\.exr$/.test(f)).map(load);
  return { ref, seeds, converged: load('converged.exr') };
}

/** 核心按参考包的设置渲一个种子，返回 RGB 浮点（行主序）与显卡名 */
export function renderCore(bin, packDir, { frame: k, size: [w, h], spp, seed, override }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beiming-level3-'));
  try {
    const raw = path.join(tmp, 'o.raw'), stats = path.join(tmp, 's.json');
    const r = spawnSync(bin, ['render-pack', packDir, '-o', path.join(tmp, 'o.png'), '--hdr', raw, '--stats', stats, '--frame', String(k), '--spp', String(spp),
      '--width', String(w), '--height', String(h), '--no-denoise', '--presets', PRESETS, '--override', JSON.stringify({ native: override })],
    { encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, THREERT_SEED: String(seed) } });
    if (r.status !== 0) throw Object.assign(new Error(`render-pack ${path.basename(packDir)} 种子 ${seed} 失败：${r.stderr.trim().split('\n').at(-1)}`), /adapter|GPU|显卡/i.test(r.stderr) ? { missing: 'GPU' } : {});
    const b = fs.readFileSync(raw);
    const rgb = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    if (rgb.length !== 3 * w * h) throw new Error(`render-pack 出的图大小不对：${rgb.length} 个数，要 ${3 * w * h}`);
    const s = JSON.parse(fs.readFileSync(stats, 'utf8'));
    return { rgb, adapter: s.adapter ?? s.gpu ?? null };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** 逐球（物体编号 = 实例名在场景包里的序号加 1，只取覆盖率为 1 的像素）的平均亮度：核心 16 个种子的均值对收敛图 */
export function ballReadings(names, balls, cycles, cores) {
  const { w, h, id, coverage, rgb: conv } = cycles.converged;
  return balls.map((b) => {
    const oid = names.indexOf(b.entity) + 1;
    let n = 0, ref = 0;
    const per = cores.map(() => 0);
    for (let i = 0; i < w * h; i++) {
      if (id[i] !== oid || coverage[i] !== 1) continue;
      n++; ref += lum(conv, i);
      cores.forEach((c, s) => { per[s] += lum(c, i); });
    }
    if (!n) throw new Error(`${b.entity} 在画面上一个整像素都没有`);
    const means = per.map((x) => x / n), mean = means.reduce((a, x) => a + x, 0) / means.length;
    const sd = Math.sqrt(means.reduce((a, x) => a + (x - mean) ** 2, 0) / (means.length - 1));
    return { entity: b.entity, params: b.params, pixels: n, cycles: ref / n, core: mean, rel: (mean - ref / n) / (ref / n), z: (mean - ref / n) / (sd / Math.sqrt(means.length)) };
  });
}

/** 判一个场景包：两道门加逐球读数。override 是给内核的设置（负对照在这里改） */
export function judgePack(root, bin, g, { override } = {}) {
  const cycles = readRef(root, g.ref);
  const { ref } = cycles;
  if (cycles.seeds.length !== SEEDS.length) throw new Error(`${g.pack} 的参考包有 ${cycles.seeds.length} 个种子，要 ${SEEDS.length} 个`);
  const packDir = path.join(root, 'scene-packs', g.pack);
  const [w, h] = g.size;
  let adapter = null;
  const cores = SEEDS.map((seed) => {
    const r = renderCore(bin, packDir, { frame: g.frame, size: g.size, spp: ref.samples, seed, override: override ?? MATCH(ref) });
    adapter = r.adapter;
    return r.rgb;
  });
  const flipValue = hdrFlip(frame(w, h, cycles.seeds[0].rgb), frame(w, h, cores[0])).value;
  const floor = floorGate({ pack: ref, value: flipValue });
  const welch = welchGate(cores.map((c) => frame(w, h, c)), cycles.seeds.map((c) => frame(w, h, c.rgb)));
  const names = JSON.parse(fs.readFileSync(path.join(packDir, 'pack.json'), 'utf8')).instances.names;
  return {
    pack: g.pack, ref: g.ref, adapter, spp: ref.samples, size: g.size,
    floor: { status: floor.status, value: floorValue(floor, flipValue), threshold: floor.threshold ?? null, floor: floor.floor ?? null },
    welch: { pass: welch.pass, significantRatio: welch.significantRatio, alpha: welch.alpha, flat: welch.pHistogram.flat, testedUnits: welch.testedUnits, equivalentUnits: welch.equivalentUnits },
    ok: floor.status === 'pass' && welch.pass,
    balls: ballReadings(names, g.balls, cycles, cores),
  };
}
const floorValue = (f, v) => f.value ?? v;

export async function runLevel3({ root, only, log = () => {} }) {
  if (!root) throw missing('参考包根目录（--root 或 BEIMING_CORE_LADDER_ROOT）');
  const packs = level3Packs(root).filter((g) => !only || g.pack === only);
  if (!packs.length) throw new Error(only ? `第 3 级里没有场景包 ${only}` : '覆盖表里没有第 3 级的取值点');
  const { bin } = buildRenderer();
  const rows = [];
  for (const g of packs) {
    log(`第 3 级 ${g.pack}：${SEEDS.length} 个种子`);
    rows.push(judgePack(root, bin, g));
  }
  let negative = null;
  const ng = packs.find((g) => g.pack === NEGATIVE.pack);
  if (ng) {
    log(`负对照：${NEGATIVE.name}（${ng.pack}）`);
    const r = judgePack(root, bin, ng, { override: { ...MATCH(readRef(root, ng.ref).ref), ...NEGATIVE.override } });
    negative = { name: NEGATIVE.name, pack: ng.pack, floor: r.floor, welch: r.welch, caught: !r.ok };
  }
  let envNegative = null;
  const eg = packs.find((g) => g.pack === ENV_NEGATIVE.pack);
  if (eg) {
    log(`负对照：${ENV_NEGATIVE.name}（${eg.pack}）`);
    const r = judgePack(root, buildRenderer({ inject: ENV_NEGATIVE.inject }).bin, eg);
    envNegative = { name: ENV_NEGATIVE.name, pack: eg.pack, floor: r.floor, welch: r.welch, caught: !r.ok };
  }
  return { format: 'beiming.core.level3/1', k: THRESHOLDS.k, alpha: THRESHOLDS.welch.alpha, seeds: SEEDS.length, adapter: rows[0]?.adapter ?? null, rows, negative, envNegative,
    ok: rows.every((r) => r.ok) && (negative === null || negative.caught) && (envNegative === null || envNegative.caught) };
}

export const command = defineCommand({
  name: 'chassis-level3',
  summary: '对拍阶梯第 3 级：材质球逐输入扫参，核心 16 个种子对标准答案机的参考包，过「噪声地板乘 k」与 Welch 两道门',
  usage: ['node beiming/sources/core/chassis/level3.mjs --root <参考包根目录> [--only <场景包名>] [--out 报告.json]'],
  options: {
    root: { type: 'string', arg: '<目录>', describe: '参考包根目录（coverage.json、scene-packs/、refs/）；默认读 BEIMING_CORE_LADDER_ROOT' },
    only: { type: 'string', arg: '<场景包名>', describe: '只判这一包（负对照只在它是粗糙金属白炉那一包时跑）' },
    out: { type: 'string', arg: '<文件>', describe: '报告写到哪里（默认 out/chassis/level3/report.json）' },
  },
  exitCodes: { 0: '全部过', 2: '用法错误', 3: '缺工具链或参考包', 4: '有一项不过' },
  async run(ctx) {
    let report;
    try {
      report = await runLevel3({ root: ctx.opts.root ?? process.env.BEIMING_CORE_LADDER_ROOT, only: ctx.opts.only, log: (s) => ctx.log.info(s) });
    } catch (e) {
      if (e.missing) throw new CliError('env.chassis-toolchain', `缺：${e.missing}`, '参考包由标准答案机出，不在仓库里；要 cargo 与能跑 wgpu 的显卡');
      throw e;
    }
    const file = path.resolve(ctx.opts.out ?? path.join(WORK, 'report.json'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    for (const r of report.rows) {
      const worst = r.balls.reduce((a, b) => (Math.abs(b.rel) > Math.abs(a.rel) ? b : a));
      ctx.out(`${r.ok ? '✓' : '✗'} ${r.pack}  HDR-FLIP ${r.floor.value.toExponential(3)}（门 ${r.floor.threshold?.toExponential(3) ?? '未定线'}，${r.floor.status}）  Welch 显著比例 ${r.welch.significantRatio.toExponential(2)}（α ${r.welch.alpha}，p 值直方图${r.welch.flat ? '平' : '不平'}）  最差的球 ${worst.entity} 相对差 ${worst.rel.toExponential(2)}（${worst.z.toFixed(1)} 个标准误）`);
    }
    if (report.envNegative) ctx.out(`${report.envNegative.caught ? '✓' : '✗'} 负对照 ${report.envNegative.name}（${report.envNegative.pack}）：HDR-FLIP ${report.envNegative.floor.status}，Welch ${report.envNegative.welch.pass ? '过' : '不过'}（必须至少一道不过）`);
    if (report.negative) ctx.out(`${report.negative.caught ? '✓' : '✗'} 负对照 ${report.negative.name}（${report.negative.pack}）：HDR-FLIP ${report.negative.floor.status}，Welch ${report.negative.welch.pass ? '过' : '不过'}（必须至少一道不过）`);
    ctx.out(`报告：${file}`);
    return { data: report, outputs: [{ path: file, kind: 'report' }], ...(!report.ok && { error: { code: 'contract.chassis-level3', message: '第 3 级有不过的项', hint: `明细见 ${file}` } }) };
  },
});

if (isMain(import.meta.url)) await runCli(command);
