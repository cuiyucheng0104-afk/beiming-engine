// 作业成本账本：每个作业的每一轮终态往 ledger.jsonl 追加一行（墙钟、显卡秒、按模型档位分的 token、渲帧数、交付帧数、磁盘字节），
// 外加渲染前按草稿实测耗时的报价。数值原样落盘、不做四舍五入，汇总时逐行相加就不会累积舍入漂移。
// 写入与读回过同一套校验：坏入参不落盘，坏行带物理行号报错，账本不静默丢行、也不静默改数。
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { atomicWrite, checkJobId, processIsAlive } from './workspace.mjs';

const FORMAT = 'job-ledger/0.1';
const TIERS = ['fable', 'opus', 'sonnet', 'haiku', 'other'];
const STATUSES = ['succeeded', 'failed', 'stopped', 'canceled'];
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const zeroTiers = () => Object.fromEntries(TIERS.map(tier => [tier, 0]));

function count(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} 必须是非负安全整数。`);
  return value;
}

function positiveCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} 必须是正安全整数。`);
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

function finite(value, name) {
  if (!Number.isFinite(value)) throw new RangeError(`${name} 超出可表示的范围。`);
  return value;
}

function plain(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} 必须是对象。`);
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} 必须是非空字符串。`);
  return value;
}

function area(size, name) {
  if (!Array.isArray(size) || size.length !== 2) throw new TypeError(`${name} 必须是 [宽, 高]。`);
  return positiveCount(size[0], `${name}[0]`) * positiveCount(size[1], `${name}[1]`);
}

// 汇总要用到的六维成本：新行、旧 API 行映射出来的行、直接传给汇总的行，都过这一关。
function checkCosts(row) {
  plain(row, '账本记录');
  if (!STATUSES.includes(row.status)) throw new RangeError(`账本只记终态作业（${STATUSES.join('、')}）。`);
  amount(row.wallMs, 'wallMs');
  amount(row.gpuSeconds, 'gpuSeconds');
  const tokens = plain(row.tokensByTier, 'tokensByTier');
  for (const tier of Object.keys(tokens)) {
    if (!TIERS.includes(tier)) throw new RangeError(`未知的模型档位 ${tier}（可用：${TIERS.join('、')}）。`);
  }
  const total = TIERS.reduce((sum, tier) => sum + count(tokens[tier], `tokensByTier.${tier}`), 0);
  if (!Number.isSafeInteger(total)) throw new RangeError('各档 token 合计超出安全整数范围。');
  if (row.totalTokens !== total) throw new RangeError('totalTokens 必须等于各档 token 之和。');
  count(row.renderedFrames, 'renderedFrames');
  count(row.deliveredFrames, 'deliveredFrames');
  count(row.diskBytes, 'diskBytes');
  return row;
}

function checkRow(row) {
  checkCosts(row);
  positiveCount(row.seq, 'seq');
  checkJobId(row.jobId);
  positiveCount(row.attempt, 'attempt');
  text(row.kind, 'kind');
  if (row.handler !== undefined) text(row.handler, 'handler');
  if (row.rev !== undefined) count(row.rev, 'rev');
  if (typeof row.gpuKnown !== 'boolean') throw new TypeError('gpuKnown 必须是布尔值。');
  return row;
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

/**
 * 把一行解析后的 JSON 认成账本记录：job-ledger/0.1 行逐字段校验后原样交回。
 * allowLegacyApiRows 时兼容 beiming/api 的旧账本（<数据目录>/meta/<片子>.ledger.jsonl）：作业终态行映射成同样的六维并标 legacyApiRow，
 * 请求流水行与钩子行交回 null（不是作业成本）。旧行只有不分档的 tokens 与 modelTokens，两者都归进 other 档。
 */
export function normalizeLedgerEntry(raw, { allowLegacyApiRows = false } = {}) {
  plain(raw, '账本记录');
  if (raw.format === FORMAT) return checkRow(raw);
  if (!allowLegacyApiRows) throw new TypeError(`不是 ${FORMAT} 行（旧 API 账本用 allowLegacyApiRows 读）。`);
  const step = typeof raw.step === 'string' && raw.step.startsWith('job.') ? raw.step.slice('job.'.length) : undefined;
  if (step === undefined && raw.kind !== 'job') {
    if (typeof raw.step === 'string' || raw.kind === 'request') return null;
    throw new TypeError('认不出的账本行。');
  }
  const tokens = count(raw.tokens ?? 0, 'tokens') + count(raw.modelTokens ?? 0, 'modelTokens');
  return checkCosts({
    legacyApiRow: true,
    ...(raw.seq !== undefined && { seq: positiveCount(raw.seq, 'seq') }),
    jobId: text(raw.jobId ?? raw.job, 'jobId'),
    attempt: 1,
    kind: step || 'job',
    ...(raw.rev !== undefined && { rev: count(raw.rev, 'rev') }),
    status: raw.status,
    wallMs: raw.wallMs,
    gpuSeconds: raw.gpuSeconds ?? 0,
    gpuKnown: typeof raw.gpuSeconds === 'number',
    tokensByTier: { ...zeroTiers(), other: tokens },
    totalTokens: tokens,
    renderedFrames: raw.frames ?? 0,
    deliveredFrames: 0,
    diskBytes: raw.diskBytes ?? 0,
  });
}

// 行号按物理行算：空行跳过但占号，报错的行号能直接在编辑器里找到。
function load(ledgerPath, options) {
  let content = '';
  try {
    content = fs.readFileSync(ledgerPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const rows = [];
  content.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const row = normalizeLedgerEntry(JSON.parse(line), options);
      if (row) rows.push(row);
    } catch (error) {
      throw new Error(`作业账本第 ${index + 1} 行损坏：${error.message}`, { cause: error });
    }
  });
  return { content, rows };
}

