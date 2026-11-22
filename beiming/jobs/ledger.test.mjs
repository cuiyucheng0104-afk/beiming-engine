import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs, { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import * as jobs from './index.mjs';
import { withFileLock } from './ledger.mjs';

const api = new URL('./index.mjs', import.meta.url).href;
const zeroTiers = { fable: 0, opus: 0, sonnet: 0, haiku: 0, other: 0 };
const baseRow = { jobId: 'j-1', kind: 'draft', rev: 0, status: 'succeeded', wallMs: 10, renderedFrames: 2, deliveredFrames: 0, diskBytes: 7 };

function tempDir(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `bm-a15-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 一个已发布修订 0 的最小工作区，外加接好执行器的队列。
function queueFixture(t, handlers) {
  const workspace = jobs.openWorkspace(tempDir(t, 'queue'));
  const film = { format: 'film/3.0', id: 'demo', output: { size: [16, 16], fps: '24', frames: 1 },
    shots: [{ id: 's01', in: 0, out: 1, source: 'three', host: 'page', mode: 'build-script', entry: 'shots/s01.mjs', colorRef: 'scene' }],
    style: { view: { scene: 'linear', display: 'srgb' } }, predicates: { base: [] }, delivery: { master: 'test' } };
  writeFileSync(workspace.resolve('film.json'), JSON.stringify(film));
  writeFileSync(workspace.resolve('shots/s01.mjs'), 'initial');
  const snapshot = workspace.commitRevision(0);
  return { workspace, snapshot, queue: jobs.loadQueue(workspace.root, { handlers }) };
}

test('A15-1 作业账本单行六维字段与从帧元数据 renderMs 累加显卡秒', () => {
  assert.equal(typeof jobs.appendJobLedger, 'function', '缺少 appendJobLedger 导出');
  assert.equal(typeof jobs.readJobLedger, 'function', '缺少 readJobLedger 导出');
  assert.equal(typeof jobs.summarizeJobLedger, 'function', '缺少 summarizeJobLedger 导出');
  assert.equal(typeof jobs.quoteFromDraft, 'function', '缺少 quoteFromDraft 导出');
  assert.equal(typeof jobs.measureDiskBytes, 'function', '缺少 measureDiskBytes 导出');

  const dir = mkdtempSync(join(tmpdir(), 'bm-a15-one-'));
  try {
    writeFileSync(join(dir, 'frame-0.bin'), Buffer.alloc(4096, 1));
    writeFileSync(join(dir, 'frame-1.bin'), Buffer.alloc(2048, 2));
    const disk = jobs.measureDiskBytes(dir);
    assert.equal(disk, 6144);

    const ledgerPath = join(dir, 'ledger.jsonl');
    const row = jobs.appendJobLedger(ledgerPath, {
      jobId: 'j-1',
      kind: 'deliver',
      rev: 3,
      status: 'succeeded',
      wallMs: 12450,
      frameMetas: [{ timing: { renderMs: 1250 } }, { timing: { renderMs: 1750 } }],
      tokensByTier: { opus: 42000, sonnet: 18000, fable: 5000 },
      renderedFrames: 180,
      deliveredFrames: 300,
      workspaceDir: dir,
    });

    assert.deepEqual([row.format, row.seq, row.jobId, row.attempt, row.gpuKnown], ['job-ledger/0.1', 1, 'j-1', 1, true]);
    assert.equal(row.gpuSeconds, 3);
    assert.deepEqual(row.tokensByTier, { fable: 5000, opus: 42000, sonnet: 18000, haiku: 0, other: 0 });
    assert.equal(row.totalTokens, 65000);
    assert.equal(row.renderedFrames, 180);
    assert.equal(row.deliveredFrames, 300);
    assert.ok(row.diskBytes >= 6144);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A15-2 渲染前按草稿帧实测耗时报价 quoteFromDraft', () => {
  // 草稿 960x540, 16 spp, 渲了 3 帧共 4.5 秒（每帧 1.5s）
  // 终渲 1920x1080（面积 ×4）, 32 spp（采样 ×2）, 共 180 帧 => 1.5 * 4 * 2 * 180 = 2160 秒
  const quote = jobs.quoteFromDraft({
    draftFrames: 3,
    draftGpuSeconds: 4.5,
    draftWallMs: 5100,
    draftSize: [960, 540],
    draftSamples: 16,
    targetFrames: 180,
    targetSize: [1920, 1080],
    targetSamples: 32,
  });
  assert.ok(Math.abs(quote.estimatedGpuSeconds - 2160) < 1e-6);
  assert.ok(quote.estimatedWallMs >= 2160 * 1000);
  assert.equal(quote.areaScale, 4);
  assert.equal(quote.sampleScale, 2);
});

test('A15-3 连续 20 次重复作业记账与汇总对账误差 <= 1%', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-a15-twenty-'));
  try {
    const ledgerPath = join(dir, 'ledger.jsonl');
    let truthWall = 0;
    let truthGpu = 0;
    let truthTok = 0;
    let truthRendered = 0;
    let truthDelivered = 0;

    for (let i = 1; i <= 20; i++) {
      const wallMs = 40000 + i * 317;
      const frameMetas = Array.from({ length: 10 }, (_, k) => ({ timing: { renderMs: 210.5 + i * 3.2 + k } }));
      const gpuSec = frameMetas.reduce((s, m) => s + m.timing.renderMs, 0) / 1000;
      const opus = 300000 + i * 1500;
      const sonnet = 120000 + i * 800;
      const fable = 8500 + i * 100;
      const renderedFrames = 300;
      const deliveredFrames = i % 5 === 0 ? 0 : 300;

      truthWall += wallMs;
      truthGpu += gpuSec;
      truthTok += opus + sonnet + fable;
      truthRendered += renderedFrames;
      truthDelivered += deliveredFrames;

      jobs.appendJobLedger(ledgerPath, {
        jobId: `j-${i}`,
        kind: 'delegate',
        rev: 2,
        status: deliveredFrames ? 'succeeded' : 'failed',
        wallMs,
        frameMetas,
        tokensByTier: { opus, sonnet, fable },
        renderedFrames,
        deliveredFrames,
        diskBytes: 8_000_000 + i * 1024,
      });
    }

    const rows = jobs.readJobLedger(ledgerPath);
    assert.equal(rows.length, 20);
    const sum = jobs.summarizeJobLedger(rows);
    assert.equal(sum.count, 20);
    assert.equal(sum.succeeded, 16);
    assert.ok(Math.abs(sum.wallMs - truthWall) / truthWall <= 0.01);
    assert.ok(Math.abs(sum.gpuSeconds - truthGpu) / truthGpu <= 0.01, `gpu diff: ${sum.gpuSeconds} vs ${truthGpu}`);
    assert.ok(Math.abs(sum.totalTokens - truthTok) / truthTok <= 0.01);
    assert.equal(sum.renderedFrames, truthRendered);
    assert.equal(sum.deliveredFrames, truthDelivered);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A15-4 显式值优先、磁盘统计不跟符号链接、坏入参与坏行一律报错', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bm-a15-edge-'));
  try {
    mkdirSync(join(dir, 'ws/frames'), { recursive: true });
    writeFileSync(join(dir, 'ws/frames/a.bin'), Buffer.alloc(1000));
    writeFileSync(join(dir, 'ws/b.bin'), Buffer.alloc(24));
    writeFileSync(join(dir, 'outside.bin'), Buffer.alloc(5000));
    symlinkSync(join(dir, 'outside.bin'), join(dir, 'ws/file-link'));
    symlinkSync(join(dir, 'ws'), join(dir, 'ws/frames/loop'));
    assert.equal(jobs.measureDiskBytes(join(dir, 'ws')), 1024);
    assert.equal(jobs.measureDiskBytes(join(dir, 'missing')), 0);

    const ledgerPath = join(dir, 'nested/ledger.jsonl');
    const base = { jobId: 'j-1', kind: 'draft', rev: 0, status: 'stopped', wallMs: 10, renderedFrames: 2, deliveredFrames: 0, diskBytes: 7 };
    // 显式 gpuSeconds 与 diskBytes 压过帧元数据与目录实测，不相加。
    const explicit = jobs.appendJobLedger(ledgerPath, { ...base, gpuSeconds: 9.5, frameMetas: [{ timing: { renderMs: 1000 } }], workspaceDir: join(dir, 'ws') });
    assert.equal(explicit.gpuSeconds, 9.5);
    assert.equal(explicit.diskBytes, 7);
    const measured = jobs.appendJobLedger(ledgerPath, { ...base, jobId: 'j-2', status: 'canceled', diskBytes: undefined, workspaceDir: join(dir, 'ws') });
    assert.deepEqual([explicit.gpuKnown, measured.gpuKnown], [true, false]);
    assert.deepEqual([measured.seq, measured.gpuSeconds, measured.diskBytes, measured.totalTokens], [2, 0, 1024, 0]);

    const bad = [
      { jobId: 'J 1' },
      { kind: '' },
      { status: 'running' },
      { rev: -1 },
      { wallMs: Number.NaN },
      { gpuSeconds: -1 },
      { frameMetas: [{ timing: {} }] },
      { tokensByTier: { gpt: 1 } },
      { tokensByTier: { opus: 1.5 } },
      { renderedFrames: '2' },
      { deliveredFrames: -1 },
      { diskBytes: undefined },
    ];
    for (const patch of bad) assert.throws(() => jobs.appendJobLedger(ledgerPath, { ...base, ...patch }), JSON.stringify(patch));

    // 被拒的行一行都没落盘；汇总可以直接传路径，磁盘取峰值。
    const sum = jobs.summarizeJobLedger(ledgerPath);
    assert.deepEqual(
      [sum.count, sum.succeeded, sum.failed, sum.stopped, sum.canceled, sum.gpuSeconds, sum.maxDiskBytes],
      [2, 0, 0, 1, 1, 9.5, 1024],
    );
    assert.deepEqual(jobs.readJobLedger(join(dir, 'none.jsonl')), []);
    assert.equal(jobs.summarizeJobLedger([]).count, 0);

    appendFileSync(ledgerPath, '{"seq":3,"job":\n');
    assert.throws(() => jobs.readJobLedger(ledgerPath), /第 3 行损坏/);
    assert.throws(() => jobs.appendJobLedger(ledgerPath, base), /第 3 行损坏/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A15-5 一万行累计不漂移，报价拒绝非正数与坏画幅', () => {
  const rows = Array.from({ length: 10000 }, () => ({
    status: 'succeeded', wallMs: 100.1, gpuSeconds: 0.1, tokensByTier: { fable: 0, opus: 1, sonnet: 0, haiku: 0, other: 0 },
    totalTokens: 1, renderedFrames: 1, deliveredFrames: 1, diskBytes: 1,
  }));
  const sum = jobs.summarizeJobLedger(rows);
  assert.ok(Math.abs(sum.gpuSeconds - 1000) / 1000 < 1e-9, `gpu: ${sum.gpuSeconds}`);
  assert.ok(Math.abs(sum.wallMs - 1001000) / 1001000 < 1e-9, `wall: ${sum.wallMs}`);
  assert.equal(sum.tokensByTier.opus, 10000);

  const good = { draftFrames: 2, draftGpuSeconds: 3, draftWallMs: 2000, draftSize: [960, 540], draftSamples: 16, targetFrames: 2, targetSize: [960, 540], targetSamples: 16 };
  // 多卡并行时墙钟可以小于显卡秒，报价保留这个比例。
  assert.deepEqual(jobs.quoteFromDraft(good), { areaScale: 1, sampleScale: 1, perFrameGpuSeconds: 1.5, estimatedGpuSeconds: 3, estimatedWallMs: 2000 });
  for (const patch of [{ draftFrames: 0 }, { draftGpuSeconds: 0 }, { draftWallMs: -1 }, { draftSamples: 0 }, { targetFrames: Number.NaN }, { targetSamples: '32' }, { draftSize: [960] }, { targetSize: [1920, 0] }]) {
    assert.throws(() => jobs.quoteFromDraft({ ...good, ...patch }), JSON.stringify(patch));
  }
});

test('A15-6 队列终态自动结算：20 个真实作业各落一行六维账，对账误差 <= 1%，账本不进快照', async t => {
  const blob = 4096; // 字节
  const costOf = i => ({
    wallMs: 400 + i * 31,
    frameMetas: [{ timing: { renderMs: 120.5 + i } }, { timing: { renderMs: 80 } }],
    tokensByTier: { opus: 1000 + i, haiku: 7 },
    renderedFrames: 2,
    deliveredFrames: i % 5 === 0 ? 0 : 2,
  });
  const { workspace, snapshot, queue } = queueFixture(t, {
    draft: async ({ job, intermediateDir, step }) => {
      writeFileSync(join(intermediateDir, 'frames.bin'), Buffer.alloc(blob));
      await step('render', () => {});
      const cost = costOf(job.payload.i);
      // 失败的作业同样花了钱：成本挂在抛出的错误上。
      if (job.payload.i % 5 === 0) throw Object.assign(new Error('渲染失败'), { cost });
      return { cost };
    },
  });
  const truth = { wallMs: 0, gpuSeconds: 0, tokens: 0, rendered: 0, delivered: 0 };
  for (let i = 1; i <= 20; i += 1) {
    const job = queue.enqueue({ kind: 'draft', rev: 0, payload: { i } });
    const done = await queue.runJob(job.id);
    assert.equal(done.status, i % 5 === 0 ? 'failed' : 'succeeded');
    assert.equal(done.events.at(-1).ledgerError, undefined);
    const cost = costOf(i);
    truth.wallMs += cost.wallMs;
    truth.gpuSeconds += (cost.frameMetas[0].timing.renderMs + 80) / 1000;
    truth.tokens += cost.tokensByTier.opus + 7;
    truth.rendered += 2;
    truth.delivered += cost.deliveredFrames;
  }

  assert.equal(queue.ledgerFile(), workspace.resolve('jobs/ledger.jsonl'));
  const rows = queue.readLedger();
  assert.equal(rows.length, 20);
  rows.forEach((row, index) => {
    const cost = costOf(index + 1);
    assert.deepEqual({ ...row, diskBytes: 0 }, {
      format: 'job-ledger/0.1', seq: index + 1, jobId: `job-${index + 1}`, attempt: 1, kind: 'draft', handler: 'draft', rev: 0,
      status: (index + 1) % 5 === 0 ? 'failed' : 'succeeded', wallMs: cost.wallMs,
      gpuSeconds: (cost.frameMetas[0].timing.renderMs + 80) / 1000, gpuKnown: true,
      tokensByTier: { ...zeroTiers, ...cost.tokensByTier }, totalTokens: cost.tokensByTier.opus + 7,
      renderedFrames: 2, deliveredFrames: cost.deliveredFrames, diskBytes: 0,
    });
    // 磁盘在清理中间产物之前采样，所以算得进已经被清掉的那 4096 字节。
    assert.ok(row.diskBytes >= blob + 'initial'.length, `diskBytes: ${row.diskBytes}`);
    assert.equal(existsSync(workspace.intermediateDir(row.jobId)), false);
  });

  const sum = queue.summarizeLedger();
  assert.deepEqual([sum.count, sum.succeeded, sum.failed, sum.gpuUnknownRows], [20, 16, 4, 0]);
  const within = (actual, expected) => Math.abs(actual - expected) / expected <= 0.01;
  assert.ok(within(sum.wallMs, truth.wallMs) && within(sum.gpuSeconds, truth.gpuSeconds), JSON.stringify(sum));
  assert.deepEqual([sum.wallMs, sum.totalTokens, sum.tokensByTier.haiku, sum.renderedFrames, sum.deliveredFrames],
    [truth.wallMs, truth.tokens, 140, truth.rendered, truth.delivered]);
  assert.equal(sum.maxDiskBytes, Math.max(...rows.map(row => row.diskBytes)));

  // 账本在 jobs/ 下，不属于作品输入：同一修订再发布一次，快照哈希不变。
  assert.deepEqual(workspace.commitRevision(0), snapshot);
  assert.deepEqual(queue.listJobs().length, 20);
});

test('A15-7 未回报成本标 gpuKnown:false，replay 记新轮次，重复结算幂等，按草稿实测报价，记账失败不扣住作业', async t => {
  const { queue } = queueFixture(t, {
    draft: async ({ job }) => {
      await new Promise(resolve => setTimeout(resolve, 20)); // 毫秒
      return job.payload ?? 'ok';
    },
  });
  queue.enqueue({ id: 'plain', kind: 'draft', rev: 0 });
  await queue.runJob('plain');
  let rows = queue.readLedger();
  assert.deepEqual([rows[0].gpuSeconds, rows[0].gpuKnown, rows[0].totalTokens, rows[0].renderedFrames], [0, false, 0, 0]);
  assert.ok(rows[0].wallMs >= 15 && rows[0].wallMs < 5000, `wallMs: ${rows[0].wallMs}`);
  assert.ok(rows[0].diskBytes > 0);
  assert.equal(queue.summarizeLedger().gpuUnknownRows, 1);

  // replay 是新的一轮实际执行，记新行；同一 (jobId, attempt) 的结算再来一次不记。
  assert.equal((await queue.replay('plain')).attempt, 2);
  rows = queue.readLedger();
  assert.deepEqual(rows.map(row => [row.seq, row.jobId, row.attempt]), [[1, 'plain', 1], [2, 'plain', 2]]);
  assert.deepEqual(jobs.appendJobLedger(queue.ledgerFile(), { ...rows[1], wallMs: 999999 }), rows[1]);
  assert.equal(queue.readLedger().length, 2);

  // 排队中取消也是终态：记一行零成本。
  queue.enqueue({ id: 'never', kind: 'draft', rev: 0 });
  await queue.cancelJob('never');
  const canceled = queue.readLedger().at(-1);
  assert.deepEqual([canceled.jobId, canceled.status, canceled.wallMs, canceled.gpuKnown], ['never', 'canceled', 0, false]);

  // 草稿跑完，账本里就有它的实测；终渲前拿它报价：帧数 2 → 3，墙钟 1000 → 1500。
  queue.enqueue({ id: 'draft-1', kind: 'draft', rev: 0, payload: { cost: { wallMs: 1000, gpuSeconds: 3, renderedFrames: 2 } } });
  await queue.runJob('draft-1');
  const target = { draftSize: [960, 540], draftSamples: 16, targetFrames: 3, targetSize: [960, 540], targetSamples: 16 };
  const quote = queue.quoteJobFromDraft({ draftJobId: 'draft-1', ...target });
  assert.deepEqual([quote.estimatedWallMs, quote.estimatedGpuSeconds], [1500, 4.5]);
  assert.throws(() => queue.quoteJobFromDraft({ draftJobId: 'plain', ...target }), /实测/);
  assert.throws(() => queue.quoteJobFromDraft({ draftJobId: 'missing', ...target }), /实测/);
  const explicit = { draftFrames: 2, draftGpuSeconds: 3, draftWallMs: 1000, ...target };
  assert.deepEqual(queue.quoteJobFromDraft(explicit), jobs.quoteFromDraft(explicit));

  // 执行器回报了坏成本，或者账本本身坏了：作业照常到终态，终态事件带 ledgerError，不静默。
  for (const cost of [{ tokensByTier: 100 }, 5, { gpuSeconds: -1 }]) {
    const job = queue.enqueue({ kind: 'draft', rev: 0, payload: { cost } });
    const done = await queue.runJob(job.id);
    assert.equal(done.status, 'succeeded');
    assert.equal(typeof done.events.at(-1).ledgerError, 'string', JSON.stringify(cost));
  }
  const before = queue.readLedger().length;
  assert.equal(before, 4);
  appendFileSync(queue.ledgerFile(), 'null\n');
  queue.enqueue({ id: 'after', kind: 'draft', rev: 0 });
  const after = await queue.runJob('after');
  assert.equal(after.status, 'succeeded');
  assert.match(after.events.at(-1).ledgerError, /第 5 行损坏/);
  assert.match(queue.getJob('after').events.at(-1).ledgerError, /第 5 行损坏/);
});

test('A15-8 末行缺换行照样安全追加，坏行按物理行号报错，合法 JSON 的坏记录读入即拒', t => {
  const file = join(tempDir(t, 'strict'), 'ledger.jsonl');
  const first = jobs.appendJobLedger(file, baseRow);
  const good = JSON.stringify(first);
  writeFileSync(file, good); // 一行完整 JSON，末尾没有换行
  assert.deepEqual(jobs.readJobLedger(file), [first]);
  const second = jobs.appendJobLedger(file, { ...baseRow, jobId: 'j-2' });
  assert.equal(second.seq, 2);
  assert.equal(readFileSync(file, 'utf8'), `${good}\n${JSON.stringify(second)}\n`);
  assert.deepEqual(jobs.readJobLedger(file), [first, second]);

  // 空行跳过但占行号：有效行、空行、坏行，坏的是物理第 3 行。
  writeFileSync(file, `${good}\n\n{"seq":3,\n`);
  assert.throws(() => jobs.readJobLedger(file), /第 3 行损坏/);
  writeFileSync(file, `${good}\r\n  \n\n${JSON.stringify(second)}\n`);
  assert.deepEqual(jobs.readJobLedger(file), [first, second]);

  const drop = (row, key) => Object.fromEntries(Object.entries(row).filter(([name]) => name !== key));
  const badRows = [
    null, [], 7, 'x', true, {},
    { ...first, wallMs: '1200' },
    { ...first, gpuSeconds: null },
    { ...first, renderedFrames: 1.5 },
    { ...first, diskBytes: -1 },
    { ...first, status: 'running' },
    { ...first, format: 'job-ledger/9' },
    { ...first, seq: 0 },
    { ...first, jobId: 'J 1' },
    { ...first, attempt: 0 },
    { ...first, kind: '' },
    { ...first, rev: -1 },
    { ...first, gpuKnown: 'yes' },
    { ...first, tokensByTier: 100 },
    { ...first, tokensByTier: drop(first.tokensByTier, 'haiku') },
    { ...first, tokensByTier: { ...first.tokensByTier, gpt: 1 } },
    { ...first, tokensByTier: { ...first.tokensByTier, opus: '1' } },
    { ...first, totalTokens: 5 },
    drop(first, 'totalTokens'), drop(first, 'attempt'), drop(first, 'deliveredFrames'), drop(first, 'gpuKnown'),
  ];
  for (const bad of badRows) {
    const text = `${good}\n\n${JSON.stringify(bad)}\n`;
    writeFileSync(file, text);
    const label = JSON.stringify(bad);
    assert.throws(() => jobs.readJobLedger(file), /第 3 行损坏/, label);
    assert.throws(() => jobs.summarizeJobLedger(file), /第 3 行损坏/, label);
    // 账本坏着的时候不往上追加，免得把坏账越埋越深。
    assert.throws(() => jobs.appendJobLedger(file, { ...baseRow, jobId: 'j-9' }), /第 3 行损坏/, label);
    assert.equal(readFileSync(file, 'utf8'), text, label);
  }

  // 汇总直接收行数组时同样校验，不让字符串拼接或 NaN 混进总数。
  assert.throws(() => jobs.summarizeJobLedger([first, { ...first, wallMs: '1200' }]), /第 2 条.*wallMs/);
  assert.throws(() => jobs.summarizeJobLedger([null]), /第 1 条/);
  assert.throws(() => jobs.summarizeJobLedger([drop(first, 'totalTokens')]), /totalTokens/);
});

test('A15-9 旧 API 账本兼容读取：作业行映射成六维，请求流水行跳过，默认严格模式拒绝', t => {
  const file = join(tempDir(t, 'legacy'), 'film.ledger.jsonl');
  const modern = jobs.appendJobLedger(join(tempDir(t, 'modern'), 'ledger.jsonl'), { ...baseRow, gpuSeconds: 2, tokensByTier: { opus: 5 } });
  const lines = [
    // beiming/api/server.mjs 的请求流水行
    { seq: 1, step: 'render', ok: true, wallMs: 12, gpuSeconds: 0, tokens: 600, modelTokens: 0, frames: 0 },
    // beiming/api/work.mjs 的作业终态行
    { seq: 2, step: 'job.render', job: 'job-1', rev: 3, status: 'failed', ok: false, wallMs: 1200, gpuSeconds: 1.25, tokens: 0, modelTokens: 90, frames: 4 },
    // 同一个文件里的钩子行：带作业号但不是终态
    { seq: 3, step: 'harvest-hook', job: 'job-1', rev: 3, ok: true, wallMs: 0, gpuSeconds: 0, tokens: 0, modelTokens: 0, frames: 0 },
    { kind: 'request', wallMs: 5 },
    { kind: 'job', jobId: 'job-2', status: 'succeeded', wallMs: 800, tokens: 30, frames: 2, diskBytes: 4096 },
    modern,
  ];
  writeFileSync(file, lines.map(line => `${JSON.stringify(line)}\n`).join(''));

  assert.throws(() => jobs.readJobLedger(file), /第 1 行损坏.*job-ledger\/0\.1/);
  assert.throws(() => jobs.summarizeJobLedger(file), /第 1 行损坏/);

  const rows = jobs.readJobLedger(file, { allowLegacyApiRows: true });
  assert.deepEqual(rows, [
    { legacyApiRow: true, seq: 2, jobId: 'job-1', attempt: 1, kind: 'render', rev: 3, status: 'failed', wallMs: 1200, gpuSeconds: 1.25, gpuKnown: true,
      tokensByTier: { ...zeroTiers, other: 90 }, totalTokens: 90, renderedFrames: 4, deliveredFrames: 0, diskBytes: 0 },
    { legacyApiRow: true, jobId: 'job-2', attempt: 1, kind: 'job', status: 'succeeded', wallMs: 800, gpuSeconds: 0, gpuKnown: false,
      tokensByTier: { ...zeroTiers, other: 30 }, totalTokens: 30, renderedFrames: 2, deliveredFrames: 0, diskBytes: 4096 },
    modern,
  ]);
  const sum = jobs.summarizeJobLedger(file, { allowLegacyApiRows: true });
  assert.deepEqual(
    [sum.count, sum.legacyRows, sum.gpuUnknownRows, sum.succeeded, sum.failed, sum.wallMs, sum.gpuSeconds, sum.totalTokens, sum.tokensByTier.other, sum.tokensByTier.opus, sum.renderedFrames, sum.maxDiskBytes],
    [3, 2, 1, 2, 1, 2010, 3.25, 125, 120, 5, 8, 4096],
  );
  assert.deepEqual(jobs.normalizeLedgerEntry(lines[0], { allowLegacyApiRows: true }), null);
  assert.deepEqual(jobs.normalizeLedgerEntry(modern), modern);
  assert.throws(() => jobs.normalizeLedgerEntry(lines[1]), /job-ledger\/0\.1/);

  // 兼容模式不等于放水：旧作业行里的坏值、认不出的行，一样带物理行号拒绝。
  for (const bad of [{ ...lines[1], wallMs: '1200' }, { ...lines[1], modelTokens: 1.5 }, { ...lines[1], status: 'running' }, { ...lines[1], job: '' }, { foo: 1 }, null]) {
    writeFileSync(file, `${JSON.stringify(lines[0])}\n${JSON.stringify(bad)}\n`);
    assert.throws(() => jobs.readJobLedger(file, { allowLegacyApiRows: true }), /第 2 行损坏/, JSON.stringify(bad));
  }
});

test('A15-10 同一 (jobId, attempt) 的结算重放不重复计费，新轮次照常记', t => {
  const file = join(tempDir(t, 'idem'), 'ledger.jsonl');
  const entries = Array.from({ length: 20 }, (_, index) => ({
    ...baseRow, jobId: `j-${index + 1}`, wallMs: 500 + index, tokensByTier: { sonnet: 150 + index }, gpuSeconds: 0.1,
  }));
  const written = entries.map(entry => jobs.appendJobLedger(file, entry));
  const before = jobs.summarizeJobLedger(file);

  assert.deepEqual(jobs.appendJobLedger(file, entries[19]), written[19]);
  assert.deepEqual(jobs.appendJobLedger(file, { ...entries[19], attempt: 1 }), written[19]);
  assert.equal(jobs.readJobLedger(file).length, 20);
  assert.deepEqual(jobs.summarizeJobLedger(file), before); // 累计成本误差 0%

  const retry = jobs.appendJobLedger(file, { ...entries[19], attempt: 2 });
  assert.deepEqual([retry.seq, retry.jobId, retry.attempt], [21, 'j-20', 2]);
  assert.equal(jobs.summarizeJobLedger(file).wallMs, before.wallMs + 519);
  for (const attempt of [0, -1, 1.5, '1', null, 2 ** 53]) {
    assert.throws(() => jobs.appendJobLedger(file, { ...baseRow, jobId: 'j-99', attempt }), JSON.stringify(attempt));
  }
  assert.equal(jobs.readJobLedger(file).length, 21);
});

test('A15-11 tokensByTier 必须是对象且各档与合计都是安全整数；M04 拒绝 2**53，M14 haiku 不丢', t => {
  const file = join(tempDir(t, 'tokens'), 'ledger.jsonl');
  const max = Number.MAX_SAFE_INTEGER;
  for (const tokensByTier of [100, null, [], 'opus', { sonnet: null }, { sonnet: Number.NaN }, { sonnet: undefined }, { opus: 2 ** 53 }, { opus: -1 }]) {
    assert.throws(() => jobs.appendJobLedger(file, { ...baseRow, tokensByTier }), JSON.stringify(tokensByTier) ?? 'undefined');
  }
  // 三档各自合法，合计 9007199254740993 超出安全整数：不能悄悄记成 ...992。
  assert.throws(() => jobs.appendJobLedger(file, { ...baseRow, tokensByTier: { fable: max, opus: 1, sonnet: 1 } }), RangeError);
  // M04：计数必须是安全整数，2**53 不行。
  for (const patch of [{ rev: 2 ** 53 }, { renderedFrames: 2 ** 53 }, { deliveredFrames: 2 ** 53 }, { diskBytes: 2 ** 53 }]) {
    assert.throws(() => jobs.appendJobLedger(file, { ...baseRow, ...patch }), RangeError, JSON.stringify(patch));
  }
  assert.equal(existsSync(file), false); // 被拒的一行都没落盘

  // M14：haiku 档在行里、汇总里都在。
  const row = jobs.appendJobLedger(file, { ...baseRow, tokensByTier: { haiku: 7 } });
  assert.deepEqual([row.tokensByTier.haiku, row.totalTokens], [7, 7]);
  const sum = jobs.summarizeJobLedger(file);
  assert.equal(sum.tokensByTier.haiku, 7);
  assert.equal(sum.totalTokens, 7);
  assert.deepEqual(jobs.appendJobLedger(file, { ...baseRow, jobId: 'j-2', tokensByTier: { fable: max } }).totalTokens, max);
  // 单行都合法，累计超出安全整数时汇总也报错，不给不精确的总数。
  assert.throws(() => jobs.summarizeJobLedger(file), RangeError);
});

test('A15-12 跨进程并发追加：4 个进程各 30 笔得到 120 个连续唯一 seq，陈旧锁自动清理，活锁超时报错', { timeout: 60000 }, async t => {
  const file = join(tempDir(t, 'lock'), 'ledger.jsonl');
  // 上一个持锁进程已经退出，留下的锁不该把后来的人卡死。
  writeFileSync(`${file}.lock`, `${spawnSync(process.execPath, ['-e', '']).pid}\n`);
  const script = `
    import { appendJobLedger } from ${JSON.stringify(api)};
    const [file, name] = process.argv.slice(1);
    for (let i = 0; i < 30; i += 1) {
      appendJobLedger(file, { jobId: name + '-' + i, kind: 'draft', status: 'succeeded', wallMs: 1, renderedFrames: 1, deliveredFrames: 1, diskBytes: 1 });
    }
  `;
  const exits = await Promise.all(['a', 'b', 'c', 'd'].map(async name => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, file, name], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [code] = await once(child, 'exit');
    return [code, stderr];
  }));
  assert.deepEqual(exits, [[0, ''], [0, ''], [0, ''], [0, '']]);
  const rows = jobs.readJobLedger(file);
  assert.deepEqual(rows.map(row => row.seq), Array.from({ length: 120 }, (_, index) => index + 1));
  assert.equal(new Set(rows.map(row => row.jobId)).size, 120);
  assert.equal(existsSync(`${file}.lock`), false);

  // 活着的进程持锁：等到超时就报错，不硬闯。
  writeFileSync(`${file}.lock`, `${process.pid}\n`);
  assert.throws(() => jobs.appendJobLedger(file, { ...baseRow, jobId: 'late' }, { lockTimeoutMs: 60 }), /账本锁/);
  assert.equal(existsSync(`${file}.lock`), true);
  rmSync(`${file}.lock`);
  assert.equal(jobs.readJobLedger(file).length, 120);
});

test('R1 工作区顶层 cache/ 不入账，素材目录下的 cache/ 仍入账', t => {
  const dir = tempDir(t, 'cache-cost');
  const ws = join(dir, 'ws');
  for (const sub of ['cache/final', 'shots/cache']) mkdirSync(join(ws, sub), { recursive: true });
  writeFileSync(join(ws, 'cache/final/a.frame'), Buffer.alloc(4096));
  writeFileSync(join(ws, 'shots/cache/input'), '12345');
  writeFileSync(join(ws, 'film.json'), '{}');
  assert.equal(jobs.measureDiskBytes(ws), 7);
  const row = jobs.appendJobLedger(join(dir, 'ledger.jsonl'), { ...baseRow, diskBytes: undefined, workspaceDir: ws });
  assert.equal(row.diskBytes, 7);
});

test('R1 顶层 Cache/ 是 cache/ 的大小写别名才排除，独立目录仍入账', t => {
  const root = tempDir(t, 'cache-case');
  mkdirSync(join(root, 'Cache'));
  writeFileSync(join(root, 'Cache/input'), '12345');
  const expected = existsSync(join(root, 'cache/input')) ? 0 : 5;
  assert.equal(jobs.measureDiskBytes(root), expected);
  mkdirSync(join(root, 'cache'), { recursive: true });
  writeFileSync(join(root, 'cache/shared'), '678');
  assert.equal(jobs.measureDiskBytes(root), expected);
});

test('R1 等锁的头 15 ms 不碰 .break 或读 PID，短持锁者可直接交接', t => {
  const file = join(tempDir(t, 'grace'), 'job.json');
  const lock = `${file}.lock`;
  writeFileSync(lock, `${process.pid}\n`);
  let elapsed = 0;
  const probes = [];
  const waits = [];
  t.mock.method(performance, 'now', () => elapsed);
  for (const [method, target] of [['writeFileSync', `${lock}.break`], ['readFileSync', lock]]) {
    const original = fs[method];
    t.mock.method(fs, method, (...args) => {
      if (args[0] === target) probes.push([method, elapsed]);
      return original(...args);
    });
  }
  t.mock.method(Atomics, 'wait', (_array, _index, _value, ms) => {
    waits.push(ms);
    elapsed += ms;
    rmSync(lock, { force: true });
  });
  assert.equal(withFileLock(file, () => 'ok'), 'ok');
  assert.equal(waits[0], 15);
  assert.deepEqual(probes.filter(([, at]) => at < 15), []);
});

// 只干扰指定锁路径的一次系统调用，后续创建、读 PID、删除和新一轮加锁都走真实文件系统。
for (const [method, target, code] of [
  ['linkSync', 'lock', 'ENOENT'], ['linkSync', 'lock', 'EPERM'], ['linkSync', 'lock', 'EBUSY'],
  ['writeFileSync', 'break', 'EACCES'], ['readFileSync', 'stale', 'EBUSY'],
  ['rmSync', 'stale', 'EPERM'], ['rmSync', 'break', 'EBUSY'], ['rmSync', 'lock', 'EPERM'],
]) {
  test(`R1 ${method}(${target}) 短暂 ${code} 后正常取锁并清理`, t => {
    const file = join(tempDir(t, 'pending'), 'ledger.jsonl');
    const lock = `${file}.lock`;
    if (target !== 'lock') writeFileSync(lock, `${spawnSync(process.execPath, ['-e', '']).pid}\n`);
    const original = fs[method];
    let injected = false;
    t.mock.method(fs, method, (...args) => {
      const path = args[method === 'linkSync' ? 1 : 0];
      if (!injected && path === (target === 'break' ? `${lock}.break` : lock)) {
        injected = true;
        throw Object.assign(new Error('delete pending'), { code });
      }
      return original(...args);
    });
    const row = jobs.appendJobLedger(file, baseRow);
    assert.equal(injected, true);
    assert.deepEqual(jobs.readJobLedger(file), [row]);
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(`${lock}.break`), false);
  });
}

for (const code of ['EBUSY', 'ENOTEMPTY']) {
  test(`R1 发布硬链接后删除暂存遇 ${code}，不会把自己的锁误判为活锁`, t => {
    const dir = tempDir(t, 'published');
    const file = join(dir, 'job.json');
    let injected = false;
    t.mock.method(fs, 'rmSync', (path, options) => {
      if (!injected && options?.recursive && existsSync(`${file}.lock`)) {
        injected = true;
        throw Object.assign(new Error('暂存清理失败'), { code });
      }
      return rmSync(path, options);
    });
    let entered = 0;
    withFileLock(file, () => { entered++; }, 100);
    assert.equal(injected, true);
    assert.equal(entered, 1);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
}

test('R1 主锁 ENOTEMPTY 不重试、不递归删除', t => {
  const file = join(tempDir(t, 'lock-dir'), 'job.json');
  const lock = `${file}.lock`;
  let attempts = 0;
  t.mock.method(fs, 'rmSync', (path, options) => {
    if (path === lock) {
      attempts++;
      assert.ok(!options?.recursive);
      throw Object.assign(new Error('不是普通锁文件'), { code: 'ENOTEMPTY' });
    }
    return rmSync(path, options);
  });
  assert.throws(() => withFileLock(file, () => {}), { code: 'ENOTEMPTY' });
  assert.equal(attempts, 1);
});

test('R9 锁文件内容是「进程号 UUID」：已退出进程留下的新格式锁照常清掉，活进程的照常等到超时', t => {
  const file = join(tempDir(t, 'payload'), 'job.json');
  const lock = `${file}.lock`;
  const uuid = '123e4567-e89b-42d3-a456-426614174000';
  writeFileSync(lock, `${spawnSync(process.execPath, ['-e', '']).pid} ${uuid}\n`);
  const held = withFileLock(file, () => readFileSync(lock, 'utf8'), 2000);
  assert.match(held, new RegExp(`^${process.pid} [0-9a-f-]{36}\\n$`));
  assert.equal(existsSync(lock), false);
  writeFileSync(lock, `${process.pid} ${uuid}\n`);
  assert.throws(() => withFileLock(file, assert.fail, 60), { code: 'ETIMEDOUT' });
  assert.equal(readFileSync(lock, 'utf8'), `${process.pid} ${uuid}\n`, '别人的锁超时后原样留着');
});

test('R1 等锁时父目录消失，立即报 ENOENT，不把缺目录变成竞争超时', t => {
  const parent = join(tempDir(t, 'parent'), 'jobs');
  const file = join(parent, 'ledger.jsonl');
  assert.throws(() => withFileLock(file, assert.fail), { code: 'ENOENT' });
  assert.equal(jobs.appendJobLedger(file, baseRow).seq, 1); // 首次追加仍会创建父目录
  writeFileSync(`${file}.lock`, `${process.pid}\n`);
  let waits = 0;
  t.mock.method(Atomics, 'wait', () => {
    assert.equal(++waits, 1, '父目录消失后不再退避');
    rmSync(parent, { recursive: true });
  });
  assert.throws(() => withFileLock(file, assert.fail), { code: 'ENOENT' });
  assert.equal(waits, 1);
  assert.equal(existsSync(parent), false);
});

test('A15-13 报价只收正安全整数的帧数、画幅与采样，溢出报错；M12 1.5 倍缩放 1000 ms 精确报 1500 ms', () => {
  const good = { draftFrames: 2, draftGpuSeconds: 3, draftWallMs: 1000, draftSize: [960, 540], draftSamples: 16, targetFrames: 3, targetSize: [960, 540], targetSamples: 16 };
  const quote = jobs.quoteFromDraft(good);
  assert.equal(quote.estimatedWallMs, 1500);
  assert.equal(quote.estimatedGpuSeconds, 4.5);
  assert.equal(jobs.quoteFromDraft({ ...good, draftWallMs: 999 }).estimatedWallMs, 1498.5);

  const bad = [
    { draftFrames: 0.5 }, { targetFrames: 1.5 }, { draftFrames: 2 ** 53 }, { draftSamples: 1.5 }, { targetSamples: 0.25 },
    { draftSize: [960.5, 540] }, { targetSize: [1e200, 1e200] }, { targetSize: [1920, 1080, 3] }, { targetSize: '1920x1080' },
    { draftGpuSeconds: Number.POSITIVE_INFINITY }, { draftWallMs: '1000' },
    // 入参各自有限，乘出来的报价溢出成 Infinity。
    { draftGpuSeconds: Number.MAX_VALUE }, { draftWallMs: Number.MAX_VALUE },
  ];
  for (const patch of bad) assert.throws(() => jobs.quoteFromDraft({ ...good, ...patch }), JSON.stringify(patch));
  assert.throws(() => jobs.quoteFromDraft({ ...good, targetSize: [1e200, 1e200] }), RangeError);
  assert.throws(() => jobs.quoteFromDraft({ ...good, draftWallMs: Number.MAX_VALUE }), RangeError);
});

test('A15-14 非普通成本容器被拒，成功和失败都在终态记录原因', async t => {
  const file = join(tempDir(t, 'container'), 'ledger.jsonl');
  const tiers = new Map([['opus', 1200]]);
  assert.throws(() => jobs.appendJobLedger(file, { ...baseRow, tokensByTier: tiers }), /tokensByTier/);
  assert.equal(existsSync(file), false);
  assert.equal(jobs.appendJobLedger(file, { ...baseRow, tokensByTier: Object.assign(Object.create(null), { opus: 1200 }) }).totalTokens, 1200);
});

test('A15-15 执行器的非法 cost 不落账，显式 undefined 与省略 cost 等价', async t => {
  const costs = [null, 123, new Map(), { tokensByTier: new Map([['opus', 1200]]) }, undefined];
  const { queue } = queueFixture(t, { draft: ({ job }) => {
    const cost = costs[job.payload.index];
    if (job.payload.fail) throw Object.assign(new Error('作业失败'), { cost });
    return { value: 7, cost };
  } });
  for (const [index, cost] of costs.entries()) {
    for (const fail of [false, true]) {
      const { id } = queue.enqueue({ kind: 'draft', rev: 0, payload: { index, fail } });
      const done = await queue.runJob(id);
      assert.equal(done.status, fail ? 'failed' : 'succeeded');
      if (!fail) assert.equal(done.result.value, 7);
      const event = queue.getJob(id).events.at(-1);
      if (cost === undefined) assert.equal(event.ledgerError, undefined);
      else assert.match(event.ledgerError ?? '', /cost|tokensByTier/);
      assert.equal(queue.readLedger().filter(row => row.jobId === id).length, cost === undefined ? 1 : 0);
    }
  }
});

test('A15-16 序号已满时重试可读回原行，新键被拒且原文件逐字节不变', t => {
  const file = join(tempDir(t, 'seq'), 'ledger.jsonl');
  const last = { ...jobs.appendJobLedger(file, baseRow), seq: Number.MAX_SAFE_INTEGER };
  const bytes = Buffer.from(JSON.stringify(last));
  writeFileSync(file, bytes);
  assert.deepEqual(jobs.appendJobLedger(file, baseRow), last);
  assert.throws(() => jobs.appendJobLedger(file, { ...baseRow, attempt: 2 }), RangeError);
  assert.deepEqual(readFileSync(file), bytes);
  assert.deepEqual(jobs.readJobLedger(file), [last]);
});

// 在子进程里截住终态 job.json 的原子替换，保留进程退出时真实的作业文件和账本。
function crashAtTerminalSave(workspace, queue, position) {
  const { id } = queue.enqueue({ kind: 'draft', rev: 0 });
  const script = `
    import fs from 'node:fs';
    import { loadQueue } from ${JSON.stringify(api)};
    const [dir, id, position] = process.argv.slice(1);
    const queue = loadQueue(dir, { handlers: { draft: () => ({ cost: { wallMs: 17, tokensByTier: { opus: 1200 } } }) } });
    const rename = fs.renameSync;
    fs.renameSync = (src, dst) => {
      if (dst !== queue.jobFile(id) || JSON.parse(fs.readFileSync(src)).status !== 'succeeded') return rename(src, dst);
      if (position === 'after') rename(src, dst);
      process.exit(42);
    };
    await queue.runJob(id);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, workspace.root, id, position], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 42, child.error?.message ?? child.stderr);
  return id;
}

