// 作业成本账本：每个终态作业往 ledger.jsonl 追加一行（墙钟、显卡秒、按模型档位分的 token、渲帧数、交付帧数、磁盘字节），
// 外加渲染前按草稿实测耗时的报价。数值原样落盘、不做四舍五入，汇总时逐行相加就不会累积舍入漂移。
import fs from 'node:fs';
import path from 'node:path';
import { checkJobId } from './workspace.mjs';

const TIERS = ['fable', 'opus', 'sonnet', 'haiku', 'other'];
const STATUSES = ['succeeded', 'failed', 'stopped', 'canceled'];

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} 必须是非负安全整数。`);
  return value;
}

function amount(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} 必须是非负有限数。`);
  return value;
}

function positive(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} 必须是正数。`);
  return value;
}

function area(size, name) {
  if (!Array.isArray(size) || size.length !== 2) throw new TypeError(`${name} 必须是 [宽, 高]。`);
  return positive(size[0], `${name}[0]`) * positive(size[1], `${name}[1]`);
}

/** 目录里常规文件的字节数之和。符号链接不跟（防环、也不把工作区外的文件算进来）；目录不存在算 0。 */
export function measureDiskBytes(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  let bytes = 0;
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes += measureDiskBytes(file);
    // 别的作业正在原子写入时，暂存文件会在统计途中消失，消失的算 0。
    else if (entry.isFile()) bytes += fs.lstatSync(file, { throwIfNoEntry: false })?.size ?? 0;
  }
  return bytes;
}

/** 读回账本的全部行；文件不存在是空账本，坏行直接报错（账本不静默丢行）。 */
export function readJobLedger(ledgerPath) {
  let text;
  try {
    text = fs.readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`作业账本第 ${index + 1} 行损坏。`, { cause: error });
    }
  });
}

/**
 * 追加一行作业成本并交回这一行。
 * 显卡秒：给了 gpuSeconds 就用它（调用方的实测优先，不与帧元数据相加，免得重复计）；没给就把 frameMetas 每帧的 timing.renderMs 加起来。
 * 磁盘字节：给了 diskBytes 就用它；没给就实测 workspaceDir。
 */
export function appendJobLedger(ledgerPath, entry) {
  const { job, kind, status, frameMetas = [], tokensByTier = {}, workspaceDir } = entry;
  checkJobId(job);
  if (typeof kind !== 'string' || !kind) throw new TypeError('作业类型必须是非空字符串。');
  if (!STATUSES.includes(status)) throw new RangeError(`账本只记终态作业（${STATUSES.join('、')}）。`);
  for (const tier of Object.keys(tokensByTier)) {
    if (!TIERS.includes(tier)) throw new RangeError(`未知的模型档位 ${tier}（可用：${TIERS.join('、')}）。`);
  }
  const tokens = Object.fromEntries(TIERS.map(tier => [tier, count(tokensByTier[tier] ?? 0, `tokensByTier.${tier}`)]));
  // 先把毫秒加完再除一次，整数毫秒的帧就得到精确的秒数。
  const gpuSeconds = entry.gpuSeconds ??
    frameMetas.reduce((ms, meta) => ms + amount(meta?.timing?.renderMs, 'meta.timing.renderMs'), 0) / 1000;
  const diskBytes = entry.diskBytes ?? (workspaceDir === undefined ? undefined : measureDiskBytes(workspaceDir));
  const row = {
    // shortcut: 序号取现有行数加一，多个进程同时追加会重号（行不会丢，汇总也不依赖序号），要并发记账时加锁文件。
    seq: readJobLedger(ledgerPath).length + 1,
    job,
    kind,
    rev: count(entry.rev, 'rev'),
    status,
    wallMs: amount(entry.wallMs, 'wallMs'),
    gpuSeconds: amount(gpuSeconds, 'gpuSeconds'),
    tokensByTier: tokens,
    totalTokens: TIERS.reduce((sum, tier) => sum + tokens[tier], 0),
    renderedFrames: count(entry.renderedFrames, 'renderedFrames'),
    deliveredFrames: count(entry.deliveredFrames, 'deliveredFrames'),
    diskBytes: count(diskBytes, 'diskBytes（或给 workspaceDir 实测）'),
  };
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);
  return row;
}

/** 汇总账本：传行数组或账本路径。磁盘是存量不是流量，所以取峰值 maxDiskBytes，其余各维相加。 */
export function summarizeJobLedger(rowsOrPath) {
  const rows = typeof rowsOrPath === 'string' ? readJobLedger(rowsOrPath) : rowsOrPath;
  const sum = {
    count: rows.length,
    ...Object.fromEntries(STATUSES.map(status => [status, 0])),
    wallMs: 0,
    gpuSeconds: 0,
    tokensByTier: Object.fromEntries(TIERS.map(tier => [tier, 0])),
    totalTokens: 0,
    renderedFrames: 0,
    deliveredFrames: 0,
    maxDiskBytes: 0,
  };
  for (const row of rows) {
    if (STATUSES.includes(row.status)) sum[row.status] += 1;
    sum.wallMs += row.wallMs;
    sum.gpuSeconds += row.gpuSeconds;
    for (const tier of TIERS) sum.tokensByTier[tier] += row.tokensByTier[tier];
    sum.totalTokens += row.totalTokens;
    sum.renderedFrames += row.renderedFrames;
    sum.deliveredFrames += row.deliveredFrames;
    sum.maxDiskBytes = Math.max(sum.maxDiskBytes, row.diskBytes);
  }
  return sum;
}

/**
 * 渲染前报价：用草稿的实测耗时推终渲。
 * 一阶模型：单帧耗时与像素数、采样数成正比；墙钟按同一比例放大，保留草稿实测的墙钟与显卡秒之比。
 */
export function quoteFromDraft({ draftFrames, draftGpuSeconds, draftWallMs, draftSize, draftSamples, targetFrames, targetSize, targetSamples }) {
  const areaScale = area(targetSize, 'targetSize') / area(draftSize, 'draftSize');
  const sampleScale = positive(targetSamples, 'targetSamples') / positive(draftSamples, 'draftSamples');
  const scale = areaScale * sampleScale * positive(targetFrames, 'targetFrames') / positive(draftFrames, 'draftFrames');
  return {
    areaScale,
    sampleScale,
    perFrameGpuSeconds: positive(draftGpuSeconds, 'draftGpuSeconds') / draftFrames,
    estimatedGpuSeconds: draftGpuSeconds * scale,
    estimatedWallMs: positive(draftWallMs, 'draftWallMs') * scale,
  };
}
