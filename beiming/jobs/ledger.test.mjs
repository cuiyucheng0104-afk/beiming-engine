import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as jobs from './index.mjs';

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
      job: 'j-1',
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

    assert.equal(row.seq, 1);
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
        job: `j-${i}`,
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
    const base = { job: 'j-1', kind: 'draft', rev: 0, status: 'stopped', wallMs: 10, renderedFrames: 2, deliveredFrames: 0, diskBytes: 7 };
    // 显式 gpuSeconds 与 diskBytes 压过帧元数据与目录实测，不相加。
    const explicit = jobs.appendJobLedger(ledgerPath, { ...base, gpuSeconds: 9.5, frameMetas: [{ timing: { renderMs: 1000 } }], workspaceDir: join(dir, 'ws') });
    assert.equal(explicit.gpuSeconds, 9.5);
    assert.equal(explicit.diskBytes, 7);
    const measured = jobs.appendJobLedger(ledgerPath, { ...base, status: 'canceled', diskBytes: undefined, workspaceDir: join(dir, 'ws') });
    assert.deepEqual([measured.seq, measured.gpuSeconds, measured.diskBytes, measured.totalTokens], [2, 0, 1024, 0]);

    const bad = [
      { job: 'J 1' },
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
