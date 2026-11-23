// M1b 脚手架默认值回归自测（管理员裁定 §3.4.3 & §5.5）：
//   1. turntableShot 默认 180° 快门（shutter: { angleDeg: 180 }）与终稿 64 采样（tiers.final.samples = 64）；
//   2. Blender 帧源能力声明终稿档默认开启 OIDN 降噪（final: { samples: 64, scale: 1, denoise: 'gpu' }）；
//   3. titleShot 默认启用片名入场加微漂移动画（enter = from - 1, settleFrames = min(12, max(2, to - from)), motion = 'settle-drift'）；
//   4. titleShot 不预置 deliberate 整镜冻结豁免，guide 示例同步复用 titleShot，全部脚手架模板过冻结 film/3.0、L1 及真实渲染交付门禁。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tools } from '../comp/index.mjs';
import { loadContracts } from '../kernel/contracts/validate.mjs';
import { blackFreezeDup } from '../observe/index.mjs';
import { caps as blenderCaps } from '../sources/blender/caps.mjs';
import { findBlender, planRender as planBlender } from '../sources/blender/host.mjs';
import { DEFAULT_OUTPUT, scaffold, titleShot, turntableShot } from './films.mjs';
import { guideText } from './guide.mjs';
import { issueAccountToken, startServer } from './index.mjs';
import { layerL1 } from './pipeline.mjs';

const frozen = await loadContracts();

function assertCleanContract(obj, expectedContract) {
  const res = frozen.validate(obj);
  assert.equal(res.contract, expectedContract);
  assert.deepEqual(res.schemaErrors, []);
  assert.deepEqual(res.violations, {});
}

function pageMediaSkip() {
  const { ffmpeg, ffprobe } = tools();
  for (const [name, bin, args] of [['ffmpeg', ffmpeg, ['-version']], ['ffprobe', ffprobe, ['-version']]]) {
    if (!bin || spawnSync(bin, args, { stdio: 'ignore', timeout: 20000 }).status !== 0) return `缺少可执行的 ${name}`;
  }
  const probe = "import {chromium} from 'playwright-core'; const b=await chromium.launch({headless:true,executablePath:process.env.BEIMING_CHROME || undefined,args:['--mute-audio']}); await b.close()";
  if (spawnSync(process.execPath, ['--input-type=module', '-e', probe], { stdio: 'ignore', timeout: 30000 }).status !== 0) return '无头浏览器不可执行';
  return false;
}

function hasExecutableBlender() {
  const bin = findBlender();
  return Boolean(bin && spawnSync(bin, ['--version'], { stdio: 'ignore', timeout: 20000 }).status === 0);
}

test('M1b-1 turntableShot 与 turntable 模板（默认 60 帧、24 帧、最小 4 帧）：180 度快门、终稿 64 采样、过 film/3.0 与 L1', () => {
  const direct = turntableShot('s01', 0, 30, 1001);
  assert.equal(direct.shutter.angleDeg, 180);
  assert.deepEqual(direct.tiers, { draft: { samples: 16 }, final: { samples: 64 } });

  for (const [frames, expectedCut, expectedSettle] of [
    [undefined, 30, 12],
    [60, 30, 12],
    [24, 12, 12],
    [4, 2, 2],
  ]) {
    const { film } = scaffold({
      id: 'f_turntable',
      template: 'turntable',
      ...(frames !== undefined ? { output: { ...DEFAULT_OUTPUT, frames } } : {}),
    });
    assertCleanContract(film, 'film');
    const l1 = layerL1(film, null, 1, null);
    assert.equal(l1.ok, true, JSON.stringify(l1.diagnostics));

    const [s01, s02] = film.shots;
    assert.equal(s01.in, 0);
    assert.equal(s01.out, expectedCut);
    assert.equal(s01.shutter.angleDeg, 180);
    assert.equal(s01.tiers.draft.samples, 16);
    assert.equal(s01.tiers.final.samples, 64);

    assert.equal(s02.in, expectedCut);
    assert.equal(s02.out, frames ?? DEFAULT_OUTPUT.frames);
    assert.equal(s02.deliberate, undefined, 'titleShot 不得预置 deliberate 冻结豁免');
    const titleParams = s02.cards[0].params;
    assert.equal(titleParams.enter, expectedCut - 1);
    assert.equal(titleParams.settleFrames, expectedSettle);
    assert.equal(titleParams.motion, 'settle-drift');
  }
});