/** 读回账本的全部行；文件不存在是空账本，坏行直接报错。默认只认 job-ledger/0.1，旧 API 账本传 { allowLegacyApiRows: true }。 */
export function readJobLedger(ledgerPath, options) {
  return load(ledgerPath, options).rows;
}

// 锁文件里是持锁进程号。只有拿到 .break 的进程才能删锁，而且删之前重读一遍进程号，所以活着的锁不会被误删。
// shortcut: 进程号被系统复用，或进程恰好死在持有 .break 的瞬间，陈旧锁就清不掉、追加会超时报错（不会写坏账），那时手工删掉 .lock 与 .lock.break；要无人值守恢复再换成带租期的锁。
function clearStaleLock(lock) {
  const breaker = `${lock}.break`;
  try {
    fs.writeFileSync(breaker, '', { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return;
    throw error;
  }
  try {
    if (!processIsAlive(Number(fs.readFileSync(lock, 'utf8').trim()))) fs.rmSync(lock);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    fs.rmSync(breaker, { force: true });
  }
}

function withLock(ledgerPath, timeoutMs, run) {
  const lock = `${ledgerPath}.lock`;
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const deadline = performance.now() + amount(timeoutMs, 'lockTimeoutMs');
  for (let waitMs = 1; ; waitMs = Math.min(waitMs * 2, 50)) {
    if (!fs.existsSync(lock)) {
      try {
        atomicWrite(lock, `${process.pid}\n`, { create: true }); // 硬链接创建：要么整个锁带着进程号出现，要么已存在
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    clearStaleLock(lock);
    if (performance.now() >= deadline) throw new Error(`等待账本锁 ${lock} 超时，另一个进程正在记账。`);
    Atomics.wait(sleeper, 0, 0, waitMs);
  }
  try {
    return run();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/**
 * 追加一行作业成本并交回这一行。同一个 (jobId, attempt) 只记一次：重复结算交回已有的那一行，不再追加。
 * 显卡秒：给了 gpuSeconds 就用它（调用方的实测优先，不与帧元数据相加，免得重复计）；没给就把 frameMetas 每帧的 timing.renderMs 加起来；
 * 两样都没给记 0 并标 gpuKnown: false。磁盘字节：给了 diskBytes 就用它；没给就实测 workspaceDir。
 */
export function appendJobLedger(ledgerPath, entry, { lockTimeoutMs = 10_000 } = {}) {
  const { frameMetas, tokensByTier = {}, workspaceDir } = plain(entry, '账本记录');
  if (frameMetas !== undefined && !Array.isArray(frameMetas)) throw new TypeError('frameMetas 必须是数组。');
  const tokens = { ...zeroTiers(), ...plain(tokensByTier, 'tokensByTier') };
  const row = checkRow({
    format: FORMAT,
    seq: 1,
    jobId: entry.jobId,
    attempt: entry.attempt === undefined ? 1 : entry.attempt,
    kind: entry.kind,
    ...(entry.handler !== undefined && { handler: entry.handler }),
    ...(entry.rev !== undefined && { rev: entry.rev }),
    status: entry.status,
    wallMs: entry.wallMs,
    // 先把毫秒加完再除一次，整数毫秒的帧就得到精确的秒数。
    gpuSeconds: entry.gpuSeconds !== undefined ? entry.gpuSeconds :
      (frameMetas ?? []).reduce((ms, meta) => ms + amount(meta?.timing?.renderMs, 'meta.timing.renderMs'), 0) / 1000,
    gpuKnown: entry.gpuSeconds !== undefined || frameMetas !== undefined,
    tokensByTier: tokens,
    totalTokens: TIERS.reduce((sum, tier) => sum + tokens[tier], 0),
    renderedFrames: entry.renderedFrames,
    deliveredFrames: entry.deliveredFrames,
    diskBytes: entry.diskBytes !== undefined || workspaceDir === undefined ? entry.diskBytes : measureDiskBytes(workspaceDir),
  });
  // shortcut: 每次追加都在锁里重读整本账来查重、取序号，单次 O(行数)；账本到十万行级再换成尾部索引。
  return withLock(ledgerPath, lockTimeoutMs, () => {
    const { content, rows } = load(ledgerPath);
    const settled = rows.find(existing => existing.jobId === row.jobId && existing.attempt === row.attempt);
    if (settled) return settled;
    row.seq = rows.reduce((max, existing) => Math.max(max, existing.seq), 0) + 1;
    // 上一次写入断在半行或被人手改掉了结尾换行时，先补换行，新行不会接在旧行后面。
    fs.appendFileSync(ledgerPath, `${content && !content.endsWith('\n') ? '\n' : ''}${JSON.stringify(row)}\n`, { flush: true });
    return row;
  });
}

/**
 * 汇总账本：传行数组，或账本路径（options 同 readJobLedger）。磁盘是存量不是流量，所以取峰值 maxDiskBytes，其余各维相加。
 * gpuUnknownRows 是没有显卡秒实测的行数：它不为 0 时，gpuSeconds 合计只是下限。
 */
export function summarizeJobLedger(rowsOrPath, options) {
  const rows = typeof rowsOrPath === 'string' ? readJobLedger(rowsOrPath, options) : rowsOrPath;
  if (!Array.isArray(rows)) throw new TypeError('汇总需要账本路径或行数组。');
  const sum = {
    count: rows.length,
    ...Object.fromEntries(STATUSES.map(status => [status, 0])),
    wallMs: 0,
    gpuSeconds: 0,
    gpuUnknownRows: 0,
    legacyRows: 0,
    tokensByTier: zeroTiers(),
    totalTokens: 0,
    renderedFrames: 0,
    deliveredFrames: 0,
    maxDiskBytes: 0,
  };
  rows.forEach((row, index) => {
    try {
      checkCosts(row);
    } catch (error) {
      error.message = `第 ${index + 1} 条账本记录无效：${error.message}`;
      throw error;
    }
    sum[row.status] += 1;
    sum.wallMs += row.wallMs;
    sum.gpuSeconds += row.gpuSeconds;
    if (row.gpuKnown === false) sum.gpuUnknownRows += 1;
    if (row.legacyApiRow === true) sum.legacyRows += 1;
    for (const tier of TIERS) sum.tokensByTier[tier] += row.tokensByTier[tier];
    sum.totalTokens += row.totalTokens;
    sum.renderedFrames += row.renderedFrames;
    sum.deliveredFrames += row.deliveredFrames;
    sum.maxDiskBytes = Math.max(sum.maxDiskBytes, row.diskBytes);
  });
  // 各档都不超过合计，所以查这三项就够了。
  for (const name of ['totalTokens', 'renderedFrames', 'deliveredFrames']) {
    if (!Number.isSafeInteger(sum[name])) throw new RangeError(`${name} 累计超出安全整数范围。`);
  }
  finite(sum.wallMs, 'wallMs 累计');
  finite(sum.gpuSeconds, 'gpuSeconds 累计');
  return sum;
}

/**
 * 渲染前报价：用草稿的实测耗时推终渲。
 * 一阶模型：单帧耗时与像素数、采样数成正比；墙钟按同一比例放大，保留草稿实测的墙钟与显卡秒之比。
 * 帧数、画幅与采样数只收正安全整数；报价不取整，溢出时报错而不是交回 Infinity。
 */
export function quoteFromDraft({ draftFrames, draftGpuSeconds, draftWallMs, draftSize, draftSamples, targetFrames, targetSize, targetSamples }) {
  const areaScale = area(targetSize, 'targetSize') / area(draftSize, 'draftSize');
  const sampleScale = positiveCount(targetSamples, 'targetSamples') / positiveCount(draftSamples, 'draftSamples');
  const scale = areaScale * sampleScale * positiveCount(targetFrames, 'targetFrames') / positiveCount(draftFrames, 'draftFrames');
  return {
    areaScale,
    sampleScale,
    perFrameGpuSeconds: positive(draftGpuSeconds, 'draftGpuSeconds') / draftFrames,
    estimatedGpuSeconds: finite(draftGpuSeconds * scale, 'estimatedGpuSeconds'),
    estimatedWallMs: finite(positive(draftWallMs, 'draftWallMs') * scale, 'estimatedWallMs'),
  };
}