for (const entry of ['before', 'readLedger', 'summarizeLedger', 'reconcileLedger', 'replay']) {
  test(`A15-17 终态存盘边界崩溃后恢复（${entry}）`, async t => {
    const { workspace, queue } = queueFixture(t, { draft: () => ({ cost: { wallMs: 23 } }) });
    const beforeSave = entry === 'before';
    const id = crashAtTerminalSave(workspace, queue, beforeSave ? 'before' : 'after');
    assert.equal(queue.getJob(id).status, beforeSave ? 'running' : 'succeeded');
    assert.deepEqual(jobs.readJobLedger(queue.ledgerFile()), []);
    const retry = beforeSave || entry === 'replay';
    if (retry) await queue.replay(id);
    else if (entry === 'summarizeLedger') assert.equal(queue.summarizeLedger().wallMs, 17);
    else queue[entry]();
    const rows = jobs.readJobLedger(queue.ledgerFile());
    const history = queue.getJob(id).events.filter(event => ['succeeded', 'stopped'].includes(event.type));
    const expected = [[1, beforeSave ? 'stopped' : 'succeeded']];
    if (retry) expected.push([2, 'succeeded']);
    assert.deepEqual(history.map(event => [event.attempt, event.type]), expected);
    assert.deepEqual(rows.map(row => [row.attempt, row.status]), expected);
    assert.deepEqual([rows[0].wallMs, rows[0].tokensByTier.opus, rows[0].gpuKnown], beforeSave ? [0, 0, false] : [17, 1200, false]);
    assert.deepEqual(queue.readLedger(), rows);
  });
}

