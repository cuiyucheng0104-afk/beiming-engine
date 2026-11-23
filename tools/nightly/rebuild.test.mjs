// tools/nightly/rebuild.mjs 的单元与实渲集成测试（含正常通过、哈希失配必败、锁失配必败、无浏览器必退 exit 3 的负对照）
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_FRAMES,
  NIGHTLY_REBUILD_FORMAT,
  parseRebuildArgs,
  prepareLockedProbeFilm,
  runNightlyRebuild,
} from './rebuild.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const REBUILD_CLI = path.join(HERE, 'rebuild.mjs');

function makeTempDir(t, prefix = 'beiming-nightly-test-') {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeSyntheticRenderer(perturb = () => {}) {
  return async (film, _lock, info) => {
    perturb(film, info);
    const [width, height] = film.output.size;
    const frames = [];
    const deliverables = {};
    for (const shot of film.shots) {
      const bias = shot.shutter?.angleDeg === 90 ? 0.25 : 0;
      for (let f = shot.in; f < shot.out; f++) {
        const color = new Float32Array(width * height * 3);
        const val = (f + 1) / (film.output.frames + 1) + bias;
        color.fill(val);
        frames.push({ frame: f, shot: shot.id, width, height, channels: 3, color });
        deliverables[`${shot.id}/f${String(f).padStart(4, '0')}.color.f32`] = `sha256:${String(f + (bias ? 900 : 100)).padStart(64, '0')}`;
      }
    }
    return { frames, deliverables };
  };
}

test('rebuild-1 注入渲染器正对照：两次独立加锁渲染逐帧逐位一致，写出 report.json 与 controllability.jsonl', async (t) => {
  const outDir = makeTempDir(t);
  const report = await runNightlyRebuild({
    outDir,
    frames: DEFAULT_FRAMES,
    size: [16, 9],
    renderLocked: makeSyntheticRenderer(),
  });

  assert.equal(report.format, NIGHTLY_REBUILD_FORMAT);
  assert.equal(report.ok, true, JSON.stringify(report.error));
  assert.equal(report.pass, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.error, null);
  assert.equal(report.filmId, 'skeleton-calib');
  assert.equal(report.totalFrames, DEFAULT_FRAMES);
  assert.equal(report.identicalFrames, DEFAULT_FRAMES);
  assert.deepEqual(report.failedFrames, []);
  assert.deepEqual(report.mismatchedDeliverables, []);
  assert.equal(report.frames.length, DEFAULT_FRAMES);
  for (const frame of report.frames) {
    assert.equal(frame.identical, true);
    assert.equal(frame.sha256Run1, frame.sha256Run2);
    assert.match(frame.sha256Run1, /^sha256:[0-9a-f]{64}$/);
  }

  const reportFile = path.join(outDir, 'report.json');
  const jsonlFile = path.join(outDir, 'controllability.jsonl');
  assert.deepEqual(report.outputs, [reportFile, jsonlFile]);
  assert.ok(fs.existsSync(reportFile));
  assert.ok(fs.existsSync(jsonlFile));

  const saved = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(saved.pass, true);
  const row = JSON.parse(fs.readFileSync(jsonlFile, 'utf8').trim());
  assert.equal(row.format, 'controllability-row/0.1');
  assert.equal(row.overallPass, true);

  for (const n of [1, 2, 3, 6, 107]) {
    const p = prepareLockedProbeFilm({ frames: n });
    assert.equal(p.film.output.frames, n);
  }
  assert.throws(() => prepareLockedProbeFilm({ frames: 0 }), /frames 必须是 1 到 107/);
  assert.throws(() => prepareLockedProbeFilm({ frames: 108 }), /frames 必须是 1 到 107/);
});

test('rebuild-2 负对照：帧哈希失配、交付件哈希失配、锁被篡改、渲染抛错均必须返回非 0 退出码（exit 1，绝不假绿）', async (t) => {
  const outDir = makeTempDir(t);

  // 1. 第二遍渲染画面漂移 -> exit 1
  const drifted = await runNightlyRebuild({
    outDir,
    frames: 6,
    size: [8, 8],
    renderLocked: makeSyntheticRenderer((film, { run }) => {
      if (run === 2) film.shots[0].shutter.angleDeg = 90;
    }),
  });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.pass, false);
  assert.equal(drifted.exitCode, 1);
  assert.deepEqual(drifted.failedFrames, [0, 1]);
  assert.equal(drifted.identicalFrames, 4);
  assert.equal(drifted.frames[0].identical, false);
  assert.notEqual(drifted.frames[0].sha256Run1, drifted.frames[0].sha256Run2);

  // 2. 帧相同但交付件哈希失配 -> exit 1
  const badDeliv = await runNightlyRebuild({
    outDir: null,
    frames: 3,
    size: [8, 8],
    renderLocked: async (film, lock, info) => {
      const res = await makeSyntheticRenderer()(film, lock, info);
      res.deliverables['master.mp4'] = info.run === 1 ? 'sha256:1111' : 'sha256:2222';
      return res;
    },
  });
  assert.equal(badDeliv.ok, false);
  assert.equal(badDeliv.exitCode, 1);
  assert.deepEqual(badDeliv.mismatchedDeliverables, ['master.mp4']);

  // 3. 锁种子与片子描述不匹配 -> 开渲前拒收，exit 1
  const { film, lock } = prepareLockedProbeFilm({ frames: 3 });
  lock.seeds.s01 += 1;
  let renderCalls = 0;
  const badLock = await runNightlyRebuild({
    outDir: null,
    film,
    lock,
    frames: 3,
    renderLocked: async (...args) => {
      renderCalls++;
      return makeSyntheticRenderer()(...args);
    },
  });
  assert.equal(badLock.ok, false);
  assert.equal(badLock.exitCode, 1);
  assert.equal(renderCalls, 0, '坏锁必须在开渲前被拒收');

  // 4. 非法帧数参数 -> exit 2
  const badFrames = await runNightlyRebuild({ outDir: null, frames: 0, renderLocked: makeSyntheticRenderer() });
  assert.equal(badFrames.ok, false);
  assert.equal(badFrames.exitCode, 2);
});

