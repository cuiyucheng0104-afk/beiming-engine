// 「噪声地板乘 k」的门：核心对 Cycles 的差 ≤ k × 参考噪声地板（Cycles 换种子对 Cycles，同采样、同机器）。
// 地板从参考包清单的 floor 读，floor 缺段或三项有一项是 null 就判「未定线」（unset），不判过（参考包契约 RP3）；
// 门值就是 floor[metric] × k（RP4）。k、量和 Welch 的参数都只从 floor-gate.json 读，调用方传不进来；
// 改阈值文件和本文件要签字，见 floorguard.mjs。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { welchTest } from './welch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };
export const THRESHOLDS = deepFreeze(JSON.parse(fs.readFileSync(path.join(HERE, 'floor-gate.json'), 'utf8')));
export const FLOOR_KEYS = ['rerunBitExact', 'seedVsSeedPsnr', 'seedVsSeedFlipMean'];

const bad = (message) => Object.assign(new TypeError(`floorgate: ${message}`), { code: 'usage.bad-argument' });
const unit = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;

/**
 * 判一道门。pack 是参考包清单（ref-pack/0.1）。value 是核心的一张种子图对 Cycles 的一张种子图（同 pack.samples）的
 * HDR-FLIP 平均值，参数要和标准答案机量 floor.seedVsSeedFlipMean 时一样；不能拿收敛图去比（门会松约 √2 倍）。
 * 返回 { status: 'pass'|'fail'|'unset', ... }；判了的带 judging（metric、k、threshold），照参考包核对记录
 * judgings[] 的形状，可以直接交给参考包契约的 RP3、RP4 核对。
 */
export function floorGate({ pack, value }) {
  const { k, floorMetric: metric } = THRESHOLDS;
  if (!unit(value)) throw bad(`value 须为 [0, 1] 内的数，收到 ${value}`);
  const floor = pack?.floor;
  const missing = !floor || typeof floor !== 'object' ? ['floor'] : FLOOR_KEYS.filter((key) => !Object.hasOwn(floor, key) || floor[key] === null);
  if (missing.length) return { status: 'unset', metric, k, value, reason: `参考包清单的 floor 没填全（${missing.join('、')} 缺或是 null），这个包不当裁判` };
  const f = floor[metric];
  // 地板是 0 说明两个种子出了同一张图，种子没起作用：这是坏包，不是「门很严」
  if (!unit(f) || f === 0) throw bad(`floor.${metric} 须为 (0, 1] 内的数，收到 ${f}`);
  const threshold = f * k;
  return { status: value <= threshold ? 'pass' : 'fail', metric, k, floor: f, threshold, value, judging: { metric, k, threshold } };
}

/** 第 3 级的 Welch 检验：α、块大小、每边种子数都照阈值文件；门看返回的 pass。Welch 不乘 k：t 统计量本来就除以了换种子的标准误 */
export function welchGate(core, cycles) {
  const { alpha, blockSize, seeds } = THRESHOLDS.welch;
  if (!Array.isArray(core) || !Array.isArray(cycles) || core.length !== seeds || cycles.length !== seeds) {
    throw bad(`每边要正好 ${seeds} 个种子，收到 ${core?.length} 与 ${cycles?.length}`);
  }
  return welchTest(core, cycles, { alpha, blockSize });
}