test('A15-19 补回更早轮次后，报价仍采用最新成功轮次的实测', async t => {
  const { queue } = queueFixture(t, { draft: ({ job }) => ({ cost: { renderedFrames: 1, wallMs: job.attempt * 10, gpuSeconds: job.attempt } }) });
  const { id } = queue.enqueue({ kind: 'draft', rev: 0 });
  await queue.runJob(id);
  await queue.replay(id);
  const [, second] = queue.readLedger();
  writeFileSync(queue.ledgerFile(), `${JSON.stringify(second)}\n`);
  const quote = queue.quoteJobFromDraft({ draftJobId: id, draftSize: [1, 1], targetSize: [1, 1], draftSamples: 1, targetSamples: 1, targetFrames: 1 });
  assert.deepEqual([quote.estimatedGpuSeconds, quote.estimatedWallMs], [2, 20]);
});

test('A15-20 首轮追加失败写诊断时，另一进程的重放保留两轮历史', { timeout: 15000 }, async t => {
  const { workspace, queue } = queueFixture(t, { draft: () => '重放完成' });
  const { id } = queue.enqueue({ kind: 'draft', rev: 0 });
  const script = `
    import fs from 'node:fs';
    import { loadQueue } from ${JSON.stringify(api)};
    const [dir, id] = process.argv.slice(1);
    const queue = loadQueue(dir, { handlers: { draft: () => '首轮完成' } });
    fs.appendFileSync = () => { throw new Error('追加失败'); };
    const rename = fs.renameSync;
    fs.renameSync = (src, dst) => {
      if (dst === queue.jobFile(id) && JSON.parse(fs.readFileSync(src)).events.at(-1).ledgerError) {
        fs.writeSync(1, '保存诊断');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
      }
      return rename(src, dst);
    };
    await queue.runJob(id);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, workspace.root, id], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => child.kill());
  const exit = once(child, 'exit');
  await once(child.stdout, 'data');
  await queue.replay(id);
  assert.deepEqual(await exit, [0, null]);
  const job = queue.getJob(id);
  assert.deepEqual([job.attempt, job.result], [2, '重放完成']);
  assert.match(job.events.find(event => event.type === 'succeeded').ledgerError, /追加失败/);
  assert.deepEqual(queue.readLedger().map(row => row.attempt), [1, 2]);
});

test('A15-21 坏账不挡作业重放，严格读取报错，修复后补齐两轮', async t => {
  const { queue } = queueFixture(t, { draft: () => '完成' });
  const { id } = queue.enqueue({ kind: 'draft', rev: 0 });
  await queue.runJob(id);
  const file = queue.ledgerFile();
  const original = readFileSync(file);
  writeFileSync(file, '{bad\n');
  const job = await queue.replay(id);
  assert.deepEqual([job.status, job.attempt, job.result], ['succeeded', 2, '完成']);
  assert.match(queue.getJob(id).events.at(-1).ledgerError, /第 1 行损坏/);
  for (const read of [queue.readLedger, queue.summarizeLedger, queue.reconcileLedger]) assert.throws(() => read(), /第 1 行损坏/);
  assert.equal(readFileSync(file, 'utf8'), '{bad\n');
  writeFileSync(file, original);
  assert.deepEqual(queue.readLedger().map(row => row.attempt), [1, 2]);
});

test('A15-18 M21 四个子进程同时结算同一轮，只记 10 ms', { timeout: 20000 }, async t => {
  const file = join(tempDir(t, 'same-key'), 'ledger.jsonl');
  const script = `
    import { appendJobLedger } from ${JSON.stringify(api)};
    process.send('ready');
    process.once('message', () => {
      appendJobLedger(process.argv[1], ${JSON.stringify(baseRow)});
      process.disconnect();
    });
  `;
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['--input-type=module', '-e', script, file], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] }));
  t.after(() => children.forEach(child => child.kill()));
  const exits = children.map(child => once(child, 'exit'));
  await Promise.all(children.map(child => once(child, 'message')));
  children.forEach(child => child.send('start'));
  assert.deepEqual(await Promise.all(exits), children.map(() => [0, null]));
  const rows = jobs.readJobLedger(file);
  assert.equal(rows.length, 1);
  assert.equal(jobs.summarizeJobLedger(rows).wallMs, 10);
});