test('rebuild-3 负对照：无头浏览器缺失或无法启动时必须直接返回 exit 3（绝不跳过当绿灯）', async (t) => {
  const outDir = makeTempDir(t);

  // 1. 探测到无浏览器 -> exit 3
  const noBrowser = await runNightlyRebuild({
    outDir,
    frames: 3,
    browserOk: false,
  });
  assert.equal(noBrowser.ok, false);
  assert.equal(noBrowser.pass, false);
  assert.equal(noBrowser.exitCode, 3);
  assert.equal(noBrowser.error?.code, 'env.browser-missing');

  // 2. startSource 启动浏览器抛错 -> exit 3
  const launchFail = await runNightlyRebuild({
    outDir: null,
    frames: 3,
    browserOk: true,
    startSource: async () => {
      throw new Error("browserType.launch: Executable doesn't exist at /nonexistent/chrome");
    },
  });
  assert.equal(launchFail.ok, false);
  assert.equal(launchFail.exitCode, 3);
  assert.equal(launchFail.error?.code, 'env.browser-launch-failed');

  // 3. CLI 子进程：BEIMING_CHROME 指向不存在的可执行文件时必须 exit 3
  const { NODE_TEST_CONTEXT: _, ...baseEnv } = process.env;
  const cliNoChrome = spawnSync(
    process.execPath,
    [REBUILD_CLI, '--frames', '3', '--out', path.join(outDir, 'cli-no-chrome'), '--json'],
    {
      encoding: 'utf8',
      env: { ...baseEnv, BEIMING_CHROME: path.join(outDir, 'no-such-chrome-binary') },
      timeout: 60000,
    },
  );
  assert.equal(cliNoChrome.status, 3, `无浏览器时 CLI 必须 exit 3，实际 ${cliNoChrome.status}: ${cliNoChrome.stderr}`);
  const parsed = JSON.parse(cliNoChrome.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.exitCode, 3);

  // 4. CLI 参数解析测试
  const helpRun = spawnSync(process.execPath, [REBUILD_CLI, '--help'], { encoding: 'utf8' });
  assert.equal(helpRun.status, 0);
  assert.match(helpRun.stdout, /用法：node tools\/nightly\/rebuild\.mjs/);
  const badFlag = spawnSync(process.execPath, [REBUILD_CLI, '--bad-flag'], { encoding: 'utf8' });
  assert.equal(badFlag.status, 2);
  assert.throws(() => parseRebuildArgs(['--frames', 'abc']), /--frames 需要指定正整数/);
  assert.throws(() => parseRebuildArgs(['--out']), /--out 需要指定目录路径/);
});

test('rebuild-4 静态合规：tools/nightly/rebuild.mjs 中所有动态 import() 均使用 pathToFileURL(...).href', () => {
  const src = fs.readFileSync(REBUILD_CLI, 'utf8').replace(/^\s*\/\/.*$/gm, '');
  const dynamicImports = [...src.matchAll(/\bimport\s*\(([^\n;]+)\)/g)].map((m) => m[1].trim());
  assert.ok(dynamicImports.length >= 1, 'rebuild.mjs 应包含动态 import()');
  for (const expr of dynamicImports) {
    assert.match(expr, /^pathToFileURL\b[\s\S]*\.href$/, `动态 import(${expr}) 必须使用 pathToFileURL(...).href`);
  }
});

test('rebuild-5 页面宿主真实渲染：本机有无头浏览器时真跑两次独立进程重建并核验负对照', async (t) => {
  const { browserOk } = await import(pathToFileURL(path.join(REPO, 'tests', 'ci', 'browser.mjs')).href);
  if (!browserOk) {
    t.skip('本机未安装无头浏览器，跳过真实页面宿主渲染（无浏览器 exit 3 已在 rebuild-3 验证）');
    return;
  }

  const outDir = makeTempDir(t);
  // 1. 真实页面宿主两次独立浏览器进程渲染（3 个镜头共 3 帧）
  const report = await runNightlyRebuild({
    outDir,
    frames: 3,
    size: [160, 90],
  });
  assert.equal(report.ok, true, JSON.stringify(report.error));
  assert.equal(report.pass, true);
  assert.equal(report.exitCode, 0);
  assert.equal(report.totalFrames, 3);
  assert.equal(report.identicalFrames, 3);
  assert.equal(report.frames.length, 3);
  assert.deepEqual(report.frames.map((f) => f.shot), ['s01', 's02', 's03']);
  for (const f of report.frames) {
    assert.equal(f.identical, true);
    assert.equal(f.sha256Run1, f.sha256Run2);
  }

  // 2. 真实页面宿主负对照：第二遍扰动 s01 快门角，真实渲染出的第 0 帧哈希必须失配且 exitCode 为 1
  const negReport = await runNightlyRebuild({
    outDir: null,
    frames: 3,
    size: [160, 90],
    perturb: (film, { run }) => {
      if (run === 2) film.shots[0].shutter.angleDeg = 90;
    },
  });
  assert.equal(negReport.ok, false);
  assert.equal(negReport.pass, false);
  assert.equal(negReport.exitCode, 1);
  assert.deepEqual(negReport.failedFrames, [0]);
  assert.equal(negReport.frames[0].identical, false);
  assert.equal(negReport.frames[1].identical, true);
  assert.equal(negReport.frames[2].identical, true);
});