test('M1b-2 Blender 帧源能力声明与出帧计划：final 档默认 64 采样 + OIDN 显卡降噪，180 度快门规划一致', () => {
  const c = blenderCaps('5.2.0', { 'blender.cycles': {} });
  assertCleanContract(c, 'source');
  assert.deepEqual(c.final, { samples: 64, scale: 1, denoise: 'gpu' });

  const shot = turntableShot('s01', 0, 30, 1001);
  const plan = planBlender(c, shot, [1280, 720], 'final', {}, ['color'], { shutterSamples: 1 });
  assert.deepEqual(plan, {
    angleDeg: 180,
    shutterSamples: 1,
    size: [1280, 720],
    samples: 64,
    denoise: true,
    layers: ['color'],
  });
});

test('M1b-3 title 模板（全尺寸统一 settleFrames、最小 2 帧）与 guide 示例：默认 settle-drift、无预置冻结豁免、过 film/3.0 与 L1', () => {
  for (const [frames, expectedSettle] of [
    [undefined, 12],
    [60, 12],
    [24, 12],
    [10, 10],
    [2, 2],
  ]) {
    const { film } = scaffold({
      id: 'f_title',
      template: 'title',
      ...(frames !== undefined ? { output: { ...DEFAULT_OUTPUT, frames } } : {}),
    });
    assertCleanContract(film, 'film');
    const l1 = layerL1(film, null, 1, null);
    assert.equal(l1.ok, true, JSON.stringify(l1.diagnostics));

    assert.equal(film.shots.length, 1);
    const [s01] = film.shots;
    assert.equal(s01.deliberate, undefined, 'titleShot 不得预置 deliberate 冻结豁免');
    const titleParams = s01.cards[0].params;
    assert.equal(titleParams.enter, -1);
    assert.equal(titleParams.settleFrames, expectedSettle);
    assert.ok(titleParams.settleFrames >= 2);
    assert.equal(titleParams.motion, 'settle-drift');
  }

  // 小画幅 320x180 与 640x360、1280x720 统一使用相同公式，settleFrames === 12
  const small = scaffold({ id: 'f_small', template: 'title', output: { size: [320, 180], fps: '30/1', frames: 60 } });
  const medium = scaffold({ id: 'f_medium', template: 'title', output: { size: [640, 360], fps: '30/1', frames: 60 } });
  assert.equal(small.film.shots[0].cards[0].params.settleFrames, 12);
  assert.equal(small.film.shots[0].cards[0].params.settleFrames, medium.film.shots[0].cards[0].params.settleFrames);

  const guide = guideText();
  assert.ok(guide.includes(JSON.stringify(titleShot('s01', 0, 60, 'RTX 5090', 1001))));
  assert.match(guide, /"enter":-1,"settleFrames":12,"motion":"settle-drift"/);
  assert.match(guide, /"shutter":\{"angleDeg":180/);
  assert.match(guide, /"final":\{"samples":64\}/);
  assert.doesNotMatch(guide, /"deliberate":\[\{"kind":"freeze"/);
});

const skipPage = pageMediaSkip();
const hasBlender = !skipPage && hasExecutableBlender();

test('M1b-4 真实渲染与交付端到端：默认 60f/30fps title、24f/24fps title、GET /v1/guide THREE_SAMPLE 均零冻结过 deliver，最短 2f title 帧哈希不同', { skip: skipPage, timeout: 600000 }, async () => {
  const tempVar = process.platform === 'win32' ? 'TEMP' : 'TMPDIR';
  const prevTemp = process.env[tempVar];
  const root = mkdtempSync(join(tmpdir(), 'beiming-m1b-e2e-'));
  process.env[tempVar] = root;
  const account = issueAccountToken(root);
  const api = await startServer({ dataDir: root, port: 0, reviewer: null });

  const call = async (method, path, token, body) => {
    const res = await fetch(api.url + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const env = await res.json();
    assert.equal(res.status, 200, `${method} ${path} -> ${res.status}: ${JSON.stringify(env)}`);
    assert.equal(env.ok, true, `${method} ${path} failed: ${JSON.stringify(env)}`);
    return env;
  };

  const runJob = async (filmId, token, kind, body = {}) => {
    let env = await call('POST', `/v1/films/${filmId}/${kind}`, token, { ...body, wait: 30 });
    while (['queued', 'running'].includes(env.data.status)) {
      env = await call('GET', `/v1/jobs/${env.data.job}?wait=30`, token);
    }
    const full = env.outputs?.find((o) => o.kind === 'response');
    if (full) {
      const res = await fetch(api.url + full.url, { headers: { authorization: `Bearer ${token}` } });
      env = await res.json();
    }
    assert.equal(env.ok, true, `${kind} not ok: ${JSON.stringify(env)}`);
    assert.equal(env.data.status, 'succeeded', `${kind} failed: ${JSON.stringify(env)}`);
    return env;
  };

  const assertCleanDeliver = async (filmId, deliverEnv) => {
    assert.deepEqual(deliverEnv.data.failed, []);
    const bundleDir = join(root, 'films', filmId, 'deliver', deliverEnv.data.job, 'bundle');
    const report = JSON.parse(readFileSync(join(bundleDir, 'report.json'), 'utf8'));
    const v = report.verification;
    assert.equal(v.ok, true);
    assert.equal(v.layers.L2.ok, true);
    assert.ok(v.layers.L2.bbox.minIou >= 0.95);
    assert.equal(v.layers.L3.basePass, true);
    const byId = Object.fromEntries(v.verdicts.map((item) => [item.id, item]));
    assert.equal(byId['pred.delivery']?.status, 'pass', JSON.stringify(v.verdicts));
    assert.equal(byId['pred.inside_frame']?.status, 'pass', JSON.stringify(v.verdicts));
    assert.equal(byId['pred.visible']?.status, 'pass', JSON.stringify(v.verdicts));
    const bfd = await blackFreezeDup(join(bundleDir, 'master.mp4'));
    assert.deepEqual(bfd.details.black, [], '交付成片不得有黑帧');
    assert.deepEqual(bfd.details.freezes, [], '交付成片不得有冻结段');
  };

  try {
    // 1. 默认 POST /v1/films { template: 'title' }（1280x720, 60f/30fps）与 320x180 60f/30fps -> POST /deliver ok: true
    const defaultTitle = (await call('POST', '/v1/films', account, { template: 'title' })).data;
    const defaultDeliver = await runJob(defaultTitle.film, defaultTitle.token, 'deliver');
    await assertCleanDeliver(defaultTitle.film, defaultDeliver);

    const smallTitle = (await call('POST', '/v1/films', account, {
      template: 'title',
      output: { size: [320, 180], fps: '30/1', frames: 60 },
    })).data;
    const smallDeliver = await runJob(smallTitle.film, smallTitle.token, 'deliver');
    await assertCleanDeliver(smallTitle.film, smallDeliver);

    // 2. POST /v1/films { template: 'title', output: { size: [640, 360], fps: '24/1', frames: 24 } } -> POST /deliver ok: true
    const title24 = (await call('POST', '/v1/films', account, {
      template: 'title',
      output: { size: [640, 360], fps: '24/1', frames: 24 },
    })).data;
    const deliver24 = await runJob(title24.film, title24.token, 'deliver');
    await assertCleanDeliver(title24.film, deliver24);

    // 4. 最短 2 帧 title 真实渲染第 0、1 帧颜色 SHA-256 不同
    const shortestTitle = (await call('POST', '/v1/films', account, {
      template: 'title',
      output: { size: [320, 180], fps: '24/1', frames: 2 },
    })).data;
    const render2 = await runJob(shortestTitle.film, shortestTitle.token, 'render', { tier: 'draft' });
    assert.equal(render2.data.actualCount, 2);
    const jobDir2 = join(root, 'films', shortestTitle.film, 'deliver', render2.data.job, 'frames', 's01');
    const meta0 = JSON.parse(readFileSync(join(jobDir2, 'f0000.meta.json'), 'utf8'));
    const meta1 = JSON.parse(readFileSync(join(jobDir2, 'f0001.meta.json'), 'utf8'));
    assert.ok(meta0.hash.color.startsWith('sha256:'));
    assert.notEqual(meta0.hash.color, meta1.hash.color, '最短 2 帧 title 的第 0、1 帧必须有可见入场变化');

    // 5. 从 GET /v1/guide 解析 THREE_SAMPLE 原样 PUT /film -> POST /deliver 返回 ok: true（零黑帧、主角可见、零冻结）
    const guideEnv = await call('GET', '/v1/guide', account);
    const lines = guideEnv.data.guide.split('\n');
    const sampleIdx = lines.findIndex((l) => l.startsWith('## 样例 three'));
    assert.ok(sampleIdx >= 0, 'guide 中必须包含 ## 样例 three');
    const threeSample = JSON.parse(lines[sampleIdx + 1]);
    const currentFilm = (await call('GET', `/v1/films/${defaultTitle.film}/film`, defaultTitle.token)).data;
    assert.deepEqual(currentFilm.film.shots, [threeSample]);
    await call('PUT', `/v1/films/${defaultTitle.film}/film`, defaultTitle.token, {
      ...currentFilm.film,
      shots: [threeSample],
      rev: currentFilm.rev,
    });
    const guideDeliver = await runJob(defaultTitle.film, defaultTitle.token, 'deliver');
    await assertCleanDeliver(defaultTitle.film, guideDeliver);
  } finally {
    await api.close();
    if (prevTemp === undefined) delete process.env[tempVar];
    else process.env[tempVar] = prevTemp;
    rmSync(root, { recursive: true, force: true });
  }
});

test('M1b-5 真实 Blender + three 双镜 turntable（60f/30fps deliver 与最短 4 帧渲染哈希）', { skip: !hasBlender && '本机没有可用的 Blender 或媒体工具', timeout: 600000 }, async () => {
  const tempVar = process.platform === 'win32' ? 'TEMP' : 'TMPDIR';
  const prevTemp = process.env[tempVar];
  const root = mkdtempSync(join(tmpdir(), 'beiming-m1b-blender-'));
  process.env[tempVar] = root;
  const account = issueAccountToken(root);
  const api = await startServer({ dataDir: root, port: 0, reviewer: null });

  const call = async (method, path, token, body) => {
    const res = await fetch(api.url + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const env = await res.json();
    assert.equal(res.status, 200, `${method} ${path} -> ${res.status}: ${JSON.stringify(env)}`);
    assert.equal(env.ok, true, `${method} ${path} failed: ${JSON.stringify(env)}`);
    return env;
  };

  const runJob = async (filmId, token, kind, body = {}) => {
    let env = await call('POST', `/v1/films/${filmId}/${kind}`, token, { ...body, wait: 30 });
    while (['queued', 'running'].includes(env.data.status)) {
      env = await call('GET', `/v1/jobs/${env.data.job}?wait=30`, token);
    }
    const full = env.outputs?.find((o) => o.kind === 'response');
    if (full) {
      const res = await fetch(api.url + full.url, { headers: { authorization: `Bearer ${token}` } });
      env = await res.json();
    }
    assert.equal(env.ok, true, `${kind} not ok: ${JSON.stringify(env)}`);
    assert.equal(env.data.status, 'succeeded', `${kind} failed: ${JSON.stringify(env)}`);
    return env;
  };

  try {
    // 3. 默认 turntable 60f/30fps -> POST /deliver 返回 ok: true
    const turn60 = (await call('POST', '/v1/films', account, {
      template: 'turntable',
      output: { size: [320, 180], fps: '30/1', frames: 60 },
    })).data;
    const deliver60 = await runJob(turn60.film, turn60.token, 'deliver');
    assert.deepEqual(deliver60.data.failed, []);
    const bundleDir = join(root, 'films', turn60.film, 'deliver', deliver60.data.job, 'bundle');
    const report = JSON.parse(readFileSync(join(bundleDir, 'report.json'), 'utf8'));
    const v = report.verification;
    assert.equal(v.ok, true);
    assert.equal(v.layers.L2.ok, true);
    assert.ok(v.layers.L2.bbox.minIou >= 0.95);
    assert.equal(v.layers.L3.basePass, true);
    const byId = Object.fromEntries(v.verdicts.map((item) => [item.id, item]));
    assert.equal(byId['pred.delivery']?.status, 'pass', JSON.stringify(v.verdicts));
    assert.equal(byId['pred.inside_frame']?.status, 'pass', JSON.stringify(v.verdicts));
    assert.equal(byId['pred.visible']?.status, 'pass', JSON.stringify(v.verdicts));
    const bfd = await blackFreezeDup(join(bundleDir, 'master.mp4'));
    assert.deepEqual(bfd.details.black, []);
    assert.deepEqual(bfd.details.freezes, []);

    // 最短 4 帧 turntable 真实渲染 s01（0,1 帧）与 s02（2,3 帧）颜色 SHA-256 均不同
    const turn4 = (await call('POST', '/v1/films', account, {
      template: 'turntable',
      output: { size: [320, 180], fps: '24/1', frames: 4 },
    })).data;
    const render4 = await runJob(turn4.film, turn4.token, 'render', { tier: 'draft' });
    assert.equal(render4.data.actualCount, 4);
    const jobBase = join(root, 'films', turn4.film, 'deliver', render4.data.job, 'frames');
    const f0 = JSON.parse(readFileSync(join(jobBase, 's01', 'f0000.meta.json'), 'utf8'));
    const f1 = JSON.parse(readFileSync(join(jobBase, 's01', 'f0001.meta.json'), 'utf8'));
    const f2 = JSON.parse(readFileSync(join(jobBase, 's02', 'f0002.meta.json'), 'utf8'));
    const f3 = JSON.parse(readFileSync(join(jobBase, 's02', 'f0003.meta.json'), 'utf8'));
    assert.notEqual(f0.hash.color, f1.hash.color, '最短 4 帧 turntable 的 s01 第 0、1 帧哈希必须不同');
    assert.notEqual(f2.hash.color, f3.hash.color, '最短 4 帧 turntable 的 s02 第 2、3 帧哈希必须不同');
  } finally {
    await api.close();
    if (prevTemp === undefined) delete process.env[tempVar];
    else process.env[tempVar] = prevTemp;
    rmSync(root, { recursive: true, force: true });
  }
});

